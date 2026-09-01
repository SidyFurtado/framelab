/**
 * Baixar Vídeos — a ferramenta.
 *
 * Dona só do corpo; a Shell é dona do cabeçalho, do callout e das
 * ações. O botão Aplicar da Shell baixa, o secundário limpa a lista.
 *
 * O fluxo tem dois tempos de propósito. ANALISAR consulta os links e
 * mostra título, duração e as resoluções que aquele vídeo tem de
 * verdade — é barato, é rede e nada mais, e é o que impede a escada de
 * qualidade de oferecer 4K num TikTok vertical de 1080. BAIXAR é o
 * caro, e só acontece depois que o editor viu o que vai receber.
 *
 * Analisar não é obrigatório: com um link colado e nenhuma análise, o
 * botão baixa assim mesmo, na qualidade escolhida. Obrigar a análise
 * seria cobrar dois cliques por uma resposta que o editor muitas vezes
 * já sabe.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL, setDisabled, escapeHtml } from "../../shell/controls";
import { getPremiere, describeError } from "../../bridge/premiere";
import {
  availableQualities,
  defaultDestination,
  describeRunError,
  downloadUrls,
  findQuality,
  formatBytes,
  formatClock,
  installYtdlp,
  openWorkFolder,
  probeUrls,
  readConfig,
  writeConfig,
  type Cookies,
  type DownloadConfig,
  type Probe,
  type Quality,
} from "./ytdlp";
import { uxpModule } from "../silence/workspace";
import {
  fetchManyTikTok,
  isTikTokUrl,
  tiktokFileName,
  type TikTokFast,
} from "./tiktok";
import type { DirectJob } from "./ytdlp";
import { downloadInPanel, rememberFolderToken } from "./panelFetch";

/**
 * Um botão que abre uma lista de opções.
 *
 * Existe porque a alternativa — uma barra de segmentos com sete
 * degraus de qualidade e uma linha de nota embaixo explicando os
 * degraus — enchia a tela para responder uma pergunta que se responde
 * uma vez. Fechado, ocupa uma linha e diz a escolha; aberto, mostra o
 * tamanho de cada opção, que é a informação que de fato decide.
 *
 * Também resolve os seis navegadores dos cookies: o UXP não honra
 * `flex-wrap`, então uma fila de seis chips não quebrava linha — ela
 * espremia todos até ninguém conseguir ler.
 */
interface MenuOption {
  readonly id: string;
  readonly label: string;
  /** Direita da linha: tamanho, resolução. Vazio some. */
  readonly meta?: string;
}

interface Dropdown {
  /** Relê as opções e o selecionado. */
  render(): void;
  /** Fecha, a menos que o clique tenha sido dentro dele. */
  closeUnless(target: Element | null): void;
}

function mountDropdown(
  host: HTMLElement,
  source: {
    options(): MenuOption[];
    selected(): string;
    onPick(id: string): void;
  }
): Dropdown {
  host.className = "dl-pick-wrap";
  host.innerHTML =
    `<div class="dl-pick" ${CONTROL} data-pick-button aria-expanded="false">` +
      '<span class="dl-pick-value" data-pick-value></span>' +
      '<span class="dl-pick-meta" data-pick-meta></span>' +
      '<span class="dl-pick-caret" aria-hidden="true">▾</span>' +
    "</div>" +
    '<div class="dl-menu" data-pick-menu hidden></div>';

  const button = host.querySelector<HTMLElement>("[data-pick-button]")!;
  const valueEl = host.querySelector<HTMLElement>("[data-pick-value]")!;
  const metaEl = host.querySelector<HTMLElement>("[data-pick-meta]")!;
  const menu = host.querySelector<HTMLElement>("[data-pick-menu]")!;

  function setOpen(open: boolean): void {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }

  function render(): void {
    const options = source.options();
    const selected = source.selected();
    const current = options.find((option) => option.id === selected);

    valueEl.textContent = current?.label ?? "—";
    metaEl.textContent = current?.meta ?? "";

    menu.innerHTML = options
      .map(
        (option) =>
          `<div class="dl-menu-item" ${CONTROL} data-value="${escapeHtml(option.id)}" ` +
          `aria-pressed="${option.id === selected}">` +
          `<span class="dl-menu-name">${escapeHtml(option.label)}</span>` +
          `<span class="dl-menu-meta">${escapeHtml(option.meta ?? "")}</span>` +
          "</div>"
      )
      .join("");
  }

  button.addEventListener("click", () => setOpen(menu.hidden));

  menu.addEventListener("click", (event) => {
    const item = (event.target as Element | null)?.closest<HTMLElement>("[data-value]");
    const id = item?.dataset.value;
    if (!id) return;
    setOpen(false);
    source.onPick(id);
  });

  render();

  return {
    render,
    closeUnless(target) {
      if (!menu.hidden && !host.contains(target)) {
        setOpen(false);
      }
    },
  };
}

