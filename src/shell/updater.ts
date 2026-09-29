/**
 * Auto-Updater for Framelab
 * Checks for updates on GitHub and performs seamless in-place updates.
 *
 * A troca dos arquivos na pasta do plugin é transacional e mora em
 * `installBundle.ts`; aqui ficam a consulta ao manifesto, o download e a
 * tradução da pasta do UXP para a porta que a transação pede.
 */
import { installBundle, type InstallTarget } from "./installBundle";
import { fetchWithTimeout, NET_DEADLINE } from "../bridge/net";
import { compareVersions, hostVersion } from "../bridge/premiere";

/** O que a transação usa de um arquivo da pasta do plugin. */
interface PluginFileEntry {
  write(data: ArrayBuffer | string, options?: { format?: unknown }): Promise<unknown>;
  read(options?: { format?: unknown }): Promise<ArrayBuffer | string>;
  delete?(): Promise<unknown>;
  /** Existe só nas builds que oferecem rename. Ver `installBundle.ts`. */
  moveTo?(
    folder: unknown,
    options?: { overwrite?: boolean; newName?: string }
  ): Promise<unknown>;
}

interface PluginFolderEntry {
  createFile(name: string, options?: { overwrite?: boolean }): Promise<PluginFileEntry>;
  getEntry(name: string): Promise<PluginFileEntry>;
}

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

/** `0.4.1` -> `v0.4.1`. O manifesto aceita as duas formas. */
function versionTag(version: string): string {
  const clean = version.trim();
  return clean.startsWith("v") ? clean : `v${clean}`;
}
const VERSION_MANIFEST_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json`;

export class PluginUpdater {
  private readonly currentVersion: string;
  private readonly readHostVersion: () => string;
  private latestManifest: VersionManifest | null = null;
  private checking = false;

  /**
   * `readHostVersion` é costura de teste: fora dele, é sempre a fonte
   * única do projeto (`bridge/premiere`).
   */
  constructor(currentVersion: string, readHostVersion: () => string = hostVersion) {
    this.currentVersion = currentVersion;
    this.readHostVersion = readHostVersion;
  }

  /**
   * Este Premiere atende o mínimo que a release exige?
   *
   * O campo é OPCIONAL no contrato (`minPremiereVersion?`), então um
   * manifesto antigo que não o traga continua instalável como sempre —
   * ausência não é incompatibilidade.
   *
   * Nos outros casos a dúvida bloqueia: versão do host ilegível ou
   * mínimo mal escrito não liberam a gravação "por via das dúvidas". O
   * caminho manual (Baixar Manual) continua aberto de qualquer forma.
   */
  private hostMeets(manifest: VersionManifest): { ok: boolean; message: string } {
    const required = manifest.minPremiereVersion;
    if (required === undefined || required === null || required === "") {
      return { ok: true, message: "" };
    }
    const host = this.readHostVersion();
    const order = compareVersions(host, required);
    if (order === null) {
      return {
        ok: false,
        message: host
          ? `Não reconheci a versão do Premiere ("${host}") para conferir se ` +
            "esta atualização serve. Baixe o instalador pelo GitHub."
          : "Não consegui descobrir a versão do Premiere para conferir se " +
            "esta atualização serve. Baixe o instalador pelo GitHub.",
      };
    }
    if (order < 0) {
      return {
        ok: false,
        message:
          `Esta versão do Framelab requer Adobe Premiere Pro ${required} ou ` +
          `superior. Você está usando ${host}.`,
      };
    }
    return { ok: true, message: "" };
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
      const response = await fetchWithTimeout(
        url,
        { cache: "no-store", headers: { Accept: "application/json" } },
        NET_DEADLINE.manifest
      );

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

      /*
       * O PORTÃO DA OFERTA. Uma release que exija um Premiere mais novo
       * não é apresentada como instalável: o selo não aparece, porque
       * oferecer uma atualização que deixaria o painel sem abrir é pior
       * que não oferecer nenhuma. A frase sai no resultado e no console.
       */
      const fits = this.hostMeets(data);
      if (hasUpdate && !fits.ok) {
        console.warn("[Updater] atualização incompatível com este host:", fits.message);
        return {
          hasUpdate: false,
          currentVersion: this.currentVersion,
          latestVersion: data.version,
          manifest: data,
          error: fits.message,
        };
      }

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
  ): Promise<{
    success: boolean;
    requiresReload: boolean;
    message: string;
    /**
     * true só quando a troca falhou E a volta atrás também: a
     * instalação ficou misturada. Opcional para não mexer em quem já
     * consome as outras três — a mensagem é o canal para o editor.
     */
    critical?: boolean;
  }> {
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
    /*
     * O PORTÃO DA GRAVAÇÃO, e ele existe mesmo com o da oferta.
     *
     * O selo pode ter sido desenhado com um manifesto anterior, o modal
     * pode estar aberto desde antes, e `applyUpdate` é público. Conferir
     * de novo aqui — ANTES de baixar um byte, quanto mais de gravar — é
     * o que impede um estado velho de furar o portão visual.
     */
    const fits = this.hostMeets(manifest);
    if (!fits.ok) {
      console.error("[Updater] instalação recusada:", fits.message);
      return { success: false, requiresReload: false, message: fits.message };
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

      /*
       * Os arquivos vêm da TAG da versão anunciada, nunca do `main`.
       *
       * O `dist/` é versionado e reescrito a cada build local. Servindo
       * de `main`, o que o usuário baixava era o que estivesse lá NAQUELE
       * instante — não o código da versão que o manifesto acabou de
       * anunciar. Quem estivesse numa versão antiga e atualizasse no meio
       * de um desenvolvimento recebia trabalho pela metade, e o painel
       * dizia que tinha instalado a versão anunciada.
       *
       * Numa tag isso não acontece: ou ela existe e entrega exatamente o
       * que foi publicado, ou ela não existe e a atualização falha alto,
       * com o caminho manual oferecido logo abaixo. Falhar alto é o
       * melhor dos dois erros.
       */
      const tag = versionTag(manifest.version);
      const filesToUpdate = manifest.bundleFiles ?? {
        "manifest.json": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/manifest.json`,
        "index.html": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.html`,
        "index.js": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.js`,
        "index.css": `https://raw.githubusercontent.com/${GITHUB_REPO}/${tag}/dist/index.css`,
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
          fileUrl.startsWith(allowedUrl) &&
          // Um manifesto que aponte de volta para um ramo móvel traz de
          // volta o problema que a tag resolve, então ele é recusado
          // aqui mesmo — inclusive o nosso, se um dia regredir.
          !/^(main|master|HEAD)\//.test(fileUrl.slice(allowedUrl.length))
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
          const fileResponse = await fetchWithTimeout(
            `${fileUrl}?_t=${Date.now()}`,
            { cache: "no-store" },
            NET_DEADLINE.media
          );
          if (!fileResponse.ok) {
            throw new Error(`Falha ao baixar ${filename} (${fileResponse.status})`);
          }
          return { filename, data: await fileResponse.arrayBuffer() };
        })
      );

      /*
       * A troca dos arquivos é uma transação: ensaio ao lado, cópia de
       * segurança, troca, e volta atrás se algo falhar no meio. O porquê
       * e os estados possíveis estão em `installBundle.ts` — gravar
       * direto por cima, um a um, era o que deixava `index.html` novo ao
       * lado de `index.js` velho quando a segunda escrita falhava.
       */
      const outcome = await installBundle(
        pluginTarget(pluginFolder),
        downloads,
        onProgress
      );
      if (!outcome.ok) {
        if (outcome.critical) {
          console.error("[Updater] atualização MISTURADA:", outcome.message);
        }
        return {
          success: false,
          requiresReload: false,
          critical: outcome.critical,
          message: outcome.message,
        };
      }

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

