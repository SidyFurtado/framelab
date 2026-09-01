import type { Tool, ToolContext } from "../../shell/tool";
import { CONTROL } from "../../shell/controls";
import {
  applyCurve,
  clearToLinear,
  readAnimatedParams,
  type AnimatedParam,
  type FlowTarget,
  type ScanReport,
} from "./applyFlow";
import {
  DENSITY_MAX,
  DENSITY_MIN,
  DENSITY_PRESETS,
  DENSITY_DEFAULT,
} from "../../curves/easing";
import {
  mountCurvePicker,
  renderCurvePreview,
  type CurvePicker,
} from "../../curves/picker";

/** The live picker, so unmount can release the editor it may hold. */
let livePicker: CurvePicker | null = null;

/**
 * Speed curves. Premiere gives no way to read which keyframes are
 * selected in Effect Controls — the Keyframe object carries no selection
 * state and no event reports one — so the panel draws the parameter's
 * own keyframes and you pick the segment here.
 */
export const flowTool: Tool = {
  id: "flow",
  name: "Curvas de velocidade",
  summary: "Assa easing entre keyframes existentes",
  hint:
    "Selecione o clipe animado na timeline. A lista relê sozinha quando você volta ao painel — " +
    "escolha um trecho, a curva e a densidade. Linear apaga só os keyframes intermediários " +
    "daquele trecho, então dá para reajustar o tempo e aplicar de novo.",
  category: "edicao",
  glyph: "curve",
  available: true,

  mount(container: HTMLElement, context: ToolContext): void {
    let params: AnimatedParam[] = [];
    let report: ScanReport | null = null;
    let density = DENSITY_DEFAULT;
    /** Guards against a rescan landing on top of another one. */
    let scanning = false;
    /** paramId -> segment index, or "all". */
    const picked = new Map<string, number | "all">();

    container.innerHTML = shellMarkup(density);

    const list = container.querySelector<HTMLElement>("[data-param-list]")!;
    const densityOut = container.querySelector<HTMLElement>("[data-out-density]");
    const densityInput = container.querySelector<HTMLInputElement>("[data-density]");
    function targets(): FlowTarget[] {
      const out: FlowTarget[] = [];
      for (const param of params) {
        const segment = picked.get(param.id);
        if (segment !== undefined) {
          out.push({ param, segment });
        }
      }
      return out;
    }

    const curveZone = container.querySelector<HTMLElement>("[data-curve-zone]")!;

    livePicker?.destroy();
    livePicker = mountCurvePicker(curveZone, {
      curveId: "ease-out",
      renderPreview: renderCurvePreview,
      onChange: () => {},
    });

    function renderList(keepStatus = false): void {
      if (params.length === 0) {
        list.innerHTML =
          '<p class="work-note">Nenhum parâmetro com keyframes no clipe selecionado. ' +
          "Selecione na timeline o clipe que tem a animação e toque em Reler.</p>" +
          scanMarkup(report);
        context.setApplyEnabled(false);
        if (!keepStatus) {
          context.setStatus(
            report && report.clips === 0
              ? "Nenhum clipe de vídeo selecionado na timeline."
              : "O clipe selecionado não tem parâmetros com keyframes.",
            "error"
          );
        }
        return;
      }

      list.innerHTML = params
        .map((param) => paramMarkup(param, picked.get(param.id)))
        .join("");

      const chosen = targets().length;
      context.setApplyEnabled(chosen > 0);
      if (!keepStatus) {
        context.setStatus(
          chosen > 0
            ? `${chosen} de ${params.length} ${
                params.length === 1 ? "parâmetro" : "parâmetros"
              } selecionado(s).`
            : "Escolha ao menos um parâmetro."
        );
      }
    }

    /**
     * Re-reads the selection. Premiere reports no keyframe events, so
     * this runs on mount, on the Shell's refresh (which the panel also
     * fires when it regains focus) and on the Reler control — otherwise
     * the list would still describe whichever clip was selected when the
     * Tool was opened, and the action button would sit dead.
     */
    async function reload(keepStatus = false): Promise<void> {
      if (scanning) {
        return;
      }
      scanning = true;

      const knownIds = new Set(params.map((param) => param.id));
      const previousPicks = new Map(picked);
      const previousShape = new Map(
        params.map((param) => [param.id, param.anchorTicks.join("|")] as const)
      );

      list.innerHTML = '<p class="work-note">Lendo keyframes…</p>';
      try {
        const scan = await readAnimatedParams();
        params = scan.params;
        report = scan.report;
        picked.clear();

        for (const param of params) {
          if (!knownIds.has(param.id)) {
            // Everything newly animated starts selected — clicking a row
            // or a segment narrows it down. Nothing is applied until you
            // press the button.
            picked.set(param.id, "all");
            continue;
          }
          const before = previousPicks.get(param.id);
          if (before === undefined) {
            // Deselected on purpose; a rescan does not undo that.
            continue;
          }
          const moved = previousShape.get(param.id) !== param.anchorTicks.join("|");
          picked.set(param.id, moved ? "all" : before);
        }

        renderList(keepStatus);
      } finally {
        scanning = false;
      }
    }

    list.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const key = target.closest<HTMLElement>("[data-segment]");
      if (key) {
        const paramId = key.dataset.param!;
        const segment = Number(key.dataset.segment);
        picked.set(paramId, picked.get(paramId) === segment ? "all" : segment);
        renderList();
        return;
      }

      const row = target.closest<HTMLElement>("[data-param]");
      if (row?.dataset.param) {
        const paramId = row.dataset.param;
        if (picked.has(paramId)) {
          picked.delete(paramId);
        } else {
          picked.set(paramId, "all");
        }
        renderList();
      }
    });

    for (const button of container.querySelectorAll<HTMLElement>("[data-density-preset]")) {
      button.addEventListener("click", () => {
        setDensity(Number(button.dataset.densityPreset));
      });
    }

    container
      .querySelector<HTMLElement>("[data-rescan]")
      ?.addEventListener("click", () => void reload());

    densityInput?.addEventListener("input", () => {
      setDensity(Number.parseInt(densityInput.value, 10));
    });

    function setDensity(value: number): void {
      if (!Number.isFinite(value)) {
        return;
      }
      density = Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, value));
      if (densityInput) {
        densityInput.value = String(density);
      }
      if (densityOut) {
        densityOut.textContent = `${density} kf`;
      }
      for (const button of container.querySelectorAll<HTMLElement>("[data-density-preset]")) {
        button.classList.toggle(
          "is-active",
          Number(button.dataset.densityPreset) === density
        );
      }
    }

    setDensity(density);
    void reload();

    context.setApplyLabel("Aplicar curva");
    context.setApplyEnabled(false);
    context.setResetLabel("Linear");
    context.setResetHandler(() => {
      void (async () => {
        const chosen = targets();
        if (chosen.length === 0) {
          context.setStatus("Escolha um parâmetro primeiro.", "error");
          return;
        }
        context.setStatus("Limpando…");
        const result = await clearToLinear(chosen);
        // The rescan runs first and is told to keep quiet, so the result
        // is the last thing written to the status bar instead of being
        // overwritten by the scan's own count a tick later.
        await reload(true);
        context.setStatus(result.message, result.ok ? "done" : "error");
      })();
    });
    context.setApplyHandler(async () => {
      const picker = livePicker;
      if (!picker) {
        context.setStatus("O seletor de curva não está montado.", "error");
        return;
      }
      const chosen = targets();
      if (chosen.length === 0) {
        context.setStatus("Escolha um parâmetro primeiro.", "error");
        return;
      }
      context.setStatus("Aplicando…");
      const result = await applyCurve(chosen, picker.curve(), density);
      await reload(true);
      context.setStatus(result.message, result.ok ? "done" : "error");
    });
    context.setRefreshHandler(() => void reload());
  },

  unmount(): void {
    // The editor listens on window for resizes; the Shell wiping the
    // body would leave that listener behind on a detached node.
    livePicker?.destroy();
    livePicker = null;
  },
};

