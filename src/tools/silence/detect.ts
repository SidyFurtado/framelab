/**
 * Corte de Silêncios — o algoritmo, sem host nenhum por perto.
 *
 * Entra uma lista de intervalos de fala (de onde vieram é problema de
 * outro arquivo), o trecho do clipe que está na timeline e os
 * parâmetros. Sai a lista do que fica e do que sai — em segundos de
 * SOURCE, o mesmo espaço em que os in/out points do clipe são medidos.
 *
 * Tudo aqui é função pura: é o que permite o painel recalcular o plano
 * inteiro a cada movimento de slider sem tocar no Premiere de novo.
 */
import type { SilenceParams } from "./presets";

export interface Span {
  start: number;
  end: number;
}

/** Um intervalo de fala. `filler` vem da tag da transcrição. */
export interface VoicedSpan extends Span {
  filler: boolean;
  /**
   * A palavra como a transcrição escreveu. Ausente no modo onda, onde
   * o intervalo vem do envelope e não tem texto nenhum. O Corte de
   * Silêncios não a usa; o Cortar Muletas decide por ela.
   */
  text?: string;
  /**
   * Confiança do reconhecimento, 0..1. Vale 1 quando a transcrição
   * não informa — ausência de dado não pode virar suspeita.
   */
  confidence: number;
}

export interface SegmentPlan {
  /** O que sobrevive, em ordem, sem sobreposição. */
  keep: Span[];
  /** Os silêncios removidos, na ordem. */
  drop: Span[];
  /** Soma de `drop`. */
  removedSeconds: number;
  /** Soma de `keep`. */
  keptSeconds: number;
}

/**
 * Um corte menor que isso não é corte: é um soluço de um ou dois
 * frames que ninguém percebe e que só serve para picotar a timeline.
 * Depois das margens, um silêncio que encolheu abaixo deste piso é
 * devolvido para o material mantido.
 */
const MIN_REMOVAL_SECONDS = 0.06;

/**
 * O plano de corte de um clipe.
 *
 * `range` é o trecho do source que está na timeline (in/out do track
 * item). Nada fora dele é considerado — a fala que ficou de fora do
 * trim não existe para este cálculo.
 *
 * `frameSeconds` faz o plano falar a mesma língua da sequência: as
 * bordas saem no grid de frames, então o que o painel mostra é o que
 * a timeline recebe.
 */
export function planSegments(
  voiced: readonly VoicedSpan[],
  range: Span,
  params: SilenceParams,
  frameSeconds: number
): SegmentPlan {
  const total = range.end - range.start;
  if (!(total > 0)) {
    return emptyPlan();
  }

  const frame = frameSeconds > 0 ? frameSeconds : 1 / 30;
  const minRemoval = Math.max(MIN_REMOVAL_SECONDS, frame * 2);

  // 1. Tudo que soou, dentro do trecho que está na timeline.
  const spans: VoicedSpan[] = [];
  for (const span of voiced) {
    const start = Math.max(range.start, span.start);
    const end = Math.min(range.end, span.end);
    if (end > start) {
      spans.push({ ...span, start, end });
    }
  }
  if (spans.length === 0) {
    return emptyPlan();
  }
  spans.sort((a, b) => a.start - b.start);

  // 2. Ruído sai primeiro, e é medido na fala COMPLETA — muleta
  //    incluída. A ordem importa: tirar a muleta antes abriria buracos
  //    de meio segundo em volta das vizinhas, e uma palavra curta que
  //    só ficou sozinha porque o "né" ao lado sumiu seria descartada
  //    como estalo. Muleta é fala; enquanto está lá, a vizinha tem
  //    companhia.
  const clean = rejectNoise(spans, params);

  // 3. Agora sim as muletas, se foram pedidas.
  const speech = params.removeFillers
    ? clean.filter((span) => !span.filler)
    : clean;
  if (speech.length === 0) {
    return emptyPlan();
  }

  // 4. Fecha tudo que não chega a ser silêncio.
  //
  // O `minSilence` é medido ANTES das margens, na fala crua: é a
  // pergunta "houve uma pausa?", não "quanto sobrou depois de eu
  // devolver o ar". Medir depois faria o mesmo número significar
  // coisas diferentes conforme a margem escolhida.
  let blocks = mergeGaps(speech, params.minSilence);

  // 5. Devolve o ar em volta de cada bloco e refunde o que colidiu.
  blocks = blocks.map((block) => ({
    start: Math.max(range.start, block.start - params.padIn),
    end: Math.min(range.end, block.end + params.padOut),
  }));
  blocks = mergeGaps(blocks, minRemoval);

  // 6. Nenhum trecho mantido sai menor que o mínimo: cresce em volta
  //    do próprio centro em vez de ser descartado — jogar fora um
  //    trecho curto é jogar fora uma palavra.
  blocks = blocks.map((block) => grow(block, params.minKeep, range));
  blocks = mergeGaps(blocks, minRemoval);

  // 7. Grid de frames. Cresce para fora nos dois lados: arredondar
  //    para dentro come sílaba, arredondar para fora custa um frame.
  const keep: Span[] = [];
  for (const block of blocks) {
    const start = Math.max(range.start, floorTo(block.start - range.start, frame) + range.start);
    const end = Math.min(range.end, ceilTo(block.end - range.start, frame) + range.start);
    if (end - start >= frame) {
      keep.push({ start, end });
    }
  }
  const merged = mergeGaps(keep, minRemoval);

  // 8. O complemento é o que sai. Um silêncio de borda (antes da
  //    primeira fala, depois da última) conta como corte igual aos do
  //    meio: é ali que mora a maior parte do tempo morto de um take.
  const drop: Span[] = [];
  let cursor = range.start;
  for (const block of merged) {
    if (block.start - cursor >= minRemoval) {
      drop.push({ start: cursor, end: block.start });
    }
    cursor = Math.max(cursor, block.end);
  }
  if (range.end - cursor >= minRemoval) {
    drop.push({ start: cursor, end: range.end });
  }

  // O que ficou entre dois cortes com folga menor que `minRemoval`
  // voltou a ser material: reconstrói o `keep` a partir dos cortes
  // para os dois lados sempre fecharem exatamente o range.
  const finalKeep = complement(drop, range, frame);

  return {
    keep: finalKeep,
    drop,
    removedSeconds: sum(drop),
    keptSeconds: sum(finalKeep),
  };
}

