/**
 * O ciclo que fecha: aprender com as correções do editor.
 *
 * ── A ideia ────────────────────────────────────────────────────────
 * O modelo não aprende — isso é fixo e não adianta prometer. Quem
 * aprende é o GLOSSÁRIO, e a fonte de aprendizado mais confiável que
 * existe já estava dentro do Premiere: o editor sempre corrige a
 * legenda à mão. Essa correção é a resposta certa, escrita por quem
 * sabe.
 *
 * O plugin tem as duas metades: ele ESCREVEU a transcrição (e guarda
 * o que escreveu) e sabe LER a atual de volta (`Transcript.exportToJSON`,
 * o mesmo caminho que o Corte de Silêncios usa). A diferença entre as
 * duas é, literalmente, a lista dos seus erros — corrigida.
 *
 * ── Por que propor em vez de aplicar ───────────────────────────────
 * Aprendizado silencioso que erra é pior que erro nenhum: uma troca
 * inventada entraria em todas as transcrições seguintes sem ninguém
 * ver. Então isto só PROPÕE termos, e quem aceita é o editor. A mesma
 * disciplina da correção por glossário, que só junta palavras com
 * casamento exato.
 *
 * Tudo aqui é função pura sobre duas listas de palavras: dá para
 * provar sem host, e é o que permite confiar no que ele propõe.
 */
import type { AdobeTranscript } from "./toAdobe";
import { fold } from "./glossary";

/** Uma palavra lida de volta do Premiere, já corrigida pelo editor. */
export interface ReadWord {
  text: string;
  start: number;
}

export interface Candidate {
  /** O que o modelo escreveu. */
  from: string;
  /** O que o editor deixou no lugar. */
  to: string;
  /** Quantas vezes a mesma troca apareceu. */
  times: number;
}

/**
 * O que mudou entre o que escrevemos e o que ficou.
 *
 * O casamento é por TEMPO, não por posição na lista: o editor pode ter
 * apagado ou juntado palavras, e um alinhamento por índice
 * desalinharia tudo depois da primeira edição. Duas palavras que
 * começam quase no mesmo instante são a mesma palavra — antes e
 * depois da correção.
 */
export function diffCorrections(
  written: AdobeTranscript,
  current: readonly ReadWord[],
  toleranceSeconds = 0.25
): Candidate[] {
  const ours = written.segments.flatMap((segment) => segment.words);
  if (ours.length === 0 || current.length === 0) {
    return [];
  }

  const tally = new Map<string, Candidate>();
  let cursor = 0;

  for (const mine of ours) {
    // Avança até a primeira palavra atual que ainda pode ser esta.
    while (
      cursor < current.length &&
      current[cursor].start < mine.start - toleranceSeconds
    ) {
      cursor += 1;
    }
    const theirs = current[cursor];
    if (!theirs || Math.abs(theirs.start - mine.start) > toleranceSeconds) {
      continue;
    }

    const before = mine.text.trim();
    const after = theirs.text.trim();
    if (!before || !after || before === after) {
      continue;
    }
    // Só interessa a troca de PALAVRA. Pontuação e caixa mudam por
    // gosto do editor e virariam ruído no glossário.
    if (fold(before) === fold(after)) {
      continue;
    }
    /*
     * Uma palavra trocada por outra completamente diferente costuma
     * ser o editor reescrevendo a frase, não corrigindo o que ouvimos.
     * Duas portas para passar:
     *
     *  - PARECIDA com o que escrevemos ("frameelab"→"Framelab", razão
     *    0.11; a reescrita "casa"→"mansão" fica em 0.50 e não passa —
     *    medido antes de escolher o corte).
     *  - MAIÚSCULA no meio da fala: nome próprio, que é o que o modelo
     *    mais destrói e o glossário mais conserta. Aqui a distância não
     *    ajuda ("CD"→"Sidy" está a 0.75 de qualquer jeito), e o risco é
     *    pequeno: o glossário guarda só o lado CERTO, escrito pelo
     *    próprio editor.
     */
    const looksProper = /^[A-ZÀ-Ý]/.test(after);
    if (!looksProper && !resembles(fold(before), fold(after))) {
      continue;
    }

    const key = `${fold(before)}→${after}`;
    const found = tally.get(key);
    if (found) {
      found.times += 1;
    } else {
      tally.set(key, { from: before, to: after, times: 1 });
    }
  }

  return [...tally.values()].sort((a, b) => b.times - a.times);
}

/**
 * Duas grafias do mesmo som.
 *
 * O corte em 0.4 não é gosto: medido, as correções de verdade ficam
 * entre 0.10 e 0.33 ("transform"→"transforma" 0.10, "frameelab"→
 * "Framelab" 0.11, "claro"→"claros" 0.17) e a reescrita de frase
 * ("casa"→"mansão") cai em 0.50. O número mora na folga entre os dois
 * grupos.
 */
function resembles(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const longest = Math.max(a.length, b.length);
  if (longest < 3) {
    return false;
  }
  let distance = 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = previous;
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current.push(
        Math.min(
          row[j] + 1,
          current[j - 1] + 1,
          row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        )
      );
    }
    row = current;
  }
  distance = row[b.length];
  return distance / longest < 0.4;
}

/**
 * Os termos que valem a pena guardar.
 *
 * Repetição é o sinal mais forte: a mesma correção duas vezes não é
 * acaso, é uma palavra do vocabulário do editor. Uma vez só entra
 * quando parece nome próprio (começa com maiúscula), que é justamente
 * o caso que o modelo mais erra e o glossário mais conserta.
 */
export function worthLearning(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.times >= 2 || /^[A-ZÀ-Ý]/.test(candidate.to.trim())
  );
}

/** Junta o aprendido ao glossário, sem duplicar o que já está lá. */
export function mergeIntoGlossary(
  glossary: string,
  learned: readonly Candidate[]
): { text: string; added: string[] } {
  const existing = new Set(
    glossary
      .split(/\r?\n/)
      .map((line) => fold(line))
      .filter(Boolean)
  );
  const added: string[] = [];
  for (const candidate of learned) {
    const term = candidate.to.trim().replace(/[.,;:!?]+$/, "");
    if (!term || existing.has(fold(term))) {
      continue;
    }
    existing.add(fold(term));
    added.push(term);
  }
  if (added.length === 0) {
    return { text: glossary, added };
  }
  const base = glossary.trimEnd();
  return {
    text: (base ? `${base}\n` : "") + added.join("\n") + "\n",
    added,
  };
}
