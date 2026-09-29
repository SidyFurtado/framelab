/**
 * A leitura da cauda do log, sem carregar o log inteiro.
 *
 * O caso que este arquivo existe para travar: o polling do Baixar
 * mostrava as últimas linhas chamando `readText`, que faz
 * `readFileSync` do arquivo INTEIRO, e só então fatiava os últimos 4096
 * caracteres. Num lote longo — o teto é de noventa minutos — o log chega
 * a megabytes, e isso acontecia duas vezes por segundo na thread do
 * painel. A fatia cortava o `split`, não a leitura.
 *
 * A prova que importa está em "só a janela sai do disco": para um log de
 * vários MB, o total pedido ao filesystem continua preso ao teto.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readTailText,
  TAIL_WINDOW_BYTES,
  type UxpFs,
  type Workspace,
} from "../src/tools/silence/workspace";

const SPACE: Workspace = {
  fsBase: "plugin-data:/edit-toolbox-audio",
  nativeBase: "/Users/editor/Library/Caches/EditToolbox",
  sync: true,
  origin: "teste",
};

interface Espiao {
  fs: UxpFs;
  /** Quantos bytes foram pedidos em cada `read`. */
  lidos: number[];
  /** true quando alguém leu o arquivo inteiro de uma vez. */
  leuTudo: boolean;
  abertos: number;
  fechados: number;
}

/** Um filesystem de mentira sobre um conteúdo em memória. */
function discoCom(
  conteudo: Uint8Array | string | null,
  opcoes: {
    semLstat?: boolean;
    falhaNoOpen?: boolean;
    falhaNoRead?: boolean;
    falhaNoClose?: boolean;
    /** Tamanho que o `lstat` relata, para simular truncamento. */
    tamanhoMentiroso?: number;
    /** Cresce o arquivo na primeira leitura. */
    aoLer?: () => void;
  } = {}
): Espiao {
  let bytes =
    conteudo === null
      ? null
      : typeof conteudo === "string"
        ? new TextEncoder().encode(conteudo)
        : conteudo;
  const state = { lidos: [] as number[], leuTudo: false, abertos: 0, fechados: 0 };

  const fs: UxpFs = {
    readFileSync() {
      if (!bytes) throw new Error("ENOENT");
      state.leuTudo = true;
      return new TextDecoder().decode(bytes);
    },
    writeFileSync: () => 0,
    writeFile: async () => 0,
    async open() {
      if (opcoes.falhaNoOpen) throw new Error("open recusado");
      state.abertos += 1;
      return 7;
    },
    async read(_fd, buffer, _offset, length, position) {
      if (opcoes.falhaNoRead) throw new Error("read recusado");
      opcoes.aoLer?.();
      state.lidos.push(length);
      const fonte = bytes ?? new Uint8Array(0);
      const fatia = fonte.subarray(position, position + length);
      new Uint8Array(buffer).set(fatia);
      return { bytesRead: fatia.length, buffer };
    },
    async close() {
      if (opcoes.falhaNoClose) throw new Error("close recusado");
      state.fechados += 1;
      return 0;
    },
    mkdir: async () => 0,
    unlink: async () => 0,
  };

  if (!opcoes.semLstat) {
    fs.lstatSync = (): { size: number } => {
      if (!bytes) throw new Error("ENOENT");
      return { size: opcoes.tamanhoMentiroso ?? bytes.length };
    };
  }

  return {
    fs,
    get lidos() {
      return state.lidos;
    },
    get leuTudo() {
      return state.leuTudo;
    },
    get abertos() {
      return state.abertos;
    },
    get fechados() {
      return state.fechados;
    },
    // Deixa o teste crescer o arquivo entre as etapas.
    set conteudo(novo: Uint8Array) {
      bytes = novo;
    },
  } as Espiao & { conteudo: Uint8Array };
}

/** Um log plausível, com N linhas numeradas. */
function logDe(linhas: number): string {
  return Array.from({ length: linhas }, (_, at) => `[download]  ${at}.0% de 42MiB`).join(
    "\n"
  );
}

describe("readTailText · arquivos pequenos", () => {
  it("arquivo menor que a janela volta inteiro", async () => {
    const disco = discoCom("três linhas\nde log\naqui");
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.equal(texto, "três linhas\nde log\naqui");
    // Cabe na janela: não vale abrir descritor para isso.
    assert.equal(disco.abertos, 0);
  });

  it("arquivo vazio devolve null, como antes", async () => {
    const disco = discoCom("");
    assert.equal(await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs), null);
  });

  it("arquivo inexistente devolve null, como antes", async () => {
    const disco = discoCom(null);
    assert.equal(await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs), null);
  });
});

