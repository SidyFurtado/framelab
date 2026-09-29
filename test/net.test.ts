/**
 * O prazo de toda requisição do plugin.
 *
 * O caso que este arquivo existe para travar: um `fetch` sem prazo.
 * `fetch` não tem um por padrão, e uma conexão que ABRE e não responde
 * — CDN engasgado, portal cativo, GitHub bloqueado — pendurava a
 * operação para sempre. As bandeiras de cancelamento das ferramentas só
 * são lidas ENTRE requisições, então nem o botão de cancelar salvava: a
 * única saída era recarregar o painel.
 *
 * O `fetch` global é trocado por um dublê em cada teste. Nada aqui toca
 * a rede.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  fetchWithTimeout,
  isNetCancelled,
  isNetTimeout,
  NET_DEADLINE,
  NetCancelled,
  NetTimeout,
} from "../src/bridge/net";

type FetchFn = typeof globalThis.fetch;
const realFetch = globalThis.fetch;
const realAbortController = globalThis.AbortController;

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.AbortController = realAbortController;
});

/** Um dublê que anota o que recebeu. */
function spyFetch(behaviour: (signal?: AbortSignal) => Promise<unknown>): {
  calls: number;
  signal(): AbortSignal | undefined;
} {
  const state = { calls: 0, seen: undefined as AbortSignal | undefined };
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    state.calls += 1;
    state.seen = init?.signal ?? undefined;
    return behaviour(state.seen);
  }) as FetchFn;
  return {
    get calls() {
      return state.calls;
    },
    signal: () => state.seen,
  };
}

/** Uma resposta de mentira, só com o que o helper devolve. */
function reply(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

const never = (): Promise<never> => new Promise(() => undefined);
const soon = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("fetchWithTimeout · o caminho normal", () => {
  it("resposta antes do prazo volta intacta", async () => {
    spyFetch(async () => reply(200));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
  });

  it("erro HTTP NÃO lança: chega ao consumidor como sempre", async () => {
    // É assim que os quatro módulos decidem o que fazer com 404 e 429.
    spyFetch(async () => reply(404));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    assert.equal(response.ok, false);
    assert.equal(response.status, 404);
  });

  it("erro de rede sobe como sempre subiu, sem virar prazo", async () => {
    spyFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 1000),
      (cause: unknown) => {
        assert.ok(!isNetTimeout(cause), "erro de rede virou prazo vencido");
        assert.ok(!isNetCancelled(cause));
        assert.match(String((cause as Error).message), /Failed to fetch/);
        return true;
      }
    );
  });

  it("método, cabeçalhos e corpo passam adiante", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(reply());
    }) as FetchFn;

    await fetchWithTimeout(
      "https://x/y",
      { method: "POST", headers: { Accept: "application/json" }, body: "oi" },
      1000
    );
    assert.equal(seen?.method, "POST");
    assert.deepEqual(seen?.headers, { Accept: "application/json" });
    assert.equal(seen?.body, "oi");
  });
});

describe("fetchWithTimeout · o prazo", () => {
  it("vence, aborta a requisição e rejeita", async () => {
    const spy = spyFetch(never);
    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 40),
      (cause: unknown) => {
        assert.ok(cause instanceof NetTimeout);
        assert.ok(isNetTimeout(cause));
        return true;
      }
    );
    // A requisição real foi abortada — na build que honrar o sinal.
    assert.equal(spy.signal()?.aborted, true);
  });

  it("o erro diz quanto tempo esperou", () => {
    // Direto no erro: esperar o relógio de verdade custaria segundos de
    // suíte para provar uma frase.
    assert.match(new NetTimeout(3000).message, /não respondeu em 3s/);
    assert.match(new NetTimeout(NET_DEADLINE.media).message, /em 120s/);
    assert.equal(new NetTimeout(3000).ms, 3000);
  });

  it("um AbortError do próprio fetch ainda é reportado como prazo", async () => {
    // Na build que honra o sinal, quem rejeita primeiro é o fetch, com
    // uma causa genérica que não diz se foi prazo ou desistência.
    spyFetch(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 30),
      (cause: unknown) => isNetTimeout(cause)
    );
  });
});

