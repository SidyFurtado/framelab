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
  function hostVersion() {
    if (typeof require !== "function") {
      return "";
    }
    try {
      const uxp = require("uxp");
      return uxp?.host?.version ?? "";
    } catch {
      return "";
    }
  }
  function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) {
      return null;
    }
    for (let at2 = 0; at2 < Math.max(left.length, right.length); at2 += 1) {
      const diff = (left[at2] ?? 0) - (right[at2] ?? 0);
      if (diff !== 0) {
        return diff > 0 ? 1 : -1;
      }
    }
    return 0;
  }
  function parseVersion(raw) {
    if (typeof raw !== "string") {
      return null;
    }
    const found = /^\s*v?(\d+(?:\.\d+)*)(?![\d.])/.exec(raw);
    if (!found) {
      return null;
    }
    const parts = found[1].split(".").map((part) => Number.parseInt(part, 10));
    return parts.every((part) => Number.isFinite(part)) ? parts : null;
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
      const sequence2 = project2 ? await project2.getActiveSequence() : null;
      if (!sequence2) {
        return EMPTY_SELECTION;
      }
      const trackCount = await sequence2.getVideoTrackCount();
      let best = [];
      let bestSelected = 0;
      let bestIndex = -1;
      let totalSelected = 0;
      let totalSeconds = 0;
      const tracks = await Promise.all(
        Array.from({ length: trackCount }, (_, index) => sequence2.getVideoTrack(index))
      );
      for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        const track = tracks[trackIndex];
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
        playheadRatio: await readPlayheadRatio(sequence2, rangeStart, rangeEnd)
      };
    } catch {
      return EMPTY_SELECTION;
    }
  }
  async function readPlayheadRatio(sequence2, rangeStart, rangeEnd) {
    try {
      const span = rangeEnd - rangeStart;
      if (!(span > 0)) {
        return null;
      }
      const position = await sequence2.getPlayerPosition();
      const ratio = (position.seconds - rangeStart) / span;
      return ratio >= 0 && ratio <= 1 ? ratio : null;
    } catch {
      return null;
    }
  }
  async function collectSelectedVideoClips(ppro, sequence2) {
    const refs = [];
    const seen = /* @__PURE__ */ new Map();
    const trackCount = await sequence2.getVideoTrackCount();
    const tracks = await Promise.all(
      Array.from({ length: trackCount }, (_, index) => sequence2.getVideoTrack(index))
    );
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      const track = tracks[trackIndex];
      if (!track) {
        continue;
      }
      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const selected = await Promise.all(
        items.map((item) => Promise.resolve(item.getIsSelected()).catch(() => false))
      );
      const chosen = items.filter((_, at2) => selected[at2]);
      const identities = await Promise.all(
        chosen.map((item, at2) => clipIdentity(item, trackIndex, refs.length + at2))
      );
      chosen.forEach((item, at2) => {
        const base = identities[at2];
        const repeat = seen.get(base) ?? 0;
        seen.set(base, repeat + 1);
        refs.push({
          clip: item,
          key: repeat === 0 ? base : `${base}#${repeat}`,
          trackIndex
        });
      });
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
  async function readTicksPerFrame(sequence2) {
    try {
      const settings2 = await sequence2.getSettings();
      const rate = settings2 ? await settings2.getVideoFrameRate() : null;
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
  const WORK_FOLDER = "edit-toolbox-audio";
  const PROBE_FILE$1 = "write-probe.txt";
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
    const tempNative2 = await nativePathOf(
      storage?.getTemporaryFolder?.bind(storage),
      "getTemporaryFolder"
    );
    if (tempNative2) {
      list.push({
        fsBase: `plugin-temp:/${WORK_FOLDER}`,
        nativeBase: join(tempNative2, WORK_FOLDER),
        origin: "plugin-temp + subpasta"
      });
      list.push({
        fsBase: "plugin-temp:",
        nativeBase: tempNative2,
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
      attempts.push(`os.homedir: ${describe$5(cause)}`);
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
      attempts.push(`${label}: ${describe$5(cause)}`);
    }
    return null;
  }
  async function tryCandidate(fs, candidate) {
    try {
      await fs.mkdir(candidate.fsBase, { recursive: true });
    } catch {
    }
    const probe2 = join(candidate.fsBase, PROBE_FILE$1);
    const stamp = "edit-toolbox";
    for (const sync2 of [true, false]) {
      try {
        if (sync2) {
          fs.writeFileSync(probe2, stamp, { encoding: "utf-8" });
        } else {
          await fs.writeFile(probe2, stamp, { encoding: "utf-8" });
        }
        const back = String(fs.readFileSync(probe2, { encoding: "utf-8" }));
        if (back.trim() !== stamp) {
          attempts.push(`${candidate.origin}: leu "${back.slice(0, 20)}"`);
          continue;
        }
        return { ...candidate, sync: sync2 };
      } catch (cause) {
        attempts.push(`${candidate.origin} ${sync2 ? "sync" : "async"}: ${describe$5(cause)}`);
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
  function fileUrl(nativePathValue) {
    return "file://" + nativePathValue.replace(/\\/g, "/").split("/").map((part) => encodeURIComponent(part)).join("/");
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
  async function append(space, name, line) {
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    const path = fsPath(space, name);
    const text2 = line.endsWith("\n") ? line : `${line}
`;
    try {
      await fs.writeFile(path, text2, { encoding: "utf-8", flag: "a" });
      return;
    } catch {
    }
    let held = "";
    try {
      held = String(fs.readFileSync(path, { encoding: "utf-8" }));
    } catch {
    }
    await write(space, name, held + text2);
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
  function readText$1(space, name) {
    return readWhole(fsModule(), fsPath(space, name));
  }
  function readWhole(fs, path) {
    if (!fs) {
      return null;
    }
    try {
      const raw = fs.readFileSync(path, { encoding: "utf-8" });
      const text2 = String(raw).trim();
      return text2.length > 0 ? text2 : null;
    } catch {
      return null;
    }
  }
  const TAIL_WINDOW_BYTES = 8192;
  async function readTailText(space, name, maxBytes = TAIL_WINDOW_BYTES, fs = fsModule()) {
    if (!fs) {
      return null;
    }
    const path = fsPath(space, name);
    const size = fileSize(fs, path);
    if (size === null || size <= maxBytes || typeof TextDecoder !== "function") {
      return readWhole(fs, path);
    }
    let fd = null;
    try {
      fd = await fs.open(path, "r");
      const buffer = new ArrayBuffer(maxBytes);
      const answer = await fs.read(fd, buffer, 0, maxBytes, size - maxBytes);
      const read = Number(answer?.bytesRead ?? 0);
      if (!(read > 0)) {
        return null;
      }
      const bytes = new Uint8Array(answer?.buffer ?? buffer, 0, read);
      const text2 = new TextDecoder("utf-8").decode(bytes);
      return text2.replace(/^\uFFFD+/, "").trim() || null;
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        await fs.close(fd).catch(() => void 0);
      }
    }
  }
  function fileSize(fs, path) {
    if (typeof fs.lstatSync !== "function") {
      return null;
    }
    try {
      const size = Number(fs.lstatSync(path)?.size);
      return Number.isFinite(size) && size >= 0 ? size : null;
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
  function describe$5(cause) {
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
  const DIAG_FILE = "zoom-diag.json";
  const DIAG_ENABLED = false;
  async function dumpDiag(payload, file = DIAG_FILE, force = false) {
    if (!force) {
      return;
    }
    try {
      const space = await workspace();
      await write(space, file, JSON.stringify(payload, null, 2));
      console.log(`[Diag] relatório em ${nativePath(space, file)}`);
    } catch (cause) {
      console.warn("[Diag] não consegui escrever o relatório:", cause);
    }
  }
  async function probeParams(ppro, component, ticks) {
    const rows = [];
    let count = 0;
    try {
      count = Number(await Promise.resolve(component.getParamCount())) || 0;
    } catch {
      return rows;
    }
    for (let index = 0; index < count; index += 1) {
      let name = "(erro)";
      let valor = "(não lido)";
      let tipo = "?";
      try {
        const param = component.getParam(index);
        try {
          name = (param.displayName ?? "").trim();
        } catch {
          name = "(sem nome)";
        }
        try {
          const raw = await param.getValueAtTime(ppro.TickTime.createWithTicks(ticks));
          tipo = raw === null ? "null" : typeof raw;
          valor = unwrapValue(raw);
        } catch (cause) {
          valor = `(erro: ${cause instanceof Error ? cause.message : String(cause)})`;
        }
      } catch {
      }
      rows.push({ index, name, tipo, valor });
    }
    return rows;
  }
  function unwrapValue(raw, depth = 0) {
    if (raw === null || raw === void 0) {
      return raw ?? null;
    }
    if (typeof raw === "number") {
      return Number.isFinite(raw) ? raw : "NaN";
    }
    if (typeof raw !== "object") {
      return raw;
    }
    if (Array.isArray(raw)) {
      return raw.map((item) => unwrapValue(item, depth + 1));
    }
    const point = raw;
    if (point.x !== void 0 || point.y !== void 0) {
      return { x: Number(point.x), y: Number(point.y) };
    }
    const wrapper = raw;
    if ("value" in wrapper && depth < 4) {
      return unwrapValue(wrapper.value, depth + 1);
    }
    try {
      const keys = Object.keys(raw);
      return keys.length > 0 ? `(objeto: ${keys.join(", ")})` : String(raw);
    } catch {
      return String(raw);
    }
  }
  function numberOf(raw) {
    const plain2 = unwrapValue(raw);
    return typeof plain2 === "number" ? plain2 : null;
  }
  async function probeKeyframes(param) {
    let times;
    try {
      times = await Promise.resolve(param.getKeyframeListAsTickTimes());
    } catch (cause) {
      return `(erro na lista: ${cause instanceof Error ? cause.message : String(cause)})`;
    }
    if (!Array.isArray(times)) {
      return "(o host não devolveu uma lista)";
    }
    const rows = [];
    for (const time of times) {
      let valor = "(não lido)";
      try {
        valor = unwrapValue(await param.getValueAtTime(time));
      } catch (cause) {
        valor = `(erro: ${cause instanceof Error ? cause.message : String(cause)})`;
      }
      rows.push({
        ticks: String(time?.ticks ?? "?"),
        segundos: Number(time?.seconds ?? NaN),
        valor
      });
    }
    return rows;
  }
  async function findComponent(chain, pattern) {
    try {
      const count = Number(await Promise.resolve(chain.getComponentCount())) || 0;
      for (let index = 0; index < count; index += 1) {
        const component = await Promise.resolve(chain.getComponentAtIndex(index));
        const matchName = component ? await component.getMatchName().catch(() => "") : "";
        if (pattern.test(matchName)) {
          return component;
        }
      }
    } catch {
    }
    return null;
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
      return fail$4("Premiere UXP runtime unavailable.");
    }
    let rollbackAppends = null;
    try {
      const project2 = await ppro.Project.getActiveProject();
      if (!project2) {
        return fail$4("No active project.");
      }
      const sequence2 = await project2.getActiveSequence();
      if (!sequence2) {
        return fail$4("Open a sequence in the timeline first.");
      }
      const videoClips = await collectSelectedVideoClips(ppro, sequence2);
      if (videoClips.length === 0) {
        return fail$4("Nenhum clipe de vídeo selecionado na timeline.");
      }
      const ticksPerFrame = await readTicksPerFrame(sequence2);
      const { matchName: transformMatchName, candidates: candidates2 } = await resolveTransformMatchName(ppro);
      if (!transformMatchName) {
        return fail$4(
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
        const seqStart = await Promise.resolve(clip.getStartTime()).catch(() => null);
        const seqEnd = await Promise.resolve(clip.getEndTime()).catch(() => null);
        const newComponent = await ppro.VideoFilterFactory.createComponent(
          transformMatchName
        );
        if (!newComponent) {
          continue;
        }
        const appendIndex = await Promise.resolve(chain.getComponentCount());
        const punchSec = Math.max(
          PUNCH_DURATION_MIN,
          Math.min(PUNCH_DURATION_MAX, options.punchDuration)
        );
        const endTime = options.style === "punch" ? ppro.TickTime.createWithSeconds(
          Math.min(inPoint.seconds + punchSec, outPoint.seconds)
        ) : outPoint;
        targets.push({
          clipKey: ref.key,
          chain,
          newComponent,
          appendIndex,
          startTicks: inPoint.ticks,
          endTicks: endTime.ticks,
          seqStartTicks: seqStart ? seqStart.ticks : "(ilegível)",
          seqEndTicks: seqEnd ? seqEnd.ticks : "(ilegível)"
        });
      }
      if (targets.length === 0) {
        return fail$4(
          speedSkipped > 0 ? `Nenhum clipe elegível: ${speedSkipped} com velocidade alterada. O Zoom precisa de clipes com velocidade a 100% para o tempo do punch bater.` : "Nenhum clipe selecionado aceitou um efeito Transform."
        );
      }
      let insertCommitted = false;
      project2.lockedAccess(() => {
        insertCommitted = project2.executeTransaction((compoundAction) => {
          for (const target2 of targets) {
            const action = target2.chain.createAppendComponentAction(
              target2.newComponent
            );
            compoundAction.addAction(action);
          }
        }, "Adicionar efeito Transform");
      });
      if (!insertCommitted) {
        return fail$4("O Premiere recusou a inserção do efeito Transform.");
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
      const semResgate = [];
      let probeChain = null;
      let probeTransform = null;
      let probeTicks = "0";
      let probeTarget = null;
      for (const target2 of targets) {
        const clip = clipByKey.get(target2.clipKey);
        if (!clip) {
          console.warn("[Zoom] clipe não encontrado após a inserção do Transform");
          semResgate.push(target2.clipKey);
          continue;
        }
        const chain = await clip.getComponentChain();
        if (!chain) {
          console.warn("[Zoom] cadeia de efeitos ilegível após a inserção");
          semResgate.push(target2.clipKey);
          continue;
        }
        const comp = await findTransformComponent(
          chain,
          transformMatchName,
          target2.appendIndex
        );
        if (!comp) {
          console.warn("[Zoom] componente Transform não encontrado no clipe");
          const porIndice = await componentAtIndex(chain, target2.appendIndex);
          if (porIndice) {
            appended.push({ chain, component: porIndice });
          } else {
            semResgate.push(target2.clipKey);
          }
          continue;
        }
        appended.push({ chain, component: comp });
        if (!probeTransform) {
          probeChain = chain;
          probeTransform = comp;
          probeTicks = target2.startTicks;
          probeTarget = target2;
        }
        const scaleParam = await findScaleParamWithDiag(comp);
        if (!scaleParam) {
          console.warn("[Zoom] parâmetro Scale não encontrado no Transform");
          continue;
        }
        readyScaleItems.push({
          chain,
          scaleParam,
          startTicks: target2.startTicks,
          endTicks: target2.endTicks
        });
      }
      if (semResgate.length > 0) {
        console.warn(
          `[Zoom] ${semResgate.length} Transform(s) podem ter ficado no clipe: ` + semResgate.join(", ")
        );
      }
      if (readyScaleItems.length === 0) {
        rollbackAppends();
        return fail$4(
          "Nenhum parâmetro Scale encontrado no Transform. O console do UXP tem o dump."
        );
      }
      const motion = DIAG_ENABLED && probeChain ? await findComponent(probeChain, /motion/i) : null;
      const relatorio = {
        quando: (/* @__PURE__ */ new Date()).toISOString(),
        transformMatchName,
        ticksDaCabeca: probeTicks,
        relogios: probeTarget ? {
          mediaIn: probeTarget.startTicks,
          mediaOut: probeTarget.endTicks,
          sequenciaIn: probeTarget.seqStartTicks,
          sequenciaOut: probeTarget.seqEndTicks
        } : "(clipe-cobaia não encontrado)",
        vouEscrever: {
          de: options.direction === "in" ? NEUTRAL_SCALE : options.scalePercent,
          para: options.direction === "in" ? options.scalePercent : NEUTRAL_SCALE
        },
        scaleParamEscolhido: readyScaleItems[0] ? safeDisplayName$1(readyScaleItems[0].scaleParam) : null,
        motion: motion ? await probeParams(ppro, motion, probeTicks) : "(não sondado)",
        transformNovo: DIAG_ENABLED && probeTransform ? await probeParams(ppro, probeTransform, probeTicks) : "(não sondado)"
      };
      await dumpDiag(relatorio);
      const [baseFrom, baseTo] = options.direction === "in" ? [NEUTRAL_SCALE, options.scalePercent] : [options.scalePercent, NEUTRAL_SCALE];
      const placedOf = /* @__PURE__ */ new Map();
      const animaveis = [];
      for (const item of readyScaleItems) {
        const startSec = ppro.TickTime.createWithTicks(item.startTicks).seconds;
        const endSec = ppro.TickTime.createWithTicks(item.endTicks).seconds;
        const duration = endSec - startSec;
        if (!(duration > 0)) {
          continue;
        }
        placedOf.set(
          item,
          placeKeyframes(
            ppro,
            options,
            baseFrom,
            baseTo,
            item.startTicks,
            item.endTicks,
            startSec,
            duration,
            ticksPerFrame
          )
        );
        animaveis.push(item);
      }
      if (animaveis.length === 0) {
        rollbackAppends();
        return fail$4("Nenhum clipe selecionado tem duração para animar.");
      }
      let clockCommitted = false;
      project2.lockedAccess(() => {
        clockCommitted = project2.executeTransaction((compoundAction) => {
          for (const item of animaveis) {
            compoundAction.addAction(item.scaleParam.createSetTimeVaryingAction(true));
          }
        }, "Ligar o cronômetro do Zoom");
      });
      if (!clockCommitted) {
        rollbackAppends();
        return fail$4("O Premiere recusou ligar o cronômetro do Scale.");
      }
      const keyframesDoHost = [];
      const paraApagar = [];
      for (const item of animaveis) {
        let times;
        try {
          times = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
        } catch (cause) {
          console.warn("[Zoom] não deu para listar o que o cronômetro criou:", cause);
          continue;
        }
        if (!Array.isArray(times)) {
          continue;
        }
        for (const time of times) {
          if (item === animaveis[0]) {
            let valor = "(não lido)";
            try {
              const bruto = await item.scaleParam.getValueAtTime(time);
              valor = numberOf(bruto) ?? bruto;
            } catch (cause) {
              valor = `(erro: ${describeError$1(cause)})`;
            }
            keyframesDoHost.push({ ticks: String(time?.ticks ?? "?"), valor });
          }
          paraApagar.push({ param: item.scaleParam, time });
        }
      }
      let hostCleared = true;
      if (paraApagar.length > 0) {
        console.log(
          `[Zoom] o cronômetro criou ${paraApagar.length} keyframe(s); apagando antes de escrever`
        );
        hostCleared = false;
        try {
          project2.lockedAccess(() => {
            hostCleared = project2.executeTransaction((compoundAction) => {
              for (const entry of paraApagar) {
                compoundAction.addAction(
                  entry.param.createRemoveKeyframeAction(entry.time)
                );
              }
            }, "Limpar o keyframe que o Premiere criou sozinho");
          });
        } catch (cause) {
          console.warn("[Zoom] a limpeza do âncora não assentou:", cause);
        }
      }
      const paraLinear = [];
      let animCommitted = false;
      project2.lockedAccess(() => {
        animCommitted = project2.executeTransaction((compoundAction) => {
          for (const item of animaveis) {
            const placed2 = placedOf.get(item);
            if (!placed2) {
              continue;
            }
            for (const [ticks, value] of placed2) {
              const kf = item.scaleParam.createKeyframe(value);
              kf.position = ppro.TickTime.createWithTicks(ticks);
              compoundAction.addAction(item.scaleParam.createAddKeyframeAction(kf));
              paraLinear.push({ param: item.scaleParam, ticks });
            }
          }
        }, "Aplicar Zoom");
      });
      let linearCommitted = false;
      if (animCommitted && paraLinear.length > 0) {
        try {
          project2.lockedAccess(() => {
            linearCommitted = project2.executeTransaction((compoundAction) => {
              for (const entry of paraLinear) {
                try {
                  compoundAction.addAction(
                    entry.param.createSetInterpolationAtKeyframeAction(
                      ppro.TickTime.createWithTicks(entry.ticks),
                      ppro.Constants.InterpolationMode.LINEAR
                    )
                  );
                } catch (cause) {
                  console.warn("[Zoom] interpolação recusada:", cause);
                }
              }
            }, "Zoom: interpolação linear");
          });
        } catch (cause) {
          console.warn("[Zoom] a transação de interpolação não assentou:", cause);
        }
      }
      if (!animCommitted) {
        rollbackAppends();
        return fail$4("Premiere rejected the zoom animation transaction.");
      }
      const headOf = /* @__PURE__ */ new Map();
      for (const [item, placed2] of placedOf) {
        const first = [...placed2.keys()][0];
        if (first !== void 0) {
          headOf.set(item, first);
        }
      }
      const strays = [];
      for (const item of readyScaleItems) {
        const nossos = placedOf.get(item);
        if (!nossos || nossos.size === 0) {
          continue;
        }
        try {
          const kfTimes = await Promise.resolve(item.scaleParam.getKeyframeListAsTickTimes());
          if (!Array.isArray(kfTimes)) {
            continue;
          }
          const meus = /* @__PURE__ */ new Set();
          for (const t of nossos.keys()) {
            try {
              meus.add(BigInt(t).toString());
            } catch {
              meus.add(t);
            }
          }
          const alheios = kfTimes.filter((time) => {
            try {
              return !meus.has(BigInt(time.ticks).toString());
            } catch {
              return false;
            }
          });
          if (alheios.length > 0) {
            strays.push({ param: item.scaleParam, times: alheios });
          }
        } catch (err) {
          console.warn("[Zoom] leitura de keyframes para a varredura falhou:", err);
        }
      }
      if (strays.length > 0) {
        const total = strays.reduce((soma, entry) => soma + entry.times.length, 0);
        console.log(`[Zoom] removendo ${total} keyframe(s) que o host criou sozinho`);
        try {
          project2.lockedAccess(() => {
            project2.executeTransaction((compoundAction) => {
              for (const entry of strays) {
                for (const time of entry.times) {
                  compoundAction.addAction(entry.param.createRemoveKeyframeAction(time));
                }
              }
            }, "Limpar keyframe alheio do Zoom");
          });
        } catch (err) {
          console.warn("[Zoom] não foi possível remover o keyframe alheio:", err);
        }
      }
      const cabecas = [];
      for (const item of readyScaleItems) {
        const tick = headOf.get(item);
        if (tick === void 0) {
          continue;
        }
        const alvo = placedOf.get(item)?.get(tick) ?? baseFrom;
        const time = ppro.TickTime.createWithTicks(tick);
        const ler = async () => {
          try {
            return await item.scaleParam.getValueAtTime(time);
          } catch (cause) {
            return `(erro: ${describeError$1(cause)})`;
          }
        };
        const bruto = await ler();
        const relato = {
          tick,
          alvo,
          antes: numberOf(bruto) ?? bruto,
          precisou: false,
          apagou: false,
          escreveu: false,
          depois: null
        };
        const lido = numberOf(bruto);
        if (lido === null || Math.abs(lido - alvo) > 0.5) {
          relato.precisou = true;
          try {
            project2.lockedAccess(() => {
              relato.apagou = project2.executeTransaction((compoundAction) => {
                compoundAction.addAction(
                  item.scaleParam.createRemoveKeyframeAction(time)
                );
              }, "Corrigir a cabeça do Zoom (apagar)");
            });
            project2.lockedAccess(() => {
              relato.escreveu = project2.executeTransaction((compoundAction) => {
                const kf = item.scaleParam.createKeyframe(alvo);
                kf.position = time;
                compoundAction.addAction(item.scaleParam.createAddKeyframeAction(kf));
                compoundAction.addAction(
                  item.scaleParam.createSetInterpolationAtKeyframeAction(
                    time,
                    ppro.Constants.InterpolationMode.LINEAR
                  )
                );
              }, "Corrigir a cabeça do Zoom (escrever)");
            });
          } catch (cause) {
            relato.erro = describeError$1(cause);
            console.warn("[Zoom] a correção da cabeça não assentou:", cause);
          }
          const depois = await ler();
          relato.depois = numberOf(depois) ?? depois;
        } else {
          relato.depois = relato.antes;
        }
        cabecas.push(relato);
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
      const torto = cabecas.some((row) => row.precisou) || strays.length > 0 || paraApagar.length > 0 || paraLinear.length > 0 && !linearCommitted || verifiedCount === 0 || unreadableCount > 0;
      relatorio.depois = {
        cronometroLigado: clockCommitted,
        interpolacao: { pedidos: paraLinear.length, linearCommitted },
        keyframesDoHost,
        hostLimpo: hostCleared,
        cabecas,
        keyframesDoPrimeiroClipe: (DIAG_ENABLED || torto) && readyScaleItems[0] ? await probeKeyframes(readyScaleItems[0].scaleParam) : "(não sondado)",
        clipesVerificados: verifiedCount,
        clipesIlegiveis: unreadableCount
      };
      await dumpDiag(relatorio, void 0, torto);
      if (verifiedCount === 0 && unreadableCount === 0) {
        rollbackAppends();
        return fail$4("Nenhum keyframe foi criado no Scale do Transform.");
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
      return fail$4(`Zoom falhou: ${describeError$1(cause)}`);
    }
  }
  function placeKeyframes(ppro, options, baseFrom, baseTo, startTicks, endTicks, startSec, duration, ticksPerFrame) {
    const placed2 = /* @__PURE__ */ new Map();
    const delta = baseTo - baseFrom;
    placed2.set(snapTicksToFrame(startTicks, ticksPerFrame), baseFrom);
    if (!isLinear(options.ease)) {
      for (let step2 = 1; step2 < CURVE_KEYS; step2++) {
        const t = step2 / CURVE_KEYS;
        const ticks = snapTicksToFrame(
          ppro.TickTime.createWithSeconds(startSec + duration * t).ticks,
          ticksPerFrame
        );
        placed2.set(ticks, baseFrom + delta * options.ease(t));
      }
    }
    placed2.set(snapTicksToFrame(endTicks, ticksPerFrame), baseTo);
    return placed2;
  }
  function isLinear(ease) {
    for (let step2 = 1; step2 < CURVE_KEYS; step2++) {
      const t = step2 / CURVE_KEYS;
      if (Math.abs(ease(t) - t) > 2e-3) {
        return false;
      }
    }
    return true;
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
  async function componentAtIndex(chain, index) {
    try {
      return await Promise.resolve(chain.getComponentAtIndex(index)) ?? null;
    } catch {
      return null;
    }
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
    const params = await Promise.all(
      Array.from(
        { length: count },
        (_, index) => Promise.resolve(component.getParam(index)).catch(() => null)
      )
    );
    const rows = params.map((param, index) => ({
      index,
      name: param ? safeDisplayName$1(param) : "(error)"
    }));
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
    const candidatos = rows.filter(
      (row) => (row.name.includes("scale") || row.name.includes("escala")) && !row.name.includes("uniform")
    );
    const aceitaKeyframe = await Promise.all(
      candidatos.map((row) => {
        const param = params[row.index];
        return param ? Promise.resolve(param.areKeyframesSupported()).catch(() => false) : Promise.resolve(false);
      })
    );
    for (let at2 = 0; at2 < candidatos.length; at2++) {
      if (aceitaKeyframe[at2] === true) {
        try {
          return component.getParam(candidatos[at2].index);
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
    const parts = [`Zoom aplicado em ${applied} ${plural$1(applied, "clipe")}.`];
    if (speedSkipped > 0) {
      parts.push(
        `${speedSkipped} ${plural$1(speedSkipped, "clipe")} com velocidade alterada ${speedSkipped === 1 ? "foi ignorado" : "foram ignorados"}.`
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
  function plural$1(count, word) {
    return count === 1 ? word : `${word}s`;
  }
  function fail$4(message) {
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
      const at2 = pointAt(step2 / SAMPLES);
      steps.push(`${step2 === 0 ? "M" : "L"}${at2.x.toFixed(1)},${at2.y.toFixed(1)}`);
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
  function bindKeyboard(root2) {
    root2.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      const target2 = event.target;
      if (!(target2 instanceof HTMLElement)) {
        return;
      }
      const control = target2.closest('[role="button"]');
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
  const DEBOUNCE_MS = 400;
  function createToolSettings(file, defaults2, sanitize) {
    let cache2 = null;
    let timer = null;
    let writing2 = null;
    async function persist() {
      const value = cache2;
      if (!value) {
        return;
      }
      try {
        await write(await workspace(), file, JSON.stringify(value, null, 2));
      } catch (cause) {
        console.warn(`[Ajustes] não consegui gravar ${file}:`, cause);
      }
    }
    function schedule() {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        writing2 = persist();
      }, DEBOUNCE_MS);
    }
    return {
      peek() {
        return cache2 ? { ...cache2 } : null;
      },
      async read() {
        if (cache2) {
          return { ...cache2 };
        }
        try {
          const raw = readText$1(await workspace(), file);
          cache2 = raw ? sanitize(JSON.parse(raw)) : { ...defaults2 };
        } catch {
          cache2 = { ...defaults2 };
        }
        return { ...cache2 };
      },
      save(next) {
        cache2 = sanitize(next);
        schedule();
      },
      patch(part) {
        cache2 = sanitize({ ...cache2 ?? defaults2, ...part });
        schedule();
      },
      async flush() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
          writing2 = persist();
        }
        await writing2;
      }
    };
  }
  function warmToolSettings(settings2) {
    void settings2.read().catch(() => void 0);
  }
  function clampNumber(raw, min, max, fallback) {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, value));
  }
  function pickString(raw, fallback) {
    return typeof raw === "string" && raw.trim() !== "" ? raw : fallback;
  }
  function pickOneOf(raw, allowed, fallback) {
    return typeof raw === "string" && allowed.includes(raw) ? raw : fallback;
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
      x1: clamp$1(points.x1, 0, 1),
      y1: clamp$1(points.y1, CURVE_Y_MIN, CURVE_Y_MAX),
      x2: clamp$1(points.x2, 0, 1),
      y2: clamp$1(points.y2, CURVE_Y_MIN, CURVE_Y_MAX)
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
  function clamp$1(value, low, high) {
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
    container.innerHTML = markup$a();
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
    function measure2() {
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
        const at2 = project(box, value.x, value.y);
        const anchor = index === 1 ? start : end;
        setAttr(
          tethers.get(index),
          "d",
          `M${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} L${at2.x.toFixed(1)},${at2.y.toFixed(1)}`
        );
        const grip = grips.get(index);
        if (grip) {
          grip.style.left = `${at2.x.toFixed(1)}px`;
          grip.style.top = `${at2.y.toFixed(1)}px`;
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
      measure2();
      render();
      const target2 = event.target;
      const grip = target2 instanceof Element ? target2.closest("[data-handle]") : null;
      const at2 = locate(event);
      let index = grip ? Number(grip.dataset.handle) : null;
      if (!index && at2) {
        const cursor = project(box, at2.x, at2.y);
        const first = project(box, points.x1, points.y1);
        const second = project(box, points.x2, points.y2);
        index = distance$1(cursor, first) <= distance$1(cursor, second) ? 1 : 2;
        commit2(withPoint(index, at2.x, at2.y));
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
      const at2 = locate(event);
      if (at2) {
        commit2(withPoint(dragging, at2.x, at2.y));
      }
    }
    function onMouseUp() {
      dragging = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }
    function onKeyDown(event) {
      const target2 = event.target;
      const grip = target2 instanceof Element ? target2.closest("[data-handle]") : null;
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
      measure2();
      render();
    }
    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    measure2();
    render();
    return {
      setPoints(next) {
        points = clampPoints(next);
        measure2();
        render();
      },
      relayout() {
        measure2();
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
  function markup$a() {
    return `<svg class="ce-canvas" viewBox="0 0 ${NOMINAL_WIDTH} ${NOMINAL_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><path class="ce-floor" d=""/><path class="ce-ceiling" d=""/><path class="ce-linear" d=""/><path class="ce-tether" data-tether="1" d=""/><path class="ce-tether" data-tether="2" d=""/><path class="ce-curve" d=""/></svg><div class="ce-grip" ${CONTROL} data-handle="1" aria-label="Ponto de controle da saída"></div><div class="ce-grip" ${CONTROL} data-handle="2" aria-label="Ponto de controle da chegada"></div>`;
  }
  let drawnPoints = { ...CUSTOM_DEFAULT };
  const drawnSettings = createToolSettings(
    "curve-drawn.json",
    { ...CUSTOM_DEFAULT },
    (raw) => clampPoints({
      x1: clampNumber(raw.x1, -4, 4, CUSTOM_DEFAULT.x1),
      y1: clampNumber(raw.y1, -4, 4, CUSTOM_DEFAULT.y1),
      x2: clampNumber(raw.x2, -4, 4, CUSTOM_DEFAULT.x2),
      y2: clampNumber(raw.y2, -4, 4, CUSTOM_DEFAULT.y2)
    })
  );
  warmToolSettings(drawnSettings);
  let drawnTouched = false;
  void drawnSettings.read().then((stored) => {
    if (!drawnTouched) {
      drawnPoints = stored;
    }
  });
  function setDrawnPoints(next) {
    drawnPoints = next;
    drawnTouched = true;
    drawnSettings.save({ ...next });
  }
  const PREVIEW_WIDTH$1 = 200;
  const PREVIEW_GRAPH_HEIGHT$1 = 76;
  const PREVIEW_HEIGHT$1 = 108;
  const PREVIEW_PAD$1 = 8;
  const MOTION_START_X = 14;
  const MOTION_END_MARGIN = 26;
  const MOTION_Y_OFFSET = 14;
  function mountCurvePicker(container, options) {
    const initialCurveId = options.curveId ?? CURVES[0].id;
    let curveId = initialCurveId;
    let editor = null;
    let previewFrame = null;
    let previewMotion = null;
    container.innerHTML = markup$9(curveId);
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
      stopPreview();
      previewMotion = null;
      const drawing = curveId === CUSTOM_CURVE;
      slot.classList.toggle("is-editing", drawing);
      if (drawing) {
        if (!editor) {
          slot.innerHTML = "";
          editor = mountCurveEditor(slot, {
            points: drawnPoints,
            onChange: (next) => {
              setDrawnPoints(next);
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
        previewMotion = options.renderPreview(slot, curve());
      }
      writeTag();
      if (meta) {
        meta.innerHTML = drawing ? `<b>arraste os dois pontos</b><span class="preview-meta-gap"></span><div class="field-action" ${CONTROL} data-curve-reset>Redefinir</div>` : `<b>início</b><span class="preview-meta-gap"></span><div class="curve-preview-button" ${CONTROL} data-curve-play aria-label="Reproduzir a curva"><span class="curve-preview-play" aria-hidden="true"></span><span data-curve-play-label>Reproduzir</span></div><span class="preview-meta-gap"></span><b>fim</b>`;
      }
    }
    function stopPreview() {
      if (previewFrame !== null) {
        cancelAnimationFrame(previewFrame);
        previewFrame = null;
      }
      slot?.querySelector(".preview-runner")?.remove();
      slot?.querySelector(".preview-playhead")?.remove();
      slot?.querySelector(".preview-motion-trail")?.remove();
      slot?.querySelector(".preview-motion-halo")?.remove();
      slot?.querySelector(".preview-motion-runner")?.remove();
      const button = meta?.querySelector("[data-curve-play]");
      button?.classList.remove("is-playing");
      const label = button?.querySelector("[data-curve-play-label]");
      if (label) label.textContent = "Reproduzir";
    }
    function playPreview() {
      if (!slot) return;
      stopPreview();
      const svg = slot.querySelector("svg");
      const motion = previewMotion;
      if (!svg || !motion) return;
      const ns = "http://www.w3.org/2000/svg";
      const playhead = document.createElementNS(ns, "line");
      playhead.setAttribute("class", "preview-playhead");
      const runner = document.createElementNS(ns, "circle");
      runner.setAttribute("class", "preview-runner");
      runner.setAttribute("r", "4");
      const trail = document.createElementNS(ns, "line");
      trail.setAttribute("class", "preview-motion-trail");
      const halo = document.createElementNS(ns, "circle");
      halo.setAttribute("class", "preview-motion-halo");
      halo.setAttribute("r", "10");
      const mover = document.createElementNS(ns, "rect");
      mover.setAttribute("class", "preview-motion-runner");
      mover.setAttribute("width", "14");
      mover.setAttribute("height", "12");
      mover.setAttribute("rx", "2.5");
      const motionY = motion.height - MOTION_Y_OFFSET;
      const motionEndX = motion.width - MOTION_END_MARGIN;
      trail.setAttribute("x1", String(MOTION_START_X));
      trail.setAttribute("y1", String(motionY));
      trail.setAttribute("y2", String(motionY));
      svg.append(playhead, runner, trail, halo, mover);
      const button = meta?.querySelector("[data-curve-play]");
      button?.classList.add("is-playing");
      const label = button?.querySelector("[data-curve-play-label]");
      if (label) label.textContent = "Reproduzindo";
      let reduced = false;
      try {
        reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      } catch {
      }
      const duration = reduced ? 0 : 2200;
      const started = performance.now();
      const activeCurve = curve();
      const tick = (now) => {
        const progress = duration > 0 ? Math.min(1, (now - started) / duration) : 1;
        const point = motion.pointAt(progress);
        const eased = activeCurve.ease(progress);
        const motionX = MOTION_START_X + eased * (motionEndX - MOTION_START_X);
        runner.setAttribute("cx", point.x.toFixed(2));
        runner.setAttribute("cy", point.y.toFixed(2));
        playhead.setAttribute("x1", point.x.toFixed(2));
        playhead.setAttribute("x2", point.x.toFixed(2));
        playhead.setAttribute("y1", "4");
        playhead.setAttribute("y2", String(motion.graphHeight - 4));
        trail.setAttribute("x2", motionX.toFixed(2));
        halo.setAttribute("cx", motionX.toFixed(2));
        halo.setAttribute("cy", String(motionY));
        mover.setAttribute("x", (motionX - 7).toFixed(2));
        mover.setAttribute("y", String(motionY - 6));
        if (progress < 1) {
          previewFrame = requestAnimationFrame(tick);
        } else {
          previewFrame = null;
          button?.classList.remove("is-playing");
          if (label) label.textContent = "Reproduzir";
          playhead.remove();
          runner.remove();
        }
      };
      previewFrame = requestAnimationFrame(tick);
    }
    function select(next) {
      if (next === CUSTOM_CURVE && curveId !== CUSTOM_CURVE) {
        const seed = findCurve(curveId).points;
        if (seed) {
          setDrawnPoints({ ...seed });
        }
      }
      curveId = next;
      for (const cell2 of container.querySelectorAll("[data-curve]")) {
        cell2.setAttribute("aria-pressed", String(cell2.dataset.curve === next));
      }
      render();
      options.onChange(curve());
      if (next !== CUSTOM_CURVE) {
        playPreview();
      }
    }
    for (const cell2 of container.querySelectorAll("[data-curve]")) {
      cell2.addEventListener("click", () => select(cell2.dataset.curve));
    }
    meta?.addEventListener("click", (event) => {
      const target2 = event.target;
      if (!(target2 instanceof Element)) return;
      if (target2.closest("[data-curve-play]")) {
        playPreview();
      } else if (target2.closest("[data-curve-reset]")) {
        setDrawnPoints({ ...CUSTOM_DEFAULT });
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
      setCurveId(id) {
        const known2 = id === CUSTOM_CURVE || CURVES.some((entry) => entry.id === id);
        if (known2 && id !== curveId) {
          select(id);
        }
      },
      destroy() {
        stopPreview();
        editor?.destroy();
        editor = null;
      }
    };
  }
  function renderCurvePreview(slot, curve) {
    slot.innerHTML = `<svg viewBox="0 0 ${PREVIEW_WIDTH$1} ${PREVIEW_HEIGHT$1}" preserveAspectRatio="none" aria-hidden="true"><path class="preview-grid" d="M0,${PREVIEW_GRAPH_HEIGHT$1 - PREVIEW_PAD$1} L${PREVIEW_WIDTH$1},${PREVIEW_GRAPH_HEIGHT$1 - PREVIEW_PAD$1}"/><path class="preview-curve" d="${curvePath(curve, PREVIEW_WIDTH$1, PREVIEW_GRAPH_HEIGHT$1, PREVIEW_PAD$1)}"/><path class="preview-motion-track" d="M${MOTION_START_X},${PREVIEW_HEIGHT$1 - MOTION_Y_OFFSET} L${PREVIEW_WIDTH$1 - MOTION_END_MARGIN},${PREVIEW_HEIGHT$1 - MOTION_Y_OFFSET}"/><circle class="preview-motion-stop" cx="${MOTION_START_X}" cy="${PREVIEW_HEIGHT$1 - MOTION_Y_OFFSET}" r="2"/><circle class="preview-motion-stop" cx="${PREVIEW_WIDTH$1 - MOTION_END_MARGIN}" cy="${PREVIEW_HEIGHT$1 - MOTION_Y_OFFSET}" r="2"/></svg>`;
    return {
      width: PREVIEW_WIDTH$1,
      height: PREVIEW_HEIGHT$1,
      graphHeight: PREVIEW_GRAPH_HEIGHT$1,
      pointAt(progress) {
        const t = Math.max(0, Math.min(1, progress));
        return {
          x: PREVIEW_PAD$1 + t * (PREVIEW_WIDTH$1 - PREVIEW_PAD$1 * 2),
          y: PREVIEW_GRAPH_HEIGHT$1 - PREVIEW_PAD$1 - curve.ease(t) * (PREVIEW_GRAPH_HEIGHT$1 - PREVIEW_PAD$1 * 2)
        };
      }
    };
  }
  function markup$9(curveId) {
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
  function mountSlider(host2, spec) {
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
    host2.className = "fl-slider";
    host2.setAttribute("role", "slider");
    host2.setAttribute("tabindex", "0");
    host2.setAttribute("aria-label", spec.label);
    host2.innerHTML = '<span class="fl-slider-line"></span><span class="fl-slider-fill"></span><span class="fl-slider-thumb"></span>';
    const fill = host2.querySelector(".fl-slider-fill");
    const thumb = host2.querySelector(".fl-slider-thumb");
    function render() {
      const percent = span === 0 ? 0 : (value - spec.min) / span * 100;
      if (fill) fill.style.width = `${percent}%`;
      if (thumb) thumb.style.left = `${percent}%`;
      host2.setAttribute("aria-valuenow", String(value));
      host2.setAttribute("aria-valuemin", String(spec.min));
      host2.setAttribute("aria-valuemax", String(spec.max));
      host2.setAttribute("aria-valuetext", spec.format(value));
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
      const rect = host2.getBoundingClientRect();
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
      host2.focus();
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
    host2.addEventListener("mousedown", onDown);
    host2.addEventListener("keydown", onKey);
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
          host2.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeEntry(false);
          host2.focus();
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
        host2.removeEventListener("mousedown", onDown);
        host2.removeEventListener("keydown", onKey);
        if (spec.output) {
          spec.output.removeEventListener("dblclick", onOutputDouble);
          spec.output.removeEventListener("keydown", onOutputKey);
        }
      }
    };
  }
  const ZOOM_DEFAULTS = {
    direction: "in",
    style: "punch",
    scalePercent: SCALE_DEFAULTS.punch,
    punchDuration: PUNCH_DURATION_DEFAULT,
    curveId: "punch",
    scaleTouched: false
  };
  const zoomSettings = createToolSettings(
    "zoom-config.json",
    ZOOM_DEFAULTS,
    (raw) => ({
      direction: pickOneOf(raw.direction, ["in", "out"], "in"),
      style: pickOneOf(raw.style, ["punch", "full"], "punch"),
      scalePercent: Math.round(
        clampNumber(raw.scalePercent, SCALE_MIN, SCALE_MAX, SCALE_DEFAULTS.punch)
      ),
      punchDuration: clampNumber(
        raw.punchDuration,
        PUNCH_DURATION_MIN,
        PUNCH_DURATION_MAX,
        PUNCH_DURATION_DEFAULT
      ),
      curveId: typeof raw.curveId === "string" && raw.curveId !== "custom" ? raw.curveId : "punch",
      scaleTouched: raw.scaleTouched === true
    })
  );
  warmToolSettings(zoomSettings);
  let livePicker$1 = null;
  let scaleSlider = null;
  let durationSlider = null;
  const PREVIEW_WIDTH = 220;
  const PREVIEW_GRAPH_HEIGHT = 76;
  const PREVIEW_HEIGHT = 108;
  const PREVIEW_PAD = 8;
  const PREVIEW_MOTION_Y = 94;
  const PREVIEW_MOTION_START_X = 14;
  const PREVIEW_MOTION_END_X = PREVIEW_WIDTH - 26;
  function shapeFor$1(style, punchDuration) {
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
      const saved = zoomSettings.peek() ?? ZOOM_DEFAULTS;
      let direction = saved.direction;
      let style = saved.style;
      let scalePercent = saved.scalePercent;
      let punchDuration = saved.punchDuration;
      let scaleTouched = saved.scaleTouched;
      container.innerHTML = markup$8(direction, style, scalePercent, punchDuration);
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
      const curveZone = container.querySelector("[data-curve-zone]");
      livePicker$1?.destroy();
      livePicker$1 = mountCurvePicker(curveZone, {
        curveId: saved.curveId,
        renderPreview: (slot, curve) => renderRamp(slot, curve),
        onChange: () => draw()
      });
      function renderRamp(slot, curve) {
        const geometry = curveGeometry(
          shapeFor$1(style, punchDuration),
          scalePercent,
          PREVIEW_WIDTH,
          PREVIEW_GRAPH_HEIGHT,
          PREVIEW_PAD,
          curve.ease
        );
        const dots = KEY_OFFSETS.map((t) => {
          const at2 = geometry.pointAt(t);
          return `<circle class="preview-key" cx="${at2.x.toFixed(1)}" cy="${at2.y.toFixed(1)}" r="2.6"/>`;
        }).join("");
        slot.innerHTML = `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" preserveAspectRatio="none" aria-hidden="true"><path class="preview-grid" d="M0,${PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD} L${PREVIEW_WIDTH},${PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD}"/><path class="preview-area" d="${geometry.area}"/><path class="preview-hold" d="${geometry.hold}"/><path class="preview-curve" d="${geometry.rise}"/>` + dots + `<path class="preview-motion-track" d="M${PREVIEW_MOTION_START_X},${PREVIEW_MOTION_Y} L${PREVIEW_MOTION_END_X},${PREVIEW_MOTION_Y}"/><circle class="preview-motion-stop" cx="${PREVIEW_MOTION_START_X}" cy="${PREVIEW_MOTION_Y}" r="2"/><circle class="preview-motion-stop" cx="${PREVIEW_MOTION_END_X}" cy="${PREVIEW_MOTION_Y}" r="2"/></svg>`;
        return {
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          graphHeight: PREVIEW_GRAPH_HEIGHT,
          pointAt: geometry.pointAt
        };
      }
      function draw() {
        livePicker$1?.refresh();
        if (durationField) {
          durationField.hidden = style === "full";
        }
        remember2();
      }
      function remember2() {
        zoomSettings.patch({
          direction,
          style,
          scalePercent,
          punchDuration,
          scaleTouched,
          curveId: livePicker$1?.curve().id ?? ZOOM_DEFAULTS.curveId
        });
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
      void zoomSettings.read().then((stored) => {
        if (!container.isConnected) {
          return;
        }
        scaleTouched = stored.scaleTouched;
        setDirection(stored.direction);
        setStyle(stored.style);
        setScale(stored.scalePercent);
        setDuration(stored.punchDuration);
        livePicker$1?.setCurveId(stored.curveId);
      });
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
      void zoomSettings.flush();
      scaleSlider?.destroy();
      scaleSlider = null;
      durationSlider?.destroy();
      durationSlider = null;
      livePicker$1?.destroy();
      livePicker$1 = null;
    }
  };
  function markup$8(direction, style, scalePercent, punchDuration) {
    const presetButtonsHtml = PUNCH_DURATION_PRESETS.map(
      (preset) => `<div class="preset-pill${Math.abs(preset - punchDuration) < 0.05 ? " is-active" : ""}" ${CONTROL} data-preset-dur="${preset}">${preset.toFixed(1)}s</div>`
    ).join("");
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Direção</span><div class="seg" data-direction-seg><div class="seg-item" ${CONTROL} data-value="in" aria-pressed="${direction === "in"}">Zoom In</div><div class="seg-item" ${CONTROL} data-value="out" aria-pressed="${direction === "out"}">Zoom Out</div></div></div><div class="field"><span class="t-label">Comportamento</span><div class="seg" data-style-seg><div class="seg-item" ${CONTROL} data-style="punch" aria-pressed="${style === "punch"}">Punch Smooth</div><div class="seg-item" ${CONTROL} data-style="full" aria-pressed="${style === "full"}">Clipe inteiro</div></div></div><div class="field" data-duration-field${style === "full" ? " hidden" : ""}><div class="field-head"><span class="t-label">Duração do Punch</span><span class="field-val" data-out-duration>${punchDuration.toFixed(1)}s</span></div><div class="preset-rail">${presetButtonsHtml}</div><div class="slider-row"><div data-duration></div></div></div><div class="field"><div class="field-head"><span class="t-label" title="100% mantém o enquadramento; valores acima aumentam o corte com Transform.">Intensidade (Escala Alvo)</span><span class="field-val" data-out-scale>${scalePercent}%</span></div><div class="slider-row"><div data-scale></div></div></div></div><div class="zone" data-curve-zone></div></div>`;
  }
  const FILE = "flow-baked.json";
  const MAX_PROJECTS = 24;
  const bakedByParam = /* @__PURE__ */ new Map();
  let loadedFor = null;
  let loading = null;
  function projectKey(project2) {
    if (!project2) {
      return "(sem projeto)";
    }
    try {
      const path = project2.path;
      if (typeof path === "string" && path.trim() !== "") {
        return path;
      }
    } catch {
    }
    try {
      const name = project2.name;
      if (typeof name === "string" && name.trim() !== "") {
        return `nome:${name}`;
      }
    } catch {
    }
    return "(sem projeto)";
  }
  function parse(raw) {
    if (!raw) {
      return { version: 1, projects: {} };
    }
    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || typeof data.projects !== "object") {
        return { version: 1, projects: {} };
      }
      return { version: 1, projects: data.projects };
    } catch {
      return { version: 1, projects: {} };
    }
  }
  async function readStored() {
    try {
      const space = await workspace();
      return parse(readText$1(space, FILE));
    } catch {
      return { version: 1, projects: {} };
    }
  }
  async function ensureRegistryLoaded(project2) {
    const key = projectKey(project2);
    if (loadedFor === key) {
      return;
    }
    if (loading) {
      await loading;
      if (loadedFor === key) {
        return;
      }
    }
    loading = (async () => {
      const stored = await readStored();
      bakedByParam.clear();
      const entry = stored.projects[key];
      if (entry && entry.params) {
        for (const [paramKey, ticks] of Object.entries(entry.params)) {
          if (Array.isArray(ticks) && ticks.length > 0) {
            bakedByParam.set(paramKey, new Set(ticks.filter((t) => typeof t === "string")));
          }
        }
      }
      loadedFor = key;
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }
  async function persistRegistry(project2) {
    const key = projectKey(project2);
    try {
      const space = await workspace();
      const stored = parse(readText$1(space, FILE));
      const params = {};
      for (const [paramKey, ticks] of bakedByParam) {
        if (ticks.size > 0) {
          params[paramKey] = [...ticks];
        }
      }
      if (Object.keys(params).length === 0) {
        delete stored.projects[key];
      } else {
        stored.projects[key] = { updated: (/* @__PURE__ */ new Date()).toISOString(), params };
      }
      const ordered2 = Object.entries(stored.projects).sort(
        (a, b) => (b[1]?.updated ?? "").localeCompare(a[1]?.updated ?? "")
      );
      stored.projects = Object.fromEntries(ordered2.slice(0, MAX_PROJECTS));
      await write(space, FILE, JSON.stringify(stored));
    } catch (cause) {
      console.warn("[Flow] não consegui gravar o registro de assadura:", cause);
    }
  }
  function bakedFor(key) {
    let set = bakedByParam.get(key);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      bakedByParam.set(key, set);
    }
    return set;
  }
  function bakedIfAny(key) {
    return bakedByParam.get(key);
  }
  function forgetParam(key) {
    bakedByParam.delete(key);
  }
  const FLOW_DIAG_FILE = "flow-diag.json";
  const MAX_PARAMS = 40;
  const EXCLUDED_COMPONENTS = /time\s*remap|remapeamento\s*de\s*tempo|remappage|zeitverzerrung|时间重映射/i;
  async function resolve(value) {
    return await value;
  }
  async function readAnimatedParams() {
    const report2 = { clips: 0, lines: [] };
    const ppro = getPremiere();
    if (!ppro) {
      report2.lines.push("Runtime do Premiere indisponível.");
      return { params: [], report: report2 };
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      const sequence2 = project2 ? await project2.getActiveSequence() : null;
      if (!sequence2) {
        report2.lines.push("Nenhuma sequência ativa.");
        return { params: [], report: report2 };
      }
      await ensureRegistryLoaded(project2);
      const clips = await collectSelectedVideoClips(ppro, sequence2);
      report2.clips = clips.length;
      if (clips.length === 0) {
        report2.lines.push("Nenhum clipe de vídeo selecionado na timeline.");
        return { params: [], report: report2 };
      }
      const found = [];
      for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
        const clipKey = clips[clipIndex].key;
        const chain = await clips[clipIndex].clip.getComponentChain();
        if (!chain) {
          report2.lines.push(`Clipe ${clipIndex + 1}: sem cadeia de efeitos.`);
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
            report2.lines.push(`${componentName}: ignorado (remapeamento de tempo).`);
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
              anchorTicks: anchorsOf$1(key, keyTicks),
              clipIndex,
              componentIndex: ci,
              paramIndex: pi
            });
          }
          report2.lines.push(
            `${componentName}: ${paramCount} param, ${animatedHere} animado(s)`
          );
        }
      }
      console.log(
        `[Flow] varredura: ${report2.clips} clipe(s), ${found.length} parâmetro(s) animado(s)`
      );
      return { params: found, report: report2 };
    } catch (cause) {
      report2.lines.push(`Erro: ${describeError$1(cause)}`);
      console.error("[Flow] falha ao ler os parâmetros:", cause);
      return { params: [], report: report2 };
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
  function anchorsOf$1(key, keyTicks) {
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
          const existing = (await keyframeTimes(param)).map((time) => time.ticks);
          plans.push({
            param,
            key: "",
            removeTicks: inner,
            add: [],
            before: existing.length,
            existing,
            anchors: []
          });
        }
      }
      return plans;
    });
  }
  async function runOnTargets(targets, undoLabel, build) {
    const ppro = getPremiere();
    if (!ppro) {
      return fail$3("Runtime do Premiere indisponível.");
    }
    if (targets.length === 0) {
      return fail$3("Escolha ao menos um parâmetro animado.");
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      const sequence2 = project2 ? await project2.getActiveSequence() : null;
      if (!sequence2) {
        return fail$3("Abra uma sequência na timeline primeiro.");
      }
      await ensureRegistryLoaded(project2);
      const clips = await collectSelectedVideoClips(ppro, sequence2);
      if (clips.length === 0) {
        return fail$3("Nenhum clipe de vídeo selecionado na timeline.");
      }
      const byKey = new Map(clips.map((ref) => [ref.key, ref.clip]));
      const context = {
        ticksPerFrame: await readTicksPerFrame(sequence2),
        notes: [],
        diag: []
      };
      const plans = [];
      let segments = 0;
      for (const target2 of targets) {
        const label = target2.param.label;
        const param = await resolveParam(byKey, target2.param);
        if (!param) {
          context.notes.push(`${label}: clipe não está mais na seleção.`);
          continue;
        }
        if (!await keyframesSupported(param)) {
          context.notes.push(`${label}: não aceita keyframes.`);
          continue;
        }
        const pairs = pairsFor(target2);
        if (pairs.length === 0) {
          context.notes.push(`${label}: trecho fora do alcance.`);
          continue;
        }
        try {
          const built = await build(param, pairs, context);
          for (const plan of built) {
            plan.key = target2.param.key;
            plan.descriptor = target2.param;
          }
          plans.push(...built);
          segments += built.length;
        } catch (cause) {
          context.notes.push(`${label}: ${describeError$1(cause)}`);
        }
      }
      if (plans.length === 0) {
        return fail$3(withNotes("Nada a fazer nesses segmentos.", context.notes));
      }
      const relatorio = {
        quando: (/* @__PURE__ */ new Date()).toISOString(),
        acao: undoLabel,
        ticksPerFrame: context.ticksPerFrame === null ? null : context.ticksPerFrame.toString(),
        alvos: targets.map((target2) => ({
          label: target2.param.label,
          segment: target2.segment,
          keyTicks: target2.param.keyTicks,
          anchorTicks: target2.param.anchorTicks
        })),
        relogios: DIAG_ENABLED ? await clipClocks(byKey, targets) : "(diag desligado)",
        trechos: context.diag,
        planos: plans.map((plan) => ({
          param: plan.descriptor?.label ?? safeDisplayName(plan.param),
          remove: plan.removeTicks,
          add: plan.add,
          existentes: plan.existing
        })),
        antes: DIAG_ENABLED ? await keyframesByParam(plans, byKey) : "(diag desligado)",
        notas: context.notes.slice()
      };
      await dumpDiag(relatorio, FLOW_DIAG_FILE);
      let committed = false;
      let added = 0;
      let refused2 = 0;
      let transactionError = null;
      const filed = [];
      const toLinear = [];
      try {
        project2.lockedAccess(() => {
          committed = project2.executeTransaction((compoundAction) => {
            const push = (make, required) => {
              try {
                const action = make();
                if (!action) {
                  if (required) refused2 += 1;
                  return false;
                }
                const accepted = compoundAction.addAction(action) !== false;
                if (!accepted && required) {
                  refused2 += 1;
                }
                return accepted;
              } catch (cause) {
                if (required) {
                  refused2 += 1;
                  console.warn("[Flow] ação recusada:", cause);
                }
                return false;
              }
            };
            for (const plan of plans) {
              const record = { key: plan.key, added: [], removed: [] };
              filed.push(record);
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
                toLinear.push({ param: plan.param, ticks });
              }
            }
          }, undoLabel);
        });
      } catch (cause) {
        transactionError = describeError$1(cause);
      }
      relatorio.transacao = { committed, added, refused: refused2, transactionError, filed };
      if (transactionError) {
        await dumpDiag(relatorio, FLOW_DIAG_FILE, true);
        return fail$3(withNotes(`O Premiere recusou: ${transactionError}`, context.notes));
      }
      if (!committed) {
        return fail$3(
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
          forgetParam(record.key);
        }
      }
      await persistRegistry(project2);
      let linearCommitted = false;
      let linearFiled = 0;
      if (toLinear.length > 0) {
        try {
          project2.lockedAccess(() => {
            linearCommitted = project2.executeTransaction((compoundAction) => {
              for (const entry of toLinear) {
                try {
                  const action = entry.param.createSetInterpolationAtKeyframeAction(
                    ppro.TickTime.createWithTicks(entry.ticks),
                    ppro.Constants.InterpolationMode.LINEAR
                  );
                  if (action && compoundAction.addAction(action) !== false) {
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
        return fail$3(
          withNotes(
            `Nenhum keyframe foi aceito (${refused2} recusa(s)). Veja o console do UXP.`,
            context.notes
          )
        );
      }
      const refreshedSequence = await (await ppro.Project.getActiveProject())?.getActiveSequence() ?? sequence2;
      const refreshedClips = await collectSelectedVideoClips(ppro, refreshedSequence);
      const refreshedByKey = new Map(
        refreshedClips.map((ref) => [ref.key, ref.clip])
      );
      const swept = await sweepStrays(ppro, project2, plans, filed, refreshedByKey);
      if (swept > 0) {
        context.notes.push(
          `${swept} keyframe(s) que o Premiere criou sozinho foram removidos.`
        );
      }
      const ancoras = await repairAnchors(ppro, project2, plans, refreshedByKey);
      relatorio.ancoras = ancoras;
      const reparados = ancoras.filter((row) => row.reparado).length;
      if (reparados > 0) {
        context.notes.push(
          `${reparados} âncora(s) voltaram com valor errado e foram reescritos.`
        );
      }
      const verified = await verify(plans, refreshedByKey);
      const torto = swept > 0 || reparados > 0 || refused2 > 0 || wanted > 0 && verified === 0;
      relatorio.depois = {
        varridos: swept,
        verificados: verified,
        keyframes: DIAG_ENABLED || torto ? await keyframesByParam(plans, refreshedByKey) : "(diag desligado)",
        notas: context.notes.slice()
      };
      await dumpDiag(relatorio, FLOW_DIAG_FILE, torto);
      if (wanted > 0 && verified === 0) {
        context.notes.push("Não consegui reler os keyframes — confira o Effect Controls.");
      }
      if (refused2 > 0) {
        context.notes.push(`${refused2} ação(ões) recusada(s) pelo Premiere.`);
      }
      return {
        ok: true,
        message: withNotes(
          added ? `${added} keyframes criados em ${segments} ${segments === 1 ? "trecho" : "trechos"}.` : `${segments} ${segments === 1 ? "trecho limpo" : "trechos limpos"}.`,
          context.notes
        )
      };
    } catch (cause) {
      return fail$3(`Falhou: ${describeError$1(cause)}`);
    }
  }
  async function clipClocks(byKey, targets) {
    const out = {};
    const read = async (get) => {
      try {
        const time = await Promise.resolve(get());
        return time ? String(time.ticks) : "(vazio)";
      } catch (cause) {
        return `(erro: ${describeError$1(cause)})`;
      }
    };
    for (const target2 of targets) {
      const clip = byKey.get(target2.param.clipKey);
      if (!clip || out[target2.param.clipKey]) {
        continue;
      }
      out[target2.param.clipKey] = {
        sequenciaIn: await read(() => clip.getStartTime()),
        sequenciaOut: await read(() => clip.getEndTime()),
        mediaIn: await read(() => clip.getInPoint()),
        mediaOut: await read(() => clip.getOutPoint())
      };
    }
    return out;
  }
  async function keyframesByParam(plans, byKey) {
    const out = {};
    for (const plan of plans) {
      const label = plan.descriptor?.label ?? safeDisplayName(plan.param);
      if (out[label]) {
        continue;
      }
      let param = null;
      try {
        param = plan.descriptor ? await resolveParam(byKey, plan.descriptor) : null;
      } catch {
        param = null;
      }
      out[label] = await probeKeyframes(param ?? plan.param);
    }
    return out;
  }
  function sameValue(a, b) {
    if (b === null) {
      return false;
    }
    if (typeof a === "number" || typeof b === "number") {
      return typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-3;
    }
    return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4;
  }
  async function repairAnchors(ppro, project2, plans, byKey) {
    const rows = [];
    const seen = /* @__PURE__ */ new Set();
    for (const plan of plans) {
      let fresh = null;
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
        const row = {
          param: label,
          ticks: anchor.ticks,
          antes: anchor.value,
          depois,
          reparado: false
        };
        rows.push(row);
        if (sameValue(anchor.value, depois)) {
          continue;
        }
        console.warn(`[Flow] ${label}: âncora em ${anchor.ticks} mudou de`, anchor.value, "para", depois);
        try {
          let apagou = false;
          project2.lockedAccess(() => {
            apagou = project2.executeTransaction((compoundAction) => {
              compoundAction.addAction(
                handle.createRemoveKeyframeAction(
                  ppro.TickTime.createWithTicks(anchor.ticks),
                  false
                )
              );
            }, "Curva: repor âncora (apagar)");
          });
          let escreveu = false;
          project2.lockedAccess(() => {
            escreveu = project2.executeTransaction((compoundAction) => {
              const keyframe = makeKeyframe(ppro, handle, anchor.value);
              keyframe.position = ppro.TickTime.createWithTicks(anchor.ticks);
              compoundAction.addAction(handle.createAddKeyframeAction(keyframe));
            }, "Curva: repor âncora (escrever)");
          });
          row.reparado = apagou && escreveu;
        } catch (cause) {
          row.erro = describeError$1(cause);
          console.warn("[Flow] a reposição do âncora não assentou:", cause);
        }
        row.depoisDoReparo = await readValue(handle, time);
      }
    }
    return rows;
  }
  async function sweepStrays(ppro, project2, plans, filed, byKey) {
    const normal = (ticks) => {
      try {
        return BigInt(ticks).toString();
      } catch {
        return ticks;
      }
    };
    const expected = /* @__PURE__ */ new Map();
    const paramOf = /* @__PURE__ */ new Map();
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
    const strays = [];
    for (const [key, set] of expected) {
      const plan = paramOf.get(key)?.plan;
      if (!plan) {
        continue;
      }
      let param = null;
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
          label: plan.descriptor?.label ?? safeDisplayName(handle)
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
      project2.lockedAccess(() => {
        const committed = project2.executeTransaction((compoundAction) => {
          for (const stray of strays) {
            for (const time of stray.times) {
              try {
                const action = stray.param.createRemoveKeyframeAction(
                  ppro.TickTime.createWithTicks(time.ticks),
                  false
                );
                if (action && compoundAction.addAction(action) !== false) {
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
  function pairsFor(target2) {
    const ticks = target2.param.anchorTicks;
    if (target2.segment === "all") {
      const pairs = [];
      for (let index = 0; index < ticks.length - 1; index++) {
        pairs.push([ticks[index], ticks[index + 1]]);
      }
      return pairs;
    }
    const start = ticks[target2.segment];
    const end = ticks[target2.segment + 1];
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
        { ticks: endTicks, value: to }
      ]
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
    let current2 = raw;
    for (let depth = 0; depth < 4; depth++) {
      const asNumber = finiteNumber(current2);
      if (asNumber !== null) {
        return asNumber;
      }
      if (!current2 || typeof current2 !== "object") {
        return null;
      }
      if (Array.isArray(current2) && current2.length >= 2) {
        const x2 = finiteNumber(current2[0]);
        const y2 = finiteNumber(current2[1]);
        return x2 !== null && y2 !== null ? { x: x2, y: y2 } : null;
      }
      const record = current2;
      const x = finiteNumber(record.x);
      const y = finiteNumber(record.y);
      if (x !== null && y !== null) {
        return { x, y };
      }
      if (!("value" in record)) {
        return null;
      }
      current2 = record.value;
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
  function fail$3(message) {
    return { ok: false, message };
  }
  const FLOW_DEFAULTS = {
    density: DENSITY_DEFAULT,
    curveId: "ease-out"
  };
  const flowSettings = createToolSettings(
    "flow-config.json",
    FLOW_DEFAULTS,
    (raw) => ({
      density: Math.round(
        clampNumber(raw.density, DENSITY_MIN, DENSITY_MAX, DENSITY_DEFAULT)
      ),
      curveId: typeof raw.curveId === "string" && raw.curveId !== "custom" ? raw.curveId : FLOW_DEFAULTS.curveId
    })
  );
  warmToolSettings(flowSettings);
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
      const saved = flowSettings.peek() ?? FLOW_DEFAULTS;
      let params = [];
      let report2 = null;
      let density = saved.density;
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
        curveId: saved.curveId,
        renderPreview: renderCurvePreview,
        onChange: () => remember2()
      });
      function remember2() {
        flowSettings.patch({
          density,
          curveId: livePicker?.curve().id ?? FLOW_DEFAULTS.curveId
        });
      }
      function renderList(keepStatus = false) {
        if (params.length === 0) {
          list.innerHTML = '<p class="work-note">Nenhum parâmetro com keyframes no clipe selecionado. Selecione na timeline o clipe que tem a animação e toque em Reler.</p>' + scanMarkup(report2);
          context.setApplyEnabled(false);
          if (!keepStatus) {
            context.setStatus(
              report2 && report2.clips === 0 ? "Nenhum clipe de vídeo selecionado na timeline." : "O clipe selecionado não tem parâmetros com keyframes.",
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
          report2 = scan.report;
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
        const target2 = event.target;
        if (!(target2 instanceof Element)) {
          return;
        }
        const key = target2.closest("[data-segment]");
        if (key) {
          const paramId = key.dataset.param;
          const segment = Number(key.dataset.segment);
          picked.set(paramId, picked.get(paramId) === segment ? "all" : segment);
          renderList();
          return;
        }
        const row = target2.closest("[data-param]");
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
        remember2();
      }
      setDensity(density);
      void reload();
      void flowSettings.read().then((stored) => {
        if (!container.isConnected) {
          return;
        }
        setDensity(stored.density);
        livePicker?.setCurveId(stored.curveId);
      });
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
      void flowSettings.flush();
      densitySlider?.destroy();
      densitySlider = null;
      livePicker?.destroy();
      livePicker = null;
    }
  };
  function scanMarkup(report2) {
    if (!report2) {
      return "";
    }
    const rows = report2.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
    return `<div class="scan"><span class="t-label">Varredura · ${report2.clips} clipe(s)</span>` + (rows ? `<ul class="scan-list">${rows}</ul>` : "") + "</div>";
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
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Parâmetros animados</span><div class="field-action" ${CONTROL} data-rescan title="Reler os keyframes do clipe selecionado">Reler</div></div><div class="kf-list" data-param-list></div></div><div class="field"><div class="field-head"><span class="t-label" title="Cada keyframe assado é um keyframe que você não retima mais. Use Linear para desfazer e reajustar o tempo.">Densidade da assadura</span><span class="field-val" data-out-density>${density} kf</span></div><div class="preset-rail">${presets}</div><div class="slider-row"><div data-density></div></div></div></div><div class="zone" data-curve-zone></div></div>`;
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
    const keep2 = [];
    for (const block of blocks) {
      const start = Math.max(range.start, floorTo(block.start - range.start, frame) + range.start);
      const end = Math.min(range.end, ceilTo(block.end - range.start, frame) + range.start);
      if (end - start >= frame) {
        keep2.push({ start, end });
      }
    }
    const merged = mergeGaps(keep2, minRemoval);
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
      const current2 = sorted[index];
      const last = out[out.length - 1];
      if (current2.start - last.end < tolerance2) {
        last.end = Math.max(last.end, current2.end);
      } else {
        out.push({ ...current2 });
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
    const keep2 = [];
    let cursor = range.start;
    for (const gap of drop) {
      if (gap.start - cursor >= frame) {
        keep2.push({ start: cursor, end: gap.start });
      }
      cursor = gap.end;
    }
    if (range.end - cursor >= frame) {
      keep2.push({ start: cursor, end: range.end });
    }
    return keep2;
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
  function formatSeconds$1(value) {
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
      const words2 = parseTranscriptJSON(json);
      return {
        status: words2.length > 0 ? "ok" : "empty",
        words: words2,
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
    const words2 = readSegments(data) ?? readMonologues(data) ?? [];
    words2.sort((a, b) => a.start - b.start);
    return words2;
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
          text: readText(raw)
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
          text: readText(raw)
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
  function readText(raw) {
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
      this.values = [];
      this.sumSquares = 0;
      this.count = 0;
      this.carry = -1;
      this.windowSeconds = windowSeconds;
      this.offsetSeconds = offsetSeconds;
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
  const AGENT_VERSION = "4";
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
    const raw = readText$1(space, ALIVE_FILE);
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
      const raw = readText$1(space, ALIVE_FILE) ?? "";
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
      for (let attempt2 = 0; attempt2 < 12 && agentState(space) !== "gone"; attempt2 += 1) {
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
      return { mode: "denied", error: describe$5(cause), ticket: null };
    }
  }
  async function stampVerdict() {
    try {
      return (await agentStatus()).up ? "busy" : "dead";
    } catch {
      return "dead";
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
  function stopAgentHeartbeat() {
    if (heartbeat !== null) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
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
      "Dim runN, wrapPath, doneP, wh, q",
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set sh = CreateObject("WScript.Shell")',
      // A aspa como variável, e não escapada dentro de cada literal: o
      // invólucro abaixo cita dois caminhos, e uma linha com seis aspas
      // seguidas é onde um erro de escape se esconde sem ser visto.
      "q = Chr(34)",
      "runN = 0",
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
      // Terceiro campo, como no Unix. Ele não é decorativo: `agentStatus`
      // lê exatamente esta posição, e sem ela o diagnóstico do painel
      // dizia "de pé, nativo (?)" em TODA máquina Windows. Aqui não há
      // Rosetta, então a resposta honesta é o nome da arquitetura que o
      // próprio Windows informa.
      "  Dim arch",
      '  arch = sh.Environment("Process")("PROCESSOR_ARCHITECTURE")',
      '  If arch = "" Then arch = "windows"',
      `  h.Write Epoch() & " ${AGENT_VERSION} " & arch`,
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
      "          runN = runN + 1",
      '          wrapPath = dir & "\\agent-run-" & runN & ".bat"',
      '          doneP = dir & "\\agent-done-" & runN & ".txt"',
      "          ' Um sobrevivente de um agente anterior faria este job",
      "          ' parecer concluído antes mesmo de começar.",
      "          If fso.FileExists(doneP) Then fso.DeleteFile doneP, True",
      "          ' O invólucro: roda o job e AVISA quando ele de fato",
      "          ' saiu. O aviso chega por tmp+move, que é atômico — sem",
      "          ' isso o laço abaixo veria o arquivo antes do conteúdo.",
      "          Set wh = fso.CreateTextFile(wrapPath, True)",
      '          wh.WriteLine "@echo off"',
      '          wh.WriteLine "call " & q & jobPath & q',
      // O redirecionamento vem ANTES do echo de propósito. `echo 0> f` é
      // lido pelo cmd como redirecionamento do handle 0 (stdin), porque um
      // dígito colado no `>` é um número de handle — e o código de saída
      // mais comum é justamente 0. Assim o arquivo nasce vazio e o laço de
      // espera lê um código que nunca esteve lá.
      '          wh.WriteLine "> " & q & doneP & ".tmp" & q & " echo %errorlevel%"',
      '          wh.WriteLine "move /y " & q & doneP & ".tmp" & q & " " & q & doneP & q & " >nul"',
      "          wh.Close",
      "          Stamp",
      "          ' 0 = sem janela; False = NÃO espera aqui. Era o True",
      "          ' que congelava o carimbo pelo tempo inteiro do job.",
      '          sh.Run "cmd /c " & q & wrapPath & q, 0, False',
      "          ' A espera é nossa, e carimba a cada meia volta — é o",
      "          ' equivalente do `while kill -0` do bash. O sinal do",
      "          ' painel NÃO é checado aqui: trabalho começado termina.",
      "          Do While Not fso.FileExists(doneP)",
      "            Stamp",
      "            WScript.Sleep 500",
      "          Loop",
      "          Stamp",
      "          On Error Resume Next",
      "          fso.DeleteFile doneP, True",
      "          fso.DeleteFile wrapPath, True",
      "          On Error GoTo 0",
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
  const POLL_MS$2 = 350;
  const POLL_SLOW_MS = 1200;
  const POLL_FAST_WINDOW_MS = 30 * 1e3;
  const TIMEOUT_MS$2 = 20 * 60 * 1e3;
  async function step(label, run2) {
    try {
      return await run2();
    } catch (cause) {
      console.error(`[Silêncios] ${label} falhou:`, cause);
      throw new Error(`${label} — ${describe$5(cause)}`);
    }
  }
  let sequence$2 = 0;
  function extractionRun(windows = isWindows()) {
    const tag = `${Date.now().toString(36)}-${(sequence$2 += 1).toString(36)}`;
    return {
      tag,
      script: windows ? `extract-${tag}.bat` : `extract-${tag}.command`,
      // A grafia destes três não muda: é o contrato que o script escreve.
      result: `sil-${tag}-result.json`,
      progress: `sil-${tag}-progress.txt`,
      started: `sil-${tag}-started.txt`
    };
  }
  function runFiles$1(run2) {
    return [run2.script, run2.result, run2.progress, run2.started];
  }
  function extractionScript(run2, jobs, nativeBase, ffmpegPath, windows = isWindows()) {
    return (windows ? windowsScript$1(jobs, nativeBase, ffmpegPath) : unixScript$1(jobs, nativeBase, ffmpegPath)).split(RESULT_FILE$2).join(run2.result).split(PROGRESS_FILE$1).join(run2.progress).split(STARTED_FILE$2).join(run2.started);
  }
  let previousRun = [];
  async function readConfig$2() {
    const fallback = { ffmpegPath: "", mode: "waveform" };
    try {
      const raw = readText$1(await workspace(), CONFIG_FILE$2);
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
    const run2 = extractionRun();
    const scriptPath = nativePath(space, run2.script);
    for (const name of previousRun) {
      await remove(space, name);
    }
    previousRun = runFiles$1(run2);
    for (const job of jobs) {
      await remove(space, job.file);
    }
    const script = extractionScript(run2, jobs, space.nativeBase, ffmpegPath);
    await step("escrever o script", () => write(space, run2.script, script, true));
    const PURPOSE = "Extrair o áudio dos clipes selecionados com o ffmpeg, para detectar os silêncios pela onda.";
    let launchError = null;
    const sent = await dispatch(run2.script);
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Silêncios] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, PURPOSE);
      } catch (cause) {
        launchError = describe$5(cause);
        console.error("[Silêncios] openPath recusou:", cause);
        onManual?.(scriptPath, launchError);
      }
    }
    let stampDeadline = Date.now() + 8e3;
    const BUSY_GRACE_MS = 8e3;
    const BUSY_LIMIT = Date.now() + 18e4;
    const started = Date.now();
    const deadline = started + TIMEOUT_MS$2;
    let lastDone = -1;
    let tick = 0;
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        return { ok: false, error: "cancelled", ffmpegPath: null, scriptPath };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        const verdict = await stampVerdict();
        if (verdict === "busy" && Date.now() < BUSY_LIMIT) {
          stampDeadline = Date.now() + BUSY_GRACE_MS;
          console.log("[Silêncios] na fila: o agente está com outro trabalho.");
        } else if (!readText$1(space, run2.started)) {
          awaitingStamp = false;
          console.warn("[Silêncios] agente não respondeu — caindo para o Terminal.");
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, "Extrair o áudio dos clipes selecionados.");
          } catch (cause) {
            launchError = describe$5(cause);
            onManual?.(scriptPath, launchError);
          }
        } else {
          awaitingStamp = false;
        }
      }
      if (tick % 3 === 0) {
        const done = readProgress$1(space, run2.progress);
        if (done !== null && done !== lastDone) {
          lastDone = done;
          onProgress?.(done, jobs.length);
        }
      }
      tick += 1;
      const raw = readText$1(space, run2.result);
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
    const text2 = readText$1(space, name);
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
      add("módulo os", false, describe$5(cause));
    }
    let space;
    try {
      space = await workspace();
      add("endereço de escrita", true, `${space.fsBase} (${space.origin}, ${space.sync ? "sync" : "async"})`);
      add("caminho nativo", true, space.nativeBase);
    } catch (cause) {
      add("endereço de escrita", false, describe$5(cause));
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
      add("escrever script executável", false, describe$5(cause));
      return lines;
    }
    if (!shell) {
      return lines;
    }
    try {
      await shell.openPath(nativePath(space, probeName), "Testar o acesso ao ffmpeg.");
      add("openPath (script)", true, "disparado — aguardando resposta");
    } catch (cause) {
      add("openPath (script)", false, describe$5(cause));
      try {
        await shell.openPath(space.nativeBase, "Abrir a pasta de trabalho.");
        add("openPath (pasta)", true, "Finder abriu — o bloqueio é ao executável");
      } catch (folderCause) {
        add("openPath (pasta)", false, describe$5(folderCause));
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
      answer = readText$1(space, "probe.json");
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
      /*
       * FFMPEG nasce vazia, e isso NÃO é enfeite.
       *
       * Com `set -u` ligado, ler uma variável que nunca recebeu valor
       * aborta o bash na hora. O laço abaixo só atribui FFMPEG quando
       * ENCONTRA o binário, e a primeira leitura dela é justamente o
       * teste que decide baixar o FFmpeg. Ou seja: na máquina onde
       * nenhum dos caminhos tem ffmpeg — exatamente a primeira execução
       * de um usuário novo — o script morria em "unbound variable"
       * antes de escrever o resultado, o bloco de download logo abaixo
       * nunca rodava, e o painel esperava os 20 minutos do tempo limite
       * para depois acusar problema de autorização que não existia.
       *
       * O whisper.ts e o ytdlp.ts já faziam isto. Só este arquivo não.
       */
      "FFMPEG=''",
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
      // Pelo mesmo motivo do script de extração: sem isto o teste morria
      // em "unbound variable" na máquina sem ffmpeg, e o diagnóstico
      // respondia "sem resposta em 20s" — culpando a autorização do
      // sistema por um erro de script nosso.
      "FFMPEG=''",
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
      return "O sistema não executou o script" + (raw ? ` (${raw})` : "") + // Sem nomear o arquivo: ele é carimbado por execução (ver
      // `ExtractionRun`), e o nome exato aparece logo ao lado, no bloco
      // de execução manual, que mostra o caminho inteiro.
      '. Use "Abrir pasta" e dê um duplo clique no script de extração indicado abaixo — o painel continua esperando o resultado.';
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
  async function runCutTransaction(runs, rollback2) {
    const touched = [];
    for (const run2 of runs) {
      const removed = await attempt(() => run2.remove(), "a remoção dos clipes originais");
      if (!removed.ok) {
        if (touched.length === 0) {
          return { kind: "untouched", cause: removed.message };
        }
        return await undo(touched, removed.message, rollback2);
      }
      touched.push(run2.snapshot());
      const written = await attempt(() => run2.write(), "a escrita de um trecho");
      if (!written.ok) {
        return await undo(touched, written.message, rollback2);
      }
    }
    return { kind: "done", runs: touched };
  }
  async function attempt(step2, what) {
    try {
      return await step2();
    } catch (cause) {
      return {
        ok: false,
        message: `Falha em ${what}: ${describe$4(cause)}`
      };
    }
  }
  async function undo(touched, cause, rollback2) {
    let back;
    try {
      back = await rollback2(touched);
    } catch (rollbackCause) {
      back = { ok: false, message: describe$4(rollbackCause) };
    }
    if (back.ok) {
      return { kind: "restored", cause };
    }
    return {
      kind: "critical",
      cause,
      rollbackCause: back.message,
      runs: touched
    };
  }
  function describe$4(cause) {
    return cause instanceof Error ? cause.message : String(cause);
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
    const sequence2 = await project2.getActiveSequence();
    if (!sequence2) {
      throw new Error("Abra uma sequência na timeline primeiro.");
    }
    const ticksPerFrame = await readTicksPerFrame(sequence2);
    const perSecond = ticksPerSecond(ppro);
    const frameSeconds2 = ticksPerFrame ? Number(ticksPerFrame) / Number(perSecond) : 1 / 30;
    options.onStage?.("Lendo a seleção…");
    const pairs = await collectSelectedPairs(ppro, sequence2);
    const clips = [];
    for (const pair of pairs) {
      const target2 = await describePair(ppro, pair, options.mode);
      if (target2) {
        clips.push(target2);
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
  async function collectSelectedPairs(ppro, sequence2) {
    const pairs = [];
    const byIdentity = /* @__PURE__ */ new Map();
    const loose = /* @__PURE__ */ new Set();
    const videoCount = await sequence2.getVideoTrackCount();
    const videoTracks = await Promise.all(
      Array.from({ length: videoCount }, (_, index) => sequence2.getVideoTrack(index))
    );
    for (let index = 0; index < videoCount; index++) {
      const track = videoTracks[index];
      if (!track) {
        continue;
      }
      const itens = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const marcados = await Promise.all(
        itens.map((item) => Promise.resolve(item.getIsSelected()).catch(() => false))
      );
      const escolhidos = itens.filter((_, at2) => marcados[at2]);
      const chaves = await Promise.all(escolhidos.map((item) => itemIdentity(item)));
      escolhidos.forEach((item, at2) => {
        const key = chaves[at2];
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
      });
    }
    const audioCount = await sequence2.getAudioTrackCount();
    const audioTracks = await Promise.all(
      Array.from({ length: audioCount }, (_, index) => sequence2.getAudioTrack(index))
    );
    for (let index = 0; index < audioCount; index++) {
      const track = audioTracks[index];
      if (!track) {
        continue;
      }
      const itens = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const marcados = await Promise.all(
        itens.map((item) => Promise.resolve(item.getIsSelected()).catch(() => false))
      );
      const precisaDosSoltos = byIdentity.size > 0;
      const chaves = await Promise.all(
        itens.map(
          (item, at2) => marcados[at2] || precisaDosSoltos ? itemIdentity(item) : Promise.resolve(null)
        )
      );
      for (let at2 = 0; at2 < itens.length; at2++) {
        const item = itens[at2];
        const key = chaves[at2];
        if (!marcados[at2]) {
          if (precisaDosSoltos && key) {
            loose.add(key);
          }
          continue;
        }
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
    const runTag2 = Date.now().toString(36);
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
        file: `audio-${runTag2}-${index}.pcm`
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
    const sequence2 = project2 ? await project2.getActiveSequence() : null;
    if (!project2 || !sequence2) {
      return { ok: false, message: "Abra uma sequência na timeline." };
    }
    const editor = resolveEditor$1(ppro, sequence2);
    if (!editor) {
      return { ok: false, message: "SequenceEditor indisponível nesta versão." };
    }
    const items = await buildProjectItemMap(ppro, project2);
    return { ok: true, host: { project: project2, sequence: sequence2, editor, items } };
  }
  async function reopenHost(ppro, host2) {
    const opened = await openHost(ppro);
    if (!opened.ok) {
      return false;
    }
    host2.project = opened.host.project;
    host2.sequence = opened.host.sequence;
    host2.editor = opened.host.editor;
    host2.items = opened.host.items;
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
      const host2 = opened.host;
      const identified = await identifyClips(ppro, host2, ready);
      if (!identified.ok) {
        return { ok: false, message: identified.message, snapshot: null };
      }
      const perSecond = ticksPerSecond(ppro);
      const runs = groupIntoRuns(ready);
      const snapshot2 = {
        runs: [],
        clipCount: ready.length,
        cuts: scan.cuts,
        removedSeconds: scan.removedSeconds
      };
      let totalWrites = 0;
      let totalDropped = 0;
      let originalTicks = 0n;
      let keptTicks = 0n;
      const plannedRuns = runs.map((run2) => {
        const planned = planRun(run2, scan, perSecond);
        totalWrites += planned.writes.length;
        totalDropped += planned.dropped;
        if (planned.writes.length > 0) {
          keptTicks += planned.keptTicks;
          for (const clip of run2) {
            if (clip.plan) {
              originalTicks += BigInt(clip.outTicks) - BigInt(clip.inTicks);
            }
          }
        }
        return { run: run2, writes: planned.writes };
      });
      const writtenRuns = plannedRuns.filter((entry) => entry.writes.length > 0).length;
      let done = 0;
      const outcome = await runCutTransaction(
        plannedRuns.filter((entry) => entry.writes.length > 0).map(({ run: run2, writes }) => ({
          // 1. Tira os originais do caminho. Sem ripple: o resto da
          //    timeline não pode se mexer enquanto reescrevemos aqui.
          remove: () => removeRun(ppro, host2, run2),
          snapshot: () => {
            const runStart = BigInt(run2[0].startTicks);
            const lastWrite = writes[writes.length - 1];
            return {
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
            };
          },
          // 2. Reescreve cada trecho. O in/out entra na transação
          //    anterior ao overwrite que o consome — ver o cabeçalho.
          write: async () => {
            const written = await writeSegments(ppro, host2, writes, () => {
              done += 1;
              onProgress?.(done, totalWrites);
            });
            return written.ok ? { ok: true } : {
              ok: false,
              message: stepMessage("a escrita de um trecho", written.error)
            };
          }
        })),
        // A volta atrás é o MESMO mecanismo do Desfazer manual, que já
        // sabe apagar a região reescrita e recolocar cada original com o
        // in/out que tinha. Nada de um segundo caminho de restauração.
        async (touched) => {
          const back = await undoCuts({ ...snapshot2, runs: [...touched] });
          return back.ok ? { ok: true } : { ok: false, message: back.message };
        }
      );
      if (outcome.kind === "untouched") {
        return { ok: false, message: outcome.cause, snapshot: null };
      }
      if (outcome.kind === "restored") {
        return {
          ok: false,
          message: `${outcome.cause} A timeline foi restaurada automaticamente ao estado anterior — nenhum corte foi aplicado.`,
          snapshot: null
        };
      }
      if (outcome.kind === "critical") {
        snapshot2.runs = outcome.runs;
        return {
          ok: false,
          message: `FALHA CRÍTICA no corte: ${outcome.cause} A restauração automática também falhou (${outcome.rollbackCause}). ${describeTouched(outcome.runs, perSecond)} NÃO feche o painel: tente “Desfazer corte” agora, e se ele também falhar, use o Desfazer do Premiere (Cmd/Ctrl+Z) repetidamente até a timeline voltar.`,
          snapshot: snapshot2
        };
      }
      snapshot2.runs = outcome.runs;
      const removedSeconds = originalTicks > 0n ? Number(originalTicks - keptTicks) / Number(perSecond) : scan.removedSeconds;
      const message = `${scan.cuts} ${scan.cuts === 1 ? "corte feito" : "cortes feitos"} em ${ready.length} ${ready.length === 1 ? "clipe" : "clipes"} · ${formatClock$1(removedSeconds)} removidos.` + (totalDropped > 0 ? ` ${totalDropped} trecho(s) curto(s) demais foram absorvidos no corte.` : "") + (writtenRuns > 1 ? ` Sobrou espaço vazio entre ${writtenRuns} blocos: o corte não é ripple.` : "");
      return { ok: true, message, snapshot: snapshot2 };
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
  async function identifyClips(ppro, host2, clips) {
    for (const clip of clips) {
      const located = await locateRun(ppro, host2, [clip]);
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
        const permanent = id && host2.items.get(id) || fromTrack;
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
  async function locateRun(ppro, host2, run2) {
    const items = [];
    try {
      for (const clip of run2) {
        if (clip.trackVideo >= 0) {
          const track = await host2.sequence.getVideoTrack(clip.trackVideo);
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
          const track = await host2.sequence.getAudioTrack(clip.trackAudio);
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
  function describeTouched(runs, perSecond) {
    if (runs.length === 0) {
      return "Nenhuma região foi identificada como alterada.";
    }
    try {
      const parts = runs.map((run2) => {
        const track = run2.trackVideo >= 0 ? `V${run2.trackVideo + 1}` : run2.trackAudio >= 0 ? `A${run2.trackAudio + 1}` : "faixa desconhecida";
        const from = Number(BigInt(run2.writtenStart) / perSecond);
        const to = Number(BigInt(run2.writtenEnd) / perSecond);
        return `${track} ${formatClock$1(from)}–${formatClock$1(to)}`;
      });
      return `Pode estar alterado: ${parts.join(", ")}.`;
    } catch {
      return `${runs.length} bloco(s) podem estar alterados.`;
    }
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
      let current2 = [];
      for (const clip of list) {
        const previous = current2[current2.length - 1];
        if (previous && compareTicks(previous.endTicks, clip.startTicks) === 0) {
          current2.push(clip);
        } else {
          if (current2.length > 0) {
            runs.push(current2);
          }
          current2 = [clip];
        }
      }
      if (current2.length > 0) {
        runs.push(current2);
      }
    }
    return runs;
  }
  function planRun(run2, scan, perSecond) {
    const writes = [];
    let dropped = 0;
    let keptTicks = 0n;
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
          dropped += 1;
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
        keptTicks += to - from;
      }
    }
    return { writes, dropped, keptTicks };
  }
  async function removeRun(ppro, host2, run2) {
    for (let attempt2 = 0; attempt2 < 2; attempt2++) {
      const located = await locateRun(ppro, host2, run2);
      if (!located.ok) {
        return located;
      }
      const result = removeItems$1(ppro, host2, located.items);
      if (result.ok) {
        return { ok: true };
      }
      if (attempt2 > 0 || !await reopenHost(ppro, host2)) {
        return {
          ok: false,
          message: stepMessage("a remoção dos clipes originais", result.error)
        };
      }
    }
    return { ok: false, message: stepMessage("a remoção dos clipes originais", null) };
  }
  function removeItems$1(ppro, host2, items) {
    if (items.length === 0) {
      return { ok: true, error: null };
    }
    const scoped = removeInsideSelectionScope(ppro, host2, items);
    if (scoped.ok) {
      return scoped;
    }
    const escaped = removeOutsideSelectionScope(ppro, host2, items);
    return escaped.ok || escaped.error ? escaped : scoped;
  }
  function removeInsideSelectionScope(ppro, host2, items) {
    let outcome = { ok: false, error: null };
    let entered = false;
    try {
      ppro.TrackItemSelection.createEmptySelection((selection) => {
        entered = true;
        for (const item of items) {
          selection.addItem(item, true);
        }
        outcome = commit$1(host2.project, "Cortar silêncios — remover original", (tx) => {
          tx.addAction(
            host2.editor.createRemoveItemsAction(
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
  function removeOutsideSelectionScope(ppro, host2, items) {
    let selection = null;
    try {
      ppro.TrackItemSelection.createEmptySelection((created) => {
        selection = created;
      });
      const target2 = selection;
      if (!target2) {
        return {
          ok: false,
          error: new Error("o Premiere não entregou a seleção dos clipes.")
        };
      }
      for (const item of items) {
        target2.addItem(item, true);
      }
      return commit$1(host2.project, "Cortar silêncios — remover original", (tx) => {
        tx.addAction(
          host2.editor.createRemoveItemsAction(
            target2,
            false,
            ppro.Constants.MediaType.ANY
          )
        );
      });
    } catch (cause) {
      return { ok: false, error: cause };
    }
  }
  async function writeSegments(ppro, host2, writes, onWritten) {
    let pending = null;
    for (const write2 of writes) {
      const previous = pending;
      const result2 = await commitStable(ppro, host2, "Cortar silêncios", (live, tx) => {
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
        const target2 = resolveProjectItem(ppro, live, write2);
        tx.addAction(target2.clipItem.createClearInOutPointsAction());
        tx.addAction(
          target2.clipItem.createSetInOutPointsAction(
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
    const result = await commitStable(ppro, host2, "Cortar silêncios", (live, tx) => {
      const target2 = resolveProjectItem(ppro, live, last);
      tx.addAction(
        live.editor.createOverwriteItemAction(
          target2.projectItem,
          ppro.TickTime.createWithTicks(last.position.toString()),
          last.trackVideo,
          last.trackAudio
        )
      );
      tx.addAction(target2.clipItem.createClearInOutPointsAction());
    });
    if (result.ok) {
      onWritten();
    }
    return result;
  }
  function resolveProjectItem(ppro, host2, write2) {
    const fresh = write2.projectItemId ? host2.items.get(write2.projectItemId) : void 0;
    const projectItem = fresh ?? write2.fallbackItem;
    return { projectItem, clipItem: ppro.ClipProjectItem.cast(projectItem) };
  }
  async function undoCuts(snapshot2) {
    const ppro = getPremiere();
    if (!ppro) {
      return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: snapshot2 };
    }
    try {
      const opened = await openHost(ppro);
      if (!opened.ok) {
        return { ok: false, message: opened.message, snapshot: snapshot2 };
      }
      const host2 = opened.host;
      for (const run2 of snapshot2.runs) {
        const cleared = await clearRange(ppro, host2, run2);
        if (!cleared.ok) {
          return { ok: false, message: cleared.message, snapshot: snapshot2 };
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
        const restored = await writeSegments(ppro, host2, writes, () => {
        });
        if (!restored.ok) {
          return {
            ok: false,
            message: stepMessage("a recolocação dos clipes originais", restored.error),
            snapshot: snapshot2
          };
        }
      }
      return {
        ok: true,
        message: `${snapshot2.clipCount} ${snapshot2.clipCount === 1 ? "clipe restaurado" : "clipes restaurados"}.`,
        snapshot: null
      };
    } catch (cause) {
      return { ok: false, message: describeError$1(cause), snapshot: snapshot2 };
    }
  }
  async function clearRange(ppro, host2, run2) {
    for (let attempt2 = 0; attempt2 < 2; attempt2++) {
      const items = await itemsInRange(
        ppro,
        host2.sequence,
        run2.trackVideo,
        run2.trackAudio,
        BigInt(run2.writtenStart),
        BigInt(run2.writtenEnd)
      );
      const result = removeItems$1(ppro, host2, items);
      if (result.ok) {
        return { ok: true };
      }
      if (attempt2 > 0 || !await reopenHost(ppro, host2)) {
        return { ok: false, message: stepMessage("a limpeza do trecho", result.error) };
      }
    }
    return { ok: false, message: stepMessage("a limpeza do trecho", null) };
  }
  async function itemsInRange(ppro, sequence2, trackVideo, trackAudio, from, to) {
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
      const track = await sequence2.getVideoTrack(trackVideo);
      if (track) {
        await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      }
    }
    if (trackAudio >= 0) {
      const track = await sequence2.getAudioTrack(trackAudio);
      if (track) {
        await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
      }
    }
    return found;
  }
  function commit$1(project2, label, build) {
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
  async function commitStable(ppro, host2, label, build) {
    const first = commit$1(host2.project, label, (tx) => build(host2, tx));
    if (first.ok) {
      return first;
    }
    if (!await reopenHost(ppro, host2)) {
      return first;
    }
    const second = commit$1(host2.project, label, (tx) => build(host2, tx));
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
  function resolveEditor$1(ppro, sequence2) {
    const api = ppro.SequenceEditor;
    try {
      if (typeof api?.getEditor === "function") {
        return api.getEditor(sequence2) ?? null;
      }
      if (typeof api?.createForSequence === "function") {
        return api.createForSequence(sequence2) ?? null;
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
  let snapshot$2 = null;
  const silenceTool = {
    id: "silence",
    name: "Corte de Silêncios",
    summary: "Remove pausas e fecha o corte automaticamente",
    hint: "Selecione os clipes falados na timeline e analise. Os trechos com fala são mantidos e encostados entre si. O corte não é ripple: clipes não selecionados ficam onde estão, e entre blocos separados por eles sobra o buraco do que saiu.",
    category: "edicao",
    glyph: "cut",
    available: true,
    mount(container, context) {
      let params = defaultParams();
      let mode = "waveform";
      let ffmpegPath = "";
      let scan = null;
      let scanning = false;
      let cancelRequested = false;
      container.innerHTML = markup$7(params);
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
      context.setResetHandler(snapshot$2 ? () => void runUndo() : null);
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
                `Execute ${baseName$2(scriptPath)} na pasta aberta.`,
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
        manualEl.innerHTML = '<p class="sil-warn"><b>Execução manual necessária:</b>' + (reason ? ` <span class="sil-manual-why">${escapeHtml(reason)}</span>` : "") + ` Dê duplo clique em <b>${escapeHtml(baseName$2(scriptPath))}</b> na pasta de trabalho.</p><p class="sil-manual-path">${escapeHtml(scriptPath)}</p><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-open-folder>Abrir pasta</div></div>`;
        manualEl.querySelector("[data-open-folder]")?.addEventListener("click", () => {
          void openWorkFolder$1().catch((cause) => {
            context.setStatus(
              cause instanceof Error ? cause.message : String(cause),
              "error"
            );
          });
        });
      }
      function setScanBusy(busy2) {
        if (!scanButton) {
          return;
        }
        scanButton.classList.toggle("is-busy", busy2);
        scanButton.textContent = busy2 ? "Cancelar" : "Analisar Seleção";
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
          snapshot$2 = result.snapshot;
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
        if (!snapshot$2) {
          return;
        }
        context.setStatus("Restaurando clipes originais…");
        const result = await undoCuts(snapshot$2);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok) {
          snapshot$2 = null;
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
        html += `<div class="sil-stats"><span class="sil-stat-tag">✂️ ${scan.cuts} ${scan.cuts === 1 ? "corte" : "cortes"}</span><span class="sil-stat-saved">−${formatSeconds$1(scan.removedSeconds)}</span><span class="sil-stat-range">${formatSeconds$1(scan.totalSeconds)} → <b>${formatSeconds$1(
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
      function warnings(current2) {
        let html = "";
        if (current2.mode === "transcript") {
          const missing = current2.clips.filter((clip) => clip.status === "no-transcript");
          if (missing.length > 0) {
            html += `<p class="sil-warn">${missing.length} ${missing.length === 1 ? "clipe sem transcrição" : "clipes sem transcrição"}. Transcreva em <b>Texto › Transcrever</b> ou use o modo <b>Onda</b>.</p>`;
          }
        }
        const orphans = current2.clips.filter(
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
  function markup$7(params) {
    const presets = SILENCE_PRESETS.map(
      (preset) => `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}" title="${escapeHtml(preset.note)}">${preset.name}</div>`
    ).join("");
    const sliderFor = (spec) => `<div class="field" data-field="${spec.key}" hidden><div class="field-head"><span class="t-label" title="${escapeHtml(spec.note)}">${spec.label}</span><span class="field-val" data-out="${spec.key}">${formatParam(
      spec,
      params[spec.key]
    )}</span></div><div class="slider-row"><div data-slider="${spec.key}"></div></div></div>`;
    const coreSliders = ["minSilence", "padIn", "padOut"].map((k) => SLIDERS.find((s) => s.key === k)).filter((s) => Boolean(s)).map(sliderFor).join("");
    const advSliders = ["minKeep", "noiseIsland", "dbMargin", "dbThreshold", "minConfidence"].map((k) => SLIDERS.find((s) => s.key === k)).filter((s) => Boolean(s)).map(sliderFor).join("");
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">Ritmo de Corte</span><div class="preset-rail preset-rail--2x2" data-preset-rail>${presets}</div></div></div><div class="zone">${coreSliders}</div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para analisar</p><p class="sil-empty-desc">Selecione os clipes na timeline e analise para visualizar o corte.</p></div><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div><div class="sil-manual" data-manual hidden></div><div class="sil-report" data-report></div></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">Ajustes avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><span class="t-label">Método de Detecção</span><div class="seg" data-mode-seg><div class="seg-item" ${CONTROL} data-mode="waveform">Onda (ffmpeg)</div><div class="seg-item" ${CONTROL} data-mode="transcript">Transcrição</div></div></div><div class="field" data-filler-field hidden><span class="t-label">Muletas de Fala</span><div class="seg" data-filler-seg><div class="seg-item" ${CONTROL} data-filler="off">Manter</div><div class="seg-item" ${CONTROL} data-filler="on">Remover</div></div></div><div class="field" data-auto-field hidden><span class="t-label">Calibração de Ruído</span><div class="seg" data-auto-seg><div class="seg-item" ${CONTROL} data-auto="on">Automático</div><div class="seg-item" ${CONTROL} data-auto="off">Fixo</div></div></div>` + advSliders + `<div class="sil-ffmpeg-group" data-ffmpeg-field hidden><div class="field"><span class="t-label">Caminho do FFmpeg</span><input type="text" class="sil-path" data-ffmpeg-path spellcheck="false" placeholder="Padrão do sistema (automático)"></div><div class="field"><div class="field-head"><span class="t-label">Diagnóstico</span><span class="field-action" ${CONTROL} data-diag>Testar FFmpeg</span></div><div class="sil-diag" data-diag-out></div></div></div></div></div></div>`;
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
      for (const keep2 of plan.keep) {
        if (keep2.start > cursor) {
          cells += cell("sil-cut", (keep2.start - cursor) / span);
        }
        cells += cell("sil-keep", (keep2.end - keep2.start) / span);
        cursor = keep2.end;
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
    const detail = clip.status === "ready" && clip.plan ? `<span class="sil-row-cuts">${clip.plan.drop.length} ${clip.plan.drop.length === 1 ? "corte" : "cortes"}</span><span class="sil-row-time">${formatSeconds$1(clip.durationSeconds)} → ${formatSeconds$1(
      clip.plan.keptSeconds
    )}</span>` : `<span class="sil-row-skip">${escapeHtml(
      clip.status === "error" && clip.detail ? clip.detail : label
    )}</span>`;
    return `<div class="sil-row-group${clip.status === "ready" ? " is-ready" : ""}"><div class="sil-row"><span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
      clip.name
    )}</span>` + detail + "</div></div>";
  }
  function baseName$2(path) {
    return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
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
  const TOKEN_RE = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|[^\s\-_–—]+/g;
  function tokenizeName(name) {
    const tokens = [];
    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(name)) !== null) {
      tokens.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
    }
    return tokens;
  }
  const VARIANT_RE = /^(?:\d{1,4}|[A-Za-z]|[A-Za-z]{1,3}\d{1,3}|\d{1,3}[A-Za-z]{1,2})$/;
  function isVariantToken(text2) {
    const bare = text2.replace(/^[[({]/, "").replace(/[\])}]$/, "").trim();
    return bare.length > 0 && VARIANT_RE.test(bare);
  }
  const MIN_KEY_CHARS = 3;
  function labelWithout(name, token) {
    return (name.slice(0, token.start) + name.slice(token.end)).replace(/([-_–—])\s*\1/g, "$1").replace(/\s{2,}/g, " ").replace(/^\s*[-_–—]\s*/, "").replace(/\s*[-_–—]\s*$/, "").trim();
  }
  function groupByVariantToken(names) {
    const candidates2 = /* @__PURE__ */ new Map();
    names.forEach((name, index) => {
      const tokens = tokenizeName(name);
      if (tokens.length < 2) {
        return;
      }
      tokens.forEach((token, position) => {
        if (!isVariantToken(token.text)) {
          return;
        }
        const rest = tokens.filter((_, other) => other !== position);
        const keyChars = rest.reduce((total, part) => total + part.text.length, 0);
        if (keyChars < MIN_KEY_CHARS) {
          return;
        }
        const key = rest.map((part) => part.text.toLowerCase()).join("\0");
        const existing = candidates2.get(key);
        if (existing) {
          if (!existing.labels.has(index)) {
            existing.members.push(index);
            existing.labels.set(index, labelWithout(name, token));
          }
          return;
        }
        candidates2.set(key, {
          labels: /* @__PURE__ */ new Map([[index, labelWithout(name, token)]]),
          members: [index],
          weight: keyChars
        });
      });
    });
    const ordered2 = [...candidates2.values()].filter((candidate) => candidate.members.length >= 2).sort((a, b) => b.weight - a.weight || b.members.length - a.members.length);
    const taken = /* @__PURE__ */ new Set();
    const groups = [];
    for (const candidate of ordered2) {
      const free = candidate.members.filter((index) => !taken.has(index));
      if (free.length < 2) {
        continue;
      }
      for (const index of free) {
        taken.add(index);
      }
      groups.push({
        label: candidate.labels.get(free[0]) ?? "",
        members: free
      });
    }
    return groups.filter((group2) => group2.label !== "");
  }
  function normalizeChannels(value) {
    const text2 = value.toLowerCase();
    if (/(^|[^a-z])mono([^a-z]|$)|monaural|1\s*(ch|canal)/.test(text2)) {
      return "mono";
    }
    if (/(^|[^a-z])(stereo|st[eé]reo|est[eé]reo)([^a-z]|$)|2\s*(ch|canais)/.test(text2)) {
      return "stereo";
    }
    if (/5\.1|7\.1|multi|surround/.test(text2)) {
      return "multi";
    }
    return null;
  }
  const XMP_PATTERNS = [
    /<[\w:.-]*audioChannelType[^>]*>([^<]{1,40})</i,
    /[\w:.-]*audioChannelType\s*=\s*["']([^"']{1,40})["']/i,
    /"[\w:.-]*audioChannelType"\s*:\s*"([^"]{1,40})"/i
  ];
  const COLUMN_PATTERNS = [
    /<[^>]*audio\.?info[^>]*>([^<]{1,120})</i,
    /"[^"]*audio\.?info[^"]*"\s*:\s*"([^"]{1,120})"/i
  ];
  function firstMatch(raw, patterns) {
    for (const pattern of patterns) {
      const found = pattern.exec(raw);
      if (found?.[1]) {
        const verdict = normalizeChannels(found[1]);
        if (verdict) {
          return verdict;
        }
      }
    }
    return null;
  }
  function parseChannelsFromXmp(raw) {
    return raw ? firstMatch(raw, XMP_PATTERNS) : null;
  }
  function parseChannelsFromColumns(raw) {
    return raw ? firstMatch(raw, COLUMN_PATTERNS) : null;
  }
  function probe(name, source, raw) {
    {
      return;
    }
  }
  async function readAudioChannels(ppro, item, name) {
    const metadata = ppro.Metadata;
    if (!metadata) {
      return null;
    }
    try {
      const raw = await metadata.getXMPMetadata(item) ?? "";
      probe(name, "xmp", raw);
      const verdict = parseChannelsFromXmp(raw);
      if (verdict) {
        return verdict;
      }
    } catch {
    }
    try {
      const raw = await metadata.getProjectColumnsMetadata(item) ?? "";
      probe(name, "colunas", raw);
      return parseChannelsFromColumns(raw);
    } catch {
      return null;
    }
  }
  function commitTransaction$1(project2, label, build) {
    let committed = false;
    let error = null;
    try {
      project2.lockedAccess(() => {
        try {
          committed = project2.executeTransaction(build, label);
        } catch (cause) {
          error = cause;
        }
      });
    } catch (cause) {
      error = error ?? cause;
    }
    if (error) {
      console.error(`[Organize] transação "${label}" falhou:`, error);
    }
    return committed;
  }
  function undoableSnapshot(snapshot2) {
    return snapshot2.moves.length > 0 || snapshot2.createdBinIds.length > 0 ? snapshot2 : null;
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
  function extensionOf$1(path) {
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
  const VOICE_HINTS = /(^|[^a-z])(loc[uú][cç][aã]o|locucao|narra[cç][aã]o|narracao|narration|narrador|voice[ _-]?over|voiceover|vocal|dublagem|dubbing|avatar|talking[ _-]?head)([^a-z]|$)/i;
  const VOICE_TOKENS = /* @__PURE__ */ new Set(["vo", "vox", "nar", "loc"]);
  function hasVoiceToken(text2) {
    return text2.toLowerCase().split(/[^a-z0-9À-ſ]+/).some((token) => VOICE_TOKENS.has(token));
  }
  const MUSIC_MIN_SECONDS = 45;
  const SFX_MAX_SECONDS = 8;
  function folderPartOf(mediaPath) {
    const cut = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
    return cut > 0 ? mediaPath.slice(0, cut) : "";
  }
  function baseNameOf(mediaPath) {
    const cut = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
    return cut >= 0 ? mediaPath.slice(cut + 1) : mediaPath;
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
  function stemOf$1(name) {
    const cut = name.lastIndexOf(".");
    const stem = cut > 0 ? name.slice(0, cut) : name;
    return stem.trim().toLowerCase();
  }
  async function audioKindOf(ctx) {
    const { ppro, item, clip, name, mediaPath, sequenceNames } = ctx;
    const folder = folderPartOf(mediaPath);
    const seconds2 = await audioSeconds(ppro, clip);
    const namesAPiece = sequenceNames.has(stemOf$1(name)) || mediaPath !== "" && sequenceNames.has(stemOf$1(baseNameOf(mediaPath)));
    let channels = null;
    const decided = await (async () => {
      if (SFX_HINTS.test(folder)) return "sfx";
      if (MUSIC_HINTS.test(folder)) return "music";
      if (VOICE_HINTS.test(folder)) return "voice";
      if (SFX_HINTS.test(name)) return "sfx";
      if (MUSIC_HINTS.test(name)) return "music";
      if (VOICE_HINTS.test(name) || hasVoiceToken(name)) return "voice";
      if (namesAPiece) return "voice";
      channels = await readAudioChannels(ppro, item, name);
      if (channels === "mono") {
        if (seconds2 === null) return null;
        return seconds2 <= SFX_MAX_SECONDS ? "sfx" : "voice";
      }
      if (seconds2 !== null) {
        if (seconds2 >= MUSIC_MIN_SECONDS) return "music";
        if (seconds2 <= SFX_MAX_SECONDS) return "sfx";
        return null;
      }
      const ext = extensionOf$1(mediaPath || name);
      return MUSIC_LEANING_EXTS.has(ext) ? "music" : null;
    })();
    return decided;
  }
  const AUDIO_KIND_LABELS = {
    voice: "Locucao",
    music: "Musicas",
    sfx: "SFX"
  };
  const AUDIO_KIND_ALIASES = {
    voice: [
      "locucao",
      "narracao",
      "narrador",
      "narration",
      "voz",
      "vozes",
      "vo",
      "voice",
      "voices",
      "voiceover",
      "voice over",
      "avatar",
      "avatares",
      "dublagem",
      "fala",
      "falas"
    ],
    music: [
      "musicas",
      "musica",
      "trilha",
      "trilhas",
      "trilha sonora",
      "music",
      "musics",
      "soundtrack",
      "bgm",
      "score"
    ],
    sfx: [
      "sfx",
      "fx",
      "efeito",
      "efeitos",
      "efeitos sonoros",
      "sound effects",
      "sounds",
      "foley"
    ]
  };
  function normalizeBinName(name) {
    return name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  }
  const AUDIO_KIND_ORDER = ["voice", "music", "sfx"];
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
  const SCAN_CANCELLED = "Varredura cancelada.";
  function isScanCancelled(cause) {
    return cause instanceof Error && cause.message === SCAN_CANCELLED;
  }
  function stopIfCancelled(options) {
    if (options.cancelled?.()) {
      throw new Error(SCAN_CANCELLED);
    }
  }
  async function scanProject(options = {}) {
    const ppro = getPremiere();
    if (!ppro) {
      throw new Error("Premiere UXP runtime indisponível.");
    }
    const project2 = await ppro.Project.getActiveProject();
    if (!project2) {
      throw new Error("Nenhum projeto aberto.");
    }
    options.onStage?.("Lendo a raiz do projeto…");
    const rootFolder = await project2.getRootItem();
    const rootLooseItems = await collectRootLooseItems(ppro, rootFolder);
    stopIfCancelled(options);
    options.onStage?.("Lendo as sequências do projeto…");
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
    const sequenceNamesLower = new Set(
      [...projectSequenceNames].map((seqName) => seqName.trim().toLowerCase())
    );
    stopIfCancelled(options);
    const nestedDetection = await detectNestedSequences(
      ppro,
      projectSequences,
      projectSequenceNames,
      options
    );
    const classified = [];
    let scanned = 0;
    options.onStage?.("Classificando os itens soltos…");
    for (const { item, parentId } of rootLooseItems) {
      stopIfCancelled(options);
      scanned += 1;
      options.onProgress?.(scanned, rootLooseItems.length);
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
      const ext = extensionOf$1(mediaPath || name);
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
        audioKind = await audioKindOf({
          ppro,
          item,
          clip,
          name,
          mediaPath: mediaPathForKind,
          sequenceNames: sequenceNamesLower
        });
      }
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
    const audioKindCounts = { voice: 0, sfx: 0, music: 0 };
    for (const c of classified) {
      counts[c.category]++;
      if (c.audioKind) {
        audioKindCounts[c.audioKind]++;
      }
    }
    const totalSequences = counts.sequence + counts["sequence-nested"];
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
    const leftovers = [];
    for (const [base, members] of seqMap) {
      if (members.length >= 2 && !isNestedSequenceName(base)) {
        sequenceGroups.push({ base, items: members });
      } else {
        leftovers.push(...members);
      }
    }
    const variantGroups = groupByVariantToken(leftovers.map((item) => item.name));
    const grouped = /* @__PURE__ */ new Set();
    const groupByBase = /* @__PURE__ */ new Map();
    for (const group2 of sequenceGroups) {
      groupByBase.set(group2.base.toLowerCase(), group2);
    }
    for (const variant of variantGroups) {
      const members = variant.members.map((index) => leftovers[index]);
      const existing = groupByBase.get(variant.label.toLowerCase());
      if (existing) {
        existing.items.push(...members);
      } else {
        const group2 = { base: variant.label, items: members };
        sequenceGroups.push(group2);
        groupByBase.set(group2.base.toLowerCase(), group2);
      }
      for (const index of variant.members) {
        grouped.add(index);
      }
    }
    const groupOfSequence = /* @__PURE__ */ new Map();
    for (const group2 of sequenceGroups) {
      for (const member of group2.items) {
        groupOfSequence.set(member.name.trim().toLowerCase(), group2);
      }
    }
    const homeForNested = (item) => {
      const parents = /* @__PURE__ */ new Set([
        ...nestedDetection.parentsById.get(item.id) ?? [],
        ...nestedDetection.parentsByName.get(item.name.trim().toLowerCase()) ?? []
      ]);
      let home = null;
      for (const parent of parents) {
        const group2 = groupOfSequence.get(parent.trim().toLowerCase());
        if (!group2) continue;
        if (home && home !== group2) return null;
        home = group2;
      }
      return home;
    };
    for (const [index, member] of leftovers.entries()) {
      if (grouped.has(index)) continue;
      if (member.category === "sequence-nested") {
        const home = homeForNested(member);
        if (home) {
          home.items.push(member);
          continue;
        }
        standaloneNested.push(member);
      } else {
        standalonePrincipal.push(member);
      }
    }
    for (const group2 of sequenceGroups) {
      for (const member of group2.items) {
        member.sequenceBase = group2.base;
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
  async function detectNestedSequences(ppro, sequences, projectSequenceNames, options) {
    const ids = /* @__PURE__ */ new Set();
    const names = /* @__PURE__ */ new Set();
    const guids = /* @__PURE__ */ new Set();
    const parentsById = /* @__PURE__ */ new Map();
    const parentsByName = /* @__PURE__ */ new Map();
    const noteParent = (map, key, parentName) => {
      if (!key || !parentName) return;
      const known2 = map.get(key);
      if (known2) {
        known2.add(parentName);
      } else {
        map.set(key, /* @__PURE__ */ new Set([parentName]));
      }
    };
    const verdicts = /* @__PURE__ */ new Map();
    const scanTrack = async (track, parentName) => {
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
              noteParent(parentsById, id, parentName);
              if (piName) {
                names.add(piName.toLowerCase());
                noteParent(parentsByName, piName.toLowerCase(), parentName);
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
    let walked = 0;
    options.onStage?.("Procurando sequências aninhadas…");
    for (const seq of sequences) {
      stopIfCancelled(options);
      walked += 1;
      options.onProgress?.(walked, sequences.length);
      let parentName = "";
      try {
        parentName = (seq.name ?? "").trim();
      } catch {
        parentName = "";
      }
      try {
        const videoTrackCount = await seq.getVideoTrackCount();
        for (let t = 0; t < videoTrackCount; t++) {
          await scanTrack(await seq.getVideoTrack(t), parentName);
        }
        const audioTrackCount = await seq.getAudioTrackCount();
        for (let t = 0; t < audioTrackCount; t++) {
          await scanTrack(await seq.getAudioTrack(t), parentName);
        }
      } catch {
      }
    }
    return { ids, names, guids, parentsById, parentsByName };
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
    const snapshot2 = { moves: [], createdBinIds: [] };
    let phase = "iniciar";
    try {
      phase = "ler a raiz do projeto";
      let root2 = await project2.getRootItem();
      const existingTopNames = /* @__PURE__ */ new Set();
      for (const child of await root2.getItems()) {
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
              tx.addAction(root2.createBinAction(label, true));
              plannedTop += 1;
            }
          }
        }
      );
      if (plannedTop > 0 && !topCreated) {
        return {
          ok: false,
          message: "O Premiere recusou a criação das pastas principais. Nada foi alterado.",
          snapshot: undoableSnapshot(snapshot2)
        };
      }
      phase = "reler as pastas principais";
      root2 = await project2.getRootItem();
      const afterTop = await readBinLayout(ppro, root2);
      for (const [cat, folder] of afterTop.top) {
        if (!existingTopNames.has(TOP_CATEGORY_LABELS[cat])) {
          const id = afterTop.ids.get(folder);
          if (id) snapshot2.createdBinIds.push(id);
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
            for (const group2 of scan.sequenceGroups) {
              if (!hadSeqGroups.has(normalizeBinName(group2.base))) {
                tx.addAction(seqBin.createBinAction(group2.base, true));
                plannedSub += 1;
              }
            }
          }
          if (audioBin) {
            for (const kind of AUDIO_KIND_ORDER) {
              if (scan.audioKindCounts[kind] > 0 && !hadAudioKinds.has(kind)) {
                tx.addAction(audioBin.createBinAction(AUDIO_KIND_LABELS[kind], true));
                plannedSub += 1;
              }
            }
          }
        }
      );
      phase = "reler a estrutura de pastas";
      root2 = await project2.getRootItem();
      const layout = await readBinLayout(ppro, root2);
      if (layout.seqPrincipal && !hadPrincipal) {
        const id = layout.ids.get(layout.seqPrincipal);
        if (id) snapshot2.createdBinIds.push(id);
      }
      if (layout.seqNested && !hadNested) {
        const id = layout.ids.get(layout.seqNested);
        if (id) snapshot2.createdBinIds.push(id);
      }
      for (const [name, folder] of layout.seqGroups) {
        if (!hadSeqGroups.has(name)) {
          const id = layout.ids.get(folder);
          if (id) snapshot2.createdBinIds.push(id);
        }
      }
      for (const kind of AUDIO_KIND_ORDER) {
        const folder = layout.audioKind.get(kind);
        if (folder && !hadAudioKinds.has(kind)) {
          const id = layout.ids.get(folder);
          if (id) snapshot2.createdBinIds.push(id);
        }
      }
      if (plannedSub > 0 && !subCreated) {
        return {
          ok: false,
          message: "O Premiere recusou a criação das subpastas. Nenhum item foi movido; use Desfazer para remover as pastas que já haviam sido criadas.",
          snapshot: undoableSnapshot(snapshot2)
        };
      }
      phase = "indexar os itens";
      const freshItems = /* @__PURE__ */ new Map();
      await indexAllItems(ppro, root2, freshItems);
      phase = "mover os itens";
      let movedCount = 0;
      let missingTargets = 0;
      const moveRoot = root2;
      const moved = commitTransaction$1(project2, "Organizar Projeto — Mover Itens", (tx) => {
        for (const classified of scan.items) {
          const { category, audioKind, sequenceBase, parentId } = classified;
          let targetBin;
          const seqTop = layout.top.get("sequence");
          if (category === "sequence" || category === "sequence-nested") {
            const groupKey = sequenceBase ? normalizeBinName(sequenceBase) : "";
            if (groupKey && layout.seqGroups.has(groupKey)) {
              targetBin = layout.seqGroups.get(groupKey);
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
          snapshot2.moves.push({
            itemId: classified.id,
            originalParentId: parentId
          });
          tx.addAction(moveRoot.createMoveItemAction(freshItem, targetBin));
          movedCount++;
        }
      });
      if (movedCount > 0 && !moved) {
        snapshot2.moves.length = 0;
        return {
          ok: false,
          message: "O Premiere recusou a movimentação. Nenhum item foi movido; use Desfazer para remover as pastas que já haviam sido criadas.",
          snapshot: undoableSnapshot(snapshot2)
        };
      }
      if (movedCount === 0 && missingTargets > 0) {
        return {
          ok: false,
          message: `${missingTargets} ${missingTargets === 1 ? "item ficou" : "itens ficaram"} sem pasta de destino. Confira se as pastas do plugin existem na raiz do projeto.`,
          snapshot: undoableSnapshot(snapshot2)
        };
      }
      return {
        ok: true,
        message: movedCount > 0 ? `${movedCount} ${movedCount === 1 ? "item organizado" : "itens organizados"} com sucesso.` + (missingTargets > 0 ? ` ${missingTargets} sem pasta de destino.` : "") : "Nada a mover — tudo já está no lugar.",
        snapshot: snapshot2
      };
    } catch (cause) {
      console.error(`[Organize] falhou ao ${phase}:`, cause);
      const partial = undoableSnapshot(snapshot2);
      return {
        ok: false,
        message: `Falha ao ${phase}: ${describeError$1(cause)}` + (partial ? " Use Desfazer para reverter o que já foi feito." : ""),
        snapshot: partial
      };
    }
  }
  async function undoOrganize(snapshot2) {
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
      const parentBefore = /* @__PURE__ */ new Map();
      await indexItemParents(ppro, rootFolder, "__root__", parentBefore);
      let plannedMoves = 0;
      const restored = commitTransaction$1(
        project2,
        "Desfazer Organização — Restaurar Itens",
        (tx) => {
          for (const move of snapshot2.moves) {
            if (parentBefore.get(move.itemId) === move.originalParentId) {
              continue;
            }
            const item = allItemsById.get(move.itemId);
            const originalParent = allBins.get(move.originalParentId);
            if (!item || !originalParent) {
              continue;
            }
            const moveAction = rootFolder.createMoveItemAction(item, originalParent);
            tx.addAction(moveAction);
            plannedMoves++;
          }
        }
      );
      if (plannedMoves > 0 && !restored) {
        return {
          ok: false,
          message: "O Premiere recusou a restauração dos itens. Nada foi movido de volta.",
          snapshot: snapshot2
        };
      }
      const rootAfterRestore = await project2.getRootItem();
      const updatedBins = /* @__PURE__ */ new Map();
      await indexBins(ppro, rootAfterRestore, updatedBins);
      const parentAfter = /* @__PURE__ */ new Map();
      await indexItemParents(ppro, rootAfterRestore, "__root__", parentAfter);
      let restoredCount = 0;
      let missingCount = 0;
      let stuckCount = 0;
      for (const move of snapshot2.moves) {
        const parent = parentAfter.get(move.itemId);
        if (parent === void 0) {
          missingCount++;
        } else if (parent === move.originalParentId) {
          restoredCount++;
        } else {
          stuckCount++;
        }
      }
      const candidates2 = [];
      for (const id of snapshot2.createdBinIds) {
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
      if (stuckCount > 0) {
        notes.push(
          `${stuckCount} ${stuckCount === 1 ? "item continuou" : "itens continuaram"} na pasta nova.`
        );
      }
      if (missingCount > 0) {
        notes.push(
          `${missingCount} ${missingCount === 1 ? "item não foi encontrado" : "itens não foram encontrados"} no projeto.`
        );
      }
      if (!binsRemoved) {
        notes.push("O Premiere recusou a remoção das pastas vazias.");
      }
      const undone = binsRemoved && stuckCount === 0 && missingCount === 0;
      return {
        ok: undone,
        message: [
          `${restoredCount} ${restoredCount === 1 ? "item restaurado" : "itens restaurados"}.`,
          ...notes
        ].join(" "),
        snapshot: undone ? null : snapshot2
      };
    } catch (cause) {
      return {
        ok: false,
        message: `Falha ao desfazer: ${describeError$1(cause)}`,
        snapshot: snapshot2
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
          const normalized = normalizeBinName(sub.name);
          for (const kind of AUDIO_KIND_ORDER) {
            if (normalized === normalizeBinName(AUDIO_KIND_LABELS[kind])) {
              layout.audioKind.set(kind, subFolder);
            } else if (!layout.audioKind.has(kind) && AUDIO_KIND_ALIASES[kind].includes(normalized)) {
              layout.audioKind.set(kind, subFolder);
            }
          }
        } else if (sub.name === "Principal") {
          layout.seqPrincipal = subFolder;
        } else if (sub.name === "Nested") {
          layout.seqNested = subFolder;
        } else {
          layout.seqGroups.set(normalizeBinName(sub.name), subFolder);
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
  async function indexItemParents(ppro, folder, parentId, map) {
    const children = await folder.getItems();
    for (const child of children) {
      const id = safeId(child);
      if (id) {
        map.set(id, parentId);
      }
      if (child.type === ppro.ProjectItem.TYPE_BIN) {
        try {
          const sub = ppro.FolderItem.cast(child);
          await indexItemParents(ppro, sub, id, map);
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
  let lastSnapshot = null;
  const organizeTool = {
    id: "organize",
    name: "Organizar Pastas",
    summary: "Organização automática do projeto por tipo",
    hint: "Organiza apenas os arquivos e sequências soltos na raiz do projeto. Suas pastas pessoais e pastas criadas por plugins (Animation Composer, etc.) são 100% preservadas e intocadas. Se você já tem uma pasta de áudio com o seu nome (Avatar, Locução, Trilha…), ela é usada como está.",
    category: "projeto",
    glyph: "folder",
    available: true,
    usesSelection: false,
    mount(container, context) {
      let scan = null;
      let scanning = false;
      let cancelRequested = false;
      let stage = "Escaneando itens soltos…";
      container.innerHTML = emptyMarkup();
      const scanBtn = container.querySelector("[data-scan]");
      const treeEl = container.querySelector("[data-tree]");
      const statsEl = container.querySelector("[data-stats]");
      const emptyEl = container.querySelector("[data-empty]");
      context.setApplyLabel("ORGANIZAR PROJETO");
      context.setApplyEnabled(false);
      context.setResetLabel("DESFAZER");
      context.setResetHandler(lastSnapshot ? () => void runUndo() : null);
      async function runScan() {
        if (scanning) {
          cancelRequested = true;
          context.setStatus("Cancelando…");
          return;
        }
        scanning = true;
        cancelRequested = false;
        stage = "Escaneando itens soltos…";
        context.setStatus(stage);
        context.setApplyEnabled(false);
        setScanBusy(true);
        try {
          scan = await scanProject({
            onStage: (text2) => {
              stage = text2;
              context.setStatus(text2);
            },
            onProgress: (done, total) => context.setStatus(`${stage} ${done}/${total}`),
            cancelled: () => cancelRequested
          });
          renderTree();
          renderStats();
          context.setApplyEnabled(scan.items.length > 0);
          context.setStatus(
            `${scan.items.length} ${scan.items.length === 1 ? "item solto encontrado" : "itens soltos encontrados"}.`,
            "done"
          );
        } catch (cause) {
          if (isScanCancelled(cause)) {
            context.setStatus("Varredura cancelada.", "idle");
          } else {
            const msg = cause instanceof Error ? cause.message : String(cause);
            context.setStatus(msg, "error");
          }
          context.setApplyEnabled(scan !== null && scan.items.length > 0);
        } finally {
          scanning = false;
          cancelRequested = false;
          setScanBusy(false);
        }
      }
      function setScanBusy(busy2) {
        if (!scanBtn) return;
        scanBtn.classList.toggle("is-busy", busy2);
        scanBtn.textContent = busy2 ? "Cancelar" : "Escanear Projeto";
      }
      scanBtn?.addEventListener("click", () => void runScan());
      context.setApplyHandler(async () => {
        if (!scan) return;
        context.setStatus("Organizando…");
        context.setApplyEnabled(false);
        const result = await organizeProject(scan);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.snapshot) {
          lastSnapshot = result.snapshot;
          context.setResetHandler(() => void runUndo());
        }
        if (result.ok && result.snapshot) {
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
            for (const group2 of scan.sequenceGroups) {
              html += `<div class="org-group">`;
              html += `<span class="org-group-name">${escapeHtml(group2.base)}</span>`;
              html += `<span class="org-group-count">${group2.items.length}</span>`;
              html += `</div>`;
              html += renderItemList(group2.items, true);
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
            const anyAudioKind = AUDIO_KIND_ORDER.some(
              (kind) => scan.audioKindCounts[kind] > 0
            );
            if (cat === "audio" && anyAudioKind) {
              for (const kind of AUDIO_KIND_ORDER) {
                const group2 = items.filter((i) => i.audioKind === kind);
                if (group2.length === 0) continue;
                html += `<div class="org-group">`;
                html += `<span class="org-group-name">${escapeHtml(AUDIO_KIND_LABELS[kind])}</span>`;
                html += `<span class="org-group-count">${group2.length}</span>`;
                html += `</div>`;
                html += renderItemList(group2, true);
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
  function fold$2(value) {
    return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function filterOptions(options, query) {
    const needle = fold$2(query.trim());
    if (!needle) {
      return [...options];
    }
    const starts = [];
    const contains = [];
    for (const option of options) {
      const label = fold$2(option.label);
      if (label.startsWith(needle)) {
        starts.push(option);
      } else if (label.includes(needle) || fold$2(option.meta ?? "").includes(needle)) {
        contains.push(option);
      }
    }
    return [...starts, ...contains];
  }
  function mountDropdown(host2, source) {
    const search = source.search;
    host2.className = "dl-pick-wrap";
    host2.innerHTML = `<div class="dl-pick" ${CONTROL} data-pick-button aria-expanded="false"><span class="dl-pick-value" data-pick-value></span><span class="dl-pick-meta" data-pick-meta></span><span class="dl-pick-caret" aria-hidden="true">▾</span></div><div class="dl-menu" data-pick-menu hidden>` + (search ? `<input type="text" class="dl-menu-search" data-pick-search spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="${escapeHtml(search.placeholder)}">` : "") + // A lista é um nó SEPARADO do campo: `render()` reescreve só ela,
    // e o que já foi digitado sobrevive a cada filtragem.
    "<div data-pick-list></div></div>";
    const button = host2.querySelector("[data-pick-button]");
    const valueEl = host2.querySelector("[data-pick-value]");
    const metaEl = host2.querySelector("[data-pick-meta]");
    const menu = host2.querySelector("[data-pick-menu]");
    const list = host2.querySelector("[data-pick-list]");
    const searchEl = host2.querySelector("[data-pick-search]");
    function query() {
      return searchEl?.value ?? "";
    }
    function setOpen(open) {
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) {
        if (searchEl) {
          searchEl.value = "";
        }
        render();
        try {
          searchEl?.focus();
        } catch {
        }
      }
    }
    function render() {
      const options = source.options();
      const selected = source.selected();
      const current2 = options.find((option) => option.id === selected);
      valueEl.textContent = current2?.label ?? (selected ? selected : "—");
      metaEl.textContent = current2?.meta ?? "";
      const visible = filterOptions(options, query());
      const typed = query().trim();
      const rows = visible.map(
        (option) => `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml(option.id)}" aria-pressed="${option.id === selected}"><span class="dl-menu-name">${escapeHtml(option.label)}</span><span class="dl-menu-meta">${escapeHtml(option.meta ?? "")}</span></div>`
      ).join("");
      const extra = search?.useTyped && typed && !visible.some((option) => option.id === typed) ? `<div class="dl-menu-item is-typed" ${CONTROL} data-raw="${escapeHtml(typed)}"><span class="dl-menu-name">${escapeHtml(search.useTyped(typed))}</span></div>` : "";
      list.innerHTML = rows || extra ? rows + extra : '<div class="dl-menu-empty">nada com esse nome</div>';
    }
    button.addEventListener("click", () => setOpen(menu.hidden));
    menu.addEventListener("click", (event) => {
      const item = event.target?.closest(
        "[data-value],[data-raw]"
      );
      if (!item) return;
      const id = item.dataset.value ?? item.dataset.raw;
      if (id === void 0) return;
      setOpen(false);
      source.onPick(id);
    });
    searchEl?.addEventListener("input", render);
    searchEl?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = list.querySelector("[data-value],[data-raw]");
        const id = first?.dataset.value ?? first?.dataset.raw;
        if (id !== void 0) {
          setOpen(false);
          source.onPick(id);
        }
        event.preventDefault();
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    });
    render();
    return {
      render,
      closeUnless(target2) {
        if (!menu.hidden && !host2.contains(target2)) {
          setOpen(false);
        }
      }
    };
  }
  const premiereMediaUnix = String.raw`#!/bin/bash
set -eu
SOURCE="$1"
FFMPEG="\${FRAMELAB_FFMPEG:-}"
if [ -z "$FFMPEG" ]; then echo 'ERROR: falta o ffmpeg para preparar o video para o Premiere.' >&2; exit 1; fi
INFO="$("$FFMPEG" -hide_banner -i "$SOURCE" 2>&1 || true)"
VIDEO="$(printf '%s\n' "$INFO" | sed -n 's/.*Stream.*Video: \([^ ,]*\).*/\1/p' | head -n 1)"
AUDIO="$(printf '%s\n' "$INFO" | sed -n 's/.*Stream.*Audio: \([^ ,]*\).*/\1/p' | head -n 1)"
if [ -z "$VIDEO" ]; then echo 'ERROR: nao foi possivel validar o video baixado.' >&2; exit 1; fi
VARGS=(-c:v copy)
if [ "$VIDEO" != h264 ] || ! printf '%s\n' "$INFO" | grep -Eq 'Video:.* yuv420p[,( ]'; then
  VARGS=(-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p)
fi
AARGS=(-c:a copy)
if [ -n "$AUDIO" ] && [ "$AUDIO" != aac ]; then AARGS=(-c:a aac -b:a 192k); fi
if [ "\${VARGS[1]}" != copy ] || [ "\${AARGS[1]}" != copy ]; then
  echo '[Framelab] Preparando video compativel com o Premiere (H.264/AAC)...'
  STAGE="$(mktemp -d "\${SOURCE}.framelab.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  "$FFMPEG" -nostdin -hide_banner -y -i "$SOURCE" -map 0:v:0 -map '0:a:0?' \
    "\${VARGS[@]}" "\${AARGS[@]}" -movflags +faststart -f mp4 "$STAGE/ready.mp4"
  mv -f "$STAGE/ready.mp4" "$SOURCE"
fi
JSON="$SOURCE"
JSON="\${JSON//\\/\\\\}"
JSON="\${JSON//\"/\\\"}"
JSON="\${JSON//$'\n'/\\n}"
JSON="\${JSON//$'\r'/\\r}"
JSON="\${JSON//$'\t'/\\t}"
JSON="\${JSON//$'\b'/\\b}"
JSON="\${JSON//$'\f'/\\f}"
printf 'FRAMELAB_FILE:"%s"\n' "$JSON"
`.replace(/\\\$/g, "$");
  const premiereMediaWin = String.raw`param([string]$Source)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$Stage = $null
try {
  $ffmpeg = $env:FRAMELAB_FFMPEG
  if (!$ffmpeg) { throw 'Falta o ffmpeg para preparar o video para o Premiere.' }
  $ErrorActionPreference = 'Continue'
  $info = (& $ffmpeg -hide_banner -i $Source 2>&1 | Out-String)
  $ErrorActionPreference = 'Stop'
  $video = [regex]::Match($info, 'Stream[^\r\n]*Video: ([^ ,]+)').Groups[1].Value
  $audio = [regex]::Match($info, 'Stream[^\r\n]*Audio: ([^ ,]+)').Groups[1].Value
  if (!$video) { throw 'Nao foi possivel validar o video baixado.' }
  $vargs = @('-c:v', 'copy')
  if ($video -ne 'h264' -or $info -notmatch 'Video:[^\r\n]* yuv420p[,( ]') {
    $vargs = @('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p')
  }
  $aargs = @('-c:a', 'copy')
  if ($audio -and $audio -ne 'aac') { $aargs = @('-c:a', 'aac', '-b:a', '192k') }
  if ($vargs[1] -ne 'copy' -or $aargs[1] -ne 'copy') {
    Write-Output '[Framelab] Preparando video compativel com o Premiere (H.264/AAC)...'
    $Stage = $Source + '.framelab.' + [guid]::NewGuid().ToString('N')
    New-Item -ItemType Directory -Path $Stage | Out-Null
    $ready = Join-Path $Stage 'ready.mp4'
    & $ffmpeg -nostdin -hide_banner -y -i $Source -map 0:v:0 -map '0:a:0?' @vargs @aargs -movflags +faststart -f mp4 $ready
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao converter o video para o Premiere.' }
    Move-Item -Force -LiteralPath $ready -Destination $Source
  }
  Write-Output ('FRAMELAB_FILE:' + (ConvertTo-Json -Compress -InputObject $Source))
} catch {
  Write-Output ('ERROR: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($Stage -and (Test-Path -LiteralPath $Stage)) { Remove-Item -Recurse -Force -LiteralPath $Stage }
}
exit 0
`;
  function destinationOf(path, token = "") {
    return { path, token };
  }
  const DESTINATION_GROUPS = {
    download: ["download"],
    captions: ["captions"],
    titles: ["titles"],
    audio: ["sfx", "soundDesign"]
  };
  const GROUP_OF = new Map(
    Object.entries(DESTINATION_GROUPS).flatMap(([group2, tools2]) => tools2.map((tool) => [tool, group2]))
  );
  function groupOf(tool) {
    const group2 = GROUP_OF.get(tool);
    if (!group2) {
      throw new Error(`ferramenta sem grupo de destino: ${tool}`);
    }
    return group2;
  }
  const STORE_FILE = "destinations.json";
  let cache = null;
  let writing = Promise.resolve();
  function readStore(space) {
    if (cache) {
      return cache;
    }
    const out = {};
    try {
      const raw = readText$1(space, STORE_FILE);
      const parsed = raw ? JSON.parse(raw) : {};
      for (const [group2, value] of Object.entries(parsed ?? {})) {
        const path = typeof value?.path === "string" ? value.path : "";
        if (path) {
          out[group2] = { path, token: typeof value?.token === "string" ? value.token : "" };
        }
      }
    } catch {
    }
    cache = out;
    return out;
  }
  async function readDestination(tool, legacy) {
    const space = await workspace();
    const store = readStore(space);
    const group2 = groupOf(tool);
    const held = store[group2];
    if (held) {
      return held;
    }
    if (legacy?.path) {
      await saveDestination(tool, legacy);
      return legacy;
    }
    return null;
  }
  async function saveDestination(tool, next) {
    const space = await workspace();
    const store = readStore(space);
    const group2 = groupOf(tool);
    if (next?.path) {
      store[group2] = { path: next.path, token: next.token ?? "" };
    } else {
      delete store[group2];
    }
    writing = writing.then(async () => {
      try {
        await write(space, STORE_FILE, JSON.stringify(store, null, 2));
      } catch (cause) {
        console.warn("[Destino] não consegui gravar as pastas:", cause);
      }
    });
    await writing;
  }
  function storageApi() {
    const storage = uxpModule("uxp")?.storage;
    const lfs = storage?.localFileSystem;
    return lfs ? { lfs, binary: storage?.formats?.binary } : null;
  }
  const NO_PICKER = "este build do Premiere não abre o seletor de pastas";
  async function pickDestination() {
    const api = storageApi();
    if (typeof api?.lfs.getFolder !== "function") {
      throw new Error(NO_PICKER);
    }
    let folder = null;
    try {
      folder = await api.lfs.getFolder();
    } catch {
      return null;
    }
    if (!folder?.nativePath) {
      return null;
    }
    return { path: folder.nativePath, token: await persistentToken(folder) ?? "" };
  }
  async function pickAndSave(tool) {
    const picked = await pickDestination();
    if (!picked) {
      return null;
    }
    await saveDestination(tool, picked);
    return picked;
  }
  async function persistentToken(entry) {
    const api = storageApi();
    if (typeof api?.lfs.createPersistentToken !== "function") {
      return null;
    }
    try {
      return await api.lfs.createPersistentToken(entry) ?? null;
    } catch {
      return null;
    }
  }
  function samePath$1(a, b) {
    const clean = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC");
    const left = clean(a);
    const right = clean(b);
    return left === right || left.toLowerCase() === right.toLowerCase();
  }
  const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  function safeBaseName(raw, fallback = "arquivo") {
    const compact = raw.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 180).replace(/[. ]+$/, "");
    if (!compact || compact === "." || compact === "..") {
      return fallback;
    }
    return RESERVED.test(compact) ? `_${compact}` : compact;
  }
  function safeRelative(relative, fallback = "arquivo") {
    const parts = relative.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
    if (parts.length === 0) {
      return fallback;
    }
    const name = safeBaseName(parts.pop(), fallback);
    return [...parts.map((part) => safeBaseName(part, "pasta")), name].join("/");
  }
  async function openDestination(target2, options = {}) {
    const api = storageApi();
    if (!api) {
      throw new Error("destino: storage do UXP indisponível");
    }
    if (!target2.path) {
      throw new Error("destino: nenhuma pasta escolhida");
    }
    if (target2.token && typeof api.lfs.getEntryForPersistentToken === "function") {
      try {
        const folder2 = await api.lfs.getEntryForPersistentToken(target2.token);
        const actual = folder2?.nativePath ?? "";
        if (!actual || samePath$1(actual, target2.path)) {
          return { folder: folder2, binary: api.binary, nativePath: actual || target2.path, via: "token" };
        }
        console.warn(
          `[Destino] token ignorado: ele abre "${actual}", e a pasta guardada é "${target2.path}".`
        );
      } catch {
      }
    }
    if (typeof api.lfs.getEntryWithUrl === "function") {
      try {
        const folder2 = await api.lfs.getEntryWithUrl(fileUrl(target2.path));
        return { folder: folder2, binary: api.binary, nativePath: folder2?.nativePath ?? target2.path, via: "path" };
      } catch (cause) {
        if (!options.create) {
          throw new Error(
            `destino: a pasta não abriu: "${target2.path}". Se ela foi renomeada ou está num Drive que não montou, escolha-a de novo — o plugin não cria pasta parecida no lugar dela (${describe$3(cause)}).`
          );
        }
      }
    }
    if (!options.create) {
      throw new Error(`destino: o storage do UXP não abriu "${target2.path}"`);
    }
    const normalized = target2.path.replace(/\\/g, "/").replace(/\/+$/, "");
    const cut = normalized.lastIndexOf("/");
    if (cut <= 0 || typeof api.lfs.getEntryWithUrl !== "function") {
      throw new Error(`destino: sem pasta-mãe para criar "${target2.path}"`);
    }
    const parent = await api.lfs.getEntryWithUrl(fileUrl(normalized.slice(0, cut)));
    const leaf = normalized.slice(cut + 1);
    let folder;
    try {
      folder = await parent.createFolder(leaf);
    } catch {
      folder = await parent.getEntry(leaf);
    }
    return { folder, binary: api.binary, nativePath: folder?.nativePath ?? target2.path, via: "created" };
  }
  async function writeFileInto(target2, relative, data, options = {}) {
    const safe = safeRelative(relative);
    const opened = await openDestination(target2, options);
    const cut = safe.lastIndexOf("/");
    const dir = cut > 0 ? safe.slice(0, cut) : "";
    const name = cut > 0 ? safe.slice(cut + 1) : safe;
    let folder = opened.folder;
    if (dir) {
      if (!options.createSubfolders) {
        throw new Error(`destino: "${dir}" precisaria ser criada e ninguém autorizou`);
      }
      for (const part of dir.split("/")) {
        folder = await subfolder(folder, part);
      }
    }
    const file = await folder.createFile(name, { overwrite: true });
    const binary = typeof data === "string" ? void 0 : opened.binary;
    try {
      await file.write(data, binary !== void 0 ? { format: binary } : void 0);
    } catch (cause) {
      if (typeof data === "string") {
        throw cause;
      }
      await file.write(data, { format: "binary" });
    }
    return file.nativePath ?? joinNative(opened.nativePath, safe);
  }
  async function subfolder(parent, name) {
    try {
      return await parent.createFolder(name);
    } catch {
      return await parent.getEntry(name);
    }
  }
  function joinNative(base, relative) {
    const sep = isWindows() && !base.includes("/") ? "\\" : "/";
    return `${base.replace(/[\\/]+$/, "")}${sep}${relative.split("/").join(sep)}`;
  }
  function isInside(folder, file) {
    const clean = (value) => value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").toLowerCase();
    const base = clean(folder);
    const target2 = clean(file);
    return target2 === base || target2.startsWith(`${base}/`);
  }
  function describe$3(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const q$1 = shellQuote;
  const RESULT_FILE$1 = "dl-result.json";
  const PROGRESS_FILE = "dl-progress.txt";
  const LOG_FILE = "dl-log.txt";
  const FILES_FILE = "dl-files.txt";
  const FILE_MARKER = "FRAMELAB_FILE:";
  const FILE_PRINT = `after_move:${FILE_MARKER}%(filepath)j`;
  const COOKIE_MARKER = "FRAMELAB_COOKIES:";
  const STARTED_FILE$1 = "dl-started.txt";
  const CANCEL_FILE = "dl-cancel.txt";
  const CONFIG_FILE$1 = "download-config.json";
  const SCRIPT_FILE$1 = "download.command";
  const SCRIPT_FILE_WIN$1 = "download.bat";
  const LOCAL_BIN_WIN = "yt-dlp.exe";
  function runTag() {
    return Date.now().toString(36);
  }
  function infoFile(tag, index) {
    return `dl-${tag}-info-${index}.json`;
  }
  function scriptName$1(tag) {
    return `dl-${tag}-${isWindows() ? SCRIPT_FILE_WIN$1 : SCRIPT_FILE$1}`;
  }
  const POLL_MS$1 = 250;
  const PROBE_TIMEOUT_MS = 90 * 1e3;
  const PROBE_SETUP_TIMEOUT_MS = 8 * 60 * 1e3;
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
      const raw = readText$1(await workspace(), CONFIG_FILE$1);
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
    const cap = `[width<=?${ceiling}][height<=?${ceiling}]`;
    return `bv*${NO_WATERMARK}${cap}+ba/b${NO_WATERMARK}${cap}/bv*${NO_WATERMARK}+ba/b${NO_WATERMARK}/b`;
  }
  function sortArg(quality) {
    if (quality.audioOnly) {
      return null;
    }
    const resolution = quality.height === null ? "res" : `res:${quality.height}`;
    return `${resolution},vcodec:h264,acodec:aac`;
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
      const hasDimensions = shortSide(format) !== null;
      const hasVideo = hasDimensions || text$1(format.vcodec) !== "none" && text$1(format.vcodec) !== "";
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
    const ok = probes.filter((probe2) => probe2.ok);
    if (ok.length === 0) {
      return [...QUALITIES];
    }
    const tallest = Math.max(...ok.map((probe2) => probe2.resolutions[0] ?? 0));
    return QUALITIES.filter(
      (quality) => quality.height === null || quality.height <= tallest
    );
  }
  function parseCookieTrouble(log) {
    const found = new RegExp(`^${COOKIE_MARKER}(blocked|missing)\\s*$`, "m").exec(log);
    return found ? found[1] : null;
  }
  function describeCookieTrouble(trouble, browser, brief = false) {
    if (brief) {
      return trouble === "missing" ? `sem cookies (${browser} não encontrado)` : `sem cookies (o macOS bloqueou o ${browser})`;
    }
    if (trouble === "missing") {
      return `O ${browser} não está neste Mac, então seguiu sem cookies. Nos ajustes avançados, escolha o navegador que você usa ou Nenhum.`;
    }
    return `O macOS não deixou ler os cookies do ${browser}, então seguiu sem eles. Para usar cookies, libere o FramelabAgent em Ajustes do Sistema › Privacidade e Segurança › Acesso Total ao Disco; se não precisa, deixe em Nenhum.`;
  }
  function parseDownloadedFiles(log) {
    const files = [];
    for (const line of log.split(/\r?\n/)) {
      if (!line.startsWith(FILE_MARKER)) continue;
      try {
        const path = JSON.parse(line.slice(FILE_MARKER.length));
        if (typeof path === "string" && /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) {
          files.push(path);
        }
      } catch {
      }
    }
    return [...new Set(files)];
  }
  let previousRunFiles$1 = [];
  async function run$2(launch) {
    const shell = shellModule();
    if (!shell) {
      return fail$2("uxp-unavailable", null);
    }
    const space = await workspace();
    const scriptFile = scriptName$1(launch.tag);
    const scriptPath = nativePath(space, scriptFile);
    const tag = launch.tag;
    const runFiles2 = {
      result: `dl-${tag}-result.json`,
      progress: `dl-${tag}-progress.txt`,
      log: `dl-${tag}-log.txt`,
      files: `dl-${tag}-files.txt`,
      started: `dl-${tag}-started.txt`,
      cancel: `dl-${tag}-cancel.txt`
    };
    for (const name of [
      ...Object.values(runFiles2),
      ...launch.owned ?? [],
      ...previousRunFiles$1,
      RESULT_FILE$1,
      PROGRESS_FILE,
      LOG_FILE,
      FILES_FILE,
      STARTED_FILE$1,
      ...launch.stale
    ]) {
      await remove(space, name);
    }
    previousRunFiles$1 = [
      runFiles2.result,
      runFiles2.progress,
      runFiles2.log,
      runFiles2.files,
      runFiles2.started,
      ...launch.owned ?? [],
      scriptFile
    ];
    const script = launch.build(space).split(RESULT_FILE$1).join(runFiles2.result).split(PROGRESS_FILE).join(runFiles2.progress).split(LOG_FILE).join(runFiles2.log).split(FILES_FILE).join(runFiles2.files).split(STARTED_FILE$1).join(runFiles2.started).split(CANCEL_FILE).join(runFiles2.cancel);
    await write(space, scriptFile, script, true);
    let launchError = null;
    const sent = await dispatch(scriptFile);
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Download] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, launch.purpose);
      } catch (cause) {
        launchError = describe$5(cause);
        console.error("[Download] openPath recusou:", cause);
        launch.onManual?.(scriptPath, launchError);
      }
    }
    let stampDeadline = Date.now() + 8e3;
    const BUSY_GRACE_MS = 8e3;
    const deadline = Date.now() + launch.timeoutMs;
    let lastSignature = "";
    let tick = 0;
    while (Date.now() < deadline) {
      tick += 1;
      if (launch.cancelled?.()) {
        await write(space, runFiles2.cancel, "1");
        await withdraw(sent.ticket);
        const full = readText$1(space, runFiles2.log) ?? "";
        const logTail2 = await tail(space, runFiles2.log);
        return {
          ...fail$2("cancelled", scriptPath),
          log: logTail2,
          filesFile: runFiles2.files,
          // `after_move` só imprime depois do arquivo estar no nome
          // final: o que está nessa lista está inteiro.
          downloadedFiles: parseDownloadedFiles(full),
          cookies: parseCookieTrouble(full)
        };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        const verdict = await stampVerdict();
        if (verdict === "busy") {
          stampDeadline = Date.now() + BUSY_GRACE_MS;
          launch.onQueued?.("na fila do agente — outro trabalho está rodando…");
        } else if (!readText$1(space, runFiles2.started)) {
          awaitingStamp = false;
          console.warn("[Download] sem carimbo do agente — caindo para o Terminal.");
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, launch.purpose);
          } catch (cause) {
            launchError = describe$5(cause);
            launch.onManual?.(scriptPath, launchError);
          }
        } else {
          awaitingStamp = false;
        }
      }
      if (launch.onProgress && tick % 4 === 0) {
        const log = await tail(space, runFiles2.log);
        const done = readProgress(space, runFiles2.progress);
        const percent = readPercent(log);
        const signature2 = `${done}|${percent}|${log.length}`;
        if (signature2 !== lastSignature) {
          lastSignature = signature2;
          launch.onProgress(done, launch.total, percent, log);
        }
      }
      const raw = readText$1(space, runFiles2.result);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const full = readText$1(space, runFiles2.log) ?? "";
          const logTail2 = await tail(space, runFiles2.log);
          return {
            ok: parsed.ok === true,
            error: parsed.ok === true ? null : parsed.error ?? "ytdlp-failed",
            ytdlpPath: typeof parsed.ytdlp === "string" ? parsed.ytdlp : null,
            scriptPath,
            failed: typeof parsed.failed === "number" ? parsed.failed : 0,
            log: logTail2,
            filesFile: runFiles2.files,
            downloadedFiles: parseDownloadedFiles(full),
            cookies: parseCookieTrouble(full)
          };
        } catch {
        }
      }
      await wait$1(POLL_MS$1);
    }
    const logTail = await tail(space, runFiles2.log);
    return {
      ...fail$2(launchError ? `launch-denied: ${launchError}` : "timeout", scriptPath),
      log: logTail
    };
  }
  function fail$2(error, scriptPath) {
    return { ok: false, error, ytdlpPath: null, scriptPath, failed: 0, log: "" };
  }
  function readProgress(space, name) {
    const raw = readText$1(space, name);
    const parsed = Number.parseInt(raw?.split("/")[0] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  async function tail(space, name, lines = 12) {
    const raw = await readTailText(space, name);
    if (!raw) {
      return "";
    }
    const slice = raw.length > 4096 ? raw.slice(-4096) : raw;
    return slice.split(/\r?\n/).filter((line) => !line.startsWith(FILE_MARKER) && !line.startsWith(COOKIE_MARKER)).slice(-lines).join("\n");
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
      const index = urls.findIndex((url, at2) => !out.has(at2) && mentions(line, url));
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
  async function probeUrls(urls, config, onProgress, cancelled, onManual, onQueued) {
    const tag = runTag();
    const infoFiles = urls.map((_, index) => infoFile(tag, index));
    const stale = urls.map((_, index) => `dl-info-${index}.json`);
    const attempt2 = await run$2({
      build: (space2) => isWindows() ? probeScriptWin(urls, tag, config, space2.nativeBase) : probeScriptUnix(urls, tag, config, space2.nativeBase),
      tag,
      // Sem caminho guardado é a primeira vez: o script vai provisionar
      // antes de consultar, e 90s não cobrem 35 MB numa linha ruim.
      timeoutMs: config.ytdlpPath ? PROBE_TIMEOUT_MS : PROBE_SETUP_TIMEOUT_MS,
      stale,
      owned: infoFiles,
      onProgress,
      onQueued,
      total: urls.length,
      cancelled,
      onManual,
      purpose: "Consultar os dados dos vídeos com o yt-dlp."
    });
    const result = attempt2.error === "timeout" ? { ...attempt2, error: "probe-timeout" } : attempt2;
    const space = await workspace();
    const complaints = complaintsByIndex(urls, result.log);
    const probes = urls.map((url, index) => {
      const raw = readText$1(space, infoFiles[index]);
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
  async function downloadUrls(urls, quality, config, direct = [], onProgress, cancelled, onManual, onQueued) {
    const chosen = config.destination.trim();
    const destination = chosen || await defaultDestination();
    const mayCreate = chosen === "";
    const customFfmpeg = urls.length > 0 ? (await readConfig$2()).ffmpegPath : "";
    const result = await run$2({
      build: (space2) => isWindows() ? downloadScriptWin(urls, quality, config, space2.nativeBase, destination, direct, customFfmpeg, mayCreate) : downloadScriptUnix(urls, quality, config, space2.nativeBase, destination, direct, customFfmpeg, mayCreate),
      tag: runTag(),
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      stale: [],
      onProgress,
      onQueued,
      total: urls.length + direct.length,
      cancelled,
      onManual,
      purpose: "Baixar os vídeos dos links informados."
    });
    const space = await workspace();
    const listed = readText$1(space, result.filesFile ?? FILES_FILE);
    const directFiles = listed ? listed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0) : [];
    const files = [.../* @__PURE__ */ new Set([...directFiles, ...result.downloadedFiles ?? []])];
    const strays = files.filter((file) => !isInside(destination, file));
    if (strays.length > 0) {
      console.error("[Download] arquivos fora da pasta escolhida:", strays);
      return {
        ...result,
        ok: false,
        error: "destination-escaped",
        files,
        log: `${result.log}

O download saiu da pasta escolhida.
Pedido: ${destination}
Escrito: ${strays.join("\n         ")}`
      };
    }
    if (result.ok && files.length === 0) {
      return { ...result, ok: false, error: "missing-files", files };
    }
    return { ...result, files };
  }
  async function installYtdlp(onManual, cancelled) {
    const result = await run$2({
      build: (space) => isWindows() ? installScriptWin(space.nativeBase) : installScriptUnix(space.nativeBase),
      tag: runTag(),
      timeoutMs: INSTALL_TIMEOUT_MS,
      stale: [],
      total: 1,
      cancelled,
      onManual,
      purpose: "Baixar o yt-dlp oficial para a pasta do plugin."
    });
    return result.error === "cancelled" ? { ...result, error: "install-cancelled" } : result;
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
      // Binário de arquivo único (ou nenhum)? Troca pelo onedir — ver
      // ONEDIR_DIR para o porquê. Um script Python (Homebrew, pip) começa
      // com `#!` e não tem o problema; esse fica como está.
      `ONEDIR="$WORK/${ONEDIR_DIR}"`,
      'if [ -z "$YTDLP" ] || [ "$(head -c 2 "$YTDLP" 2>/dev/null)" != "#!" ]; then',
      `  if [ ! -x "$ONEDIR/${ONEDIR_BIN}" ]; then`,
      '    echo "Preparando o downloader rapido (so na primeira vez)..."',
      `    echo "Preparando o downloader rapido (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
      '    rm -rf "$ONEDIR.tmp" "$ONEDIR.zip"',
      `    if curl -fsSL --retry 3 -o "$ONEDIR.zip" ${q$1(RELEASE_MAC_ONEDIR)} 2>> "$WORK/${LOG_FILE}" &&`,
      `      unzip -q -o "$ONEDIR.zip" -d "$ONEDIR.tmp" >> "$WORK/${LOG_FILE}" 2>&1; then`,
      '      xattr -dr com.apple.quarantine "$ONEDIR.tmp" >/dev/null 2>&1 || true',
      // Esta primeira execução é a que o XProtect escaneia, e o `mv`
      // depois não a desfaz (medido). É também a prova de que o build
      // roda antes de ele vencer a busca de todo script futuro.
      `      if "$ONEDIR.tmp/${ONEDIR_BIN}" --version >/dev/null 2>&1; then`,
      '        rm -rf "$ONEDIR"',
      '        mv "$ONEDIR.tmp" "$ONEDIR"',
      "      fi",
      "    fi",
      '    rm -rf "$ONEDIR.tmp" "$ONEDIR.zip"',
      "  fi",
      // Falhou? Segue com o de arquivo único: lento, mas funciona.
      `  if [ -x "$ONEDIR/${ONEDIR_BIN}" ]; then YTDLP="$ONEDIR/${ONEDIR_BIN}"; fi`,
      "fi",
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
      // A permissão de execução não garante que o runtime roda neste Mac:
      // uma cópia Intel sem Rosetta passa em -x, mas deixa o YouTube sem JS.
      "DENO=''",
      'for candidate in "$WORK/deno" /opt/homebrew/bin/deno /usr/local/bin/deno "$HOME/.deno/bin/deno"; do',
      '  if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then DENO="$candidate"; break; fi',
      "done",
      'if [ -z "$DENO" ]; then',
      '  candidate="$(command -v deno 2>/dev/null || true)"',
      '  if [ -n "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then DENO="$candidate"; fi',
      "fi",
      'if [ -z "$DENO" ]; then',
      '  echo "Preparando o motor de extracao (so na primeira vez)..."',
      `  echo "Preparando o motor de extracao (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
      `  if [ "$(uname -m)" = "arm64" ]; then DURL=${q$1(DENO_MAC_ARM)}; else DURL=${q$1(DENO_MAC_INTEL)}; fi`,
      '  DENO_STAGE="$(mktemp -d "$WORK/deno-install.XXXXXX")"',
      '  if [ -n "$DENO_STAGE" ]; then',
      `    if curl -fsSL --retry 3 -o "$DENO_STAGE/deno.zip" "$DURL" 2>> "$WORK/${LOG_FILE}" &&`,
      `      unzip -o -q "$DENO_STAGE/deno.zip" deno -d "$DENO_STAGE" >> "$WORK/${LOG_FILE}" 2>&1; then`,
      '      chmod +x "$DENO_STAGE/deno" 2>/dev/null',
      '      xattr -d com.apple.quarantine "$DENO_STAGE/deno" >/dev/null 2>&1 || true',
      '      if "$DENO_STAGE/deno" --version >/dev/null 2>&1 && mv -f "$DENO_STAGE/deno" "$WORK/deno"; then DENO="$WORK/deno"; fi',
      "    fi",
      '    rm -rf "$DENO_STAGE"',
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
  const MAC_BROWSER_DIRS = {
    chrome: "Google/Chrome",
    edge: "Microsoft Edge",
    brave: "BraveSoftware/Brave-Browser",
    firefox: "Firefox"
  };
  function unixCookies(config) {
    const lines = ["CK=''", "CKDIR=''"];
    const note2 = (trouble) => `  printf '%s\\n' '${COOKIE_MARKER}${trouble}' >> "$WORK/${LOG_FILE}"`;
    const browser = config.cookies;
    if (browser === "none") {
      return lines;
    }
    if (browser === "safari") {
      return [
        ...lines,
        'SF="$HOME/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"',
        'if [ -f "$HOME/Library/Cookies/Cookies.binarycookies" ]; then SF="$HOME/Library/Cookies/Cookies.binarycookies"; fi',
        // O Safari sempre existe no Mac: ilegível aqui é o macOS negando.
        'if head -c 1 "$SF" >/dev/null 2>&1; then',
        "  CK=safari",
        "else",
        note2("blocked"),
        "fi"
      ];
    }
    const dir = MAC_BROWSER_DIRS[browser];
    if (!dir) {
      return lines;
    }
    const chromium = browser !== "firefox";
    return [
      ...lines,
      `BDIR="$HOME/Library/Application Support/${dir}"`,
      'if [ ! -d "$BDIR" ]; then',
      note2("missing"),
      // O `-d` passa mesmo sob a proteção do macOS; listar, não.
      'elif ! ls "$BDIR" >/dev/null 2>&1; then',
      note2("blocked"),
      "else",
      `  CK=${browser}`,
      ...chromium ? [
        '  PROFILE="$(plutil -extract profile.last_used raw -o - "$BDIR/Local State" 2>/dev/null || true)"',
        '  if [ -z "$PROFILE" ]; then PROFILE=Default; fi',
        '  if [ -f "$BDIR/$PROFILE/Cookies" ]; then',
        '    CKDIR="$(mktemp -d "${TMPDIR:-/tmp}/framelab-cookies.XXXXXX" 2>/dev/null || true)"',
        '    if [ -n "$CKDIR" ] && cp "$BDIR/$PROFILE/Cookies" "$CKDIR/Cookies" 2>/dev/null; then',
        `      CK="${browser}:$CKDIR"`,
        "    fi",
        "  fi"
      ] : [],
      "fi",
      `trap 'if [ -n "$CKDIR" ]; then rm -rf "$CKDIR"; fi' EXIT`
    ];
  }
  const UNIX_COOKIES_ARG = '${CK:+--cookies-from-browser "$CK"} ';
  const UNIX_CLOSE_WINDOW = `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`;
  const UNIX_CLOSE = [
    'echo "Pronto. Pode voltar ao Premiere."',
    UNIX_CLOSE_WINDOW,
    "exit 0"
  ];
  function unixCancelGuard() {
    return [
      `if [ -f "$WORK/${CANCEL_FILE}" ]; then`,
      `  rm -f "$WORK/${CANCEL_FILE}"`,
      '  echo "Cancelado pelo painel."',
      `  ${UNIX_CLOSE_WINDOW}`,
      "  exit 0",
      "fi"
    ];
  }
  const WIN_CANCEL_LABEL = "fl_cancelado";
  function winCancelGuard() {
    return `if exist "%WORK%\\${CANCEL_FILE}" goto :${WIN_CANCEL_LABEL}`;
  }
  function winCancelTail() {
    return [
      `:${WIN_CANCEL_LABEL}`,
      `del /q "%WORK%\\${CANCEL_FILE}" >nul 2>&1`,
      "echo Cancelado pelo painel.",
      "exit /b 0"
    ];
  }
  function probeScriptUnix(urls, tag, config, folder) {
    const lines = [...unixBase(folder), ...unixYtdlpSetup(config), ...unixCookies(config)];
    lines.push("FAILED=0");
    urls.forEach((url, index) => {
      const target2 = `"$WORK/${infoFile(tag, index)}"`;
      const extra = extraSiteArgs(url);
      lines.push(
        ...unixCancelGuard(),
        `echo "[${index + 1}/${urls.length}] consultando…"`,
        `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
        `if "$YTDLP" --no-warnings --no-playlist --ignore-config --extractor-retries 5 --retry-sleep extractor:3 \${DENO:+--js-runtimes "deno:$DENO"} ${UNIX_COOKIES_ARG}${extra}-J ${q$1(url)} > ${target2}.tmp 2>> "$WORK/${LOG_FILE}"; then`,
        `  mv ${target2}.tmp ${target2}`,
        "else",
        "  FAILED=$((FAILED+1))",
        `  rm -f ${target2}.tmp`,
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
  function downloadScriptUnix(urls, quality, config, folder, destination, direct = [], customFfmpeg = "", mayCreate = false) {
    const lines = unixBase(folder);
    if (urls.length > 0) {
      lines.push(...unixYtdlpSetup(config), ...unixFfmpeg(customFfmpeg), ...unixCookies(config));
      if (!quality.audioOnly) {
        lines.push(
          'export FRAMELAB_FFMPEG="$FFMPEG"',
          `cat > "$WORK/${LOG_FILE}.premiere.sh" <<'FRAMELAB_MEDIA_SCRIPT'`,
          premiereMediaUnix,
          "FRAMELAB_MEDIA_SCRIPT"
        );
      }
    }
    lines.push(`DEST=${q$1(destination)}`);
    lines.push(
      ...mayCreate ? ['mkdir -p "$DEST"'] : [
        'if [ ! -d "$DEST" ]; then',
        `  echo "ERROR: a pasta de destino não existe: $DEST" >> "$WORK/${LOG_FILE}"`,
        `  printf '{"ok":false,"error":"destination-missing","failed":1}' > "$WORK/${RESULT_FILE$1}.tmp"`,
        `  mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
        "  exit 1",
        "fi"
      ]
    );
    lines.push("FAILED=0");
    const total = direct.length + urls.length;
    direct.forEach((job, index) => {
      const target2 = `"$DEST/"${q$1(job.fileName)}`;
      lines.push(
        ...unixCancelGuard(),
        `echo "[${index + 1}/${total}] ${escapeEcho(job.fileName)}"`,
        `printf '%s/%s' ${index + 1} ${total} > "$WORK/${PROGRESS_FILE}"`,
        `if curl -fL --progress-bar --retry 3 -o ${target2} ${q$1(job.mediaUrl)} 2>> "$WORK/${LOG_FILE}"; then`,
        `  printf '%s\\n' "$DEST/"${q$1(job.fileName)} >> "$WORK/${FILES_FILE}"`,
        "else",
        "  FAILED=$((FAILED+1))",
        `  echo "ERROR: download direto falhou: ${escapeEcho(job.sourceUrl)}" >> "$WORK/${LOG_FILE}"`,
        `  rm -f ${target2}`,
        "fi"
      );
    });
    const shared = `--newline --no-mtime --no-playlist --ignore-config --no-windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 --extractor-retries 5 --retry-sleep extractor:3 \${DENO:+--js-runtimes "deno:$DENO"} -o ${q$1("%(title)s [%(id)s].%(ext)s")} ` + // Vídeo: só o helper publica o caminho, depois de preparar os codecs.
    // --print after_move seria prematuro: yt-dlp imprime antes do --exec.
    // Áudio: a extração para MP3 já terminou quando after_move começa.
    (quality.audioOnly ? `--print ${q$1(FILE_PRINT)} ` : `--exec ${q$1(`after_move:/bin/bash "${LOG_FILE}.premiere.sh" %(filepath)q`)} `) + `--no-simulate --no-quiet --progress ` + UNIX_COOKIES_ARG;
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${q$1(formatSelector(quality))}` : (
      // MP4 é o contêiner; o helper after_move valida/converte os codecs
      // antes de publicar o marcador, inclusive para arquivos existentes.
      `-f ${q$1(formatSelector(quality))} ${sort ? `-S ${q$1(sort)} ` : ""}--merge-output-format mp4 --remux-video mp4`
    );
    urls.forEach((url, index) => {
      const step2 = direct.length + index + 1;
      const extra = extraSiteArgs(url);
      lines.push(
        ...unixCancelGuard(),
        `echo "[${step2}/${total}] ${escapeEcho(url)}"`,
        `printf '%s\\n' ${q$1(`[${step2}/${total}] ${url}`)} >> "$WORK/${LOG_FILE}"`,
        `printf '%s/%s' ${step2} ${total} > "$WORK/${PROGRESS_FILE}"`,
        // `${FFDIR:+…}` some inteiro quando não há ffmpeg, em vez de
        // passar uma flag com valor vazio — que o yt-dlp recusa.
        `"$YTDLP" ${shared} ${media} ${extra}-P "$DEST" \${FFDIR:+--ffmpeg-location "$FFDIR"} ${q$1(url)} 2>&1 | tee -a "$WORK/${LOG_FILE}"`,
        'if [ "${PIPESTATUS[0]}" -ne 0 ]; then FAILED=$((FAILED+1)); fi'
      );
    });
    lines.push(
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
  const RELEASE_MAC_ONEDIR = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip";
  const ONEDIR_DIR = "yt-dlp-onedir";
  const ONEDIR_BIN = "yt-dlp_macos";
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
      // O onedir, não o arquivo único: ver ONEDIR_DIR. Sem tee: o `if`
      // precisa medir o CURL, e `curl | tee` mede o tee, que nunca
      // falha — um download pela metade seguia o caminho feliz e
      // instalava um binário truncado.
      `ONEDIR="$WORK/${ONEDIR_DIR}"`,
      'rm -rf "$ONEDIR.tmp" "$ONEDIR.zip"',
      `if curl -fSL --retry 3 -o "$ONEDIR.zip" ${q$1(RELEASE_MAC_ONEDIR)} 2>> "$WORK/${LOG_FILE}" &&`,
      `  unzip -q -o "$ONEDIR.zip" -d "$ONEDIR.tmp" >> "$WORK/${LOG_FILE}" 2>&1; then`,
      // O binário do macOS vem sem assinatura reconhecida pelo
      // Gatekeeper; sem tirar a quarentena, a primeira execução morre
      // num diálogo que o painel nunca veria.
      '  xattr -dr com.apple.quarantine "$ONEDIR.tmp" >/dev/null 2>&1 || true',
      `  if "$ONEDIR.tmp/${ONEDIR_BIN}" --version >/dev/null 2>&1; then`,
      '    rm -rf "$ONEDIR"',
      '    mv "$ONEDIR.tmp" "$ONEDIR"',
      `    printf '{"ok":true,"ytdlp":"%s"}' "$ONEDIR/${ONEDIR_BIN}" > "$WORK/${RESULT_FILE$1}.tmp"`,
      "  else",
      // O que não executa não pode ficar: um yt-dlp quebrado em
      // $WORK vence a busca de TODO script futuro.
      `    printf '{"ok":false,"error":"install-unusable"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      "  fi",
      "else",
      `  printf '{"ok":false,"error":"install-failed"}' > "$WORK/${RESULT_FILE$1}.tmp"`,
      "fi",
      'rm -rf "$ONEDIR.tmp" "$ONEDIR.zip"',
      `mv "$WORK/${RESULT_FILE$1}.tmp" "$WORK/${RESULT_FILE$1}"`,
      ...UNIX_CLOSE
    ].join("\n") + "\n";
  }
  function cookiesArg(config) {
    return config.cookies === "none" ? "" : `--cookies-from-browser ${config.cookies} `;
  }
  function extraSiteArgs(url, _isWin = false) {
    if (/pornhub\.com/i.test(url)) {
      return '--add-header "Cookie:age_verified=1" --referer "https://www.pornhub.com/" ';
    }
    return "";
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
  function probeScriptWin(urls, tag, config, folder) {
    const lines = [...winBase(folder), ...winYtdlpSetup(config)];
    urls.forEach((url, index) => {
      const target2 = `"%WORK%\\${infoFile(tag, index)}"`;
      const extra = extraSiteArgs(url, true);
      lines.push(
        winCancelGuard(),
        `echo [${index + 1}/${urls.length}] consultando...`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
        `"%YTDLP%" --no-warnings --no-playlist --ignore-config --extractor-retries 5 --retry-sleep extractor:3 %JSARGS% ${cookiesArg(config)}${extra}-J ${bq(url)} > ${target2} 2>>"%WORK%\\${LOG_FILE}"`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      `>"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":%FAILED%}`,
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "exit /b 0",
      ...winCancelTail()
    );
    return lines.join("\r\n") + "\r\n";
  }
  function downloadScriptWin(urls, quality, config, folder, destination, direct = [], customFfmpeg = "", mayCreate = false) {
    const lines = winBase(folder);
    if (urls.length > 0) {
      lines.push(...winYtdlpSetup(config));
    }
    lines.push(
      `set "DEST=${batValue(destination)}"`,
      ...mayCreate ? ['if not exist "%DEST%" mkdir "%DEST%"'] : [
        'if not exist "%DEST%" (',
        `  >>"%WORK%\\${LOG_FILE}" echo ERROR: a pasta de destino nao existe: %DEST%`,
        `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"destination-missing","failed":1}`,
        `  move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
        "  exit /b 1",
        ")"
      ]
    );
    const total = direct.length + urls.length;
    direct.forEach((job, index) => {
      lines.push(
        winCancelGuard(),
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
      if (!quality.audioOnly) {
        const scriptLines = premiereMediaWin.split(/\r?\n/).map((line) => `'${line.replace(/'/g, "''")}'`).join(",");
        lines.push(
          'set "FRAMELAB_FFMPEG=ffmpeg.exe"',
          'if "%FFLOC%"=="CUSTOM" (set "FRAMELAB_FFMPEG=%FFCUSTOM%") else if not "%FFLOC%"=="" set "FRAMELAB_FFMPEG=%FFLOC%\\ffmpeg.exe"',
          `powershell -NoProfile -Command ${bq(`Set-Content -Encoding UTF8 -LiteralPath '${LOG_FILE}.premiere.ps1' -Value @(${scriptLines})`)}`
        );
      }
    }
    const shared = (
      // Mesma razão do macOS (ver `downloadScriptUnix`): a flag saneia o
      // caminho inteiro, e a pasta do editor não é do plugin. No Windows o
      // basename já sai seguro sem ela, porque é o sistema onde ele roda.
      `--newline --no-mtime --no-playlist --ignore-config --no-windows-filenames --trim-filenames 120 --retries 5 --fragment-retries 10 -o ${bq("%(title)s [%(id)s].%(ext)s")} ` + (quality.audioOnly ? `--print ${bq(FILE_PRINT)} ` : `--exec ${bq(`after_move:powershell -NoProfile -ExecutionPolicy Bypass -File ${LOG_FILE}.premiere.ps1 %(filepath)q`)} `) + `--no-simulate --no-quiet --progress ` + cookiesArg(config)
    );
    const sort = sortArg(quality);
    const media = quality.audioOnly ? `-x --audio-format mp3 --audio-quality 0 -f ${bq(formatSelector(quality))}` : `-f ${bq(formatSelector(quality))} ${sort ? `-S ${bq(sort)} ` : ""}--merge-output-format mp4 --remux-video mp4`;
    urls.forEach((url, index) => {
      const step2 = direct.length + index + 1;
      const extra = extraSiteArgs(url, true);
      lines.push(
        winCancelGuard(),
        `echo [${step2}/${total}]`,
        `>"%WORK%\\${PROGRESS_FILE}" echo ${step2}/${total}`,
        `"%YTDLP%" ${shared} ${media} ${extra}-P "%DEST%" %FFARGS% %JSARGS% ${bq(url)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
        "if errorlevel 1 set /a FAILED+=1"
      );
    });
    lines.push(
      'if "%FAILED%"=="0" (',
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":0}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE$1}.tmp" echo {"ok":false,"error":"ytdlp-failed","failed":%FAILED%}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE$1}.tmp" "%WORK%\\${RESULT_FILE$1}" >nul`,
      "exit /b 0",
      ...winCancelTail()
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
      case "missing-files":
        return "O yt-dlp terminou, mas não informou o arquivo salvo. Confira a pasta de destino e tente novamente.";
      case "destination-missing":
        return 'A pasta de destino não existe mais. Nada foi baixado — o plugin não cria pasta parecida no lugar dela. Escolha-a de novo em "Destino › Escolher…". Se ela fica num Drive compartilhado, confira se ele montou.';
      case "destination-escaped":
        return "Os arquivos foram escritos FORA da pasta escolhida — veja o log para os caminhos. Eles existem no disco, mas não onde deveriam: mova-os antes de relinkar no projeto.";
      case "install-failed":
        return "Não foi possível baixar o yt-dlp. Verifique a conexão e tente de novo.";
      case "install-unusable":
        return 'O yt-dlp baixou mas não executou. No macOS isso costuma ser o Gatekeeper: abra a pasta e autorize o binário, ou use "brew install yt-dlp".';
      case "timeout":
        return "O download passou do tempo limite e foi abandonado.";
      case "probe-timeout":
        return "A consulta travou e foi abandonada. Tente de novo; se repetir, confira a internet ou o caminho do yt-dlp nos ajustes avançados.";
      case "cancelled":
        return "Cancelado. Um download já iniciado ainda pode terminar em segundo plano.";
      case "install-cancelled":
        return "Instalação cancelada. O yt-dlp continua como estava.";
      case "uxp-unavailable":
        return "Este build do Premiere não expõe shell/fs do UXP.";
      default:
        return `Falha: ${code}`;
    }
  }
  const CAUSES = [
    {
      // Primeiro de todos: quando os cookies não carregam, o yt-dlp para
      // antes de abrir o link — não há outra queixa para ler. A frase
      // cita "cookies" e caía na regra de login, que mandava o editor
      // escolher o navegador que ele JÁ tinha escolhido.
      test: /could not find \w+ cookies database|could not copy \w+ cookie database|failed to decrypt with dpapi|operation not permitted.*cookies/i,
      short: "cookies ilegíveis",
      long: 'Não deu para ler os cookies do navegador escolhido, e sem eles o yt-dlp nem abre o link. Deixe "Cookies do navegador" em Nenhum para baixar normalmente, ou escolha o navegador que você usa.'
    },
    {
      test: /unable to extract universal data|rehydration/i,
      short: "TikTok recusou",
      long: "O TikTok recusou a conversa desta vez — acontece em rajadas. Espere alguns segundos e tente de novo."
    },
    {
      // A queixa do Instagram cita "--cookies-from-browser" no meio do
      // texto, então ela TEM que ser lida antes da regra geral de login
      // — que casa com "cookies" e roubaria o caso.
      test: /empty media response|login required|requested content is not available|locked behind the login page/i,
      short: "Instagram pediu login",
      login: true,
      long: "O Instagram não entregou esse link sem login — é a mesma resposta dele para conta privada, story, post apagado e para quando limitou as consultas do seu IP. Nos ajustes avançados, escolha o navegador onde você já está logado; se insistir, espere alguns minutos."
    },
    {
      test: /no video formats found/i,
      short: "link sem vídeo",
      long: "Não há vídeo nesse link — no Instagram, é um post só de fotos. O painel baixa vídeo e áudio; imagem, não."
    },
    {
      test: /private video/i,
      short: "vídeo privado",
      login: true,
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
      login: true,
      long: "Vídeo com restrição de idade — use os cookies do navegador nos ajustes avançados."
    },
    {
      // `--cookies` e não "cookies": a dica de login do yt-dlp cita a
      // opção, e a palavra solta casava com qualquer linha sobre cookies.
      test: /sign in to confirm|not a bot|--cookies/i,
      short: "pede login",
      login: true,
      long: "O site pediu login. Nos ajustes avançados, escolha o navegador onde você já está logado para o yt-dlp usar os cookies dele."
    },
    {
      test: /ffmpeg is not installed|ffmpeg not found/i,
      short: "falta o ffmpeg",
      long: 'Falta o ffmpeg para juntar vídeo e áudio nesta qualidade. Instale com "brew install ffmpeg" ou escolha 1080p ou menos.'
    },
    {
      // O extrator genérico que não acha o player numa página é o mesmo
      // caso de uma URL desconhecida: o yt-dlp não sabe ler esse site.
      test: /unsupported url|\[generic\][^\n]*unable to extract/i,
      short: "site não suportado",
      long: "O yt-dlp não sabe ler os vídeos desse site."
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
    return errors[errors.length - 1].replace(/^ERROR:\s*/, "").replace(/;?\s*please report this issue on[\s\S]*$/i, "").trim();
  }
  function needsLogin(log) {
    return CAUSES.find((entry) => entry.test.test(log))?.login === true;
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
  function formatBytes$1(bytes) {
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
    const host2 = url.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
    return /(^|\.)tiktok\.com$/i.test(host2);
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
      const playUrl2 = absolute(text(data.play));
      if (!playUrl2) {
        return null;
      }
      return {
        id: text(data.id) || "tiktok",
        title: text(data.title) || "TikTok",
        durationSeconds: num$1(data.duration),
        playUrl: playUrl2,
        hdUrl: absolute(text(data.hdplay)),
        musicUrl: absolute(text(data.music)),
        sizeSd: num$1(data.size) ?? 0,
        sizeHd: num$1(data.hd_size) ?? 0
      };
    } catch {
      return null;
    }
  }
  async function fetchManyTikTok(urls, cancelled) {
    const out = [];
    for (let index = 0; index < urls.length; index += 1) {
      if (cancelled?.()) {
        while (out.length < urls.length) {
          out.push(null);
        }
        break;
      }
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
  function isInstagramUrl(url) {
    const host2 = url.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
    return /(^|\.)(instagram\.com|instagr\.am)$/i.test(host2);
  }
  const SHORTCODE = /\/(reels?|p|tv)\/([A-Za-z0-9_-]+)/i;
  const TRACKING = /^(igsh|igshid|img_index|hl|fbclid|utm_[a-z_]+|ig_[a-z_]+)$/i;
  function cleanInstagramUrl(url) {
    if (!isInstagramUrl(url)) {
      return url;
    }
    const noHash = url.split("#", 1)[0];
    const cut = noHash.indexOf("?");
    const path = cut === -1 ? noHash : noHash.slice(0, cut);
    const query = cut === -1 ? "" : noHash.slice(cut + 1);
    const match = /\/share\//i.test(path) ? null : SHORTCODE.exec(path);
    if (match) {
      const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
      return `https://www.instagram.com/${kind}/${match[2]}/`;
    }
    const kept = query.split("&").filter((pair) => pair.length > 0 && !TRACKING.test(pair.split("=", 1)[0]));
    return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
  }
  function instagramNeedsLogin(url) {
    return isInstagramUrl(url) && /\/stories\//i.test(url);
  }
  const NET_DEADLINE = {
    /** API pequena, resposta curta: metadados de um link. */
    metadata: 2e4,
    /** O `version.json`: um punhado de linhas, e o painel está abrindo. */
    manifest: 2e4,
    /** Uma página de listagem do Drive: HTML, e pode ser grande. */
    listing: 45e3,
    /** Bytes de verdade — um bloco de 4 MB, um som, o bundle. */
    media: 12e4,
    /** Uma rodada de tradução: um lote de falas. */
    translate: 3e4
  };
  class NetTimeout extends Error {
    constructor(ms) {
      super(`a rede não respondeu em ${Math.round(ms / 1e3)}s`);
      this.isNetTimeout = true;
      this.name = "NetTimeout";
      this.ms = ms;
    }
  }
  class NetCancelled extends Error {
    constructor() {
      super("cancelado");
      this.isNetCancelled = true;
      this.name = "NetCancelled";
    }
  }
  function isNetCancelled(cause) {
    return cause instanceof NetCancelled || typeof cause === "object" && cause !== null && "isNetCancelled" in cause;
  }
  function makeController$1() {
    try {
      return typeof AbortController === "function" ? new AbortController() : null;
    } catch {
      return null;
    }
  }
  async function underDeadline(work, clock2) {
    if (clock2.externalSignal?.aborted) {
      throw new NetCancelled();
    }
    const left = clock2.until - Date.now();
    if (left <= 0) {
      throw new NetTimeout(clock2.total);
    }
    let timer = null;
    let onExternalAbort = null;
    let verdict = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        verdict = "timeout";
        clock2.controller?.abort();
        reject(new NetTimeout(clock2.total));
      }, left);
      if (clock2.externalSignal) {
        onExternalAbort = () => {
          verdict = "cancelled";
          clock2.controller?.abort();
          reject(new NetCancelled());
        };
        clock2.externalSignal.addEventListener("abort", onExternalAbort);
      }
    });
    try {
      return await Promise.race([work(), deadline]);
    } catch (cause) {
      if (verdict === "timeout") {
        throw new NetTimeout(clock2.total);
      }
      if (verdict === "cancelled") {
        throw new NetCancelled();
      }
      throw cause;
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (clock2.externalSignal && onExternalAbort) {
        clock2.externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
  const BODY_READERS = /* @__PURE__ */ new Set(["json", "text", "arrayBuffer", "blob", "formData"]);
  function guardBody(response, clock2) {
    return new Proxy(response, {
      get(target2, prop) {
        if (typeof prop === "string" && BODY_READERS.has(prop)) {
          const read = Reflect.get(target2, prop, target2);
          if (typeof read !== "function") {
            return read;
          }
          return () => underDeadline(
            () => read.call(target2),
            clock2
          );
        }
        const value = Reflect.get(target2, prop, target2);
        return typeof value === "function" ? value.bind(target2) : value;
      }
    });
  }
  async function fetchWithTimeout(url, init, timeoutMs, externalSignal) {
    if (externalSignal?.aborted) {
      throw new NetCancelled();
    }
    const clock2 = {
      until: Date.now() + timeoutMs,
      total: timeoutMs,
      controller: makeController$1(),
      externalSignal
    };
    const response = await underDeadline(
      () => fetch(
        url,
        clock2.controller ? { ...init, signal: clock2.controller.signal } : init
      ),
      clock2
    );
    return guardBody(response, clock2);
  }
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const MAX_BYTES = 300 * 1024 * 1024;
  const GAVE_UP = "cancelado pelo editor";
  function stageError(stage, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Error(`${stage}: ${detail}`);
  }
  async function destinationFolder(target2, mayCreate = false) {
    const opened = await openDestination(target2, { create: mayCreate });
    return { folder: opened.folder, binary: opened.binary };
  }
  async function downloadInPanel(job, destination, mayCreate, onProgress, cancelled) {
    const { folder, binary } = await destinationFolder(destination, mayCreate);
    let combined;
    try {
      combined = await fetchAllBytes(job.mediaUrl, onProgress, cancelled);
    } catch (cause) {
      throw stageError("rede", cause);
    }
    try {
      const file = await folder.createFile(safeBaseName(job.fileName, "video"), {
        overwrite: true
      });
      try {
        await file.write(
          combined.buffer,
          binary !== void 0 ? { format: binary } : void 0
        );
      } catch {
        await file.write(combined.buffer, { format: "binary" });
      }
      return file.nativePath ?? `${destination.path}/${safeBaseName(job.fileName, "video")}`;
    } catch (cause) {
      throw stageError("escrita", cause);
    }
  }
  const TOO_BIG = "arquivo grande demais para o painel";
  const UNMEASURABLE = "o servidor não disse o tamanho e esta build não lê o corpo em partes";
  function declaredLength(response) {
    const raw = response.headers?.get?.("content-length");
    if (typeof raw !== "string" || raw.trim() === "") {
      return null;
    }
    if (!/^\d+$/.test(raw.trim())) {
      return null;
    }
    const size = Number(raw.trim());
    if (Number.isNaN(size) || size < 0) {
      return null;
    }
    return size;
  }
  async function readWholeCapped(response, onProgress, cancelled) {
    const declared = declaredLength(response);
    if (declared !== null && declared > MAX_BYTES) {
      throw new Error(TOO_BIG);
    }
    const reader = response.body?.getReader?.();
    if (reader) {
      const parts = [];
      let received = 0;
      try {
        for (; ; ) {
          if (cancelled?.()) {
            throw new Error(GAVE_UP);
          }
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value || value.byteLength === 0) {
            continue;
          }
          received += value.byteLength;
          if (received > MAX_BYTES) {
            throw new Error(TOO_BIG);
          }
          parts.push(value);
          onProgress?.(received, declared);
        }
      } finally {
        try {
          await reader.cancel?.();
        } catch {
        }
      }
      const combined = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) {
        combined.set(part, offset);
        offset += part.byteLength;
      }
      return combined;
    }
    if (declared === null) {
      throw new Error(UNMEASURABLE);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  async function fetchAllBytes(mediaUrl, onProgress, cancelled) {
    const parts = [];
    let received = 0;
    let total = null;
    for (; ; ) {
      if (cancelled?.()) {
        throw new Error(GAVE_UP);
      }
      const from = received;
      const to = from + CHUNK_BYTES - 1;
      let response;
      try {
        response = await fetchWithTimeout(
          mediaUrl,
          { headers: { Range: `bytes=${from}-${to}` } },
          NET_DEADLINE.media
        );
      } catch (cause) {
        if (from > 0) {
          throw cause;
        }
        response = await fetchWithTimeout(mediaUrl, void 0, NET_DEADLINE.media);
      }
      if (response.status === 200) {
        const whole = await readWholeCapped(response, onProgress, cancelled);
        parts.length = 0;
        parts.push(whole);
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
      if (received > MAX_BYTES) {
        throw new Error(TOO_BIG);
      }
      if (total === null) {
        const range = response.headers.get("content-range");
        const match = range ? /\/(\d+)\s*$/.exec(range) : null;
        total = match ? Number.parseInt(match[1], 10) : null;
        if (total !== null && total > MAX_BYTES) {
          throw new Error(TOO_BIG);
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
  const HISTORY_FILE = "download-history.jsonl";
  function baseName$1(path) {
    const clean = path.replace(/[\\/]+$/, "");
    return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
  }
  function pairDownloads(files, jobs, urls, destination, at2 = (/* @__PURE__ */ new Date()).toISOString()) {
    const byName = /* @__PURE__ */ new Map();
    for (const job of jobs) {
      byName.set(job.fileName, job.sourceUrl);
    }
    const rest = [];
    const records = files.map((path, index) => {
      const name = baseName$1(path);
      const known2 = byName.get(name) ?? null;
      if (known2 === null) {
        rest.push(index);
      }
      return { at: at2, url: known2, name, path, destination };
    });
    const taken = new Set(jobs.map((job) => job.sourceUrl));
    const left = urls.filter((url) => !taken.has(url));
    if (left.length === rest.length) {
      rest.forEach((index, at22) => {
        records[index].url = left[at22];
      });
    }
    return records;
  }
  async function rememberDownloads(files, jobs, urls, destination) {
    if (files.length === 0) {
      return;
    }
    try {
      const space = await workspace();
      const lines = pairDownloads(files, jobs, urls, destination).map((record) => JSON.stringify(record)).join("\n");
      await append(space, HISTORY_FILE, lines);
    } catch (cause) {
      console.warn("[Download] não consegui anotar no diário:", cause);
    }
  }
  async function fastLaneByIndex(list, cancelled) {
    const positions = list.map((url, index) => ({ url, index })).filter((entry) => isTikTokUrl(entry.url));
    const infos = await fetchManyTikTok(
      positions.map((entry) => entry.url),
      cancelled
    );
    const byIndex = /* @__PURE__ */ new Map();
    positions.forEach((entry, at2) => {
      const info = infos[at2];
      if (info) {
        byIndex.set(entry.index, info);
      }
    });
    return byIndex;
  }
  function parseUrls(raw) {
    return raw.split(/[\s,]+/).map((line) => line.trim()).filter((line) => /^https?:\/\/\S+$/i.test(line)).map((line) => cleanInstagramUrl(line));
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
  let releaseDocument$3 = null;
  let cancelActiveRun$1 = null;
  const downloadTool = {
    id: "download",
    name: "Baixar Vídeos",
    summary: "Download de YouTube, TikTok e Instagram",
    hint: "Cole um ou mais links do YouTube, do TikTok ou do Instagram. O TikTok vem sempre sem marca d'água, e o arquivo pode entrar direto no projeto aberto.",
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
      let defaultShown = "";
      let probes = [];
      let busy2 = false;
      let cancelled = false;
      container.innerHTML = markup$6();
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
          if (config.cookies !== "none") {
            context.setStatus("", "idle");
          }
        }
      }) : null;
      if (cookiesPick) dropdowns.push(cookiesPick);
      function closeMenus(target2) {
        for (const dropdown of dropdowns) {
          dropdown.closeUnless(target2);
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
      releaseDocument$3 = () => {
        document.removeEventListener("click", onDocumentPointer, true);
        document.removeEventListener("keydown", onDocumentKey, true);
      };
      context.setApplyLabel("BAIXAR");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      void (async () => {
        config = await readConfig$1();
        const held = await readDestination(
          "download",
          destinationOf(config.destination, config.destinationToken)
        ).catch(() => null);
        config.destination = held?.path ?? "";
        config.destinationToken = held?.token ?? "";
        if (!config.destination) {
          defaultShown = await defaultDestination().catch(() => "");
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
        context.setApplyEnabled(!busy2 && list.length > 0);
        if (scanEl && !busy2) {
          setDisabled(scanEl, list.length === 0);
        }
        if (list.length === 0) {
          const typed = countLines(urlsEl?.value ?? "");
          context.setStatus(
            typed > 0 ? "Nenhuma linha parece um link (http/https)." : "",
            typed > 0 ? "error" : "idle"
          );
        }
      }
      function hintLogin() {
        if (busy2 || config.cookies !== "none") {
          return;
        }
        if (urls().some(instagramNeedsLogin)) {
          context.setStatus(
            "Story do Instagram só baixa logado: escolha o navegador nos ajustes avançados.",
            "error"
          );
        }
      }
      function withCookieNote(message, trouble, failureLog) {
        if (!trouble || config.cookies === "none") {
          return message;
        }
        const browser = COOKIE_LABELS[config.cookies];
        return failureLog !== void 0 && needsLogin(failureLog) ? `${message} ${describeCookieTrouble(trouble, browser)}` : `${message} · ${describeCookieTrouble(trouble, browser, true)}`;
      }
      urlsEl?.addEventListener("input", () => {
        if (probes.length > 0) {
          probes = [];
          renderList();
          renderQualities();
        }
        syncApply();
        hintLogin();
      });
      scanEl?.addEventListener("click", () => {
        if (busy2) {
          requestCancel();
          return;
        }
        void runProbe();
      });
      async function runProbe() {
        const list = urls();
        if (busy2 || list.length === 0) {
          return;
        }
        startBusy("Consultando os links…");
        showProgress("consulta", null, "lendo os links…");
        try {
          const fast = await fastLaneByIndex(list, () => cancelled);
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
          let result = {
            ok: true,
            error: null,
            log: "",
            ytdlpPath: null,
            cookies: null
          };
          if (slow.length > 0) {
            const scripted = await probeUrls(
              slow,
              config,
              (done, total, _percent, log) => {
                showProgress(`${done}/${total}`, null);
                showLog(log);
              },
              () => cancelled,
              showManual,
              showLog
            );
            result = { ...result, ...scripted.result };
            scripted.probes.forEach((probe2, at2) => byIndex.set(slowAt[at2], probe2));
          }
          if (cancelled) {
            probes = [];
            renderList();
            renderQualities();
            showLog("");
            context.setStatus("Consulta cancelada.", "idle");
            return;
          }
          probes = list.map((_, index) => byIndex.get(index)).filter((p) => !!p);
          renderList();
          renderQualities();
          const ok = probes.filter((probe2) => probe2.ok).length;
          showLog(ok === probes.length && result.ok ? "" : result.log);
          if (ok === 0) {
            context.setStatus(
              withCookieNote(
                describeRunError(result.error ?? "ytdlp-failed", result.log),
                result.cookies,
                result.log
              ),
              "error"
            );
          } else if (ok < probes.length) {
            context.setStatus(
              withCookieNote(`${ok} de ${probes.length} links lidos.`, result.cookies, result.log),
              "error"
            );
          } else {
            context.setStatus(
              withCookieNote(
                `${ok} ${ok === 1 ? "vídeo pronto" : "vídeos prontos"} para baixar.`,
                result.cookies
              ),
              "done"
            );
          }
          if (result.ytdlpPath && !config.ytdlpPath) {
            rememberFoundBinary(result.ytdlpPath);
          }
        } catch (cause) {
          context.setStatus(failureMessage("consultar os links", cause), "error");
        } finally {
          showProgress(null, null);
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
        if (busy2 || list.length === 0) {
          return;
        }
        const quality = findQuality(config.quality);
        startBusy(`Baixando em ${quality.label}…`);
        try {
          const direct = [];
          const slow = [];
          const fast = await fastLaneByIndex(list, () => cancelled);
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
          const fallback = await defaultDestination();
          const nowDestination = () => {
            const chosen = config.destination.trim();
            return {
              target: destinationOf(chosen || fallback, chosen ? config.destinationToken : ""),
              mayCreate: chosen === ""
            };
          };
          const tryPanel = async (job, step2) => {
            showProgress(step2, null, "conectando…");
            const { target: target2, mayCreate } = nowDestination();
            return downloadInPanel(
              job,
              target2,
              mayCreate,
              (done, size) => {
                showProgress(
                  step2,
                  size ? done / size * 100 : null,
                  size ? `${formatBytes$1(done)} de ${formatBytes$1(size)}` : formatBytes$1(done)
                );
              },
              () => cancelled
            );
          };
          for (let index = 0; index < direct.length; index += 1) {
            if (cancelled) {
              break;
            }
            const job = direct[index];
            const step2 = `${index + 1}/${total}`;
            try {
              panelFiles.push(await tryPanel(job, step2));
              continue;
            } catch (cause) {
              if (cancelled) {
                break;
              }
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
            files: [],
            cookies: null
          };
          if (!cancelled && (slow.length > 0 || scriptDirect.length > 0)) {
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
              showManual,
              showLog
            );
            outcome = { ...outcome, ...scripted };
          }
          const files = [...panelFiles, ...outcome.files];
          void rememberDownloads(files, [...direct, ...scriptDirect], list, nowDestination().target.path);
          showProgress(null, null);
          showLog(outcome.ok && outcome.failed === 0 ? "" : outcome.log);
          if (cancelled) {
            await finishCancelled(files, outcome.error === "cancelled");
            return;
          }
          if (files.length === 0) {
            context.setStatus(
              withCookieNote(
                describeRunError(outcome.error ?? "ytdlp-failed", outcome.log),
                outcome.cookies,
                outcome.log
              ),
              "error"
            );
            return;
          }
          const imported = config.importToProject ? await importFiles(files) : null;
          const count = files.length;
          const head = `${count} ${count === 1 ? "arquivo baixado" : "arquivos baixados"}` + (outcome.failed > 0 ? ` · ${outcome.failed} falharam` : "");
          context.setStatus(
            withCookieNote(
              imported === null ? head : `${head} · ${imported}`,
              outcome.cookies,
              outcome.failed > 0 ? outcome.log : void 0
            ),
            outcome.failed > 0 ? "error" : "done"
          );
          renderFiles(files);
          context.setResetHandler(() => clearAll());
        } catch (cause) {
          context.setStatus(failureMessage("baixar", cause), "error");
        } finally {
          endBusy();
        }
      });
      async function finishCancelled(files, scriptWasRunning) {
        const note2 = scriptWasRunning ? describeRunError("cancelled", "") : "Download cancelado.";
        if (files.length === 0) {
          context.setStatus(note2, "idle");
          return;
        }
        const count = files.length;
        const saved = `${count} ${count === 1 ? "arquivo já estava salvo" : "arquivos já estavam salvos"}`;
        const imported = config.importToProject ? await importFiles(files) : null;
        context.setStatus(
          imported === null ? `${note2} ${saved}.` : `${note2} ${saved} · ${imported}.`,
          "idle"
        );
        renderFiles(files);
        context.setResetHandler(() => clearAll());
      }
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
        busy2 = true;
        cancelled = false;
        hideManual();
        context.setStatus(message);
        context.setApplyEnabled(false);
        setScanBusy(true);
        if (installEl) setDisabled(installEl, true);
      }
      function endBusy() {
        busy2 = false;
        cancelled = false;
        setScanBusy(false);
        if (installEl) setDisabled(installEl, false);
        syncApply();
      }
      function setScanBusy(running) {
        if (!scanEl) return;
        scanEl.classList.toggle("is-busy", running);
        scanEl.textContent = running ? "Cancelar" : "Analisar links";
        setDisabled(scanEl, running ? false : urls().length === 0);
      }
      function requestCancel() {
        if (!busy2 || cancelled) {
          return;
        }
        cancelled = true;
        context.setStatus("Cancelando…");
        if (scanEl) setDisabled(scanEl, true);
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
        listEl.innerHTML = probes.map((probe2) => probeRow(probe2, config.quality)).join("");
      }
      function renderFiles(files) {
        if (!listEl || files.length === 0) return;
        listEl.innerHTML = '<p class="dl-done-title">Baixado ✓</p>' + files.map(
          (file) => `<div class="dl-file" title="${escapeHtml(file)}"><span class="dl-file-name">${escapeHtml(baseName(file))}</span></div>`
        ).join("");
      }
      function renderDestination() {
        if (destEl) {
          const shown = config.destination || defaultShown;
          destEl.textContent = config.destination ? config.destination : shown ? `${shown} (pasta padrão)` : "(pasta padrão)";
          destEl.title = shown;
        }
      }
      pickEl?.addEventListener("click", () => void pickFolder());
      async function pickFolder() {
        try {
          const picked = await pickAndSave("download");
          if (!picked) {
            return;
          }
          config.destination = picked.path;
          config.destinationToken = picked.token;
          persist();
          renderDestination();
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          context.setStatus(
            reason === NO_PICKER ? "Este build do Premiere não abre o seletor de pastas." : `Não deu para escolher a pasta: ${reason}`,
            "error"
          );
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
        if (busy2) return;
        startBusy("Baixando o yt-dlp…");
        if (installEl) installEl.textContent = "Baixando…";
        try {
          const result = await installYtdlp(showManual, () => cancelled);
          showLog(result.log);
          if (result.ok && result.ytdlpPath) {
            rememberFoundBinary(result.ytdlpPath);
            context.setStatus("yt-dlp instalado na pasta do plugin.", "done");
          } else {
            context.setStatus(
              describeRunError(result.error, result.log),
              result.error === "install-cancelled" ? "idle" : "error"
            );
          }
        } catch (cause) {
          context.setStatus(failureMessage("instalar o yt-dlp", cause), "error");
        } finally {
          if (installEl) installEl.textContent = "Reinstalar yt-dlp";
          endBusy();
        }
      }
      folderEl?.addEventListener("click", () => {
        void openWorkFolder().catch((cause) => {
          context.setStatus(failureMessage("abrir a pasta", cause), "error");
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
      cancelActiveRun$1 = () => {
        cancelled = true;
      };
    },
    unmount() {
      cancelActiveRun$1?.();
      cancelActiveRun$1 = null;
      releaseDocument$3?.();
      releaseDocument$3 = null;
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
  const FAILURES = [
    {
      // O `fs` do UXP roteia por esquema; caminho nativo cai fora da rota
      // e volta com este nome interno. Ver silence/workspace.ts — a
      // mensagem não fala de permissão, não fala de caminho, e apareceu
      // na barra de status como a única explicação de um download que não
      // aconteceu.
      test: /route not found/i,
      message: "Este build do Premiere não deixou o plugin escrever na pasta de trabalho. Feche e reabra o painel; se continuar, reinstale o plugin."
    },
    {
      test: /nenhum caminho gravável|require\("fs"\)|shell não resolveu|storage do UXP/i,
      message: "O Premiere não deu ao plugin uma pasta onde trabalhar. Feche e reabra o painel; se continuar, reinstale o plugin."
    },
    {
      test: /^destino:|não abre o seletor|sem pasta-mãe/i,
      message: 'A pasta de destino não aceitou a escrita. Escolha a pasta de novo em "Destino › Escolher…".'
    },
    {
      test: /^rede:|failed to fetch|networkerror|net::|ENOTFOUND|ECONNRESET|timed? ?out/i,
      message: "A conexão caiu no meio do caminho. Confira a internet e tente de novo."
    }
  ];
  function failureMessage(step2, cause) {
    const raw = describeError$1(cause).trim();
    console.error(`[Download] falha ao ${step2}:`, cause);
    const known2 = FAILURES.find((failure) => failure.test.test(raw));
    if (known2) {
      return known2.message;
    }
    return raw ? `Falha ao ${step2}: ${/[.!?]$/.test(raw) ? raw : `${raw}.`}` : `Falha ao ${step2}.`;
  }
  function qualityMeta(quality, probes) {
    const ok = probes.filter((probe2) => probe2.ok);
    if (ok.length === 0) {
      return "";
    }
    if (quality.audioOnly) {
      return "só o áudio";
    }
    const size = formatBytes$1(
      ok.reduce((sum2, probe2) => sum2 + estimateFor(probe2, quality), 0)
    );
    const delivered = new Set(ok.map((probe2) => effectiveResolution(probe2, quality)));
    const single = delivered.size === 1 ? [...delivered][0] : null;
    const shown = single !== null && single !== quality.height ? `${single}p` : "";
    return [shown, size].filter((part) => part.length > 0).join(" · ");
  }
  function estimateFor(probe2, quality) {
    const chosen = effectiveResolution(probe2, quality);
    return chosen === null ? 0 : probe2.sizeByResolution[chosen] ?? 0;
  }
  function effectiveResolution(probe2, quality) {
    const list = probe2.resolutions;
    if (list.length === 0) {
      return null;
    }
    return quality.height === null ? list[0] : list.find((value) => value <= quality.height) ?? list[list.length - 1];
  }
  function probeRow(probe2, qualityId) {
    if (!probe2.ok) {
      return `<div class="dl-row is-bad"><span class="dl-row-name">${escapeHtml(shorten(probe2.url))}</span><span class="dl-row-meta">${escapeHtml(probe2.error ?? "não foi possível ler")}</span></div>`;
    }
    const quality = findQuality(qualityId);
    const size = formatBytes$1(estimateFor(probe2, quality));
    const clock2 = formatClock(probe2.durationSeconds);
    const top = probe2.resolutions[0] ? `${probe2.resolutions[0]}p` : "";
    const meta = [probe2.site, clock2, top, size].filter((part) => part.length > 0).join(" · ");
    return `<div class="dl-row"><span class="dl-row-name" title="${escapeHtml(probe2.title)}">${escapeHtml(
      probe2.title
    )}</span><span class="dl-row-meta">${escapeHtml(meta)}</span>` + (probe2.hadWatermarked ? `<span class="dl-row-tag">sem marca d'água</span>` : "") + "</div>";
  }
  function shorten(value) {
    return value.length > 64 ? `${value.slice(0, 61)}…` : value;
  }
  function baseName(path) {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }
  function markup$6() {
    return `<div class="zones"><div class="zone is-wide"><div class="field"><div class="field-head"><span class="t-label">Links</span></div><textarea class="dl-urls" data-urls spellcheck="false" rows="3" placeholder="Cole os links do YouTube, TikTok ou Instagram — um por linha"></textarea><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar links</div></div><div class="sil-manual" data-manual hidden></div><div class="dl-list" data-list></div><div class="dl-progress" data-progress hidden></div><pre class="dl-log" data-log hidden></pre></div></div><div class="zone"><div class="field"><span class="t-label">Qualidade</span><div data-quality-pick></div></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Destino</span><span class="field-action" ${CONTROL} data-pick>Escolher…</span></div><p class="dl-dest" data-dest></p></div><div class="field"><span class="t-label">Importar para o projeto</span><div class="seg" data-import-seg><div class="seg-item" ${CONTROL} data-import="on">Sim</div><div class="seg-item" ${CONTROL} data-import="off">Não</div></div></div></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">Ajustes avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><span class="t-label" title="Para vídeo com restrição de idade ou quando o site pede login. Use o navegador onde você já está logado.">Cookies do navegador</span><div data-cookies-pick></div></div><div class="field"><div class="field-head"><span class="t-label" title="Não precisa instalar nada: na primeira vez o painel baixa sozinho o yt-dlp e o ffmpeg oficiais para a pasta do plugin.">Caminho do yt-dlp</span><span class="field-action" ${CONTROL} data-open-folder>Abrir pasta</span></div><div class="sil-ffmpeg-group"><input type="text" class="sil-path" data-ytdlp-path spellcheck="false" placeholder="deixe vazio para procurar sozinho"><div class="org-scan" ${CONTROL} data-install>Reinstalar yt-dlp</div></div></div></div></div></div>`;
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
  function planFillers(words2, range, params, frameSeconds2) {
    const total = range.end - range.start;
    if (!(total > 0)) {
      return empty();
    }
    const frame = frameSeconds2 > 0 ? frameSeconds2 : 1 / 30;
    const minRemoval = Math.max(MIN_REMOVAL_SECONDS, frame * 2);
    const inRange = words2.filter((word) => word.end > range.start && word.start < range.end).map((word) => ({
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
    const keep2 = [];
    let cursor = range.start;
    for (const cut of drop) {
      if (cut.start - cursor > 1e-6) {
        keep2.push({ start: cursor, end: cut.start });
      }
      cursor = cut.end;
    }
    if (range.end - cursor > 1e-6) {
      keep2.push({ start: cursor, end: range.end });
    }
    const removedSeconds = drop.reduce((sum2, cut) => sum2 + (cut.end - cut.start), 0);
    return {
      keep: keep2,
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
  let snapshot$1 = null;
  const fillerSettings = createToolSettings(
    "fillers-config.json",
    FILLER_DEFAULTS,
    (raw) => ({
      useTags: raw.useTags !== false,
      stretchedSeconds: clampNumber(raw.stretchedSeconds, 0, 1, FILLER_DEFAULTS.stretchedSeconds),
      padSeconds: clampNumber(raw.padSeconds, 0, 0.4, FILLER_DEFAULTS.padSeconds)
    })
  );
  warmToolSettings(fillerSettings);
  function mensagemDeFalha$1(cause) {
    const cru = cause instanceof Error ? cause.message : String(cause);
    console.error("[Muletas] a varredura falhou:", cause);
    if (/no longer valid/i.test(cru)) {
      return "O Premiere trocou a sequência embaixo do painel. Selecione os clipes de novo e analise.";
    }
    if (/route not found|no such file|ENOENT/i.test(cru)) {
      return "Não consegui chegar na pasta de trabalho do plugin. Reabra o painel.";
    }
    if (/transcri|transcript/i.test(cru)) {
      return "Não achei a transcrição do clipe. Use a janela Texto → Transcrever no Premiere e analise de novo.";
    }
    return `Falha ao analisar: ${cru}`;
  }
  const fillersTool = {
    id: "fillers",
    name: "Cortar Muletas",
    summary: "Remove os ééé e aaamm da fala",
    hint: "Selecione os clipes falados e analise. Usa a transcrição do Premiere (janela Texto → Transcrever) — só as muletas caem, o resto da fala e as pausas ficam como estão.",
    category: "edicao",
    glyph: "speech",
    available: true,
    mount(container, context) {
      const params = { ...fillerSettings.peek() ?? FILLER_DEFAULTS };
      let scan = null;
      let plans = /* @__PURE__ */ new Map();
      let scanning = false;
      container.innerHTML = markup$5(params);
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
      context.setResetHandler(snapshot$1 ? () => void runUndo() : null);
      function syncOutputs() {
        padSlider?.set(params.padSeconds);
        stretchSlider?.set(params.stretchedSeconds);
        for (const item of tagSeg?.querySelectorAll(".seg-item") ?? []) {
          item.setAttribute(
            "aria-pressed",
            String(item.dataset.tag === "on" === params.useTags)
          );
        }
        fillerSettings.patch({ ...params });
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
      void fillerSettings.read().then((stored) => {
        if (!container.isConnected) {
          return;
        }
        params.useTags = stored.useTags;
        params.padSeconds = stored.padSeconds;
        params.stretchedSeconds = stored.stretchedSeconds;
        syncOutputs();
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
          context.setStatus(mensagemDeFalha$1(cause), "error");
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
          total > 0 ? `${total} ${total === 1 ? "muleta encontrada" : "muletas encontradas"} · ${formatSeconds$1(removed)} a remover` : "Nenhuma muleta encontrada na seleção.",
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
          snapshot$1 = result.snapshot;
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
        if (!snapshot$1) return;
        context.setStatus("Desfazendo…");
        const result = await undoCuts(snapshot$1);
        context.setStatus(result.message, result.ok ? "done" : "error");
        if (result.ok) {
          snapshot$1 = null;
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
          meta = `<span class="sil-row-cuts">${hits.length} ${hits.length === 1 ? "muleta" : "muletas"}</span><span class="sil-row-time">−${formatSeconds$1(plan?.removedSeconds ?? 0)}</span>`;
        }
        let html = `<div class="sil-row-group"><div class="sil-row${hits.length > 0 ? " is-ready" : ""}"><span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
          clip.name
        )}</span>${meta}</div>`;
        if (hits.length > 0) {
          html += '<div class="fl-hits">';
          for (const hit of hits) {
            const at2 = formatSeconds$1(Math.max(0, hit.start - clip.sourceStart));
            html += `<span class="fl-hit is-${hit.reason}" title="${REASON_LABELS[hit.reason]}"><b>${escapeHtml(hit.text || "(sem texto)")}</b>${at2}</span>`;
          }
          html += "</div>";
        }
        return html + "</div>";
      }
      syncOutputs();
      context.setRefreshHandler(null);
    },
    unmount() {
      void fillerSettings.flush();
      cancelActiveScan?.();
      cancelActiveScan = null;
      padSlider?.destroy();
      padSlider = null;
      stretchSlider?.destroy();
      stretchSlider = null;
    }
  };
  function markup$5(params) {
    return `<div class="zones"><div class="zone"><div class="field"><div class="field-head"><span class="t-label" title="Quanto de ar cai junto com cada muleta. A margem avança pelo silêncio vizinho e para na palavra ao lado — nunca morde fala.">Margem ao redor</span><span class="field-val" data-out-pad>${params.padSeconds.toFixed(2)}s</span></div><div class="slider-row"><div data-pad></div></div></div><div class="field"><div class="field-head"><span class="t-label" title="Um &quot;é&quot; ou &quot;ah&quot; mais longo que isso é hesitação, não palavra. Zero desliga — aí só sons inequívocos (ééé, hum) e a tag cortam.">Esticado a partir de</span><span class="field-val" data-out-stretch>${params.stretchedSeconds.toFixed(2)}s</span></div><div class="slider-row"><div data-stretch></div></div></div><div class="field"><span class="t-label" title="O que o próprio Premiere marcou como muleta. Desligue se o &quot;né&quot; faz parte do jeito de falar do vídeo.">Tag da transcrição (né, tipo…)</span><div class="seg" data-tag-seg><div class="seg-item" ${CONTROL} data-tag="on">Cortar</div><div class="seg-item" ${CONTROL} data-tag="off">Manter</div></div></div></div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para analisar</p><p class="sil-empty-desc">Selecione os clipes falados na timeline. É preciso que estejam transcritos (janela Texto → Transcrever sequência).</p></div><div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div><div class="sil-report" data-report></div></div></div>`;
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
      const words2 = mergeTokens(tokens, offsetSeconds);
      if (words2.length === 0) {
        continue;
      }
      segments.push({
        start: num(segment.offsets?.from, 0) / 1e3 + offsetSeconds,
        words: words2
      });
    }
    return { version: "1.0.0", segments };
  }
  function mergeTokens(tokens, offsetSeconds = 0) {
    const words2 = [];
    let current2 = null;
    const flush = () => {
      if (!current2) {
        return;
      }
      const text2 = current2.text.trim();
      if (text2 && !/[\p{L}\p{N}]/u.test(text2) && words2.length > 0) {
        const previous = words2[words2.length - 1];
        previous.text += text2;
        previous.duration = Math.max(
          previous.duration,
          current2.end - previous.start
        );
        current2 = null;
        return;
      }
      if (text2) {
        words2.push({
          text: text2,
          start: round$1(current2.start),
          // Duração nunca zero: o Premiere trata um span degenerado como
          // ausência de tempo e a palavra some da legenda.
          duration: round$1(Math.max(8e-3, current2.end - current2.start)),
          type: "word",
          confidence: round$1(
            current2.ps.reduce((sum2, p) => sum2 + p, 0) / current2.ps.length
          ),
          tags: []
        });
      }
      current2 = null;
    };
    for (const token of tokens) {
      const raw = typeof token.text === "string" ? token.text : "";
      if (!raw.trim() || isMarker(raw)) {
        continue;
      }
      const start = num(token.offsets?.from, 0) / 1e3 + offsetSeconds;
      const end = num(token.offsets?.to, num(token.offsets?.from, 0)) / 1e3 + offsetSeconds;
      const probability = Math.min(1, Math.max(0, num(token.p, 1)));
      if (raw.startsWith(" ") || current2 === null) {
        flush();
        current2 = { text: raw.trim(), start, end, ps: [probability] };
      } else {
        current2.text += raw;
        current2.end = Math.max(current2.end, end);
        current2.ps.push(probability);
      }
    }
    flush();
    return words2;
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
  function fold$1(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) {
      return limit + 1;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const current2 = [i];
      let best = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const value = Math.min(
          previous[j] + 1,
          current2[j - 1] + 1,
          previous[j - 1] + cost
        );
        current2.push(value);
        if (value < best) {
          best = value;
        }
      }
      if (best > limit) {
        return limit + 1;
      }
      previous = current2;
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
      const folded = fold$1(display);
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
      const words2 = [];
      let index = 0;
      while (index < segment.words.length) {
        let matched = false;
        for (let span = Math.min(maxSpan, segment.words.length - index); span >= 1 && !matched; span -= 1) {
          const window2 = segment.words.slice(index, index + span);
          const joined = window2.map((word) => word.text).join(" ");
          const folded = fold$1(joined);
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
            words2.push({
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
          words2.push(segment.words[index]);
          index += 1;
        }
      }
      return { start: segment.start, words: words2 };
    });
    return {
      transcript: { version: transcript.version, segments },
      corrections
    };
  }
  const FAMILIES$1 = {
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
  const BASE_GLOSSARY = Object.values(FAMILIES$1).flat().join("\n");
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
  const TIMING_FILE = "cc-timing.txt";
  const OUT_BASE = "cc-out";
  const AUDIO_FILE = "cc-audio.wav";
  const PROBE_FILE = "cc-probe.wav";
  const DETECT_FILE = "cc-detect.txt";
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
      megabytes: 181,
      beamSize: 5
    },
    {
      id: "turbo",
      label: "Equilibrado",
      note: "547 MB · o recomendado — 10 min de vídeo em ~3 min",
      file: "ggml-large-v3-turbo-q5_0.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
      megabytes: 547,
      beamSize: 3
    },
    {
      id: "large",
      label: "Máxima",
      note: "1 GB · bem mais lento, e nos testes não acertou mais que o Equilibrado",
      file: "ggml-large-v3-q5_0.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
      megabytes: 1031,
      beamSize: 2
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
  function readTiming(space, timingFile) {
    const raw = readText$1(space, timingFile);
    if (!raw) return null;
    const [gasto, audio] = raw.split(/\s+/).map((n) => Number.parseFloat(n));
    return Number.isFinite(gasto) && Number.isFinite(audio) ? { elapsedSeconds: gasto, audioSeconds: audio } : null;
  }
  let previousRunFiles = [];
  async function transcribe(job, model, language, prompt, onStage, cancelled, onManual) {
    const shell = shellModule();
    if (!shell) {
      return { ok: false, error: "uxp-unavailable", json: null, scriptPath: null };
    }
    const space = await workspace();
    const tag = Date.now().toString(36);
    const run2 = {
      result: `cc-${tag}-result.json`,
      stage: `cc-${tag}-stage.txt`,
      started: `cc-${tag}-started.txt`,
      log: `cc-${tag}-whisper.log`,
      timing: `cc-${tag}-timing.txt`,
      outBase: `cc-${tag}-out`,
      audio: `cc-${tag}-audio.wav`,
      probe: `cc-${tag}-probe.wav`,
      detect: `cc-${tag}-detect.txt`,
      script: scriptName(tag)
    };
    const outJson = `${run2.outBase}.json`;
    const scriptPath = nativePath(space, run2.script);
    for (const name of [
      ...previousRunFiles,
      RESULT_FILE,
      STAGE_FILE,
      STARTED_FILE,
      WHISPER_LOG,
      TIMING_FILE,
      `${OUT_BASE}.json`,
      AUDIO_FILE,
      PROBE_FILE,
      DETECT_FILE,
      SCRIPT_FILE,
      SCRIPT_FILE_WIN
    ]) {
      await remove(space, name);
    }
    previousRunFiles = [...Object.values(run2), outJson];
    const script = (isWindows() ? windowsScript(job, model, language, space.nativeBase, prompt) : unixScript(job, model, language, space.nativeBase, prompt)).split(RESULT_FILE).join(run2.result).split(STAGE_FILE).join(run2.stage).split(STARTED_FILE).join(run2.started).split(WHISPER_LOG).join(run2.log).split(TIMING_FILE).join(run2.timing).split(AUDIO_FILE).join(run2.audio).split(PROBE_FILE).join(run2.probe).split(DETECT_FILE).join(run2.detect).split(OUT_BASE).join(run2.outBase);
    await write(space, run2.script, script, true);
    const PURPOSE = "Transcrever o áudio das faixas escolhidas.";
    let launchError = null;
    const sent = await dispatch(run2.script);
    let awaitingStamp = sent.mode !== "denied";
    if (!awaitingStamp) {
      console.error("[Legendas] agente recusado:", sent.error);
      try {
        await shell.openPath(scriptPath, PURPOSE);
      } catch (cause) {
        launchError = describe$5(cause);
        onManual?.(scriptPath, launchError);
      }
    }
    let stampDeadline = Date.now() + 8e3;
    const BUSY_GRACE_MS = 8e3;
    const BUSY_LIMIT = Date.now() + 18e4;
    const deadline = Date.now() + TIMEOUT_MS;
    let lastStage = "";
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        return { ok: false, error: "cancelled", json: null, scriptPath };
      }
      if (awaitingStamp && Date.now() > stampDeadline) {
        const verdict = await stampVerdict();
        if (verdict === "busy" && Date.now() < BUSY_LIMIT) {
          stampDeadline = Date.now() + BUSY_GRACE_MS;
          console.log("[Legendas] na fila: o agente está com outro trabalho.");
        } else if (!readText$1(space, run2.started)) {
          awaitingStamp = false;
          await withdraw(sent.ticket);
          try {
            await shell.openPath(scriptPath, PURPOSE);
          } catch (cause) {
            launchError = describe$5(cause);
            onManual?.(scriptPath, launchError);
          }
        } else {
          awaitingStamp = false;
        }
      }
      const stage = readText$1(space, run2.stage);
      const percent = stage?.startsWith("Transcrevendo") ? whisperProgress(space, run2.log) : null;
      const shown = percent === null ? stage : `${stage} ${percent}%`;
      if (shown && shown !== lastStage) {
        lastStage = shown;
        onStage?.(shown);
      }
      const raw = readText$1(space, run2.result);
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
          if (cancelled?.()) {
            return { ok: false, error: "cancelled", json: null, scriptPath };
          }
          return {
            ok: true,
            error: null,
            json: readJson(space, outJson),
            scriptPath,
            timing: readTiming(space, run2.timing)
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
  function whisperProgress(space, logFile) {
    const log = readText$1(space, logFile);
    if (!log) return null;
    const hits = log.match(/progress\s*=\s*(\d+)%/g);
    if (!hits) return null;
    const last = /(\d+)%/.exec(hits[hits.length - 1]);
    return last ? Number.parseInt(last[1], 10) : null;
  }
  function readJson(space, name) {
    const raw = readText$1(space, name);
    if (!raw) {
      console.error("[Legendas] whisper terminou mas não deixou JSON.");
      return null;
    }
    return raw;
  }
  function scriptName(tag) {
    const base = isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
    return tag ? base.replace(".", `-${tag}.`) : base;
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
      `"$FFMPEG" -v error -y ` + job.inputs.map((args) => args.map(q).join(" ")).join(" ") + ` -filter_complex ${q(job.filter)} -map "[out]" -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/${AUDIO_FILE}" || fail audio-extract`,
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
        // O `-dl` só olha os primeiros 30s, mas LÊ o arquivo inteiro
        // antes de decidir isso: numa faixa de uma hora são ~115 MB
        // de PCM carregados para usar meio por cento deles. Um
        // recorte custa centésimos de segundo e poupa a leitura.
        `"$FFMPEG" -v error -y -t 30 -i "$WORK/${AUDIO_FILE}" -c copy "$WORK/${PROBE_FILE}" 2>/dev/null || cp "$WORK/${AUDIO_FILE}" "$WORK/${PROBE_FILE}"`,
        `DET=$("$WHISPER" -m "$MODEL" -f "$WORK/${PROBE_FILE}" -dl 2>&1 || true)`,
        `rm -f "$WORK/${PROBE_FILE}"`,
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
        `  rm -f "$WORK/${AUDIO_FILE}"`,
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
       * Flash attention: de graça, quando o binário tem.
       *
       * Nas builds recentes do whisper.cpp o `-fa` acelera a atenção no
       * Metal sem mexer no resultado. Nas antigas ele não existe — e um
       * argumento desconhecido não é ignorado, o whisper MORRE nele. Daí
       * a pergunta ao `--help` antes: quem tem, usa; quem não tem, roda
       * como rodava.
       */
      `FA=""; "$WHISPER" --help 2>&1 | grep -q -- "-fa" && FA="-fa"`,
      // O relógio de parede desta etapa, para o painel poder dizer
      // "3 min para 10 min de áudio" em vez de só "demorou".
      "T0=$(date +%s)",
      /*
       * `-pp` é uma BANDEIRA. Escrito `-pp false`, o `false` virava um
       * segundo arquivo de entrada ("input file not found 'false'") — o
       * whisper reclamava e seguia, mas o progresso nunca chegou ao
       * painel. O stderr vai para o log, não para o nada: é dele que
       * saem o percentual e o diagnóstico de lentidão.
       */
      `"$WHISPER" -m "$MODEL" -f "$WORK/${AUDIO_FILE}" -l ${q(language)} -t "$THREADS" $FA -bs ${model.beamSize} -bo ${model.beamSize} -sns -et 2.4 -lpt -1.0 ` + (prompt ? `--prompt ${q(prompt)} ` : "") + `-ojf -of "$WORK/${OUT_BASE}" -pp >/dev/null 2>"$WORK/${WHISPER_LOG}" || fail whisper-failed`,
      // Quanto levou, e para quantos segundos de áudio. É o número que
      // transforma "está lento" em algo que dá para conferir.
      `printf '%s %s' "$(( $(date +%s) - T0 ))" ${q(job.durationSeconds.toFixed(1))} > "$WORK/${TIMING_FILE}"`,
      `if [ ! -f "$WORK/${OUT_BASE}.json" ]; then fail no-output; fi`,
      // O WAV de 16 kHz de uma hora de fala são ~115 MB; some assim que
      // vira transcrição.
      `rm -f "$WORK/${AUDIO_FILE}"`,
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
    const emit = (json, indent = "") => [
      `${indent}>"%WORK%\\${RESULT_FILE}.tmp" echo ${json}`,
      `${indent}move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`
    ];
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
      ...emit('{"ok":false,"error":"ffmpeg-not-found"}', "  "),
      "  exit /b 1",
      ")",
      'set "WHISPER="',
      'for %%i in (whisper-cli.exe) do @set "WHISPER=%%~$PATH:i"',
      'if "%WHISPER%"=="" (',
      ...emit('{"ok":false,"error":"whisper-not-found"}', "  "),
      "  exit /b 1",
      ")",
      `set "MODEL=%WORK%\\${bat(model.file)}"`,
      /*
       * O modelo baixa para `.tmp` e só então vira o nome final — o
       * mesmo `curl -o "$MODEL.tmp"` do macOS.
       *
       * Escrevendo direto no nome final, uma internet que caiu no meio
       * do gigabyte deixava o arquivo truncado LÁ, e a execução seguinte
       * só olhava `if not exist`: o modelo "existia", o whisper morria
       * ao carregá-lo, e o painel dizia whisper-failed — uma falha de
       * rede vestida de falha do motor, que não se conserta sozinha
       * nunca mais, porque o download nunca mais é tentado.
       *
       * `if errorlevel 1` e não `%ERRORLEVEL%`: dentro de um bloco entre
       * parênteses o segundo é expandido na hora de LER o bloco, quando
       * o curl ainda nem rodou. (Como o resto do .bat, não testado num
       * Windows real.)
       */
      'if not exist "%MODEL%" (',
      `  >"%WORK%\\${STAGE_FILE}" echo Baixando o modelo (${model.megabytes} MB)...`,
      `  curl.exe -fsSL --retry 3 -o "%MODEL%.tmp" "${model.url}"`,
      "  if errorlevel 1 (",
      `    del /q "%MODEL%.tmp" 2>nul`,
      ...emit('{"ok":false,"error":"model-download"}', "    "),
      "    exit /b 1",
      "  )",
      `  move /y "%MODEL%.tmp" "%MODEL%" >nul`,
      ")",
      `>"%WORK%\\${STAGE_FILE}" echo Montando o audio da faixa...`,
      `"%FFMPEG%" -v error -y ` + job.inputs.map((args) => args.map((a) => `"${bat(a)}"`).join(" ")).join(" ") + ` -filter_complex "${bat(job.filter)}" -map "[out]" -t ${job.durationSeconds.toFixed(6)} -vn -ac 1 -ar 16000 -c:a pcm_s16le "%WORK%\\${AUDIO_FILE}"`,
      "if errorlevel 1 (",
      ...emit('{"ok":false,"error":"audio-extract"}', "  "),
      "  exit /b 1",
      ")",
      /*
       * O MESMO gate de idioma do macOS, pelo mesmo motivo: forçar `-l fr`
       * num áudio em português não dá erro, dá francês inventado com
       * pontuação perfeita — minutos de motor para produzir uma tradução
       * que ninguém pediu. Detectar custa ~4s contra isso.
       *
       * Duas diferenças de tradução para o cmd, ambas sem Windows real
       * para conferir (vale para o arquivo inteiro):
       *  · `!VAR:*texto=!` corta tudo até o texto, inclusive — é o que o
       *    `sed` faz do outro lado, e não depende do prefixo que o
       *    whisper imprime antes de "auto-detected language:".
       *  · o cmd não compara número com ponto. `gtr` entre "0.99" e
       *    "0.70" é comparação de TEXTO, que dá o mesmo resultado aqui
       *    porque o whisper sempre imprime a probabilidade com um dígito
       *    antes do ponto.
       */
      ...language === "auto" ? [] : [
        `>"%WORK%\\${STAGE_FILE}" echo Conferindo o idioma...`,
        // O `-dl` só olha os primeiros 30s, mas lê o arquivo inteiro
        // antes de decidir isso. O recorte poupa a leitura.
        `"%FFMPEG%" -v error -y -t 30 -i "%WORK%\\${AUDIO_FILE}" -c copy "%WORK%\\${PROBE_FILE}" 2>nul`,
        `if not exist "%WORK%\\${PROBE_FILE}" copy /y "%WORK%\\${AUDIO_FILE}" "%WORK%\\${PROBE_FILE}" >nul`,
        `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\${PROBE_FILE}" -dl >"%WORK%\\${DETECT_FILE}" 2>&1`,
        `del /q "%WORK%\\${PROBE_FILE}" 2>nul`,
        "setlocal enabledelayedexpansion",
        'set "DETLINE="',
        'set "DETLANG="',
        'set "DETP="',
        `for /f "delims=" %%L in ('findstr /c:"auto-detected language" "%WORK%\\${DETECT_FILE}"') do set "DETLINE=%%L"`,
        'set "DETREST=!DETLINE:*auto-detected language: =!"',
        // `pt (p = 0.99)` com espaço e parênteses por delimitador:
        // token 1 é o idioma, token 4 é a probabilidade.
        'for /f "tokens=1,4 delims= ()" %%a in ("!DETREST!") do (set "DETLANG=%%a" & set "DETP=%%b")',
        // Detecção muda ou insegura: quem manda é a escolha do editor.
        'if "!DETLANG!"=="" goto :cc_lang_ok',
        `if /i "!DETLANG!"=="${bat(language)}" goto :cc_lang_ok`,
        'if not "!DETP!" gtr "0.70" goto :cc_lang_ok',
        `>"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"language-mismatch","detected":"!DETLANG!","p":"!DETP!"}`,
        `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
        `del /q "%WORK%\\${AUDIO_FILE}" 2>nul`,
        "endlocal",
        "exit /b 1",
        ":cc_lang_ok",
        "endlocal"
      ],
      `>"%WORK%\\${STAGE_FILE}" echo Transcrevendo...`,
      // O feixe vem do modelo, não de um 5 fixo: é o mesmo botão de
      // velocidade que o macOS usa, e num modelo grande ele é o
      // principal responsável pela espera.
      `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\${AUDIO_FILE}" -l ${bat(language)} -bs ${model.beamSize} -bo ${model.beamSize} -sns -et 2.4 -lpt -1.0 ` + (prompt ? `--prompt "${bat(prompt)}" ` : "") + `-ojf -of "%WORK%\\${OUT_BASE}" -pp >nul 2>"%WORK%\\${WHISPER_LOG}"`,
      "if errorlevel 1 (",
      ...emit('{"ok":false,"error":"whisper-failed"}', "  "),
      "  exit /b 1",
      ")",
      `del /q "%WORK%\\${AUDIO_FILE}" 2>nul`,
      ...emit('{"ok":true}'),
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
    const words2 = [];
    for (const segment of transcript.segments) {
      for (const word of segment.words) {
        const text2 = word.text.trim();
        if (text2) {
          words2.push({ text: text2, start: word.start, end: word.start + word.duration });
        }
      }
    }
    words2.sort((a, b) => a.start - b.start);
    if (words2.length === 0) {
      return [];
    }
    const capacity = Math.max(1, options.maxLineChars * options.maxLines);
    const cues = [];
    let current2 = [];
    const flush = () => {
      if (current2.length === 0) {
        return;
      }
      const start = current2[0].start;
      const spoken = current2[current2.length - 1].end;
      const lines = wrap(current2.map((word) => word.text).join(" "), options);
      const chars = lines.join(" ").length;
      const toRead = options.readingCps > 0 ? chars / options.readingCps : 0;
      cues.push({
        start,
        end: Math.max(spoken, start + options.minCueSeconds, start + toRead),
        lines,
        spokenEnd: spoken
      });
      current2 = [];
    };
    for (let index = 0; index < words2.length; index += 1) {
      const word = words2[index];
      if (current2.length > 0) {
        const grown = current2.map((entry) => entry.text).join(" ").length + 1 + word.text.length;
        if (grown > capacity) {
          flush();
        }
      }
      current2.push(word);
      const text2 = current2.map((entry) => entry.text).join(" ");
      const next = words2[index + 1];
      const elapsed = word.end - current2[0].start;
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
    const words2 = text2.split(" ");
    const lines = [];
    let line = "";
    for (let index = 0; index < words2.length; index += 1) {
      const word = words2[index];
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > options.maxLineChars && line) {
        if (lines.length === limit - 1) {
          return [...lines, [line, ...words2.slice(index)].join(" ")];
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
  const DEFAULTS$1 = {
    model: "turbo",
    language: "pt",
    glossary: "",
    track: "all",
    srt: { ...SRT_DEFAULTS },
    srtDestination: "",
    srtDestinationToken: ""
  };
  async function readConfig() {
    try {
      const raw = readText$1(await workspace(), CONFIG_FILE);
      if (!raw) {
        return { ...DEFAULTS$1 };
      }
      const parsed = JSON.parse(raw);
      return {
        model: typeof parsed.model === "string" ? parsed.model : DEFAULTS$1.model,
        language: typeof parsed.language === "string" ? parsed.language : DEFAULTS$1.language,
        glossary: typeof parsed.glossary === "string" ? parsed.glossary : "",
        track: typeof parsed.track === "number" || parsed.track === "all" ? parsed.track : "all",
        srt: readSrt(parsed.srt),
        srtDestination: typeof parsed.srtDestination === "string" ? parsed.srtDestination : "",
        srtDestinationToken: typeof parsed.srtDestinationToken === "string" ? parsed.srtDestinationToken : ""
      };
    } catch {
      return { ...DEFAULTS$1 };
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
      const raw = readText$1(await workspace(), SNAPSHOT_FILE);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  async function writeSnapshot$1(mediaPath, transcript) {
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
      const raw = readText$1(await workspace(), LAST_RUN_FILE);
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
  function diffCorrections(written, current2, toleranceSeconds = 0.25) {
    const ours = written.segments.flatMap((segment) => segment.words);
    if (ours.length === 0 || current2.length === 0) {
      return [];
    }
    const tally = /* @__PURE__ */ new Map();
    let cursor = 0;
    for (const mine of ours) {
      while (cursor < current2.length && current2[cursor].start < mine.start - toleranceSeconds) {
        cursor += 1;
      }
      const theirs = current2[cursor];
      if (!theirs || Math.abs(theirs.start - mine.start) > toleranceSeconds) {
        continue;
      }
      const before = mine.text.trim();
      const after = theirs.text.trim();
      if (!before || !after || before === after) {
        continue;
      }
      if (fold$1(before) === fold$1(after)) {
        continue;
      }
      const looksProper = /^[A-ZÀ-Ý]/.test(after);
      if (!looksProper && !resembles(fold$1(before), fold$1(after))) {
        continue;
      }
      const key = `${fold$1(before)}→${after}`;
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
      const current2 = [i];
      for (let j = 1; j <= b.length; j += 1) {
        current2.push(
          Math.min(
            row[j] + 1,
            current2[j - 1] + 1,
            row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
          )
        );
      }
      row = current2;
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
      glossary.split(/\r?\n/).map((line) => fold$1(line)).filter(Boolean)
    );
    const added = [];
    for (const candidate of learned) {
      const term = candidate.to.trim().replace(/[.,;:!?]+$/, "");
      if (!term || existing.has(fold$1(term))) {
        continue;
      }
      existing.add(fold$1(term));
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
  const SHAPES$1 = [
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
          words: segment.words.map((word, at2) => ({
            id: `w${index}_${at2}`,
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
    const words2 = segment.words;
    if (words2.length === 0) {
      return 0;
    }
    const last = words2[words2.length - 1];
    return Math.max(0.01, last.start + last.duration - segment.start);
  }
  let known = null;
  function rememberShape(id) {
    known = id;
  }
  function shapesToTry() {
    if (!known) {
      return [...SHAPES$1];
    }
    const first = SHAPES$1.filter((shape) => shape.id === known);
    return [...first, ...SHAPES$1.filter((shape) => shape.id !== known)];
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
    const ordered2 = [...clips].sort((a, b) => a.seqStart - b.seqStart);
    for (const segment of transcript.segments) {
      const byClip = /* @__PURE__ */ new Map();
      for (const word of segment.words) {
        const clip = ordered2.find(
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
      for (const [key, words2] of byClip) {
        if (words2.length === 0) {
          continue;
        }
        const existing = out.get(key) ?? { version: transcript.version, segments: [] };
        existing.segments.push({ start: words2[0].start, words: words2 });
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
    let error = null;
    try {
      project2.lockedAccess(() => {
        try {
          committed = project2.executeTransaction(build, label);
        } catch (cause) {
          error = cause;
        }
      });
    } catch (cause) {
      error = error ?? cause;
    }
    if (error) {
      throw error;
    }
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
    const sequence2 = await project2.getActiveSequence();
    if (!sequence2) {
      throw new Error("Nenhuma sequência aberta.");
    }
    let fps = 0;
    try {
      const settings2 = await sequence2.getSettings();
      const rate = settings2?.getVideoFrameRate?.();
      if (rate && Number.isFinite(rate.value) && rate.value > 0) {
        fps = rate.value;
      }
    } catch {
    }
    const tracks = [];
    const count = await sequence2.getAudioTrackCount();
    for (let index = 0; index < count; index += 1) {
      const track = await sequence2.getAudioTrack(index);
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
  function describeTiming(t) {
    const min = (sec) => sec >= 60 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)}s`;
    const fator = t.elapsedSeconds > 0 ? t.audioSeconds / t.elapsedSeconds : 0;
    const ritmo = fator > 0 ? ` · ${fator.toFixed(1)}x tempo real` : "";
    return `${min(t.elapsedSeconds)} para ${min(t.audioSeconds)} de áudio${ritmo}`;
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
    if (options.cancelled?.()) {
      stages.push("cancelado depois de o motor terminar; nada foi gravado");
      return {
        ok: false,
        message: describeError("cancelled"),
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
      stages,
      options.destination,
      options.destinationToken
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
    const placed2 = [...perClip.values()].reduce(
      (total, transcript) => total + countWords(transcript),
      0
    );
    stages.push(`palavras encaixadas em clipes: ${placed2}`);
    if (heard > 0 && placed2 === 0) {
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
        await writeSnapshot$1(clip.mediaPath, transcript);
      } else {
        failures.push(clip.name);
      }
    }
    stages.push(`importados: ${imported}`);
    if (failures.length > 0) {
      stages.push(`recusados pelo Premiere: ${failures.length}`);
      for (const note2 of [...new Set(notes)].slice(0, 4)) {
        stages.push(note2);
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
    const quanto = result.timing ? ` · ${describeTiming(result.timing)}` : "";
    const comoAplicar = srtInProject ? options.destination ? ` · ${cues} legendas salvas em ${srtPath} e no projeto` : ` · ${cues} legendas no .srt dentro do projeto — arraste para a timeline` : cues > 0 ? ` · .srt salvo em ${srtPath}` : "";
    return {
      ok: failures.length === 0,
      message: `${head}${comoAplicar}${quanto}`,
      imported,
      stages,
      srtPath,
      cues
    };
  }
  async function writeSrtToDestination(destination, token, fileName, content) {
    return writeFileInto(destinationOf(destination, token ?? ""), fileName, content);
  }
  async function emitSrt(project2, transcript, options, fps, stages, destination, destinationToken) {
    let srtPath = null;
    let cues = 0;
    try {
      const built = buildCues(transcript, options, fps);
      cues = built.length;
      if (cues > 0) {
        let seqName = "";
        try {
          const activeSeq = await project2.getActiveSequence();
          if (activeSeq?.name) {
            seqName = activeSeq.name.replace(/[/\\?%*:|"<>]/g, "-").trim();
          }
        } catch {
        }
        const prefix = seqName ? `${seqName}-` : "";
        const name = `${prefix}legendas-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}-${Date.now().toString(36)}.srt`;
        const srtContent = cuesToSrt(built);
        if (destination) {
          try {
            srtPath = await writeSrtToDestination(destination, destinationToken, name, srtContent);
            stages.push(`legendas salvas no destino escolhido: ${srtPath}`);
          } catch (destErr) {
            stages.push(
              `ATENÇÃO: a pasta escolhida (${destination}) não aceitou o arquivo (${describeError$1(destErr)}). O .srt foi para a pasta de trabalho do plugin — escolha o destino de novo antes da próxima legenda.`
            );
          }
        }
        if (!srtPath) {
          const space = await workspace();
          await write(space, name, srtContent);
          srtPath = nativePath(space, name);
          stages.push(`legendas no .srt: ${cues}`);
        }
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
  async function rebuildSrt(options, destination, destinationToken) {
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
      stages,
      destination,
      destinationToken
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
      message: `${cues} legendas refeitas de ${last.label}. ` + (inProject ? destination ? `Salvo em ${srtPath} e no seu projeto.` : "O .srt novo está no seu projeto — arraste para a timeline." : `Arquivo salvo: ${srtPath}`),
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
      const current2 = await readTranscript(ppro, clip.clipItem);
      if (current2.status !== "ok" || current2.words.length === 0) {
        continue;
      }
      checked += 1;
      const words2 = current2.words.filter((word) => !!word.text).map((word) => ({ text: word.text, start: word.start }));
      all.push(...diffCorrections(written, words2));
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
        const words2 = Array.isArray(segment.words) ? segment.words : null;
        if (words2 && words2.length > 0 && typeof words2[0] === "object") {
          lines.push(`palavra: ${Object.keys(words2[0]).join(", ")}`);
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
    const words2 = [];
    let clock2 = 0.4;
    for (const token of DEMO_SPEECH.split(" ")) {
      if (token === "||") {
        clock2 += 1.4;
        continue;
      }
      const duration = 0.09 + 0.055 * token.length;
      words2.push({
        text: token,
        start: Number(clock2.toFixed(3)),
        duration: Number(duration.toFixed(3)),
        type: "word",
        confidence: 1,
        tags: []
      });
      clock2 += duration + 0.045;
    }
    return { version: "1.0.0", segments: [{ start: 0, words: words2 }] };
  }
  const CAP_USABLE_PX = 234;
  const CAP_CHAR_RATIO = 0.49;
  function captionFontPx(chars) {
    const fits = CAP_USABLE_PX / (Math.max(1, chars) * CAP_CHAR_RATIO);
    return Number(Math.min(11, Math.max(6.5, fits)).toFixed(2));
  }
  function seconds$1(value) {
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
      return `<div class="cc-cap-screen"><div class="cc-cap-clock"><span>${shortClock(cue.start)}</span><span class="cc-cap-dur">${seconds$1(cue.end - cue.start)}</span></div><div class="cc-cap-lines">${lines}</div></div>`;
    }).join("");
    const warning = stats.rushed > 0 ? `<p class="cc-cap-warn">${stats.rushed} ${stats.rushed === 1 ? "legenda passa" : "legendas passam"} rápido demais para ${Math.round(options.readingCps)} car/s — aumente os caracteres por linha, ou baixe a velocidade de leitura.</p>` : "";
    return `<div class="cc-cap-preview" style="--cc-cap-size:${captionFontPx(widest)}px">` + screens + `<div class="cc-cap-stats"><span><b>${stats.cues}</b> ${stats.cues === 1 ? "legenda" : "legendas"}</span><span>linha máx <b>${stats.longestLine}</b></span><span>média <b>${seconds$1(stats.meanSeconds)}</b></span></div>` + warning + `<p class="cc-cap-source">${escapeHtml(source)}</p></div>`;
  }
  const asSeconds = (value) => `${value.toFixed(1).replace(".", ",")}s`;
  const CAP_SLIDERS = [
    {
      key: "maxLineChars",
      label: "Comprimento máximo",
      note: "Quantidade máxima de caracteres por linha antes de quebrar ou criar nova legenda.",
      step: 1,
      format: (value) => `${Math.round(value)} caracteres`
    },
    {
      key: "minCueSeconds",
      label: "Duração mínima",
      note: "Tempo mínimo que cada legenda permanece visível em tela.",
      step: 0.1,
      format: asSeconds
    },
    {
      key: "gapFrames",
      label: "Intervalo entre legendas",
      note: "Espaço em quadros entre legendas. 0 quadros entra imediatamente sem piscar.",
      step: 1,
      format: (value) => {
        const v = Math.round(value);
        return v === 0 ? "0 quadros (sem gap)" : `${v} ${v === 1 ? "quadro" : "quadros"}`;
      }
    },
    {
      key: "readingCps",
      label: "Velocidade de leitura",
      note: "Caracteres por segundo para garantir conforto visual na leitura.",
      step: 1,
      // 0 não é "zero caracteres por segundo", é a regra desligada — e
      // mostrar "0 car/s" faria parecer defeito.
      format: (value) => value <= 0 ? "desligada" : `${Math.round(value)} car/s`
    },
    {
      key: "maxCueSeconds",
      label: "Duração máxima",
      note: "Tempo máximo permitido para um único bloco de legenda.",
      step: 0.25,
      format: asSeconds
    },
    {
      key: "gapSeconds",
      label: "Pausa para silêncio",
      note: "Tempo de pausa na fala que encerra a legenda em vez de emendar na próxima.",
      step: 0.05,
      format: asSeconds
    }
  ];
  const HOST_FAILURES = [
    {
      match: /no longer valid/i,
      say: 'O Premiere soltou a sequência — ela mudou, foi fechada ou o painel recarregou. Clique em "Reler a sequência" e tente de novo.'
    },
    {
      match: /route not found/i,
      say: "Este build do Premiere recusou a escrita na pasta de trabalho do plugin. Reinicie o Premiere; se continuar, me mande o console do UXP."
    },
    {
      match: /is not a function|undefined is not an object/i,
      say: "Esta versão do Premiere não expõe uma parte da API que a ferramenta usa. Atualize o Premiere — o console do UXP diz qual peça falta."
    }
  ];
  function hostMessage(step2, cause) {
    const raw = describeError$1(cause).trim();
    console.error(`[Legendas] ${step2}:`, cause);
    const known2 = HOST_FAILURES.find((entry) => entry.match.test(raw));
    if (known2) {
      return known2.say;
    }
    return raw || `Não foi possível ${step2}.`;
  }
  let cancelActiveRun = null;
  let releaseDocument$2 = null;
  let releaseTimer = null;
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
        srt: { ...SRT_DEFAULTS },
        srtDestination: "",
        srtDestinationToken: ""
      };
      let scan = null;
      const capSliders = /* @__PURE__ */ new Map();
      let lastRun = null;
      let busy2 = false;
      container.innerHTML = markup$4();
      const scanBtn = container.querySelector("[data-scan]");
      const learnBtn = container.querySelector("[data-learn]");
      const reportEl = container.querySelector("[data-report]");
      const emptyEl = container.querySelector("[data-empty]");
      const trackHost = container.querySelector("[data-track-pick]");
      const langHost = container.querySelector("[data-lang-pick]");
      const modelSeg = container.querySelector("[data-model-seg]");
      const srtDestEl = container.querySelector("[data-srt-dest]");
      const srtDestPick = container.querySelector("[data-srt-dest-pick]");
      const srtDestReset = container.querySelector("[data-srt-dest-reset]");
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
      const closeMenus = (target2) => {
        trackPick?.closeUnless(target2);
        langPick?.closeUnless(target2);
      };
      const onDocumentPointer = (event) => closeMenus(event.target);
      const onDocumentKey = (event) => {
        if (event.key === "Escape") closeMenus(null);
      };
      document.addEventListener("click", onDocumentPointer, true);
      document.addEventListener("keydown", onDocumentKey, true);
      releaseTimer = () => {
        if (timerInterval !== null) {
          window.clearInterval(timerInterval);
          timerInterval = null;
        }
      };
      releaseDocument$2 = () => {
        document.removeEventListener("click", onDocumentPointer, true);
        document.removeEventListener("keydown", onDocumentKey, true);
      };
      context.setApplyLabel("TRANSCREVER");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      void (async () => {
        config = await readConfig();
        const held = await readDestination(
          "captions",
          destinationOf(config.srtDestination, config.srtDestinationToken)
        ).catch(() => null);
        config.srtDestination = held?.path ?? "";
        config.srtDestinationToken = held?.token ?? "";
        if (glossaryEl) glossaryEl.value = config.glossary;
        lastRun = await readLastRun();
        trackPick?.render();
        langPick?.render();
        syncModel();
        syncGlossaryNote();
        syncCaptionFormat();
        renderDestination();
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
      function renderDestination() {
        if (srtDestEl) {
          if (config.srtDestination) {
            srtDestEl.textContent = config.srtDestination;
            srtDestEl.title = `${config.srtDestination} (clique para abrir no Finder/Explorer)`;
            srtDestEl.style.cursor = "pointer";
          } else {
            srtDestEl.textContent = "(pasta padrão do plugin)";
            srtDestEl.title = "Pasta interna de trabalho do plugin. Clique em 'Escolher…' para definir uma pasta no seu computador.";
            srtDestEl.style.cursor = "default";
          }
        }
        if (srtDestReset) {
          srtDestReset.hidden = !config.srtDestination;
        }
      }
      srtDestPick?.addEventListener("click", () => void pickDestination2());
      srtDestReset?.addEventListener("click", () => {
        config.srtDestination = "";
        config.srtDestinationToken = "";
        void saveDestination("captions", null);
        persist();
        renderDestination();
        context.setStatus("Destino redefinido para a pasta padrão do plugin.", "idle");
      });
      srtDestEl?.addEventListener("click", async () => {
        try {
          const shell = shellModule();
          if (!shell?.openPath) return;
          if (config.srtDestination) {
            await shell.openPath(config.srtDestination, "Abrir pasta de destino das legendas");
          } else {
            const space = await workspace();
            await shell.openPath(space.nativeBase, "Abrir pasta de trabalho do plugin");
          }
        } catch (cause) {
          console.warn("[Legendas] não foi possível abrir a pasta:", cause);
        }
      });
      async function pickDestination2() {
        try {
          const picked = await pickAndSave("captions");
          if (!picked) {
            return;
          }
          config.srtDestination = picked.path;
          config.srtDestinationToken = picked.token;
          persist();
          renderDestination();
          context.setStatus(`Pasta de destino definida: ${picked.path}`, "done");
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          context.setStatus(
            reason === NO_PICKER ? "Este build do Premiere não abre o seletor de pastas." : `Não deu para escolher a pasta: ${reason}`,
            "error"
          );
        }
      }
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
        if (busy2 || !lastRun) return;
        busy2 = true;
        if (redoBtn) {
          setDisabled(redoBtn, true);
          redoBtn.textContent = "Gerando…";
        }
        try {
          const result = await rebuildSrt(config.srt, config.srtDestination, config.srtDestinationToken);
          context.setStatus(result.message, result.ok ? "done" : "error");
        } catch (cause) {
          context.setStatus(hostMessage("refazer o .srt", cause), "error");
        } finally {
          busy2 = false;
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
      async function runScan(silent2 = false) {
        if (busy2) return;
        busy2 = true;
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
          if (!silent2) {
            context.setStatus(hostMessage("ler a sequência", cause), "error");
          }
        } finally {
          busy2 = false;
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
        if (!scan || busy2) return;
        if (clipsFor(scan, config.track).length === 0) return;
        busy2 = true;
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
            destination: config.srtDestination,
            destinationToken: config.srtDestinationToken,
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
          const partial = result.ok && result.imported === 0;
          context.setStatus(result.message, result.ok ? partial ? "idle" : "done" : "error");
          showStages(result.ok && !partial ? [] : result.stages);
          if (result.imported > 0) {
            context.setResetHandler(() => clearAll());
          } else {
            context.setApplyEnabled(true);
          }
        } catch (cause) {
          showProgress(null);
          context.setStatus(hostMessage("transcrever", cause), "error");
          context.setApplyEnabled(true);
        } finally {
          showProgress(null);
          busy2 = false;
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
        if (busy2) return;
        busy2 = true;
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
          context.setStatus(hostMessage("ler as correções", cause), "error");
        } finally {
          busy2 = false;
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
        const words2 = track.clips.reduce((total, clip) => total + clip.words, 0);
        const meta = words2 > 0 ? `<span class="sil-row-cuts">${words2} palavras</span>` : track.usable === 0 ? '<span class="sil-row-skip">vazia</span>' : `<span class="sil-row-time">${track.usable} ${track.usable === 1 ? "clipe" : "clipes"}</span>`;
        let html = '<div class="sil-row-group"><div class="sil-row' + (words2 > 0 ? " is-ready" : "") + `"><span class="sil-row-name">${track.label}</span>${meta}</div>`;
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
      releaseTimer?.();
      releaseTimer = null;
      releaseDocument$2?.();
      releaseDocument$2 = null;
      releaseSliders?.();
      releaseSliders = null;
    }
  };
  function markup$4() {
    const models = MODELS.map(
      (model) => `<div class="seg-item" ${CONTROL} data-model="${model.id}" title="${escapeHtml(model.note)}">${escapeHtml(model.label)}</div>`
    ).join("");
    const srtPresets = SRT_PRESETS.map(
      (preset) => `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}" title="${escapeHtml(preset.note)}">${escapeHtml(preset.name)}</div>`
    ).join("");
    const lineCounts = [1, 2, 3].map(
      (count) => `<div class="seg-item" ${CONTROL} data-lines="${count}">${count} ${count === 1 ? "linha" : "linhas"}</div>`
    ).join("");
    const capSlider = (key) => {
      const spec = CAP_SLIDERS.find((entry) => entry.key === key);
      if (!spec) return "";
      return `<div class="field"><div class="field-head"><span class="t-label" title="${escapeHtml(spec.note ?? "")}">${spec.label}</span><span class="field-val" data-cap-out="${key}">${spec.format(SRT_DEFAULTS[key])}</span></div><div class="slider-row"><div data-cap="${key}"></div></div></div>`;
    };
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label" title="A faixa vai inteira para o motor, com os silêncios entre os clipes — é o que faz uma frase cortada no meio sair inteira.">Faixa de áudio</span><div data-track-pick></div></div><div class="field"><span class="t-label">Idioma</span><div data-lang-pick></div></div><div class="field"><span class="t-label" title="O modelo baixa sozinho na primeira vez.">Qualidade</span><div class="seg" data-model-seg>${models}</div></div><div class="field"><div class="field-head"><span class="t-label" title="Pasta onde o .srt é salvo no disco. O arquivo também entra no seu projeto.">Destino do .srt</span><span class="field-action" ${CONTROL} data-srt-dest-pick>Escolher…</span><span class="field-action" ${CONTROL} data-srt-dest-reset hidden>Padrão</span></div><p class="dl-dest" data-srt-dest></p></div></div><div class="zone"><div class="field"><span class="t-label">Formato da legenda</span><div class="preset-rail" data-srt-rail>${srtPresets}</div></div><div class="field"><span class="t-label">Linhas</span><div class="seg" data-lines-seg>${lineCounts}</div></div>` + capSlider("maxLineChars") + capSlider("minCueSeconds") + capSlider("gapFrames") + // A prévia fica ENCOSTADA nos controles principais. Mais
    // abaixo, num painel de 320px, ela sai da tela justamente
    // enquanto o deslizador está sendo arrastado — que é o único
    // momento em que ela serve para alguma coisa.
    `<div data-cap-preview></div><div class="cc-redo" ${CONTROL} data-redo hidden>Refazer o .srt com estes ajustes</div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-cap-adv-toggle><span class="sil-advanced-title">Ajustes adicionais</span><span class="sil-advanced-icon" data-cap-adv-icon>▾</span></div><div class="sil-advanced-content" data-cap-adv-content hidden>` + capSlider("readingCps") + capSlider("maxCueSeconds") + capSlider("gapSeconds") + `</div></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Glossário do projeto</span></div><textarea class="dl-urls" data-glossary spellcheck="false" rows="3" placeholder="Framelab&#10;Sidy Furtado&#10;nome do cliente" title="Um termo por linha: nomes, marcas, jargão. Já vem com o vocabulário de edição de fábrica."></textarea></div></div><div class="zone is-wide"><div class="sil-empty" data-empty><p class="sil-empty-title">Pronto para transcrever</p><p class="sil-empty-desc">Escolha a faixa acima e transcreva. O resultado vira um .srt no seu projeto, pronto para arrastar para a timeline.</p></div><div class="cc-actions"><div class="org-scan" ${CONTROL} data-scan>Reler a sequência</div><div class="cc-learn" ${CONTROL} data-learn title="Compara o que o plugin escreveu com o que você corrigiu à mão">Aprender com minhas correções</div></div><div class="sil-manual" data-manual hidden></div><div class="cc-progress" data-progress hidden></div><div class="sil-report" data-report></div></div></div>`;
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
      if (montarUrl(base, [texto]).length > maxUrl) {
        if (atual.length > 0) {
          lotes.push(atual);
          atual = [];
        }
        lotes.push([texto]);
        continue;
      }
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
    const resposta = await fetchWithTimeout(
      montarUrl(base, textos),
      { headers: { "User-Agent": UA } },
      NET_DEADLINE.translate
    );
    if (!resposta.ok) return null;
    return lerResposta(await resposta.text(), textos.length);
  }
  function parouEm(texts, pedidos, cause, cancelled = false) {
    return {
      texts,
      detected: null,
      missing: pedidos - texts.length,
      cause,
      cancelled
    };
  }
  async function pedirMyMemory(textos, from, to, cancelled) {
    const par = `${from === "auto" ? "autodetect" : from}|${to}`;
    const saida = [];
    for (const texto of textos) {
      if (cancelled?.()) {
        return parouEm(saida, textos.length, null, true);
      }
      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(texto)}&langpair=${encodeURIComponent(par)}`;
        const resposta = await fetchWithTimeout(url, void 0, NET_DEADLINE.translate);
        if (!resposta.ok) {
          return parouEm(saida, textos.length, `MyMemory respondeu ${resposta.status}`);
        }
        const dados = await resposta.json();
        const traduzido = dados?.responseData?.translatedText;
        if (typeof traduzido !== "string") {
          return parouEm(saida, textos.length, "MyMemory respondeu sem tradução");
        }
        saida.push(traduzido);
      } catch (cause) {
        if (isNetCancelled(cause)) {
          return parouEm(saida, textos.length, null, true);
        }
        return parouEm(saida, textos.length, descreve(cause));
      }
      if (cancelled?.()) {
        return parouEm(saida, textos.length, null, true);
      }
    }
    return { texts: saida, detected: null, missing: 0, cause: null, cancelled: false };
  }
  function descreve(cause) {
    return cause instanceof Error ? cause.message : String(cause);
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
    let ultimaCausa = null;
    let parou = false;
    const alinhar = () => entradas.map((t) => mapa.get(t) ?? t);
    const cancelado = () => ({
      ok: false,
      texts: [],
      detected,
      error: "cancelled",
      done: mapa.size,
      pending: total - mapa.size
    });
    for (const lote of lotes) {
      if (options.cancelled?.()) {
        return cancelado();
      }
      let resposta = null;
      try {
        resposta = await pedirGoogle(lote, options.from, options.to);
      } catch {
        resposta = null;
      }
      if (!resposta) {
        usouReserva = true;
        const reserva = await pedirMyMemory(
          lote,
          options.from,
          options.to,
          options.cancelled
        );
        reserva.texts.forEach((texto, i) => mapa.set(lote[i], texto));
        feitos += reserva.texts.length;
        options.onProgress?.(feitos, total);
        if (reserva.cancelled) {
          return cancelado();
        }
        if (reserva.missing > 0) {
          ultimaCausa = reserva.cause;
          parou = true;
          break;
        }
        continue;
      }
      if (!detected) detected = resposta.detected;
      lote.forEach((original, i) => mapa.set(original, resposta.texts[i]));
      feitos += lote.length;
      options.onProgress?.(feitos, total);
    }
    const pending = total - mapa.size;
    if (parou && mapa.size === 0) {
      return {
        ok: false,
        texts: [],
        detected,
        error: usouReserva ? "both-engines-failed" : "engine-failed",
        done: 0,
        pending: total
      };
    }
    if (parou) {
      console.warn(
        `[Traduzir] parcial: ${mapa.size} de ${total} falas · ${ultimaCausa ?? "sem causa"}`
      );
    }
    return {
      ok: true,
      texts: alinhar(),
      detected,
      error: null,
      done: mapa.size,
      pending
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
      error: null,
      pending: resultado.pending
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
  function localFs$1() {
    return uxpModule("uxp")?.storage?.localFileSystem ?? null;
  }
  async function pickSrtFile() {
    const lfs = localFs$1();
    if (!lfs?.getFileForOpening) {
      throw new Error("este build do Premiere não expõe o seletor de arquivos do UXP");
    }
    let entrada = null;
    let primeiraFalha = null;
    const tentativas = [{ types: ["srt", "vtt"] }, {}];
    for (const opcoes of tentativas) {
      try {
        const escolhido = await lfs.getFileForOpening(opcoes);
        entrada = (Array.isArray(escolhido) ? escolhido[0] : escolhido) ?? null;
        if (entrada || !opcoes.types) break;
      } catch (cause) {
        primeiraFalha = primeiraFalha ?? cause;
      }
    }
    if (!entrada) {
      if (primeiraFalha) {
        throw new Error(`o seletor de arquivos não abriu (${describe$5(primeiraFalha)})`);
      }
      return null;
    }
    return {
      name: entrada.name,
      nativePath: entrada.nativePath ?? null,
      text: String(await entrada.read())
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
  let sequence$1 = 0;
  function copyRun() {
    const tag = `${Date.now().toString(36)}-${(sequence$1 += 1).toString(36)}`;
    return {
      tag,
      script: `translate-copy-${tag}.command`,
      out: `tr-${tag}-input.srt`,
      done: `tr-${tag}-copy-done.txt`
    };
  }
  function copyRunFiles(run2) {
    return [run2.script, run2.out, run2.done];
  }
  function copyScript(run2, nativePath2, workBase) {
    return [
      "#!/bin/bash",
      "# Gerado pelo Framelab — traz a legenda para dentro. Pode apagar.",
      "set -u",
      `WORK=${shellQuote(workBase)}`,
      `if ERR=$(cp ${shellQuote(nativePath2)} "$WORK/${run2.out}" 2>&1); then`,
      `  printf ok > "$WORK/${run2.done}"`,
      "else",
      `  printf 'falhou %s' "$ERR" > "$WORK/${run2.done}"`,
      "fi",
      ""
    ].join("\n");
  }
  async function readAnyPath(nativePath2) {
    const falhas = [];
    const lfs = localFs$1();
    if (typeof lfs?.getEntryWithUrl === "function") {
      for (const alvo of [fileUrl(nativePath2), nativePath2]) {
        try {
          const entrada = await lfs.getEntryWithUrl(alvo);
          const texto = String(await entrada.read());
          if (texto.trim()) return texto;
          falhas.push("getEntryWithUrl: veio vazio");
        } catch (cause) {
          falhas.push(`getEntryWithUrl: ${describe$5(cause)}`);
        }
      }
    } else {
      falhas.push("getEntryWithUrl: ausente");
    }
    const fs = fsModule();
    if (fs) {
      for (const alvo of [nativePath2, fileUrl(nativePath2)]) {
        try {
          const texto = String(fs.readFileSync(alvo, { encoding: "utf-8" }));
          if (texto.trim()) return texto;
        } catch (cause) {
          falhas.push(`fs: ${describe$5(cause)}`);
        }
      }
    }
    return await copyViaAgent(nativePath2, falhas);
  }
  async function copyViaAgent(nativePath2, falhas) {
    const resumo = falhas.length ? ` (${falhas.join(" · ")})` : "";
    const space = await workspace();
    const run2 = copyRun();
    await write(space, run2.script, copyScript(run2, nativePath2, space.nativeBase), true);
    const enviado = await dispatch(run2.script);
    if (enviado.mode === "denied") {
      await esquecer(space, run2);
      throw new Error(
        `o assistente não pôde ser iniciado para ler o arquivo${resumo}`
      );
    }
    const limite = Date.now() + 15e3;
    try {
      while (Date.now() < limite) {
        const estado = readText$1(space, run2.done);
        if (estado === "ok") {
          const texto = readText$1(space, run2.out);
          if (texto) return texto;
          throw new Error("o arquivo foi copiado mas veio vazio");
        }
        if (estado?.startsWith("falhou")) {
          const motivo = estado.slice("falhou".length).trim();
          throw new Error(
            motivo ? `não consegui ler esse arquivo: ${motivo}` : `não consegui ler esse arquivo${resumo}`
          );
        }
        await wait$1(200);
      }
      await withdraw(enviado.ticket);
      throw new Error(`a leitura do arquivo passou do tempo${resumo}`);
    } finally {
      await esquecer(space, run2);
    }
  }
  async function esquecer(space, run2) {
    for (const nome of copyRunFiles(run2)) {
      await remove(space, nome);
    }
  }
  let releaseDocument$1 = null;
  let cancelActive = null;
  const TRANSLATE_DEFAULTS = { from: "auto", to: "pt" };
  const translateSettings = createToolSettings(
    "translate-config.json",
    TRANSLATE_DEFAULTS,
    (raw) => ({
      from: typeof raw.from === "string" && (raw.from === "auto" || SOURCE_LANGUAGES.some((l) => l.id === raw.from)) ? raw.from : "auto",
      to: typeof raw.to === "string" && TARGET_LANGUAGES.some((l) => l.id === raw.to) ? raw.to : "pt"
    })
  );
  warmToolSettings(translateSettings);
  const FALHAS = [
    [
      /no longer valid/i,
      "O Premiere trocou o projeto embaixo do painel. Clique em LIMPAR e escolha a legenda de novo."
    ],
    [
      /route not found|no such file|ENOENT/i,
      "Não achei o arquivo nesse caminho. Ele pode ter sido movido ou estar num disco que saiu."
    ],
    [
      /permission|denied|EACCES/i,
      "O sistema negou o acesso ao arquivo. Confira as permissões da pasta."
    ],
    [
      /network|fetch|ETIMEDOUT|ECONNRESET/i,
      "A tradução depende da internet e a conexão falhou. Tente de novo."
    ]
  ];
  function mensagemDeFalha(passo, cause) {
    const cru = describeError$1(cause);
    console.error(`[Traduzir] falha ao ${passo}:`, cause);
    for (const [padrao, frase] of FALHAS) {
      if (padrao.test(cru)) {
        return frase;
      }
    }
    return `Falha ao ${passo}: ${cru}`;
  }
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
      const saved = translateSettings.peek() ?? TRANSLATE_DEFAULTS;
      let carregada = null;
      let from = saved.from;
      let to = saved.to;
      let busy2 = false;
      container.innerHTML = markup$3();
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
          translateSettings.patch({ from });
          fromPick?.render();
        }
      }) : null;
      const toPick = toEl ? mountDropdown(toEl, {
        options: () => TARGET_LANGUAGES.map((l) => ({ id: l.id, label: l.label })),
        selected: () => to,
        onPick: (id) => {
          to = id;
          translateSettings.patch({ to });
          toPick?.render();
        }
      }) : null;
      void translateSettings.read().then((stored) => {
        if (!container.isConnected) {
          return;
        }
        from = stored.from;
        to = stored.to;
        fromPick?.render();
        toPick?.render();
      });
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
      releaseDocument$1 = () => {
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
        if (busy2) return;
        void (async () => {
          busy2 = true;
          context.setStatus("Abrindo o seletor de arquivos…");
          try {
            const escolhido = await pickSrtFile();
            if (escolhido) {
              carregar(escolhido.name, escolhido.text);
            } else {
              context.setStatus("Nenhum arquivo escolhido.", "idle");
            }
          } catch (cause) {
            context.setStatus(mensagemDeFalha("abrir o arquivo", cause), "error");
          } finally {
            busy2 = false;
          }
        })();
      });
      projetoEl?.addEventListener("click", () => void listarProjeto());
      async function listarProjeto() {
        if (busy2) return;
        busy2 = true;
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
          context.setStatus(mensagemDeFalha("procurar legendas no projeto", cause), "error");
        } finally {
          busy2 = false;
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
        if (!caminho || busy2) return;
        void (async () => {
          busy2 = true;
          context.setStatus("Lendo a legenda…");
          try {
            carregar(nome, await readAnyPath(caminho));
          } catch (cause) {
            context.setStatus(mensagemDeFalha("ler a legenda", cause), "error");
          } finally {
            busy2 = false;
          }
        })();
      });
      context.setApplyHandler(async () => {
        if (!carregada || busy2) return;
        busy2 = true;
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
          const faltaram = resultado.pending ?? 0;
          context.setStatus(
            `${resultado.translated} de ${resultado.total} blocos traduzidos · ${origem} · ` + (noProjeto ? "o .srt está no seu projeto" : `salvo em ${caminho}`) + (faltaram > 0 ? ` · ${faltaram} ${faltaram === 1 ? "trecho ficou" : "trechos ficaram"} no idioma original (o tradutor parou antes do fim)` : ""),
            faltaram > 0 ? "error" : "done"
          );
        } catch (cause) {
          context.setStatus(mensagemDeFalha("traduzir", cause), "error");
        } finally {
          busy2 = false;
          cancelActive = null;
          context.setApplyLabel("TRADUZIR");
          context.setApplyEnabled(!!carregada);
        }
      });
      function limpar() {
        carregada = null;
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
      void translateSettings.flush();
      cancelActive?.();
      cancelActive = null;
      releaseDocument$1?.();
      releaseDocument$1 = null;
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
  function markup$3() {
    return `<div class="zones"><div class="zone"><div class="field"><span class="t-label">A legenda</span><div class="tr-acts" data-empty><div class="tr-btn" ${CONTROL} data-import>Importar arquivo…</div><div class="tr-btn" ${CONTROL} data-project>Buscar no projeto</div></div><div class="tr-file" data-file hidden></div><div class="tr-list" data-list hidden></div></div></div><div class="zone"><div class="field"><span class="t-label">Traduzir de</span><div data-from></div></div><div class="field"><span class="t-label" title="Os tempos de cada bloco saem idênticos aos que entraram — só o texto muda. O arquivo novo entra no seu projeto ao lado do original.">Para</span><div data-to></div></div></div><div class="zone is-wide"><div class="tr-prev" data-preview hidden></div></div></div>`;
  }
  const CHUNK$1 = 65536;
  let note$1 = "";
  function lastReadNote() {
    return note$1;
  }
  async function readBytes(fs, path) {
    try {
      const raw = fs.readFileSync(path);
      if (raw && typeof raw !== "string") {
        note$1 = "readFileSync";
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      }
      note$1 = `readFileSync devolveu ${typeof raw}`;
    } catch (cause) {
      note$1 = `readFileSync: ${String(cause).slice(0, 80)}`;
    }
    let fd = null;
    try {
      fd = await fs.open(path, "r");
      const parts = [];
      let position = 0;
      for (; ; ) {
        const buffer = new ArrayBuffer(CHUNK$1);
        const answer = await fs.read(fd, buffer, 0, CHUNK$1, position);
        const read = Number(answer?.bytesRead ?? 0);
        if (!(read > 0)) {
          break;
        }
        parts.push(new Uint8Array(answer.buffer ?? buffer, 0, read).slice());
        position += read;
        if (read < CHUNK$1) {
          break;
        }
      }
      if (position === 0) {
        note$1 += " · open/read: arquivo vazio";
        return null;
      }
      const all = new Uint8Array(position);
      let at2 = 0;
      for (const part of parts) {
        all.set(part, at2);
        at2 += part.length;
      }
      note$1 += " · open/read ok";
      return all;
    } catch (cause) {
      note$1 += ` · open/read: ${String(cause).slice(0, 80)}`;
      return null;
    } finally {
      if (fd !== null) {
        await fs.close(fd).catch(() => void 0);
      }
    }
  }
  async function readWorkBytes(space, relative) {
    const fs = fsModule();
    if (!fs) {
      note$1 = 'require("fs") não resolveu';
      return null;
    }
    return readBytes(fs, fsPath(space, relative));
  }
  async function readNativeBytes(path) {
    const fs = fsModule();
    if (!fs) {
      note$1 = 'require("fs") não resolveu';
      return null;
    }
    return readBytes(fs, path);
  }
  function writeWorkBytes(space, relative, bytes) {
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    fs.writeFileSync(fsPath(space, relative), bytes);
  }
  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function textForDefinition(text2) {
    return text2.replace(/\r\n?|\n/g, "\r").trim();
  }
  function newCapsuleId(random = Math.random) {
    const hex = "0123456789abcdef";
    let out = "";
    for (let index = 0; index < 36; index += 1) {
      if (index === 8 || index === 13 || index === 18 || index === 23) {
        out += "-";
      } else if (index === 14) {
        out += "4";
      } else if (index === 19) {
        out += hex[8 + Math.floor(random() * 4)];
      } else {
        out += hex[Math.floor(random() * 16)];
      }
    }
    return out;
  }
  function setStrDb(holder, value) {
    if (!isObject(holder) || !Array.isArray(holder.strDB)) {
      return false;
    }
    let touched = false;
    for (const row of holder.strDB) {
      if (isObject(row) && typeof row.str === "string") {
        row.str = value;
        touched = true;
      }
    }
    return touched;
  }
  function textControls(definition) {
    const controls = Array.isArray(definition.clientControls) ? definition.clientControls : [];
    return controls.filter(
      (control) => isObject(control) && (control.type === 6 || isObject(control.fonteditinfo))
    );
  }
  function splitAcross(text2, fields) {
    if (fields <= 1) {
      return [text2];
    }
    const lines = text2.split("\r");
    return Array.from(
      { length: fields },
      (_, index) => index === fields - 1 ? lines.slice(index).join("\r") : lines[index] ?? ""
    );
  }
  function capParamsFor(definition, controlId) {
    const found = [];
    const localized = definition.sourceInfoLocalized;
    if (!isObject(localized)) {
      return found;
    }
    for (const info of Object.values(localized)) {
      if (!isObject(info) || !isObject(info.capsuleparams)) {
        continue;
      }
      const params = info.capsuleparams.capParams;
      if (!Array.isArray(params)) {
        continue;
      }
      for (const param of params) {
        if (isObject(param) && param.capPropMatchName === controlId) {
          found.push(param);
        }
      }
    }
    return found;
  }
  function registerFont(definition, font) {
    const used = definition.usedFontsLocalized;
    if (!isObject(used)) {
      return;
    }
    for (const [locale, list] of Object.entries(used)) {
      if (Array.isArray(list) && !list.includes(font)) {
        used[locale] = [...list, font];
      }
    }
  }
  function patchDefinition(json, patch) {
    const definition = JSON.parse(json);
    if (!isObject(definition)) {
      throw new Error("definition.json não é um objeto");
    }
    const text2 = textForDefinition(patch.text);
    const baseName2 = typeof definition.capsuleName === "string" ? definition.capsuleName : "Modelo";
    const capsuleName = patch.label?.trim() || `${baseName2} · ${text2.replace(/\r/g, " ").slice(0, 32)}`;
    const capsuleId = newCapsuleId();
    definition.capsuleID = capsuleId;
    definition.capsuleName = capsuleName;
    setStrDb(definition.capsuleNameLocalized, capsuleName);
    let textApplied = false;
    let fontApplied = false;
    let sizeApplied = false;
    const controls = textControls(definition);
    const parts = splitAcross(text2, controls.length);
    controls.forEach((control, index) => {
      const part = parts[index] ?? "";
      if (setStrDb(control.value, part)) {
        textApplied = true;
      }
      const fontInfo = isObject(control.fonteditinfo) ? control.fonteditinfo : null;
      if (fontInfo && patch.font) {
        fontInfo.fontEditValue = patch.font;
        fontApplied = true;
      }
      if (fontInfo && patch.size && patch.size > 0) {
        fontInfo.fontSizeEditValue = patch.size;
        sizeApplied = true;
      }
      const id = typeof control.id === "string" ? control.id : "";
      for (const param of capParamsFor(definition, id)) {
        if ("textEditValue" in param) {
          param.textEditValue = part;
          textApplied = true;
        }
        if ("capPropDefault" in param && typeof param.capPropDefault === "string") {
          param.capPropDefault = part;
        }
        if (Array.isArray(param.fontTextRunLength)) {
          param.fontTextRunLength = [part.length];
        }
        if ("capPropTextRunCount" in param) {
          param.capPropTextRunCount = 1;
        }
        if (patch.font && Array.isArray(param.fontEditValue)) {
          param.fontEditValue = [patch.font];
          fontApplied = true;
        }
        if (patch.size && patch.size > 0 && Array.isArray(param.fontSizeEditValue)) {
          param.fontSizeEditValue = [patch.size];
          sizeApplied = true;
        }
      }
    });
    if (fontApplied && patch.font) {
      registerFont(definition, patch.font);
    }
    return {
      json: JSON.stringify(definition),
      capsuleName,
      capsuleId,
      textApplied,
      fontApplied,
      sizeApplied,
      textFields: controls.length,
      parts
    };
  }
  const LENGTH_BASE = [
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    13,
    15,
    17,
    19,
    23,
    27,
    31,
    35,
    43,
    51,
    59,
    67,
    83,
    99,
    115,
    131,
    163,
    195,
    227,
    258
  ];
  const LENGTH_EXTRA = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0
  ];
  const DIST_BASE = [
    1,
    2,
    3,
    4,
    5,
    7,
    9,
    13,
    17,
    25,
    33,
    49,
    65,
    97,
    129,
    193,
    257,
    385,
    513,
    769,
    1025,
    1537,
    2049,
    3073,
    4097,
    6145,
    8193,
    12289,
    16385,
    24577
  ];
  const DIST_EXTRA = [
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13
  ];
  const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const MAX_BITS = 15;
  function buildHuffman(lengths, n) {
    const count = new Uint16Array(MAX_BITS + 1);
    for (let i = 0; i < n; i += 1) {
      count[lengths[i]] += 1;
    }
    count[0] = 0;
    const offsets = new Uint16Array(MAX_BITS + 2);
    for (let len = 1; len <= MAX_BITS; len += 1) {
      offsets[len + 1] = offsets[len] + count[len];
    }
    const symbol = new Uint16Array(n);
    for (let i = 0; i < n; i += 1) {
      if (lengths[i] !== 0) {
        symbol[offsets[lengths[i]]] = i;
        offsets[lengths[i]] += 1;
      }
    }
    return { count, symbol };
  }
  class BitReader {
    // Campo declarado à mão, e não `constructor(private input)`: o Node
    // roda os testes em modo strip-only, que não aceita a forma curta.
    constructor(input) {
      this.pos = 0;
      this.bitBuffer = 0;
      this.bitCount = 0;
      this.input = input;
    }
    bits(need) {
      let value = this.bitBuffer;
      while (this.bitCount < need) {
        if (this.pos >= this.input.length) {
          throw new Error("deflate: fim inesperado dos dados");
        }
        value |= this.input[this.pos] << this.bitCount;
        this.pos += 1;
        this.bitCount += 8;
      }
      this.bitBuffer = value >>> need;
      this.bitCount -= need;
      return value & (1 << need) - 1;
    }
    /** Bloco sem compressão começa alinhado em byte. */
    alignToByte() {
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
    bytes(length) {
      if (this.pos + length > this.input.length) {
        throw new Error("deflate: bloco sem compressão passa do fim");
      }
      const slice = this.input.subarray(this.pos, this.pos + length);
      this.pos += length;
      return slice;
    }
    decode(code) {
      let value = 0;
      let first = 0;
      let index = 0;
      for (let len = 1; len <= MAX_BITS; len += 1) {
        value |= this.bits(1);
        const count = code.count[len];
        if (value - count < first) {
          return code.symbol[index + (value - first)];
        }
        index += count;
        first += count;
        first <<= 1;
        value <<= 1;
      }
      throw new Error("deflate: código de Huffman inválido");
    }
  }
  class Output {
    constructor(expected) {
      this.length = 0;
      this.buffer = new Uint8Array(Math.max(expected, 1024));
    }
    ensure(extra) {
      if (this.length + extra <= this.buffer.length) {
        return;
      }
      let size = this.buffer.length * 2;
      while (size < this.length + extra) {
        size *= 2;
      }
      const bigger = new Uint8Array(size);
      bigger.set(this.buffer.subarray(0, this.length));
      this.buffer = bigger;
    }
    push(byte) {
      this.ensure(1);
      this.buffer[this.length] = byte;
      this.length += 1;
    }
    pushAll(bytes) {
      this.ensure(bytes.length);
      this.buffer.set(bytes, this.length);
      this.length += bytes.length;
    }
    /** Copia `length` bytes de `distance` atrás — a cópia pode se sobrepor. */
    copyBack(distance2, length) {
      if (distance2 > this.length) {
        throw new Error("deflate: distância aponta antes do começo");
      }
      this.ensure(length);
      let from = this.length - distance2;
      for (let i = 0; i < length; i += 1) {
        this.buffer[this.length] = this.buffer[from];
        this.length += 1;
        from += 1;
      }
    }
    result() {
      return this.buffer.slice(0, this.length);
    }
  }
  let fixedLiteral = null;
  let fixedDistance = null;
  function fixedCodes() {
    if (!fixedLiteral || !fixedDistance) {
      const lengths = new Uint8Array(288);
      lengths.fill(8, 0, 144);
      lengths.fill(9, 144, 256);
      lengths.fill(7, 256, 280);
      lengths.fill(8, 280, 288);
      fixedLiteral = buildHuffman(lengths, 288);
      const dist = new Uint8Array(30);
      dist.fill(5);
      fixedDistance = buildHuffman(dist, 30);
    }
    return { literal: fixedLiteral, distance: fixedDistance };
  }
  function inflateCodes(reader, out, literal, distance2) {
    for (; ; ) {
      const symbol = reader.decode(literal);
      if (symbol < 256) {
        out.push(symbol);
        continue;
      }
      if (symbol === 256) {
        return;
      }
      const li = symbol - 257;
      if (li >= LENGTH_BASE.length) {
        throw new Error("deflate: símbolo de comprimento inválido");
      }
      const length = LENGTH_BASE[li] + reader.bits(LENGTH_EXTRA[li]);
      const di = reader.decode(distance2);
      if (di >= DIST_BASE.length) {
        throw new Error("deflate: símbolo de distância inválido");
      }
      const dist = DIST_BASE[di] + reader.bits(DIST_EXTRA[di]);
      out.copyBack(dist, length);
    }
  }
  function dynamicCodes(reader) {
    const nlen = reader.bits(5) + 257;
    const ndist = reader.bits(5) + 1;
    const ncode = reader.bits(4) + 4;
    if (nlen > 286 || ndist > 30) {
      throw new Error("deflate: tabela dinâmica fora dos limites");
    }
    const codeLengths = new Uint8Array(19);
    for (let i = 0; i < ncode; i += 1) {
      codeLengths[CODE_ORDER[i]] = reader.bits(3);
    }
    const codeCode = buildHuffman(codeLengths, 19);
    const lengths = new Uint8Array(nlen + ndist);
    let index = 0;
    while (index < nlen + ndist) {
      const symbol = reader.decode(codeCode);
      if (symbol < 16) {
        lengths[index] = symbol;
        index += 1;
        continue;
      }
      let repeat;
      let value = 0;
      if (symbol === 16) {
        if (index === 0) {
          throw new Error("deflate: repetição sem comprimento anterior");
        }
        value = lengths[index - 1];
        repeat = 3 + reader.bits(2);
      } else if (symbol === 17) {
        repeat = 3 + reader.bits(3);
      } else {
        repeat = 11 + reader.bits(7);
      }
      if (index + repeat > nlen + ndist) {
        throw new Error("deflate: repetição passa da tabela");
      }
      lengths.fill(value, index, index + repeat);
      index += repeat;
    }
    return {
      literal: buildHuffman(lengths.subarray(0, nlen), nlen),
      distance: buildHuffman(lengths.subarray(nlen), ndist)
    };
  }
  function inflateRaw(input, expected = 0) {
    const reader = new BitReader(input);
    const out = new Output(expected);
    let last = 0;
    do {
      last = reader.bits(1);
      const type = reader.bits(2);
      if (type === 0) {
        reader.alignToByte();
        const header = reader.bytes(4);
        const length = header[0] | header[1] << 8;
        const check = header[2] | header[3] << 8;
        if ((length ^ 65535) !== check) {
          throw new Error("deflate: bloco sem compressão com tamanho corrompido");
        }
        out.pushAll(reader.bytes(length));
      } else if (type === 1) {
        const { literal, distance: distance2 } = fixedCodes();
        inflateCodes(reader, out, literal, distance2);
      } else if (type === 2) {
        const { literal, distance: distance2 } = dynamicCodes(reader);
        inflateCodes(reader, out, literal, distance2);
      } else {
        throw new Error("deflate: tipo de bloco reservado");
      }
    } while (!last);
    return out.result();
  }
  const CHUNK = 8192;
  function utf8Encode(text2) {
    const out = new Uint8Array(text2.length * 4);
    let at2 = 0;
    for (let index = 0; index < text2.length; index += 1) {
      let code = text2.charCodeAt(index);
      if (code >= 55296 && code <= 56319 && index + 1 < text2.length) {
        const low = text2.charCodeAt(index + 1);
        if (low >= 56320 && low <= 57343) {
          code = 65536 + (code - 55296 << 10) + (low - 56320);
          index += 1;
        }
      }
      if (code >= 55296 && code <= 57343) {
        code = 65533;
      }
      if (code < 128) {
        out[at2] = code;
        at2 += 1;
      } else if (code < 2048) {
        out[at2] = 192 | code >> 6;
        out[at2 + 1] = 128 | code & 63;
        at2 += 2;
      } else if (code < 65536) {
        out[at2] = 224 | code >> 12;
        out[at2 + 1] = 128 | code >> 6 & 63;
        out[at2 + 2] = 128 | code & 63;
        at2 += 3;
      } else {
        out[at2] = 240 | code >> 18;
        out[at2 + 1] = 128 | code >> 12 & 63;
        out[at2 + 2] = 128 | code >> 6 & 63;
        out[at2 + 3] = 128 | code & 63;
        at2 += 4;
      }
    }
    return out.subarray(0, at2);
  }
  function utf8Decode(bytes) {
    const units = [];
    let out = "";
    const flush = () => {
      if (units.length > 0) {
        out += String.fromCharCode(...units);
        units.length = 0;
      }
    };
    for (let at2 = 0; at2 < bytes.length; ) {
      const first = bytes[at2];
      let code;
      let size;
      let lowSecond = 128;
      let highSecond = 191;
      if (first < 128) {
        code = first;
        size = 1;
      } else if (first >= 194 && first <= 223) {
        code = first & 31;
        size = 2;
      } else if (first >= 224 && first <= 239) {
        code = first & 15;
        size = 3;
        if (first === 224) lowSecond = 160;
        if (first === 237) highSecond = 159;
      } else if (first >= 240 && first <= 244) {
        code = first & 7;
        size = 4;
        if (first === 240) lowSecond = 144;
        if (first === 244) highSecond = 143;
      } else {
        units.push(65533);
        at2 += 1;
        continue;
      }
      let broken = false;
      for (let step2 = 1; step2 < size; step2 += 1) {
        const next = at2 + step2 < bytes.length ? bytes[at2 + step2] : -1;
        const low = step2 === 1 ? lowSecond : 128;
        const high = step2 === 1 ? highSecond : 191;
        if (next < low || next > high) {
          broken = true;
          break;
        }
        code = code << 6 | next & 63;
      }
      if (broken) {
        units.push(65533);
        at2 += 1;
        continue;
      }
      at2 += size;
      if (code < 65536) {
        units.push(code);
      } else {
        const rest = code - 65536;
        units.push(55296 + (rest >> 10), 56320 + (rest & 1023));
      }
      if (units.length >= CHUNK) {
        flush();
      }
    }
    flush();
    return out;
  }
  const SIG_LOCAL = 67324752;
  const SIG_CENTRAL = 33639248;
  const SIG_END = 101010256;
  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  function listEntries(zip) {
    const view = viewOf(zip);
    let end = zip.length - 22;
    const floor = Math.max(0, zip.length - 22 - 65535);
    while (end >= floor && view.getUint32(end, true) !== SIG_END) {
      end -= 1;
    }
    if (end < floor) {
      throw new Error("mogrt: não é um ZIP (sem registro de fim)");
    }
    const total = view.getUint16(end + 10, true);
    let at2 = view.getUint32(end + 16, true);
    const entries = [];
    for (let index = 0; index < total; index += 1) {
      if (view.getUint32(at2, true) !== SIG_CENTRAL) {
        throw new Error("mogrt: diretório central corrompido");
      }
      const method = view.getUint16(at2 + 10, true);
      const dosTime = view.getUint16(at2 + 12, true);
      const dosDate = view.getUint16(at2 + 14, true);
      const crc = view.getUint32(at2 + 16, true);
      const compressedSize = view.getUint32(at2 + 20, true);
      const size = view.getUint32(at2 + 24, true);
      const nameLength = view.getUint16(at2 + 28, true);
      const extraLength = view.getUint16(at2 + 30, true);
      const commentLength = view.getUint16(at2 + 32, true);
      const localOffset = view.getUint32(at2 + 42, true);
      const name = utf8Decode(zip.subarray(at2 + 46, at2 + 46 + nameLength));
      if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
        throw new Error(`mogrt: cabeçalho local de "${name}" corrompido`);
      }
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localName + localExtra;
      entries.push({ name, method, compressedSize, size, crc, dosTime, dosDate, dataOffset });
      at2 += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }
  function readEntry(zip, entry) {
    const packed = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    if (entry.method === 0) {
      return packed.slice();
    }
    if (entry.method === 8) {
      return inflateRaw(packed, entry.size);
    }
    throw new Error(`mogrt: "${entry.name}" usa compressão ${entry.method}, que não sei ler`);
  }
  function readTextEntry(zip, name) {
    const entry = listEntries(zip).find((item) => item.name === name);
    return entry ? utf8Decode(readEntry(zip, entry)) : null;
  }
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
          c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
        }
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 4294967295;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = crcTable[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
    }
    return (crc ^ 4294967295) >>> 0;
  }
  class Sink {
    constructor() {
      this.buffer = new Uint8Array(1 << 16);
      this.length = 0;
    }
    ensure(extra) {
      if (this.length + extra <= this.buffer.length) {
        return;
      }
      let size = this.buffer.length * 2;
      while (size < this.length + extra) {
        size *= 2;
      }
      const bigger = new Uint8Array(size);
      bigger.set(this.buffer.subarray(0, this.length));
      this.buffer = bigger;
    }
    u16(value) {
      this.ensure(2);
      this.buffer[this.length] = value & 255;
      this.buffer[this.length + 1] = value >>> 8 & 255;
      this.length += 2;
    }
    u32(value) {
      this.ensure(4);
      this.buffer[this.length] = value & 255;
      this.buffer[this.length + 1] = value >>> 8 & 255;
      this.buffer[this.length + 2] = value >>> 16 & 255;
      this.buffer[this.length + 3] = value >>> 24 & 255;
      this.length += 4;
    }
    bytes(data) {
      this.ensure(data.length);
      this.buffer.set(data, this.length);
      this.length += data.length;
    }
    result() {
      return this.buffer.slice(0, this.length);
    }
  }
  function writeZip(entries) {
    const sink = new Sink();
    const offsets = [];
    for (const entry of entries) {
      offsets.push(sink.length);
      sink.u32(SIG_LOCAL);
      sink.u16(20);
      sink.u16(0);
      sink.u16(entry.method);
      sink.u16(entry.dosTime);
      sink.u16(entry.dosDate);
      sink.u32(entry.crc);
      sink.u32(entry.compressedSize);
      sink.u32(entry.size);
      sink.u16(entry.name.length);
      sink.u16(0);
      sink.bytes(entry.name);
      sink.bytes(entry.data);
    }
    const centralStart = sink.length;
    entries.forEach((entry, index) => {
      sink.u32(SIG_CENTRAL);
      sink.u16(20);
      sink.u16(20);
      sink.u16(0);
      sink.u16(entry.method);
      sink.u16(entry.dosTime);
      sink.u16(entry.dosDate);
      sink.u32(entry.crc);
      sink.u32(entry.compressedSize);
      sink.u32(entry.size);
      sink.u16(entry.name.length);
      sink.u16(0);
      sink.u16(0);
      sink.u16(0);
      sink.u16(0);
      sink.u32(0);
      sink.u32(offsets[index]);
      sink.bytes(entry.name);
    });
    const centralSize = sink.length - centralStart;
    sink.u32(SIG_END);
    sink.u16(0);
    sink.u16(0);
    sink.u16(entries.length);
    sink.u16(entries.length);
    sink.u32(centralSize);
    sink.u32(centralStart);
    sink.u16(0);
    return sink.result();
  }
  const DROPPED = /* @__PURE__ */ new Set(["thumb.mp4"]);
  function rewriteMogrt(zip, definitionJson) {
    const entries = listEntries(zip);
    const original = entries.find((entry) => entry.name === "definition.json");
    if (!original) {
      throw new Error("mogrt: o pacote não tem definition.json");
    }
    const definition = utf8Encode(definitionJson);
    const outgoing = [
      {
        name: utf8Encode("definition.json"),
        method: 0,
        crc: crc32(definition),
        compressedSize: definition.length,
        size: definition.length,
        dosTime: original.dosTime,
        dosDate: original.dosDate,
        data: definition
      }
    ];
    for (const entry of entries) {
      if (entry.name === "definition.json" || DROPPED.has(entry.name)) {
        continue;
      }
      outgoing.push({
        name: utf8Encode(entry.name),
        method: entry.method,
        crc: entry.crc,
        compressedSize: entry.compressedSize,
        size: entry.size,
        dosTime: entry.dosTime,
        dosDate: entry.dosDate,
        data: zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize)
      });
    }
    return writeZip(outgoing);
  }
  const PREVIEW_FOLDER = "title-previews";
  const FRAME_COUNT = 30;
  const FRAME_MS = 83;
  function slugFor(name) {
    return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "modelo";
  }
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let out = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index];
      const b = bytes[index + 1];
      const c = bytes[index + 2];
      const has2 = b !== void 0;
      const has3 = c !== void 0;
      out += ALPHABET[a >> 2];
      out += ALPHABET[(a & 3) << 4 | (has2 ? b >> 4 : 0)];
      out += has2 ? ALPHABET[(b & 15) << 2 | (has3 ? c >> 6 : 0)] : "=";
      out += has3 ? ALPHABET[c & 63] : "=";
    }
    return out;
  }
  async function readImage(space, relative) {
    const bytes = await readWorkBytes(space, relative);
    if (bytes && bytes.length > 0) {
      return `data:image/png;base64,${toBase64(bytes)}`;
    }
    return null;
  }
  async function readTemplateStyles() {
    const styles = /* @__PURE__ */ new Map();
    try {
      const raw = readText$1(await workspace(), `${PREVIEW_FOLDER}/index.json`);
      if (!raw) {
        return styles;
      }
      const parsed = JSON.parse(raw);
      for (const [name, entry] of Object.entries(parsed ?? {})) {
        styles.set(name, {
          fonte: typeof entry?.fonte === "string" ? entry.fonte : null,
          corpo: typeof entry?.corpo === "number" ? entry.corpo : null,
          campos: typeof entry?.campos === "number" && entry.campos > 0 ? entry.campos : 1
        });
      }
    } catch (cause) {
      console.warn("[Textos] índice de modelos ilegível:", cause);
    }
    return styles;
  }
  async function postersFor(names) {
    const found = /* @__PURE__ */ new Map();
    let space;
    try {
      space = await workspace();
    } catch {
      return found;
    }
    for (const name of names) {
      const poster = await readImage(space, `${PREVIEW_FOLDER}/${slugFor(name)}.png`);
      if (poster) {
        found.set(name, poster);
      }
    }
    await write(
      space,
      "previews-diag.txt",
      [
        `Framelab — prévias · ${(/* @__PURE__ */ new Date()).toISOString()}`,
        `pasta fs: ${space.fsBase}`,
        `pasta nativa: ${space.nativeBase}`,
        `modelos: ${names.length} · cartazes: ${found.size}`,
        `última leitura: ${lastReadNote() || "(nada tentado)"}`,
        names.length > 0 ? `exemplo: ${PREVIEW_FOLDER}/${slugFor(names[0])}.png` : ""
      ].join("\n") + "\n"
    ).catch(() => void 0);
    return found;
  }
  async function framesFor(name) {
    let space;
    try {
      space = await workspace();
    } catch {
      return [];
    }
    const frames = [];
    const slug = slugFor(name);
    for (let index = 1; index <= FRAME_COUNT; index += 1) {
      const file = `${PREVIEW_FOLDER}/${slug}.f${String(index).padStart(2, "0")}.png`;
      const frame = await readImage(space, file);
      if (!frame) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }
  const CACHE_FOLDER = "mogrt-cache";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  async function loadTemplate(path) {
    const zip = await readNativeBytes(path);
    if (!zip || zip.length === 0) {
      throw new Error(`não consegui ler o modelo (${lastReadNote()})`);
    }
    const definition = readTextEntry(zip, "definition.json");
    if (!definition) {
      throw new Error("o modelo não tem definition.json — não é um .mogrt");
    }
    const name = path.split(/[\\/]/).pop()?.replace(/\.mogrt$/i, "") || "modelo";
    return { path, name, zip, definition };
  }
  let sweptAt = 0;
  const SWEEP_EVERY_MS = 60 * 1e3;
  async function sweepCache() {
    if (Date.now() - sweptAt < SWEEP_EVERY_MS) {
      return;
    }
    sweptAt = Date.now();
    const fs = fsModule();
    if (!fs) {
      return;
    }
    try {
      const space = await workspace();
      const folder = fsPath(space, CACHE_FOLDER);
      const names = fs.readdir ? await fs.readdir(folder) : fs.readdirSync ? fs.readdirSync(folder) : [];
      const now = Date.now();
      for (const name of names ?? []) {
        const stamp = /-(\d{13})-/.exec(name);
        if (stamp && now - Number(stamp[1]) > CACHE_TTL_MS && fs.unlink) {
          await fs.unlink(`${folder}/${name}`).catch(() => void 0);
        }
      }
    } catch {
    }
  }
  async function prepareMogrt(template, patch) {
    const patched = patchDefinition(template.definition, patch);
    const bytes = rewriteMogrt(template.zip, patched.json);
    const space = await workspace();
    await ensureDir(space, CACHE_FOLDER);
    await sweepCache();
    const stamp = Date.now();
    const salt = Math.floor(Math.random() * 65535).toString(16).padStart(4, "0");
    const file = `${CACHE_FOLDER}/${slugFor(template.name)}-${stamp}-${salt}.mogrt`;
    writeWorkBytes(space, file, bytes);
    return {
      path: nativePath(space, file),
      capsuleName: patched.capsuleName,
      textApplied: patched.textApplied,
      fontApplied: patched.fontApplied,
      sizeApplied: patched.sizeApplied,
      textFields: patched.textFields,
      parts: patched.parts,
      bytes: bytes.length
    };
  }
  function patchFor(text2, style) {
    return { text: text2, font: style?.font || void 0, size: style?.size || void 0 };
  }
  function fail$1(message, report2 = []) {
    return { ok: false, message, report: report2 };
  }
  const REPORT_FILE$1 = "titles-report.txt";
  async function saveReport(lines) {
    try {
      const space = await workspace();
      await write(space, REPORT_FILE$1, lines.join("\n") + "\n");
      return nativePath(space, REPORT_FILE$1);
    } catch (cause) {
      console.warn("[Textos] não consegui gravar o relatório:", cause);
      return null;
    }
  }
  function resolveEditor(ppro, sequence2) {
    const api = ppro.SequenceEditor;
    try {
      if (typeof api?.getEditor === "function") {
        return api.getEditor(sequence2) ?? null;
      }
      if (typeof api?.createForSequence === "function") {
        return api.createForSequence(sequence2) ?? null;
      }
    } catch (cause) {
      console.error("[Textos] SequenceEditor indisponível:", cause);
    }
    return null;
  }
  async function insertionPoint(ppro, sequence2, request) {
    const playhead = async () => (await sequence2.getPlayerPosition().catch(() => null))?.seconds ?? 0;
    if (request.atPlayhead) {
      return playhead();
    }
    const selected = await collectSelectedVideoClips(ppro, sequence2).catch(() => []);
    const starts = [];
    for (const ref of selected) {
      const start = await ref.clip.getStartTime?.().catch(() => null);
      if (start && Number.isFinite(start.seconds)) {
        starts.push(start.seconds);
      }
    }
    return starts.length > 0 ? Math.min(...starts) : playhead();
  }
  async function freeTrack(ppro, sequence2, trackCount, startSeconds, endSeconds, report2) {
    for (let index = trackCount - 1; index >= 0; index -= 1) {
      const track = await sequence2.getVideoTrack(index).catch(() => null);
      if (!track) {
        continue;
      }
      const locked = track.isLocked;
      if (typeof locked === "function" && await locked.call(track).catch(() => false)) {
        report2.push(`V${index + 1}: travada.`);
        continue;
      }
      let items = [];
      try {
        items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      } catch (cause) {
        report2.push(`V${index + 1}: não deu para ler (${describeError$1(cause)}).`);
        continue;
      }
      const spans = await Promise.all(
        items.map(async (item) => {
          const from = await item.getStartTime().catch(() => null);
          const to = await item.getEndTime().catch(() => null);
          return from && to ? { from: from.seconds, to: to.seconds } : null;
        })
      );
      const busy2 = spans.some(
        (span) => span && span.from < endSeconds && span.to > startSeconds
      );
      if (!busy2) {
        report2.push(`V${index + 1}: livre no trecho — é ela.`);
        return index;
      }
      report2.push(`V${index + 1}: ocupada no trecho.`);
    }
    return null;
  }
  function insertRefusal(trackIndex, trackCount) {
    return trackIndex >= trackCount ? "Não há trilha de vídeo livre neste trecho e o Premiere não criou uma. No Premiere, clique com o botão direito no cabeçalho das trilhas → Adicionar trilha, e tente de novo." : "O Premiere não inseriu o modelo. Confira se o After Effects está instalado (os modelos são dele) e se a trilha está destravada.";
  }
  async function applyTitle(request) {
    const report2 = [];
    const result = await run$1(request, report2);
    const path = await saveReport([
      `Framelab — Textos Animados · ${(/* @__PURE__ */ new Date()).toISOString()}`,
      result.ok ? "RESULTADO: ok" : `RESULTADO: ${result.message}`,
      "",
      ...report2
    ]);
    return {
      ...result,
      report: path ? [...report2, "", `Relatório salvo em: ${path}`] : report2
    };
  }
  async function run$1(request, report2) {
    const ppro = getPremiere();
    if (!ppro) {
      return fail$1("Premiere UXP indisponível neste build.");
    }
    if (!request.templatePath) {
      return fail$1("Escolha um modelo de texto.");
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      if (!project2) {
        return fail$1("Nenhum projeto aberto.");
      }
      const sequence2 = await project2.getActiveSequence();
      if (!sequence2) {
        return fail$1("Abra uma sequência na timeline primeiro.");
      }
      const editor = resolveEditor(ppro, sequence2);
      if (!editor || typeof editor.insertMogrtFromPath !== "function") {
        return fail$1(
          "Esta versão do Premiere não aceita inserir modelo (.mogrt) pelo painel."
        );
      }
      const trackCount = await sequence2.getVideoTrackCount();
      if (!(trackCount > 0)) {
        return fail$1("A sequência não tem trilha de vídeo.");
      }
      const text2 = request.text.trim();
      let mogrtPath = request.templatePath;
      if (text2) {
        const template = await loadTemplate(request.templatePath);
        const prepared = await prepareMogrt(template, patchFor(text2, request.style));
        report2.push(
          `Cópia gerada: "${prepared.capsuleName}" (${Math.round(prepared.bytes / 1024)} KB) em ${prepared.path}`
        );
        report2.push(
          `texto: ${prepared.textApplied ? "trocado" : "o modelo não expõe controle de texto"} · campos: ${prepared.textFields}` + (prepared.textFields > 1 ? ` [${prepared.parts.map((part) => JSON.stringify(part)).join(", ")}]` : "") + (request.style?.font ? ` · fonte: ${prepared.fontApplied ? "trocada" : "não aceita"}` : "")
        );
        if (!prepared.textApplied) {
          return fail$1(
            "Esse modelo não tem controle de texto — não dá para escrever nele. Escolha outro.",
            report2
          );
        }
        mogrtPath = prepared.path;
      }
      const startSeconds = Math.max(0, await insertionPoint(ppro, sequence2, request));
      const start = ppro.TickTime.createWithSeconds(startSeconds);
      const span = request.durationSeconds > 0 ? request.durationSeconds : 5;
      let trackIndex;
      if (request.trackIndex >= 0) {
        trackIndex = Math.min(request.trackIndex, trackCount - 1);
        report2.push(`Trilha escolhida à mão: V${trackIndex + 1}.`);
      } else {
        const free = await freeTrack(ppro, sequence2, trackCount, startSeconds, startSeconds + span, report2);
        trackIndex = free ?? trackCount;
        if (free === null) {
          report2.push(`Nenhuma trilha livre no trecho; tentando V${trackCount + 1} (acima do topo).`);
        }
      }
      report2.push(`Inserindo em V${trackIndex + 1}, aos ${startSeconds.toFixed(2)}s.`);
      let inserted = [];
      let insertError = "";
      project2.lockedAccess(() => {
        try {
          inserted = editor.insertMogrtFromPath(mogrtPath, start, trackIndex, 0);
        } catch (cause) {
          insertError = describeError$1(cause);
        }
      });
      if (insertError) {
        report2.push(`insertMogrtFromPath: ${insertError}`);
      }
      if (!Array.isArray(inserted) || inserted.length === 0) {
        return fail$1(insertRefusal(trackIndex, trackCount), report2);
      }
      report2.push(`O host devolveu ${inserted.length} item(ns).`);
      const clip = inserted[0];
      let trimmed = true;
      if (request.durationSeconds > 0) {
        const end = ppro.TickTime.createWithSeconds(startSeconds + request.durationSeconds);
        project2.lockedAccess(() => {
          try {
            trimmed = project2.executeTransaction((compound) => {
              compound.addAction(clip.createSetEndAction(end));
            }, "Duração do título");
          } catch (cause) {
            trimmed = false;
            report2.push(`Duração recusada: ${describeError$1(cause)}`);
          }
        });
        report2.push(
          trimmed ? `Duração ajustada para ${request.durationSeconds}s.` : "Duração ficou a do modelo."
        );
      }
      return {
        ok: true,
        message: text2 ? `Título em V${trackIndex + 1}${trimmed ? "" : " (duração do modelo)"}.` : `Modelo em V${trackIndex + 1} com o texto de fábrica.`,
        report: report2
      };
    } catch (cause) {
      report2.push(`Erro: ${describeError$1(cause)}`);
      return fail$1(describeError$1(cause), report2);
    }
  }
  function parseTimecode(value) {
    const match = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*$/.exec(value);
    if (!match) {
      return null;
    }
    const [, hours, minutes, seconds2, fraction] = match;
    const millis = Number(fraction.padEnd(3, "0"));
    return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds2) + millis / 1e3;
  }
  function cuesFromSrt(raw) {
    const document2 = parseSrt(raw);
    const cues = [];
    for (const block of document2.cues) {
      const [from, to] = block.timing.split("-->");
      if (!from || !to) {
        continue;
      }
      const start = parseTimecode(from);
      const end = parseTimecode(to.split(/\s{2,}|\t| line:| align:/)[0]);
      const text2 = block.lines.join("\n").trim();
      if (start === null || end === null || !text2) {
        continue;
      }
      cues.push({ start, end: Math.max(end, start + 0.1), text: text2 });
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  function withoutOverlap(cues) {
    const out = [];
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      const next = cues[index + 1];
      const end = next ? Math.min(cue.end, next.start) : cue.end;
      if (end > cue.start) {
        out.push({ ...cue, end });
      }
    }
    return out;
  }
  function cueSpan(cues) {
    if (cues.length === 0) {
      return { start: 0, end: 0 };
    }
    return {
      start: cues[0].start,
      end: cues.reduce((last, cue) => Math.max(last, cue.end), 0)
    };
  }
  function groupCues(cues, maxSeconds, maxChars = 63, maxGap = 0.7) {
    if (maxSeconds <= 0 || cues.length === 0) {
      return [...cues];
    }
    const out = [];
    let open = null;
    for (const cue of cues) {
      if (!open) {
        open = { start: cue.start, end: cue.end, text: cue.text };
        continue;
      }
      const oneLine = (value) => value.replace(/\s*\r?\n\s*/g, " ");
      const joined = `${oneLine(open.text)} ${oneLine(cue.text)}`.trim();
      const fits = cue.end - open.start <= maxSeconds && joined.length <= maxChars && cue.start - open.end <= maxGap;
      if (fits) {
        open = { start: open.start, end: cue.end, text: joined };
      } else {
        out.push({ ...open });
        open = { start: cue.start, end: cue.end, text: cue.text };
      }
    }
    if (open) {
      out.push(open);
    }
    return out;
  }
  function wrapCues(cues, maxLineChars = 21, maxLines = 3) {
    return cues.map((cue) => ({
      ...cue,
      text: wrap(cue.text.replace(/\s*\r?\n\s*/g, " "), {
        ...SRT_DEFAULTS,
        maxLineChars,
        maxLines
      }).join("\n")
    }));
  }
  const PACE_MS = 60;
  const BREATH_EVERY = 10;
  const BREATH_MS = 300;
  const MAX_PIECES = 40;
  function fail(message, report2, inserted = 0) {
    return { ok: false, message, inserted, report: report2 };
  }
  async function countGraphicsBin(ppro, project2) {
    try {
      const root2 = await project2.getRootItem();
      const items = await root2.getItems();
      for (const item of items) {
        const name = item.name ?? "";
        if (!/motion graphics/i.test(name)) {
          continue;
        }
        const folder = ppro.FolderItem.cast(item);
        if (folder && typeof folder.getItems === "function") {
          return (await folder.getItems()).length;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  async function applyCaptions(request) {
    const report2 = [];
    const result = await run(request, report2);
    const path = await saveReport([
      `Framelab — Legendas Animadas · ${(/* @__PURE__ */ new Date()).toISOString()}`,
      `RESULTADO: ${result.ok ? "ok" : result.message}`,
      `Legendas: ${result.inserted} de ${request.cues.length}`,
      "",
      ...report2
    ]);
    return {
      ...result,
      report: path ? [...report2, "", `Relatório salvo em: ${path}`] : report2
    };
  }
  async function run(request, report2) {
    const ppro = getPremiere();
    if (!ppro) {
      return fail("Premiere UXP indisponível neste build.", report2);
    }
    if (!request.templatePath) {
      return fail("Escolha um modelo de legenda.", report2);
    }
    if (request.cues.length === 0) {
      return fail("O arquivo não tem nenhuma legenda legível.", report2);
    }
    if (request.cues.length > MAX_PIECES) {
      return fail(
        `${request.cues.length} legendas de uma vez passa do que este caminho aguenta (${MAX_PIECES}): cada uma é um modelo importado, e acima disso o Premiere põe as mídias offline e trava o preview.`,
        report2
      );
    }
    try {
      const project2 = await ppro.Project.getActiveProject();
      if (!project2) {
        return fail("Nenhum projeto aberto.", report2);
      }
      const sequence2 = await project2.getActiveSequence();
      if (!sequence2) {
        return fail("Abra uma sequência na timeline primeiro.", report2);
      }
      const editor = resolveEditor(ppro, sequence2);
      if (!editor || typeof editor.insertMogrtFromPath !== "function") {
        return fail("Esta versão do Premiere não insere modelo pelo painel.", report2);
      }
      const trackCount = await sequence2.getVideoTrackCount();
      if (!(trackCount > 0)) {
        return fail("A sequência não tem trilha de vídeo.", report2);
      }
      const binBefore = await countGraphicsBin(ppro, project2);
      const template = await loadTemplate(request.templatePath);
      report2.push(`Modelo lido: ${template.name} (${Math.round(template.zip.length / 1024)} KB).`);
      const span = cueSpan(request.cues);
      report2.push(
        `${request.cues.length} legendas, de ${span.start.toFixed(2)}s a ${span.end.toFixed(2)}s.`
      );
      for (const cue of request.cues.slice(0, 5)) {
        report2.push(
          `  ${cue.start.toFixed(2)} → ${cue.end.toFixed(2)}  ${JSON.stringify(cue.text)}`
        );
      }
      let trackIndex;
      if (request.trackIndex >= 0) {
        trackIndex = Math.min(request.trackIndex, trackCount - 1);
        report2.push(`Trilha escolhida à mão: V${trackIndex + 1}.`);
      } else {
        const free = await freeTrack(ppro, sequence2, trackCount, span.start, span.end, report2);
        trackIndex = free ?? trackCount;
        if (free === null) {
          report2.push(`Sem trilha livre; tentando V${trackCount + 1}.`);
        }
      }
      let placed2 = 0;
      let trimmed = 0;
      let bytes = 0;
      const failures = [];
      for (let index = 0; index < request.cues.length; index += 1) {
        if (request.cancelled?.()) {
          report2.push(`Cancelado na peça ${index + 1}.`);
          break;
        }
        const cue = request.cues[index];
        const label = `${index + 1}/${request.cues.length}`;
        request.onProgress?.(index, request.cues.length);
        let prepared;
        try {
          prepared = await prepareMogrt(template, patchFor(cue.text, request.style));
        } catch (cause) {
          failures.push(`${label}: cópia falhou (${describeError$1(cause)})`);
          continue;
        }
        bytes += prepared.bytes;
        if (index === 0 && !prepared.textApplied) {
          return fail(
            "Esse modelo não tem controle de texto — não serve para legenda. Escolha outro.",
            report2
          );
        }
        let inserted = [];
        let insertError = "";
        project2.lockedAccess(() => {
          try {
            inserted = editor.insertMogrtFromPath(
              prepared.path,
              ppro.TickTime.createWithSeconds(cue.start),
              trackIndex,
              0
            );
          } catch (cause) {
            insertError = describeError$1(cause);
          }
        });
        if (!Array.isArray(inserted) || inserted.length === 0) {
          const why = insertError ? ` (${insertError})` : "";
          if (index === 0) {
            report2.push(`Primeira peça recusada${why}.`);
            return fail(insertRefusal(trackIndex, trackCount), report2);
          }
          failures.push(`${label}: recusada${why}`);
          continue;
        }
        placed2 += 1;
        const clip = inserted[0];
        let ok = false;
        project2.lockedAccess(() => {
          try {
            ok = project2.executeTransaction((compound) => {
              compound.addAction(
                clip.createSetEndAction(ppro.TickTime.createWithSeconds(cue.end))
              );
            }, "Duração da legenda");
          } catch (cause) {
            failures.push(`${label}: duração recusada (${describeError$1(cause)})`);
          }
        });
        if (ok) {
          trimmed += 1;
        }
        await wait$1(PACE_MS);
        if ((index + 1) % BREATH_EVERY === 0) {
          await wait$1(BREATH_MS);
        }
      }
      request.onProgress?.(request.cues.length, request.cues.length);
      const inBin = await countGraphicsBin(ppro, project2);
      if (inBin !== null) {
        report2.push(
          `Itens na bin de Motion Graphics: ${inBin} (eram ${binBefore ?? "?"} antes).`
        );
        if (binBefore !== null && inBin - binBefore < placed2) {
          report2.push(
            `Atenção: entraram ${placed2} peças e a bin cresceu ${inBin - binBefore}. As que não ganharam mídia aparecem deslinkadas na timeline.`
          );
        }
      }
      report2.push(
        `Peças: ${placed2} inseridas, ${trimmed} aparadas, ${Math.round(bytes / 1024)} KB de cópias.`
      );
      for (const failure of failures) {
        report2.push(`• ${failure}`);
      }
      if (placed2 === 0) {
        return fail("Nenhuma legenda entrou. O relatório abaixo diz por quê.", report2);
      }
      const missing = request.cues.length - placed2;
      const grew = binBefore !== null && inBin !== null ? inBin - binBefore : null;
      return {
        ok: true,
        message: `${placed2} legendas animadas em V${trackIndex + 1}` + (missing > 0 ? ` (${missing} ficaram de fora — ver relatório)` : "") + (trimmed < placed2 ? ` · ${placed2 - trimmed} com a duração do modelo` : "") + (grew !== null && grew < placed2 ? ` · só ${grew} ganharam mídia: confira a timeline` : "") + ".",
        inserted: placed2,
        report: report2
      };
    } catch (cause) {
      report2.push(`Erro: ${describeError$1(cause)}`);
      return fail(describeError$1(cause), report2);
    }
  }
  function localFs() {
    return uxpModule("uxp")?.storage?.localFileSystem ?? null;
  }
  let note = "";
  function lastFontNote() {
    return note;
  }
  function fontFolders(home, windows) {
    if (windows) {
      return [
        "C:\\Windows\\Fonts",
        home ? `${home}\\AppData\\Local\\Microsoft\\Windows\\Fonts` : ""
      ].filter(Boolean);
    }
    return [
      home ? `${home}/Library/Fonts` : "",
      "/Library/Fonts",
      "/System/Library/Fonts"
    ].filter(Boolean);
  }
  function fontNamesFrom(files) {
    const names = /* @__PURE__ */ new Set();
    for (const file of files) {
      const match = /^(.+)\.(otf|ttf)$/i.exec(file.trim());
      if (match) {
        names.add(match[1]);
      }
    }
    return [...names].sort(
      (a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })
    );
  }
  async function filesIn(folder) {
    const fs = uxpModule("fs");
    if (fs) {
      for (const target2 of [folder, fileUrl(folder)]) {
        try {
          const found = fs.readdir ? await fs.readdir(target2) : fs.readdirSync ? fs.readdirSync(target2) : null;
          if (found && found.length > 0) {
            return found;
          }
        } catch (cause) {
          note += ` · readdir(${target2.slice(0, 12)}…): ${String(cause).slice(0, 40)}`;
        }
      }
    }
    const lfs = localFs();
    if (typeof lfs?.getEntryWithUrl === "function") {
      try {
        const entry = await lfs.getEntryWithUrl(fileUrl(folder));
        const children = await entry.getEntries?.() ?? [];
        return children.map((child) => child.name ?? "").filter(Boolean);
      } catch (cause) {
        note += ` · getEntryWithUrl: ${String(cause).slice(0, 40)}`;
      }
    }
    return [];
  }
  async function listFonts() {
    note = "";
    const home = uxpModule("os")?.homedir?.() ?? "";
    const windows = isWindows();
    const files = [];
    for (const folder of fontFolders(home, windows)) {
      const found = await filesIn(folder);
      note += ` · ${folder}: ${found.length}`;
      files.push(...found);
    }
    const names = fontNamesFrom(files);
    note = `${names.length} fontes${note}`;
    return names;
  }
  function defaultLibrary() {
    const home = uxpModule("os")?.homedir?.() ?? "";
    return home ? `${home}/Documents/Editor Black Belt/Titulos` : "";
  }
  function isMogrt(fileName) {
    return /\.mogrt$/i.test(fileName);
  }
  function templateName(fileName) {
    return fileName.replace(/\.mogrt$/i, "").trim() || fileName;
  }
  function templatesFrom(folder, fileNames) {
    const base = folder.replace(/[\\/]+$/, "");
    return fileNames.filter(isMogrt).map((fileName) => ({ path: `${base}/${fileName}`, name: templateName(fileName) })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
  }
  async function listTemplates(folder) {
    if (!folder) {
      return [];
    }
    const fs = uxpModule("fs");
    if (!fs) {
      return [];
    }
    try {
      const names = fs.readdir ? await fs.readdir(folder) : fs.readdirSync ? fs.readdirSync(folder) : [];
      return templatesFrom(folder, names ?? []);
    } catch (cause) {
      console.warn("[Textos] não consegui ler a pasta de modelos:", cause);
      return [];
    }
  }
  async function templatesFromEntry(folder) {
    const entries = await folder.getEntries?.() ?? [];
    const found = [];
    for (const entry of entries) {
      const name = entry?.name ?? "";
      const path = entry?.nativePath ?? "";
      if (name && path && isMogrt(name)) {
        found.push({ path, name: templateName(name) });
      }
    }
    return found.sort(
      (a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
    );
  }
  const GROUPS = [
    { id: "srt", label: "Do .srt", seconds: 0 },
    { id: "2", label: "≤ 2 s", seconds: 2 },
    { id: "25", label: "≤ 2,5 s", seconds: 2.5 },
    { id: "4", label: "≤ 4 s", seconds: 4 }
  ];
  const DURATIONS = [
    { id: "model", label: "Do modelo", seconds: 0 },
    { id: "2", label: "2 s", seconds: 2 },
    { id: "3", label: "3 s", seconds: 3 },
    { id: "5", label: "5 s", seconds: 5 }
  ];
  const DEFAULTS = {
    library: "",
    template: "",
    duration: "model",
    modo: "titulo",
    font: "",
    group: 0,
    trackIndex: -1,
    atPlayhead: true
  };
  const settings$1 = createToolSettings(
    "titles-config.json",
    DEFAULTS,
    (raw) => ({
      library: pickString(raw.library, ""),
      template: pickString(raw.template, ""),
      duration: DURATIONS.some((item) => item.id === raw.duration) ? raw.duration : "model",
      modo: raw.modo === "legenda" ? "legenda" : "titulo",
      font: pickString(raw.font, ""),
      group: GROUPS.some((item) => item.seconds === raw.group) ? raw.group : 0,
      trackIndex: Math.round(clampNumber(raw.trackIndex, -1, 98, -1)),
      atPlayhead: raw.atPlayhead !== false
    })
  );
  warmToolSettings(settings$1);
  let releaseDocument = null;
  let flipTimer = null;
  const HOVER_MS = 140;
  let hoverTimer = null;
  function stopFlip() {
    if (flipTimer !== null) {
      clearInterval(flipTimer);
      flipTimer = null;
    }
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }
  function secondsFor(id) {
    return DURATIONS.find((item) => item.id === id)?.seconds ?? 0;
  }
  const titlesTool = {
    id: "titles",
    name: "Textos Animados",
    summary: "Título ou legenda .srt que já entram animados",
    hint: "Um título na agulha, ou um .srt inteiro virando legenda animada. O painel usa a trilha de cima que estiver livre no trecho — nunca por cima de um vídeo — e preserva a tipografia do modelo, trocando só a frase.",
    category: "texto",
    glyph: "title",
    available: true,
    usesSelection: false,
    mount(container, context) {
      const saved = settings$1.peek() ?? DEFAULTS;
      let config = { ...saved };
      if (!config.library) {
        config.library = defaultLibrary();
      }
      let templates = [];
      let srt = null;
      let applied = 0;
      let trackCount = 0;
      let busy2 = false;
      let cancelled = false;
      let fonts = [];
      container.innerHTML = markup$2(config);
      const textEl = container.querySelector("[data-text]");
      const modeSeg = container.querySelector("[data-mode-seg]");
      const textField = container.querySelector("[data-text-field]");
      const srtField = container.querySelector("[data-srt-field]");
      const srtInfoEl = container.querySelector("[data-srt-info]");
      const pickSrtEl = container.querySelector("[data-pick-srt]");
      const projectSrtEl = container.querySelector("[data-project-srt]");
      const srtListEl = container.querySelector("[data-srt-list]");
      const srtWarnEl = container.querySelector("[data-srt-warn]");
      const groupSeg = container.querySelector("[data-group-seg]");
      const galleryEl = container.querySelector("[data-gallery]");
      const stageImgEl = container.querySelector("[data-stage-img]");
      const stageNameEl = container.querySelector("[data-stage-name]");
      const fontHost = container.querySelector("[data-font-pick]");
      const fontEl = container.querySelector("[data-font]");
      const fieldsNoteEl = container.querySelector("[data-fields-note]");
      const trackHost = container.querySelector("[data-track-pick]");
      const durationSeg = container.querySelector("[data-duration-seg]");
      const whereSeg = container.querySelector("[data-where-seg]");
      const libEl = container.querySelector("[data-library]");
      const pickLibEl = container.querySelector("[data-pick-library]");
      const reloadEl = container.querySelector("[data-reload]");
      const reportEl = container.querySelector("[data-report]");
      const advToggleEl = container.querySelector("[data-adv-toggle]");
      const advContentEl = container.querySelector("[data-adv-content]");
      const advIconEl = container.querySelector("[data-adv-icon]");
      const dropdowns = [];
      let posters = /* @__PURE__ */ new Map();
      let styles = /* @__PURE__ */ new Map();
      const frameCache = /* @__PURE__ */ new Map();
      let staged = "";
      function showStage(name) {
        if (!stageImgEl || staged === name) {
          return;
        }
        staged = name;
        stopFlip();
        if (stageNameEl) stageNameEl.textContent = name;
        const poster = posters.get(name) ?? "";
        if (poster) {
          stageImgEl.src = poster;
        }
        stageImgEl.hidden = !poster;
        if (hoverTimer !== null) {
          clearTimeout(hoverTimer);
        }
        hoverTimer = setTimeout(() => void playStage(name), HOVER_MS);
      }
      async function playStage(name) {
        if (!stageImgEl || staged !== name) {
          return;
        }
        const poster = posters.get(name) ?? "";
        let frames = frameCache.get(name);
        if (!frames) {
          frames = await framesFor(name);
          frameCache.set(name, frames);
        }
        if (staged !== name || frames.length === 0) {
          return;
        }
        if (!poster) {
          stageImgEl.hidden = false;
        }
        let at2 = 0;
        flipTimer = setInterval(() => {
          if (!stageImgEl.isConnected) {
            stopFlip();
            return;
          }
          at2 = (at2 + 1) % (frames.length + 4);
          stageImgEl.src = at2 < frames.length ? frames[at2] : poster || frames[0];
        }, FRAME_MS);
      }
      function stageSelected() {
        const chosen = templates.find((item) => item.path === config.template);
        if (chosen) {
          showStage(chosen.name);
        }
      }
      function renderGallery() {
        if (!galleryEl) return;
        stopFlip();
        if (templates.length === 0) {
          galleryEl.innerHTML = '<p class="tt-empty">Nenhum modelo nesta pasta. Escolha outra em Ajustes avançados.</p>';
          return;
        }
        galleryEl.innerHTML = templates.map((item, index) => {
          const poster = posters.get(item.name);
          const on = item.path === config.template;
          const style = styles.get(item.name);
          return `<div class="tt-card" ${CONTROL} data-card="${index}" aria-pressed="${on ? "true" : "false"}">` + (poster ? `<img class="tt-thumb" src="${poster}" alt="">` : '<span class="tt-thumb is-empty"></span>') + `<span class="tt-card-text"><span class="tt-name">${escapeHtml(item.name)}</span>` + (style?.fonte ? `<span class="tt-font">${escapeHtml(style.fonte)}</span>` : "") + "</span></div>";
        }).join("");
        stageSelected();
      }
      galleryEl?.addEventListener("mouseover", (event) => {
        const card = event.target?.closest("[data-card]");
        const item = card ? templates[Number(card.dataset.card)] : null;
        if (item) {
          showStage(item.name);
        }
      });
      galleryEl?.addEventListener("mouseleave", () => stageSelected());
      galleryEl?.addEventListener("click", (event) => {
        const card = event.target?.closest("[data-card]");
        if (!card) return;
        const index = Number(card.dataset.card);
        const chosen = templates[index];
        if (!chosen) return;
        config.template = chosen.path;
        persist();
        renderGallery();
        fontPick?.render();
        renderFontHint();
        syncApply();
      });
      const trackPick = trackHost ? mountDropdown(trackHost, {
        options: () => [
          { id: "-1", label: "Automática", meta: "a de cima que estiver livre" },
          ...Array.from({ length: Math.max(trackCount, 1) }, (_, index) => ({
            id: String(index),
            label: `V${index + 1}`,
            meta: index === trackCount - 1 ? "topo" : ""
          }))
        ],
        selected: () => String(config.trackIndex),
        onPick: (id) => {
          config.trackIndex = Number(id);
          persist();
          trackPick?.render();
        }
      }) : null;
      if (trackPick) dropdowns.push(trackPick);
      function templateFont() {
        const chosen = templates.find((item) => item.path === config.template);
        return chosen && styles.get(chosen.name)?.fonte || "";
      }
      function renderFontHint() {
        const model = templateFont();
        if (fontEl) {
          fontEl.placeholder = model ? `${model} (do modelo)` : "a do modelo";
          fontEl.hidden = true;
        }
        if (fieldsNoteEl) {
          const fields = templateFields();
          fieldsNoteEl.hidden = fields < 2;
          fieldsNoteEl.textContent = fields >= 2 ? `Este modelo tem ${fields} campos de texto — uma linha para cada. Linha a menos deixa o campo vazio; linha a mais vai no último.` : "";
        }
      }
      function templateFields() {
        const chosen = templates.find((item) => item.path === config.template);
        return chosen && styles.get(chosen.name)?.campos || 1;
      }
      const fontPick = fontHost ? mountDropdown(fontHost, {
        options: () => [
          { id: "", label: "A do modelo", meta: templateFont() },
          ...fonts.map((name) => ({ id: name, label: name }))
        ],
        selected: () => config.font,
        search: {
          placeholder: "Buscar fonte…",
          useTyped: (typed) => `Usar "${typed}"`
        },
        onPick: (id) => {
          config.font = id;
          if (fontEl) fontEl.value = id;
          persist();
          fontPick?.render();
        }
      }) : null;
      if (fontPick) dropdowns.push(fontPick);
      function closeMenus(target2) {
        for (const dropdown of dropdowns) {
          dropdown.closeUnless(target2);
        }
      }
      const onPointer = (event) => closeMenus(event.target);
      const onKey = (event) => {
        if (event.key === "Escape") closeMenus(null);
      };
      document.addEventListener("click", onPointer, true);
      document.addEventListener("keydown", onKey, true);
      releaseDocument = () => {
        document.removeEventListener("click", onPointer, true);
        document.removeEventListener("keydown", onKey, true);
      };
      context.setApplyLabel("INSERIR");
      context.setApplyEnabled(false);
      context.setResetLabel("LIMPAR");
      context.setResetHandler(null);
      context.setRefreshHandler(() => void readTracks());
      void (async () => {
        config = { ...await settings$1.read() };
        const held = await readDestination("titles", destinationOf(config.library)).catch(
          () => null
        );
        if (held?.path) {
          config.library = held.path;
        }
        if (!config.library) {
          config.library = defaultLibrary();
        }
        if (fontEl) fontEl.value = config.font;
        renderLibrary();
        await Promise.all([loadTemplates(), readTracks(), loadFonts()]);
      })();
      function persist() {
        settings$1.save(config);
      }
      async function loadFonts() {
        fonts = await listFonts();
        fontPick?.render();
        if (fonts.length === 0) {
          try {
            const space = await workspace();
            await write(
              space,
              "fonts-diag.txt",
              `Framelab — fontes · ${(/* @__PURE__ */ new Date()).toISOString()}
${lastFontNote()}
`
            );
            console.warn("[Textos] nenhuma fonte listada:", lastFontNote());
          } catch {
          }
        }
      }
      fontEl?.addEventListener("change", () => {
        config.font = (fontEl.value ?? "").trim();
        persist();
      });
      function renderLibrary() {
        if (libEl) {
          libEl.textContent = config.library || "(nenhuma pasta escolhida)";
          libEl.title = config.library;
        }
      }
      async function loadTemplates() {
        templates = await listTemplates(config.library);
        await afterTemplates();
      }
      async function afterTemplates() {
        if (!templates.some((item) => item.path === config.template)) {
          config.template = templates[0]?.path ?? "";
          persist();
        }
        posters = await postersFor(templates.map((item) => item.name));
        styles = await readTemplateStyles();
        frameCache.clear();
        staged = "";
        renderGallery();
        fontPick?.render();
        renderFontHint();
        syncApply();
        if (templates.length > 0 && posters.size === 0) {
          context.setStatus(
            'Modelos achados, mas sem prévia: rode "Reler pasta" ou gere as miniaturas.',
            "error"
          );
        }
        if (templates.length === 0 && config.library) {
          context.setStatus(
            "Nenhum .mogrt nesta pasta — escolha outra em Ajustes avançados.",
            "error"
          );
        }
      }
      async function readTracks() {
        const ppro = getPremiere();
        if (!ppro) return;
        try {
          const project2 = await ppro.Project.getActiveProject();
          const sequence2 = project2 ? await project2.getActiveSequence() : null;
          trackCount = sequence2 ? await sequence2.getVideoTrackCount() : 0;
        } catch {
          trackCount = 0;
        }
        if (trackCount > 0 && config.trackIndex > trackCount - 1) {
          config.trackIndex = -1;
          persist();
        }
        trackPick?.render();
      }
      function syncApply() {
        const total = pieces().length;
        const batch = nextBatch();
        const pronto = config.modo === "legenda" ? batch.length > 0 : (textEl?.value ?? "").trim().length > 0;
        context.setApplyEnabled(!busy2 && pronto && config.template !== "");
        if (config.modo !== "legenda") {
          context.setApplyLabel("INSERIR");
        } else if (batch.length === 0) {
          context.setApplyLabel("ANIMAR LEGENDAS");
        } else if (total <= MAX_PIECES) {
          context.setApplyLabel(`ANIMAR ${total}`);
        } else {
          context.setApplyLabel(`ANIMAR ${applied + 1}–${applied + batch.length}`);
        }
        if (config.modo === "legenda" && total > 0 && batch.length === 0 && !busy2) {
          context.setStatus(
            `As ${total} legendas de ${srt?.name ?? "o arquivo"} já foram aplicadas. Escolha outro arquivo, ou mude o agrupamento para começar de novo.`,
            "done"
          );
        }
      }
      function renderMode() {
        const legenda = config.modo === "legenda";
        if (textField) textField.hidden = legenda;
        if (srtField) srtField.hidden = !legenda;
        if (srtInfoEl) {
          const total = pieces().length;
          srtInfoEl.textContent = srt ? `${srt.name} · ${srt.cues.length} legendas` + (total !== srt.cues.length ? ` → ${total} peças` : "") + (applied > 0 ? ` · ${applied} aplicadas` : "") : "nenhum arquivo escolhido";
        }
        if (srtWarnEl) {
          const total = pieces().length;
          srtWarnEl.hidden = total <= MAX_PIECES;
          srtWarnEl.textContent = total > MAX_PIECES ? `${total} peças vão em partes de ${MAX_PIECES}: cada legenda é um modelo importado, e de uma vez só o Premiere põe as mídias offline e trava. Aplique, confira, e clique de novo para a parte seguinte.` : "";
        }
        for (const item of Array.from(
          container.querySelectorAll("[data-mode]")
        )) {
          item.setAttribute(
            "aria-pressed",
            item.dataset.mode === config.modo ? "true" : "false"
          );
        }
        syncApply();
      }
      modeSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-mode]");
        if (!item || busy2) return;
        config.modo = item.dataset.mode === "legenda" ? "legenda" : "titulo";
        persist();
        renderMode();
      });
      pickSrtEl?.addEventListener("click", () => void loadSrtFromDisk());
      projectSrtEl?.addEventListener("click", () => void listProjectSrt());
      function acceptSrt(name, text2) {
        const cues = withoutOverlap(cuesFromSrt(text2));
        if (cues.length === 0) {
          context.setStatus(`${name} não tem nenhuma legenda legível.`, "error");
          return;
        }
        srt = { name, cues };
        applied = 0;
        hideSrtList();
        renderMode();
        context.setStatus(`${cues.length} legendas lidas de ${name}.`, "done");
      }
      function nextBatch() {
        return pieces().slice(applied, applied + MAX_PIECES);
      }
      function pieces() {
        if (!srt) {
          return [];
        }
        if (config.group <= 0) {
          return withoutOverlap(srt.cues);
        }
        return wrapCues(withoutOverlap(groupCues(srt.cues, config.group)));
      }
      async function loadSrtFromDisk() {
        if (busy2) return;
        try {
          const source = await pickSrtFile();
          if (source) {
            acceptSrt(source.name, source.text);
          }
        } catch (cause) {
          context.setStatus(`Não deu para abrir o .srt: ${describeError$1(cause)}`, "error");
        }
      }
      function hideSrtList() {
        if (srtListEl) {
          srtListEl.hidden = true;
          srtListEl.innerHTML = "";
        }
      }
      async function listProjectSrt() {
        if (busy2) return;
        busy2 = true;
        if (projectSrtEl) {
          setDisabled(projectSrtEl, true);
          projectSrtEl.textContent = "Procurando…";
        }
        try {
          const found = await findSrtInProject();
          if (found.length === 0) {
            hideSrtList();
            context.setStatus(
              "Nenhum .srt no projeto aberto. Use Importar para trazer do disco.",
              "idle"
            );
            return;
          }
          if (srtListEl) {
            srtListEl.hidden = false;
            srtListEl.innerHTML = '<p class="tr-list-title">No projeto</p>' + found.map(
              (item) => `<div class="tr-list-item" ${CONTROL} data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>`
            ).join("");
          }
          context.setStatus(
            `${found.length} ${found.length === 1 ? "legenda" : "legendas"} no projeto.`,
            "done"
          );
        } catch (cause) {
          context.setStatus(
            `Não deu para procurar no projeto: ${describeError$1(cause)}`,
            "error"
          );
        } finally {
          busy2 = false;
          if (projectSrtEl) {
            setDisabled(projectSrtEl, false);
            projectSrtEl.textContent = "Buscar no projeto";
          }
          syncApply();
        }
      }
      srtListEl?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-path]");
        const path = item?.dataset.path;
        const name = item?.dataset.name ?? "legenda.srt";
        if (!path || busy2) return;
        void (async () => {
          busy2 = true;
          context.setStatus("Lendo a legenda…");
          try {
            acceptSrt(name, await readAnyPath(path));
          } catch (cause) {
            context.setStatus(`Não deu para ler ${name}: ${describeError$1(cause)}`, "error");
          } finally {
            busy2 = false;
            syncApply();
          }
        })();
      });
      textEl?.addEventListener("input", syncApply);
      groupSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-group]");
        if (!item || busy2) return;
        config.group = Number(item.dataset.group);
        applied = 0;
        persist();
        renderSegs();
        renderMode();
      });
      durationSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-duration]");
        if (!item) return;
        config.duration = item.dataset.duration ?? "model";
        persist();
        renderSegs();
      });
      whereSeg?.addEventListener("click", (event) => {
        const item = event.target?.closest("[data-where]");
        if (!item) return;
        config.atPlayhead = item.dataset.where !== "clip";
        persist();
        renderSegs();
      });
      function renderSegs() {
        for (const item of Array.from(
          container.querySelectorAll("[data-duration]")
        )) {
          item.setAttribute(
            "aria-pressed",
            item.dataset.duration === config.duration ? "true" : "false"
          );
        }
        for (const item of Array.from(
          container.querySelectorAll("[data-group]")
        )) {
          item.setAttribute(
            "aria-pressed",
            Number(item.dataset.group) === config.group ? "true" : "false"
          );
        }
        for (const item of Array.from(
          container.querySelectorAll("[data-where]")
        )) {
          const on = item.dataset.where === "clip" !== config.atPlayhead;
          item.setAttribute("aria-pressed", on ? "true" : "false");
        }
      }
      renderSegs();
      renderMode();
      reloadEl?.addEventListener("click", () => {
        if (busy2) return;
        void loadTemplates().then(() => {
          if (templates.length > 0) {
            context.setStatus(
              `${templates.length} ${templates.length === 1 ? "modelo" : "modelos"} na pasta.`,
              "done"
            );
          }
        });
      });
      advToggleEl?.addEventListener("click", () => {
        if (!advContentEl) return;
        const open = advContentEl.hidden;
        advContentEl.hidden = !open;
        if (advIconEl) advIconEl.textContent = open ? "▴" : "▾";
      });
      pickLibEl?.addEventListener("click", () => void pickLibrary());
      async function pickLibrary() {
        try {
          const picked = await pickAndSave("titles");
          if (!picked) return;
          config.library = picked.path;
          persist();
          renderLibrary();
          templates = await listTemplates(config.library);
          if (templates.length === 0) {
            try {
              const opened = await openDestination(picked);
              templates = await templatesFromEntry(opened.folder);
            } catch (cause) {
              console.warn("[Textos] a pasta não abriu pela entry:", cause);
            }
          }
          await afterTemplates();
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          context.setStatus(
            reason === NO_PICKER ? "Este build do Premiere não abre o seletor de pastas." : `Não deu para ler a pasta: ${reason}`,
            "error"
          );
        }
      }
      function showReport(lines) {
        if (!reportEl) return;
        const text2 = lines.join("\n").trim();
        reportEl.hidden = text2.length === 0;
        reportEl.textContent = text2;
      }
      context.setApplyHandler(async () => {
        const text2 = (textEl?.value ?? "").trim();
        const legenda = config.modo === "legenda";
        if (busy2 || !config.template || (legenda ? !srt : !text2)) {
          return;
        }
        if (legenda && srt) {
          const batch = nextBatch();
          const total = pieces().length;
          await runCaptions(srt.name, batch, total);
          return;
        }
        busy2 = true;
        context.setApplyEnabled(false);
        context.setStatus("Inserindo o título…");
        showReport([]);
        try {
          const result = await applyTitle({
            templatePath: config.template,
            text: text2,
            trackIndex: config.trackIndex,
            durationSeconds: secondsFor(config.duration),
            atPlayhead: config.atPlayhead,
            style: { font: config.font }
          });
          console.log("[Textos]", result.report.join("\n"));
          showReport(result.ok ? [] : result.report);
          context.setStatus(result.message, result.ok ? "done" : "error");
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy2 = false;
          syncApply();
        }
      });
      async function runCaptions(name, list, total) {
        busy2 = true;
        cancelled = false;
        context.setApplyEnabled(false);
        context.setStatus(
          total > list.length ? `Animando as legendas ${applied + 1} a ${applied + list.length} de ${total}…` : `Animando ${list.length} legendas de ${name}…`
        );
        context.setResetLabel("CANCELAR");
        context.setResetHandler(() => {
          cancelled = true;
          context.setStatus("Cancelando…");
        });
        showReport([]);
        try {
          const result = await applyCaptions({
            templatePath: config.template,
            cues: list,
            trackIndex: config.trackIndex,
            style: { font: config.font },
            onProgress: (done, total2) => {
              context.setStatus(`Legenda ${done} de ${total2}…`);
            },
            cancelled: () => cancelled
          });
          console.log("[Legendas]", result.report.join("\n"));
          showReport(result.ok ? [] : result.report);
          applied += result.inserted;
          renderMode();
          const faltam = total - applied;
          context.setStatus(
            result.ok && faltam > 0 ? `${result.message} Faltam ${faltam} — confira a timeline e clique de novo.` : result.message,
            result.ok ? "done" : "error"
          );
        } catch (cause) {
          context.setStatus(describeError$1(cause), "error");
        } finally {
          busy2 = false;
          cancelled = false;
          context.setResetLabel("LIMPAR");
          context.setResetHandler(null);
          syncApply();
        }
      }
    },
    unmount() {
      stopFlip();
      releaseDocument?.();
      releaseDocument = null;
      void settings$1.flush();
    }
  };
  function markup$2(config) {
    return `<div class="zones"><div class="zone is-wide"><div class="field"><span class="t-label">O que animar</span><div class="seg" data-mode-seg><div class="seg-item" ${CONTROL} data-mode="titulo">Um título</div><div class="seg-item" ${CONTROL} data-mode="legenda">Legenda (.srt)</div></div></div><div class="field" data-text-field><div class="field-head"><span class="t-label">Texto</span></div><textarea class="tt-text" data-text spellcheck="false" rows="2" placeholder="O texto do título — uma linha por quebra"></textarea><p class="tt-note" data-fields-note hidden></p></div><div class="field" data-srt-field hidden><span class="t-label">Arquivo</span><div class="tr-acts"><div class="tr-btn" ${CONTROL} data-pick-srt>Importar arquivo…</div><div class="tr-btn" ${CONTROL} data-project-srt>Buscar no projeto</div></div><div class="tr-list" data-srt-list hidden></div><p class="dl-dest" data-srt-info>nenhum arquivo escolhido</p><div class="field-head"><span class="t-label" title="Junta legendas vizinhas numa frase só, sem atravessar pausa da fala. Menos peças, menos trabalho para o Premiere.">Agrupar</span></div><div class="seg" data-group-seg>` + GROUPS.map(
      (item) => `<div class="seg-item" ${CONTROL} data-group="${item.seconds}">${escapeHtml(item.label)}</div>`
    ).join("") + `</div><p class="tt-note" data-srt-warn hidden></p></div></div><div class="zone"><div class="field"><div class="field-head"><span class="t-label">Modelo</span><span class="field-action" ${CONTROL} data-reload>Reler pasta</span></div><div class="tt-stage"><img class="tt-stage-img" data-stage-img alt="" hidden><span class="tt-stage-name" data-stage-name></span></div><div class="tt-grid" data-gallery></div><p class="tt-tip">Passe o mouse para ver a animação; clique para escolher.</p></div><div class="field"><span class="t-label" title="As fontes instaladas nesta máquina. Vazio mantém a do modelo.">Fonte</span><div data-font-pick></div><input type="text" class="sil-path tt-font-typed" data-font spellcheck="false" placeholder="a do modelo" hidden></div><div class="field"><span class="t-label">Duração</span><div class="seg" data-duration-seg>` + DURATIONS.map(
      (item) => `<div class="seg-item" ${CONTROL} data-duration="${item.id}">${escapeHtml(item.label)}</div>`
    ).join("") + `</div></div></div><div class="zone"><div class="field"><span class="t-label">Trilha</span><div data-track-pick></div></div><div class="field"><span class="t-label">Onde começa</span><div class="seg" data-where-seg><div class="seg-item" ${CONTROL} data-where="playhead">Na agulha</div><div class="seg-item" ${CONTROL} data-where="clip">No clipe selecionado</div></div></div><pre class="dl-log" data-report hidden></pre></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">Ajustes avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><div class="field-head"><span class="t-label" title="A pasta onde os .mogrt moram. Modelo novo é arquivo novo nela.">Pasta dos modelos</span><span class="field-action" ${CONTROL} data-pick-library>Escolher…</span></div><p class="dl-dest" data-library>${escapeHtml(config.library)}</p></div></div></div></div>`;
  }
  const w = (list) => new RegExp(`\\b(?:${list})\\b`);
  const KINDS = [
    { id: "assinatura", label: "Assinatura Sidy", blurb: "Os seus, escolhidos a dedo", order: 0, words: /$^/ },
    {
      id: "whooshes",
      label: "Whooshes & transições",
      blurb: "Passagens, swishes, slides",
      order: 1,
      words: w("whooshe?s?|wooshe?s?|swooshe?s?|swishe?s?|swipes?|sweeps?|transitions?|transicao|transicoes|pass ?by|passby|fly ?by|flyby|air slicers?|slides?|zips?|breeze|phew|whips?|rush|spin|spins|zoom|slices?|swings?|swoops?|woop")
    },
    {
      id: "impactos",
      label: "Impactos & hits",
      blurb: "Hits, booms, punches",
      order: 2,
      words: w("impacts?|impacto|hits?|booms?|punch(?:es)?|punching|slams?|thuds?|stomps?|bangs?|knocks?|thumps?|smash(?:es)?|glove|stick hit|bag drop|straight hand")
    },
    {
      id: "risers",
      label: "Risers & tensão",
      blurb: "Subidas, suspense, reverses",
      order: 3,
      words: w("risers?|rises?|rising|build ?ups?|buildups?|uplifters?|tension|suspense|swells?|reverses?|reversed|downer")
    },
    {
      id: "cliques",
      label: "Cliques & interface",
      blurb: "Cliques, UI, teclado, bipes",
      order: 4,
      words: w("clicks?|clique|mouse|buttons?|ui|interface|beeps?|bleeps?|blips?|select|notifications?|notify|typing|keyboard|teclado|tecla|type ?writer|typewriter|enter|menu|hover|taps?|ticks?|toggle|switch|messages?|desativar|confirmation")
    },
    {
      id: "pops",
      label: "Pops & bolhas",
      blurb: "Pops, bolhas, puffs",
      order: 5,
      words: w("pops?|pop ?ups?|bubbles?|bolhas?|doinks?|puffs?|plucks?|boops?|bloops?|plops?|winks?")
    },
    {
      id: "glitch",
      label: "Glitch & digital",
      blurb: "Glitch, dados, interferência",
      order: 6,
      words: w("glitch(?:es|s)?|data|datamosh|mosh|circuit ?bend|circuitbend|mangl(?:ed|ing)|stutter|static|interference|interferencia|distort(?:ed|ion)?|digital|vhs|bitcrush(?:ed)?|transmission|signal|error|falha")
    },
    {
      id: "cinematicos",
      label: "Cinemáticos & trailer",
      blurb: "Braams, stingers, drones",
      order: 7,
      words: w("cinematic|cinematics|cinematicos?|cine|trailer|braams?|stingers?|sub ?drops?|bass ?drops?|drops?|drones?|epic|dark|horror|scary|spooky|growl|tense pulses|dramatic|choir")
    },
    {
      id: "camera",
      label: "Câmera & flash",
      blurb: "Obturador, flash, film burn",
      order: 8,
      words: w("cameras?|shutters?|flash(?:es)?|film ?burn|projector|polaroid|photos?|foto|obturador|rec|film")
    },
    {
      id: "brilhos",
      label: "Brilhos & mágica",
      blurb: "Shines, sparkles, sinos",
      order: 9,
      words: w("shines?|shining|shimmer|sparkles?|magic|magica|twinkles?|glitter|chimes?|bells?|dings?|fairy|glow|wand|zing")
    },
    {
      id: "dinheiro",
      label: "Dinheiro & sucesso",
      blurb: "Moedas, caixa, vitória",
      order: 10,
      words: w("cash|coins?|money|dinheiro|register|cha ?ching|ka ?ching|success|win|winner|victory|reward|level ?up|achievement|correct|right|quest")
    },
    {
      id: "cartoon",
      label: "Cartoon & comédia",
      blurb: "Boings, molas, efeitos engraçados",
      order: 11,
      words: w("cartoons?|comedy|funny|boings?|springs?|slide ?whistle|squeaks?|honks?|fails?|wacky|toon|comic|whistles?|emotes?")
    },
    {
      id: "pessoas",
      label: "Pessoas & vozes",
      blurb: "Respiração, risadas, plateia",
      order: 12,
      words: w("human|humans|people|pessoas?|voices?|vocal|breath|breaths|breathing|laughs?|laughing|screams?|crowds?|applause|claps?|clapping|cheers?|kiss|cough|sneeze|gasps?|footsteps?|steps|walk|walking|heart ?beats?|heartbeat|yells?|whispers?|baby|kids?|child|man|woman|female|male|grunt|sigh|eat|eating|drink|drinking|swallow")
    },
    {
      id: "foley",
      label: "Foley & objetos",
      blurb: "Papel, vidro, madeira, quebras",
      order: 13,
      words: w("paper|papel|glass|vidro|creaks?|rustles?|rattles?|clinks?|clangs?|cracks?|cloth|doors?|drawers?|keys|metal|metallic|wood|wooden|plastic|bottles?|cups?|zipper|chairs?|books?|pages?|crash(?:es)?|break|breaks|breaking|shatter|debris|scrape|rub|shake|pencil|drawing|crumble|flip")
    },
    {
      id: "ambientes",
      label: "Ambientes",
      blurb: "Ambiência, cidade, salas",
      order: 14,
      words: w("ambiences?|ambiance|ambient|room ?tone|atmos|atmosphere|city|street|traffic|office|restaurant|cafe|park|mall|market|interior|exterior")
    },
    {
      id: "natureza",
      label: "Natureza & clima",
      blurb: "Chuva, vento, água, trovão",
      order: 15,
      words: w("weather|rain|raining|thunder|storms?|wind|windy|water|agua|ocean|sea|waves?|river|stream|nature|natureza|forest|splash|drip|underwater|lightening|lightning")
    },
    {
      id: "fogo",
      label: "Fogo & explosões",
      blurb: "Fogo, explosões, fogos",
      order: 16,
      words: w("fire|fogo|flames?|burn(?:ing)?|explosions?|explosoes|explosao|blasts?|detonat\\w*|fireworks?|fireballs?|match fire|flare")
    },
    {
      id: "tecnologia",
      label: "Tecnologia & máquinas",
      blurb: "Máquinas, sci-fi, veículos",
      order: 17,
      words: w("technology|tech|machines?|robots?|computer|phone|iphone|telefone|servo|motor|engines?|mechanical|gears?|electric|electricity|power ?ups?|power ?downs?|scanner|holograms?|sci ?fi|scifi|laser|beams?|spaceship|cars?|vehicles?|truck|motorcycle|train|plane|helicopter|radar|clock|ticking")
    },
    {
      id: "animais",
      label: "Animais",
      blurb: "Bichos de todo tipo",
      order: 18,
      words: w("animals?|dogs?|cats?|birds?|horses?|cows?|lions?|pigs?|sheep|chickens?|ducks?|monkeys?|wolf|wolves|bark|barking|meow|chirp|roar|insects?|bees?|frogs?|elephant|goat|rooster")
    },
    {
      id: "esportes",
      label: "Esportes",
      blurb: "Bolas, torcida, jogos",
      order: 19,
      words: w("sports?|balls?|basketball|basket|soccer|football|tennis|golf|baseball|stadium|bowling|boxing|referee|skate|hockey")
    },
    {
      id: "alarmes",
      label: "Alarmes & emergência",
      blurb: "Sirenes, alarmes, alertas",
      order: 20,
      words: w("emergency|sirens?|alarms?|alerts?|police|ambulance|warning|buzzer|censura|bleep censor")
    },
    {
      id: "games",
      label: "Games & armas",
      blurb: "Armas, loot, arcade",
      order: 21,
      words: w("games?|gaming|fortnite|shotguns?|sniper|snipers|guns?|gunshots?|rifles?|pistols?|reload|weapons?|arma|loot|kill|elimination|revive|shield|health|victory royale|fall dmg|8 ?bit|retro|arcade|laser gun|shots?|shoot|shooting|grenades?|launchers?|missiles?|smg|equip|pickup|scope|bolt|knife|sword|stab|ricochet|hitmarker|headshot|ammo|bullets?|shells?|trigger|grappler|batarang|scythe|sycthe|die")
    },
    {
      id: "memes",
      label: "Memes & bordões",
      blurb: "Bordões, virais, MLG",
      order: 23,
      words: w("memes?|mlg|bruh|nope|oof|yeet|wow|spongebob|vine|airhorn|air horn|sad violin|hell no|you suck|emotional damage|surprise|zoidberg|few moments later|not finished|never done|clean af|bizniss|oh no|what|damn")
    },
    {
      id: "musical",
      label: "Percussão & musical",
      blurb: "Bateria, pratos, instrumentos",
      order: 22,
      words: w("drums?|drum hits?|cymbals?|percussion|percs?|snare|toms?|bass|instruments?|piano|guitar|synth|notes?|chords?|orchestra|strings|juno|samples of")
    },
    { id: "diversos", label: "Diversos", blurb: "O que não se encaixou", order: 90, words: /$^/ }
  ];
  const BY_ID = new Map(KINDS.map((k) => [k.id, k]));
  const FOLDER_KINDS = {
    "01 sfx assinatura sidy": "assinatura",
    wooshes: "whooshes",
    whooshes: "whooshes",
    swishes: "whooshes",
    transition: "whooshes",
    "whoosh sfx pack": "whooshes",
    "motion design": "whooshes",
    velocity: "whooshes",
    "hits impacts": "impactos",
    impacts: "impactos",
    "impact sounds": "impactos",
    hit: "impactos",
    "punching percussion": "impactos",
    risers: "risers",
    ui: "cliques",
    computer: "cliques",
    "editing sfx": "cliques",
    bells: "brilhos",
    cameras: "camera",
    cinematics: "cinematicos",
    "cinematic sound effects": "cinematicos",
    drones: "cinematicos",
    "trailer construction lite version": "cinematicos",
    "ambience 1": "ambientes",
    "ambience 2": "ambientes",
    animals: "animais",
    cartoon: "cartoon",
    "emote sfx": "cartoon",
    crashes: "foley",
    "sons abstratos": "foley",
    papel: "foley",
    vidro: "foley",
    "emergency effects": "alarmes",
    "fire and explosions": "fogo",
    explosoes: "fogo",
    sports: "esportes",
    technology: "tecnologia",
    machines: "tecnologia",
    weather: "natureza",
    natureza: "natureza",
    agua: "natureza",
    storm: "natureza",
    "human elements": "pessoas",
    pessoas: "pessoas",
    "glitch volume 01": "glitch",
    "more glitches": "glitch",
    "glitches e interferencia": "glitch",
    "mangling audio": "glitch",
    "data mosh hits": "glitch",
    "data mosh loops": "glitch",
    "experimental glitch hits one shots": "glitch",
    signal: "glitch",
    fortnite: "games",
    elimination: "games",
    kill: "games",
    "fall dmg": "games",
    "pump shotgun sounds": "games",
    "tac shotgun": "games",
    snipers: "games",
    revive: "games",
    shield: "games",
    health: "games",
    "loot sounds": "games",
    "victory royale": "games",
    drums: "musical",
    "instruments multi samples": "musical",
    "beefy field percs one shots": "musical",
    "alpha juno vhs one shots": "musical",
    "sound effects 2": "games",
    explosives: "fogo",
    "assault rifles": "games",
    smg: "games",
    pistols: "games",
    shotguns: "games",
    ricochet: "games",
    pickup: "games",
    ads: "games",
    grappler: "games",
    "more sfx lordsse": "memes",
    "popular sfx lordsse": "memes",
    mlg: "memes",
    "efeitos sonoros vinhetas": "cinematicos"
  };
  const WEAK_FOLDERS = /* @__PURE__ */ new Set(["more sfx lordsse", "popular sfx lordsse", "sound effects 2", "emote sfx"]);
  const normalizeTaxon = (s) => (
    // "CineRiser1" is two words and a take: split the joins before folding case.
    s.replace(/([a-z])([A-Z])/g, "$1 $2").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\(\d+\)/g, " ").replace(/\.[a-z0-9]{2,4}$/, "").replace(/([a-z])(\d)/g, "$1 $2").replace(/[^a-z0-9]+/g, " ").trim()
  );
  const SOURCES = [
    [/adobe audition/, "Adobe Audition"],
    [/mateus ferreira|designer sound fx/, "Mateus Ferreira"],
    [/sfx library collection/, "SFX Library Collection"],
    [/negativist/, "Negativist Audio"],
    [/assinatura/, "Assinatura Sidy"],
    [/outros sfx/, "Outros"]
  ];
  function sourceOf(folders) {
    const joined = folders.map(normalizeTaxon).join(" / ");
    return SOURCES.find(([pattern]) => pattern.test(joined))?.[1] ?? (folders.length ? "Pack SFX" : "Pack");
  }
  function classify(folders, name) {
    const score = /* @__PURE__ */ new Map();
    const add = (id, points) => {
      score.set(id, (score.get(id) ?? 0) + points);
    };
    const file = normalizeTaxon(name);
    const path = folders.map(normalizeTaxon);
    if (path.some((p) => FOLDER_KINDS[p] === "assinatura")) return BY_ID.get("assinatura");
    let named = false;
    for (const kind of KINDS) {
      if (kind.words.test(` ${file} `)) {
        add(kind.id, 5);
        named = true;
      }
      path.forEach((p, i) => {
        if (kind.words.test(` ${p} `)) add(kind.id, i === path.length - 1 ? 2 : 1);
      });
    }
    for (let i = named ? -1 : path.length - 1; i >= 0; i--) {
      const direct = FOLDER_KINDS[path[i]];
      if (direct) {
        add(direct, (WEAK_FOLDERS.has(path[i]) ? 2.5 : 4) + i * 0.01);
        break;
      }
    }
    let best = null, top = 0;
    for (const [id, points] of score) if (points > top || points === top && best && BY_ID.get(id).order < BY_ID.get(best).order) {
      best = id;
      top = points;
    }
    return BY_ID.get(best ?? "diversos");
  }
  const kindById = (id) => BY_ID.get(id);
  const DEFAULT_PACK_ID = "1fuP4p1JRQ9TP64R2U6X4uIrAGf7pzq7N";
  const LEGACY_PACK_ID = "1vvWFLN8ZQV9kZQ1i5heLL8d5fm0gTv6p";
  function parseFolderView(html) {
    const entries = [];
    for (const chunk of html.split('<div class="flip-entry"').slice(1)) {
      const id = /id="entry-([\w-]+)"/.exec(chunk)?.[1];
      const title = /class="flip-entry-title">([^<]*)</.exec(chunk)?.[1];
      if (!id || title === void 0) {
        continue;
      }
      const href = /<a href="([^"]*)"/.exec(chunk)?.[1] ?? "";
      const stamp = /class="flip-entry-last-modified"><div>([^<]*)</.exec(chunk)?.[1] ?? "";
      entries.push({
        id,
        name: decodeEntities(title).trim(),
        folder: href.includes("/folders/"),
        stamp: decodeEntities(stamp).trim()
      });
    }
    return entries;
  }
  function looksLikeFolderView(html) {
    return html.includes("flip-entries");
  }
  function folderIdFrom(input) {
    const text2 = input.trim();
    const match = /\/folders\/([\w-]{10,})/.exec(text2) ?? /[?&]id=([\w-]{10,})/.exec(text2) ?? /^([\w-]{10,})$/.exec(text2);
    return match ? match[1] : null;
  }
  function decodeEntities(text2) {
    return text2.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (all, code) => {
      const lower = code.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos" || lower === "#39") return "'";
      const value = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : all;
    });
  }
  const FORMATS = ["wav", "aif", "aiff", "m4a", "aac", "mp3", "mpeg"];
  function isAudioName(name) {
    if (name.startsWith(".")) {
      return false;
    }
    return FORMATS.includes(extensionOf(name));
  }
  function isJunkFolder(name) {
    return name === "__MACOSX" || name.startsWith(".");
  }
  function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  }
  function stemOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }
  const VENDOR_PREFIX = (
    // "(MISTER HORSE - ESSENTIAL SOUND EFFECTS) CLICK 02": the pack grande prefixa a loja entre parênteses.
    /^(?:ES_|\([^)]*(?:sound|sfx|effects|audio|horse)[^)]*\)\s*|(?:Mountain Audio|Ni Sound|LG[_ ]Sound|Filmmaking Props|VIRAL SFX|GDYN)(?:\s*-\s*|[_\s]+))/i
  );
  const TAIL_NOISE = [
    /\s*-\s*SFX Producer$/i,
    /\s*\((?:wav|mp3|aiff?)\)$/i,
    // Código de catálogo: "SDT012702", "SBA-300055968".
    /[\s_-]+[A-Z]{2,4}-?\d{5,}$/,
    /[\s_-]+sound[\s_-]+effect$/i,
    // "Counter Beeps - Sound (1)": o "Sound" não diz nada.
    /\s*-\s*Sound(?=\s*(?:\(\d+\))?$)/i
  ];
  const SMALL_WORDS = /* @__PURE__ */ new Set([
    "a",
    "o",
    "e",
    "de",
    "da",
    "do",
    "das",
    "dos",
    "na",
    "no",
    "nas",
    "nos",
    "em",
    "com",
    "para",
    "por",
    "of",
    "the",
    "and",
    "in",
    "on",
    "at",
    "to",
    "an",
    "or",
    "for"
  ]);
  function parseSoundName(fileName) {
    let text2 = stemOf(fileName).trim();
    for (let guard = 0; guard < 4; guard += 1) {
      const next = text2.replace(VENDOR_PREFIX, "");
      if (next === text2) break;
      text2 = next;
    }
    for (let guard = 0; guard < 4; guard += 1) {
      const next = TAIL_NOISE.reduce((value, rule) => value.replace(rule, ""), text2).trim();
      if (next === text2) break;
      text2 = next;
    }
    text2 = text2.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").replace(/(\S)-(?=\S)/g, "$1 ").replace(/\s+-\s+/g, " ").replace(/\s+/g, " ").trim();
    let loop = false;
    const withoutLoop = text2.replace(/\s*\bloop\b\s*/i, " ").trim();
    if (withoutLoop !== text2 && withoutLoop.length > 0) {
      loop = true;
      text2 = withoutLoop;
    }
    text2 = text2.replace(/ 0\d(?= \D)/g, "");
    let take = null;
    const numbered = /^(.*?[^\d\s(])[\s(]*(\d{1,3})\)?$/.exec(text2);
    if (numbered && numbered[1].trim().length >= 2) {
      text2 = numbered[1].trim();
      take = Number.parseInt(numbered[2], 10);
    }
    text2 = text2.replace(/\b([Ww])oosh/g, (_all, w2) => `${w2}hoosh`);
    return { base: titleCase(text2), take, loop };
  }
  function titleCase(text2) {
    const letters = text2.replace(/[^\p{L}]/gu, "");
    const shouting = letters.length > 3 && letters === letters.toUpperCase();
    return text2.split(" ").map((word, index) => {
      if (!word) return word;
      if (shouting) {
        if (word.length <= 2) return word;
        word = word.toLowerCase();
      }
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      if (/\p{Lu}/u.test(word.slice(1))) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(" ");
  }
  function normalize(text2) {
    return text2.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  const SYNONYMS = {
    impacto: ["impact", "hit", "boom", "punch"],
    batida: ["hit", "punch", "impact"],
    explosao: ["explosion", "boom", "fireball"],
    clique: ["click", "select"],
    clicar: ["click", "select"],
    teclado: ["keyboard", "teclado"],
    digitar: ["keyboard", "teclado", "typing"],
    foto: ["camera", "shutter", "flash"],
    obturador: ["shutter"],
    dinheiro: ["cash", "coin"],
    grana: ["cash", "coin"],
    moeda: ["coin"],
    moedas: ["coin"],
    bolha: ["bubble"],
    bolhas: ["bubble"],
    piscada: ["wink"],
    piscar: ["wink"],
    papel: ["paper"],
    relogio: ["clock"],
    tensao: ["riser"],
    subida: ["riser"],
    brilho: ["shine", "sparkle", "shining", "magic", "bell"],
    sino: ["bell"],
    transicao: ["whoosh", "swoosh", "transition"],
    vento: ["whoosh", "swoosh"],
    notificacao: ["notification", "message", "pop"],
    celular: ["iphone", "notification"],
    erro: ["glitch", "falha"],
    falha: ["glitch", "falha"],
    tecnologia: ["tech", "digital", "hologram", "data", "sci"],
    dados: ["data"],
    jogo: ["game"],
    rebobinar: ["rebobinar", "rewind"],
    bip: ["beep", "censura"],
    estalo: ["snap", "pop"],
    corte: ["cut", "slice"],
    fogo: ["fire", "flare", "fireball"],
    sucesso: ["success", "right", "confirmation"],
    certo: ["right", "success", "confirmation"],
    engrenagem: ["gears"],
    filme: ["film", "projector", "movie"]
  };
  function queryTerms(query) {
    return normalize(query).split(" ").filter(Boolean).map((word) => [word, ...SYNONYMS[word] ?? []]);
  }
  function soundMatches(sound, terms) {
    if (terms.length === 0) {
      return true;
    }
    const hay = ` ${sound.haystack}`;
    return terms.every((options) => options.some((option) => hay.includes(` ${option}`)));
  }
  function buildCatalog(files) {
    const byCategory = /* @__PURE__ */ new Map();
    for (const file of files) {
      if (!isAudioName(file.name) || file.folders.some(isJunkFolder)) {
        continue;
      }
      const kind = classify(file.folders, file.name);
      const info = { id: kind.id, label: kind.label, order: kind.order };
      let bucket2 = byCategory.get(info.id);
      if (!bucket2) {
        bucket2 = { info, folder: kind.label, groups: /* @__PURE__ */ new Map() };
        byCategory.set(info.id, bucket2);
      }
      const parsed = parseSoundName(file.name);
      const source = sourceOf(file.folders);
      const groupKey = `${normalize(source).replace(/ /g, "-")}|${normalize(parsed.base) || normalize(stemOf(file.name))}`;
      const members = bucket2.groups.get(groupKey) ?? [];
      members.push({ file, parsed });
      bucket2.groups.set(groupKey, members);
    }
    let fileCount = 0;
    const categories2 = [];
    for (const [categoryId, bucket2] of byCategory) {
      const sounds = [];
      for (const [groupKey, members] of bucket2.groups) {
        const variants = pickVariants(members);
        if (variants.length === 0) continue;
        fileCount += variants.length;
        const first = members.find((member) => member.file.id === variants[0].id) ?? members[0];
        const name = first.parsed.base;
        const loop = members.some((member) => member.parsed.loop);
        const haystack = normalize(
          [
            name,
            bucket2.info.label,
            ...new Set(members.flatMap((member) => member.file.folders)),
            ...members.map((member) => stemOf(member.file.name)),
            loop ? "loop" : ""
          ].join(" ")
        );
        sounds.push({
          key: `${categoryId}/${groupKey.replace(/ /g, "-")}`,
          name,
          category: categoryId,
          variants,
          loop,
          haystack,
          source: sourceOf(first.file.folders)
        });
      }
      sounds.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true, sensitivity: "base" }));
      categories2.push({
        id: categoryId,
        label: bucket2.info.label,
        folder: bucket2.folder,
        order: bucket2.info.order,
        sounds
      });
    }
    categories2.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, "pt-BR"));
    return {
      categories: categories2,
      sounds: categories2.reduce((sum2, category) => sum2 + category.sounds.length, 0),
      files: fileCount
    };
  }
  function pickVariants(members) {
    const best = /* @__PURE__ */ new Map();
    for (const member of members) {
      const same = normalize(stemOf(member.file.name)) + "|" + member.file.folders.join("/");
      const held = best.get(same);
      if (!held || formatRank(member.file.name) < formatRank(held.file.name)) {
        best.set(same, member);
      }
    }
    return [...best.values()].sort((a, b) => {
      const ta = a.parsed.take ?? -1;
      const tb = b.parsed.take ?? -1;
      return ta - tb || a.file.name.localeCompare(b.file.name, "pt-BR", { numeric: true });
    }).map((member) => ({
      id: member.file.id,
      file: member.file.name,
      folders: member.file.folders,
      stamp: member.file.stamp,
      ext: extensionOf(member.file.name)
    }));
  }
  function formatRank(name) {
    const rank = FORMATS.indexOf(extensionOf(name));
    return rank < 0 ? FORMATS.length : rank;
  }
  function safeName(text2) {
    return text2.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "Som";
  }
  function fileNameFor(category, sound, index) {
    const variant = sound.variants[index];
    const take = sound.variants.length > 1 ? ` ${index + 1}` : "";
    return `${safeName(category.label)}/${safeName(sound.name)}${take}.${variant?.ext || "wav"}`;
  }
  const SFX_DEFAULTS = {
    pack: DEFAULT_PACK_ID,
    view: "inicio",
    favorites: [],
    folder: "",
    folderToken: ""
  };
  const sfxSettings = createToolSettings("sfx-config.json", SFX_DEFAULTS, (raw) => ({
    // O pack antigo (221 sons) está dentro do grande: quem o tinha salvo passa para o grande.
    pack: /* @__PURE__ */ ((id) => id === LEGACY_PACK_ID ? DEFAULT_PACK_ID : id)(folderIdFrom(pickString(raw.pack, DEFAULT_PACK_ID)) ?? DEFAULT_PACK_ID),
    view: pickString(raw.view, "inicio"),
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((item) => typeof item === "string").slice(0, 500) : [],
    folder: typeof raw.folder === "string" ? raw.folder : "",
    folderToken: typeof raw.folderToken === "string" ? raw.folderToken : ""
  }));
  warmToolSettings(sfxSettings);
  const FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id=";
  const DOWNLOAD = "https://drive.usercontent.google.com/download?export=download&confirm=t&id=";
  const PARALLEL = 10;
  const MAX_FOLDERS = 3e3;
  const MAX_DEPTH = 16;
  async function crawlPack(rootId, progress = () => {
  }) {
    const files = [];
    const seen = /* @__PURE__ */ new Set([rootId]);
    let level = [{ id: rootId, folders: [] }];
    let visited = 0;
    for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH; depth += 1) {
      const next = [];
      for (let start = 0; start < level.length; start += PARALLEL) {
        const batch = level.slice(start, start + PARALLEL);
        const pages = await Promise.all(batch.map((item) => readFolder(item.id)));
        batch.forEach((item, index) => {
          for (const entry of pages[index]) {
            if (entry.folder) {
              if (!isJunkFolder(entry.name) && !seen.has(entry.id)) {
                seen.add(entry.id);
                next.push({ id: entry.id, folders: [...item.folders, entry.name] });
              }
            } else if (isAudioName(entry.name)) {
              files.push({ id: entry.id, name: entry.name, folders: item.folders, stamp: entry.stamp });
            }
          }
        });
        visited += batch.length;
        progress(visited, files.length);
        if (visited > MAX_FOLDERS) {
          throw new Error(`o pack passou de ${MAX_FOLDERS} pastas`);
        }
      }
      level = next;
    }
    return files;
  }
  async function readFolder(id) {
    try {
      return await readFolderOnce(id);
    } catch (first) {
      await new Promise((resolve2) => setTimeout(resolve2, 600));
      try {
        return await readFolderOnce(id);
      } catch {
        throw first;
      }
    }
  }
  async function readFolderOnce(id) {
    let response;
    try {
      response = await fetchWithTimeout(
        FOLDER_VIEW + encodeURIComponent(id),
        void 0,
        NET_DEADLINE.listing
      );
    } catch (cause) {
      throw new Error(`sem conexão com o Drive (${describe$2(cause)})`);
    }
    if (!response.ok) {
      throw new Error(
        response.status === 404 ? "a pasta do pack não existe mais nesse link" : `o Drive respondeu ${response.status}`
      );
    }
    const html = await response.text();
    if (!looksLikeFolderView(html)) {
      throw new Error("a pasta do pack não está pública — o Drive pediu login");
    }
    return parseFolderView(html);
  }
  async function downloadSound(id, signal) {
    let response;
    try {
      response = await fetchWithTimeout(
        DOWNLOAD + encodeURIComponent(id),
        void 0,
        NET_DEADLINE.media,
        signal
      );
    } catch (cause) {
      if (isNetCancelled(cause)) {
        throw cause;
      }
      throw new Error(`sem conexão com o Drive (${describe$2(cause)})`);
    }
    if (!response.ok) {
      throw new Error(`o Drive respondeu ${response.status}`);
    }
    if (response.headers.get("content-length") === "0") {
      return new ArrayBuffer(0);
    }
    if (/text\/html/i.test(response.headers.get("content-type") ?? "")) {
      throw new Error("o Drive devolveu uma página em vez do áudio (limite de downloads?)");
    }
    return response.arrayBuffer();
  }
  function describe$2(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const BIN_NAME = "SFX";
  const FALLBACK_SECONDS = 2;
  function commit(project2, label, build) {
    let committed = false;
    let error = null;
    try {
      project2.lockedAccess(() => {
        try {
          committed = project2.executeTransaction(build, label);
        } catch (cause) {
          error = cause;
        }
      });
    } catch (cause) {
      error = error ?? cause;
    }
    if (error) {
      console.error(`[Efeitos] transação "${label}" falhou:`, error);
    }
    return committed;
  }
  function samePath(a, b) {
    const clean = (path) => path.replace(/\\/g, "/").normalize("NFC");
    return clean(a) === clean(b);
  }
  async function sfxBin(ppro, project2) {
    const find = async () => {
      const root22 = await project2.getRootItem();
      for (const child of await root22.getItems()) {
        if (child.type === ppro.ProjectItem.TYPE_BIN && child.name === BIN_NAME) {
          return ppro.FolderItem.cast(child);
        }
      }
      return null;
    };
    const held = await find();
    if (held) return held;
    const root2 = await project2.getRootItem();
    commit(project2, "Efeitos Sonoros — criar a bin SFX", (tx) => {
      tx.addAction(root2.createBinAction(BIN_NAME, false));
    });
    return find();
  }
  async function itemFor(ppro, bin, path) {
    for (const child of await bin.getItems()) {
      if (child.type === ppro.ProjectItem.TYPE_BIN) continue;
      let clip = null;
      try {
        clip = ppro.ClipProjectItem.cast(child);
      } catch {
        clip = null;
      }
      const media = clip ? await clip.getMediaFilePath().catch(() => "") : "";
      if (media && samePath(media, path)) return child;
    }
    return null;
  }
  async function projectItemFor(ppro, project2, path) {
    const bin = await sfxBin(ppro, project2);
    if (bin) {
      const held = await itemFor(ppro, bin, path);
      if (held) return held;
    }
    const target2 = bin ? ppro.ProjectItem.cast(bin) : void 0;
    const imported = await project2.importFiles([path], true, target2, false);
    if (!imported) {
      throw new Error("o Premiere recusou importar o arquivo");
    }
    if (bin) {
      const found = await itemFor(ppro, bin, path);
      if (found) return found;
    }
    const root2 = await project2.getRootItem();
    const loose = await itemFor(ppro, root2, path);
    if (loose) return loose;
    throw new Error("o arquivo foi importado mas não apareceu no projeto");
  }
  async function childBin(ppro, project2, parent, name) {
    const find = async () => {
      for (const child of await parent.getItems()) {
        if (child.type === ppro.ProjectItem.TYPE_BIN && child.name === name) return ppro.FolderItem.cast(child);
      }
      return null;
    };
    const held = await find();
    if (held) return held;
    commit(project2, `Efeitos Sonoros — criar a bin ${name}`, (tx) => {
      tx.addAction(parent.createBinAction(name, false));
    });
    return find();
  }
  async function projectItemsFor(ppro, project2, paths, sub) {
    const clean = (path) => path.replace(/\\/g, "/").normalize("NFC");
    const wanted = new Set(paths.map(clean));
    const found = /* @__PURE__ */ new Map();
    const index = async (folder) => {
      for (const child of await folder.getItems()) {
        if (child.type === ppro.ProjectItem.TYPE_BIN) continue;
        let media = "";
        try {
          media = await ppro.ClipProjectItem.cast(child).getMediaFilePath();
        } catch {
          continue;
        }
        if (media && wanted.has(clean(media)) && !found.has(clean(media))) found.set(clean(media), child);
      }
    };
    const parent = await sfxBin(ppro, project2);
    const bin = parent ? await childBin(ppro, project2, parent, sub) : null;
    if (bin) await index(bin);
    const missing = paths.filter((path) => !found.has(clean(path)));
    if (missing.length) {
      const target2 = bin ? ppro.ProjectItem.cast(bin) : void 0;
      for (let at2 = 0; at2 < missing.length; at2 += 100) {
        if (!await project2.importFiles(missing.slice(at2, at2 + 100), true, target2, false)) {
          throw new Error("o Premiere recusou importar os arquivos");
        }
      }
      if (bin) await index(bin);
      if (paths.some((path) => !found.has(clean(path)))) await index(await project2.getRootItem());
    }
    const absent = paths.filter((path) => !found.has(clean(path)));
    if (absent.length) {
      throw new Error(`${absent.length} arquivo(s) foram importados mas não apareceram no projeto`);
    }
    return new Map(paths.map((path) => [path, found.get(clean(path))]));
  }
  async function freeAudioTrack(ppro, sequence2, from, to) {
    const count = await sequence2.getAudioTrackCount();
    const order = [
      ...Array.from({ length: Math.max(0, count - 2) }, (_, index) => index + 2),
      ...[1, 0].filter((index) => index < count)
    ];
    for (const index of order) {
      const track = await sequence2.getAudioTrack(index).catch(() => null);
      if (!track) continue;
      const locked = track.isLocked;
      if (typeof locked === "function" && await locked.call(track).catch(() => false)) continue;
      let items = [];
      try {
        items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      } catch {
        continue;
      }
      const spans = await Promise.all(
        items.map(async (item) => {
          const start = await item.getStartTime().catch(() => null);
          const end = await item.getEndTime().catch(() => null);
          return start && end ? { start: start.seconds, end: end.seconds } : null;
        })
      );
      if (!spans.some((span) => span && span.start < to && span.end > from)) {
        return { index, count };
      }
    }
    return { index: null, count };
  }
  function timecode(seconds2) {
    const whole = Math.max(0, seconds2);
    const minutes = Math.floor(whole / 60);
    const rest = whole - minutes * 60;
    return `${minutes}:${rest.toFixed(1).padStart(4, "0").replace(".", ",")}`;
  }
  async function insertAtPlayhead(path, seconds2) {
    const ppro = getPremiere();
    if (!ppro) return { ok: false, message: "o Premiere não respondeu ao painel" };
    try {
      const project2 = await ppro.Project.getActiveProject();
      if (!project2) return { ok: false, message: "nenhum projeto aberto" };
      const sequence2 = await project2.getActiveSequence();
      if (!sequence2) return { ok: false, message: "abra uma sequência na timeline" };
      const editor = resolveEditor(ppro, sequence2);
      if (!editor) return { ok: false, message: "esta versão do Premiere não deixa o painel editar a timeline" };
      const at2 = (await sequence2.getPlayerPosition().catch(() => null))?.seconds ?? 0;
      const span = seconds2 ?? FALLBACK_SECONDS;
      const { index, count } = await freeAudioTrack(ppro, sequence2, at2, at2 + span);
      if (count === 0) return { ok: false, message: "a sequência não tem trilha de áudio" };
      if (index === null) {
        return {
          ok: false,
          message: `todas as trilhas de áudio têm algo aos ${timecode(at2)} — adicione uma trilha (botão direito no cabeçalho das trilhas) e tente de novo`
        };
      }
      const item = await projectItemFor(ppro, project2, path);
      const time = ppro.TickTime.createWithSeconds(at2);
      const placed2 = commit(project2, "Inserir efeito sonoro", (tx) => {
        tx.addAction(editor.createOverwriteItemAction(item, time, 0, index));
      });
      if (!placed2) {
        return { ok: false, message: `o Premiere recusou pôr o som na A${index + 1} (a trilha está travada?)` };
      }
      return { ok: true, message: `A${index + 1}, aos ${timecode(at2)}` };
    } catch (cause) {
      return { ok: false, message: describeError$1(cause) };
    }
  }
  const STOP_SCRIPT = "sfx-stop.command";
  const PID_FILE = "sfx-afplay.pid";
  let sequence = 0;
  function previewRun() {
    const tag = `p${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;
    return {
      tag,
      script: `sfx-play-${tag}.command`,
      started: `sfx-play-${tag}-started.txt`,
      errors: `sfx-play-${tag}-error.txt`
    };
  }
  function runFiles(run2) {
    return [run2.script, run2.started, run2.errors];
  }
  function nativeFileOf(url) {
    if (!url.startsWith("file://")) return null;
    try {
      return decodeURIComponent(url.slice("file://".length));
    } catch {
      return null;
    }
  }
  function nativeAvailable() {
    return !isWindows();
  }
  function previewScript(run2, file, space) {
    const q2 = shellQuote;
    const pid = nativePath(space, PID_FILE);
    const started = nativePath(space, run2.started);
    const errors = nativePath(space, run2.errors);
    return [
      "#!/bin/bash",
      "# Gerado pelo Framelab — prévia de efeito sonoro. Pode apagar.",
      `if [ -f ${q2(pid)} ]; then kill "$(cat ${q2(pid)})" 2>/dev/null; fi`,
      `nohup /usr/bin/afplay ${q2(file)} >/dev/null 2>${q2(errors)} &`,
      "P=$!",
      `echo $P > ${q2(pid)}`,
      // Um instante para o afplay abrir o arquivo e a saída de áudio.
      "sleep 0.2",
      "if kill -0 $P 2>/dev/null; then",
      `  echo "${run2.tag} ok" > ${q2(started)}`,
      "else",
      "  wait $P; CODE=$?",
      '  if [ "$CODE" -eq 0 ]; then',
      `    echo "${run2.tag} ok" > ${q2(started)}`,
      "  else",
      `    echo "${run2.tag} falhou $(tr '\\n' ' ' < ${q2(errors)} | head -c 200)" > ${q2(started)}`,
      "  fi",
      "fi",
      ""
    ].join("\n");
  }
  async function playNative(file) {
    if (isWindows()) return { ok: false, detail: "afplay só existe no macOS" };
    const space = await workspace();
    const run2 = previewRun();
    await write(space, run2.script, previewScript(run2, file, space), true);
    const sent = await dispatch(run2.script);
    if (sent.mode === "denied") {
      await forget(space, run2);
      return { ok: false, detail: `assistente recusado (${sent.error ?? "sem motivo"})` };
    }
    const limit = sent.mode === "launched" ? 2e4 : 2500;
    for (let waited = 0; waited < limit; waited += 100) {
      const answer = readText$1(space, run2.started) ?? "";
      if (answer === `${run2.tag} ok`) {
        await forget(space, run2);
        return { ok: true, detail: sent.mode };
      }
      if (answer.startsWith(`${run2.tag} falhou`)) {
        const why = answer.slice(run2.tag.length + 8).trim();
        await forget(space, run2);
        return { ok: false, detail: `o afplay não tocou: ${why || "sem mensagem"}` };
      }
      await wait$1(100);
    }
    await withdraw(sent.ticket);
    await forget(space, run2);
    return { ok: false, detail: `o assistente não respondeu em ${limit / 1e3}s (${sent.mode})` };
  }
  async function forget(space, run2) {
    for (const name of runFiles(run2)) {
      await remove(space, name);
    }
  }
  async function stopNative() {
    if (isWindows()) return;
    try {
      if (!(await agentStatus()).up) return;
      const space = await workspace();
      const q2 = shellQuote;
      const pid = nativePath(space, PID_FILE);
      await write(
        space,
        STOP_SCRIPT,
        [
          "#!/bin/bash",
          "# Gerado pelo Framelab — para a prévia de efeito sonoro. Pode apagar.",
          `if [ -f ${q2(pid)} ]; then kill "$(cat ${q2(pid)})" 2>/dev/null; rm -f ${q2(pid)}; fi`,
          ""
        ].join("\n"),
        true
      );
      await dispatch(STOP_SCRIPT);
    } catch {
    }
  }
  function createSyncJob(total) {
    return {
      total,
      done: 0,
      failed: 0,
      empty: 0,
      bytes: 0,
      lastError: null,
      running: true,
      cancelled: false,
      control: makeController()
    };
  }
  function makeController() {
    try {
      return typeof AbortController === "function" ? new AbortController() : null;
    } catch {
      return null;
    }
  }
  function claimSync(current2, hold) {
    if (current2?.running) {
      return null;
    }
    const job = createSyncJob(0);
    hold(job);
    return job;
  }
  function stopSyncJob(job) {
    if (!job || !job.running) {
      return false;
    }
    job.cancelled = true;
    job.running = false;
    try {
      job.control?.abort();
    } catch (cause) {
      console.warn("[Efeitos] o aborto do download não foi aceito:", cause);
    }
    return true;
  }
  async function drainSync(job, options) {
    const worker = async () => {
      for (; ; ) {
        if (job.cancelled || !options.current()) {
          return;
        }
        const item = options.next();
        if (item === void 0) {
          return;
        }
        try {
          await options.run(item, job.control?.signal);
        } catch (cause) {
          if (isNetCancelled(cause) || job.cancelled) {
            return;
          }
          job.failed += 1;
          job.lastError = describe$1(cause);
        }
        job.done += 1;
        if (options.current()) {
          options.tick();
        }
      }
    };
    await Promise.all(Array.from({ length: options.workers }, () => worker()));
    if (options.current()) {
      job.running = false;
      options.tick();
    }
  }
  function describe$1(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const TRY_MS = 1500;
  const NATIVE = "afplay pelo assistente";
  const REPORT_FILE = "sfx-preview-report.txt";
  const WINNER_FILE = "sfx-player.txt";
  const REPORT_LIMIT = 24e3;
  let nativeActive = false;
  let lastSeconds = null;
  let current = null;
  let timers = [];
  let generation = 0;
  let primed = null;
  let host = null;
  let winner = null;
  async function warmPlayer() {
    if (winner) return;
    try {
      const saved = readText$1(await workspace(), WINNER_FILE);
      if (saved && (saved === NATIVE || STRATEGIES.some((item) => item.name === saved))) {
        winner = saved;
      }
    } catch {
    }
  }
  function crown(name) {
    if (winner === name) return;
    winner = name;
    void (async () => {
      try {
        await write(await workspace(), WINNER_FILE, name);
      } catch {
      }
    })();
  }
  function baseElement() {
    const element = document.createElement("video");
    element.setAttribute("aria-hidden", "true");
    element.style.position = "absolute";
    element.style.width = "1px";
    element.style.height = "1px";
    element.style.pointerEvents = "none";
    return element;
  }
  function finiteSeconds(value) {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  function safePlay(element, log, tag) {
    try {
      const pending = element.play();
      if (pending && typeof pending.then === "function") {
        pending.then(
          () => log(`${tag}: play() resolveu`),
          (cause) => log(`${tag}: play() recusou (${String(cause)})`)
        );
      } else {
        log(`${tag}: play() voltou ${typeof pending}`);
      }
    } catch (cause) {
      log(`${tag}: play() lançou (${String(cause)})`);
    }
  }
  function prime(silence2) {
    dropPrimed();
    const element = baseElement();
    element.autoplay = true;
    document.body.appendChild(element);
    primed = element;
    if (silence2) element.src = silence2;
    try {
      const pending = element.play();
      pending?.catch?.(() => void 0);
    } catch {
    }
  }
  function dropPrimed() {
    if (!primed) return;
    try {
      primed.pause();
    } catch {
    }
    primed.remove();
    primed = null;
  }
  function setHost(element) {
    host = element;
  }
  const STRATEGIES = [
    {
      // O elemento destravado no clique recebe o som de verdade.
      name: "destravado no clique",
      run(url, log) {
        const element = primed ?? baseElement();
        if (!primed) log("sem elemento destravado — elemento novo");
        primed = null;
        if (!element.isConnected) document.body.appendChild(element);
        element.autoplay = true;
        element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
        element.src = url;
        safePlay(element, log, "logo após src");
        return element;
      }
    },
    {
      // A receita da sonda que tocou uma vez.
      name: "autoplay + play() no loadedmetadata",
      run(url, log) {
        const element = baseElement();
        element.autoplay = true;
        element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
        document.body.appendChild(element);
        element.src = url;
        return element;
      }
    },
    {
      // Como a Adobe faz nos painéis dela: um <video> de verdade, visível,
      // dentro da interface, com carregamento completo antes do play().
      name: "visível na linha, load() + play() no canplay",
      run(url, log) {
        const element = document.createElement("video");
        element.setAttribute("aria-hidden", "true");
        element.className = "sfx-player-visible";
        element.preload = "auto";
        element.addEventListener("canplay", () => safePlay(element, log, "canplay"));
        element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
        (host?.isConnected ? host : document.body).appendChild(element);
        element.src = url;
        try {
          element.load();
        } catch (cause) {
          log(`load() lançou (${String(cause)})`);
        }
        return element;
      }
    },
    {
      // Autoplay mudo costuma passar onde o com som é barrado; o som
      // liga assim que o tempo anda.
      name: "mudo, liga o som ao andar",
      run(url, log) {
        const element = baseElement();
        element.muted = true;
        element.autoplay = true;
        let unmuted = false;
        element.addEventListener("timeupdate", () => {
          if (!unmuted && element.currentTime > 0) {
            unmuted = true;
            element.muted = false;
            element.volume = 1;
            log("som ligado");
          }
        });
        element.addEventListener("loadedmetadata", () => safePlay(element, log, "loadedmetadata"));
        document.body.appendChild(element);
        element.src = url;
        return element;
      }
    }
  ];
  function ordered() {
    const names = STRATEGIES.map((item) => item.name);
    names.splice(1, 0, NATIVE);
    if (!winner || !names.includes(winner)) return names;
    return [winner, ...names.filter((name) => name !== winner)];
  }
  let report$1 = [];
  function clock$2() {
    const now = /* @__PURE__ */ new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  async function flushReport() {
    if (report$1.length === 0) return;
    const block = report$1.join("\n");
    report$1 = [];
    try {
      const space = await workspace();
      const before = readText$1(space, REPORT_FILE) ?? "";
      const text2 = `${before}
${block}
`;
      await write(space, REPORT_FILE, text2.length > REPORT_LIMIT ? text2.slice(-REPORT_LIMIT) : text2);
    } catch {
    }
  }
  function describeState(element) {
    const error = element.error ? ` erro=${element.error.code} ${element.error.message}` : "";
    return `t=${(element.currentTime || 0).toFixed(2)} dur=${String(finiteSeconds(element.duration) ?? "?")} paused=${String(element.paused)} muted=${String(element.muted)} vol=${String(element.volume)}${error}`;
  }
  function playUrl(url, handlers, label = "") {
    stopPlayback(false);
    const token = generation;
    const started = Date.now();
    report$1.push(`── ${clock$2()} · ${label} · ${url.slice(0, 160)}`);
    const queue = ordered();
    let attempt2 = 0;
    const next = () => {
      if (token !== generation) return;
      const name = queue[attempt2];
      attempt2 += 1;
      if (name === NATIVE) {
        tryNative();
        return;
      }
      const strategy = STRATEGIES.find((item) => item.name === name);
      if (!strategy) {
        report$1.push("   resultado: nenhuma maneira tocou");
        void flushReport();
        stopPlayback(false);
        handlers.onError("o player abriu o arquivo mas não tocou (detalhes em sfx-preview-report.txt)");
        return;
      }
      const t0 = Date.now();
      const log = (line) => {
        report$1.push(`   [${strategy.name}] +${Date.now() - t0}ms ${line}`);
      };
      let playing = false;
      let element;
      try {
        element = strategy.run(url, log);
      } catch (cause) {
        log(`falhou ao montar (${String(cause)})`);
        next();
        return;
      }
      current = element;
      for (const name2 of ["loadedmetadata", "canplay", "play", "playing", "pause", "stalled", "waiting"]) {
        element.addEventListener(name2, () => {
          if (token === generation && current === element) log(`${name2} · ${describeState(element)}`);
        });
      }
      const succeed = () => {
        if (playing || token !== generation || current !== element) return;
        playing = true;
        crown(strategy.name);
        log(`TOCOU · ${describeState(element)} · ${Date.now() - started}ms desde o pedido`);
        void flushReport();
        const seconds2 = finiteSeconds(element.duration);
        handlers.onStart(seconds2);
        if (seconds2 !== null) {
          timers.push(
            setTimeout(() => {
              if (token !== generation) return;
              stopPlayback(false);
              handlers.onEnd();
            }, seconds2 * 1e3 + 1500)
          );
        }
      };
      element.addEventListener("loadedmetadata", () => {
        lastSeconds = finiteSeconds(element.duration) ?? lastSeconds;
      });
      element.addEventListener("timeupdate", () => {
        if (element.currentTime > 0) succeed();
      });
      element.addEventListener("ended", () => {
        if (token !== generation || current !== element) return;
        log(`ended · ${describeState(element)}`);
        if (!playing) succeed();
        void flushReport();
        stopPlayback(false);
        handlers.onEnd();
      });
      element.addEventListener("error", () => {
        if (token !== generation || current !== element) return;
        log(`error · ${describeState(element)}`);
        if (!playing) {
          discard$1(element);
          next();
        }
      });
      timers.push(
        setTimeout(() => {
          if (playing || token !== generation || current !== element) return;
          log(`não andou em ${TRY_MS}ms · ${describeState(element)}`);
          discard$1(element);
          next();
        }, TRY_MS)
      );
    };
    const tryNative = () => {
      const t0 = Date.now();
      const log = (line) => {
        report$1.push(`   [${NATIVE}] +${Date.now() - t0}ms ${line}`);
      };
      const file = nativeFileOf(url);
      if (!file || !nativeAvailable()) {
        log(file ? "só existe no macOS — pulado" : "não é arquivo local — pulado");
        next();
        return;
      }
      void (async () => {
        const seconds2 = lastSeconds ?? await probeDuration(url);
        if (token !== generation) return;
        log("pedindo ao assistente…");
        const result = await playNative(file);
        if (token !== generation) {
          if (result.ok) void stopNative();
          return;
        }
        if (!result.ok) {
          log(`falhou · ${result.detail}`);
          next();
          return;
        }
        nativeActive = true;
        crown(NATIVE);
        dropPrimed();
        log(`TOCOU (${result.detail}) · ${Date.now() - started}ms desde o pedido`);
        void flushReport();
        handlers.onStart(seconds2);
        timers.push(
          setTimeout(() => {
            if (token !== generation) return;
            nativeActive = false;
            stopPlayback(false);
            handlers.onEnd();
          }, (seconds2 ?? 3) * 1e3 + 300)
        );
      })();
    };
    next();
  }
  function discard$1(element) {
    try {
      element.pause();
    } catch {
    }
    element.remove();
    if (current === element) current = null;
  }
  function stopPlayback(dropPrime = true) {
    generation += 1;
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    if (nativeActive) {
      nativeActive = false;
      void stopNative();
    }
    if (dropPrime) dropPrimed();
    const element = current;
    current = null;
    if (element) discard$1(element);
  }
  function probeDuration(url) {
    return new Promise((resolve2) => {
      const element = baseElement();
      element.preload = "metadata";
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        element.remove();
        resolve2(value);
      };
      const timer = setTimeout(() => finish(null), 4e3);
      element.addEventListener("loadedmetadata", () => finish(finiteSeconds(element.duration)));
      element.addEventListener("error", () => finish(null));
      document.body.appendChild(element);
      element.src = url;
    });
  }
  let rootKey = "";
  let root = null;
  const subfolders = /* @__PURE__ */ new Map();
  async function openRoot(target2) {
    const key = `${target2.path}|${target2.token}`;
    if (root && rootKey === key) return root;
    const opened = await openDestination(target2);
    root = { folder: opened.folder, binary: opened.binary };
    rootKey = key;
    subfolders.clear();
    return root;
  }
  async function openSubfolder(target2, name) {
    const held = subfolders.get(name);
    if (held) return held;
    const { folder } = await openRoot(target2);
    const sub = await subfolder(folder, name);
    subfolders.set(name, sub);
    return sub;
  }
  function split(relative) {
    const cut = relative.lastIndexOf("/");
    return cut > 0 ? { dir: relative.slice(0, cut), name: relative.slice(cut + 1) } : { dir: "", name: relative };
  }
  async function writeInto(target2, relative, data) {
    const { binary } = await openRoot(target2);
    const { dir, name } = split(safeRelative(relative, "som"));
    const folder = dir ? await openSubfolder(target2, dir) : (await openRoot(target2)).folder;
    const file = await folder.createFile(name, { overwrite: true });
    try {
      await file.write(data, binary !== void 0 ? { format: binary } : void 0);
    } catch {
      await file.write(data, { format: "binary" });
    }
    return file.nativePath ?? nativeIn(target2, relative);
  }
  async function readFrom(target2, relative) {
    const { binary } = await openRoot(target2);
    const { dir, name } = split(relative);
    const folder = dir ? await openSubfolder(target2, dir) : (await openRoot(target2)).folder;
    const file = await folder.getEntry(name);
    let data;
    try {
      data = await file.read(binary !== void 0 ? { format: binary } : void 0);
    } catch {
      data = await file.read({ format: "binary" });
    }
    if (typeof data === "string") {
      throw new Error("a leitura voltou como texto");
    }
    return data;
  }
  async function removeFrom(target2, relative) {
    const { dir, name } = split(relative);
    try {
      const folder = dir ? await openSubfolder(target2, dir) : (await openRoot(target2)).folder;
      const entry = await folder.getEntry(name);
      await entry.delete?.();
    } catch {
    }
  }
  function forgetOpenFolders() {
    root = null;
    rootKey = "";
    subfolders.clear();
  }
  function nativeIn(target2, relative) {
    return joinNative(target2.path, relative);
  }
  function folderLabel(path) {
    const clean = path.replace(/[\\/]+$/, "");
    return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
  }
  const PACK_FILE = "sfx/pack.json";
  const MANIFEST_FILE = "sfx/cache.json";
  let manifest = { sounds: {}, empty: {}, seconds: {} };
  let target = null;
  let manifestRead = false;
  let saving = Promise.resolve();
  const inflight = /* @__PURE__ */ new Map();
  async function readSnapshot(rootId) {
    try {
      const raw = readText$1(await workspace(), PACK_FILE);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.rootId !== rootId || !Array.isArray(parsed.files)) {
        return null;
      }
      return {
        rootId,
        fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
        files: parsed.files.filter(isPackFile)
      };
    } catch {
      return null;
    }
  }
  async function writeSnapshot(snapshot2) {
    try {
      const space = await workspace();
      await ensureDir(space, "sfx");
      await write(space, PACK_FILE, JSON.stringify(snapshot2));
    } catch (cause) {
      console.warn("[Efeitos] não consegui guardar a listagem:", cause);
    }
  }
  function isPackFile(value) {
    const item = value;
    return !!item && typeof item.id === "string" && typeof item.name === "string" && typeof item.stamp === "string" && Array.isArray(item.folders);
  }
  function asRecord(value) {
    return value && typeof value === "object" ? value : {};
  }
  async function loadManifest() {
    if (manifestRead) return;
    manifestRead = true;
    try {
      const raw = readText$1(await workspace(), MANIFEST_FILE);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      manifest = {
        sounds: asRecord(parsed.sounds),
        empty: asRecord(parsed.empty),
        seconds: asRecord(parsed.seconds)
      };
    } catch {
    }
  }
  function saveManifest() {
    saving = saving.then(async () => {
      try {
        const space = await workspace();
        await ensureDir(space, "sfx");
        await write(space, MANIFEST_FILE, JSON.stringify(manifest));
      } catch (cause) {
        console.warn("[Efeitos] não consegui gravar o manifesto:", cause);
      }
    });
    return saving;
  }
  function setFolder(folder) {
    target = folder && folder.path ? folder : null;
  }
  function copied(variant) {
    const entry = manifest.sounds[variant.id];
    return entry && target && entry.base === target.path && entry.stamp === variant.stamp ? entry : null;
  }
  function localState(variant) {
    if (manifest.empty[variant.id] === variant.stamp) return "empty";
    return copied(variant) ? "copied" : "drive";
  }
  function markEmpty(variant) {
    manifest.empty[variant.id] = variant.stamp;
    void saveManifest();
  }
  function knownSeconds(variant) {
    const entry = manifest.seconds[variant.id];
    return entry && entry.stamp === variant.stamp ? entry.seconds : null;
  }
  function rememberSeconds(variant, seconds2) {
    if (seconds2 === null || knownSeconds(variant) === seconds2) return;
    manifest.seconds[variant.id] = { stamp: variant.stamp, seconds: seconds2 };
    void saveManifest();
  }
  function forgetCopy(variant) {
    if (manifest.sounds[variant.id]) {
      delete manifest.sounds[variant.id];
      void saveManifest();
    }
  }
  function copiedFile(variant) {
    const entry = copied(variant);
    return entry && target ? nativeIn(target, entry.path) : null;
  }
  function plannedFile(variant, relative) {
    if (!target) return null;
    const held = copied(variant);
    return nativeIn(target, held ? held.path : freePath(target.path, variant.id, relative));
  }
  async function copiedBytes(variant) {
    const entry = copied(variant);
    if (!entry || !target) return null;
    return readFrom(target, entry.path);
  }
  function copyUsage(variants) {
    let files = 0;
    let bytes = 0;
    for (const variant of variants) {
      const entry = copied(variant);
      if (entry) {
        files += 1;
        bytes += entry.bytes;
      }
    }
    return { files, bytes };
  }
  function copyToDisk(variant, relative, signal) {
    const running = inflight.get(variant.id);
    if (running) return running;
    const job = fetchToFolder(variant, relative, signal).finally(
      () => inflight.delete(variant.id)
    );
    inflight.set(variant.id, job);
    return job;
  }
  async function fetchToFolder(variant, relative, signal) {
    const folder = target;
    if (!folder) {
      throw new Error("nenhuma pasta dos SFX escolhida");
    }
    const held = copied(variant);
    if (held) {
      return { kind: "ok", url: fileUrl(nativeIn(folder, held.path)), bytes: held.bytes };
    }
    if (manifest.empty[variant.id] === variant.stamp) {
      return { kind: "empty" };
    }
    const data = await downloadSound(variant.id, signal);
    if (data.byteLength === 0) {
      markEmpty(variant);
      return { kind: "empty" };
    }
    const path = freePath(folder.path, variant.id, relative);
    let written;
    try {
      written = await writeInto(folder, path, data);
    } catch (cause) {
      throw new Error(`a pasta não aceitou o arquivo (${describe$5(cause)})`);
    }
    manifest.sounds[variant.id] = { base: folder.path, path, stamp: variant.stamp, bytes: data.byteLength };
    void saveManifest();
    return { kind: "ok", url: fileUrl(written), bytes: data.byteLength, data };
  }
  async function clearCopy() {
    const folder = target;
    if (!folder) return 0;
    let count = 0;
    for (const [id, entry] of Object.entries(manifest.sounds)) {
      if (entry.base !== folder.path) continue;
      await removeFrom(folder, entry.path);
      delete manifest.sounds[id];
      count += 1;
    }
    await saveManifest();
    return count;
  }
  function freePath(base, id, relative) {
    const taken = Object.entries(manifest.sounds).some(
      ([other, entry]) => other !== id && entry.base === base && entry.path === relative
    );
    if (!taken) return relative;
    const dot = relative.lastIndexOf(".");
    const tag = id.slice(0, 6);
    return dot > 0 ? `${relative.slice(0, dot)} (${tag})${relative.slice(dot)}` : `${relative} (${tag})`;
  }
  const MEMORY_LIMIT = 48 * 1024 * 1024;
  const MEMORY_ITEM_LIMIT = 12 * 1024 * 1024;
  const memory = /* @__PURE__ */ new Map();
  let memoryBytes = 0;
  let counter = 0;
  let tempNative = null;
  let silence = null;
  function silentWav(seconds2 = 0.3, rate = 8e3) {
    const dataBytes = Math.round(seconds2 * rate) * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const text2 = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    text2(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    text2(8, "WAVE");
    text2(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text2(36, "data");
    view.setUint32(40, dataBytes, true);
    return new Uint8Array(buffer);
  }
  async function warmSilence() {
    if (silence) return;
    try {
      const fs = fsModule();
      if (!fs) return;
      fs.writeFileSync("plugin-temp:/framelab-silence.wav", silentWav());
      silence = fileUrl(join(await temporaryFolder(), "framelab-silence.wav"));
    } catch {
    }
  }
  function silenceUrl() {
    return silence;
  }
  function isNearby(variant) {
    return memory.has(variant.id);
  }
  function remember$1(variant, data) {
    keep(variant.id, data);
  }
  async function bytesFor(variant) {
    const held = memory.get(variant.id);
    if (held) {
      keep(variant.id, held);
      return held;
    }
    const local = await copiedBytes(variant).catch(() => null);
    if (local && local.byteLength > 0) {
      keep(variant.id, local);
      return local;
    }
    const data = await downloadSound(variant.id);
    if (data.byteLength === 0) {
      markEmpty(variant);
      return "empty";
    }
    keep(variant.id, data);
    return data;
  }
  function keep(id, bytes) {
    if (bytes.byteLength > MEMORY_ITEM_LIMIT) return;
    const held = memory.get(id);
    if (held) {
      memory.delete(id);
      memoryBytes -= held.byteLength;
    }
    memory.set(id, bytes);
    memoryBytes += bytes.byteLength;
    for (const [oldest, data] of memory) {
      if (memoryBytes <= MEMORY_LIMIT) break;
      memory.delete(oldest);
      memoryBytes -= data.byteLength;
    }
  }
  async function temporaryFolder() {
    if (tempNative) return tempNative;
    const lfs = uxpModule("uxp")?.storage?.localFileSystem;
    const folder = await lfs?.getTemporaryFolder?.();
    if (!folder?.nativePath) {
      throw new Error("a pasta temporária do UXP não respondeu");
    }
    tempNative = folder.nativePath;
    return tempNative;
  }
  async function previewSource(variant) {
    const bytes = await bytesFor(variant);
    if (bytes === "empty") {
      return { kind: "empty" };
    }
    const fs = fsModule();
    if (!fs) {
      throw new Error('require("fs") não resolveu');
    }
    counter += 1;
    const name = `framelab-sfx-${counter}-${Date.now().toString(36)}.${variant.ext || "wav"}`;
    const route = `plugin-temp:/${name}`;
    fs.writeFileSync(route, new Uint8Array(bytes));
    const url = fileUrl(join(await temporaryFolder(), name));
    let released = false;
    return {
      kind: "ready",
      url,
      release: () => {
        if (released) return;
        released = true;
        void fs.unlink(route).catch(() => void 0);
      }
    };
  }
  const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ';
  function stroked(shapes) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + shapes.replace(/<(path|circle|line|rect) /g, `<$1 ${STROKE}`) + "</svg>";
  }
  const CATEGORY_SHAPES = {
    assinatura: '<path d="M3 17c3-1 5-6 7-6s0 6 3 6 3-4 5-4 2 2 3 2"/><path d="M3 21h18"/>',
    pops: '<circle cx="9" cy="10" r="5"/><circle cx="17" cy="16" r="3"/><circle cx="17.5" cy="6" r="1.5"/>',
    glitch: '<path d="M4 6h9"/><path d="M8 10h12"/><path d="M3 14h8"/><path d="M13 18h8"/>',
    dinheiro: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.5-.5-3-1.5"/><path d="M12 6v12"/>',
    cartoon: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>',
    pessoas: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    foley: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    ambientes: '<rect x="4" y="3" width="10" height="18" rx="1"/><path d="M14 9h6v12h-6"/><path d="M8 7h2M8 11h2M8 15h2"/>',
    natureza: '<path d="M7 16a4 4 0 1 1 1-7.9A5 5 0 0 1 18 9a3.5 3.5 0 0 1-1 6.9"/><path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>',
    fogo: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5.5 1-8.5z"/>',
    animais: '<circle cx="7" cy="9" r="1.8"/><circle cx="11" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M8 17c0-3 2-5 4-5s4 2 4 5c0 1.5-1.5 2.5-4 2.5S8 18.5 8 17z"/>',
    esportes: '<circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M3 12h18"/>',
    alarmes: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 18h14v3H5z"/><path d="M12 3v2M4.5 6.5l1.4 1.4M19.5 6.5l-1.4 1.4"/>',
    games: '<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 10v4M5 12h4"/><path d="M15 11h.01M18 13h.01"/>',
    musical: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    memes: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/><path d="M9 11h.01M15 11h.01"/><path d="M9 14.5c.8.8 1.8 1.2 3 1.2s2.2-.4 3-1.2"/>',
    // wind
    whooshes: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
    // zap
    impactos: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    // trending-up
    risers: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    // mouse-pointer-click
    interface: '<path d="M14 4.1 12 6"/><path d="m5.1 8-2.9-.8"/><path d="m6 12-1.9 2"/><path d="M7.2 2.2 8 5.1"/><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    // clapperboard
    cinematicos: '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    // camera
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    // keyboard
    computador: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
    // sparkles
    brilhos: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
    // shapes
    diversos: '<path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/>'
  };
  const FALLBACK_SHAPES = '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>';
  const SAME_AS = { cliques: "interface", tecnologia: "computador" };
  function categoryIcon(categoryId) {
    return stroked(CATEGORY_SHAPES[categoryId] ?? CATEGORY_SHAPES[SAME_AS[categoryId] ?? ""] ?? FALLBACK_SHAPES);
  }
  const STAR_PATH = "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";
  function starIcon(on) {
    const paint = on ? 'fill="currentColor" stroke="currentColor" stroke-width="1.6"' : 'fill="none" stroke="currentColor" stroke-width="1.8"';
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${paint} stroke-linejoin="round" d="${STAR_PATH}"/></svg>`;
  }
  const PLAY_ICON = '<svg class="sfx-i-play" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z"/></svg>';
  const EQ_ICON = '<span class="sfx-i-eq" aria-hidden="true"><span></span><span></span><span></span></span>';
  const SPIN_ICON = '<svg class="sfx-i-spin" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M12 3a9 9 0 0 1 9 9"/></svg>';
  const INSERT_ICON = stroked('<path d="M5 12h14"/><path d="M12 5v14"/>');
  const FOLDER_ICON = stroked(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
  );
  const SEARCH_ICON = stroked('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>');
  const BACK_ICON = stroked('<path d="m15 18-6-6 6-6"/>');
  const REFRESH_ICON = stroked(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
  );
  const LATE_CHECKS_MS = [0, 16, 50, 120];
  const NAVIGATION = /* @__PURE__ */ new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
  function isWhole(caret) {
    return caret.value.length > 0 && caret.start === 0 && caret.end === caret.value.length;
  }
  const WORD_CHAR = /[\p{L}\p{N}]/u;
  function atWordEdge(left, right) {
    return left === "" || right === "" || !WORD_CHAR.test(left.slice(-1)) || !WORD_CHAR.test(right[0]);
  }
  function couldBeEdit(prev, value) {
    const old = prev.value;
    const pre = old.slice(0, prev.start);
    const post = old.slice(prev.end);
    if (value.length >= pre.length + post.length && value.startsWith(pre) && value.endsWith(post)) return true;
    if (prev.start !== prev.end) return false;
    if (value.endsWith(post)) {
      const kept = value.slice(0, value.length - post.length);
      if (pre.startsWith(kept)) {
        const removed = pre.slice(kept.length);
        if (removed.length === 1 || atWordEdge(kept, removed)) return true;
      }
    }
    if (value.startsWith(pre)) {
      const kept = value.slice(pre.length);
      const rest = old.slice(pre.length);
      if (rest.endsWith(kept)) {
        const removed = rest.slice(0, rest.length - kept.length);
        if (removed.length === 1 || atWordEdge(removed, kept)) return true;
      }
    }
    return false;
  }
  function repairReplacement(prev, value) {
    if (!prev.value || isWhole(prev) || value === "" || value === prev.value) return null;
    if (couldBeEdit(prev, value)) return null;
    const pre = prev.value.slice(0, prev.start);
    const post = prev.value.slice(prev.end);
    const at2 = pre.length + value.length;
    return { value: pre + value + post, start: at2, end: at2 };
  }
  function guardCaret(field, host2) {
    const later = host2.later ?? ((run2, ms) => void setTimeout(run2, ms));
    let focused = false;
    let last = null;
    let undoing = false;
    const hasFocus = () => focused || host2.activeElement() === field;
    function read() {
      const start = field.selectionStart;
      if (start === null || start === void 0) return null;
      return { value: field.value, start, end: field.selectionEnd ?? start };
    }
    function remember2() {
      const now = read();
      if (now) last = now;
    }
    function place(caret) {
      if (typeof field.setSelectionRange === "function") {
        field.setSelectionRange(caret.start, caret.end);
      } else {
        field.selectionStart = caret.start;
        field.selectionEnd = caret.end;
      }
    }
    function restore() {
      if (!last || !hasFocus()) return;
      const now = read();
      if (!now || now.value !== last.value) return;
      if (!isWhole(now) || isWhole(last)) return;
      place(last);
    }
    field.addEventListener("focus", () => {
      focused = true;
    });
    field.addEventListener("blur", () => {
      focused = false;
    });
    field.addEventListener("input", () => {
      const prev = last;
      const now = read();
      if (!now) return;
      const fixed = prev && !undoing ? repairReplacement(prev, now.value) : null;
      undoing = false;
      if (fixed) {
        field.value = fixed.value;
        place(fixed);
        last = fixed;
      } else {
        last = now;
      }
    });
    field.addEventListener("mouseup", remember2);
    field.addEventListener("dblclick", remember2);
    field.addEventListener("keyup", (event) => {
      const selectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a";
      if (selectAll || NAVIGATION.has(event.key)) remember2();
    });
    field.addEventListener("keydown", (event) => {
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") undoing = true;
        if (key === "a") last = { value: field.value, start: 0, end: field.value.length };
        return;
      }
      if (event.altKey) return;
      const types = event.key.length === 1 || event.key === "Backspace" || event.key === "Delete";
      if (!types) return;
      restore();
    });
    return {
      around(paint) {
        const before = hasFocus() ? read() : null;
        if (before && (!isWhole(before) || !last)) last = before;
        paint();
        restore();
        for (const ms of LATE_CHECKS_MS) later(restore, ms);
      },
      sync() {
        undoing = false;
        last = { value: field.value, start: field.value.length, end: field.value.length };
      },
      remembered: () => last
    };
  }
  const DRAG_REPORT = "sfx-drag-report.txt";
  function timelineAcceptsDrop() {
    const version = uxpModule("uxp")?.host?.version ?? "";
    const major = Number.parseInt(version, 10);
    return Number.isFinite(major) && major >= 27;
  }
  const REFRESH_MS = 10 * 60 * 1e3;
  const SYNC_PARALLEL = 3;
  const VIEW_HOME = "inicio";
  const VIEW_FAVORITES = "favoritos";
  let snapshot = null;
  let catalog = null;
  let signature = "";
  let lastRefresh = 0;
  let refreshing = null;
  let refreshError = null;
  let sync = null;
  const listeners = /* @__PURE__ */ new Set();
  let teardown = null;
  let crawlProgress = null;
  function haltSync() {
    if (stopSyncJob(sync)) {
      notify();
    }
  }
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch (cause) {
        console.error("[Efeitos] falha ao redesenhar:", cause);
      }
    }
  }
  function adopt(files) {
    snapshot = files;
    catalog = buildCatalog(files.files);
    signature = files.files.map((file) => `${file.id}:${file.stamp}:${file.folders.join("/")}/${file.name}`).sort().join("|");
  }
  function refreshPack(rootId) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      refreshError = null;
      notify();
      try {
        crawlProgress = { folders: 0, files: 0 };
        let told = 0;
        const files = await crawlPack(rootId, (folders, found) => {
          crawlProgress = { folders, files: found };
          if (folders - told >= 20) {
            told = folders;
            notify();
          }
        });
        if (files.length === 0) {
          throw new Error("a pasta do pack não tem nenhum áudio");
        }
        const next = { rootId, fetchedAt: Date.now(), files };
        adopt(next);
        await writeSnapshot(next);
      } catch (cause) {
        refreshError = describe$5(cause);
        console.warn("[Efeitos] atualização do pack falhou:", cause);
      } finally {
        lastRefresh = Date.now();
        refreshing = null;
        crawlProgress = null;
        notify();
      }
    })();
    return refreshing;
  }
  function allTakes(from) {
    return from.categories.flatMap(
      (category) => category.sounds.flatMap(
        (sound) => sound.variants.map((_variant, index) => ({ category, sound, index }))
      )
    );
  }
  function allVariants(from) {
    return from.categories.flatMap((category) => category.sounds.flatMap((sound) => sound.variants));
  }
  async function runSync(from, categoryId) {
    const job = claimSync(sync, (novo) => {
      sync = novo;
    });
    if (!job) {
      return;
    }
    const queue = allTakes(from).filter(({ category, sound, index }) => (!categoryId || category.id === categoryId) && localState(sound.variants[index]) === "drive");
    job.total = queue.length;
    notify();
    try {
      await drainSync(job, {
        workers: SYNC_PARALLEL,
        next: () => queue.shift(),
        current: () => sync === job,
        tick: notify,
        run: async (take, signal) => {
          const variant = take.sound.variants[take.index];
          const local = await copyToDisk(
            variant,
            fileNameFor(take.category, take.sound, take.index),
            signal
          );
          if (local.kind === "empty") {
            job.empty += 1;
          } else {
            job.bytes += local.bytes;
            if (knownSeconds(variant) === null) {
              rememberSeconds(variant, await probeDuration(local.url));
            }
          }
        }
      });
    } finally {
      if (sync === job && job.running) {
        job.running = false;
        notify();
      }
    }
  }
  function formatSeconds(seconds2) {
    if (seconds2 === null) return "";
    if (seconds2 < 10) return `${seconds2.toFixed(1).replace(".", ",")} s`;
    if (seconds2 < 60) return `${Math.round(seconds2)} s`;
    const whole = Math.round(seconds2);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
  }
  function ago(timestamp) {
    const minutes = Math.floor((Date.now() - timestamp) / 6e4);
    if (minutes < 1) return "agora";
    if (minutes < 60) return `há ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours} h`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "ontem" : `há ${days} dias`;
  }
  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }
  const PAGE_SIZE = 80;
  const CONFIRM_ABOVE = 400;
  const BLURBS = {
    whooshes: "Transições e passagens",
    impactos: "Booms e batidas",
    risers: "Subidas de tensão",
    interface: "Cliques, pops e telas",
    cinematicos: "Acentos de trailer",
    camera: "Obturador, flash e filme",
    computador: "Teclado e mouse",
    brilhos: "Shine, sino e mágica",
    diversos: "Moedas, bolhas, relógio…"
  };
  const sfxTool = {
    id: "sfx",
    name: "Efeitos Sonoros",
    summary: "O pack de SFX da equipe, organizado e com prévia",
    hint: "O pack de efeitos do Drive da equipe (~8.500 sons), organizado pelo tipo de som, com a biblioteca de origem em cada linha. Clique num som para ouvir. Sem pasta escolhida, o som vem do Drive e não fica no computador; com uma pasta, cada som ouvido, o “Baixar” de uma categoria e o do pack inteiro vão para ela, uma subpasta por categoria. Os números tocam cada variação e ↑ ↓ passeiam pela lista ouvindo. Som novo na pasta do Drive aparece aqui ao atualizar, sem versão nova do plugin.",
    category: "audio",
    glyph: "sfx",
    available: true,
    usesSelection: false,
    mount(container, context) {
      const warm = sfxSettings.peek();
      const saved = warm ?? SFX_DEFAULTS;
      const config = { ...saved, favorites: [...saved.favorites] };
      let alive = true;
      let query = "";
      let selectedKey = null;
      const chosen = /* @__PURE__ */ new Map();
      let playing = null;
      let loading2 = null;
      let inserting = false;
      let release = null;
      let ticket = 0;
      let visible = [];
      const rows = /* @__PURE__ */ new Map();
      let drawnSignature = "";
      let lastSyncRunning = false;
      let limit = PAGE_SIZE;
      let armedUntil = 0;
      container.innerHTML = markup$1(config);
      const dotEl = container.querySelector("[data-pack-dot]");
      const metaEl = container.querySelector("[data-pack-meta]");
      const refreshEl = container.querySelector("[data-refresh]");
      const queryEl = container.querySelector("[data-query]");
      const clearEl = container.querySelector("[data-clear]");
      const bodyEl = container.querySelector("[data-body]");
      const packInputEl = container.querySelector("[data-pack-input]");
      const packUseEl = container.querySelector("[data-pack-use]");
      const packNoteEl = container.querySelector("[data-pack-note]");
      const advToggleEl = container.querySelector("[data-adv-toggle]");
      const advContentEl = container.querySelector("[data-adv-content]");
      const advIconEl = container.querySelector("[data-adv-icon]");
      const stageEl = container.querySelector("[data-stage]");
      setHost(stageEl);
      void warmSilence();
      void warmPlayer();
      const folderTextEl = container.querySelector("[data-folder-text]");
      const folderActEl = container.querySelector("[data-folder-act]");
      const folderPathEl = container.querySelector("[data-folder-path]");
      const folderPickEl = container.querySelector("[data-folder-pick]");
      const folderInfoEl = container.querySelector("[data-folder-info]");
      const folderOpenEl = container.querySelector("[data-folder-open]");
      const folderClearEl = container.querySelector("[data-folder-clear]");
      const folderDropEl = container.querySelector("[data-folder-drop]");
      function persist() {
        sfxSettings.save({ ...config, favorites: [...config.favorites] });
      }
      function categoryById(id) {
        return catalog?.categories.find((category) => category.id === id);
      }
      function findSound(key) {
        if (!key || !catalog) return void 0;
        for (const category of catalog.categories) {
          const found = category.sounds.find((sound) => sound.key === key);
          if (found) return found;
        }
        return void 0;
      }
      function isFavorite(sound) {
        return config.favorites.includes(sound.key);
      }
      function favorites() {
        return catalog?.categories.flatMap((category) => category.sounds.filter(isFavorite)) ?? [];
      }
      function currentView() {
        if (config.view === VIEW_FAVORITES) {
          return favorites().length > 0 ? VIEW_FAVORITES : VIEW_HOME;
        }
        return categoryById(config.view) ? config.view : VIEW_HOME;
      }
      function renderPack() {
        if (!dotEl || !metaEl) return;
        const state = refreshing ? "is-busy" : refreshError ? "is-error" : catalog ? "is-live" : "";
        dotEl.className = `sfx-dot ${state}`.trim();
        metaEl.title = refreshError ?? "";
        if (!catalog) {
          metaEl.textContent = refreshing ? crawlProgress && crawlProgress.folders > 0 ? `Lendo o pack no Drive · ${crawlProgress.folders} pastas · ${crawlProgress.files} sons…` : "Conectando ao Drive…" : refreshError ? "O pack não abriu" : "Pack do Drive";
          return;
        }
        const when = refreshing ? crawlProgress && crawlProgress.folders > 0 ? `atualizando · ${crawlProgress.folders} pastas lidas…` : "atualizando…" : refreshError ? `sem conexão · lista de ${ago(snapshot?.fetchedAt ?? 0)}` : `atualizado ${ago(snapshot?.fetchedAt ?? lastRefresh)}`;
        metaEl.textContent = `Drive · ${plural(catalog.sounds, "som", "sons")} · ${when}`;
      }
      function matching(sounds) {
        const terms = queryTerms(query);
        return terms.length === 0 ? sounds : sounds.filter((sound) => soundMatches(sound, terms));
      }
      function tileHtml(id, label, blurb, count, icon) {
        return `<div class="sfx-tile" ${CONTROL} data-open="${escapeHtml(id)}"><span class="sfx-tile-head"><span class="sfx-tile-icon">${icon}</span><span class="sfx-tile-count">${count}</span></span><span class="sfx-tile-name">${escapeHtml(label)}</span>` + (blurb ? `<span class="sfx-tile-blurb">${escapeHtml(blurb)}</span>` : "") + "</div>";
      }
      function homeHtml(from) {
        const tiles = [];
        const favs = favorites();
        if (favs.length > 0) {
          tiles.push(tileHtml(VIEW_FAVORITES, "Favoritos", "Os que você marcou", favs.length, starIcon(true)));
        }
        for (const category of from.categories) {
          tiles.push(
            tileHtml(category.id, category.label, kindById(category.id)?.blurb ?? BLURBS[category.id] ?? "", category.sounds.length, categoryIcon(category.id))
          );
        }
        return `<div class="sfx-tiles">${tiles.join("")}</div>`;
      }
      function headingHtml(label, count, icon, category) {
        const missing = category ? category.sounds.reduce((n, sound) => n + sound.variants.filter((v) => localState(v) === "drive").length, 0) : 0;
        const get = category && missing > 0 && !sync?.running ? `<span class="sfx-action is-small" ${CONTROL} data-get-category="${escapeHtml(category.id)}" title="Para ${escapeHtml(config.folder ? folderLabel(config.folder) : "a pasta que você escolher")}/${escapeHtml(label)}">Baixar ${plural(missing, "som", "sons")}</span>` : "";
        return `<div class="sfx-heading"><span class="sfx-back" ${CONTROL} data-home title="Voltar às categorias">${BACK_ICON}</span><span class="sfx-heading-icon">${icon}</span><span class="sfx-heading-name">${escapeHtml(label)}</span><span class="sfx-heading-count">${plural(count, "som", "sons")}</span>` + get + "</div>";
      }
      function moreHtml(rest) {
        return rest > 0 ? `<div class="sfx-more"><span class="sfx-action" ${CONTROL} data-more>Mostrar mais ${Math.min(PAGE_SIZE, rest)}</span><span class="sfx-more-count">faltam ${rest}</span></div>` : "";
      }
      function sectionHtml(label, count) {
        return `<div class="sfx-section"><span>${escapeHtml(label)}</span><span class="sfx-section-count">${count}</span></div>`;
      }
      function rowHtml(sound) {
        const active = sound.key === selectedKey;
        const states = sound.variants.map(localState);
        const allEmpty = states.every((state) => state === "empty");
        const count = sound.variants.length;
        const take = Math.min(chosen.get(sound.key) ?? 0, count - 1);
        const seconds2 = knownSeconds(sound.variants[take]);
        const classes = ["sfx-row"];
        if (active) classes.push("is-active");
        if (allEmpty) classes.push("is-empty");
        if (playing?.key === sound.key) classes.push("is-playing");
        if (loading2?.key === sound.key) classes.push("is-loading");
        const fav = isFavorite(sound);
        const badges = (count > 1 ? `<span class="sfx-badge" title="${count} variações">×${count}</span>` : "") + (sound.source && sound.source !== "Pack SFX" ? `<span class="sfx-src" title="Biblioteca de origem">${escapeHtml(sound.source)}</span>` : "") + (sound.loop ? '<span class="sfx-badge is-accent">loop</span>' : "") + (allEmpty ? '<span class="sfx-badge is-warn">vazio no Drive</span>' : "");
        const takes = active && count > 1 ? '<span class="sfx-takes">' + sound.variants.map((variant, index) => {
          const busy2 = playing ?? loading2;
          const on = busy2?.key === sound.key ? busy2.take === index : index === take;
          const empty2 = states[index] === "empty";
          return `<span class="sfx-take${empty2 ? " is-empty" : ""}" role="button" tabindex="-1" data-take="${index}" aria-pressed="${on ? "true" : "false"}" title="${escapeHtml(variant.file)}${empty2 ? " — vazio no Drive" : ""}">${index + 1}</span>`;
        }).join("") + "</span>" : "";
        return `<div class="${classes.join(" ")}" data-row="${escapeHtml(sound.key)}"${canDrag ? ' draggable="true"' : ""} role="button" tabindex="0" aria-label="Ouvir ${escapeHtml(sound.name)}"><span class="sfx-play" aria-hidden="true">${PLAY_ICON}${EQ_ICON}${SPIN_ICON}</span><span class="sfx-main"><span class="sfx-line"><span class="sfx-name">${escapeHtml(sound.name)}</span>${badges}</span>` + takes + `</span><span class="sfx-dur" data-dur>${formatSeconds(seconds2)}</span>` + (allEmpty ? "" : `<span class="sfx-put" role="button" tabindex="-1" data-insert title="Inserir">${INSERT_ICON}</span>`) + `<span class="sfx-fav${fav ? " is-on" : ""}" role="button" tabindex="-1" data-fav aria-pressed="${fav ? "true" : "false"}" title="${fav ? "Tirar dos favoritos" : "Favoritar"}">${starIcon(fav)}</span><span class="sfx-progress" data-progress></span></div>`;
      }
      function ghostHtml() {
        return '<div class="sfx-tiles">' + Array.from({ length: 6 }, () => '<div class="sfx-tile is-ghost"><span></span><span></span></div>').join("") + "</div>";
      }
      const canDrag = timelineAcceptsDrop();
      const TIP = '<p class="sfx-tip">' + (canDrag ? "Arraste um som para a timeline, ou + para inserir" : "Leve a agulha até o ponto e clique em + (ou I) para pôr o som ali") + " · ↑ ↓ passeiam ouvindo · 1–9 variação · F favorita</p>";
      const caret = queryEl ? guardCaret(queryEl, { activeElement: () => document.activeElement }) : null;
      function renderBody() {
        if (caret) caret.around(paintBody);
        else paintBody();
      }
      function paintBody() {
        if (!bodyEl) return;
        rows.clear();
        visible = [];
        drawnSignature = signature;
        if (!catalog) {
          bodyEl.innerHTML = refreshError && !refreshing ? `<div class="sfx-empty"><p>O pack não abriu.</p><p class="sfx-empty-detail">${escapeHtml(refreshError)}</p><span class="sfx-action" ${CONTROL} data-retry>Tentar de novo</span></div>` : ghostHtml();
          return;
        }
        const blocks = [];
        const searching = queryTerms(query).length > 0;
        if (searching) {
          let total = 0;
          const sections = [];
          for (const category of catalog.categories) {
            const sounds = matching(category.sounds);
            if (sounds.length === 0) continue;
            total += sounds.length;
            const room = limit - visible.length;
            if (room <= 0) continue;
            sections.push(sectionHtml(category.label, sounds.length));
            for (const sound of sounds.slice(0, room)) {
              sections.push(rowHtml(sound));
              visible.push(sound);
            }
          }
          if (total === 0) {
            bodyEl.innerHTML = `<div class="sfx-empty"><p>Nada com <b>“${escapeHtml(query.trim())}”</b>.</p><p class="sfx-empty-detail">O pack é quase todo em inglês: tente whoosh, hit, riser, click.</p></div>`;
            return;
          }
          blocks.push(`<p class="sfx-results">${plural(total, "som", "sons")} para “${escapeHtml(query.trim())}”</p>`);
          blocks.push(...sections, moreHtml(total - visible.length), TIP);
        } else {
          const view = currentView();
          if (view === VIEW_HOME) {
            bodyEl.innerHTML = homeHtml(catalog);
            return;
          }
          if (view === VIEW_FAVORITES) {
            const favs = favorites();
            blocks.push(headingHtml("Favoritos", favs.length, starIcon(true)));
            for (const category of catalog.categories) {
              const sounds = category.sounds.filter(isFavorite);
              if (sounds.length === 0) continue;
              blocks.push(sectionHtml(category.label, sounds.length));
              for (const sound of sounds) {
                blocks.push(rowHtml(sound));
                visible.push(sound);
              }
            }
          } else {
            const category = categoryById(view);
            if (category) {
              blocks.push(headingHtml(category.label, category.sounds.length, categoryIcon(category.id), category));
              blocks.push('<div class="sfx-rows">');
              for (const sound of category.sounds.slice(0, limit)) {
                blocks.push(rowHtml(sound));
                visible.push(sound);
              }
              blocks.push("</div>", moreHtml(category.sounds.length - visible.length));
            }
          }
          blocks.push(TIP);
        }
        bodyEl.innerHTML = blocks.join("");
        for (const row of bodyEl.querySelectorAll("[data-row]")) {
          rows.set(row.dataset.row ?? "", row);
        }
      }
      function paintRow(key) {
        if (!key) return;
        const row = rows.get(key);
        const sound = findSound(key);
        if (!row || !sound) return;
        const holder = document.createElement("div");
        holder.innerHTML = rowHtml(sound);
        const fresh = holder.firstElementChild;
        if (!fresh) return;
        const hadFocus = document.activeElement === row;
        row.replaceWith(fresh);
        rows.set(key, fresh);
        if (hadFocus) fresh.focus();
      }
      function runProgress(key, seconds2) {
        const bar = rows.get(key)?.querySelector("[data-progress]");
        if (!bar || seconds2 === null) return;
        bar.style.transition = "none";
        bar.style.width = "0";
        void bar.offsetWidth;
        bar.style.transition = `width ${seconds2}s linear`;
        bar.style.width = "100%";
      }
      function renderAll() {
        renderPack();
        renderBody();
        syncActions();
      }
      function open(view) {
        limit = PAGE_SIZE;
        config.view = view;
        persist();
        if (bodyEl) bodyEl.scrollTop = 0;
        renderBody();
        container.closest(".work-scroll")?.scrollTo?.({ top: 0 });
      }
      function letGo() {
        release?.();
        release = null;
      }
      function stop() {
        ticket += 1;
        stopPlayback();
        letGo();
        const before = playing?.key ?? loading2?.key ?? null;
        playing = null;
        loading2 = null;
        paintRow(before);
        syncActions();
      }
      function emptyMessage(variant) {
        context.setStatus(
          `“${variant.file}” está vazio no próprio Drive — o upload dele falhou e precisa ser refeito.`,
          "error"
        );
      }
      async function play(sound, take) {
        const variant = sound.variants[take];
        if (!variant) return;
        if (localState(variant) === "empty") {
          emptyMessage(variant);
          return;
        }
        const before = selectedKey;
        stopPlayback();
        letGo();
        prime(silenceUrl());
        const mine = ++ticket;
        playing = null;
        loading2 = { key: sound.key, take };
        selectedKey = sound.key;
        chosen.set(sound.key, take);
        if (before !== sound.key) paintRow(before);
        paintRow(sound.key);
        syncActions();
        const label = sound.variants.length > 1 ? `${sound.name} · ${take + 1} de ${sound.variants.length}` : sound.name;
        const toFolder = !!config.folder && localState(variant) === "drive";
        if (toFolder) {
          context.setStatus(`Baixando ${label} para ${folderLabel(config.folder)}…`, "idle");
        } else if (!isNearby(variant) && localState(variant) !== "copied") {
          context.setStatus(`Buscando ${label} no Drive…`, "idle");
        }
        let note2 = "";
        const finish = () => {
          letGo();
          playing = null;
          loading2 = null;
          paintRow(sound.key);
          syncActions();
        };
        let source = null;
        try {
          const category = categoryById(sound.category);
          if (toFolder && category) {
            try {
              const saved2 = await copyToDisk(variant, fileNameFor(category, sound, take));
              if (saved2.kind === "empty") {
                source = { kind: "empty" };
              } else if (saved2.data) {
                remember$1(variant, saved2.data);
              }
              if (alive) {
                renderPack();
                syncActions();
              }
            } catch (cause) {
              note2 = ` — não ficou salvo na pasta (${describe$5(cause)})`;
            }
          }
          source ?? (source = await previewSource(variant));
        } catch (cause) {
          if (!alive || mine !== ticket) return;
          finish();
          context.setStatus(`Não baixou “${sound.name}”: ${describe$5(cause)}`, "error");
          return;
        }
        if (!alive || mine !== ticket) {
          if (source.kind === "ready") source.release();
          return;
        }
        if (source.kind === "empty") {
          finish();
          emptyMessage(variant);
          return;
        }
        release = source.release;
        playUrl(source.url, {
          onStart: (seconds2) => {
            if (!alive || mine !== ticket) return;
            loading2 = null;
            playing = { key: sound.key, take };
            paintRow(sound.key);
            syncActions();
            context.setStatus(`Tocando ${label}${note2}`, note2 ? "error" : "idle");
            if (seconds2 !== null && knownSeconds(variant) === null) {
              rememberSeconds(variant, seconds2);
              const dur = rows.get(sound.key)?.querySelector("[data-dur]");
              if (dur) dur.textContent = formatSeconds(seconds2);
            }
            runProgress(sound.key, seconds2 ?? knownSeconds(variant));
          },
          onEnd: () => {
            if (!alive || mine !== ticket) return;
            finish();
            context.setStatus("", "idle");
          },
          onError: (message) => {
            if (!alive || mine !== ticket) return;
            if (localState(variant) === "copied") forgetCopy(variant);
            finish();
            context.setStatus(`Não tocou “${sound.name}”: ${message}`, "error");
          }
        }, `${sound.name} #${take + 1}`);
      }
      function toggle(sound, take) {
        const index = take ?? chosen.get(sound.key) ?? 0;
        const busy2 = playing ?? loading2;
        if (busy2 && busy2.key === sound.key && busy2.take === index) {
          stop();
          return;
        }
        void play(sound, index);
      }
      function toggleFavorite(sound) {
        config.favorites = isFavorite(sound) ? config.favorites.filter((key) => key !== sound.key) : [...config.favorites, sound.key];
        persist();
        if (currentView() === VIEW_FAVORITES || config.view === VIEW_FAVORITES && favorites().length === 0) {
          renderBody();
        } else {
          paintRow(sound.key);
        }
      }
      function move(step2) {
        if (visible.length === 0) return;
        const at2 = visible.findIndex((sound) => sound.key === selectedKey);
        const next = visible[Math.max(0, Math.min(visible.length - 1, at2 < 0 ? 0 : at2 + step2))];
        if (!next || next.key === selectedKey && at2 >= 0) return;
        void play(next, chosen.get(next.key) ?? 0);
        const row = rows.get(next.key);
        row?.focus();
        row?.scrollIntoView?.({ block: "nearest" });
      }
      function syncActions() {
        if (!alive) return;
        const sound = findSound(selectedKey);
        context.setApplyLabel(inserting ? "Inserindo…" : "Inserir");
        context.setApplyEnabled(!!sound && !inserting);
        if (sync?.running) {
          context.setResetLabel("Parar download");
          context.setResetHandler(haltSync);
        } else {
          context.setResetHandler(null);
        }
        renderFolder();
      }
      context.setApplyHandler(async () => {
        const sound = findSound(selectedKey);
        if (sound) await insertSound(sound, chosen.get(sound.key) ?? 0);
      });
      function takeLabel(sound, take) {
        return sound.variants.length > 1 ? `${sound.name} ${take + 1}` : sound.name;
      }
      async function fileInFolder(sound, take) {
        const variant = sound.variants[take];
        const category = categoryById(sound.category);
        if (!variant || !category) return null;
        if (!config.folder) {
          context.setStatus("Para pôr na timeline o som precisa de uma pasta — escolha onde guardar os SFX.", "idle");
          await choose(true);
          if (!config.folder) return null;
        }
        const held = copiedFile(variant);
        if (held) return held;
        const saved2 = await copyToDisk(variant, fileNameFor(category, sound, take));
        if (alive) {
          renderPack();
          syncActions();
        }
        if (saved2.kind === "empty") return "empty";
        if (saved2.data) remember$1(variant, saved2.data);
        return nativeFileOf(saved2.url);
      }
      async function insertSound(sound, take) {
        if (inserting) return;
        const variant = sound.variants[take];
        if (!variant) return;
        if (localState(variant) === "empty") {
          emptyMessage(variant);
          return;
        }
        inserting = true;
        syncActions();
        const label = takeLabel(sound, take);
        context.setStatus(`Inserindo ${label}…`, "idle");
        try {
          const file = await fileInFolder(sound, take);
          if (file === null) {
            context.setStatus("Nada foi inserido: nenhuma pasta escolhida.", "idle");
            return;
          }
          if (file === "empty") {
            emptyMessage(variant);
            paintRow(sound.key);
            return;
          }
          const seconds2 = knownSeconds(variant) ?? await probeDuration(`file://${encodeURI(file)}`);
          rememberSeconds(variant, seconds2);
          const result = await insertAtPlayhead(file, seconds2);
          if (!alive) return;
          context.setStatus(
            result.ok ? `${label} entrou na ${result.message}.` : `Não inseri ${label}: ${result.message}.`,
            result.ok ? "done" : "error"
          );
        } catch (cause) {
          if (alive) context.setStatus(`Não inseri ${label}: ${describe$5(cause)}.`, "error");
        } finally {
          inserting = false;
          if (alive) syncActions();
        }
      }
      const CONTENT_TYPES = {
        wav: "audio/wav",
        mp3: "audio/mpeg",
        mpeg: "audio/mpeg",
        m4a: "audio/m4a",
        aac: "audio/aac",
        aif: "audio/aif",
        aiff: "audio/x-aiff"
      };
      function onDragStart(event) {
        const row = event.target?.closest("[data-row]");
        const sound = findSound(row?.dataset.row ?? null);
        const transfer = event.dataTransfer;
        if (!sound || !transfer) return;
        const take = chosen.get(sound.key) ?? 0;
        const variant = sound.variants[take];
        const category = categoryById(sound.category);
        if (!variant || !category || localState(variant) === "empty") {
          event.preventDefault();
          if (variant) emptyMessage(variant);
          return;
        }
        const relative = fileNameFor(category, sound, take);
        const file = plannedFile(variant, relative);
        if (!file) {
          event.preventDefault();
          context.setStatus(
            "Para arrastar para a timeline, escolha antes a pasta dos SFX (linha embaixo da busca).",
            "error"
          );
          return;
        }
        if (localState(variant) !== "copied") {
          void copyToDisk(variant, relative).then((saved2) => {
            if (saved2.kind === "ok" && saved2.data) remember$1(variant, saved2.data);
            if (alive) renderPack();
          }).catch((cause) => {
            if (alive) context.setStatus(`Não baixei ${takeLabel(sound, take)}: ${describe$5(cause)}`, "error");
          });
        }
        const name = file.slice(file.lastIndexOf("/") + 1);
        const payload = {
          version: "1.0.0",
          items: [
            {
              name,
              display_name: takeLabel(sound, take),
              content_type: CONTENT_TYPES[variant.ext] ?? "audio/wav",
              // encodeURI, como a Adobe pede — e o `#` e o `?` à mão, que
              // ele deixa passar e que cortariam o caminho no meio.
              uri: `file://${encodeURI(file).replace(/#/g, "%23").replace(/\?/g, "%3F")}`
            }
          ]
        };
        const uri = payload.items[0].uri;
        const notes = [];
        try {
          transfer.setData("text/plain", JSON.stringify(payload));
          notes.push("text/plain ok");
        } catch (cause) {
          notes.push(`text/plain falhou (${describe$5(cause)})`);
        }
        try {
          transfer.setData("text/uri-list", uri);
          notes.push("text/uri-list ok");
        } catch (cause) {
          notes.push(`text/uri-list falhou (${describe$5(cause)})`);
        }
        transfer.effectAllowed = "copyMove";
        transfer.dropEffect = "copy";
        dragNote(`começou · ${takeLabel(sound, take)} · ${notes.join(" · ")} · ${uri}`);
        context.setStatus(`Solte ${takeLabel(sound, take)} na timeline…`, "idle");
      }
      function dragNote(line) {
        const now = /* @__PURE__ */ new Date();
        const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
        void (async () => {
          try {
            const space = await workspace();
            const before = (readText$1(space, DRAG_REPORT) ?? "").split("\n").slice(-59);
            await write(space, DRAG_REPORT, [...before, `${stamp} ${line}`].join("\n"));
          } catch {
          }
        })();
      }
      function applyFolder() {
        setFolder(config.folder ? { path: config.folder, token: config.folderToken } : null);
        forgetOpenFolders();
      }
      applyFolder();
      void (async () => {
        const held = await readDestination(
          "sfx",
          destinationOf(config.folder, config.folderToken)
        ).catch(() => null);
        if (!alive || !held || held.path === config.folder) return;
        config.folder = held.path;
        config.folderToken = held.token;
        applyFolder();
        renderAll();
      })();
      function renderFolder() {
        const label = config.folder ? folderLabel(config.folder) : "";
        const variants = catalog ? allVariants(catalog) : [];
        const copy = copyUsage(variants);
        const missing = variants.filter((variant) => localState(variant) === "drive").length;
        const running = !!sync?.running;
        if (folderTextEl && folderActEl) {
          folderTextEl.title = config.folder;
          if (!config.folder) {
            folderTextEl.innerHTML = '<span class="sfx-folder-dim">Pasta dos SFX: nenhuma — os sons vêm do Drive</span>';
            folderActEl.textContent = "Escolher…";
            folderActEl.dataset.act = "pick";
          } else if (running && sync) {
            folderTextEl.innerHTML = `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · baixando ${sync.done} de ${sync.total}</span>`;
            folderActEl.textContent = "Parar";
            folderActEl.dataset.act = "stop";
          } else if (catalog && missing > 0) {
            folderTextEl.innerHTML = `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · ${copy.files} de ${catalog.files} sons</span>`;
            folderActEl.textContent = Date.now() < armedUntil ? `Confirmar: ${missing}` : `Baixar ${missing}`;
            folderActEl.dataset.act = "download";
          } else {
            folderTextEl.innerHTML = `<b>${escapeHtml(label)}</b><span class="sfx-folder-dim"> · ${plural(copy.files, "som", "sons")}${copy.bytes > 0 ? ` · ${formatBytes(copy.bytes)}` : ""}</span>`;
            folderActEl.textContent = "Abrir";
            folderActEl.dataset.act = "open";
          }
          folderActEl.hidden = !catalog && !!config.folder;
        }
        if (folderPathEl) folderPathEl.textContent = config.folder || "Nenhuma";
        if (folderPickEl) folderPickEl.textContent = config.folder ? "Trocar…" : "Escolher…";
        if (folderInfoEl) {
          folderInfoEl.textContent = !config.folder ? "Sem pasta, os sons vêm do Drive na hora de ouvir e não ficam guardados neste computador. Escolha uma pasta para ter o pack no disco, uma subpasta por categoria." : running && sync ? `Baixando ${sync.done} de ${sync.total} · ${formatBytes(sync.bytes)}` : `${copy.files} de ${catalog?.files ?? 0} sons nesta pasta` + (copy.bytes > 0 ? ` · ${formatBytes(copy.bytes)}` : "") + (missing > 0 ? ` · faltam ${missing}` : "") + ". Apagar tira só o que o plugin baixou; o resto da pasta não é tocado.";
        }
        if (folderOpenEl) folderOpenEl.hidden = !config.folder;
        if (folderClearEl) folderClearEl.hidden = !config.folder || copy.files === 0 || running;
        if (folderDropEl) folderDropEl.hidden = !config.folder || running;
      }
      async function choose(quiet = false) {
        try {
          const picked = await pickAndSave("sfx");
          if (!picked || !alive) return;
          haltSync();
          config.folder = picked.path;
          config.folderToken = picked.token;
          persist();
          applyFolder();
          renderAll();
          if (quiet) return;
          context.setStatus(
            `Pasta escolhida: ${folderLabel(picked.path)}. Os sons que você ouvir ficam salvos nela, e “Baixar o pack” traz o resto.`,
            "done"
          );
        } catch (cause) {
          context.setStatus(`A pasta não abriu: ${describe$5(cause)}`, "error");
        }
      }
      async function download() {
        if (!catalog || sync?.running || !config.folder) return;
        const missing = allVariants(catalog).filter((variant) => localState(variant) === "drive").length;
        if (missing > CONFIRM_ABOVE && Date.now() > armedUntil) {
          armedUntil = Date.now() + 8e3;
          renderFolder();
          context.setStatus(
            `São ${missing} sons (vários GB) para ${folderLabel(config.folder)}. Clique de novo em “Confirmar” para baixar tudo — ou abra uma categoria e baixe só ela.`,
            "idle"
          );
          setTimeout(() => {
            if (alive) renderFolder();
          }, 8100);
          return;
        }
        armedUntil = 0;
        context.setStatus(`Baixando o pack para ${folderLabel(config.folder)}…`, "idle");
        await runSync(catalog);
      }
      async function downloadCategory(categoryId) {
        if (!catalog || sync?.running) return;
        const category = categoryById(categoryId);
        if (!category) return;
        if (!config.folder) await choose(true);
        if (!config.folder || !alive) return;
        context.setStatus(`Baixando ${category.label} para ${folderLabel(config.folder)}/${category.label}…`, "idle");
        await runSync(catalog, categoryId);
      }
      async function openFolder() {
        if (!config.folder) return;
        const shell = shellModule();
        if (!shell?.openPath) {
          context.setStatus("Este Premiere não deixa o painel abrir pastas.", "error");
          return;
        }
        try {
          const refusal = await shell.openPath(config.folder, "Abrir a pasta dos efeitos sonoros");
          if (typeof refusal === "string" && refusal.trim()) {
            context.setStatus(`A pasta não abriu: ${refusal.trim()}`, "error");
          }
        } catch (cause) {
          context.setStatus(`A pasta não abriu: ${describe$5(cause)}`, "error");
        }
      }
      function reportSync(job) {
        const where = config.folder ? folderLabel(config.folder) : "a pasta";
        const parts = [];
        if (job.cancelled) parts.push(`Download parado: ${job.done - job.failed - job.empty} de ${job.total} em ${where}`);
        else parts.push(`${plural(job.done - job.failed - job.empty, "som baixado", "sons baixados")} em ${where}: ${formatBytes(job.bytes)}`);
        if (job.empty > 0) parts.push(`${plural(job.empty, "arquivo está vazio", "arquivos estão vazios")} no próprio Drive`);
        if (job.failed > 0) parts.push(`${plural(job.failed, "não baixou", "não baixaram")} (${job.lastError ?? "erro"})`);
        context.setStatus(parts.join(" · "), job.failed > 0 ? "error" : "done");
      }
      folderActEl?.addEventListener("click", () => {
        switch (folderActEl.dataset.act) {
          case "pick":
            void choose();
            break;
          case "stop":
            haltSync();
            break;
          case "download":
            void download();
            break;
          default:
            void openFolder();
        }
      });
      folderPickEl?.addEventListener("click", () => void choose());
      folderOpenEl?.addEventListener("click", () => void openFolder());
      folderClearEl?.addEventListener("click", () => {
        if (sync?.running) return;
        stop();
        void clearCopy().then((count) => {
          if (!alive) return;
          renderAll();
          context.setStatus(
            `${plural(count, "som apagado", "sons apagados")} da pasta. Eles voltam a vir do Drive.`,
            "done"
          );
        }).catch((cause) => context.setStatus(`Não consegui apagar: ${describe$5(cause)}`, "error"));
      });
      folderDropEl?.addEventListener("click", () => {
        if (sync?.running) return;
        stop();
        config.folder = "";
        config.folderToken = "";
        persist();
        applyFolder();
        renderAll();
        context.setStatus("Sem pasta: os sons voltam a vir do Drive. Nada foi apagado.", "done");
      });
      bodyEl?.addEventListener("click", (event) => {
        const target2 = event.target;
        if (target2?.closest("[data-retry]")) {
          void refreshPack(config.pack);
          return;
        }
        if (target2?.closest("[data-home]")) {
          open(VIEW_HOME);
          return;
        }
        if (target2?.closest("[data-more]")) {
          const top = bodyEl.scrollTop;
          limit += PAGE_SIZE;
          renderBody();
          bodyEl.scrollTop = top;
          return;
        }
        const getCategory = target2?.closest("[data-get-category]");
        if (getCategory) {
          void downloadCategory(getCategory.dataset.getCategory ?? "");
          return;
        }
        const tile = target2?.closest("[data-open]");
        if (tile?.dataset.open) {
          open(tile.dataset.open);
          return;
        }
        const row = target2?.closest("[data-row]");
        const sound = findSound(row?.dataset.row ?? null);
        if (!sound) return;
        if (target2?.closest("[data-insert]")) {
          void insertSound(sound, chosen.get(sound.key) ?? 0);
          return;
        }
        if (target2?.closest("[data-fav]")) {
          toggleFavorite(sound);
          return;
        }
        const takeEl = target2?.closest("[data-take]");
        if (takeEl) {
          toggle(sound, Number(takeEl.dataset.take));
          return;
        }
        toggle(sound);
      });
      bodyEl?.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          move(event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Escape" && currentView() !== VIEW_HOME && !query) {
          event.preventDefault();
          open(VIEW_HOME);
          return;
        }
        const row = event.target?.closest("[data-row]");
        const sound = findSound(row?.dataset.row ?? null);
        if (!sound) return;
        if (event.key === "i" || event.key === "I") {
          event.preventDefault();
          void insertSound(sound, chosen.get(sound.key) ?? 0);
          return;
        }
        if (event.key === "f" || event.key === "F") {
          event.preventDefault();
          toggleFavorite(sound);
          return;
        }
        if (/^[1-9]$/.test(event.key)) {
          const take = Number(event.key) - 1;
          if (take < sound.variants.length) {
            event.preventDefault();
            void play(sound, take);
          }
        }
      });
      bodyEl?.addEventListener("dragstart", (event) => onDragStart(event));
      bodyEl?.addEventListener("dragend", (event) => {
        const drag = event;
        dragNote(`terminou · dropEffect=${String(drag.dataTransfer?.dropEffect ?? "?")}`);
      });
      bodyEl?.addEventListener("mousedown", (event) => {
        const target2 = event.target;
        if (!config.folder || target2?.closest("[data-fav],[data-take],[data-insert]")) return;
        const sound = findSound(target2?.closest("[data-row]")?.dataset.row ?? null);
        const take = sound ? chosen.get(sound.key) ?? 0 : 0;
        const variant = sound?.variants[take];
        const category = sound ? categoryById(sound.category) : void 0;
        if (!sound || !variant || !category || localState(variant) !== "drive") return;
        void copyToDisk(variant, fileNameFor(category, sound, take)).then((saved2) => {
          if (saved2.kind === "ok" && saved2.data) remember$1(variant, saved2.data);
        }).catch(() => void 0);
      });
      const QUERY_DEBOUNCE_MS = 120;
      let queryTimer = null;
      function applyQuery(value, immediate = false) {
        limit = PAGE_SIZE;
        query = value;
        if (queryEl && queryEl.value !== value) {
          queryEl.value = value;
          caret?.sync();
        }
        if (clearEl) clearEl.hidden = value.length === 0;
        if (queryTimer !== null) {
          clearTimeout(queryTimer);
          queryTimer = null;
        }
        if (immediate) {
          renderBody();
          return;
        }
        queryTimer = setTimeout(() => {
          queryTimer = null;
          if (alive) renderBody();
        }, QUERY_DEBOUNCE_MS);
      }
      queryEl?.addEventListener("input", () => applyQuery(queryEl.value));
      queryEl?.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && query) {
          event.preventDefault();
          applyQuery("", true);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          const before = selectedKey;
          selectedKey = null;
          paintRow(before);
          move(1);
        }
      });
      clearEl?.addEventListener("click", () => {
        applyQuery("", true);
        queryEl?.focus();
      });
      refreshEl?.addEventListener("click", () => void refreshPack(config.pack));
      advToggleEl?.addEventListener("click", () => {
        if (!advContentEl) return;
        advContentEl.hidden = !advContentEl.hidden;
        if (advIconEl) advIconEl.textContent = advContentEl.hidden ? "▾" : "▴";
      });
      packUseEl?.addEventListener("click", () => {
        const id = folderIdFrom(packInputEl?.value ?? "");
        if (!id) {
          if (packNoteEl) packNoteEl.textContent = "Não achei o id de uma pasta nesse link.";
          return;
        }
        if (packNoteEl) packNoteEl.textContent = PACK_NOTE;
        if (id === config.pack) {
          void refreshPack(id);
          return;
        }
        haltSync();
        stop();
        config.pack = id;
        config.view = VIEW_HOME;
        persist();
        snapshot = null;
        catalog = null;
        signature = "";
        renderAll();
        void (async () => {
          const held = await readSnapshot(id);
          if (!alive || config.pack !== id) return;
          if (held) adopt(held);
          renderAll();
          void refreshPack(id);
        })();
      });
      const onOutside = () => {
        if (!alive) return;
        renderPack();
        if (signature !== drawnSignature || !catalog) {
          renderBody();
        }
        syncActions();
        if (sync) {
          if (sync.running) {
            lastSyncRunning = true;
            context.setStatus(`Baixando o pack · ${sync.done} de ${sync.total} · ${formatBytes(sync.bytes)}`, "idle");
          } else if (lastSyncRunning) {
            lastSyncRunning = false;
            reportSync(sync);
            renderBody();
          }
        }
      };
      listeners.add(onOutside);
      renderAll();
      if (sync?.running) {
        lastSyncRunning = true;
        onOutside();
      }
      void (async () => {
        if (!warm) {
          const stored = await sfxSettings.read();
          Object.assign(config, stored, { favorites: [...stored.favorites] });
          applyFolder();
        }
        await loadManifest();
        if (!catalog || snapshot?.rootId !== config.pack) {
          const held = await readSnapshot(config.pack);
          if (held) adopt(held);
        }
        if (!alive) return;
        renderAll();
        const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS || snapshot?.rootId !== config.pack;
        if (stale) void refreshPack(config.pack);
      })();
      teardown = () => {
        setHost(null);
        alive = false;
        if (queryTimer !== null) {
          clearTimeout(queryTimer);
          queryTimer = null;
        }
        listeners.delete(onOutside);
        ticket += 1;
        stopPlayback();
        letGo();
      };
    },
    unmount() {
      teardown?.();
      teardown = null;
      void sfxSettings.flush();
    }
  };
  const PACK_NOTE = "Pasta pública do Drive. Cada pasta dentro dela vira uma categoria.";
  function markup$1(config) {
    return '<div class="zones sfx"><div class="zone sfx-top"><div class="sfx-search">' + SEARCH_ICON + // Campo de busca de painel não é formulário: sem histórico, sem
    // correção e sem maiúscula automática. Não foi o que causava o
    // texto selecionado (ver caretGuard.ts), é só higiene do campo.
    `<input type="text" class="sfx-query" data-query spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="Buscar — whoosh, impacto, clique…"><span class="sfx-clear" ${CONTROL} data-clear aria-label="Limpar busca" hidden>×</span></div><div class="sfx-source"><span class="sfx-dot" data-pack-dot></span><span class="sfx-source-text" data-pack-meta></span><span class="sfx-stage" data-stage aria-hidden="true"></span><span class="sfx-refresh" ${CONTROL} data-refresh title="Ver se o pack mudou no Drive">${REFRESH_ICON}</span></div><div class="sfx-folder"><span class="sfx-folder-icon">${FOLDER_ICON}</span><span class="sfx-folder-text" data-folder-text></span><span class="sfx-folder-act" ${CONTROL} data-folder-act></span></div></div><div class="zone sfx-body" data-body></div><div class="sil-advanced"><div class="sil-advanced-summary" ${CONTROL} data-adv-toggle><span class="sil-advanced-title">Ajustes avançados</span><span class="sil-advanced-icon" data-adv-icon>▾</span></div><div class="sil-advanced-content" data-adv-content hidden><div class="field"><div class="field-head"><span class="t-label" title="Onde os sons ficam quando você baixa o pack.">Pasta dos SFX</span><span class="field-action" ${CONTROL} data-folder-pick>Escolher…</span></div><p class="dl-dest" data-folder-path></p><p class="tt-note sfx-copy-info" data-folder-info></p><div class="sfx-copy-acts"><span class="field-action" ${CONTROL} data-folder-open hidden>Abrir pasta</span><span class="field-action" ${CONTROL} data-folder-clear hidden>Apagar os sons baixados</span><span class="field-action" ${CONTROL} data-folder-drop hidden>Não usar pasta</span></div></div><div class="field"><div class="field-head"><span class="t-label" title="O link de uma pasta pública do Drive.">Link do pack</span><span class="field-action" ${CONTROL} data-pack-use>Usar</span></div><input type="text" class="sil-path" data-pack-input spellcheck="false" value="${escapeHtml(`https://drive.google.com/drive/folders/${config.pack}`)}"><p class="tt-note" data-pack-note>${PACK_NOTE}</p></div></div></div></div>`;
  }
  const DEFAULT_OPTIONS = {
    word: true,
    graphic: true,
    overlay: true,
    zoom: false,
    move: false,
    opacity: false,
    text: false,
    cut: false,
    density: "balanced"
  };
  const LABELS = {
    word: "Palavra por palavra",
    graphic: "Entrada de texto",
    overlay: "Overlays e efeitos",
    zoom: "Zoom e punch-in",
    move: "Movimento",
    opacity: "Aparecer / sumir",
    text: "Troca de texto",
    cut: "Corte seco"
  };
  function hash(text2) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text2.length; i++) {
      a = Math.imul(a ^ text2.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ text2.charCodeAt(i);
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }
  const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
  const seconds = (n) => `${n.toFixed(2).replace(".", ",")} s`;
  function detectMotion(kind, input, clip, key, label = LABELS[kind]) {
    const samples = input.filter((s) => Number.isFinite(s.time) && s.value.length > 0 && s.value.every(Number.isFinite)).slice().sort((a, b) => a.time - b.time);
    const events = [];
    let begin = -1;
    let previous = [];
    const flush = (last) => {
      if (begin < 0 || last <= begin) return;
      const first = samples[begin], end = samples[last];
      const duration = end.time - first.time;
      const delta = end.value.map((v, i) => v - first.value[i]);
      const amount = kind === "zoom" ? Math.abs(end.value[0] / Math.max(1e-3, first.value[0]) - 1) : Math.hypot(...delta);
      if (!(duration > 0 && duration <= 5) || amount < (kind === "opacity" ? 0.3 : 0.035)) return;
      const intensity = clamp(amount / (kind === "opacity" ? 1.2 : 0.5) / Math.sqrt(Math.max(0.15, duration)), 0.12, 1);
      let peak = end.time, fastest = -1;
      for (let i = begin + 1; i <= last; i++) {
        const speed = Math.hypot(...samples[i].value.map((v, j) => v - samples[i - 1].value[j])) / Math.max(1e-4, samples[i].time - samples[i - 1].time);
        if (speed > fastest) {
          fastest = speed;
          peak = (samples[i].time + samples[i - 1].time) / 2;
        }
      }
      const detail = kind === "zoom" ? `${end.value[0] >= first.value[0] ? "Aproxima" : "Afasta"} ${Math.round(amount * 100)}% · ${seconds(duration)}` : kind === "opacity" ? `${end.value[0] >= first.value[0] ? "Aparece" : "Some"} · ${seconds(duration)}` : `${label} · ${seconds(duration)}`;
      events.push({
        id: hash(`${key}|${kind}|${first.time.toFixed(6)}|${end.time.toFixed(6)}`),
        clip,
        kind,
        start: first.time,
        end: end.time,
        peak,
        intensity,
        detail
      });
    };
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (b.time <= a.time || b.value.length !== a.value.length) continue;
      const direction = b.value.map((v, j) => v - a.value[j]);
      const stationary = Math.hypot(...direction) < 1e-6;
      const reversed = previous.length === direction.length && direction.reduce((n, v, j) => n + v * previous[j], 0) < -1e-8;
      if (stationary || reversed) {
        flush(i - 1);
        begin = -1;
      }
      if (!stationary) {
        if (begin < 0) begin = i - 1;
        previous = direction;
      } else previous = [];
    }
    flush(samples.length - 1);
    return events;
  }
  function punchEvent(key, clip, cut, scaleOut, scaleIn) {
    if (!(scaleOut > 0) || !(scaleIn > 0) || !Number.isFinite(cut)) return null;
    const jump = scaleIn / scaleOut - 1;
    if (Math.abs(jump) < 0.04) return null;
    return {
      id: hash(`${key}|punch|${cut.toFixed(6)}`),
      clip,
      kind: "zoom",
      start: cut - 0.18,
      peak: cut,
      end: cut + 0.12,
      intensity: clamp(Math.abs(jump) / 0.25, 0.3, 1),
      detail: `Punch no corte · ${Math.round(scaleOut * 100)}% → ${Math.round(scaleIn * 100)}%`
    };
  }
  function selectEvents(events, options, frame) {
    const out = [];
    const light = options.density === "light";
    const kept = events.filter((e) => options[e.kind] && !(light && e.kind === "word" && /· palavra (?!1$)\d+$/.test(e.detail)));
    const ranked = kept.slice().sort((a, b) => b.intensity - a.intensity || a.peak - b.peak);
    const spacing = light ? 0.8 : options.density === "balanced" ? 0.25 : frame;
    for (const event of ranked) {
      const clash = out.some((other) => {
        const words2 = Number(event.kind === "word") + Number(other.kind === "word");
        if (words2 === 2) return other.clip !== event.clip && Math.abs(other.peak - event.peak) < frame * 0.75;
        if (words2 === 1) return Math.abs(other.peak - event.peak) < frame * 1.5;
        return Math.abs(other.peak - event.peak) < Math.max(frame * 0.75, spacing);
      });
      if (!clash) out.push(event);
    }
    return out.sort((a, b) => a.peak - b.peak);
  }
  const FAMILY_LABELS = {
    click: "Palavras",
    whoosh: "Whooshes",
    pop: "Entradas",
    impact: "Cortes",
    burn: "Film burn",
    shine: "Luz",
    shutter: "Flash",
    glitch: "Glitch"
  };
  function familyOf(kind) {
    return kind === "zoom" || kind === "move" ? "whoosh" : kind === "word" ? "click" : kind === "cut" ? "impact" : "pop";
  }
  const familyFor = (event) => event.family ?? familyOf(event.kind);
  const TASTES = {
    whoosh: {
      fits: /\b(whoosh\w*|woosh\w*|swoosh\w*|swish\w*|swipe|sweep|passagem|giro)\b/,
      home: /\b(wooshes|whooshes|woosh|whoosh|transitions?)\b/,
      never: /\b(explosion|explosao|gears|riser|rise|loop|ambien\w*|music|musica|trilha|coins?|bubble|camera|clock|glitch\w*)\b/,
      prefer: [
        [/\b(whoosh|woosh|swoosh|swish)\b/, 4],
        [/\b(pops?|fire|flare|fireball|metal\w*|cymbal)\b/, -2.5],
        [/\bpulsing\b/, -1],
        [/\b(digital|ui)\b/, -0.5]
      ],
      longest: 4
    },
    click: {
      fits: /\b(click|clique|mouse|select|button|botao|tap|tick|keyboard|teclado|tecla|enter|pop|bubble)\b/,
      home: /\b(cliques|computer|computador)\b/,
      never: /\b(loop|glitch\w*|hologram|beeps?|counter|data|notification|success|message|riser|rise|whoosh|camera|shutter|clock|coins?|cash|sci|desativar|censura|zing|shine|ticking)\b/,
      prefer: [
        [/\bclick\b/, 5],
        [/\b(mouse|select|button|tap)\b/, 2],
        [/\bpop\b/, 2],
        [/\bbubble\b/, 1],
        [/\b(keyboard|teclado|mechanical)\b/, -1.5],
        [/\benter\b/, -0.5]
      ],
      longest: 1.5
    },
    pop: {
      fits: /\b(pop|popup|bubble|click|select|button|interface|open|snap|swish)\b/,
      home: /\b(pops|bolhas)\b/,
      never: /\b(loop|riser|rise|whoosh|glitch\w*|hologram|beeps?|counter|data|notification|success|message|clock|coins?|cash|camera|sci|desativar|censura|keyboard|teclado)\b/,
      prefer: [[/\bpop\b/, 5], [/\bup\b/, 1], [/\bbubble\b/, 2], [/\b(click|select|button)\b/, 2], [/\b(interface|open)\b/, 1.5], [/\bsnap\b/, 1]],
      longest: 2.5
    },
    burn: {
      fits: /\b(burn|fire|flare|fireball|match|queima|fogo)\b/,
      home: /$^/,
      never: /\b(loop|riser|explosion|explosao|camera shutter|shutter)\b/,
      prefer: [[/\bfilm\b/, 3], [/\bburn\b/, 3], [/\b(fire|flare)\b/, 1]],
      longest: 5
    },
    shine: {
      fits: /\b(shine|shining|sparkle|magic|glow|brilho|bell|reverse shine)\b/,
      home: /\b(bells|brilhos)\b/,
      never: /\b(loop|riser|ding)\b/,
      prefer: [[/\b(shine|sparkle)\b/, 2], [/\breverse\b/, 1]],
      longest: 4
    },
    shutter: {
      fits: /\b(shutter|flash|camera|obturador|foto)\b/,
      home: /\b(cameras?|camera)\b/,
      never: /\b(loop|projector|film burn|burn|rec|setting)\b/,
      prefer: [[/\bshutter\b/, 3], [/\bflash\b/, 2], [/\bclick\b/, 1]],
      longest: 2
    },
    glitch: {
      fits: /\b(glitch\w*|falha|data|digital|rebobinar|rewind|static)\b/,
      home: /\bglitch\b/,
      never: /\b(loop|counter)\b/,
      prefer: [[/\bglitch\w*\b/, 3], [/\b(falha|rebobinar)\b/, 1]],
      longest: 3
    },
    impact: {
      fits: /\b(impact|hit|punch|boom|thud|slam|snap|slice|braam|drop)\b/,
      home: /\b(hits?|impacts?|impactos)\b/,
      never: /\b(loop|riser|rise|reverse|explosion|explosao|fireball|ambien\w*|music)\b/,
      prefer: [[/\b(impact|hit|punch)\b/, 4], [/\bboom\b/, 2], [/\bwhoosh\b/, -1]],
      longest: 6
    }
  };
  const words = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/([a-z])([0-9])/g, "$1 $2").replace(/[^a-z0-9]+/g, " ").trim();
  const FAMILY_CATEGORIES = {
    whoosh: ["whooshes", "cinematicos"],
    click: ["cliques", "pops"],
    pop: ["pops", "cliques"],
    impact: ["impactos", "cinematicos"],
    burn: ["camera", "fogo"],
    shine: ["brilhos"],
    shutter: ["camera"],
    glitch: ["glitch"]
  };
  function rankSounds(event, catalog2, durationOf) {
    const family = familyFor(event);
    const taste = TASTES[family];
    const span = Math.max(0, event.end - event.start);
    const choices = [];
    const wanted = /* @__PURE__ */ new Set([...FAMILY_CATEGORIES[family], "assinatura"]);
    const organized = catalog2.categories.some((c) => wanted.has(c.id));
    for (const category of catalog2.categories) for (const sound of category.sounds) {
      if (organized && !wanted.has(category.id)) continue;
      if (sound.loop) continue;
      const home = taste.home.test(` ${words(`${category.folder} ${category.label}`)} `);
      for (let i = 0; i < sound.variants.length; i++) {
        const variant = sound.variants[i];
        const name = ` ${words(`${sound.name} ${variant.file.replace(/\.[^.]+$/, "")}`)} `;
        if (taste.never.test(name) || !home && !taste.fits.test(name)) continue;
        const known2 = durationOf(variant);
        if (known2 !== null && (!(known2 > 0) || known2 > taste.longest)) continue;
        let score = 10 + (home ? 3 : 0);
        for (const [pattern, weight] of taste.prefer) if (pattern.test(name)) score += weight;
        const heavy = /\b(epic|heavy|big|cinematic|massive|trailer|deep|sub|low|boom|forte)\b/.test(name);
        const soft = /\b(soft|light|subtle|short|small|little|gentle|casual|standard|leve)\b/.test(name);
        const quick = /\b(fast|acute|quick|swish|swoosh|short)\b/.test(name);
        const long = /\b(long|deep|sub|low|epic|slow)\b/.test(name);
        score += heavy ? event.intensity * 4 - 2 : 0;
        score += soft ? (1 - event.intensity) * 3 : 0;
        if (family === "whoosh") {
          if (span < 0.45) score += (quick ? 2 : 0) - (long ? 1.5 : 0);
          if (span > 1) score += (long ? 2 : 0) - (quick ? 1 : 0);
        }
        if (known2 !== null) score -= family === "whoosh" ? Math.max(0, known2 - 2.5) : Math.max(0, known2 - 0.8);
        if (variant.ext === "wav") score += 0.5;
        choices.push({ id: variant.id, sound, variant, name: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, score });
      }
    }
    return choices.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt-BR", { numeric: true }) || a.id.localeCompare(b.id));
  }
  function choiceById(catalog2, variantId) {
    for (const category of catalog2.categories) for (const sound of category.sounds) {
      const i = sound.variants.findIndex((v) => v.id === variantId);
      if (i >= 0) return { id: variantId, sound, variant: sound.variants[i], name: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, score: 0 };
    }
    return null;
  }
  function varietyPick(family, choices, occurrence) {
    if (family !== "whoosh" && family !== "impact") return 0;
    const best = choices[0]?.score ?? 0;
    const close = choices.slice(0, 4).filter((c) => c.score >= best - 1.5).length;
    return close > 1 ? occurrence % close : 0;
  }
  const overlaps = (a, b) => a.start < b.end - 1e-7 && a.end > b.start + 1e-7;
  const clock$1 = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, "0").replace(".", ",")}`;
  function chokeToFit(items, lanes) {
    const available = lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => ({ index: l.index, fixed: [...l.spans], planned: [] }));
    const planned = [], dropped = [];
    const order = items.slice().sort((a, b) => Number(!!a.optional) - Number(!!b.optional) || a.start - b.start || a.peak - b.peak);
    for (const source of order) {
      const item = { ...source };
      if (![item.start, item.end, item.peak, item.minEnd].every(Number.isFinite) || item.start < 0 || item.end <= item.start) {
        throw new Error("Intervalo de SFX inválido.");
      }
      item.minEnd = Math.min(item.end, Math.max(item.minEnd, item.start + 1e-3));
      let chosen = null;
      for (const lane of available) {
        const fixed = lane.fixed.filter((s) => overlaps(s, item));
        const mine = lane.planned.filter((s) => overlaps(s, item));
        if (!fixed.length && !mine.length) {
          chosen = { lane, end: item.end, choke: [] };
          break;
        }
        if (chosen) continue;
        const before = mine.filter((s) => s.start < item.start - 1e-7);
        const after = [...fixed, ...mine].filter((s) => s.start > item.start + 1e-7);
        if (fixed.length + mine.length !== before.length + after.length) continue;
        if (before.some((s) => s.minEnd > item.start + 1e-7 || item.optional && !s.optional)) continue;
        const end = after.length ? Math.min(item.end, ...after.map((s) => s.start)) : item.end;
        if (end < item.minEnd - 1e-7) continue;
        chosen = { lane, end, choke: before };
      }
      if (!chosen) {
        if (item.optional) {
          dropped.push(source);
          continue;
        }
        throw new Error(`Falta uma faixa de áudio livre aos ${clock$1(item.start)}. Adicione uma faixa de áudio a partir da A3 e aplique novamente.`);
      }
      chosen.choke.forEach((s) => {
        s.end = item.start;
      });
      item.end = chosen.end;
      item.track = chosen.lane.index;
      chosen.lane.planned.push(item);
      planned.push(item);
    }
    return { planned: planned.sort((a, b) => a.start - b.start), dropped };
  }
  const MAX_NEW_TRACKS = 8;
  function withRoom(lanes, upTo) {
    const out = [...lanes];
    for (let index = lanes.length; index <= upTo; index++) out.push({ index, locked: false, spans: [] });
    return out;
  }
  function allocateTracks(items, lanes) {
    const available = lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => ({ ...l, spans: [...l.spans] }));
    const planned = [];
    for (const item of items.slice().sort((a, b) => a.start - b.start)) {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) throw new Error("Intervalo de SFX inválido.");
      const free = (l) => !l.spans.some((s) => overlaps(s, item));
      const hinted = available.find((l) => l.index === item.track);
      const lane = hinted && free(hinted) ? hinted : available.find(free);
      if (!lane) throw new Error("Falta uma faixa livre para os SFX. Adicione uma faixa de áudio a partir da A3 e aplique novamente.");
      lane.spans.push(item);
      planned.push({
        eventId: item.eventId,
        path: item.path,
        start: item.start,
        end: item.end,
        track: lane.index,
        inPoint: item.inPoint,
        outPoint: item.outPoint,
        gainDb: item.gainDb
      });
    }
    return planned;
  }
  function cutAround(filePeak, fileDuration, peak, pre, post, frame) {
    const lead = Math.max(0, Math.min(pre, filePeak));
    let start = Math.max(0, Math.floor((peak - lead + 1e-9) / frame) * frame);
    let inPoint = filePeak - (peak - start);
    if (inPoint < 0) {
      inPoint = 0;
      start = Math.max(0, Math.floor((peak - filePeak + 1e-9) / frame) * frame);
    }
    const outPoint = Math.min(fileDuration, Math.max(inPoint + frame, filePeak + post));
    return { start, inPoint, outPoint };
  }
  function groupByCut(items) {
    const groups = /* @__PURE__ */ new Map();
    for (const item of items) {
      const key = `${item.path}|${Math.round(item.inPoint * 1e3)}|${Math.round(item.outPoint * 1e3)}`;
      const list = groups.get(key) ?? [];
      list.push(item);
      groups.set(key, list);
    }
    return [...groups.values()];
  }
  const WHOOSH_MAX_SECONDS = 0.8;
  const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const plain = (s) => fold(s).replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
  function titleOf(name) {
    const match = /^(.+?) · (.+)$/.exec(name.trim());
    return match ? { template: match[1].trim(), text: match[2].trim() } : null;
  }
  function wordCount(text2) {
    return text2.split(/\s+/).filter((w2) => /[\p{L}\p{N}]/u.test(w2)).length;
  }
  const IDENTITIES = [
    ["filmburn", /\bfilm ?burn|\bburn\b|queima/],
    ["lightleak", /light ?leak|\bleak\b|vazamento/],
    // FilmImpact's Impact Blur is the editor's flash-cut: they voice it with a camera shutter.
    ["flash", /\bflash\b|strobe|\bshutter\b|obturador|impact blur|blur fx|exposure flash/],
    ["glitch", /glitch|rgb split|datamosh/],
    ["vhs", /\bvhs\b|rewind|rebobin/],
    ["transition", /transition|transicao|\bwhip\b|\bswipe\b|swoosh|whoosh|impact (push|slide|zoom|spin|roll|stretch|wipe)/],
    ["texture", /grain|\bdust\b|poeira|scratch|texture|textura|\bnoise\b|old film|film look/]
  ];
  function identityOf(...names) {
    const text2 = names.map(plain).join(" ");
    return IDENTITIES.find(([, pattern]) => pattern.test(text2))?.[0];
  }
  const IDENTITY_FAMILY = {
    filmburn: "burn",
    flash: "shutter",
    glitch: "glitch",
    vhs: "glitch",
    transition: "whoosh"
  };
  const IDENTITY_LABEL = {
    filmburn: "film burn",
    lightleak: "light leak",
    flash: "flash",
    glitch: "glitch",
    vhs: "VHS",
    transition: "transição",
    texture: "textura"
  };
  const bucket = (seconds2) => (Math.round(seconds2 * 10) / 10).toFixed(1);
  const underTitle = (e, all, frame) => all.some((t) => t.role === "title" && Math.abs(t.start - e.start) < frame) && all.some((t) => t.role === "title" && Math.abs(t.end - e.end) < frame);
  function anchorsOf(elements, motion, frame, covers = []) {
    const out = [];
    for (const e of elements) {
      const base = { key: e.key, clip: e.clip, role: e.role, time: e.start, start: e.start, end: e.end, from: e.start - 0.3, to: e.start + 0.3 };
      if (e.role === "title") {
        const words2 = wordCount(e.text ?? "");
        out.push({
          ...base,
          kind: "word",
          sigs: [`title:${plain(e.template ?? "")}`],
          from: e.start - 0.1,
          to: e.end - 0.01,
          words: words2,
          template: e.template,
          text: e.text,
          family: "click",
          intensity: 0.3,
          detail: `“${(e.text ?? "").slice(0, 48)}” · ${words2} palavra${words2 === 1 ? "" : "s"}`
        });
      } else if (e.role === "graphic") {
        out.push({
          ...base,
          kind: "graphic",
          sigs: [`graphic:${plain(e.clip).replace(/\d+/g, "").trim()}`],
          family: e.end - e.start < 1.2 ? "whoosh" : "pop",
          intensity: 0.3,
          detail: "Gráfico entra na tela"
        });
      } else if (e.role === "overlay") {
        out.push({
          ...base,
          kind: "overlay",
          sigs: [`media:${plain(e.media || e.clip)}`],
          family: e.identity ? IDENTITY_FAMILY[e.identity] : void 0,
          intensity: 0.5,
          detail: `Overlay de ${e.identity ? IDENTITY_LABEL[e.identity] : "vídeo"} entra`
        });
      } else if (e.role === "adjustment") {
        const fx = e.effects.slice().sort().join("+") || "sem-efeito";
        const shape = underTitle(e, elements, frame) ? "titulo" : bucket(e.end - e.start);
        out.push({
          ...base,
          kind: "overlay",
          sigs: [`adjust:${fx}|${shape}`],
          family: e.identity ? IDENTITY_FAMILY[e.identity] : void 0,
          intensity: 0.45,
          detail: `Adjustment Layer (${bucket(e.end - e.start).replace(".", ",")} s) entra`
        });
      }
    }
    for (const m of motion) {
      const owner = elements.find((e) => e.clip === m.clip && m.peak >= e.start - 1e-6 && m.peak <= e.end + 1e-6);
      if (owner && owner.role !== "footage" && owner.role !== "adjustment") continue;
      const role = owner?.role ?? "footage";
      const shape = m.detail.startsWith("Punch") ? "punch" : m.kind;
      if ((m.kind === "zoom" || m.kind === "move") && shape !== "punch" && m.end - m.start > WHOOSH_MAX_SECONDS) continue;
      const track = owner?.track ?? 0;
      const hidden = (t) => covers.some((c) => c.opaque && c.track > track && c.start <= t && c.end > t);
      if (hidden(shape === "punch" ? m.peak + 0.03 : m.peak)) continue;
      out.push({
        key: m.id,
        clip: m.clip,
        role: "motion",
        kind: m.kind,
        sigs: [`motion:${shape}:${role}`, `motion:${shape}`],
        time: m.peak,
        start: m.start,
        end: m.end,
        from: m.peak - 0.3,
        to: m.peak + 0.2,
        intensity: m.intensity,
        detail: m.detail
      });
    }
    return group(out);
  }
  function group(anchors) {
    const out = [];
    for (const a of anchors.slice().sort((x, y) => x.time - y.time)) {
      const twin = out.find((b) => b.sigs[0] === a.sigs[0] && a.role !== "title" && Math.abs(b.time - a.time) < 0.6);
      if (twin) {
        twin.end = Math.max(twin.end, a.end);
        twin.to = Math.max(twin.to, a.to);
        continue;
      }
      out.push({ ...a });
    }
    return out;
  }
  function soundedAlready(anchors, clips) {
    return new Set(anchors.filter((a) => clips.some((c) => c.start >= a.from - 1e-6 && c.start <= a.to + 1e-6)).map((a) => a.key));
  }
  const snapTo = (n, frame) => Math.round(n / frame) * frame;
  const WHY = {
    title: "Título do Framelab: um clique por palavra, no ritmo da animação",
    graphic: "Gráfico entra na tela",
    overlay: "O som do que o overlay é",
    adjustment: "O som do efeito da Adjustment Layer",
    motion: "Movimento de câmera"
  };
  const templateKey = (template) => plain(template);
  const bb = (family, look) => ({ mode: "none", family, first: 0.03, look: `legenda em bloco, ${look}` });
  const TITLE_PRESETS = {
    "clean blue": { mode: "words", family: "click", first: 0.13, step: 0.09, look: "palavra por palavra" },
    "apple style animation": { mode: "words", family: "click", first: 0.13, step: 0.09, look: "palavra por palavra" },
    "orange text": { mode: "words", family: "click", first: 0.17, perLetter: 0.05, look: "néon escrito letra a letra" },
    "rebote": { mode: "words", family: "pop", first: 0.17, perLetter: 0.05, look: "letras quicando" },
    "rebound": { mode: "words", family: "pop", first: 0.17, perLetter: 0.05, look: "letras quicando" },
    "vhs": { mode: "entry", family: "glitch", first: 0.03, look: "letras em glitch" },
    "error text": { mode: "entry", family: "glitch", first: 0.1, look: "glitch" },
    "gold text": { mode: "entry", family: "shine", first: 0.03, look: "ouro líquido" },
    "texto de oro": { mode: "entry", family: "shine", first: 0.03, look: "ouro líquido" },
    "clean style": { mode: "entry", family: "whoosh", first: 0, look: "desliza" },
    "old money": { mode: "entry", family: "whoosh", first: 0.03, look: "desliza com brilho" },
    "3d text": { mode: "entry", family: "whoosh", first: 0, look: "gira em 3D" },
    "aesthetic strinking": { mode: "entry", family: "whoosh", first: 0.1, look: "entra com rastro" },
    "smooth up": { mode: "entry", family: "whoosh", first: 0.07, look: "sobe com desfoque" },
    "triple elegant text": { mode: "entry", family: "whoosh", first: 0.03, look: "três linhas crescem" },
    "rainbow text": { mode: "entry", family: "shine", first: 0.03, look: "arco-íris crescendo" },
    "smooth bounce": { mode: "entry", family: "pop", first: 0.03, look: "quica" },
    "water text": { mode: "entry", family: "pop", first: 0.03, look: "caixa d’água" },
    "smooth opacity": { mode: "none", family: "whoosh", first: 0, look: "fade" },
    "escrito a mano posterizacion": { mode: "none", family: "pop", first: 0, look: "sem entrada, só tremula" },
    "bb blur in": bb("whoosh", "desfoque"),
    "bb bounce": bb("pop", "quica"),
    "bb drop": bb("pop", "cai"),
    "bb fade down": bb("whoosh", "fade"),
    "bb fade left": bb("whoosh", "fade"),
    "bb fade right": bb("whoosh", "fade"),
    "bb fade up": bb("whoosh", "fade"),
    "bb flip 3d": bb("whoosh", "vira em 3D"),
    "bb float": bb("whoosh", "flutua"),
    "bb pop": bb("pop", "pop"),
    "bb slide": bb("whoosh", "desliza"),
    "bb snap": bb("pop", "estala"),
    "bb spin": bb("whoosh", "gira"),
    "bb tilt": bb("whoosh", "inclina"),
    "bb zoom out": bb("whoosh", "zoom")
  };
  const UNKNOWN_PRESET = { mode: "words", family: "click", first: 0.13, look: "modelo novo" };
  const presetFor = (template) => TITLE_PRESETS[templateKey(template)] ?? UNKNOWN_PRESET;
  function wordTimes(text2, start, end, preset, frame) {
    const words2 = text2.split(/\s+/).filter((w2) => /[\p{L}\p{N}]/u.test(w2)).slice(0, 40);
    if (!words2.length) return [];
    const offsets = [];
    if (preset.perLetter) {
      let chars = 0;
      for (const w2 of words2) {
        offsets.push(chars * preset.perLetter);
        chars += w2.length + 1;
      }
    } else {
      const step2 = preset.step ?? frame;
      words2.forEach((_, i) => offsets.push(i * step2));
    }
    const room = Math.max(frame, end - frame - start - preset.first);
    const last = offsets[offsets.length - 1];
    const squeeze = last > room ? room / last : 1;
    return offsets.map((o) => start + preset.first + o * squeeze);
  }
  function eventsFrom(anchors, frame, done = /* @__PURE__ */ new Set(), titleMode = (t) => presetFor(t).mode) {
    const out = [];
    for (const a of anchors) {
      if (done.has(a.key)) continue;
      if (a.role === "title") {
        const preset = presetFor(a.template ?? "");
        const mode = titleMode(a.template ?? "");
        if (mode === "none") continue;
        const why2 = `${a.template}: ${preset.look}`;
        if (mode === "entry") {
          const peak = Math.max(0, snapTo(a.start + preset.first, frame));
          const family2 = preset.mode === "entry" ? preset.family : "whoosh";
          out.push({
            id: hash(`${a.key}|entry|0`),
            clip: a.clip,
            kind: "graphic",
            start: peak - 0.05,
            peak,
            end: peak + 0.3,
            intensity: 0.35,
            detail: a.detail.replace(/ · \d+ palavras?$/, ""),
            family: family2,
            why: `${why2} · um som na entrada`
          });
          continue;
        }
        const family = preset.mode === "words" ? preset.family : "click";
        wordTimes(a.text ?? "", a.start, a.end, preset, frame).forEach((at2, i, all) => {
          const peak = Math.max(0, snapTo(at2, frame));
          out.push({
            id: hash(`${a.key}|${a.kind}|${i}`),
            clip: a.clip,
            kind: "word",
            start: peak - 0.05,
            peak,
            end: peak + 0.15,
            intensity: a.intensity,
            detail: `${a.detail} · palavra ${i + 1}`,
            family,
            why: `${why2} · ${all.length} palavra${all.length === 1 ? "" : "s"}, ${all.length} ${all.length === 1 ? "som" : "sons"}`
          });
        });
        continue;
      }
      if (!a.family && a.role !== "motion") continue;
      const why = WHY[a.role] ?? "";
      const push = (at2, index, detail) => {
        const peak = Math.max(0, snapTo(at2, frame));
        const [before, after] = a.role === "motion" ? [a.time - a.start, a.end - a.time] : [0.05, 0.15];
        out.push({
          id: hash(`${a.key}|${a.kind}|${index}`),
          clip: a.clip,
          kind: a.kind,
          start: peak - before,
          peak,
          end: peak + after,
          intensity: a.intensity,
          detail,
          family: a.family,
          why
        });
      };
      push(a.time, 0, a.detail);
    }
    return out;
  }
  const OWN_SFX = /[\\/]Framelab Auto SFX[\\/]FLAuto-/;
  async function activeTimeline() {
    const ppro = getPremiere();
    if (!ppro) throw new Error("Abra esta ferramenta dentro do Premiere.");
    const project2 = await ppro.Project.getActiveProject();
    const sequence2 = project2 ? await project2.getActiveSequence() : null;
    if (!project2 || !sequence2) throw new Error("Abra uma sequência no Premiere.");
    const id = `${project2.guid.toString()}:${sequence2.guid.toString()}`;
    if (!id || id.includes("[object Object]")) throw new Error("Não consegui identificar a sequência. Reabra o painel.");
    return { ppro, project: project2, sequence: sequence2, id };
  }
  function within(call, ms = 1500) {
    return new Promise((resolve2) => {
      const timer = setTimeout(() => resolve2(null), ms);
      let pending;
      try {
        pending = Promise.resolve(call());
      } catch {
        clearTimeout(timer);
        resolve2(null);
        return;
      }
      pending.then((value) => {
        clearTimeout(timer);
        resolve2(value ?? null);
      }, () => {
        clearTimeout(timer);
        resolve2(null);
      });
    });
  }
  const silent = /* @__PURE__ */ new Set();
  async function mediaOf(ppro, item, key) {
    if (key && silent.has(key)) return null;
    const raw = await within(() => item.getProjectItem());
    if (!raw) {
      if (key) silent.add(key);
      return null;
    }
    try {
      const clip = ppro.ClipProjectItem.cast(raw);
      const [path, nested] = await Promise.all([clip.getMediaFilePath().catch(() => ""), clip.isSequence().catch(() => false)]);
      let id = "";
      try {
        id = String(raw.getId?.() ?? "");
      } catch {
      }
      return { path: path ?? "", nested: nested === true, id: id || path || "", clip };
    } catch {
      return null;
    }
  }
  async function readAudio(ppro, sequence2) {
    const audio = [], lanes = [];
    const count = await sequence2.getAudioTrackCount();
    for (let index = 0; index < count; index++) {
      const track = await sequence2.getAudioTrack(index);
      const lock = track.isLocked;
      const locked = typeof lock === "function" ? await lock.call(track) : false;
      const muted = await track.isMuted();
      const spans = [];
      for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        const [start, end, point, media, name] = await Promise.all([
          item.getStartTime(),
          item.getEndTime(),
          item.getInPoint(),
          mediaOf(ppro, item),
          item.getName().catch(() => "")
        ]);
        if (!Number.isFinite(start.seconds) || !Number.isFinite(end.seconds)) throw new Error(`Não consegui ler a faixa A${index + 1}.`);
        audio.push({ path: media?.path ?? "", start: start.seconds, end: end.seconds, inPoint: point.seconds, track: index, name });
        spans.push({ start: start.seconds, end: end.seconds });
      }
      lanes.push({ index, locked: locked || muted, spans });
    }
    return { audio, lanes };
  }
  function paramKind(name) {
    const n = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    if (/^(scale|escala|echelle|skalierung|scala)( \(zoom\))?$/.test(n) || /^(scale height|altura da escala|hauteur d'echelle|altura de escala)$/.test(n)) return "zoom";
    if (/^(position|posicao|posicion)$/.test(n)) return "move";
    if (/^(rotation|rotacao|rotacion)$/.test(n)) return "rotate";
    if (/^(opacity|opacidade|opacite|opacidad)$/.test(n)) return "opacity";
    if (/^(source text|texto de origem|texto de origen|text|texto)$/.test(n)) return "text";
    return null;
  }
  function vector(raw) {
    const value = unwrapValue(raw);
    if (typeof value === "number" && Number.isFinite(value)) return [value];
    if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n))) return value;
    if (value && typeof value === "object") {
      const p = value;
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) return [p.x, p.y];
    }
    return null;
  }
  const NOT_TEXT = /\b(matte|fosco|cor solida|color|colour|black video|video preto|bars|barras|adjust\w*|ajuste|transparent\w*|transparente)\b/i;
  const TEXTUAL = /\btext\b|capsule|graphic|\bmgt\b/i;
  async function scanTimeline(scope, progress = () => {
  }, cancelled = () => false, only) {
    const { ppro, sequence: sequence2, id } = await activeTimeline();
    const scan = await readSequence(ppro, sequence2, id, scope, progress, cancelled, only);
    if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou durante a análise. Analise novamente.");
    return scan;
  }
  async function readSequence(ppro, sequence2, id, scope, progress, cancelled, only) {
    const ticksPerFrame = await readTicksPerFrame(sequence2);
    if (!ticksPerFrame) throw new Error("Não consegui ler a taxa de quadros da sequência.");
    const frame = Number(ticksPerFrame) / 254016e6;
    const rect = await sequence2.getFrameSize();
    const width = rect.width, height = rect.height;
    const notes = /* @__PURE__ */ new Set();
    const events = [];
    const elements = [];
    const covers = [];
    const videoMedia = /* @__PURE__ */ new Set();
    const fingerprints = [];
    const keys = [];
    let clips = 0;
    const snap2 = (n) => Math.round(n / frame) * frame;
    const check = () => {
      if (cancelled()) throw new Error("Análise cancelada.");
    };
    const isChosen = (key, selected) => only ? only.has(key) : scope === "sequence" || selected;
    const trackCount = await sequence2.getVideoTrackCount();
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      check();
      const track = await sequence2.getVideoTrack(trackIndex);
      const muted = await track.isMuted();
      fingerprints.push([trackIndex, muted]);
      if (muted) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      const lane = { clips: [] };
      for (const clip of items) {
        check();
        const [selected, disabled, start, end, inPoint, outPoint, speed, reversed, name] = await Promise.all([
          clip.getIsSelected(),
          clip.isDisabled(),
          clip.getStartTime(),
          clip.getEndTime(),
          clip.getInPoint(),
          clip.getOutPoint(),
          clip.getSpeed(),
          clip.isSpeedReversed(),
          clip.getName()
        ]);
        const clipKey = `${id}|${trackIndex}|${name}|${start.ticks}|${inPoint.ticks}`;
        const chosen = isChosen(clipKey, selected);
        const preceding = lane.clips[lane.clips.length - 1] ?? null;
        if (!disabled && !chosen && trackIndex > 0) {
          const light = !!titleOf(name) || /^(graphic|gr[aá]fico|adjustment layer|camada de ajuste)\b/i.test(name.trim()) || !!identityOf(name);
          covers.push({ track: trackIndex, start: start.seconds, end: end.seconds, opaque: !light });
        }
        if (disabled || !chosen) {
          lane.clips.push(disabled ? null : { end: end.seconds, scaleOut: 1, chosen: false, media: "" });
          continue;
        }
        clips++;
        keys.push(clipKey);
        progress(`Lendo V${trackIndex + 1} · ${name} (${clips})…`);
        const signature2 = [clipKey, end.ticks, outPoint.ticks, speed, reversed];
        fingerprints.push(signature2);
        if (![start.seconds, end.seconds, inPoint.seconds, outPoint.seconds, speed].every(Number.isFinite)) throw new Error(`Tempo ilegível: ${name}.`);
        if (speed !== 1 || reversed) {
          notes.add("Clipes com velocidade alterada ou reprodução reversa foram ignorados.");
          lane.clips.push(null);
          continue;
        }
        const toSequence = (time) => start.seconds + time.seconds - inPoint.seconds;
        const onGrid = (list) => list.map((e) => ({ ...e, start: snap2(e.start), peak: snap2(e.peak), end: snap2(e.end) }));
        const pointEvent = (kind, time, detail, intensity) => {
          const peak = snap2(time);
          events.push({
            id: hash(`${clipKey}|${kind}|${peak.toFixed(6)}`),
            clip: name,
            kind,
            start: peak,
            end: peak + 0.15,
            peak,
            intensity,
            detail
          });
        };
        let graphic = false;
        const adjustment = await clip.isAdjustmentLayer().catch(() => false) || /^(adjustment layer|camada de ajuste)\b/i.test(name.trim());
        const media = adjustment ? null : await mediaOf(ppro, clip, clipKey);
        if (!adjustment) {
          signature2.push(media?.path ?? null);
          if (!media) graphic = trackIndex > 0 && !NOT_TEXT.test(name);
          else {
            if (media.nested) notes.add("Sequências aninhadas: somente os efeitos externos são lidos.");
            graphic = /\.(mogrt|aegraphic)$/i.test(media.path) || !media.path && !media.nested && trackIndex > 0 && !NOT_TEXT.test(name);
          }
          const match = await clip.getMatchName().catch(() => "");
          if (TEXTUAL.test(match)) graphic = true;
        }
        if (media?.path) videoMedia.add(media.path);
        let scaleIn = 1, scaleOut = 1;
        const effects = [], effectNames = [];
        const chain = await clip.getComponentChain();
        const count = await chain.getComponentCount();
        for (let ci = 0; ci < count; ci++) {
          check();
          const component = await chain.getComponentAtIndex(ci);
          if (!component) continue;
          const match = await component.getMatchName().catch(() => "");
          if (match && !/^(ae\.)?adbe (motion|opacity)$/i.test(match.trim())) {
            effects.push(match);
            const named = component.getDisplayName;
            effectNames.push(typeof named === "function" ? await named.call(component).catch(() => "") : "");
          }
          const nativeMotion = /motion|geometry2|opacity/i.test(match);
          if (TEXTUAL.test(match)) graphic = !adjustment;
          const paramCount = await component.getParamCount();
          for (let pi = 0; pi < paramCount; pi++) {
            check();
            const param = await component.getParam(pi);
            const kind = paramKind(param.displayName);
            if (!kind || !nativeMotion && kind !== "text") continue;
            if (kind === "text" && (trackIndex > 0 || TEXTUAL.test(match))) graphic = !adjustment;
            let times;
            try {
              times = await Promise.resolve(param.getKeyframeListAsTickTimes());
            } catch {
              notes.add(`Parâmetro sem leitura de keyframes: ${name} · ${param.displayName}.`);
              continue;
            }
            if (kind === "zoom" && times.length < 2) {
              const value = vector(await param.getValueAtTime(inPoint).catch(() => null));
              if (value?.length === 1 && value[0] > 0) {
                scaleIn *= value[0] / 100;
                scaleOut *= value[0] / 100;
                signature2.push([ci, pi, value[0]]);
              }
              continue;
            }
            if (times.length < (kind === "text" ? 1 : 2)) continue;
            if (times.length > 1500) {
              notes.add(`Animação muito densa ignorada: ${name} · ${param.displayName}.`);
              continue;
            }
            const points = /* @__PURE__ */ new Map();
            points.set(inPoint.ticks, inPoint);
            for (const time of times) if (time.seconds >= inPoint.seconds && time.seconds < outPoint.seconds) points.set(time.ticks, time);
            const last = ppro.TickTime.createWithSeconds(Math.max(inPoint.seconds, outPoint.seconds - frame));
            points.set(last.ticks, last);
            let ordered2 = [...points.values()].sort((a, b) => a.seconds - b.seconds);
            if (kind !== "text" && ordered2.length <= 24) {
              const dense = [];
              for (let i = 0; i < ordered2.length; i++) {
                dense.push(ordered2[i]);
                const next = ordered2[i + 1];
                if (!next) continue;
                const steps = Math.min(6, Math.floor((next.seconds - ordered2[i].seconds) / frame) - 1);
                for (let s = 1; s <= steps; s++) dense.push(ppro.TickTime.createWithSeconds(ordered2[i].seconds + (next.seconds - ordered2[i].seconds) * s / (steps + 1)));
              }
              ordered2 = dense;
            }
            const samples = [];
            let textValue = null;
            const values = [];
            let unreadable = false;
            for (const time of ordered2) {
              check();
              let raw;
              try {
                raw = unwrapValue(await param.getValueAtTime(time));
              } catch {
                unreadable = true;
                break;
              }
              const at2 = toSequence(time);
              values.push([time.ticks, raw]);
              if (kind === "text") {
                if (typeof raw === "string" && raw.trim() && !/^\s*[\[{]/.test(raw)) {
                  if (textValue !== null && textValue !== raw) pointEvent("text", at2, `Texto: ${raw.slice(0, 80)}`, 0.25);
                  textValue = raw;
                }
                continue;
              }
              const value = vector(raw);
              if (!value || (kind === "move" ? value.length !== 2 : value.length !== 1)) {
                unreadable = true;
                break;
              }
              samples.push({ time: at2, value });
            }
            signature2.push([ci, match, pi, values, unreadable]);
            if (unreadable) {
              notes.add(`Animação ilegível ignorada: ${name} · ${param.displayName}.`);
              continue;
            }
            if (kind === "text" || !samples.length) continue;
            if (kind === "zoom") {
              if (samples[0].value[0] > 0) scaleIn *= samples[0].value[0] / 100;
              if (samples[samples.length - 1].value[0] > 0) scaleOut *= samples[samples.length - 1].value[0] / 100;
            }
            if (kind === "opacity") {
              const max = Math.max(...samples.map((s) => s.value[0]));
              if (max > 1.01) samples.forEach((s) => {
                s.value[0] /= 100;
              });
            }
            if (kind === "move") {
              const max = Math.max(...samples.flatMap((s) => s.value.map(Math.abs)));
              if (max > 4 && width > 0 && height > 0) samples.forEach((s) => {
                s.value = [s.value[0] / width, s.value[1] / height];
              });
            }
            if (kind === "rotate") {
              samples.forEach((s) => {
                s.value = [s.value[0] / 360];
              });
              events.push(...onGrid(detectMotion("move", samples, name, `${clipKey}|${ci}|${pi}`, "Giro")));
              continue;
            }
            events.push(...onGrid(detectMotion(kind, samples, name, `${clipKey}|${ci}|${pi}`)));
          }
        }
        const touching = preceding && Math.abs(preceding.end - start.seconds) < frame / 2;
        if (touching && preceding.chosen) {
          const sameShot = !!media?.path && preceding.media === media.path;
          const punch = sameShot ? punchEvent(clipKey, name, snap2(start.seconds), preceding.scaleOut, scaleIn) : null;
          if (punch) events.push(punch);
          else pointEvent("cut", start.seconds, "Encontro entre clipes na mesma faixa", 0.45);
        }
        const file = (media?.path ?? "").split(/[\\/]/).pop() ?? "";
        const title = titleOf(name);
        const drawn = effects.some((fx) => /graphic group|\btext\b|\bshape\b|capsule/i.test(fx));
        const effect = adjustment && !drawn;
        const identity = effect ? identityOf(...effects, ...effectNames, name) : identityOf(name, file);
        const role = title && (graphic || drawn || !media?.path) ? "title" : effect ? "adjustment" : trackIndex > 0 && identity ? "overlay" : graphic || drawn ? "graphic" : "footage";
        elements.push({
          key: clipKey,
          clip: name,
          track: trackIndex,
          start: snap2(start.seconds),
          end: snap2(end.seconds),
          role,
          media: file,
          template: title?.template,
          text: title?.text,
          identity,
          effects
        });
        if (trackIndex > 0) covers.push({ track: trackIndex, start: start.seconds, end: end.seconds, opaque: role === "footage" });
        lane.clips.push({ end: end.seconds, scaleOut, chosen: true, media: media?.path ?? "" });
      }
    }
    check();
    const audio = await readAudio(ppro, sequence2);
    const sfx = audio.audio.filter((a) => a.path && !OWN_SFX.test(a.path) && !videoMedia.has(a.path) && a.end - a.start <= 8 && a.end > a.start).map((a) => ({
      path: a.path,
      name: a.name || a.path.split(/[\\/]/).pop() || "SFX",
      start: a.start,
      inPoint: a.inPoint,
      duration: a.end - a.start,
      track: a.track
    }));
    return {
      scope,
      sequenceId: id,
      sequenceName: sequence2.name,
      frame,
      clips,
      keys,
      elements,
      motion: events,
      sfx,
      covers,
      fingerprint: hash(JSON.stringify([id, frame, width, height, fingerprints])),
      notes: [...notes],
      ...audio
    };
  }
  function alreadyPlaced(eventId, audio) {
    return audio.some((a) => a.path.replace(/\\/g, "/").split("/").pop()?.startsWith(`FLAuto-${eventId}-`));
  }
  const fourcc = (view, at2) => String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at2 + i)));
  function decodeWav(buffer, maxSeconds = 12) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 44 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") throw new Error("Áudio precisa ser convertido para WAV.");
    let format = 0, channels = 0, rate = 0, bits = 0, align = 0, offset = 0, length = 0;
    for (let at2 = 12; at2 + 8 <= buffer.byteLength; ) {
      const tag = fourcc(view, at2), size = view.getUint32(at2 + 4, true), data = at2 + 8;
      if (data + size > buffer.byteLength) throw new Error("Arquivo WAV incompleto.");
      if (tag === "fmt " && size >= 16) {
        format = view.getUint16(data, true);
        channels = view.getUint16(data + 2, true);
        rate = view.getUint32(data + 4, true);
        align = view.getUint16(data + 12, true);
        bits = view.getUint16(data + 14, true);
        if (format === 65534 && size >= 40) format = view.getUint16(data + 24, true);
      }
      if (tag === "data") {
        offset = data;
        length = size;
      }
      at2 = data + size + size % 2;
    }
    if (![1, 3].includes(format) || ![8, 16, 24, 32].includes(bits) || format === 3 && bits !== 32 || channels < 1 || channels > 2 || rate < 8e3 || rate > 192e3 || align !== channels * bits / 8 || !offset || length % align !== 0) {
      throw new Error("Formato WAV precisa de conversão.");
    }
    const count = length / (bits / 8);
    if (count / channels / rate > maxSeconds) throw new Error(`O som tem mais de ${maxSeconds} segundos. Escolha um efeito curto.`);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const at2 = offset + i * bits / 8;
      let value;
      if (format === 3) value = view.getFloat32(at2, true);
      else if (bits === 8) value = (view.getUint8(at2) - 128) / 128;
      else if (bits === 16) value = view.getInt16(at2, true) / 32768;
      else if (bits === 24) {
        let n = view.getUint8(at2) | view.getUint8(at2 + 1) << 8 | view.getUint8(at2 + 2) << 16;
        if (n & 8388608) n -= 16777216;
        value = n / 8388608;
      } else value = view.getInt32(at2, true) / 2147483648;
      if (!Number.isFinite(value)) throw new Error("O WAV contém amostras inválidas.");
      samples[i] = Math.min(1, Math.max(-1, value));
    }
    return { rate, channels, samples };
  }
  function measure(pcm) {
    let maximum = 0, index = 0;
    for (let i = 0; i < pcm.samples.length; i++) {
      const a = Math.abs(pcm.samples[i]);
      if (a > maximum) {
        maximum = a;
        index = i;
      }
    }
    return { duration: pcm.samples.length / pcm.channels / pcm.rate, peakSeconds: Math.floor(index / pcm.channels) / pcm.rate, amplitude: maximum };
  }
  async function soundLibrary(refresh = false, progress = () => {
  }) {
    const config = await sfxSettings.read();
    await loadManifest();
    const held = await readDestination(
      "soundDesign",
      destinationOf(config.folder, config.folderToken)
    ).catch(() => null);
    setFolder(held?.path ? held : null);
    let snapshot2 = refresh ? null : await readSnapshot(config.pack);
    if (!snapshot2) {
      snapshot2 = {
        rootId: config.pack,
        fetchedAt: Date.now(),
        files: await crawlPack(config.pack, (folders, files) => progress(`Lendo o pack de SFX no Drive (só na primeira vez) · ${folders} pastas · ${files} sons…`))
      };
      await writeSnapshot(snapshot2);
    }
    const catalog2 = buildCatalog(snapshot2.files);
    for (const category of catalog2.categories) for (const sound of category.sounds) {
      sound.variants = sound.variants.filter((v) => localState(v) !== "empty");
    }
    return catalog2;
  }
  function conversionScript(input, output, result, ffmpeg, windows, limit = 12) {
    if (windows) {
      const q2 = (s) => `"${batValue(s)}"`;
      return [
        "@echo off",
        "setlocal DisableDelayedExpansion",
        `set "FL_FFMPEG=${batValue(ffmpeg)}"`,
        'if "%FL_FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FL_FFMPEG=%%~$PATH:i"',
        `if "%FL_FFMPEG%"=="" (echo missing>${q2(result)} & exit /b 1)`,
        `"%FL_FFMPEG%" -nostdin -v error -y -i ${q2(input)} -t ${limit} -vn -ac 2 -ar 48000 -c:a pcm_s16le ${q2(output)}`,
        `if errorlevel 1 (echo failed>${q2(result)}) else (echo ok>${q2(result)})`,
        "exit /b 0",
        ""
      ].join("\r\n");
    }
    return [
      "#!/bin/bash",
      "set -u",
      `FL_FFMPEG=${shellQuote(ffmpeg)}`,
      'if [ -z "$FL_FFMPEG" ]; then',
      '  for candidate in "$HOME/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg; do',
      '    if [ -x "$candidate" ]; then FL_FFMPEG="$candidate"; break; fi',
      "  done",
      "fi",
      'if [ -z "$FL_FFMPEG" ]; then FL_FFMPEG="$(command -v ffmpeg || true)"; fi',
      `if [ -z "$FL_FFMPEG" ]; then printf missing > ${shellQuote(result)}; exit 1; fi`,
      `if "$FL_FFMPEG" -nostdin -v error -y -i ${shellQuote(input)} -t ${limit} -vn -ac 2 -ar 48000 -c:a pcm_s16le ${shellQuote(output)}; then`,
      `  printf ok > ${shellQuote(result)}`,
      "else",
      `  printf failed > ${shellQuote(result)}`,
      "fi",
      ""
    ].join("\n");
  }
  async function convert(bytes, ext, cancelled, limit = 12) {
    const space = await workspace(), tag = `auto-sfx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const input = `${tag}.${ext}`, output = `${tag}.wav`, result = `${tag}.txt`;
    const source = `input-${input}`;
    const script = `${tag}.${isWindows() ? "bat" : "command"}`;
    const fs = fsModule();
    if (!fs) throw new Error("Não consegui acessar os arquivos de áudio.");
    await fs.writeFile(join(space.fsBase, source), new Uint8Array(bytes));
    await write(space, script, conversionScript(nativePath(space, source), nativePath(space, output), nativePath(space, result), (await readConfig$2()).ffmpegPath, isWindows(), limit), true);
    if (cancelled()) throw new Error("Preparação cancelada.");
    const sent = await dispatch(script);
    if (sent.mode === "denied") throw new Error(`Autorize o assistente do Framelab para converter este som: ${sent.error ?? "execução recusada"}.`);
    const deadline = Date.now() + 18e4;
    try {
      while (Date.now() < deadline) {
        if (cancelled()) throw new Error("Preparação cancelada.");
        const status = readText$1(space, result)?.trim();
        if (status === "missing") throw new Error("FFmpeg não encontrado. Configure o caminho em Corte de Silêncios ou escolha um SFX WAV.");
        if (status === "failed") throw new Error("O assistente não conseguiu converter este som. Escolha outra variação.");
        if (status === "ok") {
          const data = fsModule()?.readFileSync(join(space.fsBase, output));
          if (!data || typeof data === "string") throw new Error("O WAV convertido não foi encontrado.");
          return decodeWav(data, limit);
        }
        await wait$1(300);
      }
      throw new Error("A conversão não respondeu em 3 minutos. Confira o assistente do Framelab.");
    } finally {
      await withdraw(sent.ticket);
    }
  }
  async function load(choice, catalog2, cancelled) {
    const category = catalog2.categories.find((c) => c.id === choice.sound.category);
    if (!category) throw new Error("O catálogo de sons mudou. Analise novamente.");
    const variant = choice.variant;
    const index = choice.sound.variants.findIndex((v) => v.id === variant.id);
    const copy = await copyToDisk(variant, fileNameFor(category, choice.sound, index));
    if (copy.kind === "empty") {
      markEmpty(variant);
      return null;
    }
    const bytes = copy.data ?? await copiedBytes(variant);
    if (!bytes) throw new Error(`Não consegui ler ${choice.name}.`);
    const path = copiedFile(variant);
    if (!path) throw new Error(`${choice.name} não ficou na pasta dos SFX.`);
    let pcm;
    try {
      pcm = decodeWav(bytes);
    } catch {
      pcm = await convert(bytes, variant.ext, cancelled);
    }
    const measured = measure(pcm);
    if (measured.amplitude < 1e-5) return null;
    rememberSeconds(variant, measured.duration);
    return { path, pcm, peak: measured.peakSeconds, duration: measured.duration };
  }
  function peakDbIn(pcm, from, to) {
    const a = Math.max(0, Math.floor(from * pcm.rate)) * pcm.channels;
    const b = Math.min(pcm.samples.length, Math.ceil(to * pcm.rate) * pcm.channels);
    let max = 0;
    for (let i = a; i < b; i++) max = Math.max(max, Math.abs(pcm.samples[i]));
    return 20 * Math.log10(Math.max(1e-5, max));
  }
  function shapeFor(event) {
    const clamp2 = (n, low, high) => Math.min(high, Math.max(low, n));
    switch (familyFor(event)) {
      case "whoosh":
        return {
          pre: clamp2(event.peak - event.start + 0.12, 0.15, 1.5),
          post: clamp2(event.end - event.peak + 0.45, 0.3, 2),
          fadeIn: 0.06,
          fadeOut: 0.25,
          minTail: 0.15
        };
      case "click":
        return { pre: 0.015, post: 0.2, fadeIn: 3e-3, fadeOut: 0.05, minTail: 0.06 };
      case "impact":
        return { pre: 0.05, post: 1.4, fadeIn: 0.01, fadeOut: 0.5, minTail: 0.25 };
      case "burn":
        return { pre: 0.05, post: 1.1, fadeIn: 0.01, fadeOut: 0.3, minTail: 0.2 };
      case "shine":
        return { pre: 0.3, post: 1.1, fadeIn: 0.08, fadeOut: 0.35, minTail: 0.2 };
      case "shutter":
        return { pre: 0.02, post: 0.4, fadeIn: 3e-3, fadeOut: 0.08, minTail: 0.08 };
      case "glitch":
        return { pre: 0.03, post: 0.6, fadeIn: 5e-3, fadeOut: 0.1, minTail: 0.1 };
      default:
        return event.kind === "opacity" ? { pre: 0.08, post: 0.5, fadeIn: 0.02, fadeOut: 0.15, minTail: 0.1 } : { pre: 0.03, post: 0.45, fadeIn: 5e-3, fadeOut: 0.12, minTail: 0.1 };
    }
  }
  function levelFor(event) {
    switch (familyFor(event)) {
      case "whoosh":
        return -17 + event.intensity * 6;
      case "impact":
        return -15 + event.intensity * 6;
      case "click":
        return -18;
      case "burn":
      case "glitch":
        return -18 + event.intensity * 3;
      case "shine":
        return -21;
      case "shutter":
        return -16;
      default:
        return event.kind === "opacity" ? -19 + event.intensity * 3 : -17 + event.intensity * 3;
    }
  }
  async function prepareSounds(cues, catalog2, folder, frame, level, lanes, progress, cancelled) {
    setFolder(folder);
    const sources = /* @__PURE__ */ new Map();
    const empty2 = /* @__PURE__ */ new Set();
    const cuts = [];
    for (let i = 0; i < cues.length; i++) {
      if (cancelled()) throw new Error("Preparação cancelada.");
      const { event } = cues[i];
      let source;
      for (const candidate of [cues[i].choice, ...cues[i].fallbacks].slice(0, 4)) {
        if (empty2.has(candidate.id)) continue;
        if (!sources.has(candidate.id)) progress(`Baixando ${candidate.name} (${sources.size + 1})…`);
        source = sources.get(candidate.id) ?? await load(candidate, catalog2, cancelled) ?? void 0;
        if (source) {
          sources.set(candidate.id, source);
          break;
        }
        empty2.add(candidate.id);
      }
      if (!source) throw new Error(`${cues[i].choice.name} e as alternativas estão vazios no pack. Troque o som deste evento.`);
      const shape = shapeFor(event);
      const cut = cutAround(source.peak, source.duration, event.peak, shape.pre, shape.post, frame);
      const end = cut.start + (cut.outPoint - cut.inPoint);
      const gainDb = Math.max(-40, Math.min(15, levelFor(event) + level - peakDbIn(source.pcm, cut.inPoint, cut.outPoint)));
      const landing = cut.start + (source.peak - cut.inPoint);
      cuts.push({
        eventId: event.id,
        start: cut.start,
        end,
        peak: landing,
        minEnd: Math.min(end, landing + shape.minTail),
        optional: event.kind === "word",
        path: source.path,
        inPoint: cut.inPoint,
        gainDb,
        source
      });
    }
    const { planned, dropped } = chokeToFit(cuts, lanes);
    const placements = planned.map((cue) => ({
      eventId: cue.eventId,
      path: cue.path,
      start: cue.start,
      end: cue.end,
      track: cue.track,
      inPoint: cue.inPoint,
      outPoint: cue.inPoint + (cue.end - cue.start),
      gainDb: cue.gainDb
    }));
    return { placements, dropped: dropped.map((cue) => cue.eventId), files: [...new Set(placements.map((p) => p.path))] };
  }
  const LAST_BATCH = "sound-design-last-batch.json";
  let busy = false;
  let lastBatch = null;
  const canonical = (s) => s.replace(/\\/g, "/").normalize("NFC");
  function samePlacement(item, planned, frame) {
    return canonical(item.path) === canonical(planned.path) && item.track === planned.track && Math.abs(item.start - planned.start) < frame / 2;
  }
  class ReadbackError extends Error {
    constructor(message, details) {
      super(message);
      this.details = details;
    }
  }
  const at = (n) => `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;
  async function settle(count, total, budgetMs = 15e3) {
    const deadline = Date.now() + budgetMs;
    let last = -1, still = 0, now = await count();
    while (now !== total && Date.now() < deadline) {
      still = now === last ? still + 1 : 0;
      if (still >= 3) break;
      last = now;
      await wait$1(700);
      now = await count();
    }
    return now;
  }
  async function readLastBatch() {
    if (lastBatch) return lastBatch;
    try {
      const raw = readText$1(await workspace(), LAST_BATCH);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (typeof data.sequenceId !== "string" || !Number.isFinite(data.frame) || data.frame <= 0 || !Array.isArray(data.items) || data.items.length > 1e3) return null;
      if (!data.items.every((p) => typeof p.path === "string" && p.path.length > 0 && typeof p.eventId === "string" && Number.isInteger(p.track) && p.track >= 2 && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end > p.start)) return null;
      lastBatch = data;
      return data;
    } catch {
      return null;
    }
  }
  async function saveBatch(batch) {
    lastBatch = batch;
    await write(await workspace(), LAST_BATCH, JSON.stringify(batch));
  }
  function removeItems(ppro, project2, editor, items, label) {
    if (!items.length) return true;
    const remove2 = (selection) => {
      for (const item of items) selection.addItem(item, true);
      return commit(project2, label, (tx) => {
        tx.addAction(editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.ANY));
      });
    };
    let ok = false;
    try {
      ppro.TrackItemSelection.createEmptySelection((selection) => {
        ok = remove2(selection);
      });
    } catch {
      ok = false;
    }
    if (ok) return true;
    let held = null;
    ppro.TrackItemSelection.createEmptySelection((selection) => {
      held = selection;
    });
    return held ? remove2(held) : false;
  }
  async function addAudioTracks(ppro, project2, sequence2, editor, placeholder, path, needed, progress) {
    const at2 = (await sequence2.getEndTime()).seconds + 1;
    for (let k = 0; k < needed; k++) {
      const index = await sequence2.getAudioTrackCount();
      progress(`Criando faixa de áudio A${index + 1}…`);
      const ok = commit(project2, "SFX Automático — criar faixa de áudio", (tx) => {
        tx.addAction(editor.createInsertProjectItemAction(placeholder, ppro.TickTime.createWithSeconds(at2), 0, index, true));
      });
      const created = await sequence2.getAudioTrackCount() > index;
      const strays = async () => {
        const found = [];
        const count = await sequence2.getAudioTrackCount();
        for (let ti = 0; ti < count; ti++) {
          for (const item of await (await sequence2.getAudioTrack(ti)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
            if (Math.abs((await item.getStartTime()).seconds - at2) > 0.01) continue;
            let media = "";
            try {
              media = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
            } catch {
              continue;
            }
            if (canonical(media) === canonical(path)) found.push(item);
          }
        }
        return found;
      };
      const left = await strays();
      if (left.length) removeItems(ppro, project2, editor, left, "SFX Automático — limpar marcador de faixa");
      if (left.length && (await strays()).length) {
        throw new Error(`Sobrou um marcador depois do fim da sequência (${path.split(/[\\/]/).pop()}), na faixa nova. Apague-o e aplique de novo.`);
      }
      if (!ok || !created) {
        throw new Error(`O Premiere não criou a faixa A${index + 1}. Adicione ${needed - k} faixa(s) de áudio (botão direito no cabeçalho das faixas › Adicionar faixas) e aplique de novo.`);
      }
    }
  }
  const PLACED = "sound-design-placed.json";
  let placed = null;
  async function loadPlaced() {
    if (placed) return;
    placed = /* @__PURE__ */ new Map();
    try {
      const raw = readText$1(await workspace(), PLACED);
      const list = raw ? JSON.parse(raw) : [];
      for (const [id, where] of list) if (typeof id === "string" && typeof where?.path === "string") placed.set(id, where);
    } catch {
    }
  }
  async function remember(items) {
    await loadPlaced();
    for (const p of items) placed.set(p.eventId, { path: p.path, start: p.start, track: p.track });
    const list = [...placed].slice(-4e3);
    await write(await workspace(), PLACED, JSON.stringify(list));
  }
  function isPlaced(eventId, audio, frame) {
    const where = placed?.get(eventId);
    return !!where && audio.some((a) => canonical(a.path) === canonical(where.path) && a.track === where.track && Math.abs(a.start - where.start) < frame / 2);
  }
  const onTimeline = (p, audio, frame) => audio.some((a) => samePlacement(a, p, frame));
  async function placeCuts(ppro, project2, editor, planned, items) {
    const label = "SFX Automático — inserir SFX";
    const overwrite = (tx, group2) => {
      for (const p of group2) tx.addAction(editor.createOverwriteItemAction(items.get(p.path), ppro.TickTime.createWithSeconds(p.start), 0, p.track));
    };
    let previous = null;
    for (const group2 of groupByCut(planned)) {
      const clip = ppro.ClipProjectItem.cast(items.get(group2[0].path));
      const before = previous;
      const ok2 = commit(project2, label, (tx) => {
        if (before) overwrite(tx, before);
        tx.addAction(clip.createClearInOutPointsAction());
        tx.addAction(clip.createSetInOutPointsAction(ppro.TickTime.createWithSeconds(group2[0].inPoint), ppro.TickTime.createWithSeconds(group2[0].outPoint)));
      });
      if (!ok2) throw new Error("O Premiere recusou o lote. Confira as faixas travadas e analise novamente; use Remover último lote se algum som entrou.");
      previous = group2;
    }
    const last = previous;
    const ok = commit(project2, label, (tx) => {
      if (last) overwrite(tx, last);
      for (const path of new Set(planned.map((p) => p.path))) tx.addAction(ppro.ClipProjectItem.cast(items.get(path)).createClearInOutPointsAction());
    });
    if (!ok) throw new Error("O Premiere recusou o lote. Confira as faixas travadas e analise novamente; use Remover último lote se algum som entrou.");
  }
  async function applyGains(ppro, project2, sequence2, planned, frame) {
    try {
      const found = [];
      for (const index of new Set(planned.map((p) => p.track))) {
        const track = await sequence2.getAudioTrack(index);
        for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
          const start = (await item.getStartTime()).seconds;
          const mine = planned.filter((p2) => p2.track === index && Math.abs(p2.start - start) < frame / 2);
          if (!mine.length) continue;
          let path = "";
          try {
            path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
          } catch {
            continue;
          }
          const p = mine.find((m) => canonical(m.path) === canonical(path));
          if (!p) continue;
          const chain = await item.getComponentChain();
          const count = await Promise.resolve(chain.getComponentCount());
          for (let ci = 0; ci < count; ci++) {
            const component = await Promise.resolve(chain.getComponentAtIndex(ci));
            const name = `${await component.getDisplayName().catch(() => "")} ${await component.getMatchName().catch(() => "")}`;
            if (!/volume/i.test(name) || /channel/i.test(name)) continue;
            const params = await Promise.resolve(component.getParamCount());
            for (let pi = 0; pi < params; pi++) {
              const param = await Promise.resolve(component.getParam(pi));
              if (/^(level|n[ií]vel)$/i.test((param.displayName ?? "").trim())) {
                found.push({ param, gainDb: p.gainDb });
                break;
              }
            }
            break;
          }
        }
      }
      if (!found.length) return { set: 0, note: "o volume dos clipes não apareceu para o plugin; os SFX ficaram no nível do arquivo" };
      const zero = Number(unwrapValue(await found[0].param.getValueAtTime(ppro.TickTime.createWithSeconds(0))));
      const scale = (db) => zero > 0.1 && zero < 0.3 ? Math.min(1, zero * Math.pow(10, db / 20)) : zero > 0.9 && zero < 1.1 ? Math.pow(10, db / 20) : Math.abs(zero) < 1e-3 ? db : null;
      if (scale(0) === null) return { set: 0, note: `o Level veio num formato desconhecido (${zero}); os SFX ficaram no nível do arquivo` };
      const ok = commit(project2, "SFX Automático — volume dos SFX", (tx) => {
        for (const { param, gainDb } of found) {
          if (param.isTimeVarying()) tx.addAction(param.createSetTimeVaryingAction(false));
          tx.addAction(param.createSetValueAction(param.createKeyframe(scale(gainDb)), true));
        }
      });
      return ok ? { set: found.length, note: "" } : { set: 0, note: "o Premiere recusou ajustar o volume; os SFX ficaram no nível do arquivo" };
    } catch (cause) {
      return { set: 0, note: `o volume não foi ajustado (${cause instanceof Error ? cause.message : String(cause)}); os SFX ficaram no nível do arquivo` };
    }
  }
  async function applySounds(scan, sounds, progress, cancelled) {
    if (busy) throw new Error("Uma aplicação de SFX já está em andamento.");
    busy = true;
    try {
      const { ppro, project: project2, sequence: sequence2, id } = await activeTimeline();
      if (id !== scan.sequenceId) throw new Error("A sequência mudou. Analise novamente antes de aplicar.");
      if (!sounds.length) return { count: 0, skipped: 0, volume: "" };
      const editor = resolveEditor(ppro, sequence2);
      if (!editor) throw new Error("O Premiere não disponibilizou o editor da sequência.");
      const fresh = await readAudio(ppro, sequence2);
      const pending = sounds.filter((p) => !onTimeline(p, fresh.audio, scan.frame));
      const skipped = sounds.length - pending.length;
      if (!pending.length) return { count: 0, skipped, volume: "" };
      const highest = Math.max(...pending.map((p) => p.track));
      allocateTracks(pending, withRoom(fresh.lanes, highest));
      if (cancelled()) throw new Error("Aplicação cancelada antes de inserir os SFX.");
      if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou durante a preparação. Analise novamente.");
      const files = [...new Set(pending.map((p) => p.path))];
      progress(`Importando ${files.length} arquivo${files.length === 1 ? "" : "s"} de SFX para a bin SFX/Automático…`);
      const imports = await projectItemsFor(ppro, project2, files, "Automático");
      const missing = highest + 1 - await sequence2.getAudioTrackCount();
      if (missing > 0) await addAudioTracks(ppro, project2, sequence2, editor, imports.get(pending[0].path), pending[0].path, missing, progress);
      progress("Conferindo se a timeline mudou desde a análise…");
      const validated = await scanTimeline(scan.scope, progress, cancelled, new Set(scan.keys));
      if (validated.fingerprint !== scan.fingerprint) throw new Error("Os clipes ou animações mudaram depois da análise. Analise novamente.");
      const remaining = pending.filter((p) => !onTimeline(p, validated.audio, scan.frame));
      const planned = allocateTracks(remaining, validated.lanes);
      if (!planned.length) return { count: 0, skipped: sounds.length, volume: "" };
      if (cancelled()) throw new Error("Aplicação cancelada.");
      await saveBatch({ sequenceId: id, frame: scan.frame, items: planned });
      if ((await activeTimeline()).id !== id || cancelled()) throw new Error("A aplicação foi interrompida antes de inserir os sons.");
      const current2 = await readAudio(ppro, sequence2);
      const reserved = allocateTracks(planned, current2.lanes);
      if (reserved.some((p, i) => p.track !== planned[i].track)) throw new Error("As faixas de áudio mudaram. Aplique novamente.");
      progress(`Inserindo ${planned.length} SFX…`);
      await placeCuts(ppro, project2, editor, planned, imports);
      progress(`Conferindo os ${planned.length} SFX na timeline…`);
      let written = await readAudio(ppro, sequence2);
      const count = await settle(async () => {
        written = await readAudio(ppro, sequence2);
        return planned.filter((p) => written.audio.some((a) => samePlacement(a, p, scan.frame))).length;
      }, planned.length);
      if (count !== planned.length) {
        const missing2 = planned.filter((p) => !written.audio.some((a) => samePlacement(a, p, scan.frame)));
        const details = missing2.slice(0, 40).map((p) => {
          const found = written.audio.filter((a) => canonical(a.path) === canonical(p.path));
          return `planejado A${p.track + 1} ${at(p.start)}–${at(p.end)} ${p.path.split(/[\\/]/).pop()} → ` + (found.length ? found.map((a) => `achado A${a.track + 1} ${at(a.start)}–${at(a.end)} in ${a.inPoint.toFixed(3)}`).join("; ") : "ausente");
        });
        throw new ReadbackError(`O Premiere mostrou ${count} de ${planned.length} SFX no lugar planejado. Confira a timeline; Remover último lote tira os que entraram.`, details);
      }
      await remember(planned);
      progress("Ajustando o volume de cada SFX…");
      const gains = await applyGains(ppro, project2, sequence2, planned, scan.frame);
      return { count, skipped: sounds.length - planned.length, volume: gains.note };
    } finally {
      busy = false;
    }
  }
  async function undoLastBatch() {
    if (busy) throw new Error("Espere a aplicação terminar.");
    busy = true;
    try {
      const snapshot2 = await readLastBatch();
      if (!snapshot2?.items.length) return { count: 0, preserved: 0 };
      const { ppro, project: project2, sequence: sequence2, id } = await activeTimeline();
      if (id !== snapshot2.sequenceId) throw new Error("Volte à sequência onde o último lote foi aplicado para removê-lo.");
      const editor = resolveEditor(ppro, sequence2);
      if (!editor) throw new Error("O editor da sequência não respondeu.");
      const matches = [];
      const removed = /* @__PURE__ */ new Set();
      const count = await sequence2.getAudioTrackCount();
      for (let ti = 2; ti < count; ti++) {
        const track = await sequence2.getAudioTrack(ti);
        const lock = track.isLocked;
        if (typeof lock === "function" && await lock.call(track)) continue;
        for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
          let path;
          try {
            path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath();
          } catch {
            continue;
          }
          const planned = snapshot2.items.find((p) => canonical(p.path) === canonical(path));
          if (!planned || removed.has(path)) continue;
          const [start, end, point] = await Promise.all([item.getStartTime(), item.getEndTime(), item.getInPoint()]);
          const now = { path, start: start.seconds, end: end.seconds, inPoint: point.seconds, track: ti };
          if (!samePlacement(now, planned, snapshot2.frame)) continue;
          matches.push(item);
          removed.add(path);
        }
      }
      if (matches.length) {
        if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou. Tente novamente na sequência original.");
        const ok = removeItems(ppro, project2, editor, matches, "SFX Automático — remover último lote");
        if (!ok) throw new Error("O Premiere recusou remover o lote. Confira as faixas travadas.");
        const left = await settle(async () => (await readAudio(ppro, sequence2)).audio.filter((a) => removed.has(a.path)).length, 0);
        if (left) throw new Error(`${left} SFX do lote continuam na timeline. Confira e remova à mão, ou tente de novo.`);
      }
      const remaining = snapshot2.items.filter((p) => !removed.has(p.path));
      await saveBatch({ ...snapshot2, items: remaining });
      return { count: matches.length, preserved: remaining.length };
    } finally {
      busy = false;
    }
  }
  const FAMILIES = Object.keys(FAMILY_LABELS);
  const defaults = { version: 3, scope: "selection", options: DEFAULT_OPTIONS, level: 0, sounds: {}, titles: {}, respect: true };
  const settings = createToolSettings("sound-design-config.json", defaults, (raw) => ({
    version: 3,
    scope: raw.scope === "sequence" ? "sequence" : "selection",
    level: clampNumber(raw.level, -12, 6, 0),
    options: Object.fromEntries(Object.entries(DEFAULT_OPTIONS).map(([key, value]) => [
      key,
      key === "density" ? ["light", "balanced", "full"].includes(raw.options?.density ?? "") ? raw.options.density : value : raw.version === 3 && typeof raw.options?.[key] === "boolean" ? raw.options[key] : value
    ])),
    sounds: Object.fromEntries(FAMILIES.filter((f) => typeof raw.sounds?.[f] === "string").map((f) => [f, raw.sounds[f]])),
    titles: Object.fromEntries(Object.entries(raw.titles ?? {}).filter(([, v]) => v === "words" || v === "entry" || v === "none")),
    respect: raw.respect !== false
  }));
  warmToolSettings(settings);
  let dispose = null;
  const MAX_BATCH = 1e3;
  const clock = (n) => `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toFixed(2).padStart(5, "0")}`;
  const soundDesignTool = {
    id: "sound-design",
    name: "SFX Automático",
    category: "audio",
    glyph: "sfx-auto",
    available: true,
    usesSelection: false,
    summary: "O som do que está na tela",
    hint: "Cada elemento recebe o som do que ele é: títulos do Textos Animados ganham um clique por palavra no ritmo da animação, film burn ganha film burn, flash ganha obturador, glitch ganha glitch, gráfico curto ganha swoosh. O que não tem identidade clara (light leak, textura, B-roll, Adjustment Layer sem efeito reconhecido) fica em silêncio, e onde você já pôs SFX ele não mexe. Zoom e movimento de câmera só entram se você ligar. A trilha de legendas nunca recebe SFX.",
    mount(container, context) {
      const initial = settings.peek() ?? defaults;
      const config = { ...initial, options: { ...initial.options }, sounds: { ...initial.sounds }, titles: { ...initial.titles } };
      let alive = true, busy2 = false, cancelled = false, previewToken = 0, previewId = "", dirty = false;
      let release = null;
      let folder = null, scan = null, catalog2 = null;
      let rows = [], hasUndo = false;
      let events = [];
      let anchors = [];
      let done = /* @__PURE__ */ new Set();
      let templateMenus = [];
      const modeOf = (template) => config.titles[templateKey(template)] ?? presetFor(template).mode;
      const derive = () => {
        if (scan) events = eventsFrom(anchors, scan.frame, config.respect ? done : /* @__PURE__ */ new Set(), modeOf);
      };
      const mountTemplates = () => {
        const host2 = el("[data-templates]");
        const found = /* @__PURE__ */ new Map();
        for (const a of anchors) if (a.role === "title" && a.template) {
          const key = templateKey(a.template);
          found.set(key, { name: a.template, count: (found.get(key)?.count ?? 0) + 1 });
        }
        host2.hidden = found.size === 0;
        host2.innerHTML = found.size ? `<p class="sd-families-title">Títulos do Textos Animados</p>` + [...found].map(([, t], i) => `<div class="sd-family"><span class="sd-family-label" title="${escapeHtml(t.name)}">${escapeHtml(t.name)} <span class="sd-count">${t.count}×</span></span><div class="sd-family-pick"><div data-template-pick="${i}"></div></div></div>`).join("") : "";
        templateMenus = [...found].map(([key, t], i) => ({ key, menu: mountDropdown(host2.querySelector(`[data-template-pick="${i}"]`), {
          options: () => {
            const preset = presetFor(t.name);
            const mark = (mode) => preset.mode === mode ? `padrão · ${preset.look}` : void 0;
            return [
              { id: "words", label: "Palavra por palavra", meta: mark("words") ?? "um som por palavra" },
              { id: "entry", label: "Um som na entrada", meta: mark("entry") ?? "swoosh" },
              { id: "none", label: "Sem som", meta: mark("none") }
            ];
          },
          selected: () => config.titles[key] ?? presetFor(t.name).mode,
          onPick: (id) => {
            if (busy2) return;
            config.titles[key] = id;
            remember2();
            derive();
            rebuild();
          }
        }) }));
        menus = [scopeMenu, densityMenu, ...familyMenus, ...templateMenus.map((t) => t.menu)];
      };
      let menus = [];
      let page = 0;
      const PAGE = 30;
      container.innerHTML = markup();
      const el = (q2) => container.querySelector(q2);
      const status = (text2, error = false) => {
        if (!alive) return;
        context.setStatus(text2, error ? "error" : "idle");
        el("[data-progress]").textContent = text2;
      };
      const remember2 = () => {
        dirty = true;
        settings.save({ ...config, options: { ...config.options }, sounds: { ...config.sounds }, titles: { ...config.titles } });
      };
      const choiceFor = (id) => {
        for (const row of rows) {
          const hit = row.choices.find((c) => c.id === id);
          if (hit) return hit;
        }
        return catalog2 ? choiceById(catalog2, id) : null;
      };
      const stop = () => {
        previewToken++;
        previewId = "";
        stopPlayback();
        release?.();
        release = null;
      };
      const optionsChanged = () => {
        if (busy2) return;
        remember2();
        rebuild();
      };
      const scopeMenu = mountDropdown(el("[data-scope]"), {
        options: () => [{ id: "selection", label: "Clipes selecionados" }, { id: "sequence", label: "Sequência inteira" }],
        selected: () => config.scope,
        onPick: (id) => {
          if (busy2) return;
          config.scope = id;
          scan = null;
          rows = [];
          page = 0;
          remember2();
          render();
        }
      });
      const densityMenu = mountDropdown(el("[data-density]"), {
        options: () => [{ id: "light", label: "Discreto", meta: "Mais espaço" }, { id: "balanced", label: "Equilibrado" }, { id: "full", label: "Detalhado", meta: "Cada evento" }],
        selected: () => config.options.density,
        onPick: (id) => {
          if (busy2) return;
          config.options.density = id;
          optionsChanged();
        }
      });
      const preferred = (family, choices) => {
        const id = config.sounds[family];
        if (!id || id === "auto" || !catalog2) return -1;
        const at2 = choices.findIndex((c) => c.id === id);
        if (at2 >= 0) return at2;
        const extra = choiceFor(id);
        if (!extra) return -1;
        choices.push(extra);
        return choices.length - 1;
      };
      const familyOptions = (family) => {
        const best = /* @__PURE__ */ new Map();
        for (const row of rows) if (familyFor(row.event) === family) for (const c of row.choices) {
          if (c.score > 0 && (best.get(c.id)?.score ?? -1) < c.score) best.set(c.id, c);
        }
        const ranked = [...best.values()].sort((a, b) => b.score - a.score);
        const out = [{ id: "auto", label: family === "whoosh" || family === "impact" ? "Automático · varia" : "Automático", meta: ranked[0]?.name }];
        for (const c of ranked.slice(0, 12)) out.push({ id: c.id, label: c.name, meta: "sugerido" });
        const homes = /* @__PURE__ */ new Set([...FAMILY_CATEGORIES[family], "assinatura"]);
        if (catalog2) for (const category of catalog2.categories) for (const sound of category.sounds) {
          if (sound.loop || !homes.has(category.id)) continue;
          sound.variants.forEach((v, i) => {
            if (ranked.slice(0, 12).some((c) => c.id === v.id)) return;
            out.push({ id: v.id, label: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, meta: category.label });
          });
        }
        return out;
      };
      const setFamily = (family, id) => {
        stop();
        config.sounds[family] = id;
        remember2();
        const seen = /* @__PURE__ */ new Map();
        for (const row of rows) {
          if (familyFor(row.event) !== family) continue;
          const occurrence = seen.get(family) ?? 0;
          seen.set(family, occurrence + 1);
          if (row.placed) continue;
          const had = row.choices.length;
          const chosen = preferred(family, row.choices);
          row.pick = chosen >= 0 ? chosen : varietyPick(family, row.choices, occurrence);
          if (!had && row.choices.length) row.enabled = true;
        }
        familyMenus.forEach((menu) => menu.render());
        const name = config.sounds[family] === "auto" ? "o automático" : choiceFor(id)?.name ?? "o som escolhido";
        status(`${FAMILY_LABELS[family]}: ${name} em todos os eventos deste tipo.`);
        render();
      };
      const familyMenus = FAMILIES.map((family) => mountDropdown(el(`[data-family-pick="${family}"]`), {
        options: () => familyOptions(family),
        selected: () => config.sounds[family] ?? "auto",
        onPick: (id) => {
          if (!busy2) setFamily(family, id);
        },
        search: { placeholder: "Buscar no pack…" }
      }));
      menus = [scopeMenu, densityMenu, ...familyMenus];
      const slider = mountSlider(el("[data-level]"), {
        min: -12,
        max: 6,
        step: 1,
        value: config.level,
        label: "Nível dos efeitos sonoros",
        output: el("[data-level-value]"),
        format: (n) => n === 0 ? "Padrão" : `${n > 0 ? "+" : ""}${n} dB`,
        onInput: (n) => {
          if (!busy2) {
            config.level = n;
            remember2();
          }
        }
      });
      const ready = () => rows.filter((r) => r.enabled && !r.placed && r.choices.length).length;
      const step2 = () => {
        if (!scan) return "analyze";
        if (ready()) return "apply";
        return rows.some((r) => !r.placed && r.choices.length) ? "review" : "analyze";
      };
      function actions() {
        if (!alive) return;
        const count = ready();
        const next = step2();
        context.setApplyLabel(busy2 ? "Processando…" : next === "apply" ? `Aplicar ${count} SFX` : next === "review" ? "Aplicar SFX" : scan ? "Analisar de novo" : "Analisar timeline");
        context.setApplyEnabled(!busy2 && (next === "analyze" || next === "apply" && !!catalog2 && count <= MAX_BATCH));
        if (!busy2 && next === "apply" && count > MAX_BATCH) context.setStatus(`${count} eventos marcados: o limite é ${MAX_BATCH} por lote. Desmarque alguns ou analise uma seleção menor.`, "error");
        if (!busy2 && next === "review") context.setStatus("Nenhum evento marcado. Marque na lista os sons que quer aplicar.", "idle");
        el("[data-analyze-label]").textContent = scan ? "Analisar de novo" : "Analisar e sugerir sons";
        context.setResetLabel(busy2 ? "Cancelar" : "Remover último lote");
        context.setResetHandler(busy2 ? () => {
          cancelled = true;
          status("Cancelando antes da próxima etapa…");
        } : hasUndo ? () => {
          void undo2();
        } : null);
        setDisabled(el("[data-analyze]"), busy2);
        setDisabled(el("[data-folder]"), busy2);
        el("[data-controls]").classList.toggle("is-disabled", busy2);
        el("[data-controls]").setAttribute("aria-disabled", String(busy2));
        container.setAttribute("aria-busy", String(busy2));
        el("[data-respect]").setAttribute("aria-pressed", String(config.respect));
        setDisabled(el("[data-respect]"), busy2);
        for (const key of Object.keys(LABELS)) {
          const button = el(`[data-kind="${key}"]`);
          button.setAttribute("aria-pressed", String(config.options[key]));
          setDisabled(button, busy2);
        }
      }
      function rebuild() {
        stop();
        const previous = new Map(rows.map((r) => [r.event.id, r]));
        const seen = /* @__PURE__ */ new Map();
        const ranked = /* @__PURE__ */ new Map();
        const rank = (event) => {
          const key = `${familyFor(event)}|${Math.round((event.end - event.start) * 10)}|${Math.round(event.intensity * 10)}`;
          let list = ranked.get(key);
          if (!list) {
            list = rankSounds(event, catalog2, knownSeconds).slice(0, 24);
            ranked.set(key, list);
          }
          return list.slice();
        };
        rows = scan && catalog2 ? selectEvents(events, config.options, scan.frame).map((event) => {
          const old = previous.get(event.id);
          const choices = rank(event);
          const placed2 = isPlaced(event.id, scan.audio, scan.frame) || alreadyPlaced(event.id, scan.audio);
          const oldId = old?.choices[old.pick]?.id;
          const family = familyFor(event);
          const occurrence = seen.get(family) ?? 0;
          seen.set(family, occurrence + 1);
          const kept = oldId ? choices.findIndex((choice) => choice.id === oldId) : -1;
          const chosen = kept >= 0 ? -1 : preferred(family, choices);
          const pick = kept >= 0 ? kept : chosen >= 0 ? chosen : varietyPick(family, choices, occurrence);
          return { event, choices, pick, placed: placed2, enabled: !placed2 && !!choices.length && (old?.enabled ?? true) };
        }) : [];
        familyMenus.forEach((menu) => menu.render());
        page = 0;
        render();
      }
      function render() {
        if (!alive) return;
        const count = rows.filter((r) => r.enabled && !r.placed && r.choices.length).length;
        const placed2 = rows.filter((r) => r.placed).length;
        el("[data-summary]").textContent = scan ? `${count} prontos · ${placed2} já na timeline` : "Encontre o ritmo da edição";
        el("[data-summary-detail]").textContent = scan ? `${scan.sequenceName} · ${scan.clips} clipes analisados` : "Cada elemento recebe o som do que ele é.";
        el("[data-folder-label]").textContent = folder ? folder.path.split(/[\\/]/).pop() || folder.path : "Nenhuma — escolha antes de aplicar";
        el("[data-folder-label]").title = folder?.path ?? "";
        el("[data-folder]").textContent = folder ? "Trocar…" : "Escolher…";
        const notes = [...scan?.notes ?? []];
        if (scan && !scan.lanes.some((l) => l.index >= 2 && !l.locked)) notes.unshift("Adicione uma faixa de áudio livre a partir da A3 para aplicar os sons.");
        if (count > MAX_BATCH) notes.unshift(`Selecione até ${MAX_BATCH} eventos por lote ou analise uma seleção menor.`);
        if (rows.some((r) => !r.choices.length)) notes.push("Sem som compatível: confira se o pack possui whooshes, clicks ou impactos e atualize a biblioteca de Efeitos Sonoros.");
        el("[data-notes]").innerHTML = notes.map((note2) => `<p>${escapeHtml(note2)}</p>`).join("");
        el("[data-notes]").hidden = notes.length === 0;
        const present = new Set(rows.filter((r) => r.choices.length).map((r) => familyFor(r.event)));
        el("[data-families]").hidden = present.size === 0;
        for (const family of FAMILIES) {
          const line = el(`[data-family="${family}"]`);
          line.hidden = !present.has(family);
          el(`[data-family-play="${family}"]`).textContent = previewId === `family:${family}` ? "Parar" : "Ouvir";
        }
        const visible = rows.slice(page * PAGE, (page + 1) * PAGE);
        el("[data-cues]").innerHTML = visible.length ? visible.map((r) => {
          const choice = r.choices[r.pick];
          const id = r.event.id;
          return `<div class="sd-cue${r.placed ? " is-placed" : ""}" data-row="${id}"><div class="sd-cue-top"><span class="sd-check" ${CONTROL} data-toggle="${id}" aria-label="Incluir ${escapeHtml(LABELS[r.event.kind])} aos ${clock(r.event.peak)}" aria-pressed="${r.enabled}" aria-disabled="${r.placed || !choice}">${r.placed ? "✓" : r.enabled ? "✓" : "−"}</span><span class="sd-time" ${CONTROL} data-seek="${id}" title="Ir a este ponto na timeline">${clock(r.event.peak)}</span><span class="sd-kind">${escapeHtml(LABELS[r.event.kind])}</span></div><p class="sd-detail">${escapeHtml(r.event.detail)}</p><p class="sd-clip" title="${escapeHtml(r.event.clip)}">${escapeHtml(r.event.clip)}</p>` + (r.event.why ? `<p class="sd-why">${escapeHtml(r.event.why)}</p>` : "") + `<div class="sd-sound"><span class="sd-sound-name" data-sound-name>${r.placed ? "Já aplicado" : choice ? escapeHtml(choice.name) : "Sem som compatível"}</span><span class="sd-small" ${CONTROL} data-play="${id}" aria-label="Ouvir som sugerido" aria-disabled="${!choice}">${previewId === id ? "Parar" : "Ouvir"}</span>` + (!r.placed && r.choices.length > 1 ? `<span class="sd-small" ${CONTROL} data-swap="${id}" title="Próximo som compatível">Trocar</span>` : "") + "</div></div>";
        }).join("") : `<div class="sd-empty"><p>${scan ? "Nenhum evento disponível" : "Comece pelos clipes que você quer sonorizar"}</p><span>${scan ? "Confira os filtros de eventos acima. A análise lê keyframes de escala, posição, rotação e opacidade, cortes com mudança de enquadramento e textos na timeline; movimento já renderizado dentro do vídeo não aparece." : "Selecione na timeline e clique em Analisar. Os sons aparecem aqui para você ouvir e revisar."}</span></div>`;
        el("[data-page]").textContent = rows.length ? `${page * PAGE + 1}–${Math.min(rows.length, (page + 1) * PAGE)} de ${rows.length}` : "";
        el("[data-pagination]").hidden = rows.length <= PAGE;
        setDisabled(el("[data-prev]"), page === 0 || busy2);
        setDisabled(el("[data-next]"), (page + 1) * PAGE >= rows.length || busy2);
        el("[data-bulk]").hidden = !rows.length;
        actions();
      }
      async function analyze() {
        if (busy2) return;
        busy2 = true;
        cancelled = false;
        stop();
        scan = null;
        rows = [];
        events = [];
        render();
        try {
          status("Lendo a timeline…");
          const next = await scanTimeline(config.scope, status, () => cancelled || !alive);
          if (!next.clips) throw new Error(config.scope === "selection" ? "Nada selecionado: selecione os clipes na timeline (vídeo e legendas) ou escolha Sequência inteira em Analisar." : "Esta sequência não tem clipes de vídeo ativos.");
          status("Consultando o pack de SFX…");
          const sounds = await soundLibrary(false, status);
          await loadPlaced();
          if (cancelled || !alive) return;
          anchors = anchorsOf(next.elements, next.motion, next.frame, next.covers);
          done = soundedAlready(anchors, next.sfx);
          scan = next;
          catalog2 = sounds;
          derive();
          mountTemplates();
          rebuild();
          const count = ready();
          const skipped = config.respect && done.size ? ` · ${done.size} momentos já têm SFX seu e ficaram de fora (desligue “Respeitar meus SFX” para incluir)` : "";
          status(rows.length ? `${rows.length} eventos encontrados${count < rows.length ? ` · ${count} com som pronto` : ""}${skipped}.` : `Nenhum evento novo em ${next.clips} clipes${skipped}.`, !count);
          void report(ANALYSIS, "Análise", describeScan(next, rows, sounds, done.size));
        } catch (cause) {
          status(describe$5(cause), true);
          void report(ANALYSIS, "Análise falhou", [`escopo: ${config.scope}`, `erro: ${describe$5(cause)}`, String(cause?.stack ?? "")]);
        } finally {
          busy2 = false;
          if (alive) render();
        }
      }
      async function chooseFolder() {
        const chosen = await pickAndSave("soundDesign");
        if (!chosen || !alive) return;
        folder = chosen;
        setFolder(folder);
        forgetOpenFolders();
        sfxSettings.patch({ folder: chosen.path, folderToken: chosen.token });
        await sfxSettings.flush();
        render();
      }
      async function apply() {
        if (busy2 || !scan || !catalog2) return;
        const chosen = rows.filter((r) => r.enabled && !r.placed && r.choices.length);
        if (!chosen.length || chosen.length > MAX_BATCH) return;
        busy2 = true;
        cancelled = false;
        stop();
        actions();
        try {
          const timeline = await activeTimeline();
          if (timeline.id !== scan.sequenceId) throw new Error("A sequência mudou. Analise novamente.");
          if (!folder) await chooseFolder();
          if (!folder) {
            status("Escolha a pasta onde os SFX usados vão ficar: o Premiere precisa do arquivo no disco.");
            return;
          }
          const current2 = (await readAudio(timeline.ppro, timeline.sequence)).lanes;
          const lanes = withRoom(current2, current2.length - 1 + MAX_NEW_TRACKS);
          const { placements, dropped, files } = await prepareSounds(chosen.map((r) => ({
            event: r.event,
            choice: r.choices[r.pick],
            fallbacks: r.choices.filter((c, i) => i !== r.pick && c.id !== r.choices[r.pick].id)
          })), catalog2, folder, scan.frame, config.level, lanes, status, () => cancelled || !alive);
          const result = await applySounds(scan, placements, status, () => cancelled || !alive);
          hasUndo = !!(await readLastBatch())?.items.length;
          if (!alive) return;
          const left = new Set(dropped);
          for (const row of chosen) if (!left.has(row.event.id)) {
            row.placed = true;
            row.enabled = false;
          }
          const created = Math.max(0, Math.max(-1, ...placements.map((p) => p.track)) + 1 - current2.length);
          const room = (created ? ` · ${created} faixa(s) de áudio criada(s)` : "") + (dropped.length ? ` · ${dropped.length} cliques de palavra ficaram de fora: mesmo com ${MAX_NEW_TRACKS} faixas novas não couberam.` : "");
          const where = folder.path.split(/[\\/]/).pop() || folder.path;
          const volume = result.volume ? ` Atenção: ${result.volume}.` : "";
          status(`${result.count} SFX na timeline · ${files.length} arquivo${files.length === 1 ? "" : "s"} de som em ${where} (só os usados)${result.skipped ? ` · ${result.skipped} já existiam` : ""}${room}.${volume} Remover último lote desfaz esta aplicação.`, !!result.volume);
          void report(REPORT, "Aplicação", [
            `inseridos: ${result.count}`,
            `já existiam: ${result.skipped}`,
            `sem faixa livre: ${dropped.length}`,
            `pasta: ${folder.path}`,
            `volume: ${result.volume || "ajustado em cada clipe"}`,
            ...files.map((f) => `arquivo: ${f}`),
            ...placements.map((p) => `A${p.track + 1} ${clock(p.start)}–${clock(p.end)} in ${p.inPoint.toFixed(3)} out ${p.outPoint.toFixed(3)} ${p.gainDb.toFixed(1)} dB · ${p.path.split(/[\\/]/).pop()}`)
          ]);
          if (!result.volume) context.setStatus(`${result.count} SFX na timeline · ${files.length} arquivos de som baixados em ${where}.`, "done");
        } catch (cause) {
          hasUndo = !!(await readLastBatch())?.items.length;
          scan = null;
          rows = [];
          status(`${describe$5(cause)} Analise novamente antes de reaplicar.`, true);
          void report(REPORT, "Aplicação falhou", [`erro: ${describe$5(cause)}`, ...cause?.details ?? [], String(cause?.stack ?? "")]);
        } finally {
          busy2 = false;
          if (alive) render();
        }
      }
      async function undo2() {
        if (busy2) return;
        busy2 = true;
        actions();
        stop();
        try {
          const result = await undoLastBatch();
          hasUndo = !!(await readLastBatch())?.items.length;
          scan = null;
          rows = [];
          status(`${result.count} SFX removidos.${result.preserved ? ` ${result.preserved} itens alterados, ausentes ou travados foram preservados.` : " Analise para gerar novas sugestões."}`);
        } catch (cause) {
          status(describe$5(cause), true);
        } finally {
          busy2 = false;
          if (alive) render();
        }
      }
      async function preview(row) {
        if (row.choices.length) await previewChoice(row.event.id, row.choices[row.pick]);
      }
      async function previewChoice(key, choice) {
        if (previewId === key) {
          stop();
          render();
          return;
        }
        stop();
        prime(silenceUrl());
        const ticket = previewToken;
        previewId = key;
        render();
        try {
          await warmPlayer();
          const source = await previewSource(choice.variant);
          if (!alive || ticket !== previewToken) {
            if (source.kind === "ready") source.release();
            return;
          }
          if (source.kind !== "ready") throw new Error("Este som está vazio no pack. Troque a sugestão.");
          release = source.release;
          status("Prévia do som original. Na aplicação, o nível e o trecho são ajustados ao evento.");
          const ended = () => {
            if (ticket === previewToken) {
              stop();
              render();
            }
          };
          playUrl(source.url, { onStart: () => {
          }, onEnd: ended, onError: (message) => {
            ended();
            status(message, true);
          } }, choice.name);
        } catch (cause) {
          if (ticket === previewToken) {
            stop();
            render();
            status(describe$5(cause), true);
          }
        }
      }
      container.addEventListener("click", (event) => {
        const target2 = event.target instanceof Element ? event.target : null;
        menus.forEach((menu) => menu.closeUnless(target2));
        const button = target2?.closest("[role=button]");
        if (!button || button.getAttribute("aria-disabled") === "true" || busy2) return;
        const data = button.dataset;
        if ("analyze" in data) {
          void analyze();
          return;
        }
        if ("folder" in data) {
          void chooseFolder().catch((cause) => status(describe$5(cause), true));
          return;
        }
        if ("respect" in data) {
          config.respect = !config.respect;
          remember2();
          derive();
          rebuild();
          return;
        }
        if (data.kind) {
          const kind = data.kind;
          config.options[kind] = !config.options[kind];
          optionsChanged();
          return;
        }
        if (data.familyPlay) {
          const family = data.familyPlay;
          const row2 = rows.find((r) => familyFor(r.event) === family && r.choices.length);
          const id = config.sounds[family];
          const choice = id && id !== "auto" ? choiceFor(id) : row2 ? row2.choices[row2.pick] : null;
          if (choice) void previewChoice(`family:${family}`, choice);
          return;
        }
        if ("prev" in data) {
          page = Math.max(0, page - 1);
          render();
          return;
        }
        if ("next" in data) {
          page++;
          render();
          return;
        }
        if ("all" in data || "none" in data) {
          rows.forEach((r) => {
            r.enabled = "all" in data && !r.placed && !!r.choices.length;
          });
          render();
          return;
        }
        const row = rows.find((r) => r.event.id === (data.toggle ?? data.play ?? data.swap ?? data.seek));
        if (!row) return;
        if (data.toggle) {
          row.enabled = !row.enabled;
          render();
        }
        if (data.swap) {
          stop();
          row.pick = (row.pick + 1) % row.choices.length;
          render();
        }
        if (data.play) void preview(row);
        if (data.seek) void (async () => {
          const timeline = await activeTimeline();
          if (timeline.id !== scan?.sequenceId) throw new Error("Volte à sequência analisada ou analise novamente.");
          await timeline.sequence.setPlayerPosition(timeline.ppro.TickTime.createWithSeconds(row.event.peak));
        })().catch((cause) => status(describe$5(cause), true));
      });
      context.setApplyHandler(() => step2() === "apply" ? apply() : analyze());
      context.setRefreshHandler(null);
      setHost(el("[data-player]"));
      void warmSilence();
      render();
      void (async () => {
        const shared = await sfxSettings.read();
        const held = await readDestination(
          "soundDesign",
          destinationOf(shared.folder, shared.folderToken)
        ).catch(() => null);
        const last = await readLastBatch();
        if (!alive) return;
        folder = held?.path ? held : null;
        hasUndo = !!last?.items.length;
        const stored = await settings.read();
        if (!alive) return;
        if (!dirty && !busy2 && !scan) {
          Object.assign(config, stored, { options: { ...stored.options }, sounds: { ...stored.sounds } });
          slider.set(config.level);
          scopeMenu.render();
          densityMenu.render();
          familyMenus.forEach((menu) => menu.render());
        }
        render();
      })();
      dispose = () => {
        alive = false;
        cancelled = true;
        stop();
        slider.destroy();
        setHost(null);
        void settings.flush();
      };
    },
    unmount() {
      dispose?.();
      dispose = null;
    }
  };
  const ANALYSIS = "sfx-auto-analysis.txt";
  const REPORT = "sfx-auto-report.txt";
  async function report(file, title, lines) {
    try {
      await write(await workspace(), file, [`Framelab — SFX Automático · ${(/* @__PURE__ */ new Date()).toISOString()}`, title, ...lines].join("\n") + "\n");
    } catch {
    }
  }
  function describeScan(scan, rows, catalog2, done) {
    const kinds = /* @__PURE__ */ new Map();
    for (const element of scan.elements) kinds.set(element.role, (kinds.get(element.role) ?? 0) + 1);
    const elements = scan.elements.filter((e) => e.role !== "footage").map((e) => `elemento: ${clock(e.start)}–${clock(e.end)} V${e.track + 1} ${e.role}${e.identity ? `/${e.identity}` : ""} · ${e.clip}${e.effects.length ? ` · efeitos: ${e.effects.join(", ")}` : ""}`);
    const free = scan.lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => `A${l.index + 1}`);
    return [
      `escopo: ${scan.scope} · sequência: ${scan.sequenceName} · quadro: ${scan.frame.toFixed(5)} s`,
      `clipes lidos: ${scan.clips} · elementos: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "nenhum"} · movimentos: ${scan.motion.length} · seus SFX aqui: ${scan.sfx.length} (${done} momentos já sonorizados)`,
      ...elements,
      `na lista: ${rows.length} · prontos: ${rows.filter((r) => r.enabled && !r.placed && r.choices.length).length} · sem som compatível: ${rows.filter((r) => !r.choices.length).length} · já na timeline: ${rows.filter((r) => r.placed).length}`,
      `pack: ${catalog2.sounds} sons · faixas livres a partir da A3: ${free.join(", ") || "nenhuma"}`,
      ...scan.notes.map((note2) => `nota: ${note2}`),
      ...rows.slice(0, 300).map((r) => `som: ${clock(r.event.peak)} ${r.event.kind} · ${r.event.detail} · ${r.event.clip} → ${r.choices[r.pick]?.name ?? "sem som"}${r.enabled ? "" : " (desmarcado)"}`)
    ];
  }
  function markup() {
    return `<div class="zones sd-workspace"><div class="zone" data-controls><div class="field"><div class="field-head"><span class="t-label">Analisar</span><span class="sd-local">TIMELINE</span></div><div data-scope></div></div><div class="field"><div class="field-head"><span class="t-label">Eventos</span></div><div class="sd-kinds">` + Object.keys(LABELS).map((kind) => `<span class="sd-filter" ${CONTROL} data-kind="${kind}" aria-pressed="false">${escapeHtml(LABELS[kind])}</span>`).join("") + `</div><p class="sd-hint">Palavra por palavra: títulos do Textos Animados, um clique por palavra no ritmo da animação. Overlays e efeitos: film burn, flash, glitch e VHS pelo nome do arquivo. Zoom e movimento vêm desligados: ligue se quiser whoosh nos movimentos de câmera.</p></div><div class="field"><div class="field-head"><span class="t-label">Densidade</span></div><div data-density></div><div class="sd-kinds"><span class="sd-filter" ${CONTROL} data-respect aria-pressed="true">Respeitar meus SFX</span></div><p class="sd-hint">Ligado: onde você já pôs um SFX à mão, ele não põe outro.</p></div><div class="field"><div class="field-head"><span class="t-label">SFX baixados em</span></div><div class="sd-folder"><span class="sd-folder-name" data-folder-label>Nenhuma pasta escolhida</span><span class="sd-small" ${CONTROL} data-folder>Trocar…</span></div><p class="sd-hint">Só os sons que entram na timeline são baixados: um arquivo por som, mesmo que ele toque em cem palavras, numa subpasta por categoria. É a mesma pasta dos Efeitos Sonoros.</p></div><div class="field"><div class="field-head"><span class="t-label">Nível dos SFX</span><span class="field-value" data-level-value></span></div><div data-level></div><p class="sd-hint">Níveis suaves para conviver com a fala. Ouça o resultado na timeline.</p></div></div><div class="zone is-wide sd-run"><div class="sd-analyze" ${CONTROL} data-analyze><span data-analyze-label>Analisar e sugerir sons</span> <span aria-hidden="true">→</span></div><p class="sd-progress" data-progress role="status" aria-live="polite"></p><div class="sd-notes" data-notes hidden></div><div class="sd-review"><div class="sd-review-head"><p class="sd-summary" data-summary></p><p class="sd-hint" data-summary-detail></p></div><div class="sd-families" data-templates hidden></div><div class="sd-families" data-families hidden><p class="sd-families-title">Som de cada tipo</p>` + FAMILIES.map((family) => `<div class="sd-family" data-family="${family}" hidden><span class="sd-family-label">${escapeHtml(FAMILY_LABELS[family])}</span><div class="sd-family-pick"><div data-family-pick="${family}"></div></div><span class="sd-small" ${CONTROL} data-family-play="${family}">Ouvir</span></div>`).join("") + `</div><div class="sd-bulk" data-bulk hidden><span class="sd-small" ${CONTROL} data-all>Selecionar todos</span><span class="sd-small" ${CONTROL} data-none>Limpar seleção</span></div><div data-cues></div><div class="sd-pagination" data-pagination hidden><span class="sd-small" ${CONTROL} data-prev>Anterior</span><span data-page></span><span class="sd-small" ${CONTROL} data-next>Próxima</span></div></div><span class="sfx-stage" data-player aria-hidden="true"></span></div></div>`;
  }
  const categories = [
    { id: "edicao", name: "Edição" },
    { id: "texto", name: "Texto" },
    { id: "audio", name: "Áudio" },
    { id: "midia", name: "Mídia" },
    { id: "projeto", name: "Projeto" }
  ];
  const tools = [
    zoomTool,
    silenceTool,
    fillersTool,
    flowTool,
    captionsTool,
    titlesTool,
    translateTool,
    sfxTool,
    soundDesignTool,
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
  const SHAPES = {
    zoom: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
    cut: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    speech: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m14.5 7.5-5 5"/><path d="m9.5 7.5 5 5"/>',
    curve: '<path d="M4 18C10 18 10 6 20 6"/><path d="m4 16 2 2-2 2-2-2 2-2Z"/><path d="m20 4 2 2-2 2-2-2 2-2Z"/>',
    caption: '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
    text: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
    title: '<path d="M3 6V4h10v2"/><path d="M8 4v16"/><path d="M5.5 20h5"/><path d="M18 3v4M16 5h4"/><path d="M19.5 12.5v3M18 14h3"/>',
    download: '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',
    /* Efeitos Sonoros: as barras de um som (Lucide audio-lines). */
    sfx: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
    /* SFX Automático: as mesmas barras, mais baixas, com o brilho de quatro
       pontas que marca o que a ferramenta faz sozinha. */
    "sfx-auto": '<path d="M3 11v4"/><path d="M7 8v10"/><path d="M11 5v16"/><path d="M15 12v6"/><path d="M19 15v2"/><path d="M18.5 2c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z"/>',
    folder: '<path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/><path d="M2 8v11a2 2 0 0 0 2 2h14"/>',
    frame: '<rect x="3" y="3" width="18" height="18" rx="2"/>'
  };
  function glyph(name) {
    const shapes = (SHAPES[name] ?? SHAPES.frame).replace(
      /<(path|circle|line|rect) /g,
      '<$1 fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" '
    );
    return '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor">' + shapes + "</svg>";
  }
  async function guardApplyRun(io) {
    let caught = null;
    try {
      await io.run();
    } catch (cause) {
      caught = { cause };
    }
    try {
      const stale = io.stale();
      if (stale) {
        io.setApplyDisabled(true);
      } else if (caught) {
        io.setApplyDisabled(false);
      } else if (!io.stateOwned()) {
        io.setApplyDisabled(false);
      }
      io.settled();
      if (caught && !stale) {
        io.reportError(caught.cause);
      }
    } catch (recovery) {
      console.error("[Shell] falha ao recuperar o painel após o Apply:", recovery);
    }
  }
  function actionButton(el) {
    let action = null;
    let running = false;
    el.addEventListener("click", () => {
      void run2();
    });
    async function run2() {
      const current2 = action;
      if (!current2 || running || el.disabled) {
        return;
      }
      running = true;
      try {
        await current2();
      } catch (cause) {
        console.error("[Shell] a ação do botão falhou:", cause);
      } finally {
        running = false;
      }
    }
    return {
      set(label, next) {
        el.textContent = label;
        action = next;
      },
      setAction(next) {
        action = next;
      },
      label() {
        return el.textContent ?? "";
      },
      busy() {
        return running;
      }
    };
  }
  const STAGED = ".framelab-new";
  const BACKUP = ".framelab-bak";
  const COMMIT_FROM = 60;
  const COMMIT_SPAN = 35;
  async function installBundle(target2, files, onProgress) {
    if (files.length === 0) {
      return refused("Nenhum arquivo para instalar.");
    }
    const empty2 = files.filter((file) => file.data.byteLength === 0);
    if (empty2.length > 0) {
      return refused(
        `A atualização veio com arquivo vazio (${empty2.map((file) => file.filename).join(", ")}). Nada foi alterado.`
      );
    }
    const staged = [];
    const backups = /* @__PURE__ */ new Map();
    const committed = [];
    onProgress?.("Preparando os arquivos...", 55);
    for (const file of files) {
      const name = `${file.filename}${STAGED}`;
      try {
        await target2.writeFile(name, file.data);
        staged.push(name);
      } catch (cause) {
        await discard(target2, staged, backups);
        return refused(
          `A pasta do plugin não aceitou ${file.filename} (${describe(cause)}). Nada foi alterado.`
        );
      }
    }
    for (const file of files) {
      let held;
      try {
        held = await target2.readFile(file.filename);
      } catch (cause) {
        await discard(target2, staged, backups);
        return refused(
          `Não consegui ler ${file.filename} para guardar uma cópia (${describe(cause)}). Nada foi alterado.`
        );
      }
      backups.set(file.filename, held);
      if (held === null) {
        continue;
      }
      try {
        await target2.writeFile(`${file.filename}${BACKUP}`, held);
      } catch (cause) {
        await discard(target2, staged, backups);
        return refused(
          `Não consegui guardar a cópia de ${file.filename} (${describe(cause)}). Nada foi alterado.`
        );
      }
    }
    for (let at2 = 0; at2 < files.length; at2 += 1) {
      const file = files[at2];
      onProgress?.(
        `Gravando ${file.filename}...`,
        COMMIT_FROM + Math.round(at2 / files.length * COMMIT_SPAN)
      );
      try {
        await replace(target2, file);
        committed.push(file.filename);
      } catch (cause) {
        return await rollback(target2, files, staged, backups, committed, cause);
      }
    }
    await discard(target2, staged, backups);
    onProgress?.("Atualização concluída!", 100);
    return { ok: true, critical: false, message: "", unrestored: [] };
  }
  async function replace(target2, file) {
    const stagedName = `${file.filename}${STAGED}`;
    if (typeof target2.replaceFrom === "function") {
      try {
        await target2.replaceFrom(stagedName, file.filename);
        return;
      } catch (cause) {
        console.warn(`[Updater] rename recusado em ${file.filename}:`, cause);
      }
    }
    await target2.writeFile(file.filename, file.data);
  }
  async function rollback(target2, files, staged, backups, committed, cause) {
    const failed = files.find((file) => !committed.includes(file.filename));
    const unrestored = [];
    for (const name of committed) {
      const held = backups.get(name);
      try {
        if (held === null || held === void 0) {
          await target2.deleteFile(name);
        } else {
          await target2.writeFile(name, held);
        }
      } catch (restoreCause) {
        console.error(`[Updater] não consegui restaurar ${name}:`, restoreCause);
        unrestored.push(name);
      }
    }
    const step2 = failed ? failed.filename : "um arquivo";
    if (unrestored.length === 0) {
      await discard(target2, staged, backups);
      return {
        ok: false,
        critical: false,
        message: `Falha ao gravar ${step2} (${describe(cause)}). A versão anterior foi restaurada e continua funcionando.`,
        unrestored: []
      };
    }
    return {
      ok: false,
      critical: true,
      message: `FALHA CRÍTICA na atualização: ${step2} não foi gravado (${describe(cause)}) e não consegui restaurar ${unrestored.join(", ")}. A instalação está MISTURADA e o painel pode não abrir. Na pasta do plugin, os arquivos terminados em "${BACKUP}" são a versão anterior: renomeie cada um removendo esse sufixo, ou reinstale o plugin pelo instalador do GitHub.`,
      unrestored
    };
  }
  async function discard(target2, staged, backups) {
    for (const name of staged) {
      try {
        await target2.deleteFile(name);
      } catch (cause) {
        console.warn(`[Updater] sobrou ${name} na pasta do plugin:`, cause);
      }
    }
    for (const [name, held] of backups) {
      if (held === null) {
        continue;
      }
      try {
        await target2.deleteFile(`${name}${BACKUP}`);
      } catch (cause) {
        console.warn(`[Updater] sobrou ${name}${BACKUP} na pasta do plugin:`, cause);
      }
    }
  }
  function refused(message) {
    return { ok: false, critical: false, message, unrestored: [] };
  }
  function describe(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  const GITHUB_REPO = "SidyFurtado/framelab";
  function versionTag(version) {
    const clean = version.trim();
    return clean.startsWith("v") ? clean : `v${clean}`;
  }
  const VERSION_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json`;
  class PluginUpdater {
    /**
     * `readHostVersion` é costura de teste: fora dele, é sempre a fonte
     * única do projeto (`bridge/premiere`).
     */
    constructor(currentVersion, readHostVersion = hostVersion) {
      this.latestManifest = null;
      this.checking = false;
      this.currentVersion = currentVersion;
      this.readHostVersion = readHostVersion;
    }
    /**
     * Este Premiere atende o mínimo que a release exige?
     *
     * O campo é OPCIONAL no contrato (`minPremiereVersion?`), então um
     * manifesto antigo que não o traga continua instalável como sempre —
     * ausência não é incompatibilidade.
     *
     * Nos outros casos a dúvida bloqueia: versão do host ilegível ou
     * mínimo mal escrito não liberam a gravação "por via das dúvidas". O
     * caminho manual (Baixar Manual) continua aberto de qualquer forma.
     */
    hostMeets(manifest2) {
      const required = manifest2.minPremiereVersion;
      if (required === void 0 || required === null || required === "") {
        return { ok: true, message: "" };
      }
      const host2 = this.readHostVersion();
      const order = compareVersions(host2, required);
      if (order === null) {
        return {
          ok: false,
          message: host2 ? `Não reconheci a versão do Premiere ("${host2}") para conferir se esta atualização serve. Baixe o instalador pelo GitHub.` : "Não consegui descobrir a versão do Premiere para conferir se esta atualização serve. Baixe o instalador pelo GitHub."
        };
      }
      if (order < 0) {
        return {
          ok: false,
          message: `Esta versão do Framelab requer Adobe Premiere Pro ${required} ou superior. Você está usando ${host2}.`
        };
      }
      return { ok: true, message: "" };
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
        const response = await fetchWithTimeout(
          url,
          { cache: "no-store", headers: { Accept: "application/json" } },
          NET_DEADLINE.manifest
        );
        if (!response.ok) {
          throw new Error(`Servidor respondeu com status ${response.status}`);
        }
        const data = await response.json();
        if (typeof data.version !== "string" || !/^v?\d+(\.\d+){0,3}$/.test(data.version)) {
          throw new Error("version.json com versão em formato inesperado.");
        }
        this.latestManifest = data;
        const hasUpdate = isNewerVersion(data.version, this.currentVersion);
        const fits = this.hostMeets(data);
        if (hasUpdate && !fits.ok) {
          console.warn("[Updater] atualização incompatível com este host:", fits.message);
          return {
            hasUpdate: false,
            currentVersion: this.currentVersion,
            latestVersion: data.version,
            manifest: data,
            error: fits.message
          };
        }
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
      const manifest2 = this.latestManifest;
      if (!manifest2 || !isNewerVersion(manifest2.version, this.currentVersion)) {
        return {
          success: false,
          requiresReload: false,
          message: "Nenhuma atualização disponível no momento."
        };
      }
      const fits = this.hostMeets(manifest2);
      if (!fits.ok) {
        console.error("[Updater] instalação recusada:", fits.message);
        return { success: false, requiresReload: false, message: fits.message };
      }
      onProgress?.("Conectando ao GitHub...", 15);
      try {
        const uxp = getUxpModule();
        if (!uxp?.storage?.localFileSystem) {
          throw new Error("Sistema de arquivos UXP indisponível.");
        }
        const fs = uxp.storage.localFileSystem;
        const pluginFolder = await fs.getPluginFolder();
        const tag = versionTag(manifest2.version);
        const filesToUpdate = manifest2.bundleFiles ?? {
          "manifest.json": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/manifest.json`,
          "index.html": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.html`,
          "index.js": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.js`,
          "index.css": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.css`
        };
        const allowedUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/`;
        const fileEntries = Object.entries(filesToUpdate).filter(
          ([filename, fileUrl2]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) && fileUrl2.startsWith(allowedUrl) && // Um manifesto que aponte de volta para um ramo móvel traz de
          // volta o problema que a tag resolve, então ele é recusado
          // aqui mesmo — inclusive o nosso, se um dia regredir.
          !/^(main|master|HEAD)\//.test(fileUrl2.slice(allowedUrl.length))
        );
        if (fileEntries.length === 0) {
          throw new Error("Manifesto sem arquivos válidos para atualizar.");
        }
        onProgress?.("Baixando a atualização...", 25);
        const downloads = await Promise.all(
          fileEntries.map(async ([filename, fileUrl2]) => {
            const fileResponse = await fetchWithTimeout(
              `${fileUrl2}?_t=${Date.now()}`,
              { cache: "no-store" },
              NET_DEADLINE.media
            );
            if (!fileResponse.ok) {
              throw new Error(`Falha ao baixar ${filename} (${fileResponse.status})`);
            }
            return { filename, data: await fileResponse.arrayBuffer() };
          })
        );
        const outcome = await installBundle(
          pluginTarget(pluginFolder),
          downloads,
          onProgress
        );
        if (!outcome.ok) {
          if (outcome.critical) {
            console.error("[Updater] atualização MISTURADA:", outcome.message);
          }
          return {
            success: false,
            requiresReload: false,
            critical: outcome.critical,
            message: outcome.message
          };
        }
        return {
          success: true,
          requiresReload: true,
          message: `Framelab v${manifest2.version} instalado com sucesso!`
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
  function pluginTarget(folder) {
    const binary = getUxpModule()?.storage?.formats?.binary;
    return {
      async writeFile(name, data) {
        const file = await folder.createFile(name, { overwrite: true });
        if (binary !== void 0) {
          try {
            await file.write(data, { format: binary });
            return;
          } catch (cause) {
            console.warn("[Updater] escrita binária recusada, usando texto:", cause);
          }
        }
        await file.write(decodeUtf8(data));
      },
      async readFile(name) {
        let file;
        try {
          file = await folder.getEntry(name);
        } catch {
          return null;
        }
        let held;
        try {
          held = await file.read(binary !== void 0 ? { format: binary } : void 0);
        } catch {
          held = await file.read({ format: "binary" });
        }
        if (typeof held !== "string") {
          return held;
        }
        return utf8Bytes(held);
      },
      async deleteFile(name) {
        let file;
        try {
          file = await folder.getEntry(name);
        } catch {
          return;
        }
        await file.delete?.();
      },
      async replaceFrom(stagedName, targetName) {
        const file = await folder.getEntry(stagedName);
        if (typeof file.moveTo !== "function") {
          throw new Error("moveTo indisponível nesta build");
        }
        await file.moveTo(folder, { overwrite: true, newName: targetName });
      }
    };
  }
  function utf8Bytes(text2) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(text2).buffer;
    }
    const raw = unescape(encodeURIComponent(text2));
    const bytes = new Uint8Array(raw.length);
    for (let at2 = 0; at2 < raw.length; at2 += 1) {
      bytes[at2] = raw.charCodeAt(at2);
    }
    return bytes.buffer;
  }
  function decodeUtf8(data) {
    if (typeof TextDecoder === "function") {
      return new TextDecoder("utf-8").decode(data);
    }
    const bytes = new Uint8Array(data);
    let out = "";
    for (let at2 = 0; at2 < bytes.length; at2 += 8192) {
      out += String.fromCharCode(...bytes.subarray(at2, at2 + 8192));
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
  function isNewerVersion(candidate, current2) {
    const parse2 = (v) => v.replace(/^v/, "").split("-")[0].split(".").map((part) => parseInt(part, 10) || 0);
    const [cMajor = 0, cMinor = 0, cPatch = 0] = parse2(candidate);
    const [curMajor = 0, curMinor = 0, curPatch = 0] = parse2(current2);
    if (cMajor > curMajor) return true;
    if (cMajor < curMajor) return false;
    if (cMinor > curMinor) return true;
    if (cMinor < curMinor) return false;
    return cPatch > curPatch;
  }
  const PRODUCT_NAME = "Framelab";
  const PRODUCT_TAGLINE = "Premiere";
  const VERSION = "0.5.0";
  const NAV_PREFERENCE = "framelab.navigation.collapsed";
  class ProductShell {
    constructor(root2) {
      this.navPreference = null;
      this.navCompact = false;
      this.narrow = false;
      this.onResize = () => this.updateLayout();
      this.updateBadgeEl = null;
      this.updateModalEl = null;
      this.latestManifest = null;
      this.segmentObserver = null;
      this.applyHandler = null;
      this.applyStateOwned = false;
      this.resetHandler = null;
      this.refreshHandler = null;
      this.activeToolId = null;
      this.toolGeneration = 0;
      this.refreshTimer = null;
      this.refreshInFlight = false;
      this.refreshQueued = false;
      this.query = "";
      this.selection = null;
      this.hostGaps = false;
      this.updater = new PluginUpdater(VERSION);
      this.root = root2;
      this.root.innerHTML = "";
      this.root.className = "shell";
      try {
        const saved = localStorage.getItem(NAV_PREFERENCE);
        this.navPreference = saved === "true" ? true : saved === "false" ? false : null;
      } catch {
      }
      const topbar = document.createElement("header");
      topbar.className = "topbar";
      topbar.innerHTML = `<div class="brand" aria-label="${escapeHtml(PRODUCT_NAME)}"><b>${escapeHtml(PRODUCT_NAME.toLowerCase())}</b><span aria-hidden="true">/</span></div><label class="search">` + searchGlyph() + `<input type="text" placeholder="Buscar ferramenta…" aria-label="Buscar ferramenta" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></label><span class="version" title="build ${"2026-09-29 17:41:55"}">v${VERSION}</span>`;
      this.topbarEl = topbar;
      this.navToggle = createControl("nav-toggle");
      this.navToggle.innerHTML = panelToggleGlyph();
      this.navToggle.setAttribute("aria-controls", "tool-navigation");
      this.navToggle.addEventListener("click", () => this.setNavCompact(!this.navCompact));
      topbar.insertBefore(this.navToggle, topbar.firstChild);
      this.searchInput = topbar.querySelector("input");
      this.searchInput.addEventListener("input", () => {
        this.query = this.searchInput.value;
        this.renderNav();
      });
      this.navEl = document.createElement("nav");
      this.navEl.className = "nav";
      this.navEl.id = "tool-navigation";
      this.navEl.setAttribute("aria-label", "Ferramentas");
      this.navScroll = document.createElement("div");
      this.navScroll.className = "nav-scroll";
      const empty2 = document.createElement("p");
      empty2.className = "nav-empty";
      empty2.textContent = "Nenhuma ferramenta encontrada.";
      const navFooter = document.createElement("div");
      navFooter.className = "nav-footer";
      navFooter.innerHTML = `<span class="nav-footer-mark" aria-hidden="true">${premiereGlyph()}</span><span>${escapeHtml(PRODUCT_TAGLINE)} Pro</span><span class="nav-footer-version" title="build ${"2026-09-29 17:41:55"}">v${VERSION}</span>`;
      this.navEl.append(this.navScroll, empty2, navFooter);
      const work = document.createElement("div");
      work.className = "work";
      const header = document.createElement("div");
      header.className = "work-head";
      this.titleEl = document.createElement("span");
      this.titleEl.className = "work-title";
      this.subtitleEl = document.createElement("span");
      this.subtitleEl.className = "work-subtitle";
      this.chipEl = document.createElement("span");
      this.chipEl.className = "work-chip";
      const refresh = createControl("work-refresh");
      this.refreshButton = refresh;
      refresh.title = "Reler a seleção da timeline";
      refresh.setAttribute("aria-label", "Reler a seleção da timeline");
      refresh.innerHTML = refreshGlyph();
      refresh.addEventListener("click", () => void this.refreshSelection());
      const heading = document.createElement("div");
      heading.className = "work-heading";
      heading.append(this.chipEl, this.titleEl, this.subtitleEl);
      this.helpToggle = createControl("work-help");
      this.helpToggle.innerHTML = helpGlyph();
      this.helpToggle.title = "Como usar esta ferramenta";
      this.helpToggle.setAttribute("aria-label", "Como usar esta ferramenta");
      this.helpToggle.setAttribute("aria-controls", "tool-help");
      this.helpToggle.setAttribute("aria-expanded", "false");
      this.helpToggle.addEventListener("click", () => {
        if (this.hostGaps) return;
        this.calloutEl.hidden = !this.calloutEl.hidden;
        this.helpToggle.setAttribute("aria-expanded", String(!this.calloutEl.hidden));
      });
      header.append(heading, this.helpToggle, refresh);
      this.stateEl = document.createElement("div");
      this.stateEl.className = "work-state";
      this.calloutEl = document.createElement("p");
      this.calloutEl.className = "callout";
      this.calloutEl.id = "tool-help";
      this.calloutEl.hidden = true;
      this.bodyEl = document.createElement("div");
      this.bodyEl.className = "work-body";
      this.bodyEl.addEventListener("click", () => {
        requestAnimationFrame(() => this.syncSegmentGliders());
      });
      if (typeof MutationObserver !== "undefined") {
        this.segmentObserver = new MutationObserver(() => this.syncSegmentGliders());
        this.segmentObserver.observe(this.bodyEl, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["aria-pressed"]
        });
      }
      const actions = document.createElement("div");
      actions.className = "actions";
      const actionDescription = document.createElement("div");
      actionDescription.className = "action-description";
      this.actionSelectionEl = document.createElement("span");
      this.actionSelectionEl.className = "action-selection";
      this.actionSummaryEl = document.createElement("span");
      this.actionSummaryEl.className = "action-summary";
      actionDescription.append(this.actionSelectionEl, this.actionSummaryEl);
      this.resetButton = createControl("btn-reset", "Limpar");
      this.resetButton.hidden = true;
      this.resetButton.addEventListener("click", () => this.resetHandler?.());
      this.applyButton = createControl("btn-apply");
      this.applyLabelEl = document.createElement("span");
      this.applyLabelEl.className = "btn-apply-label";
      this.applyButton.append(this.applyLabelEl);
      this.applyButton.insertAdjacentHTML("beforeend", arrowGlyph());
      setDisabled(this.applyButton, true);
      this.applyButton.addEventListener("click", () => void this.runApply());
      actions.append(actionDescription, this.resetButton, this.applyButton);
      this.scrollEl = document.createElement("div");
      this.scrollEl.className = "work-scroll";
      this.scrollEl.append(this.stateEl, this.calloutEl, this.bodyEl);
      work.append(header, this.scrollEl, actions);
      const main = document.createElement("div");
      main.className = "main";
      const scrim = createControl("nav-scrim");
      scrim.setAttribute("aria-label", "Recolher navegação");
      scrim.addEventListener("click", () => this.setNavCompact(true));
      main.append(this.navEl, scrim, work);
      this.statusEl = document.createElement("footer");
      this.statusEl.className = "statusbar";
      this.statusEl.setAttribute("role", "status");
      this.statusEl.setAttribute("aria-live", "polite");
      this.statusToolEl = document.createElement("span");
      this.statusToolEl.className = "statusbar-tool";
      this.root.append(topbar, main, this.statusEl);
      this.navScroll.addEventListener("click", (event) => this.onNavClick(event));
      bindKeyboard(this.root);
      this.root.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.narrow && !this.navCompact) {
          this.setNavCompact(true);
          this.navToggle.focus();
        }
        if (event.key === "Tab" && this.narrow && !this.navCompact) {
          const controls = [
            ...this.topbarEl.querySelectorAll('input, button, [tabindex="0"]'),
            ...this.navEl.querySelectorAll('[tabindex="0"]')
          ].filter((element) => element.getBoundingClientRect().width > 0);
          const current2 = controls.indexOf(document.activeElement);
          const next = (current2 + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
          if (controls[next]) {
            event.preventDefault();
            controls[next].focus();
          }
        }
      });
      this.updateLayout();
      window.addEventListener("resize", this.onResize);
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
      window.addEventListener("beforeunload", () => {
        window.removeEventListener("resize", this.onResize);
        stopAgentHeartbeat();
        if (this.refreshTimer !== null) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = null;
        }
        try {
          if (this.activeToolId) {
            findTool(this.activeToolId)?.unmount?.();
          }
        } catch {
        }
      });
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
      const manifest2 = this.latestManifest;
      if (!manifest2) return;
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
      const versionTag2 = document.createElement("p");
      versionTag2.className = "update-version-tag";
      versionTag2.innerHTML = `Nova versão <b>v${escapeHtml(manifest2.version)}</b> pronta para instalar. (Versão atual: v${VERSION})`;
      const changelog = document.createElement("div");
      changelog.className = "update-changelog";
      changelog.textContent = manifest2.changelog || "Melhorias de desempenho e estabilidade.";
      const progressWrap = document.createElement("div");
      progressWrap.className = "update-progress-wrap";
      progressWrap.hidden = true;
      progressWrap.innerHTML = '<div class="update-progress-track"><div class="update-progress-fill"></div></div><span class="update-progress-status">Preparando download...</span>';
      body.append(versionTag2, changelog, progressWrap);
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
      const update = actionButton(btnUpdate);
      const btnReload = document.createElement("button");
      btnReload.className = "btn-update-pri";
      btnReload.textContent = "Recarregar Painel";
      btnReload.hidden = true;
      btnReload.addEventListener("click", () => {
        this.updater.reloadPlugin();
      });
      update.set("Atualizar Agora", async () => {
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
          btnUpdate.disabled = false;
          update.set("Tentar via Navegador", () => this.updater.openDownloadPage());
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
      this.calloutEl.hidden = false;
      this.helpToggle.hidden = true;
    }
    // ── navigator ────────────────────────────────────────────
    setNavCompact(compact) {
      this.navPreference = compact;
      try {
        localStorage.setItem(NAV_PREFERENCE, String(compact));
      } catch {
      }
      this.updateLayout();
    }
    updateLayout() {
      const width = this.root.clientWidth || window.innerWidth;
      const previousCompact = this.navCompact;
      this.narrow = width < 600;
      this.navCompact = this.navPreference ?? this.narrow;
      this.root.classList.toggle("is-narrow", this.narrow);
      this.root.classList.toggle("is-nav-compact", this.navCompact);
      const workWidth = width - (this.navCompact || this.narrow ? 56 : 212);
      this.root.classList.toggle("is-work-wide", workWidth >= 640);
      this.root.classList.toggle("is-work-small", workWidth < 330);
      const label = this.navCompact ? "Expandir navegação" : "Recolher navegação";
      this.navToggle.title = label;
      this.navToggle.setAttribute("aria-label", label);
      this.navToggle.setAttribute("aria-expanded", String(!this.navCompact));
      if (previousCompact !== this.navCompact || !this.navScroll.firstChild) {
        this.renderNav();
      }
    }
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
        return `<div class="nav-group"><div class="nav-cat"><span class="nav-cat-name">${escapeHtml(category.name)}</span></div><div class="nav-tools">${list.map((tool) => this.toolMarkup(tool)).join("")}</div></div>`;
      }).join("");
    }
    toolMarkup(tool) {
      const active = tool.id === this.activeToolId;
      return `<div class="nav-tool${active ? " is-active" : ""}" ${CONTROL} data-tool="${tool.id}" data-available="${tool.available}" aria-label="${escapeHtml(tool.name)}" aria-pressed="${active}" title="${escapeHtml(tool.name)} — ${escapeHtml(tool.summary)}"><span class="nav-glyph" aria-hidden="true">${glyph(tool.glyph)}</span><span class="nav-text"><span class="nav-name">${escapeHtml(tool.name)}</span></span></div>`;
    }
    onNavClick(event) {
      const target2 = event.target;
      if (!(target2 instanceof Element)) {
        return;
      }
      const toolButton = target2.closest("[data-tool]");
      if (toolButton?.dataset.tool) {
        this.selectTool(toolButton.dataset.tool);
        if (this.narrow && !this.navCompact) {
          this.setNavCompact(true);
        }
        this.navScroll.querySelector(`[data-tool="${toolButton.dataset.tool}"]`)?.focus();
        return;
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
      this.applyLabelEl.textContent = "Aplicar";
      setDisabled(this.applyButton, true);
      this.titleEl.textContent = tool.name;
      this.subtitleEl.textContent = tool.summary;
      const category = categories.find((entry) => entry.id === tool.category);
      this.chipEl.textContent = category?.name ?? "";
      if (!this.hostGaps) {
        this.calloutEl.textContent = tool.hint;
        this.calloutEl.hidden = true;
        this.helpToggle.setAttribute("aria-expanded", "false");
      }
      this.stateEl.hidden = tool.usesSelection === false;
      this.refreshButton.hidden = tool.usesSelection === false;
      this.statusToolEl.textContent = tool.name;
      this.setStatus("", "idle");
      this.renderNav();
      this.scrollEl.scrollTop = 0;
      this.bodyEl.innerHTML = "";
      tool.mount(this.bodyEl, this.createContext());
      this.syncSegmentGliders();
      this.bodyEl.classList.remove("is-tool-enter");
      void this.bodyEl.offsetWidth;
      this.bodyEl.classList.add("is-tool-enter");
      this.renderApplyCount();
    }
    /**
     * A lâmina móvel da prévia aprovada. A posição vem do aria-pressed que
     * cada Tool já mantém, então o movimento não duplica estado de produto.
     */
    syncSegmentGliders() {
      for (const segment of this.bodyEl.querySelectorAll(".seg")) {
        const children = [...segment.children].filter(
          (child) => child instanceof HTMLElement
        );
        const items = children.filter((child) => child.classList.contains("seg-item"));
        if (items.length < 2) continue;
        let glider = children.find((child) => child.classList.contains("seg-glider"));
        if (!glider) {
          glider = document.createElement("span");
          glider.className = "seg-glider";
          glider.setAttribute("aria-hidden", "true");
          segment.insertBefore(glider, segment.firstChild);
        }
        const selected = items.findIndex(
          (item) => item.getAttribute("aria-pressed") === "true"
        );
        glider.style.width = `calc((100% - 6px) / ${items.length})`;
        glider.hidden = selected < 0;
        if (selected < 0) continue;
        glider.style.transform = `translateX(${selected * 100}%)`;
        segment.classList.add("has-glider");
      }
    }
    createContext() {
      const generation2 = this.toolGeneration;
      const live = () => generation2 === this.toolGeneration;
      return {
        setApplyLabel: (label) => {
          if (!live()) return;
          this.applyLabelEl.textContent = sentenceCase(label);
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
    /**
     * Guards the action button against re-entry while a Tool is running.
     *
     * O que acontece quando a Tool rejeita — e a razão de o botão voltar
     * mesmo com `applyStateOwned` ligado — está em `applyRun.ts`. A
     * decisão mora lá para poder ser provada sem DOM e sem host.
     */
    async runApply() {
      const handler = this.applyHandler;
      if (!handler || isDisabled(this.applyButton)) {
        return;
      }
      this.applyStateOwned = false;
      setDisabled(this.applyButton, true);
      await guardApplyRun({
        run: () => handler(),
        // Hand the control back only if the Tool is still holding it AND
        // did not decide the state itself. Re-enabling unconditionally lit
        // the button up again after a run that left nothing selected.
        stale: () => this.applyHandler !== handler,
        stateOwned: () => this.applyStateOwned,
        setApplyDisabled: (disabled) => setDisabled(this.applyButton, disabled),
        reportError: (cause) => {
          console.error("[Shell] o Apply da ferramenta falhou:", cause);
          const raw = describeError$1(cause).trim();
          this.setStatus(
            raw ? `Falha ao aplicar: ${/[.!?]$/.test(raw) ? raw : `${raw}.`}` : "Falha ao aplicar.",
            "error"
          );
        },
        settled: () => this.renderApplyCount()
      });
    }
    setStatus(text2, tone) {
      this.statusEl.hidden = !text2;
      this.statusEl.className = `statusbar${tone === "done" ? " is-done" : tone === "error" ? " is-error" : ""}`;
      this.statusEl.innerHTML = "";
      if (text2) {
        const message = document.createElement("span");
        message.textContent = text2;
        this.statusEl.append(message);
      }
      this.statusToolEl.hidden = !!text2;
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
    renderApplyCount() {
      const count = this.selection?.selectedCount ?? 0;
      const tool = this.activeToolId ? findTool(this.activeToolId) : void 0;
      this.actionSelectionEl.textContent = tool?.usesSelection === false ? "Pronto para executar" : count === 0 ? "Nenhum clipe selecionado" : `${count} ${count === 1 ? "clipe selecionado" : "clipes selecionados"}`;
      this.actionSummaryEl.textContent = tool?.summary ?? "";
    }
  }
  function sentenceCase(label) {
    const normalized = label.trim().toLocaleLowerCase("pt-BR").replace(/\bsfx\b/g, "SFX");
    return normalized ? normalized[0].toLocaleUpperCase("pt-BR") + normalized.slice(1) : "";
  }
  function formatDuration(seconds2) {
    const whole = Math.max(0, Math.round(seconds2));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  function searchGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path fill="currentColor" fill-rule="evenodd" d="M1.2 1.2h8.4v8.4H1.2V1.2Zm1.5 1.5v5.4h5.4V2.7H2.7Z"/><path fill="currentColor" d="M9.3 10.4 10.4 9.3l2.4 2.4-1.1 1.1z"/></svg>';
  }
  function refreshGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor"><path fill="currentColor" fill-rule="evenodd" d="M2 2h10v3.2h-1.6V3.6H3.6v6.8h6.8V8.8H12V12H2V2Z"/><path fill="currentColor" d="M7.6 7h5.2l-2.6 3.2z"/></svg>';
  }
  function panelToggleGlyph() {
    return '<svg class="panel-toggle-glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1.5 2h13v12h-13V2Zm1.5 1.5v9h2.5v-9H3Zm4 0v9h6v-9H7Z"/><path class="panel-toggle-arrow" fill="currentColor" d="m8.2 6 2 2-2 2V6Z"/></svg>';
  }
  function premiereGlyph() {
    return '<svg viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M1.5 1.5h11v11h-11v-11ZM4 4v6h1.5V8.2h1.2C8.2 8.2 9 7.4 9 6.1S8.2 4 6.7 4H4Zm1.5 1.3h1.1c.6 0 .9.3.9.7s-.3.7-.9.7H5.5V5.8Z"/></svg>';
  }
  function helpGlyph() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.5a5 5 0 1 1 0 10A5 5 0 0 1 8 3Z"/><path fill="currentColor" d="M7.2 10.8h1.6v1.4H7.2zM5.9 6.3c.1-1.4 1-2.2 2.4-2.2 1.3 0 2.2.8 2.2 2 0 .9-.4 1.4-1.3 2-.7.4-.8.7-.8 1.3H7c0-1.1.3-1.7 1.2-2.3.6-.4.8-.6.8-1s-.3-.7-.8-.7c-.6 0-.9.3-.9.9H5.9Z"/></svg>';
  }
  function arrowGlyph() {
    return '<svg class="btn-apply-arrow" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M3 2h9v9h-1.7V4.9L3.6 11.6l-1.2-1.2L9.1 3.7H3V2Z"/></svg>';
  }
  function bootstrap() {
    const root2 = document.getElementById("root");
    if (!root2) {
      return;
    }
    try {
      console.log(`[Framelab] build ${"2026-09-29 17:41:55"}`);
      new ProductShell(root2).start();
    } catch (cause) {
      console.error("[Framelab] falha ao iniciar:", cause);
      renderFatal(root2, cause);
    }
  }
  function renderFatal(root2, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const stack = cause instanceof Error && cause.stack ? cause.stack : "";
    root2.innerHTML = "";
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
    root2.append(panel);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
