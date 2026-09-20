/**
 * As curvas, conferidas fora do Premiere.
 *
 * Toda a matemática de assadura é função pura: entra um progresso de 0
 * a 1, sai um progresso de 0 a 1. Foi justamente aí que moraram os dois
 * piores defeitos desta base — um keyframe que saía zerado e uma
 * densidade que dobrava — e os dois foram caçados gravando JSON em
 * disco e pedindo para alguém clicar no Premiere. Nada disso precisava
 * do host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampPoints,
  CURVES,
  CUSTOM_DEFAULT,
  customCurve,
  DENSITY_DEFAULT,
  DENSITY_MAX,
  DENSITY_MIN,
  findCurve,
} from "../src/curves/easing.ts";

describe("curvas de easing", () => {
  it("toda curva começa em 0 e termina em 1", () => {
    // Com tolerância: o solucionador de bezier é numérico, e back-out
    // devolve 2e-16 em t=0. Num keyframe de escala isso é zero.
    for (const curve of CURVES) {
      assert.ok(Math.abs(curve.ease(0)) < 1e-9, `${curve.id} começa em ${curve.ease(0)}`);
      assert.ok(Math.abs(curve.ease(1) - 1) < 1e-9, `${curve.id} termina em ${curve.ease(1)}`);
    }
  });

  it("nenhuma curva devolve NaN no meio do caminho", () => {
    for (const curve of CURVES) {
      for (let step = 0; step <= 40; step += 1) {
        const value = curve.ease(step / 40);
        assert.ok(
          Number.isFinite(value),
          `${curve.id} devolveu ${value} em t=${step / 40}`
        );
      }
    }
  });

  it("as curvas sem overshoot ficam entre 0 e 1", () => {
    // back-out passa do alvo e volta, de propósito: é o efeito dela.
    for (const curve of CURVES.filter((entry) => entry.id !== "back-out")) {
      for (let step = 0; step <= 40; step += 1) {
        const value = curve.ease(step / 40);
        assert.ok(
          value >= -0.001 && value <= 1.001,
          `${curve.id} saiu do intervalo em t=${step / 40}: ${value}`
        );
      }
    }
  });

  it("linear é a identidade", () => {
    const linear = findCurve("linear");
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      assert.ok(Math.abs(linear.ease(t) - t) < 1e-9);
    }
  });

  it("um id desconhecido cai na primeira curva, nunca em undefined", () => {
    const found = findCurve("curva-que-nao-existe");
    assert.equal(found.id, CURVES[0]!.id);
  });

  it("back-out passa do alvo e volta — é para isso que ela existe", () => {
    const back = findCurve("back-out");
    const peak = Math.max(
      ...Array.from({ length: 101 }, (_, i) => back.ease(i / 100))
    );
    assert.ok(peak > 1, `back-out não passou de 1: ${peak}`);
    assert.ok(peak < 1.3, `back-out passou demais: ${peak}`);
  });

  it("Punch entrega mais da metade do movimento no primeiro terço", () => {
    // É a razão de ela existir e de o decaimento ser 3 e não 10: a 10
    // o movimento acabava em 40% da duração e o resto ficava parado.
    const punch = findCurve("punch");
    assert.ok(punch.ease(1 / 3) > 0.5, `deu ${punch.ease(1 / 3)}`);
    assert.ok(punch.ease(1 / 3) < 0.7, `deu ${punch.ease(1 / 3)}`);
  });
});

describe("curva desenhada à mão", () => {
  it("o padrão sobrevive ao clamp sem mudar", () => {
    assert.deepEqual(clampPoints({ ...CUSTOM_DEFAULT }), CUSTOM_DEFAULT);
  });

  it("pontos absurdos viram pontos utilizáveis, não NaN", () => {
    const safe = clampPoints({ x1: 99, y1: -99, x2: 1e9, y2: Number.NaN });
    for (const value of Object.values(safe)) {
      assert.ok(Number.isFinite(value), `saiu ${value}`);
    }
  });

  it("a curva desenhada também começa em 0 e termina em 1", () => {
    const drawn = customCurve({ x1: 0.9, y1: 0.1, x2: 0.1, y2: 0.9 });
    assert.equal(drawn.ease(0), 0);
    assert.equal(drawn.ease(1), 1);
  });

  it("x fora de [0,1] não escapa do intervalo", () => {
    const drawn = customCurve({ ...CUSTOM_DEFAULT });
    assert.equal(drawn.ease(-5), 0);
    assert.equal(drawn.ease(5), 1);
  });
});

describe("densidade da assadura", () => {
  it("o padrão está dentro dos limites que o painel oferece", () => {
    assert.ok(DENSITY_DEFAULT >= DENSITY_MIN);
    assert.ok(DENSITY_DEFAULT <= DENSITY_MAX);
  });
});
