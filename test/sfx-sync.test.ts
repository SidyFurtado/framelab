/**
 * Parar o download do pack, de verdade.
 *
 * O caso que este arquivo existe para travar: cancelar era
 * `job.cancelled = true`, e a bandeira só era lida no TOPO de cada volta
 * do worker. Com um download esperando a rede, o worker ficava parado
 * dentro do `await` e `job.running` continuava `true` — e `running` é a
 * guarda de tudo: baixar o pack, baixar uma categoria, a prévia. O
 * editor clicava em parar, a tela seguia dizendo que baixava, e nada
 * novo começava até recarregar o painel.
 *
 * O que se prova aqui é a máquina de estados do job. `sfxTool.ts` é DOM
 * e host; `createSyncJob`, `stopSyncJob` e `drainSync` são puros.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimSync,
  createSyncJob,
  drainSync,
  stopSyncJob,
  type SyncJob,
} from "../src/tools/sfx/syncJob";
import { NetCancelled, NetTimeout } from "../src/bridge/net";

const soon = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const never = (): Promise<never> => new Promise(() => undefined);

/** Uma fila de nomes e um registro do que cada worker pegou. */
function fila(items: string[]): { next: () => string | undefined; taken: string[] } {
  const queue = [...items];
  const taken: string[] = [];
  return {
    next: () => {
      const item = queue.shift();
      if (item !== undefined) taken.push(item);
      return item;
    },
    taken,
  };
}

describe("stopSyncJob · largar a guarda na hora", () => {
  it("cancelar solta `running` sem esperar a rede", () => {
    const job = createSyncJob(10);
    assert.equal(job.running, true);

    assert.equal(stopSyncJob(job), true);

    // É o ponto do defeito: a ferramenta volta a aceitar trabalho já.
    assert.equal(job.running, false);
    assert.equal(job.cancelled, true);
  });

  it("aborta o sinal desta execução", () => {
    const job = createSyncJob(3);
    assert.equal(job.control?.signal.aborted, false);
    stopSyncJob(job);
    assert.equal(job.control?.signal.aborted, true);
  });

  it("cancelar duas vezes é seguro e não redesenha à toa", () => {
    const job = createSyncJob(3);
    assert.equal(stopSyncJob(job), true);
    assert.equal(stopSyncJob(job), false, "o segundo cancelamento reagiu");
    assert.equal(job.running, false);
  });

  it("cancelar um job já terminado não tem efeito", () => {
    const job = createSyncJob(1);
    job.running = false;
    assert.equal(stopSyncJob(job), false);
    assert.equal(job.cancelled, false, "marcou como cancelado um job concluído");
  });

  it("cancelar nada é seguro", () => {
    assert.equal(stopSyncJob(null), false);
  });
});

describe("drainSync · os workers param", () => {
  it("cancelamento ANTES do primeiro download: nada é baixado", async () => {
    const job = createSyncJob(5);
    const queue = fila(["a", "b", "c", "d", "e"]);
    stopSyncJob(job);

    await drainSync(job, {
      workers: 3,
      next: queue.next,
      current: () => true,
      tick: () => undefined,
      run: async () => {
        throw new Error("não devia ter baixado nada");
      },
    });

    assert.deepEqual(queue.taken, []);
    assert.equal(job.done, 0);
  });

  it("cancelamento COM download em voo: o worker não pega o próximo", async () => {
    const job = createSyncJob(4);
    const queue = fila(["a", "b", "c", "d"]);
    let started = 0;

    const draining = drainSync(job, {
      workers: 1,
      next: queue.next,
      current: () => true,
      tick: () => undefined,
      run: async (_item, signal) => {
        started += 1;
        // Só termina quando o sinal desta execução abortar.
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        throw new NetCancelled();
      },
    });

    await soon(10);
    assert.equal(started, 1);
    stopSyncJob(job);
    await draining;

    assert.deepEqual(queue.taken, ["a"], "pegou trabalho novo depois de parar");
    assert.equal(job.done, 0, "contou um item cancelado como feito");
  });

  it("o AbortSignal do job chega a quem baixa", async () => {
    const job = createSyncJob(1);
    let seen: AbortSignal | undefined;
    await drainSync(job, {
      workers: 1,
      next: fila(["a"]).next,
      current: () => true,
      tick: () => undefined,
      run: async (_item, signal) => {
        seen = signal;
      },
    });
    assert.ok(seen, "o worker não recebeu sinal nenhum");
    assert.equal(seen, job.control?.signal);
  });

  it("vários workers param no mesmo cancelamento", async () => {
    const job = createSyncJob(60);
    const queue = fila(Array.from({ length: 60 }, (_, at) => `s${at}`));

    const draining = drainSync(job, {
      workers: 3,
      next: queue.next,
      current: () => true,
      tick: () => undefined,
      run: async (_item, signal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve());
        });
        throw new NetCancelled();
      },
    });

    await soon(10);
    assert.equal(queue.taken.length, 3, "os três workers não pegaram um item cada");
    stopSyncJob(job);
    await draining;

    assert.equal(queue.taken.length, 3, "algum worker seguiu depois de parar");
    assert.equal(job.running, false);
  });

  it("dá para começar outro sync logo depois, sem recarregar", async () => {
    const primeiro = createSyncJob(10);
    stopSyncJob(primeiro);
    assert.equal(primeiro.running, false);

    // A guarda da ferramenta é `running`: livre, o próximo começa.
    const segundo = createSyncJob(2);
    const queue = fila(["a", "b"]);
    await drainSync(segundo, {
      workers: 2,
      next: queue.next,
      current: () => true,
      tick: () => undefined,
      run: async () => undefined,
    });
    assert.equal(segundo.done, 2);
    assert.equal(segundo.running, false);
  });
});