/**
 * A via rápida consultada para cada posição da lista.
 *
 * Pareado por índice, não por indexOf: o mesmo link colado duas vezes
 * fazia indexOf apontar sempre para a primeira ocorrência, e a segunda
 * herdava a resposta errada. É também o ÚNICO lugar que decide quem
 * qualifica para a via rápida — sondagem e download passavam por duas
 * cópias da mesma decisão.
 */
async function fastLaneByIndex(
  list: readonly string[]
): Promise<Map<number, TikTokFast>> {
  const positions = list
    .map((url, index) => ({ url, index }))
    .filter((entry) => isTikTokUrl(entry.url));
  const infos = await fetchManyTikTok(positions.map((entry) => entry.url));
  const byIndex = new Map<number, TikTokFast>();
  positions.forEach((entry, at) => {
    const info = infos[at];
    if (info) {
      byIndex.set(entry.index, info);
    }
  });
  return byIndex;
}

/** O que o painel aceita como link. Uma linha em branco não é erro. */
function parseUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S+$/i.test(line));
}

/**
 * Quantos links o texto tem, incluindo os que não passam no filtro.
 *
 * Serve para dizer "3 de 4 linhas não são links" em vez de ignorar em
 * silêncio o que o editor colou torto.
 */
function countLines(raw: string): number {
  return raw.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 0).length;
}

const COOKIE_LABELS: Record<Cookies, string> = {
  none: "Nenhum",
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  edge: "Edge",
  brave: "Brave",
};

/**
 * Solta os listeners de documento dos menus.
 *
 * Eles vivem em `document`, não no corpo que a Shell substitui — sem
 * isto, cada visita à ferramenta deixava mais um par para trás.
 */
let releaseDocument: (() => void) | null = null;

