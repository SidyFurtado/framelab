/**
 * Speed curves.
 *
 * Premiere's UXP API exposes only a keyframe's interpolation *mode* —
 * `createSetInterpolationAtKeyframeAction` — never its bezier handles.
 * So a curve cannot be set; it has to be baked into intermediate
 * keyframes, the same trick the Zoom tool uses. Everything here is the
 * maths for that bake.
 */

export interface EasingCurve {
  readonly id: string;
  readonly name: string;
  /** Progress 0..1 in, eased progress 0..1 out. */
  readonly ease: (t: number) => number;
  /**
   * The two control points, when the curve really is a cubic bezier.
   * Expo and Back are closed-form functions with no handles, so they
   * carry none — the editor falls back to its own default for those.
   */
  readonly points?: CurvePoints;
}

/** Two control points, in CSS cubic-bezier order. */
export interface CurvePoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const cubicBezier = (p1x: number, p1y: number, p2x: number, p2y: number) => {
  // Solve x(t) = target by bisection, then read y. Cheap and stable at
  // the handful of samples a bake needs.
  const curve = (a: number, b: number, t: number): number => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0;
    let high = 1;
    let mid = x;
    for (let step = 0; step < 24; step++) {
      mid = (low + high) / 2;
      if (curve(p1x, p2x, mid) < x) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return curve(p1y, p2y, mid);
  };
};

/**
 * Decay of the Punch curve.
 *
 * Not the 10 that CSS's ease-out-expo uses: at that rate the move is over
 * by 40% of its duration, so a punch of 1.6s animated for 0.64s and sat
 * still. At 3 the move spans the duration, with 57% of it done in the
 * first third — and it is far enough from every other preset here
 * (23.8% from the closest) to earn its own entry.
 */
const PUNCH_DECAY = 3;
const PUNCH_NORMALISER = 1 - Math.pow(2, -PUNCH_DECAY);

export const CURVES: readonly EasingCurve[] = [
  {
    id: "punch",
    name: "Punch",
    ease: (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return (1 - Math.pow(2, -PUNCH_DECAY * t)) / PUNCH_NORMALISER;
    },
  },
  {
    id: "linear",
    name: "Linear",
    ease: (t) => Math.max(0, Math.min(1, t)),
    points: { x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 },
  },
  {
    id: "ease-out",
    name: "Ease Out",
    ease: cubicBezier(0.16, 0.84, 0.44, 1),
    points: { x1: 0.16, y1: 0.84, x2: 0.44, y2: 1 },
  },
  {
    id: "ease-in",
    name: "Ease In",
    ease: cubicBezier(0.56, 0, 0.84, 0.16),
    points: { x1: 0.56, y1: 0, x2: 0.84, y2: 0.16 },
  },
  {
    id: "ease-in-out",
    name: "Ease In / Out",
    ease: cubicBezier(0.65, 0, 0.35, 1),
    points: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 },
  },
  { id: "expo-out", name: "Expo Out", ease: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)) },
  { id: "expo-in-out", name: "Expo In / Out", ease: (t) => {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t < 0.5
        ? Math.pow(2, 20 * t - 10) / 2
        : (2 - Math.pow(2, -20 * t + 10)) / 2;
    } },
  { id: "back-out", name: "Back Out", ease: (t) => {
      const c = 1.70158;
      const u = t - 1;
      return 1 + (c + 1) * u * u * u + c * u * u;
    } },
];

export const DEFAULT_CURVE = "ease-out";

export function findCurve(id: string): EasingCurve {
  return CURVES.find((curve) => curve.id === id) ?? CURVES[0]!;
}

export const DENSITY_MIN = 4;
export const DENSITY_MAX = 48;
export const DENSITY_DEFAULT = 16;
export const DENSITY_PRESETS = [8, 16, 24, 32];

