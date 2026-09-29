import type { AudioClipTrackItem, ComponentParam, premierepro, Project, ProjectItem, Sequence, TrackItemSelection } from "@adobe/premierepro";
import { commit, projectItemsFor } from "../sfx/insert";
import { resolveEditor } from "../titles/applyTitles";
import { readText, wait, workspace, write } from "../silence/workspace";
import { allocateTracks, groupByCut, withRoom, type Placement } from "./plan";
import { activeTimeline, readAudio, scanTimeline, type AudioItem, type TimelineScan } from "./scan";
import { unwrapValue } from "../zoom/diag";

export interface BatchSnapshot { sequenceId: string; frame: number; items: Placement[] }
const LAST_BATCH = "sound-design-last-batch.json";
let busy = false;
let lastBatch: BatchSnapshot | null = null;
const canonical = (s: string): string => s.replace(/\\/g, "/").normalize("NFC");

/**
 * This batch's clip where it was put. The file name is unique per event and batch, so path, track and
 * start identify it; the end is not compared (the host may round a WAV's length, and a trimmed SFX is
 * still this batch's SFX). A clip moved elsewhere counts as the editor's and is left alone.
 */
export function samePlacement(item: AudioItem, planned: Placement, frame: number): boolean {
  return canonical(item.path) === canonical(planned.path) && item.track === planned.track &&
    Math.abs(item.start - planned.start) < frame / 2;
}

/** An error that carries what the read-back saw, for the report. */
export class ReadbackError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[]) { super(message); this.details = details; }
}
const at = (n: number): string => `${Math.floor(n / 60)}:${(n % 60).toFixed(2).padStart(5, "0")}`;

/**
 * `executeTransaction` returns before a large batch is laid down: 506 overwrites read back as 23 right
 * after the commit while the editor saw them all arrive. Read until the count is complete or stops moving.
 */
async function settle(count: () => Promise<number>, total: number, budgetMs = 15000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let last = -1, still = 0, now = await count();
  while (now !== total && Date.now() < deadline) {
    still = now === last ? still + 1 : 0;
    if (still >= 3) break;
    last = now;
    await wait(700);
    now = await count();
  }
  return now;
}

export async function readLastBatch(): Promise<BatchSnapshot | null> {
  if (lastBatch) return lastBatch;
  try {
    const raw = readText(await workspace(), LAST_BATCH);
    if (!raw) return null;
    const data = JSON.parse(raw) as BatchSnapshot;
    if (typeof data.sequenceId !== "string" || !Number.isFinite(data.frame) || data.frame <= 0 || !Array.isArray(data.items) || data.items.length > 1000) return null;
    if (!data.items.every((p) => typeof p.path === "string" && p.path.length > 0 &&
      typeof p.eventId === "string" && Number.isInteger(p.track) && p.track >= 2 && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end > p.start)) return null;
    lastBatch = data;
    return data;
  } catch { return null; }
}
async function saveBatch(batch: BatchSnapshot): Promise<void> {
  lastBatch = batch;
  await write(await workspace(), LAST_BATCH, JSON.stringify(batch));
}

type Editor = NonNullable<ReturnType<typeof resolveEditor>>;
/**
 * The removal proven in this Premiere, copied from Corte de Silêncios (applySilence.ts). The
 * selection lives only inside its callback, so the transaction runs there. `addItem` answers false
 * in 26.5 even when it adds (measured: the batch died here with the placeholder still selectable),
 * so callers check the timeline afterwards, never this return.
 */
function removeItems(ppro: premierepro, project: Project, editor: Editor, items: readonly AudioClipTrackItem[], label: string): boolean {
  if (!items.length) return true;
  const remove = (selection: TrackItemSelection): boolean => {
    for (const item of items) selection.addItem(item, true);
    return commit(project, label, (tx) => {
      tx.addAction(editor.createRemoveItemsAction(selection, false, ppro.Constants.MediaType.ANY));
    });
  };
  let ok = false;
  try { ppro.TrackItemSelection.createEmptySelection((selection) => { ok = remove(selection); }); }
  catch { ok = false; }
  if (ok) return true;
  // Some builds refuse a transaction inside the callback: build the selection there, commit outside.
  let held: TrackItemSelection | null = null;
  ppro.TrackItemSelection.createEmptySelection((selection) => { held = selection; });
  return held ? remove(held) : false;
}

