/**
 * O pack grande organizado pelo que cada som é. Os caminhos abaixo são
 * do pack real (Drive, 2026-09-22): 8.540 áudios em 803 pastas, com
 * pastas que não dizem nada ("SOUND EFFECTS 2", "SFX 6", "MORE SFX").
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, sourceOf } from "../src/tools/sfx/taxonomy";
import { buildCatalog } from "../src/tools/sfx/pack";

const at = (path: string): string => {
  const parts = path.split("/");
  const name = parts.pop()!;
  return classify(parts, name).id;
};

describe("classify", () => {
  const cases: Array<[string, string]> = [
    ["02_SFX_CINEMATICOS/MATEUS FERREIRA/DESIGNER SOUND FX/ESSENTIAL/CLICK/(MISTER HORSE - ESSENTIAL SOUND EFFECTS) CLICK KEYBOARD 02.WAV", "cliques"],
    ["02_SFX_CINEMATICOS/MATEUS FERREIRA/DESIGNER SOUND FX/ESSENTIAL/POP/(MISTER HORSE - ESSENTIAL SOUND EFFECTS) POP PLASTIC 01.WAV", "pops"],
    ["02_SFX_CINEMATICOS/MATEUS FERREIRA/DESIGNER SOUND FX/SWISHES (100)/SWISH 12.WAV", "whooshes"],
    ["03_BIBLIOTECAS_GRANDES/01_ADOBE_AUDITION_LIBRARY/IMPACTS/IMPACT BODY FALL IN GRAVEL 03.WAV", "impactos"],
    ["03_BIBLIOTECAS_GRANDES/01_ADOBE_AUDITION_LIBRARY/ANIMALS/Dog Bark 02.wav", "animais"],
    ["03_BIBLIOTECAS_GRANDES/01_ADOBE_AUDITION_LIBRARY/AMBIENCE_1/Office Room Tone.wav", "ambientes"],
    ["03_BIBLIOTECAS_GRANDES/03_SFX_LIBRARY_COLLECTION/SFX-001/SFX/SOUND EFFECTS 2/SMG/SHOT/TAR SHOT 1.MP3", "games"],
    ["03_BIBLIOTECAS_GRANDES/03_SFX_LIBRARY_COLLECTION/SFX-001/SFX/MORE SFX/MORE SFX - LORDSSE/OH HELL NO.MP3", "memes"],
    ["03_BIBLIOTECAS_GRANDES/03_SFX_LIBRARY_COLLECTION/SFX-001/SFX/MORE SFX/MORE SFX - LORDSSE/CASH REGISTER.MP3", "dinheiro"],
    ["04_OUTROS_SFX/CineRiser1.wav", "risers"],
    ["SFX/Cameras/Film Burn 3.mp3", "camera"],
    ["SFX/Ui/Pop up.wav", "pops"],
    ["SFX/Wooshes/Epic Woosh 1.wav", "whooshes"],
    ["01_SFX_ASSINATURA_SIDY/REAL LIFE/qualquer coisa.wav", "assinatura"],
  ];
  for (const [path, id] of cases) it(`${path.split("/").pop()} → ${id}`, () => assert.equal(at(path), id));
});

describe("sourceOf", () => {
  it("a biblioteca vira a etiqueta", () => {
    assert.equal(sourceOf(["03_BIBLIOTECAS_GRANDES", "01_ADOBE_AUDITION_LIBRARY", "IMPACTS"]), "Adobe Audition");
    assert.equal(sourceOf(["02_SFX_CINEMATICOS", "MATEUS FERREIRA", "DESIGNER SOUND FX"]), "Mateus Ferreira");
    assert.equal(sourceOf(["SFX", "Wooshes"]), "Pack SFX");
  });
  it("tomadas de bibliotecas diferentes não viram um som só", () => {
    const catalog = buildCatalog([
      { id: "a", name: "Impact 01.wav", folders: ["03_BIBLIOTECAS_GRANDES", "01_ADOBE_AUDITION_LIBRARY", "IMPACTS"], stamp: "" },
      { id: "b", name: "Impact 02.wav", folders: ["02_SFX_CINEMATICOS", "MATEUS FERREIRA", "DESIGNER SOUND FX", "IMPACTS (100)"], stamp: "" },
    ]);
    const sounds = catalog.categories.find((c) => c.id === "impactos")!.sounds;
    assert.equal(sounds.length, 2);
    assert.deepEqual(sounds.map((s) => s.source).sort(), ["Adobe Audition", "Mateus Ferreira"]);
  });
});
