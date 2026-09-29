import type { ClipProjectItem, premierepro, Project, Sequence, TickTime, VideoClipTrackItem } from "@adobe/premierepro";
import { getPremiere, readTicksPerFrame } from "../../bridge/premiere";
import { unwrapValue } from "../zoom/diag";
import { detectMotion, hash, punchEvent, type AudioLane, type Sample, type VisualEvent } from "./plan";
import { identityOf, titleOf, type Cover, type Element, type Role, type SfxClip } from "./identity";

export type Scope = "selection" | "sequence";
export interface AudioItem {
  path: string; start: number; end: number; inPoint: number; track: number; name?: string;
}
export interface TimelineScan {
  scope: Scope;
  sequenceId: string;
  sequenceName: string;
  fingerprint: string;
  frame: number;
  clips: number;
  /** The clips this analysis covered: apply re-reads exactly these, whatever is selected by then. */
  keys: string[];
  /** Every clip read, with what it is. */
  elements: Element[];
  /** Keyframed motion, punch-ins and cuts inside the clips. */
  motion: VisualEvent[];
  /** Sound effects the editor already placed by hand. */
  sfx: SfxClip[];
  /** Every video clip above V1 and whether it hides what is under it (footage does; titles, overlays, effects do not). */
  covers: Cover[];
  notes: string[];
  audio: AudioItem[];
  lanes: AudioLane[];
}

/** Where this tool's rendered files live; they are never read as voice. */
const OWN_SFX = /[\\/]Framelab Auto SFX[\\/]FLAuto-/;

export async function activeTimeline(): Promise<{ ppro: premierepro; project: Project; sequence: Sequence; id: string }> {
  const ppro = getPremiere();
  if (!ppro) throw new Error("Abra esta ferramenta dentro do Premiere.");
  const project = await ppro.Project.getActiveProject();
  const sequence = project ? await project.getActiveSequence() : null;
  if (!project || !sequence) throw new Error("Abra uma sequência no Premiere.");
  const id = `${project.guid.toString()}:${sequence.guid.toString()}`;
  if (!id || id.includes("[object Object]")) throw new Error("Não consegui identificar a sequência. Reabra o painel.");
  return { ppro, project, sequence, id };
}

/**
 * A host call that may never settle. In Premiere 26.5 `getProjectItem()` on a .mogrt clip
 * does not deliver an item (see titles/applyCaptions.ts); absence is an answer, not a hang.
 */
function within<T>(call: () => Promise<T>, ms = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    let pending: Promise<T>;
    try { pending = Promise.resolve(call()); } catch { clearTimeout(timer); resolve(null); return; }
    pending.then((value) => { clearTimeout(timer); resolve(value ?? null); }, () => { clearTimeout(timer); resolve(null); });
  });
}

interface Media { path: string; nested: boolean; id: string; clip: ClipProjectItem }
/** Clips whose project item never came: forty .mogrt captions must not cost a minute per re-read. */
const silent = new Set<string>();
async function mediaOf(ppro: premierepro, item: { getProjectItem(): Promise<unknown> }, key?: string): Promise<Media | null> {
  if (key && silent.has(key)) return null;
  const raw = await within(() => item.getProjectItem());
  if (!raw) { if (key) silent.add(key); return null; }
  try {
    const clip = ppro.ClipProjectItem.cast(raw as never);
    const [path, nested] = await Promise.all([clip.getMediaFilePath().catch(() => ""), clip.isSequence().catch(() => false)]);
    let id = "";
    try { id = String((raw as { getId?: () => unknown }).getId?.() ?? ""); } catch { /* optional */ }
    return { path: path ?? "", nested: nested === true, id: id || path || "", clip };
  } catch { return null; }
}

