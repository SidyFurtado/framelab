/**
 * O script que baixa — conferido contra o defeito de 23/09/2026.
 *
 * Medido no yt-dlp 2026.08.19 que o plugin instala, com a pasta real
 * `.../Arquivo de Edição /01. Male` e `-P` apontando para ela:
 *
 *   --windows-filenames     → …/Arquivo de Edição#/01. Male/…
 *   --no-windows-filenames  → …/Arquivo de Edição /01. Male/…
 *
 * O motivo está no `sanitize_path` do yt-dlp: com `force=True` ele
 * aplica `[\s.]$ → '#'` a CADA componente do caminho, e o `-P` entra
 * nessa conta. Este arquivo existe para que a flag nunca volte.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downloadScriptUnix, downloadScriptWin, DEFAULT_CONFIG, type Quality } from "../src/tools/download/ytdlp";
import { pairDownloads } from "../src/tools/download/history";

/** A pasta do enunciado, com o espaço final que começou tudo. */
const DEST = "/Users/sidy/Library/CloudStorage/GoogleDrive-x/H&W - Edição de Vídeo -Q3/Arquivo de Edição /01. Male Enhancement";

const QUALITY: Quality = { id: "1080", label: "1080p", height: 1080, audioOnly: false };
const URLS = ["https://www.youtube.com/watch?v=abc"];

function unix(destination = DEST, mayCreate = false): string {
  return downloadScriptUnix(URLS, QUALITY, DEFAULT_CONFIG, "/tmp/work", destination, [], "", mayCreate);
}

describe("o script não reescreve a pasta escolhida", () => {
  it("nunca passa --windows-filenames", () => {
    const script = unix();
    assert.ok(!/(?<!-no)-windows-filenames/.test(script.replace(/--no-windows-filenames/g, "")),
      "a flag que trocava o espaço final por # voltou ao script");
    assert.match(script, /--no-windows-filenames/);
  });

  it("o .bat também não", () => {
    const script = downloadScriptWin(URLS, QUALITY, DEFAULT_CONFIG, "C:\\work", "C:\\Videos", [], "", false);
    assert.match(script, /--no-windows-filenames/);
  });

  it("a pasta entra no script letra por letra, espaço final incluído", () => {
    const script = unix();
    assert.ok(
      script.includes(`DEST='${DEST}'`),
      "o caminho foi reescrito antes de chegar ao script"
    );
    assert.ok(!script.includes("Arquivo de Edição#"), "o # apareceu de novo");
  });
});

describe("o script não inventa pasta", () => {
  it("uma pasta escolhida que não existe PARA o download", () => {
    const script = unix();
    assert.ok(!/mkdir -p "\$DEST"/.test(script), 'o `mkdir -p "$DEST"` silencioso voltou');
    assert.match(script, /if \[ ! -d "\$DEST" \]; then/);
    assert.match(script, /destination-missing/);
    assert.match(script, /exit 1/);
  });

  it("a pasta PADRÃO do plugin, essa ele pode criar", () => {
    const script = unix("/Users/sidy/Movies/Framelab", true);
    assert.match(script, /mkdir -p "\$DEST"/);
    assert.ok(!script.includes("destination-missing"));
  });

  it("no Windows a regra é a mesma", () => {
    const strict = downloadScriptWin(URLS, QUALITY, DEFAULT_CONFIG, "C:\\w", "D:\\Editar", [], "", false);
    assert.ok(!/if not exist "%DEST%" mkdir/.test(strict));
    assert.match(strict, /destination-missing/);
    const loose = downloadScriptWin(URLS, QUALITY, DEFAULT_CONFIG, "C:\\w", "C:\\Videos\\Framelab", [], "", true);
    assert.match(loose, /if not exist "%DEST%" mkdir/);
  });
});

describe("o diário do Baixar", () => {
  const AT = "2026-09-24T10:00:00.000Z";

  it("pareia o que a via rápida baixou pelo nome do arquivo", () => {
    const records = pairDownloads(
      [`${DEST}/Gato [123].mp4`],
      [{ mediaUrl: "https://cdn/x", fileName: "Gato [123].mp4", sourceUrl: "https://tiktok.com/@a/video/1" }],
      ["https://tiktok.com/@a/video/1"],
      DEST,
      AT
    );
    assert.deepEqual(records, [
      {
        at: AT,
        url: "https://tiktok.com/@a/video/1",
        name: "Gato [123].mp4",
        path: `${DEST}/Gato [123].mp4`,
        destination: DEST,
      },
    ]);
  });

  it("pareia por posição o que sobrou para o yt-dlp", () => {
    const records = pairDownloads(
      ["/d/um.mp4", "/d/dois.mp4"],
      [],
      ["https://y/1", "https://y/2"],
      "/d",
      AT
    );
    assert.deepEqual(records.map((r) => r.url), ["https://y/1", "https://y/2"]);
  });

  it("prefere um null honesto a um link adivinhado", () => {
    const records = pairDownloads(["/d/um.mp4", "/d/dois.mp4"], [], ["https://y/1"], "/d", AT);
    assert.deepEqual(records.map((r) => r.url), [null, null]);
  });

  it("guarda a pasta PEDIDA junto do caminho escrito", () => {
    const [record] = pairDownloads(["/outra/arvore/um.mp4"], [], [], DEST, AT);
    assert.equal(record.destination, DEST);
    assert.equal(record.path, "/outra/arvore/um.mp4");
  });
});