/**
 * Empty audio tracks after the last one. UXP has no "add track" action (not even in the 27 beta);
 * the one documented way is an insert aimed past the last track. The placeholder goes one second
 * after the end of the sequence, where an insert has nothing to push, and is removed right away.
 */
export async function addAudioTracks(ppro: premierepro, project: Project, sequence: Sequence, editor: Editor,
  placeholder: ProjectItem, path: string, needed: number, progress: (text: string) => void): Promise<void> {
  const at = (await sequence.getEndTime()).seconds + 1;
  for (let k = 0; k < needed; k++) {
    const index = await sequence.getAudioTrackCount();
    progress(`Criando faixa de áudio A${index + 1}…`);
    const ok = commit(project, "SFX Automático — criar faixa de áudio", (tx) => {
      tx.addAction(editor.createInsertProjectItemAction(placeholder, ppro.TickTime.createWithSeconds(at), 0, index, true));
    });
    const created = (await sequence.getAudioTrackCount()) > index;
    // Wherever the placeholder landed, it goes; the timeline read back is the proof.
    const strays = async (): Promise<AudioClipTrackItem[]> => {
      const found: AudioClipTrackItem[] = [];
      const count = await sequence.getAudioTrackCount();
      for (let ti = 0; ti < count; ti++) {
        for (const item of await (await sequence.getAudioTrack(ti)).getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
          if (Math.abs((await item.getStartTime()).seconds - at) > 0.01) continue;
          let media = "";
          try { media = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath(); } catch { continue; }
          if (canonical(media) === canonical(path)) found.push(item as AudioClipTrackItem);
        }
      }
      return found;
    };
    const left = await strays();
    if (left.length) removeItems(ppro, project, editor, left, "SFX Automático — limpar marcador de faixa");
    if (left.length && (await strays()).length) {
      throw new Error(`Sobrou um marcador depois do fim da sequência (${path.split(/[\\/]/).pop()}), na faixa nova. Apague-o e aplique de novo.`);
    }
    if (!ok || !created) {
      throw new Error(`O Premiere não criou a faixa A${index + 1}. Adicione ${needed - k} faixa(s) de áudio (botão direito no cabeçalho das faixas › Adicionar faixas) e aplique de novo.`);
    }
  }
}

/** Events already on the timeline, across batches: the file does not say which event it voices any more. */
const PLACED = "sound-design-placed.json";
let placed: Map<string, { path: string; start: number; track: number }> | null = null;
export async function loadPlaced(): Promise<void> {
  if (placed) return;
  placed = new Map();
  try {
    const raw = readText(await workspace(), PLACED);
    const list = raw ? JSON.parse(raw) as Array<[string, { path: string; start: number; track: number }]> : [];
    for (const [id, where] of list) if (typeof id === "string" && typeof where?.path === "string") placed.set(id, where);
  } catch { /* an unreadable history only means "nothing placed yet" */ }
}
async function remember(items: readonly Placement[]): Promise<void> {
  await loadPlaced();
  for (const p of items) placed!.set(p.eventId, { path: p.path, start: p.start, track: p.track });
  const list = [...placed!].slice(-4000);
  await write(await workspace(), PLACED, JSON.stringify(list));
}
/** This event's sound is still where it was put. */
export function isPlaced(eventId: string, audio: readonly AudioItem[], frame: number): boolean {
  const where = placed?.get(eventId);
  return !!where && audio.some((a) => canonical(a.path) === canonical(where.path) && a.track === where.track && Math.abs(a.start - where.start) < frame / 2);
}
const onTimeline = (p: Placement, audio: readonly AudioItem[], frame: number): boolean => audio.some((a) => samePlacement(a, p, frame));

