/**
 * O estado de um download do pack, e como pará-lo de verdade.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * Cancelar era `job.cancelled = true`, e a bandeira só era lida no
 * TOPO de cada volta do worker. Com um `downloadSound` esperando a
 * rede, o worker ficava parado dentro do `await` e `job.running`
 * continuava `true` — e `running` é a guarda de tudo: baixar o pack,
 * baixar uma categoria, a prévia. O editor clicava em parar, a tela
 * seguia dizendo que baixava, e nada novo começava até recarregar o
 * painel.
 *
 * Agora o cancelamento faz três coisas de uma vez: marca, **larga a
 * guarda na hora** e aborta a requisição em voo pelo `AbortController`
 * do próprio job.
 *
 * ── O runtime pode ignorar o aborto ───────────────────────────────
 * A tipagem do `fetch` do UXP não declara `signal` (ver `bridge/net.ts`).
 * Se esta build o ignorar, o soquete continua vivo lá embaixo — mas o
 * `fetchWithTimeout` libera a promessa de qualquer jeito, e o estado
 * lógico daqui não depende do soquete ter fechado. Um resultado que
 * chegue atrasado cai num job que já não é o corrente, e um job que não
 * é o corrente não mexe em nada.
 *
 * ── Por que mora fora do sfxTool ──────────────────────────────────
 * Para poder ser provado. `sfxTool.ts` é DOM e host; aqui só está a
 * máquina de estados, que é onde o defeito morava.
 */
import { isNetCancelled } from "../../bridge/net";

export interface SyncJob {
  total: number;
  done: number;
  failed: number;
  empty: number;
  bytes: number;
  lastError: string | null;
  running: boolean;
  cancelled: boolean;
  /** O aborto desta execução. `null` na build sem `AbortController`. */
  readonly control: AbortController | null;
}

export function createSyncJob(total: number): SyncJob {
  return {
    total,
    done: 0,
    failed: 0,
    empty: 0,
    bytes: 0,
    lastError: null,
    running: true,
    cancelled: false,
    control: makeController(),
  };
}

function makeController(): AbortController | null {
  try {
    return typeof AbortController === "function" ? new AbortController() : null;
  } catch {
    return null;
  }
}

/**
 * Reserva a vez para um sync novo. Síncrono de propósito.
 *
 * ── Por que a guarda mora aqui ────────────────────────────────────
 * `downloadCategory` perguntava `sync?.running` e só depois abria o
 * seletor nativo de pasta — um `await` que dura o tempo que o editor
 * quiser. Nesse intervalo outra ação podia começar um sync, e o
 * primeiro fluxo voltava do diálogo e chamava `runSync` sem perguntar
 * de novo: dois jobs vivos, o segundo substituindo `sync`, os workers
 * do primeiro ainda baixando, e o dobro de pedidos ao Drive.
 *
 * Guardar na entrada do `runSync` não bastaria se a pergunta e a posse
 * ficassem separadas por qualquer coisa que ceda o controle. Aqui as
 * duas acontecem DENTRO da mesma função síncrona — entre o `if` e o
 * `hold` não existe ponto de suspensão, então dois chamadores que
 * cheguem quase juntos não passam os dois.
 *
 * Uma tentativa recusada não cria job nem `AbortController`, e não
 * encosta em `sync`.
 *
 * `hold` é o que grava o job como o corrente — a variável vive no
 * módulo da ferramenta, e passá-la assim é o que mantém a aquisição
 * indivisível sem trazer a variável para cá.
 */
export function claimSync(
  current: SyncJob | null,
  hold: (job: SyncJob) => void
): SyncJob | null {
  if (current?.running) {
    return null;
  }
  const job = createSyncJob(0);
  hold(job);
  return job;
}

/**
 * Para o job: marca, larga a guarda e aborta o que estiver em voo.
 *
 * Idempotente, e inofensivo num job que já terminou — devolve `true`
 * só quando havia mesmo algo de pé para parar, que é o que permite a
 * quem chama decidir se precisa redesenhar.
 *
 * `running` cai AQUI, e não quando os workers drenarem: é o que devolve
 * a ferramenta ao editor sem esperar uma conexão morta.
 */
export function stopSyncJob(job: SyncJob | null): boolean {
  if (!job || !job.running) {
    return false;
  }
  job.cancelled = true;
  job.running = false;
  try {
    job.control?.abort();
  } catch (cause) {
    // Abortar não pode ser o que impede de parar.
    console.warn("[Efeitos] o aborto do download não foi aceito:", cause);
  }
  return true;
}

export interface DrainOptions<T> {
  /** Quantos em paralelo. O Drive corta quem pede demais. */
  readonly workers: number;
  /** O próximo da fila, ou `undefined` quando acabou. */
  next(): T | undefined;
  /** false quando este job já não é o que a ferramenta mostra. */
  current(): boolean;
  /** O trabalho de um item. Recebe o sinal desta execução. */
  run(item: T, signal: AbortSignal | undefined): Promise<void>;
  /** Redesenha. Só é chamado enquanto o job for o corrente. */
  tick(): void;
}

/**
 * Drena a fila com N workers, parando de verdade quando pedido.
 *
 * Cada volta pergunta duas coisas antes de pegar trabalho: se o job foi
 * cancelado, e se ele ainda é o corrente. A segunda é o que impede um
 * worker de um job antigo de continuar baixando — e de tocar na tela —
 * depois que outro já começou.
 */
export async function drainSync<T>(job: SyncJob, options: DrainOptions<T>): Promise<void> {
  const worker = async (): Promise<void> => {
    for (;;) {
      if (job.cancelled || !options.current()) {
        return;
      }
      const item = options.next();
      if (item === undefined) {
        return;
      }
      try {
        await options.run(item, job.control?.signal);
      } catch (cause) {
        /*
         * Desistência do editor não é falha de rede: não entra na
         * contagem de erros e não vira a mensagem assustadora que
         * `reportSync` monta a partir de `failed`. Prazo vencido e erro
         * de verdade seguem contando como sempre contaram.
         */
        if (isNetCancelled(cause) || job.cancelled) {
          return;
        }
        job.failed += 1;
        job.lastError = describe(cause);
      }
      job.done += 1;
      if (options.current()) {
        options.tick();
      }
    }
  };

  await Promise.all(Array.from({ length: options.workers }, () => worker()));

  /*
   * O encerramento só vale para o job CORRENTE. Sem esta pergunta, os
   * workers de um job antigo que terminassem de drenar baixariam a
   * guarda de um job novo que acabou de começar.
   */
  if (options.current()) {
    job.running = false;
    options.tick();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
