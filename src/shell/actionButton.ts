/**
 * Um botão cuja ação MUDA ao longo da vida dele.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * O botão do modal de atualização tem mais de um papel: começa em
 * "Atualizar Agora" e, se a instalação falhar, vira "Tentar via
 * Navegador". A troca era feita assim:
 *
 *     btnUpdate.addEventListener("click", async () => { …applyUpdate… });
 *     // mais tarde, no ramo de falha:
 *     btnUpdate.onclick = () => openDownloadPage();
 *
 * `onclick` e `addEventListener` são dois canais de registro
 * INDEPENDENTES — atribuir um não remove o outro. Então o clique
 * seguinte disparava os dois: abria o navegador E tentava a instalação
 * de novo, desabilitando o botão, escondendo o "Depois" e reiniciando a
 * barra de progresso. A ação de contorno re-armava exatamente a operação
 * que acabara de falhar.
 *
 * ── A regra ───────────────────────────────────────────────────────
 * Um listener, registrado uma vez. A ação corrente é uma VARIÁVEL, e
 * trocar de estado troca essa variável — nunca acrescenta um caminho
 * novo. Um clique executa no máximo uma ação: a do estado de agora.
 *
 * ── Por que mora fora do ProductShell ─────────────────────────────
 * Para poder ser provado. `ProductShell.ts` não é importável em teste
 * (lê o define `__APP_VERSION__` no topo do módulo e o catálogo arrasta
 * as onze Tools). Aqui não há DOM real: o botão entra por uma porta de
 * três campos que tanto um `HTMLButtonElement` quanto um dublê de teste
 * satisfazem.
 */

/** O mínimo que o controlador precisa do elemento. */
export interface ButtonEl {
  textContent: string | null;
  disabled: boolean;
  addEventListener(type: "click", handler: () => void): void;
}

/** `null` desliga o botão: clicar não faz nada. */
export type ButtonAction = (() => void | Promise<void>) | null;

export interface ActionButton {
  /** Troca rótulo e ação. A ação anterior deixa de existir. */
  set(label: string, action: ButtonAction): void;
  /** Troca só a ação, mantendo o rótulo. */
  setAction(action: ButtonAction): void;
  /** O rótulo do estado corrente. Para teste e diagnóstico. */
  label(): string;
  /** true enquanto a ação corrente não terminou. */
  busy(): boolean;
}

export function actionButton(el: ButtonEl): ActionButton {
  let action: ButtonAction = null;
  let running = false;

  /*
   * UM listener, para sempre. É a diferença inteira: enquanto a troca de
   * estado registrava um caminho novo, o antigo continuava lá.
   */
  el.addEventListener("click", () => {
    void run();
  });

  async function run(): Promise<void> {
    // A ação é lida AGORA, no clique — não capturada no registro. É o
    // que faz o botão executar o estado de agora, e não o de antes.
    const current = action;
    // `disabled` é a decisão de quem desenha; `running` cobre o clique
    // repetido durante um trabalho que esqueceu de desabilitar.
    if (!current || running || el.disabled) {
      return;
    }
    running = true;
    try {
      await current();
    } catch (cause) {
      // Este botão é clicado com `void`: uma rejeição aqui não teria
      // dono. Quem quiser tratar o erro trata dentro da própria ação.
      console.error("[Shell] a ação do botão falhou:", cause);
    } finally {
      running = false;
    }
  }

  return {
    set(label, next) {
      el.textContent = label;
      action = next;
    },
    setAction(next) {
      action = next;
    },
    label() {
      return el.textContent ?? "";
    },
    busy() {
      return running;
    },
  };
}
