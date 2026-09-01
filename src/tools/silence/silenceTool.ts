/**
 * Corte de Silêncios — o workspace.
 *
 * O fluxo é analisar uma vez e ajustar à vontade: depois da varredura
 * o que fica em memória é a CURVA de dB de cada clipe (ou a
 * transcrição, no outro modo), então mexer num slider recalcula o
 * plano inteiro na hora sem tocar no host nem chamar o ffmpeg de novo.
 */
import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL } from "../../shell/controls";
import {
  applyCuts,
  recomputePlans,
  scanSelection,
  undoCuts,
  type ClipStatus,
  type ClipTarget,
  type CutSnapshot,
  type SilenceScan,
} from "./applySilence";
import { formatSeconds } from "./detect";
import {
  diagnose,
  openWorkFolder,
  readConfig,
  writeConfig,
  type DiagnosticLine,
} from "./ffmpeg";
import {
  clampParams,
  defaultParams,
  formatParam,
  matchPreset,
  presetById,
  SILENCE_PRESETS,
  SLIDERS,
  type DetectionMode,
  type SilenceParams,
  type SliderSpec,
} from "./presets";

/** Rótulo curto por status, para a linha do clipe na lista. */
const STATUS_LABEL: Record<ClipStatus, string> = {
  ready: "",
  nothing: "sem silêncio",
  "no-transcript": "sem transcrição",
  "no-speech": "sem fala",
  "no-media": "sem arquivo",
  speed: "velocidade alterada",
  error: "erro",
};

/**
 * Lets `unmount` call off a scan that is still running.
 *
 * A wave scan can sit waiting on ffmpeg for up to twenty minutes. Leaving
 * the Tool used to leave that loop polling the disk behind a panel nobody
 * is looking at.
 */
let cancelActiveScan: (() => void) | null = null;

