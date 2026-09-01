/**
 * De onde sai a fala: a transcrição do próprio Premiere.
 *
 * O UXP não dá acesso a samples de áudio — não há Web Audio, não há
 * decodificador, e o único arquivo que dá para ler do disco é o
 * original comprimido. O que o host DÁ é a transcrição, com tempo
 * palavra a palavra, e ela é melhor que um detector de nível de áudio
 * para o que esta ferramenta faz: um limiar em dB corta no meio de uma
 * sílaba fraca e se perde com respiração, teclado e ar condicionado; a
 * transcrição sabe onde a palavra começa e onde termina.
 *
 * Formato: `Transcript.exportToJSON` devolve o schema público da Adobe
 * (schemas.adobe.com/transcript/v1.0.0) — `segments[].words[]` com
 * `start` e `duration` em segundos a partir do início da mídia, `type`
 * separando palavra de pontuação, `tags` marcando muleta e
 * `confidence` dizendo o quanto o reconhecimento acredita no que
 * ouviu. A confiança é o que a ferramenta usa no lugar de um limiar em
 * dB: ruído ouvido como palavra chega aqui com nota baixa. O parser
 * aceita também o formato antigo `monologues[].elements[]` (`ts` /
 * `end_ts`), que ainda aparece em transcrições importadas.
 */
import type { premierepro, ClipProjectItem } from "@adobe/premierepro";
import type { VoicedSpan } from "./detect";

export type TranscriptStatus = "ok" | "missing" | "empty" | "unsupported" | "error";

export interface TranscriptRead {
  status: TranscriptStatus;
  words: VoicedSpan[];
  /** Preenchido quando `status` é "error". */
  detail: string | null;
}

/**
 * Lê a transcrição de um item de projeto.
 *
 * Nunca lança: um clipe sem transcrição é um caso normal de uso, não
 * uma falha — o painel precisa continuar e listar os outros.
 */
export async function readTranscript(
  ppro: premierepro,
  clipItem: ClipProjectItem
): Promise<TranscriptRead> {
  const api = ppro.Transcript;
  if (!api || typeof api.exportToJSON !== "function") {
    return { status: "unsupported", words: [], detail: null };
  }

  try {
    // `hasTranscript` é síncrono no typings, mas é uma ponte para o
    // host: se esta build devolver outra coisa, a checagem não pode
    // decidir sozinha que não há transcrição — daí o `=== false`.
    if (typeof api.hasTranscript === "function") {
      const has = await Promise.resolve(api.hasTranscript(clipItem));
      if (has === false) {
        return { status: "missing", words: [], detail: null };
      }
    }

    const json = await api.exportToJSON(clipItem);
    if (typeof json !== "string" || json.trim().length === 0) {
      return { status: "missing", words: [], detail: null };
    }

    const words = parseTranscriptJSON(json);
    return {
      status: words.length > 0 ? "ok" : "empty",
      words,
      detail: null,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // O host lança quando não há transcrição em algumas builds, em vez
    // de devolver false. Isso é "missing", não erro.
    if (/transcript/i.test(detail) && /(no|not|exist|found)/i.test(detail)) {
      return { status: "missing", words: [], detail: null };
    }
    return { status: "error", words: [], detail };
  }
}

/** Exportado para poder ser exercitado sem o host por perto. */
export function parseTranscriptJSON(json: string): VoicedSpan[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isRecord(data)) {
    return [];
  }

  const words = readSegments(data) ?? readMonologues(data) ?? [];
  words.sort((a, b) => a.start - b.start);
  return words;
}

/** Schema atual: `segments[].words[]`. */
function readSegments(data: Record<string, unknown>): VoicedSpan[] | null {
  const segments = data.segments;
  if (!Array.isArray(segments)) {
    return null;
  }

  const out: VoicedSpan[] = [];
  for (const segment of segments) {
    if (!isRecord(segment)) {
      continue;
    }
    const segmentStart = num(segment.start) ?? 0;
    const list = segment.words;
    if (!Array.isArray(list)) {
      continue;
    }

    for (const raw of list) {
      if (!isRecord(raw)) {
        continue;
      }
      // Pontuação não ocupa tempo de fala; entra como marcador e
      // arrastaria o fim do bloco para depois da última sílaba.
      if (typeof raw.type === "string" && raw.type === "punctuation") {
        continue;
      }

      const start = num(raw.start);
      if (start === null) {
        continue;
      }
      const end = spanEnd(raw, start);
      if (end === null) {
        continue;
      }

      // O schema diz que o tempo da palavra é absoluto, mas parte dos
      // exportadores escreve relativo ao segmento. Uma palavra que
      // começa antes do próprio segmento denuncia isso.
      const offset = start < segmentStart - 1e-3 ? segmentStart : 0;

      out.push({
        start: start + offset,
        end: end + offset,
        filler: hasFillerTag(raw.tags),
        confidence: readConfidence(raw.confidence),
      });
    }
  }
  return out;
}

/** Formato antigo: `monologues[].elements[]` com `ts` / `end_ts`. */
function readMonologues(data: Record<string, unknown>): VoicedSpan[] | null {
  const monologues = data.monologues;
  if (!Array.isArray(monologues)) {
    return null;
  }

  const out: VoicedSpan[] = [];
  for (const monologue of monologues) {
    if (!isRecord(monologue)) {
      continue;
    }
    const elements = monologue.elements;
    if (!Array.isArray(elements)) {
      continue;
    }
    for (const raw of elements) {
      if (!isRecord(raw)) {
        continue;
      }
      if (typeof raw.type === "string" && raw.type !== "text") {
        continue;
      }
      const start = num(raw.ts);
      const end = num(raw.end_ts);
      if (start === null || end === null || !(end > start)) {
        continue;
      }
      out.push({
        start,
        end,
        filler: hasFillerTag(raw.tags),
        confidence: readConfidence(raw.confidence),
      });
    }
  }
  return out;
}

function spanEnd(raw: Record<string, unknown>, start: number): number | null {
  const duration = num(raw.duration);
  if (duration !== null && duration > 0) {
    return start + duration;
  }
  const end = num(raw.end);
  if (end !== null && end > start) {
    return end;
  }
  return null;
}

/**
 * Confiança 0..1.
 *
 * Ausência vira 1: uma transcrição que não informa confiança não pode
 * fazer a ferramenta desconfiar de tudo que leu.
 */
function readConfidence(value: unknown): number {
  const parsed = num(value);
  if (parsed === null) {
    return 1;
  }
  return Math.min(1, Math.max(0, parsed));
}

function hasFillerTag(tags: unknown): boolean {
  return (
    Array.isArray(tags) &&
    tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "filler")
  );
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
