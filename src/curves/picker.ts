/**
 * The curve picker: the preset gallery, the draw-your-own bar, and the
 * box that holds either the Tool's own preview or the live editor.
 *
 * It lives here rather than inside a Tool because two Tools now choose
 * curves, and the alternative — the same gallery written twice — is how
 * the Zoom preview ended up describing one animation while its keyframes
 * followed another.
 *
 * What the picker does NOT own is the preview drawing. A curve means
 * something different in each Tool: Flow shows progress from 0 to 1,
 * Zoom shows a scale ramp with the hold that follows it. So the Tool
 * hands in a renderer, and the picker gives it a slot — except while a
 * curve is being drawn, when the editor takes the slot instead.
 */
import { CONTROL, escapeHtml } from "../shell/controls";
import { mountCurveEditor, type CurveEditorHandle } from "./curveEditor";
import {
  CURVES,
  curvePath,
  customCurve,
  CUSTOM_CURVE,
  CUSTOM_DEFAULT,
  findCurve,
  formatPoints,
  type CurvePoints,
  type EasingCurve,
} from "./easing";

export interface CurvePickerOptions {
  /** Preset to start on. Ignored if a curve was already drawn this session. */
  curveId?: string;
  /** Draws the Tool's own preview into the slot. Never called while editing. */
  renderPreview(slot: HTMLElement, curve: EasingCurve): void;
  /** Fired on every preset change and on every drag of a control point. */
  onChange(curve: EasingCurve): void;
}

export interface CurvePicker {
  /** The chosen curve, resolved — a preset, or the one in the editor. */
  curve(): EasingCurve;
  /** Re-runs the Tool's preview renderer. Call when the Tool's own inputs move. */
  refresh(): void;
  /**
   * Back to the preset the Tool opened on.
   *
   * Deliberately does NOT touch the drawn curve: that one is shared across
   * Tools on purpose, and a Tool's own "clear" has no business throwing
   * away a curve someone drew for another one.
   */
  reset(): void;
  destroy(): void;
}

/**
 * The curve you drew, kept for the session and shared by every Tool.
 * Drawing a curve in Zoom and finding it waiting in Flow is the point:
 * it is one curve vocabulary, not two.
 */
let drawnPoints: CurvePoints = { ...CUSTOM_DEFAULT };

const PREVIEW_WIDTH = 200;
const PREVIEW_HEIGHT = 84;

export function mountCurvePicker(
  container: HTMLElement,
  options: CurvePickerOptions
): CurvePicker {
  const initialCurveId = options.curveId ?? CURVES[0]!.id;
  let curveId = initialCurveId;
  let editor: CurveEditorHandle | null = null;

  container.innerHTML = markup(curveId);

  const tag = container.querySelector<HTMLElement>("[data-curve-name]");
  const slot = container.querySelector<HTMLElement>("[data-curve-slot]");
  const meta = container.querySelector<HTMLElement>("[data-curve-meta]");

  function curve(): EasingCurve {
    return curveId === CUSTOM_CURVE ? customCurve(drawnPoints) : findCurve(curveId);
  }

  function writeTag(): void {
    if (tag) {
      tag.textContent =
        curveId === CUSTOM_CURVE ? formatPoints(drawnPoints) : curve().name;
    }
  }

  function render(): void {
    if (!slot) {
      return;
    }
    const drawing = curveId === CUSTOM_CURVE;
    slot.classList.toggle("is-editing", drawing);

    if (drawing) {
      if (!editor) {
        slot.innerHTML = "";
        editor = mountCurveEditor(slot, {
          points: drawnPoints,
          onChange: (next) => {
            drawnPoints = next;
            writeTag();
            options.onChange(curve());
          },
        });
        // The box only takes its real size once it is in the layout.
        editor.relayout();
      } else {
        editor.setPoints(drawnPoints);
      }
    } else {
      if (editor) {
        editor.destroy();
        editor = null;
        slot.innerHTML = "";
      }
      options.renderPreview(slot, curve());
    }

    writeTag();
    if (meta) {
      meta.innerHTML = drawing
        ? "<b>arraste os dois pontos</b>" +
          '<span class="preview-meta-gap"></span>' +
          `<div class="field-action" ${CONTROL} data-curve-reset>Redefinir</div>`
        : '<b>início</b><span class="preview-meta-gap"></span><b>fim</b>';
    }
  }

  function select(next: string): void {
    // Entering the editor from a preset that really is a cubic bezier
    // starts you on that shape instead of on a stranger.
    if (next === CUSTOM_CURVE && curveId !== CUSTOM_CURVE) {
      const seed = findCurve(curveId).points;
      if (seed) {
        drawnPoints = { ...seed };
      }
    }
    curveId = next;
    for (const cell of container.querySelectorAll<HTMLElement>("[data-curve]")) {
      cell.setAttribute("aria-pressed", String(cell.dataset.curve === next));
    }
    render();
    options.onChange(curve());
  }

  for (const cell of container.querySelectorAll<HTMLElement>("[data-curve]")) {
    cell.addEventListener("click", () => select(cell.dataset.curve!));
  }

  // Delegated: render() rewrites this row, so a listener bound to the
  // control itself would die on the first mode switch.
  meta?.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-curve-reset]")) {
      drawnPoints = { ...CUSTOM_DEFAULT };
      editor?.setPoints(drawnPoints);
      writeTag();
      options.onChange(curve());
    }
  });

  render();

  return {
    curve,
    refresh: render,
    reset(): void {
      select(initialCurveId);
    },
    destroy(): void {
      editor?.destroy();
      editor = null;
    },
  };
}

