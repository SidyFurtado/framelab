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
  Project,
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
import { DIAG_ENABLED, dumpDiag, probeKeyframes, unwrapValue } from "../zoom/diag";
import {
  bakedFor,
  bakedIfAny,
  ensureRegistryLoaded,
  forgetParam,
  persistRegistry,
} from "./bakeRegistry";

/**
 * O relatório do Curvas, em disco — `flow-diag.json`, ao lado do do Zoom.
 * Mesmo motivo: o console do UXP mora dentro do Premiere, e o que foi
 * lido, calculado e escrito precisa chegar inteiro a quem conserta.
 */
const FLOW_DIAG_FILE = "flow-diag.json";

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

/*
 * O registro de assadura mora em `bakeRegistry.ts`, em disco.
 *
 * Enquanto ele vivia só na memória deste módulo, fechar o painel
 * bastava para os keyframes assados voltarem a ser lidos como âncoras
 * do editor — e a segunda curva assava entre cada par deles, levando
 * um parâmetro de dezoito para cerca de cento e vinte keyframes sem
 * dizer nada. O arquivo explica a cerca que impede o contrário.
 */

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

    // Antes de decidir o que é âncora e o que é assado.
    await ensureRegistryLoaded(project);

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
  const baked = bakedIfAny(key);
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
        const existing = (await keyframeTimes(param)).map((time) => time.ticks);
        plans.push({
          param,
          key: "",
          removeTicks: inner,
          add: [],
          before: existing.length,
          existing,
          anchors: [],
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
  /**
   * Every keyframe tick the parameter had before the commit. With
   * `removeTicks` and `add` it says exactly what the parameter should
   * hold afterwards — anything else on it was planted by the host.
   */
  existing: string[];
  /**
   * Os dois âncoras do trecho com o valor que tinham ANTES do commit.
   * O bake não os toca — e mesmo assim o host devolveu o do tick 0
   * zerado. É contra isto que eles são conferidos depois.
   */
  anchors: Array<{ ticks: string; value: number | { x: number; y: number } }>;
  /** Re-resolved after the commit, since the built handle may be stale. */
  descriptor?: AnimatedParam;
}

/** Shared state a plan builder needs from the sequence. */
interface BuildContext {
  /** Frame length in ticks, or null when the host would not say. */
  ticksPerFrame: bigint | null;
  notes: string[];
  /** Um registro por trecho planejado, para o relatório. */
  diag: unknown[];
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

    await ensureRegistryLoaded(project);

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
      diag: [],
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

    // O relatório, ANTES de tocar no host — se a transação derrubar o
    // plugin, o que foi lido e calculado já está em disco.
    const relatorio: Record<string, unknown> = {
      quando: new Date().toISOString(),
      acao: undoLabel,
      ticksPerFrame: context.ticksPerFrame === null ? null : context.ticksPerFrame.toString(),
      alvos: targets.map((target) => ({
        label: target.param.label,
        segment: target.segment,
        keyTicks: target.param.keyTicks,
        anchorTicks: target.param.anchorTicks,
      })),
      relogios: DIAG_ENABLED ? await clipClocks(byKey, targets) : "(diag desligado)",
      trechos: context.diag,
      planos: plans.map((plan) => ({
        param: plan.descriptor?.label ?? safeDisplayName(plan.param),
        remove: plan.removeTicks,
        add: plan.add,
        existentes: plan.existing,
      })),
      antes: DIAG_ENABLED ? await keyframesByParam(plans, byKey) : "(diag desligado)",
      notas: context.notes.slice(),
    };
    await dumpDiag(relatorio, FLOW_DIAG_FILE);

    // Synchronous from here: Action and Keyframe objects created outside a
    // locked transaction go stale ("The script object is no longer valid").
    let committed = false;
    let added = 0;
    let refused = 0;
    let transactionError: string | null = null;
    /** What the transaction really filed, so the bake registry can be
     *  updated with the truth rather than with the plan. */
    const filed: Array<{ key: string; added: string[]; removed: string[] }> = [];
    /** Keyframes assados que entraram — recebem LINEAR numa 2ª transação. */
    const toLinear: Array<{ param: ComponentParam; ticks: string }> = [];

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

            // Sem ligar o cronômetro. Todo parâmetro que chega aqui já
            // tem dois ou mais keyframes — o cronômetro já está ligado —
            // e `createSetTimeVaryingAction(true)` não é um no-op: o
            // Zoom mediu que ela faz o Premiere plantar um keyframe
            // SEU, no tick 0 do parâmetro, com valor 0. Era isso que
            // fazia toda animação com curva partir do zero, em escala
            // e em posição, mesmo com o primeiro keyframe longe do
            // início. A varredura depois do commit apanha o que
            // sobrar.

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

            // A interpolação NÃO entra neste compound. A ação resolve o
            // keyframe pelo tempo NA CRIAÇÃO — e aqui dentro os
            // keyframes assados ainda não existem: o compound só roda
            // depois. O relatório mostrou o resultado: os assados
            // entram certos e o âncora do tick 0 sai com valor 0.
            // LINEAR vai numa transação própria, com os keyframes já
            // no lugar.
            for (const ticks of landed) {
              toLinear.push({ param: plan.param, ticks });
            }
          }
        }, undoLabel);
      });
    } catch (cause) {
      transactionError = describeError(cause);
    }

    relatorio.transacao = { committed, added, refused, transactionError, filed };
    if (transactionError) {
      await dumpDiag(relatorio, FLOW_DIAG_FILE, true);
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
        forgetParam(record.key);
      }
    }
    // Em disco agora, não no fim da função: daqui para baixo tudo é
    // conferência e relatório, e qualquer um deles pode estourar.
    await persistRegistry(project);

    // ── 2ª transação: LINEAR nos assados, agora que eles existem ─────
    // Sem LINEAR o Premiere suaviza por cima da assadura e a forma
    // deriva. Se esta falhar, a assadura fica: é curva um pouco mais
    // macia, não um trecho perdido.
    let linearCommitted = false;
    let linearFiled = 0;
    if (toLinear.length > 0) {
      try {
        project.lockedAccess(() => {
          linearCommitted = project.executeTransaction((compoundAction) => {
            for (const entry of toLinear) {
              try {
                const action = entry.param.createSetInterpolationAtKeyframeAction(
                  ppro.TickTime.createWithTicks(entry.ticks),
                  ppro.Constants.InterpolationMode.LINEAR
                );
                if (action && compoundAction.addAction(action as never) !== false) {
                  linearFiled += 1;
                }
              } catch (cause) {
                console.warn("[Flow] interpolação recusada:", cause);
              }
            }
          }, "Curva: interpolação linear");
        });
      } catch (cause) {
        console.warn("[Flow] a transação de interpolação não assentou:", cause);
      }
      if (!linearCommitted) {
        context.notes.push("O Premiere não aceitou a interpolação linear dos assados.");
      }
    }
    relatorio.interpolacao = { pedidos: toLinear.length, aceitos: linearFiled, linearCommitted };

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
    // Lida pelos clipes reatualizados, pelo mesmo motivo do verify.
    const swept = await sweepStrays(ppro, project, plans, filed, refreshedByKey);
    if (swept > 0) {
      context.notes.push(
        `${swept} keyframe(s) que o Premiere criou sozinho foram removidos.`
      );
    }

    // ── Os âncoras, CONFERIDOS ───────────────────────────────────────
    // O bake não os toca, e o host devolveu o do tick 0 com valor 0.
    // Cada âncora é relido e comparado com o valor de antes; o que
    // divergir é apagado e reescrito com o valor original — em duas
    // transações, porque no mesmo compound as duas se anulam. Perde-se
    // o bezier do âncora, ganha-se o valor de volta.
    const ancoras = await repairAnchors(ppro, project, plans, refreshedByKey);
    relatorio.ancoras = ancoras;
    const reparados = ancoras.filter((row) => row.reparado).length;
    if (reparados > 0) {
      context.notes.push(
        `${reparados} âncora(s) voltaram com valor errado e foram reescritos.`
      );
    }
    const verified = await verify(plans, refreshedByKey);
    /*
     * Algo saiu do trilho? Então o relatório vale o disco, mesmo com o
     * diagnóstico desligado — é justamente o caso em que alguém vai
     * precisar dele, e pedir para o editor reproduzir o problema com a
     * flag ligada é a rodada de ping-pong que este arquivo existe para
     * evitar.
     */
    const torto =
      swept > 0 || reparados > 0 || refused > 0 || (wanted > 0 && verified === 0);
    relatorio.depois = {
      varridos: swept,
      verificados: verified,
      keyframes:
        DIAG_ENABLED || torto
          ? await keyframesByParam(plans, refreshedByKey)
          : "(diag desligado)",
      notas: context.notes.slice(),
    };
    await dumpDiag(relatorio, FLOW_DIAG_FILE, torto);
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