export const silenceTool: Tool = {
  id: "silence",
  name: "Corte de Silêncios",
  summary: "Remove pausas e fecha o corte automaticamente",
  hint:
    "Selecione os clipes falados na timeline e analise. " +
    "Os trechos com fala são mantidos e encostados na timeline.",
  category: "edicao",
  glyph: "cut",
  available: true,

  mount(container: HTMLElement, context: ToolContext): void {
    let params: SilenceParams = defaultParams();
    let mode: DetectionMode = "waveform";
    let ffmpegPath = "";
    let scan: SilenceScan | null = null;
    let snapshot: CutSnapshot | null = null;
    let scanning = false;
    let cancelRequested = false;

    container.innerHTML = markup(params);

    const modeSeg = container.querySelector<HTMLElement>("[data-mode-seg]");
    const presetRail = container.querySelector<HTMLElement>("[data-preset-rail]");
    const presetNote = container.querySelector<HTMLElement>("[data-preset-note]");
    const fillerField = container.querySelector<HTMLElement>("[data-filler-field]");
    const fillerSeg = container.querySelector<HTMLElement>("[data-filler-seg]");
    const autoSeg = container.querySelector<HTMLElement>("[data-auto-seg]");
    const autoField = container.querySelector<HTMLElement>("[data-auto-field]");
    const ffmpegField = container.querySelector<HTMLElement>("[data-ffmpeg-field]");
    const ffmpegInput = container.querySelector<HTMLInputElement>("[data-ffmpeg-path]");
    const diagButton = container.querySelector<HTMLElement>("[data-diag]");
    const diagOut = container.querySelector<HTMLElement>("[data-diag-out]");
    const scanButton = container.querySelector<HTMLElement>("[data-scan]");
    const emptyEl = container.querySelector<HTMLElement>("[data-empty]");
    const reportEl = container.querySelector<HTMLElement>("[data-report]");
    const manualEl = container.querySelector<HTMLElement>("[data-manual]");
    const advToggle = container.querySelector<HTMLElement>("[data-adv-toggle]");
    const advContent = container.querySelector<HTMLElement>("[data-adv-content]");
    const advIcon = container.querySelector<HTMLElement>("[data-adv-icon]");

    advToggle?.addEventListener("click", () => {
      if (!advContent) {
        return;
      }
      const willOpen = advContent.hidden;
      advContent.hidden = !willOpen;
      if (advIcon) {
        advIcon.style.transform = willOpen ? "rotate(180deg)" : "";
      }
    });

    context.setApplyLabel("CORTAR SILÊNCIOS");
    context.setApplyEnabled(false);
    context.setResetLabel("DESFAZER CORTE");
    context.setResetHandler(null);

    // Carrega configurações persistidas de máquina
    void readConfig().then((config) => {
      ffmpegPath = config.ffmpegPath;
      if (config.mode === "transcript" || config.mode === "waveform") {
        mode = config.mode;
      }
      if (ffmpegInput) {
        ffmpegInput.value = ffmpegPath;
      }
      syncMode();
    });

    // ── modo ──────────────────────────────────────────────────

    function syncMode(): void {
      for (const item of modeSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String(item.getAttribute("data-mode") === mode)
        );
      }
      if (fillerField) {
        fillerField.hidden = mode !== "transcript";
      }
      if (autoField) {
        autoField.hidden = mode !== "waveform";
      }
      if (ffmpegField) {
        ffmpegField.hidden = mode !== "waveform";
      }
      syncSliderVisibility();
    }

    function syncSliderVisibility(): void {
      for (const spec of SLIDERS) {
        const field = container.querySelector<HTMLElement>(`[data-field="${spec.key}"]`);
        if (!field) {
          continue;
        }
        let visible = spec.modes.includes(mode);
        if (spec.key === "dbMargin") {
          visible = visible && params.autoThreshold;
        }
        if (spec.key === "dbThreshold") {
          visible = visible && !params.autoThreshold;
        }
        field.hidden = !visible;
      }
      for (const item of autoSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String((item.getAttribute("data-auto") === "on") === params.autoThreshold)
        );
      }
    }

    modeSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>(".seg-item");
      if (!item || !modeSeg.contains(item)) {
        return;
      }
      const next = item.getAttribute("data-mode") === "transcript" ? "transcript" : "waveform";
      if (next === mode) {
        return;
      }
      mode = next;
      scan = null;
      if (reportEl) {
        reportEl.innerHTML = "";
      }
      if (emptyEl) {
        emptyEl.hidden = false;
      }
      context.setApplyEnabled(false);
      syncMode();
      void writeConfig({ ffmpegPath, mode });
      context.setStatus(
        mode === "waveform" ? "Modo Onda (ffmpeg)" : "Modo Transcrição"
      );
    });

    ffmpegInput?.addEventListener("change", () => {
      ffmpegPath = ffmpegInput.value.trim();
      void writeConfig({ ffmpegPath, mode });
    });

    // ── parâmetros ────────────────────────────────────────────

    function syncPresetRail(): void {
      const active = matchPreset(params);
      for (const pill of presetRail?.querySelectorAll<HTMLElement>(".preset-pill") ?? []) {
        pill.classList.toggle(
          "is-active",
          active !== null && pill.getAttribute("data-preset") === active.id
        );
      }
      if (presetNote) {
        presetNote.textContent =
          active?.note ?? "Ajustes manuais — nenhum preset bate com estes números.";
      }
    }

    function syncSliders(): void {
      for (const spec of SLIDERS) {
        const input = container.querySelector<HTMLInputElement>(
          `[data-slider="${spec.key}"]`
        );
        const output = container.querySelector<HTMLElement>(`[data-out="${spec.key}"]`);
        if (input) {
          input.value = String(params[spec.key]);
        }
        if (output) {
          output.textContent = formatParam(spec, params[spec.key]);
        }
      }
      for (const item of fillerSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        item.setAttribute(
          "aria-pressed",
          String((item.getAttribute("data-filler") === "on") === params.removeFillers)
        );
      }
    }

    /** Um parâmetro mudou: o plano em memória é refeito na hora. */
    function paramsChanged(): void {
      params = clampParams(params);
      syncSliders();
      syncSliderVisibility();
      syncPresetRail();
      if (scan) {
        recomputePlans(scan, params);
        renderReport();
        context.setApplyEnabled(scan.readyCount > 0);
      }
    }

    for (const spec of SLIDERS) {
      const input = container.querySelector<HTMLInputElement>(
        `[data-slider="${spec.key}"]`
      );
      input?.addEventListener("input", () => {
        const parsed = Number.parseFloat(input.value);
        if (Number.isFinite(parsed)) {
          params = { ...params, [spec.key]: parsed };
          paramsChanged();
        }
      });
    }

    presetRail?.addEventListener("click", (event) => {
      const pill = (event.target as Element | null)?.closest<HTMLElement>(".preset-pill");
      const preset = pill ? presetById(pill.getAttribute("data-preset") ?? "") : null;
      if (preset) {
        params = { ...preset.params };
        paramsChanged();
        context.setStatus(`Preset ${preset.name}`);
      }
    });

    fillerSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>(".seg-item");
      if (item && fillerSeg.contains(item)) {
        params = { ...params, removeFillers: item.getAttribute("data-filler") === "on" };
        paramsChanged();
      }
    });

    autoSeg?.addEventListener("click", (event) => {
      const item = (event.target as Element | null)?.closest<HTMLElement>(".seg-item");
      if (item && autoSeg.contains(item)) {
        params = { ...params, autoThreshold: item.getAttribute("data-auto") === "on" };
        paramsChanged();
      }
    });

    // ── análise ───────────────────────────────────────────────

    async function runScan(): Promise<void> {
      if (scanning) {
        cancelRequested = true;
        context.setStatus("Cancelando…");
        return;
      }
      scanning = true;
      cancelRequested = false;
      context.setApplyEnabled(false);
      setScanBusy(true);

      try {
        showManual(null, "");
        scan = await scanSelection(params, {
          mode,
          ffmpegPath,
          onStage: (text) => context.setStatus(text),
          onProgress: (done, total) =>
            context.setStatus(`Extraindo áudio… ${done}/${total}`),
          cancelled: () => cancelRequested,
          onManual: (scriptPath, reason) => {
            showManual(scriptPath, reason);
            context.setStatus(
              "Execute extract.command na pasta aberta.",
              "error"
            );
          },
        });
        showManual(null, "");
        renderReport();
        context.setApplyEnabled(scan.readyCount > 0);
        context.setStatus(summaryLine(scan), scan.readyCount > 0 ? "done" : "idle");
      } catch (cause) {
        scan = null;
        console.error("[Silêncios] varredura falhou:", cause);
        context.setStatus(
          cause instanceof Error ? cause.message : String(cause),
          "error"
        );
      } finally {
        scanning = false;
        cancelRequested = false;
        setScanBusy(false);
      }
    }

    function showManual(scriptPath: string | null, reason: string): void {
      if (!manualEl) {
        return;
      }
      manualEl.hidden = scriptPath === null;
      if (!scriptPath) {
        manualEl.innerHTML = "";
        return;
      }
      manualEl.innerHTML =
        '<p class="sil-warn"><b>Execução manual necessária:</b>' +
        (reason ? ` <span class="sil-manual-why">${escapeHtml(reason)}</span>` : "") +
        " Dê duplo clique em <b>extract.command</b> na pasta de trabalho.</p>" +
        `<p class="sil-manual-path">${escapeHtml(scriptPath)}</p>` +
        `<div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-open-folder>Abrir pasta</div></div>`;
      manualEl
        .querySelector<HTMLElement>("[data-open-folder]")
        ?.addEventListener("click", () => {
          void openWorkFolder().catch((cause: unknown) => {
            context.setStatus(
              cause instanceof Error ? cause.message : String(cause),
              "error"
            );
          });
        });
    }

    function setScanBusy(busy: boolean): void {
      if (!scanButton) {
        return;
      }
      scanButton.classList.toggle("is-busy", busy);
      scanButton.textContent = busy ? "Cancelar" : "Analisar Seleção";
    }

    scanButton?.addEventListener("click", () => void runScan());

    diagButton?.addEventListener("click", () => {
      if (!diagOut) {
        return;
      }
      diagButton.setAttribute("aria-disabled", "true");
      diagOut.innerHTML = '<p class="sil-diag-wait">Testando…</p>';
      void diagnose(ffmpegPath)
        .then((lines) => {
          diagOut.innerHTML = renderDiagnostic(lines);
        })
        .catch((cause: unknown) => {
          diagOut.innerHTML =
            '<p class="sil-diag-wait">' +
            escapeHtml(cause instanceof Error ? cause.message : String(cause)) +
            "</p>";
        })
        .then(() => {
          diagButton.removeAttribute("aria-disabled");
        });
    });

    // ── aplicar ───────────────────────────────────────────────

    context.setApplyHandler(async () => {
      if (!scan || scan.readyCount === 0) {
        return;
      }
      context.setStatus("Cortando silêncios…");
      context.setApplyEnabled(false);

      const result = await applyCuts(scan, (done, total) => {
        context.setStatus(`Cortando… ${done}/${total}`);
      });
      context.setStatus(result.message, result.ok ? "done" : "error");

      if (result.snapshot) {
        snapshot = result.snapshot;
        context.setResetHandler(() => void runUndo());
      }
      if (result.ok) {
        scan = null;
        if (reportEl) {
          reportEl.innerHTML = doneMarkup(result.message);
        }
        if (emptyEl) {
          emptyEl.hidden = true;
        }
      }
      context.refreshSelection();
    });

    async function runUndo(): Promise<void> {
      if (!snapshot) {
        return;
      }
      context.setStatus("Restaurando clipes originais…");
      const result = await undoCuts(snapshot);
      context.setStatus(result.message, result.ok ? "done" : "error");
      if (result.ok) {
        snapshot = null;
        context.setResetHandler(null);
        scan = null;
        if (reportEl) {
          reportEl.innerHTML = "";
        }
        if (emptyEl) {
          emptyEl.hidden = false;
        }
        context.setApplyEnabled(false);
      }
      context.refreshSelection();
    }

    // ── relatório ─────────────────────────────────────────────

    function renderReport(): void {
      if (!reportEl || !scan) {
        return;
      }
      if (emptyEl) {
        emptyEl.hidden = scan.clips.length > 0;
      }
      if (scan.clips.length === 0) {
        reportEl.innerHTML = "";
        return;
      }

      const finalSeconds = Math.max(0, scan.totalSeconds - scan.removedSeconds);
      const ratio =
        scan.totalSeconds > 0 ? scan.removedSeconds / scan.totalSeconds : 0;

      let html = "";

      html +=
        '<div class="sil-stats">' +
        `<span class="sil-stat-tag">✂️ ${scan.cuts} ${
          scan.cuts === 1 ? "corte" : "cortes"
        }</span>` +
        `<span class="sil-stat-saved">−${formatSeconds(scan.removedSeconds)}</span>` +
        `<span class="sil-stat-range">${formatSeconds(scan.totalSeconds)} → <b>${formatSeconds(
          finalSeconds
        )}</b></span>` +
        `<span class="sil-stat-pct">−${Math.round(ratio * 100)}%</span>` +
        "</div>";

      html += renderBars(scan);

      html += '<div class="sil-list">';
      for (const clip of scan.clips) {
        html += renderClipRow(clip);
      }
      html += "</div>";

      html += warnings(scan);
      reportEl.innerHTML = html;
    }

    function warnings(current: SilenceScan): string {
      let html = "";

      if (current.mode === "transcript") {
        const missing = current.clips.filter((clip) => clip.status === "no-transcript");
        if (missing.length > 0) {
          html +=
            '<p class="sil-warn">' +
            `${missing.length} ${
              missing.length === 1 ? "clipe sem transcrição" : "clipes sem transcrição"
            }. Transcreva em <b>Texto › Transcrever</b> ou use o modo <b>Onda</b>.</p>`;
        }
      }

      const orphans = current.clips.filter(
        (clip) => clip.orphanAudio && clip.status === "ready"
      );
      if (orphans.length > 0) {
        html +=
          '<p class="sil-warn"><b>Áudio não selecionado:</b> ' +
          `${orphans.length} ${
            orphans.length === 1 ? "clipe possui" : "clipes possuem"
          } áudio desvinculado. Selecione áudio e vídeo juntos para manter o sincronismo.</p>`;
      }

      return html;
    }

    // Estado inicial
    cancelActiveScan = () => {
      cancelRequested = true;
    };
    syncSliders();
    syncPresetRail();
    syncMode();
  },

  unmount(): void {
    cancelActiveScan?.();
    cancelActiveScan = null;
  },
};