export async function readAudio(ppro: premierepro, sequence: Sequence): Promise<{ audio: AudioItem[]; lanes: AudioLane[] }> {
  const audio: AudioItem[] = [], lanes: AudioLane[] = [];
  const count = await sequence.getAudioTrackCount();
  for (let index = 0; index < count; index++) {
    const track = await sequence.getAudioTrack(index);
    const lock = (track as unknown as { isLocked?: () => Promise<boolean> }).isLocked;
    const locked = typeof lock === "function" ? await lock.call(track) : false;
    const muted = await track.isMuted();
    const spans: Array<{ start: number; end: number }> = [];
    for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      const [start, end, point, media, name] = await Promise.all([item.getStartTime(), item.getEndTime(), item.getInPoint(), mediaOf(ppro, item),
        item.getName().catch(() => "")]);
      if (!Number.isFinite(start.seconds) || !Number.isFinite(end.seconds)) throw new Error(`Não consegui ler a faixa A${index + 1}.`);
      // Nested or unreadable audio still occupies its full span.
      audio.push({ path: media?.path ?? "", start: start.seconds, end: end.seconds, inPoint: point.seconds, track: index, name });
      spans.push({ start: start.seconds, end: end.seconds });
    }
    lanes.push({ index, locked: locked || muted, spans });
  }
  return { audio, lanes };
}

type ParamKind = "zoom" | "move" | "rotate" | "opacity" | "text";
/** `ComponentParam` exposes no matchName, only a localized display name (see zoom/applyZoom.ts). */
export function paramKind(name: string): ParamKind | null {
  const n = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  // The Zoom tool keys Transform > "Scale Height", which is the uniform scale there.
  if (/^(scale|escala|echelle|skalierung|scala)( \(zoom\))?$/.test(n) || /^(scale height|altura da escala|hauteur d'echelle|altura de escala)$/.test(n)) return "zoom";
  if (/^(position|posicao|posicion)$/.test(n)) return "move";
  if (/^(rotation|rotacao|rotacion)$/.test(n)) return "rotate";
  if (/^(opacity|opacidade|opacite|opacidad)$/.test(n)) return "opacity";
  if (/^(source text|texto de origem|texto de origen|text|texto)$/.test(n)) return "text";
  return null;
}
function vector(raw: unknown): number[] | null {
  const value = unwrapValue(raw);
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && Number.isFinite(n))) return value as number[];
  if (value && typeof value === "object") {
    const p = value as { x?: number; y?: number };
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return [p.x!, p.y!];
  }
  return null;
}
/** Solid colours and adjustment layers have no media either; they are not text on screen. */
const NOT_TEXT = /\b(matte|fosco|cor solida|color|colour|black video|video preto|bars|barras|adjust\w*|ajuste|transparent\w*|transparente)\b/i;
/** Match names of text/graphic components and clips. Whole word: "Texturize" is a video effect. */
const TEXTUAL = /\btext\b|capsule|graphic|\bmgt\b/i;

interface Track { clips: Array<{ end: number; scaleOut: number; chosen: boolean; media: string } | null> }

/** No writes. Repeating this scan before apply also checks for trimmed/moved/reanimated clips. */
export async function scanTimeline(
  scope: Scope, progress: (message: string) => void = () => {}, cancelled: () => boolean = () => false,
  only?: ReadonlySet<string>,
): Promise<TimelineScan> {
  const { ppro, sequence, id } = await activeTimeline();
  const scan = await readSequence(ppro, sequence, id, scope, progress, cancelled, only);
  if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou durante a análise. Analise novamente.");
  return scan;
}

