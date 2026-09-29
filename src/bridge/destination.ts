/**
 * A pasta de destino — uma só definição, para todas as ferramentas.
 *
 * ── Por que este arquivo existe ────────────────────────────────────
 * Havia QUATRO cópias do seletor de pastas (Baixar, Efeitos Sonoros,
 * Legendas, Textos Animados) e TRÊS cópias da resolução de destino
 * (`panelFetch`, `sfx/folder`, `applyCaptions`). Cópias divergem, e
 * divergiram: cada uma tratava o token de um jeito, nenhuma conferia
 * se a pasta existia, e uma delas criava a árvore em silêncio.
 *
 * Em 23/09/2026 isso custou um dia. O yt-dlp, chamado com
 * `--windows-filenames`, aplica `sanitize_path` ao caminho INTEIRO — e
 * essa função troca o espaço final de CADA componente de diretório por
 * "#". Uma pasta real do Drive compartilhado,
 *
 *     …/Arquivo de Edição /01. Male Enhancement/
 *                       ↑ espaço antes da barra
 *
 * virou `…/Arquivo de Edição#/01. Male Enhancement/`, o yt-dlp criou a
 * árvore paralela inteira sem reclamar, e ~25 arquivos foram para lá.
 * No Premiere eles entravam OFFLINE: o projeto não conhece esse
 * caminho. Nada avisou, porque criar pasta era considerado normal.
 *
 * ── As três regras que saíram dali ─────────────────────────────────
 * 1. O `nativePath` que o seletor devolve é IMUTÁVEL. Nenhum
 *    componente de diretório que já existe no disco é normalizado,
 *    saneado ou reescrito — nem o espaço final, nem o acento, nem o
 *    emoji. O disco é a autoridade; o plugin não tem opinião.
 * 2. Sanear é coisa de BASENAME, e só do basename de arquivo que o
 *    PRÓPRIO plugin está criando. `safeBaseName` existe para isso e
 *    nunca vê um caminho.
 * 3. Antes de escrever, a pasta tem de existir. Se não existir, o erro
 *    aparece — não se cria árvore no escuro. A única exceção é a pasta
 *    padrão do próprio plugin (`~/Movies/Framelab`), que ele inventou
 *    e pode criar, e as subpastas que ele cria DENTRO da pasta
 *    escolhida (as categorias dos SFX), que também são invenção dele.
 */
import {
  fileUrl,
  isWindows,
  readText,
  uxpModule,
  workspace,
  write,
  type Workspace,
} from "../tools/silence/workspace";

// ── o que é um destino ─────────────────────────────────────────────

export interface Destination {
  /** Caminho nativo, exatamente como o disco o soletra. */
  readonly path: string;
  /**
   * Token persistente do seletor UXP. É a permissão de escrita que
   * sobrevive ao fechamento do Premiere; o caminho sozinho é só texto,
   * e texto pode ser uma rota que o host recusa.
   */
  readonly token: string;
}

export function destinationOf(path: string, token = ""): Destination {
  return { path, token };
}

// ── os grupos ──────────────────────────────────────────────────────

/** Toda ferramenta que escolhe uma pasta. */
export type DestinationTool =
  | "download"
  | "captions"
  | "titles"
  | "sfx"
  | "soundDesign";

/** O nome de uma pasta guardada. Cada grupo tem a SUA. */
export type DestinationGroup = "download" | "captions" | "titles" | "audio";

/**
 * Quem divide pasta com quem.
 *
 * ⚠️ `audio` tem dois membros DE PROPÓSITO, e isso não é um defeito a
 * consertar: a biblioteca de Efeitos Sonoros e o SFX Automático são a
 * mesma pasta de sons vista de dois lugares. Escolher no primeiro tem
 * de valer no segundo — foi pedido assim, e já foi "consertado" por
 * engano uma vez. Quem for separá-los precisa de um pedido explícito
 * do editor, não de uma intuição de simetria.
 *
 * A maioria é grupo de um. Um par futuro entra como mais uma linha
 * aqui, sem `if` em lugar nenhum.
 */
