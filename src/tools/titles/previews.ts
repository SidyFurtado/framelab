/**
 * As prévias — ver a animação antes de pôr na timeline.
 *
 * ── Por que os arquivos já existem prontos ─────────────────────────
 * Todo `.mogrt` carrega dentro de si uma miniatura (`thumb.png`) e um
 * vídeo curto da animação (`thumb.mp4`) — quem exportou o modelo já
 * pagou esse preço. O painel não abre o pacote: um `.mogrt` é um ZIP,
 * e descompactar em JavaScript dentro do UXP seria escrever um
 * descompactador inteiro para mostrar uma imagem.
 *
 * Então as prévias vivem extraídas numa pasta de cache, ao lado dos
 * outros arquivos de trabalho do plugin: `NOME.png` é o cartaz, e
 * `NOME.f01.png` … `NOME.f12.png` são os quadros que, passados em
 * sequência, mostram a animação acontecendo. Doze quadros a oito por
 * segundo é um segundo e meio de laço — o bastante para reconhecer o
 * movimento, e leve o bastante para caber num painel.
 *
 * ── Por que `data:` e não `file://` ────────────────────────────────
 * Porque o `<img>` do UXP não carrega de todo esquema, e um cartaz que
 * não aparece é pior que nenhum. Os bytes entram no HTML já embutidos:
 * são poucos quilobytes por imagem, e o que se ganha é uma prévia que
 * funciona em qualquer build.
 */
import { readText, workspace, write, type Workspace } from "../silence/workspace";
import { lastReadNote, readWorkBytes } from "./bytes";

/** A pasta de cache, dentro da pasta de trabalho do plugin. */
export const PREVIEW_FOLDER = "title-previews";

/**
 * O TETO de quadros de um laço, não a conta certa.
 *
 * Cada modelo tem a duração da animação dele: as legendas do BB
 * resolvem em sete quadros, um título elaborado usa trinta. A leitura
 * para no primeiro quadro que falta, então o teto só evita procurar
 * para sempre.
 */
export const FRAME_COUNT = 30;

/** 12 quadros por segundo: o mesmo passo com que eles foram extraídos. */
export const FRAME_MS = 83;

/**
 * O nome do modelo virando nome de ARQUIVO seguro.
 *
 * ── Por que isto existe ───────────────────────────────────────────
 * "CLEAN STYLE.png" não carregava. Todo modelo da coleção tem espaço
 * no nome, e o `fs` do UXP trata o caminho como URL: o espaço cru
 * derruba a leitura, a prévia cai no `file://` — que o painel não
 * renderiza — e a grade inteira fica preta. Medido na tela do editor,
 * com trinta e cinco modelos e nenhuma imagem.
 *
 * Então o cache não usa o nome: usa a forma sem acento, sem espaço e
 * sem maiúscula dele. A MESMA regra roda na extração e aqui, senão o
 * painel procura um arquivo que ninguém escreveu.
 */
export function slugFor(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "modelo"
  );
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 escrito à mão.
 *
 * O `btoa` existe em alguns builds do UXP e não em outros, e uma
 * prévia que aparece só em metade das instalações não é prévia. São
 * vinte linhas para não depender disso.
 */
function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const has2 = b !== undefined;
    const has3 = c !== undefined;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 3) << 4) | (has2 ? b >> 4 : 0)];
    out += has2 ? ALPHABET[((b & 15) << 2) | (has3 ? c >> 6 : 0)] : "=";
    out += has3 ? ALPHABET[c & 63] : "=";
  }
  return out;
}

/**
 * A imagem pronta para o `src` de um `<img>`.
 *
 * Duas portas, e não uma por elegância: a leitura binária do `fs` do
 * UXP não existe em todo build, e quando ela falha o `file://` do
 * caminho nativo ainda costuma carregar. Uma prévia que aparece só em
 * metade das instalações não é prévia — então tenta embutir os bytes
 * e, se não der, aponta para o arquivo.
 */
async function readImage(
  space: Workspace,
  relative: string
): Promise<string | null> {
  const bytes = await readWorkBytes(space, relative);
  if (bytes && bytes.length > 0) {
    return `data:image/png;base64,${toBase64(bytes)}`;
  }
  // Sem plano B por `file://` de propósito. Ele não desenha dentro do
  // painel, e pior: devolvia endereço para arquivo que NÃO EXISTE, o
  // que fazia o laço de quadros achar trinta prévias onde havia sete.
  // O relatório em disco diz onde a leitura parou; é dele que sai o
  // conserto, não de um endereço que finge ter funcionado.
  return null;
}

