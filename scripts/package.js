#!/usr/bin/env node
/**
 * Packaging and Release Script for Framelab
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
  execSync(command, {
    stdio: "inherit",
    cwd,
    env: {
      ...process.env,
      PATH: `${path.join(ROOT_DIR, "node_modules", ".bin")}:${process.env.PATH || ""}`,
    },
  });
}

function main() {
  console.log("\n\x1b[33m=== Empacotador do Framelab (macOS) ===\x1b[0m\n");

  const pkg = JSON.parse(fs.readFileSync(PKG_JSON_PATH, "utf8"));
  const version = pkg.version || "0.1.0";
  console.log(`Versão: \x1b[32mv${version}\x1b[0m\n`);

  // 1. Build Vite
  console.log("[1/6] Compilando TypeScript e gerando bundle Vite...");
  run("vite build");

  // 2. Criação do pacote .ccx (ZIP do conteúdo de dist/)
  console.log("\n[2/6] Gerando pacote Adobe CCX (Framelab.ccx)...");
  const ccxPath = path.join(DIST_DIR, "Framelab.ccx");
  if (fs.existsSync(ccxPath)) fs.unlinkSync(ccxPath);

  // Executa zip dentro de dist
  execSync(`zip -q -r Framelab.ccx manifest.json index.html index.js index.css`, {
    cwd: DIST_DIR,
  });
  console.log(`  ✓ CCX gerado em: ${ccxPath}`);

  // 3. Criação do pacote .pkg nativo do macOS (Apple Installer)
  console.log("\n[3/6] Gerando instalador nativo Apple (.pkg)...");
  const pkgOutputPath = path.join(DIST_DIR, "Framelab.pkg");
  if (fs.existsSync(pkgOutputPath)) fs.unlinkSync(pkgOutputPath);

  const pkgStageDir = path.join(STAGE_DIR, "pkg_root");
  fs.mkdirSync(pkgStageDir, { recursive: true });
  for (const f of ["manifest.json", "index.html", "index.js", "index.css"]) {
    fs.copyFileSync(path.join(DIST_DIR, f), path.join(pkgStageDir, f));
  }

  try {
    execSync(
      `pkgbuild --identifier com.framelab.premiere --version "${version}" --root "${pkgStageDir}" --install-location "/Library/Application Support/Adobe/UXP/Plugins/External/com.framelab.premiere" "${pkgOutputPath}"`,
      { stdio: "pipe" }
    );
    console.log(`  ✓ PKG nativo gerado em: ${pkgOutputPath}`);
  } catch (err) {
    console.warn("  ⚠ pkgbuild falhou (não crítico se em outro OS):", err.message);
  }

  // 4. Preparando pasta de release para os beta testers
  console.log("\n[4/6] Estruturando pacote do instalador macOS...");
  const bundleFolder = path.join(STAGE_DIR, "Framelab-macOS");
  fs.mkdirSync(bundleFolder, { recursive: true });

  // Copia os instaladores principais (PKG e CCX)
  if (fs.existsSync(pkgOutputPath)) {
    fs.copyFileSync(pkgOutputPath, path.join(bundleFolder, "Framelab.pkg"));
  }
  fs.copyFileSync(ccxPath, path.join(bundleFolder, "Framelab.ccx"));

  // Copia os scripts do instalador alternativo e documentação
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "Instalar_Framelab.command"),
    path.join(bundleFolder, "Instalar_Framelab.command")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "Desinstalar_Framelab.command"),
    path.join(bundleFolder, "Desinstalar_Framelab.command")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "LEIA-ME.txt"),
    path.join(bundleFolder, "LEIA-ME.txt")
  );
  fs.copyFileSync(
    path.join(INSTALLER_DIR, "GUIA_BETA_TESTER.md"),
    path.join(bundleFolder, "GUIA_BETA_TESTER.md")
  );

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
  fs.chmodSync(path.join(bundleFolder, "Instalar_Framelab.command"), 0o755);
  fs.chmodSync(path.join(bundleFolder, "Desinstalar_Framelab.command"), 0o755);

  // 5. Criação do ZIP final de distribuição
  console.log("\n[5/6] Criando arquivo ZIP final de distribuição (Framelab-macOS.zip)...");
  const zipOutputPath = path.join(DIST_DIR, "Framelab-macOS.zip");
  if (fs.existsSync(zipOutputPath)) fs.unlinkSync(zipOutputPath);

  execSync(`zip -q -r "${zipOutputPath}" Framelab-macOS`, {
    cwd: STAGE_DIR,
  });
  console.log(`  ✓ ZIP gerado: ${zipOutputPath} (${(fs.statSync(zipOutputPath).size / 1024 / 1024).toFixed(2)} MB)`);

  // Limpa stage
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });

  // 6. Atualiza version.json
  console.log("\n[6/6] Sincronizando version.json...");
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
  versionManifest.downloadUrl = `https://github.com/SidyFurtado/framelab/releases/latest/download/Framelab-macOS.zip`;

  fs.writeFileSync(VERSION_JSON_PATH, JSON.stringify(versionManifest, null, 2) + "\n");
  console.log("  ✓ version.json sincronizado com a versão " + version);

  console.log("\n\x1b[32m🎉 TODOS OS PACOTES GERADOS COM SUCESSO!\x1b[0m");
  console.log(`  📦 Instalador Nativo Apple: ${pkgOutputPath}`);
  console.log(`  📦 Pacote Adobe CCX:       ${ccxPath}`);
  console.log(`  📦 ZIP Completo:           ${zipOutputPath}\n`);
}

main();