/** `getValueAtTime` como o host responde: forma, chaves e valor desembrulhado. */
async function rawShapeAt(param: ComponentParam, time: TickTime): Promise<unknown> {
  let raw: unknown;
  try {
    raw = await param.getValueAtTime(time);
  } catch (cause) {
    return `(erro: ${describeError(cause)})`;
  }
  const inner = raw && typeof raw === "object" ? (raw as { value?: unknown }).value : undefined;
  return {
    forma: describeShape(raw),
    formaInterna: describeShape(inner),
    valor: unwrapValue(raw),
  };
}

/** Os quatro relógios de cada clipe alvo, em ticks. */
async function clipClocks(
  byKey: Map<string, VideoClipTrackItem>,
  targets: FlowTarget[]
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const read = async (get: () => unknown): Promise<string> => {
    try {
      const time = (await Promise.resolve(get())) as TickTime | null;
      return time ? String(time.ticks) : "(vazio)";
    } catch (cause) {
      return `(erro: ${describeError(cause)})`;
    }
  };
  for (const target of targets) {
    const clip = byKey.get(target.param.clipKey);
    if (!clip || out[target.param.clipKey]) {
      continue;
    }
    out[target.param.clipKey] = {
      sequenciaIn: await read(() => clip.getStartTime()),
      sequenciaOut: await read(() => clip.getEndTime()),
      mediaIn: await read(() => clip.getInPoint()),
      mediaOut: await read(() => clip.getOutPoint()),
    };
  }
  return out;
}

