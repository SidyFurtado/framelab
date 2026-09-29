/** Pure event detection, sound ranking and lane planning. All times are sequence seconds. */
import type { SfxCatalog, SfxSound, SfxVariant } from "../sfx/pack";

export type EventKind = "word" | "graphic" | "overlay" | "zoom" | "move" | "opacity" | "text" | "cut";
export interface Sample { time: number; value: number[] }
export interface VisualEvent {
  id: string;
  clip: string;
  kind: EventKind;
  start: number;
  peak: number;
  end: number;
  intensity: number;
  detail: string;
  /** The sound family when the element says more than the kind (film burn, flash…). */
  family?: Family;
  /** One line on why this sound is here, for the review list. */
  why?: string;
}
export interface DetectionOptions {
  word: boolean; graphic: boolean; overlay: boolean; zoom: boolean; move: boolean; opacity: boolean; text: boolean; cut: boolean;
  density: "light" | "balanced" | "full";
}
/** Camera motion is off by default: a whoosh on every punch-in is what reads as random. */
export const DEFAULT_OPTIONS: DetectionOptions = {
  word: true, graphic: true, overlay: true, zoom: false, move: false, opacity: false, text: false, cut: false, density: "balanced",
};
/** Also the order of the filter chips. */
export const LABELS: Record<EventKind, string> = {
  word: "Palavra por palavra", graphic: "Entrada de texto", overlay: "Overlays e efeitos", zoom: "Zoom e punch-in",
  move: "Movimento", opacity: "Aparecer / sumir", text: "Troca de texto", cut: "Corte seco",
};
/** A word click must lose to any visual accent that lands on it. */
export const WORD_INTENSITY = 0.18;
export function hash(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));
const seconds = (n: number): string => `${n.toFixed(2).replace(".", ",")} s`;

/** Group a baked curve into movement runs; one event per motion, never per keyframe. */
export function detectMotion(kind: "zoom" | "move" | "opacity", input: readonly Sample[], clip: string, key: string, label: string = LABELS[kind]): VisualEvent[] {
  const samples = input.filter((s) => Number.isFinite(s.time) && s.value.length > 0 && s.value.every(Number.isFinite))
    .slice().sort((a, b) => a.time - b.time);
  const events: VisualEvent[] = [];
  let begin = -1;
  let previous: number[] = [];
  const flush = (last: number): void => {
    if (begin < 0 || last <= begin) return;
    const first = samples[begin], end = samples[last];
    const duration = end.time - first.time;
    const delta = end.value.map((v, i) => v - first.value[i]);
    const amount = kind === "zoom"
      ? Math.abs(end.value[0] / Math.max(0.001, first.value[0]) - 1)
      : Math.hypot(...delta);
    if (!(duration > 0 && duration <= 5) || amount < (kind === "opacity" ? 0.3 : 0.035)) return;
    // Fast movement gets more weight; a gentle push is not a cinematic whip.
    const intensity = clamp(amount / (kind === "opacity" ? 1.2 : 0.5) / Math.sqrt(Math.max(0.15, duration)), 0.12, 1);
    let peak = end.time, fastest = -1;
    for (let i = begin + 1; i <= last; i++) {
      const speed = Math.hypot(...samples[i].value.map((v, j) => v - samples[i - 1].value[j])) /
        Math.max(0.0001, samples[i].time - samples[i - 1].time);
      if (speed > fastest) { fastest = speed; peak = (samples[i].time + samples[i - 1].time) / 2; }
    }
    const detail = kind === "zoom"
      ? `${end.value[0] >= first.value[0] ? "Aproxima" : "Afasta"} ${Math.round(amount * 100)}% · ${seconds(duration)}`
      : kind === "opacity"
        ? `${end.value[0] >= first.value[0] ? "Aparece" : "Some"} · ${seconds(duration)}`
        : `${label} · ${seconds(duration)}`;
    events.push({ id: hash(`${key}|${kind}|${first.time.toFixed(6)}|${end.time.toFixed(6)}`), clip, kind,
      start: first.time, end: end.time, peak, intensity, detail });
  };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (b.time <= a.time || b.value.length !== a.value.length) continue;
    const direction = b.value.map((v, j) => v - a.value[j]);
    const stationary = Math.hypot(...direction) < 1e-6;
    const reversed = previous.length === direction.length && direction.reduce((n, v, j) => n + v * previous[j], 0) < -1e-8;
    if (stationary || reversed) { flush(i - 1); begin = -1; }
    if (!stationary) { if (begin < 0) begin = i - 1; previous = direction; }
    else previous = [];
  }
  flush(samples.length - 1);
  return events;
}

