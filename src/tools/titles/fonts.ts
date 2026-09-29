/**
 * As fontes instaladas, para escolher antes de aplicar.
 *
 * ── Por que os NOMES DE ARQUIVO ───────────────────────────────────
 * O modelo guarda a fonte pelo nome PostScript ("Montserrat-ExtraBold"),
 * e não existe API no UXP nem no premierepro que liste as fontes do
 * sistema. O que dá para ler é a PASTA delas — e, nas fontes que um
 * editor instala (Google Fonts, pacotes de motion), o nome do arquivo
 * É o nome PostScript: `Montserrat-ExtraBold.ttf`.
 *
 * Por isso a lista aqui é SUGESTÃO, nunca verdade. O campo do painel
 * continua aceitando texto livre — e isso não é detalhe: na primeira
 * versão a lista voltou vazia na mão do editor e, como só havia o
 * menu, ele ficou sem nenhuma forma de trocar a fonte.
 *
 * ── Três portas para a mesma pasta ────────────────────────────────
 * O `fs` do UXP roteia por ESQUEMA, e caminho nativo cai fora da rota
 * em parte das builds — é a mesma pedra que o Baixar Vídeos e o
 * Traduzir Legenda já levaram. Então: caminho cru, `file:` e, por
 * último, o `getEntryWithUrl` do próprio UXP, que é a rota que a
 * tradução usa para ler legenda de qualquer lugar do disco.
 */
import { fileUrl, isWindows, uxpModule } from "../silence/workspace";

interface ReaddirFs {
  readdir?(path: string): Promise<string[]>;
  readdirSync?(path: string): string[];
}

interface FolderEntry {
  name?: string;
  isFile?: boolean;
  getEntries?(): Promise<FolderEntry[]>;
}

interface LocalFs {
  getEntryWithUrl?(url: string): Promise<FolderEntry>;
}

function localFs(): LocalFs | null {
  return (
    uxpModule<{ storage?: { localFileSystem?: LocalFs } }>("uxp")?.storage
      ?.localFileSystem ?? null
  );
}

let note = "";

/** Como foi a última varredura — para o diagnóstico em disco. */
export function lastFontNote(): string {
  return note;
}

/**
 * Onde o macOS e o Windows guardam fonte.
 *
 * `windows` vem de `isWindows()`, e não de um teste escrito aqui: a
 * primeira versão usava `/win/i` no nome da plataforma — e "darwin"
 * CONTÉM "win". O resultado foi o painel varrendo `C:\Windows\Fonts`
 * num Mac e voltando com zero fontes. O helper do projeto ancora o
 * padrão (`/^win/i`) desde sempre; era só usá-lo.
 */
export function fontFolders(home: string, windows: boolean): string[] {
  if (windows) {
    return [
      "C:\\Windows\\Fonts",
      home ? `${home}\\AppData\\Local\\Microsoft\\Windows\\Fonts` : "",
    ].filter(Boolean);
  }
  return [
    home ? `${home}/Library/Fonts` : "",
    "/Library/Fonts",
    "/System/Library/Fonts",
  ].filter(Boolean);
}

/**
 * O nome provável, a partir do arquivo.
 *
 * `.ttc` é coleção — um arquivo com várias fontes dentro, e o nome do
 * arquivo não serve para nenhuma delas. Fica de fora em vez de virar
 * sugestão errada.
 */
export function fontNamesFrom(files: readonly string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const match = /^(.+)\.(otf|ttf)$/i.exec(file.trim());
    if (match) {
      names.add(match[1]);
    }
  }
  return [...names].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { sensitivity: "base" })
  );
}

/** Os nomes de arquivo de uma pasta, pela porta que este build tiver. */
async function filesIn(folder: string): Promise<string[]> {
  const fs = uxpModule<ReaddirFs>("fs");
  if (fs) {
    for (const target of [folder, fileUrl(folder)]) {
      try {
        const found = fs.readdir
          ? await fs.readdir(target)
          : fs.readdirSync
            ? fs.readdirSync(target)
            : null;
        if (found && found.length > 0) {
          return found;
        }
      } catch (cause) {
        note += ` · readdir(${target.slice(0, 12)}…): ${String(cause).slice(0, 40)}`;
      }
    }
  }
  const lfs = localFs();
  if (typeof lfs?.getEntryWithUrl === "function") {
    try {
      const entry = await lfs.getEntryWithUrl(fileUrl(folder));
      const children = (await entry.getEntries?.()) ?? [];
      return children.map((child) => child.name ?? "").filter(Boolean);
    } catch (cause) {
      note += ` · getEntryWithUrl: ${String(cause).slice(0, 40)}`;
    }
  }
  return [];
}

/** As fontes que dá para sugerir nesta máquina. Nunca lança. */
export async function listFonts(): Promise<string[]> {
  note = "";
  const home = uxpModule<{ homedir(): string }>("os")?.homedir?.() ?? "";
  const windows = isWindows();
  const files: string[] = [];
  for (const folder of fontFolders(home, windows)) {
    const found = await filesIn(folder);
    note += ` · ${folder}: ${found.length}`;
    files.push(...found);
  }
  const names = fontNamesFrom(files);
  note = `${names.length} fontes${note}`;
  return names;
}
