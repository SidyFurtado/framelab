/**
 * O botão que troca de papel, no modal de atualização.
 *
 * O caso que este arquivo existe para travar: o botão começa em
 * "Atualizar Agora" e, na falha, vira "Tentar via Navegador". A troca era
 * feita com `btnUpdate.onclick = …` enquanto o `addEventListener`
 * original continuava registrado — dois canais independentes. O clique
 * seguinte disparava OS DOIS: abria o navegador e tentava a instalação de
 * novo, re-armando exatamente a operação que acabara de falhar.
 *
 * O que se prova aqui é a máquina de estados: um listener, uma ação
 * corrente, e no máximo uma execução por clique. Sem DOM real — o botão
 * entra pela porta de três campos que o controlador declara.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionButton, type ButtonEl } from "../src/shell/actionButton";

/** Um botão de mentira que conta quantos listeners recebeu. */
function fakeButton(): ButtonEl & { click(): void; listeners: number } {
  const handlers: Array<() => void> = [];
  return {
    textContent: "",
    disabled: false,
    addEventListener(_type, handler) {
      handlers.push(handler);
    },
    get listeners() {
      return handlers.length;
    },
    // Um clique real chama TODOS os handlers registrados. É assim que o
    // defeito aparecia, e é assim que o dublê tem de se comportar.
    click() {
      for (const handler of [...handlers]) handler();
    },
  };
}

/** Deixa o microtask das ações assíncronas drenar antes de conferir. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("actionButton · uma ação por clique", () => {
  it("estado normal: um clique, uma atualização", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let updates = 0;

    button.set("Atualizar Agora", () => {
      updates += 1;
    });
    el.click();
    await settle();

    assert.equal(updates, 1);
    assert.equal(el.textContent, "Atualizar Agora");
  });

  it("vira 'Tentar via Navegador': um clique, navegador e ZERO updates", async () => {
    // É o defeito, por extenso.
    const el = fakeButton();
    const button = actionButton(el);
    let updates = 0;
    let browser = 0;

    button.set("Atualizar Agora", () => {
      updates += 1;
      button.set("Tentar via Navegador", () => {
        browser += 1;
      });
    });

    el.click();
    await settle();
    assert.equal(updates, 1);
    assert.equal(browser, 0);

    el.click();
    await settle();
    assert.equal(browser, 1, "o navegador não abriu");
    assert.equal(updates, 1, "a instalação foi re-armada pelo botão de contorno");
    assert.equal(el.textContent, "Tentar via Navegador");
  });

  it("voltar para atualizar: um clique, um retry e nenhum navegador", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let updates = 0;
    let browser = 0;

    button.set("Atualizar Agora", () => {
      updates += 1;
    });
    button.set("Tentar via Navegador", () => {
      browser += 1;
    });
    button.set("Tentar Novamente", () => {
      updates += 1;
    });

    el.click();
    await settle();

    assert.equal(updates, 1);
    assert.equal(browser, 0, "a ação anterior sobreviveu à troca de estado");
  });

  it("estado desligado: clicar não faz nada", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let acted = 0;

    button.set("Atualizar Agora", () => {
      acted += 1;
    });
    button.setAction(null);
    el.click();
    await settle();

    assert.equal(acted, 0);
    // O rótulo não muda: desligar a ação não é apagar a frase da tela.
    assert.equal(el.textContent, "Atualizar Agora");
  });

  it("botão desabilitado não dispara", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let acted = 0;

    button.set("Atualizar Agora", () => {
      acted += 1;
    });
    el.disabled = true;
    el.click();
    await settle();
    assert.equal(acted, 0);

    el.disabled = false;
    el.click();
    await settle();
    assert.equal(acted, 1);
  });
});

describe("actionButton · os listeners não acumulam", () => {
  it("um listener só, por mais estados que o botão atravesse", () => {
    const el = fakeButton();
    const button = actionButton(el);
    assert.equal(el.listeners, 1);

    for (let at = 0; at < 20; at += 1) {
      button.set(`estado ${at}`, () => undefined);
      button.setAction(() => undefined);
    }
    assert.equal(el.listeners, 1, "cada troca de estado somou um caminho novo");
  });

  it("depois de muitas transições, o clique executa UMA ação: a atual", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    const fired: string[] = [];

    for (const name of ["update", "navegador", "retry", "navegador de novo"]) {
      button.set(name, () => {
        fired.push(name);
      });
    }
    el.click();
    await settle();

    assert.deepEqual(fired, ["navegador de novo"]);
  });
});

describe("actionButton · sem reentrada durante o trabalho", () => {
  it("cliques repetidos não iniciam duas atualizações", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let starts = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    button.set("Atualizar Agora", async () => {
      starts += 1;
      await held;
    });

    el.click();
    el.click();
    el.click();
    await settle();
    assert.equal(starts, 1, "uma instalação já em curso foi iniciada de novo");
    assert.equal(button.busy(), true);

    release();
    await settle();
    assert.equal(button.busy(), false);

    // Terminado o trabalho, o botão volta a responder.
    el.click();
    await settle();
    assert.equal(starts, 2);
  });

  it("uma ação que falha libera o botão e não deixa rejeição sem dono", async () => {
    const el = fakeButton();
    const button = actionButton(el);
    let tries = 0;

    button.set("Atualizar Agora", async () => {
      tries += 1;
      throw new Error("a instalação estourou");
    });

    el.click();
    await settle();
    assert.equal(tries, 1);
    assert.equal(button.busy(), false, "o botão ficou preso em 'trabalhando'");

    el.click();
    await settle();
    assert.equal(tries, 2);
  });

  it("trocar de estado DURANTE o trabalho vale para o clique seguinte", async () => {
    // É a sequência real: a ação de instalar troca o próprio botão para
    // "Tentar via Navegador" antes de terminar.
    const el = fakeButton();
    const button = actionButton(el);
    const fired: string[] = [];

    button.set("Atualizar Agora", async () => {
      fired.push("update");
      button.set("Tentar via Navegador", () => {
        fired.push("browser");
      });
      await settle();
    });

    el.click();
    await settle();
    await settle();
    el.click();
    await settle();

    assert.deepEqual(fired, ["update", "browser"]);
  });
});
