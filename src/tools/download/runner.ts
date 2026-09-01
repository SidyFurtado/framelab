/**
 * O runner silencioso: executa o script de trabalho SEM abrir Terminal.
 *
 * ── Por que um .app ────────────────────────────────────────────────
 * `shell.openPath` num `.command` sempre abre o Terminal — era a única
 * rota, e virou a reclamação número um do beta: uma janela piscando a
 * cada análise. Mas openPath num `.app` pede ao LaunchServices que
 * LANCE o aplicativo — e um bundle mínimo com `LSUIElement` roda sem
 * janela, sem Dock, sem nada. O "aplicativo" é três arquivos escritos
 * pelo próprio plugin: um Info.plist, um executável de quatro linhas
 * que chama o script de trabalho, e o PkgInfo de praxe.
 *
 * Gatekeeper não pega: quarentena é atributo de arquivo BAIXADO, e
 * este bundle nasce localmente, escrito pelo fs do UXP.
 *
 * ── E quando não der ───────────────────────────────────────────────
 * O script carimba `dl-started.txt` na primeira linha. Se o carimbo
 * não aparecer em alguns segundos, quem chamou volta para o caminho
 * antigo — openPath no `.command`, Terminal e tudo. Feio e visível,
 * mas funcionando: o fallback existe para a build de host onde o
 * lançamento de .app for recusado.
 *
 * No Windows o equivalente é um `.vbs`: o WScript roda o `.bat` com a
 * janela invisível (`, 0, False`).
 */
import {
  ensureDir,
  isWindows,
  nativePath,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

const APP_DIR = "FramelabRunner.app";
const VBS_FILE = "run-quiet.vbs";

/** O que o chamador dispara com openPath. */
export interface SilentLauncher {
  /** Caminho nativo do lançador (.app no macOS, .vbs no Windows). */
  path: string;
}

/**
 * Escreve (ou reescreve) o lançador e devolve o caminho dele.
 *
 * Reescrever sempre é barato — três arquivos pequenos — e é o que faz
 * uma atualização do plugin trocar o runner junto, sem versão presa.
 */
export async function ensureSilentLauncher(
  scriptName: string
): Promise<SilentLauncher> {
  const space = await workspace();

  if (isWindows()) {
    await write(space, VBS_FILE, vbsSource(space, scriptName));
    return { path: nativePath(space, VBS_FILE) };
  }

  await ensureDir(space, `${APP_DIR}/Contents/MacOS`);
  await write(space, `${APP_DIR}/Contents/Info.plist`, infoPlist());
  await write(space, `${APP_DIR}/Contents/PkgInfo`, "APPL????");
  await write(space, `${APP_DIR}/Contents/MacOS/run`, runSource(scriptName), true);
  return { path: nativePath(space, APP_DIR) };
}

/**
 * O executável do bundle. Acha a pasta de trabalho subindo a partir de
 * si mesmo — o bundle mora DENTRO dela — e entrega o stdout ao nada:
 * tudo que importa já sai por arquivo, e ecoar para lugar nenhum é o
 * ponto da existência dele.
 */
export function runSource(scriptName: string): string {
  return [
    "#!/bin/bash",
    "# Gerado pelo Framelab — roda o script de trabalho sem Terminal.",
    'DIR="$(cd "$(dirname "$0")/../../.." && pwd)"',
    `exec /bin/bash "$DIR/${scriptName}" > /dev/null 2>&1`,
    "",
  ].join("\n");
}

/** LSUIElement é a linha que importa: agente, sem janela e sem Dock. */
export function infoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleName</key><string>Framelab Runner</string>",
    "  <key>CFBundleIdentifier</key><string>com.framelab.runner</string>",
    "  <key>CFBundleExecutable</key><string>run</string>",
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    "  <key>CFBundleShortVersionString</key><string>1.0</string>",
    "  <key>LSUIElement</key><true/>",
    "  <key>LSBackgroundOnly</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Aspas de VBScript: dobradas dentro da string. */
export function vbsSource(space: Workspace, scriptName: string): string {
  const script = nativePath(space, scriptName).replace(/"/g, '""');
  return [
    "' Gerado pelo Framelab - roda o script de trabalho sem janela.",
    'CreateObject("WScript.Shell").Run "cmd /c """ & ' +
      `"${script}" & """", 0, False`,
    "",
  ].join("\r\n");
}
