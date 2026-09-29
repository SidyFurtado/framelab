/**
 * A busca do SFX: "Clic", pausa, a lista se redesenha e o UXP seleciona
 * o texto todo — o "k" seguinte apagava tudo. A seleção chega DEPOIS do
 * redesenho, e é esse atraso que os testes reproduzem.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardCaret, repairReplacement } from "../src/tools/sfx/caretGuard";

type Listener = (event: any) => void;

function fakeField() {
  const listeners = new Map<string, Listener[]>();
  const field = {
    value: "",
    selectionStart: 0 as number | null,
    selectionEnd: 0 as number | null,
    setSelectionRange(start: number, end: number) {
      field.selectionStart = start;
      field.selectionEnd = end;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fire(type: string, event: any = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ key: "", ...event });
    },
    /** O editor digita uma letra: o campo muda e o `input` sai. */
    type(text: string) {
      const start = field.selectionStart ?? 0;
      const end = field.selectionEnd ?? start;
      field.fire("keydown", { key: text });
      const s = field.selectionStart ?? start;
      const e = field.selectionEnd ?? end;
      field.value = field.value.slice(0, s) + text + field.value.slice(e);
      field.selectionStart = field.selectionEnd = s + text.length;
      field.fire("input");
    },
    /**
     * Como o UXP entrega a tecla digitando rápido: o campo troca o texto
     * primeiro, o `input` sai, e o keydown chega ao JS só depois.
     */
    typeLate(text: string) {
      const s = field.selectionStart ?? 0;
      const e = field.selectionEnd ?? s;
      field.value = field.value.slice(0, s) + text + field.value.slice(e);
      field.selectionStart = field.selectionEnd = s + text.length;
      field.fire("input");
      field.fire("keydown", { key: text });
    },
    selectAll() {
      field.selectionStart = 0;
      field.selectionEnd = field.value.length;
    },
  };
  return field;
}

function setup() {
  const field = fakeField();
  const queue: Array<() => void> = [];
  const guard = guardCaret(field, {
    activeElement: () => field,
    later: (run) => void queue.push(run),
  });
  field.fire("focus");
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return { field, guard, flush };
}

