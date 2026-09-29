/**
 * Toda requisição do plugin, com prazo.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * Nenhum `fetch` do painel tinha prazo, e `fetch` não tem um por
 * padrão. Uma conexão que ABRE e não responde — o CDN do Drive
 * engasgado, a rede do escritório atrás de um portal, o GitHub
 * bloqueado — pendurava a operação para sempre. Pior: as bandeiras de
 * cancelamento que as ferramentas já têm só são lidas ENTRE
 * requisições, então o botão de cancelar não tinha efeito enquanto o
 * `fetch` estava pendurado. A única saída era recarregar o painel.
 *
 * ── O que o runtime oferece, e o que não ──────────────────────────
 * O UXP declara `AbortController` e `AbortSignal` como globais. Mas a
 * assinatura de `fetch` na tipagem da Adobe aceita só `method`,
 * `headers`, `body` e `credentials` — `signal` NÃO está lá. Ou seja:
 * dá para criar o controlador, e não dá para garantir que o `fetch`
 * desta build o respeite.
 *
 * Passar a chave assim mesmo é seguro: o `updater.ts` já passa
 * `cache: "no-store"`, que também não está na tipagem, e funciona em
 * produção — chaves extras em `init` são ignoradas, não recusadas.
 *
 * Por isso aqui são DUAS defesas ao mesmo tempo, e não uma escolha:
 *
 *   1. o `signal`, para a requisição ser abortada DE VERDADE na build
 *      que o honrar;
 *   2. a corrida com um temporizador, que devolve o controle a quem
 *      chamou de qualquer jeito.
 *
 * **Limitação honesta:** onde o `fetch` ignorar o `signal`, a
 * requisição subjacente continua viva em segundo plano até o host
 * desistir dela. O painel não fica preso — mas o soquete pode demorar
 * a fechar, e os bytes que chegarem depois são descartados.
 */

/**
 * Os prazos, por natureza da chamada.
 *
 * Cada um vale por REQUISIÇÃO, não pela operação inteira: um lote de
 * download é feito de muitos blocos, e cada bloco tem o seu prazo. Os
 * números são folgados de propósito — uma rede de escritório lenta não
 * pode ser confundida com uma conexão morta.
 */
export const NET_DEADLINE = {
  /** API pequena, resposta curta: metadados de um link. */
  metadata: 20_000,
  /** O `version.json`: um punhado de linhas, e o painel está abrindo. */
  manifest: 20_000,
  /** Uma página de listagem do Drive: HTML, e pode ser grande. */
  listing: 45_000,
  /** Bytes de verdade — um bloco de 4 MB, um som, o bundle. */
  media: 120_000,
  /** Uma rodada de tradução: um lote de falas. */
  translate: 30_000,
} as const;

/** O prazo venceu. */
export class NetTimeout extends Error {
  readonly isNetTimeout = true;
  /** Campo declarado, e não parâmetro-propriedade: o executor de testes
   *  do Node roda em modo strip-only e recusa a forma abreviada. */
  readonly ms: number;
  constructor(ms: number) {
    super(`a rede não respondeu em ${Math.round(ms / 1000)}s`);
    this.name = "NetTimeout";
    this.ms = ms;
  }
}

/** Quem chamou desistiu. NÃO é o mesmo que a rede falhar. */
export class NetCancelled extends Error {
  readonly isNetCancelled = true;
  constructor() {
    super("cancelado");
    this.name = "NetCancelled";
  }
}

/*
 * As duas perguntas são feitas pela MARCA, e não por `instanceof`: o
 * bundle é um IIFE só, mas uma causa que atravesse um `JSON.parse` de
 * mensagem ou venha de outro realm perderia o protótipo, e um
 * cancelamento tratado como falha de rede é a pior das confusões.
 */
export function isNetTimeout(cause: unknown): boolean {
  return (
    cause instanceof NetTimeout ||
    (typeof cause === "object" && cause !== null && "isNetTimeout" in cause)
  );
}

export function isNetCancelled(cause: unknown): boolean {
  return (
    cause instanceof NetCancelled ||
    (typeof cause === "object" && cause !== null && "isNetCancelled" in cause)
  );
}


/** O controlador, quando a build tiver um. */
function makeController(): AbortController | null {
  try {
    return typeof AbortController === "function" ? new AbortController() : null;
  } catch {
    return null;
  }
}

/**
 * O relógio de UMA operação de rede, do primeiro byte pedido ao último
 * byte lido.
 *
 * ── Por que é um relógio, e não um prazo por chamada ──────────────
 * A primeira versão armava o prazo só até o `fetch` devolver a
 * `Response`, e o limpava ali. Só que a `Response` chega com os
 * CABEÇALHOS: o corpo ainda não veio. Um servidor que responda o
 * cabeçalho e pare no meio do corpo deixava `.json()`, `.text()` e
 * `.arrayBuffer()` pendurados para sempre — com o temporizador já
 * removido e o ouvinte de cancelamento também. O prazo existia e não
 * cobria a parte mais demorada da operação.
 *
 * O instante-limite é calculado UMA vez, no começo. Cada etapa corre
 * contra o que sobra dele, então a operação inteira cabe no prazo — e
 * não em dois prazos, um para o cabeçalho e outro para o corpo.
 */
