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
  function describeError$1(cause) {
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
        const reads = await Promise.all(
          items.map(async (item) => {
            const [start, end, isSelected] = await Promise.all([
              item.getStartTime(),
              item.getEndTime(),
              item.getIsSelected()
            ]);
            return { startSeconds: start.seconds, endSeconds: end.seconds, isSelected };
          })
        );
        const clips = [];
        let selected = 0;
        for (const read of reads) {
          if (!(read.endSeconds > read.startSeconds)) {
            continue;
          }
          if (read.isSelected) {
            selected += 1;
            totalSelected += 1;
            totalSeconds += read.endSeconds - read.startSeconds;
          }
          clips.push({
            startSeconds: read.startSeconds,
            endSeconds: read.endSeconds,
            selected: read.isSelected
          });
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
            try {
              const initialKf = scaleParam.createKeyframe(baseFrom);
              compoundAction.addAction(scaleParam.createSetValueAction(initialKf));
            } catch (cause) {
              console.warn("[Zoom] createSetValueAction warning:", cause);
            }
            compoundAction.addAction(
              scaleParam.createSetTimeVaryingAction(true)
            );
            const startSec = ppro.TickTime.createWithTicks(startTicks).seconds;
            const endSec = ppro.TickTime.createWithTicks(endTicks).seconds;
            const duration = endSec - startSec;
            if (duration > 0) {
              const delta = baseTo - baseFrom;
              const placed = /* @__PURE__ */ new Map();
              placed.set(startTicks, baseFrom);
              const firstSnapped = snapTicksToFrame(startTicks, ticksPerFrame);
              placed.set(firstSnapped, baseFrom);
              for (let step2 = 0; step2 <= CURVE_KEYS; step2++) {
                const t = step2 / CURVE_KEYS;
                const ticks = snapTicksToFrame(
                  ppro.TickTime.createWithSeconds(startSec + duration * t).ticks,
                  ticksPerFrame
                );
                placed.set(ticks, baseFrom + delta * options.ease(t));
              }
              placed.set(endTicks, baseTo);
              const lastTicks = snapTicksToFrame(endTicks, ticksPerFrame);
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
          const kfTimes = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
          const count = Array.isArray(kfTimes) ? kfTimes.length : 0;
          console.log(`[Zoom] Scale keyframe count after commit: ${count}`);
          if (count > 0 && Array.isArray(kfTimes) && kfTimes[0]) {
            try {
              const firstVal = await item.scaleParam.getValueAtTime(kfTimes[0]);
              console.log(`[Zoom] First keyframe at ${kfTimes[0].seconds}s has value:`, firstVal);
            } catch {
            }
          }
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
        message: summarize$1(
          applied,
          videoClips.length - applied,
          unreadableCount,
          speedSkipped
        )
      };
    } catch (cause) {
      rollbackAppends?.();
      return fail$2(`Zoom falhou: ${describeError$1(cause)}`);
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
      count = Number(await Promise.resolve(component.getParamCount())) || 0;
    } catch {
      console.error("[Zoom] getParamCount() threw on Transform component");
      return null;
    }
    console.log(`[Zoom] Transform has ${count} params:`);
    const rows = [];
    for (let index = 0; index < count; index++) {
      try {
        const param = await Promise.resolve(component.getParam(index));
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
  function summarize$1(applied, skipped, unverified, speedSkipped) {
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
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
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
    return `M${round$2(start.x)},${round$2(start.y)} C${round$2(one.x)},${round$2(one.y)} ${round$2(two.x)},${round$2(two.y)} ${round$2(end.x)},${round$2(end.y)}`;
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
  function round$2(value) {
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
    container.innerHTML = markup$7();
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
    const floorLine = container.querySelector(".ce-floor");
    const ceilingLine = container.querySelector(".ce-ceiling");
    const linearLine = container.querySelector(".ce-linear");
    function render() {
      const start = project(box, 0, 0);
      const end = project(box, 1, 1);
      const left = box.padX.toFixed(1);
      const right = (box.width - box.padX).toFixed(1);
      const floor = start.y.toFixed(1);
      const ceiling = end.y.toFixed(1);
      setAttr(floorLine, "d", `M${left},${floor} L${right},${floor}`);
      setAttr(ceilingLine, "d", `M${left},${ceiling} L${right},${ceiling}`);
      setAttr(
        linearLine,
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
        index = distance$1(cursor, first) <= distance$1(cursor, second) ? 1 : 2;
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
  function distance$1(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function setAttr(node, name, value) {
    node?.setAttribute(name, value);
  }
  function markup$7() {
    return `<svg class="ce-canvas" viewBox="0 0 ${NOMINAL_WIDTH} ${NOMINAL_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><path class="ce-floor" d=""/><path class="ce-ceiling" d=""/><path class="ce-linear" d=""/><path class="ce-tether" data-tether="1" d=""/><path class="ce-tether" data-tether="2" d=""/><path class="ce-curve" d=""/></svg><div class="ce-grip" ${CONTROL} data-handle="1" aria-label="Ponto de controle da saída"></div><div class="ce-grip" ${CONTROL} data-handle="2" aria-label="Ponto de controle da chegada"></div>`;
  }
  let drawnPoints = { ...CUSTOM_DEFAULT };
  const PREVIEW_WIDTH$1 = 200;
  const PREVIEW_HEIGHT$1 = 84;
  function mountCurvePicker(container, options) {
    const initialCurveId = options.curveId ?? CURVES[0].id;
    let curveId = initialCurveId;
    let editor = null;
    container.innerHTML = markup$6(curveId);
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
  function markup$6(curveId) {
    const cell2 = (curve, perRow) => `<div class="curve-cell" ${CONTROL} data-curve="${curve.id}" style="width:${(100 / perRow).toFixed(3)}%" aria-pressed="${curve.id === curveId}" title="${escapeHtml(curve.name)}"><svg viewBox="0 0 60 34" preserveAspectRatio="none" aria-hidden="true"><path class="curve-track" d="M4,30 L56,30"/><path class="curve-line" d="${curvePath(curve, 60, 34, 4)}"/></svg><span class="curve-cell-name">${escapeHtml(curve.name)}</span></div>`;
    const rows = [];
    for (let index = 0; index < CURVES.length; index += 3) {
      const row = CURVES.slice(index, index + 3);
      rows.push(
        `<div class="curve-row">${row.map((curve) => cell2(curve, row.length)).join("")}</div>`
      );
    }
    return `<div class="field-head"><span class="t-label">Curva</span><span class="curve-tag" data-curve-name></span></div><div class="curve-grid">${rows.join("")}</div><div class="curve-draw" ${CONTROL} data-curve="${CUSTOM_CURVE}" aria-pressed="${curveId === CUSTOM_CURVE}"><span class="curve-draw-mark"></span><span class="curve-draw-name">Desenhar a minha</span></div><div class="preview"><div class="preview-canvas" data-curve-slot></div><div class="preview-meta" data-curve-meta></div></div>`;
  }
  function decimalsOf(step2) {
    const text2 = String(step2);
    if (text2.includes("e-")) {
      return Number.parseInt(text2.split("e-")[1] ?? "0", 10);
    }
    return (text2.split(".")[1] ?? "").length;
  }
  function mountSlider(host, spec) {
    const decimals = decimalsOf(spec.step);
    const span = spec.max - spec.min;
    let value = clampSnap(spec.value);
    function clampSnap(raw) {
      if (!Number.isFinite(raw)) {
        return value ?? spec.min;
      }
      const held = Math.min(spec.max, Math.max(spec.min, raw));
      const stepped = spec.min + Math.round((held - spec.min) / spec.step) * spec.step;
      const clean = Number(stepped.toFixed(decimals));
      return Math.min(spec.max, Math.max(spec.min, clean));
    }
    host.className = "fl-slider";
    host.setAttribute("role", "slider");
    host.setAttribute("tabindex", "0");
    host.setAttribute("aria-label", spec.label);
    host.innerHTML = '<span class="fl-slider-line"></span><span class="fl-slider-fill"></span><span class="fl-slider-thumb"></span>';
    const fill = host.querySelector(".fl-slider-fill");
    const thumb = host.querySelector(".fl-slider-thumb");
    function render() {
      const percent = span === 0 ? 0 : (value - spec.min) / span * 100;
      if (fill) fill.style.width = `${percent}%`;
      if (thumb) thumb.style.left = `${percent}%`;
      host.setAttribute("aria-valuenow", String(value));
      host.setAttribute("aria-valuemin", String(spec.min));
      host.setAttribute("aria-valuemax", String(spec.max));
      host.setAttribute("aria-valuetext", spec.format(value));
      if (spec.output && !editing) {
        spec.output.textContent = spec.format(value);
      }
    }
    function apply(next, commit2) {
      const settled = clampSnap(next);
      const changed = settled !== value;
      value = settled;
      render();
      if (changed) {
        spec.onInput(value);
      }
      if (commit2) {
        spec.onCommit?.(value);
      }
    }
    function valueAt(clientX) {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0) {
        return value;
      }
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return spec.min + ratio * span;
    }
    let dragging = false;
    const onMove = (event) => {
      if (!dragging) return;
      event.preventDefault();
      apply(valueAt(event.clientX), false);
    };
    const onUp = (event) => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      apply(valueAt(event.clientX), true);
    };
    const onDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      host.focus();
      dragging = true;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      apply(valueAt(event.clientX), false);
    };
    const onKey = (event) => {
      const jump = event.shiftKey ? spec.step * 10 : spec.step;
      let next = null;
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowDown":
          next = value - jump;
          break;
        case "ArrowRight":
        case "ArrowUp":
          next = value + jump;
          break;
        case "Home":
          next = spec.min;
          break;
        case "End":
          next = spec.max;
          break;
        case "Enter":
        case " ":
          openEntry();
          event.preventDefault();
          return;
        default:
          return;
      }
      event.preventDefault();
      apply(next, true);
    };
    host.addEventListener("mousedown", onDown);
    host.addEventListener("keydown", onKey);
    let editing = false;
    let entry = null;
    function parseTyped(text2) {
      const cleaned = text2.replace(/,/g, ".").replace(/[^0-9.\-]/g, "");
      return Number.parseFloat(cleaned);
    }
    function closeEntry(commit2) {
      if (!editing || !entry || !spec.output) return;
      const typed = commit2 ? parseTyped(entry.value) : Number.NaN;
      editing = false;
      entry = null;
      spec.output.textContent = spec.format(value);
      if (Number.isFinite(typed)) {
        apply(typed, true);
      }
      render();
    }
    function openEntry() {
      if (editing || !spec.output) return;
      editing = true;
      spec.output.textContent = "";
      const field = document.createElement("input");
      field.type = "text";
      field.className = "fl-slider-entry";
      field.value = String(value);
      field.setAttribute("aria-label", spec.label);
      spec.output.appendChild(field);
      entry = field;
      field.focus();
      field.select();
      field.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          closeEntry(true);
          host.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeEntry(false);
          host.focus();
        }
      });
      field.addEventListener("blur", () => closeEntry(true));
    }
    const onOutputDouble = () => openEntry();
    const onOutputKey = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openEntry();
      }
    };
    if (spec.output) {
      spec.output.classList.add("is-typable");
      spec.output.setAttribute("tabindex", "0");
      spec.output.setAttribute("title", "Dois cliques para digitar o valor");
      spec.output.addEventListener("dblclick", onOutputDouble);
      spec.output.addEventListener("keydown", onOutputKey);
    }
    render();
    return {
      set(next) {
        value = clampSnap(next);
        render();
      },
      value: () => value,
      render,
      destroy() {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        host.removeEventListener("mousedown", onDown);
        host.removeEventListener("keydown", onKey);
        if (spec.output) {
          spec.output.removeEventListener("dblclick", onOutputDouble);
          spec.output.removeEventListener("keydown", onOutputKey);
        }
      }
    };
  }
  let livePicker$1 = null;
  let scaleSlider = null;
  let durationSlider = null;
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
      container.innerHTML = markup$5(direction, style, scalePercent, punchDuration);
      const directionSeg = container.querySelector("[data-direction-seg]");
      const styleSeg = container.querySelector("[data-style-seg]");
      const presetButtons = Array.from(
        container.querySelectorAll("[data-preset-dur]")
      );
      const scaleRail = container.querySelector("[data-scale]");
      const scaleOut = container.querySelector("[data-out-scale]");
      const durationField = container.querySelector("[data-duration-field]");
      const durationRail = container.querySelector("[data-duration]");
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
        scalePercent = Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, value)));
        scaleSlider?.set(scalePercent);
        if (scaleOut && !scaleSlider) {
          scaleOut.textContent = `${scalePercent}%`;
        }
        draw();
      }
      function setDuration(value) {
        punchDuration = Math.max(PUNCH_DURATION_MIN, Math.min(PUNCH_DURATION_MAX, value));
        durationSlider?.set(punchDuration);
        if (durationOut && !durationSlider) {
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
      if (scaleRail) {
        scaleSlider = mountSlider(scaleRail, {
          min: SCALE_MIN,
          max: SCALE_MAX,
          step: 1,
          value: scalePercent,
          label: "Intensidade",
          format: (value) => `${value}%`,
          output: scaleOut,
          onInput: (value) => {
            scaleTouched = true;
            setScale(value);
          }
        });
      }
      if (durationRail) {
        durationSlider = mountSlider(durationRail, {
          min: PUNCH_DURATION_MIN,
          max: PUNCH_DURATION_MAX,
          step: 0.1,
          value: punchDuration,
          label: "Duração do punch",
          format: (value) => `${value.toFixed(1)}s`,
          output: durationOut,
          onInput: (value) => setDuration(value)
        });
      }
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
      scaleSlider?.destroy();
      scaleSlider = null;
      durationSlider?.destroy();
      durationSlider = null;
      livePicker$1?.destroy();
      livePicker$1 = null;
    }
  };
  function markup$5(direction, style, scalePercent, punchDuration) {
    const presetButtonsHtml = PUNCH_DURATION_PRESETS.map(
      (preset) => `<div class="preset-pill${Math.abs(preset - punchDuration) < 0.05 ? " is-active" : ""}" ${CONTROL} data-preset-dur="${preset}">${preset.toFixed(1)}s</div>`
    ).join("");
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Direção</span><div class="seg" data-direction-seg><div class="seg-item" ${CONTROL} data-value="in" aria-pressed="${direction === "in"}">Zoom In</div><div class="seg-item" ${CONTROL} data-value="out" aria-pressed="${direction === "out"}">Zoom Out</div></div></div><div class="field"><span class="t-label">Comportamento</span><div class="seg" data-style-seg><div class="seg-item" ${CONTROL} data-style="punch" aria-pressed="${style === "punch"}">Punch Smooth</div><div class="seg-item" ${CONTROL} data-style="full" aria-pressed="${style === "full"}">Clipe inteiro</div></div></div><div class="field" data-duration-field${style === "full" ? " hidden" : ""}><div class="field-head"><span class="t-label">Duração do Punch</span><span class="field-val" data-out-duration>${punchDuration.toFixed(1)}s</span></div><div class="preset-rail">${presetButtonsHtml}</div><div class="slider-row"><div data-duration></div></div></div><div class="field"><div class="field-head"><span class="t-label">Intensidade (Escala Alvo)</span><span class="field-val" data-out-scale>${scalePercent}%</span></div><div class="slider-row"><div data-scale></div></div><p class="field-note">100% mantém o enquadramento; valores acima aumentam o corte com Transform.</p></div><div class="preview-meta"><b data-meta-range></b><span class="preview-meta-gap"></span><b data-meta-span></b><span data-meta-hold>segura até o fim</span></div></div><div class="zone" data-curve-zone></div></div>`;
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
      report.lines.push(`Erro: ${describeError$1(cause)}`);
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
          context.notes.push(`${label}: ${describeError$1(cause)}`);
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
        transactionError = describeError$1(cause);
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
      return fail$1(`Falhou: ${describeError$1(cause)}`);
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
    const used = /* @__PURE__ */ new Set([
      startTicks,
      endTicks,
      snapTicksToFrame(startTicks, build.ticksPerFrame),
      snapTicksToFrame(endTicks, build.ticksPerFrame)
    ]);
    for (let step2 = 1; step2 <= steps; step2++) {
      const t = step2 / (steps + 1);
      const seconds2 = startSeconds + (endSeconds - startSeconds) * t;
      const ticks = snapTicksToFrame(
        ppro.TickTime.createWithSeconds(seconds2).ticks,
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
  let densitySlider = null;
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
      const densityRail = container.querySelector("[data-density]");
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
      if (densityRail) {
        densitySlider = mountSlider(densityRail, {
          min: DENSITY_MIN,
          max: DENSITY_MAX,
          step: 1,
          value: density,
          label: "Densidade da assadura",
          format: (value) => `${value} kf`,
          output: densityOut,
          onInput: (value) => setDensity(value)
        });
      }
      function setDensity(value) {
        if (!Number.isFinite(value)) {
          return;
        }
        density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, value));
        densitySlider?.set(density);
        if (densityOut && !densitySlider) {
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
      densitySlider?.destroy();
      densitySlider = null;
      livePicker?.destroy();
      livePicker = null;
    }
  };
  function scanMarkup(report) {
    if (!report) {
      return "";
    }
    const rows = report.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
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
    return `<div class="kf-row${chosen ? " is-chosen" : ""}" ${CONTROL} data-param="${param.id}"><div class="kf-head"><span class="kf-name">${escapeHtml(param.label)}</span><span class="kf-count">${count} kf${baked > 0 ? ` +${baked}` : ""}</span></div><div class="kf-strip">${cells.join("")}</div></div>`;
  }
  function shellMarkup(density) {
    const presets = DENSITY_PRESETS.map(
      (preset) => `<div class="preset-pill${preset === density ? " is-active" : ""}" ${CONTROL} data-density-preset="${preset}">${preset}</div>`
    ).join("");
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Parâmetros animados</span><div class="field-action" ${CONTROL} data-rescan title="Reler os keyframes do clipe selecionado">Reler</div></div><div class="kf-list" data-param-list></div></div><div class="field"><div class="field-head"><span class="t-label">Densidade da assadura</span><span class="field-val" data-out-density>${density} kf</span></div><div class="preset-rail">${presets}</div><div class="slider-row"><div data-density></div></div><p class="field-note">Cada keyframe assado é um keyframe que você não retima mais. Use Linear para desfazer e reajustar o tempo.</p></div></div><div class="zone" data-curve-zone></div></div>`;
  }
  const MIN_REMOVAL_SECONDS$1 = 0.06;
  function planSegments(voiced, range, params, frameSeconds2) {
    const total = range.end - range.start;
    if (!(total > 0)) {
      return emptyPlan();
    }
    const frame = frameSeconds2 > 0 ? frameSeconds2 : 1 / 30;
    const minRemoval = Math.max(MIN_REMOVAL_SECONDS$1, frame * 2);
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
  function mergeGaps(spans, tolerance2) {
    if (spans.length === 0) {
      return [];
    }
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const out = [{ ...sorted[0] }];
    for (let index = 1; index < sorted.length; index++) {
      const current = sorted[index];
      const last = out[out.length - 1];
      if (current.start - last.end < tolerance2) {
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
    const seconds2 = (tenths - minutes * 600) / 10;
    if (minutes === 0) {
      return `${seconds2.toFixed(1)}s`;
    }
    return `${minutes}:${seconds2.toFixed(1).padStart(4, "0")}`;
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
      const segmentStart = num$3(segment.start) ?? 0;
      const list = segment.words;
      if (!Array.isArray(list)) {
        continue;
      }
      const parsed = [];
      let anyBeforeSegment = false;
      for (const raw of list) {
        if (!isRecord(raw)) {
          continue;
        }
        if (typeof raw.type === "string" && raw.type === "punctuation") {
          continue;
        }
        const start = num$3(raw.start);
        if (start === null) {
          continue;
        }
        const end = spanEnd(raw, start);
        if (end === null) {
          continue;
        }
        if (start < segmentStart - 1e-3) {
          anyBeforeSegment = true;
        }
        parsed.push({
          start,
          end,
          filler: hasFillerTag(raw.tags),
          confidence: readConfidence(raw.confidence),
          text: readText$1(raw)
        });
      }
      const offset = anyBeforeSegment ? segmentStart : 0;
      for (const word of parsed) {
        out.push({
          start: word.start + offset,
          end: word.end + offset,
          filler: word.filler,
          confidence: word.confidence,
          text: word.text
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
        const start = num$3(raw.ts);
        const end = num$3(raw.end_ts);
        if (start === null || end === null || !(end > start)) {
          continue;
        }
        out.push({
          start,
          end,
          filler: hasFillerTag(raw.tags),
          confidence: readConfidence(raw.confidence),
          text: readText$1(raw)
        });
      }
    }
    return out;
  }
  function spanEnd(raw, start) {
    const duration = num$3(raw.duration);
    if (duration !== null && duration > 0) {
      return start + duration;
    }
    const end = num$3(raw.end);
    if (end !== null && end > start) {
      return end;
    }
    return null;
  }
  function readConfidence(value) {
    const parsed = num$3(value);
    if (parsed === null) {
      return 1;
    }
    return Math.min(1, Math.max(0, parsed));
  }
  function readText$1(raw) {
    for (const key of ["text", "word", "value"]) {
      const value = raw[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return void 0;
  }
  function hasFillerTag(tags) {
    return Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "filler");
  }
  function num$3(value) {
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
  async function ensureDir(space, relative) {
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    const parts = relative.split("/").filter(Boolean);
    let path = space.fsBase;
    for (const part of parts) {
      path = join(path, part);
      try {
        await fs.mkdir(path);
      } catch {
      }
    }
  }
  function exists(space, relative) {
    const fs = fsModule();
    if (!fs) {
      return false;
    }
    try {
      fs.readFileSync(join(space.fsBase, relative), { encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
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
  function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
  function batValue(value) {
    return value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
  }
  function wait$1(ms) {
    return new Promise((resolve2) => setTimeout(resolve2, ms));
  }
  const AGENT_VERSION = "3";
  const ALIVE_FILE = "agent-alive.txt";
  const PANEL_FILE = "agent-panel.txt";
  const STOP_FILE = "agent-stop.txt";
  const GO_PREFIX = "agent-go-";
  const ALIVE_GRACE_SECONDS = 8;
  const PANEL_BEAT_MS = 2e4;
  const PANEL_GRACE_SECONDS = 90;
  const MAX_TICKS = 57600;
  const CONSENT_TEXT = "Iniciar o assistente do Framelab, que executa as tarefas do painel (baixar, converter áudio, transcrever) sem abrir o Terminal. Só é preciso autorizar uma vez por sessão do Premiere.";
  function nowSeconds() {
    return Math.floor(Date.now() / 1e3);
  }
  async function beat(space) {
    await write(space, PANEL_FILE, String(nowSeconds()));
  }
  function agentState(space) {
    const raw = readText(space, ALIVE_FILE);
    if (!raw) {
      return "gone";
    }
    const [stampText, version] = raw.split(/\s+/);
    const stamp = Number.parseInt(stampText ?? "", 10);
    if (!Number.isFinite(stamp) || nowSeconds() - stamp > ALIVE_GRACE_SECONDS) {
      return "gone";
    }
    return version === AGENT_VERSION ? "live" : "old";
  }
  async function agentStatus() {
    try {
      const space = await workspace();
      const raw = readText(space, ALIVE_FILE) ?? "";
      const arch = raw.split(/\s+/)[2] ?? "?";
      return { up: agentState(space) === "live", arch };
    } catch {
      return { up: false, arch: "?" };
    }
  }
  async function dispatch(scriptName2) {
    const space = await workspace();
    await beat(space);
    if (agentState(space) === "old") {
      await write(space, STOP_FILE, "1");
      for (let attempt = 0; attempt < 12 && agentState(space) !== "gone"; attempt += 1) {
        await wait$1(250);
      }
      await remove(space, STOP_FILE);
    }
    const ticket = `${GO_PREFIX}${Date.now().toString(36)}.txt`;
    await write(space, ticket, scriptName2);
    if (agentState(space) === "live") {
      return { mode: "agent", error: null, ticket };
    }
    const shell = shellModule();
    if (!shell) {
      await remove(space, ticket);
      return { mode: "denied", error: 'require("uxp").shell não resolveu', ticket: null };
    }
    try {
      const refusal = await shell.openPath(await ensureAgentBundle(space), CONSENT_TEXT);
      if (typeof refusal === "string" && refusal.trim().length > 0) {
        await remove(space, ticket);
        return { mode: "denied", error: refusal.trim(), ticket: null };
      }
      return { mode: "launched", error: null, ticket };
    } catch (cause) {
      await remove(space, ticket);
      return { mode: "denied", error: describe(cause), ticket: null };
    }
  }
  async function withdraw(ticket) {
    if (!ticket) {
      return;
    }
    try {
      await remove(await workspace(), ticket);
    } catch {
    }
  }
  let heartbeat = null;
  function startAgentHeartbeat() {
    if (heartbeat !== null) {
      return;
    }
    const tick = () => {
      void (async () => {
        try {
          await beat(await workspace());
        } catch {
        }
      })();
    };
    tick();
    heartbeat = window.setInterval(tick, PANEL_BEAT_MS);
  }
  async function ensureAgentBundle(space) {
    if (isWindows()) {
      const name = `FramelabAgent-${AGENT_VERSION}.vbs`;
      await write(space, name, agentVbs(space));
      return nativePath(space, name);
    }
    const app = `FramelabAgent-${AGENT_VERSION}.app`;
    await ensureDir(space, app);
    await ensureDir(space, `${app}/Contents`);
    await ensureDir(space, `${app}/Contents/MacOS`);
    await write(space, `${app}/Contents/Info.plist`, infoPlist());
    await write(space, `${app}/Contents/PkgInfo`, "APPL????");
    await write(space, `${app}/Contents/MacOS/run`, agentBash(), true);
    if (!exists(space, `${app}/Contents/MacOS/run`)) {
      throw new Error("o bundle do agente não pôde ser escrito");
    }
    return nativePath(space, app);
  }
  function infoPlist() {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>CFBundleName</key><string>Framelab Agent</string>",
      `  <key>CFBundleIdentifier</key><string>com.framelab.agent.v${AGENT_VERSION}</string>`,
      "  <key>CFBundleExecutable</key><string>run</string>",
      "  <key>CFBundlePackageType</key><string>APPL</string>",
      `  <key>CFBundleShortVersionString</key><string>${AGENT_VERSION}.0</string>`,
      "  <key>LSUIElement</key><true/>",
      "  <key>LSBackgroundOnly</key><true/>",
      // Sem isto o LaunchServices abre o bundle sob ROSETTA: o executável
      // é um script, e sem uma fatia arm64 para inspecionar ele assume o
      // pior. O bash então roda x86_64, e todo filho — ffmpeg, whisper,
      // yt-dlp, todos universais — herda a emulação. Foi assim que uma
      // transcrição de 7 minutos passou de 12: o Metal funcionava, mas a
      // metade em CPU do whisper rodava traduzida a 300% de CPU.
      "  <key>LSArchitecturePriority</key><array><string>arm64</string></array>",
      "  <key>LSRequiresNativeExecution</key><true/>",
      "</dict>",
      "</plist>",
      ""
    ].join("\n");
  }
  function agentBash() {
    return [
      "#!/bin/bash",
      "# Gerado pelo Framelab — agente residente. Pode apagar.",
      "# Se o LaunchServices nos abriu sob Rosetta, relança nativo: tudo",
      "# que este laço executar herdaria a emulação.",
      'if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && command -v arch >/dev/null 2>&1; then',
      '  exec arch -arm64 /bin/bash "$0" "$@"',
      "fi",
      'DIR="$(cd "$(dirname "$0")/../../.." && pwd)"',
      'cd "$DIR" || exit 1',
      `LOCK="$DIR/agent-lock"`,
      `ALIVE="$DIR/${ALIVE_FILE}"`,
      `PANEL="$DIR/${PANEL_FILE}"`,
      `STOP="$DIR/${STOP_FILE}"`,
      "",
      "# O carimbo vai por arquivo temporário: o painel nunca deve ler",
      "# um carimbo pela metade e concluir que o agente morreu.",
      "# Terceiro campo: native ou rosetta. É o que deixa o diagnóstico do",
      "# painel dizer 'o agente está emulado' em vez de 'está lento'.",
      'ARCH="native"; [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && ARCH="rosetta"',
      "stamp() {",
      `  printf '%s ${AGENT_VERSION} %s' "$(date +%s)" "$ARCH" > "$ALIVE.tmp" 2>/dev/null &&`,
      '    mv -f "$ALIVE.tmp" "$ALIVE" 2>/dev/null',
      "}",
      "",
      "# Idade em segundos do carimbo de um arquivo. Sem arquivo = velho.",
      "age() {",
      "  local t",
      `  t=$(cut -d' ' -f1 < "$1" 2>/dev/null)`,
      `  case "$t" in ''|*[!0-9]*) echo 999999; return;; esac`,
      "  echo $(( $(date +%s) - t ))",
      "}",
      "",
      "# Um agente por pasta de trabalho. mkdir é atômico; se o dono do",
      "# lock parou de dar sinal, ele morreu e este assume o lugar.",
      'if ! mkdir "$LOCK" 2>/dev/null; then',
      `  if [ "$(age "$ALIVE")" -lt ${ALIVE_GRACE_SECONDS} ]; then exit 0; fi`,
      "fi",
      `trap 'rm -rf "$LOCK"; rm -f "$ALIVE"' EXIT`,
      "stamp",
      "",
      "tick=0",
      "while :; do",
      "  tick=$((tick+1))",
      `  [ "$tick" -gt ${MAX_TICKS} ] && break`,
      "  # ~2s entre carimbos: 0,5s deixaria quatro escritas por segundo",
      "  # rodando por horas, para nada.",
      "  [ $((tick % 4)) -eq 1 ] && stamp",
      '  [ -f "$STOP" ] && break',
      "  # O painel fechou, ou o Premiere saiu: não há mais para quem",
      "  # trabalhar. É esta linha que impede um processo órfão.",
      `  [ "$(age "$PANEL")" -gt ${PANEL_GRACE_SECONDS} ] && break`,
      "",
      `  for go in "$DIR"/${GO_PREFIX}*.txt; do`,
      '    [ -e "$go" ] || continue',
      '    job=$(cat "$go" 2>/dev/null)',
      '    rm -f "$go"',
      "    # O nome vem de um arquivo; nome com caminho não é nome.",
      `    case "$job" in ''|*/*|*..*) continue;; esac`,
      '    [ -f "$DIR/$job" ] || continue',
      '    /bin/bash "$DIR/$job" > /dev/null 2>&1 &',
      "    pid=$!",
      "    # Segue carimbando enquanto o trabalho roda: uma transcrição de",
      "    # meia hora não pode parecer um agente morto para o painel. O",
      "    # sinal do painel NÃO é checado aqui — trabalho começado",
      "    # termina, mesmo que a janela feche no meio.",
      '    while kill -0 "$pid" 2>/dev/null; do',
      "      stamp",
      "      sleep 0.5",
      "    done",
      '    wait "$pid" 2>/dev/null',
      "  done",
      "",
      "  sleep 0.5",
      "done",
      'rm -rf "$LOCK"',
      'rm -f "$ALIVE"',
      ""
    ].join("\n");
  }
  function agentVbs(space) {
    const dir = nativePath(space, "").replace(/[\\/]+$/, "").replace(/"/g, '""');
    return [
      "' Gerado pelo Framelab - agente residente. Pode apagar.",
      "Option Explicit",
      "Dim fso, sh, dir, aliveF, panelF, stopF, tick, f, gp, pend, job, jobPath",
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set sh = CreateObject("WScript.Shell")',
      `dir = "${dir}"`,
      `aliveF = dir & "\\${ALIVE_FILE}"`,
      `panelF = dir & "\\${PANEL_FILE}"`,
      `stopF = dir & "\\${STOP_FILE}"`,
      "",
      "Function Epoch()",
      '  Epoch = DateDiff("s", #1/1/1970 00:00:00#, Now())',
      "End Function",
      "",
      "Function AgeOf(path)",
      "  Dim t, h",
      "  AgeOf = 999999",
      "  If Not fso.FileExists(path) Then Exit Function",
      "  On Error Resume Next",
      "  Set h = fso.OpenTextFile(path, 1)",
      '  t = Trim(Split(h.ReadAll & " ", " ")(0))',
      "  h.Close",
      "  On Error GoTo 0",
      "  If IsNumeric(t) Then AgeOf = Epoch() - CLng(t)",
      "End Function",
      "",
      "Sub Stamp()",
      "  Dim h",
      "  On Error Resume Next",
      "  Set h = fso.CreateTextFile(aliveF, True)",
      `  h.Write Epoch() & " ${AGENT_VERSION}"`,
      "  h.Close",
      "  On Error GoTo 0",
      "End Sub",
      "",
      "' Um agente por pasta: quem chegar com o dono ainda vivo desiste.",
      `If AgeOf(aliveF) < ${ALIVE_GRACE_SECONDS} Then WScript.Quit 0`,
      "Stamp",
      "",
      "tick = 0",
      "Do",
      "  tick = tick + 1",
      `  If tick > ${MAX_TICKS} Then Exit Do`,
      "  If (tick Mod 4) = 1 Then Stamp",
      "  If fso.FileExists(stopF) Then Exit Do",
      `  If AgeOf(panelF) > ${PANEL_GRACE_SECONDS} Then Exit Do`,
      "",
      "  ' Os nomes primeiro, a execução depois: apagar arquivo enquanto",
      "  ' se percorre a coleção Files é mexer no chão em que se pisa.",
      '  pend = ""',
      "  For Each f In fso.GetFolder(dir).Files",
      `    If Left(f.Name, ${GO_PREFIX.length}) = "${GO_PREFIX}" Then`,
      "      pend = pend & f.Path & vbTab",
      "    End If",
      "  Next",
      '  If pend <> "" Then',
      "    For Each gp In Split(Left(pend, Len(pend) - 1), vbTab)",
      '      job = ""',
      "      On Error Resume Next",
      "      job = Trim(fso.OpenTextFile(gp, 1).ReadAll)",
      "      fso.DeleteFile gp, True",
      "      On Error GoTo 0",
      '      If job <> "" And InStr(job, "\\") = 0 And InStr(job, "/") = 0 _',
      '         And InStr(job, "..") = 0 Then',
      '        jobPath = dir & "\\" & job',
      "        If fso.FileExists(jobPath) Then",
      "          Stamp",
      "          ' 0 = sem janela, True = espera terminar.",
      '          sh.Run "cmd /c """ & jobPath & """", 0, True',
      "          Stamp",
      "        End If",
      "      End If",
      "    Next",
      "  End If",
      "",
      "  WScript.Sleep 500",
      "Loop",
      "On Error Resume Next",
      "fso.DeleteFile aliveF, True",
      ""
    ].join("\r\n");
  }
  const RESULT_FILE$2 = "result.json";
  const PROGRESS_FILE$1 = "progress.txt";
  const STARTED_FILE$2 = "sil-started.txt";
  const CONFIG_FILE$2 = "silence-config.json";
  const SCRIPT_FILE$2 = "extract.command";
  const SCRIPT_FILE_WIN$2 = "extract.bat";
  const POLL_MS$2 = 350;
  const POLL_SLOW_MS = 1200;
  const POLL_FAST_WINDOW_MS = 30 * 1e3;
  const TIMEOUT_MS$2 = 20 * 60 * 1e3;
  async function step(label, run2) {
    try {
      return await run2();
    } catch (cause) {
      console.error(`[Silêncios] ${label} falhou:`, cause);
      throw new Error(`${label} — ${describe(cause)}`);
    }
  }
  function scriptName$2() {
    return isWindows() ? SCRIPT_FILE_WIN$2 : SCRIPT_FILE$2;
  }
  async function readConfig$2() {
    const fallback = { ffmpegPath: "", mode: "waveform" };
    try {
      const raw = readText(await workspace(), CONFIG_FILE$2);
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
  async function writeConfig$2(config) {
    try {
      await write(await workspace(), CONFIG_FILE$2, JSON.stringify(config, null, 2));
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
    const scriptPath = nativePath(space, scriptName$2());
    const tag = Date.now().toString(36);
    const runResult = `sil-${tag}-result.json`;
    const runProgress = `sil-${tag}-progress.txt`;
    const runStarted = `sil-${tag}-started.txt`;
    await remove(space, runResult);
    await remove(space, runProgress);
    await remove(space, runStarted);
    for (const job of jobs) {
      await remove(space, job.file);
    }
    const script = (isWindows() ? windowsScript$1(jobs, space.nativeBase, ffmpegPath) : unixScript$1(jobs, space.nativeBase, ffmpegPath)).split(RESULT_FILE$2).join(runResult).split(PROGRESS_FILE$1).join(runProgress).split(STARTED_FILE$2).join(runStarted);
    await step("escrever o script", () => write(space, scriptName$2(), script, true));
    const PURPOSE = "Extrair o áudio dos clipes selecionados com o ffmpeg, para detectar os silêncios pela onda.";
    let launchError = null;
    const sent = await dispatch(scriptName$2());
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Silêncios] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, PURPOSE);
      } catch (cause) {
        launchError = describe(cause);
        console.error("[Silêncios] openPath recusou:", cause);
        onManual?.(scriptPath, launchError);
      }
    }
    const stampDeadline = Date.now() + 8e3;
    const started = Date.now();
    const deadline = started + TIMEOUT_MS$2;
    let lastDone = -1;
    let tick = 0;
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        return { ok: false, error: "cancelled", ffmpegPath: null, scriptPath };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        awaitingStamp = false;
        if (!readText(space, runStarted)) {
          console.warn("[Silêncios] sem carimbo do agente — caindo para o Terminal.");
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, "Extrair o áudio dos clipes selecionados.");
          } catch (cause) {
            launchError = describe(cause);
            onManual?.(scriptPath, launchError);
          }
        }
      }
      if (tick % 3 === 0) {
        const done = readProgress$1(space, runProgress);
        if (done !== null && done !== lastDone) {
          lastDone = done;
          onProgress?.(done, jobs.length);
        }
      }
      tick += 1;
      const raw = readText(space, runResult);
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
        Date.now() - started < POLL_FAST_WINDOW_MS ? POLL_MS$2 : POLL_SLOW_MS
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
  function readProgress$1(space, name) {
    const text2 = readText(space, name);
    if (!text2) {
      return null;
    }
    const parsed = Number.parseInt(text2.split("/")[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
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
      await remove(space, fileName);
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
    const agent = await agentStatus();
    add(
      "assistente residente",
      agent.up && agent.arch !== "rosetta",
      !agent.up ? "parado — a próxima ação pede uma vez" : agent.arch === "rosetta" ? "de pé, mas EMULADO (Rosetta): whisper e ffmpeg rodam até 10x mais devagar — recarregue o painel" : `de pé, nativo (${agent.arch}) — as ações não pedem permissão`
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
      await wait$1(POLL_MS$2);
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
  function unixScript$1(jobs, folder, ffmpegPath) {
    const lines = [
      "#!/bin/bash",
      "# Gerado pelo Framelab — Corte de Silêncios. Pode apagar.",
      `printf '\\033]0;Framelab — analisando áudio\\007'`,
      // Nativo, custe o que custar: sob Rosetta o whisper e o ffmpeg rodam
      // emulados e uma transcrição de minutos vira uma de dezenas.
      'if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && command -v arch >/dev/null 2>&1; then exec arch -arm64 /bin/bash "$0" "$@"; fi',
      "set -u",
      `WORK=${shellQuote(folder)}`,
      `printf 1 > "$WORK/${STARTED_FILE$2}"`,
      `CUSTOM=${shellQuote(ffmpegPath)}`,
      // A ordem procura primeiro o que o editor escolheu, depois o diretório
      // integrado do Framelab, Homebrew, MacPorts, PATH e a pasta de trabalho.
      'for candidate in "$CUSTOM" "$HOME/Library/Application Support/Framelab/bin/ffmpeg" "/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      'if [ -z "$FFMPEG" ]; then',
      '  echo "Baixando FFmpeg para o Framelab (so na primeira vez)..."',
      '  FFDIR="$HOME/Library/Application Support/Framelab/bin"',
      '  mkdir -p "$FFDIR" 2>/dev/null || FFDIR="$WORK"',
      '  if [ "$(uname -m)" = "arm64" ]; then',
      '    FFURL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip"',
      "  else",
      '    FFURL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip"',
      "  fi",
      '  if curl -fsSL --retry 3 -o "$FFDIR/ffmpeg.zip" "$FFURL" 2>/dev/null || curl -fsSL --retry 2 -o "$FFDIR/ffmpeg.zip" "https://evermeet.cx/ffmpeg/getrelease/zip" 2>/dev/null; then',
      '    unzip -o -q "$FFDIR/ffmpeg.zip" ffmpeg -d "$FFDIR" 2>/dev/null',
      '    rm -f "$FFDIR/ffmpeg.zip"',
      '    chmod +x "$FFDIR/ffmpeg" 2>/dev/null',
      '    xattr -d com.apple.quarantine "$FFDIR/ffmpeg" >/dev/null 2>&1 || true',
      '    if "$FFDIR/ffmpeg" -version >/dev/null 2>&1; then FFMPEG="$FFDIR/ffmpeg"; fi',
      "  fi",
      "fi",
      'if [ -z "$FFMPEG" ]; then',
      `  printf '{"ok":false,"error":"ffmpeg-not-found"}' > "$WORK/${RESULT_FILE$2}.tmp"`,
      `  mv "$WORK/${RESULT_FILE$2}.tmp" "$WORK/${RESULT_FILE$2}"`,
      '  echo "ffmpeg não encontrado."',
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
      `  printf '{"ok":true,"ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE$2}.tmp"`,
      "else",
      `  printf '{"ok":false,"error":"ffmpeg-failed","ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE$2}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE$2}.tmp" "$WORK/${RESULT_FILE$2}"`,
      'echo "Pronto. Pode voltar ao Premiere."',
      // Fecha só a própria janela, achada pelo título posto lá em cima.
      // Se o macOS negar a automação, a janela fica aberta e nada quebra.
      // Só fecha janela se o Terminal JÁ estiver aberto. `tell application
      // "Terminal"` LANÇA o Terminal quando ele não está rodando — era isto
      // que fazia uma janela vazia aparecer no FIM de cada trabalho, mesmo
      // com o agente silencioso funcionando.
      `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`,
      "exit 0"
    );
    return lines.join("\n") + "\n";
  }
  function windowsScript$1(jobs, folder, ffmpegPath) {
    const quote = (value) => `"${batValue(value)}"`;
    const lines = [
      "@echo off",
      "rem Gerado pelo Framelab — Corte de Silêncios. Pode apagar.",
      `title Framelab - analisando audio`,
      `set "WORK=${batValue(folder)}"`,
      `>"%WORK%\\${STARTED_FILE$2}" echo 1`,
      `set "FFMPEG=${batValue(ffmpegPath)}"`,
      'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
      'if "%FFMPEG%"=="" (',
      `  >"%WORK%\\${RESULT_FILE$2}.tmp" echo {"ok":false,"error":"ffmpeg-not-found"}`,
      `  move /y "%WORK%\\${RESULT_FILE$2}.tmp" "%WORK%\\${RESULT_FILE$2}" >nul`,
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
      // Barra invertida crua dentro de JSON é escape inválido: o painel
      // não conseguia ler um sucesso e esperava os 20 minutos inteiros.
      // O cmd troca \ por / na expansão da variável.
      'set "FFJSON=%FFMPEG:\\=/%"',
      'if "%FAILED%"=="0" (',
      `  >"%WORK%\\${RESULT_FILE$2}.tmp" echo {"ok":true,"ffmpeg":"%FFJSON%"}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE$2}.tmp" echo {"ok":false,"error":"ffmpeg-failed"}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE$2}.tmp" "%WORK%\\${RESULT_FILE$2}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function probeScript(folder, ffmpegPath) {
    if (isWindows()) {
      return [
        "@echo off",
        `set "FFMPEG=${batValue(ffmpegPath)}"`,
        'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
        'set "FFJSON=%FFMPEG:\\=/%"',
        `>"${batValue(folder)}\\probe.json" echo {"ffmpeg":"%FFJSON%"}`,
        "exit /b 0"
      ].join("\r\n") + "\r\n";
    }
    return [
      "#!/bin/bash",
      `printf '\\033]0;Framelab — teste\\007'`,
      "set -u",
      `CUSTOM=${shellQuote(ffmpegPath)}`,
      'for candidate in "$CUSTOM" "$HOME/Library/Application Support/Framelab/bin/ffmpeg" "/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg ' + shellQuote(join(folder, "ffmpeg")) + "; do",
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      `printf '{"ffmpeg":"%s"}' "$FFMPEG" > ${shellQuote(join(folder, "probe.json"))}`,
      'echo "Teste concluído. ffmpeg: $FFMPEG"',
      // Só fecha janela se o Terminal JÁ estiver aberto. `tell application
      // "Terminal"` LANÇA o Terminal quando ele não está rodando — era isto
      // que fazia uma janela vazia aparecer no FIM de cada trabalho, mesmo
      // com o agente silencioso funcionando.
      `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`,
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
    const frameSeconds2 = ticksPerFrame ? Number(ticksPerFrame) / Number(perSecond) : 1 / 30;
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
      frameSeconds: frameSeconds2,
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
  const ENVELOPE_TTL_MS = 10 * 60 * 1e3;
  const ENVELOPE_CACHE_MAX = 24;
  const PREROLL_SECONDS = 0.5;
  function cachedEnvelope(key) {
    const found = envelopeCache.get(key);
    if (!found) {
      return void 0;
    }
    if (Date.now() - found.at > ENVELOPE_TTL_MS) {
      envelopeCache.delete(key);
      return void 0;
    }
    envelopeCache.delete(key);
    envelopeCache.set(key, found);
    return found.envelope;
  }
  function cacheEnvelope(key, envelope) {
    while (envelopeCache.size >= ENVELOPE_CACHE_MAX) {
      const coldest = envelopeCache.keys().next().value;
      if (coldest === void 0) {
        break;
      }
      envelopeCache.delete(coldest);
    }
    envelopeCache.set(key, { envelope, at: Date.now() });
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
    const runTag = Date.now().toString(36);
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
        // O carimbo isola execuções: cancelar deixa um script órfão
        // terminando de escrever, e sem nomes próprios a varredura
        // seguinte lia o PCM DELE como se fosse o dela.
        file: `audio-${runTag}-${index}.pcm`
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
        const detail = describeError$1(cause);
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
      return { ok: false, message: describeError$1(cause), snapshot: null };
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
          message: `Não foi possível ler o item de projeto de "${clip.name}" (${describeError$1(
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
        message: `Não foi possível reler a timeline (${describeError$1(cause)}). Analise de novo.`
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
      return { ok: false, message: describeError$1(cause), snapshot };
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
    const detail = cause ? describeError$1(cause).trim() : "";
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
  function toTicks(sourceStart, seconds2, inTicks, perSecond) {
    const offset = Math.round((seconds2 - sourceStart) * Number(perSecond));
    return inTicks + BigInt(offset);
  }
  function compareTicks(a, b) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function formatClock$1(seconds2) {
    const safe = Math.max(0, Math.round(seconds2));
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
  function matchPreset$1(params) {
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
  let cancelActiveScan$1 = null;
  let releaseSliders$1 = null;
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
      container.innerHTML = markup$4(params);
      const modeSeg = container.querySelector("[data-mode-seg]");
      const presetRail = container.querySelector("[data-preset-rail]");
      const sliders = /* @__PURE__ */ new Map();
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
      void readConfig$2().then((config) => {
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
        void writeConfig$2({ ffmpegPath, mode });
        context.setStatus(
          mode === "waveform" ? "Modo Onda (ffmpeg)" : "Modo Transcrição"
        );
      });
      ffmpegInput?.addEventListener("change", () => {
        ffmpegPath = ffmpegInput.value.trim();
        void writeConfig$2({ ffmpegPath, mode });
      });
      function syncPresetRail() {
        const active = matchPreset$1(params);
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
          sliders.get(spec.key)?.set(params[spec.key]);
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
        const rail = container.querySelector(`[data-slider="${spec.key}"]`);
        if (!rail) continue;
        sliders.set(
          spec.key,
          mountSlider(rail, {
            min: spec.min,
            max: spec.max,
            step: spec.step,
            value: params[spec.key],
            label: spec.label,
            format: (value) => formatParam(spec, value),
            output: container.querySelector(`[data-out="${spec.key}"]`),
            onInput: (value) => {
              params = { ...params, [spec.key]: value };
              paramsChanged();
            }
          })
        );
      }
      releaseSliders$1 = () => {
        for (const handle of sliders.values()) handle.destroy();
        sliders.clear();
      };
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
          const modeAtStart = mode;
          const result = await scanSelection(params, {
            mode: modeAtStart,
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
          if (mode !== modeAtStart) {
            return;
          }
          scan = result;
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
        manualEl.innerHTML = '<p class="sil-warn"><b>Execução manual necessária:</b>' + (reason ? ` <span class="sil-manual-why">${escapeHtml(reason)}</span>` : "") + ` Dê duplo clique em <b>extract.command</b> na pasta de trabalho.</p><p class="sil-manual-path">${escapeHtml(scriptPath)}</p><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-open-folder>Abrir pasta</div></div>`;
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
          diagOut.innerHTML = '<p class="sil-diag-wait">' + escapeHtml(cause instanceof Error ? cause.message : String(cause)) + "</p>";
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
        } else if (scan && scan.readyCount > 0 && !result.snapshot) {
          context.setApplyEnabled(true);
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
      cancelActiveScan$1 = () => {
        cancelRequested = true;
      };
      syncSliders();
      syncPresetRail();
      syncMode();
    },
    unmount() {
      cancelActiveScan$1?.();
      cancelActiveScan$1 = null;
      releaseSliders$1?.();
      releaseSliders$1 = null;
    }
  };
  function markup$4(params) {
    const presets = SILENCE_PRESETS.map(
      (preset) => `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}">${preset.name}</div>`
    ).join("");
    const sliderFor = (spec) => `<div class="field" data-field="${spec.key}" hidden><div class="field-head"><span class="t-label">${spec.label}</span><span class="field-val" data-out="${spec.key}">${formatParam(
      spec,
      params[spec.key]
    )}</span></div><div class="slider-row"><div data-slider="${spec.key}"></div></div><p class="field-note">${escapeHtml(spec.note)}</p></div>`;
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
    )}</span>` : `<span class="sil-row-skip">${escapeHtml(
      clip.status === "error" && clip.detail ? clip.detail : label
    )}</span>`;
    return `<div class="sil-row-group${clip.status === "ready" ? " is-ready" : ""}"><div class="sil-row"><span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
      clip.name
    )}</span>` + detail + "</div></div>";
  }
  function renderDiagnostic(lines) {
    return '<div class="sil-diag-list">' + lines.map(
      (line) => `<div class="sil-diag-row${line.ok ? "" : " is-bad"}"><span class="sil-diag-mark">${line.ok ? "✓" : "✕"}</span><span class="sil-diag-label">${escapeHtml(line.label)}</span><span class="sil-diag-detail">${escapeHtml(line.detail)}</span></div>`
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
    return `<div class="org-done"><p class="org-done-title">Silêncios cortados ✓</p><p class="org-done-desc">${escapeHtml(message)}</p><p class="org-done-desc" style="opacity: 0.7; font-size: 10.5px;">Dica: Selecione o espaço vazio na timeline e use <b>Shift+Delete</b> (Ripple Delete) para fechar os cortes.</p></div>`;
  }
  function commitTransaction$1(project2, label, build) {
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
  const CAPTION_EXTS = /* @__PURE__ */ new Set([
    "srt",
    "vtt",
    "sbv",
    "sub",
    "ass",
    "ssa",
    "dfxp",
    "scc",
    "mcc",
    "stl"
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
    if (CAPTION_EXTS.has(ext)) return "caption";
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
      const seconds2 = media?.duration?.seconds;
      if (typeof seconds2 === "number" && Number.isFinite(seconds2) && seconds2 > 0) {
        return seconds2;
      }
    } catch {
    }
    try {
      const audio = ppro.Constants.MediaType.AUDIO;
      const inPoint = await clip.getInPoint(audio);
      const outPoint = await clip.getOutPoint(audio);
      const seconds2 = outPoint.seconds - inPoint.seconds;
      return Number.isFinite(seconds2) && seconds2 > 0 ? seconds2 : null;
    } catch {
      return null;
    }
  }
  async function audioKindOf(ppro, clip, name, mediaPath) {
    const folder = folderPartOf(mediaPath);
    const seconds2 = await audioSeconds(ppro, clip);
    const decided = (() => {
      if (SFX_HINTS.test(folder)) return "sfx";
      if (MUSIC_HINTS.test(folder)) return "music";
      if (SFX_HINTS.test(name)) return "sfx";
      if (MUSIC_HINTS.test(name)) return "music";
      if (seconds2 !== null) {
        if (seconds2 >= MUSIC_MIN_SECONDS) return "music";
        if (seconds2 <= SFX_MAX_SECONDS) return "sfx";
        return null;
      }
      const ext = extensionOf(mediaPath || name);
      return MUSIC_LEANING_EXTS.has(ext) ? "music" : null;
    })();
    console.log(
      `[Organize] audio "${name}" | ${seconds2 === null ? "duração ilegível" : `${seconds2.toFixed(1)}s`} | pasta "${folder}" | -> ${decided ?? "solto em Audio"}`
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
    caption: "Legendas",
    premiere: "Itens do Premiere",
    other: "Outros"
  };
  const TOP_CATEGORY_ORDER = [
    "sequence",
    "video",
    "audio",
    "image",
    "graphics",
    "caption",
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
  function isNestedSequenceName(name) {
    if (!name) return false;
    const lower = name.toLowerCase().trim();
    if (lower.includes("nested") || lower.includes("aninhad") || lower.includes("anidad") || lower.includes("imbriqu") || lower.includes("nidificat") || lower.includes("gefaltet")) {
      return true;
    }
    const tokens = lower.split(/[^a-z0-9\u00C0-\u017F]+/);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === "nest" || token === "nests" || token === "subseq" || token === "subseqs" || token === "subsequence" || token === "subsequences" || token === "subsequencia" || token === "subsequencias" || token === "subsequência" || token === "subsequências") {
        return true;
      }
      if (token === "sub" && i + 1 < tokens.length && (tokens[i + 1] === "seq" || tokens[i + 1] === "seqs" || tokens[i + 1] === "sequence" || tokens[i + 1] === "sequences" || tokens[i + 1] === "sequencia" || tokens[i + 1] === "sequencias" || tokens[i + 1] === "sequência" || tokens[i + 1] === "sequências")) {
        return true;
      }
    }
    return false;
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
    const projectSequenceGuids = /* @__PURE__ */ new Set();
    const projectSequenceNames = /* @__PURE__ */ new Set();
    let projectSequences = [];
    try {
      projectSequences = await project2.getSequences();
      for (const seq of projectSequences) {
        try {
          if (seq.guid) projectSequenceGuids.add(String(seq.guid));
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
    const nestedDetection = await detectNestedSequences(
      ppro,
      projectSequences,
      projectSequenceNames
    );
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
      const hasRealMedia = mediaPath !== "" && (VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext) || IMAGE_EXTS.has(ext) || GRAPHICS_EXTS.has(ext) || CAPTION_EXTS.has(ext));
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
        const isNestedByName = isNestedSequenceName(name);
        const isNestedByTimeline = nestedDetection.ids.has(id) || nestedDetection.names.has(name.trim().toLowerCase()) || ownGuid !== null && nestedDetection.guids.has(ownGuid);
        const isNested = isNestedByName || isNestedByTimeline;
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
      isSequence=${claimsSequence} contentType=${String(contentTypeRaw)} guid=${ownGuid ?? "—"} noProjeto=${ownGuid !== null && projectSequenceGuids.has(ownGuid)} nomeNaLista=${projectSequenceNames.has(name)} isNestedByName=${isNestedSequenceName(name)} isNestedByTimeline=${nestedDetection.ids.has(id) || nestedDetection.names.has(name.trim().toLowerCase())}
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
      caption: 0,
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
      if (members.length >= 2 && !isNestedSequenceName(base)) {
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
  async function detectNestedSequences(ppro, sequences, projectSequenceNames) {
    const ids = /* @__PURE__ */ new Set();
    const names = /* @__PURE__ */ new Set();
    const guids = /* @__PURE__ */ new Set();
    const verdicts = /* @__PURE__ */ new Map();
    const scanTrack = async (track) => {
      if (!track) return;
      try {
        const items = track.getTrackItems(
          ppro.Constants.TrackItemType.CLIP,
          false
        );
        for (const ti of items) {
          try {
            try {
              const rawTiName = await Promise.resolve(ti.getName?.()).catch(() => "");
              const tiName = (rawTiName ?? "").trim();
              if (tiName && projectSequenceNames.has(tiName)) {
                names.add(tiName.toLowerCase());
              }
            } catch {
            }
            const pi = await ti.getProjectItem();
            if (!pi) continue;
            const id = pi.getId();
            const piName = (pi.name ?? "").trim();
            if (piName && projectSequenceNames.has(piName)) {
              names.add(piName.toLowerCase());
            }
            let isSub = verdicts.get(id);
            if (isSub === void 0) {
              let claimsSeq = false;
              try {
                const clip = ppro.ClipProjectItem.cast(pi);
                claimsSeq = await clip.isSequence();
              } catch {
                claimsSeq = false;
              }
              isSub = claimsSeq || piName !== "" && projectSequenceNames.has(piName);
              verdicts.set(id, isSub);
            }
            if (isSub) {
              ids.add(id);
              if (piName) {
                names.add(piName.toLowerCase());
              }
              try {
                const clip = ppro.ClipProjectItem.cast(pi);
                const own = await clip.getSequence();
                if (own && own.guid) {
                  guids.add(String(own.guid));
                }
              } catch {
              }
            }
          } catch {
          }
        }
      } catch {
      }
    };
    for (const seq of sequences) {
      try {
        const videoTrackCount = await seq.getVideoTrackCount();
        for (let t = 0; t < videoTrackCount; t++) {
          await scanTrack(await seq.getVideoTrack(t));
        }
        const audioTrackCount = await seq.getAudioTrackCount();
        for (let t = 0; t < audioTrackCount; t++) {
          await scanTrack(await seq.getAudioTrack(t));
        }
      } catch {
      }
    }
    return { ids, names, guids };
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
        ["caption", scan.counts.caption],
        ["premiere", scan.counts.premiere],
        ["other", scan.counts.other]
      ];
      let plannedTop = 0;
      const topCreated = commitTransaction$1(
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
      const subCreated = commitTransaction$1(
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
      const moved = commitTransaction$1(project2, "Organizar Projeto — Mover Itens", (tx) => {
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
        message: `Falha ao ${phase}: ${describeError$1(cause)}`,
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
      const restored = commitTransaction$1(
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
        binsRemoved = commitTransaction$1(
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
        message: `Falha ao desfazer: ${describeError$1(cause)}`,
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
    caption: "💬",
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
    usesSelection: false,
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
              html += `<span class="org-group-name">${escapeHtml(group.base)}</span>`;
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
            html += `<span class="org-cat-name">${escapeHtml(label)}</span>`;
            html += `<span class="org-cat-count">${count}</span>`;
            html += `</div>`;
            const items = scan.items.filter((i) => i.category === cat);
            if (cat === "audio" && (scan.audioKindCounts.music > 0 || scan.audioKindCounts.sfx > 0)) {
              for (const kind of ["music", "sfx"]) {
                const group = items.filter((i) => i.audioKind === kind);
                if (group.length === 0) continue;
                html += `<div class="org-group">`;
                html += `<span class="org-group-name">${escapeHtml(AUDIO_KIND_LABELS[kind])}</span>`;
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
          html += `<div class="org-item" title="${escapeHtml(item.name)}">`;
          html += `<span class="org-item-name">${escapeHtml(item.name)}</span>`;
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
        if (scan.counts.caption > 0) catStats.push({ label: "Legendas", count: scan.counts.caption });
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
        (option) => `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml(option.id)}" aria-pressed="${option.id === selected}"><span class="dl-menu-name">${escapeHtml(option.label)}</span><span class="dl-menu-meta">${escapeHtml(option.meta ?? "")}</span></div>`
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
  const q$1 = shellQuote;
  const RESULT_FILE$1 = "dl-result.json";
  const PROGRESS_FILE = "dl-progress.txt";
  const LOG_FILE = "dl-log.txt";
  const FILES_FILE = "dl-files.txt";
  const STARTED_FILE$1 = "dl-started.txt";
  const CONFIG_FILE$1 = "download-config.json";
  const SCRIPT_FILE$1 = "download.command";
  const SCRIPT_FILE_WIN$1 = "download.bat";
  const LOCAL_BIN = "yt-dlp";
  const LOCAL_BIN_WIN = "yt-dlp.exe";
  function infoFile(index) {
    return `dl-info-${index}.json`;
  }
  function scriptName$1() {
    return isWindows() ? SCRIPT_FILE_WIN$1 : SCRIPT_FILE$1;
  }
  const POLL_MS$1 = 250;
  const PROBE_TIMEOUT_MS = 8 * 60 * 1e3;
  const DOWNLOAD_TIMEOUT_MS = 90 * 60 * 1e3;
  const INSTALL_TIMEOUT_MS = 5 * 60 * 1e3;
  const DEFAULT_CONFIG = {
    ytdlpPath: "",
    destination: "",
    destinationToken: "",
    quality: "best",
    cookies: "none",
    importToProject: true
  };
  async function readConfig$1() {
    try {
      const raw = readText(await workspace(), CONFIG_FILE$1);
      if (!raw) {
        return { ...DEFAULT_CONFIG };
      }
      const parsed = JSON.parse(raw);
      return {
        ytdlpPath: typeof parsed.ytdlpPath === "string" ? parsed.ytdlpPath : "",
        destination: typeof parsed.destination === "string" ? parsed.destination : "",
        destinationToken: typeof parsed.destinationToken === "string" ? parsed.destinationToken : "",
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
  async function writeConfig$1(config) {
    try {
      await write(await workspace(), CONFIG_FILE$1, JSON.stringify(config, null, 2));
    } catch (cause) {
      console.error("[Download] não foi possível salvar a configuração:", cause);
    }
  }
  async function defaultDestination() {
    const home = uxpModule("os")?.homedir?.() ?? "";
    if (!home) {
      return (await workspace()).nativeBase;
    }
    return isWindows() ? join(home, "Videos", "Framelab") : join(home, "Movies", "Framelab");
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
  function text$1(value) {
    return typeof value === "string" ? value : "";
  }
  function num$2(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function shortSide(format) {
    const width = num$2(format.width);
    const height = num$2(format.height);
    if (width !== null && width > 0 && height !== null && height > 0) {
      return Math.min(width, height);
    }
    return height !== null && height > 0 ? height : null;
  }
  function isWatermarked(format) {
    const haystack = `${text$1(format.format_id)} ${text$1(format.format_note)}`;
    return /water\s*mark|wm\b/i.test(haystack);
  }
  function parseProbe(url, raw) {
    const empty2 = {
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
      return { ...empty2, error: "Resposta ilegível do yt-dlp." };
    }
    if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length > 0) {
      info = info.entries[0];
    }
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const duration = num$2(info.duration);
    const sizeByResolution = {};
    const resolutions = /* @__PURE__ */ new Set();
    let hadWatermarked = false;
    let bestAudioBytes = 0;
    for (const format of formats) {
      if (isWatermarked(format)) {
        hadWatermarked = true;
        continue;
      }
      const hasVideo = text$1(format.vcodec) !== "none" && text$1(format.vcodec) !== "";
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
      title: text$1(info.title) || url,
      id: text$1(info.id),
      site: text$1(info.extractor_key) || text$1(info.extractor),
      uploader: text$1(info.uploader) || text$1(info.channel) || null,
      durationSeconds: duration,
      resolutions: [...resolutions].sort((a, b) => b - a),
      sizeByResolution,
      hadWatermarked
    };
  }
  function hasAudioAt(formats, resolution) {
    return formats.some(
      (format) => shortSide(format) === resolution && text$1(format.acodec) !== "none" && text$1(format.acodec) !== "" && !isWatermarked(format)
    );
  }
  function estimateBytes(format, durationSeconds) {
    const exact = num$2(format.filesize) ?? num$2(format.filesize_approx);
    if (exact !== null && exact > 0) {
      return exact;
    }
    const tbr = num$2(format.tbr);
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
  let previousRunFiles = [];
  async function run(launch) {
    const shell = shellModule();
    if (!shell) {
      return fail("uxp-unavailable", null);
    }
    const space = await workspace();
    const scriptPath = nativePath(space, scriptName$1());
    const tag = Date.now().toString(36);
    const runFiles = {
      result: `dl-${tag}-result.json`,
      progress: `dl-${tag}-progress.txt`,
      log: `dl-${tag}-log.txt`,
      files: `dl-${tag}-files.txt`,
      started: `dl-${tag}-started.txt`
    };
    for (const name of [
      ...Object.values(runFiles),
      ...previousRunFiles,
      RESULT_FILE$1,
      PROGRESS_FILE,
      LOG_FILE,
      FILES_FILE,
      STARTED_FILE$1,
      ...launch.stale
    ]) {
      await remove(space, name);
    }
    previousRunFiles = Object.values(runFiles);
    const script = launch.build(space).split(RESULT_FILE$1).join(runFiles.result).split(PROGRESS_FILE).join(runFiles.progress).split(LOG_FILE).join(runFiles.log).split(FILES_FILE).join(runFiles.files).split(STARTED_FILE$1).join(runFiles.started);
    await write(space, scriptName$1(), script, true);
    let launchError = null;
    const sent = await dispatch(scriptName$1());
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Download] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, launch.purpose);
      } catch (cause) {
        launchError = describe(cause);
        console.error("[Download] openPath recusou:", cause);
        launch.onManual?.(scriptPath, launchError);
      }
    }
    const stampDeadline = Date.now() + 8e3;
    const deadline = Date.now() + launch.timeoutMs;
    let lastSignature = "";
    let tick = 0;
    while (Date.now() < deadline) {
      tick += 1;
      if (launch.cancelled?.()) {
        return { ...fail("cancelled", scriptPath) };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        awaitingStamp = false;
        if (!readText(space, runFiles.started)) {
          console.warn("[Download] sem carimbo do agente — caindo para o Terminal.");
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, launch.purpose);
          } catch (cause) {
            launchError = describe(cause);
            launch.onManual?.(scriptPath, launchError);
          }
        }
      }
      if (launch.onProgress && tick % 4 === 0) {
        const log = tail(space, runFiles.log);
        const done = readProgress(space, runFiles.progress);
        const percent = readPercent(log);
        const signature = `${done}|${percent}|${log.length}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          launch.onProgress(done, launch.total, percent, log);
        }
      }
      const raw = readText(space, runFiles.result);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          return {
            ok: parsed.ok === true,
            error: parsed.ok === true ? null : parsed.error ?? "ytdlp-failed",
            ytdlpPath: typeof parsed.ytdlp === "string" ? parsed.ytdlp : null,
            scriptPath,
            failed: typeof parsed.failed === "number" ? parsed.failed : 0,
            log: tail(space, runFiles.log),
            filesFile: runFiles.files
          };
        } catch {
        }
      }
      await wait$1(POLL_MS$1);
    }
    return {
      ...fail(launchError ? `launch-denied: ${launchError}` : "timeout", scriptPath),
      log: tail(space, runFiles.log)
    };
  }
  function fail(error, scriptPath) {
    return { ok: false, error, ytdlpPath: null, scriptPath, failed: 0, log: "" };
  }
  function readProgress(space, name) {
    const raw = readText(space, name);
    const parsed = Number.parseInt(raw?.split("/")[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function tail(space, name, lines = 12) {
    const raw = readText(space, name);
    if (!raw) {
      return "";
    }
    const slice = raw.length > 4096 ? raw.slice(-4096) : raw;
    return slice.split(/\r?\n/).slice(-lines).join("\n");
  }
  function readPercent(log) {
    const matches = log.match(/(\d{1,3}(?:\.\d)?)%/g);
    if (!matches || matches.length === 0) {
      return null;
    }
    const value = Number.parseFloat(matches[matches.length - 1]);
    return Number.isFinite(value) ? Math.min(100, value) : null;
  }
  function complaintsByIndex(urls, log) {
    const lines = log.split(/\r?\n/).filter((line) => line.startsWith("ERROR:"));
    const out = /* @__PURE__ */ new Map();
    const orphans = [];
    for (const line of lines) {
      const index = urls.findIndex((url, at) => !out.has(at) && mentions(line, url));
      if (index >= 0) {
        out.set(index, shortReason(line));
      } else {
        orphans.push(line);
      }
    }
    if (urls.length === 1 && !out.has(0) && orphans.length > 0) {
      out.set(0, shortReason(orphans[orphans.length - 1]));
    }
    return out;
  }
  function mentions(line, url) {
    if (url.length > 0 && line.includes(url)) {
      return true;
    }
    const id = /^ERROR:\s*\[[^\]]+\]\s*([^\s:]+):/.exec(line)?.[1];
    return !!id && id.length >= 4 && url.includes(id);
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
    const complaints = complaintsByIndex(urls, result.log);
    const probes = urls.map((url, index) => {
      const raw = readText(space, infoFile(index));
      if (!raw) {
        return {
          url,
          ok: false,
          // O log SABE por que este link falhou — "Private video",
          // "Unsupported URL", o que for. A linha da lista dizia sempre
          // "não conseguiu ler este link" e jogava fora o diagnóstico,
          // enquanto a barra de status logo abaixo mostrava o motivo
          // certo: duas mensagens contraditórias na mesma tela, e a
          // errada era justamente a que fica colada no link.
          error: complaints.get(index) ?? "não foi possível ler",
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
  async function downloadUrls(urls, quality, config, direct = [], onProgress, cancelled, onManual) {
    const destination = config.destination || await defaultDestination();
    const customFfmpeg = urls.length > 0 ? (await readConfig$2()).ffmpegPath : "";
    const result = await run({
      build: (space2) => isWindows() ? downloadScriptWin(urls, quality, config, space2.nativeBase, destination, direct, customFfmpeg) : downloadScriptUnix(urls, quality, config, space2.nativeBase, destination, direct, customFfmpeg),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      stale: [],
      onProgress,
      total: urls.length + direct.length,
      cancelled,
      onManual,
      purpose: "Baixar os vídeos dos links informados."
    });
    const space = await workspace();
    const listed = readText(space, result.filesFile ?? FILES_FILE);
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
  function unixBase(folder) {
    return [
      "#!/bin/bash",
      "# Gerado pelo Framelab — Baixar Vídeos. Pode apagar.",
      `printf '\\033]0;Framelab — baixando\\007'`,
      // Nativo, custe o que custar: sob Rosetta o whisper e o ffmpeg rodam
      // emulados e uma transcrição de minutos vira uma de dezenas.
      'if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && command -v arch >/dev/null 2>&1; then exec arch -arm64 /bin/bash "$0" "$@"; fi',
      "set -u",
      `WORK=${q$1(folder)}`,
      'cd "$WORK" || exit 1',
      `printf 1 > "$WORK/${STARTED_FILE$1}"`,
      // Com set -u, o result.json cita $YTDLP mesmo quando o lote não
      // precisou dele.
      "YTDLP=''"
    ];
  }
  function unixYtdlpSetup(config) {
    return [
      `CUSTOM=${q$1(config.ytdlpPath)}`,
      // A ordem procura primeiro o que o editor escolheu, depois o
      // binário que o botão "Instalar" deixa aqui, e só então os lugares
      // do Homebrew, do MacPorts e do pip — que num shell não interativo
      // podem nem estar no PATH.
      'for candidate in "$CUSTOM" "$HOME/Library/Application Support/Framelab/bin/yt-dlp" "/Library/Application Support/Framelab/bin/yt-dlp" "$WORK/yt-dlp" /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp /opt/local/bin/yt-dlp "$HOME/.local/bin/yt-dlp"; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then YTDLP="$candidate"; break; fi',
      "done",
      'if [ -z "$YTDLP" ]; then YTDLP="$(command -v yt-dlp 2>/dev/null || true)"; fi',
      // Não achou? Baixa e segue na MESMA execução. O usuário final não
      // instala ferramenta: o painel se prepara sozinho na primeira vez.
      'if [ -z "$YTDLP" ]; then',
      '  echo "Preparando o downloader (so na primeira vez)..."',
      `  echo "Preparando o downloader (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
      `  if curl -fsSL --retry 3 -o "$WORK/yt-dlp.tmp" ${q$1(RELEASE_MAC)} 2>> "$WORK/${LOG_FILE}"; then`,
      '    chmod +x "$WORK/yt-dlp.tmp"',
      // Sem tirar a quarentena, a primeira execução morre num diálogo
      // do Gatekeeper que o painel nunca veria.
      '    xattr -d com.apple.quarantine "$WORK/yt-dlp.tmp" >/dev/null 2>&1 || true',
      '    mv "$WORK/yt-dlp.tmp" "$WORK/yt-dlp"',
      '    if "$WORK/yt-dlp" --version >/dev/null 2>&1; then YTDLP="$WORK/yt-dlp"; fi',
      "  fi",
      "fi",
      'if [ -z "$YTDLP" ]; then',
      `  printf '{"ok":false,"error":"ytdlp-not-found"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      `  mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      '  echo "Nao foi possivel baixar o yt-dlp. Verifique a internet e tente de novo."',
      "  exit 1",
      "fi",
      'echo "yt-dlp: $YTDLP"',
      // O runtime JS. Sem ele o YouTube ainda responde, mas pelo caminho
      // deprecado: mais lento e com formatos faltando.
      "DENO=''",
      'for candidate in "$WORK/deno" /opt/homebrew/bin/deno /usr/local/bin/deno "$HOME/.deno/bin/deno"; do',
      '  if [ -x "$candidate" ]; then DENO="$candidate"; break; fi',
      "done",
      'if [ -z "$DENO" ]; then DENO="$(command -v deno 2>/dev/null || true)"; fi',
      'if [ -z "$DENO" ]; then',
      '  echo "Preparando o motor de extracao (so na primeira vez)..."',
      `  echo "Preparando o motor de extracao (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
      `  if [ "$(uname -m)" = "arm64" ]; then DURL=${q$1(DENO_MAC_ARM)}; else DURL=${q$1(DENO_MAC_INTEL)}; fi`,
      `  if curl -fsSL --retry 3 -o "$WORK/deno.zip" "$DURL" 2>> "$WORK/${LOG_FILE}"; then`,
      `    unzip -o -q "$WORK/deno.zip" deno -d "$WORK" >> "$WORK/${LOG_FILE}" 2>&1`,
      '    rm -f "$WORK/deno.zip"',
      '    chmod +x "$WORK/deno" 2>/dev/null',
      '    xattr -d com.apple.quarantine "$WORK/deno" >/dev/null 2>&1 || true',
      '    if "$WORK/deno" --version >/dev/null 2>&1; then DENO="$WORK/deno"; fi',
      "  fi",
      "fi"
    ];
  }
  function unixFfmpeg(customFfmpeg) {
    return [
      // O caminho que o editor configurou no Corte de Silêncios vem
      // primeiro: era honrado lá e ignorado aqui, e o mesmo binário
      // serve os dois.
      `FFCUSTOM=${q$1(customFfmpeg)}`,
      "FFMPEG=''",
      'for candidate in "$FFCUSTOM" "$HOME/Library/Application Support/Framelab/bin/ffmpeg" "/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
      '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      // Na falta, baixa o build estático da arquitetura. A falha aqui é
      // um rebaixamento, não um fim: sem ffmpeg o yt-dlp ainda entrega
      // TikTok inteiro e YouTube até onde existe formato progressivo.
      'if [ -z "$FFMPEG" ]; then',
      '  echo "Preparando o ffmpeg (so na primeira vez)..."',
      `  echo "Preparando o ffmpeg (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
      `  if [ "$(uname -m)" = "arm64" ]; then FFURL=${q$1(FFMPEG_MAC_ARM)}; else FFURL=${q$1(FFMPEG_MAC_INTEL)}; fi`,
      `  if curl -fsSL --retry 3 -o "$WORK/ffmpeg.zip" "$FFURL" 2>> "$WORK/${LOG_FILE}" || curl -fsSL --retry 2 -o "$WORK/ffmpeg.zip" ${q$1(FFMPEG_MAC_RESERVE)} 2>> "$WORK/${LOG_FILE}"; then`,
      `    unzip -o -q "$WORK/ffmpeg.zip" ffmpeg -d "$WORK" >> "$WORK/${LOG_FILE}" 2>&1`,
      '    rm -f "$WORK/ffmpeg.zip"',
      '    chmod +x "$WORK/ffmpeg" 2>/dev/null',
      '    xattr -d com.apple.quarantine "$WORK/ffmpeg" >/dev/null 2>&1 || true',
      '    if "$WORK/ffmpeg" -version >/dev/null 2>&1; then FFMPEG="$WORK/ffmpeg"; fi',
      "  fi",
      "fi",
      'if [ -z "$FFMPEG" ]; then echo "ffmpeg indisponivel: qualidades altas podem sair menores."; fi',
      "FFDIR=''",
      'if [ -n "$FFMPEG" ]; then FFDIR="$(dirname "$FFMPEG")"; fi'
    ];
  }
  const UNIX_CLOSE = [
    'echo "Pronto. Pode voltar ao Premiere."',
    // Fecha só a própria janela, achada pelo título posto no preâmbulo.
    // Se o macOS negar a automação, a janela fica aberta e nada quebra.
    // Só fecha janela se o Terminal JÁ estiver aberto. `tell application
    // "Terminal"` LANÇA o Terminal quando ele não está rodando — era isto
    // que fazia uma janela vazia aparecer no FIM de cada trabalho, mesmo
    // com o agente silencioso funcionando.
    `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`,
    "exit 0"
  ];
  function probeScriptUnix(urls, config, folder) {
    const lines = [...unixBase(folder), ...unixYtdlpSetup(config)];
    lines.push("FAILED=0");
    urls.forEach((url, index) => {
      const target = `"$WORK/${infoFile(index)}"`;
      lines.push(
        `echo "[${index + 1}/${urls.length}] consultando…"`,
        `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
        `if "$YTDLP" --no-warnings --no-playlist --ignore-config --extractor-retries 5 --retry-sleep extractor:3 \${DENO:+--js-runtimes "deno:$DENO"} ${cookiesArg(config)}-J ${q$1(url)} > ${target}.tmp 2>> "$WORK/${LOG_FILE}"; then`,
        `  mv ${target}.tmp ${target}`,
        "else",
        "  FAILED=$((FAILED+1))",
        `  rm -f ${target}.tmp`,
        "fi"
      );
    });
    lines.push(
      `printf '{"ok":true,"ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE$1}.tmp"`,
      `mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      ...UNIX_CLOSE
    );
    return lines.join("\n") + "\n";
  }
  function downloadScriptUnix(urls, quality, config, folder, destination, direct = [], customFfmpeg = "") {
    const lines = unixBase(folder);
    if (urls.length > 0) {
      lines.push(...unixYtdlpSetup(config), ...unixFfmpeg(customFfmpeg));
    }
    lines.push(`DEST=${q$1(destination)}`, 'mkdir -p "$DEST"', "FAILED=0");
    const total = direct.length + urls.length;
    direct.forEach((job, index) => {
      const target = `"$DEST/"${q$1(job.fileName)}`;
      lines.push(
        `echo "[${index + 1}/${total}] ${escapeEcho(job.fileName)}"`,
        `printf '%s/%s' ${index + 1} ${total} > "$WORK/${PROGRESS_FILE}"`,
        `if curl -fL --progress-bar --retry 3 -o ${target} ${q$1(job.mediaUrl)} 2>> "$WORK/${LOG_FILE}"; then`,
        `  printf '%s\\n' "$DEST/"${q$1(job.fileName)} >> "$WORK/${FILES_FILE}"`,
        "else",
        "  FAILED=$((FAILED+1))",
        `  echo "ERROR: download direto falhou: ${escapeEcho(job.sourceUrl)}" >> "$WORK/${LOG_FILE}"`,
        `  rm -f ${target}`,
        "fi"
      );
    });
    const shared = `--newline --no-mtime --no-playlist --ignore-config --windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 --extractor-retries 5 --retry-sleep extractor:3 \${DENO:+--js-runtimes "deno:$DENO"} -o ${q$1("%(title)s [%(id)s].%(ext)s")} --print-to-file after_move:filepath ${q$1(FILES_FILE)} ` + cookiesArg(config);
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${q$1(formatSelector(quality))}` : (
      // mp4 porque o destino é uma timeline do Premiere, e um webm/vp9
      // entra lá para arrastar a reprodução.
      `-f ${q$1(formatSelector(quality))} ${sort ? `-S ${q$1(sort)} ` : ""}--merge-output-format mp4`
    );
    urls.forEach((url, index) => {
      const step2 = direct.length + index + 1;
      lines.push(
        `echo "[${step2}/${total}] ${escapeEcho(url)}"`,
        `printf '%s/%s' ${step2} ${total} > "$WORK/${PROGRESS_FILE}"`,
        // `${FFDIR:+…}` some inteiro quando não há ffmpeg, em vez de
        // passar uma flag com valor vazio — que o yt-dlp recusa.
        `"$YTDLP" ${shared} ${media} -P "$DEST" \${FFDIR:+--ffmpeg-location "$FFDIR"} ${q$1(url)} 2>&1 | tee -a "$WORK/${LOG_FILE}"`,
        // `tee` sempre devolve 0; quem falhou foi o yt-dlp, e é o status
        // dele que o PIPESTATUS guarda.
        'if [ "${PIPESTATUS[0]}" -ne 0 ]; then FAILED=$((FAILED+1)); fi'
      );
    });
    lines.push(
      // O caminho relativo do --print-to-file é à prova do sanitizador,
      // mas o yt-dlp o resolve contra a pasta de destino (-P), não
      // contra o cwd — medido num download real. A colheita cobre os
      // dois comportamentos e não deixa arquivo de controle no destino.
      `if [ -f "$DEST/${FILES_FILE}" ]; then`,
      `  cat "$DEST/${FILES_FILE}" >> "$WORK/${FILES_FILE}"`,
      `  rm -f "$DEST/${FILES_FILE}"`,
      "fi",
      'if [ "$FAILED" -eq 0 ]; then',
      `  printf '{"ok":true,"ytdlp":"%s","failed":0}' "$YTDLP" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "else",
      `  printf '{"ok":false,"error":"ytdlp-failed","ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      ...UNIX_CLOSE
    );
    return lines.join("\n") + "\n";
  }
  const RELEASE_MAC = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  const RELEASE_WIN = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  const FFMPEG_MAC_ARM = "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip";
  const FFMPEG_MAC_INTEL = "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip";
  const FFMPEG_MAC_RESERVE = "https://evermeet.cx/ffmpeg/getrelease/zip";
  const FFMPEG_WIN = "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";
  const DENO_MAC_ARM = "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip";
  const DENO_MAC_INTEL = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip";
  const DENO_WIN = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
  function installScriptUnix(folder) {
    return [
      // A base comum traz o cd e o carimbo de início — sem ele, o
      // runner silencioso parecia morto e o painel abria um SEGUNDO
      // install no Terminal, os dois curl brigando pelo mesmo .tmp.
      ...unixBase(folder),
      `echo "Baixando o yt-dlp oficial…"`,
      // Sem tee: o `if` precisa medir o CURL, e `curl | tee` mede o
      // tee, que nunca falha — um download pela metade seguia o
      // caminho feliz e instalava um binário truncado.
      `if curl -fSL --retry 3 -o "$WORK/${LOCAL_BIN}.tmp" ${q$1(RELEASE_MAC)} 2>> "$WORK/${LOG_FILE}"; then`,
      `  chmod +x "$WORK/${LOCAL_BIN}.tmp"`,
      `  mv "$WORK/${LOCAL_BIN}.tmp" "$WORK/${LOCAL_BIN}"`,
      // O binário do macOS vem sem assinatura reconhecida pelo
      // Gatekeeper; sem tirar a quarentena, a primeira execução morre
      // num diálogo que o painel nunca veria.
      `  xattr -d com.apple.quarantine "$WORK/${LOCAL_BIN}" >/dev/null 2>&1 || true`,
      `  if "$WORK/${LOCAL_BIN}" --version >/dev/null 2>&1; then`,
      `    printf '{"ok":true,"ytdlp":"%s"}' "$WORK/${LOCAL_BIN}" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "  else",
      // O que não executa não pode ficar: um yt-dlp quebrado em
      // $WORK vence a busca de TODO script futuro.
      `    rm -f "$WORK/${LOCAL_BIN}"`,
      `    printf '{"ok":false,"error":"install-unusable"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      "  fi",
      "else",
      `  rm -f "$WORK/${LOCAL_BIN}.tmp"`,
      `  printf '{"ok":false,"error":"install-failed"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      ...UNIX_CLOSE
    ].join("\n") + "\n";
  }
  function cookiesArg(config) {
    return config.cookies === "none" ? "" : `--cookies-from-browser ${config.cookies} `;
  }
  function escapeEcho(value) {
    return value.replace(/["`$\\]/g, "").slice(0, 90);
  }
  function bq(value) {
    return `"${batValue(value)}"`;
  }
  function winBase(folder) {
    return [
      "@echo off",
      "rem Gerado pelo Framelab - Baixar Videos. Pode apagar.",
      "title Framelab - baixando",
      `set "WORK=${batValue(folder)}"`,
      'cd /d "%WORK%"',
      `>"%WORK%\\${STARTED_FILE$1}" echo 1`,
      'set "YTDLP="',
      "set FAILED=0"
    ];
  }
  function winYtdlpSetup(config) {
    return [
      `set "YTDLP=${batValue(config.ytdlpPath)}"`,
      `if "%YTDLP%"=="" if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
      `if "%YTDLP%"=="" for %%i in (yt-dlp.exe) do @set "YTDLP=%%~$PATH:i"`,
      'if "%YTDLP%"=="" (',
      "  echo Preparando o downloader (so na primeira vez)...",
      `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${RELEASE_WIN}' -OutFile '%WORK%\\${LOCAL_BIN_WIN}' -UseBasicParsing } catch { exit 1 }"`,
      `  if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
      ")",
      'if "%YTDLP%"=="" (',
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"ytdlp-not-found"}`,
      `  move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "  echo Nao foi possivel baixar o yt-dlp. Verifique a internet.",
      "  exit /b 1",
      ")",
      'set "DENO="',
      `if exist "%WORK%\\deno.exe" set "DENO=%WORK%\\deno.exe"`,
      'if "%DENO%"=="" for %%i in (deno.exe) do @set "DENO=%%~$PATH:i"',
      'if "%DENO%"=="" (',
      "  echo Preparando o motor de extracao (so na primeira vez)...",
      `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${DENO_WIN}' -OutFile '%WORK%\\deno.zip' -UseBasicParsing; Expand-Archive -Force '%WORK%\\deno.zip' '%WORK%\\dz'; Copy-Item '%WORK%\\dz\\deno.exe' '%WORK%\\deno.exe'; Remove-Item -Recurse -Force '%WORK%\\dz','%WORK%\\deno.zip' } catch { exit 1 }"`,
      `  if exist "%WORK%\\deno.exe" set "DENO=%WORK%\\deno.exe"`,
      ")",
      'set "JSARGS="',
      'if not "%DENO%"=="" set JSARGS=--js-runtimes "deno:%DENO%"'
    ];
  }
  function probeScriptWin(urls, config, folder) {
    const lines = [...winBase(folder), ...winYtdlpSetup(config)];
    urls.forEach((url, index) => {
      const target = `"%WORK%\\${infoFile(index)}"`;
      lines.push(
        `echo [${index + 1}/${urls.length}] consultando...`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
        `"%YTDLP%" --no-warnings --no-playlist --ignore-config --extractor-retries 5 --retry-sleep extractor:3 %JSARGS% ${cookiesArg(config)}-J ${bq(url)} > ${target} 2>>"%WORK%\\${LOG_FILE}"`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      `>"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":%FAILED%}`,
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function downloadScriptWin(urls, quality, config, folder, destination, direct = [], customFfmpeg = "") {
    const lines = winBase(folder);
    if (urls.length > 0) {
      lines.push(...winYtdlpSetup(config));
    }
    lines.push(
      `set "DEST=${batValue(destination)}"`,
      'if not exist "%DEST%" mkdir "%DEST%"'
    );
    const total = direct.length + urls.length;
    direct.forEach((job, index) => {
      lines.push(
        `echo [${index + 1}/${total}] ${batValue(job.fileName)}`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${total}`,
        `curl.exe -fSL --retry 3 -o "%DEST%\\${batValue(job.fileName)}" ${bq(job.mediaUrl)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
        "if errorlevel 1 (",
        "  set /a FAILED+=1",
        `  del /q "%DEST%\\${batValue(job.fileName)}" 2>nul`,
        ") else (",
        `  >>"%WORK%\\${FILES_FILE}" echo %DEST%\\${batValue(job.fileName)}`,
        ")"
      );
    });
    if (urls.length > 0) {
      lines.push(
        // ffmpeg: PATH vale, o provisionado vale, e na falta dos dois o
        // script baixa o build oficial do projeto yt-dlp. Falhar aqui não
        // derruba o download — só rebaixa a qualidade máxima.
        'set "FFLOC="',
        `set "FFCUSTOM=${batValue(customFfmpeg)}"`,
        'if exist "%FFCUSTOM%" set "FFLOC=CUSTOM"',
        'if "%FFLOC%"=="" for %%i in (ffmpeg.exe) do @if not "%%~$PATH:i"=="" set "FFLOC=SKIP"',
        `if exist "%WORK%\\ffmpeg.exe" set "FFLOC=%WORK%"`,
        'if "%FFLOC%"=="" (',
        "  echo Preparando o ffmpeg (so na primeira vez)...",
        `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${FFMPEG_WIN}' -OutFile '%WORK%\\ff.zip' -UseBasicParsing; Expand-Archive -Force '%WORK%\\ff.zip' '%WORK%\\ff'; Copy-Item '%WORK%\\ff\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe' '%WORK%\\ffmpeg.exe'; Remove-Item -Recurse -Force '%WORK%\\ff','%WORK%\\ff.zip' } catch { exit 1 }"`,
        `  if exist "%WORK%\\ffmpeg.exe" set "FFLOC=%WORK%"`,
        ")",
        'if "%FFLOC%"=="SKIP" set "FFLOC="',
        'set "FFARGS="',
        'if "%FFLOC%"=="CUSTOM" (set FFARGS=--ffmpeg-location "%FFCUSTOM%") else if not "%FFLOC%"=="" set FFARGS=--ffmpeg-location "%FFLOC%"'
      );
    }
    const shared = `--newline --no-mtime --no-playlist --ignore-config --windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 -o ${bq("%(title)s [%(id)s].%(ext)s")} --print-to-file after_move:filepath ${bq(FILES_FILE)} ` + cookiesArg(config);
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${bq(formatSelector(quality))}` : `-f ${bq(formatSelector(quality))} ${sort ? `-S ${bq(sort)} ` : ""}--merge-output-format mp4`;
    urls.forEach((url, index) => {
      const step2 = direct.length + index + 1;
      lines.push(
        `echo [${step2}/${total}]`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${step2}/${total}`,
        `"%YTDLP%" ${shared} ${media} -P "%DEST%" %FFARGS% %JSARGS% ${bq(url)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      `if exist "%DEST%\\${FILES_FILE}" (`,
      `  type "%DEST%\\${FILES_FILE}" >> "%WORK%\\${FILES_FILE}"`,
      `  del /q "%DEST%\\${FILES_FILE}"`,
      ")",
      'if "%FAILED%"=="0" (',
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":0}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"ytdlp-failed","failed":%FAILED%}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "exit /b 0"
    );
    return lines.join("\r\n") + "\r\n";
  }
  function installScriptWin(folder) {
    return [
      ...winBase(folder),
      "echo Baixando o yt-dlp oficial...",
      `powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${RELEASE_WIN}' -OutFile ('%WORK%\\${LOCAL_BIN_WIN}') -UseBasicParsing } catch { exit 1 }"`,
      "if errorlevel 1 (",
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"install-failed"}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ytdlp":"%WORK%\\${LOCAL_BIN_WIN}"}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
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
        return "O downloader não conseguiu se preparar sozinho — sem acesso ao GitHub para baixar o yt-dlp. Confira a internet e tente de novo.";
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
  const CAUSES = [
    {
      test: /unable to extract universal data|rehydration/i,
      short: "TikTok recusou",
      long: "O TikTok recusou a conversa desta vez — acontece em rajadas. Espere alguns segundos e tente de novo."
    },
    {
      test: /private video/i,
      short: "vídeo privado",
      long: "Esse vídeo é privado. Se você tem acesso a ele, escolha nos ajustes avançados o navegador onde está logado — o painel usa os cookies dele."
    },
    {
      test: /video unavailable|removed by the uploader/i,
      short: "vídeo removido",
      long: "O vídeo foi removido ou não está disponível."
    },
    {
      test: /age.?restrict/i,
      short: "restrição de idade",
      long: "Vídeo com restrição de idade — use os cookies do navegador nos ajustes avançados."
    },
    {
      test: /sign in to confirm|not a bot|cookies/i,
      short: "pede login",
      long: "O site pediu login. Nos ajustes avançados, escolha o navegador onde você já está logado para o yt-dlp usar os cookies dele."
    },
    {
      test: /ffmpeg is not installed|ffmpeg not found/i,
      short: "falta o ffmpeg",
      long: 'Falta o ffmpeg para juntar vídeo e áudio nesta qualidade. Instale com "brew install ffmpeg" ou escolha 1080p ou menos.'
    },
    {
      test: /unsupported url/i,
      short: "site não suportado",
      long: "O yt-dlp não reconhece esse link."
    },
    {
      test: /urlopen error|network|timed out|connection/i,
      short: "falha de rede",
      long: "Falha de rede durante o download."
    }
  ];
  function rawComplaint(log) {
    const errors = log.match(/^ERROR:.*$/gm);
    if (!errors || errors.length === 0) {
      return null;
    }
    return errors[errors.length - 1].replace(/^ERROR:\s*/, "").trim();
  }
  function diagnoseLog(log) {
    const cause = CAUSES.find((entry) => entry.test.test(log));
    if (cause) {
      return cause.long;
    }
    const raw = rawComplaint(log);
    return raw ? `O yt-dlp reclamou: ${raw.slice(0, 220)}` : "O yt-dlp não concluiu. O log abaixo diz onde parou.";
  }
  function shortReason(log) {
    const cause = CAUSES.find((entry) => entry.test.test(log));
    if (cause) {
      return cause.short;
    }
    const raw = rawComplaint(log);
    if (!raw) {
      return "não foi possível ler";
    }
    const clean = raw.replace(/^\[[^\]]+\]\s*[^\s:]*:\s*/, "");
    return clean.length > 30 ? `${clean.slice(0, 28)}…` : clean;
  }
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) {
      return "";
    }
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
  function formatClock(seconds2) {
    if (seconds2 === null || !Number.isFinite(seconds2) || seconds2 <= 0) {
      return "";
    }
    const whole = Math.round(seconds2);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole % 3600 / 60);
    const secs = whole % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }
  const API = "https://www.tikwm.com/api/";
  const BATCH_STEP_MS = 1100;
  const TIMEOUT_MS$1 = 8e3;
  function isTikTokUrl(url) {
    const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
    return /(^|\.)tiktok\.com$/i.test(host);
  }
  async function fetchTikTokFast(url) {
    try {
      const response = await withTimeout(
        fetch(`${API}?url=${encodeURIComponent(url)}&hd=1`, {
          headers: { Accept: "application/json" }
        })
      );
      if (!response || !response.ok) {
        return null;
      }
      const body = await withTimeout(response.json());
      if (!body || body.code !== 0 || !body.data) {
        return null;
      }
      const data = body.data;
      const playUrl = absolute(text(data.play));
      if (!playUrl) {
        return null;
      }
      return {
        id: text(data.id) || "tiktok",
        title: text(data.title) || "TikTok",
        durationSeconds: num$1(data.duration),
        playUrl,
        hdUrl: absolute(text(data.hdplay)),
        musicUrl: absolute(text(data.music)),
        sizeSd: num$1(data.size) ?? 0,
        sizeHd: num$1(data.hd_size) ?? 0
      };
    } catch {
      return null;
    }
  }
  async function fetchManyTikTok(urls) {
    const out = [];
    for (let index = 0; index < urls.length; index += 1) {
      if (index > 0) {
        await wait(BATCH_STEP_MS);
      }
      out.push(await fetchTikTokFast(urls[index]));
    }
    return out;
  }
  function tiktokFileName(info, extension) {
    const safe = info.title.replace(/[\\/:*?"<>|#%&{}$!@`'+=~\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
    return `${safe || "tiktok"} [${info.id}].${extension}`;
  }
  function withTimeout(promise) {
    return Promise.race([
      promise,
      wait(TIMEOUT_MS$1).then(() => null)
    ]);
  }
  function wait(ms) {
    return new Promise((resolve2) => setTimeout(resolve2, ms));
  }
  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function num$1(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function absolute(value) {
    if (!value) {
      return null;
    }
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    return `https://www.tikwm.com${value.startsWith("/") ? "" : "/"}${value}`;
  }
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const MAX_BYTES = 300 * 1024 * 1024;
  function stageError(stage, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(`${stage}: ${detail}`);
  }
  async function rememberFolderToken(entry) {
    try {
      const api = storageApi();
      if (!api?.lfs.createPersistentToken) {
        return null;
      }
      return await api.lfs.createPersistentToken(entry);
    } catch {
      return null;
    }
  }
  function storageApi() {
    const storage = uxpModule("uxp")?.storage;
    const lfs = storage?.localFileSystem;
    if (!lfs || typeof lfs.getEntryWithUrl !== "function") {
      return null;
    }
    return { lfs, binary: storage?.formats?.binary };
  }
  function fileUrl(nativePathValue) {
    return "file://" + nativePathValue.replace(/\\/g, "/").split("/").map((part) => encodeURIComponent(part)).join("/");
  }
  async function destinationFolder(destination, token) {
    const api = storageApi();
    if (!api) {
      throw new Error("destino: storage do UXP indisponível");
    }
    if (token && api.lfs.getEntryForPersistentToken) {
      try {
        const folder = await api.lfs.getEntryForPersistentToken(token);
        return { folder, binary: api.binary };
      } catch {
      }
    }
    try {
      try {
        const folder = await api.lfs.getEntryWithUrl(fileUrl(destination));
        return { folder, binary: api.binary };
      } catch {
      }
      const normalized = destination.replace(/\\/g, "/").replace(/\/+$/, "");
      const cut = normalized.lastIndexOf("/");
      if (cut <= 0) {
        throw new Error("sem pasta-mãe");
      }
      const parent = await api.lfs.getEntryWithUrl(fileUrl(normalized.slice(0, cut)));
      const leaf = normalized.slice(cut + 1);
      try {
        const folder = await parent.createFolder(leaf);
        return { folder, binary: api.binary };
      } catch {
        const existing = await parent.getEntry(leaf);
        return { folder: existing, binary: api.binary };
      }
    } catch (cause) {
      throw stageError("destino", cause);
    }
  }
  async function downloadInPanel(job, destination, token, onProgress) {
    const { folder, binary } = await destinationFolder(destination, token);
    let combined;
    try {
      combined = await fetchAllBytes(job.mediaUrl, onProgress);
    } catch (cause) {
      throw stageError("rede", cause);
    }
    try {
      const file = await folder.createFile(job.fileName, { overwrite: true });
      try {
        await file.write(
          combined.buffer,
          binary !== void 0 ? { format: binary } : void 0
        );
      } catch {
        await file.write(combined.buffer, { format: "binary" });
      }
      return file.nativePath ?? `${destination}/${job.fileName}`;
    } catch (cause) {
      throw stageError("escrita", cause);
    }
  }
  async function fetchAllBytes(mediaUrl, onProgress) {
    const parts = [];
    let received = 0;
    let total = null;
    for (; ; ) {
      const from = received;
      const to = from + CHUNK_BYTES - 1;
      let response;
      try {
        response = await fetch(mediaUrl, {
          headers: { Range: `bytes=${from}-${to}` }
        });
      } catch (cause) {
        if (from > 0) {
          throw cause;
        }
        response = await fetch(mediaUrl);
      }
      if (response.status === 200) {
        const whole = await response.arrayBuffer();
        if (whole.byteLength > MAX_BYTES) {
          throw new Error("arquivo grande demais para o painel");
        }
        parts.length = 0;
        parts.push(new Uint8Array(whole));
        received = whole.byteLength;
        total = received;
        onProgress?.(received, total);
        break;
      }
      if (response.status !== 206) {
        throw new Error(`CDN respondeu ${response.status}`);
      }
      const chunk = await response.arrayBuffer();
      parts.push(new Uint8Array(chunk));
      received += chunk.byteLength;
      if (total === null) {
        const range = response.headers.get("content-range");
        const match = range ? /\/(\d+)\s*$/.exec(range) : null;
        total = match ? Number.parseInt(match[1], 10) : null;
        if (total !== null && total > MAX_BYTES) {
          throw new Error("arquivo grande demais para o painel");
        }
      }
      onProgress?.(received, total);
      if (chunk.byteLength < CHUNK_BYTES || total !== null && received >= total) {
        break;
      }
    }
    if (received === 0) {
      throw new Error("CDN devolveu zero bytes");
    }
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    return combined;
  }
  async function fastLaneByIndex(list) {
    const positions = list.map((url, index) => ({ url, index })).filter((entry) => isTikTokUrl(entry.url));
    const infos = await fetchManyTikTok(positions.map((entry) => entry.url));
    const byIndex = /* @__PURE__ */ new Map();
    positions.forEach((entry, at) => {
      const info = infos[at];
      if (info) {
        byIndex.set(entry.index, info);
      }
    });
    return byIndex;
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
  let releaseDocument$2 = null;
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
        destinationToken: "",
        quality: "1080",
        cookies: "none",
        importToProject: true
      };
      let probes = [];
      let busy = false;
      let cancelled = false;
      container.innerHTML = markup$3();
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
      releaseDocument$2 = () => {
        document.removeEventListener("click", onDocumentPointer, true);
        document.removeEventListener("keydown", onDocumentKey, true);
      };
      context.setApplyLabel("BAIXAR");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      void (async () => {
        config = await readConfig$1();
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
        void writeConfig$1(config);
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
        showProgress("consulta", null, "lendo os links…");
        try {
          const fast = await fastLaneByIndex(list);
          const byIndex = /* @__PURE__ */ new Map();
          const slow = [];
          const slowAt = [];
          list.forEach((url, index) => {
            const info = fast.get(index);
            if (info) {
              byIndex.set(index, fastProbe(url, info));
            } else {
              slow.push(url);
              slowAt.push(index);
            }
          });
          let result = { ok: true, error: null, log: "", ytdlpPath: null };
          if (slow.length > 0) {
            const scripted = await probeUrls(
              slow,
              config,
              (done, total, _percent, log) => {
                showProgress(`${done}/${total}`, null);
                showLog(log);
              },
              () => cancelled,
              showManual
            );
            result = { ...result, ...scripted.result };
            scripted.probes.forEach((probe, at) => byIndex.set(slowAt[at], probe));
          }
          probes = list.map((_, index) => byIndex.get(index)).filter((p) => !!p);
          renderList();
          renderQualities();
          const ok = probes.filter((probe) => probe.ok).length;
          showLog(ok === probes.length && result.ok ? "" : result.log);
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
          context.setStatus(describeError$1(cause), "error");
        } finally {
          showProgress(null, null);
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
          const direct = [];
          const slow = [];
          const fast = await fastLaneByIndex(list);
          list.forEach((url, index) => {
            const info = fast.get(index) ?? null;
            const job = info ? directJobFor(url, info, quality) : null;
            if (job) {
              direct.push(job);
            } else {
              slow.push(url);
            }
          });
          const total = list.length;
          const panelFiles = [];
          const scriptDirect = [];
          const destination = config.destination || await defaultDestination();
          const tryPanel = async (job, step2) => {
            showProgress(step2, null, "conectando…");
            return downloadInPanel(
              job,
              config.destination || destination,
              config.destinationToken || null,
              (done, size) => {
                showProgress(
                  step2,
                  size ? done / size * 100 : null,
                  size ? `${formatBytes(done)} de ${formatBytes(size)}` : formatBytes(done)
                );
              }
            );
          };
          for (let index = 0; index < direct.length; index += 1) {
            const job = direct[index];
            const step2 = `${index + 1}/${total}`;
            try {
              panelFiles.push(await tryPanel(job, step2));
              continue;
            } catch (cause) {
              const reason = cause instanceof Error ? cause.message : String(cause);
              console.warn("[Download] painel recusou:", reason);
              if (reason.startsWith("destino") && !config.destinationToken) {
                context.setStatus("Escolha a pasta de destino — só desta vez.");
                await pickFolder();
                if (config.destinationToken) {
                  try {
                    panelFiles.push(await tryPanel(job, step2));
                    continue;
                  } catch (second) {
                    const again = second instanceof Error ? second.message : String(second);
                    console.warn("[Download] painel recusou de novo:", again);
                    showLog(`download em painel indisponível (${again}) — plano B.`);
                  }
                } else {
                  showLog(
                    `download em painel indisponível (${reason}) — plano B.`
                  );
                }
              } else {
                showLog(`download em painel indisponível (${reason}) — plano B.`);
              }
              scriptDirect.push(job);
            }
          }
          let outcome = {
            ok: true,
            error: null,
            failed: 0,
            log: "",
            files: []
          };
          if (slow.length > 0 || scriptDirect.length > 0) {
            const scripted = await downloadUrls(
              slow,
              quality,
              config,
              scriptDirect,
              (done, scriptTotal, percent, log) => {
                showProgress(
                  `${panelFiles.length + (done || 1)}/${total}`,
                  percent,
                  percent === null ? "trabalhando…" : ""
                );
                showLog(log);
              },
              () => cancelled,
              showManual
            );
            outcome = { ...outcome, ...scripted };
          }
          const files = [...panelFiles, ...outcome.files];
          showProgress(null, null);
          showLog(outcome.ok && outcome.failed === 0 ? "" : outcome.log);
          if (files.length === 0) {
            context.setStatus(
              describeRunError(outcome.error ?? "ytdlp-failed", outcome.log),
              "error"
            );
            return;
          }
          const imported = config.importToProject ? await importFiles(files) : null;
          const count = files.length;
          const head = `${count} ${count === 1 ? "arquivo baixado" : "arquivos baixados"}` + (outcome.failed > 0 ? ` · ${outcome.failed} falharam` : "");
          context.setStatus(
            imported === null ? head : `${head} · ${imported}`,
            outcome.failed > 0 ? "error" : "done"
          );
          renderFiles(files);
          context.setResetHandler(() => clearAll());
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
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
          return `falha ao importar: ${describeError$1(cause)}`;
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
          (file) => `<div class="dl-file" title="${escapeHtml(file)}"><span class="dl-file-name">${escapeHtml(baseName(file))}</span></div>`
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
          config.destinationToken = await rememberFolderToken(folder) ?? "";
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
          context.setStatus(describeError$1(cause), "error");
        } finally {
          if (installEl) installEl.textContent = "Reinstalar yt-dlp";
          endBusy();
        }
      }
      folderEl?.addEventListener("click", () => {
        void openWorkFolder().catch((cause) => {
          context.setStatus(describeError$1(cause), "error");
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
      function showProgress(step2, percent, detail = "") {
        if (!progressEl) return;
        if (step2 === null) {
          progressEl.hidden = true;
          progressEl.innerHTML = "";
          return;
        }
        progressEl.hidden = false;
        const waiting = percent === null;
        const width = waiting ? 30 : Math.max(0, Math.min(100, percent));
        const right = waiting ? detail || "…" : `${detail ? `${escapeHtml(detail)} · ` : ""}${width.toFixed(0)}%`;
        progressEl.innerHTML = `<div class="dl-bar${waiting ? " is-wait" : ""}"><span class="dl-bar-fill" style="width:${width.toFixed(1)}%"></span></div><div class="dl-bar-legend"><span>${escapeHtml(step2)}</span><span>${waiting ? escapeHtml(right) : right}</span></div>`;
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
        manualEl.innerHTML = `<p class="sil-manual-why">O sistema não executou o script (${escapeHtml(reason)}). Dê um duplo clique nele e volte — o painel continua esperando.</p><p class="sil-manual-path">${escapeHtml(scriptPath)}</p>`;
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
      releaseDocument$2?.();
      releaseDocument$2 = null;
    }
  };
  function fastProbe(url, info) {
    const resolutions = [];
    const sizeByResolution = {};
    if (info.hdUrl) {
      resolutions.push(1080);
      sizeByResolution[1080] = info.sizeHd;
    }
    resolutions.push(540);
    sizeByResolution[540] = info.sizeSd;
    return {
      url,
      ok: true,
      error: null,
      title: info.title,
      id: info.id,
      site: "TikTok",
      uploader: null,
      durationSeconds: info.durationSeconds,
      resolutions,
      sizeByResolution,
      // A via rápida entrega a cópia limpa por construção; o selo do
      // painel diz exatamente isso.
      hadWatermarked: true
    };
  }
  function directJobFor(url, info, quality) {
    if (quality.audioOnly) {
      if (!info.musicUrl) {
        return null;
      }
      return {
        mediaUrl: info.musicUrl,
        fileName: tiktokFileName(info, "mp3"),
        sourceUrl: url
      };
    }
    const wantsHd = quality.height === null || quality.height >= 720;
    return {
      mediaUrl: wantsHd && info.hdUrl ? info.hdUrl : info.playUrl,
      fileName: tiktokFileName(info, "mp4"),
      sourceUrl: url
    };
  }
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
      return `<div class="dl-row is-bad"><span class="dl-row-name">${escapeHtml(shorten(probe.url))}</span><span class="dl-row-meta">${escapeHtml(probe.error ?? "não foi possível ler")}</span></div>`;
    }
    const quality = findQuality(qualityId);
    const size = formatBytes(estimateFor(probe, quality));
    const clock = formatClock(probe.durationSeconds);
    const top = probe.resolutions[0] ? `${probe.resolutions[0]}p` : "";
    const meta = [probe.site, clock, top, size].filter((part) => part.length > 0).join(" · ");
    return `<div class="dl-row"><span class="dl-row-name" title="${escapeHtml(probe.title)}">${escapeHtml(
      probe.title
    )}</span><span class="dl-row-meta">${escapeHtml(meta)}</span>` + (probe.hadWatermarked ? `<span class="dl-row-tag">sem marca d'água</span>` : "") + "</div>";
  }
  function shorten(value) {
    return value.length > 64 ? `${value.slice(0, 61)}…` : value;
  }
  function baseName(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }
  function markup$3() {
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Links</span></div><textarea class="dl-urls" data-urls spellcheck="false" rows="3" placeholder="Cole os links do YouTube ou do TikTok — um por linha"></textarea><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar links</div></div><div class="sil-manual" data-manual hidden></div><div class="dl-list" data-list></div><div class="dl-progress" data-progress hidden></div><pre class="dl-log" data-log hidden></pre></div></div><div class="zone"><div class="field"><span class="t-label">Qualidade</span><div data-quality-pick></div></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Destino</span><span class="field-action" ${CONTROL} data-pick>Escolher…</span></div><p class="dl-dest" data-dest></p></div><div class="field"><span class="t-label">Importar para o projeto</span><div class="seg" data-import-seg><div class="seg-item" ${CONTROL} data-import="on">Sim</div><div class="seg-item" ${CONTROL} data-import="off">Não</div></div></div></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">⚙️ Ajustes Avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><span class="t-label">Cookies do navegador</span><div data-cookies-pick></div><p class="field-note">Para vídeo com restrição de idade ou quando o site pede login. Use o navegador onde você já está logado.</p></div><div class="field"><div class="field-head"><span class="t-label">Caminho do yt-dlp</span><span class="field-action" ${CONTROL} data-open-folder>Abrir pasta</span></div><div class="sil-ffmpeg-group"><input type="text" class="sil-path" data-ytdlp-path spellcheck="false" placeholder="deixe vazio para procurar sozinho"><div class="org-scan" ${CONTROL} data-install>Reinstalar yt-dlp</div></div><p class="field-note">Não precisa instalar nada: na primeira vez o painel baixa sozinho o yt-dlp e o ffmpeg oficiais para a pasta do plugin. Este botão só força uma reinstalação, se algum dia precisar atualizar.</p></div></div></div></div>`;
  }
  const FILLER_DEFAULTS = {
    useTags: true,
    stretchedSeconds: 0.45,
    padSeconds: 0.12
  };
  const MIN_REMOVAL_SECONDS = 0.06;
  const UNAMBIGUOUS = [
    /^é{2,}$/,
    //                ééé
    /^e{3,}$/,
    //                eee
    /^[ae]h{2,}$/,
    //            ahh, ehh
    /^é+h+$/,
    //                 éh, ééhh
    /^ã+h*$/,
    //                 ã, ããh
    /^h[ãa]+$/,
    //               hã, haa
    /^ah?n+$/,
    //                ahn, an — "an" não é palavra
    /^ãh?n+$/,
    //                ãhn
    /^uh+n*$/,
    //                uh, uhn
    /^h?[uũ]m{2,}$/,
    //          humm, umm
    /^hu+m+$/,
    //                hum, huum
    /^hm+$/,
    //                  hm, hmm
    /^m{2,}$/,
    //                mmm
    /^a{2,}m+$/,
    //              aam, aaammmm
    /^u{2,}m*$/
    //              uu, uum
  ];
  const AMBIGUOUS = [
    /^é$/,
    //    verbo ser… ou o clássico "é…"
    /^e+$/,
    //   conjunção… ou "e…" (ee cai no inequívoco com 3+)
    /^ah$/,
    //   interjeição intencional… ou hesitação
    /^eh$/,
    //   idem
    /^ã$/,
    //    quase sempre muleta, mas curto demais some no piso
    /^um$/,
    //   artigo… ou "um…" arrastado
    /^o$/,
    //    artigo… ou "o…" procurando a palavra
    /^a$/
    //    idem
  ];
  function normalizeWord(text2) {
    return text2.normalize("NFC").toLowerCase().replace(/[.,;:!?…"'`´‘’“”()\[\]-]+/g, "").trim();
  }
  function classifyWord(span, params) {
    if (params.useTags && span.filler) {
      return "tag";
    }
    const word = normalizeWord(span.text ?? "");
    if (!word) {
      return null;
    }
    if (UNAMBIGUOUS.some((pattern) => pattern.test(word))) {
      return "sound";
    }
    if (params.stretchedSeconds > 0 && span.end - span.start >= params.stretchedSeconds && AMBIGUOUS.some((pattern) => pattern.test(word))) {
      return "stretched";
    }
    return null;
  }
  function planFillers(words, range, params, frameSeconds2) {
    const total = range.end - range.start;
    if (!(total > 0)) {
      return empty();
    }
    const frame = frameSeconds2 > 0 ? frameSeconds2 : 1 / 30;
    const minRemoval = Math.max(MIN_REMOVAL_SECONDS, frame * 2);
    const inRange = words.filter((word) => word.end > range.start && word.start < range.end).map((word) => ({
      ...word,
      start: Math.max(range.start, word.start),
      end: Math.min(range.end, word.end)
    })).sort((a, b) => a.start - b.start);
    const marked = inRange.map((word) => classifyWord(word, params));
    const hits = [];
    const cuts = [];
    for (let index = 0; index < inRange.length; index += 1) {
      const reason = marked[index];
      if (!reason) {
        continue;
      }
      const word = inRange[index];
      let leftEdge = range.start;
      for (let i = index - 1; i >= 0; i -= 1) {
        if (!marked[i]) {
          leftEdge = inRange[i].end;
          break;
        }
      }
      let rightEdge = range.end;
      for (let i = index + 1; i < inRange.length; i += 1) {
        if (!marked[i]) {
          rightEdge = inRange[i].start;
          break;
        }
      }
      hits.push({ start: word.start, end: word.end, text: word.text ?? "", reason });
      cuts.push({
        start: Math.max(leftEdge, word.start - params.padSeconds),
        end: Math.min(rightEdge, word.end + params.padSeconds)
      });
    }
    if (cuts.length === 0) {
      return empty();
    }
    const merged = [];
    for (const cut of cuts) {
      const last = merged[merged.length - 1];
      if (last && cut.start <= last.end + 1e-6) {
        last.end = Math.max(last.end, cut.end);
      } else {
        merged.push({ ...cut });
      }
    }
    const drop = merged.filter((cut) => cut.end - cut.start >= minRemoval);
    if (drop.length === 0) {
      return empty();
    }
    const keep = [];
    let cursor = range.start;
    for (const cut of drop) {
      if (cut.start - cursor > 1e-6) {
        keep.push({ start: cursor, end: cut.start });
      }
      cursor = cut.end;
    }
    if (range.end - cursor > 1e-6) {
      keep.push({ start: cursor, end: range.end });
    }
    const removedSeconds = drop.reduce((sum2, cut) => sum2 + (cut.end - cut.start), 0);
    return {
      keep,
      drop,
      removedSeconds,
      keptSeconds: total - removedSeconds,
      hits
    };
  }
  function empty() {
    return { keep: [], drop: [], removedSeconds: 0, keptSeconds: 0, hits: [] };
  }
  const REASON_LABELS = {
    tag: "tag da transcrição",
    sound: "som de hesitação",
    stretched: "esticado"
  };
  let cancelActiveScan = null;
  let padSlider = null;
  let stretchSlider = null;
  const fillersTool = {
    id: "fillers",
    name: "Cortar Muletas",
    summary: "Remove os ééé e aaamm da fala",
    hint: "Selecione os clipes falados e analise. Usa a transcrição do Premiere (janela Texto → Transcrever) — só as muletas caem, o resto da fala e as pausas ficam como estão.",
    category: "edicao",
    glyph: "speech",
    available: true,
    mount(container, context) {
      const params = { ...FILLER_DEFAULTS };
      let scan = null;
      let plans = /* @__PURE__ */ new Map();
      let snapshot = null;
      let scanning = false;
      container.innerHTML = markup$2(params);
      const scanBtn = container.querySelector("[data-scan]");
      const emptyEl = container.querySelector("[data-empty]");
      const reportEl = container.querySelector("[data-report]");
      const padRail = container.querySelector("[data-pad]");
      const padOut = container.querySelector("[data-out-pad]");
      const stretchRail = container.querySelector("[data-stretch]");
      const stretchOut = container.querySelector("[data-out-stretch]");
      const tagSeg = container.querySelector("[data-tag-seg]");
      context.setApplyLabel("CORTAR MULETAS");
      context.setApplyEnabled(false);
      context.setResetLabel("DESFAZER");
      context.setResetHandler(null);
      function syncOutputs() {
        padSlider?.set(params.padSeconds);
        stretchSlider?.set(params.stretchedSeconds);
        for (const item of tagSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.dataset.tag === "on" === params.useTags)
          );
        }
      }
      if (padRail) {
        padSlider = mountSlider(padRail, {
          min: 0,
          max: 0.4,
          step: 0.01,
          value: params.padSeconds,
          label: "Margem ao redor de cada muleta",
          format: (value) => `${value.toFixed(2)}s`,
          output: padOut,
          onInput: (value) => {
            params.padSeconds = value;
            syncOutputs();
            rebuild();
          }
        });
      }
      if (stretchRail) {
        stretchSlider = mountSlider(stretchRail, {
          min: 0,
          max: 1,
          step: 0.05,
          value: params.stretchedSeconds,
          label: "Duração a partir da qual é e ah contam como muleta",
          // Zero não é "0,00s": é a regra desligada.
          format: (value) => value > 0 ? `${value.toFixed(2)}s` : "desligado",
          output: stretchOut,
          onInput: (value) => {
            params.stretchedSeconds = value;
            syncOutputs();
            rebuild();
          }
        });
      }
      tagSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-tag]");
        if (!item) return;
        params.useTags = item.dataset.tag === "on";
        syncOutputs();
        rebuild();
      });
      scanBtn?.addEventListener("click", () => void runScan());
      async function runScan() {
        if (scanning) return;
        scanning = true;
        let cancelled = false;
        cancelActiveScan = () => {
          cancelled = true;
        };
        context.setApplyEnabled(false);
        if (scanBtn) {
          setDisabled(scanBtn, true);
          scanBtn.textContent = "Analisando…";
        }
        try {
          const result = await scanSelection(defaultParams(), {
            mode: "transcript",
            ffmpegPath: "",
            onStage: (text2) => context.setStatus(text2),
            cancelled: () => cancelled
          });
          if (cancelled) return;
          scan = result;
          rebuild();
        } catch (cause) {
          scan = null;
          plans = /* @__PURE__ */ new Map();
          context.setStatus(cause instanceof Error ? cause.message : String(cause), "error");
        } finally {
          scanning = false;
          cancelActiveScan = null;
          if (scanBtn) {
            setDisabled(scanBtn, false);
            scanBtn.textContent = "Analisar Seleção";
          }
        }
      }
      function rebuild() {
        if (!scan) return;
        plans = /* @__PURE__ */ new Map();
        let cuts = 0;
        let removed = 0;
        let ready = 0;
        for (const clip of scan.clips) {
          if (clip.status === "error" || clip.status === "speed" || clip.status === "no-media" || clip.status === "no-transcript") {
            clip.plan = null;
            continue;
          }
          const plan = planFillers(
            clip.words,
            { start: clip.sourceStart, end: clip.sourceEnd },
            params,
            scan.frameSeconds
          );
          plans.set(clip.key, plan);
          if (plan.drop.length === 0) {
            clip.plan = null;
            clip.status = "nothing";
            continue;
          }
          if (plan.keep.length === 0) {
            clip.plan = null;
            clip.status = "no-speech";
            plans.delete(clip.key);
            continue;
          }
          clip.plan = plan;
          clip.status = "ready";
          ready += 1;
          cuts += plan.drop.length;
          removed += plan.removedSeconds;
        }
        scan.cuts = cuts;
        scan.removedSeconds = removed;
        scan.readyCount = ready;
        renderReport();
        context.setApplyEnabled(ready > 0);
        const total = totalHits();
        context.setStatus(
          total > 0 ? `${total} ${total === 1 ? "muleta encontrada" : "muletas encontradas"} · ${formatSeconds(removed)} a remover` : "Nenhuma muleta encontrada na seleção.",
          total > 0 ? "done" : "idle"
        );
      }
      function totalHits() {
        let count = 0;
        for (const plan of plans.values()) {
          count += plan.hits.length;
        }
        return count;
      }
      context.setApplyHandler(async () => {
        if (!scan || scan.readyCount === 0) return;
        context.setStatus("Cortando…");
        context.setApplyEnabled(false);
        const result = await applyCuts(scan, (done, total) => {
          context.setStatus(`Cortando… ${done}/${total}`);
        });
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.snapshot) {
          snapshot = result.snapshot;
          context.setResetHandler(() => void runUndo());
        }
        if (result.ok && result.snapshot) {
          scan = null;
          plans = /* @__PURE__ */ new Map();
          renderReport();
          context.refreshSelection();
        } else if (!result.ok && !result.snapshot && scan.readyCount > 0) {
          context.setApplyEnabled(true);
        }
      });
      async function runUndo() {
        if (!snapshot) return;
        context.setStatus("Desfazendo…");
        const result = await undoCuts(snapshot);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok) {
          snapshot = null;
          context.setResetHandler(null);
          context.refreshSelection();
        }
      }
      function renderReport() {
        if (!reportEl) return;
        if (!scan) {
          reportEl.innerHTML = "";
          if (emptyEl) emptyEl.hidden = false;
          return;
        }
        if (emptyEl) emptyEl.hidden = true;
        let html = "";
        for (const clip of scan.clips) {
          html += clipRow(clip, plans.get(clip.key) ?? null);
        }
        reportEl.innerHTML = html;
      }
      function clipRow(clip, plan) {
        const hits = plan?.hits ?? [];
        let meta;
        if (clip.status === "no-transcript") {
          meta = '<span class="sil-row-skip">sem transcrição</span>';
        } else if (clip.status === "error") {
          meta = `<span class="sil-row-skip">${escapeHtml(clip.detail ?? "erro")}</span>`;
        } else if (clip.status === "speed") {
          meta = '<span class="sil-row-skip">velocidade alterada</span>';
        } else if (clip.status === "no-media") {
          meta = '<span class="sil-row-skip">sem arquivo</span>';
        } else if (clip.status === "no-speech") {
          meta = '<span class="sil-row-skip">clipe inteiro é muleta — corte na mão</span>';
        } else if (hits.length === 0) {
          meta = '<span class="sil-row-skip">sem muletas</span>';
        } else {
          meta = `<span class="sil-row-cuts">${hits.length} ${hits.length === 1 ? "muleta" : "muletas"}</span><span class="sil-row-time">−${formatSeconds(plan?.removedSeconds ?? 0)}</span>`;
        }
        let html = `<div class="sil-row-group"><div class="sil-row${hits.length > 0 ? " is-ready" : ""}"><span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
          clip.name
        )}</span>${meta}</div>`;
        if (hits.length > 0) {
          html += '<div class="fl-hits">';
          for (const hit of hits) {
            const at = formatSeconds(Math.max(0, hit.start - clip.sourceStart));
            html += `<span class="fl-hit is-${hit.reason}" title="${REASON_LABELS[hit.reason]}"><b>${escapeHtml(hit.text || "(sem texto)")}</b>${at}</span>`;
          }
          html += "</div>";
        }
        return html + "</div>";
      }
      syncOutputs();
      context.setRefreshHandler(null);
    },
    unmount() {
      cancelActiveScan?.();
      cancelActiveScan = null;
      padSlider?.destroy();
      padSlider = null;
      stretchSlider?.destroy();
      stretchSlider = null;
    }
  };
  function markup$2(params) {
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Margem ao redor</span><span class="field-val" data-out-pad>${params.padSeconds.toFixed(2)}s</span></div><div class="slider-row"><div data-pad></div></div><p class="field-note">Quanto de ar cai junto com cada muleta. A margem avança pelo silêncio vizinho e para na palavra ao lado — nunca morde fala.</p></div><div class="field"><div class="field-head"><span class="t-label">Esticado a partir de</span><span class="field-val" data-out-stretch>${params.stretchedSeconds.toFixed(2)}s</span></div><div class="slider-row"><div data-stretch></div></div><p class="field-note">Um "é" ou "ah" mais longo que isso é hesitação, não palavra. Zero desliga — aí só sons inequívocos (ééé, hum) e a tag cortam.</p></div><div class="field"><span class="t-label">Tag da transcrição (né, tipo…)</span><div class="seg" data-tag-seg><div class="seg-item" ${CONTROL} data-tag="on">Cortar</div><div class="seg-item" ${CONTROL} data-tag="off">Manter</div></div><p class="field-note">O que o próprio Premiere marcou como muleta. Desligue se o "né" faz parte do jeito de falar do vídeo.</p></div></div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para analisar</p><p class="sil-empty-desc">Selecione os clipes falados na timeline. É preciso que estejam transcritos (janela Texto → Transcrever sequência).</p></div><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div><div class="sil-report" data-report></div></div></div>`;
  }
  function isMarker(text2) {
    return /^\[_.*_?\]$/.test(text2.trim()) || /^<\|.*\|>$/.test(text2.trim());
  }
  function num(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }
  function whisperToAdobe(json, offsetSeconds = 0) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { version: "1.0.0", segments: [] };
    }
    const list = Array.isArray(parsed.transcription) ? parsed.transcription : [];
    const segments = [];
    for (const segment of list) {
      const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
      const words = mergeTokens(tokens, offsetSeconds);
      if (words.length === 0) {
        continue;
      }
      segments.push({
        start: num(segment.offsets?.from, 0) / 1e3 + offsetSeconds,
        words
      });
    }
    return { version: "1.0.0", segments };
  }
  function mergeTokens(tokens, offsetSeconds = 0) {
    const words = [];
    let current = null;
    const flush = () => {
      if (!current) {
        return;
      }
      const text2 = current.text.trim();
      if (text2 && !/[\p{L}\p{N}]/u.test(text2) && words.length > 0) {
        const previous = words[words.length - 1];
        previous.text += text2;
        previous.duration = Math.max(
          previous.duration,
          current.end - previous.start
        );
        current = null;
        return;
      }
      if (text2) {
        words.push({
          text: text2,
          start: round$1(current.start),
          // Duração nunca zero: o Premiere trata um span degenerado como
          // ausência de tempo e a palavra some da legenda.
          duration: round$1(Math.max(8e-3, current.end - current.start)),
          type: "word",
          confidence: round$1(
            current.ps.reduce((sum2, p) => sum2 + p, 0) / current.ps.length
          ),
          tags: []
        });
      }
      current = null;
    };
    for (const token of tokens) {
      const raw = typeof token.text === "string" ? token.text : "";
      if (!raw.trim() || isMarker(raw)) {
        continue;
      }
      const start = num(token.offsets?.from, 0) / 1e3 + offsetSeconds;
      const end = num(token.offsets?.to, num(token.offsets?.from, 0)) / 1e3 + offsetSeconds;
      const probability = Math.min(1, Math.max(0, num(token.p, 1)));
      if (raw.startsWith(" ") || current === null) {
        flush();
        current = { text: raw.trim(), start, end, ps: [probability] };
      } else {
        current.text += raw;
        current.end = Math.max(current.end, end);
        current.ps.push(probability);
      }
    }
    flush();
    return words;
  }
  function round$1(value) {
    return Math.round(value * 1e3) / 1e3;
  }
  function countWords(transcript) {
    return transcript.segments.reduce(
      (total, segment) => total + segment.words.length,
      0
    );
  }
  function fold(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) {
      return limit + 1;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      let best = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const value = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + cost
        );
        current.push(value);
        if (value < best) {
          best = value;
        }
      }
      if (best > limit) {
        return limit + 1;
      }
      previous = current;
    }
    return previous[b.length];
  }
  function tolerance(folded) {
    if (folded.length <= 4) return 0;
    if (folded.length <= 7) return 1;
    return 2;
  }
  function parseGlossary(text2) {
    const terms = [];
    for (const line of text2.split(/\r?\n/)) {
      const display = line.trim();
      if (!display || display.startsWith("#")) {
        continue;
      }
      const folded = fold(display);
      if (!folded) {
        continue;
      }
      terms.push({
        display,
        folded,
        span: display.trim().split(/\s+/).length
      });
    }
    return terms.sort((a, b) => b.folded.length - a.folded.length);
  }
  function promptFrom(terms) {
    if (terms.length === 0) {
      return "";
    }
    return terms.map((term) => term.display).join(", ") + ".";
  }
  function applyGlossary(transcript, terms) {
    if (terms.length === 0) {
      return { transcript, corrections: [] };
    }
    const corrections = [];
    const maxSpan = Math.max(...terms.map((term) => term.span), 1) + 1;
    const segments = transcript.segments.map((segment) => {
      const words = [];
      let index = 0;
      while (index < segment.words.length) {
        let matched = false;
        for (let span = Math.min(maxSpan, segment.words.length - index); span >= 1 && !matched; span -= 1) {
          const window2 = segment.words.slice(index, index + span);
          const joined = window2.map((word) => word.text).join(" ");
          const folded = fold(joined);
          if (!folded) {
            continue;
          }
          for (const term of terms) {
            const budget = span === 1 ? tolerance(term.folded) : 0;
            if (distance(folded, term.folded, budget) > budget) {
              continue;
            }
            const trailing = /[^\p{L}\p{N}]+$/u.exec(joined)?.[0] ?? "";
            const corrected = term.display + trailing;
            if (joined !== corrected) {
              corrections.push({ from: joined, to: corrected, merged: span });
            }
            const first = window2[0];
            const last = window2[window2.length - 1];
            words.push({
              text: corrected,
              start: first.start,
              duration: Math.max(8e-3, last.start + last.duration - first.start),
              type: "word",
              // A confiança da junção é a do pedaço menos confiante: a
              // legenda é tão boa quanto a sua pior parte.
              confidence: Math.min(...window2.map((word) => word.confidence)),
              tags: []
            });
            index += span;
            matched = true;
            break;
          }
        }
        if (!matched) {
          words.push(segment.words[index]);
          index += 1;
        }
      }
      return { start: segment.start, words };
    });
    return {
      transcript: { version: transcript.version, segments },
      corrections
    };
  }
  const FAMILIES = {
    // O que o painel faz. O editor fala esses nomes na própria narração.
    ferramentas: ["Framelab", "Premiere Pro", "After Effects", "DaVinci Resolve"],
    // Jargão de corte dito em inglês no meio da frase em português —
    // é onde o modelo mais troca a grafia.
    edicao: [
      "b-roll",
      "keyframe",
      "timeline",
      "punch in",
      "jump cut",
      "match cut",
      "cutaway",
      "rough cut",
      "Transform",
      "proxy",
      "preset"
    ],
    /*
     * Cor e imagem. Sem "look", "matiz" nem "gamma": são palavras
     * comuns demais, e o corretor as usava para reescrever texto que já
     * estava certo — visto num teste real, "Look" virando "look". Termo
     * de fábrica só entra se for inequívoco.
     */
    cor: ["LUT", "color grading", "halation"],
    // Áudio.
    audio: ["voice over", "sound design", "foley"],
    // Entrega e formato: número e sigla juntos, que o modelo adora
    // escrever por extenso.
    formato: ["4K", "1080p", "9:16", "16:9", "frame rate", "codec", "bitrate"]
  };
  const BASE_GLOSSARY = Object.values(FAMILIES).flat().join("\n");
  function effectiveGlossary(userGlossary) {
    const user = userGlossary.trim();
    return user ? `${user}
${BASE_GLOSSARY}` : BASE_GLOSSARY;
  }
  const q = shellQuote;
  const RESULT_FILE = "cc-result.json";
  const STAGE_FILE = "cc-stage.txt";
  const WHISPER_LOG = "cc-whisper.log";
  const STARTED_FILE = "cc-started.txt";
  const OUT_BASE = "cc-out";
  const SCRIPT_FILE = "captions.command";
  const SCRIPT_FILE_WIN = "captions.bat";
  const POLL_MS = 400;
  const TIMEOUT_MS = 60 * 60 * 1e3;
  const WHISPER_CANDIDATES = [
    "/Library/Application Support/Framelab/bin/whisper-cli",
    "/opt/homebrew/bin/whisper-cli",
    "/usr/local/bin/whisper-cli",
    "/opt/homebrew/bin/whisper-cpp",
    "/usr/local/bin/whisper-cpp"
  ];
  const MODELS = [
    {
      id: "small",
      label: "Rápido",
      note: "181 MB · o mais rápido, erra mais em nome próprio",
      file: "ggml-small-q5_1.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
      megabytes: 181
    },
    {
      id: "turbo",
      label: "Equilibrado",
      note: "547 MB · o recomendado — 10 min de vídeo em ~3 min",
      file: "ggml-large-v3-turbo-q5_0.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
      megabytes: 547
    },
    {
      id: "large",
      label: "Máxima",
      note: "1 GB · 2,4x mais lento, mesma precisão nos testes",
      file: "ggml-large-v3-q5_0.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
      megabytes: 1031
    }
  ];
  const LANGUAGES = [
    { id: "pt", label: "Português" },
    { id: "en", label: "Inglês" },
    { id: "es", label: "Espanhol" },
    { id: "it", label: "Italiano" },
    { id: "fr", label: "Francês" },
    { id: "de", label: "Alemão" },
    { id: "ja", label: "Japonês" },
    { id: "zh", label: "Chinês" },
    { id: "ko", label: "Coreano" },
    { id: "ru", label: "Russo" },
    { id: "ar", label: "Árabe" },
    { id: "hi", label: "Híndi" },
    { id: "auto", label: "Detectar" }
  ];
  function findLanguage(id) {
    return LANGUAGES.find((language) => language.id === id) ?? LANGUAGES[0];
  }
  function findModel(id) {
    return MODELS.find((model) => model.id === id) ?? MODELS[1];
  }
  async function transcribe(job, model, language, prompt, onStage, cancelled, onManual) {
    const shell = shellModule();
    if (!shell) {
      return { ok: false, error: "uxp-unavailable", json: null, scriptPath: null };
    }
    const space = await workspace();
    const scriptPath = nativePath(space, scriptName());
    const outJson = `${OUT_BASE}.json`;
    for (const name of [RESULT_FILE, STAGE_FILE, STARTED_FILE, WHISPER_LOG, outJson, "cc-audio.wav"]) {
      await remove(space, name);
    }
    const script = isWindows() ? windowsScript(job, model, language, space.nativeBase, prompt) : unixScript(job, model, language, space.nativeBase, prompt);
    await write(space, scriptName(), script, true);
    const PURPOSE = "Transcrever o áudio das faixas escolhidas.";
    let launchError = null;
    const sent = await dispatch(scriptName());
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Legendas] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, PURPOSE);
      } catch (cause) {
        launchError = describe(cause);
        onManual?.(scriptPath, launchError);
      }
    }
    const stampDeadline = Date.now() + 8e3;
    const deadline = Date.now() + TIMEOUT_MS;
    let lastStage = "";
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        return { ok: false, error: "cancelled", json: null, scriptPath };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        awaitingStamp = false;
        if (!readText(space, STARTED_FILE)) {
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, PURPOSE);
          } catch (cause) {
            launchError = describe(cause);
            onManual?.(scriptPath, launchError);
          }
        }
      }
      const stage = readText(space, STAGE_FILE);
      const percent = stage?.startsWith("Transcrevendo") ? whisperProgress(space) : null;
      const shown = percent === null ? stage : `${stage} ${percent}%`;
      if (shown && shown !== lastStage) {
        lastStage = shown;
        onStage?.(shown);
      }
      const raw = readText(space, RESULT_FILE);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.ok !== true) {
            return {
              ok: false,
              error: parsed.error ?? "failed",
              detected: parsed.detected,
              json: null,
              scriptPath
            };
          }
          return {
            ok: true,
            error: null,
            json: readJson(space, outJson),
            scriptPath
          };
        } catch {
        }
      }
      await wait$1(POLL_MS);
    }
    return {
      ok: false,
      error: launchError ? `launch-denied: ${launchError}` : "timeout",
      json: null,
      scriptPath
    };
  }
  function whisperProgress(space) {
    const log = readText(space, WHISPER_LOG);
    if (!log) return null;
    const hits = log.match(/progress\s*=\s*(\d+)%/g);
    if (!hits) return null;
    const last = /(\d+)%/.exec(hits[hits.length - 1]);
    return last ? Number.parseInt(last[1], 10) : null;
  }
  function readJson(space, name) {
    const raw = readText(space, name);
    if (!raw) {
      console.error("[Legendas] whisper terminou mas não deixou JSON.");
      return null;
    }
    return raw;
  }
  function scriptName() {
    return isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
  }
  function unixScript(job, model, language, folder, prompt = "") {
    const lines = [
      "#!/bin/bash",
      "# Gerado pelo Framelab — Legendas. Pode apagar.",
      `printf '\\033]0;Framelab — transcrevendo\\007'`,
      // Nativo, custe o que custar: sob Rosetta o whisper e o ffmpeg rodam
      // emulados e uma transcrição de minutos vira uma de dezenas.
      'if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && command -v arch >/dev/null 2>&1; then exec arch -arm64 /bin/bash "$0" "$@"; fi',
      "set -u",
      `WORK=${q(folder)}`,
      'cd "$WORK" || exit 1',
      `printf 1 > "$WORK/${STARTED_FILE}"`,
      `stage() { printf '%s' "$1" > "$WORK/${STAGE_FILE}"; }`,
      `fail() { printf '{"ok":false,"error":"%s"}' "$1" > "$WORK/${RESULT_FILE}.tmp"; mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"; exit 1; }`,
      // ── ffmpeg: o mesmo que o resto do plugin provisiona ──
      "FFMPEG=''",
      'for c in "$HOME/Library/Application Support/Framelab/bin/ffmpeg" "/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
      '  if [ -x "$c" ]; then FFMPEG="$c"; break; fi',
      "done",
      'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
      'if [ -z "$FFMPEG" ]; then fail ffmpeg-not-found; fi',
      // ── whisper: procurado nas pastas integradas e no sistema ──
      "WHISPER=''",
      `for c in "$HOME/Library/Application Support/Framelab/bin/whisper-cli" ${WHISPER_CANDIDATES.map(q).join(" ")} "$WORK/whisper-cli"; do`,
      '  if [ -x "$c" ]; then WHISPER="$c"; break; fi',
      "done",
      'if [ -z "$WHISPER" ]; then WHISPER="$(command -v whisper-cli 2>/dev/null || true)"; fi',
      'if [ -z "$WHISPER" ]; then fail whisper-not-found; fi',
      // ── modelo: esse sim, baixado sozinho ──
      `MODEL="$WORK/${model.file}"`,
      'if [ ! -f "$MODEL" ]; then',
      `  stage "Baixando o modelo de transcrição (${model.megabytes} MB, só na primeira vez)…"`,
      `  if ! curl -fsSL --retry 3 -o "$MODEL.tmp" ${q(model.url)}; then rm -f "$MODEL.tmp"; fail model-download; fi`,
      '  mv "$MODEL.tmp" "$MODEL"',
      "fi",
      // ── áudio: a faixa inteira montada em tempo de sequência ──
      'stage "Montando o áudio da faixa…"',
      `"$FFMPEG" -v error -y ` + job.inputs.map((args) => args.map(q).join(" ")).join(" ") + ` -filter_complex ${q(job.filter)} -map "[out]" -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/cc-audio.wav" || fail audio-extract`,
      /*
       * O IDIOMA É CONFERIDO ANTES.
       *
       * Forçar `-l fr` num áudio em português não dá erro: o whisper
       * obedece e devolve francês fluente, inventado, com pontuação
       * perfeita. Foi o que aconteceu — dois minutos de motor para
       * produzir uma tradução alucinada que ninguém pediu, sem um aviso.
       *
       * Detectar custa ~4s (só o encoder nos primeiros 30s) contra os
       * minutos da transcrição inteira, e acerta com folga: 99,9% neste
       * áudio. Barato demais para não fazer.
       *
       * Só barra quando a detecção está CONFIANTE e discorda — sotaque
       * carregado e áudio ruim baixam a certeza, e nesses casos quem
       * manda é a escolha do editor.
       */
      ...language === "auto" ? [] : [
        'stage "Conferindo o idioma…"',
        `DET=$("$WHISPER" -m "$MODEL" -f "$WORK/cc-audio.wav" -dl 2>&1 || true)`,
        `DETLANG=$(printf '%s' "$DET" | sed -n 's/.*auto-detected language: \\([a-z][a-z]*\\).*/\\1/p' | head -1)`,
        `DETP=$(printf '%s' "$DET" | sed -n 's/.*p = \\([0-9.]*\\).*/\\1/p' | head -1)`,
        // A probabilidade entra como VARIÁVEL do awk. Escrita como
        // `$DETP` dentro do programa, o awk a lê como número de
        // campo — e em BEGIN não há campo nenhum, então a comparação
        // dava sempre falso e a checagem inteira era decorativa.
        // `p+0` cobre o caso de a detecção não ter dito nada.
        `if [ -n "$DETLANG" ] && [ "$DETLANG" != ${q(language)} ] && awk -v p="$DETP" 'BEGIN{exit !(p+0 > 0.70)}' 2>/dev/null; then`,
        `  printf '{"ok":false,"error":"language-mismatch","detected":"%s","p":"%s"}' "$DETLANG" "$DETP" > "$WORK/${RESULT_FILE}.tmp"`,
        `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
        '  rm -f "$WORK/cc-audio.wav"',
        "  exit 1",
        "fi"
      ],
      'stage "Transcrevendo…"',
      /*
       * As opções que separam uma legenda boa de uma sofrível, medidas
       * antes de entrarem aqui:
       *   --prompt      enviesa para os termos do projeto (foi o que
       *                 recuperou o nome próprio que virava outra coisa)
       *   -bs/-bo 5     busca em feixe em vez de gulosa
       *   -sns          descarta marcador de não-fala ("[música]")
       *   -et/-lpt      recusa segmento com entropia alta, que é como o
       *                 whisper alucina texto no silêncio
       */
      // Núcleos de desempenho, não todos: num Apple Silicon os de
      // eficiência atrasam o conjunto. Fora do macOS cai para o total.
      "THREADS=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null || echo 4)",
      /*
       * `-pp` é uma BANDEIRA. Escrito `-pp false`, o `false` virava um
       * segundo arquivo de entrada ("input file not found 'false'") — o
       * whisper reclamava e seguia, mas o progresso nunca chegou ao
       * painel. O stderr vai para o log, não para o nada: é dele que
       * saem o percentual e o diagnóstico de lentidão.
       */
      `"$WHISPER" -m "$MODEL" -f "$WORK/cc-audio.wav" -l ${q(language)} -t "$THREADS" -bs 5 -bo 5 -sns -et 2.4 -lpt -1.0 ` + (prompt ? `--prompt ${q(prompt)} ` : "") + `-ojf -of "$WORK/${OUT_BASE}" -pp >/dev/null 2>"$WORK/${WHISPER_LOG}" || fail whisper-failed`,
      `if [ ! -f "$WORK/${OUT_BASE}.json" ]; then fail no-output; fi`,
      // O WAV de 16 kHz de uma hora de fala são ~115 MB; some assim que
      // vira transcrição.
      'rm -f "$WORK/cc-audio.wav"',
      'stage "Pronto."',
      `printf '{"ok":true}' > "$WORK/${RESULT_FILE}.tmp"`,
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      // Só fecha janela se o Terminal JÁ estiver aberto. `tell application
      // "Terminal"` LANÇA o Terminal quando ele não está rodando — era isto
      // que fazia uma janela vazia aparecer no FIM de cada trabalho, mesmo
      // com o agente silencioso funcionando.
      `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`,
      "exit 0"
    ];
    return lines.join("\n") + "\n";
  }
  function windowsScript(job, model, language, folder, prompt = "") {
    const bat = (value) => value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
    const lines = [
      "@echo off",
      "rem Gerado pelo Framelab - Legendas. Pode apagar.",
      "title Framelab - transcrevendo",
      `set "WORK=${bat(folder)}"`,
      'cd /d "%WORK%"',
      `>"%WORK%\\${STARTED_FILE}" echo 1`,
      'set "FFMPEG="',
      'for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
      `if "%FFMPEG%"=="" if exist "%WORK%\\ffmpeg.exe" set "FFMPEG=%WORK%\\ffmpeg.exe"`,
      'if "%FFMPEG%"=="" (',
      `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"ffmpeg-not-found"}`,
      "  exit /b 1",
      ")",
      'set "WHISPER="',
      'for %%i in (whisper-cli.exe) do @set "WHISPER=%%~$PATH:i"',
      'if "%WHISPER%"=="" (',
      `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"whisper-not-found"}`,
      "  exit /b 1",
      ")",
      `set "MODEL=%WORK%\\${bat(model.file)}"`,
      'if not exist "%MODEL%" (',
      `  >"%WORK%\\${STAGE_FILE}" echo Baixando o modelo (${model.megabytes} MB)...`,
      `  curl.exe -fsSL --retry 3 -o "%MODEL%" "${model.url}"`,
      ")",
      `>"%WORK%\\${STAGE_FILE}" echo Montando o audio da faixa...`,
      `"%FFMPEG%" -v error -y ` + job.inputs.map((args) => args.map((a) => `"${bat(a)}"`).join(" ")).join(" ") + ` -filter_complex "${bat(job.filter)}" -map "[out]" -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar 16000 -c:a pcm_s16le "%WORK%\\cc-audio.wav"`,
      "if errorlevel 1 (",
      `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"audio-extract"}`,
      "  exit /b 1",
      ")",
      `>"%WORK%\\${STAGE_FILE}" echo Transcrevendo...`,
      `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\cc-audio.wav" -l ${bat(language)} -bs 5 -bo 5 -sns -et 2.4 -lpt -1.0 ` + (prompt ? `--prompt "${bat(prompt)}" ` : "") + `-ojf -of "%WORK%\\${OUT_BASE}" -pp >nul 2>"%WORK%\\${WHISPER_LOG}"`,
      "if errorlevel 1 (",
      `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"whisper-failed"}`,
      "  exit /b 1",
      ")",
      `del /q "%WORK%\\cc-audio.wav" 2>nul`,
      `>"%WORK%\\${RESULT_FILE}" echo {"ok":true}`,
      "exit /b 0"
    ];
    return lines.join("\r\n") + "\r\n";
  }
  function describeError(code, detected) {
    if (code === "language-mismatch") {
      const conhecido = LANGUAGES.find((entry) => entry.id === detected);
      const ouvido = conhecido?.label ?? (detected ? detected.toUpperCase() : "outro idioma");
      return `O áudio parece estar em ${ouvido}, não no idioma escolhido. Troque o idioma acima (ou use Detectar) e transcreva de novo — forçar o idioma errado faz o motor inventar uma tradução.`;
    }
    switch (code) {
      case "whisper-not-found":
        return 'O motor de transcrição não está instalado. No Terminal: "brew install whisper-cpp" — depois volte e analise de novo.';
      case "ffmpeg-not-found":
        return 'ffmpeg não encontrado. Instale com "brew install ffmpeg", ou use a ferramenta Baixar Vídeos uma vez, que ela o provisiona sozinha.';
      case "model-download":
        return "Não foi possível baixar o modelo. Confira a internet e tente de novo.";
      case "audio-extract":
        return "O ffmpeg não conseguiu ler o áudio deste clipe.";
      case "whisper-failed":
        return "O motor de transcrição não concluiu. Veja o console do UXP.";
      case "no-output":
        return "A transcrição terminou sem produzir arquivo.";
      case "cancelled":
        return "Transcrição cancelada.";
      case "timeout":
        return "A transcrição passou de uma hora e foi abandonada.";
      case "uxp-unavailable":
        return "Este build do Premiere não expõe shell/fs do UXP.";
      default:
        return code ? `Falha: ${code}` : "Falha desconhecida na transcrição.";
    }
  }
  const SRT_DEFAULTS = {
    maxLineChars: 42,
    maxLines: 2,
    gapSeconds: 0.7,
    minCueSeconds: 1.2,
    maxCueSeconds: 6,
    readingCps: 17,
    gapFrames: 0
  };
  const SRT_PRESETS = [
    {
      id: "vertical",
      name: "Vertical",
      note: "Uma linha curta de cada vez, trocando rápido — Reels, TikTok e Shorts, onde a legenda divide a tela com tudo.",
      options: {
        maxLineChars: 26,
        maxLines: 1,
        gapSeconds: 0.4,
        minCueSeconds: 0.7,
        maxCueSeconds: 3,
        readingCps: 20,
        gapFrames: 0
      }
    },
    {
      id: "broadcast",
      name: "Padrão",
      note: "42 caracteres, 2 linhas, 17 car/s — a medida de TV e YouTube. Serve para quase tudo.",
      options: { ...SRT_DEFAULTS }
    },
    {
      id: "cinema",
      name: "Cinema",
      note: "Linha mais longa e mais tempo na tela: entrevista e documentário, onde legenda trocando o tempo todo cansa mais que texto denso.",
      options: {
        maxLineChars: 50,
        maxLines: 2,
        gapSeconds: 1,
        minCueSeconds: 1.5,
        maxCueSeconds: 7,
        readingCps: 20,
        gapFrames: 0
      }
    }
  ];
  function matchPreset(options) {
    const keys = Object.keys(SRT_DEFAULTS);
    for (const preset of SRT_PRESETS) {
      if (keys.every((key) => Math.abs(preset.options[key] - options[key]) < 1e-3)) {
        return preset.id;
      }
    }
    return null;
  }
  const NOMINAL_FPS = 30;
  const FLOOR_SECONDS = 0.24;
  const SENTENCE_END = /[.!?…]$/;
  const CLAUSE_END = /[,;:]$/;
  function frameSeconds(frames, fps) {
    return frames / (fps > 0 ? fps : NOMINAL_FPS);
  }
  function snap(seconds2, fps) {
    return fps > 0 ? Math.round(seconds2 * fps) / fps : seconds2;
  }
  function buildCues(transcript, options = SRT_DEFAULTS, fps = 0) {
    const words = [];
    for (const segment of transcript.segments) {
      for (const word of segment.words) {
        const text2 = word.text.trim();
        if (text2) {
          words.push({ text: text2, start: word.start, end: word.start + word.duration });
        }
      }
    }
    words.sort((a, b) => a.start - b.start);
    if (words.length === 0) {
      return [];
    }
    const capacity = Math.max(1, options.maxLineChars * options.maxLines);
    const cues = [];
    let current = [];
    const flush = () => {
      if (current.length === 0) {
        return;
      }
      const start = current[0].start;
      const spoken = current[current.length - 1].end;
      const lines = wrap(current.map((word) => word.text).join(" "), options);
      const chars = lines.join(" ").length;
      const toRead = options.readingCps > 0 ? chars / options.readingCps : 0;
      cues.push({
        start,
        end: Math.max(spoken, start + options.minCueSeconds, start + toRead),
        lines,
        spokenEnd: spoken
      });
      current = [];
    };
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (current.length > 0) {
        const grown = current.map((entry) => entry.text).join(" ").length + 1 + word.text.length;
        if (grown > capacity) {
          flush();
        }
      }
      current.push(word);
      const text2 = current.map((entry) => entry.text).join(" ");
      const next = words[index + 1];
      const elapsed = word.end - current[0].start;
      if (SENTENCE_END.test(word.text)) {
        flush();
        continue;
      }
      if (!next) {
        continue;
      }
      if (next.start - word.end >= options.gapSeconds) {
        flush();
        continue;
      }
      if (elapsed >= options.maxCueSeconds) {
        flush();
        continue;
      }
      if (text2.length >= capacity * 0.8 && CLAUSE_END.test(word.text)) {
        flush();
      }
    }
    flush();
    for (const cue of cues) {
      cue.start = snap(cue.start, fps);
      cue.end = snap(cue.end, fps);
      if (cue.spokenEnd !== void 0) {
        cue.spokenEnd = snap(cue.spokenEnd, fps);
      }
    }
    const gap = frameSeconds(Math.max(0, options.gapFrames), fps);
    for (let index = 0; index < cues.length - 1; index += 1) {
      const currentCue = cues[index];
      const nextCue = cues[index + 1];
      const spokenEnd = currentCue.spokenEnd ?? currentCue.end;
      const pauseToNext = nextCue.start - spokenEnd;
      if (pauseToNext < options.gapSeconds) {
        const targetEnd = nextCue.start - gap;
        if (targetEnd > currentCue.start) {
          currentCue.end = Math.max(currentCue.end, targetEnd);
        }
      }
      const limit = nextCue.start - gap;
      if (currentCue.end > limit) {
        currentCue.end = Math.max(currentCue.start + FLOOR_SECONDS, limit);
      }
    }
    return cues;
  }
  function measureCues(cues, options) {
    if (cues.length === 0) {
      return { cues: 0, longestLine: 0, rushed: 0, peakCps: 0, meanSeconds: 0 };
    }
    let longestLine = 0;
    let rushed = 0;
    let peakCps = 0;
    let total = 0;
    for (const cue of cues) {
      for (const line of cue.lines) {
        longestLine = Math.max(longestLine, line.length);
      }
      const seconds2 = Math.max(1e-3, cue.end - cue.start);
      const chars = cue.lines.join(" ").length;
      const cps = chars / seconds2;
      peakCps = Math.max(peakCps, cps);
      total += seconds2;
      if (options.readingCps > 0 && cps > options.readingCps + 0.5) {
        rushed += 1;
      }
    }
    return {
      cues: cues.length,
      longestLine,
      rushed,
      peakCps,
      meanSeconds: total / cues.length
    };
  }
  function wrap(text2, options) {
    const limit = Math.max(1, options.maxLines);
    if (text2.length <= options.maxLineChars) {
      return [text2];
    }
    const words = text2.split(" ");
    const lines = [];
    let line = "";
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > options.maxLineChars && line) {
        if (lines.length === limit - 1) {
          return [...lines, [line, ...words.slice(index)].join(" ")];
        }
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      lines.push(line);
    }
    return lines;
  }
  function srtTime(seconds2) {
    const totalMs = Math.max(0, Math.round(seconds2 * 1e3));
    const hours = Math.floor(totalMs / 36e5);
    const minutes = Math.floor(totalMs % 36e5 / 6e4);
    const secs = Math.floor(totalMs % 6e4 / 1e3);
    const millis = totalMs % 1e3;
    const pad = (value, size = 2) => String(value).padStart(size, "0");
    return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`;
  }
  function cuesToSrt(cues) {
    return cues.map(
      (cue, index) => `${index + 1}
${srtTime(cue.start)} --> ${srtTime(cue.end)}
` + cue.lines.join("\n")
    ).join("\n\n") + (cues.length > 0 ? "\n" : "");
  }
  const CONFIG_FILE = "captions-config.json";
  const DEFAULTS = {
    model: "turbo",
    language: "pt",
    glossary: "",
    track: "all",
    srt: { ...SRT_DEFAULTS }
  };
  async function readConfig() {
    try {
      const raw = readText(await workspace(), CONFIG_FILE);
      if (!raw) {
        return { ...DEFAULTS };
      }
      const parsed = JSON.parse(raw);
      return {
        model: typeof parsed.model === "string" ? parsed.model : DEFAULTS.model,
        language: typeof parsed.language === "string" ? parsed.language : DEFAULTS.language,
        glossary: typeof parsed.glossary === "string" ? parsed.glossary : "",
        track: typeof parsed.track === "number" || parsed.track === "all" ? parsed.track : "all",
        srt: readSrt(parsed.srt)
      };
    } catch {
      return { ...DEFAULTS };
    }
  }
  const SRT_RANGE = {
    maxLineChars: [16, 70],
    maxLines: [1, 3],
    gapSeconds: [0.2, 3],
    minCueSeconds: [0.3, 5],
    maxCueSeconds: [1.5, 12],
    readingCps: [0, 30],
    gapFrames: [0, 12]
  };
  function readSrt(raw) {
    const source = raw ?? {};
    const out = { ...SRT_DEFAULTS };
    for (const key of Object.keys(SRT_DEFAULTS)) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        const [low, high] = SRT_RANGE[key];
        out[key] = Math.min(high, Math.max(low, value));
      }
    }
    out.maxCueSeconds = Math.max(out.maxCueSeconds, out.minCueSeconds + 0.5);
    return out;
  }
  async function writeConfig(config) {
    try {
      await write(await workspace(), CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (cause) {
      console.error("[Legendas] não foi possível salvar os ajustes:", cause);
    }
  }
  const SNAPSHOT_FILE = "captions-written.json";
  async function readSnapshots() {
    try {
      const raw = readText(await workspace(), SNAPSHOT_FILE);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  async function writeSnapshot(mediaPath, transcript) {
    try {
      const all = await readSnapshots();
      all[mediaPath] = transcript;
      const keys = Object.keys(all);
      if (keys.length > 40) {
        for (const old of keys.slice(0, keys.length - 40)) {
          delete all[old];
        }
      }
      await write(await workspace(), SNAPSHOT_FILE, JSON.stringify(all));
    } catch (cause) {
      console.error("[Legendas] não foi possível guardar o escrito:", cause);
    }
  }
  const LAST_RUN_FILE = "captions-last-run.json";
  async function readLastRun() {
    try {
      const raw = readText(await workspace(), LAST_RUN_FILE);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.transcript?.segments?.length) {
        return null;
      }
      return {
        at: typeof parsed.at === "number" ? parsed.at : 0,
        fps: typeof parsed.fps === "number" ? parsed.fps : 0,
        clips: typeof parsed.clips === "number" ? parsed.clips : 0,
        label: typeof parsed.label === "string" ? parsed.label : "última transcrição",
        transcript: parsed.transcript
      };
    } catch {
      return null;
    }
  }
  async function writeLastRun(run2) {
    try {
      await write(await workspace(), LAST_RUN_FILE, JSON.stringify(run2));
    } catch (cause) {
      console.error("[Legendas] não foi possível guardar a última transcrição:", cause);
    }
  }
  function diffCorrections(written, current, toleranceSeconds = 0.25) {
    const ours = written.segments.flatMap((segment) => segment.words);
    if (ours.length === 0 || current.length === 0) {
      return [];
    }
    const tally = /* @__PURE__ */ new Map();
    let cursor = 0;
    for (const mine of ours) {
      while (cursor < current.length && current[cursor].start < mine.start - toleranceSeconds) {
        cursor += 1;
      }
      const theirs = current[cursor];
      if (!theirs || Math.abs(theirs.start - mine.start) > toleranceSeconds) {
        continue;
      }
      const before = mine.text.trim();
      const after = theirs.text.trim();
      if (!before || !after || before === after) {
        continue;
      }
      if (fold(before) === fold(after)) {
        continue;
      }
      const looksProper = /^[A-ZÀ-Ý]/.test(after);
      if (!looksProper && !resembles(fold(before), fold(after))) {
        continue;
      }
      const key = `${fold(before)}→${after}`;
      const found = tally.get(key);
      if (found) {
        found.times += 1;
      } else {
        tally.set(key, { from: before, to: after, times: 1 });
      }
    }
    return [...tally.values()].sort((a, b) => b.times - a.times);
  }
  function resembles(a, b) {
    if (!a || !b) {
      return false;
    }
    const longest = Math.max(a.length, b.length);
    if (longest < 3) {
      return false;
    }
    let distance2 = 0;
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    let row = previous;
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current.push(
          Math.min(
            row[j] + 1,
            current[j - 1] + 1,
            row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
          )
        );
      }
      row = current;
    }
    distance2 = row[b.length];
    return distance2 / longest < 0.4;
  }
  function worthLearning(candidates2) {
    return candidates2.filter(
      (candidate) => candidate.times >= 2 || /^[A-ZÀ-Ý]/.test(candidate.to.trim())
    );
  }
  function mergeIntoGlossary(glossary, learned) {
    const existing = new Set(
      glossary.split(/\r?\n/).map((line) => fold(line)).filter(Boolean)
    );
    const added = [];
    for (const candidate of learned) {
      const term = candidate.to.trim().replace(/[.,;:!?]+$/, "");
      if (!term || existing.has(fold(term))) {
        continue;
      }
      existing.add(fold(term));
      added.push(term);
    }
    if (added.length === 0) {
      return { text: glossary, added };
    }
    const base = glossary.trimEnd();
    return {
      text: (base ? `${base}
` : "") + added.join("\n") + "\n",
      added
    };
  }
  const SHAPES = [
    {
      id: "v1-schema",
      label: "schema v1.0.0 com cabeçalho",
      build: (transcript, language) => JSON.stringify({
        $schema: "https://schemas.adobe.com/transcript/v1.0.0",
        version: "1.0.0",
        language,
        speakers: [{ id: "s0", name: "Locutor 1" }],
        segments: transcript.segments.map((segment, index) => ({
          id: `seg${index}`,
          speakerId: "s0",
          start: segment.start,
          duration: segmentDuration(segment),
          words: segment.words.map((word, at) => ({
            id: `w${index}_${at}`,
            text: word.text,
            start: word.start,
            duration: word.duration,
            type: "word",
            confidence: word.confidence,
            tags: []
          }))
        }))
      })
    },
    {
      id: "v1-plain",
      label: "schema v1.0.0 mínimo",
      build: (transcript) => JSON.stringify(transcript)
    },
    {
      id: "monologues",
      label: "formato antigo (monologues)",
      build: (transcript) => JSON.stringify({
        monologues: transcript.segments.map((segment) => ({
          speaker: 0,
          elements: segment.words.map((word) => ({
            type: "text",
            value: word.text,
            ts: word.start,
            end_ts: word.start + word.duration,
            confidence: word.confidence
          }))
        }))
      })
    }
  ];
  function segmentDuration(segment) {
    const words = segment.words;
    if (words.length === 0) {
      return 0;
    }
    const last = words[words.length - 1];
    return Math.max(0.01, last.start + last.duration - segment.start);
  }
  let known = null;
  function rememberShape(id) {
    known = id;
  }
  function shapesToTry() {
    if (!known) {
      return [...SHAPES];
    }
    const first = SHAPES.filter((shape) => shape.id === known);
    return [...first, ...SHAPES.filter((shape) => shape.id !== known)];
  }
  function assembleArgs(clips, sampleRate = 16e3) {
    const base = clips.length > 0 ? clips.reduce((first, clip) => Math.min(first, clip.seqStart), Infinity) : 0;
    const inputs = [];
    const parts = [];
    const labels = [];
    clips.forEach((clip, index) => {
      const duration = Math.max(0.05, clip.seqEnd - clip.seqStart);
      inputs.push([
        "-ss",
        clip.inPoint.toFixed(6),
        "-t",
        duration.toFixed(6),
        "-i",
        clip.mediaPath
      ]);
      const delay = Math.max(0, Math.round((clip.seqStart - base) * 1e3));
      parts.push(
        `[${index}:a]aresample=${sampleRate},adelay=${delay}:all=1[a${index}]`
      );
      labels.push(`[a${index}]`);
    });
    const total = clips.reduce((end, clip) => Math.max(end, clip.seqEnd - base), 0);
    const mix = clips.length === 1 ? `${labels[0]}apad[out]` : `${labels.join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad[out]`;
    return {
      inputs,
      filter: [...parts, mix].join(";"),
      durationSeconds: total,
      baseOffset: Number.isFinite(base) ? base : 0
    };
  }
  function splitByClip(transcript, clips) {
    const out = /* @__PURE__ */ new Map();
    if (clips.length === 0) {
      return out;
    }
    const ordered = [...clips].sort((a, b) => a.seqStart - b.seqStart);
    for (const segment of transcript.segments) {
      const byClip = /* @__PURE__ */ new Map();
      for (const word of segment.words) {
        const clip = ordered.find(
          (candidate) => word.start >= candidate.seqStart - 1e-6 && word.start < candidate.seqEnd - 1e-6
        );
        if (!clip) {
          continue;
        }
        const list = byClip.get(clip.key) ?? [];
        list.push({
          ...word,
          // De tempo de sequência para tempo de mídia.
          start: round(clip.inPoint + (word.start - clip.seqStart))
        });
        byClip.set(clip.key, list);
      }
      for (const [key, words] of byClip) {
        if (words.length === 0) {
          continue;
        }
        const existing = out.get(key) ?? { version: transcript.version, segments: [] };
        existing.segments.push({ start: words[0].start, words });
        out.set(key, existing);
      }
    }
    return out;
  }
  function round(value) {
    return Math.round(value * 1e3) / 1e3;
  }
  function trackLabel(index) {
    return `A${index + 1}`;
  }
  function commitTransaction(project2, label, build) {
    let committed = false;
    project2.lockedAccess(() => {
      committed = project2.executeTransaction(build, label);
    });
    return committed;
  }
  async function scanTracks() {
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
      throw new Error("Nenhuma sequência aberta.");
    }
    let fps = 0;
    try {
      const settings = await sequence.getSettings();
      const rate = settings?.getVideoFrameRate?.();
      if (rate && Number.isFinite(rate.value) && rate.value > 0) {
        fps = rate.value;
      }
    } catch {
    }
    const tracks = [];
    const count = await sequence.getAudioTrackCount();
    for (let index = 0; index < count; index += 1) {
      const track = await sequence.getAudioTrack(index);
      if (!track) {
        continue;
      }
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const clips = [];
      for (const item of items) {
        const clip = await readClip(ppro, item, index);
        if (clip) {
          clips.push(clip);
        }
      }
      tracks.push({
        index,
        label: trackLabel(index),
        clips,
        usable: clips.length
      });
    }
    return {
      tracks,
      usable: tracks.reduce((total, track) => total + track.usable, 0),
      fps
    };
  }
  async function readClip(ppro, item, trackIndex) {
    try {
      const speed = await item.getSpeed().catch(() => 1);
      if (Number.isFinite(speed) && Math.abs(speed - 1) > 1e-3) {
        return null;
      }
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      const inPoint = await item.getInPoint();
      const projectItem = await item.getProjectItem();
      if (!projectItem) {
        return null;
      }
      const clipItem = ppro.ClipProjectItem.cast(projectItem);
      const mediaPath = await clipItem.getMediaFilePath().catch(() => "");
      if (!mediaPath) {
        return null;
      }
      const name = await item.getName().catch(() => projectItem.name ?? "clipe");
      let hadTranscript = false;
      try {
        hadTranscript = ppro.Transcript?.hasTranscript?.(clipItem) === true;
      } catch {
      }
      return {
        key: `${trackIndex}:${start.ticks}`,
        name,
        mediaPath,
        seqStart: start.seconds,
        seqEnd: end.seconds,
        inPoint: inPoint.seconds,
        trackIndex,
        clipItem,
        hadTranscript,
        words: 0,
        corrections: []
      };
    } catch {
      return null;
    }
  }
  function clipsFor(scan, track) {
    const chosen = track === "all" ? scan.tracks : scan.tracks.filter((entry) => entry.index === track);
    return chosen.flatMap((entry) => entry.clips);
  }
  async function transcribeTracks(scan, options) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", imported: 0, stages: [], srtPath: null, cues: 0 };
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      return { ok: false, message: "Nenhum projeto aberto.", imported: 0, stages: [], srtPath: null, cues: 0 };
    }
    if (!ppro.Transcript?.importFromJSON || !ppro.Transcript?.createImportTextSegmentsAction) {
      return {
        ok: false,
        message: "Esta versão do Premiere não aceita importar transcrição pelo painel.",
        imported: 0,
        stages: ["API de transcrição ausente neste host"],
        srtPath: null,
        cues: 0
      };
    }
    const stages = [];
    const clips = clipsFor(scan, options.track);
    stages.push(`clipes na escolha: ${clips.length}`);
    if (clips.length === 0) {
      return {
        ok: false,
        message: "Nenhum clipe de áudio nessa escolha.",
        imported: 0,
        stages,
        srtPath: null,
        cues: 0
      };
    }
    const terms = parseGlossary(effectiveGlossary(options.glossaryText));
    const assembled = assembleArgs(clips);
    options.onStage?.("Iniciando motor Whisper…");
    const result = await transcribe(
      assembled,
      options.model,
      options.language,
      promptFrom(terms),
      options.onStage,
      options.cancelled,
      options.onManual
    );
    if (!result.ok || !result.json) {
      stages.push(`motor: ${result.error ?? "sem resposta"}`);
      return {
        ok: false,
        message: describeError(result.error, result.detected),
        imported: 0,
        stages,
        srtPath: null,
        cues: 0
      };
    }
    stages.push("motor: concluiu");
    options.onStage?.("Processando transcrição e glossário…");
    const sequenceWide = whisperToAdobe(result.json, assembled.baseOffset);
    const heard = countWords(sequenceWide);
    stages.push(`palavras ouvidas: ${heard}`);
    options.onStage?.("Gerando arquivo .srt…");
    const emitted = await emitSrt(
      project2,
      sequenceWide,
      options.srt ?? SRT_DEFAULTS,
      scan.fps,
      stages
    );
    const { srtPath, cues } = emitted;
    const srtInProject = emitted.inProject;
    await writeLastRun({
      at: Date.now(),
      fps: scan.fps,
      clips: clips.length,
      label: options.track === "all" ? `${clips.length} ${clips.length === 1 ? "clipe" : "clipes"}, todas as faixas` : `${clips.length} ${clips.length === 1 ? "clipe" : "clipes"} de ${trackLabel(options.track)}`,
      transcript: sequenceWide
    });
    const perClip = splitByClip(sequenceWide, clips);
    const placed = [...perClip.values()].reduce(
      (total, transcript) => total + countWords(transcript),
      0
    );
    stages.push(`palavras encaixadas em clipes: ${placed}`);
    if (heard > 0 && placed === 0) {
      return {
        // O .srt já existe e é utilizável: ele sai do tempo de sequência
        // e não passa pelo encaixe que falhou. Devolvê-lo é a diferença
        // entre "não deu" e "está no seu projeto, e me avise disto".
        ok: cues > 0,
        message: `O motor ouviu ${heard} palavras, mas nenhuma caiu dentro dos clipes — os tempos não bateram. ` + (cues > 0 ? `Ainda assim o .srt saiu com ${cues} legendas` + (srtInProject ? " e está no seu projeto. " : `: ${srtPath}. `) + "Me mande esta mensagem mesmo assim." : "Me mande esta mensagem."),
        imported: 0,
        stages,
        srtPath,
        cues
      };
    }
    let imported = 0;
    const failures = [];
    const notes = [];
    options.onStage?.("Importando legendas para o Premiere…");
    for (const clip of clips) {
      const raw = perClip.get(clip.key);
      if (!raw) {
        continue;
      }
      const { transcript, corrections } = applyGlossary(raw, terms);
      clip.words = countWords(transcript);
      clip.corrections = corrections;
      if (clip.words === 0) {
        continue;
      }
      if (importInto(ppro, project2, clip, transcript, options.language, notes)) {
        imported += 1;
        await writeSnapshot(clip.mediaPath, transcript);
      } else {
        failures.push(clip.name);
      }
    }
    stages.push(`importados: ${imported}`);
    if (failures.length > 0) {
      stages.push(`recusados pelo Premiere: ${failures.length}`);
      for (const note of [...new Set(notes)].slice(0, 4)) {
        stages.push(note);
      }
      stages.push(...await describeHostSchema(scan));
    }
    if (imported === 0) {
      if (cues > 0) {
        return {
          ok: true,
          message: `${cues} legendas geradas. ` + (srtInProject ? "O .srt está no seu projeto — arraste para a timeline." : `Arquivo salvo: ${srtPath}`),
          imported: 0,
          stages,
          srtPath,
          cues
        };
      }
      return {
        ok: false,
        message: failures.length > 0 ? `O Premiere recusou a importação de ${failures.length} clipe(s).` : "Nenhuma fala reconhecida nesta faixa.",
        imported: 0,
        stages,
        srtPath,
        cues
      };
    }
    const head = `${imported} ${imported === 1 ? "clipe transcrito" : "clipes transcritos"}`;
    const comoAplicar = srtInProject ? ` · ${cues} legendas no .srt dentro do projeto — arraste para a timeline` : cues > 0 ? ` · .srt salvo em ${srtPath}` : "";
    return {
      ok: failures.length === 0,
      message: `${head}${comoAplicar}`,
      imported,
      stages,
      srtPath,
      cues
    };
  }
  async function emitSrt(project2, transcript, options, fps, stages) {
    let srtPath = null;
    let cues = 0;
    try {
      const built = buildCues(transcript, options, fps);
      cues = built.length;
      if (cues > 0) {
        const space = await workspace();
        const name = `legendas-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${Date.now().toString(36)}.srt`;
        await write(space, name, cuesToSrt(built));
        srtPath = nativePath(space, name);
        stages.push(`legendas no .srt: ${cues}`);
      }
    } catch (cause) {
      stages.push(`falha ao gerar o .srt: ${describeError$1(cause)}`);
      return { srtPath: null, cues: 0, inProject: false };
    }
    let inProject = false;
    if (srtPath) {
      try {
        inProject = await project2.importFiles([srtPath], true) === true;
      } catch (cause) {
        stages.push(`o .srt não entrou no projeto: ${describeError$1(cause)}`);
      }
    }
    return { srtPath, cues, inProject };
  }
  async function rebuildSrt(options) {
    const last = await readLastRun();
    if (!last) {
      return {
        ok: false,
        message: "Nada transcrito ainda nesta máquina — transcreva uma vez primeiro.",
        srtPath: null,
        cues: 0
      };
    }
    const ppro = getPremiere();
    const project2 = ppro ? await ppro.Project.getActiveProject() : null;
    if (!project2) {
      return { ok: false, message: "Nenhum projeto aberto.", srtPath: null, cues: 0 };
    }
    const stages = [];
    const { srtPath, cues, inProject } = await emitSrt(
      project2,
      last.transcript,
      options,
      last.fps,
      stages
    );
    if (cues === 0) {
      return {
        ok: false,
        message: stages[0] ?? "Estes limites não produziram nenhuma legenda.",
        srtPath: null,
        cues: 0
      };
    }
    return {
      ok: true,
      message: `${cues} legendas refeitas de ${last.label}. ` + (inProject ? "O .srt novo está no seu projeto — arraste para a timeline." : `Arquivo salvo: ${srtPath}`),
      srtPath,
      cues
    };
  }
  function importInto(ppro, project2, clip, transcript, language, notes) {
    for (const shape of shapesToTry()) {
      let segments = null;
      try {
        segments = ppro.Transcript.importFromJSON(shape.build(transcript, language));
      } catch (cause) {
        notes.push(`${shape.id}: importFromJSON lançou — ${describeError$1(cause)}`);
        continue;
      }
      if (!segments) {
        notes.push(`${shape.id}: importFromJSON devolveu vazio`);
        continue;
      }
      try {
        const ok = commitTransaction(project2, "Importar transcrição", (tx) => {
          tx.addAction(
            ppro.Transcript.createImportTextSegmentsAction(
              segments,
              clip.clipItem
            )
          );
        });
        if (ok) {
          rememberShape(shape.id);
          return true;
        }
        notes.push(`${shape.id}: o host recusou a transação`);
      } catch (cause) {
        notes.push(`${shape.id}: a transação lançou — ${describeError$1(cause)}`);
      }
    }
    return false;
  }
  async function learnFromCorrections(scan, track) {
    const ppro = getPremiere();
    if (!ppro) {
      return { candidates: [], checked: 0 };
    }
    const snapshots = await readSnapshots();
    const all = [];
    let checked = 0;
    for (const clip of clipsFor(scan, track)) {
      const written = snapshots[clip.mediaPath];
      if (!written?.segments) {
        continue;
      }
      const current = await readTranscript(ppro, clip.clipItem);
      if (current.status !== "ok" || current.words.length === 0) {
        continue;
      }
      checked += 1;
      const words = current.words.filter((word) => !!word.text).map((word) => ({ text: word.text, start: word.start }));
      all.push(...diffCorrections(written, words));
    }
    const tally = /* @__PURE__ */ new Map();
    for (const candidate of all) {
      const found = tally.get(candidate.to);
      if (found) {
        found.times += candidate.times;
      } else {
        tally.set(candidate.to, { ...candidate });
      }
    }
    return {
      candidates: worthLearning([...tally.values()]).sort((a, b) => b.times - a.times),
      checked
    };
  }
  async function describeHostSchema(scan) {
    const ppro = getPremiere();
    if (!ppro?.Transcript?.exportToJSON) {
      return [];
    }
    for (const clip of clipsFor(scan, "all")) {
      if (!clip.hadTranscript) {
        continue;
      }
      try {
        const raw = await ppro.Transcript.exportToJSON(clip.clipItem);
        if (typeof raw !== "string" || raw.trim().length === 0) {
          continue;
        }
        try {
          await write(await workspace(), "cc-host-schema.json", raw);
        } catch {
        }
        return summarize(raw);
      } catch {
      }
    }
    return ["nenhum clipe da sequência tem transcrição do próprio Premiere"];
  }
  function summarize(raw) {
    try {
      const data = JSON.parse(raw);
      const lines = [`schema do host — raiz: ${Object.keys(data).join(", ")}`];
      const segments = Array.isArray(data.segments) ? data.segments : null;
      if (segments && segments.length > 0 && typeof segments[0] === "object") {
        const segment = segments[0];
        lines.push(`segmento: ${Object.keys(segment).join(", ")}`);
        const words = Array.isArray(segment.words) ? segment.words : null;
        if (words && words.length > 0 && typeof words[0] === "object") {
          lines.push(`palavra: ${Object.keys(words[0]).join(", ")}`);
        }
      }
      lines.push("JSON completo salvo em cc-host-schema.json");
      return lines;
    } catch {
      return ["o host exportou algo que não é JSON"];
    }
  }
  const DEMO_SPEECH = "Então, olha só: o que a gente vai fazer hoje é bem simples. Primeiro eu separo o áudio da entrevista, depois corto tudo que não presta, e no final entra a trilha sonora. || Beleza?";
  function demoTranscript() {
    const words = [];
    let clock = 0.4;
    for (const token of DEMO_SPEECH.split(" ")) {
      if (token === "||") {
        clock += 1.4;
        continue;
      }
      const duration = 0.09 + 0.055 * token.length;
      words.push({
        text: token,
        start: Number(clock.toFixed(3)),
        duration: Number(duration.toFixed(3)),
        type: "word",
        confidence: 1,
        tags: []
      });
      clock += duration + 0.045;
    }
    return { version: "1.0.0", segments: [{ start: 0, words }] };
  }
  const CAP_USABLE_PX = 234;
  const CAP_CHAR_RATIO = 0.49;
  function captionFontPx(chars) {
    const fits = CAP_USABLE_PX / (Math.max(1, chars) * CAP_CHAR_RATIO);
    return Number(Math.min(11, Math.max(6.5, fits)).toFixed(2));
  }
  function seconds(value) {
    return `${value.toFixed(1).replace(".", ",")}s`;
  }
  function shortClock(value) {
    const total = Math.max(0, value);
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(minutes).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0").replace(".", ",")}`;
  }
  function previewMarkup(cues, stats, options, source) {
    if (cues.length === 0) {
      return '<div class="cc-cap-preview"><p class="cc-cap-empty">Estes limites não produzem nenhuma legenda.</p></div>';
    }
    const widest = Math.max(options.maxLineChars, stats.longestLine);
    const screens = cues.slice(0, 2).map((cue) => {
      const lines = cue.lines.map(
        (line) => `<span class="cc-cap-line"><span class="cc-cap-text">${escapeHtml(line)}</span><span class="cc-cap-count">${line.length}</span></span>`
      ).join("");
      return `<div class="cc-cap-screen"><div class="cc-cap-clock"><span>${shortClock(cue.start)}</span><span class="cc-cap-dur">${seconds(cue.end - cue.start)}</span></div><div class="cc-cap-lines">${lines}</div></div>`;
    }).join("");
    const warning = stats.rushed > 0 ? `<p class="cc-cap-warn">${stats.rushed} ${stats.rushed === 1 ? "legenda passa" : "legendas passam"} rápido demais para ${Math.round(options.readingCps)} car/s — aumente os caracteres por linha, ou baixe a velocidade de leitura.</p>` : "";
    return `<div class="cc-cap-preview" style="--cc-cap-size:${captionFontPx(widest)}px">` + screens + `<div class="cc-cap-stats"><span><b>${stats.cues}</b> ${stats.cues === 1 ? "legenda" : "legendas"}</span><span>linha máx <b>${stats.longestLine}</b></span><span>média <b>${seconds(stats.meanSeconds)}</b></span></div>` + warning + `<p class="cc-cap-source">${escapeHtml(source)}</p></div>`;
  }
  const asSeconds = (value) => `${value.toFixed(1).replace(".", ",")}s`;
  const CAP_SLIDERS = [
    {
      key: "maxLineChars",
      label: "Comprimento máximo",
      step: 1,
      format: (value) => `${Math.round(value)} caracteres`
    },
    {
      key: "minCueSeconds",
      label: "Duração mínima",
      step: 0.1,
      format: asSeconds
    },
    {
      key: "gapFrames",
      label: "Intervalo entre legendas",
      step: 1,
      format: (value) => {
        const v = Math.round(value);
        return v === 0 ? "0 quadros (sem gap)" : `${v} ${v === 1 ? "quadro" : "quadros"}`;
      }
    },
    {
      key: "readingCps",
      label: "Velocidade de leitura",
      step: 1,
      // 0 não é "zero caracteres por segundo", é a regra desligada — e
      // mostrar "0 car/s" faria parecer defeito.
      format: (value) => value <= 0 ? "desligada" : `${Math.round(value)} car/s`
    },
    { key: "maxCueSeconds", label: "Duração máxima", step: 0.25, format: asSeconds },
    { key: "gapSeconds", label: "Pausa para silêncio", step: 0.05, format: asSeconds }
  ];
  let cancelActiveRun = null;
  let releaseDocument$1 = null;
  let releaseSliders = null;
  const captionsTool = {
    id: "captions",
    name: "Legendas",
    summary: "Transcrição mais precisa, por faixa de áudio",
    hint: "Escolha a faixa de áudio e transcreva — não precisa selecionar clipe. Sai um .srt já dentro do seu projeto: arraste da janela do projeto para a timeline e a legenda aparece.",
    category: "texto",
    glyph: "caption",
    available: true,
    usesSelection: false,
    mount(container, context) {
      let config = {
        model: "turbo",
        language: "pt",
        glossary: "",
        track: "all",
        srt: { ...SRT_DEFAULTS }
      };
      let scan = null;
      const capSliders = /* @__PURE__ */ new Map();
      let lastRun = null;
      let busy = false;
      container.innerHTML = markup$1();
      const scanBtn = container.querySelector("[data-scan]");
      const learnBtn = container.querySelector("[data-learn]");
      const reportEl = container.querySelector("[data-report]");
      const emptyEl = container.querySelector("[data-empty]");
      const trackHost = container.querySelector("[data-track-pick]");
      const langHost = container.querySelector("[data-lang-pick]");
      const modelSeg = container.querySelector("[data-model-seg]");
      const glossaryEl = container.querySelector("[data-glossary]");
      const glossaryNote = container.querySelector("[data-glossary-note]");
      const manualEl = container.querySelector("[data-manual]");
      const progressEl = container.querySelector("[data-progress]");
      const srtRail = container.querySelector("[data-srt-rail]");
      const srtNote = container.querySelector("[data-srt-note]");
      const linesSeg = container.querySelector("[data-lines-seg]");
      const capPreview = container.querySelector("[data-cap-preview]");
      const redoBtn = container.querySelector("[data-redo]");
      const capAdvToggle = container.querySelector("[data-cap-adv-toggle]");
      const capAdvContent = container.querySelector("[data-cap-adv-content]");
      const capAdvIcon = container.querySelector("[data-cap-adv-icon]");
      let timerInterval = null;
      let startTime = 0;
      const trackPick = trackHost ? mountDropdown(trackHost, {
        options: () => {
          if (!scan) {
            return [{ id: "all", label: "Todas as faixas" }];
          }
          const total = clipsFor(scan, "all").length;
          return [
            {
              id: "all",
              label: "Todas as faixas",
              meta: `${total} ${total === 1 ? "clipe" : "clipes"}`
            },
            ...scan.tracks.map((track) => ({
              id: String(track.index),
              label: track.label,
              meta: track.usable === 0 ? "vazia" : `${track.usable} ${track.usable === 1 ? "clipe" : "clipes"}`
            }))
          ];
        },
        selected: () => String(config.track),
        onPick: (id) => {
          config.track = id === "all" ? "all" : Number.parseInt(id, 10);
          persist();
          trackPick?.render();
          renderReport();
        }
      }) : null;
      const langPick = langHost ? mountDropdown(langHost, {
        options: () => LANGUAGES.map((language) => ({
          id: language.id,
          label: language.label
        })),
        selected: () => config.language,
        onPick: (id) => {
          config.language = id;
          persist();
          langPick?.render();
        }
      }) : null;
      const closeMenus = (target) => {
        trackPick?.closeUnless(target);
        langPick?.closeUnless(target);
      };
      const onDocumentPointer = (event) => closeMenus(event.target);
      const onDocumentKey = (event) => {
        if (event.key === "Escape") closeMenus(null);
      };
      document.addEventListener("click", onDocumentPointer, true);
      document.addEventListener("keydown", onDocumentKey, true);
      releaseDocument$1 = () => {
        document.removeEventListener("click", onDocumentPointer, true);
        document.removeEventListener("keydown", onDocumentKey, true);
      };
      context.setApplyLabel("TRANSCREVER");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      void (async () => {
        config = await readConfig();
        if (glossaryEl) glossaryEl.value = config.glossary;
        lastRun = await readLastRun();
        trackPick?.render();
        langPick?.render();
        syncModel();
        syncGlossaryNote();
        syncCaptionFormat();
        await runScan(true);
      })();
      function persist() {
        void writeConfig(config);
      }
      function syncModel() {
        for (const item of modelSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute("aria-pressed", String(item.dataset.model === config.model));
        }
      }
      modelSeg?.addEventListener("click", (event) => {
        const id = event.target?.closest("[data-model]")?.dataset.model;
        if (!id) return;
        config.model = id;
        persist();
        syncModel();
      });
      function setSrt(key, value) {
        if (!Number.isFinite(value)) return;
        const [low, high] = SRT_RANGE[key];
        const next = { ...config.srt, [key]: Math.min(high, Math.max(low, value)) };
        if (key === "minCueSeconds") {
          next.maxCueSeconds = Math.max(next.maxCueSeconds, next.minCueSeconds + 0.5);
        } else if (key === "maxCueSeconds") {
          next.minCueSeconds = Math.min(next.minCueSeconds, next.maxCueSeconds - 0.5);
        }
        config.srt = next;
        persist();
        syncCaptionFormat();
      }
      srtRail?.addEventListener("click", (event) => {
        const id = event.target?.closest("[data-preset]")?.dataset.preset;
        const preset = SRT_PRESETS.find((entry) => entry.id === id);
        if (!preset) return;
        config.srt = { ...preset.options };
        persist();
        syncCaptionFormat();
      });
      linesSeg?.addEventListener("click", (event) => {
        const raw = event.target?.closest("[data-lines]")?.dataset.lines;
        if (raw) setSrt("maxLines", Number.parseInt(raw, 10));
      });
      for (const spec of CAP_SLIDERS) {
        const rail = container.querySelector(`[data-cap="${spec.key}"]`);
        if (!rail) continue;
        const [low, high] = SRT_RANGE[spec.key];
        capSliders.set(
          spec.key,
          mountSlider(rail, {
            min: low,
            max: high,
            step: spec.step,
            value: SRT_DEFAULTS[spec.key],
            label: spec.label,
            format: spec.format,
            output: container.querySelector(`[data-cap-out="${spec.key}"]`),
            onInput: (value) => setSrt(spec.key, value)
          })
        );
      }
      capAdvToggle?.addEventListener("click", () => {
        if (!capAdvContent) return;
        const willOpen = capAdvContent.hidden;
        capAdvContent.hidden = !willOpen;
        if (capAdvIcon) capAdvIcon.style.transform = willOpen ? "rotate(180deg)" : "";
      });
      function syncCaptionFormat() {
        const active = matchPreset(config.srt);
        for (const pill of srtRail?.querySelectorAll(".preset-pill") ?? []) {
          pill.classList.toggle("is-active", pill.dataset.preset === active);
        }
        if (srtNote) {
          srtNote.textContent = SRT_PRESETS.find((entry) => entry.id === active)?.note ?? "Personalizado — estes números já não são os de nenhum preset.";
        }
        for (const item of linesSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(Number(item.dataset.lines) === config.srt.maxLines)
          );
        }
        for (const spec of CAP_SLIDERS) {
          capSliders.get(spec.key)?.set(config.srt[spec.key]);
        }
        renderCapPreview();
      }
      function showFps(value) {
        return String(Number(value.toFixed(3))).replace(".", ",");
      }
      function renderCapPreview() {
        if (!capPreview) return;
        const fps = scan?.fps || lastRun?.fps || 0;
        const source = lastRun?.transcript ?? demoTranscript();
        const cues = buildCues(source, config.srt, fps);
        capPreview.innerHTML = previewMarkup(
          cues,
          measureCues(cues, config.srt),
          config.srt,
          lastRun ? `da sua última transcrição · ${lastRun.label}` + (fps > 0 ? ` · ${showFps(fps)} fps` : "") : "fala de demonstração — transcreva uma vez e a prévia passa a usar o seu material"
        );
        if (redoBtn) redoBtn.hidden = !lastRun;
      }
      redoBtn?.addEventListener("click", () => void runRebuild());
      async function runRebuild() {
        if (busy || !lastRun) return;
        busy = true;
        if (redoBtn) {
          setDisabled(redoBtn, true);
          redoBtn.textContent = "Gerando…";
        }
        try {
          const result = await rebuildSrt(config.srt);
          context.setStatus(result.message, result.ok ? "done" : "error");
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy = false;
          if (redoBtn) {
            setDisabled(redoBtn, false);
            redoBtn.textContent = "Refazer o .srt com estes ajustes";
          }
        }
      }
      glossaryEl?.addEventListener("input", () => {
        config.glossary = glossaryEl.value;
        syncGlossaryNote();
      });
      glossaryEl?.addEventListener("change", () => persist());
      function syncGlossaryNote() {
        if (!glossaryNote) return;
        const count = config.glossary.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")).length;
        glossaryNote.textContent = count === 0 ? "Um termo por linha: nomes, marcas, jargão. Já vem com o vocabulário de edição de fábrica." : `${count} ${count === 1 ? "termo seu" : "termos seus"}, mais o vocabulário de fábrica.`;
      }
      scanBtn?.addEventListener("click", () => void runScan());
      async function runScan(silent = false) {
        if (busy) return;
        busy = true;
        if (scanBtn) {
          setDisabled(scanBtn, true);
          scanBtn.textContent = "Lendo…";
        }
        try {
          scan = await scanTracks();
          if (config.track !== "all" && !scan.tracks.some((track) => track.index === config.track)) {
            config.track = "all";
          }
          trackPick?.render();
          renderReport();
          renderCapPreview();
          const chosen = clipsFor(scan, config.track).length;
          context.setApplyEnabled(chosen > 0);
          context.setStatus(
            scan.usable === 0 ? "Nenhum clipe de áudio com arquivo nesta sequência." : `${scan.tracks.length} ${scan.tracks.length === 1 ? "faixa" : "faixas"} · ${chosen} ${chosen === 1 ? "clipe" : "clipes"} na escolha atual.`,
            scan.usable > 0 ? "done" : "idle"
          );
        } catch (cause) {
          scan = null;
          if (!silent) {
            context.setStatus(describeError$1(cause), "error");
          }
        } finally {
          busy = false;
          if (scanBtn) {
            setDisabled(scanBtn, false);
            scanBtn.textContent = "Reler a sequência";
          }
        }
      }
      function showProgress(stage) {
        if (!progressEl) return;
        if (stage === null) {
          if (timerInterval !== null) {
            window.clearInterval(timerInterval);
            timerInterval = null;
          }
          progressEl.hidden = true;
          progressEl.innerHTML = "";
          return;
        }
        progressEl.hidden = false;
        if (timerInterval === null) {
          startTime = Date.now();
          timerInterval = window.setInterval(updateElapsed, 500);
        }
        function formatElapsed() {
          const total = Math.max(0, Math.floor((Date.now() - startTime) / 1e3));
          const mins = Math.floor(total / 60);
          const secs = total % 60;
          return `${mins}:${secs.toString().padStart(2, "0")}`;
        }
        function updateElapsed() {
          const timeEl = progressEl?.querySelector("[data-elapsed]");
          if (timeEl) timeEl.textContent = formatElapsed();
        }
        const stageText = escapeHtml(stage || "Transcrevendo áudio…");
        const elapsed = formatElapsed();
        progressEl.innerHTML = `<div class="cc-progress-head"><span class="cc-progress-title"><span class="cc-progress-spinner"></span><span>${stageText}</span></span><span class="cc-progress-time" data-elapsed>${elapsed}</span></div><div class="cc-progress-track"><span class="cc-progress-fill"></span></div><p class="cc-progress-desc">Processando áudio com Whisper. O resultado vira um arquivo .srt pronto para uso.</p>`;
      }
      context.setApplyHandler(async () => {
        if (!scan || busy) return;
        if (clipsFor(scan, config.track).length === 0) return;
        busy = true;
        let cancelled = false;
        cancelActiveRun = () => {
          cancelled = true;
        };
        context.setApplyEnabled(false);
        context.setApplyLabel("TRANSCREVENDO…");
        hideManual();
        showProgress("Iniciando transcrição…");
        try {
          const result = await transcribeTracks(scan, {
            model: findModel(config.model),
            language: config.language,
            glossaryText: config.glossary,
            track: config.track,
            srt: config.srt,
            onStage: (text2) => {
              showProgress(text2);
              context.setStatus(`${findLanguage(config.language).label} · ${text2}`);
            },
            cancelled: () => cancelled,
            onManual: showManual
          });
          showProgress(null);
          renderReport();
          lastRun = await readLastRun();
          syncCaptionFormat();
          context.setStatus(result.message, result.ok ? "done" : "error");
          showStages(result.ok ? [] : result.stages);
          if (result.imported > 0) {
            context.setResetHandler(() => clearAll());
          } else {
            context.setApplyEnabled(true);
          }
        } catch (cause) {
          showProgress(null);
          context.setStatus(describeError$1(cause), "error");
          context.setApplyEnabled(true);
        } finally {
          showProgress(null);
          busy = false;
          cancelActiveRun = null;
          context.setApplyLabel("TRANSCREVER");
        }
      });
      function clearAll() {
        scan = null;
        trackPick?.render();
        renderReport();
        context.setResetHandler(null);
        context.setApplyEnabled(false);
        context.setStatus("", "idle");
      }
      learnBtn?.addEventListener("click", () => void runLearn());
      async function runLearn() {
        if (busy) return;
        busy = true;
        if (learnBtn) {
          setDisabled(learnBtn, true);
          learnBtn.textContent = "Comparando…";
        }
        try {
          const fresh = scan ?? await scanTracks();
          scan = fresh;
          const { candidates: candidates2, checked } = await learnFromCorrections(fresh, config.track);
          if (checked === 0) {
            context.setStatus(
              "Nada para comparar — transcreva pelo painel, corrija à mão, e volte aqui.",
              "idle"
            );
            return;
          }
          if (candidates2.length === 0) {
            context.setStatus(
              `${checked} ${checked === 1 ? "clipe conferido" : "clipes conferidos"} — nenhuma correção nova.`,
              "done"
            );
            return;
          }
          const { text: text2, added } = mergeIntoGlossary(config.glossary, candidates2);
          if (added.length === 0) {
            context.setStatus("As correções encontradas já estão no glossário.", "done");
            return;
          }
          config.glossary = text2;
          if (glossaryEl) glossaryEl.value = text2;
          syncGlossaryNote();
          persist();
          context.setStatus(
            `${added.length} ${added.length === 1 ? "termo aprendido" : "termos aprendidos"}: ` + added.slice(0, 4).join(", ") + (added.length > 4 ? "…" : "") + " — já valem na próxima.",
            "done"
          );
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy = false;
          if (learnBtn) {
            setDisabled(learnBtn, false);
            learnBtn.textContent = "Aprender com minhas correções";
          }
        }
      }
      function renderReport() {
        if (!reportEl) return;
        if (!scan) {
          reportEl.innerHTML = "";
          if (emptyEl) emptyEl.hidden = false;
          return;
        }
        if (emptyEl) emptyEl.hidden = true;
        const shown = config.track === "all" ? scan.tracks : scan.tracks.filter((track) => track.index === config.track);
        reportEl.innerHTML = shown.map(trackRow).join("");
      }
      function trackRow(track) {
        const words = track.clips.reduce((total, clip) => total + clip.words, 0);
        const meta = words > 0 ? `<span class="sil-row-cuts">${words} palavras</span>` : track.usable === 0 ? '<span class="sil-row-skip">vazia</span>' : `<span class="sil-row-time">${track.usable} ${track.usable === 1 ? "clipe" : "clipes"}</span>`;
        let html = '<div class="sil-row-group"><div class="sil-row' + (words > 0 ? " is-ready" : "") + `"><span class="sil-row-name">${track.label}</span>${meta}</div>`;
        const fixes = track.clips.flatMap((clip) => clip.corrections).slice(0, 8);
        if (fixes.length > 0) {
          html += '<div class="fl-hits">';
          for (const fix of fixes) {
            html += `<span class="fl-hit is-tag" title="corrigido pelo glossário"><b>${escapeHtml(fix.to)}</b>${escapeHtml(fix.from)}</span>`;
          }
          html += "</div>";
        }
        return html + "</div>";
      }
      function showManual(scriptPath, reason) {
        if (!manualEl) return;
        manualEl.hidden = false;
        manualEl.innerHTML = `<p class="sil-manual-why">O sistema não executou o script (${escapeHtml(reason)}). Dê um duplo clique nele e volte — o painel continua esperando.</p><p class="sil-manual-path">${escapeHtml(scriptPath)}</p>`;
      }
      function showStages(stages) {
        if (!manualEl) return;
        if (stages.length === 0) {
          manualEl.hidden = true;
          manualEl.innerHTML = "";
          return;
        }
        manualEl.hidden = false;
        manualEl.innerHTML = `<p class="sil-manual-why">Onde parou:</p><p class="sil-manual-path">${stages.map(escapeHtml).join("\n")}</p>`;
      }
      function hideManual() {
        if (manualEl) {
          manualEl.hidden = true;
          manualEl.innerHTML = "";
        }
      }
      context.setRefreshHandler(null);
      releaseSliders = () => {
        for (const handle of capSliders.values()) handle.destroy();
        capSliders.clear();
      };
    },
    unmount() {
      cancelActiveRun?.();
      cancelActiveRun = null;
      releaseDocument$1?.();
      releaseDocument$1 = null;
      releaseSliders?.();
      releaseSliders = null;
    }
  };
  function markup$1() {
    const models = MODELS.map(
      (model) => `<div class="seg-item" ${CONTROL} data-model="${model.id}" title="${escapeHtml(model.note)}">${escapeHtml(model.label)}</div>`
    ).join("");
    const srtPresets = SRT_PRESETS.map(
      (preset) => `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}">${escapeHtml(preset.name)}</div>`
    ).join("");
    const lineCounts = [1, 2, 3].map(
      (count) => `<div class="seg-item" ${CONTROL} data-lines="${count}">${count} ${count === 1 ? "linha" : "linhas"}</div>`
    ).join("");
    const capSlider = (key) => {
      const spec = CAP_SLIDERS.find((entry) => entry.key === key);
      if (!spec) return "";
      return `<div class="field"><div class="field-head"><span class="t-label">${spec.label}</span><span class="field-val" data-cap-out="${key}">${spec.format(SRT_DEFAULTS[key])}</span></div><div class="slider-row"><div data-cap="${key}"></div></div></div>`;
    };
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Faixa de áudio</span><div data-track-pick></div><p class="field-note">A faixa vai inteira para o motor, com os silêncios entre os clipes — é o que faz uma frase cortada no meio sair inteira.</p></div><div class="field"><span class="t-label">Idioma</span><div data-lang-pick></div></div><div class="field"><span class="t-label">Qualidade</span><div class="seg" data-model-seg>${models}</div><p class="field-note">O modelo baixa sozinho na primeira vez.</p></div></div><div class="zone"><div class="field"><span class="t-label">Formato da legenda</span><div class="preset-rail" data-srt-rail>${srtPresets}</div><p class="field-note" data-srt-note></p></div><div class="field"><span class="t-label">Linhas</span><div class="seg" data-lines-seg>${lineCounts}</div></div>` + capSlider("maxLineChars") + capSlider("minCueSeconds") + capSlider("gapFrames") + `<p class="field-note">Com 0 quadros de intervalo, a legenda seguinte entra imediatamente sem piscar tela preta, exceto quando houver momento de silêncio na fala.</p><div data-cap-preview></div><div class="cc-redo" ${CONTROL} data-redo hidden>Refazer o .srt com estes ajustes</div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-cap-adv-toggle><span class="sil-advanced-title">Ajustes adicionais</span><span class="sil-advanced-icon" data-cap-adv-icon>▾</span></div><div class="sil-advanced-content" data-cap-adv-content hidden>` + capSlider("readingCps") + capSlider("maxCueSeconds") + capSlider("gapSeconds") + `<p class="field-note"><b>Pausa para silêncio</b> é o tempo de silêncio na fala que encerra uma legenda em vez de emendar na próxima. <b>Velocidade de leitura</b> garante tempo de leitura aos olhos.</p></div></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Glossário do projeto</span></div><textarea class="dl-urls" data-glossary spellcheck="false" rows="4" placeholder="Framelab&#10;Sidy Furtado&#10;nome do cliente"></textarea><p class="field-note" data-glossary-note></p></div></div><div class="zone"><div class="cc-heads-up"><p class="cc-heads-up-title">Na primeira vez o macOS vai perguntar duas coisas</p><p class="cc-heads-up-body"><b>Pasta da sua mídia</b> (Google Drive, Documentos…): <b>permita</b> — é de onde o áudio é lido.<br><b>Microfone</b>: <b>pode negar</b>. O plugin nunca grava áudio; o pedido vem de uma biblioteca que o conversor de áudio carrega e não usa. Negando, tudo funciona igual.</p></div></div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para transcrever</p><p class="sil-empty-desc">Escolha a faixa acima e transcreva. O resultado vira um .srt no seu projeto, pronto para arrastar para a timeline.</p></div><div class="cc-actions"><div class="org-scan" ${CONTROL} data-scan>Reler a sequência</div><div class="cc-learn" ${CONTROL} data-learn title="Compara o que o plugin escreveu com o que você corrigiu à mão">Aprender com minhas correções</div></div><div class="sil-manual" data-manual hidden></div><div class="cc-progress" data-progress hidden></div><div class="sil-report" data-report></div></div></div>`;
  }
  const TIMING = /^\s*(-?\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,3}:\d{2}[,.]\d{1,3})\s*-->\s*/;
  function measureStyle(doc) {
    let widest = 0;
    let mostLines = 1;
    for (const cue of doc.cues) {
      mostLines = Math.max(mostLines, cue.lines.length);
      for (const line of cue.lines) {
        widest = Math.max(widest, line.length);
      }
    }
    return {
      // Presos a uma faixa utilizável: um arquivo de uma linha só com
      // 120 caracteres não vira régua, e um com duas palavras também não.
      maxLineChars: Math.min(56, Math.max(24, widest || 42)),
      maxLines: Math.min(3, Math.max(1, mostLines))
    };
  }
  function parseSrt(raw) {
    const text2 = raw.replace(/^﻿/, "");
    const eol = text2.includes("\r\n") ? "\r\n" : "\n";
    const linhas = text2.split(/\r\n|\r|\n/);
    const cues = [];
    const headerLines = [];
    let i = 0;
    while (i < linhas.length && !TIMING.test(linhas[i])) {
      const olhaFrente = linhas[i + 1] !== void 0 && TIMING.test(linhas[i + 1]);
      if (olhaFrente) break;
      headerLines.push(linhas[i]);
      i += 1;
    }
    const header = headerLines.join(eol).trim() ? headerLines.join(eol) : "";
    if (!header) i = 0;
    let seq = 0;
    while (i < linhas.length) {
      let index = 0;
      if (!TIMING.test(linhas[i]) && /^\s*\d+\s*$/.test(linhas[i])) {
        index = Number.parseInt(linhas[i].trim(), 10);
        i += 1;
      }
      if (i >= linhas.length) break;
      if (!TIMING.test(linhas[i])) {
        i += 1;
        continue;
      }
      const timing = linhas[i].trim();
      i += 1;
      const corpo = [];
      while (i < linhas.length && linhas[i].trim() !== "" && !TIMING.test(linhas[i])) {
        if (/^\s*\d+\s*$/.test(linhas[i]) && linhas[i + 1] && TIMING.test(linhas[i + 1])) {
          break;
        }
        corpo.push(linhas[i]);
        i += 1;
      }
      while (i < linhas.length && linhas[i].trim() === "") i += 1;
      seq += 1;
      cues.push({ index: index || seq, timing, lines: corpo });
    }
    return { cues, eol, header };
  }
  function serializeSrt(doc) {
    const partes = doc.cues.map(
      (cue, ordem) => `${ordem + 1}${doc.eol}${cue.timing}${doc.eol}${cue.lines.join(doc.eol)}`
    );
    const corpo = partes.join(doc.eol + doc.eol) + doc.eol;
    const cabeca = doc.header ? doc.header.trimEnd() + doc.eol + doc.eol : "";
    return cabeca + corpo;
  }
  const MAX_URL = 5500;
  const MAX_POR_LOTE = 48;
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  function semPalavras(texto) {
    return !/\p{Letter}/u.test(texto);
  }
  function montarUrl(base, textos) {
    return base + textos.map((t) => `&q=${encodeURIComponent(t)}`).join("");
  }
  function loteDe(textos, base, maxUrl = MAX_URL, maxItens = MAX_POR_LOTE) {
    const lotes = [];
    let atual = [];
    for (const texto of textos) {
      const tentativa = [...atual, texto];
      if (atual.length > 0 && (tentativa.length > maxItens || montarUrl(base, tentativa).length > maxUrl)) {
        lotes.push(atual);
        atual = [texto];
      } else {
        atual = tentativa;
      }
    }
    if (atual.length > 0) lotes.push(atual);
    return lotes;
  }
  function lerResposta(bruto, esperados) {
    let dados;
    try {
      dados = JSON.parse(bruto);
    } catch {
      return null;
    }
    if (!Array.isArray(dados) || dados.length !== esperados) {
      return null;
    }
    const texts = [];
    let detected = null;
    for (const item of dados) {
      if (typeof item === "string") {
        texts.push(item);
      } else if (Array.isArray(item) && typeof item[0] === "string") {
        texts.push(item[0]);
        if (!detected && typeof item[1] === "string") detected = item[1];
      } else {
        return null;
      }
    }
    return { texts, detected };
  }
  async function pedirGoogle(textos, from, to) {
    const base = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}`;
    const resposta = await fetch(montarUrl(base, textos), {
      headers: { "User-Agent": UA }
    });
    if (!resposta.ok) return null;
    return lerResposta(await resposta.text(), textos.length);
  }
  async function pedirMyMemory(textos, from, to) {
    const par = `${from === "auto" ? "autodetect" : from}|${to}`;
    const saida = [];
    for (const texto of textos) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}&langpair=${encodeURIComponent(par)}`;
      const resposta = await fetch(url);
      if (!resposta.ok) return null;
      const dados = await resposta.json();
      const traduzido = dados?.responseData?.translatedText;
      if (typeof traduzido !== "string") return null;
      saida.push(traduzido);
    }
    return { texts: saida, detected: null };
  }
  async function translate(entradas, options) {
    const traduzir = entradas.filter((t) => t.trim() !== "" && !semPalavras(t));
    const mapa = /* @__PURE__ */ new Map();
    const base = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${options.from}&tl=${options.to}`;
    const lotes = loteDe([...new Set(traduzir)], base);
    const total = lotes.reduce((soma, lote) => soma + lote.length, 0);
    let feitos = 0;
    let detected = null;
    let usouReserva = false;
    for (const lote of lotes) {
      if (options.cancelled?.()) {
        return { ok: false, texts: [], detected, error: "cancelled" };
      }
      let resposta = null;
      try {
        resposta = await pedirGoogle(lote, options.from, options.to);
      } catch {
        resposta = null;
      }
      if (!resposta) {
        try {
          resposta = await pedirMyMemory(lote, options.from, options.to);
          usouReserva = true;
        } catch {
          resposta = null;
        }
      }
      if (!resposta) {
        return {
          ok: false,
          texts: [],
          detected,
          error: usouReserva ? "both-engines-failed" : "engine-failed"
        };
      }
      if (!detected) detected = resposta.detected;
      lote.forEach((original, i) => mapa.set(original, resposta.texts[i]));
      feitos += lote.length;
      options.onProgress?.(feitos, total);
    }
    return {
      ok: true,
      texts: entradas.map((t) => mapa.get(t) ?? t),
      detected,
      error: null
    };
  }
  const FIM_DE_FRASE = /[.!?…]["'”’)\]]?\s*$/;
  const MAX_BLOCOS_POR_FRASE = 8;
  function agruparFrases(textos) {
    const grupos = [];
    let atual = [];
    textos.forEach((texto, i) => {
      const limpo = texto.trim();
      if (limpo === "" || !/\p{Letter}/u.test(limpo)) {
        if (atual.length > 0) grupos.push(atual);
        grupos.push([i]);
        atual = [];
        return;
      }
      atual.push(i);
      if (FIM_DE_FRASE.test(limpo) || atual.length >= MAX_BLOCOS_POR_FRASE) {
        grupos.push(atual);
        atual = [];
      }
    });
    if (atual.length > 0) grupos.push(atual);
    return grupos;
  }
  function redistribuir(traduzido, pesos) {
    const n = pesos.length;
    if (n <= 1) return [traduzido.trim()];
    const palavras = traduzido.trim().split(/\s+/).filter(Boolean);
    if (palavras.length === 0) return pesos.map(() => "");
    if (palavras.length <= n) {
      return pesos.map((_, i) => palavras[i] ?? "");
    }
    const somaPesos = pesos.reduce((soma, p) => soma + p, 0) || n;
    const partes = [];
    let cursor = 0;
    let restam = palavras.length;
    for (let i = 0; i < n; i += 1) {
      if (i === n - 1) {
        partes.push(palavras.slice(cursor).join(" "));
        break;
      }
      const blocosDepois = n - i - 1;
      const cota = Math.round(pesos[i] / somaPesos * palavras.length);
      const teto = restam - blocosDepois;
      const levar = Math.max(1, Math.min(cota, teto));
      partes.push(palavras.slice(cursor, cursor + levar).join(" "));
      cursor += levar;
      restam -= levar;
    }
    return partes;
  }
  function juntar(lines) {
    return lines.join(" ").replace(/\s+/g, " ").trim();
  }
  async function translateSrt(raw, options) {
    const doc = parseSrt(raw);
    if (doc.cues.length === 0) {
      return {
        ok: false,
        content: null,
        translated: 0,
        total: 0,
        detected: null,
        error: "empty"
      };
    }
    const entradas = doc.cues.map((cue) => juntar(cue.lines));
    const grupos = agruparFrases(entradas);
    const frases = grupos.map((g) => g.map((i) => entradas[i]).join(" ").trim());
    const resultado = await translate(frases, options);
    if (!resultado.ok) {
      return {
        ok: false,
        content: null,
        translated: 0,
        total: doc.cues.length,
        detected: resultado.detected,
        error: resultado.error
      };
    }
    const estilo = measureStyle(doc);
    const regra = {
      ...SRT_DEFAULTS,
      maxLineChars: estilo.maxLineChars,
      maxLines: estilo.maxLines
    };
    function embrulhar(texto) {
      const aperto = wrap(texto, regra);
      const coube = aperto.every((linha) => linha.length <= regra.maxLineChars);
      if (coube || regra.maxLines >= 3) {
        return aperto;
      }
      return wrap(texto, { ...regra, maxLines: regra.maxLines + 1 });
    }
    const porBloco = /* @__PURE__ */ new Map();
    grupos.forEach((grupo, g) => {
      const traduzida = resultado.texts[g] ?? frases[g];
      const pesos = grupo.map((i) => entradas[i].length || 1);
      const partes = redistribuir(traduzida, pesos);
      grupo.forEach((indice, k) => porBloco.set(indice, partes[k] ?? ""));
    });
    let traduzidos = 0;
    const saida = {
      ...doc,
      cues: doc.cues.map((cue, i) => {
        const antes = entradas[i];
        const depois = porBloco.get(i) ?? antes;
        if (antes && depois.trim() !== "" && depois !== antes) traduzidos += 1;
        return {
          ...cue,
          // O relógio atravessa como string. É a invariante da ferramenta.
          timing: cue.timing,
          lines: depois.trim() === "" ? cue.lines : embrulhar(depois.trim())
        };
      })
    };
    return {
      ok: true,
      content: serializeSrt(saida),
      translated: traduzidos,
      total: doc.cues.length,
      detected: resultado.detected,
      error: null
    };
  }
  function previewPairs(raw, content, quantos = 3) {
    const a = parseSrt(raw).cues;
    const b = parseSrt(content).cues;
    const saida = [];
    for (let i = 0; i < Math.min(quantos, a.length, b.length); i += 1) {
      const antes = juntar(a[i].lines);
      if (!antes) continue;
      saida.push({ antes, depois: juntar(b[i].lines) });
    }
    return saida;
  }
  const TARGET_LANGUAGES = [
    { id: "pt", label: "Português" },
    { id: "en", label: "Inglês" },
    { id: "es", label: "Espanhol" },
    { id: "fr", label: "Francês" },
    { id: "it", label: "Italiano" },
    { id: "de", label: "Alemão" },
    { id: "nl", label: "Holandês" },
    { id: "pl", label: "Polonês" },
    { id: "ru", label: "Russo" },
    { id: "tr", label: "Turco" },
    { id: "ar", label: "Árabe" },
    { id: "hi", label: "Híndi" },
    { id: "id", label: "Indonésio" },
    { id: "ja", label: "Japonês" },
    { id: "ko", label: "Coreano" },
    { id: "zh", label: "Chinês" }
  ];
  const SOURCE_LANGUAGES = [
    { id: "auto", label: "Detectar" },
    ...TARGET_LANGUAGES
  ];
  function labelOf(id) {
    if (!id) return "—";
    const achado = SOURCE_LANGUAGES.find((l) => l.id === id);
    return achado?.label ?? id.toUpperCase();
  }
  async function pickSrtFile() {
    const storage = uxpModule("uxp")?.storage;
    const lfs = storage?.localFileSystem;
    if (!lfs?.getFileForOpening) {
      throw new Error("Este build do Premiere não expõe o seletor de arquivos do UXP.");
    }
    const escolhido = await lfs.getFileForOpening({ types: ["srt", ".srt", "vtt", ".vtt"] });
    const entrada = Array.isArray(escolhido) ? escolhido[0] : escolhido;
    if (!entrada) {
      return null;
    }
    return {
      name: entrada.name,
      nativePath: entrada.nativePath ?? null,
      text: await entrada.read()
    };
  }
  async function findSrtInProject() {
    const ppro = getPremiere();
    if (!ppro) return [];
    const api = ppro;
    const project2 = await api.Project.getActiveProject();
    if (!project2) return [];
    const achados = [];
    const vistos = /* @__PURE__ */ new Set();
    async function descer(pasta, profundidade) {
      if (profundidade > 8) return;
      let itens = [];
      try {
        itens = await pasta.getItems();
      } catch {
        return;
      }
      for (const item of itens) {
        try {
          const comoPasta = tentarPasta(api, item);
          if (comoPasta) {
            await descer(comoPasta, profundidade + 1);
            continue;
          }
          const clipe = api.ClipProjectItem.cast(item);
          const caminho = await clipe.getMediaFilePath().catch(() => "");
          if (caminho && /\.(srt|vtt)$/i.test(caminho) && !vistos.has(caminho)) {
            vistos.add(caminho);
            const nome = item.name ?? caminho.split("/").pop() ?? caminho;
            achados.push({ name: nome, path: caminho });
          }
        } catch {
        }
      }
    }
    try {
      await descer(await project2.getRootItem(), 0);
    } catch {
      return achados;
    }
    return achados;
  }
  function tentarPasta(ppro, item) {
    try {
      const pasta = ppro.FolderItem.cast(item);
      return pasta && typeof pasta.getItems === "function" ? pasta : null;
    } catch {
      return null;
    }
  }
  const COPY_SCRIPT = "translate-copy.command";
  const COPY_OUT = "tr-input.srt";
  const COPY_DONE = "tr-copy-done.txt";
  async function readAnyPath(nativePath2) {
    const space = await workspace();
    for (const nome of [COPY_OUT, COPY_DONE]) {
      await remove(space, nome);
    }
    const script = [
      "#!/bin/bash",
      "# Gerado pelo Framelab — traz a legenda para dentro. Pode apagar.",
      "set -u",
      `WORK=${shellQuote(space.nativeBase)}`,
      `if cp ${shellQuote(nativePath2)} "$WORK/${COPY_OUT}" 2>/dev/null; then`,
      `  printf ok > "$WORK/${COPY_DONE}"`,
      "else",
      `  printf falhou > "$WORK/${COPY_DONE}"`,
      "fi",
      ""
    ].join("\n");
    await write(space, COPY_SCRIPT, script, true);
    const enviado = await dispatch(COPY_SCRIPT);
    if (enviado.mode === "denied") {
      throw new Error("o assistente não pôde ser iniciado para ler o arquivo");
    }
    const limite = Date.now() + 15e3;
    while (Date.now() < limite) {
      const estado = readText(space, COPY_DONE);
      if (estado === "ok") {
        const texto = readText(space, COPY_OUT);
        if (texto) return texto;
        throw new Error("o arquivo foi copiado mas veio vazio");
      }
      if (estado === "falhou") {
        throw new Error("não consegui ler esse arquivo — ele ainda está no lugar?");
      }
      await wait$1(200);
    }
    await withdraw(enviado.ticket);
    throw new Error("a leitura do arquivo passou do tempo");
  }
  let releaseDocument = null;
  let cancelActive = null;
  const translateTool = {
    id: "translate",
    name: "Traduzir Legenda",
    summary: "Traduz um .srt mantendo os tempos",
    hint: "Traga um .srt do disco ou do projeto aberto. A frase é traduzida inteira, e os tempos saem idênticos aos que entraram.",
    category: "texto",
    glyph: "text",
    available: true,
    usesSelection: false,
    mount(container, context) {
      let carregada = null;
      let from = "auto";
      let to = "pt";
      let busy = false;
      let ultimoSrt = null;
      container.innerHTML = markup();
      const vazioEl = container.querySelector("[data-empty]");
      const arquivoEl = container.querySelector("[data-file]");
      const importarEl = container.querySelector("[data-import]");
      const projetoEl = container.querySelector("[data-project]");
      const listaEl = container.querySelector("[data-list]");
      const fromEl = container.querySelector("[data-from]");
      const toEl = container.querySelector("[data-to]");
      const previaEl = container.querySelector("[data-preview]");
      context.setApplyLabel("TRADUZIR");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      context.setRefreshHandler(null);
      const fromPick = fromEl ? mountDropdown(fromEl, {
        options: () => SOURCE_LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
        selected: () => from,
        onPick: (id) => {
          from = id;
          fromPick?.render();
        }
      }) : null;
      const toPick = toEl ? mountDropdown(toEl, {
        options: () => TARGET_LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
        selected: () => to,
        onPick: (id) => {
          to = id;
          toPick?.render();
        }
      }) : null;
      const fechar = (alvo) => {
        fromPick?.closeUnless(alvo);
        toPick?.closeUnless(alvo);
      };
      const noPonteiro = (e) => fechar(e.target);
      const naTecla = (e) => {
        if (e.key === "Escape") fechar(null);
      };
      document.addEventListener("click", noPonteiro, true);
      document.addEventListener("keydown", naTecla, true);
      releaseDocument = () => {
        document.removeEventListener("click", noPonteiro, true);
        document.removeEventListener("keydown", naTecla, true);
      };
      function carregar(nome, texto) {
        const doc = parseSrt(texto);
        if (doc.cues.length === 0) {
          context.setStatus(
            `"${nome}" não parece uma legenda — não achei nenhum bloco com tempo.`,
            "error"
          );
          return;
        }
        carregada = { name: nome, text: texto, cues: doc.cues.length };
        ultimoSrt = null;
        renderArquivo();
        esconderLista();
        renderPrevia([]);
        context.setApplyEnabled(true);
        context.setResetHandler(() => limpar());
        context.setStatus(
          `${doc.cues.length} ${doc.cues.length === 1 ? "bloco" : "blocos"} lidos de "${nome}".`,
          "done"
        );
      }
      importarEl?.addEventListener("click", () => {
        void (async () => {
          try {
            const escolhido = await pickSrtFile();
            if (escolhido) carregar(escolhido.name, escolhido.text);
          } catch (cause) {
            context.setStatus(describeError$1(cause), "error");
          }
        })();
      });
      projetoEl?.addEventListener("click", () => void listarProjeto());
      async function listarProjeto() {
        if (busy) return;
        busy = true;
        if (projetoEl) {
          setDisabled(projetoEl, true);
          projetoEl.textContent = "Procurando…";
        }
        try {
          const achados = await findSrtInProject();
          if (achados.length === 0) {
            esconderLista();
            context.setStatus(
              "Nenhum .srt no projeto aberto. Use Importar para trazer do disco.",
              "idle"
            );
            return;
          }
          if (listaEl) {
            listaEl.hidden = false;
            listaEl.innerHTML = '<p class="tr-list-title">No projeto</p>' + achados.map(
              (a) => `<div class="tr-list-item" ${CONTROL} data-path="${escapeHtml(a.path)}" data-name="${escapeHtml(a.name)}">${escapeHtml(a.name)}</div>`
            ).join("");
          }
          context.setStatus(
            `${achados.length} ${achados.length === 1 ? "legenda" : "legendas"} no projeto.`,
            "done"
          );
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy = false;
          if (projetoEl) {
            setDisabled(projetoEl, false);
            projetoEl.textContent = "Buscar no projeto";
          }
        }
      }
      listaEl?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-path]");
        const caminho = item?.dataset.path;
        const nome = item?.dataset.name ?? "legenda.srt";
        if (!caminho || busy) return;
        void (async () => {
          busy = true;
          context.setStatus("Lendo a legenda…");
          try {
            carregar(nome, await readAnyPath(caminho));
          } catch (cause) {
            context.setStatus(describeError$1(cause), "error");
          } finally {
            busy = false;
          }
        })();
      });
      context.setApplyHandler(async () => {
        if (!carregada || busy) return;
        busy = true;
        let cancelado = false;
        cancelActive = () => {
          cancelado = true;
        };
        context.setApplyEnabled(false);
        context.setApplyLabel("TRADUZINDO…");
        try {
          const resultado = await translateSrt(carregada.text, {
            from,
            to,
            cancelled: () => cancelado,
            onProgress: (feitos, total) => context.setStatus(`Traduzindo… ${feitos} de ${total}`)
          });
          if (!resultado.ok || !resultado.content) {
            context.setStatus(descreveFalha(resultado.error), "error");
            return;
          }
          const nome = nomeTraduzido(carregada.name, to);
          const espaco = await workspace();
          await write(espaco, nome, resultado.content);
          ultimoSrt = { nome, conteudo: resultado.content };
          renderPrevia(previewPairs(carregada.text, resultado.content, 3));
          const caminho = nativePath(espaco, nome);
          let noProjeto = false;
          try {
            const ppro = getPremiere();
            const project2 = ppro ? await ppro.Project.getActiveProject() : null;
            if (project2) {
              noProjeto = await project2.importFiles([caminho], true) === true;
            }
          } catch {
          }
          const origem = from === "auto" && resultado.detected ? `${labelOf(resultado.detected)} → ${labelOf(to)}` : `${labelOf(from)} → ${labelOf(to)}`;
          context.setStatus(
            `${resultado.translated} de ${resultado.total} blocos traduzidos · ${origem} · ` + (noProjeto ? "o .srt está no seu projeto" : `salvo em ${caminho}`),
            "done"
          );
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy = false;
          cancelActive = null;
          context.setApplyLabel("TRADUZIR");
          context.setApplyEnabled(!!carregada);
        }
      });
      function limpar() {
        carregada = null;
        ultimoSrt = null;
        renderArquivo();
        renderPrevia([]);
        esconderLista();
        context.setApplyEnabled(false);
        context.setResetHandler(null);
        context.setStatus("", "idle");
      }
      function renderArquivo() {
        if (!arquivoEl) return;
        if (!carregada) {
          arquivoEl.hidden = true;
          arquivoEl.innerHTML = "";
          if (vazioEl) vazioEl.hidden = false;
          return;
        }
        if (vazioEl) vazioEl.hidden = true;
        arquivoEl.hidden = false;
        arquivoEl.innerHTML = `<span class="tr-file-name">${escapeHtml(carregada.name)}</span><span class="tr-file-meta">${carregada.cues} blocos</span><span class="tr-file-swap" ${CONTROL} data-swap>trocar</span>`;
        arquivoEl.querySelector("[data-swap]")?.addEventListener("click", () => limpar());
      }
      function renderPrevia(pares) {
        if (!previaEl) return;
        if (pares.length === 0) {
          previaEl.hidden = true;
          previaEl.innerHTML = "";
          return;
        }
        previaEl.hidden = false;
        previaEl.innerHTML = '<p class="tr-prev-title">Como ficou</p>' + pares.map(
          (p) => `<div class="tr-prev-pair"><span class="tr-prev-a">${escapeHtml(p.antes)}</span><span class="tr-prev-b">${escapeHtml(p.depois)}</span></div>`
        ).join("");
      }
      function esconderLista() {
        if (listaEl) {
          listaEl.hidden = true;
          listaEl.innerHTML = "";
        }
      }
    },
    unmount() {
      cancelActive?.();
      cancelActive = null;
      releaseDocument?.();
      releaseDocument = null;
    }
  };
  function nomeTraduzido(original, para) {
    const semExt = original.replace(/\.(srt|vtt)$/i, "");
    const limpo = semExt.replace(/^\[[A-Za-z]{2}(-[A-Za-z]{2,4})?\]\s*/, "").replace(/\.[a-z]{2}(-[A-Za-z]{2,4})?$/i, "");
    return `[${para.toUpperCase()}] ${limpo}.srt`;
  }
  function descreveFalha(code) {
    switch (code) {
      case "empty":
        return "Esse arquivo não tem nenhum bloco de legenda.";
      case "cancelled":
        return "Tradução cancelada.";
      case "engine-failed":
        return "O tradutor não respondeu. Confira a internet e tente de novo.";
      case "both-engines-failed":
        return "Os dois tradutores recusaram. Pode ser limite de uso — espere alguns minutos e tente de novo.";
      default:
        return "A tradução não terminou.";
    }
  }
  function markup() {
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">A legenda</span><div class="tr-acts" data-empty><div class="tr-btn" ${CONTROL} data-import>Importar arquivo…</div><div class="tr-btn" ${CONTROL} data-project>Buscar no projeto</div></div><div class="tr-file" data-file hidden></div><div class="tr-list" data-list hidden></div></div></div><div class="zone"><div class="field"><span class="t-label">Traduzir de</span><div data-from></div></div><div class="field"><span class="t-label">Para</span><div data-to></div><p class="field-note">Os tempos de cada bloco saem idênticos aos que entraram — só o texto muda. O arquivo novo entra no seu projeto ao lado do original.</p></div></div><div class="zone is-wide"><div class="tr-prev" data-preview hidden></div></div></div>`;
  }
  const categories = [
    { id: "edicao", name: "Edição" },
    { id: "texto", name: "Texto" },
    { id: "midia", name: "Mídia" },
    { id: "projeto", name: "Projeto" }
  ];
  const tools = [
    zoomTool,
    silenceTool,
    fillersTool,
    flowTool,
    captionsTool,
    translateTool,
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
    download: '<path d="M7 2.4v6.4"/><path d="M4.2 6.2 7 9l2.8-2.8"/><path d="M2.6 11.4h8.8"/>',
    speech: '<path d="M2 3h10v6H8l-2.6 2.2V9H2z"/><path d="M4.2 6h.9M6.6 6h.9M9 6h.9"/>'
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
        if (typeof data.version !== "string" || !/^v?\d+(\.\d+){0,3}$/.test(data.version)) {
          throw new Error("version.json com versão em formato inesperado.");
        }
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
        await this.checkForUpdates();
      }
      const manifest = this.latestManifest;
      if (!manifest || !isNewerVersion(manifest.version, this.currentVersion)) {
        return {
          success: false,
          requiresReload: false,
          message: "Nenhuma atualização disponível no momento."
        };
      }
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
        const allowedUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/`;
        const fileEntries = Object.entries(filesToUpdate).filter(
          ([filename, fileUrl2]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) && fileUrl2.startsWith(allowedUrl)
        );
        if (fileEntries.length === 0) {
          throw new Error("Manifesto sem arquivos válidos para atualizar.");
        }
        onProgress?.("Baixando a atualização...", 25);
        const downloads = await Promise.all(
          fileEntries.map(async ([filename, fileUrl2]) => {
            const fileResponse = await fetch(`${fileUrl2}?_t=${Date.now()}`, {
              cache: "no-store"
            });
            if (!fileResponse.ok) {
              throw new Error(`Falha ao baixar ${filename} (${fileResponse.status})`);
            }
            return { filename, data: await fileResponse.arrayBuffer() };
          })
        );
        const binary = getUxpModule()?.storage?.formats?.binary;
        let completed = 0;
        for (const { filename, data } of downloads) {
          onProgress?.(
            `Gravando ${filename}...`,
            60 + Math.round(completed / downloads.length * 35)
          );
          const targetFile = await pluginFolder.createFile(filename, {
            overwrite: true
          });
          let written = false;
          if (binary !== void 0) {
            try {
              await targetFile.write(data, { format: binary });
              written = true;
            } catch (cause) {
              console.warn("[Updater] escrita binária recusada, usando texto:", cause);
            }
          }
          if (!written) {
            await targetFile.write(decodeUtf8(data));
          }
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
  function decodeUtf8(data) {
    if (typeof TextDecoder === "function") {
      return new TextDecoder("utf-8").decode(data);
    }
    const bytes = new Uint8Array(data);
    let out = "";
    for (let at = 0; at < bytes.length; at += 8192) {
      out += String.fromCharCode(...bytes.subarray(at, at + 8192));
    }
    return decodeURIComponent(escape(out));
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
  const VERSION = "0.4.0";
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
      const empty2 = document.createElement("p");
      empty2.className = "nav-empty";
      empty2.textContent = "Nenhuma ferramenta encontrada.";
      this.navEl.append(this.navScroll, empty2);
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
      startAgentHeartbeat();
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
      const safe = escapeHtml(version);
      badge.title = `Nova versão v${safe} disponível! Clique para atualizar.`;
      badge.innerHTML = `<span class="update-dot"></span><span>Atualizar (v${safe})</span>`;
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
      if (tool.available === false) {
        this.setStatus(`${tool.name} não está disponível nesta versão do Premiere.`, "error");
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
  function formatDuration(seconds2) {
    const whole = Math.max(0, Math.round(seconds2));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  function brandMark() {
    return '<svg viewBox="0 0 100 100" aria-hidden="true" fill="none"><path d="M12 34V14h22" stroke="currentColor" stroke-width="8" stroke-linecap="square"/><path d="M66 14h22v20" stroke="currentColor" stroke-width="8" stroke-linecap="square"/><path d="M88 66v20H66" stroke="currentColor" stroke-width="8" stroke-linecap="square"/><path d="M34 86H12V66" stroke="currentColor" stroke-width="8" stroke-linecap="square"/><rect x="34" y="34" width="32" height="32" fill="#E39B3C"/></svg>';
  }
  function searchGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2 12.4 12.4"/></svg>';
  }
  function refreshGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="square"><path d="M11.6 7a4.6 4.6 0 1 1-1.5-3.4"/><path d="M11.8 1.6v3.2H8.6"/></svg>';
  }
  function bootstrap() {
    const root = document.getElementById("root");
    if (!root) {
      return;
    }
    try {
      new ProductShell(root).start();
    } catch (cause) {
      console.error("[Framelab] falha ao iniciar:", cause);
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