export const DESTINATION_GROUPS: Record<DestinationGroup, readonly DestinationTool[]> = {
  download: ["download"],
  captions: ["captions"],
  titles: ["titles"],
  audio: ["sfx", "soundDesign"],
};

const GROUP_OF: ReadonlyMap<DestinationTool, DestinationGroup> = new Map(
  (Object.entries(DESTINATION_GROUPS) as Array<[DestinationGroup, readonly DestinationTool[]]>)
    .flatMap(([group, tools]) => tools.map((tool) => [tool, group] as const))
);

export function groupOf(tool: DestinationTool): DestinationGroup {
  const group = GROUP_OF.get(tool);
  if (!group) {
    throw new Error(`ferramenta sem grupo de destino: ${tool}`);
  }
  return group;
}

/** true quando trocar a pasta de `a` também troca a de `b`. */
export function sharesDestination(a: DestinationTool, b: DestinationTool): boolean {
  return groupOf(a) === groupOf(b);
}

// ── onde os grupos ficam guardados ─────────────────────────────────

/**
 * Um arquivo só, com uma entrada por GRUPO.
 *
 * Fica fora dos `*-config.json` das ferramentas de propósito: enquanto
 * cada ferramenta guardava o seu destino, a pergunta "quem divide com
 * quem" não tinha resposta em lugar nenhum do código — ela morava na
 * cabeça de quem lesse os imports. Aqui ela é uma tabela.
 */
const STORE_FILE = "destinations.json";

type Stored = Partial<Record<DestinationGroup, { path?: unknown; token?: unknown }>>;

let cache: Record<string, Destination> | null = null;
let writing: Promise<void> = Promise.resolve();

function readStore(space: Workspace): Record<string, Destination> {
  if (cache) {
    return cache;
  }
  const out: Record<string, Destination> = {};
  try {
    const raw = readText(space, STORE_FILE);
    const parsed = raw ? (JSON.parse(raw) as Stored) : {};
    for (const [group, value] of Object.entries(parsed ?? {})) {
      const path = typeof value?.path === "string" ? value.path : "";
      if (path) {
        out[group] = { path, token: typeof value?.token === "string" ? value.token : "" };
      }
    }
  } catch {
    // Ilegível: cada ferramenta volta ao padrão e o editor reescolhe.
  }
  cache = out;
  return out;
}

/**
 * A pasta do grupo desta ferramenta. null = nenhuma escolhida.
 *
 * `legacy` é o valor que a ferramenta guardava no arquivo dela antes
 * deste módulo existir. Ele é adotado UMA vez, na primeira leitura de
 * um grupo vazio, para que ninguém perca a pasta ao atualizar.
 */
export async function readDestination(
  tool: DestinationTool,
  legacy?: Destination | null
): Promise<Destination | null> {
  const space = await workspace();
  const store = readStore(space);
  const group = groupOf(tool);
  const held = store[group];
  if (held) {
    return held;
  }
  if (legacy?.path) {
    await saveDestination(tool, legacy);
    return legacy;
  }
  return null;
}

/** Guarda a pasta do grupo. null apaga. */
export async function saveDestination(
  tool: DestinationTool,
  next: Destination | null
): Promise<void> {
  const space = await workspace();
  const store = readStore(space);
  const group = groupOf(tool);
  if (next?.path) {
    store[group] = { path: next.path, token: next.token ?? "" };
  } else {
    delete store[group];
  }
  writing = writing.then(async () => {
    try {
      await write(space, STORE_FILE, JSON.stringify(store, null, 2));
    } catch (cause) {
      // Não gravar custa a lembrança na próxima sessão, e nada além.
      console.warn("[Destino] não consegui gravar as pastas:", cause);
    }
  });
  await writing;
}

/** Para os testes e para o recarregamento do painel. */
export function forgetDestinations(): void {
  cache = null;
}

// ── o seletor, uma única implementação ─────────────────────────────

interface UxpEntry {
  nativePath?: string;
  isFolder?: boolean;
}

interface UxpFileEntry extends UxpEntry {
  write(data: string | ArrayBuffer, options?: { format?: unknown }): Promise<unknown>;
  read(options?: { format?: unknown }): Promise<ArrayBuffer | string>;
  delete?(): Promise<unknown>;
}

