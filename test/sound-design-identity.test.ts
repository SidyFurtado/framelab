/**
 * O som do que está na tela — sem adivinhar pelo movimento.
 *
 * A timeline abaixo é a sequência "teste de sfx" do editor, com os
 * tempos lidos do Premiere (2026-09-22): títulos CLEAN BLUE do Textos
 * Animados, film burns, light leak, poeira, Adjustment Layers, gráficos
 * e B-rolls. O editor sonorizou essa sequência à mão, e é contra essa
 * sonorização que as regras abaixo foram conferidas: clique por palavra
 * nos títulos, fogo no film burn, swoosh no gráfico, nada no resto.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorsOf, eventsFrom, identityOf, presetFor, soundedAlready, titleOf, wordCount, wordTimes, type Element, type SfxClip } from "../src/tools/soundDesign/identity";
import { DEFAULT_OPTIONS, selectEvents } from "../src/tools/soundDesign/plan";

const FRAME = 1001 / 24000;
let n = 0;
const el = (clip: string, track: number, start: number, end: number, role: Element["role"], extra: Partial<Element> = {}): Element => {
  const title = titleOf(clip);
  return { key: `k${n++}`, clip, track, start, end, role, media: extra.media ?? "", effects: [], ...(title ? { template: title.template, text: title.text } : {}), ...extra };
};
const BURN = "6508355_Film Burn Transition Effect Overlay_By_Kino-Pravda_Artlist_HD.mp4";
const LEAK = "Generated Light Leak 1 (d6af88dd) 1080x1920 by Mister Horse";
const DUST = "6086586_Film Grain Effect Dust_By_Kristian_Ozer_Kettner_Artlist_HD.mp4";
const titles: Array<[string, number, number]> = [
  ["all night long. For real,", 4.67, 5.3], ["I can give you", 11.14, 12.01], ["it was so damn good.", 30.11, 31.24], ["Literally.", 66.61, 67.4],
];
const sequence: Element[] = [
  el(DUST, 2, 0, 2.84, "overlay", { identity: identityOf(DUST), media: DUST }),
  ...titles.map(([text, a, b]) => el(`CLEAN BLUE · ${text}`, 2, a, b, "title")),
  el("CLEAN STYLE · Doctor David Samadi", 4, 43.96, 45.21, "title"),
  ...[[9.18, 9.3], [9.3, 9.68]].flatMap(([a, b]) => [el("Graphic", 2, a, b, "graphic"), el("Graphic", 3, a, b, "graphic")]),
  ...[5.05, 10.89].map((a) => el(BURN, 3, a, a + 0.92, "overlay", { identity: identityOf(BURN), media: BURN })),
  el(LEAK, 4, 41.33, 41.88, "overlay", { identity: identityOf(LEAK), media: LEAK }),
  el("Adjustment Layer", 3, 14.89, 16.1, "adjustment", { effects: ["AE.ADBE Lumetri"] }),
  el("Adjustment Layer", 1, 11.14, 12.72, "adjustment", { effects: ["AE.ADBE Gaussian Blur 2"] }),
  el("broll.mp4", 1, 0, 2.84, "footage", { media: "broll.mp4" }),
];
const anchors = anchorsOf(sequence, [], FRAME);
const events = eventsFrom(anchors, FRAME);

describe("identidade de cada clipe", () => {
  it("título do Textos Animados: modelo e texto vêm do nome", () => {
    assert.deepEqual(titleOf("CLEAN BLUE · it was so damn good."), { template: "CLEAN BLUE", text: "it was so damn good." });
    assert.equal(wordCount("it was so damn good."), 5);
    assert.equal(wordCount("Trust me, it's"), 3);
    assert.equal(titleOf("BODY_1080p.mp4"), null);
  });
  it("overlays pelo nome do arquivo", () => {
    assert.equal(identityOf(BURN), "filmburn");
    assert.equal(identityOf(LEAK), "lightleak");
    assert.equal(identityOf(DUST), "texture");
    assert.equal(identityOf("AI_03_ThreeWomen_Sofa_V01.mp4"), undefined);
  });
  it("Adjustment Layer com Impact Blur (FilmImpact) é o flash do editor", () => {
    assert.equal(identityOf("AE.Impact_Blur_FX"), "flash");
    assert.equal(identityOf("AE.ADBE Gaussian Blur 2", "AE.ADBE Lumetri"), undefined);
  });
});

describe("o som do que está na tela", () => {
  it("CLEAN BLUE: um clique por palavra, logo depois da entrada, no ritmo da animação", () => {
    const good = events.filter((e) => e.clip === "CLEAN BLUE · it was so damn good.");
    assert.equal(good.length, 5);
    assert.ok(good.every((e) => e.kind === "word" && e.family === "click"));
    assert.ok(Math.abs(good[0].peak - (30.11 + 0.13)) < FRAME);
    assert.ok(Math.abs(good[1].peak - good[0].peak - 0.09) < FRAME);
    assert.ok(good.every((e, i) => i === 0 || e.peak > good[i - 1].peak));
  });
  it("título curto: os cliques cabem dentro dele", () => {
    const one = events.filter((e) => e.clip === "CLEAN BLUE · Literally.");
    assert.equal(one.length, 1);
  });
  it("film burn: som de film burn na entrada — nunca whoosh", () => {
    const burns = events.filter((e) => e.clip === BURN);
    assert.equal(burns.length, 2);
    assert.ok(burns.every((e) => e.family === "burn"));
  });
  it("gráficos empilhados: um swoosh só", () => {
    const graphics = events.filter((e) => e.clip === "Graphic");
    assert.equal(graphics.length, 1);
    assert.equal(graphics[0].family, "whoosh");
  });
  it("light leak, poeira, Adjustment Layer sem efeito reconhecido e B-roll: silêncio", () => {
    assert.ok(!events.some((e) => e.clip === LEAK || e.clip === DUST || e.clip === "Adjustment Layer" || e.clip === "broll.mp4"));
  });
  it("modelo de título com um som na entrada, ou sem som, como o editor escolher", () => {
    const mode = (t: string) => (t === "CLEAN STYLE" ? "entry" : t === "CLEAN BLUE" ? "none" : "words") as const;
    const chosen = eventsFrom(anchors, FRAME, new Set(), mode);
    assert.ok(!chosen.some((e) => e.clip.startsWith("CLEAN BLUE")));
    const style = chosen.filter((e) => e.clip.startsWith("CLEAN STYLE"));
    assert.equal(style.length, 1);
    assert.equal(style[0].family, "whoosh");
    assert.ok(Math.abs(style[0].peak - 43.96) < FRAME);
  });
  it("onde o editor já pôs SFX, nada muda", () => {
    const mine: SfxClip[] = [{ path: "/sfx/click.wav", name: "click.wav", start: 30.32, duration: 0.04, inPoint: 0.04, track: 2 },
      { path: "/sfx/fire.wav", name: "fire.wav", start: 5.21, duration: 0.88, inPoint: 0, track: 4 }];
    const done = soundedAlready(anchors, mine);
    const rest = eventsFrom(anchors, FRAME, done);
    assert.ok(!rest.some((e) => e.clip === "CLEAN BLUE · it was so damn good."));
    assert.equal(rest.filter((e) => e.clip === BURN).length, 1);
  });
  it("zoom e punch-in no vídeo só entram com o filtro ligado", () => {
    const zoom = { id: "z", clip: "BODY_1080p.mp4", kind: "zoom" as const, start: 20, peak: 20.2, end: 20.5, intensity: 0.5, detail: "Aproxima 15%" };
    const withMotion = eventsFrom(anchorsOf([el("BODY_1080p.mp4", 0, 18, 22, "footage")], [zoom], FRAME), FRAME);
    assert.equal(selectEvents(withMotion, DEFAULT_OPTIONS, FRAME).length, 0);
    assert.equal(selectEvents(withMotion, { ...DEFAULT_OPTIONS, zoom: true }, FRAME).length, 1);
  });
  it("nada no mesmo quadro derruba os cliques de um título", () => {
    const kept = selectEvents(events, DEFAULT_OPTIONS, FRAME).filter((e) => e.clip === "CLEAN BLUE · it was so damn good.");
    assert.equal(kept.length, 5);
  });
});

describe("presets do Textos Animados, medidos no próprio vídeo de cada um", () => {
  it("CLEAN BLUE e APPLE STYLE: palavra por palavra; VHS: glitch na entrada; GOLD: brilho; SMOOTH OPACITY: nada", () => {
    assert.equal(presetFor("CLEAN BLUE").mode, "words");
    assert.equal(presetFor("APPLE STYLE ANIMATION").mode, "words");
    assert.deepEqual([presetFor("VHS").mode, presetFor("VHS").family], ["entry", "glitch"]);
    assert.deepEqual([presetFor("GOLD TEXT").mode, presetFor("GOLD TEXT").family], ["entry", "shine"]);
    assert.equal(presetFor("SMOOTH OPACITY").mode, "none");
    assert.equal(presetFor("BB Fade Up").mode, "none");
  });
  it("quantas palavras, quantos sons: 4 → 4, 10 → 10", () => {
    const blue = presetFor("CLEAN BLUE");
    assert.equal(wordTimes("buy it right now", 10, 12, blue, FRAME).length, 4);
    assert.equal(wordTimes("one two three four five six seven eight nine ten", 10, 12, blue, FRAME).length, 10);
  });
  it("letra por letra (ORANGE): cada palavra soa quando a primeira letra dela chega", () => {
    const t = wordTimes("big sale", 10, 12, presetFor("ORANGE TEXT"), FRAME);
    assert.ok(Math.abs(t[0] - 10.17) < 1e-9);
    assert.ok(Math.abs(t[1] - (10.17 + 4 * 0.05)) < 1e-9);
  });
  it("modelo desconhecido: um clique por palavra, um por quadro", () => {
    const t = wordTimes("a b c", 10, 12, presetFor("NOVO MODELO"), FRAME);
    assert.ok(Math.abs(t[1] - t[0] - FRAME) < 1e-9);
  });
  it("título curto demais: os sons se apertam dentro dele", () => {
    const t = wordTimes("one two three four five six seven eight nine ten", 10, 10.5, presetFor("CLEAN BLUE"), FRAME);
    assert.ok(t[t.length - 1] <= 10.5 - FRAME + 1e-9);
  });
});

describe("movimento só soa quando se vê, e quando é rápido", () => {
  const body = el("BODY_1080p.mp4", 0, 0, 10, "footage");
  const zoom = (peak: number, span: number) => ({ id: `z${peak}`, clip: "BODY_1080p.mp4", kind: "zoom" as const, start: peak - span / 2, peak, end: peak + span / 2, intensity: 0.5, detail: "Aproxima 20%" });
  const punch = (cut: number) => ({ id: `p${cut}`, clip: "BODY_1080p.mp4", kind: "zoom" as const, start: cut - 0.18, peak: cut, end: cut + 0.12, intensity: 0.6, detail: "Punch no corte · 100% → 120%" });
  const broll = [{ track: 1, start: 0, end: 2.84, opaque: true }, { track: 1, start: 2.84, end: 4.8, opaque: true }];
  it("punch no V1 debaixo de B-roll: nada (a troca de B-roll não é transição)", () => {
    assert.equal(anchorsOf([body], [punch(2.84)], FRAME, broll).length, 0);
  });
  it("punch no V1 visível: whoosh", () => {
    assert.equal(anchorsOf([body], [punch(6)], FRAME, broll).length, 1);
  });
  it("zoom escondido pelo B-roll: nada; título ou overlay por cima não esconde", () => {
    assert.equal(anchorsOf([body], [zoom(3.5, 0.4)], FRAME, broll).length, 0);
    assert.equal(anchorsOf([body], [zoom(6, 0.4)], FRAME, [{ track: 2, start: 5, end: 7, opaque: false }]).length, 1);
  });
  it("drift lento (Ken Burns, 1,9 s): nada; zoom rápido (0,4 s): whoosh", () => {
    assert.equal(anchorsOf([body], [zoom(6, 1.9)], FRAME).length, 0);
    assert.equal(anchorsOf([body], [zoom(6, 0.4)], FRAME).length, 1);
  });
});
