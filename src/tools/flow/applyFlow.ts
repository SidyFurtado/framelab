/**
 * Speed curves — timeline logic.
 *
 * Premiere never lets a plugin set a keyframe's bezier handles, so a
 * curve is baked into intermediate keyframes between two anchors. Every
 * baked keyframe is forced to LINEAR interpolation, otherwise Premiere
 * smooths on top of the bake and the shape drifts.
 *
 * Baking is destructive to timing, so the same targeting also drives
 * `clearSegment`, which strips a segment back to its two anchors.
 *
 * Everything here is written defensively against the host: a single
 * parameter the host refuses must never take the whole bake down with
 * it, and whatever went wrong has to reach the panel as text.
 */
import type {
  Component,
  ComponentParam,
  Keyframe,
  PointF,
  premierepro,
  TickTime,
  VideoClipTrackItem,
} from "@adobe/premierepro";
import {
  collectSelectedVideoClips,
  describeError,
  getPremiere,
  readTicksPerFrame,
  snapTicksToFrame,
} from "../../bridge/premiere";
import type { EasingCurve } from "../../curves/easing";

export interface FlowResult {
  ok: boolean;
  message: string;
}

/** A parameter on the selected clip that already carries keyframes. */
export interface AnimatedParam {
  id: string;
  /**
   * Identity of the clip this parameter lives on, from `ClipRef`. Apply
   * resolves through this, never through `clipIndex`: that index is a
   * position inside the selection as it was during the scan, and using
   * it wrote the bake into whichever clip happened to be at that slot
   * later.
   */
  clipKey: string;
  /** `clipKey` plus the parameter's address — the bake registry's key. */
  key: string;
  /** "Motion › Escala" */
  label: string;
  /** Every keyframe time on the parameter, in ticks, in order. */
  keyTicks: string[];
  /**
   * The editor's own keyframes: `keyTicks` minus whatever this session
   * baked. Segments are cut between these, never between baked keys —
   * otherwise a second apply bakes into its own output.
   */
  anchorTicks: string[];
  clipIndex: number;
  componentIndex: number;
  paramIndex: number;
}

/** What the scan saw, so a failure can explain itself in the panel. */
export interface ScanReport {
  clips: number;
  lines: string[];
}

export interface ScanResult {
  params: AnimatedParam[];
  report: ScanReport;
}

export interface FlowTarget {
  param: AnimatedParam;
  /** Index of the first anchor of the segment; the pair is [i, i + 1]. */
  segment: number | "all";
}

const MAX_PARAMS = 40;

/**
 * Ticks this session baked, per parameter.
 *
 * Premiere offers no place to mark a keyframe as the plugin's, and no
 * way to read which keyframes the editor selected, so the only way to
 * tell an anchor from a baked key is to remember what we wrote. Keyed by
 * `ClipRef.key`, which survives dragging the clip along the timeline —
 * a registry keyed on the clip's start forgot the bake on every move,
 * and re-applying then multiplied the keyframes instead of replacing
 * them. Session scoped: reopen the panel and every keyframe reads as an
 * anchor again, which is the old behaviour rather than a wrong one.
 */
const bakedByParam = new Map<string, Set<string>>();

function bakedFor(key: string): Set<string> {
  let set = bakedByParam.get(key);
  if (!set) {
    set = new Set<string>();
    bakedByParam.set(key, set);
  }
  return set;
}

/**
 * Time Remapping's Speed is permanently "animated" and its keyframes are
 * a different species — baking into it corrupts the clip's speed instead
 * of easing anything. It is dropped from the scan rather than offered.
 */
const EXCLUDED_COMPONENTS =
  /time\s*remap|remapeamento\s*de\s*tempo|remappage|zeitverzerrung|时间重映射/i;

/**
 * The typings declare several of these getters as synchronous, but a
 * good part of the Premiere UXP surface is async at runtime. Awaiting a
 * plain value is a no-op, so this is correct either way — and without it
 * a Promise silently fails every shape check below.
 */
async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

/**
 * Read-only scan of the selection: every parameter that is already
 * animated, with its keyframe times. Never throws.
 */
