/**
 * A pasta de destino — os casos que custaram um dia de trabalho.
 *
 * Em 23/09/2026 o plugin escreveu ~25 arquivos numa árvore paralela
 * porque uma pasta de verdade do Drive compartilhado termina em espaço:
 *
 *     .../H&W - Edição de Vídeo -Q3/Arquivo de Edição /01. Male .../
 *                                                    ↑ aqui
 *
 * e o yt-dlp, chamado com `--windows-filenames`, trocou esse espaço
 * final por "#" em CADA componente do caminho, criou tudo de novo ao
 * lado e disse que estava ok. Os arquivos entravam OFFLINE no Premiere.
 *
 * Cada nome de pasta daqui para baixo é um nome que precisa sobreviver
 * intacto ao caminho inteiro do plugin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESTINATION_GROUPS,
  groupOf,
  isInside,
  joinNative,
  safeBaseName,
  safeRelative,
  samePath,
  sharesDestination,
  type DestinationTool,
} from "../src/bridge/destination";

/** As pastas do enunciado, mais as que o mesmo defeito atingiria. */
const FOLDERS = [
  "/Volumes/Drive/pasta com espaço no fim ",
  "/Volumes/Drive/  espaço no início",
  "/Volumes/Drive/pasta#com#cerquilha",
  "/Volumes/Drive/pasta & e comercial",
  "/Volumes/Drive/Edição de Vídeo — acento",
  "/Volumes/Drive/pasta com emoji 🎬",
  "/Users/sidy/Library/CloudStorage/GoogleDrive-x/Drives compartilhados/H&W - Edição de Vídeo -Q3/Arquivo de Edição /01. Male Enhancement",
  "/Volumes/Drive/ponto no fim.",
];

describe("samePath — compara sem reescrever", () => {
  it("o espaço final DIFERENCIA duas pastas", () => {
    assert.equal(samePath("/a/Arquivo de Edição ", "/a/Arquivo de Edição"), false);
    // Que era exatamente a troca que o yt-dlp fazia.
    assert.equal(samePath("/a/Arquivo de Edição ", "/a/Arquivo de Edição#"), false);
  });

  it("o ponto final também", () => {
    assert.equal(samePath("/a/pasta.", "/a/pasta"), false);
  });

  it("NFD e NFC são a mesma pasta", () => {
    const nfc = "/a/Edição".normalize("NFC");
    const nfd = "/a/Edição".normalize("NFD");
    assert.notEqual(nfc, nfd);
    assert.equal(samePath(nfc, nfd), true);
  });

  it("a barra final e a caixa não contam", () => {
    assert.equal(samePath("/a/Pasta/", "/a/pasta"), true);
    assert.equal(samePath("C:\\Users\\x", "C:/Users/x"), true);
  });
});

describe("isInside — o arquivo caiu na pasta pedida?", () => {
  for (const folder of FOLDERS) {
    it(`aceita o que está dentro de "${folder}"`, () => {
      assert.equal(isInside(folder, `${folder}/video.mp4`), true);
      assert.equal(isInside(folder, `${folder}/sub/video.mp4`), true);
    });
  }

  it("recusa a árvore paralela do bug (espaço final virado #)", () => {
    const real = "/a/Arquivo de Edição /01. Male";
    const fake = "/a/Arquivo de Edição#/01. Male";
    assert.equal(isInside(real, `${fake}/video.mp4`), false);
  });

  it("recusa uma pasta vizinha de nome parecido", () => {
    assert.equal(isInside("/a/Edição", "/a/Edição extra/video.mp4"), false);
  });
});