describe("guardCaret", () => {
  it("a seleção que o UXP faz depois do redesenho é desfeita", () => {
    const { field, guard, flush } = setup();
    for (const letter of "Clic") field.type(letter);
    guard.around(() => undefined);
    field.selectAll(); // o UXP, um instante depois
    flush();
    assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 4]);
    field.type("k");
    assert.equal(field.value, "Click");
  });

  it("se a seleção escapar das conferências, a tecla ainda não apaga tudo", () => {
    const { field, guard, flush } = setup();
    for (const letter of "Clic") field.type(letter);
    guard.around(() => undefined);
    flush();
    field.selectAll(); // chegou depois de todas as conferências
    field.type("k");
    assert.equal(field.value, "Click");
  });

  it("o cursor no meio do texto volta para o meio", () => {
    const { field, guard, flush } = setup();
    for (const letter of "Clck") field.type(letter);
    field.selectionStart = field.selectionEnd = 2;
    field.fire("keyup", { key: "ArrowLeft" });
    guard.around(() => undefined);
    field.selectAll();
    flush();
    field.type("i");
    assert.equal(field.value, "Click");
  });

  it("Cmd+A do editor é dele: a letra substitui tudo, como ele pediu", () => {
    const { field, guard, flush } = setup();
    for (const letter of "whoosh") field.type(letter);
    field.selectAll();
    field.fire("keyup", { key: "a", metaKey: true });
    guard.around(() => undefined);
    flush();
    field.type("h");
    assert.equal(field.value, "h");
  });

  it("duplo clique seleciona a palavra e a guarda respeita", () => {
    const { field, flush } = setup();
    for (const letter of "hit") field.type(letter);
    field.selectAll();
    field.fire("dblclick");
    flush();
    field.type("x");
    assert.equal(field.value, "x");
  });

  it("sem foco no campo, nada é mexido", () => {
    const field = fakeField();
    const queue: Array<() => void> = [];
    const guard = guardCaret(field, { activeElement: () => null, later: (run) => void queue.push(run) });
    field.fire("focus");
    for (const letter of "riser") field.type(letter);
    field.fire("blur");
    guard.around(() => undefined);
    field.selectAll();
    while (queue.length) queue.shift()!();
    assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 5]);
  });

  it("sem setSelectionRange, o cursor vai pelos campos de seleção", () => {
    const { field, guard, flush } = setup();
    for (const letter of "Clic") field.type(letter);
    (field as any).setSelectionRange = undefined;
    guard.around(() => undefined);
    field.selectAll();
    flush();
    assert.deepEqual([field.selectionStart, field.selectionEnd], [4, 4]);
  });

  it("digitando rápido: o texto já foi trocado quando o JS vê a tecla, e a busca é remontada", () => {
    const { field, guard } = setup();
    for (const letter of "Clic") field.typeLate(letter);
    guard.around(() => undefined);
    field.selectAll(); // o UXP seleciona, e a tecla chega antes de qualquer conferência
    field.typeLate("k");
    assert.equal(field.value, "Click");
    assert.deepEqual([field.selectionStart, field.selectionEnd], [5, 5]);
    field.typeLate("s");
    assert.equal(field.value, "Clicks");
  });

  it("digitando rápido no meio do texto, a letra entra no meio", () => {
    const { field, guard } = setup();
    for (const letter of "Clck") field.typeLate(letter);
    field.selectionStart = field.selectionEnd = 2;
    field.fire("mouseup");
    guard.around(() => undefined);
    field.selectAll();
    field.typeLate("i");
    assert.equal(field.value, "Click");
    assert.deepEqual([field.selectionStart, field.selectionEnd], [3, 3]);
  });

  it("depois de limpar a busca pelo código, a próxima letra começa do zero", () => {
    const { field, guard } = setup();
    for (const letter of "Clic") field.typeLate(letter);
    field.value = "";
    field.selectionStart = field.selectionEnd = 0;
    guard.sync();
    field.typeLate("w");
    assert.equal(field.value, "w");
  });

  it("Cmd+A e uma letra antes de soltar o A: substitui tudo", () => {
    const { field } = setup();
    for (const letter of "whoosh") field.typeLate(letter);
    field.selectAll();
    field.fire("keydown", { key: "a", metaKey: true });
    field.typeLate("h");
    assert.equal(field.value, "h");
  });

  it("Cmd+Z não é remontado", () => {
    const { field } = setup();
    for (const letter of "riser") field.typeLate(letter);
    field.fire("keydown", { key: "z", metaKey: true });
    field.value = "r";
    field.selectionStart = field.selectionEnd = 1;
    field.fire("input");
    assert.equal(field.value, "r");
  });
});

describe("repairReplacement", () => {
  const at = (value: string, start: number, end = start) => ({ value, start, end });

  it("edições de verdade ficam como estão", () => {
    assert.equal(repairReplacement(at("Clic", 4), "Click"), null, "letra no fim");
    assert.equal(repairReplacement(at("Clck", 2), "Click"), null, "letra no meio");
    assert.equal(repairReplacement(at("Clic", 4), "Cli"), null, "backspace");
    assert.equal(repairReplacement(at("Clic", 0), "lic"), null, "delete para a frente");
    assert.equal(repairReplacement(at("hit big", 7), "hit "), null, "Option+Delete apaga a palavra");
    assert.equal(repairReplacement(at("Clic", 4), ""), null, "Cmd+Delete, ou não dá para saber");
    assert.equal(repairReplacement(at("hit", 3), "hit whoosh"), null, "colar");
    assert.equal(repairReplacement(at("big hit", 4, 7), "big boom"), null, "trocar o que o editor selecionou");
    assert.equal(repairReplacement(at("whoosh", 0, 6), "h"), null, "tudo selecionado pelo editor");
  });

  it("o texto trocado inteiro pela letra digitada é remontado no cursor", () => {
    assert.deepEqual(repairReplacement(at("Clic", 4), "k"), at("Click", 5));
    assert.deepEqual(repairReplacement(at("Clic", 4), "C"), at("ClicC", 5), "mesmo quando a letra repete a primeira");
    assert.deepEqual(repairReplacement(at("Clic", 4), " "), at("Clic ", 5));
    assert.deepEqual(repairReplacement(at("Clck", 2), "i"), at("Click", 3));
    assert.deepEqual(repairReplacement(at("Clic", 4), "ks"), at("Clicks", 6), "rajada de teclas");
  });
});
