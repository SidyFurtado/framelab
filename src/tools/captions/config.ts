/**
 * Os ajustes das Legendas, incluindo o glossário.
 *
 * O glossário é o que melhora com o tempo, então ele precisa
 * sobreviver ao fechamento do Premiere — mora na pasta de trabalho do
 * plugin, ao lado das outras configurações.
 */
import { readText, workspace, write } from "../silence/workspace";
import { SRT_DEFAULTS, type SrtOptions } from "./srt";
import type { AdobeTranscript } from "./toAdobe";

const CONFIG_FILE = "captions-config.json";

export interface CaptionConfig {
  model: string;
  language: string;
  /** Um termo por linha. */
  glossary: string;
  /** Índice da faixa de áudio, ou "all". */
  track: number | "all";
  /** A régua da legenda: caracteres, linhas, tempos. */
  srt: SrtOptions;
}

const DEFAULTS: CaptionConfig = {
  model: "turbo",
  language: "pt",
  glossary: "",
  track: "all",
  srt: { ...SRT_DEFAULTS },
};

export async function readConfig(): Promise<CaptionConfig> {
  try {
    const raw = readText(await workspace(), CONFIG_FILE);
    if (!raw) {
      return { ...DEFAULTS };
    }
    const parsed = JSON.parse(raw) as Partial<CaptionConfig>;
    return {
      model: typeof parsed.model === "string" ? parsed.model : DEFAULTS.model,
      language: typeof parsed.language === "string" ? parsed.language : DEFAULTS.language,
      glossary: typeof parsed.glossary === "string" ? parsed.glossary : "",
      track:
        typeof parsed.track === "number" || parsed.track === "all"
          ? parsed.track
          : "all",
      srt: readSrt(parsed.srt),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Os limites da legenda, presos aos extremos que fazem sentido.
 *
 * Um arquivo de ajustes editado à mão, ou vindo de uma versão anterior
 * sem estes campos, não pode produzir uma legenda de zero caractere ou
 * de meia linha: cada número volta ao intervalo utilizável, e o que
 * faltar cai no padrão.
 */
export const SRT_RANGE: Record<keyof SrtOptions, [number, number]> = {
  maxLineChars: [16, 64],
  maxLines: [1, 3],
  gapSeconds: [0.2, 3],
  minCueSeconds: [0.3, 4],
  maxCueSeconds: [1.5, 12],
  readingCps: [0, 30],
  gapFrames: [0, 12],
};

function readSrt(raw: unknown): SrtOptions {
  const source = (raw ?? {}) as Partial<Record<keyof SrtOptions, unknown>>;
  const out = { ...SRT_DEFAULTS };
  for (const key of Object.keys(SRT_DEFAULTS) as (keyof SrtOptions)[]) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const [low, high] = SRT_RANGE[key];
      out[key] = Math.min(high, Math.max(low, value));
    }
  }
  // Um teto abaixo do piso não é ajuste, é contradição — e produziria
  // uma legenda por palavra.
  out.maxCueSeconds = Math.max(out.maxCueSeconds, out.minCueSeconds + 0.5);
  return out;
}

export async function writeConfig(config: CaptionConfig): Promise<void> {
  try {
    await write(await workspace(), CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (cause) {
    console.error("[Legendas] não foi possível salvar os ajustes:", cause);
  }
}

// ── memória do que foi escrito ─────────────────────────────────────

const SNAPSHOT_FILE = "captions-written.json";

/**
 * O que o plugin escreveu, por mídia.
 *
 * É a metade que faltava do ciclo de aprendizado: sem guardar a nossa
 * versão, ler a transcrição de volta não diz nada — não haveria com o
 * que comparar. Guardado por caminho de mídia porque é o que sobrevive
 * a recortar o clipe na timeline.
 */
export type WrittenSnapshots = Record<string, unknown>;

export async function readSnapshots(): Promise<WrittenSnapshots> {
  try {
    const raw = readText(await workspace(), SNAPSHOT_FILE);
    return raw ? (JSON.parse(raw) as WrittenSnapshots) : {};
  } catch {
    return {};
  }
}

export async function writeSnapshot(
  mediaPath: string,
  transcript: unknown
): Promise<void> {
  try {
    const all = await readSnapshots();
    all[mediaPath] = transcript;
    // Só as últimas mídias interessam; sem teto o arquivo cresceria
    // pela vida do plugin.
    const keys = Object.keys(all);
    if (keys.length > 40) {
      for (const old of keys.slice(0, keys.length - 40)) {
        delete all[old];
      }
    }
    await write(await workspace(), SNAPSHOT_FILE, JSON.stringify(all));
  } catch (cause) {
    console.error("[Legendas] não foi possível guardar o escrito:", cause);
  }
}


// ── a última transcrição, para não transcrever de novo ─────────────

const LAST_RUN_FILE = "captions-last-run.json";

/**
 * O que a última transcrição ouviu, em tempo de sequência.
 *
 * Existe por um motivo prático: mudar "caracteres por linha" não muda
 * uma palavra do que foi ouvido — muda só como as palavras viram
 * legenda. Sem este cache, cada ajuste custaria uma passada inteira do
 * motor (minutos), e os controles seriam inúteis na prática. Com ele,
 * o .srt sai de novo em um segundo.
 */
export interface LastRun {
  /** Quando foi, em milissegundos de época. */
  at: number;
  /** O relógio da sequência de onde saiu. */
  fps: number;
  /** Quantos clipes entraram na montagem. */
  clips: number;
  /** Um rótulo para o painel dizer de onde veio. */
  label: string;
  transcript: AdobeTranscript;
}

export async function readLastRun(): Promise<LastRun | null> {
  try {
    const raw = readText(await workspace(), LAST_RUN_FILE);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<LastRun>;
    if (!parsed?.transcript?.segments?.length) {
      return null;
    }
    return {
      at: typeof parsed.at === "number" ? parsed.at : 0,
      fps: typeof parsed.fps === "number" ? parsed.fps : 0,
      clips: typeof parsed.clips === "number" ? parsed.clips : 0,
      label: typeof parsed.label === "string" ? parsed.label : "última transcrição",
      transcript: parsed.transcript,
    };
  } catch {
    return null;
  }
}

export async function writeLastRun(run: LastRun): Promise<void> {
  try {
    await write(await workspace(), LAST_RUN_FILE, JSON.stringify(run));
  } catch (cause) {
    console.error("[Legendas] não foi possível guardar a última transcrição:", cause);
  }
}
