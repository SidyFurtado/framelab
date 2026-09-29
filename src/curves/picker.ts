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
import {
  clampNumber,
  createToolSettings,
  warmToolSettings,
} from "../bridge/settings";
import { mountCurveEditor, type CurveEditorHandle } from "./curveEditor";
import {
  clampPoints,
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
  renderPreview(slot: HTMLElement, curve: EasingCurve): CurvePreviewMotion;
  /** Fired on every preset change and on every drag of a control point. */
  onChange(curve: EasingCurve): void;
}

/** Movimento da prévia calculado sem depender das APIs SVG ausentes no UXP. */
export interface CurvePreviewMotion {
  readonly width: number;
  readonly height: number;
  readonly graphHeight: number;
  pointAt(progress: number): { x: number; y: number };
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
  /**
   * Põe o seletor num preset, como se ele tivesse sido clicado.
   *
   * É como uma ferramenta restaura a curva que o editor usou da última
   * vez: o `mount` é síncrono e os ajustes salvos chegam do disco um
   * instante depois. Um id desconhecido é ignorado — um arquivo de
   * ajustes de uma versão com outros presets não muda nada.
   */
  setCurveId(id: string): void;
  destroy(): void;
}

/**
 * The curve you drew, kept for the session and shared by every Tool.
 * Drawing a curve in Zoom and finding it waiting in Flow is the point:
 * it is one curve vocabulary, not two.
 */
let drawnPoints: CurvePoints = { ...CUSTOM_DEFAULT };

/**
 * A curva desenhada, em disco.
 *
 * Ela já era compartilhada entre as ferramentas de propósito — desenhar
 * no Zoom e encontrá-la esperando nas Curvas é o objetivo. Só que
 * morria junto com a sessão: quem passou cinco minutos ajustando os
 * dois pontos de controle recomeçava do zero no dia seguinte. Fica no
 * mesmo arquivo para todas as ferramentas, porque é uma curva só.
 */
const drawnSettings = createToolSettings<CurvePoints>(
  "curve-drawn.json",
  { ...CUSTOM_DEFAULT },
  (raw) => clampPoints({
    x1: clampNumber(raw.x1, -4, 4, CUSTOM_DEFAULT.x1),
    y1: clampNumber(raw.y1, -4, 4, CUSTOM_DEFAULT.y1),
    x2: clampNumber(raw.x2, -4, 4, CUSTOM_DEFAULT.x2),
    y2: clampNumber(raw.y2, -4, 4, CUSTOM_DEFAULT.y2),
  })
);

warmToolSettings(drawnSettings);

/** True assim que alguém mexe nos pontos nesta sessão. */
let drawnTouched = false;

/**
 * O disco só fala enquanto ninguém tiver desenhado nesta sessão: um
 * `read()` que chega atrasado não pode passar por cima da curva que o
 * editor acabou de ajustar.
 */
void drawnSettings.read().then((stored) => {
  if (!drawnTouched) {
    drawnPoints = stored;
  }
});

/** Troca a curva desenhada e manda gravar. */
function setDrawnPoints(next: CurvePoints): void {
  drawnPoints = next;
  drawnTouched = true;
  drawnSettings.save({ ...next });
}

const PREVIEW_WIDTH = 200;
const PREVIEW_GRAPH_HEIGHT = 76;
const PREVIEW_HEIGHT = 108;
const PREVIEW_PAD = 8;
const MOTION_START_X = 14;
const MOTION_END_MARGIN = 26;
const MOTION_Y_OFFSET = 14;

