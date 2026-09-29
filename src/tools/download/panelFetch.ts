/**
 * Download dentro do próprio painel — sem script, sem shell, sem
 * Terminal, com progresso de verdade.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * A via rápida do TikTok entrega um link direto de CDN. Um link
 * direto não precisa de yt-dlp nem de shell: o `fetch` do UXP baixa
 * os bytes e a API de storage escreve o arquivo. O painel vê cada
 * pedaço chegar, então a barra de progresso mostra MB reais — a
 * reclamação "não tem um loading" morre aqui, junto com a última
 * razão de abrir janela para baixar um TikTok.
 *
 * ── Como ───────────────────────────────────────────────────────────
 * Em pedaços, por `Range`: cada resposta 206 é um bloco e um tick de
 * progresso. Servidor que ignorar Range devolve 200 com o corpo
 * inteiro — vira um download de um bloco só, sem progresso fino, mas
 * ainda sem shell. Tudo acumula em memória e grava de uma vez — um
 * TikTok em HD tem dezenas de MB, não gigas; o que passar do teto é
 * empurrado para o caminho do script.
 *
 * Toda falha aqui LANÇA, e quem chama manda o job para o script. O
 * painel nunca fica sem porta.
 */
import {
  openDestination,
  safeBaseName,
  type Destination,
} from "../../bridge/destination";
import type { DirectJob } from "./ytdlp";
import { fetchWithTimeout, NET_DEADLINE } from "../../bridge/net";

const CHUNK_BYTES = 4 * 1024 * 1024;
/** Acima disso não cabe em memória com folga: vai pelo script. */
const MAX_BYTES = 300 * 1024 * 1024;

export interface ByteProgress {
  (doneBytes: number, totalBytes: number | null): void;
}

/**
 * Perguntado a cada bloco. true faz o laço largar tudo na hora.
 *
 * Um TikTok em HD são dezenas de blocos de 4 MB; esperar o último para
 * só então olhar o cancelamento deixava o painel travado por todo o
 * resto do arquivo.
 */
export interface Cancelled {
  (): boolean;
}

/** O que `fetchAllBytes` lança quando o editor desiste. */
const GAVE_UP = "cancelado pelo editor";

interface UxpFolder {
  nativePath?: string;
  createFile(name: string, options?: { overwrite?: boolean }): Promise<UxpFile>;
}

interface UxpFile {
  nativePath?: string;
  write(data: ArrayBuffer, options?: { format?: unknown }): Promise<number>;
}

/**
 * Erro com a etapa no nome: quando o painel cair para o plano B, o
 * log diz QUAL API recusou — "destino", "rede" ou "escrita". Sem
 * isso, a queda era muda e indepurável à distância.
 */
