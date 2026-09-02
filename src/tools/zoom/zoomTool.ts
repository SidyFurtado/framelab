import type { Tool, ToolContext } from "../../shell/tool";
import {
  applyZoom,
  PUNCH_DURATION_DEFAULT,
  PUNCH_DURATION_MAX,
  PUNCH_DURATION_MIN,
  PUNCH_DURATION_PRESETS,
  SCALE_DEFAULTS,
  SCALE_MAX,
  SCALE_MIN,
  type ZoomDirection,
  type ZoomStyle,
} from "./applyZoom";
import { curveGeometry, type CurveShape } from "./curve";
import { CONTROL } from "../../shell/controls";
import type { EasingCurve } from "../../curves/easing";
import { mountCurvePicker, type CurvePicker } from "../../curves/picker";
import { mountSlider, type SliderHandle } from "../../shell/slider";

/** The live picker, so unmount can release the editor it may hold. */
let livePicker: CurvePicker | null = null;
/** Os deslizadores, para soltar os ouvintes que eles põem em `document`. */
let scaleSlider: SliderHandle | null = null;
let durationSlider: SliderHandle | null = null;

const PREVIEW_WIDTH = 220;
const PREVIEW_HEIGHT = 84;
const PREVIEW_PAD = 8;

function shapeFor(style: ZoomStyle, punchDuration: number): CurveShape {
  if (style === "full") {
    return { span: 1 };
  }
  return { span: Math.max(0.15, Math.min(0.92, punchDuration / PUNCH_DURATION_MAX)) };
}

/** Sampled evenly in time, which is what the bake does. */
const KEY_OFFSETS = Array.from({ length: 9 }, (_, index) => index / 8);

/**
 * Zoom In / Out — the platform's foundation Tool.
 * Owns its body; the Shell owns the header, callout, strip and actions.
 */
