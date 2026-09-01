/**
 * Zoom In / Out — timeline logic.
 *
 * For every selected video clip a NEW `Transform` effect instance is appended
 * to the clip's video component chain and its Scale is keyframed across the
 * clip's visible range. The clip's intrinsic `Motion` (Scale, Position, Anchor
 * Point and any keyframes the editor already made) is never touched.
 */
import type {
  Component,
  ComponentParam,
  premierepro,
  VideoComponentChain,
  VideoFilterComponent,
} from "@adobe/premierepro";
import {
  collectSelectedVideoClips,
  describeError,
  getPremiere,
  readTicksPerFrame,
  snapTicksToFrame,
} from "../../bridge/premiere";

export type ZoomDirection = "in" | "out";

/**
 * `full` spans the whole visible clip at the parameter's default interpolation.
 * `punch` is a short accent at the head of the clip that eases out hard.
 */
export type ZoomStyle = "full" | "punch";

export interface ZoomOptions {
  direction: ZoomDirection;
  style: ZoomStyle;
  /** Scale target in percent, relative to the framing the clip already has. */
  scalePercent: number;
  /** Punch Smooth duration in seconds. Ignored when style is "full". */
  punchDuration: number;
  /** The speed curve to bake. Progress 0..1 in, eased progress out. */
  ease: (t: number) => number;
}

export interface ZoomResult {
  ok: boolean;
  message: string;
}

export const SCALE_MIN = 105;
export const SCALE_MAX = 150;

export const SCALE_DEFAULTS: Record<ZoomStyle, number> = {
  full: 115,
  punch: 120,
};

export const PUNCH_DURATION_MIN = 0.4;
export const PUNCH_DURATION_MAX = 4.0;
export const PUNCH_DURATION_DEFAULT = 1.6;
export const PUNCH_DURATION_PRESETS = [0.8, 1.2, 1.6, 2.0];

/**
 * How many keyframes a curved zoom lays down between its two ends.
 *
 * Sampled evenly in time rather than at even progress: even-progress
 * spacing cannot represent a curve that overshoots, and every drawn
 * curve can. Frame snapping caps this from below on short punches.
 */
const CURVE_KEYS = 8;

/** Transform's Scale at 100% leaves the incoming image exactly as it was. */
const NEUTRAL_SCALE = 100;

/**
 * Candidate matchNames for the Transform video filter. One of these must be
 * present in `VideoFilterFactory.getMatchNames()` — nothing is assumed.
 */
const TRANSFORM_MATCH_NAMES = ["AE.ADBE Geometry2", "ADBE Geometry2"];

/** `ComponentParam` exposes no matchName, only a localized display name. */
const SCALE_PARAM_NAMES = new Set([
  "scale",
  "scale (zoom)",
  "escala",
  "escala (zoom)",
  "échelle",
  "echelle",
  "skalierung",
  "scala",
  "schaal",
  "skala",
  "масштаб",
  "スケール",
  "缩放",
  "縮放",
  "비율",
]);

