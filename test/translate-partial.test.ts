/**
 * A reserva da tradução, e o trabalho que ela jogava fora.
 *
 * O caso que este arquivo existe para travar: o MyMemory traduz UMA
 * fala por requisição, e o laço devolvia `null` ao primeiro tropeço —
 * apagando tudo que já tinha vindo. Pior: `translate` então devolvia
 * `texts: []`, descartando também os lotes que o Google já tinha
 * fechado. Num .srt de centenas de legendas, um 429 na fala 200 (e o
 * MyMemory limita taxa, então 429 é esperado) custava as 199 anteriores
 * e todo o resto, com a mensagem "os dois tradutores recusaram".
 *
 * Nada aqui toca a rede: o `fetch` global é um dublê.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { translate } from "../src/tools/translate/engine";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Uma resposta do Google: um array com uma tradução por fala. */
function respostaGoogle(textos: string[]): unknown {
  return { ok: true, status: 200, text: async () => JSON.stringify(textos) };
}

/** Uma resposta do MyMemory: uma fala por vez. */
function respostaMyMemory(texto: string): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ responseData: { translatedText: texto } }),
  };
}

function recusa(status: number): unknown {
  return { ok: false, status, json: async () => ({}), text: async () => "" };
}

const ehGoogle = (url: string): boolean => url.includes("clients5.google.com");

/**
 * Monta o dublê: o Google sempre recusa (para forçar a reserva) e o
 * MyMemory responde conforme o roteiro, uma fala por chamada.
 */
function comReserva(roteiro: (indice: number, url: string) => unknown): {
  chamadas: number;
  falas: string[];
} {
  const state = { chamadas: 0, falas: [] as string[] };
  globalThis.fetch = ((url: string) => {
    if (ehGoogle(url)) {
      return Promise.resolve(recusa(500));
    }
    const indice = state.chamadas;
    state.chamadas += 1;
    const pedido = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? "");
    state.falas.push(pedido);
    const resposta = roteiro(indice, url);
    return resposta instanceof Error
      ? Promise.reject(resposta)
      : Promise.resolve(resposta);
  }) as unknown as typeof globalThis.fetch;
  return state;
}

const TRES = ["um", "dois", "três"];

// ── o caminho feliz não mudou ──────────────────────────────────────

describe("translate · o Google funcionando", () => {
  it("traduz tudo sem tocar na reserva", async () => {
    let myMemory = 0;
    globalThis.fetch = ((url: string) => {
      if (!ehGoogle(url)) myMemory += 1;
      return Promise.resolve(respostaGoogle(["one", "two", "three"]));
    }) as unknown as typeof globalThis.fetch;

    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.deepEqual(saida.texts, ["one", "two", "three"]);
    assert.equal(saida.error, null);
    assert.equal(saida.pending, 0);
    assert.equal(saida.done, 3);
    assert.equal(myMemory, 0, "chamou a reserva sem precisar");
  });
});

describe("translate · a reserva cobrindo o lote inteiro", () => {
  it("traduz tudo e devolve o contrato normal", async () => {
    const dublê = comReserva((i) => respostaMyMemory(["one", "two", "three"][i]));
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.deepEqual(saida.texts, ["one", "two", "three"]);
    assert.equal(saida.pending, 0);
    assert.equal(saida.done, 3);
    assert.equal(dublê.chamadas, 3, "a reserva deixou de ser serial");
  });
});

// ── a perda de trabalho ────────────────────────────────────────────

