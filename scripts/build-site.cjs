#!/usr/bin/env node
/**
 * Leva o painel de verdade para o site.
 *
 * O site mostrava uma réplica do painel feita à mão (site/panel.js), e
 * ela envelhecia a cada mudança no plugin. Agora a página carrega o
 * próprio bundle (`dist/index.js` e `dist/index.css`) num iframe, em
 * site/app/. Rode depois do `npm run build` (ou do `npm run package`):
 *
 *   node scripts/build-site.cjs
 *
 * Fora do Premiere o painel abre, navega e mostra cada ferramenta, mas
 * não aplica nada. A única coisa que ele não consegue sozinho é listar
 * o pack de SFX: o Drive recusa a leitura vinda de outro site. Para a
 * prévia, `app/demo.js` responde a listagem com um pedaço do pack real,
 * tirado da cópia que o plugin guarda em disco (`sfx/pack.json`). Sem
 * essa cópia, a amostra que já está em site/app/ é mantida.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const APP = path.join(ROOT, "site", "app");

const PACK_CANDIDATES = [
  process.env.FRAMELAB_PACK,
  path.join(
    os.homedir(),
    "Library/Application Support/Adobe/UXP/PluginsStorage/PPRO/26/Developer/com.framelab.premiere/PluginData/edit-toolbox-audio/sfx/pack.json"
  ),
].filter(Boolean);

/** Sons por pasta na amostra, e o teto da amostra inteira. */
const PER_FOLDER = 8;
const MAX_FILES = 900;

function copyBundle() {
  fs.mkdirSync(APP, { recursive: true });
  for (const name of ["index.js", "index.css"]) {
    const from = path.join(DIST, name);
    if (!fs.existsSync(from)) throw new Error(`falta ${from} — rode \`npm run build\` antes`);
    fs.copyFileSync(from, path.join(APP, name));
  }
  const stamp = fs.statSync(path.join(DIST, "index.js")).mtimeMs.toString(36);
  fs.writeFileSync(
    path.join(APP, "index.html"),
    `<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Framelab — painel</title>
    <link rel="stylesheet" href="index.css?v=${stamp}" />
  </head>
  <body>
    <div id="root"></div>
    <script src="demo.js?v=${stamp}"></script>
    <script src="index.js?v=${stamp}"></script>
  </body>
</html>
`
  );
  console.log(`  ✓ painel copiado para site/app (build ${stamp})`);
}

/**
 * Uma amostra do pack em forma de árvore de pastas, com ids inventados
 * para as pastas (o crawler só precisa que sejam únicos) e sem os ids
 * reais dos arquivos — na prévia nada é baixado.
 */
function sampleDrive() {
  const source = PACK_CANDIDATES.find((file) => fs.existsSync(file));
  if (!source) {
    console.log("  · sem sfx/pack.json no disco: a amostra de SFX fica como está");
    return;
  }
  const pack = JSON.parse(fs.readFileSync(source, "utf8"));
  const byFolder = new Map();
  for (const file of pack.files) {
    const key = file.folders.join("/");
    const list = byFolder.get(key) ?? [];
    if (list.length < PER_FOLDER) list.push(file);
    byFolder.set(key, list);
  }

  const folders = { [pack.rootId]: [] };
  const folderIds = new Map([["", pack.rootId]]);
  let nextFolder = 0;
  let nextFile = 0;
  let total = 0;

  function folderId(parts) {
    const key = parts.join("/");
    if (folderIds.has(key)) return folderIds.get(key);
    const parent = folderId(parts.slice(0, -1));
    const id = `demo-folder-${(nextFolder += 1)}`;
    folderIds.set(key, id);
    folders[id] = [];
    folders[parent].push({ id, name: parts[parts.length - 1], folder: true, stamp: "" });
    return id;
  }

  for (const [key, files] of [...byFolder.entries()].sort()) {
    if (total >= MAX_FILES) break;
    const id = folderId(key ? key.split("/") : []);
    for (const file of files) {
      folders[id].push({ id: `demo-file-${(nextFile += 1)}`, name: file.name, folder: false, stamp: file.stamp });
      total += 1;
    }
  }

  fs.writeFileSync(path.join(APP, "demo-drive.json"), JSON.stringify({ rootId: pack.rootId, folders }));
  console.log(`  ✓ amostra do pack: ${total} sons em ${Object.keys(folders).length} pastas`);
}

console.log("Site: painel de verdade em site/app");
copyBundle();
sampleDrive();