export async function applyZoom(options: ZoomOptions): Promise<ZoomResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return fail("Premiere UXP runtime unavailable.");
  }

  /**
   * Takes the appended Transforms back out.
   *
   * The insert and the keyframes are two transactions, and the second one
   * failing left an inert Transform on every selected clip — one more per
   * attempt, for the editor to find and delete by hand. Assigned once the
   * first transaction has actually committed, so the catch below can undo
   * it too.
   */
  let rollbackAppends: (() => void) | null = null;

  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      return fail("No active project.");
    }

    const sequence = await project.getActiveSequence();
    if (!sequence) {
      return fail("Open a sequence in the timeline first.");
    }

    const videoClips = await collectSelectedVideoClips(ppro, sequence);
    if (videoClips.length === 0) {
      return fail("Nenhum clipe de vídeo selecionado na timeline.");
    }
    const ticksPerFrame = await readTicksPerFrame(sequence);

    const { matchName: transformMatchName, candidates } =
      await resolveTransformMatchName(ppro);
    if (!transformMatchName) {
      return fail(
        `Transform effect not found in Premiere VideoFilterFactory. Relevant candidates: ${
          candidates.length > 0 ? candidates.join(", ") : "none"
        }`
      );
    }

    console.log(`[Zoom] Using Transform matchName: "${transformMatchName}"`);

    interface ClipTarget {
      /** Stable identity, so the clip can be found again after a commit. */
      clipKey: string;
      chain: VideoComponentChain;
      newComponent: VideoFilterComponent;
      /** Chain length before the append — where the new component lands. */
      appendIndex: number;
      startTicks: string;
      endTicks: string;
    }

    const targets: ClipTarget[] = [];
    let speedSkipped = 0;

    for (const ref of videoClips) {
      const clip = ref.clip;
      const chain = await clip.getComponentChain();
      if (!chain) {
        continue;
      }

      // Speed changes break the arithmetic the same way they break the
      // silence cut: a second of source stops being a second of sequence,
      // so a punch of "1.6s" runs for 0.8s on a clip at 200%. The Silence
      // Tool has always refused these; this one used to cut them crooked.
      const speed = await Promise.resolve(clip.getSpeed()).catch(() => 1);
      if (Number.isFinite(speed) && Math.abs(speed - 1) > 0.001) {
        speedSkipped += 1;
        continue;
      }

      const inPoint = await clip.getInPoint();
      const outPoint = await clip.getOutPoint();
      if (!inPoint || !outPoint || !(outPoint.seconds > inPoint.seconds)) {
        continue;
      }

      const newComponent = await ppro.VideoFilterFactory.createComponent(
        transformMatchName
      );
      if (!newComponent) {
        continue;
      }

      // An append lands at the end, so the index it will occupy is the
      // length now. Reading it back by index beats guessing "the last
      // one", which happily returned somebody else's effect.
      const appendIndex = await Promise.resolve(chain.getComponentCount());

      // Full Clip runs edge to edge; Punch Smooth is a short accent at the
      // head, clamped so it can never run past the clip.
      const punchSec = Math.max(PUNCH_DURATION_MIN, Math.min(PUNCH_DURATION_MAX, options.punchDuration));
      const endTime =
        options.style === "punch"
          ? ppro.TickTime.createWithSeconds(
              Math.min(inPoint.seconds + punchSec, outPoint.seconds)
            )
          : outPoint;

      targets.push({
        clipKey: ref.key,
        chain,
        newComponent,
        appendIndex,
        startTicks: inPoint.ticks,
        endTicks: endTime.ticks,
      });
    }

    if (targets.length === 0) {
      return fail(
        speedSkipped > 0
          ? `Nenhum clipe elegível: ${speedSkipped} com velocidade alterada. ` +
            "O Zoom precisa de clipes a 100% para o tempo do punch bater."
          : "Nenhum clipe selecionado aceitou um efeito Transform."
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Transaction 1: Insert Transform component into each clip's chain
    // ─────────────────────────────────────────────────────────────────────────
    let insertCommitted = false;
    project.lockedAccess(() => {
      insertCommitted = project.executeTransaction((compoundAction) => {
        for (const target of targets) {
          const action = target.chain.createAppendComponentAction(
            target.newComponent
          );
          compoundAction.addAction(action);
        }
      }, "Adicionar efeito Transform");
    });

    if (!insertCommitted) {
      return fail("O Premiere recusou a inserção do efeito Transform.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // After insertion: locate Scale param on the committed Transform
    // ─────────────────────────────────────────────────────────────────────────
    interface ReadyScaleItem {
      chain: VideoComponentChain;
      scaleParam: ComponentParam;
      startTicks: string;
      endTicks: string;
    }

    const readyScaleItems: ReadyScaleItem[] = [];
    /** Every Transform the append actually landed, so it can be undone. */
    const appended: Array<{ chain: VideoComponentChain; component: Component }> = [];

    rollbackAppends = (): void => {
      if (appended.length === 0) {
        return;
      }
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compoundAction) => {
            for (const entry of appended) {
              compoundAction.addAction(
                entry.chain.createRemoveComponentAction(entry.component)
              );
            }
          }, "Remover efeito Transform");
        });
      } catch (cause) {
        console.error("[Zoom] não foi possível remover os Transform inseridos:", cause);
      }
    };

    /*
     * Everything below is read again from the host.
     *
     * The chains captured before the append are snapshots of a project
     * that has since changed, and touching one of them answers "The
     * script object is no longer valid" — the same failure that the
     * Organize tool was hitting. Identity survives the commit; handles
     * do not.
     */
    const refreshedSequence = await (await ppro.Project.getActiveProject())
      ?.getActiveSequence();
    const refreshedClips = refreshedSequence
      ? await collectSelectedVideoClips(ppro, refreshedSequence)
      : [];
    const clipByKey = new Map(refreshedClips.map((ref) => [ref.key, ref.clip]));

    for (const target of targets) {
      const clip = clipByKey.get(target.clipKey);
      if (!clip) {
        console.warn("[Zoom] clipe não encontrado após a inserção do Transform");
        continue;
      }
      const chain = await clip.getComponentChain();
      if (!chain) {
        console.warn("[Zoom] cadeia de efeitos ilegível após a inserção");
        continue;
      }

      const comp = await findTransformComponent(
        chain,
        transformMatchName,
        target.appendIndex
      );
      if (!comp) {
        console.warn("[Zoom] componente Transform não encontrado no clipe");
        continue;
      }
      appended.push({ chain, component: comp });

      const scaleParam = await findScaleParamWithDiag(comp);
      if (!scaleParam) {
        console.warn("[Zoom] parâmetro Scale não encontrado no Transform");
        continue;
      }

      readyScaleItems.push({
        chain,
        scaleParam,
        startTicks: target.startTicks,
        endTicks: target.endTicks,
      });
    }

    if (readyScaleItems.length === 0) {
      rollbackAppends();
      return fail(
        "Nenhum parâmetro Scale encontrado no Transform. O console do UXP tem o dump."
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Transaction 2: Enable timeVarying + add keyframes in ONE transaction
    // The Adobe API expects setTimeVarying and addKeyframe as complementary
    // actions within the same compound action.
    // ─────────────────────────────────────────────────────────────────────────
    const [baseFrom, baseTo] =
      options.direction === "in"
        ? [NEUTRAL_SCALE, options.scalePercent]
        : [options.scalePercent, NEUTRAL_SCALE];

    let animCommitted = false;
    project.lockedAccess(() => {
      animCommitted = project.executeTransaction((compoundAction) => {
        for (const item of readyScaleItems) {
          const { scaleParam, startTicks, endTicks } = item;

          // Enable animation (stopwatch) first
          compoundAction.addAction(
            scaleParam.createSetTimeVaryingAction(true)
          );

          const startSec = ppro.TickTime.createWithTicks(startTicks).seconds;
          const endSec = ppro.TickTime.createWithTicks(endTicks).seconds;
          const duration = endSec - startSec;

          if (duration > 0) {
            // One path for both styles: the chosen curve is baked either
            // way. Full Clip used to lay two keyframes and inherit
            // Premiere's interpolation, which meant it could only ever
            // be a straight line.
            const delta = baseTo - baseFrom;

            // Snapped to the frame grid and deduped: off-grid keyframes
            // land where the editor cannot reproduce them by dragging,
            // and two that round onto one frame become one keyframe with
            // an arbitrary value.
            const placed = new Map<string, number>();
            for (let step = 0; step <= CURVE_KEYS; step++) {
              const t = step / CURVE_KEYS;
              const ticks = snapTicksToFrame(
                ppro.TickTime.createWithSeconds(startSec + duration * t).ticks,
                ticksPerFrame
              );
              placed.set(ticks, baseFrom + delta * options.ease(t));
            }
            // Whichever frame the last sample rounded onto, it holds the
            // target exactly.
            const lastTicks = snapTicksToFrame(
              ppro.TickTime.createWithSeconds(startSec + duration).ticks,
              ticksPerFrame
            );
            placed.set(lastTicks, baseTo);

            for (const [ticks, value] of placed) {
              const kf = scaleParam.createKeyframe(value);
              kf.position = ppro.TickTime.createWithTicks(ticks);
              compoundAction.addAction(scaleParam.createAddKeyframeAction(kf));
            }

            // Without LINEAR, Premiere smooths on top of the baked curve
            // and the shape drifts.
            for (const ticks of placed.keys()) {
              compoundAction.addAction(
                scaleParam.createSetInterpolationAtKeyframeAction(
                  ppro.TickTime.createWithTicks(ticks),
                  ppro.Constants.InterpolationMode.LINEAR
                )
              );
            }
          }
        }
      }, "Aplicar Zoom");
    });

    if (!animCommitted) {
      rollbackAppends();
      return fail("Premiere rejected the zoom animation transaction.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Validation: verify keyframes exist via getKeyframeListAsTickTimes
    // ─────────────────────────────────────────────────────────────────────────
    let verifiedCount = 0;
    let unreadableCount = 0;
    for (const item of readyScaleItems) {
      try {
        const kfTimes = item.scaleParam.getKeyframeListAsTickTimes();
        const count = Array.isArray(kfTimes) ? kfTimes.length : 0;
        console.log(`[Zoom] Scale keyframe count after commit: ${count}`);
        if (count >= 2) {
          verifiedCount += 1;
        }
      } catch (err) {
        console.warn("[Zoom] getKeyframeListAsTickTimes error:", err);
        // The transaction did commit, so this is not evidence of failure —
        // but folding it into `verifiedCount` made the number in the
        // message stop meaning "keyframes are there".
        unreadableCount += 1;
      }
    }

    if (verifiedCount === 0 && unreadableCount === 0) {
      rollbackAppends();
      return fail("Nenhum keyframe foi criado no Scale do Transform.");
    }

    // One subtraction against the clips we started from. Adding a running
    // `skipped` to it counted the same clip twice.
    const applied = verifiedCount + unreadableCount;
    return {
      ok: true,
      message: summarize(
        applied,
        videoClips.length - applied,
        unreadableCount,
        speedSkipped
      ),
    };
  } catch (cause) {
    rollbackAppends?.();
    return fail(`Zoom falhou: ${describeError(cause)}`);
  }
}

/** Returns the host's own spelling of the Transform matchName, or null. */
async function resolveTransformMatchName(
  ppro: premierepro
): Promise<{ matchName: string | null; candidates: string[] }> {
  let available: string[] = [];
  try {
    const names = await ppro.VideoFilterFactory.getMatchNames();
    if (Array.isArray(names)) {
      available = names;
    }
  } catch (err) {
    console.error("[Zoom] Failed to getMatchNames from VideoFilterFactory:", err);
    return { matchName: null, candidates: [] };
  }

  const candidates = available.filter(
    (name) => typeof name === "string" && /geometry|transform/i.test(name)
  );
  console.log(
    "[Zoom] Available Transform/Geometry video filter matchNames:",
    candidates
  );

  if (candidates.length === 0) {
    return { matchName: null, candidates: [] };
  }

  const byLowercase = new Map<string, string>();
  for (const name of available) {
    if (typeof name === "string") {
      byLowercase.set(name.toLowerCase(), name);
    }
  }

  for (const candidate of TRANSFORM_MATCH_NAMES) {
    const match = byLowercase.get(candidate.toLowerCase());
    if (match) {
      return { matchName: match, candidates };
    }
  }

  const geometry2 = candidates.find((c) => /geometry2/i.test(c));
  if (geometry2) {
    return { matchName: geometry2, candidates };
  }

  const transform = candidates.find((c) => /transform/i.test(c));
  if (transform) {
    return { matchName: transform, candidates };
  }

  const geometry = candidates.find((c) => /geometry/i.test(c));
  if (geometry) {
    return { matchName: geometry, candidates };
  }

  return { matchName: null, candidates };
}

/**
 * The Transform that was just appended.
 *
 * Looked up at the index the append was going to occupy, then confirmed
 * by matchName. The old version fell back to "the last component in the
 * chain" with no check at all, which would happily hand back an unrelated
 * effect for the keyframes to land in.
 */
async function findTransformComponent(
  chain: VideoComponentChain,
  expectedMatchName: string,
  appendIndex: number
): Promise<Component | null> {
  const count = await Promise.resolve(chain.getComponentCount());
  if (count === 0) {
    return null;
  }

  const matches = async (component: Component | null): Promise<boolean> => {
    if (!component) {
      return false;
    }
    const matchName = await component.getMatchName().catch(() => "");
    return matchName.toLowerCase() === expectedMatchName.toLowerCase();
  };

  if (appendIndex < count) {
    try {
      const atIndex = await Promise.resolve(chain.getComponentAtIndex(appendIndex));
      if (await matches(atIndex)) {
        return atIndex;
      }
    } catch {
      // Fall through to the search below.
    }
  }

  // The chain shifted under us. Search only what was added after the
  // append point, so an effect that was already there cannot be picked.
  for (let index = count - 1; index >= appendIndex; index--) {
    try {
      const component = await Promise.resolve(chain.getComponentAtIndex(index));
      if (await matches(component)) {
        return component;
      }
    } catch {
      // Keep looking.
    }
  }

  return null;
}

/**
 * Dumps every param (index | displayName | areKeyframesSupported) of the
 * Transform component to the console, then returns the Scale param.
 * areKeyframesSupported() is checked per-param for diagnostic purposes only —
 * it is NOT used as a hard gate.
 */
async function findScaleParamWithDiag(
  component: Component
): Promise<ComponentParam | null> {
  let count = 0;
  try {
    count = component.getParamCount();
  } catch {
    console.error("[Zoom] getParamCount() threw on Transform component");
    return null;
  }

  console.log(`[Zoom] Transform has ${count} params:`);
  const rows: { index: number; name: string; kf: boolean | string }[] = [];

  for (let index = 0; index < count; index++) {
    try {
      const param = component.getParam(index);
      const name = safeDisplayName(param);
      let kf: boolean | string = "?";
      try {
        kf = await param.areKeyframesSupported();
      } catch {
        kf = "error";
      }
      rows.push({ index, name, kf });
    } catch {
      rows.push({ index, name: "(error)", kf: "error" });
    }
  }

  for (const row of rows) {
    console.log(`  [${row.index}] "${row.name}" | keyframesSupported=${row.kf}`);
  }

  // Pass 1: exact match with known localized names. No "uniform" guard
  // here — nothing in SCALE_PARAM_NAMES contains it, so the check was dead.
  for (const row of rows) {
    if (SCALE_PARAM_NAMES.has(row.name)) {
      try {
        return component.getParam(row.index);
      } catch {
        // continue
      }
    }
  }

  // Pass 2: starts with "scale" / "escala" but not uniform/width/height
  for (const row of rows) {
    const name = row.name;
    if (
      (name.startsWith("scale") || name.startsWith("escala")) &&
      !name.includes("width") &&
      !name.includes("height") &&
      !name.includes("largura") &&
      !name.includes("altura") &&
      !name.includes("uniform") &&
      !name.includes("proporç")
    ) {
      try {
        return component.getParam(row.index);
      } catch {
        // continue
      }
    }
  }

  // Pass 3: any keyframeable param whose name mentions scale, in either
  // spelling. Looking only for "scale" meant this last resort never fired
  // on a Premiere running in Portuguese, which is the one it exists for.
  for (const row of rows) {
    const mentionsScale =
      row.name.includes("scale") || row.name.includes("escala");
    if (row.kf === true && mentionsScale && !row.name.includes("uniform")) {
      try {
        return component.getParam(row.index);
      } catch {
        // continue
      }
    }
  }

  console.warn("[Zoom] Could not match Scale param in any pass.");
  return null;
}


function safeDisplayName(param: ComponentParam): string {
  try {
    return (param.displayName ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function summarize(
  applied: number,
  skipped: number,
  unverified: number,
  speedSkipped: number
): string {
  const parts = [`Zoom aplicado em ${applied} ${plural(applied, "clipe")}.`];
  if (speedSkipped > 0) {
    parts.push(
      `${speedSkipped} ${plural(speedSkipped, "clipe")} com velocidade alterada ` +
        `${speedSkipped === 1 ? "foi ignorado" : "foram ignorados"}.`
    );
  }
  const other = skipped - speedSkipped;
  if (other > 0) {
    parts.push(
      `${other} sem Scale no Transform ${other === 1 ? "foi ignorado" : "foram ignorados"}.`
    );
  }
  if (unverified > 0) {
    parts.push(
      `Não consegui reler ${unverified} — confira o Effect Controls.`
    );
  }
  return parts.join(" ");
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function fail(message: string): ZoomResult {
  return { ok: false, message };
}