describe("fetchWithTimeout · o cancelamento externo", () => {
  it("aborta a requisição e rejeita como desistência, não como prazo", async () => {
    const outside = new AbortController();
    const spy = spyFetch(never);
    const pending = fetchWithTimeout("https://x/y", undefined, 5000, outside.signal);
    await soon(10);
    outside.abort();

    await assert.rejects(pending, (cause: unknown) => {
      assert.ok(cause instanceof NetCancelled);
      assert.ok(isNetCancelled(cause));
      // A distinção é o ponto: desistir não é a rede falhar.
      assert.ok(!isNetTimeout(cause), "cancelamento virou prazo vencido");
      return true;
    });
    assert.equal(spy.signal()?.aborted, true);
  });

  it("um sinal JÁ abortado não abre conexão nenhuma", async () => {
    const spy = spyFetch(async () => reply());
    const outside = new AbortController();
    outside.abort();

    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 1000, outside.signal),
      (cause: unknown) => isNetCancelled(cause)
    );
    assert.equal(spy.calls, 0, "abriu conexão mesmo já cancelado");
  });

  it("prazo e cancelamento externo convivem: quem chega primeiro decide", async () => {
    const outside = new AbortController();
    spyFetch(never);
    // O prazo é curto e ninguém cancela: tem de sair prazo.
    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 30, outside.signal),
      (cause: unknown) => isNetTimeout(cause) && !isNetCancelled(cause)
    );
  });
});

describe("fetchWithTimeout · limpeza em toda saída", () => {
  it("o temporizador sai depois do sucesso", async () => {
    const spy = spyFetch(async () => reply());
    await fetchWithTimeout("https://x/y", undefined, 30);
    // Passado o prazo, nada foi abortado: o temporizador não ficou de pé.
    await soon(60);
    assert.equal(spy.signal()?.aborted, false);
  });

  it("o temporizador sai depois do erro de rede", async () => {
    const spy = spyFetch(async () => {
      throw new Error("caiu");
    });
    await assert.rejects(() => fetchWithTimeout("https://x/y", undefined, 30));
    await soon(60);
    assert.equal(spy.signal()?.aborted, false);
  });

  it("o ouvinte do sinal externo sai com a chamada", async () => {
    const outside = new AbortController();
    const spy = spyFetch(async () => reply());
    await fetchWithTimeout("https://x/y", undefined, 1000, outside.signal);

    // Abortar DEPOIS não pode mais alcançar a requisição que terminou.
    outside.abort();
    assert.equal(spy.signal()?.aborted, false, "o ouvinte sobreviveu à chamada");
  });

  it("a corrida resolve UMA vez só", async () => {
    // Resposta e prazo praticamente juntos.
    let settlements = 0;
    spyFetch(async () => {
      await soon(30);
      return reply();
    });
    const pending = fetchWithTimeout("https://x/y", undefined, 30).then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      }
    );
    await pending;
    await soon(60);
    assert.equal(settlements, 1);
  });
});

describe("fetchWithTimeout · sem AbortController no runtime", () => {
  it("ainda devolve o controle no prazo, sem passar signal", async () => {
    // A tipagem do `fetch` do UXP não declara `signal`. Se a build não
    // tiver o controlador, a corrida é a única defesa — e a requisição
    // subjacente pode continuar viva, o que está documentado no helper.
    // @ts-expect-error — apagando o global de propósito
    delete globalThis.AbortController;
    const spy = spyFetch(never);

    await assert.rejects(
      () => fetchWithTimeout("https://x/y", undefined, 30),
      (cause: unknown) => isNetTimeout(cause)
    );
    assert.equal(spy.signal(), undefined, "passou signal sem controlador");
  });

  it("o caminho de sucesso continua igual sem controlador", async () => {
    // @ts-expect-error — apagando o global de propósito
    delete globalThis.AbortController;
    spyFetch(async () => reply(200));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    assert.equal(response.status, 200);
  });
});

