/**
 * A ordem do corte e a volta atrás automática.
 *
 * O caso que este arquivo existe para travar: a reescrita falha DEPOIS
 * de os originais já terem saído da timeline. Antes, isso devolvia um
 * buraco na montagem com um recado pedindo para o editor clicar em
 * "Desfazer corte" — e quem fechasse o painel antes de ler perdia a
 * montagem, porque o snapshot só existia em memória.
 *
 * A regra provada aqui: passada a primeira remoção, a operação termina
 * com o corte inteiro aplicado ou com a timeline de volta ao que era. O
 * terceiro final — a volta atrás também falhar — existe, e tem de gritar
 * sem engolir o erro original nem descartar o material de recuperação.
 *
 * Nada de lógica de edição aqui: os três passos (remover, registrar,
 * escrever) são funções que o teste faz falhar onde quiser. A máquina de
 * estados é a única coisa sob teste.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runCutTransaction,
  type CutRun,
  type StepResult,
} from "../src/tools/silence/cutTransaction";

const OK: StepResult = { ok: true };
const fail = (message: string): StepResult => ({ ok: false, message });

/** Um bloco de mentira. `S` é só o rótulo, como o snapshot real é. */
interface FakeOptions {
  failRemove?: string;
  failWrite?: string;
  throwRemove?: unknown;
  throwWrite?: unknown;
}

function run(
  label: string,
  log: string[],
  options: FakeOptions = {}
): CutRun<string> {
  return {
    async remove() {
      log.push(`remove:${label}`);
      if (options.throwRemove !== undefined) {
        throw options.throwRemove;
      }
      return options.failRemove ? fail(options.failRemove) : OK;
    },
    snapshot() {
      log.push(`snapshot:${label}`);
      return label;
    },
    async write() {
      log.push(`write:${label}`);
      if (options.throwWrite !== undefined) {
        throw options.throwWrite;
      }
      return options.failWrite ? fail(options.failWrite) : OK;
    },
  };
}

/** Uma volta atrás que anota o que lhe foi entregue. */
function rollback(log: string[], failure?: string | { throws: unknown }) {
  const seen: string[][] = [];
  return {
    seen,
    fn: async (runs: readonly string[]): Promise<StepResult> => {
      log.push(`rollback:${runs.join("+")}`);
      seen.push([...runs]);
      if (failure && typeof failure === "object" && "throws" in failure) {
        throw failure.throws;
      }
      return failure ? fail(failure as string) : OK;
    },
  };
}

// ── sucesso ────────────────────────────────────────────────────────

describe("runCutTransaction · sucesso", () => {
  it("roda os três passos de cada bloco, na ordem, e não desfaz nada", async () => {
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [run("a", log), run("b", log)],
      back.fn
    );

    assert.equal(outcome.kind, "done");
    assert.deepEqual(outcome.kind === "done" ? outcome.runs : null, ["a", "b"]);
    // O registro fica ENTRE a remoção e a escrita. É essa ordem que faz
    // a volta atrás existir para o bloco que está sendo escrito.
    assert.deepEqual(log, [
      "remove:a",
      "snapshot:a",
      "write:a",
      "remove:b",
      "snapshot:b",
      "write:b",
    ]);
    assert.deepEqual(back.seen, []);
  });

  it("lote vazio termina sem tocar em nada", async () => {
    const log: string[] = [];
    const back = rollback(log);
    const outcome = await runCutTransaction([], back.fn);
    assert.equal(outcome.kind, "done");
    assert.deepEqual(log, []);
  });
});

// ── falha ANTES da primeira mutação ────────────────────────────────

describe("runCutTransaction · falha antes de mutar", () => {
  it("a primeira remoção falha: nada a desfazer, e o erro sai cru", async () => {
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [run("a", log, { failRemove: "clipe não está mais lá" }), run("b", log)],
      back.fn
    );

    assert.equal(outcome.kind, "untouched");
    assert.equal(
      outcome.kind === "untouched" ? outcome.cause : null,
      "clipe não está mais lá"
    );
    // Não desfaz, e não segue para o bloco seguinte.
    assert.deepEqual(log, ["remove:a"]);
    assert.deepEqual(back.seen, []);
  });

  it("a primeira remoção estoura: ainda é 'intacto', não crítico", async () => {
    const log: string[] = [];
    const back = rollback(log);
    const outcome = await runCutTransaction(
      [run("a", log, { throwRemove: new Error("script object no longer valid") })],
      back.fn
    );
    assert.equal(outcome.kind, "untouched");
    assert.match(
      outcome.kind === "untouched" ? outcome.cause : "",
      /script object no longer valid/
    );
    assert.deepEqual(back.seen, []);
  });
});

// ── falha DEPOIS da primeira mutação ───────────────────────────────

