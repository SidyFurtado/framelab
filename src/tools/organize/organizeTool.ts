/**
 * Organize — the project-level bin organizer Tool.
 *
 * Owns its body; the Shell owns the header, callout, strip and actions.
 * The body contains a scan button, a tree preview of the classified
 * items, and statistics. The Shell's Apply button triggers the organize
 * and the Reset button undoes it.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL } from "../../shell/controls";
import {
  scanProject,
  organizeProject,
  undoOrganize,
  AUDIO_KIND_LABELS,
  TOP_CATEGORY_LABELS,
  TOP_CATEGORY_ORDER,
  type AudioKind,
  type ScanResult,
  type OrganizeSnapshot,
  type TopCategory,
  type ClassifiedItem,
} from "./applyOrganize";

/** Glyph per top category for the tree. */
const TOP_CAT_GLYPHS: Record<TopCategory, string> = {
  sequence: "📋",
  video: "🎬",
  audio: "🔊",
  image: "🖼",
  graphics: "📐",
  premiere: "🎛",
  other: "📦",
};

export const organizeTool: Tool = {
  id: "organize",
  name: "Organizar Pastas",
  summary: "Organização automática do projeto por tipo",
  hint:
    "Organiza apenas os arquivos e sequências soltos na raiz do projeto. " +
    "Suas pastas pessoais e pastas criadas por plugins (Animation Composer, etc.) são 100% preservadas e intocadas.",
  category: "projeto",
  glyph: "folder",
  available: true,

  mount(container: HTMLElement, context: ToolContext): void {
    let scan: ScanResult | null = null;
    let lastSnapshot: OrganizeSnapshot | null = null;
    let scanning = false;

    container.innerHTML = emptyMarkup();

    const scanBtn = container.querySelector<HTMLElement>("[data-scan]");
    const treeEl = container.querySelector<HTMLElement>("[data-tree]");
    const statsEl = container.querySelector<HTMLElement>("[data-stats]");
    const emptyEl = container.querySelector<HTMLElement>("[data-empty]");

    context.setApplyLabel("ORGANIZAR PROJETO");
    context.setApplyEnabled(false);
    context.setResetLabel("DESFAZER");
    context.setResetHandler(null);

    // ── scan ──────────────────────────────────────────────────

    async function runScan(): Promise<void> {
      if (scanning) return;
      scanning = true;
      context.setStatus("Escaneando itens soltos…");
      context.setApplyEnabled(false);

      if (scanBtn) {
        scanBtn.setAttribute("aria-disabled", "true");
        scanBtn.textContent = "Escaneando…";
      }

      try {
        scan = await scanProject();
        renderTree();
        renderStats();
        context.setApplyEnabled(scan.items.length > 0);
        context.setStatus(
          `${scan.items.length} ${scan.items.length === 1 ? "item solto encontrado" : "itens soltos encontrados"}.`,
          "done"
        );
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        context.setStatus(msg, "error");
      } finally {
        scanning = false;
        if (scanBtn) {
          scanBtn.removeAttribute("aria-disabled");
          scanBtn.textContent = "Escanear Projeto";
        }
      }
    }

    scanBtn?.addEventListener("click", () => void runScan());

    // ── apply ─────────────────────────────────────────────────

    context.setApplyHandler(async () => {
      if (!scan) return;
      context.setStatus("Organizando…");
      context.setApplyEnabled(false);

      const result = await organizeProject(scan);
      context.setStatus(result.message, result.ok ? "done" : "error");

      if (result.ok && result.snapshot) {
        lastSnapshot = result.snapshot;
        context.setResetHandler(() => void runUndo());
        // Clear the tree — project is now organized
        scan = null;
        if (treeEl) treeEl.innerHTML = organizedMarkup(result.snapshot.moves.length);
        if (statsEl) statsEl.innerHTML = "";
        context.setApplyEnabled(false);
      } else if (!result.ok) {
        // The scan is still valid: the run refused, it did not consume it.
        context.setApplyEnabled(scan !== null && scan.items.length > 0);
      }
    });

    // ── undo ──────────────────────────────────────────────────

    async function runUndo(): Promise<void> {
      if (!lastSnapshot) return;
      context.setStatus("Desfazendo organização…");

      const result = await undoOrganize(lastSnapshot);
      context.setStatus(result.message, result.ok ? "done" : "error");

      if (result.ok) {
        lastSnapshot = null;
        context.setResetHandler(null);
        // Reset the UI
        scan = null;
        if (treeEl) treeEl.innerHTML = "";
        if (statsEl) statsEl.innerHTML = "";
        if (emptyEl) emptyEl.hidden = false;
        context.setApplyEnabled(false);
      }
    }

    // ── render tree ───────────────────────────────────────────

    function renderTree(): void {
      if (!scan || !treeEl) return;
      if (emptyEl) emptyEl.hidden = true;

      let html = "";

      for (const cat of TOP_CATEGORY_ORDER) {
        if (cat === "sequence") {
          if (scan.totalSequences === 0) continue;

          html += `<div class="org-cat">`;
          html += `<span class="org-cat-icon">${TOP_CAT_GLYPHS.sequence}</span>`;
          html += `<span class="org-cat-name">${TOP_CATEGORY_LABELS.sequence}</span>`;
          html += `<span class="org-cat-count">${scan.totalSequences}</span>`;
          html += `</div>`;

          // Subfolders inside Sequencias:
          // 1. Groups with repeated names (e.g. VB3.03)
          for (const group of scan.sequenceGroups) {
            html += `<div class="org-group">`;
            html += `<span class="org-group-name">${escapeHtml(group.base)}</span>`;
            html += `<span class="org-group-count">${group.items.length}</span>`;
            html += `</div>`;
            html += renderItemList(group.items, true);
          }

          // 2. Standalone Normal (Principal)
          if (scan.standalonePrincipal.length > 0) {
            html += `<div class="org-group">`;
            html += `<span class="org-group-name">Principal</span>`;
            html += `<span class="org-group-count">${scan.standalonePrincipal.length}</span>`;
            html += `</div>`;
            html += renderItemList(scan.standalonePrincipal, true);
          }

          // 3. Standalone Nested
          if (scan.standaloneNested.length > 0) {
            html += `<div class="org-group">`;
            html += `<span class="org-group-name">Nested</span>`;
            html += `<span class="org-group-count">${scan.standaloneNested.length}</span>`;
            html += `</div>`;
            html += renderItemList(scan.standaloneNested, true);
          }
        } else {
          const count = scan.counts[cat];
          if (count === 0) continue;

          const gl = TOP_CAT_GLYPHS[cat];
          const label = TOP_CATEGORY_LABELS[cat];

          html += `<div class="org-cat">`;
          html += `<span class="org-cat-icon">${gl}</span>`;
          html += `<span class="org-cat-name">${escapeHtml(label)}</span>`;
          html += `<span class="org-cat-count">${count}</span>`;
          html += `</div>`;

          const items = scan.items.filter((i) => i.category === cat);

          // Áudio é o único que ganha subpasta, e só quando a heurística
          // decidiu. O que ela não soube dizer aparece solto aqui mesmo,
          // que é exatamente onde vai ficar no projeto.
          if (cat === "audio" && (scan.audioKindCounts.music > 0 || scan.audioKindCounts.sfx > 0)) {
            for (const kind of ["music", "sfx"] as AudioKind[]) {
              const group = items.filter((i) => i.audioKind === kind);
              if (group.length === 0) continue;
              html += `<div class="org-group">`;
              html += `<span class="org-group-name">${escapeHtml(AUDIO_KIND_LABELS[kind])}</span>`;
              html += `<span class="org-group-count">${group.length}</span>`;
              html += `</div>`;
              html += renderItemList(group, true);
            }
            const loose = items.filter((i) => i.audioKind === null);
            if (loose.length > 0) {
              html += renderItemList(loose);
            }
          } else {
            html += renderItemList(items);
          }
        }
      }

      treeEl.innerHTML = html;
    }

    function renderItemList(items: ClassifiedItem[], indented = false): string {
      const indent = indented ? " org-items-indent" : "";
      let html = `<div class="org-items${indent}">`;
      for (const item of items) {
        html += `<div class="org-item" title="${escapeHtml(item.name)}">`;
        html += `<span class="org-item-name">${escapeHtml(item.name)}</span>`;
        html += `</div>`;
      }
      html += `</div>`;
      return html;
    }

    // ── render stats ──────────────────────────────────────────

    function renderStats(): void {
      if (!scan || !statsEl) return;

      const total = scan.items.length;
      const catStats: Array<{ label: string; count: number }> = [];

      if (scan.totalSequences > 0) {
        catStats.push({ label: "Sequências", count: scan.totalSequences });
      }
      if (scan.counts.video > 0) catStats.push({ label: "Vídeos", count: scan.counts.video });
      if (scan.counts.audio > 0) catStats.push({ label: "Áudios", count: scan.counts.audio });
      if (scan.counts.image > 0) catStats.push({ label: "Imagens", count: scan.counts.image });
      if (scan.counts.graphics > 0) catStats.push({ label: "Gráficos", count: scan.counts.graphics });
      if (scan.counts.premiere > 0) catStats.push({ label: "Itens Premiere", count: scan.counts.premiere });
      if (scan.counts.other > 0) catStats.push({ label: "Outros", count: scan.counts.other });

      let html = '<div class="org-stat-row">';
      html += `<span class="org-stat-total">${total} itens</span>`;
      html += `<span class="org-stat-sep">·</span>`;
      html += catStats
        .map(
          (c) =>
            `<span class="org-stat-cat">${c.label} <b>${c.count}</b></span>`
        )
        .join('<span class="org-stat-sep">·</span>');
      html += "</div>";

      if (scan.sequenceGroups.length > 0) {
        const groupCount = scan.sequenceGroups.length;
        html += `<div class="org-stat-note">${groupCount} ${groupCount === 1 ? "pasta de sequência por nome criada" : "pastas de sequências por nome criadas"}</div>`;
      }

      statsEl.innerHTML = html;
    }
  },
};