export const downloadTool: Tool = {
  id: "download",
  name: "Baixar Vídeos",
  summary: "Download de YouTube e TikTok",
  hint:
    "Cole um ou mais links do YouTube ou do TikTok. O TikTok vem sempre " +
    "sem marca d'água, e o arquivo pode entrar direto no projeto aberto.",
  category: "midia",
  glyph: "download",
  available: true,
  usesSelection: false,

  mount(container: HTMLElement, context: ToolContext): void {
    let config: DownloadConfig = {
      ytdlpPath: "",
      destination: "",
      destinationToken: "",
      quality: "1080",
      cookies: "none",
      importToProject: true,
    };
    let probes: Probe[] = [];
    let busy = false;
    let cancelled = false;

    container.innerHTML = markup();

    const urlsEl = container.querySelector<HTMLTextAreaElement>("[data-urls]");
    const scanEl = container.querySelector<HTMLElement>("[data-scan]");
    const listEl = container.querySelector<HTMLElement>("[data-list]");
    const qualityHostEl = container.querySelector<HTMLElement>("[data-quality-pick]");
    const cookiesHostEl = container.querySelector<HTMLElement>("[data-cookies-pick]");
    const destEl = container.querySelector<HTMLElement>("[data-dest]");
    const pickEl = container.querySelector<HTMLElement>("[data-pick]");
    const importSegEl = container.querySelector<HTMLElement>("[data-import-seg]");
    const pathEl = container.querySelector<HTMLInputElement>("[data-ytdlp-path]");
    const installEl = container.querySelector<HTMLElement>("[data-install]");
    const folderEl = container.querySelector<HTMLElement>("[data-open-folder]");
    const advToggleEl = container.querySelector<HTMLElement>("[data-adv-toggle]");
    const advContentEl = container.querySelector<HTMLElement>("[data-adv-content]");
    const advIconEl = container.querySelector<HTMLElement>("[data-adv-icon]");
    const manualEl = container.querySelector<HTMLElement>("[data-manual]");
    const progressEl = container.querySelector<HTMLElement>("[data-progress]");
    const logEl = container.querySelector<HTMLElement>("[data-log]");

    /**
     * Os menus abertos, para um clique em qualquer outro lugar fechá-los.
     * Sem isto, o menu só fechava escolhendo — e desistir da escolha
     * exigia escolher.
     */
    const dropdowns: Dropdown[] = [];

    const qualityPick = qualityHostEl
      ? mountDropdown(qualityHostEl, {
          options: () =>
            availableQualities(probes).map((quality) => ({
              id: quality.id,
              label: quality.label,
              meta: qualityMeta(quality, probes),
            })),
          selected: () => config.quality,
          onPick: (id) => {
            config.quality = id;
            persist();
            renderQualities();
            renderList();
          },
        })
      : null;
    if (qualityPick) dropdowns.push(qualityPick);

    const cookiesPick = cookiesHostEl
      ? mountDropdown(cookiesHostEl, {
          options: () =>
            (Object.keys(COOKIE_LABELS) as Cookies[]).map((key) => ({
              id: key,
              label: COOKIE_LABELS[key],
            })),
          selected: () => config.cookies,
          onPick: (id) => {
            config.cookies = id as Cookies;
            persist();
            cookiesPick?.render();
          },
        })
      : null;
    if (cookiesPick) dropdowns.push(cookiesPick);

    function closeMenus(target: Element | null): void {
      for (const dropdown of dropdowns) {
        dropdown.closeUnless(target);
      }
    }

    const onDocumentPointer = (event: Event): void => {
      closeMenus(event.target as Element | null);
    };
    const onDocumentKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenus(null);
      }
    };
    // Na captura: um clique num controle que para a propagação ainda
    // assim fecha o menu que estava aberto atrás dele.
    document.addEventListener("click", onDocumentPointer, true);
    document.addEventListener("keydown", onDocumentKey, true);
    releaseDocument = () => {
      document.removeEventListener("click", onDocumentPointer, true);
      document.removeEventListener("keydown", onDocumentKey, true);
    };

    context.setApplyLabel("BAIXAR");
    context.setApplyEnabled(false);
    context.setResetLabel("LIMPAR");
    context.setResetHandler(null);

    // ── configuração salva ────────────────────────────────────

    void (async () => {
      config = await readConfig();
      if (!config.destination) {
        // O campo mostra para onde vai de verdade, e não um vazio que
        // o editor teria de adivinhar.
        config.destination = await defaultDestination().catch(() => "");
      }
      if (pathEl) pathEl.value = config.ytdlpPath;
      renderDestination();
      renderQualities();
      cookiesPick?.render();
      renderSegs();
      syncApply();
    })();

    function persist(): void {
      void writeConfig(config);
    }

    // ── links ─────────────────────────────────────────────────

    function urls(): string[] {
      return parseUrls(urlsEl?.value ?? "");
    }

    function syncApply(): void {
      const list = urls();
      context.setApplyEnabled(!busy && list.length > 0);
      if (scanEl) {
        setDisabled(scanEl, busy || list.length === 0);
      }
      if (list.length === 0) {
        const typed = countLines(urlsEl?.value ?? "");
        context.setStatus(
          typed > 0 ? "Nenhuma linha parece um link (http/https)." : "",
          typed > 0 ? "error" : "idle"
        );
      }
    }

    urlsEl?.addEventListener("input", () => {
      // Uma lista analisada deixa de valer no instante em que os links
      // mudam; mantê-la na tela seria mostrar os dados de outro vídeo.
      if (probes.length > 0) {
        probes = [];
        renderList();
        renderQualities();
      }
      syncApply();
    });

    // ── analisar ──────────────────────────────────────────────

    scanEl?.addEventListener("click", () => void runProbe());

    async function runProbe(): Promise<void> {
      const list = urls();
      if (busy || list.length === 0) {
        return;
      }
      startBusy("Consultando os links…");
      if (scanEl) scanEl.textContent = "Consultando…";
      showProgress("consulta", null, "lendo os links…");

      try {
        // TikTok vai pela via rápida (uma chamada de API, ~1s); o que
        // ela não resolver — e todo o resto — vai pelo yt-dlp. Ver
        // tiktok.ts para o porquê da existência das duas portas.
        const fast = await fastLaneByIndex(list);
        const byIndex = new Map<number, Probe>();
        const slow: string[] = [];
        const slowAt: number[] = [];
        list.forEach((url, index) => {
          const info = fast.get(index);
          if (info) {
            byIndex.set(index, fastProbe(url, info));
          } else {
            slow.push(url);
            slowAt.push(index);
          }
        });

        let result = { ok: true, error: null as string | null, log: "", ytdlpPath: null as string | null };
        if (slow.length > 0) {
          const scripted = await probeUrls(
            slow,
            config,
            (done, total, _percent, log) => {
              showProgress(`${done}/${total}`, null);
              showLog(log);
            },
            () => cancelled,
            showManual
          );
          result = { ...result, ...scripted.result };
          scripted.probes.forEach((probe, at) => byIndex.set(slowAt[at], probe));
        }

        probes = list
          .map((_, index) => byIndex.get(index))
          .filter((p): p is Probe => !!p);
        renderList();
        renderQualities();

        const ok = probes.filter((probe) => probe.ok).length;
        // O log é a explicação de uma falha, não um diário: com tudo
        // certo ele sai da frente.
        showLog(ok === probes.length && result.ok ? "" : result.log);
        if (ok === 0) {
          context.setStatus(describeRunError(result.error ?? "ytdlp-failed", result.log), "error");
        } else if (ok < probes.length) {
          context.setStatus(`${ok} de ${probes.length} links lidos.`, "error");
        } else {
          context.setStatus(
            `${ok} ${ok === 1 ? "vídeo pronto" : "vídeos prontos"} para baixar.`,
            "done"
          );
        }
        if (result.ytdlpPath && !config.ytdlpPath) {
          rememberFoundBinary(result.ytdlpPath);
        }
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        showProgress(null, null);
        if (scanEl) scanEl.textContent = "Analisar links";
        endBusy();
      }
    }

    /**
     * Guarda o binário que o script encontrou.
     *
     * Sem isso, cada execução repetia a busca por seis diretórios; com
     * isso, a segunda em diante vai direto — e o campo dos ajustes
     * avançados passa a mostrar de onde o yt-dlp está vindo.
     */
    function rememberFoundBinary(path: string): void {
      config.ytdlpPath = path;
      if (pathEl) pathEl.value = path;
      persist();
    }

    // ── baixar ────────────────────────────────────────────────

    context.setApplyHandler(async () => {
      const list = urls();
      if (busy || list.length === 0) {
        return;
      }
      const quality = findQuality(config.quality);
      startBusy(`Baixando em ${quality.label}…`);

      try {
        // Os links do CDN expiram, então a via rápida consulta de novo
        // AGORA — um segundo por link. O que ela não resolver desce
        // para o yt-dlp junto com os links que nunca foram dela.
        const direct: DirectJob[] = [];
        const slow: string[] = [];
        const fast = await fastLaneByIndex(list);
        list.forEach((url, index) => {
          const info = fast.get(index) ?? null;
          const job = info ? directJobFor(url, info, quality) : null;
          if (job) {
            direct.push(job);
          } else {
            slow.push(url);
          }
        });

        // Primeiro o download DENTRO do painel: sem script, sem shell,
        // sem Terminal — e com os bytes na barra, porque é o painel que
        // os recebe. O que tropeçar aqui desce para o script junto com
        // o que sempre foi dele (YouTube e afins).
        const total = list.length;
        const panelFiles: string[] = [];
        const scriptDirect: DirectJob[] = [];
        const destination = config.destination || (await defaultDestination());

        const tryPanel = async (job: DirectJob, step: string): Promise<string> => {
          showProgress(step, null, "conectando…");
          return downloadInPanel(
            job,
            config.destination || destination,
            config.destinationToken || null,
            (done, size) => {
              showProgress(
                step,
                size ? (done / size) * 100 : null,
                size
                  ? `${formatBytes(done)} de ${formatBytes(size)}`
                  : formatBytes(done)
              );
            }
          );
        };

        for (let index = 0; index < direct.length; index += 1) {
          const job = direct[index];
          const step = `${index + 1}/${total}`;
          try {
            panelFiles.push(await tryPanel(job, step));
            continue;
          } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause);
            console.warn("[Download] painel recusou:", reason);

            // Host que não atende destino por caminho: o seletor de
            // pasta resolve — diálogo nativo UMA vez, token guardado,
            // e o lote inteiro segue em painel. Um diálogo é o oposto
            // de uma janela de Terminal: é o host pedindo licença.
            if (reason.startsWith("destino") && !config.destinationToken) {
              context.setStatus("Escolha a pasta de destino — só desta vez.");
              await pickFolder();
              if (config.destinationToken) {
                try {
                  panelFiles.push(await tryPanel(job, step));
                  continue;
                } catch (second) {
                  const again =
                    second instanceof Error ? second.message : String(second);
                  console.warn("[Download] painel recusou de novo:", again);
                  showLog(`download em painel indisponível (${again}) — plano B.`);
                }
              } else {
                showLog(
                  `download em painel indisponível (${reason}) — plano B.`
                );
              }
            } else {
              showLog(`download em painel indisponível (${reason}) — plano B.`);
            }
            scriptDirect.push(job);
          }
        }

        let outcome = {
          ok: true,
          error: null as string | null,
          failed: 0,
          log: "",
          files: [] as string[],
        };
        if (slow.length > 0 || scriptDirect.length > 0) {
          const scripted = await downloadUrls(
            slow,
            quality,
            config,
            scriptDirect,
            (done, scriptTotal, percent, log) => {
              void scriptTotal;
              showProgress(
                `${panelFiles.length + (done || 1)}/${total}`,
                percent,
                percent === null ? "trabalhando…" : ""
              );
              showLog(log);
            },
            () => cancelled,
            showManual
          );
          outcome = { ...outcome, ...scripted };
        }

        const files = [...panelFiles, ...outcome.files];
        showProgress(null, null);
        showLog(outcome.ok && outcome.failed === 0 ? "" : outcome.log);

        if (files.length === 0) {
          context.setStatus(
            describeRunError(outcome.error ?? "ytdlp-failed", outcome.log),
            "error"
          );
          return;
        }

        const imported = config.importToProject ? await importFiles(files) : null;

        const count = files.length;
        const head =
          `${count} ${count === 1 ? "arquivo baixado" : "arquivos baixados"}` +
          (outcome.failed > 0 ? ` · ${outcome.failed} falharam` : "");
        context.setStatus(
          imported === null ? head : `${head} · ${imported}`,
          outcome.failed > 0 ? "error" : "done"
        );
        renderFiles(files);
        context.setResetHandler(() => clearAll());
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        endBusy();
      }
    });

    /** Joga o que baixou no projeto aberto. Devolve a frase do status. */
    async function importFiles(files: readonly string[]): Promise<string> {
      if (files.length === 0) {
        return "nada para importar";
      }
      const ppro = getPremiere();
      if (!ppro) {
        return "Premiere indisponível para importar";
      }
      try {
        const project = await ppro.Project.getActiveProject();
        if (!project) {
          return "nenhum projeto aberto para importar";
        }
        const ok = await project.importFiles([...files], true);
        return ok ? "importado para o projeto" : "o Premiere recusou a importação";
      } catch (cause) {
        console.error("[Download] importFiles falhou:", cause);
        return `falha ao importar: ${describeError(cause)}`;
      }
    }

    function clearAll(): void {
      probes = [];
      if (urlsEl) urlsEl.value = "";
      renderList();
      renderQualities();
      showLog("");
      showProgress(null, null);
      context.setResetHandler(null);
      context.setStatus("", "idle");
      syncApply();
    }

    // ── estado ocupado ────────────────────────────────────────

    function startBusy(message: string): void {
      busy = true;
      cancelled = false;
      hideManual();
      context.setStatus(message);
      context.setApplyEnabled(false);
      if (scanEl) setDisabled(scanEl, true);
      if (installEl) setDisabled(installEl, true);
    }

    function endBusy(): void {
      busy = false;
      if (installEl) setDisabled(installEl, false);
      syncApply();
    }

    // ── qualidade ─────────────────────────────────────────────

    function renderQualities(): void {
      // A qualidade guardada pode não existir neste vídeo. Cair para a
      // mais alta possível é melhor que um botão apontando para o nada.
      const offered = availableQualities(probes);
      if (!offered.some((quality) => quality.id === config.quality)) {
        config.quality = offered[0]?.id ?? "best";
      }
      qualityPick?.render();
    }

    // ── lista analisada ───────────────────────────────────────

    function renderList(): void {
      if (!listEl) return;
      if (probes.length === 0) {
        listEl.innerHTML = "";
        return;
      }
      listEl.innerHTML = probes.map((probe) => probeRow(probe, config.quality)).join("");
    }

    function renderFiles(files: readonly string[]): void {
      if (!listEl || files.length === 0) return;
      listEl.innerHTML =
        '<p class="dl-done-title">Baixado ✓</p>' +
        files
          .map(
            (file) =>
              `<div class="dl-file" title="${escapeHtml(file)}">` +
              `<span class="dl-file-name">${escapeHtml(baseName(file))}</span></div>`
          )
          .join("");
    }

    // ── destino ───────────────────────────────────────────────

    function renderDestination(): void {
      if (destEl) {
        destEl.textContent = config.destination || "(pasta padrão)";
        destEl.title = config.destination;
      }
    }

    pickEl?.addEventListener("click", () => void pickFolder());

    async function pickFolder(): Promise<void> {
      const picker = uxpModule<{
        storage?: {
          localFileSystem?: { getFolder?(): Promise<{ nativePath?: string } | null> };
        };
      }>("uxp")?.storage?.localFileSystem;

      if (typeof picker?.getFolder !== "function") {
        context.setStatus("Este build do Premiere não abre o seletor de pastas.", "error");
        return;
      }
      try {
        const folder = await picker.getFolder();
        if (!folder?.nativePath) {
          return;
        }
        config.destination = folder.nativePath;
        // A entry em mãos é permissão de escrita; o token a torna
        // permanente. É o que faz o download em painel — silencioso —
        // funcionar em qualquer build, escolhendo a pasta UMA vez.
        config.destinationToken = (await rememberFolderToken(folder)) ?? "";
        persist();
        renderDestination();
      } catch (cause) {
        // Cancelar o diálogo chega aqui como erro em alguns builds, e
        // desistir de escolher não é uma falha para reportar.
        console.log("[Download] seleção de pasta encerrada:", cause);
      }
    }

    // ── ajustes avançados ─────────────────────────────────────

    advToggleEl?.addEventListener("click", () => {
      if (!advContentEl) return;
      const open = advContentEl.hidden;
      advContentEl.hidden = !open;
      if (advIconEl) advIconEl.textContent = open ? "▴" : "▾";
    });

    pathEl?.addEventListener("change", () => {
      config.ytdlpPath = pathEl.value.trim();
      persist();
    });

    installEl?.addEventListener("click", () => void runInstall());

    async function runInstall(): Promise<void> {
      if (busy) return;
      startBusy("Baixando o yt-dlp…");
      if (installEl) installEl.textContent = "Baixando…";
      try {
        const result = await installYtdlp(showManual);
        showLog(result.log);
        if (result.ok && result.ytdlpPath) {
          rememberFoundBinary(result.ytdlpPath);
          context.setStatus("yt-dlp instalado na pasta do plugin.", "done");
        } else {
          context.setStatus(describeRunError(result.error, result.log), "error");
        }
      } catch (cause) {
        context.setStatus(describeError(cause), "error");
      } finally {
        if (installEl) installEl.textContent = "Reinstalar yt-dlp";
        endBusy();
      }
    }

    folderEl?.addEventListener("click", () => {
      void openWorkFolder().catch((cause) => {
        context.setStatus(describeError(cause), "error");
      });
    });

    // ── segmentos simples ─────────────────────────────────────

    function renderSegs(): void {
      for (const item of importSegEl?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String((item.dataset.import === "on") === config.importToProject)
        );
      }
    }

    importSegEl?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>("[data-import]");
      if (!item) return;
      config.importToProject = item.dataset.import === "on";
      persist();
      renderSegs();
    });

    // ── progresso, log e o contorno da recusa ─────────────────

    /**
     * A barra. Sem porcentagem ela não fica parada no zero — anima em
     * vai-e-vem, que é a diferença entre "trabalhando" e "travou".
     * `detail` é a legenda humana: "8,4 de 10,5 MB", "conectando…".
     */
    function showProgress(
      step: string | null,
      percent: number | null,
      detail = ""
    ): void {
      if (!progressEl) return;
      if (step === null) {
        progressEl.hidden = true;
        progressEl.innerHTML = "";
        return;
      }
      progressEl.hidden = false;
      const waiting = percent === null;
      const width = waiting ? 30 : Math.max(0, Math.min(100, percent));
      const right = waiting
        ? detail || "…"
        : `${detail ? `${escapeHtml(detail)} · ` : ""}${width.toFixed(0)}%`;
      progressEl.innerHTML =
        `<div class="dl-bar${waiting ? " is-wait" : ""}">` +
        `<span class="dl-bar-fill" style="width:${width.toFixed(1)}%"></span></div>` +
        `<div class="dl-bar-legend"><span>${escapeHtml(step)}</span>` +
        `<span>${waiting ? escapeHtml(right) : right}</span></div>`;
    }

    function showLog(text: string): void {
      if (!logEl) return;
      const trimmed = text.trim();
      logEl.hidden = trimmed.length === 0;
      logEl.textContent = trimmed;
    }

    /**
     * O sistema recusou executar o script.
     *
     * O script está escrito e é um duplo clique; o painel continua
     * esperando o resultado. Desistir aqui transformaria um contorno de
     * dez segundos numa funcionalidade morta.
     */
    function showManual(scriptPath: string, reason: string): void {
      if (!manualEl) return;
      manualEl.hidden = false;
      manualEl.innerHTML =
        '<p class="sil-manual-why">O sistema não executou o script ' +
        `(${escapeHtml(reason)}). Dê um duplo clique nele e volte — o ` +
        "painel continua esperando.</p>" +
        `<p class="sil-manual-path">${escapeHtml(scriptPath)}</p>`;
    }

    function hideManual(): void {
      if (manualEl) {
        manualEl.hidden = true;
        manualEl.innerHTML = "";
      }
    }

    // Sem seleção de timeline para reler; a ferramenta não depende dela.
    context.setRefreshHandler(null);
  },

  unmount(): void {
    releaseDocument?.();
    releaseDocument = null;
  },
};