describe("translate · falha DEPOIS de progresso preserva o que veio", () => {
  it("falas 1 e 2 traduzem, a 3 falha: as duas primeiras ficam", async () => {
    comReserva((i) =>
      i < 2 ? respostaMyMemory(["one", "two"][i]) : recusa(500)
    );
    const saida = await translate(TRES, { from: "pt", to: "en" });

    // O ponto do item: nada do que veio é jogado fora.
    assert.equal(saida.ok, true, "a falha posterior derrubou o lote inteiro");
    assert.deepEqual(saida.texts, ["one", "two", "três"]);
    assert.equal(saida.done, 2);
    assert.equal(saida.pending, 1);
    assert.equal(saida.error, null);
  });

  it("429 depois de progresso vira parcial, não both-engines-failed", async () => {
    comReserva((i) => (i < 2 ? respostaMyMemory(["one", "two"][i]) : recusa(429)));
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.notEqual(saida.error, "both-engines-failed");
    assert.equal(saida.done, 2);
    assert.equal(saida.pending, 1);
  });

  it("timeout depois de progresso vira parcial", async () => {
    const { NetTimeout } = await import("../src/bridge/net");
    comReserva((i) =>
      i < 1 ? respostaMyMemory("one") : new NetTimeout(30000)
    );
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.deepEqual(saida.texts, ["one", "dois", "três"]);
    assert.equal(saida.done, 1);
    assert.equal(saida.pending, 2);
  });

  it("erro de rede depois de progresso vira parcial", async () => {
    comReserva((i) =>
      i < 1 ? respostaMyMemory("one") : new TypeError("Failed to fetch")
    );
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.equal(saida.done, 1);
    assert.equal(saida.pending, 2);
  });

  it("a ordem é preservada e nada é duplicado", async () => {
    const entradas = ["a", "b", "c", "d", "e"];
    comReserva((i) => (i < 3 ? respostaMyMemory(`T${i}`) : recusa(429)));
    const saida = await translate(entradas, { from: "pt", to: "en" });

    assert.deepEqual(saida.texts, ["T0", "T1", "T2", "d", "e"]);
    assert.equal(new Set(saida.texts).size, 5, "traduziu duas falas com o mesmo texto");
    assert.equal(saida.texts.length, entradas.length);
  });

  it("a contagem bate com o que saiu traduzido", async () => {
    const entradas = ["a", "b", "c", "d"];
    comReserva((i) => (i < 2 ? respostaMyMemory(`T${i}`) : recusa(500)));
    const saida = await translate(entradas, { from: "pt", to: "en" });

    const mudaram = saida.texts.filter((t, i) => t !== entradas[i]).length;
    assert.equal(saida.done, mudaram);
    assert.equal((saida.done ?? 0) + (saida.pending ?? 0), entradas.length);
  });

  it("não insiste na reserva depois que ela cai", async () => {
    // Um .srt grande vira mais de um lote; o limite de taxa não melhora
    // pedindo mais.
    const muitas = Array.from({ length: 120 }, (_, i) => `fala ${i}`);
    const dublê = comReserva((i) => (i < 5 ? respostaMyMemory(`T${i}`) : recusa(429)));
    const saida = await translate(muitas, { from: "pt", to: "en" });

    assert.equal(saida.ok, true);
    assert.equal(saida.done, 5);
    assert.equal(dublê.chamadas, 6, "continuou pedindo depois do 429");
  });
});

// ── zero progresso continua sendo falha ────────────────────────────

describe("translate · sem nenhuma tradução", () => {
  it("a PRIMEIRA fala falha: falha total, como antes", async () => {
    comReserva(() => recusa(429));
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, false);
    assert.equal(saida.error, "both-engines-failed");
    assert.deepEqual(saida.texts, []);
    assert.equal(saida.done, 0);
  });

  it("zero traduções não é chamado de parcial", async () => {
    comReserva(() => new TypeError("sem rede"));
    const saida = await translate(TRES, { from: "pt", to: "en" });
    assert.equal(saida.ok, false);
    assert.equal(saida.done, 0);
  });
});

// ── cancelamento ───────────────────────────────────────────────────

describe("translate · cancelamento", () => {
  it("cancelado antes da primeira fala: nenhuma requisição", async () => {
    const dublê = comReserva(() => respostaMyMemory("x"));
    const saida = await translate(TRES, {
      from: "pt",
      to: "en",
      cancelled: () => true,
    });

    assert.equal(saida.ok, false);
    assert.equal(saida.error, "cancelled");
    assert.equal(dublê.chamadas, 0, "abriu requisição já cancelado");
  });

  it("cancelado entre duas falas: nenhuma requisição nova", async () => {
    let cancelar = false;
    const dublê = comReserva((i) => {
      if (i === 1) cancelar = true; // desiste logo após a segunda resposta
      return respostaMyMemory(`T${i}`);
    });

    const saida = await translate(["a", "b", "c", "d"], {
      from: "pt",
      to: "en",
      cancelled: () => cancelar,
    });

    assert.equal(saida.error, "cancelled");
    assert.equal(dublê.chamadas, 2, "pediu mais uma fala depois de cancelar");
  });

  it("cancelamento não vira both-engines-failed nem erro de tradução", async () => {
    comReserva((i) => (i < 1 ? respostaMyMemory("one") : recusa(429)));
    let cancelar = false;
    const saida = await translate(TRES, {
      from: "pt",
      to: "en",
      cancelled: () => {
        const agora = cancelar;
        cancelar = true; // cancela depois da primeira checagem
        return agora;
      },
    });

    assert.notEqual(saida.error, "both-engines-failed");
    assert.notEqual(saida.error, "engine-failed");
    assert.equal(saida.error, "cancelled");
  });

  it("um NetCancelled no meio é desistência, não falha", async () => {
    const { NetCancelled } = await import("../src/bridge/net");
    comReserva((i) => (i < 1 ? respostaMyMemory("one") : new NetCancelled()));
    const saida = await translate(TRES, { from: "pt", to: "en" });

    assert.equal(saida.ok, false);
    assert.equal(saida.error, "cancelled");
    assert.notEqual(saida.error, "both-engines-failed");
  });

  it("o cancelamento conta o que já tinha vindo, para diagnóstico", async () => {
    let chamadas = 0;
    comReserva(() => {
      chamadas += 1;
      return respostaMyMemory(`T${chamadas}`);
    });
    const saida = await translate(TRES, {
      from: "pt",
      to: "en",
      cancelled: () => chamadas >= 2,
    });

    assert.equal(saida.error, "cancelled");
    assert.equal(saida.done, 2);
    assert.equal(saida.pending, 1);
  });
});
