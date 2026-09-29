/**
 * What each clip IS decides its sound — never its keyframes alone.
 *
 * Tools that place SFX precisely do not guess from motion: they voice the elements they know. Every
 * clip becomes an element with an identity: a Framelab title ("TEMPLATE · text", one click per word
 * in the rhythm of the animation), a graphic, an overlay (film burn, flash, glitch…, by file name),
 * an adjustment layer, footage. What has no identity stays silent; camera motion is voiced only when
 * the editor asks for it. Pure: no Premiere here.
 */
import { hash, type EventKind, type Family, type VisualEvent } from "./plan";

export type Role = "title" | "graphic" | "overlay" | "adjustment" | "footage";
export type Identity = "filmburn" | "lightleak" | "flash" | "glitch" | "vhs" | "transition" | "texture";
export interface Element {
  key: string;
  clip: string;
  track: number;
  start: number;
  end: number;
  role: Role;
  /** Media file name, without folders. */
  media: string;
  template?: string;
  text?: string;
  identity?: Identity;
  /** Match names of the effects applied, Motion and Opacity left out. */
  effects: string[];
}
/** A clip above V1: `opaque` footage (a B-roll, an image) hides what moves under it. */
export interface Cover { track: number; start: number; end: number; opaque: boolean }
/** A move slower than this is a drift (a Ken Burns push, a creeping zoom), not a whoosh moment. */
export const WHOOSH_MAX_SECONDS = 0.8;

/** An audio clip the editor placed as a sound effect themselves. */
export interface SfxClip { path: string; name: string; start: number; inPoint: number; duration: number; track: number }

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const plain = (s: string): string => fold(s).replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Framelab's Textos Animados names every title "TEMPLATE · text". */
export function titleOf(name: string): { template: string; text: string } | null {
  const match = /^(.+?) · (.+)$/.exec(name.trim());
  return match ? { template: match[1].trim(), text: match[2].trim() } : null;
}
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
const IDENTITIES: Array<[Identity, RegExp]> = [
  ["filmburn", /\bfilm ?burn|\bburn\b|queima/],
  ["lightleak", /light ?leak|\bleak\b|vazamento/],
  // FilmImpact's Impact Blur is the editor's flash-cut: they voice it with a camera shutter.
  ["flash", /\bflash\b|strobe|\bshutter\b|obturador|impact blur|blur fx|exposure flash/],
  ["glitch", /glitch|rgb split|datamosh/],
  ["vhs", /\bvhs\b|rewind|rebobin/],
  ["transition", /transition|transicao|\bwhip\b|\bswipe\b|swoosh|whoosh|impact (push|slide|zoom|spin|roll|stretch|wipe)/],
  ["texture", /grain|\bdust\b|poeira|scratch|texture|textura|\bnoise\b|old film|film look/],
];
export function identityOf(...names: string[]): Identity | undefined {
  const text = names.map(plain).join(" ");
  return IDENTITIES.find(([, pattern]) => pattern.test(text))?.[0];
}
/** Only identities with one conventional sound; a light leak or a texture has none, and stays silent. */
export const IDENTITY_FAMILY: Partial<Record<Identity, Family>> = {
  filmburn: "burn", flash: "shutter", glitch: "glitch", vhs: "glitch", transition: "whoosh",
};
export const IDENTITY_LABEL: Record<Identity, string> = {
  filmburn: "film burn", lightleak: "light leak", flash: "flash", glitch: "glitch", vhs: "VHS", transition: "transição", texture: "textura",
};

/** A moment that may carry a sound: an element entering, or a motion inside a clip. */
export interface Anchor {
  key: string;
  clip: string;
  role: Role | "motion";
  kind: EventKind;
  /** What kind of moment this is; pieces stacked on several tracks share it and are grouped. */
  sigs: string[];
  time: number;
  start: number;
  end: number;
  /** Where a sound the editor already placed counts as this moment's. */
  from: number;
  to: number;
  words?: number;
  /** Titles: the template and the text, as on the clip. */
  template?: string;
  text?: string;
  family?: Family;
  intensity: number;
  detail: string;
}

const bucket = (seconds: number): string => (Math.round(seconds * 10) / 10).toFixed(1);
/** An adjustment layer that starts with a title and ends with one is the titles' backdrop, not an effect of its own. */
const underTitle = (e: Element, all: readonly Element[], frame: number): boolean =>
  all.some((t) => t.role === "title" && Math.abs(t.start - e.start) < frame) &&
  all.some((t) => t.role === "title" && Math.abs(t.end - e.end) < frame);