// ── markup ─────────────────────────────────────────────────────────

function markup(params: SilenceParams): string {
  const presets = SILENCE_PRESETS.map(
    (preset) =>
      `<div class="preset-pill" ${CONTROL} data-preset="${preset.id}">${preset.name}</div>`
  ).join("");

  const sliderFor = (spec: SliderSpec): string =>
    `<div class="field" data-field="${spec.key}" hidden>` +
    '<div class="field-head">' +
    `<span class="t-label">${spec.label}</span>` +
    `<span class="field-val" data-out="${spec.key}">${formatParam(
      spec,
      params[spec.key]
    )}</span>` +
    "</div>" +
    '<div class="slider-row">' +
    `<input type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" ` +
    `value="${params[spec.key]}" data-slider="${spec.key}" aria-label="${spec.label}">` +
    "</div>" +
    // The notes were written, typed and shipped, and never rendered — the
    // whole explanation of the Tool's hardest controls sat unreachable in
    // presets.ts.
    `<p class="field-note">${escapeHtml(spec.note)}</p>` +
    "</div>";

  const coreSliders = ["minSilence", "padIn", "padOut"]
    .map((k) => SLIDERS.find((s) => s.key === k))
    .filter((s): s is SliderSpec => Boolean(s))
    .map(sliderFor)
    .join("");

  const advSliders = ["minKeep", "noiseIsland", "dbMargin", "dbThreshold", "minConfidence"]
    .map((k) => SLIDERS.find((s) => s.key === k))
    .filter((s): s is SliderSpec => Boolean(s))
    .map(sliderFor)
    .join("");

  return (
    '<div class="zones">' +
      // Presets principais
      '<div class="zone">' +
        '<div class="field">' +
          '<span class="t-label">Ritmo de Corte</span>' +
          `<div class="preset-rail" data-preset-rail>${presets}</div>` +
          '<p class="field-note" data-preset-note></p>' +
        "</div>" +
      "</div>" +

      // Controles Essenciais (Silêncio mínimo, Margem antes/depois)
      `<div class="zone">${coreSliders}</div>` +

      // Ação de Análise e Relatório Visual
      '<div class="zone is-wide">' +
        '<div class="sil-empty" data-empty>' +
          '<p class="sil-empty-title">Pronto para analisar</p>' +
          '<p class="sil-empty-desc">Selecione os clipes na timeline e analise para visualizar o corte.</p>' +
        "</div>" +
        `<div class="sil-scan-row"><div class="org-scan" ${CONTROL} data-scan>Analisar Seleção</div></div>` +
        '<div class="sil-manual" data-manual hidden></div>' +
        '<div class="sil-report" data-report></div>' +
      "</div>" +

      // Ajustes Avançados (Colapsável)
      '<div class="sil-advanced">' +
        `<div class="sil-advanced-summary" ${CONTROL} data-adv-toggle>` +
          '<span class="sil-advanced-title">⚙️ Ajustes Avançados</span>' +
          '<span class="sil-advanced-icon" data-adv-icon>▾</span>' +
        "</div>" +
        '<div class="sil-advanced-content" data-adv-content hidden>' +
          '<div class="field">' +
            '<span class="t-label">Método de Detecção</span>' +
            '<div class="seg" data-mode-seg>' +
              `<div class="seg-item" ${CONTROL} data-mode="waveform">Onda (ffmpeg)</div>` +
              `<div class="seg-item" ${CONTROL} data-mode="transcript">Transcrição</div>` +
            "</div>" +
          "</div>" +

          '<div class="field" data-filler-field hidden>' +
            '<span class="t-label">Muletas de Fala</span>' +
            '<div class="seg" data-filler-seg>' +
              `<div class="seg-item" ${CONTROL} data-filler="off">Manter</div>` +
              `<div class="seg-item" ${CONTROL} data-filler="on">Remover</div>` +
            "</div>" +
          "</div>" +

          '<div class="field" data-auto-field hidden>' +
            '<span class="t-label">Calibração de Ruído</span>' +
            '<div class="seg" data-auto-seg>' +
              `<div class="seg-item" ${CONTROL} data-auto="on">Automático</div>` +
              `<div class="seg-item" ${CONTROL} data-auto="off">Fixo</div>` +
            "</div>" +
          "</div>" +

          advSliders +

          '<div class="sil-ffmpeg-group" data-ffmpeg-field hidden>' +
            '<div class="field">' +
              '<span class="t-label">Caminho do FFmpeg</span>' +
              '<input type="text" class="sil-path" data-ffmpeg-path spellcheck="false" ' +
              'placeholder="Padrão do sistema (automático)">' +
            "</div>" +
            '<div class="field">' +
              '<div class="field-head">' +
                '<span class="t-label">Diagnóstico</span>' +
                `<span class="field-action" ${CONTROL} data-diag>Testar FFmpeg</span>` +
              "</div>" +
              '<div class="sil-diag" data-diag-out></div>' +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>" +
    "</div>"
  );
}

