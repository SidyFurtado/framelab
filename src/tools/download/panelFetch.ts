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
import { fileUrl, uxpModule } from "../silence/workspace";
import type { DirectJob } from "./ytdlp";

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
  createFolder(name: string): Promise<UxpFolder>;
  getEntry(name: string): Promise<UxpFolder | UxpFile>;
}

interface UxpFile {
  nativePath?: string;
  write(data: ArrayBuffer, options?: { format?: unknown }): Promise<number>;
}

interface UxpLfs {
  getEntryWithUrl(url: string): Promise<UxpFolder>;
  getEntryForPersistentToken?(token: string): Promise<UxpFolder>;
  createPersistentToken?(entry: unknown): Promise<string>;
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
 * Guarda a permissão da pasta que o editor escolheu no seletor.
 *
 * A entry que o seletor devolve JÁ TEM permissão de escrita; o token
 * é o que a faz sobreviver entre sessões. Sem ele, o caminho salvo é
 * só texto — e texto pode ser uma rota que este host não atende.
 */
export async function rememberFolderToken(entry: unknown): Promise<string | null> {
  try {
    const api = storageApi();
    if (!api?.lfs.createPersistentToken) {
      return null;
    }
    return await api.lfs.createPersistentToken(entry);
  } catch {
    return null;
  }
}

function storageApi(): { lfs: UxpLfs; binary: unknown } | null {
  const storage = uxpModule<{
    storage?: { localFileSystem?: UxpLfs; formats?: { binary?: unknown } };
  }>("uxp")?.storage;
  const lfs = storage?.localFileSystem;
  if (!lfs || typeof lfs.getEntryWithUrl !== "function") {
    return null;
  }
  return { lfs, binary: storage?.formats?.binary };
}

/** file: URL de um caminho nativo, com cada segmento escapado. */
/**
 * A pasta de destino como entry de storage — criando o último nível
 * se for preciso. `~/Movies` sempre existe; `~/Movies/Framelab` só
 * depois do primeiro download.
 */
async function destinationFolder(
  destination: string,
  token: string | null
): Promise<{ folder: UxpFolder; binary: unknown }> {
  const api = storageApi();
  if (!api) {
    throw new Error("destino: storage do UXP indisponível");
  }

  // 1. O token do seletor: a única rota GARANTIDA em qualquer build,
  //    porque a permissão veio do próprio host quando o editor
  //    escolheu a pasta.
  if (token && api.lfs.getEntryForPersistentToken) {
    try {
      const folder = await api.lfs.getEntryForPersistentToken(token);
      return { folder, binary: api.binary };
    } catch {
      // Token velho (pasta sumiu, permissão caducou): tenta o caminho.
    }
  }

  // 2. Por caminho — funciona nos hosts que atendem a rota file:.
  try {
    try {
      const folder = await api.lfs.getEntryWithUrl(fileUrl(destination));
      return { folder, binary: api.binary };
    } catch {
      // O último nível pode não existir ainda.
    }
    const normalized = destination.replace(/\\/g, "/").replace(/\/+$/, "");
    const cut = normalized.lastIndexOf("/");
    if (cut <= 0) {
      throw new Error("sem pasta-mãe");
    }
    const parent = await api.lfs.getEntryWithUrl(fileUrl(normalized.slice(0, cut)));
    const leaf = normalized.slice(cut + 1);
    try {
      const folder = await parent.createFolder(leaf);
      return { folder, binary: api.binary };
    } catch {
      const existing = (await parent.getEntry(leaf)) as UxpFolder;
      return { folder: existing, binary: api.binary };
    }
  } catch (cause) {
    throw stageError("destino", cause);
  }
}

/**
 * Baixa um job direto e devolve o caminho nativo do arquivo escrito.
 * Lança em qualquer tropeço — o chamador tem o script de plano B.
 */
export async function downloadInPanel(
  job: DirectJob,
  destination: string,
  token: string | null,
  onProgress?: ByteProgress,
  cancelled?: Cancelled
): Promise<string> {
  const { folder, binary } = await destinationFolder(destination, token);

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
    const file = await folder.createFile(job.fileName, { overwrite: true });
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
    return file.nativePath ?? `${destination}/${job.fileName}`;
  } catch (cause) {
    throw stageError("escrita", cause);
  }
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
      response = await fetch(mediaUrl, {
        headers: { Range: `bytes=${from}-${to}` },
      });
    } catch (cause) {
      // Header recusado ou rede piscou no primeiro bloco: um GET
      // inteiro ainda entrega — sem progresso fino, mas entrega.
      if (from > 0) {
        throw cause;
      }
      response = await fetch(mediaUrl);
    }

    if (response.status === 200) {
      // Servidor sem Range: veio inteiro. Um bloco só.
      const whole = await response.arrayBuffer();
      if (whole.byteLength > MAX_BYTES) {
        throw new Error("arquivo grande demais para o painel");
      }
      parts.length = 0;
      parts.push(new Uint8Array(whole));
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
      throw new Error("arquivo grande demais para o painel");
    }

    if (total === null) {
      const range = response.headers.get("content-range");
      const match = range ? /\/(\d+)\s*$/.exec(range) : null;
      total = match ? Number.parseInt(match[1], 10) : null;
      // O total declarado corta antes de baixar o resto — o teto acima
      // já garante o fim, este só o torna barato.
      if (total !== null && total > MAX_BYTES) {
        throw new Error("arquivo grande demais para o painel");
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
