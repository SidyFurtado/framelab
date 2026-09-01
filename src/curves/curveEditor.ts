/**
 * The curve editor: two control points you drag, and the bake follows.
 *
 * Two decisions worth keeping:
 *
 * The viewBox is re-measured from the element's own pixel box instead of
 * being a fixed grid stretched with `preserveAspectRatio="none"`. One
 * user unit is one pixel, so nothing is distorted and the drag inverse
 * is exact rather than approximately right.
 *
 * The grips are real divs laid over the canvas, not SVG shapes: divs
 * take focus, keyboard and `:focus-visible` for free, and a 14px hit
 * area is easier to hand a div than an SVG node.
 */
import {
  bezierPath,
  clampPoints,
  curveBox,
  project,
  unproject,
  type CurveBox,
  type CurvePoints,
} from "./easing";
import { CONTROL } from "../shell/controls";

export interface CurveEditorHandle {
  /** Redraws from the outside — after a resize, or a seeded curve. */
  setPoints(points: CurvePoints): void;
  /** Re-measures the box. Call when the editor is shown or resized. */
  relayout(): void;
  destroy(): void;
}

export interface CurveEditorOptions {
  points: CurvePoints;
  onChange(points: CurvePoints): void;
}

/** Fallback geometry, used only until the element has been laid out. */
const NOMINAL_WIDTH = 200;
const NOMINAL_HEIGHT = 150;
const PAD_X = 14;
const PAD_Y = 13;

/** Arrow-key steps, in curve units. */
const NUDGE = 0.01;
const NUDGE_COARSE = 0.1;