/**
 * Cuts of the same file go to the timeline through the file's own project item: its in/out is set in one
 * transaction and the overwrites happen in the next (the order Corte de Silêncios proved), group by group.
 * In/out is cleared at the end, so dragging the item from the bin later gives the whole sound.
 */
export async function placeCuts(ppro: premierepro, project: Project, editor: Editor, planned: readonly Placement[], items: Map<string, ProjectItem>): Promise<void> {
  const label = "SFX Automático — inserir SFX";
  const overwrite = (tx: { addAction(a: unknown): void }, group: readonly Placement[]): void => {
    for (const p of group) tx.addAction(editor.createOverwriteItemAction(items.get(p.path)!, ppro.TickTime.createWithSeconds(p.start), 0, p.track));
  };
  let previous: Placement[] | null = null;
  for (const group of groupByCut(planned)) {
    const clip = ppro.ClipProjectItem.cast(items.get(group[0].path)!);
    const before = previous;
    const ok = commit(project, label, (tx) => {
      if (before) overwrite(tx as never, before);
      tx.addAction(clip.createClearInOutPointsAction());
      tx.addAction(clip.createSetInOutPointsAction(ppro.TickTime.createWithSeconds(group[0].inPoint), ppro.TickTime.createWithSeconds(group[0].outPoint)));
    });
    if (!ok) throw new Error("O Premiere recusou o lote. Confira as faixas travadas e analise novamente; use Remover último lote se algum som entrou.");
    previous = group;
  }
  const last = previous;
  const ok = commit(project, label, (tx) => {
    if (last) overwrite(tx as never, last);
    for (const path of new Set(planned.map((p) => p.path))) tx.addAction(ppro.ClipProjectItem.cast(items.get(path)!).createClearInOutPointsAction());
  });
  if (!ok) throw new Error("O Premiere recusou o lote. Confira as faixas travadas e analise novamente; use Remover último lote se algum som entrou.");
}

/**
 * Each clip's Level, set to its gain. The unit is read, not assumed: a fresh clip sits at 0 dB, so the
 * value it reports says whether Level is linear (1), Premiere's amplitude scale (0 dB = 0.178, +15 dB = 1)
 * or decibels (0). Best effort: a Premiere that refuses leaves the files at their own level, and says so.
 */
async function applyGains(ppro: premierepro, project: Project, sequence: Sequence, planned: readonly Placement[], frame: number): Promise<{ set: number; note: string }> {
  try {
    const found: Array<{ param: ComponentParam; gainDb: number }> = [];
    for (const index of new Set(planned.map((p) => p.track))) {
      const track = await sequence.getAudioTrack(index);
      for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        const start = (await item.getStartTime()).seconds;
        const mine = planned.filter((p) => p.track === index && Math.abs(p.start - start) < frame / 2);
        if (!mine.length) continue;
        let path = "";
        try { path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath(); } catch { continue; }
        const p = mine.find((m) => canonical(m.path) === canonical(path));
        if (!p) continue;
        const chain = await (item as AudioClipTrackItem).getComponentChain();
        const count = await Promise.resolve(chain.getComponentCount());
        for (let ci = 0; ci < count; ci++) {
          const component = await Promise.resolve(chain.getComponentAtIndex(ci));
          const name = `${await component.getDisplayName().catch(() => "")} ${await component.getMatchName().catch(() => "")}`;
          if (!/volume/i.test(name) || /channel/i.test(name)) continue;
          const params = await Promise.resolve(component.getParamCount());
          for (let pi = 0; pi < params; pi++) {
            const param = await Promise.resolve(component.getParam(pi));
            if (/^(level|n[ií]vel)$/i.test((param.displayName ?? "").trim())) { found.push({ param, gainDb: p.gainDb }); break; }
          }
          break;
        }
      }
    }
    if (!found.length) return { set: 0, note: "o volume dos clipes não apareceu para o plugin; os SFX ficaram no nível do arquivo" };
    const zero = Number(unwrapValue(await found[0].param.getValueAtTime(ppro.TickTime.createWithSeconds(0))));
    const scale = (db: number): number | null =>
      zero > 0.1 && zero < 0.3 ? Math.min(1, zero * Math.pow(10, db / 20))
      : zero > 0.9 && zero < 1.1 ? Math.pow(10, db / 20)
      : Math.abs(zero) < 1e-3 ? db
      : null;
    if (scale(0) === null) return { set: 0, note: `o Level veio num formato desconhecido (${zero}); os SFX ficaram no nível do arquivo` };
    const ok = commit(project, "SFX Automático — volume dos SFX", (tx) => {
      for (const { param, gainDb } of found) {
        if (param.isTimeVarying()) tx.addAction(param.createSetTimeVaryingAction(false));
        tx.addAction(param.createSetValueAction(param.createKeyframe(scale(gainDb)!), true));
      }
    });
    return ok ? { set: found.length, note: "" } : { set: 0, note: "o Premiere recusou ajustar o volume; os SFX ficaram no nível do arquivo" };
  } catch (cause) {
    return { set: 0, note: `o volume não foi ajustado (${cause instanceof Error ? cause.message : String(cause)}); os SFX ficaram no nível do arquivo` };
  }
}