/**
 * A punch-in edit: two touching clips where the framing jumps on the cut.
 * `scaleOut`/`scaleIn` are overall scale factors (1 = 100%).
 */
export function punchEvent(key: string, clip: string, cut: number, scaleOut: number, scaleIn: number): VisualEvent | null {
  if (!(scaleOut > 0) || !(scaleIn > 0) || !Number.isFinite(cut)) return null;
  const jump = scaleIn / scaleOut - 1;
  if (Math.abs(jump) < 0.04) return null;
  return { id: hash(`${key}|punch|${cut.toFixed(6)}`), clip, kind: "zoom", start: cut - 0.18, peak: cut, end: cut + 0.12,
    intensity: clamp(Math.abs(jump) / 0.25, 0.3, 1),
    detail: `Punch no corte · ${Math.round(scaleOut * 100)}% → ${Math.round(scaleIn * 100)}%` };
}

export function selectEvents(events: readonly VisualEvent[], options: DetectionOptions, frame: number): VisualEvent[] {
  const out: VisualEvent[] = [];
  // A title's clicks are one designed run: they never clash with each other. "Discreto" keeps its first word.
  const light = options.density === "light";
  const kept = events.filter((e) => options[e.kind] && !(light && e.kind === "word" && /· palavra (?!1$)\d+$/.test(e.detail)));
  const ranked = kept.slice().sort((a, b) => b.intensity - a.intensity || a.peak - b.peak);
  const spacing = light ? 0.8 : options.density === "balanced" ? 0.25 : frame;
  for (const event of ranked) {
    const clash = out.some((other) => {
      const words = Number(event.kind === "word") + Number(other.kind === "word");
      if (words === 2) return other.clip !== event.clip && Math.abs(other.peak - event.peak) < frame * 0.75;
      // A click can sit next to a film burn or a whoosh, just not on the same frame.
      if (words === 1) return Math.abs(other.peak - event.peak) < frame * 1.5;
      return Math.abs(other.peak - event.peak) < Math.max(frame * 0.75, spacing);
    });
    if (!clash) out.push(event);
  }
  return out.sort((a, b) => a.peak - b.peak);
}