/** O que cada modelo traz de fábrica: fonte, corpo e quantos campos de texto tem. */
export interface TemplateStyle {
  readonly fonte: string | null;
  readonly corpo: number | null;
  /**
   * Quantos controles de texto o modelo expõe.
   *
   * Dois ou mais mudam o que o editor precisa escrever — uma linha
   * por campo — e é melhor ele saber ANTES de aplicar. Ver o comentário
   * de `splitAcross` em definition.ts.
   */
  readonly campos: number;
}

/**
 * A tipografia de fábrica de cada modelo, do cache.
 *
 * Vem do mesmo lugar que as miniaturas: o `definition.json` de dentro
 * do `.mogrt`, lido na hora de gerar as prévias. Sem isso o painel só
 * descobriria a fonte do modelo DEPOIS de inserir — tarde demais para
 * oferecer a escolha.
 */
export async function readTemplateStyles(): Promise<Map<string, TemplateStyle>> {
  const styles = new Map<string, TemplateStyle>();
  try {
    const raw = readText(await workspace(), `${PREVIEW_FOLDER}/index.json`);
    if (!raw) {
      return styles;
    }
    const parsed = JSON.parse(raw) as Record<
      string,
      { fonte?: unknown; corpo?: unknown; campos?: unknown }
    >;
    for (const [name, entry] of Object.entries(parsed ?? {})) {
      styles.set(name, {
        fonte: typeof entry?.fonte === "string" ? entry.fonte : null,
        corpo: typeof entry?.corpo === "number" ? entry.corpo : null,
        campos: typeof entry?.campos === "number" && entry.campos > 0 ? entry.campos : 1,
      });
    }
  } catch (cause) {
    console.warn("[Textos] índice de modelos ilegível:", cause);
  }
  return styles;
}

/** O cartaz de um modelo, ou null quando ainda não há prévia dele. */
export async function posterFor(name: string): Promise<string | null> {
  try {
    return await readImage(await workspace(), `${PREVIEW_FOLDER}/${slugFor(name)}.png`);
  } catch {
    return null;
  }
}

/**
 * Os cartazes de vários modelos, numa passada.
 *
 * O que não tiver prévia fica de fora do mapa — a grade desenha o
 * nome sozinho, que é melhor que um buraco.
 */
export async function postersFor(
  names: readonly string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let space: Workspace;
  try {
    space = await workspace();
  } catch {
    return found;
  }
  for (const name of names) {
    const poster = await readImage(space, `${PREVIEW_FOLDER}/${slugFor(name)}.png`);
    if (poster) {
      found.set(name, poster);
    }
  }
  // O porquê de uma grade preta não pode morar só no console do UXP:
  // ele mora dentro do Premiere, e chegar até ele custa uma tarde.
  await write(
    space,
    "previews-diag.txt",
    [
      `Framelab — prévias · ${new Date().toISOString()}`,
      `pasta fs: ${space.fsBase}`,
      `pasta nativa: ${space.nativeBase}`,
      `modelos: ${names.length} · cartazes: ${found.size}`,
      `última leitura: ${lastReadNote() || "(nada tentado)"}`,
      names.length > 0
        ? `exemplo: ${PREVIEW_FOLDER}/${slugFor(names[0])}.png`
        : "",
    ].join("\n") + "\n"
  ).catch(() => undefined);
  return found;
}

/**
 * Os quadros do laço de um modelo.
 *
 * Carregados só quando o editor escolhe aquele modelo: doze imagens
 * por modelo, vezes vinte modelos, seria megabytes de base64 montados
 * de uma vez para mostrar um.
 */
export async function framesFor(name: string): Promise<string[]> {
  let space: Workspace;
  try {
    space = await workspace();
  } catch {
    return [];
  }
  const frames: string[] = [];
  const slug = slugFor(name);
  for (let index = 1; index <= FRAME_COUNT; index += 1) {
    const file = `${PREVIEW_FOLDER}/${slug}.f${String(index).padStart(2, "0")}.png`;
    const frame = await readImage(space, file);
    if (!frame) {
      break;
    }
    frames.push(frame);
  }
  return frames;
}