export async function applySounds(scan: TimelineScan, sounds: readonly Placement[], progress: (text: string) => void, cancelled: () => boolean):
  Promise<{ count: number; skipped: number; volume: string }> {
  if (busy) throw new Error("Uma aplicação de SFX já está em andamento.");
  busy = true;
  try {
    const { ppro, project, sequence, id } = await activeTimeline();
    if (id !== scan.sequenceId) throw new Error("A sequência mudou. Analise novamente antes de aplicar.");
    if (!sounds.length) return { count: 0, skipped: 0, volume: "" };
    const editor = resolveEditor(ppro, sequence);
    if (!editor) throw new Error("O Premiere não disponibilizou o editor da sequência.");
    // Cheap check first; the full re-read of the analysed clips comes once, after the import.
    const fresh = await readAudio(ppro, sequence);
    const pending = sounds.filter((p) => !onTimeline(p, fresh.audio, scan.frame));
    const skipped = sounds.length - pending.length;
    if (!pending.length) return { count: 0, skipped, volume: "" };
    // Fail before importing anything if there is insufficient room, counting the tracks this batch will create.
    const highest = Math.max(...pending.map((p) => p.track));
    allocateTracks(pending, withRoom(fresh.lanes, highest));
    if (cancelled()) throw new Error("Aplicação cancelada antes de inserir os SFX.");
    if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou durante a preparação. Analise novamente.");
    const files = [...new Set(pending.map((p) => p.path))];
    progress(`Importando ${files.length} arquivo${files.length === 1 ? "" : "s"} de SFX para a bin SFX/Automático…`);
    const imports = await projectItemsFor(ppro, project, files, "Automático");
    const missing = highest + 1 - await sequence.getAudioTrackCount();
    if (missing > 0) await addAudioTracks(ppro, project, sequence, editor, imports.get(pending[0].path)!, pending[0].path, missing, progress);
    // The same clips as the analysis, even if the selection moved since: only real edits count.
    progress("Conferindo se a timeline mudou desde a análise…");
    const validated = await scanTimeline(scan.scope, progress, cancelled, new Set(scan.keys));
    if (validated.fingerprint !== scan.fingerprint) throw new Error("Os clipes ou animações mudaram depois da análise. Analise novamente.");
    const remaining = pending.filter((p) => !onTimeline(p, validated.audio, scan.frame));
    const planned = allocateTracks(remaining, validated.lanes);
    if (!planned.length) return { count: 0, skipped: sounds.length, volume: "" };
    if (cancelled()) throw new Error("Aplicação cancelada.");
    // Persist first: even a readback error must leave the targeted undo available.
    await saveBatch({ sequenceId: id, frame: scan.frame, items: planned });
    if ((await activeTimeline()).id !== id || cancelled()) throw new Error("A aplicação foi interrompida antes de inserir os sons.");
    const current = await readAudio(ppro, sequence);
    const reserved = allocateTracks(planned, current.lanes);
    // No await between final reservations and commit.
    if (reserved.some((p, i) => p.track !== planned[i].track)) throw new Error("As faixas de áudio mudaram. Aplique novamente.");
    progress(`Inserindo ${planned.length} SFX…`);
    await placeCuts(ppro, project, editor, planned, imports);
    progress(`Conferindo os ${planned.length} SFX na timeline…`);
    let written = await readAudio(ppro, sequence);
    const count = await settle(async () => {
      written = await readAudio(ppro, sequence);
      return planned.filter((p) => written.audio.some((a) => samePlacement(a, p, scan.frame))).length;
    }, planned.length);
    if (count !== planned.length) {
      const missing = planned.filter((p) => !written.audio.some((a) => samePlacement(a, p, scan.frame)));
      const details = missing.slice(0, 40).map((p) => {
        const found = written.audio.filter((a) => canonical(a.path) === canonical(p.path));
        return `planejado A${p.track + 1} ${at(p.start)}–${at(p.end)} ${p.path.split(/[\\/]/).pop()} → ` +
          (found.length ? found.map((a) => `achado A${a.track + 1} ${at(a.start)}–${at(a.end)} in ${a.inPoint.toFixed(3)}`).join("; ") : "ausente");
      });
      throw new ReadbackError(`O Premiere mostrou ${count} de ${planned.length} SFX no lugar planejado. Confira a timeline; Remover último lote tira os que entraram.`, details);
    }
    await remember(planned);
    progress("Ajustando o volume de cada SFX…");
    const gains = await applyGains(ppro, project, sequence, planned, scan.frame);
    return { count, skipped: sounds.length - planned.length, volume: gains.note };
  } finally { busy = false; }
}