/** A take of the pack. `id` is the Drive file id. */
export interface SoundChoice { id: string; name: string; score: number; sound: SfxSound; variant: SfxVariant }
export type Family = "click" | "whoosh" | "pop" | "impact" | "burn" | "shine" | "shutter" | "glitch";
/** Also the order of the per-family sound pickers. */
export const FAMILY_LABELS: Record<Family, string> = {
  click: "Palavras", whoosh: "Whooshes", pop: "Entradas", impact: "Cortes",
  burn: "Film burn", shine: "Luz", shutter: "Flash", glitch: "Glitch",
};
export function familyOf(kind: EventKind): Family {
  return kind === "zoom" || kind === "move" ? "whoosh" : kind === "word" ? "click" : kind === "cut" ? "impact" : "pop";
}
export const familyFor = (event: VisualEvent): Family => event.family ?? familyOf(event.kind);
interface Taste {
  /** Name words that make a sound usable for this family. */
  fits: RegExp;
  /** Pack folders that hold this family. */
  home: RegExp;
  /** Never for this family, whatever the folder says. */
  never: RegExp;
  /** Name preferences, applied in order. */
  prefer: Array<[RegExp, number]>;
  /** Longest source worth considering, when its length is known. */
  longest: number;
}
/** Tuned on the real pack (Wooshes, Ui, Computer, Hits - impacts …). Names only: folders mix families. */
const TASTES: Record<Family, Taste> = {
  whoosh: {
    fits: /\b(whoosh\w*|woosh\w*|swoosh\w*|swish\w*|swipe|sweep|passagem|giro)\b/,
    home: /\b(wooshes|whooshes|woosh|whoosh|transitions?)\b/,
    never: /\b(explosion|explosao|gears|riser|rise|loop|ambien\w*|music|musica|trilha|coins?|bubble|camera|clock|glitch\w*)\b/,
    prefer: [[/\b(whoosh|woosh|swoosh|swish)\b/, 4], [/\b(pops?|fire|flare|fireball|metal\w*|cymbal)\b/, -2.5],
      [/\bpulsing\b/, -1], [/\b(digital|ui)\b/, -0.5]],
    longest: 4,
  },
  click: {
    fits: /\b(click|clique|mouse|select|button|botao|tap|tick|keyboard|teclado|tecla|enter|pop|bubble)\b/,
    home: /\b(cliques|computer|computador)\b/,
    never: /\b(loop|glitch\w*|hologram|beeps?|counter|data|notification|success|message|riser|rise|whoosh|camera|shutter|clock|coins?|cash|sci|desativar|censura|zing|shine|ticking)\b/,
    prefer: [[/\bclick\b/, 5], [/\b(mouse|select|button|tap)\b/, 2], [/\bpop\b/, 2], [/\bbubble\b/, 1],
      [/\b(keyboard|teclado|mechanical)\b/, -1.5], [/\benter\b/, -0.5]],
    longest: 1.5,
  },
  pop: {
    fits: /\b(pop|popup|bubble|click|select|button|interface|open|snap|swish)\b/,
    home: /\b(pops|bolhas)\b/,
    never: /\b(loop|riser|rise|whoosh|glitch\w*|hologram|beeps?|counter|data|notification|success|message|clock|coins?|cash|camera|sci|desativar|censura|keyboard|teclado)\b/,
    prefer: [[/\bpop\b/, 5], [/\bup\b/, 1], [/\bbubble\b/, 2], [/\b(click|select|button)\b/, 2], [/\b(interface|open)\b/, 1.5], [/\bsnap\b/, 1]],
    longest: 2.5,
  },
  burn: {
    fits: /\b(burn|fire|flare|fireball|match|queima|fogo)\b/,
    home: /$^/,
    never: /\b(loop|riser|explosion|explosao|camera shutter|shutter)\b/,
    prefer: [[/\bfilm\b/, 3], [/\bburn\b/, 3], [/\b(fire|flare)\b/, 1]],
    longest: 5,
  },
  shine: {
    fits: /\b(shine|shining|sparkle|magic|glow|brilho|bell|reverse shine)\b/,
    home: /\b(bells|brilhos)\b/,
    never: /\b(loop|riser|ding)\b/,
    prefer: [[/\b(shine|sparkle)\b/, 2], [/\breverse\b/, 1]],
    longest: 4,
  },
  shutter: {
    fits: /\b(shutter|flash|camera|obturador|foto)\b/,
    home: /\b(cameras?|camera)\b/,
    never: /\b(loop|projector|film burn|burn|rec|setting)\b/,
    prefer: [[/\bshutter\b/, 3], [/\bflash\b/, 2], [/\bclick\b/, 1]],
    longest: 2,
  },
  glitch: {
    fits: /\b(glitch\w*|falha|data|digital|rebobinar|rewind|static)\b/,
    home: /\bglitch\b/,
    never: /\b(loop|counter)\b/,
    prefer: [[/\bglitch\w*\b/, 3], [/\b(falha|rebobinar)\b/, 1]],
    longest: 3,
  },
  impact: {
    fits: /\b(impact|hit|punch|boom|thud|slam|snap|slice|braam|drop)\b/,
    home: /\b(hits?|impacts?|impactos)\b/,
    never: /\b(loop|riser|rise|reverse|explosion|explosao|fireball|ambien\w*|music)\b/,
    prefer: [[/\b(impact|hit|punch)\b/, 4], [/\bboom\b/, 2], [/\bwhoosh\b/, -1]],
    longest: 6,
  },
};
const words = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/([a-z])([0-9])/g, "$1 $2").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Where each family looks in the organized pack (see sfx/taxonomy.ts). With ~8.500 sounds, a click is
 * never searched among animals and sports, and the editor's own "Assinatura" is always a candidate.
 */
export const FAMILY_CATEGORIES: Record<Family, readonly string[]> = {
  whoosh: ["whooshes", "cinematicos"], click: ["cliques", "pops"], pop: ["pops", "cliques"], impact: ["impactos", "cinematicos"],
  burn: ["camera", "fogo"], shine: ["brilhos"], shutter: ["camera"], glitch: ["glitch"],
};

