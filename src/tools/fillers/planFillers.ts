/**
 * Cortar Muletas — o algoritmo, sem host nenhum por perto.
 *
 * Entra a lista de palavras da transcrição (com texto), o trecho do
 * clipe que está na timeline e os parâmetros. Sai o plano no mesmo
 * SegmentPlan que o executor do Corte de Silêncios consome — este
 * módulo é um segundo planejador em cima da mesma máquina de corte,
 * não uma segunda máquina.
 *
 * ── O problema real: "é" é verbo ───────────────────────────────────
 * Em português, o som de hesitação e o verbo ser dividem a mesma
 * letra. Um cortador que caça todo "é" transforma "isso é bom" em
 * "isso bom". Por isso a decisão sai de TRÊS sinais, do mais seguro
 * para o menos:
 *
 *   1. A tag `filler` da própria transcrição da Adobe — o modelo
 *      deles viu a frase inteira e decidiu que aquilo é muleta.
 *   2. Grafia inequívoca: "ééé", "ehh", "hum", "aaamm" não são
 *      palavra nenhuma da língua; podem cair sem medo.
 *   3. Grafia ambígua ("é", "ah", "e") só cai ESTICADA: um "é" de
 *      meio segundo não é o verbo, é alguém procurando a próxima
 *      frase. O limiar é do editor.
 *
 * Tudo função pura, pelo mesmo motivo de detect.ts: o painel recalcula
 * a cada movimento de slider sem tocar no Premiere.
 */
import type { Span, VoicedSpan, SegmentPlan } from "../silence/detect";

export interface FillerParams {
  /** Confiar na tag `filler` da transcrição. */
  useTags: boolean;
  /**
   * Duração a partir da qual uma grafia ambígua ("é", "ah") vira
   * muleta. 0 desliga o sinal — aí só tag e grafia inequívoca cortam.
   */
  stretchedSeconds: number;
  /**
   * Margem em volta de cada muleta, por lado. Ela avança pelo AR
   * vizinho e para na borda da palavra ao lado: engolir a pausa em
   * volta do "ééé" é o objetivo; morder a palavra seguinte é defeito.
   */
  padSeconds: number;
}

export const FILLER_DEFAULTS: FillerParams = {
  useTags: true,
  stretchedSeconds: 0.45,
  padSeconds: 0.12,
};

/** Por que esta palavra foi marcada. Aparece na lista do painel. */
export type FillerReason = "tag" | "sound" | "stretched";

export interface FillerHit extends Span {
  text: string;
  reason: FillerReason;
}

export interface FillerPlan extends SegmentPlan {
  /** As muletas que caíram, na ordem, com texto e motivo. */
  hits: FillerHit[];
}

/**
 * Um corte menor que dois frames não é corte, é um soluço que picota a
 * timeline sem ninguém perceber o ganho. Mesmo piso do detect.ts.
 */
const MIN_REMOVAL_SECONDS = 0.06;

/**
 * Grafias que não são palavra nenhuma da língua.
 *
 * A âncora é a repetição: "ééé", "ehh", "aaam", "humm". O que tem UMA
 * grafia possível de palavra real fica de fora daqui e vai para a
 * lista ambígua — "um" é artigo, "e" é conjunção, "ah" pode ser uma
 * interjeição que o editor quer manter.
 */
const UNAMBIGUOUS = [
  /^é{2,}$/, //                ééé
  /^e{3,}$/, //                eee
  /^[ae]h{2,}$/, //            ahh, ehh
  /^é+h+$/, //                 éh, ééhh
  /^ã+h*$/, //                 ã, ããh
  /^h[ãa]+$/, //               hã, haa
  /^ah?n+$/, //                ahn, an — "an" não é palavra
  /^ãh?n+$/, //                ãhn
  /^uh+n*$/, //                uh, uhn
  /^h?[uũ]m{2,}$/, //          humm, umm
  /^hu+m+$/, //                hum, huum
  /^hm+$/, //                  hm, hmm
  /^m{2,}$/, //                mmm
  /^a{2,}m+$/, //              aam, aaammmm
  /^u{2,}m*$/, //              uu, uum
];

/**
 * Grafias que também são palavra de verdade. Só caem esticadas — e
 * "esticada" é a duração dizendo que aquilo não foi dito, foi
 * segurado.
 */
const AMBIGUOUS = [
  /^é$/, //    verbo ser… ou o clássico "é…"
  /^e+$/, //   conjunção… ou "e…" (ee cai no inequívoco com 3+)
  /^ah$/, //   interjeição intencional… ou hesitação
  /^eh$/, //   idem
  /^ã$/, //    quase sempre muleta, mas curto demais some no piso
  /^um$/, //   artigo… ou "um…" arrastado
  /^o$/, //    artigo… ou "o…" procurando a palavra
  /^a$/, //    idem
];