export interface UxpFolderEntry extends UxpEntry {
  name?: string;
  createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFileEntry>;
  createFolder(name: string): Promise<UxpFolderEntry>;
  getEntry(name: string): Promise<UxpFolderEntry | UxpFileEntry>;
  /** Existe nas builds em que a entry do seletor também lista. */
  getEntries?(): Promise<unknown[]>;
}

interface UxpLfs {
  getFolder?(options?: unknown): Promise<UxpEntry | null>;
  getEntryWithUrl?(url: string): Promise<UxpFolderEntry>;
  getEntryForPersistentToken?(token: string): Promise<UxpFolderEntry>;
  createPersistentToken?(entry: unknown): Promise<string>;
}

function storageApi(): { lfs: UxpLfs; binary: unknown } | null {
  const storage = uxpModule<{
    storage?: { localFileSystem?: UxpLfs; formats?: { binary?: unknown } };
  }>("uxp")?.storage;
  const lfs = storage?.localFileSystem;
  return lfs ? { lfs, binary: storage?.formats?.binary } : null;
}

/** O que o seletor lançou quando este build não tem seletor. */
export const NO_PICKER = "este build do Premiere não abre o seletor de pastas";

/**
 * Abre o diálogo nativo e devolve a pasta escolhida. null = desistiu.
 *
 * O `nativePath` sai daqui do jeito que entrou. Qualquer tentação de
 * "arrumar" o caminho — tirar o espaço do fim, normalizar o acento,
 * trocar a barra — pertence ao bug de 23/09 e não a este código.
 */
export async function pickDestination(): Promise<Destination | null> {
  const api = storageApi();
  if (typeof api?.lfs.getFolder !== "function") {
    throw new Error(NO_PICKER);
  }
  let folder: UxpEntry | null = null;
  try {
    folder = await api.lfs.getFolder();
  } catch {
    // Cancelar o diálogo chega como erro em alguns builds, e desistir
    // de escolher não é uma falha para reportar a ninguém.
    return null;
  }
  if (!folder?.nativePath) {
    return null;
  }
  return { path: folder.nativePath, token: (await persistentToken(folder)) ?? "" };
}

/**
 * Escolhe e JÁ guarda, no grupo da ferramenta. É o que quase toda
 * chamada quer: as duas metades separadas foi como o Legendas acabou
 * gravando o caminho novo por cima do token velho.
 */
export async function pickAndSave(tool: DestinationTool): Promise<Destination | null> {
  const picked = await pickDestination();
  if (!picked) {
    return null;
  }
  await saveDestination(tool, picked);
  return picked;
}

async function persistentToken(entry: unknown): Promise<string | null> {
  const api = storageApi();
  if (typeof api?.lfs.createPersistentToken !== "function") {
    return null;
  }
  try {
    return (await api.lfs.createPersistentToken(entry)) ?? null;
  } catch {
    return null;
  }
}

// ── comparar caminhos sem reescrevê-los ────────────────────────────

/**
 * Dois caminhos apontam para o mesmo lugar?
 *
 * Só COMPARA — nunca devolve um caminho "arrumado" para ser usado. A
 * normalização é necessária porque o mesmo caminho chega em NFD de uma
 * API e em NFC de outra (é a regra do macOS com acento), e porque APFS
 * e NTFS não distinguem maiúscula. O espaço final, que é o que o bug
 * comia, é preservado dos dois lados: ele DIFERENCIA duas pastas.
 */
export function samePath(a: string, b: string): boolean {
  const clean = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC");
  const left = clean(a);
  const right = clean(b);
  return left === right || left.toLowerCase() === right.toLowerCase();
}

// ── sanear o basename, e NADA além dele ────────────────────────────

