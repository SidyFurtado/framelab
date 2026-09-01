/**
 * Auto-Updater for Framelab
 * Checks for updates on GitHub and performs seamless in-place updates.
 */

export interface VersionManifest {
  version: string;
  releaseDate: string;
  changelog: string;
  downloadUrl: string;
  minPremiereVersion?: string;
  bundleFiles?: Record<string, string>;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  manifest: VersionManifest | null;
  error?: string;
}

const GITHUB_REPO = "SidyFurtado/framelab";
const VERSION_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json`;

export class PluginUpdater {
  private readonly currentVersion: string;
  private latestManifest: VersionManifest | null = null;
  private checking = false;

  constructor(currentVersion: string) {
    this.currentVersion = currentVersion;
  }

  /**
   * Checks GitHub repository for the latest version.json
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (this.checking) {
      return {
        hasUpdate: false,
        currentVersion: this.currentVersion,
        latestVersion: this.latestManifest?.version ?? this.currentVersion,
        manifest: this.latestManifest,
      };
    }

    this.checking = true;
    try {
      // Cache-busting query parameter
      const url = `${VERSION_MANIFEST_URL}?_t=${Date.now()}`;
      const response = await fetch(url, {
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Servidor respondeu com status ${response.status}`);
      }

      const data = (await response.json()) as VersionManifest;
      this.latestManifest = data;

      const hasUpdate = isNewerVersion(data.version, this.currentVersion);

      return {
        hasUpdate,
        currentVersion: this.currentVersion,
        latestVersion: data.version,
        manifest: data,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.warn("[Updater] Erro ao verificar atualizações:", message);
      return {
        hasUpdate: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        manifest: null,
        error: message,
      };
    } finally {
      this.checking = false;
    }
  }

  /**
   * Applies the update directly into the plugin folder (in-place)
   */
  async applyUpdate(
    onProgress?: (step: string, percent: number) => void
  ): Promise<{ success: boolean; requiresReload: boolean; message: string }> {
    if (!this.latestManifest) {
      const check = await this.checkForUpdates();
      if (!check.hasUpdate || !check.manifest) {
        return {
          success: false,
          requiresReload: false,
          message: "Nenhuma atualização disponível no momento.",
        };
      }
    }

    const manifest = this.latestManifest!;
    onProgress?.("Conectando ao GitHub...", 15);

    try {
      // Access UXP localFileSystem
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const uxp = getUxpModule();
      if (!uxp?.storage?.localFileSystem) {
        throw new Error("Sistema de arquivos UXP indisponível.");
      }

      const fs = uxp.storage.localFileSystem;
      const pluginFolder = await fs.getPluginFolder();

      const filesToUpdate = manifest.bundleFiles ?? {
        "manifest.json": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/manifest.json`,
        "index.html": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.html`,
        "index.js": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.js`,
        "index.css": `https://raw.githubusercontent.com/${GITHUB_REPO}/main/dist/index.css`,
      };

      const fileEntries = Object.entries(filesToUpdate);
      const totalFiles = fileEntries.length;
      let completed = 0;

      for (const [filename, fileUrl] of fileEntries) {
        onProgress?.(
          `Baixando ${filename}...`,
          20 + Math.round((completed / totalFiles) * 60)
        );

        const fileResponse = await fetch(`${fileUrl}?_t=${Date.now()}`, {
          cache: "no-store",
        });

        if (!fileResponse.ok) {
          throw new Error(
            `Falha ao baixar ${filename} (${fileResponse.status})`
          );
        }

        const fileData = await fileResponse.text();

        onProgress?.(
          `Gravando ${filename}...`,
          20 + Math.round(((completed + 0.5) / totalFiles) * 60)
        );

        const targetFile = await pluginFolder.createFile(filename, {
          overwrite: true,
        });
        await targetFile.write(fileData);

        completed += 1;
      }

      onProgress?.("Atualização concluída!", 100);
      return {
        success: true,
        requiresReload: true,
        message: `Framelab v${manifest.version} instalado com sucesso!`,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("[Updater] Falha na atualização in-place:", message);

      // Fallback: offer external download
      return {
        success: false,
        requiresReload: false,
        message:
          `Não foi possível atualizar automaticamente: ${message}. ` +
          "Clique para baixar o instalador mais recente pelo GitHub.",
      };
    }
  }

  /**
   * Opens the download link in default browser
   */
  openDownloadPage(): void {
    const url =
      this.latestManifest?.downloadUrl ??
      `https://github.com/${GITHUB_REPO}/releases/latest`;

    try {
      const uxp = getUxpModule();
      if (uxp?.shell?.openExternal) {
        uxp.shell.openExternal(url);
        return;
      }
    } catch {
      // Fallback
    }

    if (typeof window !== "undefined") {
      window.open(url, "_blank");
    }
  }

  /**
   * Reloads the plugin panel view
   */
  reloadPlugin(): void {
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUxpModule(): any {
  try {
    // @ts-ignore
    if (typeof require === "function") {
      // @ts-ignore
      return require("uxp");
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Compare two semver strings: returns true if candidate > current
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((part) => parseInt(part, 10) || 0);

  const [cMajor = 0, cMinor = 0, cPatch = 0] = parse(candidate);
  const [curMajor = 0, curMinor = 0, curPatch = 0] = parse(current);

  if (cMajor > curMajor) return true;
  if (cMajor < curMajor) return false;
  if (cMinor > curMinor) return true;
  if (cMinor < curMinor) return false;
  return cPatch > curPatch;
}
