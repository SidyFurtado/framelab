/**
 * Onde o plugin escreve, e como ele descobre isso.
 *
 * ── Por que este arquivo existe ────────────────────────────────────
 * O `fs` do UXP não endereça arquivos por caminho e pronto: ele ROTEIA
 * por esquema — `plugin:`, `plugin-data:`, `plugin-temp:` e `file:`.
 * Caminho sem esquema é tratado como `file:`, e o UXP do Premiere não
 * atende essa rota: qualquer escrita em caminho nativo volta com
 * "Route not found" — mensagem que não fala de permissão nem de
 * caminho, e que por isso custou caro para ser entendida.
 *
 * Só que o esquema resolve metade do problema. `shell.openPath` e o
 * ffmpeg são o mundo de fora: os dois precisam do caminho NATIVO. Uma
 * pasta, então, tem dois endereços, e este módulo mantém os dois
 * juntos — o esquema para o `fs`, o nativo para quem vive fora do UXP.
 *
 * Nada disso é declarado por versão de host: é DESCOBERTO. O módulo
 * escreve um arquivo de teste em cada candidato, na ordem, e fica com
 * o primeiro que responder. Assim uma build que passe a atender `file:`
 * (ou que deixe de atender `plugin-data:`) não quebra nada.
 */

export interface Workspace {
  /** Prefixo das chamadas de `fs`. Pode ter esquema. */
  readonly fsBase: string;
  /** A MESMA pasta em caminho nativo — para `openPath` e para o ffmpeg. */
  readonly nativeBase: string;
  /** false quando só a versão assíncrona de write funciona. */
  readonly sync: boolean;
  /** Como esta combinação foi encontrada. Aparece no diagnóstico. */
  readonly origin: string;
}

export interface UxpFs {
  readFileSync(path: string, options?: { encoding?: string }): string | ArrayBuffer;
  writeFileSync(
    path: string,
    data: string | ArrayBuffer | ArrayBufferView,
    options?: { flag?: number | string; mode?: number | string; encoding?: string }
  ): number;
  writeFile(
    path: string,
    data: string | ArrayBuffer | ArrayBufferView,
    options?: { flag?: number | string; mode?: number | string; encoding?: string }
  ): Promise<number>;
  open(path: string, flag?: number | string, mode?: number | string): Promise<number>;
  read(
    fd: number,
    buffer: ArrayBuffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number; buffer: ArrayBuffer }>;
  close(fd: number): Promise<number>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<number>;
  unlink(path: string): Promise<number>;
}

export interface UxpShell {
  openPath(path: string, developerText?: string): Promise<string>;
}

const WORK_FOLDER = "edit-toolbox-audio";
const PROBE_FILE = "write-probe.txt";

export function uxpModule<T>(name: string): T | null {
  if (typeof require !== "function") {
    return null;
  }
  try {
    return (require(name) as T) ?? null;
  } catch {
    return null;
  }
}

export function fsModule(): UxpFs | null {
  return uxpModule<UxpFs>("fs");
}

export function shellModule(): UxpShell | null {
  return uxpModule<{ shell?: UxpShell }>("uxp")?.shell ?? null;
}

export function platform(): string {
  try {
    return uxpModule<{ platform(): string }>("os")?.platform() ?? "darwin";
  } catch {
    return "darwin";
  }
}

export function isWindows(): boolean {
  return /^win/i.test(platform());
}

/**
 * A UXP scheme prefix — `plugin-data:`, `plugin-temp:`, `file:`.
 *
 * Two or more characters before the colon, which is what separates a
 * scheme from a Windows drive letter: `C:` is a drive, `plugin-data:` is
 * a route.
 */
const UXP_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/** Junta segmentos preservando o esquema (`plugin-data:/…` usa `/`). */
export function join(base: string, ...parts: string[]): string {
  // A scheme route is spelled with forward slashes on every platform.
  // Testing for ":/" missed the bare `plugin-data:` and `plugin-temp:`
  // candidates, so on Windows they were joined with a backslash — and
  // those two are precisely the fallbacks that exist for the build where
  // mkdir is missing.
  const separator = isWindows() && !UXP_SCHEME.test(base) ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(separator);
}

// ── descoberta ─────────────────────────────────────────────────────

interface Candidate {
  fsBase: string;
  nativeBase: string;
  origin: string;
}

let cached: Workspace | null = null;
/** O que falhou na descoberta, para o diagnóstico contar a história. */
let attempts: string[] = [];

export function workspaceAttempts(): readonly string[] {
  return attempts;
}

export function forgetWorkspace(): void {
  cached = null;
  attempts = [];
}

/**
 * A pasta de trabalho, descoberta na primeira chamada.
 *
 * A ordem tenta primeiro o que é do plugin (`plugin-data:`), porque é
 * a rota que o UXP sempre atende e a que não depende de permissão de
 * disco. Caminho nativo vem por último: é o que falha hoje no Premiere,
 * mas continua na lista para o dia em que passar a funcionar.
 */
export async function workspace(): Promise<Workspace> {
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
        `[Silêncios] pasta de trabalho: ${found.fsBase} (${found.origin}, ` +
          `${found.sync ? "sync" : "async"}) → ${found.nativeBase}`
      );
      return found;
    }
  }
  throw new Error(
    `nenhum caminho gravável (${attempts.join(" · ") || "sem candidatos"})`
  );
}

/**
 * Os endereços possíveis, do mais provável ao menos.
 *
 * Cada pasta aparece duas vezes: com subpasta e sem. Se `mkdir` não
 * estiver implementado, escrever na raiz da pasta de dados ainda
 * funciona — é menos organizado e melhor que não funcionar.
 */
