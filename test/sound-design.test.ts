/**
 * SFX Automático, fora do Premiere: detectar, escolher o som, alinhar o
 * pico no quadro e caber nas faixas. Os nomes de som são os do pack
 * real (a pasta SFX do Drive).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCatalog, type PackFile } from "../src/tools/sfx/pack";
import {
  allocateTracks,
  cutAround,
  groupByCut,
  choiceById,
  chokeToFit,
  MAX_NEW_TRACKS,
  withRoom,
  DEFAULT_OPTIONS,
  detectMotion,
  punchEvent,
  rankSounds,
  selectEvents,
  varietyPick,
  type AudioLane,
  type Cue,
  type VisualEvent,
} from "../src/tools/soundDesign/plan";
import { decodeWav, encodeWav, measure, renderSound, trimTail, type Pcm } from "../src/tools/soundDesign/wave";
import { paramKind } from "../src/tools/soundDesign/scan";
import { addAudioTracks, placeCuts } from "../src/tools/soundDesign/apply";

const FRAME = 1 / 30;
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

function event(kind: VisualEvent["kind"], peak: number, intensity = 0.5, span = 0.4): VisualEvent {
  return { id: `${kind}-${peak}`, clip: "C", kind, start: peak - span / 2, peak, end: peak + span / 2, intensity, detail: "" };
}

describe("paramKind", () => {
  it("o Zoom do Framelab grava em Transformar › Scale Height", () => {
    assert.equal(paramKind("Scale Height"), "zoom");
    assert.equal(paramKind("Altura da escala"), "zoom");
  });
  it("Movimento em inglês e português", () => {
    assert.equal(paramKind("Scale"), "zoom");
    assert.equal(paramKind("Escala"), "zoom");
    assert.equal(paramKind("Posição"), "move");
    assert.equal(paramKind("Rotation"), "rotate");
    assert.equal(paramKind("Opacidade"), "opacity");
  });
  it("largura sozinha não é zoom (com escala uniforme ela nem vale)", () => {
    assert.equal(paramKind("Scale Width"), null);
    assert.equal(paramKind("Anchor Point"), null);
  });
});

describe("detectMotion", () => {
  it("um zoom com ease vira um evento só, com pico onde anda mais rápido", () => {
    // 100 → 120 em 0,5 s, ease-in-out: rápido no meio.
    const samples = Array.from({ length: 11 }, (_, i) => {
      const t = i / 10;
      const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
      return { time: 2 + t * 0.5, value: [100 + 20 * eased] };
    });
    const events = detectMotion("zoom", samples, "A", "k");
    assert.equal(events.length, 1);
    near(events[0].start, 2);
    near(events[0].end, 2.5);
    assert.ok(Math.abs(events[0].peak - 2.25) < 0.05, `pico ${events[0].peak}`);
    assert.match(events[0].detail, /Aproxima 20%/);
  });
  it("vai e volta são dois movimentos", () => {
    const samples = [0, 0.25, 0.5, 0.75, 1].map((t, i) => ({ time: t, value: [[100, 110, 120, 110, 100][i]] }));
    assert.equal(detectMotion("zoom", samples, "A", "k").length, 2);
  });
  it("mudança pequena demais não é evento", () => {
    assert.equal(detectMotion("zoom", [{ time: 0, value: [100] }, { time: 1, value: [101] }], "A", "k").length, 0);
  });
});

describe("punchEvent", () => {
  it("corte de 100% para 115% é punch, com o pico no corte", () => {
    const punch = punchEvent("k", "A", 3, 1, 1.15);
    assert.ok(punch);
    assert.equal(punch.kind, "zoom");
    assert.equal(punch.peak, 3);
    assert.match(punch.detail, /100% → 115%/);
  });
  it("mesmo enquadramento nos dois lados não é punch", () => {
    assert.equal(punchEvent("k", "A", 3, 1.1, 1.12), null);
  });
});

describe("selectEvents", () => {
  const withZoom = { ...DEFAULT_OPTIONS, zoom: true };
  it("os cliques de um título nunca se derrubam; um whoosh no mesmo quadro de um clique ganha", () => {
    const words = [1, 1.09, 1.18, 1.3].map((t, i) => ({ ...event("word", t, 0.3, 0.12), id: `w${t}`, detail: `· palavra ${i + 1}` }));
    const zoom = event("zoom", 1.3, 0.6);
    const out = selectEvents([...words, zoom], withZoom, FRAME);
    assert.ok(out.some((e) => e.kind === "zoom"));
    assert.equal(out.filter((e) => e.kind === "word").length, 3);
    assert.ok(!out.some((e) => e.kind === "word" && Math.abs(e.peak - 1.3) < 0.01));
  });
  it("zoom e movimento vêm desligados", () => {
    assert.equal(selectEvents([event("zoom", 3, 0.5), event("move", 5, 0.5)], DEFAULT_OPTIONS, FRAME).length, 0);
  });
  it("Discreto deixa só a primeira palavra de cada título", () => {
    const words = [1, 1.09, 1.18].map((t, i) => ({ ...event("word", t, 0.3, 0.12), id: `w${t}`, detail: `“x” · palavra ${i + 1}` }));
    const out = selectEvents(words, { ...DEFAULT_OPTIONS, density: "light" }, FRAME);
    assert.deepEqual(out.map((e) => e.detail), ["“x” · palavra 1"]);
  });
  it("filtro desligado some da lista", () => {
    const out = selectEvents([event("word", 1, 0.18)], { ...DEFAULT_OPTIONS, word: false }, FRAME);
    assert.equal(out.length, 0);
  });
});

// Um recorte do pack real, com as pastas como estão no Drive.
const PACK: PackFile[] = [
  "Wooshes/Whoosh 03.wav", "Wooshes/Best Whoosh.wav", "Wooshes/Fast Swoosh 3.wav", "Wooshes/Fast Swoosh 7.wav", "Wooshes/Gears 1.wav",
  "Wooshes/Fireball 02 Explosion.mp3", "Wooshes/Whoosh long.wav", "Wooshes/Deep Sub Whoosh.wav",
  "Computer/click casual digital.wav", "Computer/1 Click Mouse.wav", "Computer/Mechanical Keyboard.wav",
  "Ui/Pop up.wav", "Ui/Hologram 1.mp3", "Ui/Mountain Audio - Counter Beeps - Sound (1).wav", "Ui/RISE_Digital_Fear.wav",
  "Diversos/Pop.wav", "Hits - impacts/Impact 01.mp3", "Hits - impacts/Reverse Boom.wav", "Risers/Riser 1.wav",
  "Diversos/Data/DigitalDataCounter_01_Loop.wav",
].map((path) => {
  const parts = path.split("/");
  const name = parts.pop()!;
  return { id: path, name, folders: parts, stamp: "" };
});
const catalog = buildCatalog(PACK);
const unknown = () => null;

describe("rankSounds", () => {
  it("zoom ganha whoosh, nunca engrenagem nem explosão", () => {
    const names = rankSounds(event("zoom", 2), catalog, unknown).map((c) => c.variant.file);
    assert.ok(names.length > 0);
    assert.match(names[0], /whoosh|swoosh/i);
    assert.ok(!names.some((n) => /gears|explosion|riser/i.test(n)));
  });
  it("punch curto prefere o swoosh rápido; empurrão longo, o whoosh longo", () => {
    const fast = rankSounds(event("zoom", 2, 0.8, 0.3), catalog, unknown)[0].variant.file;
    const slow = rankSounds(event("zoom", 2, 0.3, 1.8), catalog, unknown)[0].variant.file;
    assert.match(fast, /Fast Swoosh/);
    assert.match(slow, /long|Deep Sub/i);
  });
  it("palavra ganha clique do Computer, não bipe nem holograma", () => {
    const names = rankSounds(event("word", 2, 0.18, 0.12), catalog, unknown).map((c) => c.variant.file);
    assert.match(names[0], /click/i);
    assert.ok(!names.some((n) => /hologram|counter|beeps|rise|loop/i.test(n)));
  });
  it("texto entrando ganha pop", () => {
    assert.match(rankSounds(event("graphic", 2, 0.25, 0.15), catalog, unknown)[0].variant.file, /pop/i);
  });
  it("corte ganha impacto, nunca o boom reverso", () => {
    const names = rankSounds(event("cut", 2, 0.45, 0.15), catalog, unknown).map((c) => c.variant.file);
    assert.match(names[0], /impact/i);
    assert.ok(!names.some((n) => /reverse/i.test(n)));
  });
  it("som com duração conhecida longa demais sai da lista", () => {
    const names = rankSounds(event("word", 2, 0.18, 0.12), catalog, (v) => (v.file.startsWith("click casual") ? 9 : null))
      .map((c) => c.variant.file);
    assert.ok(!names.includes("click casual digital.wav"));
  });
  it("whooshes seguidos alternam; palavras repetem o mesmo clique", () => {
    const whooshes = rankSounds(event("zoom", 2), catalog, unknown);
    const picks = [0, 1, 2].map((n) => varietyPick("whoosh", whooshes, n));
    assert.ok(new Set(picks).size > 1);
    const clicks = rankSounds(event("word", 2, 0.18, 0.12), catalog, unknown);
    assert.deepEqual([0, 1, 2].map((n) => varietyPick("click", clicks, n)), [0, 0, 0]);
  });
});

function tone(seconds: number, peakAt: number, rate = 48000, channels = 2): Pcm {
  const frames = Math.round(seconds * rate);
  const samples = new Float32Array(frames * channels);
  const p = Math.round(peakAt * rate);
  for (let f = 0; f < frames; f++) {
    const level = f === p ? 0.9 : 0.2 * Math.exp(-Math.abs(f - p) / rate / 0.1);
    for (let c = 0; c < channels; c++) samples[f * channels + c] = level * (f % 2 ? 1 : -1) * (f === p ? 1 : 0.5);
  }
  return { rate, channels, samples };
}
const peakOffset = (pcm: Pcm): number => measure(pcm).peakSeconds;

describe("renderSound", () => {
  const shape = { pre: 0.3, post: 0.4, fadeIn: 0.05, fadeOut: 0.1 };
  it("o pico do som cai exatamente no quadro pedido", () => {
    const out = renderSound(tone(2, 0.8), 5, shape, -12, FRAME);
    near(out.peak, Math.round(5 / FRAME) * FRAME);
    near(out.start + peakOffset(out.pcm), out.peak, 1 / 48000 + 1e-9);
    near(out.start / FRAME, Math.round(out.start / FRAME), 1e-6);
  });
  it("começo e fim no grid de quadros", () => {
    const out = renderSound(tone(2, 0.8), 5, shape, -12, FRAME);
    near((out.end - out.start) / FRAME, Math.round((out.end - out.start) / FRAME), 1e-6);
  });
  it("perto do zero, corta o começo em vez de atrasar o pico", () => {
    const out = renderSound(tone(2, 0.8), FRAME, shape, -12, FRAME);
    assert.equal(out.start, 0);
    near(peakOffset(out.pcm), FRAME, 1 / 48000 + 1e-9);
  });
  it("normaliza no pico pedido", () => {
    const out = renderSound(tone(2, 0.8), 5, shape, -12, FRAME);
    near(measure(out.pcm).amplitude, Math.pow(10, -12 / 20), 1e-3);
  });
  it("cauda cortada termina em silêncio; cauda natural não recebe fade", () => {
    const cut = renderSound(tone(2, 0.8), 5, shape, -12, FRAME);
    const frames = cut.pcm.samples.length / 2;
    // Depois do fade vem só o preenchimento até o quadro.
    const body = Math.round((0.3 + 0.4) * 48000);
    assert.ok(Math.abs(cut.pcm.samples[(body - 1) * 2]) < 1e-3);
    assert.ok(frames >= body);
    const click = renderSound(tone(0.1, 0), 5, { pre: 0, post: 0.4, fadeIn: 0, fadeOut: 0.1 }, -12, FRAME);
    near(click.start, Math.round(5 / FRAME) * FRAME);
  });
  it("WAV de ida e volta mantém o formato", () => {
    const out = renderSound(tone(1, 0.3), 2, shape, -12, FRAME);
    const back = decodeWav(encodeWav(out.pcm));
    assert.equal(back.rate, 48000);
    assert.equal(back.channels, 2);
    assert.equal(back.samples.length, out.pcm.samples.length);
  });
});

describe("trimTail", () => {
  it("encurta até o próximo som e fecha com fade", () => {
    const out = renderSound(tone(2, 0.8), 5, { pre: 0.3, post: 0.8, fadeIn: 0.05, fadeOut: 0.1 }, -12, FRAME);
    const end = out.peak + 5 * FRAME;
    const short = trimTail(out, end, 0.05);
    near(short.end, end, 1 / 48000);
    assert.ok(Math.abs(short.pcm.samples[short.pcm.samples.length - 1]) < 1e-3);
    near(short.start + peakOffset(short.pcm), out.peak, 1 / 48000 + 1e-9);
  });
  it("nunca corta o ataque", () => {
    const out = renderSound(tone(2, 0.8), 5, { pre: 0.3, post: 0.8, fadeIn: 0.05, fadeOut: 0.1 }, -12, FRAME);
    assert.throws(() => trimTail(out, out.peak - FRAME, 0.05));
  });
});

const cue = (id: string, start: number, end: number, peak = start + 0.05, minEnd = peak + 0.06): Cue =>
  ({ eventId: id, start, end, peak, minEnd });
const lanes = (...spans: Array<Array<[number, number]>>): AudioLane[] => [
  { index: 0, locked: false, spans: [{ start: 0, end: 60 }] },
  { index: 1, locked: false, spans: [] },
  ...spans.map((list, i) => ({ index: i + 2, locked: false, spans: list.map(([start, end]) => ({ start, end })) })),
];

describe("chokeToFit", () => {
  const plan = (items: Cue[], l: AudioLane[]) => chokeToFit(items, l).planned.map((p) => [p.eventId, p.track, p.end]);
  it("com uma faixa só, a cauda do whoosh é cortada no impacto seguinte", () => {
    assert.deepEqual(plan([cue("w", 1, 2, 1.3, 1.45), cue("c", 1.6, 1.8)], lanes([])), [["w", 2, 1.6], ["c", 2, 1.8]]);
  });
  it("com duas faixas, ninguém é cortado", () => {
    assert.deepEqual(plan([cue("w", 1, 2, 1.3, 1.45), cue("c", 1.6, 1.8)], lanes([], [])), [["w", 2, 2], ["c", 3, 1.8]]);
  });
  it("não corta abaixo do mínimo: pede uma faixa", () => {
    assert.throws(() => chokeToFit([cue("w", 1, 2, 1.3, 1.7), cue("c", 1.6, 1.8)], lanes([])), /faixa de áudio livre/);
  });
  it("A1 e A2 nunca entram; faixa travada também não", () => {
    const locked: AudioLane[] = [...lanes(), { index: 2, locked: true, spans: [] }];
    assert.throws(() => chokeToFit([cue("c", 1, 1.2)], locked), /A3/);
  });
  it("o som encolhe antes de um clipe que já está na faixa", () => {
    assert.deepEqual(plan([cue("w", 1, 2, 1.2, 1.4)], lanes([[1.5, 3]])), [["w", 2, 1.5]]);
  });
  it("clique de palavra cede: fica de fora em vez de derrubar o lote ou cortar o whoosh", () => {
    const whoosh = cue("w", 1, 2, 1.3, 1.45);
    const words = [{ ...cue("p1", 0.6, 0.8), optional: true }, { ...cue("p2", 1.35, 1.55), optional: true }, { ...cue("p3", 2.1, 2.3), optional: true }];
    const out = chokeToFit([...words, whoosh], lanes([]));
    assert.deepEqual(out.planned.map((p) => [p.eventId, p.end]), [["p1", 0.8], ["w", 2], ["p3", 2.3]]);
    assert.deepEqual(out.dropped.map((p) => p.eventId), ["p2"]);
  });
  it("clique que invade o começo de um whoosh termina antes dele", () => {
    const out = chokeToFit([cue("w", 1, 2, 1.3, 1.45), { ...cue("p", 0.9, 1.1, 0.92, 0.98), optional: true }], lanes([]));
    assert.deepEqual(out.planned.map((p) => [p.eventId, p.end]), [["p", 1], ["w", 2]]);
  });
});

describe("faixas novas", () => {
  it("sem faixa livre, o plano usa a faixa que o lote vai criar", () => {
    const base = lanes([[0, 60]]);
    const out = chokeToFit([cue("w", 1, 2, 1.3, 1.9), cue("c", 1.2, 1.5, 1.25, 1.45)], withRoom(base, base.length - 1 + MAX_NEW_TRACKS));
    assert.deepEqual(out.planned.map((p) => [p.eventId, p.track]), [["w", 3], ["c", 4]]);
    assert.equal(out.dropped.length, 0);
  });
  it("as faixas que já existem vêm primeiro", () => {
    const base = lanes([]);
    const out = chokeToFit([cue("c", 1, 1.2)], withRoom(base, base.length - 1 + MAX_NEW_TRACKS));
    assert.equal(out.planned[0].track, 2);
  });
  it("withRoom não mexe nas faixas existentes", () => {
    const base = lanes([[1, 2]]);
    const room = withRoom(base, 5);
    assert.deepEqual(room.map((l) => l.index), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(room[2].spans, [{ start: 1, end: 2 }]);
  });
});

describe("choiceById", () => {
  it("qualquer tomada do pack vira opção, mesmo fora do ranking", () => {
    const choice = choiceById(catalog, "Computer/Mechanical Keyboard.wav");
    assert.ok(choice);
    assert.equal(choice.variant.file, "Mechanical Keyboard.wav");
    assert.equal(choiceById(catalog, "nao-existe"), null);
  });
});

describe("allocateTracks", () => {
  it("respeita a faixa planejada quando ela continua livre", () => {
    const placed = allocateTracks([{ eventId: "a", path: "x", start: 1, end: 2, track: 3 }], lanes([], []));
    assert.equal(placed[0].track, 3);
  });
  it("recusa quando falta faixa", () => {
    assert.throws(() => allocateTracks([{ eventId: "a", path: "x", start: 1, end: 2, track: 2 }], lanes([[0, 5]])));
  });
});

/*
 * Um Premiere de mentira, com o comportamento que a documentação
 * promete: insert numa faixa além da última cria a faixa. O segundo
 * host ignora o índice e põe o clipe na A1 — o pior caso.
 */
