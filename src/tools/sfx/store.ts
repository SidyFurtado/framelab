/**
 * O que a ferramenta guarda no disco — e o que ela NÃO guarda.
 *
 * ── Por padrão, nenhum som ─────────────────────────────────────────
 * A prévia toca direto do Drive. Foi pedido assim: quem só quer ouvir
 * não precisa de 90 MB de efeitos no computador. O que fica em disco
 * é texto:
 *
 *   • a última listagem do pack (`sfx/pack.json`), para a ferramenta
 *     abrir na hora com o que viu da última vez, e só depois perguntar
 *     ao Drive se mudou algo;
 *   • a duração de cada som já ouvido e quais arquivos estão vazios no
 *     Drive (`sfx/cache.json`), para a lista mostrar isso sem precisar
 *     tocar de novo.
 *
 * Guarda-se a LISTA DE ARQUIVOS, não o catálogo montado: o catálogo é
 * refeito a cada abertura, e uma regra de organização melhor numa
 * versão nova do plugin vale na hora.
 *
 * ── A pasta dos SFX é escolha do editor ────────────────────────────
 * Quem quiser o pack no disco escolhe a pasta (ver `folder.ts`) e
 * manda baixar: cada tomada vira `<Categoria>/<Nome>.wav` lá dentro. A
 * prévia passa a tocar de lá. Cada registro do manifesto guarda DE QUAL
 * pasta ele é — trocar de pasta não faz o plugin achar que os sons da
 * pasta velha estão na nova, e apagar só apaga o que o plugin gravou
 * na pasta atual. Quando a inserção na timeline existir, ela vai
 * precisar do arquivo no disco (o Premiere só importa arquivo local).
 */
import { describe, ensureDir, fileUrl, readText, workspace, write } from "../silence/workspace";
import { downloadSound } from "./drive";
import { nativeIn, readFrom, removeFrom, writeInto, type SfxFolder } from "./folder";
import type { PackFile, SfxVariant } from "./pack";

const PACK_FILE = "sfx/pack.json";
const MANIFEST_FILE = "sfx/cache.json";

export interface PackSnapshot {
  rootId: string;
  fetchedAt: number;
  files: PackFile[];
}

interface CopiedSound {
  /** A pasta dos SFX onde ele foi gravado (caminho nativo). */
  base: string;
  /** Relativo a ela: `Whooshes/Epic Whoosh 2.wav`. */
  path: string;
  stamp: string;
  bytes: number;
}

interface Manifest {
  /** Os sons gravados na pasta dos SFX. id → arquivo. */
  sounds: Record<string, CopiedSound>;
  /** id → carimbo, dos arquivos que estão vazios no próprio Drive. */
  empty: Record<string, string>;
  /** id → duração, de todo som que já tocou ou foi copiado. */
  seconds: Record<string, { stamp: string; seconds: number }>;
}

/** `data` vem quando o som acabou de ser baixado: a prévia usa sem ler de novo. */
export type CopyResult =
  | { kind: "ok"; url: string; bytes: number; data?: ArrayBuffer }
  | { kind: "empty" };

let manifest: Manifest = { sounds: {}, empty: {}, seconds: {} };
/** A pasta dos SFX escolhida nos ajustes. null = só o Drive. */
let target: SfxFolder | null = null;
let manifestRead = false;
let saving: Promise<void> = Promise.resolve();
const inflight = new Map<string, Promise<CopyResult>>();

// ── a listagem ─────────────────────────────────────────────────────