describe("NET_DEADLINE · prazos nomeados e folgados", () => {
  it("cada categoria tem o seu, e nenhuma é agressiva", () => {
    for (const [nome, ms] of Object.entries(NET_DEADLINE)) {
      assert.ok(ms >= 20_000, `${nome} é curto demais para uma rede lenta`);
      assert.ok(ms <= 120_000, `${nome} é longo demais para ser um prazo`);
    }
    // Bytes têm mais folga que um JSON de manifesto.
    assert.ok(NET_DEADLINE.media > NET_DEADLINE.manifest);
  });
});

// ── a adoção, um por categoria de consumidor ───────────────────────

describe("os quatro módulos passaram a ter prazo", () => {
  it("manifesto/update · PluginUpdater.checkForUpdates", async () => {
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "9.9.9", downloadUrl: "", changelog: "", releaseDate: "" }),
    }));
    const { PluginUpdater } = await import("../src/shell/updater");
    const result = await new PluginUpdater("0.0.1").checkForUpdates();

    assert.equal(result.hasUpdate, true);
    assert.ok(spy.signal(), "a consulta do manifesto saiu sem prazo");
  });

  it("tradução · translate", async () => {
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(["hello"]),
    }));
    const { translate } = await import("../src/tools/translate/engine");
    const out = await translate(["oi"], { from: "pt", to: "en" });

    assert.equal(out.ok, true);
    assert.deepEqual(out.texts, ["hello"]);
    assert.ok(spy.signal(), "a tradução saiu sem prazo");
  });

  it("download de arquivo · fetchAllBytes", async () => {
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      // O tamanho declarado é o que deixa o teto de memória aceitar a
      // resposta sem lê-la às cegas — ver o P2-10.
      headers: { get: (nome: string) => (nome === "content-length" ? "3" : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const { fetchAllBytes } = await import("../src/tools/download/panelFetch");
    const bytes = await fetchAllBytes("https://cdn/v.mp4");

    assert.equal(bytes.byteLength, 3);
    assert.ok(spy.signal(), "o download no painel saiu sem prazo");
  });

  it("metadata/API · downloadSound do Drive", async () => {
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "audio/wav" : "128") },
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    }));
    const { downloadSound } = await import("../src/tools/sfx/drive");
    const data = await downloadSound("abc");

    assert.equal(data.byteLength, 1);
    assert.ok(spy.signal(), "o download do Drive saiu sem prazo");
  });
});

// ── o corpo, que era a metade descoberta ───────────────────────────