function fakeHost(createsTracks: boolean) {
  const path = "/SFX/Framelab Auto SFX/FLAuto-x.wav";
  const placeholder = { getMediaFilePath: async () => path };
  const voice = { getMediaFilePath: async () => "/voz.wav" };
  const clipAt = (seconds: number, item: typeof placeholder) => ({ seconds, item, getStartTime: async () => ({ seconds }), getProjectItem: async () => item });
  const tracks: Array<Array<ReturnType<typeof clipAt>>> = [[clipAt(0, voice)], [], []];
  const actions: Array<() => void> = [];
  const ppro = {
    TickTime: { createWithSeconds: (seconds: number) => ({ seconds }) },
    Constants: { TrackItemType: { CLIP: 1 }, MediaType: { AUDIO: 2 } },
    ClipProjectItem: { cast: (x: unknown) => x },
    TrackItemSelection: { createEmptySelection: (cb: (s: unknown) => void) => {
      const items: unknown[] = [];
      // Como no 26.5: adiciona e responde false.
      cb({ items, addItem: (i: unknown) => { items.push(i); return false; } });
    } },
  };
  const editor = {
    createInsertProjectItemAction: (item: typeof placeholder, time: { seconds: number }, _v: number, a: number) => () => {
      const target = createsTracks ? a : 0;
      while (tracks.length <= target) tracks.push([]);
      tracks[target].push(clipAt(time.seconds, item));
    },
    createRemoveItemsAction: (selection: { items: unknown[] }) => () => {
      for (const list of tracks) for (const gone of selection.items) { const at = list.indexOf(gone as never); if (at >= 0) list.splice(at, 1); }
    },
  };
  const project = {
    lockedAccess: (fn: () => void) => fn(),
    executeTransaction: (build: (tx: { addAction(a: () => void): void }) => void) => {
      actions.length = 0; build({ addAction: (a) => actions.push(a) }); actions.forEach((a) => a()); return true;
    },
  };
  const sequence = {
    getAudioTrackCount: async () => tracks.length,
    getAudioTrack: async (i: number) => ({ getTrackItems: () => tracks[i] }),
    getEndTime: async () => ({ seconds: 30 }),
  };
  return { ppro, editor, project, sequence, placeholder, path, tracks };
}