export function mountCurveEditor(
  container: HTMLElement,
  options: CurveEditorOptions
): CurveEditorHandle {
  let points = clampPoints(options.points);
  let box: CurveBox = curveBox(NOMINAL_WIDTH, NOMINAL_HEIGHT, PAD_X, PAD_Y);
  let dragging: 1 | 2 | null = null;

  container.innerHTML = markup();

  const svg = container.querySelector<SVGElement>(".ce-canvas")!;
  const curveLine = container.querySelector<SVGPathElement>(".ce-curve");
  const grips = new Map<1 | 2, HTMLElement>();
  const tethers = new Map<1 | 2, SVGPathElement>();
  for (const index of [1, 2] as const) {
    const grip = container.querySelector<HTMLElement>(
      `[data-handle="${index}"]`
    );
    const tether = container.querySelector<SVGPathElement>(
      `[data-tether="${index}"]`
    );
    if (grip) grips.set(index, grip);
    if (tether) tethers.set(index, tether);
  }

  function pointOf(index: 1 | 2): { x: number; y: number } {
    return index === 1
      ? { x: points.x1, y: points.y1 }
      : { x: points.x2, y: points.y2 };
  }

  function withPoint(index: 1 | 2, x: number, y: number): CurvePoints {
    return clampPoints(
      index === 1
        ? { ...points, x1: x, y1: y }
        : { ...points, x2: x, y2: y }
    );
  }

  /** Reads the element's real size, so user units stay pixels. */
  function measure(): void {
    let width = NOMINAL_WIDTH;
    let height = NOMINAL_HEIGHT;
    try {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) {
        width = rect.width;
        height = rect.height;
      }
    } catch {
      // Not laid out yet; the nominal box draws something sane.
    }
    box = curveBox(width, height, PAD_X, PAD_Y);
    svg.setAttribute("viewBox", `0 0 ${width.toFixed(1)} ${height.toFixed(1)}`);
  }

  function render(): void {
    const start = project(box, 0, 0);
    const end = project(box, 1, 1);
    const left = box.padX.toFixed(1);
    const right = (box.width - box.padX).toFixed(1);
    const floor = start.y.toFixed(1);
    const ceiling = end.y.toFixed(1);

    setAttr(container.querySelector(".ce-floor"), "d", `M${left},${floor} L${right},${floor}`);
    setAttr(container.querySelector(".ce-ceiling"), "d", `M${left},${ceiling} L${right},${ceiling}`);
    setAttr(
      container.querySelector(".ce-linear"),
      "d",
      `M${start.x.toFixed(1)},${start.y.toFixed(1)} L${end.x.toFixed(1)},${end.y.toFixed(1)}`
    );
    setAttr(curveLine, "d", bezierPath(points, box));

    for (const index of [1, 2] as const) {
      const value = pointOf(index);
      const at = project(box, value.x, value.y);
      const anchor = index === 1 ? start : end;
      setAttr(
        tethers.get(index),
        "d",
        `M${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} L${at.x.toFixed(1)},${at.y.toFixed(1)}`
      );
      const grip = grips.get(index);
      if (grip) {
        grip.style.left = `${at.x.toFixed(1)}px`;
        grip.style.top = `${at.y.toFixed(1)}px`;
      }
    }
  }

  function commit(next: CurvePoints): void {
    points = next;
    render();
    options.onChange(points);
  }

  /** Curve-space position of a mouse event inside the canvas. */
  function locate(event: MouseEvent): { x: number; y: number } | null {
    let rect: DOMRect;
    try {
      rect = svg.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!(rect.width > 1) || !(rect.height > 1)) {
      return null;
    }
    return unproject(box, event.clientX - rect.left, event.clientY - rect.top);
  }

  function onMouseDown(event: MouseEvent): void {
    measure();
    render();

    const target = event.target;
    const grip =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-handle]")
        : null;

    const at = locate(event);
    let index: 1 | 2 | null = grip
      ? (Number(grip.dataset.handle) as 1 | 2)
      : null;

    if (!index && at) {
      // No grip under the cursor: the nearer handle comes to the click.
      // On a box this small, hunting a 14px square is worse than this.
      //
      // Nearness is measured in pixels, not in curve units: one unit of
      // y covers 2.2 times the range one unit of x does, so comparing
      // raw curve distances would quietly favour the wrong handle.
      const cursor = project(box, at.x, at.y);
      const first = project(box, points.x1, points.y1);
      const second = project(box, points.x2, points.y2);
      index = distance(cursor, first) <= distance(cursor, second) ? 1 : 2;
      commit(withPoint(index, at.x, at.y));
    }
    if (!index) {
      return;
    }

    dragging = index;
    grips.get(index)?.focus();
    event.preventDefault();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(event: MouseEvent): void {
    if (!dragging) {
      return;
    }
    // A mouseup that lands outside the panel never reaches us, and the
    // drag would then follow the cursor with no button held.
    if (event.buttons === 0) {
      onMouseUp();
      return;
    }
    const at = locate(event);
    if (at) {
      commit(withPoint(dragging, at.x, at.y));
    }
  }

  function onMouseUp(): void {
    dragging = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target;
    const grip =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-handle]")
        : null;
    if (!grip) {
      return;
    }
    const index = Number(grip.dataset.handle) as 1 | 2;
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const value = pointOf(index);

    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case "ArrowLeft": dx = -step; break;
      case "ArrowRight": dx = step; break;
      case "ArrowUp": dy = step; break;
      case "ArrowDown": dy = -step; break;
      default: return;
    }
    event.preventDefault();
    // The Shell's own key handler would otherwise read this as a click.
    event.stopPropagation();
    commit(withPoint(index, value.x + dx, value.y + dy));
  }

  function onResize(): void {
    measure();
    render();
  }

  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  measure();
  render();

  return {
    setPoints(next: CurvePoints): void {
      points = clampPoints(next);
      measure();
      render();
    },
    relayout(): void {
      measure();
      render();
    },
    destroy(): void {
      onMouseUp();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      container.innerHTML = "";
    },
  };
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function setAttr(node: Element | null | undefined, name: string, value: string): void {
  node?.setAttribute(name, value);
}

/**
 * Written as markup and looked up afterwards, the same way every other
 * SVG in this panel is built. (`createElementNS` does work here — the
 * Zoom preview uses it — this is just the house style.)
 */
function markup(): string {
  return (
    `<svg class="ce-canvas" viewBox="0 0 ${NOMINAL_WIDTH} ${NOMINAL_HEIGHT}" ` +
    'preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="ce-floor" d=""/>' +
      '<path class="ce-ceiling" d=""/>' +
      '<path class="ce-linear" d=""/>' +
      '<path class="ce-tether" data-tether="1" d=""/>' +
      '<path class="ce-tether" data-tether="2" d=""/>' +
      '<path class="ce-curve" d=""/>' +
    "</svg>" +
    `<div class="ce-grip" ${CONTROL} data-handle="1" ` +
    'aria-label="Ponto de controle da saída"></div>' +
    `<div class="ce-grip" ${CONTROL} data-handle="2" ` +
    'aria-label="Ponto de controle da chegada"></div>'
  );
}