export async function readAnimatedParams(): Promise<ScanResult> {
  const report: ScanReport = { clips: 0, lines: [] };
  const ppro = getPremiere();
  if (!ppro) {
    report.lines.push("Runtime do Premiere indisponível.");
    return { params: [], report };
  }

  try {
    const project = await ppro.Project.getActiveProject();
    const sequence = project ? await project.getActiveSequence() : null;
    if (!sequence) {
      report.lines.push("Nenhuma sequência ativa.");
      return { params: [], report };
    }

    const clips = await collectSelectedVideoClips(ppro, sequence);
    report.clips = clips.length;
    if (clips.length === 0) {
      report.lines.push("Nenhum clipe de vídeo selecionado na timeline.");
      return { params: [], report };
    }

    const found: AnimatedParam[] = [];

    for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
      const clipKey = clips[clipIndex]!.key;
      const chain = await clips[clipIndex]!.clip.getComponentChain();
      if (!chain) {
        report.lines.push(`Clipe ${clipIndex + 1}: sem cadeia de efeitos.`);
        continue;
      }

      const componentCount = await resolve(chain.getComponentCount());
      for (let ci = 0; ci < componentCount && found.length < MAX_PARAMS; ci++) {
        const component = await resolve(chain.getComponentAtIndex(ci));
        if (!component) {
          continue;
        }
        const componentName =
          (await component.getDisplayName().catch(() => "")) || `Efeito ${ci + 1}`;
        const matchName = await component.getMatchName().catch(() => "");

        if (
          EXCLUDED_COMPONENTS.test(componentName) ||
          EXCLUDED_COMPONENTS.test(matchName)
        ) {
          report.lines.push(`${componentName}: ignorado (remapeamento de tempo).`);
          continue;
        }

        const paramCount = await safeParamCount(component);
        let animatedHere = 0;

        for (let pi = 0; pi < paramCount && found.length < MAX_PARAMS; pi++) {
          const param = await safeParam(component, pi);
          if (!param) {
            continue;
          }

          // A parameter with two or more keyframes IS animated. Asking
          // isTimeVarying() first only added a way to be wrong.
          const times = await keyframeTimes(param);
          if (times.length < 2) {
            continue;
          }

          animatedHere += 1;
          const keyTicks = times.map((time) => time.ticks);
          const key = `${clipKey}:${ci}:${pi}`;
          found.push({
            // A MESMA identidade do registro de bake: presa ao clipe,
            // não à posição na varredura. O id posicional colidia
            // entre varreduras de clipes diferentes — "0:0:1" do clipe
            // B herdava a desseleção feita no "0:0:1" do clipe A.
            id: key,
            clipKey,
            key,
            label: `${componentName} › ${safeDisplayName(param) || `Param ${pi}`}`,
            keyTicks,
            anchorTicks: anchorsOf(key, keyTicks),
            clipIndex,
            componentIndex: ci,
            paramIndex: pi,
          });
        }

        report.lines.push(
          `${componentName}: ${paramCount} param, ${animatedHere} animado(s)`
        );
      }
    }

    // A one-line summary: this runs on every panel focus, and dumping
    // the parameter array wrote dozens of lines per alt-tab.
    console.log(
      `[Flow] varredura: ${report.clips} clipe(s), ${found.length} parâmetro(s) animado(s)`
    );
    return { params: found, report };
  } catch (cause) {
    report.lines.push(`Erro: ${describeError(cause)}`);
    console.error("[Flow] falha ao ler os parâmetros:", cause);
    return { params: [], report };
  }
}

/** Keyframe times, tolerant of the getter being sync or async. */
async function keyframeTimes(param: ComponentParam): Promise<TickTime[]> {
  try {
    const times = await resolve(param.getKeyframeListAsTickTimes());
    return Array.isArray(times) ? times : [];
  } catch {
    return [];
  }
}

/**
 * Splits a keyframe list into the editor's anchors. Keys we baked and
 * that are still there drop out; keys that vanished (an undo, a manual
 * delete) are forgotten. A record that would leave fewer than two
 * anchors is not trusted — the whole list comes back instead.
 */
function anchorsOf(key: string, keyTicks: string[]): string[] {
  const baked = bakedByParam.get(key);
  if (!baked || baked.size === 0) {
    return keyTicks.slice();
  }

  const present = new Set(keyTicks);
  for (const ticks of [...baked]) {
    if (!present.has(ticks)) {
      baked.delete(ticks);
    }
  }

  const anchors = keyTicks.filter((ticks) => !baked.has(ticks));
  return anchors.length >= 2 ? anchors : keyTicks.slice();
}