// ── a via rápida traduzida para o painel ───────────────────────────

/**
 * O que a API do TikTok respondeu, na mesma forma dos probes do
 * yt-dlp — para a lista, a escada de qualidade e a estimativa não
 * saberem por qual porta a resposta entrou.
 *
 * As resoluções são o par que a API oferece: HD (praticamente sempre
 * 1080 de lado menor) e a padrão (~540). É aproximação declarada, não
 * medida — o suficiente para a escada e o tamanho, que é o que essas
 * linhas alimentam.
 */
function fastProbe(url: string, info: TikTokFast): Probe {
  const resolutions: number[] = [];
  const sizeByResolution: Record<number, number> = {};
  if (info.hdUrl) {
    resolutions.push(1080);
    sizeByResolution[1080] = info.sizeHd;
  }
  resolutions.push(540);
  sizeByResolution[540] = info.sizeSd;

  return {
    url,
    ok: true,
    error: null,
    title: info.title,
    id: info.id,
    site: "TikTok",
    uploader: null,
    durationSeconds: info.durationSeconds,
    resolutions,
    sizeByResolution,
    // A via rápida entrega a cópia limpa por construção; o selo do
    // painel diz exatamente isso.
    hadWatermarked: true,
  };
}

/**
 * O job de curl para a qualidade pedida. null quando esta qualidade
 * precisa do yt-dlp — MP3 sem trilha na resposta, por exemplo.
 */
