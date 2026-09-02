/**
 * A faixa inteira como um áudio só — e o caminho de volta.
 *
 * ── Por que a faixa, e não o clipe ─────────────────────────────────
 * Numa edição real o áudio não acompanha o vídeo: são várias faixas,
 * vários clipes, e uma frase costuma atravessar um corte. Transcrever
 * clipe a clipe produzia dois fragmentos com pontuação truncada, e
 * obrigava o editor a selecionar na mão o que ele já organizou em
 * faixas.
 *
 * Então o áudio da faixa é montado num arquivo contínuo, em TEMPO DE
 * SEQUÊNCIA, com os silêncios entre os clipes preservados — e o
 * whisper vê a fala inteira, com o contexto que a pontuação dele
 * precisa. Medido: uma frase partida em dois clipes sai como uma
 * frase só.
 *
 * ── O caminho de volta ─────────────────────────────────────────────
 * A transcrição sai em tempo de sequência, mas o Premiere pendura
 * transcrição no ITEM DE PROJETO, que fala em tempo de mídia. Então o
 * resultado é recortado por clipe e reconvertido:
 *
 *     tempoDeMídia = inPoint + (tempoDeSequência − início na sequência)
 *
 * Tudo aqui é função pura sobre números e listas: dá para provar sem
 * host e sem ffmpeg.
 */
import type { AdobeTranscript, AdobeWord } from "./toAdobe";

/** Um clipe de áudio na faixa, com os dois relógios que ele vive. */
export interface TrackClip {
  key: string;
  name: string;
  mediaPath: string;
  /** Onde está na sequência, em segundos. */
  seqStart: number;
  seqEnd: number;
  /** Onde começa no arquivo de origem, em segundos. */
  inPoint: number;
  /** A faixa de onde veio: 0 é A1. */
  trackIndex: number;
}

/**
 * O `-i` de cada clipe e o `filter_complex` que os põe no lugar.
 *
 * `adelay` empurra cada trecho para a sua posição na sequência e o
 * `amix` soma tudo. `normalize=0` é essencial: sem ele o ffmpeg
 * divide o volume pelo número de entradas e uma faixa com trinta
 * clipes sai inaudível — o whisper receberia sussurro.
 */
export function assembleArgs(
  clips: readonly TrackClip[],
  sampleRate = 16000
): {
  inputs: string[][];
  filter: string;
  durationSeconds: number;
  /** Onde a montagem começa, em tempo de sequência. */
  baseOffset: number;
} {
  /*
   * A montagem começa no PRIMEIRO clipe, não no zero da sequência.
   * Uma faixa cuja fala começa aos dez minutos gerava dez minutos de
   * silêncio antes dela — o motor processava tudo aquilo, demorava à
   * toa e ainda ganhava chance de inventar texto no vazio. O
   * deslocamento volta depois, quando a transcrição é convertida.
   */
  const base = clips.length > 0
    ? clips.reduce((first, clip) => Math.min(first, clip.seqStart), Infinity)
    : 0;
  const inputs: string[][] = [];
  const parts: string[] = [];
  const labels: string[] = [];

  clips.forEach((clip, index) => {
    const duration = Math.max(0.05, clip.seqEnd - clip.seqStart);
    inputs.push([
      "-ss",
      clip.inPoint.toFixed(6),
      "-t",
      duration.toFixed(6),
      "-i",
      clip.mediaPath,
    ]);
    const delay = Math.max(0, Math.round((clip.seqStart - base) * 1000));
    // `all=1` atrasa todos os canais; sem isso só o primeiro sai no
    // lugar e o áudio fica com eco de meio segundo.
    parts.push(
      `[${index}:a]aresample=${sampleRate},adelay=${delay}:all=1[a${index}]`
    );
    labels.push(`[a${index}]`);
  });

  const total = clips.reduce((end, clip) => Math.max(end, clip.seqEnd - base), 0);
  const mix =
    clips.length === 1
      ? `${labels[0]}apad[out]`
      : `${labels.join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad[out]`;

  return {
    inputs,
    filter: [...parts, mix].join(";"),
    durationSeconds: total,
    baseOffset: Number.isFinite(base) ? base : 0,
  };
}

/**
 * Recorta a transcrição de sequência de volta para cada clipe.
 *
 * Uma palavra pertence ao clipe em cujo intervalo ela COMEÇA. Isso
 * resolve sozinho a palavra que atravessa o corte: ela fica com o
 * clipe onde foi dita, e não some nem se duplica.
 */
export function splitByClip(
  transcript: AdobeTranscript,
  clips: readonly TrackClip[]
): Map<string, AdobeTranscript> {
  const out = new Map<string, AdobeTranscript>();
  if (clips.length === 0) {
    return out;
  }
  // Em ordem de sequência, para a busca poder parar cedo.
  const ordered = [...clips].sort((a, b) => a.seqStart - b.seqStart);

  for (const segment of transcript.segments) {
    // Um segmento pode cruzar clipes; a decisão é por palavra.
    const byClip = new Map<string, AdobeWord[]>();

    for (const word of segment.words) {
      const clip = ordered.find(
        (candidate) =>
          word.start >= candidate.seqStart - 1e-6 &&
          word.start < candidate.seqEnd - 1e-6
      );
      if (!clip) {
        // Palavra caída num vão entre clipes: o whisper ouviu algo no
        // silêncio. Não pertence a ninguém e não entra.
        continue;
      }
      const list = byClip.get(clip.key) ?? [];
      list.push({
        ...word,
        // De tempo de sequência para tempo de mídia.
        start: round(clip.inPoint + (word.start - clip.seqStart)),
      });
      byClip.set(clip.key, list);
    }

    for (const [key, words] of byClip) {
      if (words.length === 0) {
        continue;
      }
      const existing = out.get(key) ?? { version: transcript.version, segments: [] };
      existing.segments.push({ start: words[0].start, words });
      out.set(key, existing);
    }
  }

  return out;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** O rótulo que o editor conhece: faixa 0 é A1. */
export function trackLabel(index: number): string {
  return `A${index + 1}`;
}
