/**
 * O inflate contra o zlib do Node, que é o oráculo.
 *
 * Os dados são gerados aqui mesmo — texto repetitivo, bytes aleatórios
 * e vazio — em todos os níveis de compressão, para que o teste não
 * dependa de nenhum arquivo do disco. Os `.mogrt` reais entram só
 * quando existem na máquina, como conferência extra.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { inflateRaw } from "../src/tools/titles/inflate";

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

describe("inflateRaw", () => {
  const samples: Array<[string, Uint8Array]> = [
    ["vazio", new Uint8Array(0)],
    ["um byte", new Uint8Array([42])],
    ["texto repetitivo", Buffer.from("legenda animada ".repeat(4000))],
    ["json parecido com o real", Buffer.from(JSON.stringify({
      capsuleName: "BB Pop", clientControls: Array.from({ length: 40 }, (_, i) => ({
        id: `id-${i}`, type: i % 7, value: { strDB: [{ localeString: "pt_BR", str: `Legenda ${i}` }] },
      })),
    }))],
  ];
  const random = new Uint8Array(70000);
  let seed = 7;
  for (let i = 0; i < random.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    random[i] = seed >> 16;
  }
  samples.push(["aleatório (blocos sem compressão)", random]);

  for (const [name, data] of samples) {
    for (const level of [0, 1, 6, 9]) {
      it(`${name}, nível ${level}`, () => {
        const packed = new Uint8Array(deflateRawSync(data, { level }));
        assert.ok(same(inflateRaw(packed, data.length), data));
        // Sem o tamanho esperado o buffer cresce sozinho — mesmo resultado.
        assert.ok(same(inflateRaw(packed), data));
      });
    }
  }

  it("recusa dados truncados em vez de devolver lixo", () => {
    const packed = new Uint8Array(deflateRawSync(Buffer.from("x".repeat(500))));
    assert.throws(() => inflateRaw(packed.subarray(0, 3)));
  });

  // As entradas de todos os .mogrt da máquina, quando eles existem.
  const libs = [
    join(homedir(), "Documents/Editor Black Belt/Titulos"),
    join(homedir(), "Library/Application Support/Adobe/CEP/extensions/com.editorblackbelt.toolspro/tools/pr-captions/templates"),
  ].filter((folder) => existsSync(folder));
  for (const folder of libs) {
    for (const file of readdirSync(folder).filter((f) => f.endsWith(".mogrt"))) {
      it(`entrada definition.json de ${file}`, () => {
        const zip = new Uint8Array(readFileSync(join(folder, file)));
        // Fim do diretório central → primeira entrada do diretório.
        let eocd = zip.length - 22;
        while (eocd >= 0 && !(zip[eocd] === 0x50 && zip[eocd + 1] === 0x4b && zip[eocd + 2] === 5 && zip[eocd + 3] === 6)) eocd -= 1;
        const view = new DataView(zip.buffer, zip.byteOffset);
        let at = view.getUint32(eocd + 16, true);
        const total = view.getUint16(eocd + 10, true);
        for (let i = 0; i < total; i += 1) {
          const method = view.getUint16(at + 10, true);
          const csize = view.getUint32(at + 20, true);
          const usize = view.getUint32(at + 24, true);
          const nameLen = view.getUint16(at + 28, true);
          const extraLen = view.getUint16(at + 30, true);
          const commentLen = view.getUint16(at + 32, true);
          const local = view.getUint32(at + 42, true);
          const name = Buffer.from(zip.subarray(at + 46, at + 46 + nameLen)).toString();
          const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
          const packed = zip.subarray(dataAt, dataAt + csize);
          if (name === "definition.json" && method === 8) {
            const ours = inflateRaw(packed, usize);
            const theirs = new Uint8Array(inflateRawSync(packed));
            assert.ok(same(ours, theirs));
            assert.ok(JSON.parse(Buffer.from(ours).toString("utf8")).capsuleName);
          }
          at += 46 + nameLen + extraLen + commentLen;
        }
      });
    }
  }
});