/** A lista de keyframes, com valor, de cada parâmetro tocado. */
async function keyframesByParam(
  plans: SegmentPlan[],
  byKey: Map<string, VideoClipTrackItem>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const plan of plans) {
    const label = plan.descriptor?.label ?? safeDisplayName(plan.param);
    if (out[label]) {
      continue;
    }
    let param: ComponentParam | null = null;
    try {
      param = plan.descriptor ? await resolveParam(byKey, plan.descriptor) : null;
    } catch {
      param = null;
    }
    out[label] = await probeKeyframes(param ?? plan.param);
  }
  return out;
}

interface AnchorReport {
  param: string;
  ticks: string;
  antes: number | { x: number; y: number };
  depois: unknown;
  reparado: boolean;
  depoisDoReparo?: unknown;
  erro?: string;
}

/** Igual o bastante: diferença abaixo do que o Effect Controls mostra. */
function sameValue(
  a: number | { x: number; y: number },
  b: number | { x: number; y: number } | null
): boolean {
  if (b === null) {
    return false;
  }
  if (typeof a === "number" || typeof b === "number") {
    return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-3;
  }
  return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4;
}

/**
 * Relê cada âncora tocado pelo bake e reescreve o que mudou de valor.
 * Devolve um relato por âncora, para o relatório dizer se precisou.
 */
