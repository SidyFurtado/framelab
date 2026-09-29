import type { StatusTone, Tool, ToolContext } from "./tool";
import {
  categories,
  findTool,
  searchTools,
  tools,
  toolsIn,
} from "./catalog";
import { glyph } from "./glyphs";
import {
  bindKeyboard,
  CONTROL,
  createControl,
  isDisabled,
  setDisabled, escapeHtml } from "./controls";
import {
  checkHostCapabilities,
  describeError,
  readSelection,
  type SelectionSummary,
} from "../bridge/premiere";
import { guardApplyRun } from "./applyRun";
import { actionButton } from "./actionButton";
import { PluginUpdater, type VersionManifest } from "./updater";
import { startAgentHeartbeat, stopAgentHeartbeat } from "../tools/download/runner";

/** Cravados pelo vite no build. Ver o porquê em vite.config.ts. */
declare const __BUILD_STAMP__: string;
declare const __APP_VERSION__: string;

const PRODUCT_NAME = "Framelab";
const PRODUCT_TAGLINE = "Premiere";
// Do package.json, via vite. Era uma cópia à mão, e é ela que o
// atualizador compara: esquecer de bumpar aqui desligava a
// atualização para todo mundo sem nenhum aviso.
const VERSION = __APP_VERSION__;
const NAV_PREFERENCE = "framelab.navigation.collapsed";


/**
 * Product Shell: top bar, navigator, active Tool workspace, action bar
 * and status bar. Owns everything except the Tool body.
 */
export class ProductShell {
  private readonly root: HTMLElement;
  private readonly updater: PluginUpdater;

  private readonly searchInput: HTMLInputElement;
  private readonly navEl: HTMLElement;
  private readonly navScroll: HTMLElement;
  private readonly topbarEl: HTMLElement;
  private readonly navToggle: HTMLElement;
  private readonly helpToggle: HTMLElement;
  private readonly refreshButton: HTMLElement;
  private readonly scrollEl: HTMLElement;
  private navPreference: boolean | null = null;
  private navCompact = false;
  private narrow = false;
  private readonly onResize = (): void => this.updateLayout();
  private updateBadgeEl: HTMLElement | null = null;
  private updateModalEl: HTMLElement | null = null;
  private latestManifest: VersionManifest | null = null;

  private readonly titleEl: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly chipEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly calloutEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly resetButton: HTMLElement;
  private readonly applyButton: HTMLElement;
  private readonly applyLabelEl: HTMLElement;
  private readonly actionSelectionEl: HTMLElement;
  private readonly actionSummaryEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statusToolEl: HTMLElement;
  private segmentObserver: MutationObserver | null = null;

  private applyHandler: (() => void | Promise<void>) | null = null;
  /** Set when a Tool calls setApplyEnabled, so runApply stops overriding it. */
  private applyStateOwned = false;
  private resetHandler: (() => void) | null = null;
  private refreshHandler: (() => void) | null = null;
  private activeToolId: string | null = null;
  /**
   * Bumped on every Tool swap. A ToolContext closes over the Shell, not
   * over the Tool, so work that outlives its Tool — a scan waiting on
   * ffmpeg, say — used to finish into a Shell that belongs to somebody
   * else and flip the incoming Tool's button and status bar. The context
   * captures this number and goes quiet once it stops matching.
   */
  private toolGeneration = 0;
  /** Coalesces timeline reads; see `scheduleRefresh`. */
  private refreshTimer: number | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;
  private query = "";
  private selection: SelectionSummary | null = null;
  /** Keeps the host warning on screen instead of a Tool's hint. */
  private hostGaps = false;