/** The read-only preview most Tools want: the curve, from 0 to 1. */
export function renderCurvePreview(slot: HTMLElement, curve: EasingCurve): void {
  slot.innerHTML =
    `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" ` +
    'preserveAspectRatio="none" aria-hidden="true">' +
    `<path class="preview-grid" d="M0,${PREVIEW_HEIGHT - 8} L${PREVIEW_WIDTH},${PREVIEW_HEIGHT - 8}"/>` +
    `<path class="preview-curve" d="${curvePath(curve, PREVIEW_WIDTH, PREVIEW_HEIGHT, 8)}"/>` +
    "</svg>";
}

function markup(curveId: string): string {
  // UXP does not honour flex-wrap, so the rows are built explicitly, and
  // each cell takes its width from how many share its row — otherwise a
  // trailing row of two would sit at two thirds and read as a mistake.
  const cell = (curve: EasingCurve, perRow: number): string =>
    `<div class="curve-cell" ${CONTROL} data-curve="${curve.id}" ` +
    `style="width:${(100 / perRow).toFixed(3)}%" ` +
    `aria-pressed="${curve.id === curveId}" title="${escapeHtml(curve.name)}">` +
    '<svg viewBox="0 0 60 34" preserveAspectRatio="none" aria-hidden="true">' +
    '<path class="curve-track" d="M4,30 L56,30"/>' +
    `<path class="curve-line" d="${curvePath(curve, 60, 34, 4)}"/>` +
    "</svg>" +
    `<span class="curve-cell-name">${escapeHtml(curve.name)}</span></div>`;

  const rows: string[] = [];
  for (let index = 0; index < CURVES.length; index += 3) {
    const row = CURVES.slice(index, index + 3);
    rows.push(
      `<div class="curve-row">${row.map((curve) => cell(curve, row.length)).join("")}</div>`
    );
  }

  return (
    '<div class="field-head">' +
      '<span class="t-label">Curva</span>' +
      '<span class="curve-tag" data-curve-name></span>' +
    "</div>" +
    `<div class="curve-grid">${rows.join("")}</div>` +
    // Not another preset: a different kind of thing, so it gets a
    // different shape — full width, worded as an action.
    `<div class="curve-draw" ${CONTROL} data-curve="${CUSTOM_CURVE}" ` +
    `aria-pressed="${curveId === CUSTOM_CURVE}">` +
      '<span class="curve-draw-mark"></span>' +
      '<span class="curve-draw-name">Desenhar a minha</span>' +
    "</div>" +
    '<div class="preview">' +
      '<div class="preview-canvas" data-curve-slot></div>' +
      '<div class="preview-meta" data-curve-meta></div>' +
    "</div>"
  );
}