/**
 * O texto como as regras esperam: minúsculo, sem pontuação em volta,
 * sem acento composto escondendo a letra. "É…," vira "é".
 */
export function normalizeWord(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[.,;:!?…"'`´‘’“”()\[\]-]+/g, "")
    .trim();
}

/** Decide se UMA palavra é muleta, e por qual sinal. */
export function classifyWord(
  span: VoicedSpan,
  params: FillerParams
): FillerReason | null {
  if (params.useTags && span.filler) {
    return "tag";
  }

  const word = normalizeWord(span.text ?? "");
  if (!word) {
    return null;
  }

  if (UNAMBIGUOUS.some((pattern) => pattern.test(word))) {
    return "sound";
  }

  if (
    params.stretchedSeconds > 0 &&
    span.end - span.start >= params.stretchedSeconds &&
    AMBIGUOUS.some((pattern) => pattern.test(word))
  ) {
    return "stretched";
  }

  return null;
}

/**
 * O plano: cai cada muleta com margem, fica todo o resto.
 *
 * A margem avança pelo ar vizinho e PARA na palavra ao lado — o
 * clamp é contra a palavra não-muleta mais próxima, não contra o
 * vizinho qualquer: duas muletas seguidas ("é… ééé") devem se fundir
 * num corte só, com o ar entre elas dentro.
 */
export function planFillers(
  words: readonly VoicedSpan[],
  range: Span,
  params: FillerParams,
  frameSeconds: number
): FillerPlan {
  const total = range.end - range.start;
  if (!(total > 0)) {
    return empty();
  }
  const frame = frameSeconds > 0 ? frameSeconds : 1 / 30;
  const minRemoval = Math.max(MIN_REMOVAL_SECONDS, frame * 2);

  // Só o que está no trecho em uso na timeline, em ordem.
  const inRange = words
    .filter((word) => word.end > range.start && word.start < range.end)
    .map((word) => ({
      ...word,
      start: Math.max(range.start, word.start),
      end: Math.min(range.end, word.end),
    }))
    .sort((a, b) => a.start - b.start);

  const marked = inRange.map((word) => classifyWord(word, params));

  const hits: FillerHit[] = [];
  const cuts: Span[] = [];

  for (let index = 0; index < inRange.length; index += 1) {
    const reason = marked[index];
    if (!reason) {
      continue;
    }
    const word = inRange[index];

    // A borda de segurança de cada lado: a palavra DE VERDADE mais
    // próxima. Muletas no caminho não seguram a margem — elas também
    // vão cair, e o ar entre duas muletas pertence ao corte.
    let leftEdge = range.start;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (!marked[i]) {
        leftEdge = inRange[i].end;
        break;
      }
    }
    let rightEdge = range.end;
    for (let i = index + 1; i < inRange.length; i += 1) {
      if (!marked[i]) {
        rightEdge = inRange[i].start;
        break;
      }
    }

    hits.push({ start: word.start, end: word.end, text: word.text ?? "", reason });
    cuts.push({
      start: Math.max(leftEdge, word.start - params.padSeconds),
      end: Math.min(rightEdge, word.end + params.padSeconds),
    });
  }

  if (cuts.length === 0) {
    return empty();
  }

  // Funde cortes que se tocam e descarta soluços abaixo do piso.
  const merged: Span[] = [];
  for (const cut of cuts) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, cut.end);
    } else {
      merged.push({ ...cut });
    }
  }
  const drop = merged.filter((cut) => cut.end - cut.start >= minRemoval);
  if (drop.length === 0) {
    return empty();
  }

  // O que fica é o complemento, na mesma ordem.
  const keep: Span[] = [];
  let cursor = range.start;
  for (const cut of drop) {
    if (cut.start - cursor > 1e-6) {
      keep.push({ start: cursor, end: cut.start });
    }
    cursor = cut.end;
  }
  if (range.end - cursor > 1e-6) {
    keep.push({ start: cursor, end: range.end });
  }

  const removedSeconds = drop.reduce((sum, cut) => sum + (cut.end - cut.start), 0);
  return {
    keep,
    drop,
    removedSeconds,
    keptSeconds: total - removedSeconds,
    hits,
  };
}

function empty(): FillerPlan {
  return { keep: [], drop: [], removedSeconds: 0, keptSeconds: 0, hits: [] };
}
