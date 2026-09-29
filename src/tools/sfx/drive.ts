/**
 * A ponte com o Drive: ler o pack e baixar um som.
 *
 * ── Sem chave, sem login ───────────────────────────────────────────
 * A pasta do pack é pública ("qualquer pessoa com o link"). Para uma
 * pasta assim o Drive serve duas coisas sem API nenhuma:
 *
 *   • a listagem, pela página `embeddedfolderview` — a mesma que ele
 *     usa para embutir uma pasta num site;
 *   • o arquivo, por `drive.usercontent.google.com/download`.
 *
 * Os dois foram medidos de dentro do painel, no Premiere 26.5.1: o
 * `fetch` do UXP lê a listagem (200, as 10 entradas da raiz) e baixa o
 * áudio inteiro com o tipo certo (`audio/wav`, 127.380 bytes).
 *
 * ── O som não fica no computador ───────────────────────────────────
 * Foi pedido que o pack NÃO fosse baixado para o computador de quem só
 * quer ouvir. A prévia baixa um som por vez para a memória, e o player
 * o lê de um arquivo temporário apagado logo depois (ver `preview.ts`).
 * Guardar o pack é opção de quem quiser usá-lo sem internet
 * (`store.ts`).
 *
 * ── Tudo ou nada ───────────────────────────────────────────────────
 * Se uma subpasta falhar no meio da varredura, a varredura inteira
 * falha. Um catálogo com uma categoria faltando parece um catálogo
 * certo — e substituiria o bom que está no cache. Melhor ficar com a
 * cópia anterior e dizer que a atualização não veio.
 */
import {
  isAudioName,
  isJunkFolder,
  looksLikeFolderView,
  parseFolderView,
  type DriveEntry,
  type PackFile,
} from "./pack";
import { fetchWithTimeout, isNetCancelled, NET_DEADLINE } from "../../bridge/net";

const FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id=";
/**
 * O download direto. `confirm=t` pula a página de "não conseguimos
 * verificar vírus" que o Drive põe na frente de arquivo grande; num
 * arquivo pequeno ele não muda nada (conferido com os dois).
 */
const DOWNLOAD = "https://drive.usercontent.google.com/download?export=download&confirm=t&id=";

/** Pastas lidas ao mesmo tempo. O pack grande tem 803, em 12 níveis. */
const PARALLEL = 10;
/** Rédeas para uma pasta com atalho para si mesma. O pack grande usa 803 pastas e 11 níveis. */
const MAX_FOLDERS = 3000;
const MAX_DEPTH = 16;

/**
 * Todos os arquivos de áudio do pack, com as pastas até cada um.
 *
 * Em largura, uma leva de pastas por vez: a raiz, depois as categorias,
 * depois as subpastas. Com o pack real são três idas ao Drive.
 */
export async function crawlPack(rootId: string, progress: (folders: number, files: number) => void = () => {}): Promise<PackFile[]> {
  const files: PackFile[] = [];
  const seen = new Set<string>([rootId]);
  let level: Array<{ id: string; folders: string[] }> = [{ id: rootId, folders: [] }];
  let visited = 0;

  for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH; depth += 1) {
    const next: Array<{ id: string; folders: string[] }> = [];
    for (let start = 0; start < level.length; start += PARALLEL) {
      const batch = level.slice(start, start + PARALLEL);
      const pages = await Promise.all(batch.map((item) => readFolder(item.id)));
      batch.forEach((item, index) => {
        for (const entry of pages[index]) {
          if (entry.folder) {
            if (!isJunkFolder(entry.name) && !seen.has(entry.id)) {
              seen.add(entry.id);
              next.push({ id: entry.id, folders: [...item.folders, entry.name] });
            }
          } else if (isAudioName(entry.name)) {
            files.push({ id: entry.id, name: entry.name, folders: item.folders, stamp: entry.stamp });
          }
        }
      });
      visited += batch.length;
      progress(visited, files.length);
      if (visited > MAX_FOLDERS) {
        throw new Error(`o pack passou de ${MAX_FOLDERS} pastas`);
      }
    }
    level = next;
  }
  return files;
}

/** Uma pasta, com uma segunda tentativa: a rede do escritório pisca. */
async function readFolder(id: string): Promise<DriveEntry[]> {
  try {
    return await readFolderOnce(id);
  } catch (first) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    try {
      return await readFolderOnce(id);
    } catch {
      throw first;
    }
  }
}

async function readFolderOnce(id: string): Promise<DriveEntry[]> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      FOLDER_VIEW + encodeURIComponent(id),
      undefined,
      NET_DEADLINE.listing
    );
  } catch (cause) {
    throw new Error(`sem conexão com o Drive (${describe(cause)})`);
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "a pasta do pack não existe mais nesse link"
        : `o Drive respondeu ${response.status}`
    );
  }
  const html = await response.text();
  if (!looksLikeFolderView(html)) {
    throw new Error("a pasta do pack não está pública — o Drive pediu login");
  }
  return parseFolderView(html);
}

/**
 * Os bytes de um som.
 *
 * Um arquivo de 0 byte é devolvido como está, e não como erro: dez
 * arquivos do pack real estão vazios NO PRÓPRIO DRIVE (o upload deles
 * falhou). Quem chama distingue "vazio lá" de "não baixou", porque as
 * duas coisas pedem mensagens diferentes para o editor.
 */
export async function downloadSound(
  id: string,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      DOWNLOAD + encodeURIComponent(id),
      undefined,
      NET_DEADLINE.media,
      signal
    );
  } catch (cause) {
    // Desistência do editor NÃO é "sem conexão": disfarçá-la de falha
    // de rede é o que faria um cancelamento virar erro na tela.
    if (isNetCancelled(cause)) {
      throw cause;
    }
    throw new Error(`sem conexão com o Drive (${describe(cause)})`);
  }
  if (!response.ok) {
    throw new Error(`o Drive respondeu ${response.status}`);
  }
  // Corpo vazio: o `arrayBuffer()` do UXP lança "Already read" em vez
  // de devolver zero bytes. Medido com um dos arquivos vazios do pack.
  if (response.headers.get("content-length") === "0") {
    return new ArrayBuffer(0);
  }
  if (/text\/html/i.test(response.headers.get("content-type") ?? "")) {
    // A página de cota estourada ou de confirmação: HTML no lugar do
    // áudio. Gravar isso como .wav daria um arquivo que o Premiere
    // recusa sem dizer por quê.
    throw new Error("o Drive devolveu uma página em vez do áudio (limite de downloads?)");
  }
  return response.arrayBuffer();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