interface Clock {
  /** Instante absoluto em que a operação inteira expira. */
  readonly until: number;
  /** O prazo cheio, só para a mensagem de erro. */
  readonly total: number;
  /** O MESMO controlador do `fetch`: abortar aqui alcança o corpo. */
  readonly controller: AbortController | null;
  readonly externalSignal: AbortSignal | undefined;
}

/**
 * Roda uma etapa contra o que sobra do relógio.
 *
 * Serve tanto para o `fetch` quanto para a leitura do corpo, e é o que
 * garante que as duas somem um prazo, não dois.
 */
async function underDeadline<T>(work: () => Promise<T>, clock: Clock): Promise<T> {
  if (clock.externalSignal?.aborted) {
    throw new NetCancelled();
  }
  const left = clock.until - Date.now();
  if (left <= 0) {
    // O cabeçalho consumiu o prazo inteiro: o corpo não ganha mais.
    throw new NetTimeout(clock.total);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onExternalAbort: (() => void) | null = null;
  /** Quem venceu a corrida, para a causa certa sair no fim. */
  let verdict: "timeout" | "cancelled" | null = null;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      verdict = "timeout";
      clock.controller?.abort();
      reject(new NetTimeout(clock.total));
    }, left);

    if (clock.externalSignal) {
      onExternalAbort = (): void => {
        verdict = "cancelled";
        clock.controller?.abort();
        reject(new NetCancelled());
      };
      clock.externalSignal.addEventListener("abort", onExternalAbort);
    }
  });

  try {
    /*
     * `Promise.race` pendura um tratador em CADA entrada, então a
     * perdedora nunca vira rejeição sem dono — inclusive o `fetch` que
     * rejeita com AbortError depois de o prazo já ter vencido.
     */
    return await Promise.race([work(), deadline]);
  } catch (cause) {
    /*
     * Na build que honra o `signal`, quem rejeita primeiro é a própria
     * etapa, com AbortError — uma causa genérica que não diz se foi
     * prazo ou desistência. O veredito guardado acima é que diz.
     */
    if (verdict === "timeout") {
      throw new NetTimeout(clock.total);
    }
    if (verdict === "cancelled") {
      throw new NetCancelled();
    }
    // Erro de rede, ou JSON inválido: sobe como sempre subiu.
    throw cause;
  } finally {
    // Em TODA saída: sem isto, um temporizador de dois minutos fica de
    // pé depois de uma resposta que chegou em 50 ms, e o ouvinte do
    // sinal externo sobrevive à etapa que o criou.
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (clock.externalSignal && onExternalAbort) {
      clock.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/** As leituras de corpo que o prazo precisa cobrir. */
const BODY_READERS = new Set(["json", "text", "arrayBuffer", "blob", "formData"]);

/**
 * A `Response` com as leituras de corpo sob o mesmo relógio.
 *
 * Um Proxy, e não um objeto montado à mão: o que os consumidores usam
 * hoje é `ok`, `status` e `headers.get`, mas uma cópia à mão esquece
 * silenciosamente o que ninguém usou ainda. Aqui só os leitores de
 * corpo são interceptados; todo o resto passa igual, com os métodos
 * amarrados à resposta de verdade.
 */
function guardBody(response: Response, clock: Clock): Response {
  return new Proxy(response, {
    get(target, prop) {
      if (typeof prop === "string" && BODY_READERS.has(prop)) {
        const read = Reflect.get(target, prop, target) as unknown;
        if (typeof read !== "function") {
          return read;
        }
        return () =>
          underDeadline(
            () => (read as () => Promise<unknown>).call(target),
            clock
          );
      }
      // O `receiver` do Reflect é o ALVO, de propósito: um getter
      // nativo chamado com o Proxy como `this` responde "Illegal
      // invocation". Pelo mesmo motivo os métodos saem amarrados.
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * `fetch` que sempre termina — cabeçalho E corpo: sucesso, erro HTTP,
 * erro de rede, prazo ou cancelamento.
 *
 * Um erro HTTP NÃO lança — a `Response` volta com `ok: false`, como o
 * `fetch` sempre fez, porque é assim que os quatro módulos já decidem
 * o que fazer com um 404 e um 429.
 *
 * `externalSignal` existe para quem tiver um sinal de verdade. As
 * ferramentas de hoje cancelam com booleano lido entre requisições;
 * ligá-las aqui é trabalho do P2-13 e do P2-17, e não desta etapa.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  // Já cancelado antes de começar: não abre conexão nenhuma.
  if (externalSignal?.aborted) {
    throw new NetCancelled();
  }

  const clock: Clock = {
    until: Date.now() + timeoutMs,
    total: timeoutMs,
    controller: makeController(),
    externalSignal,
  };

  const response = (await underDeadline(
    () =>
      fetch(
        url,
        clock.controller ? { ...init, signal: clock.controller.signal } : init
      ),
    clock
  )) as Response;

  // O MESMO relógio segue para o corpo: é a metade que faltava.
  return guardBody(response, clock);
}
