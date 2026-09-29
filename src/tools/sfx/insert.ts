/**
 * Efeitos Sonoros — pôr o som na timeline, na agulha.
 *
 * ── O caminho ──────────────────────────────────────────────────────
 * O som já está na pasta dos SFX (quem chama garante isso): o Premiere
 * importa por REFERÊNCIA, então o arquivo precisa morar num lugar que
 * fica — nunca na pasta temporária da prévia, que é apagada.
 *
 *   1. o arquivo vira item de projeto, numa bin "SFX" — importado uma
 *      vez só: o mesmo som pedido de novo reaproveita o item;
 *   2. a trilha é a primeira de áudio LIVRE no trecho, a partir da A3
 *      (A1 costuma ser a voz e A2 a trilha, e SFX em cima delas é o
 *      que ninguém quer arrumar depois);
 *   3. overwrite na agulha — nunca insert: insert empurraria a
 *      sequência inteira para a direita.
 *
 * O mesmo padrão de escrita das outras ferramentas: `lockedAccess` em
 * volta de `executeTransaction`, com a exceção presa dentro do lock
 * (ver `applyOrganize.ts`).
 */
import type {
  ClipProjectItem,
  CompoundAction,
  FolderItem,
  premierepro,
  Project,
  ProjectItem,
  Sequence,
} from "@adobe/premierepro";
import { describeError, getPremiere } from "../../bridge/premiere";
import { resolveEditor } from "../titles/applyTitles";

/** O nome da bin onde os sons entram no projeto. */
const BIN_NAME = "SFX";
/** Sem duração conhecida, o trecho que precisa estar livre. */
const FALLBACK_SECONDS = 2;

export interface InsertResult {
  ok: boolean;
  message: string;
}

