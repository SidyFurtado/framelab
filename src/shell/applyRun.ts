/**
 * O cerco de erro do Apply.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * A Shell dispara o Apply com `void this.runApply()`, e `runApply` só
 * tinha `try/finally`. Uma Tool que rejeitasse — e cinco das onze não
 * têm `try/catch` próprio, confiando em que a função `apply*` nunca
 * lance — produzia uma rejeição sem dono: nenhuma mensagem na barra de
 * status, e o pior estado possível do painel.
 *
 * O pior estado é este: a Tool chama `setApplyEnabled(false)` antes de
 * trabalhar (é o que o Organizar faz, logo depois de escrever
 * "Organizando…"). Isso liga `applyStateOwned`, que existe para a Shell
 * não passar por cima de uma decisão da Tool. Com a decisão tomada e o
 * trabalho morto no meio, o `finally` respeitava o `false` e devolvia um
 * botão morto embaixo de um "Organizando…" que nunca mudava. Num painel
 * UXP, sem console à mão, isso é indepurável.
 *
 * ── A regra ───────────────────────────────────────────────────────
 * `applyStateOwned` continua valendo — mas só para uma execução que
 * TERMINOU. Uma que lançou não decidiu nada: a decisão foi tomada com
 * base num trabalho que não aconteceu, e devolver o botão é o que
 * impede o painel de travar. A barra de status recebe o erro pelo
 * mecanismo que a Shell já tem.
 *
 * ── Por que mora fora do ProductShell ─────────────────────────────
 * Para poder ser provado. `ProductShell.ts` não é importável fora do
 * host: ele lê `__APP_VERSION__` (um define do vite) no topo do módulo
 * e o catálogo arrasta as onze Tools. Aqui não há DOM nem host — só a
 * máquina de estados, que é justamente a parte que errava. Mesma razão
 * de `agentBash()` e `markup()` serem exportadas.
 */

/**
 * O que o cerco precisa da Shell. Tudo é função porque o estado muda
 * DURANTE a execução: a Tool pode ser trocada no meio, e a resposta a
 * "de quem é este botão?" só vale depois do `await`.
 */
export interface ApplyRun {
  /** O trabalho da Tool. É o único ponto que pode lançar. */
  run(): void | Promise<void>;
  /** true quando a Tool que pediu já não é a montada. */
  stale(): boolean;
  /** true quando a Tool decidiu o estado do botão por conta. */
  stateOwned(): boolean;
  setApplyDisabled(disabled: boolean): void;
  /** O erro na barra de status. Não é chamado quando está `stale`. */
  reportError(cause: unknown): void;
  /** O fim: o selo de contagem do botão. */
  settled(): void;
}

/**
 * Roda o Apply de uma Tool e devolve o painel utilizável, deu no que
 * der. **Nunca rejeita** — é o contrato que faz de `void runApply()`
 * uma chamada segura.
 */
export async function guardApplyRun(io: ApplyRun): Promise<void> {
  // Uma caixa, e não a causa direta: `undefined` e `null` são coisas
  // que se pode lançar, e `caught !== null` tem de continuar sabendo
  // diferenciá-las de "não lançou".
  let caught: { cause: unknown } | null = null;
  try {
    await io.run();
  } catch (cause) {
    caught = { cause };
  }

  try {
    const stale = io.stale();
    if (stale) {
      // A Tool de saída não manda mais no botão: quem manda é a que
      // entrou, e ela já o deixou como quis.
      io.setApplyDisabled(true);
    } else if (caught) {
      io.setApplyDisabled(false);
    } else if (!io.stateOwned()) {
      // Sucesso e a Tool não opinou. Note que não há `else`: com
      // `stateOwned`, o botão fica EXATAMENTE como a Tool o deixou.
      io.setApplyDisabled(false);
    }
    io.settled();
    if (caught && !stale) {
      // Por último, para que nada mais escreva na barra depois do erro.
      io.reportError(caught.cause);
    }
  } catch (recovery) {
    // A recuperação é DOM da própria Shell e não tem como falhar. Se um
    // dia falhar, o cerco ainda não rejeita: um cerco que estoura não é
    // cerco, e quem chama é um `void`.
    console.error("[Shell] falha ao recuperar o painel após o Apply:", recovery);
  }
}