/** What the scan saw. Shown only when it found nothing, so a failure
 *  can be read in the panel instead of the devtools console. */
function scanMarkup(report: ScanReport | null): string {
  if (!report) {
    return "";
  }
  const rows = report.lines
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  return (
    '<div class="scan">' +
    `<span class="t-label">Varredura · ${report.clips} clipe(s)</span>` +
    (rows ? `<ul class="scan-list">${rows}</ul>` : "") +
    "</div>"
  );
}

function paramMarkup(param: AnimatedParam, segment: number | "all" | undefined): string {
  const chosen = segment !== undefined;
  // Segments are cut between the editor's anchors. Counting the baked
  // keyframes as anchors would turn one trecho into seventeen the
  // moment a curve is applied.
  const count = param.anchorTicks.length;
  const baked = param.keyTicks.length - count;

  // The keyframe strip: a dot per anchor, a clickable span per segment.
  const cells: string[] = [];
  for (let index = 0; index < count - 1; index++) {
    const on = chosen && (segment === "all" || segment === index);
    cells.push(
      `<span class="kf-span${on ? " is-on" : ""}" ${CONTROL} ` +
        `data-param="${param.id}" data-segment="${index}" ` +
        `title="Trecho ${index + 1}"></span>`
    );
  }

  return (
    `<div class="kf-row${chosen ? " is-chosen" : ""}" ${CONTROL} data-param="${param.id}">` +
    '<div class="kf-head">' +
      `<span class="kf-name">${escapeHtml(param.label)}</span>` +
      `<span class="kf-count">${count} kf${baked > 0 ? ` +${baked}` : ""}</span>` +
    "</div>" +
    `<div class="kf-strip">${cells.join("")}</div>` +
    "</div>"
  );
}

function shellMarkup(density: number): string {
  const presets = DENSITY_PRESETS.map(
    (preset) =>
      `<div class="preset-pill${preset === density ? " is-active" : ""}" ${CONTROL} ` +
      `data-density-preset="${preset}">${preset}</div>`
  ).join("");

  return (
    '<div class="zones">' +
      '<div class="zone">' +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Parâmetros animados</span>' +
            `<div class="field-action" ${CONTROL} data-rescan ` +
            'title="Reler os keyframes do clipe selecionado">Reler</div>' +
          "</div>" +
          '<div class="kf-list" data-param-list></div>' +
        "</div>" +
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Densidade da assadura</span>' +
            `<span class="field-val" data-out-density>${density} kf</span>` +
          "</div>" +
          `<div class="preset-rail">${presets}</div>` +
          `<input type="range" min="${DENSITY_MIN}" max="${DENSITY_MAX}" step="1" ` +
          `value="${density}" data-density aria-label="Densidade">` +
          '<p class="field-note">Cada keyframe assado é um keyframe que você não retima ' +
          "mais. Use Linear para desfazer e reajustar o tempo.</p>" +
        "</div>" +
      "</div>" +
      // The picker fills this zone: gallery, draw bar and preview box.
      '<div class="zone" data-curve-zone></div>' +
    "</div>"
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