export function anchorsOf(elements: readonly Element[], motion: readonly VisualEvent[], frame: number, covers: readonly Cover[] = []): Anchor[] {
  const out: Anchor[] = [];
  for (const e of elements) {
    const base = { key: e.key, clip: e.clip, role: e.role, time: e.start, start: e.start, end: e.end, from: e.start - 0.3, to: e.start + 0.3 };
    if (e.role === "title") {
      const words = wordCount(e.text ?? "");
      out.push({ ...base, kind: "word", sigs: [`title:${plain(e.template ?? "")}`], from: e.start - 0.1, to: e.end - 0.01,
        words, template: e.template, text: e.text, family: "click", intensity: 0.3, detail: `“${(e.text ?? "").slice(0, 48)}” · ${words} palavra${words === 1 ? "" : "s"}` });
    } else if (e.role === "graphic") {
      out.push({ ...base, kind: "graphic", sigs: [`graphic:${plain(e.clip).replace(/\d+/g, "").trim()}`],
        family: e.end - e.start < 1.2 ? "whoosh" : "pop", intensity: 0.3, detail: "Gráfico entra na tela" });
    } else if (e.role === "overlay") {
      out.push({ ...base, kind: "overlay", sigs: [`media:${plain(e.media || e.clip)}`],
        family: e.identity ? IDENTITY_FAMILY[e.identity] : undefined, intensity: 0.5,
        detail: `Overlay de ${e.identity ? IDENTITY_LABEL[e.identity] : "vídeo"} entra` });
    } else if (e.role === "adjustment") {
      const fx = e.effects.slice().sort().join("+") || "sem-efeito";
      const shape = underTitle(e, elements, frame) ? "titulo" : bucket(e.end - e.start);
      out.push({ ...base, kind: "overlay", sigs: [`adjust:${fx}|${shape}`],
        family: e.identity ? IDENTITY_FAMILY[e.identity] : undefined, intensity: 0.45,
        detail: `Adjustment Layer (${bucket(e.end - e.start).replace(".", ",")} s) entra` });
    }
  }
  for (const m of motion) {
    const owner = elements.find((e) => e.clip === m.clip && m.peak >= e.start - 1e-6 && m.peak <= e.end + 1e-6);
    // Titles, graphics and overlays are voiced by what they are, never by their keyframes.
    if (owner && owner.role !== "footage" && owner.role !== "adjustment") continue;
    const role = owner?.role ?? "footage";
    const shape = m.detail.startsWith("Punch") ? "punch" : m.kind;
    // A slow drift is not a moment; only a quick move or a punch cut asks for a whoosh.
    if ((m.kind === "zoom" || m.kind === "move") && shape !== "punch" && m.end - m.start > WHOOSH_MAX_SECONDS) continue;
    // What nobody sees makes no sound: a B-roll above covers V1's punch-ins and zooms. A punch shows its
    // new framing right after the cut, so that is the instant that must be visible.
    const track = owner?.track ?? 0;
    const hidden = (t: number): boolean => covers.some((c) => c.opaque && c.track > track && c.start <= t && c.end > t);
    if (hidden(shape === "punch" ? m.peak + 0.03 : m.peak)) continue;
    out.push({ key: m.id, clip: m.clip, role: "motion", kind: m.kind, sigs: [`motion:${shape}:${role}`, `motion:${shape}`],
      time: m.peak, start: m.start, end: m.end, from: m.peak - 0.3, to: m.peak + 0.2, intensity: m.intensity, detail: m.detail });
  }
  return group(out);
}

/** Pieces of one graphic stacked on several tracks are one moment, not four. */
function group(anchors: Anchor[]): Anchor[] {
  const out: Anchor[] = [];
  for (const a of anchors.slice().sort((x, y) => x.time - y.time)) {
    const twin = out.find((b) => b.sigs[0] === a.sigs[0] && a.role !== "title" && Math.abs(b.time - a.time) < 0.6);
    if (twin) { twin.end = Math.max(twin.end, a.end); twin.to = Math.max(twin.to, a.to); continue; }
    out.push({ ...a });
  }
  return out;
}

/** Moments the editor already voiced by hand: a sound of theirs starts inside the moment's window. */
export function soundedAlready(anchors: readonly Anchor[], clips: readonly SfxClip[]): Set<string> {
  return new Set(anchors.filter((a) => clips.some((c) => c.start >= a.from - 1e-6 && c.start <= a.to + 1e-6)).map((a) => a.key));
}

const snapTo = (n: number, frame: number): number => Math.round(n / frame) * frame;
const WHY: Record<string, string> = {
  title: "Título do Framelab: um clique por palavra, no ritmo da animação",
  graphic: "Gráfico entra na tela",
  overlay: "O som do que o overlay é",
  adjustment: "O som do efeito da Adjustment Layer",
  motion: "Movimento de câmera",
};

/**
 * What a title template asks for: a sound per word (its words appear one after the other), one sound
 * on its entry (it arrives whole), or nothing. The editor can override it per template.
 */
export type TitleMode = "words" | "entry" | "none";
export const templateKey = (template: string): string => plain(template);
export interface TitlePreset {
  mode: TitleMode;
  /** The sound for its words (click, pop) or for its entry (whoosh, glitch, shine…). */
  family: Family;
  /** Seconds from the clip start to the first word, or to the entry. */
  first: number;
  /** Words shown at a steady pace: seconds between two words. Absent: one frame. */
  step?: number;
  /** Letters written one by one: seconds per character; a word sounds when its first letter lands. */
  perLetter?: number;
  /** How it animates, in the editor's words. */
  look: string;
}
const bb = (family: Family, look: string): TitlePreset => ({ mode: "none", family, first: 0.03, look: `legenda em bloco, ${look}` });
/**
 * Every preset of the Textos Animados library, watched frame by frame on its own preview (thumb.mp4,
 * 30 fps) on 2026-09-22. Only CLEAN BLUE and APPLE STYLE reveal whole words in sequence (first at
 * 0,13 s, then every ~0,09 s — the editor's hand-placed clicks agree); ORANGE, REBOTE and REBOUND
 * write letter by letter; the rest arrive whole. The BB captions animate a whole line per cue.
 */