/** O que nenhum sistema de arquivos aceita dentro de um nome. */
const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** Nomes que o Windows reserva para dispositivos, com ou sem extensão. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * O nome de UM arquivo que o plugin está criando, seguro em qualquer
 * sistema — e só isso.
 *
 * Esta função nunca recebe um caminho. Se você está tentando passar
 * uma barra por aqui, o que você quer é `safeRelative`, e mesmo ela
 * não encosta na pasta escolhida pelo editor.
 *
 * O corte de espaço e ponto no FIM é o que o Windows exige, e é
 * exatamente o que causou o desastre quando aplicado a diretório. Aqui
 * é legítimo: o nome é invenção do plugin, o arquivo ainda não existe,
 * e ninguém tem um caminho anotado para ele.
 */
export function safeBaseName(raw: string, fallback = "arquivo"): string {
  const compact = raw
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 180)
    .replace(/[. ]+$/, "");
  if (!compact || compact === "." || compact === "..") {
    return fallback;
  }
  return RESERVED.test(compact) ? `_${compact}` : compact;
}

/**
 * Um caminho relativo que o plugin INVENTOU dentro da pasta escolhida
 * — `Impactos/Boom 2.wav`, por exemplo.
 *
 * Cada pedaço é saneado porque cada pedaço é criação do plugin. A
 * pasta escolhida não entra aqui: ela já existe no disco e é intocável.
 */
export function safeRelative(relative: string, fallback = "arquivo"): string {
  const parts = relative
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  if (parts.length === 0) {
    return fallback;
  }
  const name = safeBaseName(parts.pop() as string, fallback);
  return [...parts.map((part) => safeBaseName(part, "pasta")), name].join("/");
}

// ── abrir a pasta, conferindo que ela é a pasta ────────────────────

export interface OpenFolder {
  readonly folder: UxpFolderEntry;
  /** A constante de formato binário do host, quando existe. */
  readonly binary: unknown;
  /** O caminho que o host devolveu para a pasta aberta. */
  readonly nativePath: string;
  /** Por onde ela abriu — aparece no log quando algo não bate. */
  readonly via: "token" | "path" | "created";
}

export interface OpenOptions {
  /**
   * Permite criar o ÚLTIMO nível se ele não existir.
   *
   * Só é verdadeiro para a pasta padrão que o próprio plugin propõe
   * (`~/Movies/Framelab`). Para uma pasta escolhida pelo editor é
   * sempre falso: se ela não abre, alguma coisa está errada com o
   * caminho, e criar uma pasta parecida ao lado é como ~25 arquivos
   * sumiram por dois dias.
   */
  readonly create?: boolean;
}

/**
 * A pasta de destino como entry de storage, pronta para escrever.
 *
 * Lança quando a pasta não existe. Esse lançamento é a funcionalidade:
 * era o aviso que faltava em 23/09.
 */
export async function openDestination(
  target: Destination,
  options: OpenOptions = {}
): Promise<OpenFolder> {
  const api = storageApi();
  if (!api) {
    throw new Error("destino: storage do UXP indisponível");
  }
  if (!target.path) {
    throw new Error("destino: nenhuma pasta escolhida");
  }

  /*
   * 1. O token do seletor — mas só se ele concordar com o caminho.
   *
   * O token era usado sem conferência nenhuma, e vencia o caminho
   * sempre. Um token velho (pasta renomeada, escolha anterior que
   * ficou para trás num campo que não foi limpo) mandava o arquivo
   * para OUTRA pasta enquanto o painel exibia a certa — que é
   * exatamente a queixa de "a pasta escolhida vaza entre ferramentas".
   * Discordou, o token é descartado e o caminho decide.
   */
  if (target.token && typeof api.lfs.getEntryForPersistentToken === "function") {
    try {
      const folder = await api.lfs.getEntryForPersistentToken(target.token);
      const actual = folder?.nativePath ?? "";
      if (!actual || samePath(actual, target.path)) {
        return { folder, binary: api.binary, nativePath: actual || target.path, via: "token" };
      }
      console.warn(
        `[Destino] token ignorado: ele abre "${actual}", e a pasta guardada é "${target.path}".`
      );
    } catch {
      // Token caducou ou a pasta sumiu: o caminho ainda pode servir.
    }
  }

  // 2. Pelo caminho, do jeito que ele é. Sem normalizar, sem sanear.
  if (typeof api.lfs.getEntryWithUrl === "function") {
    try {
      const folder = await api.lfs.getEntryWithUrl(fileUrl(target.path));
      return { folder, binary: api.binary, nativePath: folder?.nativePath ?? target.path, via: "path" };
    } catch (cause) {
      if (!options.create) {
        /*
         * O prefixo "destino:" é contrato, não enfeite: o painel do
         * Baixar reconhece por ele que a falha é de PASTA — e é o que
         * dispara o "escolha a pasta, só desta vez" em vez de mandar
         * tudo para o plano B do script.
         */
        throw new Error(
          `destino: a pasta não abriu: "${target.path}". ` +
            "Se ela foi renomeada ou está num Drive que não montou, escolha-a de novo — " +
            `o plugin não cria pasta parecida no lugar dela (${describe(cause)}).`
        );
      }
    }
  }

  // 3. Criar o último nível: SÓ para a pasta que o plugin propôs.
  if (!options.create) {
    throw new Error(`destino: o storage do UXP não abriu "${target.path}"`);
  }
  const normalized = target.path.replace(/\\/g, "/").replace(/\/+$/, "");
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0 || typeof api.lfs.getEntryWithUrl !== "function") {
    throw new Error(`destino: sem pasta-mãe para criar "${target.path}"`);
  }
  const parent = await api.lfs.getEntryWithUrl(fileUrl(normalized.slice(0, cut)));
  const leaf = normalized.slice(cut + 1);
  let folder: UxpFolderEntry;
  try {
    folder = await parent.createFolder(leaf);
  } catch {
    folder = (await parent.getEntry(leaf)) as UxpFolderEntry;
  }
  return { folder, binary: api.binary, nativePath: folder?.nativePath ?? target.path, via: "created" };
}

