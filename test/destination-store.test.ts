/**
 * A pasta guardada — os quatro critérios de aceite do vazamento.
 *
 * A tabela de grupos já é testada em `destination.test.ts`: ela diz
 * quem DEVERIA dividir pasta com quem. Este arquivo testa a outra
 * metade, que é onde a queixa nasceu: o caminho de ida e volta até o
 * disco. Escolher no Efeitos Sonoros mudava a pasta do Baixar porque
 * ninguém guardava POR GRUPO — e um teste de tabela não teria visto
 * isso, porque a tabela estava certa e o armazenamento é que não era.
 *
 * "Fechar e reabrir o Premiere" aqui é `forgetDestinations()`: o painel
 * recarrega, o cache do módulo morre, o arquivo no disco fica. É
 * exatamente o que o critério 1 pede que sobreviva.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

/** O disco de mentira: um Map, e nada mais. */
const disk = new Map<string, string>();

const fakeFs = {
  mkdir: async () => 0,
  writeFileSync(path: string, data: string): number {
    disk.set(path, String(data));
    return 1;
  },
  async writeFile(path: string, data: string): Promise<number> {
    disk.set(path, String(data));
    return 1;
  },
  readFileSync(path: string): string {
    const held = disk.get(path);
    if (held === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return held;
  },
  async unlink(path: string): Promise<number> {
    disk.delete(path);
    return 1;
  },
};

const fakeUxp = {
  storage: {
    localFileSystem: {
      getDataFolder: async () => ({ nativePath: "/Users/sidy/Library/Fake/Framelab" }),
    },
  },
};

// `uxpModule` consulta `require` global em tempo de chamada, então basta
// instalá-lo antes do primeiro uso — não antes do import.
(globalThis as Record<string, unknown>).require = (name: string): unknown => {
  if (name === "fs") return fakeFs;
  if (name === "uxp") return fakeUxp;
  if (name === "os") return { platform: () => "darwin", homedir: () => "/Users/sidy" };
  throw new Error(`módulo não fingido: ${name}`);
};

const { readDestination, saveDestination, forgetDestinations, destinationOf } = await import(
  "../src/bridge/destination.ts"
);

/** Uma pasta por ferramenta, e uma delas com o espaço fatal no fim. */
const A = "/Volumes/Drive/Baixar dos clientes ";
const B = "/Volumes/Drive/Exportar/Legendas";
const C = "/Volumes/Drive/Biblioteca de SFX";
const D = "/Volumes/Drive/Outros sons 🎬";
const T = "/Volumes/Drive/Textos";

/** Fecha e reabre o Premiere: o cache some, o arquivo fica. */
function reopenPremiere(): void {
  forgetDestinations();
}

async function pathOf(tool: Parameters<typeof readDestination>[0]): Promise<string | null> {
  return (await readDestination(tool))?.path ?? null;
}

describe("a pasta guardada não vaza entre ferramentas", () => {
  before(() => {
    disk.clear();
    forgetDestinations();
  });

  beforeEach(() => {
    forgetDestinations();
  });

  it("1. Baixar e Legendas mantêm cada um a sua, mesmo depois de reabrir", async () => {
    await saveDestination("download", destinationOf(A));
    await saveDestination("captions", destinationOf(B));

    assert.equal(await pathOf("download"), A);
    assert.equal(await pathOf("captions"), B);

    reopenPremiere();

    assert.equal(await pathOf("download"), A, "o Baixar esqueceu a pasta ao reabrir");
    assert.equal(await pathOf("captions"), B, "o Legendas esqueceu a pasta ao reabrir");
  });

  it("1b. o espaço final sobrevive à ida e volta pelo arquivo", async () => {
    await saveDestination("download", destinationOf(A));
    reopenPremiere();
    const back = await pathOf("download");
    assert.equal(back, A);
    assert.ok(back?.endsWith(" "), "o espaço final foi comido pelo armazenamento");
  });

  it("2. escolher no Efeitos Sonoros vale no SFX Automático", async () => {
    await saveDestination("sfx", destinationOf(C));
    assert.equal(await pathOf("soundDesign"), C);
    reopenPremiere();
    assert.equal(await pathOf("soundDesign"), C);
  });

  it("3. escolher no SFX Automático vale no Efeitos Sonoros", async () => {
    await saveDestination("soundDesign", destinationOf(D));
    assert.equal(await pathOf("sfx"), D);
    reopenPremiere();
    assert.equal(await pathOf("sfx"), D);
  });

  it("4. nada disso encosta na pasta das outras ferramentas", async () => {
    await saveDestination("download", destinationOf(A));
    await saveDestination("captions", destinationOf(B));
    await saveDestination("titles", destinationOf(T));

    await saveDestination("sfx", destinationOf(C));
    await saveDestination("soundDesign", destinationOf(D));

    reopenPremiere();

    assert.equal(await pathOf("download"), A, "o par de áudio arrastou o Baixar");
    assert.equal(await pathOf("captions"), B, "o par de áudio arrastou o Legendas");
    assert.equal(await pathOf("titles"), T, "o par de áudio arrastou os Textos");
  });

  it("o token viaja junto do caminho, por grupo", async () => {
    await saveDestination("download", destinationOf(A, "token-do-baixar"));
    await saveDestination("sfx", destinationOf(C, "token-do-sfx"));
    reopenPremiere();

    assert.equal((await readDestination("download"))?.token, "token-do-baixar");
    assert.equal((await readDestination("soundDesign"))?.token, "token-do-sfx");
  });

  it("o valor antigo da ferramenta é adotado uma vez, e não atropela o do grupo", async () => {
    disk.clear();
    forgetDestinations();

    const legacy = destinationOf("/Volumes/Drive/pasta antiga do config ");
    assert.equal((await readDestination("download", legacy))?.path, legacy.path);

    // Já adotado: uma escolha nova manda, e o legado não volta.
    await saveDestination("download", destinationOf(A));
    reopenPremiere();
    assert.equal((await readDestination("download", legacy))?.path, A);
  });
});
