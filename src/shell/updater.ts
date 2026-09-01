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
      // O manifesto vem da rede: antes de qualquer uso, a versão tem
      // que PARECER uma versão. Tudo que a consome — o selo, o modal,
      // a comparação — passa a poder confiar no formato.
      if (typeof data.version !== "string" || !/^v?\d+(\.\d+){0,3}$/.test(data.version)) {
        throw new Error("version.json com versão em formato inesperado.");
      }
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
      await this.checkForUpdates();
    }
    const manifest = this.latestManifest;
    // O gate vale SEMPRE, não só quando o manifesto ainda não estava em
    // cache: sem isso, um manifesto igual ou mais velho já consultado
    // era "instalado" por cima do plugin em execução.
    if (!manifest || !isNewerVersion(manifest.version, this.currentVersion)) {
      return {
        success: false,
        requiresReload: false,
        message: "Nenhuma atualização disponível no momento.",
      };
    }
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

      /*
       * Os nomes e as URLs vêm do manifesto remoto — dados de rede.
       * Nome só pode ser um arquivo simples (nada de "../"), e URL só
       * pode apontar para o NOSSO repositório. Sem as duas cercas, um
       * version.json comprometido escreveria onde quisesse, vindo de
       * onde quisesse.
       */
      const allowedUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/`;
      const fileEntries = Object.entries(filesToUpdate).filter(
        ([filename, fileUrl]) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) &&
          fileUrl.startsWith(allowedUrl)
      );
      if (fileEntries.length === 0) {
        throw new Error("Manifesto sem arquivos válidos para atualizar.");
      }

      /*
       * Baixa TUDO antes de gravar QUALQUER coisa, em paralelo. A
       * versão anterior gravava arquivo a arquivo: uma queda de rede
       * no meio deixava HTML novo com JS velho na pasta do plugin, sem
       * caminho de volta. Com o lote inteiro em memória, falha de rede
       * não muda um byte no disco. E os bytes são gravados como bytes
       * (binário) — .text() reescreveria como UTF-8 qualquer arquivo
       * não-texto que um dia entre no bundle.
       */
      onProgress?.("Baixando a atualização...", 25);
      const downloads = await Promise.all(
        fileEntries.map(async ([filename, fileUrl]) => {
          const fileResponse = await fetch(`${fileUrl}?_t=${Date.now()}`, {
            cache: "no-store",
          });
          if (!fileResponse.ok) {
            throw new Error(`Falha ao baixar ${filename} (${fileResponse.status})`);
          }
          return { filename, data: await fileResponse.arrayBuffer() };
        })
      );

      const binary = getUxpModule()?.storage?.formats?.binary;
      let completed = 0;
      for (const { filename, data } of downloads) {
        onProgress?.(
          `Gravando ${filename}...`,
          60 + Math.round((completed / downloads.length) * 35)
        );
        const targetFile = await pluginFolder.createFile(filename, {
          overwrite: true,
        });
        /*
         * Binário primeiro — é o que não corrompe um asset não-texto
         * que um dia entre no bundle. Mas este é O caminho de entrega
         * do plugin: se esta build do host recusar ArrayBuffer, cair
         * para o write de texto (o que sempre funcionou) é a diferença
         * entre uma atualização e um painel quebrado sem volta.
         */
        let written = false;
        if (binary !== undefined) {
          try {
            await targetFile.write(data, { format: binary });
            written = true;
          } catch (cause) {
            console.warn("[Updater] escrita binária recusada, usando texto:", cause);
          }
        }
        if (!written) {
          await targetFile.write(decodeUtf8(data));
        }
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

/** Os bytes como texto, para o caminho de escrita de reserva. */
function decodeUtf8(data: ArrayBuffer): string {
  if (typeof TextDecoder === "function") {
    return new TextDecoder("utf-8").decode(data);
  }
  // Sem TextDecoder: monta em blocos, porque espalhar centenas de
  // milhares de bytes num apply estoura o limite de argumentos.
  const bytes = new Uint8Array(data);
  let out = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return decodeURIComponent(escape(out));
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