describe("drainSync · um job antigo não contamina o novo", () => {
  /** A ferramenta: qual job está na tela agora. */
  function bancada(): {
    current: SyncJob | null;
    ticks: number;
    opts(job: SyncJob, queue: () => string | undefined): Parameters<typeof drainSync>[1];
  } {
    const state = { current: null as SyncJob | null, ticks: 0 };
    return {
      get current() {
        return state.current;
      },
      set current(job: SyncJob | null) {
        state.current = job;
      },
      get ticks() {
        return state.ticks;
      },
      opts: (job, queue) => ({
        workers: 1,
        next: queue,
        current: () => state.current === job,
        tick: () => {
          state.ticks += 1;
        },
        run: async () => undefined,
      }),
    };
  }

  it("A cancelado e B começado: o `finally` tardio de A não derruba B", async () => {
    const bench = bancada();
    const a = createSyncJob(3);
    bench.current = a;

    let libera = (): void => undefined;
    const presa = new Promise<void>((resolve) => {
      libera = resolve;
    });
    const queueA = fila(["a1", "a2", "a3"]);
    const drenandoA = drainSync(a, {
      workers: 1,
      next: queueA.next,
      current: () => bench.current === a,
      tick: () => undefined,
      run: async () => presa,
    });

    await soon(10);
    stopSyncJob(a);

    // B entra no lugar enquanto o worker de A ainda está preso.
    const b = createSyncJob(2);
    bench.current = b;

    libera();
    await drenandoA;

    // O encerramento tardio de A não pode baixar a guarda de B.
    assert.equal(b.running, true, "o job antigo derrubou a guarda do novo");
    assert.equal(bench.current, b, "o job antigo trocou o job corrente");
  });

  it("o progresso tardio de A não redesenha a tela de B", async () => {
    const bench = bancada();
    const a = createSyncJob(2);
    bench.current = a;

    let marcasDeA = 0;
    let libera = (): void => undefined;
    const presa = new Promise<void>((resolve) => {
      libera = resolve;
    });
    const drenandoA = drainSync(a, {
      workers: 1,
      next: fila(["a1", "a2"]).next,
      current: () => bench.current === a,
      tick: () => {
        marcasDeA += 1;
      },
      run: async () => presa,
    });

    await soon(10);
    stopSyncJob(a);
    bench.current = createSyncJob(1);

    libera();
    await drenandoA;

    assert.equal(marcasDeA, 0, "o job antigo redesenhou por cima do novo");
  });

  it("o resultado tardio de A não mexe nos contadores de B", async () => {
    const bench = bancada();
    const a = createSyncJob(2);
    bench.current = a;

    let libera = (): void => undefined;
    const presa = new Promise<void>((resolve) => {
      libera = resolve;
    });
    const drenandoA = drainSync(a, {
      workers: 1,
      next: fila(["a1", "a2"]).next,
      current: () => bench.current === a,
      tick: () => undefined,
      run: async () => {
        await presa;
        a.bytes += 999;
      },
    });

    await soon(10);
    stopSyncJob(a);
    const b = createSyncJob(5);
    bench.current = b;

    libera();
    await drenandoA;

    // Cada job tem o seu objeto: A mexe em A, e só.
    assert.equal(b.bytes, 0);
    assert.equal(b.done, 0);
    assert.equal(b.failed, 0);
  });

  it("um worker de A para assim que B vira o corrente, mesmo sem cancelar", async () => {
    const bench = bancada();
    const a = createSyncJob(5);
    bench.current = a;
    const queueA = fila(["a1", "a2", "a3", "a4", "a5"]);

    const drenandoA = drainSync(a, {
      workers: 1,
      next: queueA.next,
      current: () => bench.current === a,
      tick: () => undefined,
      run: async () => {
        // Na primeira entrega, outro sync toma a ferramenta.
        bench.current = createSyncJob(1);
      },
    });
    await drenandoA;

    assert.equal(queueA.taken.length, 1, "seguiu baixando para um job que saiu de cena");
  });
});

