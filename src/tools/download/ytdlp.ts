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
import { dispatch, withdraw } from "./runner";
import { readConfig as readSilenceConfig } from "../silence/ffmpeg";

/** Alias local: o escapador compartilhado, no nome curto dos templates. */
const q = shellQuote;
import {
  describe,
  isWindows,
  join,
  nativePath,
  readText,
  remove,
  shellModule,
  uxpModule,
  shellQuote,
  batValue,
  wait,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

// ── nomes dos arquivos do protocolo ────────────────────────────────

const RESULT_FILE = "dl-result.json";
const PROGRESS_FILE = "dl-progress.txt";
const LOG_FILE = "dl-log.txt";
const FILES_FILE = "dl-files.txt";
/** Escrito na primeira linha útil do script: prova que ele rodou. */
const STARTED_FILE = "dl-started.txt";
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


// ── polling ────────────────────────────────────────────────────────

const POLL_MS = 250;
/**
 * Uma sondagem é rede e nada mais — mas a PRIMEIRA pode carregar o
 * yt-dlp junto (35 MB), então o teto respira.
 */
const PROBE_TIMEOUT_MS = 8 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 90 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

// ── configuração ───────────────────────────────────────────────────

export type Cookies = "none" | "chrome" | "safari" | "firefox" | "edge" | "brave";

export interface DownloadConfig {
  /** Caminho do yt-dlp escolhido à mão. Vazio = descobrir sozinho. */
  ytdlpPath: string;
  /** Pasta de destino em caminho NATIVO. Vazio = a padrão do sistema. */
  destination: string;
  /**
   * Token persistente da pasta escolhida no seletor. É a permissão de
   * escrita que sobrevive entre sessões — o caminho sozinho é só
   * texto, e texto pode ser rota que o host recusa.
   */
  destinationToken: string;
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
  destinationToken: "",
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
      destinationToken:
        typeof parsed.destinationToken === "string" ? parsed.destinationToken : "",
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
  /** Onde ESTA execução listou o que entregou. */
  filesFile?: string;
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
/** Os arquivos da execução anterior, para a próxima limpar. */
let previousRunFiles: string[] = [];

async function run(launch: Launch): Promise<RunResult> {
  const shell = shellModule();
  if (!shell) {
    return fail("uxp-unavailable", null);
  }

  const space = await workspace();
  const scriptPath = nativePath(space, scriptName());

  /*
   * Cada execução ganha os SEUS arquivos de protocolo, renomeados no
   * texto do script num ponto só. Sem isso, cancelar deixava um
   * script órfão rodando, e a execução seguinte podia engolir o
   * result.json DELE — importando o lote de ontem como se fosse o de
   * hoje. Com nomes por execução, o órfão escreve nos nomes velhos e
   * ninguém lê.
   */
  const tag = Date.now().toString(36);
  const runFiles = {
    result: `dl-${tag}-result.json`,
    progress: `dl-${tag}-progress.txt`,
    log: `dl-${tag}-log.txt`,
    files: `dl-${tag}-files.txt`,
    started: `dl-${tag}-started.txt`,
  };

  for (const name of [
    ...Object.values(runFiles),
    ...previousRunFiles,
    RESULT_FILE,
    PROGRESS_FILE,
    LOG_FILE,
    FILES_FILE,
    STARTED_FILE,
    ...launch.stale,
  ]) {
    await remove(space, name);
  }
  previousRunFiles = Object.values(runFiles);

  const script = launch
    .build(space)
    .split(RESULT_FILE).join(runFiles.result)
    .split(PROGRESS_FILE).join(runFiles.progress)
    .split(LOG_FILE).join(runFiles.log)
    .split(FILES_FILE).join(runFiles.files)
    .split(STARTED_FILE).join(runFiles.started);
  await write(space, scriptName(), script, true);

  // Primeiro o caminho silencioso: o runner executa o script sem abrir
  // Terminal (ver runner.ts). Se o lançamento for recusado — ou se o
  // carimbo de início não aparecer — o Terminal volta como plano B:
  // feio e visível, mas nunca uma funcionalidade morta.
  let launchError: string | null = null;
  const sent = await dispatch(scriptName());
  let awaitingStamp = sent.mode !== "denied";
  if (!awaitingStamp) {
    console.error("[Download] agente recusado:", sent.error);
    try {
      await shell.openPath(scriptPath, launch.purpose);
    } catch (cause) {
      launchError = describe(cause);
      console.error("[Download] openPath recusou:", cause);
      launch.onManual?.(scriptPath, launchError);
    }
  }

  /** Quando desistir do silêncio: tempo de sobra para o .app abrir. */
  const stampDeadline = Date.now() + 8000;
  const deadline = Date.now() + launch.timeoutMs;
  let lastSignature = "";
  let tick = 0;
  while (Date.now() < deadline) {
    tick += 1;
    if (launch.cancelled?.()) {
      return { ...fail("cancelled", scriptPath) };
    }

    // O runner lançou mas o script não deu sinal de vida? Terminal.
    if (awaitingStamp && Date.now() > stampDeadline) {
      awaitingStamp = false;
      if (!readText(space, runFiles.started)) {
        console.warn("[Download] sem carimbo do agente — caindo para o Terminal.");
        // Sai da fila antes: um agente que acordasse depois baixaria
        // o mesmo vídeo uma segunda vez.
        await withdraw(sent.ticket);
        try {
          await shell.openPath(scriptPath, launch.purpose);
        } catch (cause) {
          launchError = describe(cause);
          launch.onManual?.(scriptPath, launchError);
        }
      }
    }

    // O resultado encerra a espera; o log é cortesia — ler o arquivo a
    // cada volta era uma leitura síncrona de 250 em 250ms por até
    // noventa minutos.
    if (launch.onProgress && tick % 4 === 0) {
      const log = tail(space, runFiles.log);
      const done = readProgress(space, runFiles.progress);
      const percent = readPercent(log);
      const signature = `${done}|${percent}|${log.length}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        launch.onProgress(done, launch.total, percent, log);
      }
    }

    const raw = readText(space, runFiles.result);
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
          log: tail(space, runFiles.log),
          filesFile: runFiles.files,
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
    log: tail(space, runFiles.log),
  };
}

function fail(error: string, scriptPath: string | null): RunResult {
  return { ok: false, error, ytdlpPath: null, scriptPath, failed: 0, log: "" };
}

function readProgress(space: Workspace, name: string): number {
  const raw = readText(space, name);
  const parsed = Number.parseInt(raw?.split("/")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * As últimas linhas do log. O começo não interessa; o fim é o erro.
 *
 * Fatia por posição antes de quebrar em linhas: o log de um download
 * longo chega a megabytes, e um split do arquivo inteiro a cada volta
 * do polling era custo linear crescendo na thread do painel.
 */
function tail(space: Workspace, name: string, lines = 12): string {
  const raw = readText(space, name);
  if (!raw) {
    return "";
  }
  const slice = raw.length > 4096 ? raw.slice(-4096) : raw;
  return slice.split(/\r?\n/).slice(-lines).join("\n");
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


// ── as três operações ──────────────────────────────────────────────

/**
 * Liga cada reclamação do yt-dlp ao link de onde ela veio.
 *
 * O log é do LOTE: cinco links viram cinco linhas `ERROR:` num arquivo
 * só. O que amarra uma linha ao seu link é o id que o yt-dlp imprime
 * — `ERROR: [youtube] ukoShFrJ_Dc: Private video` — ou a própria URL,
 * quando a queixa é sobre ela ("Unsupported URL: …").
 *
 * Casado por ÍNDICE e sem reaproveitar linha: o mesmo vídeo colado
 * duas vezes falha duas vezes, e as duas linhas são dele.
 *
 * Exportada para ser provável fora do Premiere: atribuição errada não
 * quebra nada — só cola no link A o motivo do link B, e ninguém
 * percebe.
 */
export function complaintsByIndex(
  urls: readonly string[],
  log: string
): Map<number, string> {
  const lines = log.split(/\r?\n/).filter((line) => line.startsWith("ERROR:"));
  const out = new Map<number, string>();
  const orphans: string[] = [];

  for (const line of lines) {
    const index = urls.findIndex((url, at) => !out.has(at) && mentions(line, url));
    if (index >= 0) {
      out.set(index, shortReason(line));
    } else {
      orphans.push(line);
    }
  }

  // Um link só e uma queixa sem dono são, necessariamente, o mesmo
  // caso — vale para o erro que não cita id nem URL.
  if (urls.length === 1 && !out.has(0) && orphans.length > 0) {
    out.set(0, shortReason(orphans[orphans.length - 1]));
  }
  return out;
}

/** Esta linha de erro fala deste link? */
function mentions(line: string, url: string): boolean {
  if (url.length > 0 && line.includes(url)) {
    return true;
  }
  // `ERROR: [youtube] ukoShFrJ_Dc: …` — o id é a única coisa que liga
  // a queixa ao link que o editor colou.
  const id = /^ERROR:\s*\[[^\]]+\]\s*([^\s:]+):/.exec(line)?.[1];
  return !!id && id.length >= 4 && url.includes(id);
}

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
  const complaints = complaintsByIndex(urls, result.log);
  const probes = urls.map((url, index) => {
    const raw = readText(space, infoFile(index));
    if (!raw) {
      return {
        url,
        ok: false,
        // O log SABE por que este link falhou — "Private video",
        // "Unsupported URL", o que for. A linha da lista dizia sempre
        // "não conseguiu ler este link" e jogava fora o diagnóstico,
        // enquanto a barra de status logo abaixo mostrava o motivo
        // certo: duas mensagens contraditórias na mesma tela, e a
        // errada era justamente a que fica colada no link.
        error: complaints.get(index) ?? "não foi possível ler",
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

/**
 * Um download por link direto: a via rápida do TikTok resolve a URL
 * do CDN no painel e o script só precisa de um curl. Sem yt-dlp.
 */
export interface DirectJob {
  /** O link do CDN, já sem marca d'água. */
  mediaUrl: string;
  /** Nome final do arquivo, já saneado pelo painel. */
  fileName: string;
  /** O link original, para o log dizer de quem era a falha. */
  sourceUrl: string;
}

export interface DownloadOutcome extends RunResult {
  /** Caminhos nativos do que foi de fato escrito no disco. */
  files: string[];
}

export async function downloadUrls(
  urls: readonly string[],
  quality: Quality,
  config: DownloadConfig,
  direct: readonly DirectJob[] = [],
  onProgress?: RunProgress,
  cancelled?: () => boolean,
  onManual?: (scriptPath: string, reason: string) => void
): Promise<DownloadOutcome> {
  const destination = config.destination || (await defaultDestination());
  // O ffmpeg apontado à mão nos ajustes do Corte de Silêncios vale
  // aqui também — é o mesmo binário fazendo o mesmo trabalho.
  const customFfmpeg = urls.length > 0 ? (await readSilenceConfig()).ffmpegPath : "";

  const result = await run({
    build: (space) =>
      isWindows()
        ? downloadScriptWin(urls, quality, config, space.nativeBase, destination, direct, customFfmpeg)
        : downloadScriptUnix(urls, quality, config, space.nativeBase, destination, direct, customFfmpeg),
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    stale: [],
    onProgress,
    total: urls.length + direct.length,
    cancelled,
    onManual,
    purpose: "Baixar os vídeos dos links informados.",
  });

  const space = await workspace();
  const listed = readText(space, result.filesFile ?? FILES_FILE);
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


/** O preâmbulo comum: acha o yt-dlp, ou desiste dizendo por quê. */
/**
 * O começo de todo script: pasta, cwd e o carimbo de vida. O yt-dlp
 * NÃO mora aqui — um lote só de TikTok baixa por link direto e não
 * tem por que provisionar 35 MB de extrator.
 */
function unixBase(folder: string): string[] {
  return [
    "#!/bin/bash",
    "# Gerado pelo Framelab — Baixar Vídeos. Pode apagar.",
    `printf '\\033]0;Framelab — baixando\\007'`,
    "set -u",
    `WORK=${q(folder)}`,
    'cd "$WORK" || exit 1',
    `printf 1 > "$WORK/${STARTED_FILE}"`,
    // Com set -u, o result.json cita $YTDLP mesmo quando o lote não
    // precisou dele.
    "YTDLP=''",
  ];
}

function unixYtdlpSetup(config: DownloadConfig): string[] {
  return [
    `CUSTOM=${q(config.ytdlpPath)}`,
    // A ordem procura primeiro o que o editor escolheu, depois o
    // binário que o botão "Instalar" deixa aqui, e só então os lugares
    // do Homebrew, do MacPorts e do pip — que num shell não interativo
    // podem nem estar no PATH.
    'for candidate in "$CUSTOM" "$HOME/Library/Application Support/Framelab/bin/yt-dlp" ' +
      '"/Library/Application Support/Framelab/bin/yt-dlp" "$WORK/yt-dlp" /opt/homebrew/bin/yt-dlp ' +
      '/usr/local/bin/yt-dlp /opt/local/bin/yt-dlp "$HOME/.local/bin/yt-dlp"; do',
    '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then YTDLP="$candidate"; break; fi',
    "done",
    'if [ -z "$YTDLP" ]; then YTDLP="$(command -v yt-dlp 2>/dev/null || true)"; fi',
    // Não achou? Baixa e segue na MESMA execução. O usuário final não
    // instala ferramenta: o painel se prepara sozinho na primeira vez.
    'if [ -z "$YTDLP" ]; then',
    '  echo "Preparando o downloader (so na primeira vez)..."',
    `  echo "Preparando o downloader (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
    `  if curl -fsSL --retry 3 -o "$WORK/yt-dlp.tmp" ${q(RELEASE_MAC)} 2>> "$WORK/${LOG_FILE}"; then`,
    '    chmod +x "$WORK/yt-dlp.tmp"',
    // Sem tirar a quarentena, a primeira execução morre num diálogo
    // do Gatekeeper que o painel nunca veria.
    '    xattr -d com.apple.quarantine "$WORK/yt-dlp.tmp" >/dev/null 2>&1 || true',
    '    mv "$WORK/yt-dlp.tmp" "$WORK/yt-dlp"',
    '    if "$WORK/yt-dlp" --version >/dev/null 2>&1; then YTDLP="$WORK/yt-dlp"; fi',
    "  fi",
    "fi",
    'if [ -z "$YTDLP" ]; then',
    `  printf '{"ok":false,"error":"ytdlp-not-found"}' > "$WORK/${RESULT_FILE}.tmp"`,
    `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    '  echo "Nao foi possivel baixar o yt-dlp. Verifique a internet e tente de novo."',
    "  exit 1",
    "fi",
    'echo "yt-dlp: $YTDLP"',
    // O runtime JS. Sem ele o YouTube ainda responde, mas pelo caminho
    // deprecado: mais lento e com formatos faltando.
    "DENO=''",
    'for candidate in "$WORK/deno" /opt/homebrew/bin/deno /usr/local/bin/deno "$HOME/.deno/bin/deno"; do',
    '  if [ -x "$candidate" ]; then DENO="$candidate"; break; fi',
    "done",
    'if [ -z "$DENO" ]; then DENO="$(command -v deno 2>/dev/null || true)"; fi',
    'if [ -z "$DENO" ]; then',
    '  echo "Preparando o motor de extracao (so na primeira vez)..."',
    `  echo "Preparando o motor de extracao (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
    `  if [ "$(uname -m)" = "arm64" ]; then DURL=${q(DENO_MAC_ARM)}; else DURL=${q(DENO_MAC_INTEL)}; fi`,
    `  if curl -fsSL --retry 3 -o "$WORK/deno.zip" "$DURL" 2>> "$WORK/${LOG_FILE}"; then`,
    `    unzip -o -q "$WORK/deno.zip" deno -d "$WORK" >> "$WORK/${LOG_FILE}" 2>&1`,
    '    rm -f "$WORK/deno.zip"',
    '    chmod +x "$WORK/deno" 2>/dev/null',
    '    xattr -d com.apple.quarantine "$WORK/deno" >/dev/null 2>&1 || true',
    '    if "$WORK/deno" --version >/dev/null 2>&1; then DENO="$WORK/deno"; fi',
    "  fi",
    "fi",
  ];
}

/**
 * O ffmpeg é opcional na sondagem e obrigatório no download acima de
 * 1080p: acima disso o YouTube só serve vídeo e áudio separados, e é o
 * ffmpeg que junta os dois. Sem ele o yt-dlp cai sozinho num formato
 * progressivo — pior, mas ainda um arquivo.
 */
function unixFfmpeg(customFfmpeg: string): string[] {
  return [
    // O caminho que o editor configurou no Corte de Silêncios vem
    // primeiro: era honrado lá e ignorado aqui, e o mesmo binário
    // serve os dois.
    `FFCUSTOM=${q(customFfmpeg)}`,
    "FFMPEG=''",
    'for candidate in "$FFCUSTOM" "$HOME/Library/Application Support/Framelab/bin/ffmpeg" ' +
      '"/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg ' +
      '/opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
    '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
    "done",
    'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
    // Na falta, baixa o build estático da arquitetura. A falha aqui é
    // um rebaixamento, não um fim: sem ffmpeg o yt-dlp ainda entrega
    // TikTok inteiro e YouTube até onde existe formato progressivo.
    'if [ -z "$FFMPEG" ]; then',
    '  echo "Preparando o ffmpeg (so na primeira vez)..."',
    `  echo "Preparando o ffmpeg (so na primeira vez)..." >> "$WORK/${LOG_FILE}"`,
    `  if [ "$(uname -m)" = "arm64" ]; then FFURL=${q(FFMPEG_MAC_ARM)}; ` +
      `else FFURL=${q(FFMPEG_MAC_INTEL)}; fi`,
    `  if curl -fsSL --retry 3 -o "$WORK/ffmpeg.zip" "$FFURL" 2>> "$WORK/${LOG_FILE}" || ` +
      `curl -fsSL --retry 2 -o "$WORK/ffmpeg.zip" ${q(FFMPEG_MAC_RESERVE)} 2>> "$WORK/${LOG_FILE}"; then`,
    `    unzip -o -q "$WORK/ffmpeg.zip" ffmpeg -d "$WORK" >> "$WORK/${LOG_FILE}" 2>&1`,
    '    rm -f "$WORK/ffmpeg.zip"',
    '    chmod +x "$WORK/ffmpeg" 2>/dev/null',
    '    xattr -d com.apple.quarantine "$WORK/ffmpeg" >/dev/null 2>&1 || true',
    '    if "$WORK/ffmpeg" -version >/dev/null 2>&1; then FFMPEG="$WORK/ffmpeg"; fi',
    "  fi",
    "fi",
    'if [ -z "$FFMPEG" ]; then echo "ffmpeg indisponivel: qualidades altas podem sair menores."; fi',
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
  const lines = [...unixBase(folder), ...unixYtdlpSetup(config)];
  lines.push("FAILED=0");

  urls.forEach((url, index) => {
    const target = `"$WORK/${infoFile(index)}"`;
    lines.push(
      `echo "[${index + 1}/${urls.length}] consultando…"`,
      `printf '%s/%s' ${index + 1} ${urls.length} > "$WORK/${PROGRESS_FILE}"`,
      `if "$YTDLP" --no-warnings --no-playlist --ignore-config ` +
        `--extractor-retries 5 --retry-sleep extractor:3 ` +
        `\${DENO:+--js-runtimes "deno:$DENO"} ` +
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
  destination: string,
  direct: readonly DirectJob[] = [],
  customFfmpeg = ""
): string {
  const lines = unixBase(folder);
  // yt-dlp, deno e ffmpeg só entram quando algum link precisa deles.
  // Um lote só de TikTok fica em curl puro — é o que faz o caso mais
  // comum responder em segundos, sem provisionamento nenhum.
  if (urls.length > 0) {
    lines.push(...unixYtdlpSetup(config), ...unixFfmpeg(customFfmpeg));
  }
  lines.push(`DEST=${q(destination)}`, 'mkdir -p "$DEST"', "FAILED=0");

  const total = direct.length + urls.length;
  direct.forEach((job, index) => {
    const target = `"$DEST/"${q(job.fileName)}`;
    lines.push(
      `echo "[${index + 1}/${total}] ${escapeEcho(job.fileName)}"`,
      `printf '%s/%s' ${index + 1} ${total} > "$WORK/${PROGRESS_FILE}"`,
      `if curl -fL --progress-bar --retry 3 -o ${target} ${q(job.mediaUrl)} 2>> "$WORK/${LOG_FILE}"; then`,
      `  printf '%s\\n' "$DEST/"${q(job.fileName)} >> "$WORK/${FILES_FILE}"`,
      "else",
      "  FAILED=$((FAILED+1))",
      `  echo "ERROR: download direto falhou: ${escapeEcho(job.sourceUrl)}" >> "$WORK/${LOG_FILE}"`,
      `  rm -f ${target}`,
      "fi"
    );
  });

  const shared =
    `--newline --no-mtime --no-playlist --ignore-config --windows-filenames ` +
    `--trim-filenames 120 --retries 5 --fragment-retries 10 ` +
    `--extractor-retries 5 --retry-sleep extractor:3 ` +
    `\${DENO:+--js-runtimes "deno:$DENO"} ` +
    `-o ${q("%(title)s [%(id)s].%(ext)s")} ` +
    // Relativo de propósito: o argumento do --print-to-file passa pelo
    // sanitizador de template do yt-dlp, e um caminho absoluto longo
    // saía truncado — o download funcionava e o painel via lista vazia.
    `--print-to-file after_move:filepath ${q(FILES_FILE)} ` +
    cookiesArg(config);

  const sort = sortArg(quality);
  const media = quality.audioOnly
    ? `-x --audio-format mp3 --audio-quality 0 -f ${q(formatSelector(quality))}`
    : // mp4 porque o destino é uma timeline do Premiere, e um webm/vp9
      // entra lá para arrastar a reprodução.
      `-f ${q(formatSelector(quality))} ${sort ? `-S ${q(sort)} ` : ""}` +
      `--merge-output-format mp4`;

  urls.forEach((url, index) => {
    const step = direct.length + index + 1;
    lines.push(
      `echo "[${step}/${total}] ${escapeEcho(url)}"`,
      `printf '%s/%s' ${step} ${total} > "$WORK/${PROGRESS_FILE}"`,
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
    // O caminho relativo do --print-to-file é à prova do sanitizador,
    // mas o yt-dlp o resolve contra a pasta de destino (-P), não
    // contra o cwd — medido num download real. A colheita cobre os
    // dois comportamentos e não deixa arquivo de controle no destino.
    `if [ -f "$DEST/${FILES_FILE}" ]; then`,
    `  cat "$DEST/${FILES_FILE}" >> "$WORK/${FILES_FILE}"`,
    `  rm -f "$DEST/${FILES_FILE}"`,
    "fi",
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

/**
 * De onde vem o ffmpeg quando a máquina não tem um.
 *
 * macOS: os builds estáticos de Martin Riedl, que publicam um redirect
 * estável por arquitetura — o zip traz o binário `ffmpeg` puro.
 * O evermeet (x86_64) fica de reserva. Windows: o build oficial do
 * projeto yt-dlp. Todas respondiam 200 quando isto foi escrito; se
 * uma sumir, o script segue sem ffmpeg e avisa no log.
 */
const FFMPEG_MAC_ARM =
  "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip";
const FFMPEG_MAC_INTEL =
  "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip";
const FFMPEG_MAC_RESERVE = "https://evermeet.cx/ffmpeg/getrelease/zip";
const FFMPEG_WIN =
  "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";

/**
 * O runtime JS que o yt-dlp quer para o YouTube.
 *
 * Desde 2026 a extração sem runtime está deprecada: fica mais lenta e
 * perde formatos (o aviso apareceu num download real durante o
 * desenvolvimento). O deno é o preferido deles; provisionar junto é o
 * que mantém a promessa de "não instala nada".
 */
const DENO_MAC_ARM =
  "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip";
const DENO_MAC_INTEL =
  "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip";
const DENO_WIN =
  "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";

export function installScriptUnix(folder: string): string {
  return (
    [
      // A base comum traz o cd e o carimbo de início — sem ele, o
      // runner silencioso parecia morto e o painel abria um SEGUNDO
      // install no Terminal, os dois curl brigando pelo mesmo .tmp.
      ...unixBase(folder),
      `echo "Baixando o yt-dlp oficial…"`,
      // Sem tee: o `if` precisa medir o CURL, e `curl | tee` mede o
      // tee, que nunca falha — um download pela metade seguia o
      // caminho feliz e instalava um binário truncado.
      `if curl -fSL --retry 3 -o "$WORK/${LOCAL_BIN}.tmp" ${q(RELEASE_MAC)} 2>> "$WORK/${LOG_FILE}"; then`,
      `  chmod +x "$WORK/${LOCAL_BIN}.tmp"`,
      `  mv "$WORK/${LOCAL_BIN}.tmp" "$WORK/${LOCAL_BIN}"`,
      // O binário do macOS vem sem assinatura reconhecida pelo
      // Gatekeeper; sem tirar a quarentena, a primeira execução morre
      // num diálogo que o painel nunca veria.
      `  xattr -d com.apple.quarantine "$WORK/${LOCAL_BIN}" >/dev/null 2>&1 || true`,
      `  if "$WORK/${LOCAL_BIN}" --version >/dev/null 2>&1; then`,
      `    printf '{"ok":true,"ytdlp":"%s"}' "$WORK/${LOCAL_BIN}" > "$WORK/${RESULT_FILE}.tmp"`,
      "  else",
      // O que não executa não pode ficar: um yt-dlp quebrado em
      // $WORK vence a busca de TODO script futuro.
      `    rm -f "$WORK/${LOCAL_BIN}"`,
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


function bq(value: string): string {
  return `"${batValue(value)}"`;
}

/** Mesma coreografia em cmd.exe. Não testado num Windows real. */
function winBase(folder: string): string[] {
  return [
    "@echo off",
    "rem Gerado pelo Framelab - Baixar Videos. Pode apagar.",
    "title Framelab - baixando",
    `set "WORK=${batValue(folder)}"`,
    'cd /d "%WORK%"',
    `>"%WORK%\\${STARTED_FILE}" echo 1`,
    'set "YTDLP="',
    "set FAILED=0",
  ];
}

function winYtdlpSetup(config: DownloadConfig): string[] {
  return [
    `set "YTDLP=${batValue(config.ytdlpPath)}"`,
    `if "%YTDLP%"=="" if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
    `if "%YTDLP%"=="" for %%i in (yt-dlp.exe) do @set "YTDLP=%%~$PATH:i"`,
    'if "%YTDLP%"=="" (',
    "  echo Preparando o downloader (so na primeira vez)...",
    `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${RELEASE_WIN}' ` +
      `-OutFile '%WORK%\\${LOCAL_BIN_WIN}' -UseBasicParsing } catch { exit 1 }"`,
    `  if exist "%WORK%\\${LOCAL_BIN_WIN}" set "YTDLP=%WORK%\\${LOCAL_BIN_WIN}"`,
    ")",
    'if "%YTDLP%"=="" (',
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ytdlp-not-found"}`,
    `  move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "  echo Nao foi possivel baixar o yt-dlp. Verifique a internet.",
    "  exit /b 1",
    ")",
    'set "DENO="',
    `if exist "%WORK%\\deno.exe" set "DENO=%WORK%\\deno.exe"`,
    'if "%DENO%"=="" for %%i in (deno.exe) do @set "DENO=%%~$PATH:i"',
    'if "%DENO%"=="" (',
    "  echo Preparando o motor de extracao (so na primeira vez)...",
    `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${DENO_WIN}' ` +
      `-OutFile '%WORK%\\deno.zip' -UseBasicParsing; ` +
      `Expand-Archive -Force '%WORK%\\deno.zip' '%WORK%\\dz'; ` +
      `Copy-Item '%WORK%\\dz\\deno.exe' '%WORK%\\deno.exe'; ` +
      `Remove-Item -Recurse -Force '%WORK%\\dz','%WORK%\\deno.zip' } catch { exit 1 }"`,
    `  if exist "%WORK%\\deno.exe" set "DENO=%WORK%\\deno.exe"`,
    ")",
    'set "JSARGS="',
    'if not "%DENO%"=="" set JSARGS=--js-runtimes "deno:%DENO%"',
  ];
}

export function probeScriptWin(
  urls: readonly string[],
  config: DownloadConfig,
  folder: string
): string {
  const lines = [...winBase(folder), ...winYtdlpSetup(config)];

  urls.forEach((url, index) => {
    const target = `"%WORK%\\${infoFile(index)}"`;
    lines.push(
      `echo [${index + 1}/${urls.length}] consultando...`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${urls.length}`,
      `"%YTDLP%" --no-warnings --no-playlist --ignore-config ` +
        `--extractor-retries 5 --retry-sleep extractor:3 %JSARGS% ` +
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
  destination: string,
  direct: readonly DirectJob[] = [],
  customFfmpeg = ""
): string {
  const lines = winBase(folder);
  if (urls.length > 0) {
    lines.push(...winYtdlpSetup(config));
  }
  lines.push(
    `set "DEST=${batValue(destination)}"`,
    'if not exist "%DEST%" mkdir "%DEST%"'
  );
  const total = direct.length + urls.length;
  // curl.exe existe no Windows 10+; é tudo que o link direto precisa.
  direct.forEach((job, index) => {
    lines.push(
      `echo [${index + 1}/${total}] ${batValue(job.fileName)}`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${index + 1}/${total}`,
      `curl.exe -fSL --retry 3 -o "%DEST%\\${batValue(job.fileName)}" ` +
        `${bq(job.mediaUrl)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
      "if errorlevel 1 (",
      "  set /a FAILED+=1",
      `  del /q "%DEST%\\${batValue(job.fileName)}" 2>nul`,
      ") else (",
      `  >>"%WORK%\\${FILES_FILE}" echo %DEST%\\${batValue(job.fileName)}`,
      ")"
    );
  });
  if (urls.length > 0) {
    lines.push(
    // ffmpeg: PATH vale, o provisionado vale, e na falta dos dois o
    // script baixa o build oficial do projeto yt-dlp. Falhar aqui não
    // derruba o download — só rebaixa a qualidade máxima.
    'set "FFLOC="',
    `set "FFCUSTOM=${batValue(customFfmpeg)}"`,
    'if exist "%FFCUSTOM%" set "FFLOC=CUSTOM"',
    'if "%FFLOC%"=="" for %%i in (ffmpeg.exe) do @if not "%%~$PATH:i"=="" set "FFLOC=SKIP"',
    `if exist "%WORK%\\ffmpeg.exe" set "FFLOC=%WORK%"`,
    'if "%FFLOC%"=="" (',
    "  echo Preparando o ffmpeg (so na primeira vez)...",
    `  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '${FFMPEG_WIN}' ` +
      `-OutFile '%WORK%\\ff.zip' -UseBasicParsing; ` +
      `Expand-Archive -Force '%WORK%\\ff.zip' '%WORK%\\ff'; ` +
      `Copy-Item '%WORK%\\ff\\ffmpeg-master-latest-win64-gpl\\bin\\ffmpeg.exe' ` +
      `'%WORK%\\ffmpeg.exe'; ` +
      `Remove-Item -Recurse -Force '%WORK%\\ff','%WORK%\\ff.zip' } catch { exit 1 }"`,
    `  if exist "%WORK%\\ffmpeg.exe" set "FFLOC=%WORK%"`,
    ")",
    'if "%FFLOC%"=="SKIP" set "FFLOC="',
    'set "FFARGS="',
    'if "%FFLOC%"=="CUSTOM" (set FFARGS=--ffmpeg-location "%FFCUSTOM%") else ' +
      'if not "%FFLOC%"=="" set FFARGS=--ffmpeg-location "%FFLOC%"'
    );
  }

  const shared =
    `--newline --no-mtime --no-playlist --ignore-config --windows-filenames ` +
    `--trim-filenames 120 --retries 5 --fragment-retries 10 ` +
    `-o ${bq("%(title)s [%(id)s].%(ext)s")} ` +
    `--print-to-file after_move:filepath ${bq(FILES_FILE)} ` +
    cookiesArg(config);

  const sort = sortArg(quality);
  const media = quality.audioOnly
    ? `-x --audio-format mp3 --audio-quality 0 -f ${bq(formatSelector(quality))}`
    : `-f ${bq(formatSelector(quality))} ${sort ? `-S ${bq(sort)} ` : ""}` +
      `--merge-output-format mp4`;

  urls.forEach((url, index) => {
    const step = direct.length + index + 1;
    lines.push(
      `echo [${step}/${total}]`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${step}/${total}`,
      `"%YTDLP%" ${shared} ${media} -P "%DEST%" %FFARGS% %JSARGS% ${bq(url)} >>"%WORK%\\${LOG_FILE}" 2>&1`,
      "if errorlevel 1 set /a FAILED+=1"
    );
  });

  lines.push(
    `if exist "%DEST%\\${FILES_FILE}" (`,
    `  type "%DEST%\\${FILES_FILE}" >> "%WORK%\\${FILES_FILE}"`,
    `  del /q "%DEST%\\${FILES_FILE}"`,
    ")",
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
      ...winBase(folder),
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
        "O downloader não conseguiu se preparar sozinho — sem acesso ao " +
        "GitHub para baixar o yt-dlp. Confira a internet e tente de novo."
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
 * Por que o yt-dlp parou, em duas medidas.
 *
 * "ERROR: unable to download" não diz nada a ninguém; as causas reais
 * são poucas e cada uma tem uma saída diferente no painel. Cada causa
 * é escrita duas vezes de propósito:
 *
 *   • `short` cabe ao lado do link, na linha estreita da lista, que é
 *     onde o editor olha primeiro para saber QUAL link falhou;
 *   • `long` explica e diz o que fazer, na barra de status.
 *
 * Duas tabelas separadas divergiriam na primeira correção — por isso
 * as duas formas moram na mesma linha.
 *
 * A ordem importa: "Private video" do YouTube costuma vir acompanhado
 * de "Sign in if you've been granted access", e a regra de login é
 * larga o bastante para roubá-lo. O caso mais específico vem antes.
 */
interface Cause {
  test: RegExp;
  /** Duas ou três palavras — a linha do link é estreita. */
  short: string;
  /** A explicação e a saída. */
  long: string;
}

const CAUSES: readonly Cause[] = [
  {
    test: /unable to extract universal data|rehydration/i,
    short: "TikTok recusou",
    long:
      "O TikTok recusou a conversa desta vez — acontece em rajadas. " +
      "Espere alguns segundos e tente de novo.",
  },
  {
    test: /private video/i,
    short: "vídeo privado",
    long:
      "Esse vídeo é privado. Se você tem acesso a ele, escolha nos ajustes " +
      "avançados o navegador onde está logado — o painel usa os cookies dele.",
  },
  {
    test: /video unavailable|removed by the uploader/i,
    short: "vídeo removido",
    long: "O vídeo foi removido ou não está disponível.",
  },
  {
    test: /age.?restrict/i,
    short: "restrição de idade",
    long:
      "Vídeo com restrição de idade — use os cookies do navegador nos " +
      "ajustes avançados.",
  },
  {
    test: /sign in to confirm|not a bot|cookies/i,
    short: "pede login",
    long:
      "O site pediu login. Nos ajustes avançados, escolha o navegador onde " +
      "você já está logado para o yt-dlp usar os cookies dele.",
  },
  {
    test: /ffmpeg is not installed|ffmpeg not found/i,
    short: "falta o ffmpeg",
    long:
      "Falta o ffmpeg para juntar vídeo e áudio nesta qualidade. Instale com " +
      '"brew install ffmpeg" ou escolha 1080p ou menos.',
  },
  {
    test: /unsupported url/i,
    short: "site não suportado",
    long: "O yt-dlp não reconhece esse link.",
  },
  {
    test: /urlopen error|network|timed out|connection/i,
    short: "falha de rede",
    long: "Falha de rede durante o download.",
  },
];

/** A última reclamação crua do yt-dlp, sem o prefixo. */
function rawComplaint(log: string): string | null {
  const errors = log.match(/^ERROR:.*$/gm);
  if (!errors || errors.length === 0) {
    return null;
  }
  return errors[errors.length - 1].replace(/^ERROR:\s*/, "").trim();
}

export function diagnoseLog(log: string): string {
  const cause = CAUSES.find((entry) => entry.test.test(log));
  if (cause) {
    return cause.long;
  }
  // Nenhum padrão conhecido: melhor a reclamação crua do yt-dlp que
  // uma frase genérica — foi a falta disto que deixou um beta tester
  // com "deu erro" e nada mais.
  const raw = rawComplaint(log);
  return raw
    ? `O yt-dlp reclamou: ${raw.slice(0, 220)}`
    : "O yt-dlp não concluiu. O log abaixo diz onde parou.";
}

/** O mesmo diagnóstico em duas ou três palavras. */
export function shortReason(log: string): string {
  const cause = CAUSES.find((entry) => entry.test.test(log));
  if (cause) {
    return cause.short;
  }
  const raw = rawComplaint(log);
  if (!raw) {
    return "não foi possível ler";
  }
  // Fora o prefixo `[extrator] id:`, o que sobra é a queixa em si.
  // Curta: medida a 320px, uma queixa de 42 caracteres espremia o
  // link para 99px e o endereço sumia — e é o link que diz QUAL falhou.
  // O texto inteiro está logo abaixo, na barra de status e no log.
  const clean = raw.replace(/^\[[^\]]+\]\s*[^\s:]*:\s*/, "");
  return clean.length > 30 ? `${clean.slice(0, 28)}…` : clean;
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
