import { sfxSettings } from "../sfx/config";
import { crawlPack } from "../sfx/drive";
import { buildCatalog, fileNameFor, type SfxCatalog } from "../sfx/pack";
import { copiedBytes, copiedFile, copyToDisk, loadManifest, localState, markEmpty, readSnapshot, rememberSeconds, setFolder, writeSnapshot } from "../sfx/store";
import type { SfxFolder } from "../sfx/folder";
import { destinationOf, readDestination } from "../../bridge/destination";
import { dispatch, withdraw } from "../download/runner";
import { readConfig } from "../silence/ffmpeg";
import { batValue, fsModule, isWindows, join, nativePath, readText, shellQuote, wait, workspace, write } from "../silence/workspace";
import { chokeToFit, cutAround, familyFor, type AudioLane, type Cue, type Placement, type SoundChoice, type VisualEvent } from "./plan";
import { decodeWav, measure, type Pcm, type Shape } from "./wave";

export async function soundLibrary(refresh = false, progress: (text: string) => void = () => {}): Promise<SfxCatalog> {
  const config = await sfxSettings.read();
  await loadManifest();
  // Grupo `audio`: a mesma pasta da biblioteca de Efeitos Sonoros, de
  // propósito. Ver `bridge/destination`.
  const held = await readDestination(
    "soundDesign",
    destinationOf(config.folder, config.folderToken)
  ).catch(() => null);
  setFolder(held?.path ? held : null);
  let snapshot = refresh ? null : await readSnapshot(config.pack);
  if (!snapshot) {
    // The big pack is 800 folders: the first read takes about a minute, and says so.
    snapshot = { rootId: config.pack, fetchedAt: Date.now(),
      files: await crawlPack(config.pack, (folders, files) => progress(`Lendo o pack de SFX no Drive (só na primeira vez) · ${folders} pastas · ${files} sons…`)) };
    await writeSnapshot(snapshot);
  }
  const catalog = buildCatalog(snapshot.files);
  // Failed/empty source files must not repeatedly win automatic matching.
  for (const category of catalog.categories) for (const sound of category.sounds) {
    sound.variants = sound.variants.filter((v) => localState(v) !== "empty");
  }
  return catalog;
}

export function conversionScript(input: string, output: string, result: string, ffmpeg: string, windows: boolean, limit = 12): string {
  if (windows) {
    const q = (s: string): string => `"${batValue(s)}"`;
    return ["@echo off", "setlocal DisableDelayedExpansion", `set "FL_FFMPEG=${batValue(ffmpeg)}"`,
      'if "%FL_FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FL_FFMPEG=%%~$PATH:i"',
      `if "%FL_FFMPEG%"=="" (echo missing>${q(result)} & exit /b 1)`,
      `"%FL_FFMPEG%" -nostdin -v error -y -i ${q(input)} -t ${limit} -vn -ac 2 -ar 48000 -c:a pcm_s16le ${q(output)}`,
      `if errorlevel 1 (echo failed>${q(result)}) else (echo ok>${q(result)})`, "exit /b 0", ""].join("\r\n");
  }
  return ["#!/bin/bash", "set -u", `FL_FFMPEG=${shellQuote(ffmpeg)}`,
    'if [ -z "$FL_FFMPEG" ]; then',
    '  for candidate in "$HOME/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg; do',
    '    if [ -x "$candidate" ]; then FL_FFMPEG="$candidate"; break; fi', "  done", "fi",
    'if [ -z "$FL_FFMPEG" ]; then FL_FFMPEG="$(command -v ffmpeg || true)"; fi',
    `if [ -z "$FL_FFMPEG" ]; then printf missing > ${shellQuote(result)}; exit 1; fi`,
    `if "$FL_FFMPEG" -nostdin -v error -y -i ${shellQuote(input)} -t ${limit} -vn -ac 2 -ar 48000 -c:a pcm_s16le ${shellQuote(output)}; then`,
    `  printf ok > ${shellQuote(result)}`, "else", `  printf failed > ${shellQuote(result)}`, "fi", ""].join("\n");
}