async function repairAnchors(
  ppro: premierepro,
  project: Project,
  plans: SegmentPlan[],
  byKey: Map<string, VideoClipTrackItem>
): Promise<AnchorReport[]> {
  const rows: AnchorReport[] = [];
  const seen = new Set<string>();

  for (const plan of plans) {
    let fresh: ComponentParam | null = null;
    try {
      fresh = plan.descriptor ? await resolveParam(byKey, plan.descriptor) : null;
    } catch {
      fresh = null;
    }
    const handle = fresh ?? plan.param;
    const label = plan.descriptor?.label ?? safeDisplayName(plan.param);

    for (const anchor of plan.anchors) {
      const id = `${plan.key}@${anchor.ticks}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const time = ppro.TickTime.createWithTicks(anchor.ticks);
      const depois = await readValue(handle, time);
      const row: AnchorReport = {
        param: label,
        ticks: anchor.ticks,
        antes: anchor.value,
        depois,
        reparado: false,
      };
      rows.push(row);

      if (sameValue(anchor.value, depois)) {
        continue;
      }
      console.warn(`[Flow] ${label}: âncora em ${anchor.ticks} mudou de`, anchor.value, "para", depois);

      try {
        let apagou = false;
        project.lockedAccess(() => {
          apagou = project.executeTransaction((compoundAction) => {
            compoundAction.addAction(
              handle.createRemoveKeyframeAction(
                ppro.TickTime.createWithTicks(anchor.ticks),
                false
              )
            );
          }, "Curva: repor âncora (apagar)");
        });
        let escreveu = false;
        project.lockedAccess(() => {
          escreveu = project.executeTransaction((compoundAction) => {
            const keyframe = makeKeyframe(ppro, handle, anchor.value);
            keyframe.position = ppro.TickTime.createWithTicks(anchor.ticks);
            compoundAction.addAction(handle.createAddKeyframeAction(keyframe));
          }, "Curva: repor âncora (escrever)");
        });
        row.reparado = apagou && escreveu;
      } catch (cause) {
        row.erro = describeError(cause);
        console.warn("[Flow] a reposição do âncora não assentou:", cause);
      }
      row.depoisDoReparo = await readValue(handle, time);
    }
  }
  return rows;
}

/**
 * Removes every keyframe the commit left on a parameter that is neither
 * one the editor had nor one this bake filed.
 *
 * The transaction says what was asked for, not what the host did with
 * it: the Zoom tool measured Premiere planting a keyframe of its own
 * (tick 0, value 0) beside the ones the plugin wrote. So the list is
 * read back and compared, as numbers — the host spells a tick its own
 * way — against what the parameter should hold. Strays go in a
 * transaction of their own, after the commit: if it fails, the bake
 * stays applied. Returns how many were removed.
 */
async function sweepStrays(
  ppro: premierepro,
  project: Project,
  plans: SegmentPlan[],
  filed: Array<{ key: string; added: string[]; removed: string[] }>,
  byKey: Map<string, VideoClipTrackItem>
): Promise<number> {
  const normal = (ticks: string): string => {
    try {
      return BigInt(ticks).toString();
    } catch {
      return ticks;
    }
  };

  /** What each parameter should hold now, by registry key. */
  const expected = new Map<string, Set<string>>();
  const paramOf = new Map<string, { plan: SegmentPlan }>();
  for (const plan of plans) {
    let set = expected.get(plan.key);
    if (!set) {
      set = new Set(plan.existing.map(normal));
      expected.set(plan.key, set);
      paramOf.set(plan.key, { plan });
    }
  }
  for (const record of filed) {
    const set = expected.get(record.key);
    if (!set) {
      continue;
    }
    for (const ticks of record.removed) {
      set.delete(normal(ticks));
    }
    for (const ticks of record.added) {
      set.add(normal(ticks));
    }
  }

  const strays: Array<{ param: ComponentParam; times: TickTime[]; label: string }> = [];
  for (const [key, set] of expected) {
    const plan = paramOf.get(key)?.plan;
    if (!plan) {
      continue;
    }
    let param: ComponentParam | null = null;
    try {
      param = plan.descriptor ? await resolveParam(byKey, plan.descriptor) : null;
    } catch {
      param = null;
    }
    const handle = param ?? plan.param;
    const times = await keyframeTimes(handle);
    const alien = times.filter((time) => !set.has(normal(time.ticks)));
    if (alien.length > 0) {
      strays.push({
        param: handle,
        times: alien,
        label: plan.descriptor?.label ?? safeDisplayName(handle),
      });
    }
  }

  if (strays.length === 0) {
    return 0;
  }

  for (const stray of strays) {
    console.warn(
      `[Flow] ${stray.label}: ${stray.times.length} keyframe(s) alheio(s) em`,
      stray.times.map((time) => time.ticks).join(", ")
    );
  }

  let removed = 0;
  try {
    project.lockedAccess(() => {
      const committed = project.executeTransaction((compoundAction) => {
        for (const stray of strays) {
          for (const time of stray.times) {
            try {
              const action = stray.param.createRemoveKeyframeAction(
                ppro.TickTime.createWithTicks(time.ticks),
                false
              );
              if (action && compoundAction.addAction(action as never) !== false) {
                removed += 1;
              }
            } catch (cause) {
              console.warn("[Flow] remoção de keyframe alheio recusada:", cause);
            }
          }
        }
      }, "Limpar keyframe alheio da curva");
      if (!committed) {
        removed = 0;
      }
    });
  } catch (cause) {
    console.warn("[Flow] a limpeza dos keyframes alheios não assentou:", cause);
    return 0;
  }
  return removed;
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

  // O que o host respondeu nos âncoras, CRU — a forma e o valor — e a
  // curva amostrada, para o relatório dizer onde o zero nasce. Custa
  // duas perguntas a mais ao host por trecho, então só com o
  // diagnóstico ligado.
  if (DIAG_ENABLED) {
  build.diag.push({
    param: safeDisplayName(param),
    startTicks,
    endTicks,
    startSeconds,
    endSeconds,
    frames,
    steps,
    de: { forma: await rawShapeAt(param, startTime), lido: from },
    para: { forma: await rawShapeAt(param, endTime), lido: to },
    ease: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((t) => [t, ease(t)]),
    add,
  });
  }

  if (add.length === 0) {
    build.notes.push("Nenhum frame livre entre os keyframes do trecho.");
    return null;
  }

  const existing = (await keyframeTimes(param)).map((time) => time.ticks);
  return {
    param,
    key: "",
    removeTicks: await innerTicks(param, startTicks, endTicks),
    add,
    before: existing.length,
    existing,
    anchors: [
      { ticks: startTicks, value: from },
      { ticks: endTicks, value: to },
    ],
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
