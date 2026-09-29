/**
 * A prateleira de modelos — os `.mogrt` que o painel sabe inserir.
 *
 * ── Por que ler uma PASTA, e não embutir os modelos ────────────────
 * Um `.mogrt` é um projeto do After Effects empacotado (definition.json
 * + project.aegraphic + miniatura), e quem faz a animação é o motion
 * designer, não o plugin. Embutir uma coleção fixa no build envelhecia
 * junto com o build: modelo novo exigiria versão nova do Framelab.
 * Apontando para uma pasta, o editor larga um arquivo lá e ele aparece
 * na lista na próxima vez que abrir a ferramenta.
 *
 * ── O que o painel NÃO faz ─────────────────────────────────────────
 * Não abre o pacote. O nome na lista é o nome do arquivo, e os
 * parâmetros (texto, cor, posição) só são descobertos depois que o
 * modelo está na timeline — é lá que o Premiere os expõe, e é de lá
 * que vem a verdade. Ler o ZIP daqui exigiria um descompactador em
 * JavaScript para responder o que o host responde de graça.
 */
import { uxpModule } from "../silence/workspace";

export interface TitleTemplate {
  /** Caminho nativo, que é o que o Premiere aceita. */
  readonly path: string;
  /** O que aparece na lista: o nome do arquivo, sem a extensão. */
  readonly name: string;
}

/**
 * Onde os modelos costumam estar.
 *
 * A pasta do Editor Black Belt é o palpite inicial porque é onde a
 * coleção já existe nesta casa; o editor pode apontar outra, e a
 * escolha fica gravada.
 */
export function defaultLibrary(): string {
  const home = uxpModule<{ homedir(): string }>("os")?.homedir?.() ?? "";
  return home ? `${home}/Documents/Editor Black Belt/Titulos` : "";
}

export function isMogrt(fileName: string): boolean {
  return /\.mogrt$/i.test(fileName);
}

/** "SMOOTH BOUNCE.mogrt" → "SMOOTH BOUNCE". */
export function templateName(fileName: string): string {
  return fileName.replace(/\.mogrt$/i, "").trim() || fileName;
}

/** Só o nome do arquivo, de um caminho de qualquer sistema. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Monta a lista a partir dos nomes de arquivo de uma pasta.
 *
 * Separado da leitura de disco de propósito: a ordenação e o filtro
 * são as duas regras que têm como errar, e assim elas se provam sem
 * host e sem UXP.
 */
export function templatesFrom(
  folder: string,
  fileNames: readonly string[]
): TitleTemplate[] {
  const base = folder.replace(/[\\/]+$/, "");
  return fileNames
    .filter(isMogrt)
    .map((fileName) => ({ path: `${base}/${fileName}`, name: templateName(fileName) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

/** O `fs` do UXP tem leitura de pasta; o typings do plugin não a citava. */
interface ReaddirFs {
  readdir?(path: string): Promise<string[]>;
  readdirSync?(path: string): string[];
}

/**
 * Os modelos de uma pasta, pelo caminho nativo.
 *
 * Devolve lista vazia em vez de lançar: pasta inexistente, sem
 * permissão ou host que roteia `fs` por esquema são todos o mesmo
 * caso para quem chama — não há modelos por aqui, ofereça o seletor.
 */
export async function listTemplates(folder: string): Promise<TitleTemplate[]> {
  if (!folder) {
    return [];
  }
  const fs = uxpModule<ReaddirFs>("fs");
  if (!fs) {
    return [];
  }
  try {
    const names = fs.readdir
      ? await fs.readdir(folder)
      : fs.readdirSync
        ? fs.readdirSync(folder)
        : [];
    return templatesFrom(folder, names ?? []);
  } catch (cause) {
    console.warn("[Textos] não consegui ler a pasta de modelos:", cause);
    return [];
  }
}

/** Uma entrada de pasta do seletor nativo, no mínimo que importa aqui. */
interface FolderEntry {
  name?: string;
  nativePath?: string;
  isFile?: boolean;
  getEntries?(): Promise<FolderEntry[]>;
}

/**
 * O mesmo, a partir da pasta que o editor escolheu no diálogo nativo.
 *
 * É o plano B de `listTemplates`: builds em que o `fs` do UXP recusa
 * caminho nativo ainda entregam as entradas por aqui, porque o
 * diálogo concede o acesso junto com a escolha.
 */
export async function templatesFromEntry(
  folder: FolderEntry
): Promise<TitleTemplate[]> {
  const entries = (await folder.getEntries?.()) ?? [];
  const found: TitleTemplate[] = [];
  for (const entry of entries) {
    const name = entry?.name ?? "";
    const path = entry?.nativePath ?? "";
    if (name && path && isMogrt(name)) {
      found.push({ path, name: templateName(name) });
    }
  }
  return found.sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" })
  );
}

/**
 * O texto como o modelo espera receber.
 *
 * A quebra de linha de um texto do After Effects é RETORNO DE CARRO,
 * não `\n` — o valor de fábrica do modelo que serviu de referência é
 * literalmente "smooth\rbounce". Mandar `\n` punha as duas linhas
 * numa só.
 */
export function textForMogrt(text: string): string {
  return text.replace(/\r\n?|\n/g, "\r").trim();
}