async function convert(bytes: ArrayBuffer, ext: string, cancelled: () => boolean, limit = 12): Promise<Pcm> {
  const space = await workspace(), tag = `auto-sfx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const input = `${tag}.${ext}`, output = `${tag}.wav`, result = `${tag}.txt`;
  // A .wav input may itself need conversion (compressed or multichannel WAV).
  const source = `input-${input}`;
  const script = `${tag}.${isWindows() ? "bat" : "command"}`;
  const fs = fsModule();
  if (!fs) throw new Error("Não consegui acessar os arquivos de áudio.");
  await fs.writeFile(join(space.fsBase, source), new Uint8Array(bytes));
  await write(space, script, conversionScript(nativePath(space, source), nativePath(space, output), nativePath(space, result), (await readConfig()).ffmpegPath, isWindows(), limit), true);
  if (cancelled()) throw new Error("Preparação cancelada.");
  const sent = await dispatch(script);
  if (sent.mode === "denied") throw new Error(`Autorize o assistente do Framelab para converter este som: ${sent.error ?? "execução recusada"}.`);
  const deadline = Date.now() + 180000;
  try {
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error("Preparação cancelada.");
      const status = readText(space, result)?.trim();
      if (status === "missing") throw new Error("FFmpeg não encontrado. Configure o caminho em Corte de Silêncios ou escolha um SFX WAV.");
      if (status === "failed") throw new Error("O assistente não conseguiu converter este som. Escolha outra variação.");
      if (status === "ok") {
        const data = fsModule()?.readFileSync(join(space.fsBase, output));
        if (!data || typeof data === "string") throw new Error("O WAV convertido não foi encontrado.");
        return decodeWav(data, limit);
      }
      await wait(300);
    }
    throw new Error("A conversão não respondeu em 3 minutos. Confira o assistente do Framelab.");
  } finally { await withdraw(sent.ticket); }
}

/** `fallbacks` stand in when the chosen file is empty on the Drive (the pack has a few 0-byte uploads). */
export interface CueChoice { event: VisualEvent; choice: SoundChoice; fallbacks: readonly SoundChoice[] }

/**
 * The SFX file itself, downloaded once into the editor's SFX folder (`<pasta>/<Categoria>/<Nome>.ext`),
 * decoded only to measure it. Null when the Drive file is empty (remembered, so the library shows it too).
 */
interface Source { path: string; pcm: Pcm; peak: number; duration: number }
async function load(choice: SoundChoice, catalog: SfxCatalog, cancelled: () => boolean): Promise<Source | null> {
  const category = catalog.categories.find((c) => c.id === choice.sound.category);
  if (!category) throw new Error("O catálogo de sons mudou. Analise novamente.");
  const variant = choice.variant;
  const index = choice.sound.variants.findIndex((v) => v.id === variant.id);
  const copy = await copyToDisk(variant, fileNameFor(category, choice.sound, index));
  if (copy.kind === "empty") { markEmpty(variant); return null; }
  const bytes = copy.data ?? await copiedBytes(variant);
  if (!bytes) throw new Error(`Não consegui ler ${choice.name}.`);
  const path = copiedFile(variant);
  if (!path) throw new Error(`${choice.name} não ficou na pasta dos SFX.`);
  let pcm: Pcm;
  try { pcm = decodeWav(bytes); }
  catch { pcm = await convert(bytes, variant.ext, cancelled); }
  const measured = measure(pcm);
  if (measured.amplitude < 0.00001) return null;
  rememberSeconds(variant, measured.duration);
  return { path, pcm, peak: measured.peakSeconds, duration: measured.duration };
}

/** Loudest sample between two media times, in dBFS. */
function peakDbIn(pcm: Pcm, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * pcm.rate)) * pcm.channels;
  const b = Math.min(pcm.samples.length, Math.ceil(to * pcm.rate) * pcm.channels);
  let max = 0;
  for (let i = a; i < b; i++) max = Math.max(max, Math.abs(pcm.samples[i]));
  return 20 * Math.log10(Math.max(1e-5, max));
}

/** Window, fades and the shortest tail a choke may leave, per family of sound. */
export function shapeFor(event: VisualEvent): Shape & { minTail: number } {
  const clamp = (n: number, low: number, high: number): number => Math.min(high, Math.max(low, n));
  switch (familyFor(event)) {
    case "whoosh":
      return { pre: clamp(event.peak - event.start + 0.12, 0.15, 1.5), post: clamp(event.end - event.peak + 0.45, 0.3, 2),
        fadeIn: 0.06, fadeOut: 0.25, minTail: 0.15 };
    case "click": return { pre: 0.015, post: 0.2, fadeIn: 0.003, fadeOut: 0.05, minTail: 0.06 };
    case "impact": return { pre: 0.05, post: 1.4, fadeIn: 0.01, fadeOut: 0.5, minTail: 0.25 };
    case "burn": return { pre: 0.05, post: 1.1, fadeIn: 0.01, fadeOut: 0.3, minTail: 0.2 };
    case "shine": return { pre: 0.3, post: 1.1, fadeIn: 0.08, fadeOut: 0.35, minTail: 0.2 };
    case "shutter": return { pre: 0.02, post: 0.4, fadeIn: 0.003, fadeOut: 0.08, minTail: 0.08 };
    case "glitch": return { pre: 0.03, post: 0.6, fadeIn: 0.005, fadeOut: 0.1, minTail: 0.1 };
    default: return event.kind === "opacity" ? { pre: 0.08, post: 0.5, fadeIn: 0.02, fadeOut: 0.15, minTail: 0.1 }
      : { pre: 0.03, post: 0.45, fadeIn: 0.005, fadeOut: 0.12, minTail: 0.1 };
  }
}

/** Sample-peak target in dBFS before the editor's offset. Clicks carry less energy per peak, so they sit higher. */
export function levelFor(event: VisualEvent): number {
  switch (familyFor(event)) {
    case "whoosh": return -17 + event.intensity * 6;
    case "impact": return -15 + event.intensity * 6;
    case "click": return -18;
    case "burn": case "glitch": return -18 + event.intensity * 3;
    case "shine": return -21;
    case "shutter": return -16;
    default: return event.kind === "opacity" ? -19 + event.intensity * 3 : -17 + event.intensity * 3;
  }
}

/**
 * Every chosen event as a cut of the SFX file itself: downloaded once per sound (only the sounds used),
 * cut around its loudest point so that point lands on the event's frame, and a gain for the clip's Level.
 * Lanes are planned here, so a choked tail is just an earlier out-point.
 */
export async function prepareSounds(
  cues: readonly CueChoice[], catalog: SfxCatalog, folder: SfxFolder, frame: number, level: number, lanes: readonly AudioLane[],
  progress: (text: string) => void, cancelled: () => boolean,
): Promise<{ placements: Placement[]; dropped: string[]; files: string[] }> {
  setFolder(folder);
  const sources = new Map<string, Source>();
  const empty = new Set<string>();
  const cuts: Array<Cue & { path: string; inPoint: number; gainDb: number; source: Source }> = [];
  for (let i = 0; i < cues.length; i++) {
    if (cancelled()) throw new Error("Preparação cancelada.");
    const { event } = cues[i];
    let source: Source | undefined;
    for (const candidate of [cues[i].choice, ...cues[i].fallbacks].slice(0, 4)) {
      if (empty.has(candidate.id)) continue;
      if (!sources.has(candidate.id)) progress(`Baixando ${candidate.name} (${sources.size + 1})…`);
      source = sources.get(candidate.id) ?? await load(candidate, catalog, cancelled) ?? undefined;
      if (source) { sources.set(candidate.id, source); break; }
      empty.add(candidate.id);
    }
    if (!source) throw new Error(`${cues[i].choice.name} e as alternativas estão vazios no pack. Troque o som deste evento.`);
    const shape = shapeFor(event);
    const cut = cutAround(source.peak, source.duration, event.peak, shape.pre, shape.post, frame);
    const end = cut.start + (cut.outPoint - cut.inPoint);
    const gainDb = Math.max(-40, Math.min(15, levelFor(event) + level - peakDbIn(source.pcm, cut.inPoint, cut.outPoint)));
    const landing = cut.start + (source.peak - cut.inPoint);
    cuts.push({ eventId: event.id, start: cut.start, end, peak: landing, minEnd: Math.min(end, landing + shape.minTail),
      optional: event.kind === "word", path: source.path, inPoint: cut.inPoint, gainDb, source });
  }
  const { planned, dropped } = chokeToFit(cuts, lanes);
  const placements: Placement[] = planned.map((cue) => ({
    eventId: cue.eventId, path: cue.path, start: cue.start, end: cue.end, track: cue.track!,
    inPoint: cue.inPoint, outPoint: cue.inPoint + (cue.end - cue.start), gainDb: cue.gainDb,
  }));
  return { placements, dropped: dropped.map((cue) => cue.eventId), files: [...new Set(placements.map((p) => p.path))] };
}
