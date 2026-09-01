/**
 * Baixar Vídeos — a ponte com o yt-dlp.
 *
 * ── Por que o desenho é este ───────────────────────────────────────
 * Vale o mesmo que vale para o ffmpeg em `../silence/ffmpeg.ts`: o UXP
 * não tem `child_process`, só `shell.openPath`, que abre um arquivo
 * com o aplicativo padrão — e um script executável é "aberto" sendo
 * executado. Não dá para passar argumentos nem capturar a saída, e as
 * duas limitações somem pelo mesmo motivo: o script é GERADO aqui, com
 * os argumentos já escritos dentro, e o resultado volta por arquivo.
 *
 * A pasta de trabalho, o endereçamento duplo (esquema do `fs` para
 * dentro, caminho nativo para fora) e a escrita com bit de execução
 * vêm inteiros de `../silence/workspace.ts` — é infraestrutura do
 * plugin, não do Corte de Silêncios, e duplicá-la só criaria uma
 * segunda cópia para envelhecer sozinha.
 *
 * ── O ciclo ────────────────────────────────────────────────────────
 * 1. SONDAGEM: um script roda `yt-dlp -J` por link e escreve um JSON
 *    por link. O painel lê e mostra título, duração e as resoluções
 *    que existem de verdade — em vez de oferecer 4K num vídeo 720p.
 * 2. DOWNLOAD: outro script roda o yt-dlp com o seletor de formato da
 *    qualidade escolhida, escrevendo o log com `--newline` (de onde o
 *    painel tira a porcentagem) e o caminho final de cada arquivo em
 *    `dl-files.txt` (de onde sai a importação para o projeto).
 *
 * ── Marca d'água ───────────────────────────────────────────────────
 * O TikTok serve o mesmo vídeo em versões com e sem marca; o yt-dlp
 * expõe as duas e marca a carimbada em `format_id`/`format_note`. Todo
 * seletor daqui carrega `[format_note!*=?watermark]` — o `?` é o que
 * mantém no páreo os formatos que simplesmente não têm essa etiqueta,
 * que é o caso do YouTube inteiro. Sem ele, o filtro derrubava tudo.
 */
