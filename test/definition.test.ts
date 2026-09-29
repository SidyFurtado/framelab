/**
 * O patch do definition.json, contra a forma real do arquivo.
 *
 * O fixture é o "BB Pop" reduzido ao que importa — os mesmos nomes de
 * campo, a mesma ligação por `capPropMatchName`. Quando o .mogrt real
 * existe na máquina, ele passa pelo mesmo patch, inteiro.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  newCapsuleId,
  patchDefinition,
  splitAcross,
  textForDefinition,
} from "../src/tools/titles/definition";
import { readTextEntry } from "../src/tools/titles/mogrtZip";

const FIXTURE = {
  capsuleID: "ab190e0b-01e5-4d23-b521-1842b7f7e051",
  capsuleName: "BB Pop",
  capsuleNameLocalized: { strDB: [{ localeString: "pt_BR", str: "BB Pop" }] },
  clientControls: [
    { id: "size-id", type: 2, value: 50 },
    {
      id: "text-id",
      type: 6,
      fonteditinfo: { capPropFontEdit: true, fontEditValue: "Montserrat-ExtraBold", fontSizeEditValue: 64 },
      value: { strDB: [{ localeString: "pt_BR", str: "Legenda" }] },
    },
  ],
  sourceInfoLocalized: {
    pt_BR: {
      capsuleparams: {
        capParams: [
          { capPropMatchName: "size-id", capPropType: 1, capPropDefault: 50 },
          {
            capPropMatchName: "text-id", capPropType: 0, capPropDefault: "Legenda",
            textEditValue: "Legenda", fontEditValue: ["Montserrat-ExtraBold"],
            fontSizeEditValue: [64], fontTextRunLength: [7], capPropTextRunCount: 1,
          },
        ],
      },
    },
  },
  usedFontsLocalized: { pt_BR: ["Montserrat-ExtraBold"] },
};

describe("patchDefinition", () => {
  it("troca o texto nos dois lugares e acerta o comprimento do trecho", () => {
    const out = patchDefinition(JSON.stringify(FIXTURE), { text: "vem ver\nisso" });
    const d = JSON.parse(out.json);
    assert.equal(out.textApplied, true);
    assert.equal(d.clientControls[1].value.strDB[0].str, "vem ver\risso");
    const p = d.sourceInfoLocalized.pt_BR.capsuleparams.capParams[1];
    assert.equal(p.textEditValue, "vem ver\risso");
    assert.equal(p.capPropDefault, "vem ver\risso");
    assert.deepEqual(p.fontTextRunLength, ["vem ver\risso".length]);
    // O controle de tamanho não é texto: fica como estava.
    assert.equal(d.sourceInfoLocalized.pt_BR.capsuleparams.capParams[0].capPropDefault, 50);
  });

  it("dá um id novo e um nome que carrega a frase", () => {
    const out = patchDefinition(JSON.stringify(FIXTURE), { text: "oi" });
    const d = JSON.parse(out.json);
    assert.notEqual(d.capsuleID, FIXTURE.capsuleID);
    assert.match(d.capsuleID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(d.capsuleName, "BB Pop · oi");
    assert.equal(d.capsuleNameLocalized.strDB[0].str, "BB Pop · oi");
    // Duas cópias nunca colidem.
    assert.notEqual(newCapsuleId(), newCapsuleId());
  });

  it("fonte e corpo seguem a forma de cada lugar: escalar no controle, lista no capParam", () => {
    const out = patchDefinition(JSON.stringify(FIXTURE), { text: "x", font: "Anton-Regular", size: 90 });
    const d = JSON.parse(out.json);
    assert.equal(out.fontApplied, true);
    assert.equal(out.sizeApplied, true);
    assert.equal(d.clientControls[1].fonteditinfo.fontEditValue, "Anton-Regular");
    assert.equal(d.clientControls[1].fonteditinfo.fontSizeEditValue, 90);
    const p = d.sourceInfoLocalized.pt_BR.capsuleparams.capParams[1];
    assert.deepEqual(p.fontEditValue, ["Anton-Regular"]);
    assert.deepEqual(p.fontSizeEditValue, [90]);
    assert.deepEqual(d.usedFontsLocalized.pt_BR, ["Montserrat-ExtraBold", "Anton-Regular"]);
  });

  it("sem fonte e corpo pedidos, mantém os do modelo", () => {
    const d = JSON.parse(patchDefinition(JSON.stringify(FIXTURE), { text: "x", font: "", size: 0 }).json);
    assert.equal(d.clientControls[1].fonteditinfo.fontEditValue, "Montserrat-ExtraBold");
    assert.deepEqual(d.sourceInfoLocalized.pt_BR.capsuleparams.capParams[1].fontSizeEditValue, [64]);
  });

  it("modelo sem controle de texto avisa em vez de fingir", () => {
    const sem = { ...FIXTURE, clientControls: [FIXTURE.clientControls[0]] };
    assert.equal(patchDefinition(JSON.stringify(sem), { text: "x" }).textApplied, false);
  });

  it("quebra de linha vira retorno de carro", () => {
    assert.equal(textForDefinition("a\r\nb\nc"), "a\rb\rc");
  });

  const real = join(
    homedir(),
    "Library/Application Support/Adobe/CEP/extensions/com.editorblackbelt.toolspro/tools/pr-captions/templates/BB Pop.mogrt"
  );
  if (existsSync(real)) {
    it("o BB Pop de verdade aceita o patch inteiro", () => {
      const json = readTextEntry(new Uint8Array(readFileSync(real)), "definition.json")!;
      const out = patchDefinition(json, { text: "teste real", font: "Anton-Regular", size: 72 });
      assert.equal(out.textApplied, true);
      assert.equal(out.fontApplied, true);
      assert.equal(out.sizeApplied, true);
      const d = JSON.parse(out.json);
      const control = d.clientControls.find((c: { type: number }) => c.type === 6);
      assert.equal(control.value.strDB[0].str, "teste real");
      const p = d.sourceInfoLocalized.pt_BR.capsuleparams.capParams.find(
        (x: { capPropMatchName: string }) => x.capPropMatchName === control.id
      );
      assert.equal(p.textEditValue, "teste real");
      assert.deepEqual(p.fontTextRunLength, [10]);
    });
  }
});

describe("modelo com mais de um campo de texto", () => {
  // A forma do CLEAN BLUE: dois controles de texto, "Clean" e "blue",
  // cada um com o seu gradiente. Foi ele que revelou o bug.
  const DOIS = {
    capsuleID: "id-velho",
    capsuleName: "CLEAN BLUE",
    capsuleNameLocalized: { strDB: [{ localeString: "pt_BR", str: "CLEAN BLUE" }] },
    clientControls: [
      { id: "grupo1", type: 10, value: ["a", "b"] },
      { id: "t1", type: 6, fonteditinfo: { fontEditValue: "Mytupi-Bold", fontSizeEditValue: 124 },
        value: { strDB: [{ localeString: "pt_BR", str: "Clean" }] } },
      { id: "t2", type: 6, fonteditinfo: { fontEditValue: "Mytupi-Bold", fontSizeEditValue: 124 },
        value: { strDB: [{ localeString: "pt_BR", str: "blue" }] } },
    ],
    sourceInfoLocalized: {
      pt_BR: { capsuleparams: { capParams: [
        { capPropMatchName: "t1", capPropDefault: "Clean", textEditValue: "Clean",
          fontEditValue: ["Mytupi-Bold"], fontSizeEditValue: [124], fontTextRunLength: [5], capPropTextRunCount: 1 },
        { capPropMatchName: "t2", capPropDefault: "blue", textEditValue: "blue",
          fontEditValue: ["Mytupi-Bold"], fontSizeEditValue: [124], fontTextRunLength: [4], capPropTextRunCount: 1 },
      ] } },
    },
    usedFontsLocalized: { pt_BR: ["Mytupi-Bold"] },
  };

  function textos(json: string): string[] {
    const d = JSON.parse(json);
    return d.clientControls
      .filter((c: { type: number }) => c.type === 6)
      .map((c: { value: { strDB: { str: string }[] } }) => c.value.strDB[0].str);
  }

  it("uma linha só ESVAZIA o segundo campo — foi o bug do 'teste blue'", () => {
    const out = patchDefinition(JSON.stringify(DOIS), { text: "teste" });
    assert.equal(out.textFields, 2);
    assert.deepEqual(out.parts, ["teste", ""]);
    assert.deepEqual(textos(out.json), ["teste", ""]);
    const params = JSON.parse(out.json).sourceInfoLocalized.pt_BR.capsuleparams.capParams;
    assert.equal(params[0].textEditValue, "teste");
    assert.equal(params[1].textEditValue, "");
    assert.deepEqual(params[0].fontTextRunLength, [5]);
    assert.deepEqual(params[1].fontTextRunLength, [0]);
  });

  it("duas linhas caem uma em cada campo", () => {
    const out = patchDefinition(JSON.stringify(DOIS), { text: "vem ver\nagora" });
    assert.deepEqual(textos(out.json), ["vem ver", "agora"]);
  });

  it("linha sobrando vai para o último campo, nada se perde", () => {
    const out = patchDefinition(JSON.stringify(DOIS), { text: "um\ndois\ntrês" });
    assert.deepEqual(textos(out.json), ["um", "dois\rtrês"]);
  });

  it("a fonte escolhida vale para todos os campos", () => {
    const out = patchDefinition(JSON.stringify(DOIS), { text: "x\ny", font: "Poppins-Black" });
    const d = JSON.parse(out.json);
    const fontes = d.clientControls
      .filter((c: { type: number }) => c.type === 6)
      .map((c: { fonteditinfo: { fontEditValue: string } }) => c.fonteditinfo.fontEditValue);
    assert.deepEqual(fontes, ["Poppins-Black", "Poppins-Black"]);
    assert.deepEqual(d.usedFontsLocalized.pt_BR, ["Mytupi-Bold", "Poppins-Black"]);
  });

  it("campo único continua recebendo o texto inteiro, com quebras", () => {
    assert.deepEqual(splitAcross("a\rb\rc", 1), ["a\rb\rc"]);
    assert.deepEqual(splitAcross("a", 0), ["a"]);
  });

  // O modelo real: se ele tem dois campos, o painel tem de saber.
  const real = join(homedir(), "Documents/Editor Black Belt/Titulos/CLEAN BLUE.mogrt");
  if (existsSync(real)) {
    it("o CLEAN BLUE de verdade não deixa 'blue' para trás", () => {
      const json = readTextEntry(new Uint8Array(readFileSync(real)), "definition.json")!;
      const out = patchDefinition(json, { text: "teste" });
      assert.equal(out.textFields, 2);
      assert.deepEqual(out.parts, ["teste", ""]);
      assert.ok(!textos(out.json).some((t) => /blue/i.test(t)));
    });
  }
});
