/**
 * A cópia do modelo com o texto já dentro — pronta para inserir.
 *
 * É a peça que junta as três anteriores: lê o `.mogrt` de origem
 * (bytes.ts), troca o `definition.json` (definition.ts) e reescreve o
 * pacote (mogrtZip.ts) numa pasta de cache do plugin. O que sai daqui
 * é um caminho nativo, que é tudo o que `insertMogrtFromPath` pede.
 *
 * ── Por que o cache tem prazo ─────────────────────────────────────
 * Cada inserção gera um arquivo — um título de 10 MB, uma legenda de
 * 40 KB — e ninguém volta para apagá-los. O Premiere copia o modelo
 * para dentro do projeto ao inserir, então o arquivo só precisa viver
 * o bastante para a inserção acontecer; um dia é folga de sobra, e a
 * varredura antes de cada gravação impede a pasta de virar um depósito.
 */
import { ensureDir, fsModule, fsPath, nativePath, workspace } from "../silence/workspace";
import { lastReadNote, readNativeBytes, writeWorkBytes } from "./bytes";
import { patchDefinition, type DefinitionPatch } from "./definition";
import { readTextEntry, rewriteMogrt } from "./mogrtZip";
import { slugFor } from "./previews";

export const CACHE_FOLDER = "mogrt-cache";

/** Quanto uma cópia vive no cache antes da varredura apagá-la. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TextStyle {
  /** Nome PostScript. Vazio mantém a do modelo. */
  readonly font?: string;
  /** Corpo em pixels. 0 mantém o do modelo. */
  readonly size?: number;
}

/** O modelo de origem, lido uma vez — um lote de legendas reusa. */
export interface LoadedTemplate {
  readonly path: string;
  readonly name: string;
  readonly zip: Uint8Array;
  readonly definition: string;
}

export interface PreparedMogrt {
  /** Caminho nativo da cópia. */
  readonly path: string;
  readonly capsuleName: string;
  readonly textApplied: boolean;
  readonly fontApplied: boolean;
  readonly sizeApplied: boolean;
  /** Quantos campos de texto o modelo tem, e o que foi escrito em cada um. */
  readonly textFields: number;
  readonly parts: readonly string[];
  readonly bytes: number;
}

/** Lê o `.mogrt` e o seu `definition.json`. Lança com a causa. */
export async function loadTemplate(path: string): Promise<LoadedTemplate> {
  const zip = await readNativeBytes(path);
  if (!zip || zip.length === 0) {
    throw new Error(`não consegui ler o modelo (${lastReadNote()})`);
  }
  const definition = readTextEntry(zip, "definition.json");
  if (!definition) {
    throw new Error("o modelo não tem definition.json — não é um .mogrt");
  }
  const name = path.split(/[\\/]/).pop()?.replace(/\.mogrt$/i, "") || "modelo";
  return { path, name, zip, definition };
}

interface ReaddirFs {
  readdir?(path: string): Promise<string[]>;
  readdirSync?(path: string): string[];
  unlink?(path: string): Promise<number>;
}

/**
 * Quando a última varredura aconteceu.
 *
 * Num lote de 164 legendas a varredura rodava 164 VEZES, lendo uma
 * pasta de centenas de arquivos a cada peça — trabalho puro jogado
 * fora, e no caminho crítico. Uma vez por minuto basta: o que ela
 * apaga tem 24 horas de idade.
 */
let sweptAt = 0;
const SWEEP_EVERY_MS = 60 * 1000;

/** Apaga do cache o que passou do prazo. Nunca lança. */
async function sweepCache(): Promise<void> {
  if (Date.now() - sweptAt < SWEEP_EVERY_MS) {
    return;
  }
  sweptAt = Date.now();
  const fs = fsModule() as unknown as ReaddirFs | null;
  if (!fs) {
    return;
  }
  try {
    const space = await workspace();
    const folder = fsPath(space, CACHE_FOLDER);
    const names = fs.readdir
      ? await fs.readdir(folder)
      : fs.readdirSync
        ? fs.readdirSync(folder)
        : [];
    const now = Date.now();
    for (const name of names ?? []) {
      // O carimbo de tempo está no nome: o `fs` do UXP não promete
      // `stat`, e assim a varredura não depende dele.
      const stamp = /-(\d{13})-/.exec(name);
      if (stamp && now - Number(stamp[1]) > CACHE_TTL_MS && fs.unlink) {
        await fs.unlink(`${folder}/${name}`).catch(() => undefined);
      }
    }
  } catch {
    /* sem cache ainda, ou sem permissão: nada a varrer */
  }
}

/**
 * Gera a cópia com a frase e devolve onde ela ficou.
 *
 * O nome do arquivo carrega o modelo, o instante e um sufixo aleatório:
 * duas legendas iguais no mesmo milissegundo não se atropelam.
 */
export async function prepareMogrt(
  template: LoadedTemplate,
  patch: DefinitionPatch
): Promise<PreparedMogrt> {
  const patched = patchDefinition(template.definition, patch);
  const bytes = rewriteMogrt(template.zip, patched.json);

  const space = await workspace();
  await ensureDir(space, CACHE_FOLDER);
  await sweepCache();

  const stamp = Date.now();
  const salt = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  const file = `${CACHE_FOLDER}/${slugFor(template.name)}-${stamp}-${salt}.mogrt`;
  writeWorkBytes(space, file, bytes);

  return {
    path: nativePath(space, file),
    capsuleName: patched.capsuleName,
    textApplied: patched.textApplied,
    fontApplied: patched.fontApplied,
    sizeApplied: patched.sizeApplied,
    textFields: patched.textFields,
    parts: patched.parts,
    bytes: bytes.length,
  };
}

/** O patch a partir do que o painel pede. */
export function patchFor(text: string, style?: TextStyle): DefinitionPatch {
  return { text, font: style?.font || undefined, size: style?.size || undefined };
}