export function commit(project: Project, label: string, build: (tx: CompoundAction) => void): boolean {
  let committed = false;
  let error: unknown = null;
  try {
    project.lockedAccess(() => {
      try {
        committed = project.executeTransaction(build, label);
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

function samePath(a: string, b: string): boolean {
  const clean = (path: string) => path.replace(/\\/g, "/").normalize("NFC");
  return clean(a) === clean(b);
}

/** A bin "SFX" na raiz do projeto — criada na primeira vez. */
async function sfxBin(ppro: premierepro, project: Project): Promise<FolderItem | null> {
  const find = async (): Promise<FolderItem | null> => {
    const root = await project.getRootItem();
    for (const child of await root.getItems()) {
      if (child.type === ppro.ProjectItem.TYPE_BIN && child.name === BIN_NAME) {
        return ppro.FolderItem.cast(child);
      }
    }
    return null;
  };
  const held = await find();
  if (held) return held;
  const root = await project.getRootItem();
  commit(project, "Efeitos Sonoros — criar a bin SFX", (tx) => {
    tx.addAction(root.createBinAction(BIN_NAME, false));
  });
  return find();
}

/** O item de projeto deste arquivo, dentro da bin — ou null. */
async function itemFor(ppro: premierepro, bin: FolderItem, path: string): Promise<ProjectItem | null> {
  for (const child of await bin.getItems()) {
    if (child.type === ppro.ProjectItem.TYPE_BIN) continue;
    let clip: ClipProjectItem | null = null;
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

/** Importa o arquivo para a bin, ou reaproveita o que já foi importado. */
export async function projectItemFor(ppro: premierepro, project: Project, path: string): Promise<ProjectItem> {
  const bin = await sfxBin(ppro, project);
  if (bin) {
    const held = await itemFor(ppro, bin, path);
    if (held) return held;
  }
  const target = bin ? ppro.ProjectItem.cast(bin) : undefined;
  const imported = await project.importFiles([path], true, target, false);
  if (!imported) {
    throw new Error("o Premiere recusou importar o arquivo");
  }
  if (bin) {
    const found = await itemFor(ppro, bin, path);
    if (found) return found;
  }
  // Importou, mas fora da bin (build que ignora o destino): procura na raiz.
  const root = await project.getRootItem();
  const loose = await itemFor(ppro, root, path);
  if (loose) return loose;
  throw new Error("o arquivo foi importado mas não apareceu no projeto");
}

/** Uma bin filha de `parent` — criada na primeira vez. */
async function childBin(ppro: premierepro, project: Project, parent: FolderItem, name: string): Promise<FolderItem | null> {
  const find = async (): Promise<FolderItem | null> => {
    for (const child of await parent.getItems()) {
      if (child.type === ppro.ProjectItem.TYPE_BIN && child.name === name) return ppro.FolderItem.cast(child);
    }
    return null;
  };
  const held = await find();
  if (held) return held;
  commit(project, `Efeitos Sonoros — criar a bin ${name}`, (tx) => {
    tx.addAction(parent.createBinAction(name, false));
  });
  return find();
}

/**
 * Vários arquivos de uma vez, na bin "SFX/<sub>". Blocos de cem por
 * `importFiles`: cem sons do SFX Automático não viram cem idas ao host,
 * nem cem varreduras da bin. Devolve o item de cada caminho pedido.
 */
export async function projectItemsFor(
  ppro: premierepro,
  project: Project,
  paths: readonly string[],
  sub: string
): Promise<Map<string, ProjectItem>> {
  const clean = (path: string) => path.replace(/\\/g, "/").normalize("NFC");
  const wanted = new Set(paths.map(clean));
  const found = new Map<string, ProjectItem>();
  const index = async (folder: FolderItem): Promise<void> => {
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
  const parent = await sfxBin(ppro, project);
  const bin = parent ? await childBin(ppro, project, parent, sub) : null;
  if (bin) await index(bin);
  const missing = paths.filter((path) => !found.has(clean(path)));
  if (missing.length) {
    const target = bin ? ppro.ProjectItem.cast(bin) : undefined;
    // Em blocos: quatrocentos cliques de palavra não viram uma chamada só.
    for (let at = 0; at < missing.length; at += 100) {
      if (!(await project.importFiles(missing.slice(at, at + 100), true, target, false))) {
        throw new Error("o Premiere recusou importar os arquivos");
      }
    }
    if (bin) await index(bin);
    // Build que ignora o destino: procura na raiz.
    if (paths.some((path) => !found.has(clean(path)))) await index(await project.getRootItem());
  }
  const absent = paths.filter((path) => !found.has(clean(path)));
  if (absent.length) {
    throw new Error(`${absent.length} arquivo(s) foram importados mas não apareceram no projeto`);
  }
  return new Map(paths.map((path) => [path, found.get(clean(path))!]));
}

/**
 * A primeira trilha de áudio livre no trecho: A3 em diante, depois A2,
 * depois A1. null quando todas têm algo ali.
 */
async function freeAudioTrack(
  ppro: premierepro,
  sequence: Sequence,
  from: number,
  to: number
): Promise<{ index: number | null; count: number }> {
  const count = await sequence.getAudioTrackCount();
  const order = [
    ...Array.from({ length: Math.max(0, count - 2) }, (_, index) => index + 2),
    ...[1, 0].filter((index) => index < count),
  ];
  for (const index of order) {
    const track = await sequence.getAudioTrack(index).catch(() => null);
    if (!track) continue;
    const locked = (track as { isLocked?: () => Promise<boolean> }).isLocked;
    if (typeof locked === "function" && (await locked.call(track).catch(() => false))) continue;
    let items: ReturnType<typeof track.getTrackItems> = [];
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
    // Vizinho não é sobreposição: um clipe que termina onde o som começa serve.
    if (!spans.some((span) => span && span.start < to && span.end > from)) {
      return { index, count };
    }
  }
  return { index: null, count };
}

function timecode(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0").replace(".", ",")}`;
}

/**
 * Põe o arquivo na agulha da sequência aberta. `seconds` é a duração do
 * som, quando já se sabe — é ela que diz qual trecho precisa estar livre.
 */
export async function insertAtPlayhead(path: string, seconds: number | null): Promise<InsertResult> {
  const ppro = getPremiere();
  if (!ppro) return { ok: false, message: "o Premiere não respondeu ao painel" };
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) return { ok: false, message: "nenhum projeto aberto" };
    const sequence = await project.getActiveSequence();
    if (!sequence) return { ok: false, message: "abra uma sequência na timeline" };
    const editor = resolveEditor(ppro, sequence);
    if (!editor) return { ok: false, message: "esta versão do Premiere não deixa o painel editar a timeline" };

    const at = (await sequence.getPlayerPosition().catch(() => null))?.seconds ?? 0;
    const span = seconds ?? FALLBACK_SECONDS;
    const { index, count } = await freeAudioTrack(ppro, sequence, at, at + span);
    if (count === 0) return { ok: false, message: "a sequência não tem trilha de áudio" };
    if (index === null) {
      return {
        ok: false,
        message:
          `todas as trilhas de áudio têm algo aos ${timecode(at)} — ` +
          "adicione uma trilha (botão direito no cabeçalho das trilhas) e tente de novo",
      };
    }

    const item = await projectItemFor(ppro, project, path);
    const time = ppro.TickTime.createWithSeconds(at);
    const placed = commit(project, "Inserir efeito sonoro", (tx) => {
      tx.addAction(editor.createOverwriteItemAction(item, time, 0, index));
    });
    if (!placed) {
      return { ok: false, message: `o Premiere recusou pôr o som na A${index + 1} (a trilha está travada?)` };
    }
    return { ok: true, message: `A${index + 1}, aos ${timecode(at)}` };
  } catch (cause) {
    return { ok: false, message: describeError(cause) };
  }
}
