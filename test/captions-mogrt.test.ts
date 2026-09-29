/**
 * O relógio do .srt, conferido fora do Premiere.
 *
 * É ele que decide QUANDO cada peça entra e sai; errar aqui são
 * quarenta legendas fora de hora de uma vez. O que vai DENTRO de cada
 * peça se prova em definition.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cuesFromSrt,
  cueSpan,
  groupCues,
  parseTimecode,
  withoutOverlap,
  wrapCues,
  type TimedCue,
} from "../src/tools/titles/cues";

describe("cuesFromSrt", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:02,500",
    "primeira linha",
    "",
    "2",
    "00:00:02,500 --> 00:00:04,000",
    "segunda",
    "com quebra",
    "",
    "3",
    "00:00:05,000 --> 00:00:05,000",
    "duração zero",
    "",
  ].join("\n");

  it("lê tempo, texto e ordem", () => {
    const cues = cuesFromSrt(srt);
    assert.equal(cues.length, 3);
    assert.deepEqual(
      cues.map((c) => [c.start, c.end, c.text]),
      [
        [1, 2.5, "primeira linha"],
        [2.5, 4, "segunda\ncom quebra"],
        // Duração zero vira clipe que ninguém vê: ganha um décimo.
        [5, 5.1, "duração zero"],
      ]
    );
  });

  it("aceita as duas grafias de relógio", () => {
    assert.equal(parseTimecode("00:00:01,500"), 1.5);
    assert.equal(parseTimecode("00:00:01.500"), 1.5);
    assert.equal(parseTimecode("01:02:03,004"), 3723.004);
    // "5" depois da vírgula é meio segundo, não cinco milésimos.
    assert.equal(parseTimecode("00:00:00,5"), 0.5);
    assert.equal(parseTimecode("faixa 1"), null);
  });

  it("descarta bloco sem texto e relógio ilegível", () => {
    const sujo = "1\n00:00:01,000 --> 00:00:02,000\n\n\n2\nlixo\ntexto solto\n";
    assert.deepEqual(cuesFromSrt(sujo), []);
  });
});

describe("withoutOverlap", () => {
  it("encurta a anterior quando duas se sobrepõem", () => {
    const cues = withoutOverlap([
      { start: 0, end: 3, text: "a" },
      { start: 2, end: 4, text: "b" },
    ]);
    assert.deepEqual(cues, [
      { start: 0, end: 2, text: "a" },
      { start: 2, end: 4, text: "b" },
    ]);
  });

  it("deixa em paz quem já não se encosta", () => {
    const cues = withoutOverlap([
      { start: 0, end: 1, text: "a" },
      { start: 2, end: 3, text: "b" },
    ]);
    assert.equal(cues[0].end, 1);
  });

  it("some com a legenda que ficaria sem nenhum tempo", () => {
    const cues = withoutOverlap([
      { start: 1, end: 3, text: "engolida" },
      { start: 1, end: 4, text: "a que vale" },
    ]);
    assert.deepEqual(cues.map((c) => c.text), ["a que vale"]);
  });

  it("mede o trecho do lote para achar trilha livre", () => {
    assert.deepEqual(
      cueSpan([
        { start: 2, end: 4, text: "a" },
        { start: 9, end: 10.5, text: "b" },
      ]),
      { start: 2, end: 10.5 }
    );
  });
});

describe("groupCues", () => {
  const fala: TimedCue[] = [
    { start: 0.0, end: 0.6, text: "você" },
    { start: 0.6, end: 1.1, text: "precisa" },
    { start: 1.1, end: 1.7, text: "ver" },
    { start: 1.7, end: 2.4, text: "isso" },
    // Pausa de 1,2s: aqui a frase fecha, custe o que custar.
    { start: 3.6, end: 4.2, text: "agora" },
  ];

  it("junta até o teto de tempo e para na pausa", () => {
    const juntas = groupCues(fala, 2);
    assert.deepEqual(
      juntas.map((c) => [c.start, c.end, c.text]),
      [
        [0, 1.7, "você precisa ver"],
        [1.7, 2.4, "isso"],
        [3.6, 4.2, "agora"],
      ]
    );
  });

  it("a pausa corta mesmo com tempo de sobra", () => {
    const juntas = groupCues(fala, 10, 999);
    assert.equal(juntas.length, 2);
    assert.deepEqual(juntas.map((c) => c.text), ["você precisa ver isso", "agora"]);
    assert.equal(juntas[0].end, 2.4);
  });

  it("o teto de caracteres impede a linha quilométrica", () => {
    const longas: TimedCue[] = [
      { start: 0, end: 1, text: "palavra bem comprida aqui" },
      { start: 1, end: 2, text: "e outra igualmente comprida" },
    ];
    assert.equal(groupCues(longas, 10, 30).length, 2);
    assert.equal(groupCues(longas, 10, 80).length, 1);
  });

  it("junta as quebras de linha numa só linha", () => {
    const duas: TimedCue[] = [
      { start: 0, end: 1, text: "primeira\nlinha" },
      { start: 1, end: 2, text: "segunda" },
    ];
    assert.equal(groupCues(duas, 5)[0].text, "primeira linha segunda");
  });

  it("sem agrupamento pedido, devolve o .srt como está", () => {
    assert.deepEqual(groupCues(fala, 0), fala);
    assert.deepEqual(groupCues([], 3), []);
  });

  it("no .srt real de 164 blocos, corta o lote a um terço", () => {
    // Um bloco a cada 0,75s, como o que quebrou o Premiere.
    const muitas: TimedCue[] = Array.from({ length: 164 }, (_, i) => ({
      start: i * 0.75,
      end: i * 0.75 + 0.7,
      text: `palavra${i}`,
    }));
    const juntas = groupCues(muitas, 2.5);
    assert.ok(juntas.length <= 60, `deu ${juntas.length}`);
    // Nada se perde: a primeira começa no começo e a última termina no fim.
    assert.equal(juntas[0].start, 0);
    assert.equal(juntas[juntas.length - 1].end, muitas[163].end);
  });
});

describe("wrapCues", () => {
  it("quebra em até três linhas curtas, porque o modelo não quebra", () => {
    const uma = wrapCues([
      { start: 0, end: 3, text: "Não beba esta gelatina de cavalo a menos que queira" },
    ]);
    const linhas = uma[0].text.split("\n");
    assert.ok(linhas.length <= 3, `deu ${linhas.length} linhas`);
    assert.ok(
      linhas.every((linha) => linha.length <= 28),
      `linha longa: ${JSON.stringify(linhas)}`
    );
  });

  it("frase curta não ganha quebra nenhuma", () => {
    assert.equal(wrapCues([{ start: 0, end: 1, text: "agora" }])[0].text, "agora");
  });

  it("quebra que já vinha do .srt é refeita, não somada", () => {
    const uma = wrapCues([{ start: 0, end: 2, text: "primeira\nsegunda" }]);
    assert.equal(uma[0].text, "primeira segunda");
  });

  it("o tempo não é tocado pela quebra", () => {
    const uma = wrapCues([{ start: 1.25, end: 3.5, text: "uma frase bem comprida aqui dentro" }]);
    assert.equal(uma[0].start, 1.25);
    assert.equal(uma[0].end, 3.5);
  });
});