/**
 * Bakes the chosen curve into every selected segment. One undo.
 *
 * The curve arrives resolved rather than as an id: a curve drawn in the
 * editor has no entry in the preset table to look up.
 */
export async function applyCurve(
  targets: FlowTarget[],
  curve: EasingCurve,
  density: number
): Promise<FlowResult> {
  return runOnTargets(targets, "Aplicar curva", async (param, pairs, build) => {
    const plans: SegmentPlan[] = [];

    for (const [startTicks, endTicks] of pairs) {
      const plan = await planSegment(
        param,
        startTicks,
        endTicks,
        density,
        curve.ease,
        build
      );
      if (plan) {
        plans.push(plan);
      }
    }
    return plans;
  });
}

/** Strips every selected segment back to its two anchors. One undo. */
export async function clearToLinear(targets: FlowTarget[]): Promise<FlowResult> {
  return runOnTargets(targets, "Curva linear", async (param, pairs) => {
    const plans: SegmentPlan[] = [];
    for (const [startTicks, endTicks] of pairs) {
      const inner = await innerTicks(param, startTicks, endTicks);
      if (inner.length > 0) {
        plans.push({
          param,
          key: "",
          removeTicks: inner,
          add: [],
          before: (await keyframeTimes(param)).length,
        });
      }
    }
    return plans;
  });
}

// ── shared machinery ───────────────────────────────────────────────

interface BakedKey {
  ticks: string;
  value: number | { x: number; y: number };
}

interface SegmentPlan {
  param: ComponentParam;
  /** Registry key of the parameter this plan writes to. */
  key: string;
  removeTicks: string[];
  add: BakedKey[];
  /** Keyframe count before the bake, so the commit can be verified. */
  before: number;
  /** Re-resolved after the commit, since the built handle may be stale. */
  descriptor?: AnimatedParam;
}

/** Shared state a plan builder needs from the sequence. */
interface BuildContext {
  /** Frame length in ticks, or null when the host would not say. */
  ticksPerFrame: bigint | null;
  notes: string[];
}

type PlanBuilder = (
  param: ComponentParam,
  pairs: Array<[string, string]>,
  build: BuildContext
) => Promise<SegmentPlan[]>;