/**
 * A barra visual de cada clipe: mantido em âmbar, removido em vazio.
 */
function renderBars(scan: SilenceScan): string {
  const drawable = scan.clips.filter((clip) => clip.plan && clip.durationSeconds > 0);
  if (drawable.length === 0) {
    return "";
  }

  let html = '<div class="sil-bars">';
  for (const clip of drawable.slice(0, 8)) {
    const plan = clip.plan!;
    const span = clip.sourceEnd - clip.sourceStart;
    if (!(span > 0)) {
      continue;
    }

    let cells = "";
    let cursor = clip.sourceStart;
    for (const keep of plan.keep) {
      if (keep.start > cursor) {
        cells += cell("sil-cut", (keep.start - cursor) / span);
      }
      cells += cell("sil-keep", (keep.end - keep.start) / span);
      cursor = keep.end;
    }
    if (clip.sourceEnd > cursor) {
      cells += cell("sil-cut", (clip.sourceEnd - cursor) / span);
    }
    html += `<div class="sil-bar">${cells}</div>`;
  }
  if (drawable.length > 8) {
    html += `<p class="sil-bar-more">+${drawable.length - 8} clipes não desenhados</p>`;
  }
  html += "</div>";
  return html;
}

function cell(className: string, fraction: number): string {
  const width = Math.max(0, Math.min(100, fraction * 100));
  return `<span class="${className}" style="width:${width.toFixed(3)}%"></span>`;
}