function directJobFor(url: string, info: TikTokFast, quality: Quality): DirectJob | null {
  if (quality.audioOnly) {
    if (!info.musicUrl) {
      return null;
    }
    return {
      mediaUrl: info.musicUrl,
      fileName: tiktokFileName(info, "mp3"),
      sourceUrl: url,
    };
  }
  const wantsHd = quality.height === null || quality.height >= 720;
  return {
    mediaUrl: wantsHd && info.hdUrl ? info.hdUrl : info.playUrl,
    fileName: tiktokFileName(info, "mp4"),
    sourceUrl: url,
  };
}

// ── texto derivado ─────────────────────────────────────────────────

/**
 * A linha secundária de uma opção do menu.
 *
 * Antes da análise não há o que dizer, e dizer "analise primeiro" em
 * sete linhas era justamente o excesso que motivou o menu. Depois da
 * análise cada opção carrega o que decide: a resolução que vai sair de
 * verdade e quanto disso é disco.
 *
 * Exportada para ser conferida fora do Premiere, contra o JSON real de
 * um vídeo: é a frase que promete ao editor o que ele vai receber, e a
 * promessa erra calada se ninguém a olhar sem o host por perto.
 */
export function qualityMeta(quality: Quality, probes: readonly Probe[]): string {
  const ok = probes.filter((probe) => probe.ok);
  if (ok.length === 0) {
    return "";
  }
  if (quality.audioOnly) {
    return "só o áudio";
  }

  const size = formatBytes(
    ok.reduce((sum, probe) => sum + estimateFor(probe, quality), 0)
  );

  /*
   * A resolução entregue, mostrada só quando o rótulo não a diz.
   *
   * "1080p · 1080p" é o ruído que motivou este menu, então some. Mas
   * "Máxima" não diz número nenhum, e um degrau pode não bater: num
   * TikTok cujo menor formato é 576p, pedir 480p entrega 576p — para
   * CIMA. Por isso o número aparece cru, sem "máx." nem "mín.": os dois
   * prefixos estariam errados metade das vezes, e o número sozinho já
   * é a resposta inteira.
   *
   * Com vários links de tamanhos diferentes não há um número para dar,
   * e aí só o total faz sentido.
   */
  const delivered = new Set(ok.map((probe) => effectiveResolution(probe, quality)));
  const single = delivered.size === 1 ? [...delivered][0] : null;
  const shown =
    single !== null && single !== quality.height ? `${single}p` : "";

  return [shown, size].filter((part) => part.length > 0).join(" · ");
}