// ── markup helpers ─────────────────────────────────────────────────

function emptyMarkup(): string {
  return (
    '<div class="zones">' +
      '<div class="zone">' +
        // The scan control sits OUTSIDE the intro block: renderTree hides
        // that block, and with the button inside it there was no way back
        // to a second scan without leaving the Tool and returning.
        '<div class="org-empty" data-empty>' +
          '<p class="org-empty-title">Organização do Projeto</p>' +
          '<p class="org-empty-desc">Escaneia apenas os arquivos e sequências soltos na raiz do projeto. ' +
          'Suas pastas pessoais e pastas de plugins (Animation Composer, etc.) são 100% preservadas e intocadas.</p>' +
        '</div>' +
        `<div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Escanear Projeto</div></div>` +
        '<div class="org-tree" data-tree></div>' +
        '<div class="org-stats" data-stats></div>' +
      '</div>' +
    '</div>'
  );
}

function organizedMarkup(count: number): string {
  return (
    '<div class="org-done">' +
      '<p class="org-done-title">Projeto Organizado ✓</p>' +
      `<p class="org-done-desc">${count} ${count === 1 ? "item foi movido" : "itens foram movidos"} para pastas organizadas. ` +
      'Suas pastas pré-existentes e pastas de plugins foram preservadas. Use "Desfazer" para reverter.</p>' +
    '</div>'
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return "&quot;";
    }
  });
}