export async function readSnapshot(rootId: string): Promise<PackSnapshot | null> {
  try {
    const raw = readText(await workspace(), PACK_FILE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PackSnapshot>;
    if (parsed.rootId !== rootId || !Array.isArray(parsed.files)) {
      // Listagem de OUTRO pack (o link mudou nos ajustes): não serve.
      return null;
    }
    return {
      rootId,
      fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
      files: parsed.files.filter(isPackFile),
    };
  } catch {
    return null;
  }
}

export async function writeSnapshot(snapshot: PackSnapshot): Promise<void> {
  try {
    const space = await workspace();
    await ensureDir(space, "sfx");
    await write(space, PACK_FILE, JSON.stringify(snapshot));
  } catch (cause) {
    // Sem cópia em disco a próxima abertura espera a rede. Só isso.
    console.warn("[Efeitos] não consegui guardar a listagem:", cause);
  }
}

function isPackFile(value: unknown): value is PackFile {
  const item = value as PackFile;
  return (
    !!item &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.stamp === "string" &&
    Array.isArray(item.folders)
  );
}

// ── o manifesto ────────────────────────────────────────────────────

function asRecord<T>(value: unknown): Record<string, T> {
  return value && typeof value === "object" ? (value as Record<string, T>) : {};
}

/** Lê o manifesto uma vez. Chamado na abertura, antes de desenhar. */
export async function loadManifest(): Promise<void> {
  if (manifestRead) return;
  manifestRead = true;
  try {
    const raw = readText(await workspace(), MANIFEST_FILE);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    manifest = {
      sounds: asRecord(parsed.sounds),
      empty: asRecord(parsed.empty),
      seconds: asRecord(parsed.seconds),
    };
  } catch {
    // Ilegível: as durações voltam conforme os sons tocam.
  }
}

/**
 * Grava o manifesto, uma escrita por vez.
 *
 * Três cópias terminando juntas disparariam três escritas do mesmo
 * arquivo em paralelo; encadear garante que a última a sair é a mais
 * nova.
 */
function saveManifest(): Promise<void> {
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

/** Define a pasta dos SFX. Vazio = nenhuma: tudo vem do Drive. */
export function setFolder(folder: SfxFolder | null): void {
  target = folder && folder.path ? folder : null;
}

function copied(variant: SfxVariant): CopiedSound | null {
  const entry = manifest.sounds[variant.id];
  return entry && target && entry.base === target.path && entry.stamp === variant.stamp ? entry : null;
}

/** Em que pé está uma tomada, sem tocar em disco nem rede. */
export function localState(variant: SfxVariant): "copied" | "empty" | "drive" {
  if (manifest.empty[variant.id] === variant.stamp) return "empty";
  return copied(variant) ? "copied" : "drive";
}

export function markEmpty(variant: SfxVariant): void {
  manifest.empty[variant.id] = variant.stamp;
  void saveManifest();
}

export function knownSeconds(variant: SfxVariant): number | null {
  const entry = manifest.seconds[variant.id];
  return entry && entry.stamp === variant.stamp ? entry.seconds : null;
}

export function rememberSeconds(variant: SfxVariant, seconds: number | null): void {
  if (seconds === null || knownSeconds(variant) === seconds) return;
  manifest.seconds[variant.id] = { stamp: variant.stamp, seconds };
  void saveManifest();
}

/**
 * O endereço do som na pasta dos SFX, ou null quando ele não está lá —
 * e aí a prévia vem do Drive.
 */
export function copyUrl(variant: SfxVariant): string | null {
  const entry = copied(variant);
  return entry && target ? fileUrl(nativeIn(target, entry.path)) : null;
}

/**
 * Esquece um som da pasta — o player não conseguiu abri-lo (apagado à
 * mão no Finder, por exemplo). A próxima prévia vem do Drive.
 */
export function forgetCopy(variant: SfxVariant): void {
  if (manifest.sounds[variant.id]) {
    delete manifest.sounds[variant.id];
    void saveManifest();
  }
}

/** O caminho nativo do som na pasta. null = não está lá. */
export function copiedFile(variant: SfxVariant): string | null {
  const entry = copied(variant);
  return entry && target ? nativeIn(target, entry.path) : null;
}

/**
 * Onde o som ESTÁ ou VAI ESTAR na pasta — o mesmo caminho que
 * `copyToDisk` usaria agora. O arrasto precisa dele no instante em que
 * começa, antes de o download terminar. null = sem pasta escolhida.
 */
export function plannedFile(variant: SfxVariant, relative: string): string | null {
  if (!target) return null;
  const held = copied(variant);
  return nativeIn(target, held ? held.path : freePath(target.path, variant.id, relative));
}

/** Os bytes de um som que está na pasta, lidos pelo painel. null = não está lá. */
export async function copiedBytes(variant: SfxVariant): Promise<ArrayBuffer | null> {
  const entry = copied(variant);
  if (!entry || !target) return null;
  return readFrom(target, entry.path);
}

/** Quantas tomadas do pack estão na pasta dos SFX, e quanto pesam. */
export function copyUsage(variants: SfxVariant[]): { files: number; bytes: number } {
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

// ── baixar para a pasta ────────────────────────────────────────────

/**
 * Grava uma tomada na pasta dos SFX.
 *
 * `relative` é o nome sugerido (`Impactos/Boom 2.mp3`). Pedidos
 * simultâneos do mesmo id dividem o mesmo download.
 */
export function copyToDisk(
  variant: SfxVariant,
  relative: string,
  signal?: AbortSignal
): Promise<CopyResult> {
  const running = inflight.get(variant.id);
  if (running) return running;
  const job = fetchToFolder(variant, relative, signal).finally(() =>
    inflight.delete(variant.id)
  );
  inflight.set(variant.id, job);
  return job;
}

async function fetchToFolder(
  variant: SfxVariant,
  relative: string,
  signal?: AbortSignal
): Promise<CopyResult> {
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
  let written: string;
  try {
    written = await writeInto(folder, path, data);
  } catch (cause) {
    throw new Error(`a pasta não aceitou o arquivo (${describe(cause)})`);
  }
  manifest.sounds[variant.id] = { base: folder.path, path, stamp: variant.stamp, bytes: data.byteLength };
  void saveManifest();
  return { kind: "ok", url: fileUrl(written), bytes: data.byteLength, data };
}

/**
 * Apaga da pasta atual os sons que o PLUGIN gravou — e só esses. O
 * resto da pasta é do editor. As durações e os "vazio no Drive" ficam:
 * são texto, e continuam valendo para a prévia.
 */
export async function clearCopy(): Promise<number> {
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

/**
 * O nome sugerido, a menos que OUTRO id já more nele na mesma pasta.
 *
 * Duas tomadas podem pedir o mesmo nome — um som renomeado no Drive,
 * ou dois arquivos que limpam igual. O segundo leva um pedaço do id,
 * e nenhum sobrescreve o outro.
 */
function freePath(base: string, id: string, relative: string): string {
  const taken = Object.entries(manifest.sounds).some(
    ([other, entry]) => other !== id && entry.base === base && entry.path === relative
  );
  if (!taken) return relative;
  const dot = relative.lastIndexOf(".");
  const tag = id.slice(0, 6);
  return dot > 0 ? `${relative.slice(0, dot)} (${tag})${relative.slice(dot)}` : `${relative} (${tag})`;
}