  constructor(root: HTMLElement) {
    this.updater = new PluginUpdater(VERSION);
    this.root = root;
    this.root.innerHTML = "";
    this.root.className = "shell";
    try {
      const saved = localStorage.getItem(NAV_PREFERENCE);
      this.navPreference = saved === "true" ? true : saved === "false" ? false : null;
    } catch { /* A preferência é opcional em hosts sem storage. */ }

    // ── top bar ──
    const topbar = document.createElement("header");
    topbar.className = "topbar";
    topbar.innerHTML =
      `<div class="brand" aria-label="${escapeHtml(PRODUCT_NAME)}">` +
      `<b>${escapeHtml(PRODUCT_NAME.toLowerCase())}</b><span aria-hidden="true">/</span></div>` +
      '<label class="search">' +
      searchGlyph() +
      '<input type="text" placeholder="Buscar ferramenta…" ' +
      'aria-label="Buscar ferramenta" spellcheck="false" ' +
      // Busca de painel não é formulário: sem histórico nem correção.
      'autocomplete="off" autocorrect="off" autocapitalize="off"></label>' +
      // O carimbo do build no título: passar o ponteiro sobre a versão
      // responde "é esta build mesmo que está rodando?" sem console.
      `<span class="version" title="build ${__BUILD_STAMP__}">v${VERSION}</span>`;

    this.topbarEl = topbar;
    this.navToggle = createControl("nav-toggle");
    this.navToggle.innerHTML = panelToggleGlyph();
    this.navToggle.setAttribute("aria-controls", "tool-navigation");
    this.navToggle.addEventListener("click", () => this.setNavCompact(!this.navCompact));
    topbar.insertBefore(this.navToggle, topbar.firstChild);
    this.searchInput = topbar.querySelector("input") as HTMLInputElement;
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value;
      this.renderNav();
    });

    // ── navigator ──
    this.navEl = document.createElement("nav");
    this.navEl.className = "nav";
    this.navEl.id = "tool-navigation";
    this.navEl.setAttribute("aria-label", "Ferramentas");
    this.navScroll = document.createElement("div");
    this.navScroll.className = "nav-scroll";
    const empty = document.createElement("p");
    empty.className = "nav-empty";
    empty.textContent = "Nenhuma ferramenta encontrada.";
    const navFooter = document.createElement("div");
    navFooter.className = "nav-footer";
    navFooter.innerHTML =
      `<span class="nav-footer-mark" aria-hidden="true">${premiereGlyph()}</span>` +
      `<span>${escapeHtml(PRODUCT_TAGLINE)} Pro</span>` +
      `<span class="nav-footer-version" title="build ${__BUILD_STAMP__}">v${VERSION}</span>`;
    this.navEl.append(this.navScroll, empty, navFooter);

    // ── workspace ──
    const work = document.createElement("div");
    work.className = "work";

    const header = document.createElement("div");
    header.className = "work-head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "work-title";
    this.subtitleEl = document.createElement("span");
    this.subtitleEl.className = "work-subtitle";
    this.chipEl = document.createElement("span");
    this.chipEl.className = "work-chip";
    const refresh = createControl("work-refresh");
    this.refreshButton = refresh;
    refresh.title = "Reler a seleção da timeline";
    refresh.setAttribute("aria-label", "Reler a seleção da timeline");
    refresh.innerHTML = refreshGlyph();
    refresh.addEventListener("click", () => void this.refreshSelection());
    const heading = document.createElement("div");
    heading.className = "work-heading";
    heading.append(this.chipEl, this.titleEl, this.subtitleEl);
    this.helpToggle = createControl("work-help");
    this.helpToggle.innerHTML = helpGlyph();
    this.helpToggle.title = "Como usar esta ferramenta";
    this.helpToggle.setAttribute("aria-label", "Como usar esta ferramenta");
    this.helpToggle.setAttribute("aria-controls", "tool-help");
    this.helpToggle.setAttribute("aria-expanded", "false");
    this.helpToggle.addEventListener("click", () => {
      if (this.hostGaps) return;
      this.calloutEl.hidden = !this.calloutEl.hidden;
      this.helpToggle.setAttribute("aria-expanded", String(!this.calloutEl.hidden));
    });
    header.append(heading, this.helpToggle, refresh);

    this.stateEl = document.createElement("div");
    this.stateEl.className = "work-state";

    this.calloutEl = document.createElement("p");
    this.calloutEl.className = "callout";
    this.calloutEl.id = "tool-help";
    this.calloutEl.hidden = true;

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "work-body";
    this.bodyEl.addEventListener("click", () => {
      requestAnimationFrame(() => this.syncSegmentGliders());
    });
    if (typeof MutationObserver !== "undefined") {
      this.segmentObserver = new MutationObserver(() => this.syncSegmentGliders());
      this.segmentObserver.observe(this.bodyEl, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-pressed"],
      });
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const actionDescription = document.createElement("div");
    actionDescription.className = "action-description";
    this.actionSelectionEl = document.createElement("span");
    this.actionSelectionEl.className = "action-selection";
    this.actionSummaryEl = document.createElement("span");
    this.actionSummaryEl.className = "action-summary";
    actionDescription.append(this.actionSelectionEl, this.actionSummaryEl);
    this.resetButton = createControl("btn-reset", "Limpar");
    this.resetButton.hidden = true;
    this.resetButton.addEventListener("click", () => this.resetHandler?.());
    this.applyButton = createControl("btn-apply");
    this.applyLabelEl = document.createElement("span");
    this.applyLabelEl.className = "btn-apply-label";
    this.applyButton.append(this.applyLabelEl);
    this.applyButton.insertAdjacentHTML("beforeend", arrowGlyph());
    setDisabled(this.applyButton, true);
    this.applyButton.addEventListener("click", () => void this.runApply());
    actions.append(actionDescription, this.resetButton, this.applyButton);

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "work-scroll";
    this.scrollEl.append(this.stateEl, this.calloutEl, this.bodyEl);
    work.append(header, this.scrollEl, actions);

    const main = document.createElement("div");
    main.className = "main";
    const scrim = createControl("nav-scrim");
    scrim.setAttribute("aria-label", "Recolher navegação");
    scrim.addEventListener("click", () => this.setNavCompact(true));
    main.append(this.navEl, scrim, work);

    // ── status bar ──
    this.statusEl = document.createElement("footer");
    this.statusEl.className = "statusbar";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusToolEl = document.createElement("span");
    this.statusToolEl.className = "statusbar-tool";

    this.root.append(topbar, main, this.statusEl);
    this.navScroll.addEventListener("click", (event) => this.onNavClick(event));
    bindKeyboard(this.root);
    this.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.narrow && !this.navCompact) {
        this.setNavCompact(true);
        this.navToggle.focus();
      }
      // Com a lateral sobreposta, Tab permanece nos controles visíveis.
      if (event.key === "Tab" && this.narrow && !this.navCompact) {
        const controls = [
          ...this.topbarEl.querySelectorAll<HTMLElement>('input, button, [tabindex="0"]'),
          ...this.navEl.querySelectorAll<HTMLElement>('[tabindex="0"]'),
        ].filter((element) => element.getBoundingClientRect().width > 0);
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        if (controls[next]) {
          event.preventDefault();
          controls[next].focus();
        }
      }
    });
    this.updateLayout();
    window.addEventListener("resize", this.onResize);
  }

  start(): void {
    // O agente que roda os scripts só continua vivo enquanto este
    // batimento existir — é o que impede um processo órfão quando o
    // Premiere fecha, e o que evita pedir permissão a cada ação.
    startAgentHeartbeat();
    this.reportHostGaps();
    this.renderNav();
    const first = tools.find((tool) => tool.available) ?? tools[0];
    if (first) {
      this.selectTool(first.id);
    }
    void this.refreshSelection();
    // Debounced: a focus re-reads every track item of every video track,
    // three host calls apiece, and an alt-tab fires more than one.
    window.addEventListener("focus", () => this.scheduleRefresh());

    /*
     * O desligamento que faltava.
     *
     * `stopAgentHeartbeat` existia exportado e nunca era chamado: o
     * batimento só parava quando o processo do painel morria junto. Na
     * prática o agente saía sozinho pelos 90s de carência, mas entre o
     * fechar e o sair havia uma janela em que ele ainda achava que o
     * painel estava aberto. Ligado ao descarregamento da página, que é
     * o que o UXP dispara ao fechar e ao recarregar o plugin, o agente
     * passa a saber na hora.
     */
    window.addEventListener("beforeunload", () => {
      window.removeEventListener("resize", this.onResize);
      stopAgentHeartbeat();
      if (this.refreshTimer !== null) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      try {
        if (this.activeToolId) {
          findTool(this.activeToolId)?.unmount?.();
        }
      } catch {
        // Fechando: um unmount que reclame não muda nada.
      }
    });

    // Auto-update check in the background
    setTimeout(() => {
      void this.checkUpdates();
    }, 600);
  }

  private async checkUpdates(): Promise<void> {
    try {
      const result = await this.updater.checkForUpdates();
      if (result.hasUpdate && result.manifest) {
        this.latestManifest = result.manifest;
        this.renderUpdateBadge(result.manifest.version);
      }
    } catch (err) {
      console.warn("[Shell] Erro ao checar update:", err);
    }
  }

  private renderUpdateBadge(version: string): void {
    if (this.updateBadgeEl) {
      this.updateBadgeEl.remove();
    }
    const badge = document.createElement("button");
    badge.className = "update-badge";
    // A versão vem da rede; entra no DOM como o resto do painel entra —
    // escapada. O modal já fazia isso, o selo não.
    const safe = escapeHtml(version);
    badge.title = `Nova versão v${safe} disponível! Clique para atualizar.`;
    badge.innerHTML = `<span class="update-dot"></span><span>Atualizar (v${safe})</span>`;
    badge.addEventListener("click", () => this.showUpdateModal());
    this.topbarEl.append(badge);
    this.updateBadgeEl = badge;
  }

  private showUpdateModal(): void {
    if (this.updateModalEl) {
      this.updateModalEl.remove();
    }
    const manifest = this.latestManifest;
    if (!manifest) return;

    const modal = document.createElement("div");
    modal.className = "update-modal";

    const card = document.createElement("div");
    card.className = "update-card";

    const head = document.createElement("div");
    head.className = "update-head";
    head.innerHTML =
      '<span class="update-head-title"><span class="update-dot"></span>Atualização Disponível</span>' +
      '<span class="update-close" aria-label="Fechar">&times;</span>';

    head.querySelector(".update-close")?.addEventListener("click", () => {
      modal.remove();
      this.updateModalEl = null;
    });

    const body = document.createElement("div");
    body.className = "update-body";

    const versionTag = document.createElement("p");
    versionTag.className = "update-version-tag";
    versionTag.innerHTML = `Nova versão <b>v${escapeHtml(manifest.version)}</b> pronta para instalar. (Versão atual: v${VERSION})`;

    const changelog = document.createElement("div");
    changelog.className = "update-changelog";
    changelog.textContent = manifest.changelog || "Melhorias de desempenho e estabilidade.";

    const progressWrap = document.createElement("div");
    progressWrap.className = "update-progress-wrap";
    progressWrap.hidden = true;
    progressWrap.innerHTML =
      '<div class="update-progress-track"><div class="update-progress-fill"></div></div>' +
      '<span class="update-progress-status">Preparando download...</span>';

    body.append(versionTag, changelog, progressWrap);

    const actions = document.createElement("div");
    actions.className = "update-actions";

    const btnManual = document.createElement("button");
    btnManual.className = "btn-update-sec";
    btnManual.textContent = "Baixar Manual";
    btnManual.addEventListener("click", () => {
      this.updater.openDownloadPage();
    });

    const btnCancel = document.createElement("button");
    btnCancel.className = "btn-update-sec";
    btnCancel.textContent = "Depois";
    btnCancel.addEventListener("click", () => {
      modal.remove();
      this.updateModalEl = null;
    });

    const btnUpdate = document.createElement("button");
    btnUpdate.className = "btn-update-pri";
    /*
     * Este botão troca de papel: começa instalando e, se a instalação
     * falhar, passa a abrir o navegador. A troca é de AÇÃO, e não mais um
     * registro a somar — `onclick` e `addEventListener` conviviam, e o
     * clique seguinte fazia as duas coisas. Ver `actionButton.ts`.
     */
    const update = actionButton(btnUpdate);

    const btnReload = document.createElement("button");
    btnReload.className = "btn-update-pri";
    btnReload.textContent = "Recarregar Painel";
    btnReload.hidden = true;
    btnReload.addEventListener("click", () => {
      this.updater.reloadPlugin();
    });

    update.set("Atualizar Agora", async () => {
      btnUpdate.disabled = true;
      btnCancel.hidden = true;
      progressWrap.hidden = false;
      const fillEl = progressWrap.querySelector(".update-progress-fill") as HTMLElement;
      const statusEl = progressWrap.querySelector(".update-progress-status") as HTMLElement;

      const res = await this.updater.applyUpdate((step, percent) => {
        if (fillEl) fillEl.style.width = `${percent}%`;
        if (statusEl) statusEl.textContent = `${step} (${percent}%)`;
      });

      if (res.success && res.requiresReload) {
        if (statusEl) statusEl.textContent = "✅ " + res.message;
        btnUpdate.hidden = true;
        btnReload.hidden = false;
      } else {
        if (statusEl) statusEl.textContent = "⚠️ " + res.message;
        btnUpdate.disabled = false;
        // SUBSTITUI a ação de instalar. O botão passa a abrir o
        // navegador e só isso: era daqui que saíam as duas ações no
        // mesmo clique, re-armando a instalação que acabara de falhar.
        update.set("Tentar via Navegador", () => this.updater.openDownloadPage());
      }
    });

    actions.append(btnManual, btnCancel, btnUpdate, btnReload);

    card.append(head, body, actions);
    modal.append(card);
    this.root.append(modal);
    this.updateModalEl = modal;
  }

  /**
   * Names anything the host is missing, once, at startup.
   *
   * The manifest declares a minimum Premiere version but nothing checks
   * that the build has the APIs the Tools were written against. Missing
   * ones used to surface as an exception mid-apply, or as a blank panel
   * when one threw during mount.
   */
  private reportHostGaps(): void {
    const check = checkHostCapabilities();
    if (check.ok) {
      return;
    }
    console.error("[Shell] APIs ausentes no host:", check.missing);
    this.calloutEl.classList.add("is-error");
    this.calloutEl.textContent =
      `Esta versão do Premiere não expõe: ${check.missing.join(", ")}. ` +
      "As ferramentas podem falhar. Atualize o Premiere.";
    this.hostGaps = true;
    this.calloutEl.hidden = false;
    this.helpToggle.hidden = true;
  }

  // ── navigator ────────────────────────────────────────────

  private setNavCompact(compact: boolean): void {
    this.navPreference = compact;
    try { localStorage.setItem(NAV_PREFERENCE, String(compact)); } catch { /* opcional */ }
    this.updateLayout();
  }

  private updateLayout(): void {
    const width = this.root.clientWidth || window.innerWidth;
    const previousCompact = this.navCompact;
    this.narrow = width < 600;
    this.navCompact = this.navPreference ?? this.narrow;
    this.root.classList.toggle("is-narrow", this.narrow);
    this.root.classList.toggle("is-nav-compact", this.navCompact);
    // Breakpoints seguem o espaço da ferramenta, inclusive ao recolher a lateral.
    const workWidth = width - (this.navCompact || this.narrow ? 56 : 212);
    this.root.classList.toggle("is-work-wide", workWidth >= 640);
    this.root.classList.toggle("is-work-small", workWidth < 330);
    const label = this.navCompact ? "Expandir navegação" : "Recolher navegação";
    this.navToggle.title = label;
    this.navToggle.setAttribute("aria-label", label);
    this.navToggle.setAttribute("aria-expanded", String(!this.navCompact));
    if (previousCompact !== this.navCompact || !this.navScroll.firstChild) {
      this.renderNav();
    }
  }

  private renderNav(): void {
    const searching = this.query.trim().length > 0;
    const results = searching ? searchTools(this.query) : [];

    if (searching) {
      this.navEl.classList.toggle("is-empty", results.length === 0);
      this.navScroll.innerHTML = results.length
        ? `<div class="nav-tools">${results
            .map((tool) => this.toolMarkup(tool))
            .join("")}</div>`
        : "";
      return;
    }

    this.navEl.classList.remove("is-empty");
    this.navScroll.innerHTML = categories
      .map((category) => {
        const list = toolsIn(category.id);
        if (list.length === 0) {
          return "";
        }
        return (
          '<div class="nav-group">' +
          '<div class="nav-cat">' +
          `<span class="nav-cat-name">${escapeHtml(category.name)}</span></div>` +
          `<div class="nav-tools">${list
            .map((tool) => this.toolMarkup(tool))
            .join("")}</div></div>`
        );
      })
      .join("");
  }

  private toolMarkup(tool: Tool): string {
    const active = tool.id === this.activeToolId;
    return (
      `<div class="nav-tool${active ? " is-active" : ""}" ${CONTROL} ` +
      `data-tool="${tool.id}" data-available="${tool.available}" ` +
      `aria-label="${escapeHtml(tool.name)}" aria-pressed="${active}" ` +
      `title="${escapeHtml(tool.name)} — ${escapeHtml(tool.summary)}">` +
      `<span class="nav-glyph" aria-hidden="true">${glyph(tool.glyph)}</span>` +
      '<span class="nav-text">' +
      `<span class="nav-name">${escapeHtml(tool.name)}</span>` +
      "</span></div>"
    );
  }

  private onNavClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const toolButton = target.closest<HTMLElement>("[data-tool]");
    if (toolButton?.dataset.tool) {
      this.selectTool(toolButton.dataset.tool);
      if (this.narrow && !this.navCompact) {
        this.setNavCompact(true);
      }
      this.navScroll.querySelector<HTMLElement>(`[data-tool="${toolButton.dataset.tool}"]`)?.focus();
      return;
    }

  }

  // ── workspace ────────────────────────────────────────────

  private selectTool(toolId: string): void {
    const tool = findTool(toolId);
    if (!tool || this.activeToolId === toolId) {
      return;
    }
    // O contrato de tool.ts: available:false aparece no navegador mas
    // não ganha o workspace. Sem esta guarda, uma Tool marcada
    // indisponível montava e falhava no meio do Apply — exatamente o
    // que a marca existe para impedir.
    if (tool.available === false) {
      this.setStatus(`${tool.name} não está disponível nesta versão do Premiere.`, "error");
      return;
    }

    // Whatever the outgoing Tool put on window or document goes with
    // it; the Shell only owns the markup it is about to overwrite.
    if (this.activeToolId) {
      try {
        findTool(this.activeToolId)?.unmount?.();
      } catch (cause) {
        console.error("[Shell] unmount threw:", cause);
      }
    }

    this.activeToolId = toolId;
    this.toolGeneration += 1;
    this.applyHandler = null;
    this.applyStateOwned = false;
    this.resetHandler = null;
    this.refreshHandler = null;
    this.resetButton.hidden = true;
    this.resetButton.textContent = "Limpar";
    this.applyLabelEl.textContent = "Aplicar";
    setDisabled(this.applyButton, true);

    this.titleEl.textContent = tool.name;
    this.subtitleEl.textContent = tool.summary;
    const category = categories.find((entry) => entry.id === tool.category);
    this.chipEl.textContent = category?.name ?? "";
    if (!this.hostGaps) {
      this.calloutEl.textContent = tool.hint;
      this.calloutEl.hidden = true;
      this.helpToggle.setAttribute("aria-expanded", "false");
    }
    this.stateEl.hidden = tool.usesSelection === false;
    this.refreshButton.hidden = tool.usesSelection === false;
    this.statusToolEl.textContent = tool.name;
    this.setStatus("", "idle");

    this.renderNav();
    this.scrollEl.scrollTop = 0;
    // tool.ts promises the Shell owns this markup. Now it actually does,
    // instead of leaning on every Tool to clear the container first.
    this.bodyEl.innerHTML = "";
    tool.mount(this.bodyEl, this.createContext());
    this.syncSegmentGliders();
    this.bodyEl.classList.remove("is-tool-enter");
    void this.bodyEl.offsetWidth;
    this.bodyEl.classList.add("is-tool-enter");
    this.renderApplyCount();
  }

  /**
   * A lâmina móvel da prévia aprovada. A posição vem do aria-pressed que
   * cada Tool já mantém, então o movimento não duplica estado de produto.
   */
  private syncSegmentGliders(): void {
    for (const segment of this.bodyEl.querySelectorAll<HTMLElement>(".seg")) {
      const children = [...segment.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      );
      const items = children.filter((child) => child.classList.contains("seg-item"));
      if (items.length < 2) continue;
      let glider = children.find((child) => child.classList.contains("seg-glider"));
      if (!glider) {
        glider = document.createElement("span");
        glider.className = "seg-glider";
        glider.setAttribute("aria-hidden", "true");
        segment.insertBefore(glider, segment.firstChild);
      }
      const selected = items.findIndex(
        (item) => item.getAttribute("aria-pressed") === "true"
      );
      glider.style.width = `calc((100% - 6px) / ${items.length})`;
      glider.hidden = selected < 0;
      if (selected < 0) continue;
      glider.style.transform = `translateX(${selected * 100}%)`;
      segment.classList.add("has-glider");
    }
  }

  private createContext(): ToolContext {
    const generation = this.toolGeneration;
    /** false once this Tool has been replaced. */
    const live = (): boolean => generation === this.toolGeneration;

    return {
      setApplyLabel: (label) => {
        if (!live()) return;
        this.applyLabelEl.textContent = sentenceCase(label);
        this.renderApplyCount();
      },
      setApplyEnabled: (enabled) => {
        if (!live()) return;
        this.applyStateOwned = true;
        setDisabled(this.applyButton, !enabled);
        this.renderApplyCount();
      },
      setApplyHandler: (handler) => {
        if (!live()) return;
        this.applyHandler = handler;
      },
      setResetHandler: (handler) => {
        if (!live()) return;
        this.resetHandler = handler;
        this.resetButton.hidden = handler === null;
      },
      setResetLabel: (label) => {
        if (!live()) return;
        this.resetButton.textContent = label;
      },
      setStatus: (text, tone) => {
        if (!live()) return;
        this.setStatus(text, tone ?? "idle");
      },
      refreshSelection: () => {
        if (!live()) return;
        void this.refreshSelection();
      },
      setRefreshHandler: (handler) => {
        if (!live()) return;
        this.refreshHandler = handler;
      },
    };
  }

  /**
   * Guards the action button against re-entry while a Tool is running.
   *
   * O que acontece quando a Tool rejeita — e a razão de o botão voltar
   * mesmo com `applyStateOwned` ligado — está em `applyRun.ts`. A
   * decisão mora lá para poder ser provada sem DOM e sem host.
   */
  private async runApply(): Promise<void> {
    const handler = this.applyHandler;
    if (!handler || isDisabled(this.applyButton)) {
      return;
    }
    this.applyStateOwned = false;
    setDisabled(this.applyButton, true);
    await guardApplyRun({
      run: () => handler(),
      // Hand the control back only if the Tool is still holding it AND
      // did not decide the state itself. Re-enabling unconditionally lit
      // the button up again after a run that left nothing selected.
      stale: () => this.applyHandler !== handler,
      stateOwned: () => this.applyStateOwned,
      setApplyDisabled: (disabled) => setDisabled(this.applyButton, disabled),
      reportError: (cause) => {
        console.error("[Shell] o Apply da ferramenta falhou:", cause);
        const raw = describeError(cause).trim();
        this.setStatus(
          raw
            ? `Falha ao aplicar: ${/[.!?]$/.test(raw) ? raw : `${raw}.`}`
            : "Falha ao aplicar.",
          "error"
        );
      },
      settled: () => this.renderApplyCount(),
    });
  }

  private setStatus(text: string, tone: StatusTone): void {
    this.statusEl.hidden = !text;
    this.statusEl.className = `statusbar${
      tone === "done" ? " is-done" : tone === "error" ? " is-error" : ""
    }`;
    this.statusEl.innerHTML = "";
    if (text) {
      const message = document.createElement("span");
      message.textContent = text;
      this.statusEl.append(message);
    }
    this.statusToolEl.hidden = !!text;
    this.statusEl.append(this.statusToolEl);
  }

  // ── selection ────────────────────────────────────────────

  /**
   * Coalesces timeline reads.
   *
   * Reading the selection walks every track item of every video track, so
   * the cost is real on a long sequence — and the panel regaining focus
   * can fire several times in a row.
   */
  private scheduleRefresh(delayMs = 180): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshSelection();
    }, delayMs);
  }

  private async refreshSelection(): Promise<void> {
    // Two overlapping reads paint over each other, and the one that
    // finishes second is not necessarily the one that started second.
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      this.selection = await readSelection();
      this.renderState();
      this.renderApplyCount();
      // The active Tool re-reads whatever it cached about the selection.
      // Its own failures are the Tool's business, never the Shell's.
      try {
        this.refreshHandler?.();
      } catch (cause) {
        console.error("[Shell] refresh handler threw:", cause);
      }
    } finally {
      this.refreshInFlight = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.scheduleRefresh(0);
      }
    }
  }

  private renderState(): void {
    const summary = this.selection;
    const count = summary?.selectedCount ?? 0;

    if (count === 0) {
      this.stateEl.className = "work-state is-idle";
      this.stateEl.innerHTML =
        '<span class="dot"></span><span>Nenhum clipe de vídeo selecionado</span>';
      return;
    }

    // The count spans every video track. Naming only the strip's track
    // made the panel claim less than Apply would write, so a selection
    // that reaches further says so.
    const where = summary?.spansTracks
      ? " em várias faixas"
      : summary?.trackLabel
        ? ` em ${escapeHtml(summary.trackLabel)}`
        : "";
    this.stateEl.className = "work-state";
    this.stateEl.innerHTML =
      '<span class="dot"></span><span>' +
      `${count} ${count === 1 ? "clipe" : "clipes"} selecionado${
        count === 1 ? "" : "s"
      }${where} · ${formatDuration(summary?.selectedSeconds ?? 0)}</span>`;
  }


  private renderApplyCount(): void {
    const count = this.selection?.selectedCount ?? 0;
    const tool = this.activeToolId ? findTool(this.activeToolId) : undefined;
    this.actionSelectionEl.textContent = tool?.usesSelection === false
      ? "Pronto para executar"
      : count === 0
        ? "Nenhum clipe selecionado"
        : `${count} ${count === 1 ? "clipe selecionado" : "clipes selecionados"}`;
    this.actionSummaryEl.textContent = tool?.summary ?? "";
  }
}

