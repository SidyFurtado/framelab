/**
 * Onde cada keyframe cai, e com que valor.
 *
 * Esta é a conta que esteve errada duas vezes: uma vez pondo o primeiro
 * frame do zoom em 0%, outra multiplicando os keyframes de uma curva
 * reaplicada. As duas foram caçadas gravando JSON em disco e pedindo
 * para alguém clicar dentro do Premiere. Nenhuma das duas precisava
 * disso: a conta é pura, e aqui ela é conferida em milissegundos.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { snapTicksToFrame } from "../src/bridge/premiere.ts";
import { placeKeyframes } from "../src/tools/zoom/applyZoom.ts";
import { findCurve } from "../src/curves/easing.ts";

/** Ticks por segundo do Premiere. Medido num relatório real do host. */
const TICKS_PER_SECOND = 254016000000n;
/** 23,976 fps, o caso do relatório que destravou o bug da curva. */
const TICKS_PER_FRAME = 10594584000n;

/**
 * O mínimo do host que `placeKeyframes` toca: converter segundos em
 * ticks. Nada mais dele entra nesta conta.
 */
const ppro = {
  TickTime: {
    createWithSeconds: (seconds: number) => ({
      ticks: String(BigInt(Math.round(seconds * Number(TICKS_PER_SECOND)))),
    }),
  },
} as never;

/** O instante exato de um frame, em segundos. */
function frameSeconds(frame: number): number {
  return Number(TICKS_PER_FRAME * BigInt(frame)) / Number(TICKS_PER_SECOND);
}

function plan(
  ease: (t: number) => number,
  from: number,
  to: number,
  startSec: number,
  durationSec: number
): Map<string, number> {
  const startTicks = String(BigInt(Math.round(startSec * Number(TICKS_PER_SECOND))));
  const endTicks = String(
    BigInt(Math.round((startSec + durationSec) * Number(TICKS_PER_SECOND)))
  );
  return placeKeyframes(
    ppro,
    { ease } as never,
    from,
    to,
    startTicks,
    endTicks,
    startSec,
    durationSec,
    TICKS_PER_FRAME
  );
}

describe("grade de frames", () => {
  it("um tick já no grid não se move", () => {
    const onGrid = (TICKS_PER_FRAME * 7n).toString();
    assert.equal(snapTicksToFrame(onGrid, TICKS_PER_FRAME), onGrid);
  });

  it("um tick fora do grid vai para o frame mais perto", () => {
    const justAfter = (TICKS_PER_FRAME * 7n + 10n).toString();
    assert.equal(
      snapTicksToFrame(justAfter, TICKS_PER_FRAME),
      (TICKS_PER_FRAME * 7n).toString()
    );
    const justBefore = (TICKS_PER_FRAME * 8n - 10n).toString();
    assert.equal(
      snapTicksToFrame(justBefore, TICKS_PER_FRAME),
      (TICKS_PER_FRAME * 8n).toString()
    );
  });

  it("sem saber a grade, devolve o que recebeu em vez de chutar", () => {
    assert.equal(snapTicksToFrame("12345", null), "12345");
    assert.equal(snapTicksToFrame("12345", 0n), "12345");
  });

  it("lixo não vira NaN nem exceção", () => {
    assert.equal(snapTicksToFrame("nem-numero", TICKS_PER_FRAME), "nem-numero");
  });
});

describe("keyframes do Zoom", () => {
  const ease = findCurve("ease-out").ease;

  it("o primeiro keyframe vale o valor inicial, nunca zero", () => {
    // O defeito, escrito como teste: o primeiro frame saía a 0% e o
    // clipe abria sumindo. Vale para um clipe que começa no zero da
    // mídia, que é o caso em que o bug aparecia.
    const placed = plan(ease, 100, 115, 0, 3);
    const first = [...placed.values()][0];
    assert.equal(first, 100);
  });

  it("o último keyframe vale o valor final", () => {
    const placed = plan(ease, 100, 115, 0, 3);
    const last = [...placed.values()].at(-1);
    assert.equal(last, 115);
  });

  it("vale também num clipe aparado, longe do zero da mídia", () => {
    // 251 frames a 23,976 — o clipe do relatório que destravou o bug.
    const placed = plan(ease, 100, 140, frameSeconds(251), 3.4);
    const values = [...placed.values()];
    assert.equal(values[0], 100);
    assert.equal(values.at(-1), 140);
  });

  it("todo keyframe cai exatamente num frame", () => {
    // Inclusive o do fim: "começo + 1,6s" não cai em frame nenhum, e é
    // por isso que o rabo saía com keyframes fora da grade.
    const placed = plan(ease, 100, 115, frameSeconds(251), 1.6);
    for (const ticks of placed.keys()) {
      assert.equal(
        BigInt(ticks) % TICKS_PER_FRAME,
        0n,
        `${ticks} não está na grade`
      );
    }
  });

  it("nenhum frame recebe dois keyframes", () => {
    // Dois keyframes no mesmo frame viram um, com valor de cara ou
    // coroa. O Map já garante isso pela chave; o teste prende a
    // garantia para que ela não se perca numa refatoração.
    const placed = plan(ease, 100, 115, 0, 3);
    assert.equal(new Set(placed.keys()).size, placed.size);
  });

  it("os valores só sobem, numa curva que só sobe", () => {
    const placed = plan(ease, 100, 115, 0, 3);
    const values = [...placed.values()];
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(
        values[i]! >= values[i - 1]! - 1e-9,
        `caiu de ${values[i - 1]} para ${values[i]} na posição ${i}`
      );
    }
  });

  it("zoom out desce de onde começou até o neutro", () => {
    const placed = plan(ease, 130, 100, 0, 2);
    const values = [...placed.values()];
    assert.equal(values[0], 130);
    assert.equal(values.at(-1), 100);
  });

  it("uma reta sai com dois keyframes, não com nove", () => {
    // Sete keyframes em cima da mesma reta não desenham nada e são
    // sete desvios a mais para quem for ajustar o punch à mão.
    const placed = plan(findCurve("linear").ease, 100, 115, 0, 3);
    assert.equal(placed.size, 2, `saíram ${placed.size}`);
  });

  it("uma curva de verdade sai com mais que dois", () => {
    const placed = plan(ease, 100, 115, 0, 3);
    assert.ok(placed.size > 2, `saíram ${placed.size}`);
  });
});