async function readSequence(
  ppro: premierepro, sequence: Sequence, id: string, scope: Scope,
  progress: (message: string) => void, cancelled: () => boolean, only?: ReadonlySet<string>,
): Promise<TimelineScan> {
  const ticksPerFrame = await readTicksPerFrame(sequence);
  if (!ticksPerFrame) throw new Error("Não consegui ler a taxa de quadros da sequência.");
  const frame = Number(ticksPerFrame) / 254016000000;
  const rect = await sequence.getFrameSize();
  const width = rect.width, height = rect.height;
  const notes = new Set<string>();
  const events: VisualEvent[] = [];
  const elements: Element[] = [];
  const covers: Cover[] = [];
  const videoMedia = new Set<string>();
  const fingerprints: unknown[] = [];
  const keys: string[] = [];
  let clips = 0;
  const snap = (n: number): number => Math.round(n / frame) * frame;
  const check = (): void => { if (cancelled()) throw new Error("Análise cancelada."); };
  const isChosen = (key: string, selected: boolean): boolean => only ? only.has(key) : scope === "sequence" || selected;
  const trackCount = await sequence.getVideoTrackCount();
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    check();
    const track = await sequence.getVideoTrack(trackIndex);
    const muted = await track.isMuted();
    fingerprints.push([trackIndex, muted]);
    if (muted) continue;
    const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    const lane: Track = { clips: [] };
    for (const clip of items as VideoClipTrackItem[]) {
      check();
      const [selected, disabled, start, end, inPoint, outPoint, speed, reversed, name] = await Promise.all([
        clip.getIsSelected(), clip.isDisabled(), clip.getStartTime(), clip.getEndTime(), clip.getInPoint(),
        clip.getOutPoint(), clip.getSpeed(), clip.isSpeedReversed(), clip.getName(),
      ]);
      const clipKey = `${id}|${trackIndex}|${name}|${start.ticks}|${inPoint.ticks}`;
      const chosen = isChosen(clipKey, selected);
      const preceding = lane.clips[lane.clips.length - 1] ?? null;
      if (!disabled && !chosen && trackIndex > 0) {
        // Outside the analysis but still on screen: a B-roll above hides the motion under it. Named cheaply.
        const light = !!titleOf(name) || /^(graphic|gr[aá]fico|adjustment layer|camada de ajuste)\b/i.test(name.trim()) || !!identityOf(name);
        covers.push({ track: trackIndex, start: start.seconds, end: end.seconds, opaque: !light });
      }
      if (disabled || !chosen) { lane.clips.push(disabled ? null : { end: end.seconds, scaleOut: 1, chosen: false, media: "" }); continue; }
      clips++;
      keys.push(clipKey);
      progress(`Lendo V${trackIndex + 1} · ${name} (${clips})…`);
      const signature: unknown[] = [clipKey, end.ticks, outPoint.ticks, speed, reversed];
      fingerprints.push(signature);
      if (![start.seconds, end.seconds, inPoint.seconds, outPoint.seconds, speed].every(Number.isFinite)) throw new Error(`Tempo ilegível: ${name}.`);
      if (speed !== 1 || reversed) {
        notes.add("Clipes com velocidade alterada ou reprodução reversa foram ignorados.");
        lane.clips.push(null);
        continue;
      }
      // Exact time for speed measurements; events are snapped to the frame grid once detected.
      const toSequence = (time: TickTime): number => start.seconds + time.seconds - inPoint.seconds;
      const onGrid = (list: VisualEvent[]): VisualEvent[] => list.map((e) => ({ ...e, start: snap(e.start), peak: snap(e.peak), end: snap(e.end) }));
      const pointEvent = (kind: "cut" | "text", time: number, detail: string, intensity: number): void => {
        const peak = snap(time);
        events.push({ id: hash(`${clipKey}|${kind}|${peak.toFixed(6)}`), clip: name, kind,
          start: peak, end: peak + 0.15, peak, intensity, detail });
      };

      // Is this text on screen? .mogrt clips answer by not answering (no project item in 26.5),
      // which only counts above V1: a slow host must not turn the talking head into a caption.
      let graphic = false;
      const adjustment = (await clip.isAdjustmentLayer().catch(() => false)) || /^(adjustment layer|camada de ajuste)\b/i.test(name.trim());
      const media = adjustment ? null : await mediaOf(ppro, clip, clipKey);
      if (!adjustment) {
        signature.push(media?.path ?? null);
        if (!media) graphic = trackIndex > 0 && !NOT_TEXT.test(name);
        else {
          if (media.nested) notes.add("Sequências aninhadas: somente os efeitos externos são lidos.");
          graphic = /\.(mogrt|aegraphic)$/i.test(media.path) ||
            (!media.path && !media.nested && trackIndex > 0 && !NOT_TEXT.test(name));
        }
        const match = await clip.getMatchName().catch(() => "");
        if (TEXTUAL.test(match)) graphic = true;
      }

      if (media?.path) videoMedia.add(media.path);
      let scaleIn = 1, scaleOut = 1;
      const effects: string[] = [], effectNames: string[] = [];
      const chain = await clip.getComponentChain();
      const count = await chain.getComponentCount();
      for (let ci = 0; ci < count; ci++) {
        check();
        const component = await chain.getComponentAtIndex(ci);
        if (!component) continue;
        const match = await component.getMatchName().catch(() => "");
        if (match && !/^(ae\.)?adbe (motion|opacity)$/i.test(match.trim())) {
          effects.push(match);
          // Optional: a component without a display name still has a match name.
          const named = (component as unknown as { getDisplayName?: () => Promise<string> }).getDisplayName;
          effectNames.push(typeof named === "function" ? await named.call(component).catch(() => "") : "");
        }
        // Avoid effect parameters named Scale/Position with unrelated semantics.
        const nativeMotion = /motion|geometry2|opacity/i.test(match);
        if (TEXTUAL.test(match)) graphic = !adjustment;
        const paramCount = await component.getParamCount();
        for (let pi = 0; pi < paramCount; pi++) {
          check();
          const param = await component.getParam(pi);
          const kind = paramKind(param.displayName);
          if (!kind || (!nativeMotion && kind !== "text")) continue;
          if (kind === "text" && (trackIndex > 0 || TEXTUAL.test(match))) graphic = !adjustment;
          let times: TickTime[];
          try { times = await Promise.resolve(param.getKeyframeListAsTickTimes()); }
          catch { notes.add(`Parâmetro sem leitura de keyframes: ${name} · ${param.displayName}.`); continue; }
          if (kind === "zoom" && times.length < 2) {
            // A static scale still frames the shot: it is what a punch-in cut jumps from.
            const value = vector(await param.getValueAtTime(inPoint).catch(() => null));
            if (value?.length === 1 && value[0] > 0) { scaleIn *= value[0] / 100; scaleOut *= value[0] / 100; signature.push([ci, pi, value[0]]); }
            continue;
          }
          if (times.length < (kind === "text" ? 1 : 2)) continue;
          if (times.length > 1500) { notes.add(`Animação muito densa ignorada: ${name} · ${param.displayName}.`); continue; }
          const points = new Map<string, TickTime>();
          points.set(inPoint.ticks, inPoint);
          for (const time of times) if (time.seconds >= inPoint.seconds && time.seconds < outPoint.seconds) points.set(time.ticks, time);
          // Last visible frame, so a key on the out boundary cannot leak into the next clip.
          const last = ppro.TickTime.createWithSeconds(Math.max(inPoint.seconds, outPoint.seconds - frame));
          points.set(last.ticks, last);
          let ordered = [...points.values()].sort((a, b) => a.seconds - b.seconds);
          if (kind !== "text" && ordered.length <= 24) {
            // Two keys with a Bezier ease hide where the motion is fastest; a few inner reads find it.
            const dense: TickTime[] = [];
            for (let i = 0; i < ordered.length; i++) {
              dense.push(ordered[i]);
              const next = ordered[i + 1];
              if (!next) continue;
              const steps = Math.min(6, Math.floor((next.seconds - ordered[i].seconds) / frame) - 1);
              for (let s = 1; s <= steps; s++) dense.push(ppro.TickTime.createWithSeconds(ordered[i].seconds + (next.seconds - ordered[i].seconds) * s / (steps + 1)));
            }
            ordered = dense;
          }
          const samples: Sample[] = [];
          let textValue: string | null = null;
          const values: unknown[] = [];
          let unreadable = false;
          for (const time of ordered) {
            check();
            let raw: unknown;
            try { raw = unwrapValue(await param.getValueAtTime(time)); }
            catch { unreadable = true; break; }
            const at = toSequence(time);
            values.push([time.ticks, raw]);
            if (kind === "text") {
              // Structured MOGRT text is intentionally not guessed from JSON.
              if (typeof raw === "string" && raw.trim() && !/^\s*[\[{]/.test(raw)) {
                if (textValue !== null && textValue !== raw) pointEvent("text", at, `Texto: ${raw.slice(0, 80)}`, 0.25);
                textValue = raw;
              }
              continue;
            }
            const value = vector(raw);
            if (!value || (kind === "move" ? value.length !== 2 : value.length !== 1)) { unreadable = true; break; }
            samples.push({ time: at, value });
          }
          signature.push([ci, match, pi, values, unreadable]);
          if (unreadable) { notes.add(`Animação ilegível ignorada: ${name} · ${param.displayName}.`); continue; }
          if (kind === "text" || !samples.length) continue;
          if (kind === "zoom") {
            if (samples[0].value[0] > 0) scaleIn *= samples[0].value[0] / 100;
            if (samples[samples.length - 1].value[0] > 0) scaleOut *= samples[samples.length - 1].value[0] / 100;
          }
          if (kind === "opacity") {
            const max = Math.max(...samples.map((s) => s.value[0]));
            if (max > 1.01) samples.forEach((s) => { s.value[0] /= 100; });
          }
          if (kind === "move") {
            const max = Math.max(...samples.flatMap((s) => s.value.map(Math.abs)));
            if (max > 4 && width > 0 && height > 0) samples.forEach((s) => { s.value = [s.value[0] / width, s.value[1] / height]; });
          }
          if (kind === "rotate") {
            // A quarter turn weighs like a quarter-frame slide.
            samples.forEach((s) => { s.value = [s.value[0] / 360]; });
            events.push(...onGrid(detectMotion("move", samples, name, `${clipKey}|${ci}|${pi}`, "Giro")));
            continue;
          }
          events.push(...onGrid(detectMotion(kind, samples, name, `${clipKey}|${ci}|${pi}`)));
        }
      }

      const touching = preceding && Math.abs(preceding.end - start.seconds) < frame / 2;
      if (touching && preceding.chosen) {
        // Same footage on both sides: a reframe. A new shot at another scale is just a cut.
        const sameShot = !!media?.path && preceding.media === media.path;
        const punch = sameShot ? punchEvent(clipKey, name, snap(start.seconds), preceding.scaleOut, scaleIn) : null;
        if (punch) events.push(punch);
        else pointEvent("cut", start.seconds, "Encontro entre clipes na mesma faixa", 0.45);
      }
      // What the clip is decides its sound; its keyframes only speak for footage.
      const file = (media?.path ?? "").split(/[\\/]/).pop() ?? "";
      const title = titleOf(name);
      // Premiere answers "adjustment layer" for its own Graphic clips too; their effects say otherwise.
      const drawn = effects.some((fx) => /graphic group|\btext\b|\bshape\b|capsule/i.test(fx));
      const effect = adjustment && !drawn;
      const identity = effect ? identityOf(...effects, ...effectNames, name) : identityOf(name, file);
      const role: Role = title && (graphic || drawn || !media?.path) ? "title"
        : effect ? "adjustment"
        // A named overlay (a light leak .mogrt, a film burn clip) is what it is, not just "a graphic".
        : trackIndex > 0 && identity ? "overlay"
        : graphic || drawn ? "graphic"
        : "footage";
      elements.push({ key: clipKey, clip: name, track: trackIndex, start: snap(start.seconds), end: snap(end.seconds), role, media: file,
        template: title?.template, text: title?.text, identity, effects });
      if (trackIndex > 0) covers.push({ track: trackIndex, start: start.seconds, end: end.seconds, opaque: role === "footage" });
      lane.clips.push({ end: end.seconds, scaleOut, chosen: true, media: media?.path ?? "" });
    }
  }

  // Caption tracks (C1, C2…) are never read: plain subtitles do not animate, and no editor
  // puts SFX on them.
  check();
  const audio = await readAudio(ppro, sequence);
  // The editor's own sound effects: short clips that are neither the footage's sound nor ours.
  const sfx: SfxClip[] = audio.audio
    .filter((a) => a.path && !OWN_SFX.test(a.path) && !videoMedia.has(a.path) && a.end - a.start <= 8 && a.end > a.start)
    .map((a) => ({ path: a.path, name: a.name || a.path.split(/[\\/]/).pop() || "SFX", start: a.start, inPoint: a.inPoint,
      duration: a.end - a.start, track: a.track }));
  return { scope, sequenceId: id, sequenceName: sequence.name, frame, clips, keys, elements, motion: events, sfx, covers,
    fingerprint: hash(JSON.stringify([id, frame, width, height, fingerprints])), notes: [...notes], ...audio };
}

/** The generated filename carries event identity even after reopening the project. */
export function alreadyPlaced(eventId: string, audio: readonly AudioItem[]): boolean {
  return audio.some((a) => a.path.replace(/\\/g, "/").split("/").pop()?.startsWith(`FLAuto-${eventId}-`));
}
