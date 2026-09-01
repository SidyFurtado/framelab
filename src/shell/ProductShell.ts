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
  setDisabled,
} from "./controls";
import {
  checkHostCapabilities,
  readSelection,
  type SelectionSummary,
} from "../bridge/premiere";
import { PluginUpdater, type VersionManifest } from "./updater";

const PRODUCT_NAME = "Edit Toolbox";
const PRODUCT_TAGLINE = "Premiere";
const VERSION = "0.1.0";

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
  private updateBadgeEl: HTMLElement | null = null;
  private updateModalEl: HTMLElement | null = null;
  private latestManifest: VersionManifest | null = null;

  private readonly titleEl: HTMLElement;
  private readonly chipEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly calloutEl: HTMLElement;
  private readonly stripEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly resetButton: HTMLElement;
  private readonly applyButton: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statusToolEl: HTMLElement;

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
  private collapsed = new Set<string>();
  private query = "";
  private selection: SelectionSummary | null = null;
  /** Keeps the host warning on screen instead of a Tool's hint. */
  private hostGaps = false;

  constructor(root: HTMLElement) {
    this.updater = new PluginUpdater(VERSION);
    this.root = root;
    this.root.innerHTML = "";
    this.root.className = "shell";

    // ── top bar ──
    const topbar = document.createElement("header");
    topbar.className = "topbar";
    topbar.innerHTML =
      '<div class="brand"><span class="brand-mark">' +
      brandMark() +
      `</span><span class="brand-name"><b>${escapeHtml(PRODUCT_NAME)}</b>` +
      `<span>${escapeHtml(PRODUCT_TAGLINE)}</span></span></div>` +
      '<label class="search">' +
      searchGlyph() +
      '<input type="text" placeholder="Buscar ferramenta…" ' +
      'aria-label="Buscar ferramenta" spellcheck="false"></label>' +
      `<span class="version">v${VERSION}</span>`;

    this.topbarEl = topbar;
    this.searchInput = topbar.querySelector("input") as HTMLInputElement;
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value;
      this.renderNav();
    });

    // ── navigator ──
    this.navEl = document.createElement("nav");
    this.navEl.className = "nav";
    this.navScroll = document.createElement("div");
    this.navScroll.className = "nav-scroll";
    const empty = document.createElement("p");
    empty.className = "nav-empty";
    empty.textContent = "Nenhuma ferramenta encontrada.";
    this.navEl.append(this.navScroll, empty);

    // ── workspace ──
    const work = document.createElement("div");
    work.className = "work";

    const header = document.createElement("div");
    header.className = "work-head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "work-title";
    this.chipEl = document.createElement("span");
    this.chipEl.className = "work-chip";
    const refresh = createControl("work-refresh");
    refresh.title = "Reler a seleção da timeline";
    refresh.setAttribute("aria-label", "Reler a seleção da timeline");
    refresh.innerHTML = refreshGlyph();
    refresh.addEventListener("click", () => void this.refreshSelection());
    header.append(this.titleEl, this.chipEl, refresh);

    this.stateEl = document.createElement("div");
    this.stateEl.className = "work-state";

    this.calloutEl = document.createElement("p");
    this.calloutEl.className = "callout";

    this.stripEl = document.createElement("div");
    this.stripEl.className = "strip";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "work-body";

    const actions = document.createElement("div");
    actions.className = "actions";
    this.resetButton = createControl("btn-reset", "Limpar");
    this.resetButton.hidden = true;
    this.resetButton.addEventListener("click", () => this.resetHandler?.());
    this.applyButton = createControl("btn-apply");
    setDisabled(this.applyButton, true);
    this.applyButton.addEventListener("click", () => void this.runApply());
    actions.append(this.resetButton, this.applyButton);

    work.append(
      header,
      this.stateEl,
      this.calloutEl,
      this.stripEl,
      this.bodyEl,
      actions
    );

    const main = document.createElement("div");
    main.className = "main";
    main.append(this.navEl, work);

    // ── status bar ──
    this.statusEl = document.createElement("footer");
    this.statusEl.className = "statusbar";
    this.statusToolEl = document.createElement("span");
    this.statusToolEl.className = "statusbar-tool";

    this.root.append(topbar, main, this.statusEl);
    this.navScroll.addEventListener("click", (event) => this.onNavClick(event));
    bindKeyboard(this.root);
  }

  start(): void {
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
    badge.title = `Nova versão v${version} disponível! Clique para atualizar.`;
    badge.innerHTML = `<span class="update-dot"></span><span>Atualizar (v${version})</span>`;
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
    btnUpdate.textContent = "Atualizar Agora";

    const btnReload = document.createElement("button");
    btnReload.className = "btn-update-pri";
    btnReload.textContent = "Recarregar Painel";
    btnReload.hidden = true;
    btnReload.addEventListener("click", () => {
      this.updater.reloadPlugin();
    });

    btnUpdate.addEventListener("click", async () => {
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
        btnUpdate.textContent = "Tentar via Navegador";
        btnUpdate.disabled = false;
        btnUpdate.onclick = () => this.updater.openDownloadPage();
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
  }

  // ── navigator ────────────────────────────────────────────

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
        const open = !this.collapsed.has(category.id);
        return (
          `<div class="nav-cat" ${CONTROL} data-category="${category.id}" ` +
          `aria-expanded="${open}"><span class="caret"></span>` +
          `<span class="nav-cat-name">${escapeHtml(category.name)}</span></div>` +
          (open
            ? `<div class="nav-tools">${list
                .map((tool) => this.toolMarkup(tool))
                .join("")}</div>`
            : "")
        );
      })
      .join("");
  }

  private toolMarkup(tool: Tool): string {
    const active = tool.id === this.activeToolId;
    return (
      `<div class="nav-tool${active ? " is-active" : ""}" ${CONTROL} ` +
      `data-tool="${tool.id}" data-available="${tool.available}" ` +
      `title="${escapeHtml(tool.name)}">` +
      `<span class="nav-glyph">${glyph(tool.glyph)}</span>` +
      '<span class="nav-text">' +
      `<span class="nav-name">${escapeHtml(tool.name)}</span>` +
      `<span class="nav-summary">${escapeHtml(tool.summary)}</span>` +
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
      return;
    }

    const categoryButton = target.closest<HTMLElement>("[data-category]");
    const categoryId = categoryButton?.dataset.category;
    if (categoryId) {
      if (this.collapsed.has(categoryId)) {
        this.collapsed.delete(categoryId);
      } else {
        this.collapsed.add(categoryId);
      }
      this.renderNav();
    }
  }

  // ── workspace ────────────────────────────────────────────

  private selectTool(toolId: string): void {
    const tool = findTool(toolId);
    if (!tool || this.activeToolId === toolId) {
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
    this.applyButton.textContent = "Aplicar";
    setDisabled(this.applyButton, true);

    this.titleEl.textContent = tool.name;
    const category = categories.find((entry) => entry.id === tool.category);
    this.chipEl.textContent = category?.name ?? "";
    if (!this.hostGaps) {
      this.calloutEl.textContent = tool.hint;
    }
    this.statusToolEl.textContent = tool.name;
    this.setStatus("", "idle");

    this.renderNav();
    this.bodyEl.scrollTop = 0;
    // tool.ts promises the Shell owns this markup. Now it actually does,
    // instead of leaning on every Tool to clear the container first.
    this.bodyEl.innerHTML = "";
    tool.mount(this.bodyEl, this.createContext());
    this.renderApplyCount();
  }

  private createContext(): ToolContext {
    const generation = this.toolGeneration;
    /** false once this Tool has been replaced. */
    const live = (): boolean => generation === this.toolGeneration;

    return {
      setApplyLabel: (label) => {
        if (!live()) return;
        this.applyButton.textContent = label;
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

  /** Guards the action button against re-entry while a Tool is running. */
  private async runApply(): Promise<void> {
    const handler = this.applyHandler;
    if (!handler || isDisabled(this.applyButton)) {
      return;
    }
    this.applyStateOwned = false;
    setDisabled(this.applyButton, true);
    try {
      await handler();
    } finally {
      // Hand the control back only if the Tool is still holding it AND
      // did not decide the state itself. Re-enabling unconditionally lit
      // the button up again after a run that left nothing selected.
      if (this.applyHandler !== handler) {
        setDisabled(this.applyButton, true);
      } else if (!this.applyStateOwned) {
        setDisabled(this.applyButton, false);
      }
      this.renderApplyCount();
    }
  }

  private setStatus(text: string, tone: StatusTone): void {
    this.statusEl.className = `statusbar${
      tone === "done" ? " is-done" : tone === "error" ? " is-error" : ""
    }`;
    this.statusEl.innerHTML = "";
    if (text) {
      const message = document.createElement("span");
      message.textContent = text;
      this.statusEl.append(message);
    }
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
      this.renderStrip();
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

  private renderStrip(): void {
    const summary = this.selection;
    this.stripEl.innerHTML = "";

    if (!summary || summary.selectedCount === 0) {
      this.stripEl.hidden = true;
      return;
    }
    this.stripEl.hidden = false;

    const base = document.createElement("span");
    base.className = "strip-base";
    this.stripEl.append(base);

    // Positioned in sequence time. Laid end to end, the strip hid every
    // gap and put the playhead nowhere near where it really was.
    const span = summary.rangeEnd - summary.rangeStart;
    if (!(span > 0)) {
      return;
    }

    const clips = document.createElement("span");
    clips.className = "strip-clips";

    for (const clip of summary.clips) {
      const item = document.createElement("span");
      item.className = `strip-clip${clip.selected ? " is-selected" : ""}`;
      item.style.left = `${(
        ((clip.startSeconds - summary.rangeStart) / span) * 100
      ).toFixed(3)}%`;
      item.style.width = `${(
        ((clip.endSeconds - clip.startSeconds) / span) * 100
      ).toFixed(3)}%`;
      if (clip.selected) {
        const block = document.createElement("span");
        block.className = "strip-block";
        item.append(block);
      }
      clips.append(item);
    }

    this.stripEl.append(clips);

    if (summary.playheadRatio !== null) {
      const head = document.createElement("span");
      head.className = "strip-head";
      head.style.left = `${(summary.playheadRatio * 100).toFixed(2)}%`;
      this.stripEl.append(head);
    }
  }

  private renderApplyCount(): void {
    this.applyButton.querySelector(".btn-apply-count")?.remove();
    const count = this.selection?.selectedCount ?? 0;
    const tool = this.activeToolId ? findTool(this.activeToolId) : undefined;
    if (isDisabled(this.applyButton) || count === 0 || tool?.usesSelection === false) {
      return;
    }
    const badge = document.createElement("span");
    badge.className = "btn-apply-count";
    badge.textContent = `${count} ${count === 1 ? "clipe" : "clipes"}`;
    this.applyButton.append(badge);
  }
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/* The site's own mark: a film frame with perforations and a rec dot. */
function brandMark(): string {
  return (
    '<svg viewBox="0 0 100 100" aria-hidden="true">' +
    '<rect x="1" y="1" width="98" height="98" fill="none" stroke="currentColor" stroke-width="6"/>' +
    '<rect x="14" y="18" width="10" height="12" fill="currentColor"/>' +
    '<rect x="14" y="44" width="10" height="12" fill="currentColor"/>' +
    '<rect x="14" y="70" width="10" height="12" fill="currentColor"/>' +
    '<rect x="76" y="18" width="10" height="12" fill="currentColor"/>' +
    '<rect x="76" y="44" width="10" height="12" fill="currentColor"/>' +
    '<rect x="76" y="70" width="10" height="12" fill="currentColor"/>' +
    '<circle cx="50" cy="50" r="15" fill="#E5372A"/></svg>'
  );
}

function searchGlyph(): string {
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2 12.4 12.4"/></svg>'
  );
}

function refreshGlyph(): string {
  return (
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" ' +
    'stroke-width="1.2" stroke-linecap="square">' +
    '<path d="M11.6 7a4.6 4.6 0 1 1-1.5-3.4"/><path d="M11.8 1.6v3.2H8.6"/></svg>'
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return "&quot;";
    }
  });
}