describe("drainSync · cancelamento não é erro", () => {
  it("NetCancelled não conta como falha nem vira mensagem de erro", async () => {
    const job = createSyncJob(2);
    await drainSync(job, {
      workers: 1,
      next: fila(["a"]).next,
      current: () => true,
      tick: () => undefined,
      run: async () => {
        throw new NetCancelled();
      },
    });
    assert.equal(job.failed, 0, "a desistência entrou na contagem de erros");
    assert.equal(job.lastError, null, "a desistência virou mensagem de erro");
    assert.equal(job.done, 0);
  });

  it("prazo vencido CONTINUA sendo erro, e não cancelamento", async () => {
    const job = createSyncJob(1);
    await drainSync(job, {
      workers: 1,
      next: fila(["a"]).next,
      current: () => true,
      tick: () => undefined,
      run: async () => {
        throw new NetTimeout(120000);
      },
    });
    assert.equal(job.failed, 1);
    assert.match(job.lastError ?? "", /não respondeu em 120s/);
    assert.equal(job.done, 1);
  });

  it("erro de verdade continua contando como sempre contou", async () => {
    const job = createSyncJob(2);
    await drainSync(job, {
      workers: 1,
      next: fila(["a", "b"]).next,
      current: () => true,
      tick: () => undefined,
      run: async (item) => {
        if (item === "a") throw new Error("o Drive respondeu 500");
      },
    });
    assert.equal(job.failed, 1);
    assert.equal(job.lastError, "o Drive respondeu 500");
    assert.equal(job.done, 2, "o item que falhou não entrou no total feito");
  });

  it("uma falha depois do cancelamento não vira erro na tela", async () => {
    // O item já estava em voo quando o editor desistiu: a exceção que
    // chega depois é consequência do aborto, não uma falha de rede.
    const job = createSyncJob(1);
    await drainSync(job, {
      workers: 1,
      next: fila(["a"]).next,
      current: () => true,
      tick: () => undefined,
      run: async () => {
        stopSyncJob(job);
        throw new Error("socket fechado no meio");
      },
    });
    assert.equal(job.failed, 0);
    assert.equal(job.lastError, null);
  });
});

describe("drainSync · o sucesso normal não mudou", () => {
  it("drena a fila inteira, conta e encerra", async () => {
    const job = createSyncJob(4);
    const queue = fila(["a", "b", "c", "d"]);
    let ticks = 0;

    await drainSync(job, {
      workers: 3,
      next: queue.next,
      current: () => true,
      tick: () => {
        ticks += 1;
      },
      run: async () => {
        job.bytes += 10;
      },
    });

    assert.deepEqual(queue.taken.sort(), ["a", "b", "c", "d"]);
    assert.equal(job.done, 4);
    assert.equal(job.failed, 0);
    assert.equal(job.bytes, 40);
    assert.equal(job.running, false, "não encerrou a guarda no fim normal");
    // Um redesenho por item, mais o do encerramento.
    assert.equal(ticks, 5);
  });

  it("fila vazia encerra na hora", async () => {
    const job = createSyncJob(0);
    await drainSync(job, {
      workers: 3,
      next: () => undefined,
      current: () => true,
      tick: () => undefined,
      run: async () => undefined,
    });
    assert.equal(job.running, false);
    assert.equal(job.done, 0);
  });

  it("uma requisição que nunca responde não prende o cancelamento", async () => {
    const job = createSyncJob(1);
    const draining = drainSync(job, {
      workers: 1,
      next: fila(["a"]).next,
      current: () => true,
      tick: () => undefined,
      run: async (_item, signal) => {
        // O runtime que IGNORA o signal: a promessa nunca resolve.
        await Promise.race([
          never(),
          new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve())
          ),
        ]);
      },
    });

    await soon(10);
    stopSyncJob(job);
    // A guarda já caiu, mesmo com o soquete imaginário ainda aberto.
    assert.equal(job.running, false);
    await draining;
  });
});

// ── a vez, adquirida no ponto central ──────────────────────────────

