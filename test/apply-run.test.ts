/**
 * O cerco de erro do Apply.
 *
 * O caso que este arquivo existe para travar: uma Tool que rejeita no
 * meio do Apply depois de ter desabilitado o botão. Antes do cerco, a
 * rejeição não tinha dono — nada na barra de status — e o `finally`
 * respeitava o `applyStateOwned`, deixando o painel com um botão morto
 * embaixo de um "Organizando…" que nunca mudava.
 *
 * Nenhuma das asserções depende de DOM ou do host: o que se prova aqui
 * é a máquina de estados, que é onde estava o defeito. E o executor de
 * testes do Node falha a rodada inteira numa rejeição sem dono, então
 * "não vaza rejeição" é verificado pelo simples fato de a suíte passar —
 * além do `doesNotReject` explícito de cada caso.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardApplyRun, type ApplyRun } from "../src/shell/applyRun";

/** Uma Shell de mentira, que só anota o que foi pedido dela. */
function shell(overrides: Partial<ApplyRun> = {}): {
  io: ApplyRun;
  disabled: boolean[];
  errors: unknown[];
  settled: number;
} {
  const disabled: boolean[] = [];
  const errors: unknown[] = [];
  const state = { settled: 0 };
  const io: ApplyRun = {
    run: () => undefined,
    stale: () => false,
    stateOwned: () => false,
    setApplyDisabled: (value) => disabled.push(value),
    reportError: (cause) => errors.push(cause),
    settled: () => {
      state.settled += 1;
    },
    ...overrides,
  };
  return {
    io,
    disabled,
    errors,
    get settled() {
      return state.settled;
    },
  };
}

describe("guardApplyRun", () => {
  it("sucesso sem opinião da Tool: devolve o botão", async () => {
    const host = shell({ run: async () => undefined });
    await assert.doesNotReject(() => guardApplyRun(host.io));
    assert.deepEqual(host.disabled, [false]);
    assert.deepEqual(host.errors, []);
    assert.equal(host.settled, 1);
  });

  it("sucesso com applyStateOwned: NÃO toca no botão", async () => {
    // A Tool que decidiu o estado continua com ele. É o que impede o
    // botão de acender de novo depois de uma execução que não deixou
    // nada selecionado.
    const host = shell({ run: async () => undefined, stateOwned: () => true });
    await guardApplyRun(host.io);
    assert.deepEqual(host.disabled, []);
    assert.equal(host.settled, 1);
  });

  it("a Tool rejeita: não vaza a rejeição, reporta o erro e devolve o botão", async () => {
    const boom = new Error("The script object is no longer valid");
    const host = shell({
      run: async () => {
        throw boom;
      },
    });
    await assert.doesNotReject(() => guardApplyRun(host.io));
    assert.deepEqual(host.disabled, [false]);
    // A causa chega inteira: quem formata a frase é a Shell.
    assert.deepEqual(host.errors, [boom]);
    assert.equal(host.settled, 1);
  });

  it("rejeita COM applyStateOwned: o botão volta — é o painel travado", async () => {
    // O caso do Organizar: `setApplyEnabled(false)` e depois o host
    // recusa. Respeitar o `false` aqui é o que deixava o botão morto.
    const host = shell({
      run: async () => {
        throw new Error("Nenhum projeto aberto.");
      },
      stateOwned: () => true,
    });
    await guardApplyRun(host.io);
    assert.deepEqual(host.disabled, [false]);
    assert.equal(host.errors.length, 1);
  });

  it("rejeição síncrona conta como rejeição", async () => {
    const host = shell({
      run: () => {
        throw new Error("lançou antes do primeiro await");
      },
    });
    await assert.doesNotReject(() => guardApplyRun(host.io));
    assert.deepEqual(host.disabled, [false]);
    assert.equal(host.errors.length, 1);
  });

  it("lançar undefined ainda é falha", async () => {
    // `throw undefined` é legal, e um `caught` guardado como a causa
    // direta trataria isso como sucesso.
    const host = shell({
      run: () => {
        throw undefined;
      },
    });
    await guardApplyRun(host.io);
    assert.deepEqual(host.disabled, [false]);
    assert.deepEqual(host.errors, [undefined]);
  });

  it("Tool trocada durante a falha: botão desabilitado e NADA na barra", async () => {
    // A barra de status pertence à Tool que entrou. Escrever o erro da
    // que saiu é pintar por cima dela — o mesmo motivo do `live()` do
    // ToolContext.
    const host = shell({
      run: async () => {
        throw new Error("falhou depois da troca");
      },
      stale: () => true,
    });
    await guardApplyRun(host.io);
    assert.deepEqual(host.disabled, [true]);
    assert.deepEqual(host.errors, []);
    assert.equal(host.settled, 1);
  });

  it("Tool trocada com sucesso: botão desabilitado", async () => {
    const host = shell({ run: async () => undefined, stale: () => true });
    await guardApplyRun(host.io);
    assert.deepEqual(host.disabled, [true]);
    assert.deepEqual(host.errors, []);
  });

  it("nem a recuperação que falha faz o cerco rejeitar", async () => {
    const host = shell({
      run: async () => {
        throw new Error("falha da Tool");
      },
      settled: () => {
        throw new Error("a própria Shell tropeçou");
      },
    });
    await assert.doesNotReject(() => guardApplyRun(host.io));
  });
});