function sentenceCase(label: string): string {
  // Siglas continuam siglas: "Aplicar 12 SFX", não "Aplicar 12 sfx".
  const normalized = label.trim().toLocaleLowerCase("pt-BR").replace(/\bsfx\b/g, "SFX");
  return normalized ? normalized[0].toLocaleUpperCase("pt-BR") + normalized.slice(1) : "";
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/*
 * As marcas do próprio Shell.
 *
 * Mesma regra dos glifos das ferramentas (ver `glyphs.ts`): o UXP não
 * honra `fill="none"` e não desce o preenchimento do <svg> para os
 * filhos, então nada aqui é desenhado a traço. Tudo é silhueta, com
 * `fill` escrito em cada forma, e só com linhas retas — o que mantém
 * a família coerente e dispensa qualquer curva do renderizador.
 */

/** A marca: o retículo do visor, com o sensor no acento do tema. */
/** Busca: o mesmo quadro do glifo de Zoom, com um cabo. */
function searchGlyph(): string {
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">' +
    '<path fill="currentColor" fill-rule="evenodd" ' +
    'd="M1.2 1.2h8.4v8.4H1.2V1.2Zm1.5 1.5v5.4h5.4V2.7H2.7Z"/>' +
    '<path fill="currentColor" d="M9.3 10.4 10.4 9.3l2.4 2.4-1.1 1.1z"/>' +
    "</svg>"
  );
}

