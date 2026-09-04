/**
 * De onde vem o .srt.
 *
 * ── As três portas, e por que são três ─────────────────────────────
 * O editor pediu três portas: importar, arrastar do Finder e arrastar
 * do projeto. Sobraram duas — e a segunda ficou melhor que o arrasto.
 *
 * O arrasto do Finder foi tentado e o Premiere não entrega o evento
 * ao painel — a documentação da Adobe já dizia que arrastar de fora
 * "não é suportado", e o teste confirmou. Saiu.
 *
 * Arrastar de dentro do PROJETO nunca teve chance: um item de projeto
 * não é um arquivo do sistema, e o painel não recebe esse arrasto de
 * jeito nenhum. Em troca há algo melhor e certo — ler o projeto e
 * listar os .srt que já estão nele. Dois cliques em vez de um arrasto,
 * mas funciona sempre, e ainda encontra legenda que o editor esqueceu
 * onde guardou.
 */
import type { premierepro } from "@adobe/premierepro";
import { getPremiere } from "../../bridge/premiere";
import {
  readText,
  remove,
  shellQuote,
  uxpModule,
  wait,
  workspace,
  write,
} from "../silence/workspace";
import { dispatch, withdraw } from "../download/runner";

/** Um .srt achado em algum lugar. */
export interface SrtSource {
  /** O que aparece na tela. */
  name: string;
  /** Caminho nativo, quando existe (arquivo do disco). */
  nativePath: string | null;
  /** O conteúdo, já lido. */
  text: string;
}

interface UxpFileEntry {
  name: string;
  nativePath?: string;
  read(options?: { format?: unknown }): Promise<string>;
}

interface UxpStorage {
  localFileSystem?: {
    getFileForOpening(options: {
      types?: string[];
      allowMultiple?: boolean;
    }): Promise<UxpFileEntry | UxpFileEntry[] | null>;
  };
}

/** O seletor do sistema. A porta que sempre existe. */
export async function pickSrtFile(): Promise<SrtSource | null> {
  const storage = uxpModule<{ storage?: UxpStorage }>("uxp")?.storage;
  const lfs = storage?.localFileSystem;
  if (!lfs?.getFileForOpening) {
    throw new Error("Este build do Premiere não expõe o seletor de arquivos do UXP.");
  }
  // `srt` sem ponto e `.srt` com ponto: hosts diferentes aceitam
  // formas diferentes, e passar as duas não custa nada.
  const escolhido = await lfs.getFileForOpening({ types: ["srt", ".srt", "vtt", ".vtt"] });
  const entrada = Array.isArray(escolhido) ? escolhido[0] : escolhido;
  if (!entrada) {
    return null;
  }
  return {
    name: entrada.name,
    nativePath: entrada.nativePath ?? null,
    text: await entrada.read(),
  };
}

/**
 * Os .srt que já estão no projeto aberto.
 *
 * Percorre as pastas por completo — legenda costuma estar enterrada
 * numa bin, e listar só a raiz acharia pouco.
 */
export async function findSrtInProject(): Promise<
  { name: string; path: string }[]
> {
  const ppro = getPremiere();
  if (!ppro) return [];
  // Preso numa constante não-nula: o TypeScript perde a checagem de
  // cima dentro da função aninhada.
  const api = ppro;
  const project = await api.Project.getActiveProject();
  if (!project) return [];

  const achados: { name: string; path: string }[] = [];
  const vistos = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function descer(pasta: any, profundidade: number): Promise<void> {
    // Projeto com bins aninhadas em excesso não trava o painel.
    if (profundidade > 8) return;
    let itens: unknown[] = [];
    try {
      itens = await pasta.getItems();
    } catch {
      return;
    }
    for (const item of itens) {
      try {
        const comoPasta = tentarPasta(api, item);
        if (comoPasta) {
          await descer(comoPasta, profundidade + 1);
          continue;
        }
        const clipe = api.ClipProjectItem.cast(item as never);
        const caminho = await clipe.getMediaFilePath().catch(() => "");
        if (caminho && /\.(srt|vtt)$/i.test(caminho) && !vistos.has(caminho)) {
          vistos.add(caminho);
          const nome =
            (item as { name?: string }).name ?? caminho.split("/").pop() ?? caminho;
          achados.push({ name: nome, path: caminho });
        }
      } catch {
        // Item que não é clipe nem pasta: segue o baile.
      }
    }
  }

  try {
    await descer(await project.getRootItem(), 0);
  } catch {
    return achados;
  }
  return achados;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tentarPasta(ppro: premierepro, item: unknown): any | null {
  try {
    const pasta = ppro.FolderItem.cast(item as never);
    // `cast` devolve objeto mesmo para não-pasta em alguns builds; o
    // que separa de verdade é responder a `getItems`.
    return pasta && typeof (pasta as { getItems?: unknown }).getItems === "function"
      ? pasta
      : null;
  } catch {
    return null;
  }
}

// ── ler um arquivo que não é nosso ─────────────────────────────────

const COPY_SCRIPT = "translate-copy.command";
const COPY_OUT = "tr-input.srt";
const COPY_DONE = "tr-copy-done.txt";

/**
 * Traz para dentro um .srt que está em qualquer lugar do disco.
 *
 * O `fs` do UXP no Premiere NÃO abre caminho nativo — está escrito e
 * medido em `workspace.ts`, e é por isso que a pasta de trabalho tem
 * dois endereços. Um .srt achado no projeto, ou largado num arrasto,
 * chega justamente como caminho nativo.
 *
 * A saída é o assistente que já está de pé para as outras ferramentas:
 * ele copia o arquivo para a pasta do plugin, e daí o `fs` lê pela
 * rota que funciona. Uma linha de `cp` reaproveitando máquina pronta,
 * em vez de uma segunda forma de ler arquivo.
 */
export async function readAnyPath(nativePath: string): Promise<string> {
  const space = await workspace();
  for (const nome of [COPY_OUT, COPY_DONE]) {
    await remove(space, nome);
  }

  const script = [
    "#!/bin/bash",
    "# Gerado pelo Framelab — traz a legenda para dentro. Pode apagar.",
    "set -u",
    `WORK=${shellQuote(space.nativeBase)}`,
    `if cp ${shellQuote(nativePath)} "$WORK/${COPY_OUT}" 2>/dev/null; then`,
    `  printf ok > "$WORK/${COPY_DONE}"`,
    "else",
    `  printf falhou > "$WORK/${COPY_DONE}"`,
    "fi",
    "",
  ].join("\n");
  await write(space, COPY_SCRIPT, script, true);

  const enviado = await dispatch(COPY_SCRIPT);
  if (enviado.mode === "denied") {
    throw new Error("o assistente não pôde ser iniciado para ler o arquivo");
  }

  // Copiar um .srt é instantâneo; o teto de 15s é só para não esperar
  // para sempre se o assistente morrer no meio.
  const limite = Date.now() + 15_000;
  while (Date.now() < limite) {
    const estado = readText(space, COPY_DONE);
    if (estado === "ok") {
      const texto = readText(space, COPY_OUT);
      if (texto) return texto;
      throw new Error("o arquivo foi copiado mas veio vazio");
    }
    if (estado === "falhou") {
      throw new Error("não consegui ler esse arquivo — ele ainda está no lugar?");
    }
    await wait(200);
  }
  await withdraw(enviado.ticket);
  throw new Error("a leitura do arquivo passou do tempo");
}
