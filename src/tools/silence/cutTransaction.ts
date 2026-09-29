/**
 * A ordem do corte, e o que fazer quando ela quebra no meio.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * O corte é destrutivo por construção: o UXP não tem razor, então cada
 * bloco de clipes é REMOVIDO e reescrito em pedaços (o porquê está no
 * cabeçalho de `applySilence.ts`). Entre a remoção e a reescrita existe
 * um instante em que a montagem daquele bloco não está em lugar nenhum
 * a não ser na memória do painel.
 *
 * Se a reescrita falhava ali, o executor devolvia a mensagem
 * "Use Desfazer corte para recuperar os clipes originais" — e ia embora,
 * deixando um buraco na timeline e a recuperação dependendo de o editor
 * ler a frase e clicar no botão certo. Quem fechasse o painel, ou quem
 * não lesse, perdia a montagem.
 *
 * ── A regra ───────────────────────────────────────────────────────
 * Passada a primeira remoção, a operação termina em UM de dois estados:
 * o corte inteiro aplicado, ou a timeline original de volta — e a volta
 * é automática, não um convite. Só quando a própria volta falha é que
 * existe um terceiro final, e esse grita.
 *
 * ── Por que mora fora do applySilence ─────────────────────────────
 * Para poder ser provado. `applyCuts` fala com transações do Premiere e
 * com o ffmpeg; aqui só existe a ORDEM — remover, registrar, escrever,
 * e voltar atrás — atrás de três funções que o teste implementa e faz
 * falhar em qualquer ponto. Nenhuma lógica de edição é replicada: os
 * passos continuam sendo os de lá.
 */

/** Como os passos do corte já respondem hoje. */
export type StepResult = { ok: true } | { ok: false; message: string };

/**
 * Um bloco de clipes encostados, nos três tempos que o corte faz.
 *
 * `snapshot()` fica ENTRE os dois por um motivo que é a correção
 * inteira: só depois da remoção se sabe o que precisa voltar, e o
 * registro tem de existir antes da escrita que pode falhar.
 */
export interface CutRun<S> {
  /** 1) Tira os originais do caminho. A primeira mutação destrutiva. */
  remove(): Promise<StepResult>;
  /** 2) O que desfazer precisa saber, montado depois da remoção. */
  snapshot(): S;
  /** 3) Reescreve os trechos que sobrevivem. */
  write(): Promise<StepResult>;
}

/** Devolve ao estado anterior os blocos já registrados. */
export interface CutRollback<S> {
  (runs: readonly S[]): Promise<StepResult>;
}

export type CutOutcome<S> =
  /** Tudo aplicado. */
  | { kind: "done"; runs: S[] }
  /** Falhou ANTES de qualquer remoção: não há o que desfazer. */
  | { kind: "untouched"; cause: string }
  /** Falhou depois de mutar, e a timeline voltou sozinha ao que era. */
  | { kind: "restored"; cause: string }
  /**
   * Falhou depois de mutar E a volta também falhou. `runs` é o material
   * de recuperação — não pode ser descartado.
   */
  | {
      kind: "critical";
      cause: string;
      rollbackCause: string;
      runs: S[];
    };

/**
 * Roda os blocos na ordem, com volta atrás automática.
 *
 * **Nunca lança**: um passo que estoure é tratado como falha do passo,
 * porque uma exceção subindo daqui era o caminho pelo qual o snapshot
 * se perdia — o `catch` de fora de `applyCuts` devolvia
 * `snapshot: null` com a timeline já cortada pela metade.
 */
export async function runCutTransaction<S>(
  runs: readonly CutRun<S>[],
  rollback: CutRollback<S>
): Promise<CutOutcome<S>> {
  /** Registrados, na ordem. É o que a volta atrás desfaz. */
  const touched: S[] = [];

  for (const run of runs) {
    const removed = await attempt(() => run.remove(), "a remoção dos clipes originais");
    if (!removed.ok) {
      if (touched.length === 0) {
        // Nada foi tocado ainda: o plano segue válido e a timeline
        // intacta. É a "recusa seca" que os painéis já sabem tratar.
        return { kind: "untouched", cause: removed.message };
      }
      // Blocos anteriores já foram cortados. Mesmo estando cada um
      // consistente, um corte pela metade não é um dos dois finais.
      return await undo(touched, removed.message, rollback);
    }

    // O registro ANTES da escrita: é ele que faz a volta atrás existir
    // para o bloco que está sendo escrito agora.
    touched.push(run.snapshot());

    const written = await attempt(() => run.write(), "a escrita de um trecho");
    if (!written.ok) {
      return await undo(touched, written.message, rollback);
    }
  }

  return { kind: "done", runs: touched };
}

/** Um passo, com exceção virando falha de passo. */
async function attempt(
  step: () => Promise<StepResult>,
  what: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    return await step();
  } catch (cause) {
    return {
      ok: false,
      message: `Falha em ${what}: ${describe(cause)}`,
    };
  }
}

async function undo<S>(
  touched: S[],
  cause: string,
  rollback: CutRollback<S>
): Promise<CutOutcome<S>> {
  let back: StepResult;
  try {
    back = await rollback(touched);
  } catch (rollbackCause) {
    back = { ok: false, message: describe(rollbackCause) };
  }
  if (back.ok) {
    return { kind: "restored", cause };
  }
  /*
   * O final que não deveria existir. O erro original vai junto do erro
   * da volta — esconder qualquer um dos dois tira de quem vai consertar
   * justamente a informação de que ele precisa — e `runs` sai inteiro,
   * porque é o único registro do que a timeline era.
   */
  return {
    kind: "critical",
    cause,
    rollbackCause: back.message,
    runs: touched,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