/** Reler: um anel partido, com a ponta da seta no corte. */
function refreshGlyph(): string {
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor">' +
    '<path fill="currentColor" fill-rule="evenodd" ' +
    'd="M2 2h10v3.2h-1.6V3.6H3.6v6.8h6.8V8.8H12V12H2V2Z"/>' +
    '<path fill="currentColor" d="M7.6 7h5.2l-2.6 3.2z"/>' +
    "</svg>"
  );
}

function panelToggleGlyph(): string {
  return (
    '<svg class="panel-toggle-glyph" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M1.5 2h13v12h-13V2Zm1.5 1.5v9h2.5v-9H3Zm4 0v9h6v-9H7Z"/>' +
    '<path class="panel-toggle-arrow" fill="currentColor" d="m8.2 6 2 2-2 2V6Z"/>' +
    "</svg>"
  );
}

function premiereGlyph(): string {
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M1.5 1.5h11v11h-11v-11ZM4 4v6h1.5V8.2h1.2C8.2 8.2 9 7.4 9 6.1S8.2 4 6.7 4H4Zm1.5 1.3h1.1c.6 0 .9.3.9.7s-.3.7-.9.7H5.5V5.8Z"/>' +
    "</svg>"
  );
}

function helpGlyph(): string {
  return (
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.5a5 5 0 1 1 0 10A5 5 0 0 1 8 3Z"/>' +
    '<path fill="currentColor" d="M7.2 10.8h1.6v1.4H7.2zM5.9 6.3c.1-1.4 1-2.2 2.4-2.2 1.3 0 2.2.8 2.2 2 0 .9-.4 1.4-1.3 2-.7.4-.8.7-.8 1.3H7c0-1.1.3-1.7 1.2-2.3.6-.4.8-.6.8-1s-.3-.7-.8-.7c-.6 0-.9.3-.9.9H5.9Z"/>' +
    "</svg>"
  );
}

function arrowGlyph(): string {
  return (
    '<svg class="btn-apply-arrow" viewBox="0 0 14 14" aria-hidden="true">' +
    '<path fill="currentColor" d="M3 2h9v9h-1.7V4.9L3.6 11.6l-1.2-1.2L9.1 3.7H3V2Z"/>' +
    "</svg>"
  );
}
