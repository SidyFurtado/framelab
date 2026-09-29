/**
 * A prateleira de modelos, conferida fora do Premiere.
 *
 * O que tem como errar aqui é o que o editor vê na lista e o que o
 * modelo recebe como texto — e as duas coisas são função pura.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isMogrt,
  templateName,
  templatesFrom,
  textForMogrt,
} from "../src/tools/titles/library";
import { fontFolders, fontNamesFrom } from "../src/tools/titles/fonts";
import { slugFor } from "../src/tools/titles/previews";

describe("templatesFrom", () => {
  // Os nomes são os da coleção real, com a mistura de idiomas e
  // espaços que ela tem de verdade.
  const folder = "/Users/ed/Documents/Editor Black Belt/Titulos";
  const files = [
    "WATER TEXT.mogrt",
    "Rebote.mogrt",
    "APPLE STYLE ANIMATION.mogrt",
    "leia-me.txt",
    "ESCRITO A MANO POSTERIZACION.MOGRT",
    ".DS_Store",
  ];

  it("fica só com os .mogrt, em ordem de leitura humana", () => {
    const found = templatesFrom(folder, files);
    assert.deepEqual(
      found.map((item) => item.name),
      ["APPLE STYLE ANIMATION", "ESCRITO A MANO POSTERIZACION", "Rebote", "WATER TEXT"]
    );
  });

  it("monta o caminho que o Premiere recebe", () => {
    const [first] = templatesFrom(folder, ["APPLE STYLE ANIMATION.mogrt"]);
    assert.equal(first.path, `${folder}/APPLE STYLE ANIMATION.mogrt`);
  });

  it("não duplica a barra quando a pasta já termina em uma", () => {
    const [first] = templatesFrom(`${folder}/`, ["VHS.mogrt"]);
    assert.equal(first.path, `${folder}/VHS.mogrt`);
  });

  it("reconhece a extensão em qualquer caixa", () => {
    assert.equal(isMogrt("A.mogrt"), true);
    assert.equal(isMogrt("A.MoGrT"), true);
    assert.equal(isMogrt("A.mogrt.zip"), false);
    assert.equal(templateName("SMOOTH BOUNCE.mogrt"), "SMOOTH BOUNCE");
  });
});

describe("textForMogrt", () => {
  it("quebra linha com retorno de carro, que é o que o AE usa", () => {
    assert.equal(textForMogrt("smooth\nbounce"), "smooth\rbounce");
    assert.equal(textForMogrt("smooth\r\nbounce"), "smooth\rbounce");
    assert.equal(textForMogrt("  sem sobra  "), "sem sobra");
  });
});

describe("fontNamesFrom", () => {
  it("vira sugestão o que parece nome PostScript", () => {
    const found = fontNamesFrom([
      "Montserrat-ExtraBold.ttf",
      "Anton-Regular.TTF",
      "AVANTE.otf",
      // Coleção: um arquivo, várias fontes dentro. O nome do arquivo
      // não serve para nenhuma delas.
      "Helvetica.ttc",
      "leia-me.txt",
      ".DS_Store",
      // A mesma fonte nas duas pastas do sistema não vira duas linhas.
      "Anton-Regular.ttf",
    ]);
    assert.deepEqual(found, ["Anton-Regular", "AVANTE", "Montserrat-ExtraBold"]);
  });
});

describe("slugFor", () => {
  it("tira espaço, acento e caixa — que é o que quebrava a leitura", () => {
    assert.equal(slugFor("CLEAN STYLE"), "clean-style");
    assert.equal(slugFor("BB Pop"), "bb-pop");
    assert.equal(slugFor("3D TEXT"), "3d-text");
    assert.equal(slugFor("ESCRITO A MANO POSTERIZACION"), "escrito-a-mano-posterizacion");
    assert.equal(slugFor("Rebote"), "rebote");
  });

  it("não deixa o nome virar vazio nem sair com traço solto", () => {
    assert.equal(slugFor("!!!"), "modelo");
    assert.equal(slugFor(" — VHS — "), "vhs");
  });

  it("a coleção inteira sai sem duas prévias disputando o mesmo arquivo", () => {
    const nomes = [
      "3D TEXT", "AESTHETIC STRINKING", "APPLE STYLE ANIMATION", "CLEAN BLUE",
      "CLEAN STYLE", "ERROR TEXT", "ESCRITO A MANO POSTERIZACION", "GOLD TEXT",
      "OLD MONEY", "ORANGE TEXT", "RAINBOW TEXT", "REBOUND", "Rebote",
      "SMOOTH BOUNCE", "SMOOTH OPACITY", "SMOOTH UP", "TEXTO DE ORO",
      "TRIPLE ELEGANT TEXT", "VHS", "WATER TEXT", "BB Blur In", "BB Bounce",
      "BB Drop", "BB Fade Down", "BB Fade Left", "BB Fade Right", "BB Fade Up",
      "BB Flip 3D", "BB Float", "BB Pop", "BB Slide", "BB Snap", "BB Spin",
      "BB Tilt", "BB Zoom Out",
    ];
    assert.equal(new Set(nomes.map(slugFor)).size, nomes.length);
  });
});

describe("fontFolders", () => {
  it("no macOS não vai procurar em C:\\Windows", () => {
    const mac = fontFolders("/Users/ed", false);
    assert.deepEqual(mac, ["/Users/ed/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts"]);
    // "darwin" contém "win": foi este o bug que deixou a lista vazia.
    assert.ok(!mac.some((folder) => /Windows/i.test(folder)));
  });

  it("no Windows procura nas duas pastas de lá", () => {
    const win = fontFolders("C:\\Users\\ed", true);
    assert.deepEqual(win, [
      "C:\\Windows\\Fonts",
      "C:\\Users\\ed\\AppData\\Local\\Microsoft\\Windows\\Fonts",
    ]);
  });
});