import {
  describe,
  isWindows,
  join,
  nativePath,
  readText,
  remove,
  shellModule,
  uxpModule,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

// ── nomes dos arquivos do protocolo ────────────────────────────────

const RESULT_FILE = "dl-result.json";
const PROGRESS_FILE = "dl-progress.txt";
const LOG_FILE = "dl-log.txt";
const FILES_FILE = "dl-files.txt";
const CONFIG_FILE = "download-config.json";
const SCRIPT_FILE = "download.command";
const SCRIPT_FILE_WIN = "download.bat";
/** O binário que o botão "Instalar" deixa na pasta de trabalho. */
const LOCAL_BIN = "yt-dlp";
const LOCAL_BIN_WIN = "yt-dlp.exe";

/** Prefixo dos JSON de sondagem: `dl-info-0.json`, `dl-info-1.json`… */
function infoFile(index: number): string {
  return `dl-info-${index}.json`;
}

function scriptName(): string {
  return isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
}

export function localBinaryName(): string {
  return isWindows() ? LOCAL_BIN_WIN : LOCAL_BIN;
}

// ── polling ────────────────────────────────────────────────────────

const POLL_MS = 400;
/** Uma sondagem é rede e nada mais; um download pode ser meia hora. */
const PROBE_TIMEOUT_MS = 3 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 90 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

// ── configuração ───────────────────────────────────────────────────

export type Cookies = "none" | "chrome" | "safari" | "firefox" | "edge" | "brave";

export interface DownloadConfig {
  /** Caminho do yt-dlp escolhido à mão. Vazio = descobrir sozinho. */
  ytdlpPath: string;
  /** Pasta de destino em caminho NATIVO. Vazio = a padrão do sistema. */
  destination: string;
  /** Última qualidade usada. Escolha de hábito, não de projeto. */
  quality: string;
  /** Navegador de onde tirar os cookies, para vídeo restrito. */
  cookies: Cookies;
  /** Importar para o projeto aberto assim que baixar. */
  importToProject: boolean;
}

export const DEFAULT_CONFIG: DownloadConfig = {
  ytdlpPath: "",
  destination: "",
  quality: "best",
  cookies: "none",
  importToProject: true,
};

export async function readConfig(): Promise<DownloadConfig> {
  try {
    const raw = readText(await workspace(), CONFIG_FILE);
    if (!raw) {
      return { ...DEFAULT_CONFIG };
    }
    const parsed = JSON.parse(raw) as Partial<DownloadConfig>;
    return {
      ytdlpPath: typeof parsed.ytdlpPath === "string" ? parsed.ytdlpPath : "",
      destination: typeof parsed.destination === "string" ? parsed.destination : "",
      quality: typeof parsed.quality === "string" ? parsed.quality : "best",
      cookies: isCookies(parsed.cookies) ? parsed.cookies : "none",
      importToProject: parsed.importToProject !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function isCookies(value: unknown): value is Cookies {
  return (
    value === "none" ||
    value === "chrome" ||
    value === "safari" ||
    value === "firefox" ||
    value === "edge" ||
    value === "brave"
  );
}

export async function writeConfig(config: DownloadConfig): Promise<void> {
  try {
    await write(await workspace(), CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (cause) {
    console.error("[Download] não foi possível salvar a configuração:", cause);
  }
}

/**
 * Onde os vídeos caem quando o editor não escolheu uma pasta.
 *
 * Movies/Vídeos e não a pasta do plugin: o que se baixa é material de
 * trabalho, e material de trabalho não mora num cache que o Premiere
 * pode limpar sem avisar.
 */
export async function defaultDestination(): Promise<string> {
  const home = uxpModule<{ homedir(): string }>("os")?.homedir?.() ?? "";
  if (!home) {
    // Sem home legível, a pasta de trabalho é pior mas existe.
    return (await workspace()).nativeBase;
  }
  return isWindows()
    ? join(home, "Videos", "Framelab")
    : join(home, "Movies", "Framelab");
}

// ── qualidades ─────────────────────────────────────────────────────

export interface Quality {
  readonly id: string;
  readonly label: string;
  /** Altura máxima em pixels. null = sem teto, ou só áudio. */
  readonly height: number | null;
  readonly audioOnly: boolean;
}

/**
 * A escada de qualidade.
 *
 * Alturas em vez de nomes de formato porque o formato exato varia por
 * site e por vídeo, e a pergunta que o editor faz é sempre a mesma:
 * quão grande eu quero isso. A sondagem depois esconde os degraus que
 * aquele vídeo não tem.
 */
export const QUALITIES: readonly Quality[] = [
  { id: "best", label: "Máxima", height: null, audioOnly: false },
  { id: "2160", label: "4K", height: 2160, audioOnly: false },
  { id: "1440", label: "1440p", height: 1440, audioOnly: false },
  { id: "1080", label: "1080p", height: 1080, audioOnly: false },
  { id: "720", label: "720p", height: 720, audioOnly: false },
  { id: "480", label: "480p", height: 480, audioOnly: false },
  { id: "audio", label: "MP3", height: null, audioOnly: true },
];

export function findQuality(id: string): Quality {
  return QUALITIES.find((q) => q.id === id) ?? QUALITIES[0];
}

/**
 * Só formatos sem marca d'água.
 *
 * `!*=?` é "não contém, e passa se o campo não existir". Os dois campos
 * são testados porque o TikTok carimba ora um, ora o outro, conforme a
 * rota de onde o extractor tirou o formato.
 */
const NO_WATERMARK = "[format_note!*=?watermark][format_id!*=?watermark]";

/**
 * O argumento de `-f`.
 *
 * ── Por que o teto não é `[height<=N]` ─────────────────────────────
 * Porque num vídeo vertical a altura é o lado GRANDE. O TikTok de
 * 1080p é 1080×1920, e `[height<=1080]` deixava passar só o 576×1024 —
 * ou seja, pedir 1080p entregava a pior cópia que existia. Medido no
 * vídeo real antes de escrever isto.
 *
 * Quem escolhe de verdade é o `-S res:N` de `sortArg`, porque o `res`
 * do yt-dlp é o MENOR lado e por isso não tem orientação. O filtro
 * aqui só põe um teto grosseiro — nenhum lado acima do dobro do
 * pedido — para o `-S` não ter que decidir entre 1080p e 4K quando o
 * editor pediu 1080p. Aspecto até 2:1 passa; o que não passar cai nas
 * alternativas seguintes, que é melhor que voltar de mãos vazias.
 */
export function formatSelector(quality: Quality): string {
  if (quality.audioOnly) {
    return `ba${NO_WATERMARK}/ba/b${NO_WATERMARK}/b`;
  }
  if (quality.height === null) {
    return `bv*${NO_WATERMARK}+ba/b${NO_WATERMARK}/bv*+ba/b`;
  }
  const ceiling = quality.height * 2;
  const cap = `[width<=${ceiling}][height<=${ceiling}]`;
  return (
    `bv*${NO_WATERMARK}${cap}+ba/b${NO_WATERMARK}${cap}/` +
    `bv*${NO_WATERMARK}+ba/b${NO_WATERMARK}/b`
  );
}

/**
 * O argumento de `-S`, que é quem de fato escolhe a resolução.
 *
 * `res` é o menor lado do vídeo, então `res:1080` quer dizer "1080p"
 * no sentido em que uma pessoa usa a palavra — vale para deitado e
 * para em pé. Sem valor, ordena da maior para a menor.
 */
export function sortArg(quality: Quality): string | null {
  if (quality.audioOnly) {
    return null;
  }
  return quality.height === null ? "res" : `res:${quality.height}`;
}

// ── sondagem: o que o painel guarda de cada link ───────────────────

export interface Probe {
  url: string;
  ok: boolean;
  /** Frase pronta quando `ok` é false. */
  error: string | null;
  title: string;
  id: string;
  /** "Youtube", "TikTok"… como o yt-dlp chama o extractor. */
  site: string;
  uploader: string | null;
  durationSeconds: number | null;
  /**
   * As resoluções sem marca d'água, da maior para a menor.
   *
   * Medidas pelo lado MENOR, que é o que "1080p" quer dizer tanto num
   * vídeo deitado quanto num vertical. Guardar a altura crua fazia o
   * painel anunciar "1920p" num TikTok comum.
   */
  resolutions: number[];
  /** Tamanho estimado em bytes por resolução. Falta quando o site não diz. */
  sizeByResolution: Record<number, number>;
  /** true quando o site servia versão carimbada e ela foi descartada. */
  hadWatermarked: boolean;
}

interface RawFormat {
  format_id?: unknown;
  format_note?: unknown;
  width?: unknown;
  height?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  ext?: unknown;
  tbr?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** O lado menor: a resolução no sentido em que se fala dela. */
function shortSide(format: RawFormat): number | null {
  const width = num(format.width);
  const height = num(format.height);
  if (width !== null && width > 0 && height !== null && height > 0) {
    return Math.min(width, height);
  }
  return height !== null && height > 0 ? height : null;
}

function isWatermarked(format: RawFormat): boolean {
  const haystack = `${text(format.format_id)} ${text(format.format_note)}`;
  return /water\s*mark|wm\b/i.test(haystack);
}

/**
 * Transforma o JSON gigante do yt-dlp no punhado de campos que a tela
 * usa. O resto — centenas de KB de fragmentos e cabeçalhos HTTP — é
 * descartado aqui e nunca chega a viver no estado da ferramenta.
 */
export function parseProbe(url: string, raw: string): Probe {
  const empty: Probe = {
    url,
    ok: false,
    error: null,
    title: url,
    id: "",
    site: "",
    uploader: null,
    durationSeconds: null,
    resolutions: [],
    sizeByResolution: {},
    hadWatermarked: false,
  };

  let info: Record<string, unknown>;
  try {
    info = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...empty, error: "Resposta ilegível do yt-dlp." };
  }

  // Playlist: o `-J` devolve um envelope com `entries`. O painel pede
  // `--no-playlist`, então isto só aparece quando o link NÃO tem vídeo
  // próprio — e aí a primeira entrada é a resposta mais honesta.
  if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length > 0) {
    info = info.entries[0] as Record<string, unknown>;
  }

  const formats = Array.isArray(info.formats) ? (info.formats as RawFormat[]) : [];
  const duration = num(info.duration);

  const sizeByResolution: Record<number, number> = {};
  const resolutions = new Set<number>();
  let hadWatermarked = false;
  let bestAudioBytes = 0;

  for (const format of formats) {
    if (isWatermarked(format)) {
      hadWatermarked = true;
      continue;
    }
    const hasVideo = text(format.vcodec) !== "none" && text(format.vcodec) !== "";
    const bytes = estimateBytes(format, duration);

    if (!hasVideo) {
      if (bytes > bestAudioBytes) {
        bestAudioBytes = bytes;
      }
      continue;
    }
    const resolution = shortSide(format);
    if (resolution === null) {
      continue;
    }
    resolutions.add(resolution);
    // O maior de cada resolução: é o que o seletor vai escolher.
    if (bytes > (sizeByResolution[resolution] ?? 0)) {
      sizeByResolution[resolution] = bytes;
    }
  }

  // Formato só-vídeo precisa do áudio junto para virar arquivo; sem
  // somar, o 4K do YouTube aparecia menor que o 720p progressivo.
  for (const resolution of resolutions) {
    const size = sizeByResolution[resolution];
    if (size && !hasAudioAt(formats, resolution)) {
      sizeByResolution[resolution] = size + bestAudioBytes;
    }
  }

  return {
    url,
    ok: true,
    error: null,
    title: text(info.title) || url,
    id: text(info.id),
    site: text(info.extractor_key) || text(info.extractor),
    uploader: text(info.uploader) || text(info.channel) || null,
    durationSeconds: duration,
    resolutions: [...resolutions].sort((a, b) => b - a),
    sizeByResolution,
    hadWatermarked,
  };
}

function hasAudioAt(formats: RawFormat[], resolution: number): boolean {
  return formats.some(
    (format) =>
      shortSide(format) === resolution &&
      text(format.acodec) !== "none" &&
      text(format.acodec) !== "" &&
      !isWatermarked(format)
  );
}

function estimateBytes(format: RawFormat, durationSeconds: number | null): number {
  const exact = num(format.filesize) ?? num(format.filesize_approx);
  if (exact !== null && exact > 0) {
    return exact;
  }
  const tbr = num(format.tbr);
  if (tbr !== null && tbr > 0 && durationSeconds !== null && durationSeconds > 0) {
    // tbr vem em kbit/s.
    return Math.round((tbr * 1000 * durationSeconds) / 8);
  }
  return 0;
}

/** As qualidades que fazem sentido oferecer para estes links. */
export function availableQualities(probes: readonly Probe[]): Quality[] {
  const ok = probes.filter((probe) => probe.ok);
  if (ok.length === 0) {
    return [...QUALITIES];
  }
  const tallest = Math.max(...ok.map((probe) => probe.resolutions[0] ?? 0));
  return QUALITIES.filter(
    (quality) => quality.height === null || quality.height <= tallest
  );
}

// ── execução ───────────────────────────────────────────────────────

export interface RunResult {
  ok: boolean;
  /** Código curto: "ytdlp-not-found", "ytdlp-failed", "timeout"… */
  error: string | null;
  ytdlpPath: string | null;
  scriptPath: string | null;
  /** Quantos links falharam, quando o script chegou ao fim. */
  failed: number;
  /** As últimas linhas do log — o que o yt-dlp reclamou. */
  log: string;
}

export interface RunProgress {
  /** Índice do link corrente (1-based) e total. */
  (done: number, total: number, percent: number | null, log: string): void;
}

interface Launch {
  /**
   * Constrói o script. É função e não texto porque todo script cita a
   * pasta de trabalho lá dentro, e ela só se conhece depois do await.
   */
  build(space: Workspace): string;
  timeoutMs: number;
  /** Arquivos de uma execução anterior que precisam sumir antes. */
  stale: string[];
  onProgress?: RunProgress;
  total: number;
  cancelled?: () => boolean;
  onManual?: (scriptPath: string, reason: string) => void;
  purpose: string;
}

/**
 * Escreve o script, dispara, e espera o `result.json`.
 *
 * O corpo é o mesmo das três operações — sondar, baixar, instalar —
 * porque o que muda entre elas é só o texto do script e o tempo que
 * vale a pena esperar.
 */
async function run(launch: Launch): Promise<RunResult> {
  const shell = shellModule();
  if (!shell) {
    return fail("uxp-unavailable", null);
  }

  const space = await workspace();
  const scriptPath = nativePath(space, scriptName());

  // Sobra de uma execução anterior faria o polling terminar antes de o
  // yt-dlp começar, com o resultado do link de ontem.
  for (const name of [RESULT_FILE, PROGRESS_FILE, LOG_FILE, FILES_FILE, ...launch.stale]) {
    await remove(space, name);
  }

  await write(space, scriptName(), launch.build(space), true);

  // Uma recusa aqui não é o fim: o script está escrito e é um duplo
  // clique. O polling segue esperando por ele.
  let launchError: string | null = null;
  try {
    await shell.openPath(scriptPath, launch.purpose);
  } catch (cause) {
    launchError = describe(cause);
    console.error("[Download] openPath recusou:", cause);
    launch.onManual?.(scriptPath, launchError);
  }

  const deadline = Date.now() + launch.timeoutMs;
  let lastSignature = "";
  while (Date.now() < deadline) {
    if (launch.cancelled?.()) {
      return { ...fail("cancelled", scriptPath) };
    }

    if (launch.onProgress) {
      const log = tail(space);
      const done = readProgress(space);
      const percent = readPercent(log);
      const signature = `${done}|${percent}|${log.length}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        launch.onProgress(done, launch.total, percent, log);
      }
    }

    const raw = readText(space, RESULT_FILE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          ok?: boolean;
          error?: string;
          ytdlp?: string;
          failed?: number;
        };
        return {
          ok: parsed.ok === true,
          error: parsed.ok === true ? null : parsed.error ?? "ytdlp-failed",
          ytdlpPath: typeof parsed.ytdlp === "string" ? parsed.ytdlp : null,
          scriptPath,
          failed: typeof parsed.failed === "number" ? parsed.failed : 0,
          log: tail(space),
        };
      } catch {
        // JSON pela metade: o `mv` do script torna isso raro, e uma
        // volta a mais custa um passo.
      }
    }
    await wait(POLL_MS);
  }

  return {
    ...fail(launchError ? `launch-denied: ${launchError}` : "timeout", scriptPath),
    log: tail(space),
  };
}

function fail(error: string, scriptPath: string | null): RunResult {
  return { ok: false, error, ytdlpPath: null, scriptPath, failed: 0, log: "" };
}

function readProgress(space: Workspace): number {
  const raw = readText(space, PROGRESS_FILE);
  const parsed = Number.parseInt(raw?.split("/")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** As últimas linhas do log. O começo não interessa; o fim é o erro. */
function tail(space: Workspace, lines = 12): string {
  const raw = readText(space, LOG_FILE);
  if (!raw) {
    return "";
  }
  return raw.split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * A porcentagem do download corrente, tirada do log.
 *
 * `--newline` faz o yt-dlp escrever cada atualização numa linha
 * própria, então a última que casar é o estado de agora.
 */
function readPercent(log: string): number | null {
  const matches = log.match(/(\d{1,3}(?:\.\d)?)%/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  const value = Number.parseFloat(matches[matches.length - 1]);
  return Number.isFinite(value) ? Math.min(100, value) : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── as três operações ──────────────────────────────────────────────

export async function probeUrls(
  urls: readonly string[],
  config: DownloadConfig,
  onProgress?: RunProgress,
  cancelled?: () => boolean,
  onManual?: (scriptPath: string, reason: string) => void
): Promise<{ result: RunResult; probes: Probe[] }> {
  const stale = urls.map((_, index) => infoFile(index));

  const result = await run({
    build: (space) =>
      isWindows()
        ? probeScriptWin(urls, config, space.nativeBase)
        : probeScriptUnix(urls, config, space.nativeBase),
    timeoutMs: PROBE_TIMEOUT_MS,
    stale,
    onProgress,
    total: urls.length,
    cancelled,
    onManual,
    purpose: "Consultar os dados dos vídeos com o yt-dlp.",
  });

  const space = await workspace();
  const probes = urls.map((url, index) => {
    const raw = readText(space, infoFile(index));
    if (!raw) {
      return {
        url,
        ok: false,
        error: "O yt-dlp não conseguiu ler este link.",
        title: url,
        id: "",
        site: "",
        uploader: null,
        durationSeconds: null,
        resolutions: [],
        sizeByResolution: {},
        hadWatermarked: false,
      } satisfies Probe;
    }
    return parseProbe(url, raw);
  });

  return { result, probes };
}

export interface DownloadOutcome extends RunResult {
  /** Caminhos nativos do que foi de fato escrito no disco. */
  files: string[];
}

export async function downloadUrls(
  urls: readonly string[],
  quality: Quality,
  config: DownloadConfig,
  onProgress?: RunProgress,
  cancelled?: () => boolean,
  onManual?: (scriptPath: string, reason: string) => void
): Promise<DownloadOutcome> {
  const destination = config.destination || (await defaultDestination());

  const result = await run({
    build: (space) =>
      isWindows()
        ? downloadScriptWin(urls, quality, config, space.nativeBase, destination)
        : downloadScriptUnix(urls, quality, config, space.nativeBase, destination),
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    stale: [],
    onProgress,
    total: urls.length,
    cancelled,
    onManual,
    purpose: "Baixar os vídeos dos links informados com o yt-dlp.",
  });

  const space = await workspace();
  const listed = readText(space, FILES_FILE);
  const files = listed
    ? listed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

  return { ...result, files };
}

/**
 * Baixa o binário oficial do yt-dlp para a pasta de trabalho.
 *
 * Existe porque a alternativa era mandar o editor abrir um terminal e
 * digitar `brew install`, e o editor que precisa disso é justamente o
 * que não tem o Homebrew. O binário do macOS é autocontido — não
 * depende de um Python instalado.
 */
export async function installYtdlp(
  onManual?: (scriptPath: string, reason: string) => void
): Promise<RunResult> {
  return run({
    build: (space) =>
      isWindows()
        ? installScriptWin(space.nativeBase)
        : installScriptUnix(space.nativeBase),
    timeoutMs: INSTALL_TIMEOUT_MS,
    stale: [],
    total: 1,
    onManual,
    purpose: "Baixar o yt-dlp oficial para a pasta do plugin.",
  });
}

/** Abre a pasta de trabalho, para rodar o script à mão. */
export async function openWorkFolder(): Promise<void> {
  const shell = shellModule();
  if (!shell) {
    throw new Error("uxp.shell indisponível");
  }
  const space = await workspace();
  await shell.openPath(space.nativeBase, "Abrir a pasta do script de download.");
}

// ── geração do script (unix) ───────────────────────────────────────

/**
 * Aspas simples de shell.
 *
 * Um link do YouTube tem `&` e `?`, um título tem acento e apóstrofo, e
 * um apóstrofo sem escape transforma o caminho em comando. Toda string
 * que entra num script passa por aqui.
 */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** O preâmbulo comum: acha o yt-dlp, ou desiste dizendo por quê. */
function unixPreamble(folder: string, config: DownloadConfig): string[] {
  return [
    "#!/bin/bash",
    "# Gerado pelo Framelab — Baixar Vídeos. Pode apagar.",
    `printf '\\033]0;Framelab — baixando\\007'`,
    "set -u",
    `WORK=${q(folder)}`,
    `CUSTOM=${q(config.ytdlpPath)}`,
    "YTDLP=''",
    // A ordem procura primeiro o que o editor escolheu, depois o
    // binário que o botão "Instalar" deixa aqui, e só então os lugares
    // do Homebrew, do MacPorts e do pip — que num shell não interativo
    // podem nem estar no PATH.
    'for candidate in "$CUSTOM" "$WORK/yt-dlp" /opt/homebrew/bin/yt-dlp ' +
      '/usr/local/bin/yt-dlp /opt/local/bin/yt-dlp "$HOME/.local/bin/yt-dlp"; do',
    '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then YTDLP="$candidate"; break; fi',
    "done",
    'if [ -z "$YTDLP" ]; then YTDLP="$(command -v yt-dlp 2>/dev/null || true)"; fi',
    'if [ -z "$YTDLP" ]; then',
    `  printf '{"ok":false,"error":"ytdlp-not-found"}' > "$WORK/${RESULT_FILE}.tmp"`,
    `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    '  echo "yt-dlp nao encontrado. Use o botao Instalar no painel, ou brew install yt-dlp."',
    "  exit 1",
    "fi",
    'echo "yt-dlp: $YTDLP"',
  ];
}

/**
 * O ffmpeg é opcional na sondagem e obrigatório no download acima de
 * 1080p: acima disso o YouTube só serve vídeo e áudio separados, e é o
 * ffmpeg que junta os dois. Sem ele o yt-dlp cai sozinho num formato
 * progressivo — pior, mas ainda um arquivo.
 */
function unixFfmpeg(): string[] {
  return [
    "FFMPEG=''",
    "for candidate in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg " +
      "/opt/local/bin/ffmpeg /usr/bin/ffmpeg; do",
    '  if [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
    "done",
    'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
    "FFDIR=''",
    'if [ -n "$FFMPEG" ]; then FFDIR="$(dirname "$FFMPEG")"; fi',
  ];
}

const UNIX_CLOSE = [
  'echo "Pronto. Pode voltar ao Premiere."',
  // Fecha só a própria janela, achada pelo título posto no preâmbulo.
  // Se o macOS negar a automação, a janela fica aberta e nada quebra.
  `osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 &`,
  "exit 0",
];

export function probeScriptUnix(
  urls: readonly string[],
  config: DownloadConfig,
  folder: string
): string {
  const lines = unixPreamble(folder, config);
  lines.push("FAILED=0");

  urls.forEach((url, index) => {
    const target = `"$WORK/${infoFile(index)}"`;
    lines.push(
      `echo "[${index + 1}/${urls.length}] consultando…"`,
      `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
      `if "$YTDLP" --no-warnings --no-playlist --ignore-config ` +
        `${cookiesArg(config)}-J ${q(url)} > ${target}.tmp 2>> "$WORK/${LOG_FILE}"; then`,
      `  mv ${target}.tmp ${target}`,
      "else",
      "  FAILED=$((FAILED+1))",
      `  rm -f ${target}.tmp`,
      "fi"
    );
  });

  lines.push(
    `printf '{"ok":true,"ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE}.tmp"`,
    `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    ...UNIX_CLOSE
  );

  return lines.join("\n") + "\n";
}

export function downloadScriptUnix(
  urls: readonly string[],
  quality: Quality,
  config: DownloadConfig,
  folder: string,
  destination: string
): string {
  const lines = unixPreamble(folder, config);
  lines.push(...unixFfmpeg());
  lines.push(`DEST=${q(destination)}`, 'mkdir -p "$DEST"', "FAILED=0");

  const shared =
    `--newline --no-mtime --no-playlist --ignore-config --windows-filenames ` +
    `--trim-filenames 120 --retries 5 --fragment-retries 10 ` +
    `-o ${q("%(title)s [%(id)s].%(ext)s")} ` +
    `--print-to-file after_move:filepath "$WORK/${FILES_FILE}" ` +
    cookiesArg(config);

  const sort = sortArg(quality);
  const media = quality.audioOnly
    ? `-x --audio-format mp3 --audio-quality 0 -f ${q(formatSelector(quality))}`
    : // mp4 porque o destino é uma timeline do Premiere, e um webm/vp9
      // entra lá para arrastar a reprodução.
      `-f ${q(formatSelector(quality))} ${sort ? `-S ${q(sort)} ` : ""}` +
      `--merge-output-format mp4`;

  urls.forEach((url, index) => {
    lines.push(
      `echo "[${index + 1}/${urls.length}] ${escapeEcho(url)}"`,
      `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
      // `${FFDIR:+…}` some inteiro quando não há ffmpeg, em vez de
      // passar uma flag com valor vazio — que o yt-dlp recusa.
      `"$YTDLP" ${shared} ${media} -P "$DEST" ` +
        `\${FFDIR:+--ffmpeg-location "$FFDIR"} ${q(url)} 2>&1 | ` +
        `tee -a "$WORK/${LOG_FILE}"`,
      // `tee` sempre devolve 0; quem falhou foi o yt-dlp, e é o status
      // dele que o PIPESTATUS guarda.
      'if [ "${PIPESTATUS[0]}" -ne 0 ]; then FAILED=$((FAILED+1)); fi'
    );
  });

  lines.push(
    'if [ "$FAILED" -eq 0 ]; then',
    `  printf '{"ok":true,"ytdlp":"%s","failed":0}' "$YTDLP" > "$WORK/${RESULT_FILE}.tmp"`,
    "else",
    `  printf '{"ok":false,"error":"ytdlp-failed","ytdlp":"%s","failed":%s}' "$YTDLP" "$FAILED" > "$WORK/${RESULT_FILE}.tmp"`,
    "fi",
    `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    ...UNIX_CLOSE
  );

  return lines.join("\n") + "\n";
}

const RELEASE_MAC =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
const RELEASE_WIN =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";

export function installScriptUnix(folder: string): string {
  return (
    [
      "#!/bin/bash",
      "# Gerado pelo Framelab — Baixar Vídeos. Pode apagar.",
      `printf '\\033]0;Framelab — instalando yt-dlp\\007'`,
      "set -u",
      `WORK=${q(folder)}`,
      `echo "Baixando o yt-dlp oficial…"`,
      `if curl -fL --retry 3 -o "$WORK/${LOCAL_BIN}.tmp" ${q(RELEASE_MAC)} 2>&1 | tee -a "$WORK/${LOG_FILE}"; then`,
      `  chmod +x "$WORK/${LOCAL_BIN}.tmp"`,
      `  mv "$WORK/${LOCAL_BIN}.tmp" "$WORK/${LOCAL_BIN}"`,
      // O binário do macOS vem sem assinatura reconhecida pelo
      // Gatekeeper; sem tirar a quarentena, a primeira execução morre
      // num diálogo que o painel nunca veria.
      `  xattr -d com.apple.quarantine "$WORK/${LOCAL_BIN}" >/dev/null 2>&1 || true`,
      `  if "$WORK/${LOCAL_BIN}" --version >/dev/null 2>&1; then`,
      `    printf '{"ok":true,"ytdlp":"%s"}' "$WORK/${LOCAL_BIN}" > "$WORK/${RESULT_FILE}.tmp"`,
      "  else",
      `    printf '{"ok":false,"error":"install-unusable"}' > "$WORK/${RESULT_FILE}.tmp"`,
      "  fi",
      "else",
      `  rm -f "$WORK/${LOCAL_BIN}.tmp"`,
      `  printf '{"ok":false,"error":"install-failed"}' > "$WORK/${RESULT_FILE}.tmp"`,
      "fi",
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
      ...UNIX_CLOSE,
    ].join("\n") + "\n"
  );
}

function cookiesArg(config: DownloadConfig): string {
  return config.cookies === "none" ? "" : `--cookies-from-browser ${config.cookies} `;
}

/** Um valor seguro dentro de um `echo` de diagnóstico. */
function escapeEcho(value: string): string {
  return value.replace(/["`$\\]/g, "").slice(0, 90);
}

// ── geração do script (windows) ────────────────────────────────────

/**
 * Um valor seguro dentro de `set "NOME=…"` num .bat.
 *
 * O cmd não tem escape para uma aspa dentro de um `set` entre aspas,
 * então ela é removida em vez de contrabandeada. O porcento é dobrado,
 * que é como um .bat escreve um porcento literal — e o template de
 * nome de arquivo do yt-dlp é feito só de porcentos.
 */
function batValue(value: string): string {
  return value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
}

function bq(value: string): string {
  return `"${batValue(value)}"`;
}

/** Mesma coreografia em cmd.exe. Não testado num Windows real. */
function winPreamble(config: DownloadConfig, folder: string): string[] {
  return [
    "@echo off",
    "rem Gerado pelo Framelab - Baixar Videos. Pode apagar.",
    "title Framelab - baixando",
    `set "WORK=${batValue(folder)}"`,
    `set "YTDLP=${batValue(config.ytdlpPath)}"`,
    `if "%YTDLP%"=="" if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
    `if "%YTDLP%"=="" for %%i in (yt-dlp.exe) do @set "YTDLP=%%~$PATH:i"`,
    'if "%YTDLP%"=="" (',
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ytdlp-not-found"}`,
    `  move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "  echo yt-dlp nao encontrado. Use o botao Instalar no painel.",
    "  exit /b 1",
    ")",
    "set FAILED=0",
  ];
}

export function probeScriptWin(
  urls: readonly string[],
  config: DownloadConfig,
  folder: string
): string {
  const lines = winPreamble(config, folder);

  urls.forEach((url, index) => {
    const target = `"%WORK%\\${infoFile(index)}"`;
    lines.push(
      `echo [${index + 1}/${urls.length}] consultando...`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
      `"%YTDLP%" --no-warnings --no-playlist --ignore-config ` +
        `${cookiesArg(config)}-J ${bq(url)} > ${target} 2>>"%WORK%\\${LOG_FILE}"`,
      "if errorlevel 1 set /a FAILED+=1"
    );
  });

  lines.push(
    `>"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":%FAILED%}`,
    `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "exit /b 0"
  );

  return lines.join("\r\n") + "\r\n";
}

export function downloadScriptWin(
  urls: readonly string[],
  quality: Quality,
  config: DownloadConfig,
  folder: string,
  destination: string
): string {
  const lines = winPreamble(config, folder);
  lines.push(
    `set "DEST=${batValue(destination)}"`,
    'if not exist "%DEST%" mkdir "%DEST%"'
  );

  const shared =
    `--newline --no-mtime --no-playlist --ignore-config --windows-filenames ` +
    `--trim-filenames 120 --retries 5 --fragment-retries 10 ` +
    `-o ${bq("%(title)s [%(id)s].%(ext)s")} ` +
    `--print-to-file after_move:filepath "%WORK%\\${FILES_FILE}" ` +
    cookiesArg(config);

  const sort = sortArg(quality);
  const media = quality.audioOnly
    ? `-x --audio-format mp3 --audio-quality 0 -f ${bq(formatSelector(quality))}`
    : `-f ${bq(formatSelector(quality))} ${sort ? `-S ${bq(sort)} ` : ""}` +
      `--merge-output-format mp4`;

  urls.forEach((url, index) => {
    lines.push(
      `echo [${index + 1}/${urls.length}]`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
      `"%YTDLP%" ${shared} ${media} -P "%DEST%" ${bq(url)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
      "if errorlevel 1 set /a FAILED+=1"
    );
  });

  lines.push(
    'if "%FAILED%"=="0" (',
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%YTDLP%","failed":0}`,
    ") else (",
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ytdlp-failed","failed":%FAILED%}`,
    ")",
    `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "exit /b 0"
  );

  return lines.join("\r\n") + "\r\n";
}

export function installScriptWin(folder: string): string {
  return (
    [
      "@echo off",
      "rem Gerado pelo Framelab - Baixar Videos. Pode apagar.",
      "title Framelab - instalando yt-dlp",
      `set "WORK=${batValue(folder)}"`,
      "echo Baixando o yt-dlp oficial...",
      `powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${RELEASE_WIN}' ` +
        `-OutFile ('%WORK%\\${LOCAL_BIN_WIN}') -UseBasicParsing } catch { exit 1 }"`,
      "if errorlevel 1 (",
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"install-failed"}`,
      ") else (",
      `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ytdlp":"%WORK%\\${LOCAL_BIN_WIN}"}`,
      ")",
      `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
      "exit /b 0",
    ].join("\r\n") + "\r\n"
  );
}

// ── mensagens ──────────────────────────────────────────────────────

export function describeRunError(code: string | null, log: string): string {
  if (!code) {
    return "Falha desconhecida no download.";
  }
  if (code.startsWith("launch-denied")) {
    const raw = code.slice("launch-denied:".length).trim();
    return (
      "O sistema não executou o script" +
      (raw ? ` (${raw})` : "") +
      '. Use "Abrir pasta" e dê um duplo clique no script — o painel ' +
      "continua esperando o resultado."
    );
  }
  switch (code) {
    case "ytdlp-not-found":
      return (
        'yt-dlp não encontrado. Use o botão "Instalar yt-dlp" nos ajustes ' +
        "avançados, ou instale com \"brew install yt-dlp\"."
      );
    case "ytdlp-failed":
      return diagnoseLog(log);
    case "install-failed":
      return "Não foi possível baixar o yt-dlp. Verifique a conexão e tente de novo.";
    case "install-unusable":
      return (
        "O yt-dlp baixou mas não executou. No macOS isso costuma ser o " +
        'Gatekeeper: abra a pasta e autorize o binário, ou use "brew install yt-dlp".'
      );
    case "timeout":
      return "O download passou do tempo limite e foi abandonado.";
    case "cancelled":
      return "Download cancelado.";
    case "uxp-unavailable":
      return "Este build do Premiere não expõe shell/fs do UXP.";
    default:
      return `Falha: ${code}`;
  }
}

/**
 * Lê o desabafo do yt-dlp e devolve a frase que aponta o conserto.
 *
 * "ERROR: unable to download" não diz nada a ninguém; as causas reais
 * são poucas e cada uma tem uma saída diferente no painel.
 */
function diagnoseLog(log: string): string {
  if (/sign in to confirm|not a bot|cookies/i.test(log)) {
    return (
      "O site pediu login. Nos ajustes avançados, escolha o navegador onde " +
      "você já está logado para o yt-dlp usar os cookies dele."
    );
  }
  if (/private video|video unavailable|removed by the uploader/i.test(log)) {
    return "O vídeo é privado ou foi removido.";
  }
  if (/age.?restrict/i.test(log)) {
    return "Vídeo com restrição de idade — use os cookies do navegador nos ajustes avançados.";
  }
  if (/ffmpeg is not installed|ffmpeg not found/i.test(log)) {
    return (
      "Falta o ffmpeg para juntar vídeo e áudio nesta qualidade. Instale com " +
      '"brew install ffmpeg" ou escolha 1080p ou menos.'
    );
  }
  if (/unsupported url/i.test(log)) {
    return "O yt-dlp não reconhece esse link.";
  }
  if (/urlopen error|network|timed out|connection/i.test(log)) {
    return "Falha de rede durante o download.";
  }
  return "O yt-dlp não concluiu. Veja o log abaixo.";
}

// ── formatação ─────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return "";
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}
