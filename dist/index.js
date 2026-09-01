(function() {
  "use strict";
  function getPremiere() {
    if (typeof require !== "function") {
      return null;
    }
    try {
      return require("premierepro") ?? null;
    } catch {
      return null;
    }
  }
  function describeError(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const EMPTY_SELECTION = {
    clips: [],
    rangeStart: 0,
    rangeEnd: 0,
    selectedCount: 0,
    selectedSeconds: 0,
    trackLabel: null,
    spansTracks: false,
    playheadRatio: null
  };
  async function readSelection() {
    const ppro = getPremiere();
    if (!ppro) {
      return EMPTY_SELECTION;
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      const sequence = project2 ? await project2.getActiveSequence() : null;
      if (!sequence) {
        return EMPTY_SELECTION;
      }
      const trackCount = await sequence.getVideoTrackCount();
      let best = [];
      let bestSelected = 0;
      let bestIndex = -1;
      let totalSelected = 0;
      let totalSeconds = 0;
      for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        const track = await sequence.getVideoTrack(trackIndex);
        if (!track) {
          continue;
        }
        const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
        const clips = [];
        let selected = 0;
        for (const item of items) {
          const start = await item.getStartTime();
          const end = await item.getEndTime();
          const startSeconds = start.seconds;
          const endSeconds = end.seconds;
          if (!(endSeconds > startSeconds)) {
            continue;
          }
          const isSelected = await item.getIsSelected();
          if (isSelected) {
            selected += 1;
            totalSelected += 1;
            totalSeconds += endSeconds - startSeconds;
          }
          clips.push({ startSeconds, endSeconds, selected: isSelected });
        }
        if (selected > bestSelected) {
          best = clips;
          bestSelected = selected;
          bestIndex = trackIndex;
        }
      }
      if (totalSelected === 0) {
        return EMPTY_SELECTION;
      }
      let rangeStart = Number.POSITIVE_INFINITY;
      let rangeEnd = Number.NEGATIVE_INFINITY;
      for (const clip of best) {
        if (clip.startSeconds < rangeStart) {
          rangeStart = clip.startSeconds;
        }
        if (clip.endSeconds > rangeEnd) {
          rangeEnd = clip.endSeconds;
        }
      }
      if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
        return EMPTY_SELECTION;
      }
      return {
        clips: best,
        rangeStart,
        rangeEnd,
        selectedCount: totalSelected,
        selectedSeconds: totalSeconds,
        trackLabel: `V${bestIndex + 1}`,
        spansTracks: totalSelected > bestSelected,
        playheadRatio: await readPlayheadRatio(sequence, rangeStart, rangeEnd)
      };
    } catch {
      return EMPTY_SELECTION;
    }
  }
  async function readPlayheadRatio(sequence, rangeStart, rangeEnd) {
    try {
      const span = rangeEnd - rangeStart;
      if (!(span > 0)) {
        return null;
      }
      const position = await sequence.getPlayerPosition();
      const ratio = (position.seconds - rangeStart) / span;
      return ratio >= 0 && ratio <= 1 ? ratio : null;
    } catch {
      return null;
    }
  }
  async function collectSelectedVideoClips(ppro, sequence) {
    const refs = [];
    const seen = /* @__PURE__ */ new Map();
    const trackCount = await sequence.getVideoTrackCount();
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      const track = await sequence.getVideoTrack(trackIndex);
      if (!track) {
        continue;
      }
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (const item of items) {
        if (await item.getIsSelected()) {
          const base = await clipIdentity(item, trackIndex, refs.length);
          const repeat = seen.get(base) ?? 0;
          seen.set(base, repeat + 1);
          refs.push({
            clip: item,
            key: repeat === 0 ? base : `${base}#${repeat}`,
            trackIndex
          });
        }
      }
    }
    return refs;
  }
  async function clipIdentity(clip, trackIndex, ordinal) {
    try {
      const name = await Promise.resolve(clip.getName()).catch(() => "");
      const inPoint = await clip.getInPoint();
      const outPoint = await clip.getOutPoint();
      return `v${trackIndex}|${name}|${inPoint.ticks}|${outPoint.ticks}`;
    } catch {
      return `v${trackIndex}|#${ordinal}`;
    }
  }
  async function readTicksPerFrame(sequence) {
    try {
      const settings = await sequence.getSettings();
      const rate = settings ? await settings.getVideoFrameRate() : null;
      const ticks = rate ? Number(rate.ticksPerFrame) : Number.NaN;
      return Number.isFinite(ticks) && ticks > 0 ? BigInt(Math.round(ticks)) : null;
    } catch {
      return null;
    }
  }
  function snapTicksToFrame(ticks, ticksPerFrame) {
    if (!ticksPerFrame || ticksPerFrame <= 0n) {
      return ticks;
    }
    try {
      const value = BigInt(ticks);
      if (value < 0n) {
        return ticks;
      }
      return ((value + ticksPerFrame / 2n) / ticksPerFrame * ticksPerFrame).toString();
    } catch {
      return ticks;
    }
  }
  const REQUIRED_HOST_APIS = [
    ["Project.getActiveProject", (ppro) => ppro.Project?.getActiveProject],
    ["TickTime.createWithTicks", (ppro) => ppro.TickTime?.createWithTicks],
    ["TickTime.createWithSeconds", (ppro) => ppro.TickTime?.createWithSeconds],
    ["PointF", (ppro) => ppro.PointF],
    ["Constants.TrackItemType", (ppro) => ppro.Constants?.TrackItemType],
    ["Constants.InterpolationMode", (ppro) => ppro.Constants?.InterpolationMode],
    ["Constants.MediaType", (ppro) => ppro.Constants?.MediaType],
    ["SequenceEditor", (ppro) => ppro.SequenceEditor],
    ["ClipProjectItem.cast", (ppro) => ppro.ClipProjectItem?.cast],
    [
      "TrackItemSelection.createEmptySelection",
      (ppro) => ppro.TrackItemSelection?.createEmptySelection
    ],
    ["VideoFilterFactory.createComponent", (ppro) => ppro.VideoFilterFactory?.createComponent],
    ["VideoFilterFactory.getMatchNames", (ppro) => ppro.VideoFilterFactory?.getMatchNames]
  ];
  function checkHostCapabilities() {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: true, missing: [] };
    }
    const missing = [];
    for (const [name, read] of REQUIRED_HOST_APIS) {
      try {
        if (read(ppro) == null) {
          missing.push(name);
        }
      } catch {
        missing.push(name);
      }
    }
    return { ok: missing.length === 0, missing };
  }
  const SCALE_MIN = 105;
  const SCALE_MAX = 150;
  const SCALE_DEFAULTS = {
    full: 115,
    punch: 120
  };
  const PUNCH_DURATION_MIN = 0.4;
  const PUNCH_DURATION_MAX = 4;
  const PUNCH_DURATION_DEFAULT = 1.6;
  const PUNCH_DURATION_PRESETS = [0.8, 1.2, 1.6, 2];
  const CURVE_KEYS = 8;
  const NEUTRAL_SCALE = 100;
  const TRANSFORM_MATCH_NAMES = ["AE.ADBE Geometry2", "ADBE Geometry2"];
  const SCALE_PARAM_NAMES = /* @__PURE__ */ new Set([
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
    "비율"
  ]);
  async function applyZoom(options) {
    const ppro = getPremiere();
    if (!ppro) {
      return fail$2("Premiere UXP runtime unavailable.");
    }
    let rollbackAppends = null;
    try {
      const project2 = await ppro.Project.getActiveProject();
      if (!project2) {
        return fail$2("No active project.");
      }
      const sequence = await project2.getActiveSequence();
      if (!sequence) {
        return fail$2("Open a sequence in the timeline first.");
      }
      const videoClips = await collectSelectedVideoClips(ppro, sequence);
      if (videoClips.length === 0) {
        return fail$2("Nenhum clipe de vídeo selecionado na timeline.");
      }
      const ticksPerFrame = await readTicksPerFrame(sequence);
      const { matchName: transformMatchName, candidates: candidates2 } = await resolveTransformMatchName(ppro);
      if (!transformMatchName) {
        return fail$2(
          `Transform effect not found in Premiere VideoFilterFactory. Relevant candidates: ${candidates2.length > 0 ? candidates2.join(", ") : "none"}`
        );
      }
      console.log(`[Zoom] Using Transform matchName: "${transformMatchName}"`);
      const targets = [];
      let speedSkipped = 0;
      for (const ref of videoClips) {
        const clip = ref.clip;
        const chain = await clip.getComponentChain();
        if (!chain) {
          continue;
        }
        const speed = await Promise.resolve(clip.getSpeed()).catch(() => 1);
        if (Number.isFinite(speed) && Math.abs(speed - 1) > 1e-3) {
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
        const appendIndex = await Promise.resolve(chain.getComponentCount());
        const punchSec = Math.max(PUNCH_DURATION_MIN, Math.min(PUNCH_DURATION_MAX, options.punchDuration));
        const endTime = options.style === "punch" ? ppro.TickTime.createWithSeconds(
          Math.min(inPoint.seconds + punchSec, outPoint.seconds)
        ) : outPoint;
        targets.push({
          clipKey: ref.key,
          chain,
          newComponent,
          appendIndex,
          startTicks: inPoint.ticks,
          endTicks: endTime.ticks
        });
      }
      if (targets.length === 0) {
        return fail$2(
          speedSkipped > 0 ? `Nenhum clipe elegível: ${speedSkipped} com velocidade alterada. O Zoom precisa de clipes a 100% para o tempo do punch bater.` : "Nenhum clipe selecionado aceitou um efeito Transform."
        );
      }
      let insertCommitted = false;
      project2.lockedAccess(() => {
        insertCommitted = project2.executeTransaction((compoundAction) => {
          for (const target of targets) {
            const action = target.chain.createAppendComponentAction(
              target.newComponent
            );
            compoundAction.addAction(action);
          }
        }, "Adicionar efeito Transform");
      });
      if (!insertCommitted) {
        return fail$2("O Premiere recusou a inserção do efeito Transform.");
      }
      const readyScaleItems = [];
      const appended = [];
      rollbackAppends = () => {
        if (appended.length === 0) {
          return;
        }
        try {
          project2.lockedAccess(() => {
            project2.executeTransaction((compoundAction) => {
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
      const refreshedSequence = await (await ppro.Project.getActiveProject())?.getActiveSequence();
      const refreshedClips = refreshedSequence ? await collectSelectedVideoClips(ppro, refreshedSequence) : [];
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
          endTicks: target.endTicks
        });
      }
      if (readyScaleItems.length === 0) {
        rollbackAppends();
        return fail$2(
          "Nenhum parâmetro Scale encontrado no Transform. O console do UXP tem o dump."
        );
      }
      const [baseFrom, baseTo] = options.direction === "in" ? [NEUTRAL_SCALE, options.scalePercent] : [options.scalePercent, NEUTRAL_SCALE];
      let animCommitted = false;
      project2.lockedAccess(() => {
        animCommitted = project2.executeTransaction((compoundAction) => {
          for (const item of readyScaleItems) {
            const { scaleParam, startTicks, endTicks } = item;
            compoundAction.addAction(
              scaleParam.createSetTimeVaryingAction(true)
            );
            const startSec = ppro.TickTime.createWithTicks(startTicks).seconds;
            const endSec = ppro.TickTime.createWithTicks(endTicks).seconds;
            const duration = endSec - startSec;
            if (duration > 0) {
              const delta = baseTo - baseFrom;
              const placed = /* @__PURE__ */ new Map();
              for (let step2 = 0; step2 <= CURVE_KEYS; step2++) {
                const t = step2 / CURVE_KEYS;
                const ticks = snapTicksToFrame(
                  ppro.TickTime.createWithSeconds(startSec + duration * t).ticks,
                  ticksPerFrame
                );
                placed.set(ticks, baseFrom + delta * options.ease(t));
              }
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
        return fail$2("Premiere rejected the zoom animation transaction.");
      }
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
          unreadableCount += 1;
        }
      }
      if (verifiedCount === 0 && unreadableCount === 0) {
        rollbackAppends();
        return fail$2("Nenhum keyframe foi criado no Scale do Transform.");
      }
      const applied = verifiedCount + unreadableCount;
      return {
        ok: true,
        message: summarize(
          applied,
          videoClips.length - applied,
          unreadableCount,
          speedSkipped
        )
      };
    } catch (cause) {
      rollbackAppends?.();
      return fail$2(`Zoom falhou: ${describeError(cause)}`);
    }
  }
  async function resolveTransformMatchName(ppro) {
    let available = [];
    try {
      const names = await ppro.VideoFilterFactory.getMatchNames();
      if (Array.isArray(names)) {
        available = names;
      }
    } catch (err) {
      console.error("[Zoom] Failed to getMatchNames from VideoFilterFactory:", err);
      return { matchName: null, candidates: [] };
    }
    const candidates2 = available.filter(
      (name) => typeof name === "string" && /geometry|transform/i.test(name)
    );
    console.log(
      "[Zoom] Available Transform/Geometry video filter matchNames:",
      candidates2
    );
    if (candidates2.length === 0) {
      return { matchName: null, candidates: [] };
    }
    const byLowercase = /* @__PURE__ */ new Map();
    for (const name of available) {
      if (typeof name === "string") {
        byLowercase.set(name.toLowerCase(), name);
      }
    }
    for (const candidate of TRANSFORM_MATCH_NAMES) {
      const match = byLowercase.get(candidate.toLowerCase());
      if (match) {
        return { matchName: match, candidates: candidates2 };
      }
    }
    const geometry2 = candidates2.find((c) => /geometry2/i.test(c));
    if (geometry2) {
      return { matchName: geometry2, candidates: candidates2 };
    }
    const transform = candidates2.find((c) => /transform/i.test(c));
    if (transform) {
      return { matchName: transform, candidates: candidates2 };
    }
    const geometry = candidates2.find((c) => /geometry/i.test(c));
    if (geometry) {
      return { matchName: geometry, candidates: candidates2 };
    }
    return { matchName: null, candidates: candidates2 };
  }
  async function findTransformComponent(chain, expectedMatchName, appendIndex) {
    const count = await Promise.resolve(chain.getComponentCount());
    if (count === 0) {
      return null;
    }
    const matches = async (component) => {
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
      }
    }
    for (let index = count - 1; index >= appendIndex; index--) {
      try {
        const component = await Promise.resolve(chain.getComponentAtIndex(index));
        if (await matches(component)) {
          return component;
        }
      } catch {
      }
    }
    return null;
  }
  async function findScaleParamWithDiag(component) {
    let count = 0;
    try {
      count = component.getParamCount();
    } catch {
      console.error("[Zoom] getParamCount() threw on Transform component");
      return null;
    }
    console.log(`[Zoom] Transform has ${count} params:`);
    const rows = [];
    for (let index = 0; index < count; index++) {
      try {
        const param = component.getParam(index);
        const name = safeDisplayName$1(param);
        let kf = "?";
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
    for (const row of rows) {
      if (SCALE_PARAM_NAMES.has(row.name)) {
        try {
          return component.getParam(row.index);
        } catch {
        }
      }
    }
    for (const row of rows) {
      const name = row.name;
      if ((name.startsWith("scale") || name.startsWith("escala")) && !name.includes("width") && !name.includes("height") && !name.includes("largura") && !name.includes("altura") && !name.includes("uniform") && !name.includes("proporç")) {
        try {
          return component.getParam(row.index);
        } catch {
        }
      }
    }
    for (const row of rows) {
      const mentionsScale = row.name.includes("scale") || row.name.includes("escala");
      if (row.kf === true && mentionsScale && !row.name.includes("uniform")) {
        try {
          return component.getParam(row.index);
        } catch {
        }
      }
    }
    console.warn("[Zoom] Could not match Scale param in any pass.");
    return null;
  }
  function safeDisplayName$1(param) {
    try {
      return (param.displayName ?? "").trim().toLowerCase();
    } catch {
      return "";
    }
  }
  function summarize(applied, skipped, unverified, speedSkipped) {
    const parts = [`Zoom aplicado em ${applied} ${plural(applied, "clipe")}.`];
    if (speedSkipped > 0) {
      parts.push(
        `${speedSkipped} ${plural(speedSkipped, "clipe")} com velocidade alterada ${speedSkipped === 1 ? "foi ignorado" : "foram ignorados"}.`
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
  function plural(count, word) {
    return count === 1 ? word : `${word}s`;
  }
  function fail$2(message) {
    return { ok: false, message };
  }
  const SAMPLES = 48;
  function curveGeometry(shape, scalePercent, width, height, pad, ease) {
    const left = pad;
    const right = width - pad;
    const baseY = height - pad;
    const topY = pad + (1 - (scalePercent - 100) / 50) * (height - pad * 2) * 0.62;
    const span = Math.max(0, Math.min(1, shape.span));
    const endX = left + span * (right - left);
    const pointAt = (t) => {
      const clamped = Math.max(0, Math.min(1, t));
      return {
        x: left + clamped * (endX - left),
        y: baseY - ease(clamped) * (baseY - topY)
      };
    };
    const steps = [];
    for (let step2 = 0; step2 <= SAMPLES; step2++) {
      const at = pointAt(step2 / SAMPLES);
      steps.push(`${step2 === 0 ? "M" : "L"}${at.x.toFixed(1)},${at.y.toFixed(1)}`);
    }
    const rise = steps.join(" ");
    return {
      rise,
      hold: `M${endX.toFixed(1)},${topY.toFixed(1)} L${right.toFixed(1)},${topY.toFixed(1)}`,
      area: `${rise} L${right.toFixed(1)},${topY.toFixed(1)} L${right.toFixed(1)},${baseY.toFixed(1)} L${left.toFixed(1)},${baseY.toFixed(1)} Z`,
      pointAt,
      endX,
      baseY,
      topY
    };
  }
  const CONTROL = 'role="button" tabindex="0"';
  function createControl(className, label) {
    const element = document.createElement("div");
    element.className = className;
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    if (label !== void 0) {
      element.textContent = label;
    }
    return element;
  }
  function setDisabled(element, disabled) {
    element.classList.toggle("is-disabled", disabled);
    element.setAttribute("aria-disabled", String(disabled));
    element.tabIndex = disabled ? -1 : 0;
  }
  function isDisabled(element) {
    return element.getAttribute("aria-disabled") === "true";
  }
  function bindKeyboard(root) {
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const control = target.closest('[role="button"]');
      if (!control || isDisabled(control)) {
        return;
      }
      event.preventDefault();
      control.click();
    });
  }
  const cubicBezier = (p1x, p1y, p2x, p2y) => {
    const curve = (a, b, t) => {
      const u = 1 - t;
      return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
    };
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let low = 0;
      let high = 1;
      let mid = x;
      for (let step2 = 0; step2 < 24; step2++) {
        mid = (low + high) / 2;
        if (curve(p1x, p2x, mid) < x) {
          low = mid;
        } else {
          high = mid;
        }
      }
      return curve(p1y, p2y, mid);
    };
  };
  const PUNCH_NORMALISER = 1 - Math.pow(2, -3);
  const CURVES = [
    {
      id: "punch",
      name: "Punch",
      ease: (t) => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        return (1 - Math.pow(2, -3 * t)) / PUNCH_NORMALISER;
      }
    },
    {
      id: "linear",
      name: "Linear",
      ease: (t) => Math.max(0, Math.min(1, t)),
      points: { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }
    },
    {
      id: "ease-out",
      name: "Ease Out",
      ease: cubicBezier(0.16, 0.84, 0.44, 1),
      points: { x1: 0.16, y1: 0.84, x2: 0.44, y2: 1 }
    },
    {
      id: "ease-in",
      name: "Ease In",
      ease: cubicBezier(0.56, 0, 0.84, 0.16),
      points: { x1: 0.56, y1: 0, x2: 0.84, y2: 0.16 }
    },
    {
      id: "ease-in-out",
      name: "Ease In / Out",
      ease: cubicBezier(0.65, 0, 0.35, 1),
      points: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 }
    },
    { id: "expo-out", name: "Expo Out", ease: (t) => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t) },
    { id: "expo-in-out", name: "Expo In / Out", ease: (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
    } },
    { id: "back-out", name: "Back Out", ease: (t) => {
      const c = 1.70158;
      const u = t - 1;
      return 1 + (c + 1) * u * u * u + c * u * u;
    } }
  ];
  function findCurve(id) {
    return CURVES.find((curve) => curve.id === id) ?? CURVES[0];
  }
  const DENSITY_MIN = 4;
  const DENSITY_MAX = 48;
  const DENSITY_DEFAULT = 16;
  const DENSITY_PRESETS = [8, 16, 24, 32];
  function curvePath(curve, width, height, pad) {
    const steps = 40;
    const points = [];
    for (let step2 = 0; step2 <= steps; step2++) {
      const t = step2 / steps;
      const x = pad + t * (width - pad * 2);
      const y = height - pad - curve.ease(t) * (height - pad * 2);
      points.push(`${step2 === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return points.join(" ");
  }
  const CUSTOM_CURVE = "custom";
  const CUSTOM_DEFAULT = { x1: 0.16, y1: 0.84, x2: 0.44, y2: 1 };
  const CURVE_Y_MIN = -0.6;
  const CURVE_Y_MAX = 1.6;
  function curveBox(width, height, padX, padY) {
    return { width, height, padX, padY, min: CURVE_Y_MIN, max: CURVE_Y_MAX };
  }
  function project(box, x, y) {
    const spanX = box.width - box.padX * 2;
    const spanY = box.height - box.padY * 2;
    return {
      x: box.padX + x * spanX,
      y: box.padY + (box.max - y) / (box.max - box.min) * spanY
    };
  }
  function unproject(box, x, y) {
    const spanX = box.width - box.padX * 2;
    const spanY = box.height - box.padY * 2;
    return {
      x: spanX > 0 ? (x - box.padX) / spanX : 0,
      y: spanY > 0 ? box.max - (y - box.padY) / spanY * (box.max - box.min) : 0
    };
  }
  function bezierPath(points, box) {
    const start = project(box, 0, 0);
    const one = project(box, points.x1, points.y1);
    const two = project(box, points.x2, points.y2);
    const end = project(box, 1, 1);
    return `M${round(start.x)},${round(start.y)} C${round(one.x)},${round(one.y)} ${round(two.x)},${round(two.y)} ${round(end.x)},${round(end.y)}`;
  }
  function clampPoints(points) {
    return {
      x1: clamp(points.x1, 0, 1),
      y1: clamp(points.y1, CURVE_Y_MIN, CURVE_Y_MAX),
      x2: clamp(points.x2, 0, 1),
      y2: clamp(points.y2, CURVE_Y_MIN, CURVE_Y_MAX)
    };
  }
  function customCurve(points) {
    const safe = clampPoints(points);
    return {
      id: CUSTOM_CURVE,
      name: "Sua curva",
      ease: cubicBezier(safe.x1, safe.y1, safe.x2, safe.y2),
      points: safe
    };
  }
  function formatPoints(points) {
    return [points.x1, points.y1, points.x2, points.y2].map(figure).join("  ");
  }
  function figure(value) {
    const fixed = value.toFixed(2);
    const trimmed = fixed.replace(/\.00$/, "");
    if (trimmed === "0" || trimmed === "-0") {
      return "0";
    }
    return trimmed.replace(/^0\./, ".").replace(/^-0\./, "-.");
  }
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) {
      return low;
    }
    return Math.min(high, Math.max(low, value));
  }
  function round(value) {
    return value.toFixed(1);
  }
  const NOMINAL_WIDTH = 200;
  const NOMINAL_HEIGHT = 150;
  const PAD_X = 14;
  const PAD_Y = 13;
  const NUDGE = 0.01;
  const NUDGE_COARSE = 0.1;
  function mountCurveEditor(container, options) {
    let points = clampPoints(options.points);
    let box = curveBox(NOMINAL_WIDTH, NOMINAL_HEIGHT, PAD_X, PAD_Y);
    let dragging = null;
    container.innerHTML = markup$4();
    const svg = container.querySelector(".ce-canvas");
    const curveLine = container.querySelector(".ce-curve");
    const grips = /* @__PURE__ */ new Map();
    const tethers = /* @__PURE__ */ new Map();
    for (const index of [1, 2]) {
      const grip = container.querySelector(
        `[data-handle="${index}"]`
      );
      const tether = container.querySelector(
        `[data-tether="${index}"]`
      );
      if (grip) grips.set(index, grip);
      if (tether) tethers.set(index, tether);
    }
    function pointOf2(index) {
      return index === 1 ? { x: points.x1, y: points.y1 } : { x: points.x2, y: points.y2 };
    }
    function withPoint(index, x, y) {
      return clampPoints(
        index === 1 ? { ...points, x1: x, y1: y } : { ...points, x2: x, y2: y }
      );
    }
    function measure() {
      let width = NOMINAL_WIDTH;
      let height = NOMINAL_HEIGHT;
      try {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 1 && rect.height > 1) {
          width = rect.width;
          height = rect.height;
        }
      } catch {
      }
      box = curveBox(width, height, PAD_X, PAD_Y);
      svg.setAttribute("viewBox", `0 0 ${width.toFixed(1)} ${height.toFixed(1)}`);
    }
    function render() {
      const start = project(box, 0, 0);
      const end = project(box, 1, 1);
      const left = box.padX.toFixed(1);
      const right = (box.width - box.padX).toFixed(1);
      const floor = start.y.toFixed(1);
      const ceiling = end.y.toFixed(1);
      setAttr(container.querySelector(".ce-floor"), "d", `M${left},${floor} L${right},${floor}`);
      setAttr(container.querySelector(".ce-ceiling"), "d", `M${left},${ceiling} L${right},${ceiling}`);
      setAttr(
        container.querySelector(".ce-linear"),
        "d",
        `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`
      );
      setAttr(curveLine, "d", bezierPath(points, box));
      for (const index of [1, 2]) {
        const value = pointOf2(index);
        const at = project(box, value.x, value.y);
        const anchor = index === 1 ? start : end;
        setAttr(
          tethers.get(index),
          "d",
          `M${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} L${at.x.toFixed(1)},${at.y.toFixed(1)}`
        );
        const grip = grips.get(index);
        if (grip) {
          grip.style.left = `${at.x.toFixed(1)}px`;
          grip.style.top = `${at.y.toFixed(1)}px`;
        }
      }
    }
    function commit2(next) {
      points = next;
      render();
      options.onChange(points);
    }
    function locate(event) {
      let rect;
      try {
        rect = svg.getBoundingClientRect();
      } catch {
        return null;
      }
      if (!(rect.width > 1) || !(rect.height > 1)) {
        return null;
      }
      return unproject(box, event.clientX - rect.left, event.clientY - rect.top);
    }
    function onMouseDown(event) {
      measure();
      render();
      const target = event.target;
      const grip = target instanceof Element ? target.closest("[data-handle]") : null;
      const at = locate(event);
      let index = grip ? Number(grip.dataset.handle) : null;
      if (!index && at) {
        const cursor = project(box, at.x, at.y);
        const first = project(box, points.x1, points.y1);
        const second = project(box, points.x2, points.y2);
        index = distance(cursor, first) <= distance(cursor, second) ? 1 : 2;
        commit2(withPoint(index, at.x, at.y));
      }
      if (!index) {
        return;
      }
      dragging = index;
      grips.get(index)?.focus();
      event.preventDefault();
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    }
    function onMouseMove(event) {
      if (!dragging) {
        return;
      }
      if (event.buttons === 0) {
        onMouseUp();
        return;
      }
      const at = locate(event);
      if (at) {
        commit2(withPoint(dragging, at.x, at.y));
      }
    }
    function onMouseUp() {
      dragging = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
    function onKeyDown(event) {
      const target = event.target;
      const grip = target instanceof Element ? target.closest("[data-handle]") : null;
      if (!grip) {
        return;
      }
      const index = Number(grip.dataset.handle);
      const step2 = event.shiftKey ? NUDGE_COARSE : NUDGE;
      const value = pointOf2(index);
      let dx = 0;
      let dy = 0;
      switch (event.key) {
        case "ArrowLeft":
          dx = -step2;
          break;
        case "ArrowRight":
          dx = step2;
          break;
        case "ArrowUp":
          dy = step2;
          break;
        case "ArrowDown":
          dy = -step2;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      commit2(withPoint(index, value.x + dx, value.y + dy));
    }
    function onResize() {
      measure();
      render();
    }
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    measure();
    render();
    return {
      setPoints(next) {
        points = clampPoints(next);
        measure();
        render();
      },
      relayout() {
        measure();
        render();
      },
      destroy() {
        onMouseUp();
        container.removeEventListener("mousedown", onMouseDown);
        container.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onResize);
        container.innerHTML = "";
      }
    };
  }
  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function setAttr(node, name, value) {
    node?.setAttribute(name, value);
  }
  function markup$4() {
    return `<svg class="ce-canvas" viewBox="0 0 ${NOMINAL_WIDTH} ${NOMINAL_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><path class="ce-floor" d=""/><path class="ce-ceiling" d=""/><path class="ce-linear" d=""/><path class="ce-tether" data-tether="1" d=""/><path class="ce-tether" data-tether="2" d=""/><path class="ce-curve" d=""/></svg><div class="ce-grip" ${CONTROL} data-handle="1" aria-label="Ponto de controle da saída"></div><div class="ce-grip" ${CONTROL} data-handle="2" aria-label="Ponto de controle da chegada"></div>`;
  }
  let drawnPoints = { ...CUSTOM_DEFAULT };
  const PREVIEW_WIDTH$1 = 200;
  const PREVIEW_HEIGHT$1 = 84;
  function mountCurvePicker(container, options) {
    const initialCurveId = options.curveId ?? CURVES[0].id;
    let curveId = initialCurveId;
    let editor = null;
    container.innerHTML = markup$3(curveId);
    const tag = container.querySelector("[data-curve-name]");
    const slot = container.querySelector("[data-curve-slot]");
    const meta = container.querySelector("[data-curve-meta]");
    function curve() {
      return curveId === CUSTOM_CURVE ? customCurve(drawnPoints) : findCurve(curveId);
    }
    function writeTag() {
      if (tag) {
        tag.textContent = curveId === CUSTOM_CURVE ? formatPoints(drawnPoints) : curve().name;
      }
    }
    function render() {
      if (!slot) {
        return;
      }
      const drawing = curveId === CUSTOM_CURVE;
      slot.classList.toggle("is-editing", drawing);
      if (drawing) {
        if (!editor) {
          slot.innerHTML = "";
          editor = mountCurveEditor(slot, {
            points: drawnPoints,
            onChange: (next) => {
              drawnPoints = next;
              writeTag();
              options.onChange(curve());
            }
          });
          editor.relayout();
        } else {
          editor.setPoints(drawnPoints);
        }
      } else {
        if (editor) {
          editor.destroy();
          editor = null;
          slot.innerHTML = "";
        }
        options.renderPreview(slot, curve());
      }
      writeTag();
      if (meta) {
        meta.innerHTML = drawing ? `<b>arraste os dois pontos</b><span class="preview-meta-gap"></span><div class="field-action" ${CONTROL} data-curve-reset>Redefinir</div>` : '<b>início</b><span class="preview-meta-gap"></span><b>fim</b>';
      }
    }
    function select(next) {
      if (next === CUSTOM_CURVE && curveId !== CUSTOM_CURVE) {
        const seed = findCurve(curveId).points;
        if (seed) {
          drawnPoints = { ...seed };
        }
      }
      curveId = next;
      for (const cell2 of container.querySelectorAll("[data-curve]")) {
        cell2.setAttribute("aria-pressed", String(cell2.dataset.curve === next));
      }
      render();
      options.onChange(curve());
    }
    for (const cell2 of container.querySelectorAll("[data-curve]")) {
      cell2.addEventListener("click", () => select(cell2.dataset.curve));
    }
    meta?.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-curve-reset]")) {
        drawnPoints = { ...CUSTOM_DEFAULT };
        editor?.setPoints(drawnPoints);
        writeTag();
        options.onChange(curve());
      }
    });
    render();
    return {
      curve,
      refresh: render,
      reset() {
        select(initialCurveId);
      },
      destroy() {
        editor?.destroy();
        editor = null;
      }
    };
  }
  function renderCurvePreview(slot, curve) {
    slot.innerHTML = `<svg viewBox="0 0 ${PREVIEW_WIDTH$1} ${PREVIEW_HEIGHT$1}" preserveAspectRatio="none" aria-hidden="true"><path class="preview-grid" d="M0,${PREVIEW_HEIGHT$1 - 8} L${PREVIEW_WIDTH$1},${PREVIEW_HEIGHT$1 - 8}"/><path class="preview-curve" d="${curvePath(curve, PREVIEW_WIDTH$1, PREVIEW_HEIGHT$1, 8)}"/></svg>`;
  }
  function markup$3(curveId) {
    const cell2 = (curve, perRow) => `<div class="curve-cell" ${CONTROL} data-curve="${curve.id}" style="width:${(100 / perRow).toFixed(3)}%" aria-pressed="${curve.id === curveId}" title="${escapeHtml$5(curve.name)}"><svg viewBox="0 0 60 34" preserveAspectRatio="none" aria-hidden="true"><path class="curve-track" d="M4,30 L56,30"/><path class="curve-line" d="${curvePath(curve, 60, 34, 4)}"/></svg><span class="curve-cell-name">${escapeHtml$5(curve.name)}</span></div>`;
    const rows = [];
    for (let index = 0; index < CURVES.length; index += 3) {
      const row = CURVES.slice(index, index + 3);
      rows.push(
        `<div class="curve-row">${row.map((curve) => cell2(curve, row.length)).join("")}</div>`
      );
    }
    return `<div class="field-head"><span class="t-label">Curva</span><span class="curve-tag" data-curve-name></span></div><div class="curve-grid">${rows.join("")}</div><div class="curve-draw" ${CONTROL} data-curve="${CUSTOM_CURVE}" aria-pressed="${curveId === CUSTOM_CURVE}"><span class="curve-draw-mark"></span><span class="curve-draw-name">Desenhar a minha</span></div><div class="preview"><div class="preview-canvas" data-curve-slot></div><div class="preview-meta" data-curve-meta></div></div>`;
  }
  function escapeHtml$5(value) {
    return value.replace(/[&<>"]/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  let livePicker$1 = null;
  const PREVIEW_WIDTH = 220;
  const PREVIEW_HEIGHT = 84;
  const PREVIEW_PAD = 8;
  function shapeFor(style, punchDuration) {
    if (style === "full") {
      return { span: 1 };
    }
    return { span: Math.max(0.15, Math.min(0.92, punchDuration / PUNCH_DURATION_MAX)) };
  }
  const KEY_OFFSETS = Array.from({ length: 9 }, (_, index) => index / 8);
  const zoomTool = {
    id: "zoom",
    name: "Zoom In / Out",
    summary: "Punch-in animado no clipe selecionado",
    hint: "Selecione um ou mais clipes na timeline e escolha a direção. Os keyframes de escala entram num efeito Transform novo — o Motion original não é tocado.",
    category: "edicao",
    glyph: "zoom",
    available: true,
    mount(container, context) {
      let direction = "in";
      let style = "punch";
      let scalePercent = SCALE_DEFAULTS.punch;
      let punchDuration = PUNCH_DURATION_DEFAULT;
      let scaleTouched = false;
      container.innerHTML = markup$2(direction, style, scalePercent, punchDuration);
      const directionSeg = container.querySelector("[data-direction-seg]");
      const styleSeg = container.querySelector("[data-style-seg]");
      const presetButtons = Array.from(
        container.querySelectorAll("[data-preset-dur]")
      );
      const scaleInput = container.querySelector("[data-scale]");
      const scaleOut = container.querySelector("[data-out-scale]");
      const durationField = container.querySelector("[data-duration-field]");
      const durationInput = container.querySelector("[data-duration]");
      const durationOut = container.querySelector("[data-out-duration]");
      const metaRange = container.querySelector("[data-meta-range]");
      const metaSpan = container.querySelector("[data-meta-span]");
      const metaHold = container.querySelector("[data-meta-hold]");
      const curveZone = container.querySelector("[data-curve-zone]");
      livePicker$1?.destroy();
      livePicker$1 = mountCurvePicker(curveZone, {
        curveId: "punch",
        renderPreview: (slot, curve) => renderRamp(slot, curve),
        onChange: () => draw()
      });
      function renderRamp(slot, curve) {
        const geometry = curveGeometry(
          shapeFor(style, punchDuration),
          scalePercent,
          PREVIEW_WIDTH,
          PREVIEW_HEIGHT,
          PREVIEW_PAD,
          curve.ease
        );
        const dots = KEY_OFFSETS.map((t) => {
          const at = geometry.pointAt(t);
          return `<circle class="preview-key" cx="${at.x.toFixed(1)}" cy="${at.y.toFixed(1)}" r="2.6"/>`;
        }).join("");
        slot.innerHTML = `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><path class="preview-grid" d="M0,${PREVIEW_HEIGHT - PREVIEW_PAD} L${PREVIEW_WIDTH},${PREVIEW_HEIGHT - PREVIEW_PAD}"/><path class="preview-area" d="${geometry.area}"/><path class="preview-hold" d="${geometry.hold}"/><path class="preview-curve" d="${geometry.rise}"/>` + dots + "</svg>";
      }
      function draw() {
        livePicker$1?.refresh();
        const [from, to] = direction === "in" ? ["100%", `${scalePercent}%`] : [`${scalePercent}%`, "100%"];
        if (metaRange) {
          metaRange.textContent = `${from} → ${to}`;
        }
        if (metaSpan) {
          metaSpan.textContent = style === "full" ? "clipe inteiro" : `${punchDuration.toFixed(1)}s`;
        }
        if (metaHold) {
          metaHold.hidden = style === "full";
        }
        if (durationField) {
          durationField.hidden = style === "full";
        }
      }
      function setStyle(next) {
        style = next;
        for (const button of styleSeg?.querySelectorAll(".seg-item") ?? []) {
          button.setAttribute(
            "aria-pressed",
            String(button.getAttribute("data-style") === next)
          );
        }
        if (scaleTouched) {
          draw();
        } else {
          setScale(SCALE_DEFAULTS[next]);
        }
      }
      function setScale(value) {
        scalePercent = value;
        if (scaleInput) {
          scaleInput.value = String(value);
        }
        if (scaleOut) {
          scaleOut.textContent = `${value}%`;
        }
        draw();
      }
      function setDuration(value) {
        punchDuration = Math.max(PUNCH_DURATION_MIN, Math.min(PUNCH_DURATION_MAX, value));
        if (durationInput) {
          durationInput.value = String(punchDuration);
        }
        if (durationOut) {
          durationOut.textContent = `${punchDuration.toFixed(1)}s`;
        }
        for (const btn of presetButtons) {
          const pVal = Number.parseFloat(btn.getAttribute("data-preset-dur") ?? "");
          btn.classList.toggle("is-active", Math.abs(pVal - punchDuration) < 0.05);
        }
        draw();
      }
      function setDirection(next) {
        direction = next;
        for (const button of directionSeg?.querySelectorAll(".seg-item") ?? []) {
          button.setAttribute(
            "aria-pressed",
            String(button.getAttribute("data-value") === next)
          );
        }
        draw();
      }
      directionSeg?.addEventListener("click", (event) => {
        const button = event.target?.closest(".seg-item");
        if (button && directionSeg.contains(button)) {
          setDirection(button.getAttribute("data-value") ?? "in");
        }
      });
      styleSeg?.addEventListener("click", (event) => {
        const button = event.target?.closest(".seg-item");
        if (button && styleSeg.contains(button)) {
          setStyle(button.getAttribute("data-style") ?? "punch");
        }
      });
      for (const btn of presetButtons) {
        btn.addEventListener("click", () => {
          const val = Number.parseFloat(btn.getAttribute("data-preset-dur") ?? "");
          if (Number.isFinite(val)) {
            setDuration(val);
          }
        });
      }
      scaleInput?.addEventListener("input", () => {
        const parsed = Number.parseFloat(scaleInput.value);
        scaleTouched = true;
        setScale(Number.isFinite(parsed) ? parsed : SCALE_DEFAULTS[style]);
      });
      durationInput?.addEventListener("input", () => {
        const parsed = Number.parseFloat(durationInput.value);
        setDuration(Number.isFinite(parsed) ? parsed : PUNCH_DURATION_DEFAULT);
      });
      draw();
      context.setApplyLabel("APLICAR ZOOM");
      context.setApplyEnabled(true);
      context.setResetHandler(() => {
        scaleTouched = false;
        setDirection("in");
        setStyle("punch");
        setDuration(PUNCH_DURATION_DEFAULT);
        livePicker$1?.reset();
        context.setStatus("Ajustes restaurados.");
      });
      context.setApplyHandler(async () => {
        const picker = livePicker$1;
        if (!picker) {
          context.setStatus("O seletor de curva não está montado.", "error");
          return;
        }
        context.setStatus("Aplicando…");
        const result = await applyZoom({
          direction,
          style,
          scalePercent,
          punchDuration,
          ease: picker.curve().ease
        });
        context.setStatus(result.message, result.ok ? "done" : "error");
        context.refreshSelection();
      });
    },
    unmount() {
      livePicker$1?.destroy();
      livePicker$1 = null;
    }
  };
  function markup$2(direction, style, scalePercent, punchDuration) {
    const presetButtonsHtml = PUNCH_DURATION_PRESETS.map(
      (preset) => `<div class="preset-pill${Math.abs(preset - punchDuration) < 0.05 ? " is-active" : ""}" ${CONTROL} data-preset-dur="${preset}">${preset.toFixed(1)}s</div>`
    ).join("");
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Direção</span><div class="seg" data-direction-seg><div class="seg-item" ${CONTROL} data-value="in" aria-pressed="${direction === "in"}">Zoom In</div><div class="seg-item" ${CONTROL} data-value="out" aria-pressed="${direction === "out"}">Zoom Out</div></div></div><div class="field"><span class="t-label">Comportamento</span><div class="seg" data-style-seg><div class="seg-item" ${CONTROL} data-style="punch" aria-pressed="${style === "punch"}">Punch Smooth</div><div class="seg-item" ${CONTROL} data-style="full" aria-pressed="${style === "full"}">Clipe inteiro</div></div></div><div class="field" data-duration-field${style === "full" ? " hidden" : ""}><div class="field-head"><span class="t-label">Duração do Punch</span><span class="field-val" data-out-duration>${punchDuration.toFixed(1)}s</span></div><div class="preset-rail">${presetButtonsHtml}</div><div class="slider-row"><input type="range" min="${PUNCH_DURATION_MIN}" max="${PUNCH_DURATION_MAX}" step="0.1" value="${punchDuration}" data-duration aria-label="Duração do punch"></div></div><div class="field"><div class="field-head"><span class="t-label">Intensidade (Escala Alvo)</span><span class="field-val" data-out-scale>${scalePercent}%</span></div><div class="slider-row"><input type="range" min="${SCALE_MIN}" max="${SCALE_MAX}" step="1" value="${scalePercent}" data-scale aria-label="Intensidade"></div><p class="field-note">100% mantém o enquadramento; valores acima aumentam o corte com Transform.</p></div><div class="preview-meta"><b data-meta-range></b><span class="preview-meta-gap"></span><b data-meta-span></b><span data-meta-hold>segura até o fim</span></div></div><div class="zone" data-curve-zone></div></div>`;
  }
  const MAX_PARAMS = 40;
  const bakedByParam = /* @__PURE__ */ new Map();
  function bakedFor(key) {
    let set = bakedByParam.get(key);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      bakedByParam.set(key, set);
    }
    return set;
  }
  const EXCLUDED_COMPONENTS = /time\s*remap|remapeamento\s*de\s*tempo|remappage|zeitverzerrung|时间重映射/i;
  async function resolve(value) {
    return await value;
  }
  async function readAnimatedParams() {
    const report = { clips: 0, lines: [] };
    const ppro = getPremiere();
    if (!ppro) {
      report.lines.push("Runtime do Premiere indisponível.");
      return { params: [], report };
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      const sequence = project2 ? await project2.getActiveSequence() : null;
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
      const found = [];
      for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
        const clipKey = clips[clipIndex].key;
        const chain = await clips[clipIndex].clip.getComponentChain();
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
          const componentName = await component.getDisplayName().catch(() => "") || `Efeito ${ci + 1}`;
          const matchName = await component.getMatchName().catch(() => "");
          if (EXCLUDED_COMPONENTS.test(componentName) || EXCLUDED_COMPONENTS.test(matchName)) {
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
            const times = await keyframeTimes(param);
            if (times.length < 2) {
              continue;
            }
            animatedHere += 1;
            const keyTicks = times.map((time) => time.ticks);
            const key = `${clipKey}:${ci}:${pi}`;
            found.push({
              id: `${clipIndex}:${ci}:${pi}`,
              clipKey,
              key,
              label: `${componentName} › ${safeDisplayName(param) || `Param ${pi}`}`,
              keyTicks,
              anchorTicks: anchorsOf(key, keyTicks),
              clipIndex,
              componentIndex: ci,
              paramIndex: pi
            });
          }
          report.lines.push(
            `${componentName}: ${paramCount} param, ${animatedHere} animado(s)`
          );
        }
      }
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
  async function keyframeTimes(param) {
    try {
      const times = await resolve(param.getKeyframeListAsTickTimes());
      return Array.isArray(times) ? times : [];
    } catch {
      return [];
    }
  }
  function anchorsOf(key, keyTicks) {
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
  async function applyCurve(targets, curve, density) {
    return runOnTargets(targets, "Aplicar curva", async (param, pairs, build) => {
      const plans = [];
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
  async function clearToLinear(targets) {
    return runOnTargets(targets, "Curva linear", async (param, pairs) => {
      const plans = [];
      for (const [startTicks, endTicks] of pairs) {
        const inner = await innerTicks(param, startTicks, endTicks);
        if (inner.length > 0) {
          plans.push({
            param,
            key: "",
            removeTicks: inner,
            add: [],
            before: (await keyframeTimes(param)).length
          });
        }
      }
      return plans;
    });
  }
  async function runOnTargets(targets, undoLabel, build) {
    const ppro = getPremiere();
    if (!ppro) {
      return fail$1("Runtime do Premiere indisponível.");
    }
    if (targets.length === 0) {
      return fail$1("Escolha ao menos um parâmetro animado.");
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      const sequence = project2 ? await project2.getActiveSequence() : null;
      if (!sequence) {
        return fail$1("Abra uma sequência na timeline primeiro.");
      }
      const clips = await collectSelectedVideoClips(ppro, sequence);
      if (clips.length === 0) {
        return fail$1("Nenhum clipe de vídeo selecionado na timeline.");
      }
      const byKey = new Map(clips.map((ref) => [ref.key, ref.clip]));
      const context = {
        ticksPerFrame: await readTicksPerFrame(sequence),
        notes: []
      };
      const plans = [];
      let segments = 0;
      for (const target of targets) {
        const label = target.param.label;
        const param = await resolveParam(byKey, target.param);
        if (!param) {
          context.notes.push(`${label}: clipe não está mais na seleção.`);
          continue;
        }
        if (!await keyframesSupported(param)) {
          context.notes.push(`${label}: não aceita keyframes.`);
          continue;
        }
        const pairs = pairsFor(target);
        if (pairs.length === 0) {
          context.notes.push(`${label}: trecho fora do alcance.`);
          continue;
        }
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
        return fail$1(withNotes("Nada a fazer nesses segmentos.", context.notes));
      }
      let committed = false;
      let added = 0;
      let refused = 0;
      let transactionError = null;
      const filed = [];
      try {
        project2.lockedAccess(() => {
          committed = project2.executeTransaction((compoundAction) => {
            const push = (make, required) => {
              try {
                const action = make();
                if (!action) {
                  if (required) refused += 1;
                  return false;
                }
                const accepted = compoundAction.addAction(action) !== false;
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
              const record = { key: plan.key, added: [], removed: [] };
              filed.push(record);
              if (plan.add.length > 0) {
                push(() => plan.param.createSetTimeVaryingAction(true), false);
              }
              for (const ticks of plan.removeTicks) {
                const gone = push(
                  () => plan.param.createRemoveKeyframeAction(
                    ppro.TickTime.createWithTicks(ticks),
                    false
                  ),
                  true
                );
                if (gone) {
                  record.removed.push(ticks);
                }
              }
              const landed = [];
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
              for (const ticks of landed) {
                push(
                  () => plan.param.createSetInterpolationAtKeyframeAction(
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
        return fail$1(withNotes(`O Premiere recusou: ${transactionError}`, context.notes));
      }
      if (!committed) {
        return fail$1(
          withNotes("O Premiere recusou a transação. Nada foi alterado.", context.notes)
        );
      }
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
        return fail$1(
          withNotes(
            `Nenhum keyframe foi aceito (${refused} recusa(s)). Veja o console do UXP.`,
            context.notes
          )
        );
      }
      const refreshedSequence = await (await ppro.Project.getActiveProject())?.getActiveSequence() ?? sequence;
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
          added ? `${added} keyframes criados em ${segments} ${segments === 1 ? "trecho" : "trechos"}.` : `${segments} ${segments === 1 ? "trecho limpo" : "trechos limpos"}.`,
          context.notes
        )
      };
    } catch (cause) {
      return fail$1(`Falhou: ${describeError(cause)}`);
    }
  }
  async function verify(plans, byKey) {
    let changed = 0;
    for (const plan of plans) {
      try {
        const fresh = plan.descriptor ? await resolveParam(byKey, plan.descriptor) : null;
        const times = await keyframeTimes(fresh ?? plan.param);
        if (times.length !== plan.before) {
          changed += 1;
        }
      } catch {
        changed += 1;
      }
    }
    return changed;
  }
  function withNotes(message, notes) {
    if (notes.length === 0) {
      return message;
    }
    console.warn("[Flow]", message, notes);
    return `${message} ${notes.slice(0, 2).join(" ")}`;
  }
  function makeKeyframe(ppro, param, value) {
    if (typeof value === "number") {
      return param.createKeyframe(value);
    }
    const candidates2 = [
      () => new ppro.PointF(value.x, value.y),
      () => ppro.PointF(value.x, value.y),
      () => ({ x: value.x, y: value.y }),
      () => [value.x, value.y]
    ];
    let lastError = null;
    for (const build of candidates2) {
      try {
        return param.createKeyframe(build());
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError ?? new Error("nenhum formato de ponto foi aceito");
  }
  function pairsFor(target) {
    const ticks = target.param.anchorTicks;
    if (target.segment === "all") {
      const pairs = [];
      for (let index = 0; index < ticks.length - 1; index++) {
        pairs.push([ticks[index], ticks[index + 1]]);
      }
      return pairs;
    }
    const start = ticks[target.segment];
    const end = ticks[target.segment + 1];
    return start && end ? [[start, end]] : [];
  }
  async function planSegment(param, startTicks, endTicks, density, ease, build) {
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
    const frames = frameSpan(startTicks, endTicks, build.ticksPerFrame);
    const steps = Math.max(0, Math.min(density, frames - 1));
    if (steps === 0) {
      build.notes.push("Trecho curto demais para assar (menos de 2 frames).");
      return null;
    }
    const add = [];
    const used = /* @__PURE__ */ new Set([startTicks, endTicks]);
    for (let step2 = 1; step2 <= steps; step2++) {
      const t = step2 / (steps + 1);
      const seconds = startSeconds + (endSeconds - startSeconds) * t;
      const ticks = snapTicksToFrame(
        ppro.TickTime.createWithSeconds(seconds).ticks,
        build.ticksPerFrame
      );
      if (used.has(ticks)) {
        continue;
      }
      used.add(ticks);
      const eased = ease(t);
      add.push({
        ticks,
        value: typeof from === "number" && typeof to === "number" ? from + (to - from) * eased : {
          x: pointOf(from).x + (pointOf(to).x - pointOf(from).x) * eased,
          y: pointOf(from).y + (pointOf(to).y - pointOf(from).y) * eased
        }
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
      before: (await keyframeTimes(param)).length
    };
  }
  function frameSpan(startTicks, endTicks, ticksPerFrame) {
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
  async function innerTicks(param, startTicks, endTicks) {
    const ppro = getPremiere();
    if (!ppro) {
      return [];
    }
    const times = await keyframeTimes(param);
    const startSeconds = ppro.TickTime.createWithTicks(startTicks).seconds;
    const endSeconds = ppro.TickTime.createWithTicks(endTicks).seconds;
    const epsilon = 1e-6;
    return times.filter(
      (time) => time.seconds > startSeconds + epsilon && time.seconds < endSeconds - epsilon
    ).map((time) => time.ticks);
  }
  async function resolveParam(byKey, descriptor) {
    const clip = byKey.get(descriptor.clipKey);
    if (!clip) {
      return null;
    }
    const chain = await clip.getComponentChain();
    if (!chain) {
      return null;
    }
    if (descriptor.componentIndex >= await resolve(chain.getComponentCount())) {
      return null;
    }
    const component = await resolve(
      chain.getComponentAtIndex(descriptor.componentIndex)
    );
    return component ? safeParam(component, descriptor.paramIndex) : null;
  }
  async function keyframesSupported(param) {
    try {
      const supported = await resolve(param.areKeyframesSupported());
      return supported !== false;
    } catch {
      return true;
    }
  }
  async function readValue(param, time) {
    let direct = null;
    try {
      direct = await param.getValueAtTime(time);
    } catch {
      direct = null;
    }
    const value = normalizeValue(direct);
    if (value !== null) {
      return value;
    }
    let fromKeyframe = null;
    try {
      fromKeyframe = await resolve(param.getKeyframePtr(time));
    } catch {
      fromKeyframe = null;
    }
    const fallback = normalizeValue(fromKeyframe);
    if (fallback !== null) {
      return fallback;
    }
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
  function normalizeValue(raw) {
    let current = raw;
    for (let depth = 0; depth < 4; depth++) {
      const asNumber = finiteNumber(current);
      if (asNumber !== null) {
        return asNumber;
      }
      if (!current || typeof current !== "object") {
        return null;
      }
      if (Array.isArray(current) && current.length >= 2) {
        const x2 = finiteNumber(current[0]);
        const y2 = finiteNumber(current[1]);
        return x2 !== null && y2 !== null ? { x: x2, y: y2 } : null;
      }
      const record = current;
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
  function finiteNumber(raw) {
    if (typeof raw === "number") {
      return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function describeShape(raw) {
    if (raw === null) return "null";
    if (raw === void 0) return "undefined";
    if (Array.isArray(raw)) return `Array[${raw.length}]`;
    if (typeof raw !== "object") return typeof raw;
    const name = raw.constructor?.name ?? "Object";
    let keys = [];
    try {
      keys = Object.keys(raw).slice(0, 6);
    } catch {
      keys = [];
    }
    return `${name}{${keys.join(",")}}`;
  }
  function pointOf(value) {
    return typeof value === "number" ? { x: value, y: value } : value;
  }
  async function safeParamCount(component) {
    try {
      return await resolve(component.getParamCount());
    } catch {
      return 0;
    }
  }
  async function safeParam(component, index) {
    try {
      return await resolve(component.getParam(index));
    } catch {
      return null;
    }
  }
  function safeDisplayName(param) {
    try {
      return param.displayName ?? "";
    } catch {
      return "";
    }
  }
  function fail$1(message) {
    return { ok: false, message };
  }
  let livePicker = null;
  const flowTool = {
    id: "flow",
    name: "Curvas de velocidade",
    summary: "Assa easing entre keyframes existentes",
    hint: "Selecione o clipe animado na timeline. A lista relê sozinha quando você volta ao painel — escolha um trecho, a curva e a densidade. Linear apaga só os keyframes intermediários daquele trecho, então dá para reajustar o tempo e aplicar de novo.",
    category: "edicao",
    glyph: "curve",
    available: true,
    mount(container, context) {
      let params = [];
      let report = null;
      let density = DENSITY_DEFAULT;
      let scanning = false;
      const picked = /* @__PURE__ */ new Map();
      container.innerHTML = shellMarkup(density);
      const list = container.querySelector("[data-param-list]");
      const densityOut = container.querySelector("[data-out-density]");
      const densityInput = container.querySelector("[data-density]");
      function targets() {
        const out = [];
        for (const param of params) {
          const segment = picked.get(param.id);
          if (segment !== void 0) {
            out.push({ param, segment });
          }
        }
        return out;
      }
      const curveZone = container.querySelector("[data-curve-zone]");
      livePicker?.destroy();
      livePicker = mountCurvePicker(curveZone, {
        curveId: "ease-out",
        renderPreview: renderCurvePreview,
        onChange: () => {
        }
      });
      function renderList(keepStatus = false) {
        if (params.length === 0) {
          list.innerHTML = '<p class="work-note">Nenhum parâmetro com keyframes no clipe selecionado. Selecione na timeline o clipe que tem a animação e toque em Reler.</p>' + scanMarkup(report);
          context.setApplyEnabled(false);
          if (!keepStatus) {
            context.setStatus(
              report && report.clips === 0 ? "Nenhum clipe de vídeo selecionado na timeline." : "O clipe selecionado não tem parâmetros com keyframes.",
              "error"
            );
          }
          return;
        }
        list.innerHTML = params.map((param) => paramMarkup(param, picked.get(param.id))).join("");
        const chosen = targets().length;
        context.setApplyEnabled(chosen > 0);
        if (!keepStatus) {
          context.setStatus(
            chosen > 0 ? `${chosen} de ${params.length} ${params.length === 1 ? "parâmetro" : "parâmetros"} selecionado(s).` : "Escolha ao menos um parâmetro."
          );
        }
      }
      async function reload(keepStatus = false) {
        if (scanning) {
          return;
        }
        scanning = true;
        const knownIds = new Set(params.map((param) => param.id));
        const previousPicks = new Map(picked);
        const previousShape = new Map(
          params.map((param) => [param.id, param.anchorTicks.join("|")])
        );
        list.innerHTML = '<p class="work-note">Lendo keyframes…</p>';
        try {
          const scan = await readAnimatedParams();
          params = scan.params;
          report = scan.report;
          picked.clear();
          for (const param of params) {
            if (!knownIds.has(param.id)) {
              picked.set(param.id, "all");
              continue;
            }
            const before = previousPicks.get(param.id);
            if (before === void 0) {
              continue;
            }
            const moved = previousShape.get(param.id) !== param.anchorTicks.join("|");
            picked.set(param.id, moved ? "all" : before);
          }
          renderList(keepStatus);
        } finally {
          scanning = false;
        }
      }
      list.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const key = target.closest("[data-segment]");
        if (key) {
          const paramId = key.dataset.param;
          const segment = Number(key.dataset.segment);
          picked.set(paramId, picked.get(paramId) === segment ? "all" : segment);
          renderList();
          return;
        }
        const row = target.closest("[data-param]");
        if (row?.dataset.param) {
          const paramId = row.dataset.param;
          if (picked.has(paramId)) {
            picked.delete(paramId);
          } else {
            picked.set(paramId, "all");
          }
          renderList();
        }
      });
      for (const button of container.querySelectorAll("[data-density-preset]")) {
        button.addEventListener("click", () => {
          setDensity(Number(button.dataset.densityPreset));
        });
      }
      container.querySelector("[data-rescan]")?.addEventListener("click", () => void reload());
      densityInput?.addEventListener("input", () => {
        setDensity(Number.parseInt(densityInput.value, 10));
      });
      function setDensity(value) {
        if (!Number.isFinite(value)) {
          return;
        }
        density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, value));
        if (densityInput) {
          densityInput.value = String(density);
        }
        if (densityOut) {
          densityOut.textContent = `${density} kf`;
        }
        for (const button of container.querySelectorAll("[data-density-preset]")) {
          button.classList.toggle(
            "is-active",
            Number(button.dataset.densityPreset) === density
          );
        }
      }
      setDensity(density);
      void reload();
      context.setApplyLabel("Aplicar curva");
      context.setApplyEnabled(false);
      context.setResetLabel("Linear");
      context.setResetHandler(() => {
        void (async () => {
          const chosen = targets();
          if (chosen.length === 0) {
            context.setStatus("Escolha um parâmetro primeiro.", "error");
            return;
          }
          context.setStatus("Limpando…");
          const result = await clearToLinear(chosen);
          await reload(true);
          context.setStatus(result.message, result.ok ? "done" : "error");
        })();
      });
      context.setApplyHandler(async () => {
        const picker = livePicker;
        if (!picker) {
          context.setStatus("O seletor de curva não está montado.", "error");
          return;
        }
        const chosen = targets();
        if (chosen.length === 0) {
          context.setStatus("Escolha um parâmetro primeiro.", "error");
          return;
        }
        context.setStatus("Aplicando…");
        const result = await applyCurve(chosen, picker.curve(), density);
        await reload(true);
        context.setStatus(result.message, result.ok ? "done" : "error");
      });
      context.setRefreshHandler(() => void reload());
    },
    unmount() {
      livePicker?.destroy();
      livePicker = null;
    }
  };
  function scanMarkup(report) {
    if (!report) {
      return "";
    }
    const rows = report.lines.map((line) => `<li>${escapeHtml$4(line)}</li>`).join("");
    return `<div class="scan"><span class="t-label">Varredura · ${report.clips} clipe(s)</span>` + (rows ? `<ul class="scan-list">${rows}</ul>` : "") + "</div>";
  }
  function paramMarkup(param, segment) {
    const chosen = segment !== void 0;
    const count = param.anchorTicks.length;
    const baked = param.keyTicks.length - count;
    const cells = [];
    for (let index = 0; index < count - 1; index++) {
      const on = chosen && (segment === "all" || segment === index);
      cells.push(
        `<span class="kf-span${on ? " is-on" : ""}" ${CONTROL} data-param="${param.id}" data-segment="${index}" title="Trecho ${index + 1}"></span>`
      );
    }
    return `<div class="kf-row${chosen ? " is-chosen" : ""}" ${CONTROL} data-param="${param.id}"><div class="kf-head"><span class="kf-name">${escapeHtml$4(param.label)}</span><span class="kf-count">${count} kf${baked > 0 ? ` +${baked}` : ""}</span></div><div class="kf-strip">${cells.join("")}</div></div>`;
  }
  function shellMarkup(density) {
    const presets = DENSITY_PRESETS.map(
      (preset) => `<div class="preset-pill${preset === density ? " is-active" : ""}" ${CONTROL} data-density-preset="${preset}">${preset}</div>`
    ).join("");
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Parâmetros animados</span><div class="field-action" ${CONTROL} data-rescan title="Reler os keyframes do clipe selecionado">Reler</div></div><div class="kf-list" data-param-list></div></div><div class="field"><div class="field-head"><span class="t-label">Densidade da assadura</span><span class="field-val" data-out-density>${density} kf</span></div><div class="preset-rail">${presets}</div><input type="range" min="${DENSITY_MIN}" max="${DENSITY_MAX}" step="1" value="${density}" data-density aria-label="Densidade"><p class="field-note">Cada keyframe assado é um keyframe que você não retima mais. Use Linear para desfazer e reajustar o tempo.</p></div></div><div class="zone" data-curve-zone></div></div>`;
  }
  function escapeHtml$4(value) {
    return value.replace(/[&<>"]/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  const MIN_REMOVAL_SECONDS = 0.06;
  function planSegments(voiced, range, params, frameSeconds) {
    const total = range.end - range.start;
    if (!(total > 0)) {
      return emptyPlan();
    }
    const frame = frameSeconds > 0 ? frameSeconds : 1 / 30;
    const minRemoval = Math.max(MIN_REMOVAL_SECONDS, frame * 2);
    const spans = [];
    for (const span of voiced) {
      const start = Math.max(range.start, span.start);
      const end = Math.min(range.end, span.end);
      if (end > start) {
        spans.push({ ...span, start, end });
      }
    }
    if (spans.length === 0) {
      return emptyPlan();
    }
    spans.sort((a, b) => a.start - b.start);
    const clean = rejectNoise(spans, params);
    const speech = params.removeFillers ? clean.filter((span) => !span.filler) : clean;
    if (speech.length === 0) {
      return emptyPlan();
    }
    let blocks = mergeGaps(speech, params.minSilence);
    blocks = blocks.map((block) => ({
      start: Math.max(range.start, block.start - params.padIn),
      end: Math.min(range.end, block.end + params.padOut)
    }));
    blocks = mergeGaps(blocks, minRemoval);
    blocks = blocks.map((block) => grow(block, params.minKeep, range));
    blocks = mergeGaps(blocks, minRemoval);
    const keep = [];
    for (const block of blocks) {
      const start = Math.max(range.start, floorTo(block.start - range.start, frame) + range.start);
      const end = Math.min(range.end, ceilTo(block.end - range.start, frame) + range.start);
      if (end - start >= frame) {
        keep.push({ start, end });
      }
    }
    const merged = mergeGaps(keep, minRemoval);
    const drop = [];
    let cursor = range.start;
    for (const block of merged) {
      if (block.start - cursor >= minRemoval) {
        drop.push({ start: cursor, end: block.start });
      }
      cursor = Math.max(cursor, block.end);
    }
    if (range.end - cursor >= minRemoval) {
      drop.push({ start: cursor, end: range.end });
    }
    const finalKeep = complement(drop, range, frame);
    return {
      keep: finalKeep,
      drop,
      removedSeconds: sum(drop),
      keptSeconds: sum(finalKeep)
    };
  }
  function rejectNoise(spans, params) {
    if (params.minConfidence <= 0 && params.noiseIsland <= 0) {
      return [...spans];
    }
    const kept = [];
    for (let index = 0; index < spans.length; index++) {
      const span = spans[index];
      const previous = spans[index - 1];
      const next = spans[index + 1];
      const gapBefore = previous ? span.start - previous.end : Number.POSITIVE_INFINITY;
      const gapAfter = next ? next.start - span.end : Number.POSITIVE_INFINITY;
      const isolated = gapBefore >= params.minSilence && gapAfter >= params.minSilence;
      if (!isolated) {
        kept.push(span);
        continue;
      }
      const tooShort = params.noiseIsland > 0 && span.end - span.start < params.noiseIsland;
      const tooUnsure = params.minConfidence > 0 && span.confidence < params.minConfidence;
      if (!tooShort && !tooUnsure) {
        kept.push(span);
      }
    }
    return kept;
  }
  function mergeGaps(spans, tolerance) {
    if (spans.length === 0) {
      return [];
    }
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const out = [{ ...sorted[0] }];
    for (let index = 1; index < sorted.length; index++) {
      const current = sorted[index];
      const last = out[out.length - 1];
      if (current.start - last.end < tolerance) {
        last.end = Math.max(last.end, current.end);
      } else {
        out.push({ ...current });
      }
    }
    return out;
  }
  function grow(span, minLength, bounds) {
    const missing = minLength - (span.end - span.start);
    if (missing <= 0) {
      return span;
    }
    let start = span.start - missing / 2;
    let end = span.end + missing / 2;
    if (start < bounds.start) {
      end += bounds.start - start;
      start = bounds.start;
    }
    if (end > bounds.end) {
      start = Math.max(bounds.start, start - (end - bounds.end));
      end = bounds.end;
    }
    return { start, end };
  }
  function complement(drop, range, frame) {
    const keep = [];
    let cursor = range.start;
    for (const gap of drop) {
      if (gap.start - cursor >= frame) {
        keep.push({ start: cursor, end: gap.start });
      }
      cursor = gap.end;
    }
    if (range.end - cursor >= frame) {
      keep.push({ start: cursor, end: range.end });
    }
    return keep;
  }
  function sum(spans) {
    return spans.reduce((acc, span) => acc + (span.end - span.start), 0);
  }
  function floorTo(value, step2) {
    return Math.floor(value / step2 + 1e-6) * step2;
  }
  function ceilTo(value, step2) {
    return Math.ceil(value / step2 - 1e-6) * step2;
  }
  function emptyPlan() {
    return { keep: [], drop: [], removedSeconds: 0, keptSeconds: 0 };
  }
  function formatSeconds(value) {
    if (!Number.isFinite(value)) {
      return "0.0s";
    }
    const tenths = Math.round(Math.max(0, value) * 10);
    const minutes = Math.floor(tenths / 600);
    const seconds = (tenths - minutes * 600) / 10;
    if (minutes === 0) {
      return `${seconds.toFixed(1)}s`;
    }
    return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
  }
  async function readTranscript(ppro, clipItem) {
    const api = ppro.Transcript;
    if (!api || typeof api.exportToJSON !== "function") {
      return { status: "unsupported", words: [], detail: null };
    }
    try {
      if (typeof api.hasTranscript === "function") {
        const has = await Promise.resolve(api.hasTranscript(clipItem));
        if (has === false) {
          return { status: "missing", words: [], detail: null };
        }
      }
      const json = await api.exportToJSON(clipItem);
      if (typeof json !== "string" || json.trim().length === 0) {
        return { status: "missing", words: [], detail: null };
      }
      const words = parseTranscriptJSON(json);
      return {
        status: words.length > 0 ? "ok" : "empty",
        words,
        detail: null
      };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (/transcript/i.test(detail) && /(no|not|exist|found)/i.test(detail)) {
        return { status: "missing", words: [], detail: null };
      }
      return { status: "error", words: [], detail };
    }
  }
  function parseTranscriptJSON(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return [];
    }
    if (!isRecord(data)) {
      return [];
    }
    const words = readSegments(data) ?? readMonologues(data) ?? [];
    words.sort((a, b) => a.start - b.start);
    return words;
  }
  function readSegments(data) {
    const segments = data.segments;
    if (!Array.isArray(segments)) {
      return null;
    }
    const out = [];
    for (const segment of segments) {
      if (!isRecord(segment)) {
        continue;
      }
      const segmentStart = num$1(segment.start) ?? 0;
      const list = segment.words;
      if (!Array.isArray(list)) {
        continue;
      }
      for (const raw of list) {
        if (!isRecord(raw)) {
          continue;
        }
        if (typeof raw.type === "string" && raw.type === "punctuation") {
          continue;
        }
        const start = num$1(raw.start);
        if (start === null) {
          continue;
        }
        const end = spanEnd(raw, start);
        if (end === null) {
          continue;
        }
        const offset = start < segmentStart - 1e-3 ? segmentStart : 0;
        out.push({
          start: start + offset,
          end: end + offset,
          filler: hasFillerTag(raw.tags),
          confidence: readConfidence(raw.confidence)
        });
      }
    }
    return out;
  }
  function readMonologues(data) {
    const monologues = data.monologues;
    if (!Array.isArray(monologues)) {
      return null;
    }
    const out = [];
    for (const monologue of monologues) {
      if (!isRecord(monologue)) {
        continue;
      }
      const elements = monologue.elements;
      if (!Array.isArray(elements)) {
        continue;
      }
      for (const raw of elements) {
        if (!isRecord(raw)) {
          continue;
        }
        if (typeof raw.type === "string" && raw.type !== "text") {
          continue;
        }
        const start = num$1(raw.ts);
        const end = num$1(raw.end_ts);
        if (start === null || end === null || !(end > start)) {
          continue;
        }
        out.push({
          start,
          end,
          filler: hasFillerTag(raw.tags),
          confidence: readConfidence(raw.confidence)
        });
      }
    }
    return out;
  }
  function spanEnd(raw, start) {
    const duration = num$1(raw.duration);
    if (duration !== null && duration > 0) {
      return start + duration;
    }
    const end = num$1(raw.end);
    if (end !== null && end > start) {
      return end;
    }
    return null;
  }
  function readConfidence(value) {
    const parsed = num$1(value);
    if (parsed === null) {
      return 1;
    }
    return Math.min(1, Math.max(0, parsed));
  }
  function hasFillerTag(tags) {
    return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "filler");
  }
  function num$1(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  const PCM_SAMPLE_RATE = 8e3;
  const PCM_WINDOW_SECONDS = 0.02;
  const DB_FLOOR = -120;
  class EnvelopeBuilder {
    constructor(sampleRate = PCM_SAMPLE_RATE, windowSeconds = PCM_WINDOW_SECONDS, offsetSeconds = 0) {
      this.windowSeconds = windowSeconds;
      this.offsetSeconds = offsetSeconds;
      this.values = [];
      this.sumSquares = 0;
      this.count = 0;
      this.carry = -1;
      this.samplesPerWindow = Math.max(
        1,
        Math.round(sampleRate * windowSeconds)
      );
    }
    push(buffer, byteLength) {
      const bytes = new Uint8Array(buffer, 0, byteLength);
      let index = 0;
      if (this.carry >= 0 && bytes.length > 0) {
        this.addSample(toSigned16(this.carry | bytes[0] << 8));
        this.carry = -1;
        index = 1;
      }
      for (; index + 1 < bytes.length; index += 2) {
        this.addSample(toSigned16(bytes[index] | bytes[index + 1] << 8));
      }
      if (index < bytes.length) {
        this.carry = bytes[index];
      }
    }
    finish() {
      if (this.count > 0) {
        this.closeWindow();
      }
      const db = Float32Array.from(this.values);
      return {
        db,
        windowSeconds: this.windowSeconds,
        offsetSeconds: this.offsetSeconds,
        ...measureLevels(db)
      };
    }
    addSample(sample) {
      const normalized = sample / 32768;
      this.sumSquares += normalized * normalized;
      this.count += 1;
      if (this.count >= this.samplesPerWindow) {
        this.closeWindow();
      }
    }
    closeWindow() {
      const rms = Math.sqrt(this.sumSquares / this.count);
      this.values.push(rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR);
      this.sumSquares = 0;
      this.count = 0;
    }
  }
  function toSigned16(value) {
    return value >= 32768 ? value - 65536 : value;
  }
  function measureLevels(db) {
    if (db.length === 0) {
      return { noiseFloorDb: DB_FLOOR, loudDb: DB_FLOOR, peakDb: DB_FLOOR };
    }
    let peakDb = DB_FLOOR;
    const audible = [];
    for (const value of db) {
      if (value > peakDb) {
        peakDb = value;
      }
      if (value > DB_FLOOR + 20) {
        audible.push(value);
      }
    }
    const pool = audible.length >= Math.max(8, db.length * 0.05) ? audible : Array.from(db);
    pool.sort((a, b) => a - b);
    const loudDb = percentile(pool, 0.95);
    const rawFloor = percentile(pool, 0.1);
    return {
      noiseFloorDb: Math.min(rawFloor, loudDb - 10),
      loudDb,
      peakDb
    };
  }
  function percentile(sorted, ratio) {
    if (sorted.length === 0) {
      return DB_FLOOR;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.round((sorted.length - 1) * ratio))
    );
    return sorted[index];
  }
  function resolveThreshold(envelope, autoThreshold, marginDb, manualDb) {
    if (!autoThreshold) {
      return { db: manualDb, automatic: false };
    }
    const ceiling = Math.max(
      envelope.noiseFloorDb + 3,
      envelope.loudDb - 10
    );
    return {
      db: Math.min(envelope.noiseFloorDb + marginDb, ceiling),
      automatic: true
    };
  }
  const HYSTERESIS_DB = 2;
  function spansFromEnvelope(envelope, thresholdDb) {
    const spans = [];
    const exitDb = thresholdDb - HYSTERESIS_DB;
    const { db, windowSeconds, offsetSeconds } = envelope;
    let start = -1;
    for (let index = 0; index < db.length; index++) {
      const level = db[index];
      if (start < 0) {
        if (level >= thresholdDb) {
          start = index;
        }
        continue;
      }
      if (level < exitDb) {
        spans.push(makeSpan(start, index, windowSeconds, offsetSeconds));
        start = -1;
      }
    }
    if (start >= 0) {
      spans.push(makeSpan(start, db.length, windowSeconds, offsetSeconds));
    }
    return spans;
  }
  function makeSpan(from, to, windowSeconds, offsetSeconds) {
    return {
      start: offsetSeconds + from * windowSeconds,
      end: offsetSeconds + to * windowSeconds,
      filler: false,
      // A onda não opina sobre o que ouviu: ou passou do limiar, ou não.
      // Confiança 1 neutraliza o filtro que só faz sentido na transcrição.
      confidence: 1
    };
  }
  const WORK_FOLDER = "edit-toolbox-audio";
  const PROBE_FILE = "write-probe.txt";
  function uxpModule(name) {
    if (typeof require !== "function") {
      return null;
    }
    try {
      return require(name) ?? null;
    } catch {
      return null;
    }
  }
  function fsModule() {
    return uxpModule("fs");
  }
  function shellModule() {
    return uxpModule("uxp")?.shell ?? null;
  }
  function platform() {
    try {
      return uxpModule("os")?.platform() ?? "darwin";
    } catch {
      return "darwin";
    }
  }
  function isWindows() {
    return /^win/i.test(platform());
  }
  const UXP_SCHEME = /^[a-z][a-z0-9+.-]+:/i;
  function join(base, ...parts) {
    const separator = isWindows() && !UXP_SCHEME.test(base) ? "\\" : "/";
    return [base.replace(/[\\/]+$/, ""), ...parts].join(separator);
  }
  let cached = null;
  let attempts = [];
  function workspaceAttempts() {
    return attempts;
  }
  function forgetWorkspace() {
    cached = null;
    attempts = [];
  }
  async function workspace() {
    if (cached) {
      return cached;
    }
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    attempts = [];
    for (const candidate of await candidates()) {
      const found = await tryCandidate(fs, candidate);
      if (found) {
        cached = found;
        console.log(
          `[Silêncios] pasta de trabalho: ${found.fsBase} (${found.origin}, ${found.sync ? "sync" : "async"}) → ${found.nativeBase}`
        );
        return found;
      }
    }
    throw new Error(
      `nenhum caminho gravável (${attempts.join(" · ") || "sem candidatos"})`
    );
  }
  async function candidates() {
    const list = [];
    const storage = uxpModule("uxp")?.storage?.localFileSystem;
    const dataNative = await nativePathOf(storage?.getDataFolder?.bind(storage), "getDataFolder");
    if (dataNative) {
      list.push({
        fsBase: `plugin-data:/${WORK_FOLDER}`,
        nativeBase: join(dataNative, WORK_FOLDER),
        origin: "plugin-data + subpasta"
      });
      list.push({
        fsBase: "plugin-data:",
        nativeBase: dataNative,
        origin: "plugin-data raiz"
      });
    }
    const tempNative = await nativePathOf(
      storage?.getTemporaryFolder?.bind(storage),
      "getTemporaryFolder"
    );
    if (tempNative) {
      list.push({
        fsBase: `plugin-temp:/${WORK_FOLDER}`,
        nativeBase: join(tempNative, WORK_FOLDER),
        origin: "plugin-temp + subpasta"
      });
      list.push({
        fsBase: "plugin-temp:",
        nativeBase: tempNative,
        origin: "plugin-temp raiz"
      });
    }
    if (dataNative) {
      list.push({
        fsBase: join(dataNative, WORK_FOLDER),
        nativeBase: join(dataNative, WORK_FOLDER),
        origin: "caminho nativo (dados do plugin)"
      });
    }
    try {
      const home = uxpModule("os")?.homedir?.();
      if (home) {
        const base = isWindows() ? join(home, "AppData", "Local", "EditToolbox") : join(home, "Library", "Caches", "EditToolbox");
        list.push({ fsBase: base, nativeBase: base, origin: "caminho nativo (home)" });
      }
    } catch (cause) {
      attempts.push(`os.homedir: ${describe(cause)}`);
    }
    return list;
  }
  async function nativePathOf(read, label) {
    if (typeof read !== "function") {
      attempts.push(`${label}: ausente`);
      return null;
    }
    try {
      const folder = await read();
      if (folder?.nativePath) {
        return folder.nativePath;
      }
      attempts.push(`${label}: sem nativePath`);
    } catch (cause) {
      attempts.push(`${label}: ${describe(cause)}`);
    }
    return null;
  }
  async function tryCandidate(fs, candidate) {
    try {
      await fs.mkdir(candidate.fsBase, { recursive: true });
    } catch {
    }
    const probe = join(candidate.fsBase, PROBE_FILE);
    const stamp = "edit-toolbox";
    for (const sync of [true, false]) {
      try {
        if (sync) {
          fs.writeFileSync(probe, stamp, { encoding: "utf-8" });
        } else {
          await fs.writeFile(probe, stamp, { encoding: "utf-8" });
        }
        const back = String(fs.readFileSync(probe, { encoding: "utf-8" }));
        if (back.trim() !== stamp) {
          attempts.push(`${candidate.origin}: leu "${back.slice(0, 20)}"`);
          continue;
        }
        return { ...candidate, sync };
      } catch (cause) {
        attempts.push(`${candidate.origin} ${sync ? "sync" : "async"}: ${describe(cause)}`);
      }
    }
    return null;
  }
  function fsPath(space, name) {
    return join(space.fsBase, name);
  }
  function nativePath(space, name) {
    return join(space.nativeBase, name);
  }
  async function write(space, name, data, executable = false) {
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    const path = fsPath(space, name);
    const attempts2 = executable ? [{ encoding: "utf-8", mode: 493 }, { encoding: "utf-8" }] : [{ encoding: "utf-8" }];
    let lastError = null;
    for (const options of attempts2) {
      try {
        if (space.sync) {
          fs.writeFileSync(path, data, options);
        } else {
          await fs.writeFile(path, data, options);
        }
        return;
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError ?? new Error(`não foi possível escrever ${name}`);
  }
  function readText(space, name) {
    const fs = fsModule();
    if (!fs) {
      return null;
    }
    try {
      const raw = fs.readFileSync(fsPath(space, name), { encoding: "utf-8" });
      const text2 = String(raw).trim();
      return text2.length > 0 ? text2 : null;
    } catch {
      return null;
    }
  }
  async function remove(space, name) {
    const fs = fsModule();
    if (!fs) {
      return;
    }
    try {
      await fs.unlink(fsPath(space, name));
    } catch {
    }
  }
  function describe(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const RESULT_FILE$1 = "result.json";
  const PROGRESS_FILE$1 = "progress.txt";
  const CONFIG_FILE$1 = "silence-config.json";
  const SCRIPT_FILE$1 = "extract.command";
  const SCRIPT_FILE_WIN$1 = "extract.bat";
  const POLL_MS$1 = 350;
  const POLL_SLOW_MS = 1200;
  const POLL_FAST_WINDOW_MS = 30 * 1e3;
  const TIMEOUT_MS = 20 * 60 * 1e3;
  async function step(label, run2) {
    try {
      return await run2();
    } catch (cause) {
      console.error(`[Silêncios] ${label} falhou:`, cause);
      throw new Error(`${label} — ${describe(cause)}`);
    }
  }
  function scriptName$1() {
    return isWindows() ? SCRIPT_FILE_WIN$1 : SCRIPT_FILE$1;
  }
  async function readConfig$1() {
    const fallback = { ffmpegPath: "", mode: "waveform" };
    try {
      const raw = readText(await workspace(), CONFIG_FILE$1);
      if (!raw) {
        return fallback;
      }
      const parsed = JSON.parse(raw);
      return {
        ffmpegPath: typeof parsed.ffmpegPath === "string" ? parsed.ffmpegPath : "",
        mode: parsed.mode === "transcript" ? "transcript" : "waveform"
      };
    } catch {
      return fallback;
    }
  }
  async function writeConfig$1(config) {
    try {
      await write(await workspace(), CONFIG_FILE$1, JSON.stringify(config, null, 2));
    } catch (cause) {
      console.error("[Silêncios] não foi possível salvar a configuração:", cause);
    }
  }
  async function extractAudio(jobs, ffmpegPath, onProgress, cancelled, onManual) {
    const shell = shellModule();
    if (!shell) {
      return { ok: false, error: "uxp-unavailable", ffmpegPath: null, scriptPath: null };
    }
    const space = await step("pasta de trabalho", () => workspace());
    const scriptPath = nativePath(space, scriptName$1());
    await remove(space, RESULT_FILE$1);
    await remove(space, PROGRESS_FILE$1);
    for (const job of jobs) {
      await remove(space, job.file);
    }
    const script = isWindows() ? windowsScript(jobs, space.nativeBase, ffmpegPath) : unixScript(jobs, space.nativeBase, ffmpegPath);
    await step("escrever o script", () => write(space, scriptName$1(), script, true));
    let launchError = null;
    try {
      await shell.openPath(
        scriptPath,
        "Extrair o áudio dos clipes selecionados com o ffmpeg, para detectar os silêncios pela onda."
      );
    } catch (cause) {
      launchError = describe(cause);
      console.error("[Silêncios] openPath recusou:", cause);
      onManual?.(scriptPath, launchError);
    }
    const started = Date.now();
    const deadline = started + TIMEOUT_MS;
    let lastDone = -1;
    let tick = 0;
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        return { ok: false, error: "cancelled", ffmpegPath: null, scriptPath };
      }
      if (tick % 3 === 0) {
        const done = readProgress$1(space);
        if (done !== null && done !== lastDone) {
          lastDone = done;
          onProgress?.(done, jobs.length);
        }
      }
      tick += 1;
      const raw = readText(space, RESULT_FILE$1);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          return {
            ok: parsed.ok === true,
            error: parsed.ok === true ? null : parsed.error ?? "ffmpeg-failed",
            ffmpegPath: typeof parsed.ffmpeg === "string" ? parsed.ffmpeg : null,
            scriptPath
          };
        } catch {
        }
      }
      await wait$1(
        Date.now() - started < POLL_FAST_WINDOW_MS ? POLL_MS$1 : POLL_SLOW_MS
      );
    }
    return {
      ok: false,
      error: launchError ? `launch-denied: ${launchError}` : "timeout",
      ffmpegPath: null,
      scriptPath
    };
  }
  async function openWorkFolder$1() {
    const shell = shellModule();
    if (!shell) {
      throw new Error("uxp.shell indisponível");
    }
    const space = await workspace();
    await shell.openPath(space.nativeBase, "Abrir a pasta do script de extração.");
  }
  function readProgress$1(space) {
    const text2 = readText(space, PROGRESS_FILE$1);
    if (!text2) {
      return null;
    }
    const parsed = Number.parseInt(text2.split("/")[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function wait$1(ms) {
    return new Promise((resolve2) => setTimeout(resolve2, ms));
  }
  const READ_CHUNK = 1 << 20;
  async function readEnvelope(fileName, offsetSeconds) {
    const fs = fsModule();
    if (!fs) {
      throw new Error("Sistema de arquivos do UXP indisponível.");
    }
    const space = await workspace();
    const path = fsPath(space, fileName);
    const builder = new EnvelopeBuilder(PCM_SAMPLE_RATE, void 0, offsetSeconds);
    const fd = await step(`abrir ${fileName}`, () => fs.open(path, "r"));
    try {
      const buffer = new ArrayBuffer(READ_CHUNK);
      let position = 0;
      for (; ; ) {
        const { bytesRead } = await fs.read(fd, buffer, 0, READ_CHUNK, position);
        if (!bytesRead) {
          break;
        }
        builder.push(buffer, bytesRead);
        position += bytesRead;
      }
    } finally {
      await fs.close(fd).catch(() => void 0);
    }
    return builder.finish();
  }
  async function diagnose(ffmpegPath) {
    forgetWorkspace();
    const lines = [];
    const add = (label, ok, detail) => {
      lines.push({ label, ok, detail });
    };
    const fs = fsModule();
    add("módulo fs", !!fs, fs ? "disponível" : 'require("fs") não resolveu');
    const shell = shellModule();
    add(
      "módulo uxp.shell",
      !!shell && typeof shell.openPath === "function",
      shell?.openPath ? "openPath disponível" : "openPath ausente"
    );
    try {
      const os = uxpModule("os");
      add("módulo os", !!os?.homedir?.(), `${os?.platform?.() ?? "?"} · ${os?.homedir?.() ?? "sem homedir"}`);
    } catch (cause) {
      add("módulo os", false, describe(cause));
    }
    let space;
    try {
      space = await workspace();
      add("endereço de escrita", true, `${space.fsBase} (${space.origin}, ${space.sync ? "sync" : "async"})`);
      add("caminho nativo", true, space.nativeBase);
    } catch (cause) {
      add("endereço de escrita", false, describe(cause));
      for (const line of workspaceAttempts()) {
        add("  tentativa", false, line);
      }
      return lines;
    }
    const probeName = isWindows() ? "probe.bat" : "probe.command";
    try {
      await remove(space, "probe.json");
      await write(space, probeName, probeScript(space.nativeBase, ffmpegPath), true);
      add("escrever script executável", true, nativePath(space, probeName));
    } catch (cause) {
      add("escrever script executável", false, describe(cause));
      return lines;
    }
    if (!shell) {
      return lines;
    }
    try {
      await shell.openPath(nativePath(space, probeName), "Testar o acesso ao ffmpeg.");
      add("openPath (script)", true, "disparado — aguardando resposta");
    } catch (cause) {
      add("openPath (script)", false, describe(cause));
      try {
        await shell.openPath(space.nativeBase, "Abrir a pasta de trabalho.");
        add("openPath (pasta)", true, "Finder abriu — o bloqueio é ao executável");
      } catch (folderCause) {
        add("openPath (pasta)", false, describe(folderCause));
      }
      add(
        "  contorno",
        false,
        `dê um duplo clique em ${probeName} na pasta que abriu`
      );
      return lines;
    }
    const deadline = Date.now() + 2e4;
    let answer = null;
    while (Date.now() < deadline && !answer) {
      await wait$1(POLL_MS$1);
      answer = readText(space, "probe.json");
    }
    if (!answer) {
      add(
        "script executou",
        false,
        "sem resposta em 20s — o sistema abriu o arquivo em vez de executar, ou a autorização foi negada"
      );
      return lines;
    }
    try {
      const parsed = JSON.parse(answer);
      const found = typeof parsed.ffmpeg === "string" ? parsed.ffmpeg : "";
      add("script executou", true, "sim");
      add(
        "ffmpeg encontrado",
        found.length > 0,
        found.length > 0 ? found : "não encontrado nos caminhos conhecidos nem no PATH"
      );
    } catch {
      add("script executou", true, `resposta ilegível: ${answer.slice(0, 120)}`);
    }
    return lines;
  }
  function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  function unixScript(jobs, folder, ffmpegPath) {
    const lines = [
      "#!/bin/bash",
      "# Gerado pelo Edit Toolbox — Corte de Silêncios. Pode apagar.",
      `printf '\\033]0;Edit Toolbox — analisando áudio\\007'`,
      "set -u",
      `WORK=${shellQuote(folder)}`,
      `CUSTOM=${shellQuote(ffmpegPath)}`,
      "FFMPEG=''",
      // A ordem procura primeiro o que o editor escolheu, depois os
      // lugares onde Homebrew e MacPorts instalam, e só então o PATH —
      // que num shell não interativo pode nem ter /opt/homebrew.
      'for candidate in "$CUSTOM" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      'if [ -z "$FFMPEG" ]; then',
      `  printf '{"ok":false,"error":"ffmpeg-not-found"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      `  mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      '  echo "ffmpeg não encontrado. Instale (brew install ffmpeg) ou informe o caminho no painel."',
      "  exit 1",
      "fi",
      'echo "ffmpeg: $FFMPEG"',
      "FAILED=0"
    ];
    jobs.forEach((job, index) => {
      const number = index + 1;
      lines.push(
        `echo "[${number}/${jobs.length}] $(basename ${shellQuote(job.mediaPath)})"`,
        // -vn descarta vídeo, -ac 1 soma os canais, -ar 8000 é o que a
        // energia da fala precisa, e o high-pass tira o grave que
        // inflaria o piso de ruído sem ser som audível.
        `"$FFMPEG" -v error -y -accurate_seek -ss ${job.offsetSeconds.toFixed(6)} -i ${shellQuote(job.mediaPath)} -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar ${PCM_SAMPLE_RATE} -af highpass=f=85 -f s16le ${shellQuote(join(folder, job.file))} || FAILED=1`,
        `printf '%s/%s' ${number} ${jobs.length} > "$WORK/${PROGRESS_FILE$1}"`
      );
    });
    lines.push(
      'if [ "$FAILED" -eq 0 ]; then',
      `  printf '{"ok":true,"ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "else",
      `  printf '{"ok":false,"error":"ffmpeg-failed","ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      'echo "Pronto. Pode voltar ao Premiere."',
      // Fecha só a própria janela, achada pelo título posto lá em cima.
      // Se o macOS negar a automação, a janela fica aberta e nada quebra.
      `osascript -e 'tell application "Terminal" to close (every window whose name contains "Edit Toolbox")' >/dev/null 2>&1 &`,
      "exit 0"
    );
    return lines.join("\n") + "\n";
  }
  function batchValue(value) {
    return value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
  }
  function windowsScript(jobs, folder, ffmpegPath) {
    const quote = (value) => `"${batchValue(value)}"`;
    const lines = [
      "@echo off",
      "rem Gerado pelo Edit Toolbox — Corte de Silêncios. Pode apagar.",
      `title Edit Toolbox - analisando audio`,
      `set "WORK=${batchValue(folder)}"`,
      `set "FFMPEG=${batchValue(ffmpegPath)}"`,
      'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
      'if "%FFMPEG%"=="" (',
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"ffmpeg-not-found"}`,
      `  move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "  echo ffmpeg nao encontrado. Informe o caminho no painel.",
      "  exit /b 1",
      ")",
      "set FAILED=0"
    ];
    jobs.forEach((job, index) => {
      const number = index + 1;
      lines.push(
        `echo [${number}/${jobs.length}]`,
        `"%FFMPEG%" -v error -y -accurate_seek -ss ${job.offsetSeconds.toFixed(6)} -i ${quote(job.mediaPath)} -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar ${PCM_SAMPLE_RATE} -af highpass=f=85 -f s16le ${quote(join(folder, job.file))} || set FAILED=1`,
        `>"%WORK%\\${PROGRESS_FILE$1}" echo ${number}/${jobs.length}`
      );
    });
    lines.push(
      'if "%FAILED%"=="0" (',
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ffmpeg":"%FFMPEG%"}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"ffmpeg-failed"}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function probeScript(folder, ffmpegPath) {
    if (isWindows()) {
      return [
        "@echo off",
        `set "FFMPEG=${batchValue(ffmpegPath)}"`,
        'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
        `>"${batchValue(folder)}\\probe.json" echo {"ffmpeg":"%FFMPEG%"}`,
        "exit /b 0"
      ].join("\r\n") + "\r\n";
    }
    return [
      "#!/bin/bash",
      `printf '\\033]0;Edit Toolbox — teste\\007'`,
      "set -u",
      `CUSTOM=${shellQuote(ffmpegPath)}`,
      "FFMPEG=''",
      'for candidate in "$CUSTOM" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      `printf '{"ffmpeg":"%s"}' "$FFMPEG" > ${shellQuote(join(folder, "probe.json"))}`,
      'echo "Teste concluído. ffmpeg: $FFMPEG"',
      `osascript -e 'tell application "Terminal" to close (every window whose name contains "Edit Toolbox")' >/dev/null 2>&1 &`,
      "exit 0"
    ].join("\n") + "\n";
  }
  function describeExtractionError(code) {
    if (!code) {
      return "Falha desconhecida na extração de áudio.";
    }
    if (code.startsWith("launch-denied")) {
      const raw = code.slice("launch-denied:".length).trim();
      return "O sistema não executou o script" + (raw ? ` (${raw})` : "") + '. Use "Abrir pasta" e dê um duplo clique em extract.command — o painel continua esperando o resultado.';
    }
    switch (code) {
      case "ffmpeg-not-found":
        return 'ffmpeg não encontrado. Instale com "brew install ffmpeg" ou informe o caminho do binário no campo abaixo.';
      case "ffmpeg-failed":
        return "O ffmpeg não conseguiu ler algum arquivo. Veja a janela do Terminal.";
      case "timeout":
        return "A extração passou de 20 minutos e foi abandonada.";
      case "cancelled":
        return "Extração cancelada.";
      case "uxp-unavailable":
        return "Este build do Premiere não expõe shell/fs do UXP.";
      default:
        return `Falha na extração: ${code}`;
    }
  }
  const TICKS_PER_SECOND_FALLBACK = 254016000000n;
  async function scanSelection(params, options) {
    const ppro = getPremiere();
    if (!ppro) {
      throw new Error("Premiere UXP runtime indisponível.");
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      throw new Error("Nenhum projeto aberto.");
    }
    const sequence = await project2.getActiveSequence();
    if (!sequence) {
      throw new Error("Abra uma sequência na timeline primeiro.");
    }
    const ticksPerFrame = await readTicksPerFrame(sequence);
    const perSecond = ticksPerSecond(ppro);
    const frameSeconds = ticksPerFrame ? Number(ticksPerFrame) / Number(perSecond) : 1 / 30;
    options.onStage?.("Lendo a seleção…");
    const pairs = await collectSelectedPairs(ppro, sequence);
    const clips = [];
    for (const pair of pairs) {
      const target = await describePair(ppro, pair, options.mode);
      if (target) {
        clips.push(target);
      }
    }
    if (options.mode === "waveform") {
      await attachEnvelopes(clips, options);
    }
    const scan = {
      mode: options.mode,
      clips,
      frameSeconds,
      ticksPerFrame,
      totalSeconds: 0,
      removedSeconds: 0,
      cuts: 0,
      readyCount: 0
    };
    recomputePlans(scan, params);
    return scan;
  }
  function recomputePlans(scan, params) {
    let removed = 0;
    let cuts = 0;
    let ready = 0;
    let total = 0;
    for (const clip of scan.clips) {
      total += clip.durationSeconds;
      if (clip.status === "error" || clip.status === "speed" || clip.status === "no-media") {
        continue;
      }
      const voiced = voicedSpansFor(scan.mode, clip, params);
      if (voiced.length === 0) {
        clip.plan = null;
        if (clip.status !== "no-transcript") {
          clip.status = "no-speech";
        }
        continue;
      }
      const plan = planSegments(
        voiced,
        { start: clip.sourceStart, end: clip.sourceEnd },
        params,
        scan.frameSeconds
      );
      if (plan.keep.length === 0) {
        clip.plan = null;
        clip.status = "no-speech";
        continue;
      }
      clip.plan = plan;
      if (plan.drop.length === 0) {
        clip.status = "nothing";
        continue;
      }
      clip.status = "ready";
      ready += 1;
      cuts += plan.drop.length;
      removed += plan.removedSeconds;
    }
    scan.totalSeconds = total;
    scan.removedSeconds = removed;
    scan.cuts = cuts;
    scan.readyCount = ready;
  }
  function voicedSpansFor(mode, clip, params) {
    if (mode === "transcript") {
      clip.thresholdDb = null;
      return clip.words;
    }
    if (!clip.envelope || clip.envelope.db.length === 0) {
      clip.thresholdDb = null;
      return [];
    }
    const threshold = resolveThreshold(
      clip.envelope,
      params.autoThreshold,
      params.dbMargin,
      params.dbThreshold
    );
    clip.thresholdDb = threshold.db;
    return spansFromEnvelope(clip.envelope, threshold.db);
  }
  async function collectSelectedPairs(ppro, sequence) {
    const pairs = [];
    const byIdentity = /* @__PURE__ */ new Map();
    const loose = /* @__PURE__ */ new Set();
    const videoCount = await sequence.getVideoTrackCount();
    for (let index = 0; index < videoCount; index++) {
      const track = await sequence.getVideoTrack(index);
      if (!track) {
        continue;
      }
      for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        if (!await item.getIsSelected()) {
          continue;
        }
        const key = await itemIdentity(item);
        const pair = {
          videoItem: item,
          audioItem: null,
          trackVideo: index,
          trackAudio: -1,
          identity: key,
          orphanAudio: false
        };
        pairs.push(pair);
        if (key) {
          byIdentity.set(key, pair);
        }
      }
    }
    const audioCount = await sequence.getAudioTrackCount();
    for (let index = 0; index < audioCount; index++) {
      const track = await sequence.getAudioTrack(index);
      if (!track) {
        continue;
      }
      for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        if (!await item.getIsSelected()) {
          if (byIdentity.size > 0) {
            const orphan = await itemIdentity(item);
            if (orphan) {
              loose.add(orphan);
            }
          }
          continue;
        }
        const key = await itemIdentity(item);
        const linked = key ? byIdentity.get(key) : void 0;
        if (linked && linked.trackAudio === -1) {
          linked.audioItem = item;
          linked.trackAudio = index;
          continue;
        }
        pairs.push({
          videoItem: null,
          audioItem: item,
          trackVideo: -1,
          trackAudio: index,
          identity: key,
          orphanAudio: false
        });
      }
    }
    for (const pair of pairs) {
      if (pair.videoItem && pair.trackAudio === -1 && pair.identity) {
        pair.orphanAudio = loose.has(pair.identity);
      }
    }
    return pairs;
  }
  async function itemIdentity(item) {
    try {
      const projectItem = await item.getProjectItem();
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      return `${projectItem.getId()}|${start.ticks}|${end.ticks}`;
    } catch {
      return null;
    }
  }
  async function describePair(ppro, pair, mode) {
    const item = pair.videoItem ?? pair.audioItem;
    if (!item) {
      return null;
    }
    try {
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      const inPoint = await item.getInPoint();
      const outPoint = await item.getOutPoint();
      const projectItem = await item.getProjectItem();
      const name = await item.getName().catch(() => projectItem.name ?? "clipe");
      const base = {
        envelope: null,
        thresholdDb: null,
        mediaPath: null,
        key: `${pair.trackVideo}:${pair.trackAudio}:${start.ticks}`,
        name,
        trackVideo: pair.trackVideo,
        trackAudio: pair.trackAudio,
        startTicks: start.ticks,
        endTicks: end.ticks,
        inTicks: inPoint.ticks,
        outTicks: outPoint.ticks,
        sourceStart: inPoint.seconds,
        sourceEnd: outPoint.seconds,
        durationSeconds: Math.max(0, end.seconds - start.seconds),
        orphanAudio: pair.orphanAudio,
        videoItem: pair.videoItem,
        audioItem: pair.audioItem,
        projectItem,
        clipItem: ppro.ClipProjectItem.cast(projectItem),
        projectItemId: safeId$1(projectItem)
      };
      const speed = await item.getSpeed().catch(() => 1);
      if (Number.isFinite(speed) && Math.abs(speed - 1) > 1e-3) {
        return { ...base, status: "speed", detail: null, words: [], plan: null };
      }
      if (mode === "waveform") {
        const mediaPath = await base.clipItem.getMediaFilePath().catch(() => "");
        return {
          ...base,
          mediaPath: mediaPath || null,
          status: mediaPath ? "no-speech" : "no-media",
          detail: null,
          words: [],
          plan: null
        };
      }
      const transcript = await readTranscript(ppro, base.clipItem);
      if (transcript.status === "error" || transcript.status === "unsupported") {
        return {
          ...base,
          status: "error",
          detail: transcript.detail ?? "API de transcrição indisponível nesta versão do Premiere.",
          words: [],
          plan: null
        };
      }
      return {
        ...base,
        status: transcriptStatusToClip(transcript.status),
        detail: null,
        words: transcript.words,
        plan: null
      };
    } catch (cause) {
      console.error("[Silêncios] falha ao ler clipe:", cause);
      return null;
    }
  }
  const envelopeCache = /* @__PURE__ */ new Map();
  const ENVELOPE_CACHE_MAX = 24;
  const PREROLL_SECONDS = 0.5;
  function cachedEnvelope(key) {
    const found = envelopeCache.get(key);
    if (found) {
      envelopeCache.delete(key);
      envelopeCache.set(key, found);
    }
    return found;
  }
  function cacheEnvelope(key, envelope) {
    while (envelopeCache.size >= ENVELOPE_CACHE_MAX) {
      const coldest = envelopeCache.keys().next().value;
      if (coldest === void 0) {
        break;
      }
      envelopeCache.delete(coldest);
    }
    envelopeCache.set(key, envelope);
  }
  async function attachEnvelopes(clips, options) {
    const needs = /* @__PURE__ */ new Map();
    for (const clip of clips) {
      if (!clip.mediaPath || clip.status === "no-media" || clip.status === "speed") {
        continue;
      }
      const from = Math.max(0, clip.sourceStart - PREROLL_SECONDS);
      const to = clip.sourceEnd + PREROLL_SECONDS;
      const found = needs.get(clip.mediaPath);
      if (found) {
        found.from = Math.min(found.from, from);
        found.to = Math.max(found.to, to);
        found.clips.push(clip);
      } else {
        needs.set(clip.mediaPath, { mediaPath: clip.mediaPath, from, to, clips: [clip] });
      }
    }
    if (needs.size === 0) {
      return;
    }
    const jobs = [];
    const pending = [];
    let index = 0;
    for (const need of needs.values()) {
      const cached2 = cachedEnvelope(cacheKey(need.mediaPath, need.from, need.to));
      if (cached2) {
        assignEnvelope(need.clips, cached2);
        continue;
      }
      index += 1;
      jobs.push({
        mediaPath: need.mediaPath,
        offsetSeconds: need.from,
        durationSeconds: Math.max(0.1, need.to - need.from),
        file: `audio-${index}.pcm`
      });
      pending.push(need);
    }
    if (jobs.length === 0) {
      return;
    }
    options.onStage?.(
      jobs.length === 1 ? "Extraindo o áudio com o ffmpeg…" : `Extraindo o áudio de ${jobs.length} arquivos…`
    );
    const run2 = await extractAudio(
      jobs,
      options.ffmpegPath,
      options.onProgress,
      options.cancelled,
      options.onManual
    );
    if (!run2.ok) {
      throw new Error(describeExtractionError(run2.error));
    }
    options.onStage?.("Medindo a onda…");
    for (let position = 0; position < jobs.length; position++) {
      const job = jobs[position];
      const need = pending[position];
      try {
        const envelope = await readEnvelope(job.file, job.offsetSeconds);
        cacheEnvelope(cacheKey(need.mediaPath, need.from, need.to), envelope);
        assignEnvelope(need.clips, envelope);
      } catch (cause) {
        const detail = describeError(cause);
        for (const clip of need.clips) {
          clip.status = "error";
          clip.detail = `Não foi possível ler o áudio extraído: ${detail}`;
        }
      }
    }
  }
  function assignEnvelope(clips, envelope) {
    for (const clip of clips) {
      clip.envelope = envelope;
      clip.status = "no-speech";
    }
  }
  function cacheKey(mediaPath, from, to) {
    return `${mediaPath}|${from.toFixed(2)}|${to.toFixed(2)}`;
  }
  function transcriptStatusToClip(status) {
    switch (status) {
      case "ok":
        return "ready";
      case "empty":
        return "no-speech";
      default:
        return "no-transcript";
    }
  }
  async function openHost(ppro) {
    const project2 = await ppro.Project.getActiveProject();
    const sequence = project2 ? await project2.getActiveSequence() : null;
    if (!project2 || !sequence) {
      return { ok: false, message: "Abra uma sequência na timeline." };
    }
    const editor = resolveEditor(ppro, sequence);
    if (!editor) {
      return { ok: false, message: "SequenceEditor indisponível nesta versão." };
    }
    const items = await buildProjectItemMap(ppro, project2);
    return { ok: true, host: { project: project2, sequence, editor, items } };
  }
  async function reopenHost(ppro, host) {
    const opened = await openHost(ppro);
    if (!opened.ok) {
      return false;
    }
    host.project = opened.host.project;
    host.sequence = opened.host.sequence;
    host.editor = opened.host.editor;
    host.items = opened.host.items;
    return true;
  }
  async function applyCuts(scan, onProgress) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
    }
    const ready = scan.clips.filter(
      (clip) => clip.status === "ready" && clip.plan && clip.plan.drop.length > 0
    );
    if (ready.length === 0) {
      return { ok: false, message: "Nada para cortar na seleção.", snapshot: null };
    }
    try {
      const opened = await openHost(ppro);
      if (!opened.ok) {
        return { ok: false, message: opened.message, snapshot: null };
      }
      const host = opened.host;
      const identified = await identifyClips(ppro, host, ready);
      if (!identified.ok) {
        return { ok: false, message: identified.message, snapshot: null };
      }
      const perSecond = ticksPerSecond(ppro);
      const runs = groupIntoRuns(ready);
      const snapshot = {
        runs: [],
        clipCount: ready.length,
        cuts: scan.cuts,
        removedSeconds: scan.removedSeconds
      };
      let totalWrites = 0;
      const plannedRuns = runs.map((run2) => {
        const writes = planRun(run2, scan, perSecond);
        totalWrites += writes.length;
        return { run: run2, writes };
      });
      let done = 0;
      for (const { run: run2, writes } of plannedRuns) {
        if (writes.length === 0) {
          continue;
        }
        const removed = await removeRun(ppro, host, run2);
        if (!removed.ok) {
          return {
            ok: false,
            message: removed.message,
            snapshot: snapshot.runs.length > 0 ? snapshot : null
          };
        }
        const runStart = BigInt(run2[0].startTicks);
        const lastWrite = writes[writes.length - 1];
        snapshot.runs.push({
          trackVideo: run2[0].trackVideo,
          trackAudio: run2[0].trackAudio,
          writtenStart: runStart.toString(),
          writtenEnd: (lastWrite.position + (lastWrite.outTicks - lastWrite.inTicks)).toString(),
          originals: run2.map((clip) => ({
            projectItemId: clip.projectItemId,
            projectItem: clip.projectItem,
            startTicks: clip.startTicks,
            inTicks: clip.inTicks,
            outTicks: clip.outTicks
          }))
        });
        const written = await writeSegments(ppro, host, writes, () => {
          done += 1;
          onProgress?.(done, totalWrites);
        });
        if (!written.ok) {
          return {
            ok: false,
            message: stepMessage("a escrita de um trecho", written.error) + " Use Desfazer corte para recuperar os clipes originais.",
            snapshot
          };
        }
      }
      const message = `${scan.cuts} ${scan.cuts === 1 ? "corte feito" : "cortes feitos"} em ${ready.length} ${ready.length === 1 ? "clipe" : "clipes"} · ${formatClock$1(scan.removedSeconds)} removidos.`;
      return { ok: true, message, snapshot };
    } catch (cause) {
      return { ok: false, message: describeError(cause), snapshot: null };
    }
  }
  async function buildProjectItemMap(ppro, project2) {
    const map = /* @__PURE__ */ new Map();
    try {
      const rootFolder = await project2.getRootItem();
      if (!rootFolder) {
        return map;
      }
      const stack = [rootFolder];
      while (stack.length > 0) {
        const folder = stack.pop();
        try {
          const items = await folder.getItems();
          for (const item of items) {
            const id = safeId$1(item);
            if (id) {
              map.set(id, item);
            }
            if (item.type === ppro.ProjectItem.TYPE_BIN) {
              try {
                stack.push(ppro.FolderItem.cast(item));
              } catch {
              }
            }
          }
        } catch {
        }
      }
    } catch {
    }
    return map;
  }
  async function identifyClips(ppro, host, clips) {
    for (const clip of clips) {
      const located = await locateRun(ppro, host, [clip]);
      if (!located.ok) {
        return located;
      }
      const anchor = located.items[0];
      if (!anchor) {
        return { ok: false, message: `"${clip.name}" não foi encontrado na timeline.` };
      }
      try {
        const fromTrack = await anchor.getProjectItem();
        const id = safeId$1(fromTrack);
        const permanent = id && host.items.get(id) || fromTrack;
        clip.projectItemId = id;
        clip.projectItem = permanent;
        clip.clipItem = ppro.ClipProjectItem.cast(permanent);
      } catch (cause) {
        return {
          ok: false,
          message: `Não foi possível ler o item de projeto de "${clip.name}" (${describeError(
            cause
          )}).`
        };
      }
    }
    return { ok: true };
  }
  async function locateRun(ppro, host, run2) {
    const items = [];
    try {
      for (const clip of run2) {
        if (clip.trackVideo >= 0) {
          const track = await host.sequence.getVideoTrack(clip.trackVideo);
          const found = track ? await findByPosition(
            track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false),
            clip
          ) : null;
          if (!found) {
            return {
              ok: false,
              message: `"${clip.name}" não está mais onde estava. Analise de novo.`
            };
          }
          items.push(found);
        }
        if (clip.trackAudio >= 0) {
          const track = await host.sequence.getAudioTrack(clip.trackAudio);
          const found = track ? await findByPosition(
            track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false),
            clip
          ) : null;
          if (!found) {
            return {
              ok: false,
              message: `O áudio de "${clip.name}" não está mais onde estava. Analise de novo.`
            };
          }
          items.push(found);
        }
      }
    } catch (cause) {
      return {
        ok: false,
        message: `Não foi possível reler a timeline (${describeError(cause)}). Analise de novo.`
      };
    }
    return { ok: true, items };
  }
  async function findByPosition(items, clip) {
    for (const item of items) {
      const start = await item.getStartTime();
      if (compareTicks(start.ticks, clip.startTicks) !== 0) {
        continue;
      }
      const end = await item.getEndTime();
      if (compareTicks(end.ticks, clip.endTicks) === 0) {
        return item;
      }
    }
    return null;
  }
  function safeId$1(item) {
    try {
      return item.getId();
    } catch {
      return "";
    }
  }
  function groupIntoRuns(clips) {
    const byTrack = /* @__PURE__ */ new Map();
    for (const clip of clips) {
      const key = `${clip.trackVideo}:${clip.trackAudio}`;
      const list = byTrack.get(key);
      if (list) {
        list.push(clip);
      } else {
        byTrack.set(key, [clip]);
      }
    }
    const runs = [];
    for (const list of byTrack.values()) {
      list.sort((a, b) => compareTicks(a.startTicks, b.startTicks));
      let current = [];
      for (const clip of list) {
        const previous = current[current.length - 1];
        if (previous && compareTicks(previous.endTicks, clip.startTicks) === 0) {
          current.push(clip);
        } else {
          if (current.length > 0) {
            runs.push(current);
          }
          current = [clip];
        }
      }
      if (current.length > 0) {
        runs.push(current);
      }
    }
    return runs;
  }
  function planRun(run2, scan, perSecond) {
    const writes = [];
    const frame = scan.ticksPerFrame;
    let cursor = BigInt(run2[0].startTicks);
    for (const clip of run2) {
      const plan = clip.plan;
      if (!plan) {
        continue;
      }
      const inTicks = BigInt(clip.inTicks);
      const outTicks = BigInt(clip.outTicks);
      const minimum = frame ?? 1n;
      for (const span of plan.keep) {
        let from = toTicks(clip.sourceStart, span.start, inTicks, perSecond);
        let to = toTicks(clip.sourceStart, span.end, inTicks, perSecond);
        from = BigInt(snapTicksToFrame(from.toString(), frame));
        to = BigInt(snapTicksToFrame(to.toString(), frame));
        if (from < inTicks) {
          from = inTicks;
        }
        if (to > outTicks) {
          to = outTicks;
        }
        if (to - from < minimum) {
          continue;
        }
        writes.push({
          projectItemId: clip.projectItemId,
          fallbackItem: clip.projectItem,
          inTicks: from,
          outTicks: to,
          position: cursor,
          trackVideo: clip.trackVideo,
          trackAudio: clip.trackAudio
        });
        cursor += to - from;
      }
    }
    return writes;
  }
  async function removeRun(ppro, host, run2) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const located = await locateRun(ppro, host, run2);
      if (!located.ok) {
        return located;
      }
      const result = removeItems(ppro, host, located.items);
      if (result.ok) {
        return { ok: true };
      }
      if (attempt > 0 || !await reopenHost(ppro, host)) {
        return {
          ok: false,
          message: stepMessage("a remoção dos clipes originais", result.error)
        };
      }
    }
    return { ok: false, message: stepMessage("a remoção dos clipes originais", null) };
  }
  function removeItems(ppro, host, items) {
    if (items.length === 0) {
      return { ok: true, error: null };
    }
    const scoped = removeInsideSelectionScope(ppro, host, items);
    if (scoped.ok) {
      return scoped;
    }
    const escaped = removeOutsideSelectionScope(ppro, host, items);
    return escaped.ok || escaped.error ? escaped : scoped;
  }
  function removeInsideSelectionScope(ppro, host, items) {
    let outcome = { ok: false, error: null };
    let entered = false;
    try {
      ppro.TrackItemSelection.createEmptySelection((selection) => {
        entered = true;
        for (const item of items) {
          selection.addItem(item, true);
        }
        outcome = commit(host.project, "Cortar silêncios — remover original", (tx) => {
          tx.addAction(
            host.editor.createRemoveItemsAction(
              selection,
              false,
              ppro.Constants.MediaType.ANY
            )
          );
        });
      });
    } catch (cause) {
      return { ok: false, error: cause };
    }
    if (!entered) {
      return {
        ok: false,
        error: new Error("o Premiere não entregou a seleção dos clipes.")
      };
    }
    return outcome;
  }
  function removeOutsideSelectionScope(ppro, host, items) {
    let selection = null;
    try {
      ppro.TrackItemSelection.createEmptySelection((created) => {
        selection = created;
      });
      const target = selection;
      if (!target) {
        return {
          ok: false,
          error: new Error("o Premiere não entregou a seleção dos clipes.")
        };
      }
      for (const item of items) {
        target.addItem(item, true);
      }
      return commit(host.project, "Cortar silêncios — remover original", (tx) => {
        tx.addAction(
          host.editor.createRemoveItemsAction(
            target,
            false,
            ppro.Constants.MediaType.ANY
          )
        );
      });
    } catch (cause) {
      return { ok: false, error: cause };
    }
  }
  async function writeSegments(ppro, host, writes, onWritten) {
    let pending = null;
    for (const write2 of writes) {
      const previous = pending;
      const result2 = await commitStable(ppro, host, "Cortar silêncios", (live, tx) => {
        if (previous) {
          tx.addAction(
            live.editor.createOverwriteItemAction(
              resolveProjectItem(ppro, live, previous).projectItem,
              ppro.TickTime.createWithTicks(previous.position.toString()),
              previous.trackVideo,
              previous.trackAudio
            )
          );
        }
        const target = resolveProjectItem(ppro, live, write2);
        tx.addAction(target.clipItem.createClearInOutPointsAction());
        tx.addAction(
          target.clipItem.createSetInOutPointsAction(
            ppro.TickTime.createWithTicks(write2.inTicks.toString()),
            ppro.TickTime.createWithTicks(write2.outTicks.toString())
          )
        );
      });
      if (!result2.ok) {
        return result2;
      }
      if (previous) {
        onWritten();
      }
      pending = write2;
    }
    if (!pending) {
      return { ok: true, error: null };
    }
    const last = pending;
    const result = await commitStable(ppro, host, "Cortar silêncios", (live, tx) => {
      const target = resolveProjectItem(ppro, live, last);
      tx.addAction(
        live.editor.createOverwriteItemAction(
          target.projectItem,
          ppro.TickTime.createWithTicks(last.position.toString()),
          last.trackVideo,
          last.trackAudio
        )
      );
      tx.addAction(target.clipItem.createClearInOutPointsAction());
    });
    if (result.ok) {
      onWritten();
    }
    return result;
  }
  function resolveProjectItem(ppro, host, write2) {
    const fresh = write2.projectItemId ? host.items.get(write2.projectItemId) : void 0;
    const projectItem = fresh ?? write2.fallbackItem;
    return { projectItem, clipItem: ppro.ClipProjectItem.cast(projectItem) };
  }
  async function undoCuts(snapshot) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot };
    }
    try {
      const opened = await openHost(ppro);
      if (!opened.ok) {
        return { ok: false, message: opened.message, snapshot };
      }
      const host = opened.host;
      for (const run2 of snapshot.runs) {
        const cleared = await clearRange(ppro, host, run2);
        if (!cleared.ok) {
          return { ok: false, message: cleared.message, snapshot };
        }
        const writes = run2.originals.map((original) => ({
          projectItemId: original.projectItemId,
          fallbackItem: original.projectItem,
          inTicks: BigInt(original.inTicks),
          outTicks: BigInt(original.outTicks),
          position: BigInt(original.startTicks),
          trackVideo: run2.trackVideo,
          trackAudio: run2.trackAudio
        }));
        const restored = await writeSegments(ppro, host, writes, () => {
        });
        if (!restored.ok) {
          return {
            ok: false,
            message: stepMessage("a recolocação dos clipes originais", restored.error),
            snapshot
          };
        }
      }
      return {
        ok: true,
        message: `${snapshot.clipCount} ${snapshot.clipCount === 1 ? "clipe restaurado" : "clipes restaurados"}.`,
        snapshot: null
      };
    } catch (cause) {
      return { ok: false, message: describeError(cause), snapshot };
    }
  }
  async function clearRange(ppro, host, run2) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const items = await itemsInRange(
        ppro,
        host.sequence,
        run2.trackVideo,
        run2.trackAudio,
        BigInt(run2.writtenStart),
        BigInt(run2.writtenEnd)
      );
      const result = removeItems(ppro, host, items);
      if (result.ok) {
        return { ok: true };
      }
      if (attempt > 0 || !await reopenHost(ppro, host)) {
        return { ok: false, message: stepMessage("a limpeza do trecho", result.error) };
      }
    }
    return { ok: false, message: stepMessage("a limpeza do trecho", null) };
  }
  async function itemsInRange(ppro, sequence, trackVideo, trackAudio, from, to) {
    const found = [];
    const pick = async (items) => {
      for (const item of items) {
        const start = BigInt((await item.getStartTime()).ticks);
        const end = BigInt((await item.getEndTime()).ticks);
        if (start >= from && end <= to) {
          found.push(item);
        }
      }
    };
    if (trackVideo >= 0) {
      const track = await sequence.getVideoTrack(trackVideo);
      if (track) {
        await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      }
    }
    if (trackAudio >= 0) {
      const track = await sequence.getAudioTrack(trackAudio);
      if (track) {
        await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      }
    }
    return found;
  }
  function commit(project2, label, build) {
    let ok = false;
    let error = null;
    try {
      project2.lockedAccess(() => {
        try {
          ok = project2.executeTransaction(build, label);
        } catch (cause) {
          error = cause;
        }
      });
    } catch (cause) {
      error = error ?? cause;
    }
    if (error) {
      console.error(`[Silêncios] transação "${label}" falhou:`, error);
    }
    return { ok, error };
  }
  async function commitStable(ppro, host, label, build) {
    const first = commit(host.project, label, (tx) => build(host, tx));
    if (first.ok) {
      return first;
    }
    if (!await reopenHost(ppro, host)) {
      return first;
    }
    const second = commit(host.project, label, (tx) => build(host, tx));
    if (second.ok || second.error) {
      return second;
    }
    return first;
  }
  function stepMessage(step2, cause) {
    const detail = cause ? describeError(cause).trim() : "";
    if (!detail) {
      return `O Premiere recusou ${step2}.`;
    }
    return `O Premiere recusou ${step2}: ${/[.!?]$/.test(detail) ? detail : `${detail}.`}`;
  }
  function resolveEditor(ppro, sequence) {
    const api = ppro.SequenceEditor;
    try {
      if (typeof api?.getEditor === "function") {
        return api.getEditor(sequence) ?? null;
      }
      if (typeof api?.createForSequence === "function") {
        return api.createForSequence(sequence) ?? null;
      }
    } catch (cause) {
      console.error("[Silêncios] SequenceEditor indisponível:", cause);
    }
    return null;
  }
  function ticksPerSecond(ppro) {
    try {
      const one = ppro.TickTime?.TIME_ONE_SECOND;
      const ticks = one ? BigInt(one.ticks) : 0n;
      return ticks > 0n ? ticks : TICKS_PER_SECOND_FALLBACK;
    } catch {
      return TICKS_PER_SECOND_FALLBACK;
    }
  }
  function toTicks(sourceStart, seconds, inTicks, perSecond) {
    const offset = Math.round((seconds - sourceStart) * Number(perSecond));
    return inTicks + BigInt(offset);
  }
  function compareTicks(a, b) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function formatClock$1(seconds) {
    const safe = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(safe / 60);
    const rest = safe % 60;
    return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
  }
  const SILENCE_PRESETS = [
    {
      id: "youtube",
      name: "YouTube",
      note: "Jump cut: tira todo silêncio e as muletas, e é o mais duro com ruído solto.",
      params: {
        minSilence: 0.15,
        padIn: 0.02,
        padOut: 0.04,
        minKeep: 0.1,
        removeFillers: true,
        minConfidence: 0.4,
        noiseIsland: 0.25,
        autoThreshold: true,
        dbMargin: 12,
        dbThreshold: -32
      }
    },
    {
      id: "dinamico",
      name: "Dinâmico",
      note: "Corta as pausas mas deixa a respiração. Padrão para UGC e VSL.",
      params: {
        minSilence: 0.3,
        padIn: 0.05,
        padOut: 0.08,
        minKeep: 0.15,
        removeFillers: false,
        minConfidence: 0.3,
        noiseIsland: 0.2,
        autoThreshold: true,
        dbMargin: 10,
        dbThreshold: -35
      }
    },
    {
      id: "natural",
      name: "Natural",
      note: "Só as pausas longas. Mantém o fôlego de entrevista e depoimento.",
      params: {
        minSilence: 0.6,
        padIn: 0.1,
        padOut: 0.15,
        minKeep: 0.25,
        removeFillers: false,
        minConfidence: 0.2,
        noiseIsland: 0.12,
        autoThreshold: true,
        dbMargin: 8,
        dbThreshold: -38
      }
    },
    {
      id: "aula",
      name: "Aula",
      note: "Tira só o ar morto e não descarta nada como ruído. Preserva o raciocínio.",
      params: {
        minSilence: 1.2,
        padIn: 0.2,
        padOut: 0.25,
        minKeep: 0.4,
        removeFillers: false,
        minConfidence: 0,
        noiseIsland: 0,
        autoThreshold: true,
        dbMargin: 6,
        dbThreshold: -42
      }
    }
  ];
  const DEFAULT_PRESET_ID = "dinamico";
  function presetById(id) {
    return SILENCE_PRESETS.find((preset) => preset.id === id);
  }
  function matchPreset(params) {
    return SILENCE_PRESETS.find(
      (preset) => near(preset.params.minSilence, params.minSilence) && near(preset.params.padIn, params.padIn) && near(preset.params.padOut, params.padOut) && near(preset.params.minKeep, params.minKeep) && near(preset.params.minConfidence, params.minConfidence) && near(preset.params.noiseIsland, params.noiseIsland) && near(preset.params.dbMargin / 100, params.dbMargin / 100) && near(preset.params.dbThreshold / 100, params.dbThreshold / 100) && preset.params.autoThreshold === params.autoThreshold && preset.params.removeFillers === params.removeFillers
    ) ?? null;
  }
  function near(a, b) {
    return Math.abs(a - b) < 5e-3;
  }
  function defaultParams() {
    return { ...(presetById(DEFAULT_PRESET_ID) ?? SILENCE_PRESETS[1]).params };
  }
  function formatParam(spec, value) {
    switch (spec.unit) {
      case "%":
        return `${Math.round(value * 100)}%`;
      case "dB":
        return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(0)} dB`;
      case "dB+":
        return `piso +${value.toFixed(0)} dB`;
      default:
        return `${value.toFixed(2)}s`;
    }
  }
  const BOTH = ["waveform", "transcript"];
  const SLIDERS = [
    {
      key: "minSilence",
      label: "Silêncio mínimo",
      min: 0.1,
      max: 3,
      step: 0.05,
      unit: "s",
      group: "corte",
      modes: BOTH,
      note: "Pausas mais curtas que isso ficam intactas. É o controle principal."
    },
    {
      key: "padIn",
      label: "Margem antes",
      min: 0,
      max: 0.6,
      step: 0.01,
      unit: "s",
      group: "corte",
      modes: BOTH,
      note: "Ar mantido antes de cada fala. Zero encosta o corte na primeira sílaba."
    },
    {
      key: "padOut",
      label: "Margem depois",
      min: 0,
      max: 0.8,
      step: 0.01,
      unit: "s",
      group: "corte",
      modes: BOTH,
      note: "Ar mantido depois da fala. Evita cortar a cauda da última palavra."
    },
    {
      key: "minKeep",
      label: "Trecho mínimo",
      min: 0.05,
      max: 1.5,
      step: 0.05,
      unit: "s",
      group: "corte",
      modes: BOTH,
      note: "Nenhum pedaço mantido fica menor que isso — evita clipes de 2 frames."
    },
    {
      key: "minConfidence",
      label: "Rejeitar ruído abaixo de",
      min: 0,
      max: 0.95,
      step: 0.05,
      unit: "%",
      group: "ruido",
      modes: ["transcript"],
      note: "Som isolado reconhecido com menos confiança que isso é ruído, não fala. Suba quando um estalo no meio do silêncio estiver travando o corte. Zero desliga."
    },
    {
      key: "noiseIsland",
      label: "Som solto até",
      min: 0,
      max: 0.6,
      step: 0.02,
      unit: "s",
      group: "ruido",
      modes: BOTH,
      note: "Som isolado — sem fala perto, ou na borda do clipe — mais curto que isso é ruído. Pega tosse, batida de mesa e o estalo que o transcritor ouve como palavra. Zero desliga."
    },
    {
      key: "dbMargin",
      label: "Margem sobre o ruído",
      min: 3,
      max: 24,
      step: 1,
      unit: "dB+",
      group: "ruido",
      modes: ["waveform"],
      note: "O limiar é o piso de ruído MEDIDO em cada clipe mais esta margem — por isso um take com ar-condicionado se calibra sozinho. Margem maior corta mais."
    },
    {
      key: "dbThreshold",
      label: "Limiar fixo",
      min: -70,
      max: -10,
      step: 1,
      unit: "dB",
      group: "ruido",
      modes: ["waveform"],
      note: "Usado quando o limiar automático está desligado. Medido em banda de fala (até 4 kHz), então chiado de banda larga lê alguns dB abaixo do medidor do Premiere — na dúvida, use o automático."
    }
  ];
  function clampParams(params) {
    const out = { ...params };
    const fallback = defaultParams();
    for (const spec of SLIDERS) {
      const value = out[spec.key];
      out[spec.key] = Number.isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : fallback[spec.key];
    }
    return out;
  }
  const STATUS_LABEL = {
    ready: "",
    nothing: "sem silêncio",
    "no-transcript": "sem transcrição",
    "no-speech": "sem fala",
    "no-media": "sem arquivo",
    speed: "velocidade alterada",
    error: "erro"
  };
  let cancelActiveScan = null;
  const silenceTool = {
    id: "silence",
    name: "Corte de Silêncios",
    summary: "Remove pausas e fecha o corte automaticamente",
    hint: "Selecione os clipes falados na timeline e analise. Os trechos com fala são mantidos e encostados na timeline.",
    category: "edicao",
    glyph: "cut",
    available: true,
    mount(container, context) {
      let params = defaultParams();
      let mode = "waveform";
      let ffmpegPath = "";
      let scan = null;
      let snapshot = null;
      let scanning = false;
      let cancelRequested = false;
      container.innerHTML = markup$1(params);
      const modeSeg = container.querySelector("[data-mode-seg]");
      const presetRail = container.querySelector("[data-preset-rail]");
      const presetNote = container.querySelector("[data-preset-note]");
      const fillerField = container.querySelector("[data-filler-field]");
      const fillerSeg = container.querySelector("[data-filler-seg]");
      const autoSeg = container.querySelector("[data-auto-seg]");
      const autoField = container.querySelector("[data-auto-field]");
      const ffmpegField = container.querySelector("[data-ffmpeg-field]");
      const ffmpegInput = container.querySelector("[data-ffmpeg-path]");
      const diagButton = container.querySelector("[data-diag]");
      const diagOut = container.querySelector("[data-diag-out]");
      const scanButton = container.querySelector("[data-scan]");
      const emptyEl = container.querySelector("[data-empty]");
      const reportEl = container.querySelector("[data-report]");
      const manualEl = container.querySelector("[data-manual]");
      const advToggle = container.querySelector("[data-adv-toggle]");
      const advContent = container.querySelector("[data-adv-content]");
      const advIcon = container.querySelector("[data-adv-icon]");
      advToggle?.addEventListener("click", () => {
        if (!advContent) {
          return;
        }
        const willOpen = advContent.hidden;
        advContent.hidden = !willOpen;
        if (advIcon) {
          advIcon.style.transform = willOpen ? "rotate(180deg)" : "";
        }
      });
      context.setApplyLabel("CORTAR SILÊNCIOS");
      context.setApplyEnabled(false);
      context.setResetLabel("DESFAZER CORTE");
      context.setResetHandler(null);
      void readConfig$1().then((config) => {
        ffmpegPath = config.ffmpegPath;
        if (config.mode === "transcript" || config.mode === "waveform") {
          mode = config.mode;
        }
        if (ffmpegInput) {
          ffmpegInput.value = ffmpegPath;
        }
        syncMode();
      });
      function syncMode() {
        for (const item of modeSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.getAttribute("data-mode") === mode)
          );
        }
        if (fillerField) {
          fillerField.hidden = mode !== "transcript";
        }
        if (autoField) {
          autoField.hidden = mode !== "waveform";
        }
        if (ffmpegField) {
          ffmpegField.hidden = mode !== "waveform";
        }
        syncSliderVisibility();
      }
      function syncSliderVisibility() {
        for (const spec of SLIDERS) {
          const field = container.querySelector(`[data-field="${spec.key}"]`);
          if (!field) {
            continue;
          }
          let visible = spec.modes.includes(mode);
          if (spec.key === "dbMargin") {
            visible = visible && params.autoThreshold;
          }
          if (spec.key === "dbThreshold") {
            visible = visible && !params.autoThreshold;
          }
          field.hidden = !visible;
        }
        for (const item of autoSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.getAttribute("data-auto") === "on" === params.autoThreshold)
          );
        }
      }
      modeSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest(".seg-item");
        if (!item || !modeSeg.contains(item)) {
          return;
        }
        const next = item.getAttribute("data-mode") === "transcript" ? "transcript" : "waveform";
        if (next === mode) {
          return;
        }
        mode = next;
        scan = null;
        if (reportEl) {
          reportEl.innerHTML = "";
        }
        if (emptyEl) {
          emptyEl.hidden = false;
        }
        context.setApplyEnabled(false);
        syncMode();
        void writeConfig$1({ ffmpegPath, mode });
        context.setStatus(
          mode === "waveform" ? "Modo Onda (ffmpeg)" : "Modo Transcrição"
        );
      });
      ffmpegInput?.addEventListener("change", () => {
        ffmpegPath = ffmpegInput.value.trim();
        void writeConfig$1({ ffmpegPath, mode });
      });
      function syncPresetRail() {
        const active = matchPreset(params);
        for (const pill of presetRail?.querySelectorAll(".preset-pill") ?? []) {
          pill.classList.toggle(
            "is-active",
            active !== null && pill.getAttribute("data-preset") === active.id
          );
        }
        if (presetNote) {
          presetNote.textContent = active?.note ?? "Ajustes manuais — nenhum preset bate com estes números.";
        }
      }
      function syncSliders() {
        for (const spec of SLIDERS) {
          const input = container.querySelector(
            `[data-slider="${spec.key}"]`
          );
          const output = container.querySelector(`[data-out="${spec.key}"]`);
          if (input) {
            input.value = String(params[spec.key]);
          }
          if (output) {
            output.textContent = formatParam(spec, params[spec.key]);
          }
        }
        for (const item of fillerSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.getAttribute("data-filler") === "on" === params.removeFillers)
          );
        }
      }
      function paramsChanged() {
        params = clampParams(params);
        syncSliders();
        syncSliderVisibility();
        syncPresetRail();
        if (scan) {
          recomputePlans(scan, params);
          renderReport();
          context.setApplyEnabled(scan.readyCount > 0);
        }
      }
      for (const spec of SLIDERS) {
        const input = container.querySelector(
          `[data-slider="${spec.key}"]`
        );
        input?.addEventListener("input", () => {
          const parsed = Number.parseFloat(input.value);
          if (Number.isFinite(parsed)) {
            params = { ...params, [spec.key]: parsed };
            paramsChanged();
          }
        });
      }
      presetRail?.addEventListener("click", (event) => {
        const pill = event.target?.closest(".preset-pill");
        const preset = pill ? presetById(pill.getAttribute("data-preset") ?? "") : null;
        if (preset) {
          params = { ...preset.params };
          paramsChanged();
          context.setStatus(`Preset ${preset.name}`);
        }
      });
      fillerSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest(".seg-item");
        if (item && fillerSeg.contains(item)) {
          params = { ...params, removeFillers: item.getAttribute("data-filler") === "on" };
          paramsChanged();
        }
      });
      autoSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest(".seg-item");
        if (item && autoSeg.contains(item)) {
          params = { ...params, autoThreshold: item.getAttribute("data-auto") === "on" };
          paramsChanged();
        }
      });
      async function runScan() {
        if (scanning) {
          cancelRequested = true;
          context.setStatus("Cancelando…");
          return;
        }
        scanning = true;
        cancelRequested = false;
        context.setApplyEnabled(false);
        setScanBusy(true);
        try {
          showManual(null, "");
          scan = await scanSelection(params, {
            mode,
            ffmpegPath,
            onStage: (text2) => context.setStatus(text2),
            onProgress: (done, total) => context.setStatus(`Extraindo áudio… ${done}/${total}`),
            cancelled: () => cancelRequested,
            onManual: (scriptPath, reason) => {
              showManual(scriptPath, reason);
              context.setStatus(
                "Execute extract.command na pasta aberta.",
                "error"
              );
            }
          });
          showManual(null, "");
          renderReport();
          context.setApplyEnabled(scan.readyCount > 0);
          context.setStatus(summaryLine(scan), scan.readyCount > 0 ? "done" : "idle");
        } catch (cause) {
          scan = null;
          console.error("[Silêncios] varredura falhou:", cause);
          context.setStatus(
            cause instanceof Error ? cause.message : String(cause),
            "error"
          );
        } finally {
          scanning = false;
          cancelRequested = false;
          setScanBusy(false);
        }
      }
      function showManual(scriptPath, reason) {
        if (!manualEl) {
          return;
        }
        manualEl.hidden = scriptPath === null;
        if (!scriptPath) {
          manualEl.innerHTML = "";
          return;
        }
        manualEl.innerHTML = '<p class="sil-warn"><b>Execução manual necessária:</b>' + (reason ? ` <span class="sil-manual-why">${escapeHtml$3(reason)}</span>` : "") + ` Dê duplo clique em <b>extract.command</b> na pasta de trabalho.</p><p class="sil-manual-path">${escapeHtml$3(scriptPath)}</p><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-open-folder>Abrir pasta</div></div>`;
        manualEl.querySelector("[data-open-folder]")?.addEventListener("click", () => {
          void openWorkFolder$1().catch((cause) => {
            context.setStatus(
              cause instanceof Error ? cause.message : String(cause),
              "error"
            );
          });
        });
      }
      function setScanBusy(busy) {
        if (!scanButton) {
          return;
        }
        scanButton.classList.toggle("is-busy", busy);
        scanButton.textContent = busy ? "Cancelar" : "Analisar Seleção";
      }
      scanButton?.addEventListener("click", () => void runScan());
      diagButton?.addEventListener("click", () => {
        if (!diagOut) {
          return;
        }
        diagButton.setAttribute("aria-disabled", "true");
        diagOut.innerHTML = '<p class="sil-diag-wait">Testando…</p>';
        void diagnose(ffmpegPath).then((lines) => {
          diagOut.innerHTML = renderDiagnostic(lines);
        }).catch((cause) => {
          diagOut.innerHTML = '<p class="sil-diag-wait">' + escapeHtml$3(cause instanceof Error ? cause.message : String(cause)) + "</p>";
        }).then(() => {
          diagButton.removeAttribute("aria-disabled");
        });
      });
      context.setApplyHandler(async () => {
        if (!scan || scan.readyCount === 0) {
          return;
        }
        context.setStatus("Cortando silêncios…");
        context.setApplyEnabled(false);
        const result = await applyCuts(scan, (done, total) => {
          context.setStatus(`Cortando… ${done}/${total}`);
        });
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.snapshot) {
          snapshot = result.snapshot;
          context.setResetHandler(() => void runUndo());
        }
        if (result.ok) {
          scan = null;
          if (reportEl) {
            reportEl.innerHTML = doneMarkup(result.message);
          }
          if (emptyEl) {
            emptyEl.hidden = true;
          }
        }
        context.refreshSelection();
      });
      async function runUndo() {
        if (!snapshot) {
          return;
        }
        context.setStatus("Restaurando clipes originais…");
        const result = await undoCuts(snapshot);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok) {
          snapshot = null;
          context.setResetHandler(null);
          scan = null;
          if (reportEl) {
            reportEl.innerHTML = "";
          }
          if (emptyEl) {
            emptyEl.hidden = false;
          }
          context.setApplyEnabled(false);
        }
        context.refreshSelection();
      }
      function renderReport() {
        if (!reportEl || !scan) {
          return;
        }
        if (emptyEl) {
          emptyEl.hidden = scan.clips.length > 0;
        }
        if (scan.clips.length === 0) {
          reportEl.innerHTML = "";
          return;
        }
        const finalSeconds = Math.max(0, scan.totalSeconds - scan.removedSeconds);
        const ratio = scan.totalSeconds > 0 ? scan.removedSeconds / scan.totalSeconds : 0;
        let html = "";
        html += `<div class="sil-stats"><span class="sil-stat-tag">✂️ ${scan.cuts} ${scan.cuts === 1 ? "corte" : "cortes"}</span><span class="sil-stat-saved">−${formatSeconds(scan.removedSeconds)}</span><span class="sil-stat-range">${formatSeconds(scan.totalSeconds)} → <b>${formatSeconds(
          finalSeconds
        )}</b></span><span class="sil-stat-pct">−${Math.round(ratio * 100)}%</span></div>`;
        html += renderBars(scan);
        html += '<div class="sil-list">';
        for (const clip of scan.clips) {
          html += renderClipRow(clip);
        }
        html += "</div>";
        html += warnings(scan);
        reportEl.innerHTML = html;
      }
      function warnings(current) {
        let html = "";
        if (current.mode === "transcript") {
          const missing = current.clips.filter((clip) => clip.status === "no-transcript");
          if (missing.length > 0) {
            html += `<p class="sil-warn">${missing.length} ${missing.length === 1 ? "clipe sem transcrição" : "clipes sem transcrição"}. Transcreva em <b>Texto › Transcrever</b> ou use o modo <b>Onda</b>.</p>`;
          }
        }
        const orphans = current.clips.filter(
          (clip) => clip.orphanAudio && clip.status === "ready"
        );
        if (orphans.length > 0) {
          html += `<p class="sil-warn"><b>Áudio não selecionado:</b> ${orphans.length} ${orphans.length === 1 ? "clipe possui" : "clipes possuem"} áudio desvinculado. Selecione áudio e vídeo juntos para manter o sincronismo.</p>`;
        }
        return html;
      }
      cancelActiveScan = () => {
        cancelRequested = true;
      };
      syncSliders();
      syncPresetRail();
      syncMode();
    },
    unmount() {
      cancelActiveScan?.();
      cancelActiveScan = null;
    }
  };
  function markup$1(params) {
    const presets = SILENCE_PRESETS.map(
      (preset) => `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}">${preset.name}</div>`
    ).join("");
    const sliderFor = (spec) => `<div class="field" data-field="${spec.key}" hidden><div class="field-head"><span class="t-label">${spec.label}</span><span class="field-val" data-out="${spec.key}">${formatParam(
      spec,
      params[spec.key]
    )}</span></div><div class="slider-row"><input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${params[spec.key]}" data-slider="${spec.key}" aria-label="${spec.label}"></div><p class="field-note">${escapeHtml$3(spec.note)}</p></div>`;
    const coreSliders = ["minSilence", "padIn", "padOut"].map((k) => SLIDERS.find((s) => s.key === k)).filter((s) => Boolean(s)).map(sliderFor).join("");
    const advSliders = ["minKeep", "noiseIsland", "dbMargin", "dbThreshold", "minConfidence"].map((k) => SLIDERS.find((s) => s.key === k)).filter((s) => Boolean(s)).map(sliderFor).join("");
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Ritmo de Corte</span><div class="preset-rail" data-preset-rail>${presets}</div><p class="field-note" data-preset-note></p></div></div><div class="zone">${coreSliders}</div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para analisar</p><p class="sil-empty-desc">Selecione os clipes na timeline e analise para visualizar o corte.</p></div><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div><div class="sil-manual" data-manual hidden></div><div class="sil-report" data-report></div></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">⚙️ Ajustes Avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><span class="t-label">Método de Detecção</span><div class="seg" data-mode-seg><div class="seg-item" ${CONTROL} data-mode="waveform">Onda (ffmpeg)</div><div class="seg-item" ${CONTROL} data-mode="transcript">Transcrição</div></div></div><div class="field" data-filler-field hidden><span class="t-label">Muletas de Fala</span><div class="seg" data-filler-seg><div class="seg-item" ${CONTROL} data-filler="off">Manter</div><div class="seg-item" ${CONTROL} data-filler="on">Remover</div></div></div><div class="field" data-auto-field hidden><span class="t-label">Calibração de Ruído</span><div class="seg" data-auto-seg><div class="seg-item" ${CONTROL} data-auto="on">Automático</div><div class="seg-item" ${CONTROL} data-auto="off">Fixo</div></div></div>` + advSliders + `<div class="sil-ffmpeg-group" data-ffmpeg-field hidden><div class="field"><span class="t-label">Caminho do FFmpeg</span><input type="text" class="sil-path" data-ffmpeg-path spellcheck="false" placeholder="Padrão do sistema (automático)"></div><div class="field"><div class="field-head"><span class="t-label">Diagnóstico</span><span class="field-action" ${CONTROL} data-diag>Testar FFmpeg</span></div><div class="sil-diag" data-diag-out></div></div></div></div></div></div>`;
  }
  function renderBars(scan) {
    const drawable = scan.clips.filter((clip) => clip.plan && clip.durationSeconds > 0);
    if (drawable.length === 0) {
      return "";
    }
    let html = '<div class="sil-bars">';
    for (const clip of drawable.slice(0, 8)) {
      const plan = clip.plan;
      const span = clip.sourceEnd - clip.sourceStart;
      if (!(span > 0)) {
        continue;
      }
      let cells = "";
      let cursor = clip.sourceStart;
      for (const keep of plan.keep) {
        if (keep.start > cursor) {
          cells += cell("sil-cut", (keep.start - cursor) / span);
        }
        cells += cell("sil-keep", (keep.end - keep.start) / span);
        cursor = keep.end;
      }
      if (clip.sourceEnd > cursor) {
        cells += cell("sil-cut", (clip.sourceEnd - cursor) / span);
      }
      html += `<div class="sil-bar">${cells}</div>`;
    }
    if (drawable.length > 8) {
      html += `<p class="sil-bar-more">+${drawable.length - 8} clipes não desenhados</p>`;
    }
    html += "</div>";
    return html;
  }
  function cell(className, fraction) {
    const width = Math.max(0, Math.min(100, fraction * 100));
    return `<span class="${className}" style="width:${width.toFixed(3)}%"></span>`;
  }
  function renderClipRow(clip) {
    const label = STATUS_LABEL[clip.status];
    const detail = clip.status === "ready" && clip.plan ? `<span class="sil-row-cuts">${clip.plan.drop.length} ${clip.plan.drop.length === 1 ? "corte" : "cortes"}</span><span class="sil-row-time">${formatSeconds(clip.durationSeconds)} → ${formatSeconds(
      clip.plan.keptSeconds
    )}</span>` : `<span class="sil-row-skip">${escapeHtml$3(
      clip.status === "error" && clip.detail ? clip.detail : label
    )}</span>`;
    return `<div class="sil-row-group${clip.status === "ready" ? " is-ready" : ""}"><div class="sil-row"><span class="sil-row-name" title="${escapeHtml$3(clip.name)}">${escapeHtml$3(
      clip.name
    )}</span>` + detail + "</div></div>";
  }
  function renderDiagnostic(lines) {
    return '<div class="sil-diag-list">' + lines.map(
      (line) => `<div class="sil-diag-row${line.ok ? "" : " is-bad"}"><span class="sil-diag-mark">${line.ok ? "✓" : "✕"}</span><span class="sil-diag-label">${escapeHtml$3(line.label)}</span><span class="sil-diag-detail">${escapeHtml$3(line.detail)}</span></div>`
    ).join("") + "</div>";
  }
  function summaryLine(scan) {
    if (scan.clips.length === 0) {
      return "Nenhum clipe selecionado.";
    }
    if (scan.readyCount === 0) {
      const missing = scan.clips.filter((clip) => clip.status === "no-transcript").length;
      if (missing > 0) {
        return "Nenhum clipe transcrito. Use o modo Onda ou transcreva em Texto.";
      }
      return "Nenhum silêncio detectado com estes parâmetros.";
    }
    return `${scan.cuts} ${scan.cuts === 1 ? "corte" : "cortes"} em ${scan.readyCount} ${scan.readyCount === 1 ? "clipe" : "clipes"}.`;
  }
  function doneMarkup(message) {
    return `<div class="org-done"><p class="org-done-title">Silêncios cortados ✓</p><p class="org-done-desc">${escapeHtml$3(message)}</p><p class="org-done-desc" style="opacity: 0.7; font-size: 10.5px;">Dica: Selecione o espaço vazio na timeline e use <b>Shift+Delete</b> (Ripple Delete) para fechar os cortes.</p></div>`;
  }
  function escapeHtml$3(value) {
    return value.replace(/[&<>"]/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  function commitTransaction(project2, label, build) {
    let committed = false;
    project2.lockedAccess(() => {
      committed = project2.executeTransaction(build, label);
    });
    return committed;
  }
  const VIDEO_EXTS = /* @__PURE__ */ new Set([
    "mp4",
    "mov",
    "avi",
    "mkv",
    "mxf",
    "r3d",
    "braw",
    "ari",
    "wmv",
    "flv",
    "m4v",
    "ts",
    "m2ts",
    "mts",
    "3gp",
    "webm",
    "prores",
    "dnxhd",
    "dnxhr",
    "cine"
  ]);
  const AUDIO_EXTS = /* @__PURE__ */ new Set([
    "wav",
    "mp3",
    "aac",
    "aif",
    "aiff",
    "flac",
    "ogg",
    "m4a",
    "wma",
    "opus",
    "ac3",
    "eac3"
  ]);
  const IMAGE_EXTS = /* @__PURE__ */ new Set([
    "jpg",
    "jpeg",
    "png",
    "tiff",
    "tif",
    "bmp",
    "psd",
    "exr",
    "dpx",
    "gif",
    "webp",
    "svg",
    "ico",
    "heic",
    "heif",
    "raw",
    "cr2",
    "nef",
    "arw",
    "dng",
    "tga"
  ]);
  const GRAPHICS_EXTS = /* @__PURE__ */ new Set([
    "mogrt",
    "prproj",
    "aep",
    "ai",
    "eps",
    "pdf"
  ]);
  const PREMIERE_SYNTHETIC_NAMES = [
    "adjustment layer",
    "camada de ajuste",
    "capa de ajuste",
    "color matte",
    "cor fosca",
    "fosco de cor",
    "solid color",
    "color sólido",
    "black video",
    "vídeo preto",
    "video preto",
    "video negro",
    "transparent video",
    "vídeo transparente",
    "video transparente",
    "bars and tone",
    "barras e tom",
    "barras y tono",
    "universal counting leader",
    "contagem regressiva"
  ];
  function isSyntheticName(name) {
    const lower = name.toLowerCase().trim();
    return PREMIERE_SYNTHETIC_NAMES.some((pattern) => lower.includes(pattern));
  }
  function extensionOf(path) {
    const dot = path.lastIndexOf(".");
    return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  }
  function categoryFromExtension(ext) {
    if (VIDEO_EXTS.has(ext)) return "video";
    if (AUDIO_EXTS.has(ext)) return "audio";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (GRAPHICS_EXTS.has(ext)) return "graphics";
    return "other";
  }
  const SFX_HINTS = /(^|[^a-z])(sfx|fx|efeito|efeitos|effects?|foley|whoosh|swoosh|impact|riser|braam|stinger|transition|ambien(ce|te)|hit)([^a-z]|$)/i;
  const MUSIC_HINTS = /(^|[^a-z])(music|m[uú]sica|musicas|trilha|soundtrack|score|song|beat|instrumental|bgm)([^a-z]|$)/i;
  const MUSIC_MIN_SECONDS = 45;
  const SFX_MAX_SECONDS = 8;
  function folderPartOf(mediaPath) {
    const cut = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
    return cut > 0 ? mediaPath.slice(0, cut) : "";
  }
  const MUSIC_LEANING_EXTS = /* @__PURE__ */ new Set(["mp3", "m4a", "aac", "ogg", "opus", "wma"]);
  async function audioSeconds(ppro, clip) {
    if (!clip) {
      return null;
    }
    try {
      const media = await clip.getMedia();
      const seconds = media?.duration?.seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    } catch {
    }
    try {
      const audio = ppro.Constants.MediaType.AUDIO;
      const inPoint = await clip.getInPoint(audio);
      const outPoint = await clip.getOutPoint(audio);
      const seconds = outPoint.seconds - inPoint.seconds;
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    } catch {
      return null;
    }
  }
  async function audioKindOf(ppro, clip, name, mediaPath) {
    const folder = folderPartOf(mediaPath);
    const seconds = await audioSeconds(ppro, clip);
    const decided = (() => {
      if (SFX_HINTS.test(folder)) return "sfx";
      if (MUSIC_HINTS.test(folder)) return "music";
      if (SFX_HINTS.test(name)) return "sfx";
      if (MUSIC_HINTS.test(name)) return "music";
      if (seconds !== null) {
        if (seconds >= MUSIC_MIN_SECONDS) return "music";
        if (seconds <= SFX_MAX_SECONDS) return "sfx";
        return null;
      }
      const ext = extensionOf(mediaPath || name);
      return MUSIC_LEANING_EXTS.has(ext) ? "music" : null;
    })();
    console.log(
      `[Organize] audio "${name}" | ${seconds === null ? "duração ilegível" : `${seconds.toFixed(1)}s`} | pasta "${folder}" | -> ${decided ?? "solto em Audio"}`
    );
    return decided;
  }
  const AUDIO_KIND_LABELS = {
    music: "Musicas",
    sfx: "SFX"
  };
  const TOP_CATEGORY_LABELS = {
    sequence: "Sequencias",
    video: "Videos",
    audio: "Audio",
    image: "Imagens",
    graphics: "Graficos & Motion",
    premiere: "Itens do Premiere",
    other: "Outros"
  };
  const TOP_CATEGORY_ORDER = [
    "sequence",
    "video",
    "audio",
    "image",
    "graphics",
    "premiere",
    "other"
  ];
  const NAME_SEPARATORS = [" - ", " _ ", " – ", " — "];
  function sequenceBaseName(name) {
    const trimmed = name.trim();
    for (const sep of NAME_SEPARATORS) {
      const idx = trimmed.indexOf(sep);
      if (idx > 0) {
        return trimmed.slice(0, idx).trim();
      }
    }
    return trimmed;
  }
  async function scanProject() {
    const ppro = getPremiere();
    if (!ppro) {
      throw new Error("Premiere UXP runtime indisponível.");
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      throw new Error("Nenhum projeto aberto.");
    }
    const rootFolder = await project2.getRootItem();
    const rootLooseItems = await collectRootLooseItems(ppro, rootFolder);
    const nestedIds = await detectNestedSequenceIds(ppro, project2);
    const projectSequenceGuids = /* @__PURE__ */ new Set();
    const projectSequenceNames = /* @__PURE__ */ new Set();
    try {
      for (const seq of await project2.getSequences()) {
        try {
          projectSequenceGuids.add(String(seq.guid));
        } catch {
        }
        try {
          if (seq.name) projectSequenceNames.add(seq.name);
        } catch {
        }
      }
    } catch {
    }
    const hasProjectSequenceList = projectSequenceGuids.size > 0 || projectSequenceNames.size > 0;
    const classified = [];
    const diagnostics = [];
    for (const { item, parentId } of rootLooseItems) {
      const id = item.getId();
      const name = item.name ?? "";
      if (item.type === ppro.ProjectItem.TYPE_BIN || item.type === ppro.ProjectItem.TYPE_ROOT) {
        continue;
      }
      let clip = null;
      try {
        clip = ppro.ClipProjectItem.cast(item);
      } catch {
        clip = null;
      }
      let mediaPath = "";
      let canChangePath = true;
      if (clip) {
        try {
          mediaPath = await clip.getMediaFilePath() || "";
        } catch {
          mediaPath = "";
        }
        try {
          canChangePath = await clip.canChangeMediaPath();
        } catch {
          canChangePath = true;
        }
      }
      const ext = extensionOf(mediaPath || name);
      const hasRealMedia = mediaPath !== "" && (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext) || IMAGE_EXTS.has(ext) || GRAPHICS_EXTS.has(ext));
      let claimsSequence = false;
      let contentTypeRaw = void 0;
      let ownGuid = null;
      if (clip) {
        try {
          claimsSequence = await clip.isSequence();
        } catch {
          claimsSequence = false;
        }
        try {
          contentTypeRaw = await clip.getContentType();
        } catch {
          contentTypeRaw = void 0;
        }
        try {
          const own = await clip.getSequence();
          ownGuid = own ? String(own.guid) : null;
        } catch {
          ownGuid = null;
        }
      }
      let isSeq;
      if (hasProjectSequenceList) {
        isSeq = ownGuid !== null && projectSequenceGuids.has(ownGuid) || ownGuid === null && projectSequenceNames.has(name) && !hasRealMedia;
      } else {
        const sequenceConst = ppro.Constants?.ContentType?.SEQUENCE;
        const byContentType = sequenceConst !== void 0 && contentTypeRaw === sequenceConst;
        isSeq = (claimsSequence || byContentType) && !hasRealMedia;
      }
      let category;
      let seqBase = null;
      let audioKind = null;
      let mediaPathForKind = "";
      if (isSeq) {
        const isNested = nestedIds.has(id);
        category = isNested ? "sequence-nested" : "sequence";
        seqBase = sequenceBaseName(name);
      } else {
        if (isSyntheticName(name) || !canChangePath && !ext || !mediaPath && !ext) {
          category = "premiere";
        } else {
          category = categoryFromExtension(ext);
        }
        mediaPathForKind = mediaPath;
      }
      if (category === "audio") {
        audioKind = await audioKindOf(ppro, clip, name, mediaPathForKind);
      }
      diagnostics.push(
        `  ${category.padEnd(16)} ${name}
      isSequence=${claimsSequence} contentType=${String(contentTypeRaw)} guid=${ownGuid ?? "—"} noProjeto=${ownGuid !== null && projectSequenceGuids.has(ownGuid)} nomeNaLista=${projectSequenceNames.has(name)}
      ext="${ext}" mídia="${mediaPath}"`
      );
      classified.push({
        item,
        clip,
        name,
        id,
        category,
        audioKind,
        sequenceBase: seqBase,
        parentId
      });
    }
    const counts = {
      video: 0,
      audio: 0,
      image: 0,
      graphics: 0,
      sequence: 0,
      "sequence-nested": 0,
      premiere: 0,
      other: 0
    };
    const audioKindCounts = { sfx: 0, music: 0 };
    for (const c of classified) {
      counts[c.category]++;
      if (c.audioKind) {
        audioKindCounts[c.audioKind]++;
      }
    }
    const totalSequences = counts.sequence + counts["sequence-nested"];
    console.log(
      `[Organize] o projeto declara ${projectSequenceNames.size} sequência(s): ${[...projectSequenceNames].join(", ") || "—"}
[Organize] classificação:
` + diagnostics.join("\n")
    );
    const allSequences = classified.filter(
      (c) => c.category === "sequence" || c.category === "sequence-nested"
    );
    const seqMap = /* @__PURE__ */ new Map();
    for (const seqItem of allSequences) {
      const base = seqItem.sequenceBase ?? seqItem.name;
      const list = seqMap.get(base);
      if (list) {
        list.push(seqItem);
      } else {
        seqMap.set(base, [seqItem]);
      }
    }
    const sequenceGroups = [];
    const standalonePrincipal = [];
    const standaloneNested = [];
    for (const [base, members] of seqMap) {
      if (members.length >= 2) {
        sequenceGroups.push({ base, items: members });
      } else {
        for (const member of members) {
          if (member.category === "sequence-nested") {
            standaloneNested.push(member);
          } else {
            standalonePrincipal.push(member);
          }
        }
      }
    }
    return {
      items: classified,
      counts,
      totalSequences,
      sequenceGroups,
      standalonePrincipal,
      standaloneNested,
      audioKindCounts
    };
  }
  async function collectRootLooseItems(ppro, rootFolder) {
    const result = [];
    const ourBinNames = new Set(Object.values(TOP_CATEGORY_LABELS));
    const children = await rootFolder.getItems();
    for (const child of children) {
      if (child.type === ppro.ProjectItem.TYPE_ROOT) {
        continue;
      }
      if (child.type === ppro.ProjectItem.TYPE_BIN) {
        if (!ourBinNames.has(child.name)) {
          continue;
        }
        try {
          const ourBin = ppro.FolderItem.cast(child);
          const binId = child.getId();
          for (const inner of await ourBin.getItems()) {
            if (inner.type === ppro.ProjectItem.TYPE_BIN || inner.type === ppro.ProjectItem.TYPE_ROOT) {
              continue;
            }
            result.push({ item: inner, parentId: binId });
          }
        } catch {
        }
        continue;
      }
      result.push({ item: child, parentId: "__root__" });
    }
    return result;
  }
  async function detectNestedSequenceIds(ppro, project2) {
    const nestedIds = /* @__PURE__ */ new Set();
    try {
      const sequences = await project2.getSequences();
      for (const seq of sequences) {
        const videoTrackCount = await seq.getVideoTrackCount();
        for (let t = 0; t < videoTrackCount; t++) {
          const track = await seq.getVideoTrack(t);
          if (!track) continue;
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
          for (const ti of items) {
            try {
              const pi = await ti.getProjectItem();
              if (!pi) continue;
              const clip = ppro.ClipProjectItem.cast(pi);
              const isSub = await clip.isSequence();
              if (isSub) {
                nestedIds.add(pi.getId());
              }
            } catch {
            }
          }
        }
        const audioTrackCount = await seq.getAudioTrackCount();
        for (let t = 0; t < audioTrackCount; t++) {
          const track = await seq.getAudioTrack(t);
          if (!track) continue;
          const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
          for (const ti of items) {
            try {
              const pi = await ti.getProjectItem();
              if (!pi) continue;
              const clip = ppro.ClipProjectItem.cast(pi);
              const isSub = await clip.isSequence();
              if (isSub) {
                nestedIds.add(pi.getId());
              }
            } catch {
            }
          }
        }
      }
    } catch {
    }
    return nestedIds;
  }
  async function organizeProject(scan) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      return { ok: false, message: "Nenhum projeto aberto.", snapshot: null };
    }
    const snapshot = { moves: [], createdBinIds: [] };
    let phase = "iniciar";
    try {
      phase = "ler a raiz do projeto";
      let root = await project2.getRootItem();
      const existingTopNames = /* @__PURE__ */ new Set();
      for (const child of await root.getItems()) {
        if (child.type === ppro.ProjectItem.TYPE_BIN) {
          existingTopNames.add(child.name);
        }
      }
      phase = "criar as pastas principais";
      const wantedTop = [
        ["sequence", scan.totalSequences],
        ["video", scan.counts.video],
        ["audio", scan.counts.audio],
        ["image", scan.counts.image],
        ["graphics", scan.counts.graphics],
        ["premiere", scan.counts.premiere],
        ["other", scan.counts.other]
      ];
      let plannedTop = 0;
      const topCreated = commitTransaction(
        project2,
        "Organizar Projeto — Criar Pastas Principais",
        (tx) => {
          for (const [cat, count] of wantedTop) {
            const label = TOP_CATEGORY_LABELS[cat];
            if (count > 0 && !existingTopNames.has(label)) {
              tx.addAction(root.createBinAction(label, true));
              plannedTop += 1;
            }
          }
        }
      );
      if (plannedTop > 0 && !topCreated) {
        return {
          ok: false,
          message: "O Premiere recusou a criação das pastas principais. Nada foi alterado.",
          snapshot: null
        };
      }
      phase = "reler as pastas principais";
      root = await project2.getRootItem();
      const afterTop = await readBinLayout(ppro, root);
      for (const [cat, folder] of afterTop.top) {
        if (!existingTopNames.has(TOP_CATEGORY_LABELS[cat])) {
          const id = afterTop.ids.get(folder);
          if (id) snapshot.createdBinIds.push(id);
        }
      }
      const hadPrincipal = !!afterTop.seqPrincipal;
      const hadNested = !!afterTop.seqNested;
      const hadSeqGroups = new Set(afterTop.seqGroups.keys());
      const hadAudioKinds = new Set(afterTop.audioKind.keys());
      phase = "criar as subpastas";
      const seqBin = afterTop.top.get("sequence");
      const audioBin = afterTop.top.get("audio");
      let plannedSub = 0;
      const subCreated = commitTransaction(
        project2,
        "Organizar Projeto — Subpastas",
        (tx) => {
          if (seqBin && scan.totalSequences > 0) {
            if (scan.standalonePrincipal.length > 0 && !hadPrincipal) {
              tx.addAction(seqBin.createBinAction("Principal", true));
              plannedSub += 1;
            }
            if (scan.standaloneNested.length > 0 && !hadNested) {
              tx.addAction(seqBin.createBinAction("Nested", true));
              plannedSub += 1;
            }
            for (const group of scan.sequenceGroups) {
              if (!hadSeqGroups.has(group.base)) {
                tx.addAction(seqBin.createBinAction(group.base, true));
                plannedSub += 1;
              }
            }
          }
          if (audioBin) {
            for (const kind of ["music", "sfx"]) {
              if (scan.audioKindCounts[kind] > 0 && !hadAudioKinds.has(kind)) {
                tx.addAction(audioBin.createBinAction(AUDIO_KIND_LABELS[kind], true));
                plannedSub += 1;
              }
            }
          }
        }
      );
      if (plannedSub > 0 && !subCreated) {
        return {
          ok: false,
          message: "O Premiere recusou a criação das subpastas. As pastas principais podem ter sido criadas; nenhum item foi movido.",
          snapshot: null
        };
      }
      phase = "reler a estrutura de pastas";
      root = await project2.getRootItem();
      const layout = await readBinLayout(ppro, root);
      if (layout.seqPrincipal && !hadPrincipal) {
        const id = layout.ids.get(layout.seqPrincipal);
        if (id) snapshot.createdBinIds.push(id);
      }
      if (layout.seqNested && !hadNested) {
        const id = layout.ids.get(layout.seqNested);
        if (id) snapshot.createdBinIds.push(id);
      }
      for (const [name, folder] of layout.seqGroups) {
        if (!hadSeqGroups.has(name)) {
          const id = layout.ids.get(folder);
          if (id) snapshot.createdBinIds.push(id);
        }
      }
      for (const kind of ["music", "sfx"]) {
        const folder = layout.audioKind.get(kind);
        if (folder && !hadAudioKinds.has(kind)) {
          const id = layout.ids.get(folder);
          if (id) snapshot.createdBinIds.push(id);
        }
      }
      phase = "indexar os itens";
      const freshItems = /* @__PURE__ */ new Map();
      await indexAllItems(ppro, root, freshItems);
      phase = "mover os itens";
      let movedCount = 0;
      let missingTargets = 0;
      const moveRoot = root;
      const moved = commitTransaction(project2, "Organizar Projeto — Mover Itens", (tx) => {
        for (const classified of scan.items) {
          const { category, audioKind, sequenceBase, parentId } = classified;
          let targetBin;
          const seqTop = layout.top.get("sequence");
          if (category === "sequence" || category === "sequence-nested") {
            if (sequenceBase && layout.seqGroups.has(sequenceBase)) {
              targetBin = layout.seqGroups.get(sequenceBase);
            } else if (category === "sequence-nested") {
              targetBin = layout.seqNested ?? seqTop;
            } else {
              targetBin = layout.seqPrincipal ?? seqTop;
            }
          } else if (category === "audio") {
            targetBin = (audioKind ? layout.audioKind.get(audioKind) : void 0) ?? layout.top.get("audio");
          } else {
            targetBin = layout.top.get(category);
          }
          if (!targetBin) {
            missingTargets += 1;
            continue;
          }
          if (layout.ids.get(targetBin) === parentId) continue;
          const freshItem = freshItems.get(classified.id);
          if (!freshItem) continue;
          snapshot.moves.push({
            itemId: classified.id,
            originalParentId: parentId
          });
          tx.addAction(moveRoot.createMoveItemAction(freshItem, targetBin));
          movedCount++;
        }
      });
      if (movedCount > 0 && !moved) {
        return {
          ok: false,
          message: "O Premiere recusou a movimentação. Nada foi alterado.",
          snapshot: null
        };
      }
      if (movedCount === 0 && missingTargets > 0) {
        return {
          ok: false,
          message: `${missingTargets} ${missingTargets === 1 ? "item ficou" : "itens ficaram"} sem pasta de destino. Confira se as pastas do plugin existem na raiz do projeto.`,
          snapshot: null
        };
      }
      return {
        ok: true,
        message: movedCount > 0 ? `${movedCount} ${movedCount === 1 ? "item organizado" : "itens organizados"} com sucesso.` + (missingTargets > 0 ? ` ${missingTargets} sem pasta de destino.` : "") : "Nada a mover — tudo já está no lugar.",
        snapshot
      };
    } catch (cause) {
      console.error(`[Organize] falhou ao ${phase}:`, cause);
      return {
        ok: false,
        message: `Falha ao ${phase}: ${describeError(cause)}`,
        snapshot: null
      };
    }
  }
  async function undoOrganize(snapshot) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      return { ok: false, message: "Nenhum projeto aberto.", snapshot: null };
    }
    try {
      const rootFolder = await project2.getRootItem();
      const allBins = /* @__PURE__ */ new Map();
      await indexBins(ppro, rootFolder, allBins);
      allBins.set("__root__", rootFolder);
      const allItemsById = /* @__PURE__ */ new Map();
      await indexAllItems(ppro, rootFolder, allItemsById);
      let restoredCount = 0;
      let lostCount = 0;
      const restored = commitTransaction(
        project2,
        "Desfazer Organização — Restaurar Itens",
        (tx) => {
          for (const move of snapshot.moves) {
            const item = allItemsById.get(move.itemId);
            const originalParent = allBins.get(move.originalParentId);
            if (!item || !originalParent) {
              lostCount++;
              continue;
            }
            const moveAction = rootFolder.createMoveItemAction(item, originalParent);
            tx.addAction(moveAction);
            restoredCount++;
          }
        }
      );
      if (restoredCount > 0 && !restored) {
        return {
          ok: false,
          message: "O Premiere recusou a restauração dos itens. Nada foi movido de volta.",
          snapshot
        };
      }
      const rootAfterRestore = await project2.getRootItem();
      const updatedBins = /* @__PURE__ */ new Map();
      await indexBins(ppro, rootAfterRestore, updatedBins);
      const candidates2 = [];
      for (const id of snapshot.createdBinIds) {
        const folder = updatedBins.get(id);
        if (!folder) {
          continue;
        }
        let childIds;
        try {
          childIds = (await folder.getItems()).map((child) => safeId(child));
        } catch {
          continue;
        }
        candidates2.push({ id, folder, childIds });
      }
      const removableIds = /* @__PURE__ */ new Set();
      let keptBins = 0;
      for (let index = candidates2.length - 1; index >= 0; index--) {
        const candidate = candidates2[index];
        const hasForeignContent = candidate.childIds.some(
          (childId) => !removableIds.has(childId)
        );
        if (hasForeignContent) {
          keptBins += 1;
          continue;
        }
        removableIds.add(candidate.id);
      }
      const binsToRemove = candidates2.filter((candidate) => removableIds.has(candidate.id)).reverse();
      let binsRemoved = true;
      if (binsToRemove.length > 0) {
        binsRemoved = commitTransaction(
          project2,
          "Desfazer Organização — Remover Pastas",
          (tx) => {
            for (const { folder } of binsToRemove) {
              const piCast = ppro.ProjectItem.cast(folder);
              const removeAction = rootAfterRestore.createRemoveItemAction(piCast);
              tx.addAction(removeAction);
            }
          }
        );
      }
      const notes = [];
      if (keptBins > 0) {
        notes.push(
          `${keptBins} ${keptBins === 1 ? "pasta mantida" : "pastas mantidas"} por ter conteúdo novo dentro.`
        );
      }
      if (lostCount > 0) {
        notes.push(
          `${lostCount} ${lostCount === 1 ? "item não foi encontrado" : "itens não foram encontrados"} no projeto.`
        );
      }
      if (!binsRemoved) {
        notes.push("O Premiere recusou a remoção das pastas vazias.");
      }
      return {
        ok: true,
        message: [
          `${restoredCount} ${restoredCount === 1 ? "item restaurado" : "itens restaurados"}.`,
          ...notes
        ].join(" "),
        snapshot: null
      };
    } catch (cause) {
      return {
        ok: false,
        message: `Falha ao desfazer: ${describeError(cause)}`,
        snapshot
      };
    }
  }
  function safeId(item) {
    try {
      return item.getId();
    } catch {
      return "";
    }
  }
  async function readBinLayout(ppro, rootFolder) {
    const layout = {
      top: /* @__PURE__ */ new Map(),
      audioKind: /* @__PURE__ */ new Map(),
      seqGroups: /* @__PURE__ */ new Map(),
      ids: /* @__PURE__ */ new Map()
    };
    for (const child of await rootFolder.getItems()) {
      if (child.type !== ppro.ProjectItem.TYPE_BIN) {
        continue;
      }
      let folder;
      try {
        folder = ppro.FolderItem.cast(child);
      } catch {
        continue;
      }
      layout.ids.set(folder, child.getId());
      const category = TOP_CATEGORY_ORDER.find(
        (cat) => TOP_CATEGORY_LABELS[cat] === child.name
      );
      if (!category) {
        continue;
      }
      layout.top.set(category, folder);
      if (category !== "audio" && category !== "sequence") {
        continue;
      }
      for (const sub of await folder.getItems()) {
        if (sub.type !== ppro.ProjectItem.TYPE_BIN) {
          continue;
        }
        let subFolder;
        try {
          subFolder = ppro.FolderItem.cast(sub);
        } catch {
          continue;
        }
        layout.ids.set(subFolder, sub.getId());
        if (category === "audio") {
          for (const kind of ["music", "sfx"]) {
            if (sub.name === AUDIO_KIND_LABELS[kind]) {
              layout.audioKind.set(kind, subFolder);
            }
          }
        } else if (sub.name === "Principal") {
          layout.seqPrincipal = subFolder;
        } else if (sub.name === "Nested") {
          layout.seqNested = subFolder;
        } else {
          layout.seqGroups.set(sub.name, subFolder);
        }
      }
    }
    return layout;
  }
  async function indexBins(ppro, folder, map) {
    const children = await folder.getItems();
    for (const child of children) {
      if (child.type === ppro.ProjectItem.TYPE_BIN) {
        try {
          const sub = ppro.FolderItem.cast(child);
          map.set(child.getId(), sub);
          await indexBins(ppro, sub, map);
        } catch {
        }
      }
    }
  }
  async function indexAllItems(ppro, folder, map) {
    const children = await folder.getItems();
    for (const child of children) {
      map.set(child.getId(), child);
      if (child.type === ppro.ProjectItem.TYPE_BIN) {
        try {
          const sub = ppro.FolderItem.cast(child);
          await indexAllItems(ppro, sub, map);
        } catch {
        }
      }
    }
  }
  const TOP_CAT_GLYPHS = {
    sequence: "📋",
    video: "🎬",
    audio: "🔊",
    image: "🖼",
    graphics: "📐",
    premiere: "🎛",
    other: "📦"
  };
  const organizeTool = {
    id: "organize",
    name: "Organizar Pastas",
    summary: "Organização automática do projeto por tipo",
    hint: "Organiza apenas os arquivos e sequências soltos na raiz do projeto. Suas pastas pessoais e pastas criadas por plugins (Animation Composer, etc.) são 100% preservadas e intocadas.",
    category: "projeto",
    glyph: "folder",
    available: true,
    mount(container, context) {
      let scan = null;
      let lastSnapshot = null;
      let scanning = false;
      container.innerHTML = emptyMarkup();
      const scanBtn = container.querySelector("[data-scan]");
      const treeEl = container.querySelector("[data-tree]");
      const statsEl = container.querySelector("[data-stats]");
      const emptyEl = container.querySelector("[data-empty]");
      context.setApplyLabel("ORGANIZAR PROJETO");
      context.setApplyEnabled(false);
      context.setResetLabel("DESFAZER");
      context.setResetHandler(null);
      async function runScan() {
        if (scanning) return;
        scanning = true;
        context.setStatus("Escaneando itens soltos…");
        context.setApplyEnabled(false);
        if (scanBtn) {
          scanBtn.setAttribute("aria-disabled", "true");
          scanBtn.textContent = "Escaneando…";
        }
        try {
          scan = await scanProject();
          renderTree();
          renderStats();
          context.setApplyEnabled(scan.items.length > 0);
          context.setStatus(
            `${scan.items.length} ${scan.items.length === 1 ? "item solto encontrado" : "itens soltos encontrados"}.`,
            "done"
          );
        } catch (cause) {
          const msg = cause instanceof Error ? cause.message : String(cause);
          context.setStatus(msg, "error");
        } finally {
          scanning = false;
          if (scanBtn) {
            scanBtn.removeAttribute("aria-disabled");
            scanBtn.textContent = "Escanear Projeto";
          }
        }
      }
      scanBtn?.addEventListener("click", () => void runScan());
      context.setApplyHandler(async () => {
        if (!scan) return;
        context.setStatus("Organizando…");
        context.setApplyEnabled(false);
        const result = await organizeProject(scan);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok && result.snapshot) {
          lastSnapshot = result.snapshot;
          context.setResetHandler(() => void runUndo());
          scan = null;
          if (treeEl) treeEl.innerHTML = organizedMarkup(result.snapshot.moves.length);
          if (statsEl) statsEl.innerHTML = "";
          context.setApplyEnabled(false);
        } else if (!result.ok) {
          context.setApplyEnabled(scan !== null && scan.items.length > 0);
        }
      });
      async function runUndo() {
        if (!lastSnapshot) return;
        context.setStatus("Desfazendo organização…");
        const result = await undoOrganize(lastSnapshot);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok) {
          lastSnapshot = null;
          context.setResetHandler(null);
          scan = null;
          if (treeEl) treeEl.innerHTML = "";
          if (statsEl) statsEl.innerHTML = "";
          if (emptyEl) emptyEl.hidden = false;
          context.setApplyEnabled(false);
        }
      }
      function renderTree() {
        if (!scan || !treeEl) return;
        if (emptyEl) emptyEl.hidden = true;
        let html = "";
        for (const cat of TOP_CATEGORY_ORDER) {
          if (cat === "sequence") {
            if (scan.totalSequences === 0) continue;
            html += `<div class="org-cat">`;
            html += `<span class="org-cat-icon">${TOP_CAT_GLYPHS.sequence}</span>`;
            html += `<span class="org-cat-name">${TOP_CATEGORY_LABELS.sequence}</span>`;
            html += `<span class="org-cat-count">${scan.totalSequences}</span>`;
            html += `</div>`;
            for (const group of scan.sequenceGroups) {
              html += `<div class="org-group">`;
              html += `<span class="org-group-name">${escapeHtml$2(group.base)}</span>`;
              html += `<span class="org-group-count">${group.items.length}</span>`;
              html += `</div>`;
              html += renderItemList(group.items, true);
            }
            if (scan.standalonePrincipal.length > 0) {
              html += `<div class="org-group">`;
              html += `<span class="org-group-name">Principal</span>`;
              html += `<span class="org-group-count">${scan.standalonePrincipal.length}</span>`;
              html += `</div>`;
              html += renderItemList(scan.standalonePrincipal, true);
            }
            if (scan.standaloneNested.length > 0) {
              html += `<div class="org-group">`;
              html += `<span class="org-group-name">Nested</span>`;
              html += `<span class="org-group-count">${scan.standaloneNested.length}</span>`;
              html += `</div>`;
              html += renderItemList(scan.standaloneNested, true);
            }
          } else {
            const count = scan.counts[cat];
            if (count === 0) continue;
            const gl = TOP_CAT_GLYPHS[cat];
            const label = TOP_CATEGORY_LABELS[cat];
            html += `<div class="org-cat">`;
            html += `<span class="org-cat-icon">${gl}</span>`;
            html += `<span class="org-cat-name">${escapeHtml$2(label)}</span>`;
            html += `<span class="org-cat-count">${count}</span>`;
            html += `</div>`;
            const items = scan.items.filter((i) => i.category === cat);
            if (cat === "audio" && (scan.audioKindCounts.music > 0 || scan.audioKindCounts.sfx > 0)) {
              for (const kind of ["music", "sfx"]) {
                const group = items.filter((i) => i.audioKind === kind);
                if (group.length === 0) continue;
                html += `<div class="org-group">`;
                html += `<span class="org-group-name">${escapeHtml$2(AUDIO_KIND_LABELS[kind])}</span>`;
                html += `<span class="org-group-count">${group.length}</span>`;
                html += `</div>`;
                html += renderItemList(group, true);
              }
              const loose = items.filter((i) => i.audioKind === null);
              if (loose.length > 0) {
                html += renderItemList(loose);
              }
            } else {
              html += renderItemList(items);
            }
          }
        }
        treeEl.innerHTML = html;
      }
      function renderItemList(items, indented = false) {
        const indent = indented ? " org-items-indent" : "";
        let html = `<div class="org-items${indent}">`;
        for (const item of items) {
          html += `<div class="org-item" title="${escapeHtml$2(item.name)}">`;
          html += `<span class="org-item-name">${escapeHtml$2(item.name)}</span>`;
          html += `</div>`;
        }
        html += `</div>`;
        return html;
      }
      function renderStats() {
        if (!scan || !statsEl) return;
        const total = scan.items.length;
        const catStats = [];
        if (scan.totalSequences > 0) {
          catStats.push({ label: "Sequências", count: scan.totalSequences });
        }
        if (scan.counts.video > 0) catStats.push({ label: "Vídeos", count: scan.counts.video });
        if (scan.counts.audio > 0) catStats.push({ label: "Áudios", count: scan.counts.audio });
        if (scan.counts.image > 0) catStats.push({ label: "Imagens", count: scan.counts.image });
        if (scan.counts.graphics > 0) catStats.push({ label: "Gráficos", count: scan.counts.graphics });
        if (scan.counts.premiere > 0) catStats.push({ label: "Itens Premiere", count: scan.counts.premiere });
        if (scan.counts.other > 0) catStats.push({ label: "Outros", count: scan.counts.other });
        let html = '<div class="org-stat-row">';
        html += `<span class="org-stat-total">${total} itens</span>`;
        html += `<span class="org-stat-sep">·</span>`;
        html += catStats.map(
          (c) => `<span class="org-stat-cat">${c.label} <b>${c.count}</b></span>`
        ).join('<span class="org-stat-sep">·</span>');
        html += "</div>";
        if (scan.sequenceGroups.length > 0) {
          const groupCount = scan.sequenceGroups.length;
          html += `<div class="org-stat-note">${groupCount} ${groupCount === 1 ? "pasta de sequência por nome criada" : "pastas de sequências por nome criadas"}</div>`;
        }
        statsEl.innerHTML = html;
      }
    }
  };
  function emptyMarkup() {
    return `<div class="zones"><div class="zone"><div class="org-empty" data-empty><p class="org-empty-title">Organização do Projeto</p><p class="org-empty-desc">Escaneia apenas os arquivos e sequências soltos na raiz do projeto. Suas pastas pessoais e pastas de plugins (Animation Composer, etc.) são 100% preservadas e intocadas.</p></div><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Escanear Projeto</div></div><div class="org-tree" data-tree></div><div class="org-stats" data-stats></div></div></div>`;
  }
  function organizedMarkup(count) {
    return `<div class="org-done"><p class="org-done-title">Projeto Organizado ✓</p><p class="org-done-desc">${count} ${count === 1 ? "item foi movido" : "itens foram movidos"} para pastas organizadas. Suas pastas pré-existentes e pastas de plugins foram preservadas. Use "Desfazer" para reverter.</p></div>`;
  }
  function escapeHtml$2(value) {
    return value.replace(/[&<>"]/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  const RESULT_FILE = "dl-result.json";
  const PROGRESS_FILE = "dl-progress.txt";
  const LOG_FILE = "dl-log.txt";
  const FILES_FILE = "dl-files.txt";
  const CONFIG_FILE = "download-config.json";
  const SCRIPT_FILE = "download.command";
  const SCRIPT_FILE_WIN = "download.bat";
  const LOCAL_BIN = "yt-dlp";
  const LOCAL_BIN_WIN = "yt-dlp.exe";
  function infoFile(index) {
    return `dl-info-${index}.json`;
  }
  function scriptName() {
    return isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
  }
  const POLL_MS = 400;
  const PROBE_TIMEOUT_MS = 3 * 60 * 1e3;
  const DOWNLOAD_TIMEOUT_MS = 90 * 60 * 1e3;
  const INSTALL_TIMEOUT_MS = 5 * 60 * 1e3;
  const DEFAULT_CONFIG = {
    ytdlpPath: "",
    destination: "",
    quality: "best",
    cookies: "none",
    importToProject: true
  };
  async function readConfig() {
    try {
      const raw = readText(await workspace(), CONFIG_FILE);
      if (!raw) {
        return { ...DEFAULT_CONFIG };
      }
      const parsed = JSON.parse(raw);
      return {
        ytdlpPath: typeof parsed.ytdlpPath === "string" ? parsed.ytdlpPath : "",
        destination: typeof parsed.destination === "string" ? parsed.destination : "",
        quality: typeof parsed.quality === "string" ? parsed.quality : "best",
        cookies: isCookies(parsed.cookies) ? parsed.cookies : "none",
        importToProject: parsed.importToProject !== false
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
  function isCookies(value) {
    return value === "none" || value === "chrome" || value === "safari" || value === "firefox" || value === "edge" || value === "brave";
  }
  async function writeConfig(config) {
    try {
      await write(await workspace(), CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (cause) {
      console.error("[Download] não foi possível salvar a configuração:", cause);
    }
  }
  async function defaultDestination() {
    const home = uxpModule("os")?.homedir?.() ?? "";
    if (!home) {
      return (await workspace()).nativeBase;
    }
    return isWindows() ? join(home, "Videos", "Edit Toolbox") : join(home, "Movies", "Edit Toolbox");
  }
  const QUALITIES = [
    { id: "best", label: "Máxima", height: null, audioOnly: false },
    { id: "2160", label: "4K", height: 2160, audioOnly: false },
    { id: "1440", label: "1440p", height: 1440, audioOnly: false },
    { id: "1080", label: "1080p", height: 1080, audioOnly: false },
    { id: "720", label: "720p", height: 720, audioOnly: false },
    { id: "480", label: "480p", height: 480, audioOnly: false },
    { id: "audio", label: "MP3", height: null, audioOnly: true }
  ];
  function findQuality(id) {
    return QUALITIES.find((q2) => q2.id === id) ?? QUALITIES[0];
  }
  const NO_WATERMARK = "[format_note!*=?watermark][format_id!*=?watermark]";
  function formatSelector(quality) {
    if (quality.audioOnly) {
      return `ba${NO_WATERMARK}/ba/b${NO_WATERMARK}/b`;
    }
    if (quality.height === null) {
      return `bv*${NO_WATERMARK}+ba/b${NO_WATERMARK}/bv*+ba/b`;
    }
    const ceiling = quality.height * 2;
    const cap = `[width<=${ceiling}][height<=${ceiling}]`;
    return `bv*${NO_WATERMARK}${cap}+ba/b${NO_WATERMARK}${cap}/bv*${NO_WATERMARK}+ba/b${NO_WATERMARK}/b`;
  }
  function sortArg(quality) {
    if (quality.audioOnly) {
      return null;
    }
    return quality.height === null ? "res" : `res:${quality.height}`;
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function shortSide(format) {
    const width = num(format.width);
    const height = num(format.height);
    if (width !== null && width > 0 && height !== null && height > 0) {
      return Math.min(width, height);
    }
    return height !== null && height > 0 ? height : null;
  }
  function isWatermarked(format) {
    const haystack = `${text(format.format_id)} ${text(format.format_note)}`;
    return /water\s*mark|wm\b/i.test(haystack);
  }
  function parseProbe(url, raw) {
    const empty = {
      url,
      ok: false,
      error: null,
      title: url,
      id: "",
      site: "",
      uploader: null,
      durationSeconds: null,
      resolutions: [],
      sizeByResolution: {},
      hadWatermarked: false
    };
    let info;
    try {
      info = JSON.parse(raw);
    } catch {
      return { ...empty, error: "Resposta ilegível do yt-dlp." };
    }
    if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length > 0) {
      info = info.entries[0];
    }
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const duration = num(info.duration);
    const sizeByResolution = {};
    const resolutions = /* @__PURE__ */ new Set();
    let hadWatermarked = false;
    let bestAudioBytes = 0;
    for (const format of formats) {
      if (isWatermarked(format)) {
        hadWatermarked = true;
        continue;
      }
      const hasVideo = text(format.vcodec) !== "none" && text(format.vcodec) !== "";
      const bytes = estimateBytes(format, duration);
      if (!hasVideo) {
        if (bytes > bestAudioBytes) {
          bestAudioBytes = bytes;
        }
        continue;
      }
      const resolution = shortSide(format);
      if (resolution === null) {
        continue;
      }
      resolutions.add(resolution);
      if (bytes > (sizeByResolution[resolution] ?? 0)) {
        sizeByResolution[resolution] = bytes;
      }
    }
    for (const resolution of resolutions) {
      const size = sizeByResolution[resolution];
      if (size && !hasAudioAt(formats, resolution)) {
        sizeByResolution[resolution] = size + bestAudioBytes;
      }
    }
    return {
      url,
      ok: true,
      error: null,
      title: text(info.title) || url,
      id: text(info.id),
      site: text(info.extractor_key) || text(info.extractor),
      uploader: text(info.uploader) || text(info.channel) || null,
      durationSeconds: duration,
      resolutions: [...resolutions].sort((a, b) => b - a),
      sizeByResolution,
      hadWatermarked
    };
  }
  function hasAudioAt(formats, resolution) {
    return formats.some(
      (format) => shortSide(format) === resolution && text(format.acodec) !== "none" && text(format.acodec) !== "" && !isWatermarked(format)
    );
  }
  function estimateBytes(format, durationSeconds) {
    const exact = num(format.filesize) ?? num(format.filesize_approx);
    if (exact !== null && exact > 0) {
      return exact;
    }
    const tbr = num(format.tbr);
    if (tbr !== null && tbr > 0 && durationSeconds !== null && durationSeconds > 0) {
      return Math.round(tbr * 1e3 * durationSeconds / 8);
    }
    return 0;
  }
  function availableQualities(probes) {
    const ok = probes.filter((probe) => probe.ok);
    if (ok.length === 0) {
      return [...QUALITIES];
    }
    const tallest = Math.max(...ok.map((probe) => probe.resolutions[0] ?? 0));
    return QUALITIES.filter(
      (quality) => quality.height === null || quality.height <= tallest
    );
  }
  async function run(launch) {
    const shell = shellModule();
    if (!shell) {
      return fail("uxp-unavailable", null);
    }
    const space = await workspace();
    const scriptPath = nativePath(space, scriptName());
    for (const name of [RESULT_FILE, PROGRESS_FILE, LOG_FILE, FILES_FILE, ...launch.stale]) {
      await remove(space, name);
    }
    await write(space, scriptName(), launch.build(space), true);
    let launchError = null;
    try {
      await shell.openPath(scriptPath, launch.purpose);
    } catch (cause) {
      launchError = describe(cause);
      console.error("[Download] openPath recusou:", cause);
      launch.onManual?.(scriptPath, launchError);
    }
    const deadline = Date.now() + launch.timeoutMs;
    let lastSignature = "";
    while (Date.now() < deadline) {
      if (launch.cancelled?.()) {
        return { ...fail("cancelled", scriptPath) };
      }
      if (launch.onProgress) {
        const log = tail(space);
        const done = readProgress(space);
        const percent = readPercent(log);
        const signature = `${done}|${percent}|${log.length}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          launch.onProgress(done, launch.total, percent, log);
        }
      }
      const raw = readText(space, RESULT_FILE);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          return {
            ok: parsed.ok === true,
            error: parsed.ok === true ? null : parsed.error ?? "ytdlp-failed",
            ytdlpPath: typeof parsed.ytdlp === "string" ? parsed.ytdlp : null,
            scriptPath,
            failed: typeof parsed.failed === "number" ? parsed.failed : 0,
            log: tail(space)
          };
        } catch {
        }
      }
      await wait(POLL_MS);
    }
    return {
      ...fail(launchError ? `launch-denied: ${launchError}` : "timeout", scriptPath),
      log: tail(space)
    };
  }
  function fail(error, scriptPath) {
    return { ok: false, error, ytdlpPath: null, scriptPath, failed: 0, log: "" };
  }
  function readProgress(space) {
    const raw = readText(space, PROGRESS_FILE);
    const parsed = Number.parseInt(raw?.split("/")[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function tail(space, lines = 12) {
    const raw = readText(space, LOG_FILE);
    if (!raw) {
      return "";
    }
    return raw.split(/\r?\n/).slice(-lines).join("\n");
  }
  function readPercent(log) {
    const matches = log.match(/(\d{1,3}(?:\.\d)?)%/g);
    if (!matches || matches.length === 0) {
      return null;
    }
    const value = Number.parseFloat(matches[matches.length - 1]);
    return Number.isFinite(value) ? Math.min(100, value) : null;
  }
  function wait(ms) {
    return new Promise((resolve2) => setTimeout(resolve2, ms));
  }
  async function probeUrls(urls, config, onProgress, cancelled, onManual) {
    const stale = urls.map((_, index) => infoFile(index));
    const result = await run({
      build: (space2) => isWindows() ? probeScriptWin(urls, config, space2.nativeBase) : probeScriptUnix(urls, config, space2.nativeBase),
      timeoutMs: PROBE_TIMEOUT_MS,
      stale,
      onProgress,
      total: urls.length,
      cancelled,
      onManual,
      purpose: "Consultar os dados dos vídeos com o yt-dlp."
    });
    const space = await workspace();
    const probes = urls.map((url, index) => {
      const raw = readText(space, infoFile(index));
      if (!raw) {
        return {
          url,
          ok: false,
          error: "O yt-dlp não conseguiu ler este link.",
          title: url,
          id: "",
          site: "",
          uploader: null,
          durationSeconds: null,
          resolutions: [],
          sizeByResolution: {},
          hadWatermarked: false
        };
      }
      return parseProbe(url, raw);
    });
    return { result, probes };
  }
  async function downloadUrls(urls, quality, config, onProgress, cancelled, onManual) {
    const destination = config.destination || await defaultDestination();
    const result = await run({
      build: (space2) => isWindows() ? downloadScriptWin(urls, quality, config, space2.nativeBase, destination) : downloadScriptUnix(urls, quality, config, space2.nativeBase, destination),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      stale: [],
      onProgress,
      total: urls.length,
      cancelled,
      onManual,
      purpose: "Baixar os vídeos dos links informados com o yt-dlp."
    });
    const space = await workspace();
    const listed = readText(space, FILES_FILE);
    const files = listed ? listed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0) : [];
    return { ...result, files };
  }
  async function installYtdlp(onManual) {
    return run({
      build: (space) => isWindows() ? installScriptWin(space.nativeBase) : installScriptUnix(space.nativeBase),
      timeoutMs: INSTALL_TIMEOUT_MS,
      stale: [],
      total: 1,
      onManual,
      purpose: "Baixar o yt-dlp oficial para a pasta do plugin."
    });
  }
  async function openWorkFolder() {
    const shell = shellModule();
    if (!shell) {
      throw new Error("uxp.shell indisponível");
    }
    const space = await workspace();
    await shell.openPath(space.nativeBase, "Abrir a pasta do script de download.");
  }
  function q(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  function unixPreamble(folder, config) {
    return [
      "#!/bin/bash",
      "# Gerado pelo Edit Toolbox — Baixar Vídeos. Pode apagar.",
      `printf '\\033]0;Edit Toolbox — baixando\\007'`,
      "set -u",
      `WORK=${q(folder)}`,
      `CUSTOM=${q(config.ytdlpPath)}`,
      "YTDLP=''",
      // A ordem procura primeiro o que o editor escolheu, depois o
      // binário que o botão "Instalar" deixa aqui, e só então os lugares
      // do Homebrew, do MacPorts e do pip — que num shell não interativo
      // podem nem estar no PATH.
      'for candidate in "$CUSTOM" "$WORK/yt-dlp" /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp /opt/local/bin/yt-dlp "$HOME/.local/bin/yt-dlp"; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then YTDLP="$candidate"; break; fi',
      "done",
      'if [ -z "$YTDLP" ]; then YTDLP="$(command -v yt-dlp 2>/dev/null || true)"; fi',
      'if [ -z "$YTDLP" ]; then',
      `  printf '{"ok":false,"error":"ytdlp-not-found"}' > "$WORK/${RESULT_FILE}.tmp"`,
      `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      '  echo "yt-dlp nao encontrado. Use o botao Instalar no painel, ou brew install yt-dlp."',
      "  exit 1",
      "fi",
      'echo "yt-dlp: $YTDLP"'
    ];
  }
  function unixFfmpeg() {
    return [
      "FFMPEG=''",
      "for candidate in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg; do",
      '  if [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      "FFDIR=''",
      'if [ -n "$FFMPEG" ]; then FFDIR="$(dirname "$FFMPEG")"; fi'
    ];
  }
  const UNIX_CLOSE = [
    'echo "Pronto. Pode voltar ao Premiere."',
    // Fecha só a própria janela, achada pelo título posto no preâmbulo.
    // Se o macOS negar a automação, a janela fica aberta e nada quebra.
    `osascript -e 'tell application "Terminal" to close (every window whose name contains "Edit Toolbox")' >/dev/null 2>&1 &`,
    "exit 0"
  ];
  function probeScriptUnix(urls, config, folder) {
    const lines = unixPreamble(folder, config);
    lines.push("FAILED=0");
    urls.forEach((url, index) => {
      const target = `"$WORK/${infoFile(index)}"`;
      lines.push(
        `echo "[${index + 1}/${urls.length}] consultando…"`,
        `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
        `if "$YTDLP" --no-warnings --no-playlist --ignore-config ${cookiesArg(config)}-J ${q(url)} > ${target}.tmp 2>> "$WORK/${LOG_FILE}"; then`,
        `  mv ${target}.tmp ${target}`,
        "else",
        "  FAILED=$((FAILED+1))",
        `  rm -f ${target}.tmp`,
        "fi"
      );
    });
    lines.push(
      `printf '{"ok":true,"ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE}.tmp"`,
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      ...UNIX_CLOSE
    );
    return lines.join("\n") + "\n";
  }
  function downloadScriptUnix(urls, quality, config, folder, destination) {
    const lines = unixPreamble(folder, config);
    lines.push(...unixFfmpeg());
    lines.push(`DEST=${q(destination)}`, 'mkdir -p "$DEST"', "FAILED=0");
    const shared = `--newline --no-mtime --no-playlist --ignore-config --windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 -o ${q("%(title)s [%(id)s].%(ext)s")} --print-to-file after_move:filepath "$WORK/${FILES_FILE}" ` + cookiesArg(config);
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${q(formatSelector(quality))}` : (
      // mp4 porque o destino é uma timeline do Premiere, e um webm/vp9
      // entra lá para arrastar a reprodução.
      `-f ${q(formatSelector(quality))} ${sort ? `-S ${q(sort)} ` : ""}--merge-output-format mp4`
    );
    urls.forEach((url, index) => {
      lines.push(
        `echo "[${index + 1}/${urls.length}] ${escapeEcho(url)}"`,
        `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
        // `${FFDIR:+…}` some inteiro quando não há ffmpeg, em vez de
        // passar uma flag com valor vazio — que o yt-dlp recusa.
        `"$YTDLP" ${shared} ${media} -P "$DEST" \${FFDIR:+--ffmpeg-location "$FFDIR"} ${q(url)} 2>&1 | tee -a "$WORK/${LOG_FILE}"`,
        // `tee` sempre devolve 0; quem falhou foi o yt-dlp, e é o status
        // dele que o PIPESTATUS guarda.
        'if [ "${PIPESTATUS[0]}" -ne 0 ]; then FAILED=$((FAILED+1)); fi'
      );
    });
    lines.push(
      'if [ "$FAILED" -eq 0 ]; then',
      `  printf '{"ok":true,"ytdlp":"%s","failed":0}' "$YTDLP" > "$WORK/${RESULT_FILE}.tmp"`,
      "else",
      `  printf '{"ok":false,"error":"ytdlp-failed","ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      ...UNIX_CLOSE
    );
    return lines.join("\n") + "\n";
  }
  const RELEASE_MAC = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  const RELEASE_WIN = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  function installScriptUnix(folder) {
    return [
      "#!/bin/bash",
      "# Gerado pelo Edit Toolbox — Baixar Vídeos. Pode apagar.",
      `printf '\\033]0;Edit Toolbox — instalando yt-dlp\\007'`,
      "set -u",
      `WORK=${q(folder)}`,
      `echo "Baixando o yt-dlp oficial…"`,
      `if curl -fL --retry 3 -o "$WORK/${LOCAL_BIN}.tmp" ${q(RELEASE_MAC)} 2>&1 | tee -a "$WORK/${LOG_FILE}"; then`,
      `  chmod +x "$WORK/${LOCAL_BIN}.tmp"`,
      `  mv "$WORK/${LOCAL_BIN}.tmp" "$WORK/${LOCAL_BIN}"`,
      // O binário do macOS vem sem assinatura reconhecida pelo
      // Gatekeeper; sem tirar a quarentena, a primeira execução morre
      // num diálogo que o painel nunca veria.
      `  xattr -d com.apple.quarantine "$WORK/${LOCAL_BIN}" >/dev/null 2>&1 || true`,
      `  if "$WORK/${LOCAL_BIN}" --version >/dev/null 2>&1; then`,
      `    printf '{"ok":true,"ytdlp":"%s"}' "$WORK/${LOCAL_BIN}" > "$WORK/${RESULT_FILE}.tmp"`,
      "  else",
      `    printf '{"ok":false,"error":"install-unusable"}' > "$WORK/${RESULT_FILE}.tmp"`,
      "  fi",
      "else",
      `  rm -f "$WORK/${LOCAL_BIN}.tmp"`,
      `  printf '{"ok":false,"error":"install-failed"}' > "$WORK/${RESULT_FILE}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      ...UNIX_CLOSE
    ].join("\n") + "\n";
  }
  function cookiesArg(config) {
    return config.cookies === "none" ? "" : `--cookies-from-browser ${config.cookies} `;
  }
  function escapeEcho(value) {
    return value.replace(/["`$\\]/g, "").slice(0, 90);
  }
  function batValue(value) {
    return value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
  }
  function bq(value) {
    return `"${batValue(value)}"`;
  }
  function winPreamble(config, folder) {
    return [
      "@echo off",
      "rem Gerado pelo Edit Toolbox - Baixar Videos. Pode apagar.",
      "title Edit Toolbox - baixando",
      `set "WORK=${batValue(folder)}"`,
      `set "YTDLP=${batValue(config.ytdlpPath)}"`,
      `if "%YTDLP%"=="" if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
      `if "%YTDLP%"=="" for %%i in (yt-dlp.exe) do @set "YTDLP=%%~$PATH:i"`,
      'if "%YTDLP%"=="" (',
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ytdlp-not-found"}`,
      `  move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
      "  echo yt-dlp nao encontrado. Use o botao Instalar no painel.",
      "  exit /b 1",
      ")",
      "set FAILED=0"
    ];
  }
  function probeScriptWin(urls, config, folder) {
    const lines = winPreamble(config, folder);
    urls.forEach((url, index) => {
      const target = `"%WORK%\\${infoFile(index)}"`;
      lines.push(
        `echo [${index + 1}/${urls.length}] consultando...`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
        `"%YTDLP%" --no-warnings --no-playlist --ignore-config ${cookiesArg(config)}-J ${bq(url)} > ${target} 2>>"%WORK%\\${LOG_FILE}"`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      `>"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":%FAILED%}`,
      `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function downloadScriptWin(urls, quality, config, folder, destination) {
    const lines = winPreamble(config, folder);
    lines.push(
      `set "DEST=${batValue(destination)}"`,
      'if not exist "%DEST%" mkdir "%DEST%"'
    );
    const shared = `--newline --no-mtime --no-playlist --ignore-config --windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 -o ${bq("%(title)s [%(id)s].%(ext)s")} --print-to-file after_move:filepath "%WORK%\\${FILES_FILE}" ` + cookiesArg(config);
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${bq(formatSelector(quality))}` : `-f ${bq(formatSelector(quality))} ${sort ? `-S ${bq(sort)} ` : ""}--merge-output-format mp4`;
    urls.forEach((url, index) => {
      lines.push(
        `echo [${index + 1}/${urls.length}]`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
        `"%YTDLP%" ${shared} ${media} -P "%DEST%" ${bq(url)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      'if "%FAILED%"=="0" (',
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":0}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ytdlp-failed","failed":%FAILED%}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function installScriptWin(folder) {
    return [
      "@echo off",
      "rem Gerado pelo Edit Toolbox - Baixar Videos. Pode apagar.",
      "title Edit Toolbox - instalando yt-dlp",
      `set "WORK=${batValue(folder)}"`,
      "echo Baixando o yt-dlp oficial...",
      `powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${RELEASE_WIN}' -OutFile ('%WORK%\\${LOCAL_BIN_WIN}') -UseBasicParsing } catch { exit 1 }"`,
      "if errorlevel 1 (",
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"install-failed"}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%WORK%\\${LOCAL_BIN_WIN}"}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
      "exit /b 0"
    ].join("\r\n") + "\r\n";
  }
  function describeRunError(code, log) {
    if (!code) {
      return "Falha desconhecida no download.";
    }
    if (code.startsWith("launch-denied")) {
      const raw = code.slice("launch-denied:".length).trim();
      return "O sistema não executou o script" + (raw ? ` (${raw})` : "") + '. Use "Abrir pasta" e dê um duplo clique no script — o painel continua esperando o resultado.';
    }
    switch (code) {
      case "ytdlp-not-found":
        return 'yt-dlp não encontrado. Use o botão "Instalar yt-dlp" nos ajustes avançados, ou instale com "brew install yt-dlp".';
      case "ytdlp-failed":
        return diagnoseLog(log);
      case "install-failed":
        return "Não foi possível baixar o yt-dlp. Verifique a conexão e tente de novo.";
      case "install-unusable":
        return 'O yt-dlp baixou mas não executou. No macOS isso costuma ser o Gatekeeper: abra a pasta e autorize o binário, ou use "brew install yt-dlp".';
      case "timeout":
        return "O download passou do tempo limite e foi abandonado.";
      case "cancelled":
        return "Download cancelado.";
      case "uxp-unavailable":
        return "Este build do Premiere não expõe shell/fs do UXP.";
      default:
        return `Falha: ${code}`;
    }
  }
  function diagnoseLog(log) {
    if (/sign in to confirm|not a bot|cookies/i.test(log)) {
      return "O site pediu login. Nos ajustes avançados, escolha o navegador onde você já está logado para o yt-dlp usar os cookies dele.";
    }
    if (/private video|video unavailable|removed by the uploader/i.test(log)) {
      return "O vídeo é privado ou foi removido.";
    }
    if (/age.?restrict/i.test(log)) {
      return "Vídeo com restrição de idade — use os cookies do navegador nos ajustes avançados.";
    }
    if (/ffmpeg is not installed|ffmpeg not found/i.test(log)) {
      return 'Falta o ffmpeg para juntar vídeo e áudio nesta qualidade. Instale com "brew install ffmpeg" ou escolha 1080p ou menos.';
    }
    if (/unsupported url/i.test(log)) {
      return "O yt-dlp não reconhece esse link.";
    }
    if (/urlopen error|network|timed out|connection/i.test(log)) {
      return "Falha de rede durante o download.";
    }
    return "O yt-dlp não concluiu. Veja o log abaixo.";
  }
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) {
      return "";
    }
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
  function formatClock(seconds) {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      return "";
    }
    const whole = Math.round(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole % 3600 / 60);
    const secs = whole % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }
  function mountDropdown(host, source) {
    host.className = "dl-pick-wrap";
    host.innerHTML = `<div class="dl-pick" ${CONTROL} data-pick-button aria-expanded="false"><span class="dl-pick-value" data-pick-value></span><span class="dl-pick-meta" data-pick-meta></span><span class="dl-pick-caret" aria-hidden="true">▾</span></div><div class="dl-menu" data-pick-menu hidden></div>`;
    const button = host.querySelector("[data-pick-button]");
    const valueEl = host.querySelector("[data-pick-value]");
    const metaEl = host.querySelector("[data-pick-meta]");
    const menu = host.querySelector("[data-pick-menu]");
    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    }
    function render() {
      const options = source.options();
      const selected = source.selected();
      const current = options.find((option) => option.id === selected);
      valueEl.textContent = current?.label ?? "—";
      metaEl.textContent = current?.meta ?? "";
      menu.innerHTML = options.map(
        (option) => `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml$1(option.id)}" aria-pressed="${option.id === selected}"><span class="dl-menu-name">${escapeHtml$1(option.label)}</span><span class="dl-menu-meta">${escapeHtml$1(option.meta ?? "")}</span></div>`
      ).join("");
    }
    button.addEventListener("click", () => setOpen(menu.hidden));
    menu.addEventListener("click", (event) => {
      const item = event.target?.closest("[data-value]");
      const id = item?.dataset.value;
      if (!id) return;
      setOpen(false);
      source.onPick(id);
    });
    render();
    return {
      render,
      closeUnless(target) {
        if (!menu.hidden && !host.contains(target)) {
          setOpen(false);
        }
      }
    };
  }
  function parseUrls(raw) {
    return raw.split(/[\s,]+/).map((line) => line.trim()).filter((line) => /^https?:\/\/\S+$/i.test(line));
  }
  function countLines(raw) {
    return raw.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0).length;
  }
  const COOKIE_LABELS = {
    none: "Nenhum",
    chrome: "Chrome",
    safari: "Safari",
    firefox: "Firefox",
    edge: "Edge",
    brave: "Brave"
  };
  let releaseDocument = null;
  const downloadTool = {
    id: "download",
    name: "Baixar Vídeos",
    summary: "Download de YouTube e TikTok",
    hint: "Cole um ou mais links do YouTube ou do TikTok. O TikTok vem sempre sem marca d'água, e o arquivo pode entrar direto no projeto aberto.",
    category: "midia",
    glyph: "download",
    available: true,
    usesSelection: false,
    mount(container, context) {
      let config = {
        ytdlpPath: "",
        destination: "",
        quality: "1080",
        cookies: "none",
        importToProject: true
      };
      let probes = [];
      let busy = false;
      let cancelled = false;
      container.innerHTML = markup();
      const urlsEl = container.querySelector("[data-urls]");
      const scanEl = container.querySelector("[data-scan]");
      const listEl = container.querySelector("[data-list]");
      const qualityHostEl = container.querySelector("[data-quality-pick]");
      const cookiesHostEl = container.querySelector("[data-cookies-pick]");
      const destEl = container.querySelector("[data-dest]");
      const pickEl = container.querySelector("[data-pick]");
      const importSegEl = container.querySelector("[data-import-seg]");
      const pathEl = container.querySelector("[data-ytdlp-path]");
      const installEl = container.querySelector("[data-install]");
      const folderEl = container.querySelector("[data-open-folder]");
      const advToggleEl = container.querySelector("[data-adv-toggle]");
      const advContentEl = container.querySelector("[data-adv-content]");
      const advIconEl = container.querySelector("[data-adv-icon]");
      const manualEl = container.querySelector("[data-manual]");
      const progressEl = container.querySelector("[data-progress]");
      const logEl = container.querySelector("[data-log]");
      const dropdowns = [];
      const qualityPick = qualityHostEl ? mountDropdown(qualityHostEl, {
        options: () => availableQualities(probes).map((quality) => ({
          id: quality.id,
          label: quality.label,
          meta: qualityMeta(quality, probes)
        })),
        selected: () => config.quality,
        onPick: (id) => {
          config.quality = id;
          persist();
          renderQualities();
          renderList();
        }
      }) : null;
      if (qualityPick) dropdowns.push(qualityPick);
      const cookiesPick = cookiesHostEl ? mountDropdown(cookiesHostEl, {
        options: () => Object.keys(COOKIE_LABELS).map((key) => ({
          id: key,
          label: COOKIE_LABELS[key]
        })),
        selected: () => config.cookies,
        onPick: (id) => {
          config.cookies = id;
          persist();
          cookiesPick?.render();
        }
      }) : null;
      if (cookiesPick) dropdowns.push(cookiesPick);
      function closeMenus(target) {
        for (const dropdown of dropdowns) {
          dropdown.closeUnless(target);
        }
      }
      const onDocumentPointer = (event) => {
        closeMenus(event.target);
      };
      const onDocumentKey = (event) => {
        if (event.key === "Escape") {
          closeMenus(null);
        }
      };
      document.addEventListener("click", onDocumentPointer, true);
      document.addEventListener("keydown", onDocumentKey, true);
      releaseDocument = () => {
        document.removeEventListener("click", onDocumentPointer, true);
        document.removeEventListener("keydown", onDocumentKey, true);
      };
      context.setApplyLabel("BAIXAR");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      void (async () => {
        config = await readConfig();
        if (!config.destination) {
          config.destination = await defaultDestination().catch(() => "");
        }
        if (pathEl) pathEl.value = config.ytdlpPath;
        renderDestination();
        renderQualities();
        cookiesPick?.render();
        renderSegs();
        syncApply();
      })();
      function persist() {
        void writeConfig(config);
      }
      function urls() {
        return parseUrls(urlsEl?.value ?? "");
      }
      function syncApply() {
        const list = urls();
        context.setApplyEnabled(!busy && list.length > 0);
        if (scanEl) {
          setDisabled(scanEl, busy || list.length === 0);
        }
        if (list.length === 0) {
          const typed = countLines(urlsEl?.value ?? "");
          context.setStatus(
            typed > 0 ? "Nenhuma linha parece um link (http/https)." : "",
            typed > 0 ? "error" : "idle"
          );
        }
      }
      urlsEl?.addEventListener("input", () => {
        if (probes.length > 0) {
          probes = [];
          renderList();
          renderQualities();
        }
        syncApply();
      });
      scanEl?.addEventListener("click", () => void runProbe());
      async function runProbe() {
        const list = urls();
        if (busy || list.length === 0) {
          return;
        }
        startBusy("Consultando os links…");
        if (scanEl) scanEl.textContent = "Consultando…";
        try {
          const { result, probes: found } = await probeUrls(
            list,
            config,
            (done, total, _percent, log) => {
              showProgress(`${done}/${total}`, null);
              showLog(log);
            },
            () => cancelled,
            showManual
          );
          probes = found;
          renderList();
          renderQualities();
          showLog(result.log);
          const ok = probes.filter((probe) => probe.ok).length;
          if (ok === 0) {
            context.setStatus(describeRunError(result.error ?? "ytdlp-failed", result.log), "error");
          } else if (ok < probes.length) {
            context.setStatus(`${ok} de ${probes.length} links lidos.`, "error");
          } else {
            context.setStatus(
              `${ok} ${ok === 1 ? "vídeo pronto" : "vídeos prontos"} para baixar.`,
              "done"
            );
          }
          if (result.ytdlpPath && !config.ytdlpPath) {
            rememberFoundBinary(result.ytdlpPath);
          }
        } catch (cause) {
          context.setStatus(describeError(cause), "error");
        } finally {
          if (scanEl) scanEl.textContent = "Analisar links";
          endBusy();
        }
      }
      function rememberFoundBinary(path) {
        config.ytdlpPath = path;
        if (pathEl) pathEl.value = path;
        persist();
      }
      context.setApplyHandler(async () => {
        const list = urls();
        if (busy || list.length === 0) {
          return;
        }
        const quality = findQuality(config.quality);
        startBusy(`Baixando em ${quality.label}…`);
        try {
          const outcome = await downloadUrls(
            list,
            quality,
            config,
            (done, total, percent, log) => {
              showProgress(`${done || 1}/${total}`, percent);
              showLog(log);
            },
            () => cancelled,
            showManual
          );
          showLog(outcome.log);
          showProgress(null, null);
          if (!outcome.ok && outcome.files.length === 0) {
            context.setStatus(describeRunError(outcome.error, outcome.log), "error");
            return;
          }
          const imported = config.importToProject ? await importFiles(outcome.files) : null;
          const count = outcome.files.length;
          const head = `${count} ${count === 1 ? "arquivo baixado" : "arquivos baixados"}` + (outcome.failed > 0 ? ` · ${outcome.failed} falharam` : "");
          context.setStatus(
            imported === null ? head : `${head} · ${imported}`,
            outcome.failed > 0 ? "error" : "done"
          );
          renderFiles(outcome.files);
          context.setResetHandler(() => clearAll());
        } catch (cause) {
          context.setStatus(describeError(cause), "error");
        } finally {
          endBusy();
        }
      });
      async function importFiles(files) {
        if (files.length === 0) {
          return "nada para importar";
        }
        const ppro = getPremiere();
        if (!ppro) {
          return "Premiere indisponível para importar";
        }
        try {
          const project2 = await ppro.Project.getActiveProject();
          if (!project2) {
            return "nenhum projeto aberto para importar";
          }
          const ok = await project2.importFiles([...files], true);
          return ok ? "importado para o projeto" : "o Premiere recusou a importação";
        } catch (cause) {
          console.error("[Download] importFiles falhou:", cause);
          return `falha ao importar: ${describeError(cause)}`;
        }
      }
      function clearAll() {
        probes = [];
        if (urlsEl) urlsEl.value = "";
        renderList();
        renderQualities();
        showLog("");
        showProgress(null, null);
        context.setResetHandler(null);
        context.setStatus("", "idle");
        syncApply();
      }
      function startBusy(message) {
        busy = true;
        cancelled = false;
        hideManual();
        context.setStatus(message);
        context.setApplyEnabled(false);
        if (scanEl) setDisabled(scanEl, true);
        if (installEl) setDisabled(installEl, true);
      }
      function endBusy() {
        busy = false;
        if (installEl) setDisabled(installEl, false);
        syncApply();
      }
      function renderQualities() {
        const offered = availableQualities(probes);
        if (!offered.some((quality) => quality.id === config.quality)) {
          config.quality = offered[0]?.id ?? "best";
        }
        qualityPick?.render();
      }
      function renderList() {
        if (!listEl) return;
        if (probes.length === 0) {
          listEl.innerHTML = "";
          return;
        }
        listEl.innerHTML = probes.map((probe) => probeRow(probe, config.quality)).join("");
      }
      function renderFiles(files) {
        if (!listEl || files.length === 0) return;
        listEl.innerHTML = '<p class="dl-done-title">Baixado ✓</p>' + files.map(
          (file) => `<div class="dl-file" title="${escapeHtml$1(file)}"><span class="dl-file-name">${escapeHtml$1(baseName(file))}</span></div>`
        ).join("");
      }
      function renderDestination() {
        if (destEl) {
          destEl.textContent = config.destination || "(pasta padrão)";
          destEl.title = config.destination;
        }
      }
      pickEl?.addEventListener("click", () => void pickFolder());
      async function pickFolder() {
        const picker = uxpModule("uxp")?.storage?.localFileSystem;
        if (typeof picker?.getFolder !== "function") {
          context.setStatus("Este build do Premiere não abre o seletor de pastas.", "error");
          return;
        }
        try {
          const folder = await picker.getFolder();
          if (!folder?.nativePath) {
            return;
          }
          config.destination = folder.nativePath;
          persist();
          renderDestination();
        } catch (cause) {
          console.log("[Download] seleção de pasta encerrada:", cause);
        }
      }
      advToggleEl?.addEventListener("click", () => {
        if (!advContentEl) return;
        const open = advContentEl.hidden;
        advContentEl.hidden = !open;
        if (advIconEl) advIconEl.textContent = open ? "▴" : "▾";
      });
      pathEl?.addEventListener("change", () => {
        config.ytdlpPath = pathEl.value.trim();
        persist();
      });
      installEl?.addEventListener("click", () => void runInstall());
      async function runInstall() {
        if (busy) return;
        startBusy("Baixando o yt-dlp…");
        if (installEl) installEl.textContent = "Baixando…";
        try {
          const result = await installYtdlp(showManual);
          showLog(result.log);
          if (result.ok && result.ytdlpPath) {
            rememberFoundBinary(result.ytdlpPath);
            context.setStatus("yt-dlp instalado na pasta do plugin.", "done");
          } else {
            context.setStatus(describeRunError(result.error, result.log), "error");
          }
        } catch (cause) {
          context.setStatus(describeError(cause), "error");
        } finally {
          if (installEl) installEl.textContent = "Instalar yt-dlp";
          endBusy();
        }
      }
      folderEl?.addEventListener("click", () => {
        void openWorkFolder().catch((cause) => {
          context.setStatus(describeError(cause), "error");
        });
      });
      function renderSegs() {
        for (const item of importSegEl?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.dataset.import === "on" === config.importToProject)
          );
        }
      }
      importSegEl?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-import]");
        if (!item) return;
        config.importToProject = item.dataset.import === "on";
        persist();
        renderSegs();
      });
      function showProgress(step2, percent) {
        if (!progressEl) return;
        if (step2 === null) {
          progressEl.hidden = true;
          progressEl.innerHTML = "";
          return;
        }
        progressEl.hidden = false;
        const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
        progressEl.innerHTML = `<div class="dl-bar"><span class="dl-bar-fill" style="width:${width.toFixed(1)}%"></span></div><div class="dl-bar-legend"><span>${escapeHtml$1(step2)}</span><span>${percent === null ? "…" : `${width.toFixed(0)}%`}</span></div>`;
      }
      function showLog(text2) {
        if (!logEl) return;
        const trimmed = text2.trim();
        logEl.hidden = trimmed.length === 0;
        logEl.textContent = trimmed;
      }
      function showManual(scriptPath, reason) {
        if (!manualEl) return;
        manualEl.hidden = false;
        manualEl.innerHTML = `<p class="sil-manual-why">O sistema não executou o script (${escapeHtml$1(reason)}). Dê um duplo clique nele e volte — o painel continua esperando.</p><p class="sil-manual-path">${escapeHtml$1(scriptPath)}</p>`;
      }
      function hideManual() {
        if (manualEl) {
          manualEl.hidden = true;
          manualEl.innerHTML = "";
        }
      }
      context.setRefreshHandler(null);
    },
    unmount() {
      releaseDocument?.();
      releaseDocument = null;
    }
  };
  function qualityMeta(quality, probes) {
    const ok = probes.filter((probe) => probe.ok);
    if (ok.length === 0) {
      return "";
    }
    if (quality.audioOnly) {
      return "só o áudio";
    }
    const size = formatBytes(
      ok.reduce((sum2, probe) => sum2 + estimateFor(probe, quality), 0)
    );
    const delivered = new Set(ok.map((probe) => effectiveResolution(probe, quality)));
    const single = delivered.size === 1 ? [...delivered][0] : null;
    const shown = single !== null && single !== quality.height ? `${single}p` : "";
    return [shown, size].filter((part) => part.length > 0).join(" · ");
  }
  function estimateFor(probe, quality) {
    const chosen = effectiveResolution(probe, quality);
    return chosen === null ? 0 : probe.sizeByResolution[chosen] ?? 0;
  }
  function effectiveResolution(probe, quality) {
    const list = probe.resolutions;
    if (list.length === 0) {
      return null;
    }
    return quality.height === null ? list[0] : list.find((value) => value <= quality.height) ?? list[list.length - 1];
  }
  function probeRow(probe, qualityId) {
    if (!probe.ok) {
      return `<div class="dl-row is-bad"><span class="dl-row-name">${escapeHtml$1(shorten(probe.url))}</span><span class="dl-row-meta">${escapeHtml$1(probe.error ?? "não foi possível ler")}</span></div>`;
    }
    const quality = findQuality(qualityId);
    const size = formatBytes(estimateFor(probe, quality));
    const clock = formatClock(probe.durationSeconds);
    const top = probe.resolutions[0] ? `${probe.resolutions[0]}p` : "";
    const meta = [probe.site, clock, top, size].filter((part) => part.length > 0).join(" · ");
    return `<div class="dl-row"><span class="dl-row-name" title="${escapeHtml$1(probe.title)}">${escapeHtml$1(
      probe.title
    )}</span><span class="dl-row-meta">${escapeHtml$1(meta)}</span>` + (probe.hadWatermarked ? `<span class="dl-row-tag">sem marca d'água</span>` : "") + "</div>";
  }
  function shorten(value) {
    return value.length > 64 ? `${value.slice(0, 61)}…` : value;
  }
  function baseName(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }
  function markup() {
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Links</span></div><textarea class="dl-urls" data-urls spellcheck="false" rows="3" placeholder="Cole os links do YouTube ou do TikTok — um por linha"></textarea><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar links</div></div><div class="sil-manual" data-manual hidden></div><div class="dl-list" data-list></div><div class="dl-progress" data-progress hidden></div></div></div><div class="zone"><div class="field"><span class="t-label">Qualidade</span><div data-quality-pick></div></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Destino</span><span class="field-action" ${CONTROL} data-pick>Escolher…</span></div><p class="dl-dest" data-dest></p></div><div class="field"><span class="t-label">Importar para o projeto</span><div class="seg" data-import-seg><div class="seg-item" ${CONTROL} data-import="on">Sim</div><div class="seg-item" ${CONTROL} data-import="off">Não</div></div></div></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">⚙️ Ajustes Avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><span class="t-label">Cookies do navegador</span><div data-cookies-pick></div><p class="field-note">Para vídeo com restrição de idade ou quando o site pede login. Use o navegador onde você já está logado.</p></div><div class="field"><div class="field-head"><span class="t-label">Caminho do yt-dlp</span><span class="field-action" ${CONTROL} data-open-folder>Abrir pasta</span></div><div class="sil-ffmpeg-group"><input type="text" class="sil-path" data-ytdlp-path spellcheck="false" placeholder="deixe vazio para procurar sozinho"><div class="org-scan" ${CONTROL} data-install>Instalar yt-dlp</div></div><p class="field-note">Instalar baixa o binário oficial para a pasta do plugin — não precisa de Homebrew nem de Python. Para 1440p e 4K também é preciso ter o ffmpeg, que é quem junta vídeo e áudio.</p></div><pre class="dl-log" data-log hidden></pre></div></div></div>`;
  }
  function escapeHtml$1(value) {
    return value.replace(/[&<>"]/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  const categories = [
    { id: "edicao", name: "Edição" },
    { id: "midia", name: "Mídia" },
    { id: "projeto", name: "Projeto" }
  ];
  const tools = [
    zoomTool,
    silenceTool,
    flowTool,
    downloadTool,
    organizeTool
  ];
  function toolsIn(categoryId) {
    return tools.filter((tool) => tool.category === categoryId);
  }
  function findTool(toolId) {
    return tools.find((tool) => tool.id === toolId);
  }
  function searchTools(query) {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return [];
    }
    return tools.filter(
      (tool) => tool.name.toLowerCase().includes(needle) || tool.summary.toLowerCase().includes(needle)
    );
  }
  const PATHS = {
    zoom: '<circle cx="6.2" cy="6.2" r="3.8"/><path d="M9.2 9.2 12 12"/><path d="M4.7 6.2h3M6.2 4.7v3"/>',
    curve: '<path d="M2 11c3.4 0 3.4-8 5-8s2.6 4.5 5 4.5"/>',
    cut: '<path d="M2 7h10"/><path d="M4.5 3v8M9.5 3v8"/>',
    frame: '<rect x="2" y="3.5" width="10" height="7"/><rect x="4.6" y="5.6" width="4.8" height="2.8"/>',
    wave: '<path d="M2 7h1.6M4.4 4.4v5.2M6.4 2.6v8.8M8.4 5v4M10.4 6.2v1.6M12 7h.4"/>',
    meter: '<path d="M2.4 10.6h9.2"/><path d="M3.8 10.6V7.4M6.2 10.6V4.6M8.6 10.6V6M11 10.6V8.2"/>',
    caption: '<rect x="2" y="3.6" width="10" height="6.8"/><path d="M4.2 6.4h3.2M4.2 8.2h5.6"/>',
    folder: '<path d="M2 4.2h3.6l1 1.4H12v5.2H2z"/>',
    text: '<path d="M2.6 3.6h8.8M7 3.6v7.2M4.8 10.8h4.4"/>',
    download: '<path d="M7 2.4v6.4"/><path d="M4.2 6.2 7 9l2.8-2.8"/><path d="M2.6 11.4h8.8"/>'
  };
  function glyph(name) {
    const path = PATHS[name] ?? PATHS.frame;
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="square">' + path + "</svg>";
  }
  const GITHUB_REPO = "SidyFurtado/framelab";
  const VERSION_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json`;
  class PluginUpdater {
    constructor(currentVersion) {
      this.latestManifest = null;
      this.checking = false;
      this.currentVersion = currentVersion;
    }
    /**
     * Checks GitHub repository for the latest version.json
     */
    async checkForUpdates() {
      if (this.checking) {
        return {
          hasUpdate: false,
          currentVersion: this.currentVersion,
          latestVersion: this.latestManifest?.version ?? this.currentVersion,
          manifest: this.latestManifest
        };
      }
      this.checking = true;
      try {
        const url = `${VERSION_MANIFEST_URL}?_t=${Date.now()}`;
        const response = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: "application/json"
          }
        });
        if (!response.ok) {
          throw new Error(`Servidor respondeu com status ${response.status}`);
        }
        const data = await response.json();
        this.latestManifest = data;
        const hasUpdate = isNewerVersion(data.version, this.currentVersion);
        return {
          hasUpdate,
          currentVersion: this.currentVersion,
          latestVersion: data.version,
          manifest: data
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.warn("[Updater] Erro ao verificar atualizações:", message);
        return {
          hasUpdate: false,
          currentVersion: this.currentVersion,
          latestVersion: this.currentVersion,
          manifest: null,
          error: message
        };
      } finally {
        this.checking = false;
      }
    }
    /**
     * Applies the update directly into the plugin folder (in-place)
     */
    async applyUpdate(onProgress) {
      if (!this.latestManifest) {
        const check = await this.checkForUpdates();
        if (!check.hasUpdate || !check.manifest) {
          return {
            success: false,
            requiresReload: false,
            message: "Nenhuma atualização disponível no momento."
          };
        }
      }
      const manifest = this.latestManifest;
      onProgress?.("Conectando ao GitHub...", 15);
      try {
        const uxp = getUxpModule();
        if (!uxp?.storage?.localFileSystem) {
          throw new Error("Sistema de arquivos UXP indisponível.");
        }
        const fs = uxp.storage.localFileSystem;
        const pluginFolder = await fs.getPluginFolder();
        const filesToUpdate = manifest.bundleFiles ?? {
          "manifest.json": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/manifest.json`,
          "index.html": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.html`,
          "index.js": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.js`,
          "index.css": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.css`
        };
        const fileEntries = Object.entries(filesToUpdate);
        const totalFiles = fileEntries.length;
        let completed = 0;
        for (const [filename, fileUrl] of fileEntries) {
          onProgress?.(
            `Baixando ${filename}...`,
            20 + Math.round(completed / totalFiles * 60)
          );
          const fileResponse = await fetch(`${fileUrl}?_t=${Date.now()}`, {
            cache: "no-store"
          });
          if (!fileResponse.ok) {
            throw new Error(
              `Falha ao baixar ${filename} (${fileResponse.status})`
            );
          }
          const fileData = await fileResponse.text();
          onProgress?.(
            `Gravando ${filename}...`,
            20 + Math.round((completed + 0.5) / totalFiles * 60)
          );
          const targetFile = await pluginFolder.createFile(filename, {
            overwrite: true
          });
          await targetFile.write(fileData);
          completed += 1;
        }
        onProgress?.("Atualização concluída!", 100);
        return {
          success: true,
          requiresReload: true,
          message: `Framelab v${manifest.version} instalado com sucesso!`
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error("[Updater] Falha na atualização in-place:", message);
        return {
          success: false,
          requiresReload: false,
          message: `Não foi possível atualizar automaticamente: ${message}. Clique para baixar o instalador mais recente pelo GitHub.`
        };
      }
    }
    /**
     * Opens the download link in default browser
     */
    openDownloadPage() {
      const url = this.latestManifest?.downloadUrl ?? `https://github.com/${GITHUB_REPO}/releases/latest`;
      try {
        const uxp = getUxpModule();
        if (uxp?.shell?.openExternal) {
          uxp.shell.openExternal(url);
          return;
        }
      } catch {
      }
      if (typeof window !== "undefined") {
        window.open(url, "_blank");
      }
    }
    /**
     * Reloads the plugin panel view
     */
    reloadPlugin() {
      if (typeof window !== "undefined" && window.location) {
        window.location.reload();
      }
    }
  }
  function getUxpModule() {
    try {
      if (typeof require === "function") {
        return require("uxp");
      }
    } catch {
    }
    return null;
  }
  function isNewerVersion(candidate, current) {
    const parse = (v) => v.replace(/^v/, "").split("-")[0].split(".").map((part) => parseInt(part, 10) || 0);
    const [cMajor = 0, cMinor = 0, cPatch = 0] = parse(candidate);
    const [curMajor = 0, curMinor = 0, curPatch = 0] = parse(current);
    if (cMajor > curMajor) return true;
    if (cMajor < curMajor) return false;
    if (cMinor > curMinor) return true;
    if (cMinor < curMinor) return false;
    return cPatch > curPatch;
  }
  const PRODUCT_NAME = "Framelab";
  const PRODUCT_TAGLINE = "Premiere";
  const VERSION = "0.1.0";
  class ProductShell {
    constructor(root) {
      this.updateBadgeEl = null;
      this.updateModalEl = null;
      this.latestManifest = null;
      this.applyHandler = null;
      this.applyStateOwned = false;
      this.resetHandler = null;
      this.refreshHandler = null;
      this.activeToolId = null;
      this.toolGeneration = 0;
      this.refreshTimer = null;
      this.refreshInFlight = false;
      this.refreshQueued = false;
      this.collapsed = /* @__PURE__ */ new Set();
      this.query = "";
      this.selection = null;
      this.hostGaps = false;
      this.updater = new PluginUpdater(VERSION);
      this.root = root;
      this.root.innerHTML = "";
      this.root.className = "shell";
      const topbar = document.createElement("header");
      topbar.className = "topbar";
      topbar.innerHTML = '<div class="brand"><span class="brand-mark">' + brandMark() + `</span><span class="brand-name"><b>${escapeHtml(PRODUCT_NAME)}</b><span>${escapeHtml(PRODUCT_TAGLINE)}</span></span></div><label class="search">` + searchGlyph() + `<input type="text" placeholder="Buscar ferramenta…" aria-label="Buscar ferramenta" spellcheck="false"></label><span class="version">v${VERSION}</span>`;
      this.topbarEl = topbar;
      this.searchInput = topbar.querySelector("input");
      this.searchInput.addEventListener("input", () => {
        this.query = this.searchInput.value;
        this.renderNav();
      });
      this.navEl = document.createElement("nav");
      this.navEl.className = "nav";
      this.navScroll = document.createElement("div");
      this.navScroll.className = "nav-scroll";
      const empty = document.createElement("p");
      empty.className = "nav-empty";
      empty.textContent = "Nenhuma ferramenta encontrada.";
      this.navEl.append(this.navScroll, empty);
      const work = document.createElement("div");
      work.className = "work";
      const header = document.createElement("div");
      header.className = "work-head";
      this.titleEl = document.createElement("span");
      this.titleEl.className = "work-title";
      this.chipEl = document.createElement("span");
      this.chipEl.className = "work-chip";
      const refresh = createControl("work-refresh");
      refresh.title = "Reler a seleção da timeline";
      refresh.setAttribute("aria-label", "Reler a seleção da timeline");
      refresh.innerHTML = refreshGlyph();
      refresh.addEventListener("click", () => void this.refreshSelection());
      header.append(this.titleEl, this.chipEl, refresh);
      this.stateEl = document.createElement("div");
      this.stateEl.className = "work-state";
      this.calloutEl = document.createElement("p");
      this.calloutEl.className = "callout";
      this.stripEl = document.createElement("div");
      this.stripEl.className = "strip";
      this.bodyEl = document.createElement("div");
      this.bodyEl.className = "work-body";
      const actions = document.createElement("div");
      actions.className = "actions";
      this.resetButton = createControl("btn-reset", "Limpar");
      this.resetButton.hidden = true;
      this.resetButton.addEventListener("click", () => this.resetHandler?.());
      this.applyButton = createControl("btn-apply");
      setDisabled(this.applyButton, true);
      this.applyButton.addEventListener("click", () => void this.runApply());
      actions.append(this.resetButton, this.applyButton);
      work.append(
        header,
        this.stateEl,
        this.calloutEl,
        this.stripEl,
        this.bodyEl,
        actions
      );
      const main = document.createElement("div");
      main.className = "main";
      main.append(this.navEl, work);
      this.statusEl = document.createElement("footer");
      this.statusEl.className = "statusbar";
      this.statusToolEl = document.createElement("span");
      this.statusToolEl.className = "statusbar-tool";
      this.root.append(topbar, main, this.statusEl);
      this.navScroll.addEventListener("click", (event) => this.onNavClick(event));
      bindKeyboard(this.root);
    }
    start() {
      this.reportHostGaps();
      this.renderNav();
      const first = tools.find((tool) => tool.available) ?? tools[0];
      if (first) {
        this.selectTool(first.id);
      }
      void this.refreshSelection();
      window.addEventListener("focus", () => this.scheduleRefresh());
      setTimeout(() => {
        void this.checkUpdates();
      }, 600);
    }
    async checkUpdates() {
      try {
        const result = await this.updater.checkForUpdates();
        if (result.hasUpdate && result.manifest) {
          this.latestManifest = result.manifest;
          this.renderUpdateBadge(result.manifest.version);
        }
      } catch (err) {
        console.warn("[Shell] Erro ao checar update:", err);
      }
    }
    renderUpdateBadge(version) {
      if (this.updateBadgeEl) {
        this.updateBadgeEl.remove();
      }
      const badge = document.createElement("button");
      badge.className = "update-badge";
      badge.title = `Nova versão v${version} disponível! Clique para atualizar.`;
      badge.innerHTML = `<span class="update-dot"></span><span>Atualizar (v${version})</span>`;
      badge.addEventListener("click", () => this.showUpdateModal());
      this.topbarEl.append(badge);
      this.updateBadgeEl = badge;
    }
    showUpdateModal() {
      if (this.updateModalEl) {
        this.updateModalEl.remove();
      }
      const manifest = this.latestManifest;
      if (!manifest) return;
      const modal = document.createElement("div");
      modal.className = "update-modal";
      const card = document.createElement("div");
      card.className = "update-card";
      const head = document.createElement("div");
      head.className = "update-head";
      head.innerHTML = '<span class="update-head-title"><span class="update-dot"></span>Atualização Disponível</span><span class="update-close" aria-label="Fechar">&times;</span>';
      head.querySelector(".update-close")?.addEventListener("click", () => {
        modal.remove();
        this.updateModalEl = null;
      });
      const body = document.createElement("div");
      body.className = "update-body";
      const versionTag = document.createElement("p");
      versionTag.className = "update-version-tag";
      versionTag.innerHTML = `Nova versão <b>v${escapeHtml(manifest.version)}</b> pronta para instalar. (Versão atual: v${VERSION})`;
      const changelog = document.createElement("div");
      changelog.className = "update-changelog";
      changelog.textContent = manifest.changelog || "Melhorias de desempenho e estabilidade.";
      const progressWrap = document.createElement("div");
      progressWrap.className = "update-progress-wrap";
      progressWrap.hidden = true;
      progressWrap.innerHTML = '<div class="update-progress-track"><div class="update-progress-fill"></div></div><span class="update-progress-status">Preparando download...</span>';
      body.append(versionTag, changelog, progressWrap);
      const actions = document.createElement("div");
      actions.className = "update-actions";
      const btnManual = document.createElement("button");
      btnManual.className = "btn-update-sec";
      btnManual.textContent = "Baixar Manual";
      btnManual.addEventListener("click", () => {
        this.updater.openDownloadPage();
      });
      const btnCancel = document.createElement("button");
      btnCancel.className = "btn-update-sec";
      btnCancel.textContent = "Depois";
      btnCancel.addEventListener("click", () => {
        modal.remove();
        this.updateModalEl = null;
      });
      const btnUpdate = document.createElement("button");
      btnUpdate.className = "btn-update-pri";
      btnUpdate.textContent = "Atualizar Agora";
      const btnReload = document.createElement("button");
      btnReload.className = "btn-update-pri";
      btnReload.textContent = "Recarregar Painel";
      btnReload.hidden = true;
      btnReload.addEventListener("click", () => {
        this.updater.reloadPlugin();
      });
      btnUpdate.addEventListener("click", async () => {
        btnUpdate.disabled = true;
        btnCancel.hidden = true;
        progressWrap.hidden = false;
        const fillEl = progressWrap.querySelector(".update-progress-fill");
        const statusEl = progressWrap.querySelector(".update-progress-status");
        const res = await this.updater.applyUpdate((step2, percent) => {
          if (fillEl) fillEl.style.width = `${percent}%`;
          if (statusEl) statusEl.textContent = `${step2} (${percent}%)`;
        });
        if (res.success && res.requiresReload) {
          if (statusEl) statusEl.textContent = "✅ " + res.message;
          btnUpdate.hidden = true;
          btnReload.hidden = false;
        } else {
          if (statusEl) statusEl.textContent = "⚠️ " + res.message;
          btnUpdate.textContent = "Tentar via Navegador";
          btnUpdate.disabled = false;
          btnUpdate.onclick = () => this.updater.openDownloadPage();
        }
      });
      actions.append(btnManual, btnCancel, btnUpdate, btnReload);
      card.append(head, body, actions);
      modal.append(card);
      this.root.append(modal);
      this.updateModalEl = modal;
    }
    /**
     * Names anything the host is missing, once, at startup.
     *
     * The manifest declares a minimum Premiere version but nothing checks
     * that the build has the APIs the Tools were written against. Missing
     * ones used to surface as an exception mid-apply, or as a blank panel
     * when one threw during mount.
     */
    reportHostGaps() {
      const check = checkHostCapabilities();
      if (check.ok) {
        return;
      }
      console.error("[Shell] APIs ausentes no host:", check.missing);
      this.calloutEl.classList.add("is-error");
      this.calloutEl.textContent = `Esta versão do Premiere não expõe: ${check.missing.join(", ")}. As ferramentas podem falhar. Atualize o Premiere.`;
      this.hostGaps = true;
    }
    // ── navigator ────────────────────────────────────────────
    renderNav() {
      const searching = this.query.trim().length > 0;
      const results = searching ? searchTools(this.query) : [];
      if (searching) {
        this.navEl.classList.toggle("is-empty", results.length === 0);
        this.navScroll.innerHTML = results.length ? `<div class="nav-tools">${results.map((tool) => this.toolMarkup(tool)).join("")}</div>` : "";
        return;
      }
      this.navEl.classList.remove("is-empty");
      this.navScroll.innerHTML = categories.map((category) => {
        const list = toolsIn(category.id);
        if (list.length === 0) {
          return "";
        }
        const open = !this.collapsed.has(category.id);
        return `<div class="nav-cat" ${CONTROL} data-category="${category.id}" aria-expanded="${open}"><span class="caret"></span><span class="nav-cat-name">${escapeHtml(category.name)}</span></div>` + (open ? `<div class="nav-tools">${list.map((tool) => this.toolMarkup(tool)).join("")}</div>` : "");
      }).join("");
    }
    toolMarkup(tool) {
      const active = tool.id === this.activeToolId;
      return `<div class="nav-tool${active ? " is-active" : ""}" ${CONTROL} data-tool="${tool.id}" data-available="${tool.available}" title="${escapeHtml(tool.name)}"><span class="nav-glyph">${glyph(tool.glyph)}</span><span class="nav-text"><span class="nav-name">${escapeHtml(tool.name)}</span><span class="nav-summary">${escapeHtml(tool.summary)}</span></span></div>`;
    }
    onNavClick(event) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const toolButton = target.closest("[data-tool]");
      if (toolButton?.dataset.tool) {
        this.selectTool(toolButton.dataset.tool);
        return;
      }
      const categoryButton = target.closest("[data-category]");
      const categoryId = categoryButton?.dataset.category;
      if (categoryId) {
        if (this.collapsed.has(categoryId)) {
          this.collapsed.delete(categoryId);
        } else {
          this.collapsed.add(categoryId);
        }
        this.renderNav();
      }
    }
    // ── workspace ────────────────────────────────────────────
    selectTool(toolId) {
      const tool = findTool(toolId);
      if (!tool || this.activeToolId === toolId) {
        return;
      }
      if (this.activeToolId) {
        try {
          findTool(this.activeToolId)?.unmount?.();
        } catch (cause) {
          console.error("[Shell] unmount threw:", cause);
        }
      }
      this.activeToolId = toolId;
      this.toolGeneration += 1;
      this.applyHandler = null;
      this.applyStateOwned = false;
      this.resetHandler = null;
      this.refreshHandler = null;
      this.resetButton.hidden = true;
      this.resetButton.textContent = "Limpar";
      this.applyButton.textContent = "Aplicar";
      setDisabled(this.applyButton, true);
      this.titleEl.textContent = tool.name;
      const category = categories.find((entry) => entry.id === tool.category);
      this.chipEl.textContent = category?.name ?? "";
      if (!this.hostGaps) {
        this.calloutEl.textContent = tool.hint;
      }
      this.statusToolEl.textContent = tool.name;
      this.setStatus("", "idle");
      this.renderNav();
      this.bodyEl.scrollTop = 0;
      this.bodyEl.innerHTML = "";
      tool.mount(this.bodyEl, this.createContext());
      this.renderApplyCount();
    }
    createContext() {
      const generation = this.toolGeneration;
      const live = () => generation === this.toolGeneration;
      return {
        setApplyLabel: (label) => {
          if (!live()) return;
          this.applyButton.textContent = label;
          this.renderApplyCount();
        },
        setApplyEnabled: (enabled) => {
          if (!live()) return;
          this.applyStateOwned = true;
          setDisabled(this.applyButton, !enabled);
          this.renderApplyCount();
        },
        setApplyHandler: (handler) => {
          if (!live()) return;
          this.applyHandler = handler;
        },
        setResetHandler: (handler) => {
          if (!live()) return;
          this.resetHandler = handler;
          this.resetButton.hidden = handler === null;
        },
        setResetLabel: (label) => {
          if (!live()) return;
          this.resetButton.textContent = label;
        },
        setStatus: (text2, tone) => {
          if (!live()) return;
          this.setStatus(text2, tone ?? "idle");
        },
        refreshSelection: () => {
          if (!live()) return;
          void this.refreshSelection();
        },
        setRefreshHandler: (handler) => {
          if (!live()) return;
          this.refreshHandler = handler;
        }
      };
    }
    /** Guards the action button against re-entry while a Tool is running. */
    async runApply() {
      const handler = this.applyHandler;
      if (!handler || isDisabled(this.applyButton)) {
        return;
      }
      this.applyStateOwned = false;
      setDisabled(this.applyButton, true);
      try {
        await handler();
      } finally {
        if (this.applyHandler !== handler) {
          setDisabled(this.applyButton, true);
        } else if (!this.applyStateOwned) {
          setDisabled(this.applyButton, false);
        }
        this.renderApplyCount();
      }
    }
    setStatus(text2, tone) {
      this.statusEl.className = `statusbar${tone === "done" ? " is-done" : tone === "error" ? " is-error" : ""}`;
      this.statusEl.innerHTML = "";
      if (text2) {
        const message = document.createElement("span");
        message.textContent = text2;
        this.statusEl.append(message);
      }
      this.statusEl.append(this.statusToolEl);
    }
    // ── selection ────────────────────────────────────────────
    /**
     * Coalesces timeline reads.
     *
     * Reading the selection walks every track item of every video track, so
     * the cost is real on a long sequence — and the panel regaining focus
     * can fire several times in a row.
     */
    scheduleRefresh(delayMs = 180) {
      if (this.refreshTimer !== null) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        void this.refreshSelection();
      }, delayMs);
    }
    async refreshSelection() {
      if (this.refreshInFlight) {
        this.refreshQueued = true;
        return;
      }
      this.refreshInFlight = true;
      try {
        this.selection = await readSelection();
        this.renderState();
        this.renderStrip();
        this.renderApplyCount();
        try {
          this.refreshHandler?.();
        } catch (cause) {
          console.error("[Shell] refresh handler threw:", cause);
        }
      } finally {
        this.refreshInFlight = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.scheduleRefresh(0);
        }
      }
    }
    renderState() {
      const summary = this.selection;
      const count = summary?.selectedCount ?? 0;
      if (count === 0) {
        this.stateEl.className = "work-state is-idle";
        this.stateEl.innerHTML = '<span class="dot"></span><span>Nenhum clipe de vídeo selecionado</span>';
        return;
      }
      const where = summary?.spansTracks ? " em várias faixas" : summary?.trackLabel ? ` em ${escapeHtml(summary.trackLabel)}` : "";
      this.stateEl.className = "work-state";
      this.stateEl.innerHTML = `<span class="dot"></span><span>${count} ${count === 1 ? "clipe" : "clipes"} selecionado${count === 1 ? "" : "s"}${where} · ${formatDuration(summary?.selectedSeconds ?? 0)}</span>`;
    }
    renderStrip() {
      const summary = this.selection;
      this.stripEl.innerHTML = "";
      if (!summary || summary.selectedCount === 0) {
        this.stripEl.hidden = true;
        return;
      }
      this.stripEl.hidden = false;
      const base = document.createElement("span");
      base.className = "strip-base";
      this.stripEl.append(base);
      const span = summary.rangeEnd - summary.rangeStart;
      if (!(span > 0)) {
        return;
      }
      const clips = document.createElement("span");
      clips.className = "strip-clips";
      for (const clip of summary.clips) {
        const item = document.createElement("span");
        item.className = `strip-clip${clip.selected ? " is-selected" : ""}`;
        item.style.left = `${((clip.startSeconds - summary.rangeStart) / span * 100).toFixed(3)}%`;
        item.style.width = `${((clip.endSeconds - clip.startSeconds) / span * 100).toFixed(3)}%`;
        if (clip.selected) {
          const block = document.createElement("span");
          block.className = "strip-block";
          item.append(block);
        }
        clips.append(item);
      }
      this.stripEl.append(clips);
      if (summary.playheadRatio !== null) {
        const head = document.createElement("span");
        head.className = "strip-head";
        head.style.left = `${(summary.playheadRatio * 100).toFixed(2)}%`;
        this.stripEl.append(head);
      }
    }
    renderApplyCount() {
      this.applyButton.querySelector(".btn-apply-count")?.remove();
      const count = this.selection?.selectedCount ?? 0;
      const tool = this.activeToolId ? findTool(this.activeToolId) : void 0;
      if (isDisabled(this.applyButton) || count === 0 || tool?.usesSelection === false) {
        return;
      }
      const badge = document.createElement("span");
      badge.className = "btn-apply-count";
      badge.textContent = `${count} ${count === 1 ? "clipe" : "clipes"}`;
      this.applyButton.append(badge);
    }
  }
  function formatDuration(seconds) {
    const whole = Math.max(0, Math.round(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  function brandMark() {
    return '<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="1" y="1" width="98" height="98" fill="none" stroke="currentColor" stroke-width="6"/><rect x="14" y="18" width="10" height="12" fill="currentColor"/><rect x="14" y="44" width="10" height="12" fill="currentColor"/><rect x="14" y="70" width="10" height="12" fill="currentColor"/><rect x="76" y="18" width="10" height="12" fill="currentColor"/><rect x="76" y="44" width="10" height="12" fill="currentColor"/><rect x="76" y="70" width="10" height="12" fill="currentColor"/><circle cx="50" cy="50" r="15" fill="#E5372A"/></svg>';
  }
  function searchGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2 12.4 12.4"/></svg>';
  }
  function refreshGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"><path d="M11.6 7a4.6 4.6 0 1 1-1.5-3.4"/><path d="M11.8 1.6v3.2H8.6"/></svg>';
  }
  function escapeHtml(value) {
    return value.replace(/[&<>"]/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        default:
          return "&quot;";
      }
    });
  }
  function bootstrap() {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    try {
      new ProductShell(root).start();
    } catch (cause) {
      console.error("[Edit Toolbox] falha ao iniciar:", cause);
      renderFatal(root, cause);
    }
  }
  function renderFatal(root, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const stack = cause instanceof Error && cause.stack ? cause.stack : "";
    root.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "fatal";
    const title = document.createElement("p");
    title.className = "fatal-title";
    title.textContent = "O painel não conseguiu iniciar.";
    const message = document.createElement("p");
    message.className = "fatal-message";
    message.textContent = detail;
    const hint = document.createElement("p");
    hint.className = "fatal-hint";
    hint.textContent = "Recarregue o plugin no UXP Developer Tool. Se persistir, confira se a versão do Premiere atende ao mínimo declarado no manifest.";
    panel.append(title, message, hint);
    if (stack) {
      const trace = document.createElement("pre");
      trace.className = "fatal-trace";
      trace.textContent = stack;
      panel.append(trace);
    }
    root.append(panel);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