describe("safeBaseName — só o nome do arquivo, nunca o caminho", () => {
  it("tira espaço e ponto do FIM, que é onde o Windows recusa", () => {
    assert.equal(safeBaseName("video "), "video");
    assert.equal(safeBaseName("video."), "video");
  });

  it("preserva o espaço do meio e o acento", () => {
    assert.equal(safeBaseName("Edição de Vídeo 01.mp4"), "Edição de Vídeo 01.mp4");
  });

  it("troca o que nenhum sistema aceita", () => {
    assert.equal(safeBaseName('a/b:c"d|e?f*g.mp4'), "a b c d e f g.mp4");
  });

  it("nunca devolve vazio, ponto ou dois pontos", () => {
    assert.equal(safeBaseName("", "legenda.srt"), "legenda.srt");
    assert.equal(safeBaseName("   ", "legenda.srt"), "legenda.srt");
    assert.equal(safeBaseName("..", "legenda.srt"), "legenda.srt");
  });

  it("desarma os nomes de dispositivo do Windows", () => {
    assert.equal(safeBaseName("CON.mp4"), "_CON.mp4");
    assert.equal(safeBaseName("nul"), "_nul");
    assert.equal(safeBaseName("conta.mp4"), "conta.mp4");
  });

  it("emoji passa — é nome de arquivo válido em todo lugar", () => {
    assert.equal(safeBaseName("clipe 🎬.mp4"), "clipe 🎬.mp4");
  });
});

describe("safeRelative — o que o plugin inventa dentro da pasta", () => {
  it("mantém a subpasta e saneia cada pedaço", () => {
    assert.equal(safeRelative("Impactos/Boom 2.wav"), "Impactos/Boom 2.wav");
    // A subpasta é invenção do plugin: o espaço no fim DELA sai, porque
    // é ele que o Windows recusa num nome de diretório.
    assert.equal(safeRelative("Impactos /Boom 2.wav"), "Impactos/Boom 2.wav");
    // O espaço antes da extensão fica: nenhum sistema o recusa, e o
    // nome é o que o editor vai ler na lista.
    assert.equal(safeRelative("Impactos/Boom 2 .wav"), "Impactos/Boom 2 .wav");
  });

  it("não deixa escapar da pasta escolhida", () => {
    assert.equal(safeRelative("../../etc/passwd"), "etc/passwd");
    assert.equal(safeRelative("/absoluto/som.wav"), "absoluto/som.wav");
  });
});

describe("joinNative — junta sem tocar na base", () => {
  it("o espaço final da pasta sobrevive", () => {
    assert.equal(
      joinNative("/a/Arquivo de Edição ", "video.mp4"),
      "/a/Arquivo de Edição /video.mp4"
    );
  });

  it("só a barra separadora é aparada", () => {
    assert.equal(joinNative("/a/pasta/", "b/c.mp4"), "/a/pasta/b/c.mp4");
  });
});

describe("grupos — quem divide pasta com quem", () => {
  const ALL: DestinationTool[] = ["download", "captions", "titles", "sfx", "soundDesign"];

  it("cada ferramenta está em exatamente um grupo", () => {
    for (const tool of ALL) {
      const found = Object.values(DESTINATION_GROUPS).filter((tools) => tools.includes(tool));
      assert.equal(found.length, 1, `${tool} aparece em ${found.length} grupos`);
      assert.ok(groupOf(tool));
    }
  });

  it("a biblioteca de SFX e o SFX Automático dividem — de propósito", () => {
    assert.equal(sharesDestination("sfx", "soundDesign"), true);
    assert.equal(sharesDestination("soundDesign", "sfx"), true);
  });

  it("todo o resto é grupo de um", () => {
    const solo: DestinationTool[] = ["download", "captions", "titles"];
    for (const tool of solo) {
      for (const other of ALL) {
        if (other === tool) continue;
        assert.equal(
          sharesDestination(tool, other),
          false,
          `${tool} não pode dividir pasta com ${other}`
        );
      }
    }
  });

  it("o par de áudio não arrasta mais ninguém", () => {
    for (const tool of ["download", "captions", "titles"] as DestinationTool[]) {
      assert.equal(sharesDestination("sfx", tool), false);
      assert.equal(sharesDestination("soundDesign", tool), false);
    }
  });
});