describe("runCutTransaction · falha depois de mutar, com volta atrás", () => {
  it("falha na escrita do PRIMEIRO bloco: restaura esse bloco", async () => {
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [run("a", log, { failWrite: "overwrite recusado" }), run("b", log)],
      back.fn
    );

    assert.equal(outcome.kind, "restored");
    assert.equal(
      outcome.kind === "restored" ? outcome.cause : null,
      "overwrite recusado"
    );
    // O bloco que falhou entra na volta atrás — ele é o que tem o buraco.
    assert.deepEqual(back.seen, [["a"]]);
    // E o bloco seguinte nunca começa.
    assert.deepEqual(log, ["remove:a", "snapshot:a", "write:a", "rollback:a"]);
  });

  it("falha no MEIO da reconstrução, com blocos já prontos: todos voltam", async () => {
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [
        run("a", log),
        run("b", log),
        run("c", log, { failWrite: "disco recusou" }),
        run("d", log),
      ],
      back.fn
    );

    assert.equal(outcome.kind, "restored");
    // Os dois prontos E o que quebrou no meio: a timeline inteira volta,
    // não só o bloco defeituoso. Corte pela metade não é um final.
    assert.deepEqual(back.seen, [["a", "b", "c"]]);
    assert.ok(!log.includes("remove:d"));
  });

  it("a REMOÇÃO de um bloco posterior falha: os anteriores voltam", async () => {
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [run("a", log), run("b", log, { failRemove: "clipe sumiu" })],
      back.fn
    );

    assert.equal(outcome.kind, "restored");
    assert.equal(outcome.kind === "restored" ? outcome.cause : null, "clipe sumiu");
    // "b" não foi registrado (não houve remoção); "a" estava pronto e volta.
    assert.deepEqual(back.seen, [["a"]]);
  });

  it("a escrita ESTOURA em vez de responder: mesma volta atrás", async () => {
    // Era por aqui que o snapshot se perdia: a exceção subia até o
    // `catch` de fora, que devolvia `snapshot: null` com a timeline já
    // cortada pela metade.
    const log: string[] = [];
    const back = rollback(log);

    const outcome = await runCutTransaction(
      [run("a", log, { throwWrite: new Error("transação caiu") })],
      back.fn
    );

    assert.equal(outcome.kind, "restored");
    assert.match(outcome.kind === "restored" ? outcome.cause : "", /transação caiu/);
    assert.deepEqual(back.seen, [["a"]]);
  });

  it("o erro original sobrevive à volta atrás bem-sucedida", async () => {
    const log: string[] = [];
    const back = rollback(log);
    const outcome = await runCutTransaction(
      [run("a", log, { failWrite: "a causa raiz, por extenso" })],
      back.fn
    );
    assert.equal(
      outcome.kind === "restored" ? outcome.cause : null,
      "a causa raiz, por extenso"
    );
  });
});

// ── a volta atrás também falha ─────────────────────────────────────

describe("runCutTransaction · a volta atrás falha", () => {
  it("reporta crítico com OS DOIS erros e preserva o material", async () => {
    const log: string[] = [];
    const back = rollback(log, "clearRange recusou a região");

    const outcome = await runCutTransaction(
      [run("a", log), run("b", log, { failWrite: "overwrite recusado" })],
      back.fn
    );

    assert.equal(outcome.kind, "critical");
    if (outcome.kind !== "critical") return;
    // Nenhum dos dois é engolido.
    assert.equal(outcome.cause, "overwrite recusado");
    assert.equal(outcome.rollbackCause, "clearRange recusou a região");
    // E o snapshot dos blocos tocados SAI inteiro: é o único registro
    // do que a timeline era, e o que mantém o Desfazer manual de pé.
    assert.deepEqual(outcome.runs, ["a", "b"]);
  });

  it("uma volta atrás que ESTOURA também é crítica, não silêncio", async () => {
    const log: string[] = [];
    const back = rollback(log, { throws: new Error("host não respondeu") });

    const outcome = await runCutTransaction(
      [run("a", log, { failWrite: "escrita falhou" })],
      back.fn
    );

    assert.equal(outcome.kind, "critical");
    if (outcome.kind !== "critical") return;
    assert.equal(outcome.cause, "escrita falhou");
    assert.match(outcome.rollbackCause, /host não respondeu/);
    assert.deepEqual(outcome.runs, ["a"]);
  });

  it("nunca lança: todo final é um outcome", async () => {
    const log: string[] = [];
    const back = rollback(log, { throws: "string crua" });
    await assert.doesNotReject(() =>
      runCutTransaction(
        [run("a", log, { throwWrite: "também string crua" })],
        back.fn
      )
    );
  });

  it("o material de recuperação não é descartado nem quando tudo falha", async () => {
    const log: string[] = [];
    const back = rollback(log, "falhou");
    const outcome = await runCutTransaction(
      [run("a", log), run("b", log), run("c", log, { failWrite: "x" })],
      back.fn
    );
    assert.equal(outcome.kind, "critical");
    // Os três: os dois prontos e o que quebrou. Nenhum registro perdido.
    assert.deepEqual(outcome.kind === "critical" ? outcome.runs : null, [
      "a",
      "b",
      "c",
    ]);
  });
});
