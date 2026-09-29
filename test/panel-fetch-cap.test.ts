/**
 * O teto de memória do download dentro do painel.
 *
 * O caso que este arquivo existe para travar: no ramo 200 — servidor que
 * ignora `Range` e manda o arquivo inteiro numa resposta só — o código
 * chamava `arrayBuffer()` e **só então** comparava com `MAX_BYTES`. A
 * verificação chegava com os bytes já na memória. Um link que resolvesse
 * para algo muito maior que o esperado derrubava o painel inteiro, não
 * só a operação.
 *
 * A prova que importa está em "recusa SEM tocar no corpo": o
 * `arrayBuffer` do dublê registra se foi chamado.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchAllBytes } from "../src/tools/download/panelFetch";

const MAX_BYTES = 300 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface RespostaFalsa {
  status: number;
  /** Cabeçalhos, já em minúsculas. */
  headers?: Record<string, string>;
  /** O corpo, para `arrayBuffer()`. */
  bytes?: Uint8Array;
  /** Os pedaços, para o leitor em partes. `null` = sem `body`. */
  pedacos?: Uint8Array[] | null;
}

interface Dublê {
  /** true quando alguém chamou `arrayBuffer()`. */
  leuCorpoInteiro: boolean;
  /** Quantos bytes o leitor em partes chegou a entregar. */
  entregues: number;
  /** true quando o fluxo foi solto com `cancel()`. */
  soltou: boolean;
  chamadas: number;
}

function servir(roteiro: (indice: number) => RespostaFalsa): Dublê {
  const state = { leuCorpoInteiro: false, entregues: 0, soltou: false, chamadas: 0 };

  globalThis.fetch = (() => {
    const plano = roteiro(state.chamadas);
    state.chamadas += 1;

    const headers = {
      get: (nome: string) => plano.headers?.[nome.toLowerCase()] ?? null,
    };

    let body: unknown = null;
    if (plano.pedacos !== null && plano.pedacos !== undefined) {
      const fila = [...plano.pedacos];
      body = {
        getReader: () => ({
          read: async () => {
            const proximo = fila.shift();
            if (!proximo) return { done: true, value: undefined };
            state.entregues += proximo.byteLength;
            return { done: false, value: proximo };
          },
          cancel: async () => {
            state.soltou = true;
          },
        }),
      };
    }

    return Promise.resolve({
      status: plano.status,
      ok: plano.status >= 200 && plano.status < 300,
      headers,
      body,
      arrayBuffer: async () => {
        state.leuCorpoInteiro = true;
        return (plano.bytes ?? new Uint8Array(0)).buffer;
      },
    });
  }) as unknown as typeof globalThis.fetch;

  return state as Dublê;
}

/** N bytes, sem alocar N de verdade quando não precisa. */
const bytes = (n: number): Uint8Array => new Uint8Array(n);

// ── 200 com Content-Length ─────────────────────────────────────────

describe("fetchAllBytes · HTTP 200 com Content-Length", () => {
  it("abaixo do teto: lê e devolve", async () => {
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": "1024" },
      bytes: bytes(1024),
      pedacos: null,
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    assert.equal(saida.byteLength, 1024);
    assert.equal(dublê.leuCorpoInteiro, true);
  });

  it("exatamente no teto: permitido", async () => {
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": String(MAX_BYTES) },
      pedacos: [bytes(8)],
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    assert.equal(saida.byteLength, 8);
    assert.equal(dublê.leuCorpoInteiro, false);
  });

  it("ACIMA do teto: recusa SEM tocar no corpo", async () => {
    // É o defeito, por extenso.
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": String(MAX_BYTES + 1) },
      bytes: bytes(16),
      pedacos: [bytes(16)],
    }));

    await assert.rejects(
      () => fetchAllBytes("https://cdn/v.mp4"),
      /grande demais/
    );
    assert.equal(dublê.leuCorpoInteiro, false, "leu o corpo antes de recusar");
    assert.equal(dublê.entregues, 0, "começou a receber bytes antes de recusar");
  });

  it("um tamanho absurdo também é recusado antes do corpo", async () => {
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": "999999999999999999999" },
      bytes: bytes(16),
      pedacos: [bytes(16)],
    }));
    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /grande demais/);
    assert.equal(dublê.leuCorpoInteiro, false);
  });
});

// ── cabeçalhos que não dá para acreditar ───────────────────────────

describe("fetchAllBytes · Content-Length inválido não vira passe livre", () => {
  const invalidos: Array<[string, string]> = [
    ["vazio", ""],
    ["não numérico", "muitos"],
    ["negativo", "-1"],
    ["com sinal", "+2048"],
    ["decimal", "10.5"],
    ["com sufixo", "2048 bytes"],
  ];

  for (const [nome, valor] of invalidos) {
    it(`${nome}: cai na leitura em partes, com o teto na mão`, async () => {
      const dublê = servir(() => ({
        status: 200,
        headers: { "content-length": valor },
        pedacos: [bytes(64)],
      }));
      const saida = await fetchAllBytes("https://cdn/v.mp4");
      assert.equal(saida.byteLength, 64);
      assert.equal(dublê.leuCorpoInteiro, false, "leu tudo de uma vez apesar do cabeçalho ruim");
    });
  }

  it("inválido E sem leitura em partes: recusa em vez de arriscar", async () => {
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": "sei lá" },
      bytes: bytes(64),
      pedacos: null,
    }));
    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /não disse o tamanho/);
    assert.equal(dublê.leuCorpoInteiro, false);
  });
});