function renderClipRow(clip: ClipTarget): string {
  const label = STATUS_LABEL[clip.status];
  const detail =
    clip.status === "ready" && clip.plan
      ? `<span class="sil-row-cuts">${clip.plan.drop.length} ${
          clip.plan.drop.length === 1 ? "corte" : "cortes"
        }</span>` +
        `<span class="sil-row-time">${formatSeconds(clip.durationSeconds)} → ${formatSeconds(
          clip.plan.keptSeconds
        )}</span>`
      : `<span class="sil-row-skip">${escapeHtml(
          clip.status === "error" && clip.detail ? clip.detail : label
        )}</span>`;

  return (
    `<div class="sil-row-group${clip.status === "ready" ? " is-ready" : ""}">` +
    '<div class="sil-row">' +
    `<span class="sil-row-name" title="${escapeHtml(clip.name)}">${escapeHtml(
      clip.name
    )}</span>` +
    detail +
    "</div>" +
    "</div>"
  );
}

function renderDiagnostic(lines: readonly DiagnosticLine[]): string {
  return (
    '<div class="sil-diag-list">' +
    lines
      .map(
        (line) =>
          `<div class="sil-diag-row${line.ok ? "" : " is-bad"}">` +
          `<span class="sil-diag-mark">${line.ok ? "✓" : "✕"}</span>` +
          `<span class="sil-diag-label">${escapeHtml(line.label)}</span>` +
          `<span class="sil-diag-detail">${escapeHtml(line.detail)}</span>` +
          "</div>"
      )
      .join("") +
    "</div>"
  );
}

function summaryLine(scan: SilenceScan): string {
  if (scan.clips.length === 0) {
    return "Nenhum clipe selecionado.";
  }
  if (scan.readyCount === 0) {
    const missing = scan.clips.filter((clip) => clip.status === "no-transcript").length;
    if (missing > 0) {
      return "Nenhum clipe transcrito. Use o modo Onda ou transcreva em Texto.";
    }
    return "Nenhum silêncio detectado com estes parâmetros.";
  }
  return `${scan.cuts} ${scan.cuts === 1 ? "corte" : "cortes"} em ${scan.readyCount} ${
    scan.readyCount === 1 ? "clipe" : "clipes"
  }.`;
}

function doneMarkup(message: string): string {
  return (
    '<div class="org-done">' +
    '<p class="org-done-title">Silêncios cortados ✓</p>' +
    `<p class="org-done-desc">${escapeHtml(message)}</p>` +
    '<p class="org-done-desc" style="opacity: 0.7; font-size: 10.5px;">Dica: Selecione o espaço vazio na timeline e use <b>Shift+Delete</b> (Ripple Delete) para fechar os cortes.</p>' +
    "</div>"
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return "&quot;";
    }
  });
}