describe("fetchWithTimeout · o prazo cobre a leitura do corpo", () => {
  /** Cabeçalho chega na hora; o corpo nunca vem. */
  function headersThenSilence(reader: "json" | "text" | "arrayBuffer"): {
    signal(): AbortSignal | undefined;
  } {
    return spyFetch(async () => ({
      ok: true,
      status: 200,
      [reader]: () => never(),
    }));
  }

  it("headers chegam e .json() nunca resolve → prazo vence", async () => {
    const spy = headersThenSilence("json");
    const response = await fetchWithTimeout("https://x/y", undefined, 40);
    await assert.rejects(
      () => response.json(),
      (cause: unknown) => isNetTimeout(cause) && !isNetCancelled(cause)
    );
    // O MESMO controlador do fetch: abortar aqui alcança o corpo.
    assert.equal(spy.signal()?.aborted, true);
  });

  it("headers chegam e .text() nunca resolve → prazo vence", async () => {
    headersThenSilence("text");
    const response = await fetchWithTimeout("https://x/y", undefined, 40);
    await assert.rejects(
      () => response.text(),
      (cause: unknown) => isNetTimeout(cause)
    );
  });

  it("headers chegam e .arrayBuffer() nunca resolve → prazo vence", async () => {
    headersThenSilence("arrayBuffer");
    const response = await fetchWithTimeout("https://x/y", undefined, 40);
    await assert.rejects(
      () => response.arrayBuffer(),
      (cause: unknown) => isNetTimeout(cause)
    );
  });

  it("cancelamento externo interrompe DURANTE a leitura do corpo", async () => {
    const outside = new AbortController();
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: () => never(),
    }));
    const response = await fetchWithTimeout(
      "https://x/y",
      undefined,
      5000,
      outside.signal
    );
    const reading = response.arrayBuffer();
    await soon(10);
    outside.abort();

    await assert.rejects(reading, (cause: unknown) => {
      assert.ok(isNetCancelled(cause));
      assert.ok(!isNetTimeout(cause), "desistir virou prazo vencido");
      return true;
    });
    assert.equal(spy.signal()?.aborted, true);
  });

  it("resposta e corpo completos antes do prazo: sucesso", async () => {
    spyFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "1.2.3" }),
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    assert.deepEqual(await response.json(), { version: "1.2.3" });
  });

  it("JSON inválido continua sendo erro de parsing, não prazo", async () => {
    spyFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    await assert.rejects(
      () => response.json(),
      (cause: unknown) => {
        assert.ok(cause instanceof SyntaxError);
        assert.ok(!isNetTimeout(cause), "erro de parsing virou prazo");
        assert.ok(!isNetCancelled(cause));
        return true;
      }
    );
  });

  it("erro real na leitura do corpo é preservado", async () => {
    spyFetch(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new TypeError("network error while reading body");
      },
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    await assert.rejects(() => response.arrayBuffer(), (cause: unknown) => {
      assert.ok(cause instanceof TypeError);
      assert.match((cause as Error).message, /while reading body/);
      assert.ok(!isNetTimeout(cause));
      return true;
    });
  });

  it("a corrida entre prazo e corpo resolve UMA vez só", async () => {
    let settlements = 0;
    spyFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => {
        await soon(30);
        return "pronto";
      },
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 30);
    await response.text().then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      }
    );
    await soon(60);
    assert.equal(settlements, 1);
  });

  it("o temporizador não fica de pé depois de o corpo terminar", async () => {
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "pronto",
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 40);
    assert.equal(await response.text(), "pronto");
    await soon(70);
    assert.equal(spy.signal()?.aborted, false, "o prazo do corpo sobreviveu a ele");
  });

  it("o ouvinte externo não fica de pé depois de o corpo terminar", async () => {
    const outside = new AbortController();
    const spy = spyFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "pronto",
    }));
    const response = await fetchWithTimeout(
      "https://x/y",
      undefined,
      1000,
      outside.signal
    );
    await response.text();

    outside.abort();
    assert.equal(spy.signal()?.aborted, false, "o ouvinte sobreviveu à leitura");
  });

  it("o prazo NÃO é duplicado entre cabeçalho e corpo", async () => {
    // O cabeçalho come quase tudo; ao corpo sobra o resto, não um prazo
    // novo. Sem o relógio único, esta operação levaria ~160 ms em vez
    // de ~100 ms.
    spyFetch(async () => {
      await soon(80);
      return { ok: true, status: 200, text: () => never() };
    });
    const começou = Date.now();
    const response = await fetchWithTimeout("https://x/y", undefined, 100);
    await assert.rejects(() => response.text(), (cause: unknown) => isNetTimeout(cause));
    const gasto = Date.now() - começou;

    assert.ok(gasto < 160, `a operação levou ${gasto}ms: o prazo foi duplicado`);
    assert.ok(gasto >= 90, `a operação levou ${gasto}ms: o corpo não usou o que sobrava`);
  });

  it("cabeçalho que consome o prazo inteiro não dá corpo de graça", async () => {
    spyFetch(async () => {
      await soon(60);
      return { ok: true, status: 200, text: async () => "tarde demais" };
    });
    const response = await fetchWithTimeout("https://x/y", undefined, 50).catch(
      () => null
    );
    // O próprio fetch já estoura aqui; o que importa é não ficar preso.
    assert.equal(response, null);
  });

  it("o resto da Response passa igual: ok, status e headers", async () => {
    spyFetch(async () => ({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? "30" : null) },
      text: async () => "devagar",
    }));
    const response = await fetchWithTimeout("https://x/y", undefined, 1000);
    assert.equal(response.ok, false);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(await response.text(), "devagar");
  });
});