async function candidates(): Promise<Candidate[]> {
  const list: Candidate[] = [];
  const storage = uxpModule<{
    storage?: {
      localFileSystem?: {
        getDataFolder?(): Promise<{ nativePath?: string }>;
        getTemporaryFolder?(): Promise<{ nativePath?: string }>;
      };
    };
  }>("uxp")?.storage?.localFileSystem;

  const dataNative = await nativePathOf(storage?.getDataFolder?.bind(storage), "getDataFolder");
  if (dataNative) {
    list.push({
      fsBase: `plugin-data:/${WORK_FOLDER}`,
      nativeBase: join(dataNative, WORK_FOLDER),
      origin: "plugin-data + subpasta",
    });
    list.push({
      fsBase: "plugin-data:",
      nativeBase: dataNative,
      origin: "plugin-data raiz",
    });
  }

  const tempNative = await nativePathOf(
    storage?.getTemporaryFolder?.bind(storage),
    "getTemporaryFolder"
  );
  if (tempNative) {
    list.push({
      fsBase: `plugin-temp:/${WORK_FOLDER}`,
      nativeBase: join(tempNative, WORK_FOLDER),
      origin: "plugin-temp + subpasta",
    });
    list.push({
      fsBase: "plugin-temp:",
      nativeBase: tempNative,
      origin: "plugin-temp raiz",
    });
  }

  // Caminho nativo puro: o que o Premiere recusa hoje. Fica por último
  // em vez de ser removido — a rota pode existir noutra build, e nesse
  // caso é a mais simples de todas.
  if (dataNative) {
    list.push({
      fsBase: join(dataNative, WORK_FOLDER),
      nativeBase: join(dataNative, WORK_FOLDER),
      origin: "caminho nativo (dados do plugin)",
    });
  }
  try {
    const home = uxpModule<{ homedir(): string }>("os")?.homedir?.();
    if (home) {
      const base = isWindows()
        ? join(home, "AppData", "Local", "EditToolbox")
        : join(home, "Library", "Caches", "EditToolbox");
      list.push({ fsBase: base, nativeBase: base, origin: "caminho nativo (home)" });
    }
  } catch (cause) {
    attempts.push(`os.homedir: ${describe(cause)}`);
  }

  return list;
}

async function nativePathOf(
  read: (() => Promise<{ nativePath?: string }>) | undefined,
  label: string
): Promise<string | null> {
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
    attempts.push(`${label}: ${describe(cause)}`);
  }
  return null;
}

/**
 * Um candidato só vale se der para escrever E ler de volta.
 *
 * Ler de volta não é zelo excessivo: uma escrita pode "funcionar" numa
 * rota que engole o arquivo, e o erro só apareceria minutos depois,
 * quando o PCM não estivesse lá.
 */
async function tryCandidate(fs: UxpFs, candidate: Candidate): Promise<Workspace | null> {
  // Tried for every candidate, not only the ones whose path spells out the
  // work folder: the native fallback under the user's cache directory has
  // its own folder name, and skipping mkdir there meant it always failed
  // for the one reason nothing reported — the folder did not exist.
  try {
    await fs.mkdir(candidate.fsBase, { recursive: true });
  } catch {
    // Já existir é o caso comum, e uma raiz de esquema não tem o que
    // criar. Não implementado também não é fatal: a escrita decide.
  }

  const probe = join(candidate.fsBase, PROBE_FILE);
  const stamp = "edit-toolbox";

  for (const sync of [true, false]) {
    try {
      if (sync) {
        fs.writeFileSync(probe, stamp, { encoding: "utf-8" });
      } else {
        await fs.writeFile(probe, stamp, { encoding: "utf-8" });
      }
      const back = String(fs.readFileSync(probe, { encoding: "utf-8" }));
      if (back.trim() !== stamp) {
        attempts.push(`${candidate.origin}: leu "${back.slice(0, 20)}"`);
        continue;
      }
      return { ...candidate, sync };
    } catch (cause) {
      attempts.push(`${candidate.origin} ${sync ? "sync" : "async"}: ${describe(cause)}`);
    }
  }
  return null;
}

// ── escrita e leitura, já no endereço certo ────────────────────────

export function fsPath(space: Workspace, name: string): string {
  return join(space.fsBase, name);
}

export function nativePath(space: Workspace, name: string): string {
  return join(space.nativeBase, name);
}

/**
 * Escreve um arquivo, com bit de execução quando pedido.
 *
 * O `mode` é o que faz `openPath` executar o script em vez de abrir
 * num editor. Se a build não aceitar a opção, escreve sem ela: o erro
 * depois é claro, e esta falha seria muda.
 */
export async function write(
  space: Workspace,
  name: string,
  data: string,
  executable = false
): Promise<void> {
  const fs = fsModule();
  if (!fs) {
    throw new Error('require("fs") não resolveu');
  }
  const path = fsPath(space, name);
  // Only the executable case has a second shape to fall back to. The old
  // list held two objects with identical contents when `executable` was
  // false, so an ordinary write was attempted twice for nothing.
  const attempts: Array<{ encoding: string; mode?: number }> = executable
    ? [{ encoding: "utf-8", mode: 0o755 }, { encoding: "utf-8" }]
    : [{ encoding: "utf-8" }];

  let lastError: unknown = null;
  for (const options of attempts) {
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

export function readText(space: Workspace, name: string): string | null {
  const fs = fsModule();
  if (!fs) {
    return null;
  }
  try {
    const raw = fs.readFileSync(fsPath(space, name), { encoding: "utf-8" });
    const text = String(raw).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function remove(space: Workspace, name: string): Promise<void> {
  const fs = fsModule();
  if (!fs) {
    return;
  }
  try {
    await fs.unlink(fsPath(space, name));
  } catch {
    // Não existir é o caso comum.
  }
}

export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