describe("addAudioTracks", () => {
  it("cria as faixas pedidas e não deixa marcador nenhum", async () => {
    const h = fakeHost(true);
    await addAudioTracks(h.ppro as never, h.project as never, h.sequence as never, h.editor as never, h.placeholder as never, h.path, 2, () => {});
    assert.equal(h.tracks.length, 5);
    assert.deepEqual(h.tracks.map((t) => t.length), [1, 0, 0, 0, 0]);
  });
  it("se o Premiere não criar a faixa, limpa o marcador e diz o que fazer", async () => {
    const h = fakeHost(false);
    await assert.rejects(
      addAudioTracks(h.ppro as never, h.project as never, h.sequence as never, h.editor as never, h.placeholder as never, h.path, 1, () => {}),
      /não criou a faixa A4.*Adicionar faixas/,
    );
    assert.deepEqual(h.tracks.map((t) => t.length), [1, 0, 0]);
  });
});

describe("recorte do arquivo do SFX", () => {
  it("o pico do arquivo cai no quadro do evento; o clipe começa num quadro", () => {
    const cut = cutAround(0.8, 3, 5, 0.3, 0.4, FRAME);
    near(cut.start / FRAME, Math.round(cut.start / FRAME), 1e-6);
    near(cut.start + (0.8 - cut.inPoint), 5, 1e-9);
    near(cut.outPoint, 1.2, 1e-9);
  });
  it("perto do começo da sequência, começa no arquivo sem inventar in negativo", () => {
    const cut = cutAround(0.8, 3, 0.1, 0.3, 0.4, FRAME);
    assert.equal(cut.inPoint >= 0, true);
    assert.equal(cut.start >= 0, true);
  });
  it("mesmo arquivo, mesmo recorte: um grupo só", () => {
    const g = groupByCut([{ path: "a", inPoint: 0.1, outPoint: 0.3 }, { path: "a", inPoint: 0.1, outPoint: 0.3 }, { path: "a", inPoint: 0.2, outPoint: 0.3 }, { path: "b", inPoint: 0.1, outPoint: 0.3 }]);
    assert.deepEqual(g.map((x) => x.length), [2, 1, 1]);
  });
});