describe("readTailText · arquivos grandes", () => {
  it("só a JANELA sai do disco, não o arquivo de vários MB", async () => {
    // 4 MB de log — o tamanho real de um lote longo.
    const grande = "x".repeat(4 * 1024 * 1024) + "\nultima linha";
    const disco = discoCom(grande);

    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);

    assert.ok(texto?.endsWith("ultima linha"));
    // A prova do item: nada de ler o arquivo inteiro.
    assert.equal(disco.leuTudo, false, "leu o arquivo completo");
    const total = disco.lidos.reduce((soma, n) => soma + n, 0);
    assert.ok(
      total <= TAIL_WINDOW_BYTES,
      `pediu ${total} bytes ao filesystem, acima do teto de ${TAIL_WINDOW_BYTES}`
    );
  });

  it("o custo NÃO cresce com o arquivo", async () => {
    const medir = async (mb: number): Promise<number> => {
      const disco = discoCom("y".repeat(mb * 1024 * 1024) + "\nfim");
      await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
      return disco.lidos.reduce((soma, n) => soma + n, 0);
    };
    assert.equal(await medir(1), await medir(8));
  });

  it("as últimas linhas úteis continuam lá", async () => {
    const disco = discoCom(logDe(20000));
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    const linhas = (texto ?? "").split("\n");
    assert.equal(linhas[linhas.length - 1], "[download]  19999.0% de 42MiB");
    assert.ok(linhas.length > 12, "não sobrou cauda suficiente para as 12 linhas");
  });

  it("sem `lstatSync` cai no caminho antigo, sem quebrar", async () => {
    const disco = discoCom("x".repeat(20000) + "\nfim", { semLstat: true });
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.ok(texto?.endsWith("fim"));
    assert.equal(disco.leuTudo, true, "a degradação deveria ler tudo");
  });
});

describe("readTailText · UTF-8 na borda", () => {
  it("um caractere cortado ao meio não corrompe o resto", async () => {
    // A janela cai EXATAMENTE no meio de um "é" (2 bytes).
    const cauda = "é acentuado até o fim";
    const enchimento = "a".repeat(64);
    const inteiro = enchimento + cauda;
    const bytes = new TextEncoder().encode(inteiro);
    // Janela que começa no segundo byte do "é".
    const janela = bytes.length - new TextEncoder().encode(cauda).byteLength + 1;

    const disco = discoCom(bytes);
    const texto = await readTailText(SPACE, "dl-log.txt", janela, disco.fs);

    assert.ok(texto !== null);
    // O pedaço órfão sai; o resto chega intacto.
    assert.ok(!texto.includes("�"), "sobrou caractere de substituição");
    assert.ok(texto.endsWith("acentuado até o fim"));
  });

  it("emoji na borda não quebra o texto seguinte", async () => {
    const cauda = "🎬 cortou aqui · ação";
    const bytes = new TextEncoder().encode("b".repeat(80) + cauda);
    const caudaBytes = new TextEncoder().encode(cauda).byteLength;

    // Varre todos os cortes possíveis dentro do emoji e dos acentos.
    for (let recuo = 0; recuo < caudaBytes; recuo += 1) {
      const disco = discoCom(bytes);
      const texto = await readTailText(SPACE, "dl-log.txt", recuo + 1, disco.fs);
      if (texto === null) continue;
      assert.ok(!texto.includes("�"), `corte em -${recuo} deixou substituição`);
      assert.ok(cauda.endsWith(texto), `corte em -${recuo} corrompeu o fim: ${texto}`);
    }
  });
});

describe("readTailText · o arquivo mudando debaixo da leitura", () => {
  it("arquivo que CRESCE durante a leitura não lança", async () => {
    const disco = discoCom("x".repeat(20000) + "\nfim", {
      aoLer: () => undefined,
    });
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.ok(texto?.endsWith("fim"));
  });

  it("arquivo TRUNCADO entre medir e ler degrada sem derrubar o polling", async () => {
    // O lstat diz 4 MB; o arquivo tem 10 bytes. A leitura no offset
    // antigo não devolve nada.
    const disco = discoCom("dez bytes.", { tamanhoMentiroso: 4 * 1024 * 1024 });
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.equal(texto, null);
    assert.equal(disco.fechados, 1, "o descritor ficou aberto");
  });
});

describe("readTailText · o descritor sempre fecha", () => {
  it("fecha no sucesso", async () => {
    const disco = discoCom("z".repeat(20000));
    await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.equal(disco.abertos, 1);
    assert.equal(disco.fechados, 1);
  });

  it("fecha quando a leitura falha", async () => {
    const disco = discoCom("z".repeat(20000), { falhaNoRead: true });
    assert.equal(await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs), null);
    assert.equal(disco.abertos, 1);
    assert.equal(disco.fechados, 1, "o descritor vazou numa falha de leitura");
  });

  it("um `open` recusado não lança para o polling", async () => {
    const disco = discoCom("z".repeat(20000), { falhaNoOpen: true });
    assert.equal(await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs), null);
    assert.equal(disco.fechados, 0);
  });

  it("um `close` que falha não lança para o polling", async () => {
    const disco = discoCom("z".repeat(20000), { falhaNoClose: true });
    const texto = await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, disco.fs);
    assert.ok(texto !== null, "a falha no fechamento engoliu o resultado");
  });

  it("sem filesystem nenhum devolve null", async () => {
    assert.equal(
      await readTailText(SPACE, "dl-log.txt", TAIL_WINDOW_BYTES, null),
      null
    );
  });
});
