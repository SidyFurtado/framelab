/**
 * O diário do Baixar: o que foi baixado, de onde, e para onde.
 *
 * ── Por que existe ─────────────────────────────────────────────────
 * Em 23/09/2026 cerca de 25 arquivos foram escritos numa árvore de
 * pastas paralela (ver `bridge/destination`). Quando deram por falta
 * deles, não havia em lugar nenhum a lista do que tinha sido baixado:
 * os links tiveram de ser reconstruídos garimpando o histórico do
 * navegador, um a um.
 *
 * Uma linha por arquivo resolve isso para sempre e custa microssegundos.
 * O formato é JSONL — uma linha por registro, append puro — porque é o
 * que sobrevive a uma gravação interrompida: perde-se a última linha,
 * nunca o arquivo.
 *
 * O diário só cresce. Ele é pequeno (algumas centenas de bytes por
 * download) e vive na pasta de trabalho do plugin; `HISTORY_FILE` é o
 * nome que o editor procura quando precisa dele.
 */
import { append, workspace } from "../silence/workspace";
import type { DirectJob } from "./ytdlp";

export const HISTORY_FILE = "download-history.jsonl";

export interface DownloadRecord {
  /** ISO 8601, com fuso — um horário sem fuso não localiza nada. */
  at: string;
  /** O link de origem, quando dá para saber de qual arquivo ele é. */
  url: string | null;
  /** Só o nome, que é por onde se procura no Finder. */
  name: string;
  /** O caminho completo do que foi escrito. */
  path: string;
  /** A pasta que o painel PEDIU — pode não ser a que recebeu. */
  destination: string;
}

function baseName(path: string): string {
  const clean = path.replace(/[\\/]+$/, "");
  return clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1) || clean;
}

/**
 * Casa cada arquivo escrito com o link que o gerou.
 *
 * A via rápida (`direct`) sabe o par exato: ela mesma escolheu o nome.
 * O yt-dlp não diz qual link virou qual arquivo, então o que sobra é
 * pareado por posição quando as contas fecham, e fica `null` quando
 * não fecham — um `null` honesto vale mais que um link adivinhado, e a
 * lista de links do lote ainda está nas outras linhas.
 *
 * Pura de propósito: é a única parte com regra, e é a que se confere
 * fora do Premiere.
 */
export function pairDownloads(
  files: readonly string[],
  jobs: readonly DirectJob[],
  urls: readonly string[],
  destination: string,
  at: string = new Date().toISOString()
): DownloadRecord[] {
  const byName = new Map<string, string>();
  for (const job of jobs) {
    byName.set(job.fileName, job.sourceUrl);
  }

  const rest: number[] = [];
  const records: DownloadRecord[] = files.map((path, index) => {
    const name = baseName(path);
    const known = byName.get(name) ?? null;
    if (known === null) {
      rest.push(index);
    }
    return { at, url: known, name, path, destination };
  });

  // Os links que nenhuma via rápida reclamou são os que foram para o
  // yt-dlp; se sobrou exatamente um por arquivo, a ordem é a do lote.
  const taken = new Set(jobs.map((job) => job.sourceUrl));
  const left = urls.filter((url) => !taken.has(url));
  if (left.length === rest.length) {
    rest.forEach((index, at2) => {
      records[index].url = left[at2];
    });
  }
  return records;
}

/** Grava o lote no diário. Falhar aqui nunca derruba um download. */
export async function rememberDownloads(
  files: readonly string[],
  jobs: readonly DirectJob[],
  urls: readonly string[],
  destination: string
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  try {
    const space = await workspace();
    const lines = pairDownloads(files, jobs, urls, destination)
      .map((record) => JSON.stringify(record))
      .join("\n");
    await append(space, HISTORY_FILE, lines);
  } catch (cause) {
    // O diário é seguro-desemprego, não parte do download.
    console.warn("[Download] não consegui anotar no diário:", cause);
  }
}
