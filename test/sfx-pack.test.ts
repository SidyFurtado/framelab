/**
 * O pack de efeitos, organizado fora do Premiere.
 *
 * Os nomes abaixo são os do pack real (a pasta SFX do Drive), com a
 * bagunça que ele tem de verdade: loja no nome, código de catálogo,
 * mp3 e wav do mesmo som, e o lixo que o Mac e o Premiere deixam.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCatalog,
  categoryFor,
  folderIdFrom,
  isAudioName,
  fileNameFor,
  looksLikeFolderView,
  parseFolderView,
  parseSoundName,
  queryTerms,
  soundMatches,
  type PackFile,
} from "../src/tools/sfx/pack";

function file(path: string, id = path): PackFile {
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  return { id, name, folders: parts, stamp: "12/31/79" };
}

describe("parseSoundName", () => {
  const cases: Array<[string, string, number | null]> = [
    ["Boom 3.mp3", "Boom", 3],
    ["Bubble 01.wav", "Bubble", 1],
    ["Interface2.wav", "Interface", 2],
    ["Coins_4.mp3", "Coins", 4],
    ["Mountain Audio - Counter Beeps - Sound (6).wav", "Counter Beeps", 6],
    ["ES_Camera Shutter 8 - SFX Producer.mp3", "Camera Shutter", 8],
    ["Ni Sound - Filmmaking Props - Camera Setting up Open Focus Beep.aac", "Camera Setting Up Open Focus Beep", null],
    ["drawing-lines-using-pencil-SBA-300055968.mp3", "Drawing Lines Using Pencil", null],
    ["StingerCameraShut SDT012702.wav", "Stinger Camera Shut", null],
    ["LG_Sound - Clock Ticking (Wav).wav", "Clock Ticking", null],
    ["VIRAL SFX DIGITAL TEXT - DATA.mp3", "Digital Text Data", null],
    ["camera-shutter-sound-effect.mp3", "Camera Shutter", null],
    ["Epic Woosh 2.wav", "Epic Whoosh", 2],
    ["falha na luz.wav", "Falha na Luz", null],
    ["UI - Digital Whoosh.wav", "UI Digital Whoosh", null],
    ["Fireball 01 Whoosh.mp3", "Fireball Whoosh", null],
    ["1 Click Mouse.wav", "1 Click Mouse", null],
    ["(MISTER HORSE - ESSENTIAL SOUND EFFECTS) BEEP SYNTHETIC 05.WAV", "Beep Synthetic", 5],
    ["(MISTER HORSE - ESSENTIAL SOUND EFFECTS) CLICK KEYBOARD 02.WAV", "Click Keyboard", 2],
    ["Success Notification .wav", "Success Notification", null],
  ];
  for (const [input, base, take] of cases) {
    it(`${input} → ${base}${take === null ? "" : ` #${take}`}`, () => {
      const parsed = parseSoundName(input);
      assert.equal(parsed.base, base);
      assert.equal(parsed.take, take);
    });
  }

  it("reconhece loop e ainda acha o número que ele escondia", () => {
    assert.deepEqual(parseSoundName("DigitalDataCounter_03_Loop.wav"), {
      base: "Digital Data Counter",
      take: 3,
      loop: true,
    });
  });
});

describe("isAudioName", () => {
  it("deixa de fora o cache do Premiere, o do Mac e o resto de zip", () => {
    assert.equal(isAudioName("Boom 1.mp3"), true);
    assert.equal(isAudioName("best Whoosh 2.mpeg"), true);
    assert.equal(isAudioName("Iphone 2.m4a"), true);
    assert.equal(isAudioName("Boom 1.mp3 44100.pek"), false);
    assert.equal(isAudioName("Riser 2.mp3 48000.cfa"), false);
    assert.equal(isAudioName(".DS_Store"), false);
    assert.equal(isAudioName("._Paper-Kite-Flying_6Ext10-2215.wav"), false);
  });
});

describe("categoryFor", () => {
  it("dá às pastas do pack o nome que o editor fala", () => {
    assert.equal(categoryFor("Wooshes").label, "Whooshes");
    assert.equal(categoryFor("Hits - impacts").label, "Impactos");
    assert.equal(categoryFor("Ui").label, "Interface");
    assert.equal(categoryFor("Bells").label, "Brilhos");
  });

  it("pasta nova entra com o próprio nome, antes de Diversos", () => {
    const fresh = categoryFor("ambiencias urbanas");
    assert.equal(fresh.label, "Ambiencias Urbanas");
    assert.ok(fresh.order < categoryFor("Diversos").order);
  });
});

describe("buildCatalog", () => {
  const catalog = buildCatalog([
    file("Hits - impacts/Boom 1.mp3"),
    file("Hits - impacts/Boom 2.mp3"),
    file("Hits - impacts/Boom 1.mp3 44100.pek"),
    file("Hits - impacts/Reverse Boom.mp3"),
    file("Hits - impacts/Reverse Boom.wav"),
    file("Cameras/Camera Shutter.mp3"),
    file("Cameras/camera-shutter-sound-effect.mp3"),
    file("Cameras/Camera shutter 2.wav"),
    file("Diversos/Bolhas/Bubble 02.wav"),
    file("Diversos/Bolhas/Bubble 01.wav"),
    file("Diversos/Papel voando/__MACOSX/._Paper-Kite-Flying.wav"),
    file("Wooshes/Epic Woosh 1.wav"),
    file(".DS_Store"),
  ]);
  const sound = (name: string) =>
    catalog.categories.flatMap((category) => category.sounds).find((item) => item.name === name);

  it("junta as tomadas num som só, em ordem", () => {
    assert.deepEqual(sound("Boom")?.variants.map((v) => v.file), ["Boom 1.mp3", "Boom 2.mp3"]);
    assert.deepEqual(sound("Bubble")?.variants.map((v) => v.file), ["Bubble 01.wav", "Bubble 02.wav"]);
  });

  it("o mesmo som em dois formatos conta uma vez, em WAV", () => {
    assert.deepEqual(sound("Reverse Boom")?.variants.map((v) => v.file), ["Reverse Boom.wav"]);
  });

  it("nomes que só limpam igual continuam sendo tomadas diferentes", () => {
    assert.equal(sound("Camera Shutter")?.variants.length, 3);
  });

  it("o som mora no que ele é: bolha em Pops, mesmo guardada em Diversos", () => {
    assert.equal(sound("Bubble")?.category, "pops");
    assert.ok(sound("Bubble")?.haystack.includes("bolhas"));
  });

  it("ignora lixo e conta o que sobrou", () => {
    assert.equal(catalog.files, 9);
    assert.equal(catalog.sounds, 5);
    assert.deepEqual(
      catalog.categories.map((category) => category.label),
      ["Whooshes & transições", "Impactos & hits", "Pops & bolhas", "Câmera & flash"]
    );
  });

  it("dá à tomada o nome que a lista mostra, numa pasta por categoria", () => {
    const impactos = catalog.categories.find((category) => category.id === "impactos");
    const boom = impactos?.sounds.find((item) => item.name === "Boom");
    assert.ok(impactos && boom);
    assert.equal(fileNameFor(impactos, boom, 1), "Impactos & hits/Boom 2.mp3");
    const reverse = impactos.sounds.find((item) => item.name === "Reverse Boom");
    assert.ok(reverse);
    assert.equal(fileNameFor(impactos, reverse, 0), "Impactos & hits/Reverse Boom.wav");
  });

  it("tira do nome o que o sistema não aceita", () => {
    const [category] = buildCatalog([file('Ui/Deep: Hit? "Pro".wav')]).categories;
    assert.equal(fileNameFor(category, category.sounds[0], 0), "Impactos & hits/Deep- Hit- -Pro-.wav");
  });
});

describe("busca", () => {
  // A busca da tela corre o catálogo inteiro: "Whoosh Boom" mora em Whooshes, "Boom" em Impactos.
  const sounds = buildCatalog([
    file("Hits - impacts/Boom 1.mp3"),
    file("Hits - impacts/Whoosh Boom.mp3"),
    file("Hits - impacts/Sub Swoosh.mp3"),
  ]).categories.flatMap((category) => category.sounds);
  const names = (query: string) =>
    sounds.filter((item) => soundMatches(item, queryTerms(query))).map((item) => item.name).sort();

  it("acha pelo começo da palavra, sem acento e sem caixa", () => {
    assert.deepEqual(names("BOO"), ["Boom", "Whoosh Boom"]);
    assert.deepEqual(names("oom"), []);
  });

  it("português acha o nome em inglês", () => {
    assert.deepEqual(names("impacto"), ["Boom", "Sub Swoosh", "Whoosh Boom"]);
  });

  it("várias palavras estreitam", () => {
    assert.deepEqual(names("whoosh boom"), ["Whoosh Boom"]);
  });
});

describe("a listagem do Drive", () => {
  const html =
    '<div class="flip-entries">' +
    '<div class="flip-entry" id="entry-1ouA3pRzRUWnBfixrHGPvFKZKHiDJoCf-" tabindex="0" role="link">' +
    '<div class="flip-entry-info"><a href="https://drive.google.com/drive/folders/1ouA3pRzRUWnBfixrHGPvFKZKHiDJoCf-" target="_blank">' +
    '<div class="flip-entry-title">Hits - impacts</div></a></div>' +
    '<div class="flip-entry-last-modified"><div>12/31/79</div></div></div>' +
    '<div class="flip-entry" id="entry-16ttVcXwyPbpeL3HyPU8DDrLNeGQD1XJT" tabindex="0" role="link">' +
    '<div class="flip-entry-info"><a href="https://drive.google.com/file/d/16ttVcXwyPbpeL3HyPU8DDrLNeGQD1XJT/view?usp=drive_web" target="_blank">' +
    '<div class="flip-entry-title">Rock &amp; Roll&#39;s Hit.mp3</div></a></div>' +
    '<div class="flip-entry-last-modified"><div>3:45 PM</div></div></div>' +
    "</div>";

  it("separa pasta de arquivo e desfaz as entidades", () => {
    assert.deepEqual(parseFolderView(html), [
      { id: "1ouA3pRzRUWnBfixrHGPvFKZKHiDJoCf-", name: "Hits - impacts", folder: true, stamp: "12/31/79" },
      { id: "16ttVcXwyPbpeL3HyPU8DDrLNeGQD1XJT", name: "Rock & Roll's Hit.mp3", folder: false, stamp: "3:45 PM" },
    ]);
  });

  it("reconhece a página de login de uma pasta que deixou de ser pública", () => {
    assert.equal(looksLikeFolderView(html), true);
    assert.equal(looksLikeFolderView("<html><title>Fazer login</title></html>"), false);
  });

  it("tira o id de qualquer forma de link", () => {
    const id = "1vvWFLN8ZQV9kZQ1i5heLL8d5fm0gTv6p";
    assert.equal(folderIdFrom(`https://drive.google.com/drive/folders/${id}?usp=drive_link`), id);
    assert.equal(folderIdFrom(`https://drive.google.com/open?id=${id}`), id);
    assert.equal(folderIdFrom(`  ${id} `), id);
    assert.equal(folderIdFrom("não é um link"), null);
  });
});