/**
 * O tamanho estimado do arquivo que esta qualidade vai gerar.
 *
 * Espelha o que o `-S res:N` do yt-dlp vai escolher: a resolução mais
 * alta que não passa do pedido e, se todas passarem, a menor que
 * existe — que é o mais perto que dá de chegar por baixo.
 */
function estimateFor(probe: Probe, quality: Quality): number {
  const chosen = effectiveResolution(probe, quality);
  return chosen === null ? 0 : probe.sizeByResolution[chosen] ?? 0;
}

/** A resolução que este vídeo vai realmente entregar nesta qualidade. */
function effectiveResolution(probe: Probe, quality: Quality): number | null {
  const list = probe.resolutions;
  if (list.length === 0) {
    return null;
  }
  return quality.height === null
    ? list[0]
    : list.find((value) => value <= quality.height!) ?? list[list.length - 1];
}

function probeRow(probe: Probe, qualityId: string): string {
  if (!probe.ok) {
    return (
      '<div class="dl-row is-bad">' +
      `<span class="dl-row-name">${escapeHtml(shorten(probe.url))}</span>` +
      `<span class="dl-row-meta">${escapeHtml(probe.error ?? "não foi possível ler")}</span>` +
      "</div>"
    );
  }

  const quality = findQuality(qualityId);
  const size = formatBytes(estimateFor(probe, quality));
  const clock = formatClock(probe.durationSeconds);
  const top = probe.resolutions[0] ? `${probe.resolutions[0]}p` : "";

  const meta = [probe.site, clock, top, size].filter((part) => part.length > 0).join(" · ");

  return (
    '<div class="dl-row">' +
    `<span class="dl-row-name" title="${escapeHtml(probe.title)}">${escapeHtml(
      probe.title
    )}</span>` +
    `<span class="dl-row-meta">${escapeHtml(meta)}</span>` +
    (probe.hadWatermarked
      ? '<span class="dl-row-tag">sem marca d\'água</span>'
      : "") +
    "</div>"
  );
}