export const TITLE_PRESETS: Record<string, TitlePreset> = {
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
  "bb blur in": bb("whoosh", "desfoque"), "bb bounce": bb("pop", "quica"), "bb drop": bb("pop", "cai"),
  "bb fade down": bb("whoosh", "fade"), "bb fade left": bb("whoosh", "fade"), "bb fade right": bb("whoosh", "fade"),
  "bb fade up": bb("whoosh", "fade"), "bb flip 3d": bb("whoosh", "vira em 3D"), "bb float": bb("whoosh", "flutua"),
  "bb pop": bb("pop", "pop"), "bb slide": bb("whoosh", "desliza"), "bb snap": bb("pop", "estala"),
  "bb spin": bb("whoosh", "gira"), "bb tilt": bb("whoosh", "inclina"), "bb zoom out": bb("whoosh", "zoom"),
};
/** A template the table does not know: the editor's rule — one click per word, one per frame. */
export const UNKNOWN_PRESET: TitlePreset = { mode: "words", family: "click", first: 0.13, look: "modelo novo" };
export const presetFor = (template: string): TitlePreset => TITLE_PRESETS[templateKey(template)] ?? UNKNOWN_PRESET;

/**
 * When each word of a title appears. A steady preset shows one every `step` (one frame when unknown);
 * a letter-by-letter one reaches word i when its first letter lands. Kept inside the clip.
 */
export function wordTimes(text: string, start: number, end: number, preset: TitlePreset, frame: number): number[] {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, 40);
  if (!words.length) return [];
  const offsets: number[] = [];
  if (preset.perLetter) {
    let chars = 0;
    for (const w of words) { offsets.push(chars * preset.perLetter); chars += w.length + 1; }
  } else {
    const step = preset.step ?? frame;
    words.forEach((_, i) => offsets.push(i * step));
  }
  const room = Math.max(frame, end - frame - start - preset.first);
  const last = offsets[offsets.length - 1];
  const squeeze = last > room ? room / last : 1;
  return offsets.map((o) => start + preset.first + o * squeeze);
}

/** The events to sound, from what each element is. Moments the editor already voiced (`done`) are left alone. */
export function eventsFrom(anchors: readonly Anchor[], frame: number, done: ReadonlySet<string> = new Set(),
  titleMode: (template: string) => TitleMode = (t) => presetFor(t).mode): VisualEvent[] {
  const out: VisualEvent[] = [];
  for (const a of anchors) {
    if (done.has(a.key)) continue;
    if (a.role === "title") {
      const preset = presetFor(a.template ?? "");
      const mode = titleMode(a.template ?? "");
      if (mode === "none") continue;
      const why = `${a.template}: ${preset.look}`;
      if (mode === "entry") {
        const peak = Math.max(0, snapTo(a.start + preset.first, frame));
        const family = preset.mode === "entry" ? preset.family : "whoosh";
        out.push({ id: hash(`${a.key}|entry|0`), clip: a.clip, kind: "graphic", start: peak - 0.05, peak, end: peak + 0.3,
          intensity: 0.35, detail: a.detail.replace(/ · \d+ palavras?$/, ""), family, why: `${why} · um som na entrada` });
        continue;
      }
      const family = preset.mode === "words" ? preset.family : "click";
      wordTimes(a.text ?? "", a.start, a.end, preset, frame).forEach((at, i, all) => {
        const peak = Math.max(0, snapTo(at, frame));
        out.push({ id: hash(`${a.key}|${a.kind}|${i}`), clip: a.clip, kind: "word", start: peak - 0.05, peak, end: peak + 0.15,
          intensity: a.intensity, detail: `${a.detail} · palavra ${i + 1}`, family, why: `${why} · ${all.length} palavra${all.length === 1 ? "" : "s"}, ${all.length} ${all.length === 1 ? "som" : "sons"}` });
      });
      continue;
    }
    // Nothing identifies a sound: silence is the congruent answer.
    if (!a.family && a.role !== "motion") continue;
    const why = WHY[a.role] ?? "";
    const push = (at: number, index: number, detail: string): void => {
      const peak = Math.max(0, snapTo(at, frame));
      // Motion keeps its own span (a long push wants a long whoosh); entries are instants.
      const [before, after] = a.role === "motion" ? [a.time - a.start, a.end - a.time] : [0.05, 0.15];
      out.push({ id: hash(`${a.key}|${a.kind}|${index}`), clip: a.clip, kind: a.kind, start: peak - before, peak, end: peak + after,
        intensity: a.intensity, detail, family: a.family, why });
    };
    push(a.time, 0, a.detail);
  }
  return out;
}