describe("placeCuts", () => {
  it("cada recorte entra com o seu in/out, e o item volta sem in/out no fim", async () => {
    const state = new Map<string, { in: number | null; out: number | null }>();
    const placed: Array<{ path: string; start: number; track: number; in: number | null; out: number | null }> = [];
    const item = (path: string) => ({
      path,
      createClearInOutPointsAction: () => () => state.set(path, { in: null, out: null }),
      createSetInOutPointsAction: (a: { seconds: number }, b: { seconds: number }) => () => state.set(path, { in: a.seconds, out: b.seconds }),
    });
    const items = new Map([["click.wav", item("click.wav")], ["whoosh.wav", item("whoosh.wav")]]);
    const ppro = { TickTime: { createWithSeconds: (seconds: number) => ({ seconds }) }, ClipProjectItem: { cast: (x: unknown) => x } };
    const editor = {
      createOverwriteItemAction: (it: { path: string }, time: { seconds: number }, _v: number, track: number) => () =>
        placed.push({ path: it.path, start: time.seconds, track, ...state.get(it.path)! }),
    };
    const actions: Array<() => void> = [];
    const project = {
      lockedAccess: (fn: () => void) => fn(),
      executeTransaction: (build: (tx: { addAction(a: () => void): void }) => void) => {
        actions.length = 0; build({ addAction: (a) => actions.push(a) }); actions.forEach((a) => a()); return true;
      },
    };
    const p = (path: string, start: number, inPoint: number, outPoint: number) =>
      ({ eventId: `${path}${start}`, path, start, end: start + outPoint - inPoint, track: 2, inPoint, outPoint, gainDb: 0 });
    const planned = [p("click.wav", 1, 0, 0.2), p("click.wav", 2, 0, 0.2), p("whoosh.wav", 3, 0.5, 1.5), p("whoosh.wav", 6, 0.7, 1.5)];
    await placeCuts(ppro as never, project as never, editor as never, planned as never, items as never);
    assert.deepEqual(placed.map((x) => [x.path, x.start, x.in, x.out]), [
      ["click.wav", 1, 0, 0.2], ["click.wav", 2, 0, 0.2], ["whoosh.wav", 3, 0.5, 1.5], ["whoosh.wav", 6, 0.7, 1.5],
    ]);
    assert.deepEqual([...state.values()], [{ in: null, out: null }, { in: null, out: null }]);
  });
});