function shorten(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}…` : value;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ── markup ─────────────────────────────────────────────────────────

function markup(): string {
  return (
    '<div class="zones">' +
      // Links
      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head"><span class="t-label">Links</span></div>' +
          '<textarea class="dl-urls" data-urls spellcheck="false" rows="3" ' +
          'placeholder="Cole os links do YouTube ou do TikTok — um por linha"></textarea>' +
          `<div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar links</div></div>` +
          '<div class="sil-manual" data-manual hidden></div>' +
          '<div class="dl-list" data-list></div>' +
          '<div class="dl-progress" data-progress hidden></div>' +
          '<pre class="dl-log" data-log hidden></pre>' +
        "</div>" +
      "</div>" +

      // Qualidade
      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Qualidade</span>' +
          '<div data-quality-pick></div>' +
        "</div>" +
      "</div>" +

      // Destino
      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Destino</span>' +
            `<span class="field-action" ${CONTROL} data-pick>Escolher…</span>` +
          "</div>" +
          '<p class="dl-dest" data-dest></p>' +
        "</div>" +
        '<div class="field">' +
          '<span class="t-label">Importar para o projeto</span>' +
          '<div class="seg" data-import-seg>' +
            `<div class="seg-item" ${CONTROL} data-import="on">Sim</div>` +
            `<div class="seg-item" ${CONTROL} data-import="off">Não</div>` +
          "</div>" +
        "</div>" +
      "</div>" +

      // Avançado
      '<div class="sil-advanced">' +
        `<div class="sil-advanced-summary" ${CONTROL} data-adv-toggle>` +
          '<span class="sil-advanced-title">⚙️ Ajustes Avançados</span>' +
          '<span class="sil-advanced-icon" data-adv-icon>▾</span>' +
        "</div>" +
        '<div class="sil-advanced-content" data-adv-content hidden>' +
          '<div class="field">' +
            '<span class="t-label">Cookies do navegador</span>' +
            '<div data-cookies-pick></div>' +
            '<p class="field-note">Para vídeo com restrição de idade ou quando o ' +
            "site pede login. Use o navegador onde você já está logado.</p>" +
          "</div>" +
          '<div class="field">' +
            '<div class="field-head">' +
              '<span class="t-label">Caminho do yt-dlp</span>' +
              `<span class="field-action" ${CONTROL} data-open-folder>Abrir pasta</span>` +
            "</div>" +
            '<div class="sil-ffmpeg-group">' +
              '<input type="text" class="sil-path" data-ytdlp-path spellcheck="false" ' +
              'placeholder="deixe vazio para procurar sozinho">' +
              `<div class="org-scan" ${CONTROL} data-install>Reinstalar yt-dlp</div>` +
            "</div>" +
            '<p class="field-note">Não precisa instalar nada: na primeira vez o painel ' +
            "baixa sozinho o yt-dlp e o ffmpeg oficiais para a pasta do plugin. Este " +
            "botão só força uma reinstalação, se algum dia precisar atualizar.</p>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>"
  );
}

