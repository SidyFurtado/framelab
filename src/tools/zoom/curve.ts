/**
 * The scale move, drawn.
 *
 * X is the clip's duration, Y is the scale. The rise is the animated
 * span; the dashed line after it is the hold, where Scale keeps its
 * last value to the end of the clip.
 *
 * The shape is sampled from the same easing the bake uses, and every
 * point on it comes out of `pointAt` — the keyframe dots included. The
 * previous version drew a decorative bezier while the dots followed the
 * real curve, so the two disagreed by up to 18% of the box height, and
 * three different values stood in for the left edge.
 */

export interface CurveShape {
  /** Fraction of the clip the animation occupies, 0..1. */
  span: number;
}

export interface CurveGeometry {
  rise: string;
  hold: string;
  area: string;
  /** Where progress `t` of the animated span sits, in user units. */
  pointAt(t: number): { x: number; y: number };
  endX: number;
  baseY: number;
  topY: number;
}

const SAMPLES = 48;

export function curveGeometry(
  shape: CurveShape,
  scalePercent: number,
  width: number,
  height: number,
  pad: number,
  ease: (t: number) => number
): CurveGeometry {
  const left = pad;
  const right = width - pad;
  const baseY = height - pad;
  const topY = pad + (1 - (scalePercent - 100) / 50) * (height - pad * 2) * 0.62;

  const span = Math.max(0, Math.min(1, shape.span));
  const endX = left + span * (right - left);

  const pointAt = (t: number): { x: number; y: number } => {
    const clamped = Math.max(0, Math.min(1, t));
    return {
      x: left + clamped * (endX - left),
      y: baseY - ease(clamped) * (baseY - topY),
    };
  };

  const steps: string[] = [];
  for (let step = 0; step <= SAMPLES; step++) {
    const at = pointAt(step / SAMPLES);
    steps.push(`${step === 0 ? "M" : "L"}${at.x.toFixed(1)},${at.y.toFixed(1)}`);
  }
  const rise = steps.join(" ");

  return {
    rise,
    hold: `M${endX.toFixed(1)},${topY.toFixed(1)} L${right.toFixed(1)},${topY.toFixed(1)}`,
    area:
      `${rise} L${right.toFixed(1)},${topY.toFixed(1)} ` +
      `L${right.toFixed(1)},${baseY.toFixed(1)} L${left.toFixed(1)},${baseY.toFixed(1)} Z`,
    pointAt,
    endX,
    baseY,
    topY,
  };
}
