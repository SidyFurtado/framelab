#!/usr/bin/env node
/**
 * Packaging and Release Script for Edit Toolbox
 * Builds, packages .ccx, creates standalone macOS installer ZIP, and updates version.json.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const INSTALLER_DIR = path.join(ROOT_DIR, "installer");
const PKG_JSON_PATH = path.join(ROOT_DIR, "package.json");
const VERSION_JSON_PATH = path.join(ROOT_DIR, "version.json");
const STAGE_DIR = path.join(ROOT_DIR, ".release_stage");

function run(command, cwd = ROOT_DIR) {
  console.log(`\x1b[36m> ${command}\x1b[0m`);
  execSync(command, { stdio: "inherit", cwd });
}

function main() {
  console.log("\n\x1b[33m=== Empacotador do Edit Toolbox (macOS) ===\x1b[0m\n");

  const pkg = JSON.parse(fs.readFileSync(PKG_JSON_PATH, "utf8"));
  const version = pkg.version || "0.1.0";
  console.log(`Versão: \x1b[32mv${version}\x1b[0m\n`);

  // 1. Build Vite
  console.log("[1/5] Compilando TypeScript e gerando bundle Vite...");
  run("npm run build");

  // 2. Criação do pacote .ccx (ZIP do conteúdo de dist/)
  console.log("\n[2/5] Gerando pacote Adobe CCX (EditToolbox.ccx)...");
  const ccxPath = path.join(DIST_DIR, "EditToolbox.ccx");
  if (fs.existsSync(ccxPath)) fs.unlinkSync(ccxPath);

  // Executa zip dentro de dist
  execSync(`zip -q -r EditToolbox.ccx manifest.json index.html index.js index.css`, {
    cwd: DIST_DIR,
  });
  console.log(`  ✓ CCX gerado em: ${ccxPath}`);

  // 3. Preparando pasta de release para os beta testers
  console.log("\n[3/5] Estruturando pacote do instalador macOS...");
  if (fs.existsSync(STAGE_DIR)) {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  }

  const bundleFolder = path.join(STAGE_DIR, "EditToolbox-macOS");
  fs.mkdirSync(bundleFolder, { recursive: true });

  // Copia os scripts do instalador
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "Instalar_Edit_Toolbox.command"),
    path.join(bundleFolder, "Instalar_Edit_Toolbox.command")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "Desinstalar_Edit_Toolbox.command"),
    path.join(bundleFolder, "Desinstalar_Edit_Toolbox.command")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "LEIA-ME.txt"),
    path.join(bundleFolder, "LEIA-ME.txt")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "GUIA_BETA_TESTER.md"),
    path.join(bundleFolder, "GUIA_BETA_TESTER.md")
  );
  fs.copyFileSync(ccxPath, path.join(bundleFolder, "EditToolbox.ccx"));

  // Copia pasta dist para dentro do pacote
  const distInBundle = path.join(bundleFolder, "dist");
  fs.mkdirSync(distInBundle, { recursive: true });
  for (const f of ["manifest.json", "index.html", "index.js", "index.css"]) {
    const src = path.join(DIST_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(distInBundle, f));
    }
  }

  // Garante permissão de execução nos scripts
  fs.chmodSync(path.join(bundleFolder, "Instalar_Edit_Toolbox.command"), 0o755);
  fs.chmodSync(path.join(bundleFolder, "Desinstalar_Edit_Toolbox.command"), 0o755);

  // 4. Criação do ZIP final de distribuição
  console.log("\n[4/5] Criando arquivo ZIP final de distribuição (EditToolbox-macOS.zip)...");
  const zipOutputPath = path.join(DIST_DIR, "EditToolbox-macOS.zip");
  if (fs.existsSync(zipOutputPath)) fs.unlinkSync(zipOutputPath);

  execSync(`zip -q -r "${zipOutputPath}" EditToolbox-macOS`, {
    cwd: STAGE_DIR,
  });
  console.log(`  ✓ ZIP gerado: ${zipOutputPath} (${(fs.statSync(zipOutputPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // Limpa stage
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  // 5. Atualiza version.json
  console.log("\n[5/5] Sincronizando version.json...");
  let versionManifest = {};
  if (fs.existsSync(VERSION_JSON_PATH)) {
    try {
      versionManifest = JSON.parse(fs.readFileSync(VERSION_JSON_PATH, "utf8"));
    } catch {
      // ignore
    }
  }

  versionManifest.version = version;
  versionManifest.releaseDate = new Date().toISOString().split("T")[0];
  versionManifest.downloadUrl = `https://github.com/SidyFurtado/edit-toolbox/releases/latest/download/EditToolbox-macOS.zip`;

  fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(versionManifest, null, 2) + "\n");
  console.log("  ✓ version.json sincronizado com a versão " + version);

  console.log("\n\x1b[32m🎉 PACOTES GERADOS COM SUCESSO!\x1b[0m");
  console.log(`  📦 ZIP de Distribuição: ${zipOutputPath}`);
  console.log(`  📦 Pacote CCX:          ${ccxPath}\n`);
}

main();
