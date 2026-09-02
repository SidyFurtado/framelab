/**
 * O glossário do projeto — a correção que o modelo não faz sozinho.
 *
 * ── Por que existem duas camadas ───────────────────────────────────
 * O whisper aceita um `--prompt` que enviesa a transcrição para os
 * termos do projeto. Medido antes de escrever isto, num trecho com
 * jargão de edição e nomes próprios: o prompt sozinho corrigiu o nome
 * "Sidy" (que sem ele virava "CD") e a maiúscula de "Transform" — mas
 * a marca "Framelab" saiu "frameelab", perto e ainda errada.
 *
 * Daí a segunda camada, que é esta: depois de transcrever, os termos
 * do glossário são procurados no texto e corrigidos de forma
 * determinística. O viés do modelo aproxima; a correção fecha.
 *
 * ── O que isto NÃO é ───────────────────────────────────────────────
 * Não é um modelo que aprende. O whisper é fixo: transcreve igual
 * hoje e daqui a um ano. O que melhora com o tempo é o GLOSSÁRIO —
 * cada nome, marca e jargão que o editor acrescenta vale para todas
 * as transcrições seguintes. A melhora é real e é do usuário, não do
 * modelo.
 *
 * ── A cerca ────────────────────────────────────────────────────────
 * Correção automática que erra é pior que erro nenhum: trocar uma
 * palavra legítima por um termo do glossário estraga uma legenda que
 * estava certa. Por isso o casamento é CONSERVADOR — só entra o que
 * está a um erro de distância do termo, e palavra curta quase não tem
 * folga. "CD" nunca vira "Sidy" por aqui; quem conserta isso é o
 * prompt, que tem o contexto da frase.
 */
import type { AdobeWord, AdobeTranscript } from "./toAdobe";

/** Sem acento, sem caixa, sem pontuação — a forma de comparar. */
export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Distância de edição, com corte. Para de contar assim que passa do
 * limite — um glossário de cinquenta termos contra uma transcrição de
 * dez mil palavras não pode pagar a matriz inteira toda vez.
 */
export function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) {
    return limit + 1;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      current.push(value);
      if (value < best) {
        best = value;
      }
    }
    if (best > limit) {
      return limit + 1;
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * A folga permitida por tamanho de termo.
 *
 * Termo curto quase não erra sem virar outra palavra: "LUT" com um
 * erro já é "luz". A folga só abre quando o termo é longo o bastante
 * para que a semelhança signifique alguma coisa.
 */
function tolerance(folded: string): number {
  if (folded.length <= 4) return 0;
  if (folded.length <= 7) return 1;
  return 2;
}

interface Term {
  /** Como deve aparecer na legenda. */
  display: string;
  folded: string;
  /** Quantas palavras o termo ocupa quando falado. */
  span: number;
}

/** Lê o glossário do editor: um termo por linha, vazio ignorado. */
export function parseGlossary(text: string): Term[] {
  const terms: Term[] = [];
  for (const line of text.split(/\r?\n/)) {
    const display = line.trim();
    if (!display || display.startsWith("#")) {
      continue;
    }
    const folded = fold(display);
    if (!folded) {
      continue;
    }
    terms.push({
      display,
      folded,
      span: display.trim().split(/\s+/).length,
    });
  }
  // Termo mais longo primeiro: "corte de silêncios" tem que ser
  // testado antes de "corte", senão o curto casa e o longo nunca vê.
  return terms.sort((a, b) => b.folded.length - a.folded.length);
}

/** O texto do `--prompt`: os termos numa frase que o modelo lê antes. */
export function promptFrom(terms: readonly Term[]): string {
  if (terms.length === 0) {
    return "";
  }
  // Os termos vão como lista, que é a forma que o whisper espera para
  // enviesar vocabulário sem contaminar a pontuação da fala.
  return terms.map((term) => term.display).join(", ") + ".";
}

export interface Correction {
  from: string;
  to: string;
  /** Quantas palavras a correção juntou. 1 = troca simples. */
  merged: number;
}

/**
 * Aplica o glossário à transcrição.
 *
 * Trabalha por segmento e por janela de palavras: um termo de duas
 * palavras ("punch in") é procurado em pares, porque a transcrição
 * pode tê-lo partido — ou o contrário, "frame lab" que precisa virar
 * uma palavra só. Quando junta, o tempo da palavra resultante cobre
 * do início da primeira ao fim da última: legenda com tempo errado é
 * pior que legenda com palavra errada.
 */
export function applyGlossary(
  transcript: AdobeTranscript,
  terms: readonly Term[]
): { transcript: AdobeTranscript; corrections: Correction[] } {
  if (terms.length === 0) {
    return { transcript, corrections: [] };
  }
  const corrections: Correction[] = [];
  const maxSpan = Math.max(...terms.map((term) => term.span), 1) + 1;

  const segments = transcript.segments.map((segment) => {
    const words: AdobeWord[] = [];
    let index = 0;

    while (index < segment.words.length) {
      let matched = false;

      // Janelas maiores primeiro: juntar "frame" + "lab" tem que ser
      // testado antes de tentar casar só "frame".
      for (let span = Math.min(maxSpan, segment.words.length - index); span >= 1 && !matched; span -= 1) {
        const window = segment.words.slice(index, index + span);
        const joined = window.map((word) => word.text).join(" ");
        const folded = fold(joined);
        if (!folded) {
          continue;
        }

        for (const term of terms) {
          /*
           * Uma palavra só pode ser difusa: é o caso de "frameelab",
           * que o modelo escreveu perto do termo e a folga conserta.
           *
           * Várias palavras exigem casamento EXATO depois de dobrar.
           * Sem essa cerca, a folga de erro cabia num artigo vizinho e
           * o corretor comia palavra legítima: medido, "No frame lab"
           * virava "Framelab" (sem o "No") e "keyframe no" perdia o
           * "no". Juntar palavras serve para o termo que veio partido
           * ("frame lab" → "Framelab"), nunca para decidir onde a
           * frase começa.
           */
          const budget = span === 1 ? tolerance(term.folded) : 0;
          if (distance(folded, term.folded, budget) > budget) {
            continue;
          }
          // Nada a fazer se já está escrito certo.
          const trailing = /[^\p{L}\p{N}]+$/u.exec(joined)?.[0] ?? "";
          const corrected = term.display + trailing;
          if (joined !== corrected) {
            corrections.push({ from: joined, to: corrected, merged: span });
          }
          const first = window[0];
          const last = window[window.length - 1];
          words.push({
            text: corrected,
            start: first.start,
            duration: Math.max(0.008, last.start + last.duration - first.start),
            type: "word",
            // A confiança da junção é a do pedaço menos confiante: a
            // legenda é tão boa quanto a sua pior parte.
            confidence: Math.min(...window.map((word) => word.confidence)),
            tags: [],
          });
          index += span;
          matched = true;
          break;
        }
      }

      if (!matched) {
        words.push(segment.words[index]);
        index += 1;
      }
    }

    return { start: segment.start, words };
  });

  return {
    transcript: { version: transcript.version, segments },
    corrections,
  };
}
