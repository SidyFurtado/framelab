/**
 * O reescritor de .mogrt, contra dois oráculos: o `zlib` do Node para
 * o conteúdo, e o `unzip -t` do sistema para o formato — porque quem
 * vai abrir o pacote é o Premiere, não o nosso próprio leitor.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  listEntries,
  readEntry,
  readTextEntry,
  rewriteMogrt,
  utf8Encode,
} from "../src/tools/titles/mogrtZip";

/** Um ZIP mínimo montado à mão, com uma entrada deflate e uma sem compressão. */
function tinyZip(): Uint8Array {
  const json = utf8Encode('{"capsuleName":"Teste","x":1}');
  const packed = new Uint8Array(deflateRawSync(json));
  // CRC de verdade nas duas: o reescritor copia o CRC do original, e o
  // `unzip -t` do pacote reescrito confere cada um.
  const aegraphic = utf8Encode("binário de mentira ".repeat(50));
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255);
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const offsets: number[] = [];
  const entries = [
    { name: "definition.json", method: 8, data: packed, size: json.length, crc: crc32(json) },
    { name: "project.aegraphic", method: 0, data: aegraphic, size: aegraphic.length, crc: crc32(aegraphic) },
  ];
  for (const e of entries) {
    offsets.push(parts.length);
    u32(0x04034b50); u16(20); u16(0); u16(e.method); u16(0); u16(0); u32(e.crc);
    u32(e.data.length); u32(e.size); u16(e.name.length); u16(0);
    parts.push(...utf8Encode(e.name)); parts.push(...e.data);
  }
  const central = parts.length;
  entries.forEach((e, i) => {
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(e.method); u16(0); u16(0); u32(e.crc);
    u32(e.data.length); u32(e.size); u16(e.name.length); u16(0); u16(0); u16(0); u16(0); u32(0);
    u32(offsets[i]); parts.push(...utf8Encode(e.name));
  });
  u32(0x06054b50); u16(0); u16(0); u16(2); u16(2); u32(parts.length - central); u32(central); u16(0);
  return new Uint8Array(parts);
}

describe("mogrtZip", () => {
  it("lista e lê as entradas, infladas ou não", () => {
    const zip = tinyZip();
    assert.deepEqual(listEntries(zip).map((e) => e.name), ["definition.json", "project.aegraphic"]);
    assert.equal(readTextEntry(zip, "definition.json"), '{"capsuleName":"Teste","x":1}');
    assert.equal(readTextEntry(zip, "nada.txt"), null);
  });

  it("reescreve com o definition.json novo e o resto intacto", () => {
    const zip = tinyZip();
    const out = rewriteMogrt(zip, '{"capsuleName":"Novo"}');
    const entries = listEntries(out);
    assert.deepEqual(entries.map((e) => e.name), ["definition.json", "project.aegraphic"]);
    assert.equal(entries[0].method, 0);
    assert.equal(readTextEntry(out, "definition.json"), '{"capsuleName":"Novo"}');
    assert.equal(
      Buffer.from(readEntry(out, entries[1])).toString(),
      "binário de mentira ".repeat(50)
    );
  });

  it("o pacote reescrito passa no unzip do sistema", () => {
    const folder = mkdtempSync(join(tmpdir(), "mogrt-"));
    const file = join(folder, "novo.mogrt");
    writeFileSync(file, rewriteMogrt(tinyZip(), '{"capsuleName":"Novo"}'));
    const check = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /No errors detected/);
  });

  // Os modelos reais, quando estão na máquina: o que o Premiere vai abrir.
  const real = [
    join(homedir(), "Library/Application Support/Adobe/CEP/extensions/com.editorblackbelt.toolspro/tools/pr-captions/templates/BB Pop.mogrt"),
    join(homedir(), "Documents/Editor Black Belt/Titulos/SMOOTH BOUNCE.mogrt"),
  ].filter((path) => existsSync(path));
  for (const path of real) {
    it(`reescreve ${path.split("/").pop()} e o unzip aprova`, () => {
      const zip = new Uint8Array(readFileSync(path));
      const definition = readTextEntry(zip, "definition.json");
      assert.ok(definition && JSON.parse(definition).capsuleName);
      const out = rewriteMogrt(zip, definition!.replace(/"capsuleName": ?"[^"]*"/, '"capsuleName":"Copia"'));
      // O vídeo de prévia fica de fora: é o que faz 40 legendas caberem
      // no disco. A miniatura fica, por via das dúvidas do importador.
      assert.deepEqual(
        listEntries(out).map((e) => e.name).sort(),
        ["definition.json", "project.aegraphic", "thumb.png"]
      );
      const folder = mkdtempSync(join(tmpdir(), "mogrt-"));
      const file = join(folder, "copia.mogrt");
      writeFileSync(file, out);
      const check = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      // O aegraphic copiado cru tem que inflar igual ao original.
      const before = listEntries(zip).find((e) => e.name === "project.aegraphic")!;
      const after = listEntries(out).find((e) => e.name === "project.aegraphic")!;
      assert.equal(after.crc, before.crc);
      assert.equal(after.size, before.size);
    });
  }
});