export function mountCurvePicker(
  container: HTMLElement,
  options: CurvePickerOptions
): CurvePicker {
  const initialCurveId = options.curveId ?? CURVES[0]!.id;
  let curveId = initialCurveId;
  let editor: CurveEditorHandle | null = null;
  let previewFrame: number | null = null;
  let previewMotion: CurvePreviewMotion | null = null;

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
    stopPreview();
    previewMotion = null;
    const drawing = curveId === CUSTOM_CURVE;
    slot.classList.toggle("is-editing", drawing);

    if (drawing) {
      if (!editor) {
        slot.innerHTML = "";
        editor = mountCurveEditor(slot, {
          points: drawnPoints,
          onChange: (next) => {
            setDrawnPoints(next);
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
      previewMotion = options.renderPreview(slot, curve());
    }

    writeTag();
    if (meta) {
      meta.innerHTML = drawing
        ? "<b>arraste os dois pontos</b>" +
          '<span class="preview-meta-gap"></span>' +
          `<div class="field-action" ${CONTROL} data-curve-reset>Redefinir</div>`
        : '<b>início</b><span class="preview-meta-gap"></span>' +
          `<div class="curve-preview-button" ${CONTROL} data-curve-play ` +
          'aria-label="Reproduzir a curva">' +
            '<span class="curve-preview-play" aria-hidden="true"></span>' +
            '<span data-curve-play-label>Reproduzir</span>' +
          '</div><span class="preview-meta-gap"></span><b>fim</b>';
    }
  }

  function stopPreview(): void {
    if (previewFrame !== null) {
      cancelAnimationFrame(previewFrame);
      previewFrame = null;
    }
    slot?.querySelector(".preview-runner")?.remove();
    slot?.querySelector(".preview-playhead")?.remove();
    slot?.querySelector(".preview-motion-trail")?.remove();
    slot?.querySelector(".preview-motion-halo")?.remove();
    slot?.querySelector(".preview-motion-runner")?.remove();
    const button = meta?.querySelector<HTMLElement>("[data-curve-play]");
    button?.classList.remove("is-playing");
    const label = button?.querySelector<HTMLElement>("[data-curve-play-label]");
    if (label) label.textContent = "Reproduzir";
  }

  function playPreview(): void {
    if (!slot) return;
    stopPreview();
    const svg = slot.querySelector<SVGSVGElement>("svg");
    const motion = previewMotion;
    if (!svg || !motion) return;
    const ns = "http://www.w3.org/2000/svg";
    const playhead = document.createElementNS(ns, "line");
    playhead.setAttribute("class", "preview-playhead");
    const runner = document.createElementNS(ns, "circle");
    runner.setAttribute("class", "preview-runner");
    runner.setAttribute("r", "4");
    const trail = document.createElementNS(ns, "line");
    trail.setAttribute("class", "preview-motion-trail");
    const halo = document.createElementNS(ns, "circle");
    halo.setAttribute("class", "preview-motion-halo");
    halo.setAttribute("r", "10");
    const mover = document.createElementNS(ns, "rect");
    mover.setAttribute("class", "preview-motion-runner");
    mover.setAttribute("width", "14");
    mover.setAttribute("height", "12");
    mover.setAttribute("rx", "2.5");
    const motionY = motion.height - MOTION_Y_OFFSET;
    const motionEndX = motion.width - MOTION_END_MARGIN;
    trail.setAttribute("x1", String(MOTION_START_X));
    trail.setAttribute("y1", String(motionY));
    trail.setAttribute("y2", String(motionY));
    svg.append(playhead, runner, trail, halo, mover);

    const button = meta?.querySelector<HTMLElement>("[data-curve-play]");
    button?.classList.add("is-playing");
    const label = button?.querySelector<HTMLElement>("[data-curve-play-label]");
    if (label) label.textContent = "Reproduzindo";

    let reduced = false;
    try {
      reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    } catch { /* hosts antigos não expõem matchMedia */ }
    const duration = reduced ? 0 : 2200;
    const started = performance.now();
    const activeCurve = curve();
    const tick = (now: number): void => {
      const progress = duration > 0 ? Math.min(1, (now - started) / duration) : 1;
      const point = motion.pointAt(progress);
      const eased = activeCurve.ease(progress);
      const motionX =
        MOTION_START_X + eased * (motionEndX - MOTION_START_X);
      runner.setAttribute("cx", point.x.toFixed(2));
      runner.setAttribute("cy", point.y.toFixed(2));
      playhead.setAttribute("x1", point.x.toFixed(2));
      playhead.setAttribute("x2", point.x.toFixed(2));
      playhead.setAttribute("y1", "4");
      playhead.setAttribute("y2", String(motion.graphHeight - 4));
      trail.setAttribute("x2", motionX.toFixed(2));
      halo.setAttribute("cx", motionX.toFixed(2));
      halo.setAttribute("cy", String(motionY));
      mover.setAttribute("x", (motionX - 7).toFixed(2));
      mover.setAttribute("y", String(motionY - 6));
      if (progress < 1) {
        previewFrame = requestAnimationFrame(tick);
      } else {
        previewFrame = null;
        button?.classList.remove("is-playing");
        if (label) label.textContent = "Reproduzir";
        playhead.remove();
        runner.remove();
      }
    };
    previewFrame = requestAnimationFrame(tick);
  }

  function select(next: string): void {
    // Entering the editor from a preset that really is a cubic bezier
    // starts you on that shape instead of on a stranger.
    if (next === CUSTOM_CURVE && curveId !== CUSTOM_CURVE) {
      const seed = findCurve(curveId).points;
      if (seed) {
        setDrawnPoints({ ...seed });
      }
    }
    curveId = next;
    for (const cell of container.querySelectorAll<HTMLElement>("[data-curve]")) {
      cell.setAttribute("aria-pressed", String(cell.dataset.curve === next));
    }
    render();
    options.onChange(curve());
    // Igual à prévia aprovada: escolher um preset já demonstra o seu
    // movimento. Repetir o clique no preset ativo também o reproduz.
    if (next !== CUSTOM_CURVE) {
      playPreview();
    }
  }

  for (const cell of container.querySelectorAll<HTMLElement>("[data-curve]")) {
    cell.addEventListener("click", () => select(cell.dataset.curve!));
  }

  // Delegated: render() rewrites this row, so a listener bound to the
  // control itself would die on the first mode switch.
  meta?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-curve-play]")) {
      playPreview();
    } else if (target.closest("[data-curve-reset]")) {
      setDrawnPoints({ ...CUSTOM_DEFAULT });
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
    setCurveId(id: string): void {
      const known = id === CUSTOM_CURVE || CURVES.some((entry) => entry.id === id);
      if (known && id !== curveId) {
        select(id);
      }
    },
    destroy(): void {
      stopPreview();
      editor?.destroy();
      editor = null;
    },
  };
}

/** The read-only preview most Tools want: the curve, from 0 to 1. */
export function renderCurvePreview(
  slot: HTMLElement,
  curve: EasingCurve
): CurvePreviewMotion {
  slot.innerHTML =
    `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" ` +
    'preserveAspectRatio="none" aria-hidden="true">' +
    `<path class="preview-grid" d="M0,${PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD} ` +
    `L${PREVIEW_WIDTH},${PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD}"/>` +
    `<path class="preview-curve" d="${curvePath(curve, PREVIEW_WIDTH, PREVIEW_GRAPH_HEIGHT, PREVIEW_PAD)}"/>` +
    `<path class="preview-motion-track" d="M${MOTION_START_X},${PREVIEW_HEIGHT - MOTION_Y_OFFSET} ` +
    `L${PREVIEW_WIDTH - MOTION_END_MARGIN},${PREVIEW_HEIGHT - MOTION_Y_OFFSET}"/>` +
    `<circle class="preview-motion-stop" cx="${MOTION_START_X}" ` +
    `cy="${PREVIEW_HEIGHT - MOTION_Y_OFFSET}" r="2"/>` +
    `<circle class="preview-motion-stop" cx="${PREVIEW_WIDTH - MOTION_END_MARGIN}" ` +
    `cy="${PREVIEW_HEIGHT - MOTION_Y_OFFSET}" r="2"/>` +
    "</svg>";

  return {
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT,
    graphHeight: PREVIEW_GRAPH_HEIGHT,
    pointAt(progress) {
      const t = Math.max(0, Math.min(1, progress));
      return {
        x: PREVIEW_PAD + t * (PREVIEW_WIDTH - PREVIEW_PAD * 2),
        y:
          PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD -
          curve.ease(t) * (PREVIEW_GRAPH_HEIGHT - PREVIEW_PAD * 2),
      };
    },
  };
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