/**
 * A pasta do plugin como a porta que a transação pede.
 *
 * Só tradução: cada operação usa o padrão que já está provado no
 * projeto — a escrita com reserva de texto é a mesma que estava no laço
 * antigo, a leitura de bytes é a de `sfx/folder.ts`, e a remoção
 * distingue "não estava lá" de "não deu para apagar", porque a volta
 * atrás depende dessa diferença para não mentir que restaurou.
 */
function pluginTarget(folder: PluginFolderEntry): InstallTarget {
  const binary = getUxpModule()?.storage?.formats?.binary;

  return {
    async writeFile(name, data) {
      const file = await folder.createFile(name, { overwrite: true });
      /*
       * Binário primeiro — é o que não corrompe um asset não-texto
       * que um dia entre no bundle. Mas este é O caminho de entrega
       * do plugin: se esta build do host recusar ArrayBuffer, cair
       * para o write de texto (o que sempre funcionou) é a diferença
       * entre uma atualização e um painel quebrado sem volta.
       */
      if (binary !== undefined) {
        try {
          await file.write(data, { format: binary });
          return;
        } catch (cause) {
          console.warn("[Updater] escrita binária recusada, usando texto:", cause);
        }
      }
      await file.write(decodeUtf8(data));
    },

    async readFile(name) {
      let file: PluginFileEntry;
      try {
        file = await folder.getEntry(name);
      } catch {
        // Ainda não existe: é um arquivo novo do bundle, e a volta
        // atrás dele é apagá-lo.
        return null;
      }
      let held: ArrayBuffer | string;
      try {
        held = await file.read(binary !== undefined ? { format: binary } : undefined);
      } catch {
        held = await file.read({ format: "binary" });
      }
      if (typeof held !== "string") {
        return held;
      }
      /*
       * Veio texto: é a mesma build que também ESCREVE texto (acima),
       * então a ida e a volta usam a mesma régua e o conteúdo fecha.
       * Só deixaria de fechar num asset não-texto, que o bundle não tem.
       */
      return utf8Bytes(held);
    },

    async deleteFile(name) {
      let file: PluginFileEntry;
      try {
        file = await folder.getEntry(name);
      } catch {
        // Não existir não é falha — é o caso comum da limpeza.
        return;
      }
      // Daqui para baixo o erro SOBE: apagar e não conseguir é uma
      // resposta diferente de não ter o que apagar.
      await file.delete?.();
    },

    async replaceFrom(stagedName, targetName) {
      const file = await folder.getEntry(stagedName);
      if (typeof file.moveTo !== "function") {
        throw new Error("moveTo indisponível nesta build");
      }
      await file.moveTo(folder, { overwrite: true, newName: targetName });
    },
  };
}

/** O par de `decodeUtf8`, para a cópia de segurança fechar a ida e volta. */
function utf8Bytes(text: string): ArrayBuffer {
  if (typeof TextEncoder === "function") {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }
  const raw = unescape(encodeURIComponent(text));
  const bytes = new Uint8Array(raw.length);
  for (let at = 0; at < raw.length; at += 1) {
    bytes[at] = raw.charCodeAt(at);
  }
  return bytes.buffer;
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