export interface WriteOptions extends OpenOptions {
  /**
   * Permite criar subpastas DENTRO da pasta escolhida, para um
   * relativo com barra. É invenção do plugin (as categorias dos SFX),
   * não estrutura do editor — e mesmo assim é explícito.
   */
  readonly createSubfolders?: boolean;
}

/**
 * Escreve um arquivo na pasta de destino e devolve o caminho nativo.
 *
 * `relative` é o que o plugin quer chamar o arquivo, com subpasta
 * opcional. Ele passa por `safeRelative`; a pasta de destino, não.
 */
export async function writeFileInto(
  target: Destination,
  relative: string,
  data: string | ArrayBuffer,
  options: WriteOptions = {}
): Promise<string> {
  const safe = safeRelative(relative);
  const opened = await openDestination(target, options);
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
  const binary = typeof data === "string" ? undefined : opened.binary;
  try {
    await file.write(data, binary !== undefined ? { format: binary } : undefined);
  } catch (cause) {
    if (typeof data === "string") {
      throw cause;
    }
    // Build sem a constante de formato: a grafia literal.
    await file.write(data, { format: "binary" });
  }
  return file.nativePath ?? joinNative(opened.nativePath, safe);
}

export async function subfolder(
  parent: UxpFolderEntry,
  name: string
): Promise<UxpFolderEntry> {
  try {
    return await parent.createFolder(name);
  } catch {
    // Já existe: é o caso comum depois do primeiro arquivo.
    return (await parent.getEntry(name)) as UxpFolderEntry;
  }
}

/**
 * Junta a pasta e o relativo SEM tocar na pasta.
 *
 * `join` da workspace apara a barra final da base, que é o que se quer
 * de uma base; aqui o que se apara é só a barra separadora, e nunca um
 * espaço.
 */
export function joinNative(base: string, relative: string): string {
  const sep = isWindows() && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${relative.split("/").join(sep)}`;
}

/**
 * O arquivo escrito caiu DENTRO da pasta escolhida?
 *
 * A pergunta que ninguém fazia. Um caminho que foge da pasta — porque
 * o yt-dlp reescreveu um componente, porque um token apontava para
 * outro lugar — deixa de ser um arquivo perdido em silêncio e vira
 * uma frase na barra de status.
 */
export function isInside(folder: string, file: string): boolean {
  const clean = (value: string): string =>
    value.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").toLowerCase();
  const base = clean(folder);
  const target = clean(file);
  return target === base || target.startsWith(`${base}/`);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