/** Best first. Ties resolve by name, so the same timeline always gets the same sounds. */
export function rankSounds(event: VisualEvent, catalog: SfxCatalog, durationOf: (v: SfxVariant) => number | null): SoundChoice[] {
  const family = familyFor(event);
  const taste = TASTES[family];
  const span = Math.max(0, event.end - event.start);
  const choices: SoundChoice[] = [];
  const wanted = new Set([...FAMILY_CATEGORIES[family], "assinatura"]);
  // A catalog organized some other way (a test, an old snapshot) is searched whole.
  const organized = catalog.categories.some((c) => wanted.has(c.id));
  for (const category of catalog.categories) for (const sound of category.sounds) {
    if (organized && !wanted.has(category.id)) continue;
    if (sound.loop) continue;
    const home = taste.home.test(` ${words(`${category.folder} ${category.label}`)} `);
    for (let i = 0; i < sound.variants.length; i++) {
      const variant = sound.variants[i];
      const name = ` ${words(`${sound.name} ${variant.file.replace(/\.[^.]+$/, "")}`)} `;
      if (taste.never.test(name) || (!home && !taste.fits.test(name))) continue;
      const known = durationOf(variant);
      if (known !== null && (!(known > 0) || known > taste.longest)) continue;
      let score = 10 + (home ? 3 : 0);
      for (const [pattern, weight] of taste.prefer) if (pattern.test(name)) score += weight;
      const heavy = /\b(epic|heavy|big|cinematic|massive|trailer|deep|sub|low|boom|forte)\b/.test(name);
      const soft = /\b(soft|light|subtle|short|small|little|gentle|casual|standard|leve)\b/.test(name);
      const quick = /\b(fast|acute|quick|swish|swoosh|short)\b/.test(name);
      const long = /\b(long|deep|sub|low|epic|slow)\b/.test(name);
      score += heavy ? event.intensity * 4 - 2 : 0;
      score += soft ? (1 - event.intensity) * 3 : 0;
      if (family === "whoosh") {
        // A 0.3 s punch wants a swish; a two-second push can carry a deep pass.
        if (span < 0.45) score += (quick ? 2 : 0) - (long ? 1.5 : 0);
        if (span > 1) score += (long ? 2 : 0) - (quick ? 1 : 0);
      }
      if (known !== null) score -= family === "whoosh" ? Math.max(0, known - 2.5) : Math.max(0, known - 0.8);
      // WAV plays without the converter.
      if (variant.ext === "wav") score += 0.5;
      choices.push({ id: variant.id, sound, variant, name: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, score });
    }
  }
  return choices.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "pt-BR", { numeric: true }) ||
    a.id.localeCompare(b.id));
}

/**
 * Any take of the pack as a choice. The ranking only suggests: the editor may want a camera
 * shutter on every word, and the picker must allow it.
 */
export function choiceById(catalog: SfxCatalog, variantId: string): SoundChoice | null {
  for (const category of catalog.categories) for (const sound of category.sounds) {
    const i = sound.variants.findIndex((v) => v.id === variantId);
    if (i >= 0) return { id: variantId, sound, variant: sound.variants[i], name: `${sound.name}${sound.variants.length > 1 ? ` · ${i + 1}` : ""}`, score: 0 };
  }
  return null;
}

/**
 * Consecutive whooshes and hits rotate through the best close takes, so twelve zooms do not
 * repeat one file. Word clicks stay on the first: one voice for every word.
 */
export function varietyPick(family: Family, choices: readonly SoundChoice[], occurrence: number): number {
  if (family !== "whoosh" && family !== "impact") return 0;
  const best = choices[0]?.score ?? 0;
  const close = choices.slice(0, 4).filter((c) => c.score >= best - 1.5).length;
  return close > 1 ? occurrence % close : 0;
}

export interface Span { start: number; end: number }
export interface AudioLane { index: number; locked: boolean; spans: Span[] }
/**
 * One sound on the timeline: `path` is the SFX file itself (downloaded once, shared by every event that
 * uses it); `inPoint`/`outPoint` cut it in media seconds; `gainDb` goes on the clip's Level.
 */
export interface Placement extends Span { eventId: string; path: string; track: number; inPoint: number; outPoint: number; gainDb: number }
export interface Cue extends Span {
  eventId: string;
  peak: number;
  /** The tail can be cut down to here when the next sound needs the lane. */
  minEnd: number;
  /** Word clicks: placed after every other sound, and left out rather than failing the batch. */
  optional?: boolean;
  track?: number;
}
const overlaps = (a: Span, b: Span): boolean => a.start < b.end - 1e-7 && a.end > b.start + 1e-7;
const clock = (n: number): string => `${Math.floor(n / 60)}:${(n % 60).toFixed(1).padStart(4, "0").replace(".", ",")}`;

/**
 * Lane plan before any file is written. When the lanes run out, the earlier sound's tail is
 * choked at the next start (as a sound designer would), never below its `minEnd`; a sound can
 * also end early where a clip already sits. Optional cues never choke the others.
 */
