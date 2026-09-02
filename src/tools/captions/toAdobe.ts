/**
 * Whisper → transcrição da Adobe.
 *
 * ── O problema ─────────────────────────────────────────────────────
 * O whisper devolve SUBTOKENS, não palavras: "Então" chega como
 * " Ent" + "e" + "o" (o modelo trabalha em pedaços de byte-pair, e um
 * acento costuma cair na emenda). Cada subtoken traz o seu tempo em
 * milissegundos e a sua probabilidade. O Premiere quer o oposto:
 * palavras inteiras, com início, duração e confiança.
 *
 * A regra de junção é a convenção do próprio whisper: um subtoken que
 * começa com ESPAÇO abre palavra nova; sem espaço, ele continua a
 * palavra anterior. O tempo da palavra vai do início do primeiro
 * pedaço ao fim do último; a confiança é a média dos pedaços — uma
 * palavra remendada de três tokens duvidosos não pode herdar só a nota
 * do melhor deles.
 *
 * ── Pontuação ──────────────────────────────────────────────────────
 * A pontuação fica GRUDADA na palavra ("claro?"), em vez de virar
 * item próprio. É de propósito: o parser da Adobe descarta entradas
 * do tipo `punctuation`, e um ponto de interrogação solto seria
 * jogado fora — sumindo da legenda exatamente o sinal que o editor
 * mais reclama que o Premiere erra.
 *
 * Tudo aqui é função pura: entra o JSON do whisper, sai o JSON da
 * Adobe. É o que permite provar a conversão sem o host por perto.
 */

/** Um segmento do `-ojf` do whisper. */
interface WhisperSegment {
  offsets?: { from?: unknown; to?: unknown };
  text?: unknown;
  tokens?: unknown;
}

interface WhisperToken {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
  p?: unknown;
}

/** Uma palavra montada, no vocabulário do schema da Adobe. */
export interface AdobeWord {
  text: string;
  /** Segundos desde o início da mídia. */
  start: number;
  duration: number;
  type: "word";
  /** 0..1, a média dos pedaços que formaram a palavra. */
  confidence: number;
  tags: string[];
}

export interface AdobeSegment {
  start: number;
  words: AdobeWord[];
}

export interface AdobeTranscript {
  version: string;
  segments: AdobeSegment[];
}

/**
 * Marcadores de controle do whisper — `[_BEG_]`, `[_TT_170]`, e os
 * `<|...|>` de algumas builds. Não são fala e não podem virar palavra.
 */
function isMarker(text: string): boolean {
  return /^\[_.*_?\]$/.test(text.trim()) || /^<\|.*\|>$/.test(text.trim());
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Converte a saída `-ojf` do whisper.cpp.
 *
 * `offsetSeconds` desloca tudo: o áudio extraído começa no ponto do
 * clipe que está na timeline, e a transcrição precisa falar em tempo
 * de MÍDIA para o Premiere pendurar a legenda no lugar certo.
 */
export function whisperToAdobe(
  json: string,
  offsetSeconds = 0
): AdobeTranscript {
  let parsed: { transcription?: unknown };
  try {
    parsed = JSON.parse(json) as { transcription?: unknown };
  } catch {
    return { version: "1.0.0", segments: [] };
  }
  const list = Array.isArray(parsed.transcription)
    ? (parsed.transcription as WhisperSegment[])
    : [];

  const segments: AdobeSegment[] = [];
  for (const segment of list) {
    const tokens = Array.isArray(segment.tokens)
      ? (segment.tokens as WhisperToken[])
      : [];
    const words = mergeTokens(tokens, offsetSeconds);
    if (words.length === 0) {
      continue;
    }
    segments.push({
      start: num(segment.offsets?.from, 0) / 1000 + offsetSeconds,
      words,
    });
  }
  return { version: "1.0.0", segments };
}

/** A junção de subtokens em palavras. Exportada para ser exercitada. */
export function mergeTokens(
  tokens: readonly WhisperToken[],
  offsetSeconds = 0
): AdobeWord[] {
  const words: AdobeWord[] = [];
  let current: { text: string; start: number; end: number; ps: number[] } | null =
    null;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = current.text.trim();
    // Uma palavra sem letra nem número é pontuação que ficou órfã (o
    // whisper às vezes abre token novo para ela). Cola no que veio
    // antes, em vez de virar item que o Premiere descarta.
    if (text && !/[\p{L}\p{N}]/u.test(text) && words.length > 0) {
      const previous = words[words.length - 1];
      previous.text += text;
      previous.duration = Math.max(
        previous.duration,
        current.end - previous.start
      );
      current = null;
      return;
    }
    if (text) {
      words.push({
        text,
        start: round(current.start),
        // Duração nunca zero: o Premiere trata um span degenerado como
        // ausência de tempo e a palavra some da legenda.
        duration: round(Math.max(0.008, current.end - current.start)),
        type: "word",
        confidence: round(
          current.ps.reduce((sum, p) => sum + p, 0) / current.ps.length
        ),
        tags: [],
      });
    }
    current = null;
  };

  for (const token of tokens) {
    const raw = typeof token.text === "string" ? token.text : "";
    if (!raw.trim() || isMarker(raw)) {
      continue;
    }
    const start = num(token.offsets?.from, 0) / 1000 + offsetSeconds;
    const end = num(token.offsets?.to, num(token.offsets?.from, 0)) / 1000 + offsetSeconds;
    const probability = Math.min(1, Math.max(0, num(token.p, 1)));

    if (raw.startsWith(" ") || current === null) {
      flush();
      current = { text: raw.trim(), start, end, ps: [probability] };
    } else {
      current.text += raw;
      current.end = Math.max(current.end, end);
      current.ps.push(probability);
    }
  }
  flush();

  return words;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** O JSON pronto para `Transcript.importFromJSON`. */
export function toAdobeJSON(transcript: AdobeTranscript): string {
  return JSON.stringify(transcript);
}

/** Quantas palavras a transcrição tem, para a linha de status. */
export function countWords(transcript: AdobeTranscript): number {
  return transcript.segments.reduce(
    (total, segment) => total + segment.words.length,
    0
  );
}