export const zoomTool: Tool = {
  id: "zoom",
  name: "Zoom In / Out",
  summary: "Punch-in animado no clipe selecionado",
  hint:
    "Selecione um ou mais clipes na timeline e escolha a direção. " +
    "Os keyframes de escala entram num efeito Transform novo — o Motion original não é tocado.",
  category: "edicao",
  glyph: "zoom",
  available: true,

  mount(container: HTMLElement, context: ToolContext): void {
    let direction: ZoomDirection = "in";
    let style: ZoomStyle = "punch";
    let scalePercent = SCALE_DEFAULTS.punch;
    let punchDuration = PUNCH_DURATION_DEFAULT;
    /** True once the editor has moved the scale slider themselves. */
    let scaleTouched = false;

    container.innerHTML = markup(direction, style, scalePercent, punchDuration);

    const directionSeg = container.querySelector<HTMLElement>("[data-direction-seg]");
    const styleSeg = container.querySelector<HTMLElement>("[data-style-seg]");
    const presetButtons = Array.from(
      container.querySelectorAll<HTMLElement>("[data-preset-dur]")
    );
    const scaleRail = container.querySelector<HTMLElement>("[data-scale]");
    const scaleOut = container.querySelector<HTMLElement>("[data-out-scale]");
    const durationField = container.querySelector<HTMLElement>("[data-duration-field]");
    const durationRail = container.querySelector<HTMLElement>("[data-duration]");
    const durationOut = container.querySelector<HTMLElement>("[data-out-duration]");
    const metaRange = container.querySelector<HTMLElement>("[data-meta-range]");
    const metaSpan = container.querySelector<HTMLElement>("[data-meta-span]");
    const metaHold = container.querySelector<HTMLElement>("[data-meta-hold]");
    const curveZone = container.querySelector<HTMLElement>("[data-curve-zone]")!;

    livePicker?.destroy();
    livePicker = mountCurvePicker(curveZone, {
      curveId: "punch",
      renderPreview: (slot, curve) => renderRamp(slot, curve),
      onChange: () => draw(),
    });

    /** The scale ramp, drawn from the curve the picker is holding. */
    function renderRamp(slot: HTMLElement, curve: EasingCurve): void {
      const geometry = curveGeometry(
        shapeFor(style, punchDuration),
        scalePercent,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
        PREVIEW_PAD,
        curve.ease
      );

      // The dots come off the same curve the line was sampled from, so
      // they sit on it by construction rather than by coincidence.
      const dots = KEY_OFFSETS.map((t) => {
        const at = geometry.pointAt(t);
        return (
          `<circle class="preview-key" cx="${at.x.toFixed(1)}" ` +
          `cy="${at.y.toFixed(1)}" r="2.6"/>`
        );
      }).join("");

      slot.innerHTML =
        `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" ` +
        'preserveAspectRatio="none" aria-hidden="true">' +
          `<path class="preview-grid" d="M0,${PREVIEW_HEIGHT - PREVIEW_PAD} ` +
          `L${PREVIEW_WIDTH},${PREVIEW_HEIGHT - PREVIEW_PAD}"/>` +
          `<path class="preview-area" d="${geometry.area}"/>` +
          `<path class="preview-hold" d="${geometry.hold}"/>` +
          `<path class="preview-curve" d="${geometry.rise}"/>` +
          dots +
        "</svg>";
    }

    function draw(): void {
      // The picker re-runs renderRamp, which reads the current style,
      // scale and duration off the closure.
      livePicker?.refresh();

      const [from, to] =
        direction === "in"
          ? ["100%", `${scalePercent}%`]
          : [`${scalePercent}%`, "100%"];
      if (metaRange) {
        metaRange.textContent = `${from} → ${to}`;
      }
      if (metaSpan) {
        metaSpan.textContent =
          style === "full" ? "clipe inteiro" : `${punchDuration.toFixed(1)}s`;
      }
      // Full Clip animates edge to edge; there is nothing held after it.
      if (metaHold) {
        metaHold.hidden = style === "full";
      }
      if (durationField) {
        durationField.hidden = style === "full";
      }
    }

    function setStyle(next: ZoomStyle): void {
      style = next;
      for (const button of styleSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        button.setAttribute(
          "aria-pressed",
          String(button.getAttribute("data-style") === next)
        );
      }
      // Each behaviour has its own sensible scale, but only until the
      // editor picks one. Re-seeding unconditionally threw away a value
      // that had just been dialled in, every time the segment was touched.
      if (scaleTouched) {
        draw();
      } else {
        setScale(SCALE_DEFAULTS[next]);
      }
    }

    function setScale(value: number): void {
      scalePercent = Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, value)));
      scaleSlider?.set(scalePercent);
      if (scaleOut && !scaleSlider) {
        scaleOut.textContent = `${scalePercent}%`;
      }
      draw();
    }

    function setDuration(value: number): void {
      punchDuration = Math.max(PUNCH_DURATION_MIN, Math.min(PUNCH_DURATION_MAX, value));
      durationSlider?.set(punchDuration);
      if (durationOut && !durationSlider) {
        durationOut.textContent = `${punchDuration.toFixed(1)}s`;
      }
      for (const btn of presetButtons) {
        const pVal = Number.parseFloat(btn.getAttribute("data-preset-dur") ?? "");
        btn.classList.toggle("is-active", Math.abs(pVal - punchDuration) < 0.05);
      }
      draw();
    }

    function setDirection(next: ZoomDirection): void {
      direction = next;
      for (const button of directionSeg?.querySelectorAll<HTMLElement>(".seg-item") ?? []) {
        button.setAttribute(
          "aria-pressed",
          String(button.getAttribute("data-value") === next)
        );
      }
      draw();
    }

    directionSeg?.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>(".seg-item");
      if (button && directionSeg.contains(button)) {
        setDirection((button.getAttribute("data-value") as ZoomDirection) ?? "in");
      }
    });

    styleSeg?.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>(".seg-item");
      if (button && styleSeg.contains(button)) {
        setStyle((button.getAttribute("data-style") as ZoomStyle) ?? "punch");
      }
    });

    for (const btn of presetButtons) {
      btn.addEventListener("click", () => {
        const val = Number.parseFloat(btn.getAttribute("data-preset-dur") ?? "");
        if (Number.isFinite(val)) {
          setDuration(val);
        }
      });
    }

    if (scaleRail) {
      scaleSlider = mountSlider(scaleRail, {
        min: SCALE_MIN,
        max: SCALE_MAX,
        step: 1,
        value: scalePercent,
        label: "Intensidade",
        format: (value) => `${value}%`,
        output: scaleOut,
        onInput: (value) => {
          scaleTouched = true;
          setScale(value);
        },
      });
    }
    if (durationRail) {
      durationSlider = mountSlider(durationRail, {
        min: PUNCH_DURATION_MIN,
        max: PUNCH_DURATION_MAX,
        step: 0.1,
        value: punchDuration,
        label: "Duração do punch",
        format: (value) => `${value.toFixed(1)}s`,
        output: durationOut,
        onInput: (value) => setDuration(value),
      });
    }

    draw();

    context.setApplyLabel("APLICAR ZOOM");
    context.setApplyEnabled(true);
    context.setResetHandler(() => {
      scaleTouched = false;
      setDirection("in");
      setStyle("punch");
      setDuration(PUNCH_DURATION_DEFAULT);
      // The curve is an adjustment like any other here, and leaving it
      // behind made "Limpar" restore everything except what you last changed.
      livePicker?.reset();
      context.setStatus("Ajustes restaurados.");
    });
    context.setApplyHandler(async () => {
      const picker = livePicker;
      if (!picker) {
        context.setStatus("O seletor de curva não está montado.", "error");
        return;
      }
      context.setStatus("Aplicando…");
      const result = await applyZoom({
        direction,
        style,
        scalePercent,
        punchDuration,
        ease: picker.curve().ease,
      });
      context.setStatus(result.message, result.ok ? "done" : "error");
      context.refreshSelection();
    });
  },

  unmount(): void {
    // The editor listens on window for resizes; the Shell wiping the
    // body would leave that listener behind on a detached node.
    scaleSlider?.destroy();
    scaleSlider = null;
    durationSlider?.destroy();
    durationSlider = null;
    livePicker?.destroy();
    livePicker = null;
  },
};

