/**
 * A pasta dos SFX: onde o editor escolheu guardar o pack.
 *
 * ── Por que pela API de entries, e não pelo `fs` ───────────────────
 * O UXP do Premiere não atende a rota `file:` do `fs` (ADR-016): gravar
 * num caminho nativo qualquer devolve "Route not found". O que funciona
 * é o caminho do Baixar Vídeos — o seletor de pasta entrega uma entry
 * que JÁ tem permissão de escrita, e um token persistente guarda essa
 * permissão entre sessões.
 *
 * ── O que sobrou aqui ──────────────────────────────────────────────
 * Só o que é dos SFX: o cache das entries abertas (uma categoria é
 * aberta uma vez, não a cada som) e a leitura de volta pelo painel. O
 * seletor, a resolução do destino e o saneamento do nome são os mesmos
 * de todas as ferramentas e moram em `bridge/destination` — este
 * arquivo tinha a sua própria cópia de cada um, e cópia é como o
 * espaço final de uma pasta do Drive virou "#" numa ferramenta e não
 * na outra.
 *
 * ── Nomes de gente, não de máquina ─────────────────────────────────
 * A pasta é do editor: ele vai abri-la no Finder e arrastar sons para
 * o Premiere. Então cada categoria é uma subpasta e cada arquivo tem o
 * nome que a lista mostra (`Whooshes/Epic Whoosh 2.wav`). Essas
 * subpastas são invenção do plugin e ele pode criá-las — dentro da
 * pasta escolhida, nunca ao lado dela.
 */
import {
  joinNative,
  openDestination,
  safeRelative,
  subfolder,
  type Destination,
  type UxpFolderEntry,
} from "../../bridge/destination";

interface FileEntry {
  nativePath?: string;
  write(data: ArrayBuffer, options?: { format?: unknown }): Promise<number>;
  read(options?: { format?: unknown }): Promise<ArrayBuffer | string>;
  delete?(): Promise<unknown>;
}

/** O mesmo par caminho+token de todas as ferramentas. */
export type SfxFolder = Destination;

/** A entry da raiz e das subpastas já abertas, para não pedir de novo. */
let rootKey = "";
let root: { folder: UxpFolderEntry; binary: unknown } | null = null;
const subfolders = new Map<string, UxpFolderEntry>();

async function openRoot(target: SfxFolder): Promise<{ folder: UxpFolderEntry; binary: unknown }> {
  const key = `${target.path}|${target.token}`;
  if (root && rootKey === key) return root;
  // `create` fica falso: a pasta dos SFX foi escolhida no seletor, e
  // uma pasta escolhida que não abre é um erro para mostrar, não uma
  // pasta para inventar.
  const opened = await openDestination(target);
  root = { folder: opened.folder, binary: opened.binary };
  rootKey = key;
  subfolders.clear();
  return root;
}

async function openSubfolder(target: SfxFolder, name: string): Promise<UxpFolderEntry> {
  const held = subfolders.get(name);
  if (held) return held;
  const { folder } = await openRoot(target);
  const sub = await subfolder(folder, name);
  subfolders.set(name, sub);
  return sub;
}

function split(relative: string): { dir: string; name: string } {
  const cut = relative.lastIndexOf("/");
  return cut > 0
    ? { dir: relative.slice(0, cut), name: relative.slice(cut + 1) }
    : { dir: "", name: relative };
}

/** Grava um som na pasta e devolve o caminho nativo dele. */
export async function writeInto(
  target: SfxFolder,
  relative: string,
  data: ArrayBuffer
): Promise<string> {
  const { binary } = await openRoot(target);
  const { dir, name } = split(safeRelative(relative, "som"));
  const folder = dir ? await openSubfolder(target, dir) : (await openRoot(target)).folder;
  const file = (await folder.createFile(name, { overwrite: true })) as unknown as FileEntry;
  try {
    await file.write(data, binary !== undefined ? { format: binary } : undefined);
  } catch {
    // Build sem a constante de formato: a grafia literal.
    await file.write(data, { format: "binary" });
  }
  return file.nativePath ?? nativeIn(target, relative);
}

/**
 * Lê de volta um som da pasta, pela API de entries.
 *
 * ── Por que o painel lê, e não o afplay ────────────────────────────
 * A pasta pode estar dentro do Google Drive (`~/Library/CloudStorage`),
 * e o macOS só deixa ler ali quem tem permissão: o Premiere tem; o
 * assistente do Framelab, não. Medido no assistente: `cp` devolveu
 * "Operation not permitted" e o `afplay`, "AudioFileOpen failed (-54)".
 * Então quem lê é o painel, e o afplay recebe uma cópia temporária.
 */
export async function readFrom(target: SfxFolder, relative: string): Promise<ArrayBuffer> {
  const { binary } = await openRoot(target);
  const { dir, name } = split(relative);
  const folder = dir ? await openSubfolder(target, dir) : (await openRoot(target)).folder;
  const file = (await folder.getEntry(name)) as unknown as FileEntry;
  let data: ArrayBuffer | string;
  try {
    data = await file.read(binary !== undefined ? { format: binary } : undefined);
  } catch {
    data = await file.read({ format: "binary" });
  }
  if (typeof data === "string") {
    throw new Error("a leitura voltou como texto");
  }
  return data;
}

/**
 * Apaga UM arquivo que o plugin gravou. Nunca é chamado para nada que
 * não esteja no manifesto: a pasta é do editor, e o resto dela não é
 * da conta do plugin.
 */
export async function removeFrom(target: SfxFolder, relative: string): Promise<void> {
  const { dir, name } = split(relative);
  try {
    const folder = dir ? await openSubfolder(target, dir) : (await openRoot(target)).folder;
    const entry = (await folder.getEntry(name)) as unknown as FileEntry;
    await entry.delete?.();
  } catch {
    // Já não estava lá.
  }
}

/** Esquece as entries abertas. O painel troca de pasta e nada fica em pé. */
export function forgetOpenFolders(): void {
  root = null;
  rootKey = "";
  subfolders.clear();
}

/** O caminho nativo de um som da pasta, para o player. */
export function nativeIn(target: SfxFolder, relative: string): string {
  return joinNative(target.path, relative);
}

/** Só o nome da pasta, para caber numa linha. */
export function folderLabel(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
}