async function runOnTargets(
  targets: FlowTarget[],
  undoLabel: string,
  build: PlanBuilder
): Promise<FlowResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return fail("Runtime do Premiere indisponível.");
  }
  if (targets.length === 0) {
    return fail("Escolha ao menos um parâmetro animado.");
  }

  try {
    const project = await ppro.Project.getActiveProject();
    const sequence = project ? await project.getActiveSequence() : null;
    if (!sequence) {
      return fail("Abra uma sequência na timeline primeiro.");
    }

    const clips = await collectSelectedVideoClips(ppro, sequence);
    if (clips.length === 0) {
      return fail("Nenhum clipe de vídeo selecionado na timeline.");
    }
    // Identity, not position. The scan's clipIndex is a slot in the
    // selection as it was then; resolving through it wrote the bake
    // into whatever clip occupied that slot at Apply time.
    const byKey = new Map(clips.map((ref) => [ref.key, ref.clip]));

    const context: BuildContext = {
      ticksPerFrame: await readTicksPerFrame(sequence),
      notes: [],
    };

    const plans: SegmentPlan[] = [];
    let segments = 0;

    for (const target of targets) {
      const label = target.param.label;
      const param = await resolveParam(byKey, target.param);
      if (!param) {
        context.notes.push(`${label}: clipe não está mais na seleção.`);
        continue;
      }
      if (!(await keyframesSupported(param))) {
        context.notes.push(`${label}: não aceita keyframes.`);
        continue;
      }

      const pairs = pairsFor(target);
      if (pairs.length === 0) {
        context.notes.push(`${label}: trecho fora do alcance.`);
        continue;
      }

      // One parameter the host refuses must not take the others down.
      try {
        const built = await build(param, pairs, context);
        for (const plan of built) {
          plan.key = target.param.key;
          plan.descriptor = target.param;
        }
        plans.push(...built);
        segments += built.length;
      } catch (cause) {
        context.notes.push(`${label}: ${describeError(cause)}`);
      }
    }

    if (plans.length === 0) {
      return fail(withNotes("Nada a fazer nesses segmentos.", context.notes));
    }

    // Synchronous from here: Action and Keyframe objects created outside a
    // locked transaction go stale ("The script object is no longer valid").
    let committed = false;
    let added = 0;
    let refused = 0;
    let transactionError: string | null = null;
    /** What the transaction really filed, so the bake registry can be
     *  updated with the truth rather than with the plan. */
    const filed: Array<{ key: string; added: string[]; removed: string[] }> = [];

    try {
      project.lockedAccess(() => {
        committed = project.executeTransaction((compoundAction) => {
          /** Builds one action and files it, never throwing outward. */
          const push = (make: () => unknown, required: boolean): boolean => {
            try {
              const action = make();
              if (!action) {
                if (required) refused += 1;
                return false;
              }
              // `addAction` is typed boolean, but a host that answers
              // undefined used to be read as a refusal on one line and as
              // a success on the next — so every keyframe was reported as
              // filed AND as rejected. Only an explicit false is a refusal.
              const accepted = compoundAction.addAction(action as never) !== false;
              if (!accepted && required) {
                refused += 1;
              }
              return accepted;
            } catch (cause) {
              if (required) {
                refused += 1;
                console.warn("[Flow] ação recusada:", cause);
              }
              return false;
            }
          };

          for (const plan of plans) {
            const record = { key: plan.key, added: [] as string[], removed: [] as string[] };
            filed.push(record);

            if (plan.add.length > 0) {
              // The docs prescribe the stopwatch action alongside the
              // keyframe actions; on an already-animated param it is a
              // no-op, and it is what makes a first bake stick.
              push(() => plan.param.createSetTimeVaryingAction(true), false);
            }

            for (const ticks of plan.removeTicks) {
              const gone = push(
                () =>
                  plan.param.createRemoveKeyframeAction(
                    ppro.TickTime.createWithTicks(ticks),
                    false
                  ),
                true
              );
              if (gone) {
                record.removed.push(ticks);
              }
            }

            const landed: string[] = [];
            for (const key of plan.add) {
              const ok = push(() => {
                const keyframe = makeKeyframe(ppro, plan.param, key.value);
                keyframe.position = ppro.TickTime.createWithTicks(key.ticks);
                return plan.param.createAddKeyframeAction(keyframe);
              }, true);
              if (ok) {
                landed.push(key.ticks);
                record.added.push(key.ticks);
                added += 1;
              }
            }

            // Interpolation is filed after every add of this plan: the
            // action resolves its keyframe by time, and the keyframes
            // only exist once the compound action runs. Without LINEAR
            // Premiere smooths on top of the bake. Only the keys that
            // were actually filed get one — the rest have no keyframe to
            // point at.
            for (const ticks of landed) {
              push(
                () =>
                  plan.param.createSetInterpolationAtKeyframeAction(
                    ppro.TickTime.createWithTicks(ticks),
                    ppro.Constants.InterpolationMode.LINEAR
                  ),
                false
              );
            }
          }
        }, undoLabel);
      });
    } catch (cause) {
      transactionError = describeError(cause);
    }

    if (transactionError) {
      return fail(withNotes(`O Premiere recusou: ${transactionError}`, context.notes));
    }
    if (!committed) {
      return fail(
        withNotes("O Premiere recusou a transação. Nada foi alterado.", context.notes)
      );
    }

    // Only now is it true. Before the commit these were intentions.
    for (const record of filed) {
      if (!record.key) {
        continue;
      }
      const baked = bakedFor(record.key);
      for (const ticks of record.removed) {
        baked.delete(ticks);
      }
      for (const ticks of record.added) {
        baked.add(ticks);
      }
      if (baked.size === 0) {
        bakedByParam.delete(record.key);
      }
    }

    const wanted = plans.reduce((total, plan) => total + plan.add.length, 0);
    if (wanted > 0 && added === 0) {
      return fail(
        withNotes(
          `Nenhum keyframe foi aceito (${refused} recusa(s)). Veja o console do UXP.`,
          context.notes
        )
      );
    }

    // The transaction reporting success is not proof the keyframes
    // landed, so the parameters are read back. A read that shows nothing
    // is a caveat, not a verdict — the host does not always hand back a
    // fresh keyframe list right after a commit, and telling the editor
    // it failed while the keyframes sit in Effect Controls is the worse
    // of the two mistakes.
    // Re-collected, not reused: the clips gathered before the commit are
    // snapshots of a project that has since changed, and reading one of
    // them back can answer with the old keyframe list — or refuse.
    const refreshedSequence =
      (await (await ppro.Project.getActiveProject())?.getActiveSequence()) ??
      sequence;
    const refreshedClips = await collectSelectedVideoClips(ppro, refreshedSequence);
    const refreshedByKey = new Map(
      refreshedClips.map((ref) => [ref.key, ref.clip])
    );
    const verified = await verify(plans, refreshedByKey);
    if (wanted > 0 && verified === 0) {
      context.notes.push("Não consegui reler os keyframes — confira o Effect Controls.");
    }

    if (refused > 0) {
      context.notes.push(`${refused} ação(ões) recusada(s) pelo Premiere.`);
    }

    return {
      ok: true,
      message: withNotes(
        added
          ? `${added} keyframes criados em ${segments} ${
              segments === 1 ? "trecho" : "trechos"
            }.`
          : `${segments} ${segments === 1 ? "trecho limpo" : "trechos limpos"}.`,
        context.notes
      ),
    };
  } catch (cause) {
    return fail(`Falhou: ${describeError(cause)}`);
  }
}