function markup(
  direction: ZoomDirection,
  style: ZoomStyle,
  scalePercent: number,
  punchDuration: number
): string {
  const presetButtonsHtml = PUNCH_DURATION_PRESETS.map(
    (preset) =>
      `<div class="preset-pill${
        Math.abs(preset - punchDuration) < 0.05 ? " is-active" : ""
      }" ${CONTROL} data-preset-dur="${preset}">${preset.toFixed(1)}s</div>`
  ).join("");

  return (
    '<div class="zones">' +
      '<div class="zone">' +
        // Direction
        '<div class="field">' +
          '<span class="t-label">Direção</span>' +
          '<div class="seg" data-direction-seg>' +
            `<div class="seg-item" ${CONTROL} data-value="in" aria-pressed="${direction === "in"}">Zoom In</div>` +
            `<div class="seg-item" ${CONTROL} data-value="out" aria-pressed="${direction === "out"}">Zoom Out</div>` +
          "</div>" +
        "</div>" +

        // Comportamento / Style
        '<div class="field">' +
          '<span class="t-label">Comportamento</span>' +
          '<div class="seg" data-style-seg>' +
            `<div class="seg-item" ${CONTROL} data-style="punch" aria-pressed="${style === "punch"}">Punch Smooth</div>` +
            `<div class="seg-item" ${CONTROL} data-style="full" aria-pressed="${style === "full"}">Clipe inteiro</div>` +
          "</div>" +
        "</div>" +

        // Duration (Punch only)
        `<div class="field" data-duration-field${style === "full" ? " hidden" : ""}>` +
          '<div class="field-head">' +
            '<span class="t-label">Duração do Punch</span>' +
            `<span class="field-val" data-out-duration>${punchDuration.toFixed(1)}s</span>` +
          "</div>" +
          `<div class="preset-rail">${presetButtonsHtml}</div>` +
          '<div class="slider-row"><div data-duration></div></div>' +
        "</div>" +

        // Scale target
        '<div class="field">' +
          '<div class="field-head">' +
            '<span class="t-label">Intensidade (Escala Alvo)</span>' +
            `<span class="field-val" data-out-scale>${scalePercent}%</span>` +
          "</div>" +
          '<div class="slider-row"><div data-scale></div></div>' +
          '<p class="field-note">100% mantém o enquadramento; valores acima aumentam o corte com Transform.</p>' +
        "</div>" +
        '<div class="preview-meta"><b data-meta-range></b>' +
        '<span class="preview-meta-gap"></span><b data-meta-span></b>' +
        '<span data-meta-hold>segura até o fim</span></div>' +
      "</div>" +

      // The picker fills this zone: gallery, draw bar, and the ramp
      // preview in its slot.
      '<div class="zone" data-curve-zone></div>' +
    "</div>"
  );
}