/** Remove only this tool's last batch and only clips that still match their original placement. */
export async function undoLastBatch(): Promise<{ count: number; preserved: number }> {
  if (busy) throw new Error("Espere a aplicação terminar.");
  busy = true;
  try {
    const snapshot = await readLastBatch();
    if (!snapshot?.items.length) return { count: 0, preserved: 0 };
    const { ppro, project, sequence, id } = await activeTimeline();
    if (id !== snapshot.sequenceId) throw new Error("Volte à sequência onde o último lote foi aplicado para removê-lo.");
    const editor = resolveEditor(ppro, sequence);
    if (!editor) throw new Error("O editor da sequência não respondeu.");
    const matches: AudioClipTrackItem[] = [];
    const removed = new Set<string>();
    const count = await sequence.getAudioTrackCount();
    for (let ti = 2; ti < count; ti++) {
      const track = await sequence.getAudioTrack(ti);
      const lock = (track as unknown as { isLocked?: () => Promise<boolean> }).isLocked;
      if (typeof lock === "function" && await lock.call(track)) continue;
      for (const item of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
        let path: string;
        try { path = await ppro.ClipProjectItem.cast(await item.getProjectItem()).getMediaFilePath(); } catch { continue; }
        const planned = snapshot.items.find((p) => canonical(p.path) === canonical(path));
        if (!planned || removed.has(path)) continue;
        const [start, end, point] = await Promise.all([item.getStartTime(), item.getEndTime(), item.getInPoint()]);
        const now = { path, start: start.seconds, end: end.seconds, inPoint: point.seconds, track: ti };
        if (!samePlacement(now, planned, snapshot.frame)) continue;
        matches.push(item); removed.add(path);
      }
    }
    if (matches.length) {
      if ((await activeTimeline()).id !== id) throw new Error("A sequência mudou. Tente novamente na sequência original.");
      const ok = removeItems(ppro, project, editor, matches, "SFX Automático — remover último lote");
      if (!ok) throw new Error("O Premiere recusou remover o lote. Confira as faixas travadas.");
      const left = await settle(async () => (await readAudio(ppro, sequence)).audio.filter((a) => removed.has(a.path)).length, 0);
      if (left) throw new Error(`${left} SFX do lote continuam na timeline. Confira e remova à mão, ou tente de novo.`);
    }
    const remaining = snapshot.items.filter((p) => !removed.has(p.path));
    await saveBatch({ ...snapshot, items: remaining });
    return { count: matches.length, preserved: remaining.length };
  } finally { busy = false; }
}
