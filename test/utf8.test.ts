/**
 * O UTF-8 da casa, contra o do Node.
 *
 * Existe porque o UXP não tem `TextDecoder` — e porque um erro aqui
 * não aparece como erro: aparece como acento trocado no meio de uma
 * legenda, ou como um `.mogrt` que o Premiere recusa sem dizer o quê.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { utf8Decode, utf8Encode } from "../src/tools/titles/utf8";
import { readTextEntry } from "../src/tools/titles/mogrtZip";

const CASES = [
  ["vazio", ""],
  ["ascii", "Legenda animada"],
  ["acento", "Não é só coração: ação, avião, ônibus, três"],
  ["retorno de carro", "smooth\rbounce\r\nfim"],
  ["emoji", "vem ver 🔥🚀 isso 👨‍👩‍👧‍👦"],
  ["ideograma", "字幕アニメ 中文 한국어"],
  ["sinais", "€ £ ¥ — “aspas” … ✓ ½"],
  ["json real", JSON.stringify({ capsuleName: "BB Pop · vem ver 🔥", str: "Ação\rimediata" })],
] as const;

describe("utf8", () => {
  for (const [name, text] of CASES) {
    it(`${name}: ida e volta igual ao Node`, () => {
      const ours = utf8Encode(text);
      const theirs = new Uint8Array(Buffer.from(text, "utf8"));
      assert.deepEqual([...ours], [...theirs], "bytes diferentes do Buffer");
      assert.equal(utf8Decode(ours), text);
      assert.equal(utf8Decode(theirs), Buffer.from(theirs).toString("utf8"));
    });
  }

  it("texto grande passa dos blocos de 8 KB", () => {
    const big = "linha com acento à ação 🔥 ".repeat(3000);
    assert.equal(utf8Decode(utf8Encode(big)), big);
    assert.deepEqual([...utf8Encode(big)], [...Buffer.from(big, "utf8")]);
  });

  it("byte inválido vira U+FFFD em vez de derrubar a leitura", () => {
    // 0xFF nunca abre caractere; 0xE2 sozinho é sequência truncada.
    assert.equal(utf8Decode(new Uint8Array([0x61, 0xff, 0x62])), "a�b");
    assert.equal(utf8Decode(new Uint8Array([0x61, 0xe2, 0x62])), "a�b");
    assert.equal(utf8Decode(new Uint8Array([0xe2, 0x82])), "��");
    // Sequência longa demais para o valor (overlong) também é inválida.
    assert.equal(utf8Decode(new Uint8Array([0xe0, 0x80, 0xaf])), "���");
  });

  it("substituto solto não vira byte inválido na gravação", () => {
    const lone = "a\ud800b";
    assert.equal(utf8Decode(utf8Encode(lone)), "a�b");
  });

  // O arquivo de verdade: se a ida e volta muda um byte, o Premiere
  // recebe um pacote diferente do que o motion designer exportou.
  const real = join(
    homedir(),
    "Library/Application Support/Adobe/CEP/extensions/com.editorblackbelt.toolspro/tools/pr-captions/templates/BB Pop.mogrt"
  );
  if (existsSync(real)) {
    it("o definition.json real sobrevive à ida e volta", () => {
      const json = readTextEntry(new Uint8Array(readFileSync(real)), "definition.json")!;
      assert.ok(json.includes("capsuleName"));
      assert.equal(utf8Decode(utf8Encode(json)), json);
      assert.deepEqual([...utf8Encode(json)], [...Buffer.from(json, "utf8")]);
    });
  }
});