function stageError(stage: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${stage}: ${detail}`);
}

/**
 * A pasta de destino como entry de storage.
 *
 * Era uma implementação inteira aqui — a terceira cópia da mesma
 * coisa, e a que criava a pasta que não existia sem perguntar. Mora
 * agora em `bridge/destination`, junto com a regra de que caminho
 * escolhido pelo editor não se reescreve e não se inventa.
 */
export async function destinationFolder(
  target: Destination,
  mayCreate = false
): Promise<{ folder: UxpFolder; binary: unknown }> {
  const opened = await openDestination(target, { create: mayCreate });
  return { folder: opened.folder as unknown as UxpFolder, binary: opened.binary };
}

/**
 * Baixa um job direto e devolve o caminho nativo do arquivo escrito.
 * Lança em qualquer tropeço — o chamador tem o script de plano B.
 */
export async function downloadInPanel(
  job: DirectJob,
  destination: Destination,
  mayCreate: boolean,
  onProgress?: ByteProgress,
  cancelled?: Cancelled
): Promise<string> {
  /*
   * A pasta PRIMEIRO, antes de um único byte de rede.
   *
   * Baixar 40 MB para depois descobrir que o destino sumiu é o gasto
   * que o editor paga duas vezes: no tempo e na confusão de ver um
   * progresso completo terminar em erro.
   */
  const { folder, binary } = await destinationFolder(destination, mayCreate);

  /*
   * Os bytes TODOS antes de qualquer arquivo existir.
   *
   * É o que garante que cancelar no meio não deixe um arquivo pela
   * metade no destino: `createFile` só acontece depois que o download
   * terminou inteiro, então uma desistência não escreve nada — e a
   * execução seguinte não tem como confundir um resto com um pronto.
   */
  let combined: Uint8Array;
  try {
    combined = await fetchAllBytes(job.mediaUrl, onProgress, cancelled);
  } catch (cause) {
    throw stageError("rede", cause);
  }

  try {
    // Só o BASENAME é saneado, e é um nome que o plugin inventou a
    // partir do título. A pasta que o editor escolheu não passa por
    // nenhuma peneira — ver `bridge/destination`.
    const file = await folder.createFile(safeBaseName(job.fileName, "video"), {
      overwrite: true,
    });
    try {
      await file.write(
        combined.buffer as ArrayBuffer,
        binary !== undefined ? { format: binary } : undefined
      );
    } catch {
      // Build sem a constante de formato: tenta a grafia literal, que
      // algumas versões aceitam.
      await file.write(combined.buffer as ArrayBuffer, { format: "binary" });
    }
    return file.nativePath ?? `${destination.path}/${safeBaseName(job.fileName, "video")}`;
  } catch (cause) {
    throw stageError("escrita", cause);
  }
}

/** O que `fetchAllBytes` lança quando o corpo passa do teto. */
const TOO_BIG = "arquivo grande demais para o painel";
/**
 * O que ele lança quando não dá para impor o teto com segurança.
 *
 * Quem chama trata como qualquer outra falha de rede e manda o trabalho
 * para o script, que sabe baixar arquivo de qualquer tamanho.
 */
const UNMEASURABLE =
  "o servidor não disse o tamanho e esta build não lê o corpo em partes";

/**
 * O tamanho que o servidor declarou, ou `null` quando não dá para
 * confiar no que ele disse.
 *
 * Comparação NUMÉRICA, nunca de texto: `"9"` > `"10"` como string. E
 * cabeçalho ausente, vazio, com letra, negativo ou absurdo vira `null` —
 * um cabeçalho inválido não pode virar passe livre.
 */
function declaredLength(response: Response): number | null {
  const raw = response.headers?.get?.("content-length");
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  if (!/^\d+$/.test(raw.trim())) {
    return null;
  }
  const size = Number(raw.trim());
  if (Number.isNaN(size) || size < 0) {
    return null;
  }
  /*
   * Um valor astronômico volta como número (até `Infinity`), e não como
   * `null`: ele É conhecido por passar do teto, e tratá-lo como
   * "tamanho desconhecido" adiaria a recusa para depois de começar a
   * receber bytes.
   */
  return size;
}

/**
 * O corpo de uma resposta 200, sem nunca passar do teto.
 *
 * Três camadas, da mais barata para a mais cara:
 *
 *   1. tamanho declarado acima do teto → recusa SEM tocar no corpo;
 *   2. corpo legível em partes → lê com o teto na mão, e para no
 *      instante em que o passaria (cobre também um `Content-Length`
 *      mentiroso, que é o furo que a camada 1 sozinha deixaria);
 *   3. sem leitura em partes nesta build, mas com tamanho declarado
 *      dentro do teto → o `arrayBuffer()` de sempre, limitado pelo que
 *      o servidor prometeu.
 *
 * Sem nenhuma das três, recusa: ler tudo para medir depois é o defeito.
 */
async function readWholeCapped(
  response: Response,
  onProgress?: ByteProgress,
  cancelled?: Cancelled
): Promise<Uint8Array> {
  const declared = declaredLength(response);
  if (declared !== null && declared > MAX_BYTES) {
    throw new Error(TOO_BIG);
  }

  const reader = response.body?.getReader?.();
  if (reader) {
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        if (cancelled?.()) {
          throw new Error(GAVE_UP);
        }
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.byteLength === 0) {
          continue;
        }
        received += value.byteLength;
        if (received > MAX_BYTES) {
          // Para AQUI, com o teto de bytes na memória e nem um a mais.
          throw new Error(TOO_BIG);
        }
        parts.push(value);
        onProgress?.(received, declared);
      }
    } finally {
      // Solta o fluxo: sem isto o resto do arquivo continua vindo para
      // um leitor que já desistiu.
      try {
        await reader.cancel?.();
      } catch {
        /* o fluxo já tinha acabado */
      }
    }
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    return combined;
  }

  if (declared === null) {
    throw new Error(UNMEASURABLE);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A parte de rede, sozinha: pedaços por Range, progresso por pedaço.
 * Separada da escrita para poder ser provada fora do host — a escrita
 * é uma chamada de API; o laço de blocos é onde mora o como-quebrar.
 */
export async function fetchAllBytes(
  mediaUrl: string,
  onProgress?: ByteProgress,
  cancelled?: Cancelled
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let received = 0;
  let total: number | null = null;

  for (;;) {
    if (cancelled?.()) {
      throw new Error(GAVE_UP);
    }
    const from = received;
    const to = from + CHUNK_BYTES - 1;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        mediaUrl,
        { headers: { Range: `bytes=${from}-${to}` } },
        NET_DEADLINE.media
      );
    } catch (cause) {
      // Header recusado ou rede piscou no primeiro bloco: um GET
      // inteiro ainda entrega — sem progresso fino, mas entrega.
      if (from > 0) {
        throw cause;
      }
      response = await fetchWithTimeout(mediaUrl, undefined, NET_DEADLINE.media);
    }

    if (response.status === 200) {
      /*
       * Servidor sem Range: o corpo inteiro vem NESTA resposta.
       *
       * O teto era conferido DEPOIS do `arrayBuffer()` — ou seja, quando
       * os bytes já estavam na memória do painel. Um link que resolvesse
       * para um arquivo muito maior que o esperado derrubava o painel
       * inteiro, não só a operação. Agora a recusa vem antes, e quando o
       * tamanho não é declarado a leitura é feita com o teto na mão.
       */
      const whole = await readWholeCapped(response, onProgress, cancelled);
      parts.length = 0;
      parts.push(whole);
      received = whole.byteLength;
      total = received;
      onProgress?.(received, total);
      break;
    }
    if (response.status !== 206) {
      throw new Error(`CDN respondeu ${response.status}`);
    }

    const chunk = await response.arrayBuffer();
    parts.push(new Uint8Array(chunk));
    received += chunk.byteLength;
    /*
     * O teto vale pelo que JÁ ESTÁ na memória, não pelo que o servidor
     * prometeu.
     *
     * A checagem morava só dentro do `if (total === null)` logo abaixo:
     * um 206 sem `content-range` — ou com um que o regex não lê — nunca
     * chegava a um total, e o laço então acumulava blocos de 4 MB até o
     * servidor parar. Um link errado apontando para um arquivo de
     * gigabytes levava o painel junto.
     */
    if (received > MAX_BYTES) {
      throw new Error(TOO_BIG);
    }

    if (total === null) {
      const range = response.headers.get("content-range");
      const match = range ? /\/(\d+)\s*$/.exec(range) : null;
      total = match ? Number.parseInt(match[1], 10) : null;
      // O total declarado corta antes de baixar o resto — o teto acima
      // já garante o fim, este só o torna barato.
      if (total !== null && total > MAX_BYTES) {
        throw new Error(TOO_BIG);
      }
    }
    onProgress?.(received, total);

    if (chunk.byteLength < CHUNK_BYTES || (total !== null && received >= total)) {
      break;
    }
  }

  if (received === 0) {
    throw new Error("CDN devolveu zero bytes");
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}
