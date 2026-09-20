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
  describe,
  fsModule,
  fileUrl,
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

interface UxpLocalFileSystem {
  getFileForOpening(options?: {
    types?: string[];
    allowMultiple?: boolean;
  }): Promise<UxpFileEntry | UxpFileEntry[] | null>;
  getEntryWithUrl?(url: string): Promise<UxpFileEntry>;
}

interface UxpStorage {
  localFileSystem?: UxpLocalFileSystem;
}

function localFs(): UxpLocalFileSystem | null {
  return uxpModule<{ storage?: UxpStorage }>("uxp")?.storage?.localFileSystem ?? null;
}

/**
 * O seletor do sistema. A porta que sempre existe.
 *
 * ── Por que o filtro tem duas tentativas ───────────────────────────
 * `types` é uma lista de EXTENSÕES, sem ponto. A versão anterior
 * mandava `["srt", ".srt", "vtt", ".vtt"]` achando que passar as duas
 * formas não custava nada — custa: um item inválido faz parte das
 * builds recusarem o filtro inteiro, e aí o diálogo NEM ABRE. O botão
 * "Importar arquivo…" ficava mudo, sem erro nenhum para explicar.
 *
 * Então: filtro limpo primeiro e, se ele não abrir nada, o seletor SEM
 * filtro. Escolher um arquivo errado dá uma mensagem clara na leitura;
 * um botão que não faz nada não dá nada.
 */
export async function pickSrtFile(): Promise<SrtSource | null> {
  const lfs = localFs();
  if (!lfs?.getFileForOpening) {
    throw new Error("este build do Premiere não expõe o seletor de arquivos do UXP");
  }

  let entrada: UxpFileEntry | null = null;
  let primeiraFalha: unknown = null;
  const tentativas: { types?: string[] }[] = [{ types: ["srt", "vtt"] }, {}];

  for (const opcoes of tentativas) {
    try {
      const escolhido = await lfs.getFileForOpening(opcoes);
      entrada = (Array.isArray(escolhido) ? escolhido[0] : escolhido) ?? null;
      // Escolha feita, ou cancelamento na chamada SEM filtro: nos dois
      // casos não há mais o que tentar.
      if (entrada || !opcoes.types) break;
    } catch (cause) {
      primeiraFalha = primeiraFalha ?? cause;
    }
  }

  if (!entrada) {
    if (primeiraFalha) {
      throw new Error(`o seletor de arquivos não abriu (${describe(primeiraFalha)})`);
    }
    return null;
  }

  return {
    name: entrada.name,
    nativePath: entrada.nativePath ?? null,
    text: String(await entrada.read()),
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
 * `file:` URL de um caminho nativo, com cada segmento escapado.
 *
 * É a mesma forma que o download já usa para achar a pasta de destino
 * — a rota `getEntryWithUrl` só resolve com o caminho ESCAPADO, e uma
 * legenda que more numa pasta com espaço ou acento é a regra, não a
 * exceção.
 */
/**
 * Traz para dentro um .srt que está em qualquer lugar do disco.
 *
 * ── Por que há três rotas, nesta ordem ─────────────────────────────
 * A versão anterior tinha UMA: escrever um `cp` e mandar o assistente
 * executá-lo. Funcionava no papel e falhava na mão do editor — todo
 * tropeço (assistente não autorizado nesta sessão, consentimento
 * recusado, `cp` sem permissão na pasta) chegava como a mesma frase,
 * "não consegui ler esse arquivo — ele ainda está no lugar?", que
 * acusa o arquivo por um problema que nunca foi dele.
 *
 * E era um caminho longo demais para a tarefa: ler um arquivo de
 * texto de alguns kB não precisa de processo externo nenhum. O UXP lê
 * caminho nativo por `getEntryWithUrl` — é a rota que o download já
 * usa, e ela não pede consentimento nem deixa lixo na pasta.
 *
 *   1. `getEntryWithUrl` + `read()` — direto, instantâneo, sem shell;
 *   2. o `fs` do UXP, para a build que atender a rota `file:`;
 *   3. o `cp` pelo assistente — a rede de segurança de antes, agora
 *      com o erro REAL do `cp` no texto em vez de um palpite.
 */
export async function readAnyPath(nativePath: string): Promise<string> {
  const falhas: string[] = [];

  // 1. A porta do próprio UXP.
  const lfs = localFs();
  if (typeof lfs?.getEntryWithUrl === "function") {
    for (const alvo of [fileUrl(nativePath), nativePath]) {
      try {
        const entrada = await lfs.getEntryWithUrl(alvo);
        const texto = String(await entrada.read());
        if (texto.trim()) return texto;
        falhas.push("getEntryWithUrl: veio vazio");
      } catch (cause) {
        falhas.push(`getEntryWithUrl: ${describe(cause)}`);
      }
    }
  } else {
    falhas.push("getEntryWithUrl: ausente");
  }

  // 2. O `fs`, para quem atender a rota.
  const fs = fsModule();
  if (fs) {
    for (const alvo of [nativePath, fileUrl(nativePath)]) {
      try {
        const texto = String(fs.readFileSync(alvo, { encoding: "utf-8" }));
        if (texto.trim()) return texto;
      } catch (cause) {
        falhas.push(`fs: ${describe(cause)}`);
      }
    }
  }

  // 3. O assistente, com `cp`. Último recurso.
  return await copyViaAgent(nativePath, falhas);
}

async function copyViaAgent(nativePath: string, falhas: string[]): Promise<string> {
  const resumo = falhas.length ? ` (${falhas.join(" · ")})` : "";
  const space = await workspace();
  for (const nome of [COPY_OUT, COPY_DONE]) {
    await remove(space, nome);
  }

  // O erro do `cp` vai para o arquivo de estado junto com "falhou":
  // "Operation not permitted" e "No such file or directory" pedem
  // providências opostas do editor, e a mensagem antiga escondia as
  // duas atrás da mesma pergunta.
  const script = [
    "#!/bin/bash",
    "# Gerado pelo Framelab — traz a legenda para dentro. Pode apagar.",
    "set -u",
    `WORK=${shellQuote(space.nativeBase)}`,
    `if ERR=$(cp ${shellQuote(nativePath)} "$WORK/${COPY_OUT}" 2>&1); then`,
    `  printf ok > "$WORK/${COPY_DONE}"`,
    "else",
    `  printf 'falhou %s' "$ERR" > "$WORK/${COPY_DONE}"`,
    "fi",
    "",
  ].join("\n");
  await write(space, COPY_SCRIPT, script, true);

  const enviado = await dispatch(COPY_SCRIPT);
  if (enviado.mode === "denied") {
    throw new Error(
      `o assistente não pôde ser iniciado para ler o arquivo${resumo}`
    );
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
    if (estado?.startsWith("falhou")) {
      const motivo = estado.slice("falhou".length).trim();
      throw new Error(
        motivo
          ? `não consegui ler esse arquivo: ${motivo}`
          : `não consegui ler esse arquivo${resumo}`
      );
    }
    await wait(200);
  }
  await withdraw(enviado.ticket);
  throw new Error(`a leitura do arquivo passou do tempo${resumo}`);
}