/**
 * Reads the touched parameters back through freshly resolved handles.
 *
 * The param objects used to build the transaction may be snapshots taken
 * before it ran, so asking them what changed can answer with the old
 * list. Re-resolving from the chain is the only read that means anything
 * here — and even then, an inconclusive answer is reported as
 * inconclusive, never as failure: the transaction did commit.
 */
async function verify(
  plans: SegmentPlan[],
  byKey: Map<string, VideoClipTrackItem>
): Promise<number> {
  let changed = 0;
  for (const plan of plans) {
    try {
      const fresh = plan.descriptor
        ? await resolveParam(byKey, plan.descriptor)
        : null;
      const times = await keyframeTimes(fresh ?? plan.param);
      if (times.length !== plan.before) {
        changed += 1;
      }
    } catch {
      // A parameter that cannot be read back is not evidence of failure.
      changed += 1;
    }
  }
  return changed;
}

function withNotes(message: string, notes: string[]): string {
  if (notes.length === 0) {
    return message;
  }
  console.warn("[Flow]", message, notes);
  return `${message} ${notes.slice(0, 2).join(" ")}`;
}

/**
 * Turns a planned value into something `createKeyframe` accepts. PointF
 * is a host constructor: `new` is the form that works whether it is a
 * class or a plain function, and calling it bare throws on a class.
 */