export function chokeToFit<T extends Cue>(items: readonly T[], lanes: readonly AudioLane[]): { planned: T[]; dropped: T[] } {
  const available = lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => ({ index: l.index, fixed: [...l.spans], planned: [] as T[] }));
  const planned: T[] = [], dropped: T[] = [];
  const order = items.slice().sort((a, b) => Number(!!a.optional) - Number(!!b.optional) || a.start - b.start || a.peak - b.peak);
  for (const source of order) {
    const item = { ...source };
    if (![item.start, item.end, item.peak, item.minEnd].every(Number.isFinite) || item.start < 0 || item.end <= item.start) {
      throw new Error("Intervalo de SFX inválido.");
    }
    item.minEnd = Math.min(item.end, Math.max(item.minEnd, item.start + 1e-3));
    let chosen: { lane: (typeof available)[number]; end: number; choke: T[] } | null = null;
    for (const lane of available) {
      const fixed = lane.fixed.filter((s) => overlaps(s, item));
      const mine = lane.planned.filter((s) => overlaps(s, item));
      if (!fixed.length && !mine.length) { chosen = { lane, end: item.end, choke: [] }; break; }
      if (chosen) continue;
      const before = mine.filter((s) => s.start < item.start - 1e-7);
      const after = [...fixed, ...mine].filter((s) => s.start > item.start + 1e-7);
      if (fixed.length + mine.length !== before.length + after.length) continue;
      if (before.some((s) => s.minEnd > item.start + 1e-7 || (item.optional && !s.optional))) continue;
      const end = after.length ? Math.min(item.end, ...after.map((s) => s.start)) : item.end;
      if (end < item.minEnd - 1e-7) continue;
      chosen = { lane, end, choke: before };
    }
    if (!chosen) {
      if (item.optional) { dropped.push(source); continue; }
      throw new Error(`Falta uma faixa de áudio livre aos ${clock(item.start)}. Adicione uma faixa de áudio a partir da A3 e aplique novamente.`);
    }
    chosen.choke.forEach((s) => { s.end = item.start; });
    item.end = chosen.end;
    item.track = chosen.lane.index;
    chosen.lane.planned.push(item);
    planned.push(item);
  }
  return { planned: planned.sort((a, b) => a.start - b.start), dropped };
}

/** The batch may create tracks: this many at most, and only the ones the plan uses. */
export const MAX_NEW_TRACKS = 8;
/** Lanes as they are, plus empty ones after the last, up to index `upTo`. */
export function withRoom(lanes: readonly AudioLane[], upTo: number): AudioLane[] {
  const out = [...lanes];
  for (let index = lanes.length; index <= upTo; index++) out.push({ index, locked: false, spans: [] });
  return out;
}

/** Reserve all spans before mutation. Voice/music lanes are never a fallback. Planned lanes are tried first. */
export function allocateTracks(items: readonly Omit<Placement, "track">[] | readonly Placement[], lanes: readonly AudioLane[]): Placement[] {
  const available = lanes.filter((l) => l.index >= 2 && !l.locked).map((l) => ({ ...l, spans: [...l.spans] }));
  const planned: Placement[] = [];
  for (const item of (items as ReadonlyArray<Omit<Placement, "track"> & { track?: number }>).slice().sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start) throw new Error("Intervalo de SFX inválido.");
    const free = (l: { spans: Span[] }): boolean => !l.spans.some((s) => overlaps(s, item));
    const hinted = available.find((l) => l.index === item.track);
    const lane = hinted && free(hinted) ? hinted : available.find(free);
    if (!lane) throw new Error("Falta uma faixa livre para os SFX. Adicione uma faixa de áudio a partir da A3 e aplique novamente.");
    lane.spans.push(item);
    planned.push({ eventId: item.eventId, path: item.path, start: item.start, end: item.end, track: lane.index,
      inPoint: item.inPoint, outPoint: item.outPoint, gainDb: item.gainDb });
  }
  return planned;
}

/**
 * Where a sound file goes so its loudest point lands on `peak`: the clip starts on a frame and the
 * in-point absorbs the rest. `pre`/`post` are how much of the file to keep around that point.
 */
export function cutAround(filePeak: number, fileDuration: number, peak: number, pre: number, post: number, frame: number):
  { start: number; inPoint: number; outPoint: number } {
  const lead = Math.max(0, Math.min(pre, filePeak));
  let start = Math.max(0, Math.floor((peak - lead + 1e-9) / frame) * frame);
  let inPoint = filePeak - (peak - start);
  if (inPoint < 0) {
    // Near sequence zero, or a file whose peak comes early: start with the file and lose < 1 frame of sync.
    inPoint = 0;
    start = Math.max(0, Math.floor((peak - filePeak + 1e-9) / frame) * frame);
  }
  const outPoint = Math.min(fileDuration, Math.max(inPoint + frame, filePeak + post));
  return { start, inPoint, outPoint };
}

/** Clips cut the same way from the same file share one in/out setting: one transaction per group. */
export function groupByCut<T extends { path: string; inPoint: number; outPoint: number }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.path}|${Math.round(item.inPoint * 1000)}|${Math.round(item.outPoint * 1000)}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups.values()];
}