/**
 * Descarta o que é ruído reconhecido como fala.
 *
 * É o análogo, aqui, do limiar em dB das ferramentas que enxergam a
 * onda: ruído contínuo — ar-condicionado, chiado, hum — nunca vira
 * palavra e já é cortado de graça; o que trava um corte é o token
 * fantasma que o transcritor ouve dentro do silêncio.
 *
 * A regra só toca em som ILHADO — sem outra fala perto dos dois lados.
 * É o que a torna segura por construção: uma palavra dentro de uma
 * frase nunca é candidata, então nenhum ajuste aqui pode abrir um
 * corte no meio da fala. Palavra de baixa confiança colada nas
 * vizinhas continua sendo fala, que é o que ela é.
 *
 * A borda do clipe conta como lado vazio: não há fala antes da
 * primeira palavra nem depois da última, por definição. Medir a
 * distância até a borda como se fosse uma pausa deixava passar
 * justamente o caso mais comum — o estalo nos primeiros décimos do
 * take, que sozinho segura o corte do ar de abertura inteiro.
 *
 * Uma passada só, de propósito: remover uma ilha pode ilhar a vizinha,
 * e iterar isso comeria fala de verdade em cascata.
 */
function rejectNoise(
  spans: readonly VoicedSpan[],
  params: SilenceParams
): VoicedSpan[] {
  if (params.minConfidence <= 0 && params.noiseIsland <= 0) {
    return [...spans];
  }

  const kept: VoicedSpan[] = [];
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index];
    const previous = spans[index - 1];
    const next = spans[index + 1];

    const gapBefore = previous
      ? span.start - previous.end
      : Number.POSITIVE_INFINITY;
    const gapAfter = next ? next.start - span.end : Number.POSITIVE_INFINITY;
    const isolated =
      gapBefore >= params.minSilence && gapAfter >= params.minSilence;

    if (!isolated) {
      kept.push(span);
      continue;
    }

    const tooShort =
      params.noiseIsland > 0 && span.end - span.start < params.noiseIsland;
    const tooUnsure =
      params.minConfidence > 0 && span.confidence < params.minConfidence;
    if (!tooShort && !tooUnsure) {
      kept.push(span);
    }
  }
  return kept;
}

/** Junta intervalos separados por menos que `tolerance`. */
function mergeGaps(spans: readonly Span[], tolerance: number): Span[] {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [{ ...sorted[0] }];
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index];
    const last = out[out.length - 1];
    if (current.start - last.end < tolerance) {
      last.end = Math.max(last.end, current.end);
    } else {
      out.push({ ...current });
    }
  }
  return out;
}

/** Estica um intervalo até `minLength`, sem sair de `bounds`. */
function grow(span: Span, minLength: number, bounds: Span): Span {
  const missing = minLength - (span.end - span.start);
  if (missing <= 0) {
    return span;
  }
  let start = span.start - missing / 2;
  let end = span.end + missing / 2;
  if (start < bounds.start) {
    end += bounds.start - start;
    start = bounds.start;
  }
  if (end > bounds.end) {
    start = Math.max(bounds.start, start - (end - bounds.end));
    end = bounds.end;
  }
  return { start, end };
}

function complement(drop: readonly Span[], range: Span, frame: number): Span[] {
  const keep: Span[] = [];
  let cursor = range.start;
  for (const gap of drop) {
    if (gap.start - cursor >= frame) {
      keep.push({ start: cursor, end: gap.start });
    }
    cursor = gap.end;
  }
  if (range.end - cursor >= frame) {
    keep.push({ start: cursor, end: range.end });
  }
  return keep;
}

function sum(spans: readonly Span[]): number {
  return spans.reduce((acc, span) => acc + (span.end - span.start), 0);
}

function floorTo(value: number, step: number): number {
  return Math.floor(value / step + 1e-6) * step;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step - 1e-6) * step;
}

function emptyPlan(): SegmentPlan {
  return { keep: [], drop: [], removedSeconds: 0, keptSeconds: 0 };
}

/** mm:ss.d — a mesma leitura do painel inteiro. */
export function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.0s";
  }
  // Round to tenths FIRST, then decide the shape. Choosing "under a
  // minute" against the raw number and rounding afterwards printed 59.96
  // as "60.0s" — a minute, spelled as if it were not one.
  const tenths = Math.round(Math.max(0, value) * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths - minutes * 600) / 10;
  if (minutes === 0) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}