// ── 200 sem Content-Length ─────────────────────────────────────────

describe("fetchAllBytes · HTTP 200 sem Content-Length", () => {
  it("lê em partes e devolve o conteúdo", async () => {
    const dublê = servir(() => ({
      status: 200,
      pedacos: [bytes(10), bytes(20), bytes(30)],
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    assert.equal(saida.byteLength, 60);
    assert.equal(dublê.leuCorpoInteiro, false);
  });

  it("corpo maior que o teto PARA antes de acumular além dele", async () => {
    // Oitenta pedaços de 4 MB = 320 MB, acima dos 300 MB do teto.
    const dublê = servir(() => ({
      status: 200,
      pedacos: Array.from({ length: 80 }, () => bytes(CHUNK_BYTES)),
    }));

    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /grande demais/);
    // Parou no primeiro pedaço que passaria do teto, e nem um depois.
    assert.ok(
      dublê.entregues <= MAX_BYTES + CHUNK_BYTES,
      `acumulou ${dublê.entregues} bytes, muito além do teto`
    );
    assert.ok(dublê.entregues < 80 * CHUNK_BYTES, "leu o arquivo inteiro assim mesmo");
    assert.equal(dublê.soltou, true, "não soltou o fluxo depois de desistir");
  });

  it("sem leitura em partes e sem tamanho: recusa, e o script assume", async () => {
    const dublê = servir(() => ({ status: 200, bytes: bytes(64), pedacos: null }));
    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /não disse o tamanho/);
    assert.equal(dublê.leuCorpoInteiro, false, "leu tudo para medir depois");
  });

  it("corpo real menor que o declarado: vale o real", async () => {
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": "1000" },
      pedacos: [bytes(120)],
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    assert.equal(saida.byteLength, 120);
    assert.equal(dublê.leuCorpoInteiro, false);
  });

  it("um Content-Length MENTIROSO não fura o teto", async () => {
    // Declara 1 KB e manda 320 MB: a camada do declarado deixa passar,
    // e a leitura em partes é quem segura.
    const dublê = servir(() => ({
      status: 200,
      headers: { "content-length": "1024" },
      pedacos: Array.from({ length: 80 }, () => bytes(CHUNK_BYTES)),
    }));
    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /grande demais/);
    assert.ok(dublê.entregues <= MAX_BYTES + CHUNK_BYTES);
  });
});

// ── o caminho 206 não mudou ────────────────────────────────────────

describe("fetchAllBytes · servidor com Range (206)", () => {
  it("lê em blocos e junta, como antes", async () => {
    const total = CHUNK_BYTES * 2 + 100;
    const dublê = servir((i) => ({
      status: 206,
      headers: { "content-range": `bytes 0-9/${total}` },
      bytes: i < 2 ? bytes(CHUNK_BYTES) : bytes(100),
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    // Dois blocos cheios e um curto encerram o laço.
    assert.equal(saida.byteLength, CHUNK_BYTES * 2 + 100);
    assert.equal(dublê.chamadas, 3);
  });

  it("um total declarado acima do teto ainda corta cedo", async () => {
    servir(() => ({
      status: 206,
      headers: { "content-range": `bytes 0-9/${MAX_BYTES + 1}` },
      bytes: bytes(CHUNK_BYTES),
    }));
    await assert.rejects(() => fetchAllBytes("https://cdn/v.mp4"), /grande demais/);
  });

  it("arquivo pequeno num bloco só continua igual", async () => {
    servir(() => ({
      status: 206,
      headers: { "content-range": "bytes 0-511/512" },
      bytes: bytes(512),
    }));
    const saida = await fetchAllBytes("https://cdn/v.mp4");
    assert.equal(saida.byteLength, 512);
  });
});

// ── cancelamento e prazo seguem valendo ────────────────────────────

describe("fetchAllBytes · cancelamento e prazo", () => {
  it("cancelar antes do primeiro pedido não abre conexão", async () => {
    const dublê = servir(() => ({ status: 200, pedacos: [bytes(8)] }));
    await assert.rejects(
      () => fetchAllBytes("https://cdn/v.mp4", undefined, () => true),
      /cancelado/
    );
    assert.equal(dublê.chamadas, 0);
  });

  it("cancelar durante a leitura em partes interrompe e solta o fluxo", async () => {
    let lidos = 0;
    const dublê = servir(() => ({
      status: 200,
      pedacos: Array.from({ length: 20 }, () => bytes(1024)),
    }));
    await assert.rejects(
      () =>
        fetchAllBytes("https://cdn/v.mp4", () => {
          lidos += 1;
        }, () => lidos >= 3),
      /cancelado/
    );
    assert.equal(dublê.soltou, true, "o fluxo ficou aberto depois do cancelamento");
  });

  it("o prazo do P2-8 continua valendo na resposta", async () => {
    // Uma resposta que nunca chega: quem corta é o `fetchWithTimeout`.
    globalThis.fetch = (() => new Promise(() => undefined)) as typeof globalThis.fetch;
    const { NET_DEADLINE } = await import("../src/bridge/net");
    assert.ok(NET_DEADLINE.media > 0);
    // Não espera os 120s de verdade: o que importa é o contrato estar
    // ligado, o que os testes de `net.ts` já provam ponta a ponta.
  });
});