describe("claimSync · dois syncs nunca começam juntos", () => {
  /** A ferramenta: a variável `sync` do módulo, aqui em miniatura. */
  function ferramenta(): { atual: SyncJob | null; hold: (job: SyncJob) => void } {
    const state = { atual: null as SyncJob | null };
    return {
      get atual() {
        return state.atual;
      },
      set atual(job: SyncJob | null) {
        state.atual = job;
      },
      hold: (job: SyncJob) => {
        state.atual = job;
      },
    };
  }

  it("o primeiro adquire a vez e vira o corrente", () => {
    const f = ferramenta();
    const job = claimSync(f.atual, f.hold);

    assert.ok(job, "o primeiro sync não conseguiu começar");
    assert.equal(f.atual, job);
    assert.equal(job.running, true);
  });

  it("o segundo, com o primeiro de pé, NÃO começa", () => {
    const f = ferramenta();
    const primeiro = claimSync(f.atual, f.hold);
    const segundo = claimSync(f.atual, f.hold);

    assert.equal(segundo, null, "dois syncs começaram juntos");
    assert.equal(f.atual, primeiro, "a tentativa recusada trocou o job corrente");
  });

  it("duas tentativas no mesmo tick: só uma passa", () => {
    // Sem `await` entre a pergunta e a posse, não há janela nenhuma.
    const f = ferramenta();
    const tentativas = [1, 2, 3, 4, 5].map(() => claimSync(f.atual, f.hold));
    const vencedores = tentativas.filter((job) => job !== null);

    assert.equal(vencedores.length, 1);
    assert.equal(f.atual, vencedores[0]);
  });

  it("a tentativa recusada não cria job nem AbortController inútil", () => {
    const f = ferramenta();
    const primeiro = claimSync(f.atual, f.hold);
    const recusado = claimSync(f.atual, f.hold);

    assert.equal(recusado, null);
    // O sinal do primeiro segue intacto: ninguém criou nem abortou nada.
    assert.equal(primeiro?.control?.signal.aborted, false);
  });

  it("o fluxo que voltou de um `await` longo não inicia um segundo sync", () => {
    /*
     * É o caso do defeito, encenado: A passa na guarda de fora, entra no
     * seletor de pasta, B começa um sync nesse meio-tempo, e A volta.
     */
    const f = ferramenta();
    const guardaExternaDeA = f.atual?.running !== true; // A pergunta e passa
    assert.equal(guardaExternaDeA, true);

    // …editor no diálogo nativo… e B começa.
    const b = claimSync(f.atual, f.hold);
    assert.ok(b);

    // A volta do `await` e tenta: o ponto central recusa.
    const a = claimSync(f.atual, f.hold);
    assert.equal(a, null, "o fluxo que voltou do diálogo iniciou um segundo sync");
    assert.equal(f.atual, b, "o job de B foi substituído pelo de A");
  });

  it("o término normal libera a vez", async () => {
    const f = ferramenta();
    const primeiro = claimSync(f.atual, f.hold);
    assert.ok(primeiro);

    await drainSync(primeiro, {
      workers: 1,
      next: () => undefined,
      current: () => f.atual === primeiro,
      tick: () => undefined,
      run: async () => undefined,
    });

    assert.equal(primeiro.running, false);
    assert.ok(claimSync(f.atual, f.hold), "a vez não foi liberada no fim normal");
  });

  it("depois de cancelar, o próximo começa na hora", () => {
    const f = ferramenta();
    const a = claimSync(f.atual, f.hold);
    stopSyncJob(a);

    const b = claimSync(f.atual, f.hold);
    assert.ok(b, "cancelar não liberou a vez");
    assert.notEqual(b, a);
    assert.equal(f.atual, b);
  });

  it("worker antigo ainda drenando não bloqueia o sync novo", async () => {
    // P2-13 preservado: `running` cai no cancelamento, e não no fim dos
    // workers — é o que devolve a ferramenta sem esperar conexão morta.
    const f = ferramenta();
    const a = claimSync(f.atual, f.hold);
    assert.ok(a);

    let libera = (): void => undefined;
    const presa = new Promise<void>((resolve) => {
      libera = resolve;
    });
    const drenandoA = drainSync(a, {
      workers: 1,
      next: () => "item",
      current: () => f.atual === a,
      tick: () => undefined,
      run: async () => presa,
    });

    await soon(10);
    stopSyncJob(a);

    const b = claimSync(f.atual, f.hold);
    assert.ok(b, "o worker preso de A impediu B de começar");

    libera();
    await drenandoA;

    // E o fim tardio de A não derruba a vez de B.
    assert.equal(b.running, true);
    assert.equal(f.atual, b);
  });

  it("um job já terminado não segura a vez", () => {
    const f = ferramenta();
    const a = claimSync(f.atual, f.hold);
    assert.ok(a);
    a.running = false; // término, por qualquer caminho

    assert.ok(claimSync(f.atual, f.hold));
  });

  it("sem nenhum sync antes, a vez está livre", () => {
    const f = ferramenta();
    assert.ok(claimSync(null, f.hold));
  });
});