/** Samples a curve into an SVG path, for the preview and the gallery. */
export function curvePath(
  curve: EasingCurve,
  width: number,
  height: number,
  pad: number
): string {
  const steps = 40;
  const points: string[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = pad + t * (width - pad * 2);
    const y = height - pad - curve.ease(t) * (height - pad * 2);
    points.push(`${step === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

// ── curva desenhada pelo editor ────────────────────────────────────

export const CUSTOM_CURVE = "custom";

/** Where a fresh custom curve starts: the Ease Out everyone reaches for. */
export const CUSTOM_DEFAULT: CurvePoints = { x1: 0.16, y1: 0.84, x2: 0.44, y2: 1 };

/**
 * Vertical room the editor draws, in curve units.
 *
 * The headroom is 0.6 rather than something tidier because of what a
 * bezier actually does: a handle at y = 1.25 only lifts the curve to a
 * peak of 1.02, which is not an overshoot anyone would notice. Reaching
 * the ~1.10 peak of the Back Out preset needs a handle near 1.56, so
 * the ceiling sits just past it and the floor mirrors it.
 */
export const CURVE_Y_MIN = -0.6;
export const CURVE_Y_MAX = 1.6;

/**
 * A drawing box in SVG user units, plus the slice of curve space it
 * shows. Projection and its inverse both read from this, so a dragged
 * handle can never land somewhere other than where it is painted.
 */
export interface CurveBox {
  width: number;
  height: number;
  padX: number;
  padY: number;
  min: number;
  max: number;
}

export function curveBox(
  width: number,
  height: number,
  padX: number,
  padY: number
): CurveBox {
  return { width, height, padX, padY, min: CURVE_Y_MIN, max: CURVE_Y_MAX };
}

/** Curve space (x 0..1, y around 0..1) into SVG user units. */
export function project(
  box: CurveBox,
  x: number,
  y: number
): { x: number; y: number } {
  const spanX = box.width - box.padX * 2;
  const spanY = box.height - box.padY * 2;
  return {
    x: box.padX + x * spanX,
    y: box.padY + ((box.max - y) / (box.max - box.min)) * spanY,
  };
}

/** SVG user units back into curve space. The exact inverse of `project`. */
export function unproject(
  box: CurveBox,
  x: number,
  y: number
): { x: number; y: number } {
  const spanX = box.width - box.padX * 2;
  const spanY = box.height - box.padY * 2;
  return {
    x: spanX > 0 ? (x - box.padX) / spanX : 0,
    y:
      spanY > 0
        ? box.max - ((y - box.padY) / spanY) * (box.max - box.min)
        : 0,
  };
}

/**
 * The curve as one SVG cubic segment. A bezier drawn as a bezier, not
 * sampled — it is exactly the shape the bake will follow.
 */
export function bezierPath(points: CurvePoints, box: CurveBox): string {
  const start = project(box, 0, 0);
  const one = project(box, points.x1, points.y1);
  const two = project(box, points.x2, points.y2);
  const end = project(box, 1, 1);
  return (
    `M${round(start.x)},${round(start.y)} ` +
    `C${round(one.x)},${round(one.y)} ` +
    `${round(two.x)},${round(two.y)} ` +
    `${round(end.x)},${round(end.y)}`
  );
}

/**
 * x has to stay inside 0..1 or the solver behind `cubicBezier` loses the
 * single-valued x(t) it bisects on, and the curve stops being a
 * function of time. y is free to overshoot within the drawn range.
 */
export function clampPoints(points: CurvePoints): CurvePoints {
  return {
    x1: clamp(points.x1, 0, 1),
    y1: clamp(points.y1, CURVE_Y_MIN, CURVE_Y_MAX),
    x2: clamp(points.x2, 0, 1),
    y2: clamp(points.y2, CURVE_Y_MIN, CURVE_Y_MAX),
  };
}

/** The drawn curve, as an EasingCurve the bake can consume. */
export function customCurve(points: CurvePoints): EasingCurve {
  const safe = clampPoints(points);
  return {
    id: CUSTOM_CURVE,
    name: "Sua curva",
    ease: cubicBezier(safe.x1, safe.y1, safe.x2, safe.y2),
    points: safe,
  };
}

/** `.16 .84 .44 1` — the readout, in the same order CSS writes it. */
export function formatPoints(points: CurvePoints): string {
  return [points.x1, points.y1, points.x2, points.y2].map(figure).join("  ");
}

function figure(value: number): string {
  const fixed = value.toFixed(2);
  // Trim the trailing hundredths first, then the leading zero. The other
  // order turned "0.00" into ".00" and then into nothing at all, so a
  // control point sitting exactly on 0 — Ease In has one — read as a blank.
  const trimmed = fixed.replace(/\.00$/, "");
  if (trimmed === "0" || trimmed === "-0") {
    return "0";
  }
  return trimmed.replace(/^0\./, ".").replace(/^-0\./, "-.");
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(high, Math.max(low, value));
}

function round(value: number): string {
  return value.toFixed(1);
}
