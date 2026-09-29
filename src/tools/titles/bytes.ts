/**
 * Bytes crus pelo `fs` do UXP — ler e gravar arquivo binário.
 *
 * ── Por que duas portas de leitura ────────────────────────────────
 * `readFileSync` sem `encoding` devolve bytes na maioria das builds,
 * mas em algumas devolve TEXTO — e binário lido como UTF-8 é perda
 * irreversível. Quando isso acontece, sobra o descritor de arquivo:
 * `open`/`read`/`close` sempre entregam bytes. A última nota de
 * leitura fica guardada para o relatório em disco dizer por qual
 * porta o painel entrou, ou onde parou.
 */
import { fsModule, fsPath, type UxpFs, type Workspace } from "../silence/workspace";

/** Pedaço de leitura: 64 KB por vez. */
const CHUNK = 65536;

let note = "";

/** O que a última leitura fez — para o diagnóstico, não para a lógica. */
export function lastReadNote(): string {
  return note;
}

export async function readBytes(fs: UxpFs, path: string): Promise<Uint8Array | null> {
  try {
    const raw = fs.readFileSync(path);
    if (raw && typeof raw !== "string") {
      note = "readFileSync";
      return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    }
    note = `readFileSync devolveu ${typeof raw}`;
  } catch (cause) {
    note = `readFileSync: ${String(cause).slice(0, 80)}`;
  }

  let fd: number | null = null;
  try {
    fd = await fs.open(path, "r");
    const parts: Uint8Array[] = [];
    let position = 0;
    for (;;) {
      const buffer = new ArrayBuffer(CHUNK);
      const answer = await fs.read(fd, buffer, 0, CHUNK, position);
      const read = Number(answer?.bytesRead ?? 0);
      if (!(read > 0)) {
        break;
      }
      parts.push(new Uint8Array(answer.buffer ?? buffer, 0, read).slice());
      position += read;
      if (read < CHUNK) {
        break;
      }
    }
    if (position === 0) {
      note += " · open/read: arquivo vazio";
      return null;
    }
    const all = new Uint8Array(position);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    note += " · open/read ok";
    return all;
  } catch (cause) {
    note += ` · open/read: ${String(cause).slice(0, 80)}`;
    return null;
  } finally {
    if (fd !== null) {
      await fs.close(fd).catch(() => undefined);
    }
  }
}

/** Um arquivo da pasta de trabalho, em bytes. */
export async function readWorkBytes(space: Workspace, relative: string): Promise<Uint8Array | null> {
  const fs = fsModule();
  if (!fs) {
    note = 'require("fs") não resolveu';
    return null;
  }
  return readBytes(fs, fsPath(space, relative));
}

/** Um arquivo pelo caminho nativo — o `.mogrt` de origem, por exemplo. */
export async function readNativeBytes(path: string): Promise<Uint8Array | null> {
  const fs = fsModule();
  if (!fs) {
    note = 'require("fs") não resolveu';
    return null;
  }
  return readBytes(fs, path);
}

/** Grava bytes na pasta de trabalho. Lança quando não dá. */
export function writeWorkBytes(space: Workspace, relative: string, bytes: Uint8Array): void {
  const fs = fsModule();
  if (!fs) {
    throw new Error('require("fs") não resolveu');
  }
  fs.writeFileSync(fsPath(space, relative), bytes);
}