function makeKeyframe(
  ppro: premierepro,
  param: ComponentParam,
  value: number | { x: number; y: number }
): Keyframe {
  if (typeof value === "number") {
    return param.createKeyframe(value);
  }

  // `createKeyframe` throws when the value does not match the param's
  // type, and the host has more than one way of spelling a point. Rather
  // than betting on one, each candidate is offered until one is taken:
  // `new` first because it is the only form that works whether PointF is
  // a class or a plain function, then the bare call, then the shapes a
  // native binding will often coerce.
  const candidates: Array<() => unknown> = [
    () => new ppro.PointF(value.x, value.y),
    () => ppro.PointF(value.x, value.y),
    () => ({ x: value.x, y: value.y }),
    () => [value.x, value.y],
  ];

  let lastError: unknown = null;
  for (const build of candidates) {
    try {
      return param.createKeyframe(build() as PointF);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError ?? new Error("nenhum formato de ponto foi aceito");
}

/** Consecutive anchor pairs the target covers. */
function pairsFor(target: FlowTarget): Array<[string, string]> {
  const ticks = target.param.anchorTicks;
  if (target.segment === "all") {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < ticks.length - 1; index++) {
      pairs.push([ticks[index]!, ticks[index + 1]!]);
    }
    return pairs;
  }
  const start = ticks[target.segment];
  const end = ticks[target.segment + 1];
  return start && end ? [[start, end]] : [];
}

async function planSegment(
  param: ComponentParam,
  startTicks: string,
  endTicks: string,
  density: number,
  ease: (t: number) => number,
  build: BuildContext
): Promise<SegmentPlan | null> {
  const ppro = getPremiere();
  if (!ppro) {
    return null;
  }

  const startTime = ppro.TickTime.createWithTicks(startTicks);
  const endTime = ppro.TickTime.createWithTicks(endTicks);
  const startSeconds = startTime.seconds;
  const endSeconds = endTime.seconds;
  if (!(endSeconds > startSeconds)) {
    return null;
  }

  const from = await readValue(param, startTime);
  const to = await readValue(param, endTime);
  if (from === null || to === null) {
    build.notes.push(
      "Valor ilegível nos âncoras — veja o console do UXP para o formato."
    );
    return null;
  }

  // A bake finer than the frame grid produces keyframes Premiere folds
  // onto the same frame — the curve then reads as a step, or as nothing.
  const frames = frameSpan(startTicks, endTicks, build.ticksPerFrame);
  const steps = Math.max(0, Math.min(density, frames - 1));
  if (steps === 0) {
    build.notes.push("Trecho curto demais para assar (menos de 2 frames).");
    return null;
  }

  const add: BakedKey[] = [];
  // Os âncoras entram na cerca já NO GRID: todo tick assado é snapado
  // antes de comparar, e um âncora fora do grid (efeito alheio, fps
  // fracionário) tinha string diferente do assado que cai no mesmo
  // frame — dois keyframes num frame, valor no cara-ou-coroa.
  const used = new Set<string>([
    startTicks,
    endTicks,
    snapTicksToFrame(startTicks, build.ticksPerFrame),
    snapTicksToFrame(endTicks, build.ticksPerFrame),
  ]);

  for (let step = 1; step <= steps; step++) {
    const t = step / (steps + 1);
    const seconds = startSeconds + (endSeconds - startSeconds) * t;
    const ticks = snapTicksToFrame(
      ppro.TickTime.createWithSeconds(seconds).ticks,
      build.ticksPerFrame
    );
    // Two baked keyframes on one frame is one keyframe with a coin toss
    // for its value.
    if (used.has(ticks)) {
      continue;
    }
    used.add(ticks);

    const eased = ease(t);
    add.push({
      ticks,
      value:
        typeof from === "number" && typeof to === "number"
          ? from + (to - from) * eased
          : {
              x: pointOf(from).x + (pointOf(to).x - pointOf(from).x) * eased,
              y: pointOf(from).y + (pointOf(to).y - pointOf(from).y) * eased,
            },
    });
  }

  if (add.length === 0) {
    build.notes.push("Nenhum frame livre entre os keyframes do trecho.");
    return null;
  }

  return {
    param,
    key: "",
    removeTicks: await innerTicks(param, startTicks, endTicks),
    add,
    before: (await keyframeTimes(param)).length,
  };
}

/** How many frames the segment spans; Infinity when the grid is unknown. */
function frameSpan(
  startTicks: string,
  endTicks: string,
  ticksPerFrame: bigint | null
): number {
  if (!ticksPerFrame || ticksPerFrame <= 0n) {
    return Number.POSITIVE_INFINITY;
  }
  try {
    const span = BigInt(endTicks) - BigInt(startTicks);
    return Number(span / ticksPerFrame);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Keyframe times strictly between the two anchors. */
async function innerTicks(
  param: ComponentParam,
  startTicks: string,
  endTicks: string
): Promise<string[]> {
  const ppro = getPremiere();
  if (!ppro) {
    return [];
  }
  const times = await keyframeTimes(param);
  const startSeconds = ppro.TickTime.createWithTicks(startTicks).seconds;
  const endSeconds = ppro.TickTime.createWithTicks(endTicks).seconds;
  const epsilon = 1e-6;

  return times
    .filter(
      (time) =>
        time.seconds > startSeconds + epsilon && time.seconds < endSeconds - epsilon
    )
    .map((time) => time.ticks);
}

async function resolveParam(
  byKey: Map<string, VideoClipTrackItem>,
  descriptor: AnimatedParam
): Promise<ComponentParam | null> {
  const clip = byKey.get(descriptor.clipKey);
  if (!clip) {
    return null;
  }
  const chain = await clip.getComponentChain();
  if (!chain) {
    return null;
  }
  if (descriptor.componentIndex >= (await resolve(chain.getComponentCount()))) {
    return null;
  }
  const component = await resolve(
    chain.getComponentAtIndex(descriptor.componentIndex)
  );
  return component ? safeParam(component, descriptor.paramIndex) : null;
}

async function keyframesSupported(param: ComponentParam): Promise<boolean> {
  try {
    const supported = await resolve(param.areKeyframesSupported());
    // Only a definite false is a refusal; anything else is the host
    // declining to answer, and the param already carries keyframes.
    return supported !== false;
  } catch {
    return true;
  }
}

/**
 * The value the parameter holds at a time. `getValueAtTime` is the
 * documented route; when the host answers with nothing usable the
 * keyframe sitting on that anchor is read instead.
 */
async function readValue(
  param: ComponentParam,
  time: TickTime
): Promise<number | { x: number; y: number } | null> {
  let direct: unknown = null;
  try {
    direct = await param.getValueAtTime(time);
  } catch {
    direct = null;
  }

  const value = normalizeValue(direct);
  if (value !== null) {
    return value;
  }

  let fromKeyframe: unknown = null;
  try {
    fromKeyframe = await resolve(param.getKeyframePtr(time));
  } catch {
    fromKeyframe = null;
  }

  const fallback = normalizeValue(fromKeyframe);
  if (fallback !== null) {
    return fallback;
  }

  // Neither route produced something readable. What the host actually
  // handed back is the only thing that can settle it, so it goes to the
  // console in full and its shape goes into the panel note.
  console.warn(
    "[Flow] valor ilegível em",
    safeDisplayName(param),
    "| getValueAtTime ->",
    describeShape(direct),
    direct,
    "| getKeyframePtr ->",
    describeShape(fromKeyframe),
    fromKeyframe
  );
  return null;
}

/**
 * Unwraps whatever the host calls a value into a number or a point.
 *
 * There is no single shape to rely on: `Keyframe` carries
 * `{ value: { value } }`, `getValueAtTime` has been seen returning the
 * bare value and a wrapper around it, and a point can arrive as a PointF,
 * as a plain `{x, y}`, or as a two-element array. Numbers sometimes come
 * through as strings. Anything that cannot be read is a null, never a
 * guess.
 */
function normalizeValue(raw: unknown): number | { x: number; y: number } | null {
  let current = raw;

  for (let depth = 0; depth < 4; depth++) {
    const asNumber = finiteNumber(current);
    if (asNumber !== null) {
      return asNumber;
    }
    if (!current || typeof current !== "object") {
      return null;
    }

    // [x, y]
    if (Array.isArray(current) && current.length >= 2) {
      const x = finiteNumber(current[0]);
      const y = finiteNumber(current[1]);
      return x !== null && y !== null ? { x, y } : null;
    }

    const record = current as Record<string, unknown>;
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    if (x !== null && y !== null) {
      return { x, y };
    }

    if (!("value" in record)) {
      return null;
    }
    current = record.value;
  }

  return null;
}

/** A number, however the host spelled it. */
function finiteNumber(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Short description of an unknown host value, for a note and a log. */
function describeShape(raw: unknown): string {
  if (raw === null) return "null";
  if (raw === undefined) return "undefined";
  if (Array.isArray(raw)) return `Array[${raw.length}]`;
  if (typeof raw !== "object") return typeof raw;
  const name = (raw as object).constructor?.name ?? "Object";
  let keys: string[] = [];
  try {
    keys = Object.keys(raw as object).slice(0, 6);
  } catch {
    keys = [];
  }
  return `${name}{${keys.join(",")}}`;
}

function pointOf(value: number | { x: number; y: number }): { x: number; y: number } {
  return typeof value === "number" ? { x: value, y: value } : value;
}

async function safeParamCount(component: Component): Promise<number> {
  try {
    return await resolve(component.getParamCount());
  } catch {
    return 0;
  }
}

async function safeParam(
  component: Component,
  index: number
): Promise<ComponentParam | null> {
  try {
    return await resolve(component.getParam(index));
  } catch {
    return null;
  }
}

function safeDisplayName(param: ComponentParam): string {
  try {
    return param.displayName ?? "";
  } catch {
    return "";
  }
}

function fail(message: string): FlowResult {
  return { ok: false, message };
}
