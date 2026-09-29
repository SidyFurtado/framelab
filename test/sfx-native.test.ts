/**
 * A identidade de cada prévia de SFX.
 *
 * O caso que este arquivo existe para travar: o script da prévia tinha
 * nome FIXO, e o assistente executa o arquivo que o ticket nomeia,
 * lendo-o na hora de executar. Entre escrever e executar cabe outra
 * prévia — ouvir dois sons em sequência é o gesto de quem procura um
 * efeito numa lista. Então:
 *
 *   1. A escreve o script          4. B toca duas vezes
 *   2. B sobrescreve o MESMO arquivo   5. A espera um carimbo que
 *   3. o ticket de A executa B         nunca vem e "não respondeu"
 *
 * O arquivo de resposta também era fixo, então B ainda apagava a
 * resposta de A — um segundo caminho para o mesmo falso timeout.
 *
 * O que se prova aqui é a identidade e o isolamento dos artefatos, que é
 * onde estava o defeito. `playNative` fala com o host e com o
 * assistente; `previewRun`, `previewScript` e `runFiles` são puros.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeFileOf,
  previewRun,
  previewScript,
  runFiles,
  type PreviewRun,
} from "../src/tools/sfx/native";
import type { Workspace } from "../src/tools/silence/workspace";

const SPACE: Workspace = {
  fsBase: "plugin-data:/edit-toolbox-audio",
  nativeBase: "/Users/editor/Library/Caches/EditToolbox",
  sync: true,
  origin: "teste",
};

const SOUND_A = "/Volumes/Drive/SFX/whoosh 1.wav";
const SOUND_B = "/Volumes/Drive/SFX/impacto 2.mp3";

/** O caminho nativo de um artefato, como o script o escreve. */
function pathOf(name: string): string {
  return `${SPACE.nativeBase}/${name}`;
}

describe("previewRun · uma identidade por chamada", () => {
  it("duas chamadas recebem script, resposta e erro diferentes", () => {
    const a = previewRun();
    const b = previewRun();

    assert.notEqual(a.tag, b.tag);
    assert.notEqual(a.script, b.script);
    assert.notEqual(a.started, b.started);
    assert.notEqual(a.errors, b.errors);
  });

  it("nem no MESMO milissegundo os nomes se repetem", () => {
    // É o cenário real: dois cliques seguidos. Um carimbo só de relógio
    // repetia aqui, e repetir é o defeito inteiro de volta.
    const runs = Array.from({ length: 200 }, () => previewRun());
    const scripts = new Set(runs.map((run) => run.script));
    const starts = new Set(runs.map((run) => run.started));
    assert.equal(scripts.size, runs.length);
    assert.equal(starts.size, runs.length);
  });

  it("a ordem de criação fica legível no nome: A antes de B", () => {
    // A fila é do `runner.ts` e não mudou; o que se garante aqui é que o
    // mapeamento ticket → script é 1:1 e que a ordem é recuperável.
    const a = previewRun();
    const b = previewRun();
    const c = previewRun();
    const seq = (run: PreviewRun): number =>
      Number.parseInt(run.tag.split("-")[1], 36);
    assert.ok(seq(a) < seq(b), "B não veio depois de A");
    assert.ok(seq(b) < seq(c), "C não veio depois de B");
  });

  it("os três artefatos carregam a etiqueta da própria prévia", () => {
    const run = previewRun();
    for (const name of runFiles(run)) {
      assert.ok(name.includes(run.tag), `${name} não carrega a etiqueta`);
    }
  });
});

describe("previewScript · A executa A, B executa B", () => {
  it("cada script aponta para os SEUS arquivos de resposta e de erro", () => {
    const a = previewRun();
    const b = previewRun();
    const scriptA = previewScript(a, SOUND_A, SPACE);
    const scriptB = previewScript(b, SOUND_B, SPACE);

    assert.ok(scriptA.includes(pathOf(a.started)));
    assert.ok(scriptA.includes(pathOf(a.errors)));
    assert.ok(!scriptA.includes(pathOf(b.started)), "A escreveria na resposta de B");
    assert.ok(!scriptA.includes(pathOf(b.errors)), "A escreveria no erro de B");

    assert.ok(scriptB.includes(pathOf(b.started)));
    assert.ok(!scriptB.includes(pathOf(a.started)), "B escreveria na resposta de A");
  });

  it("cada script toca o SEU som", () => {
    const scriptA = previewScript(previewRun(), SOUND_A, SPACE);
    const scriptB = previewScript(previewRun(), SOUND_B, SPACE);
    assert.ok(scriptA.includes(SOUND_A));
    assert.ok(!scriptA.includes(SOUND_B), "A tocaria o som de B");
    assert.ok(scriptB.includes(SOUND_B));
    assert.ok(!scriptB.includes(SOUND_A), "B tocaria o som de A");
  });

  it("A mantém o seu comando depois de B ser criada", () => {
    // O ponto do defeito: antes, criar B reescrevia o arquivo de A.
    // Agora o texto de A é um valor, e B não tem como alcançá-lo — nem o
    // conteúdo, nem o nome do arquivo onde ele vai.
    const a = previewRun();
    const scriptA = previewScript(a, SOUND_A, SPACE);
    const antes = scriptA;

    const b = previewRun();
    const scriptB = previewScript(b, SOUND_B, SPACE);

    assert.equal(scriptA, antes);
    assert.notEqual(scriptA, scriptB);
    assert.ok(scriptA.includes(`"${a.tag} ok"`));
    assert.ok(!scriptA.includes(b.tag), "a etiqueta de B apareceu no script de A");
  });

  it("a etiqueta no carimbo continua sendo a segunda cerca", () => {
    const run = previewRun();
    const script = previewScript(run, SOUND_A, SPACE);
    assert.ok(script.includes(`echo "${run.tag} ok"`));
    assert.ok(script.includes(`echo "${run.tag} falhou`));
  });

  it("três prévias enfileiradas não compartilham nada além do pid", () => {
    const runs = [previewRun(), previewRun(), previewRun()];
    const scripts = runs.map((run, at) => previewScript(run, `/s/${at}.wav`, SPACE));

    // Todo artefato de cada uma é invisível para as outras.
    runs.forEach((mine, at) => {
      runs.forEach((other, other_at) => {
        if (at === other_at) return;
        for (const name of runFiles(other)) {
          assert.ok(
            !scripts[at].includes(pathOf(name)),
            `a prévia ${at} toca o artefato ${name} da prévia ${other_at}`
          );
        }
        assert.ok(!scripts[at].includes(other.tag));
        assert.ok(!runFiles(mine).includes(other.script));
      });
    });

    // O pid é o único compartilhado, e de propósito: é por ele que uma
    // prévia nova cala a anterior e que `stopNative` funciona.
    for (const script of scripts) {
      assert.ok(script.includes(pathOf("sfx-afplay.pid")));
    }
  });

  it("o caminho do som é citado: um nome com espaço não vira dois argumentos", () => {
    const script = previewScript(previewRun(), "/Volumes/Drive/SFX/whoosh 1.wav", SPACE);
    assert.ok(script.includes("'/Volumes/Drive/SFX/whoosh 1.wav'"));
  });

  it("um apóstrofo no nome do arquivo não escapa do argumento", () => {
    // Nome de pasta com apóstrofo existe, e sem escape ele fecha a
    // citação e o resto da linha vira comando.
    const script = previewScript(previewRun(), "/s/editor's cut.wav", SPACE);
    assert.ok(script.includes(`'/s/editor'\\''s cut.wav'`));
    assert.ok(!/afplay '\/s\/editor's/.test(script));
  });

  it("o caminho normal de uma prévia só continua o de antes", () => {
    const run = previewRun();
    const script = previewScript(run, SOUND_A, SPACE);
    // Mata a anterior pelo pid, solta o afplay em segundo plano, guarda
    // o pid, espera um instante e só então confirma.
    const order = ["kill \"$(cat", "nohup /usr/bin/afplay", "echo $P >", "sleep 0.2", "if kill -0 $P"];
    let at = -1;
    for (const piece of order) {
      const found = script.indexOf(piece);
      assert.ok(found > at, `fora de ordem: ${piece}`);
      at = found;
    }
    assert.ok(script.startsWith("#!/bin/bash"));
  });
});

describe("runFiles · a limpeza só alcança a própria prévia", () => {
  it("as listas de duas prévias são disjuntas", () => {
    const a = previewRun();
    const b = previewRun();
    const mine = new Set(runFiles(a));
    for (const name of runFiles(b)) {
      assert.ok(!mine.has(name), `${name} sairia na limpeza de A`);
    }
  });

  it("o pid NÃO entra na limpeza", () => {
    // Apagá-lo no fim de uma prévia cortaria o `stopNative` da que ainda
    // estiver tocando — e é o pid que faz uma prévia calar a anterior.
    const list = runFiles(previewRun());
    assert.ok(!list.some((name) => name.includes("pid")));
    assert.equal(list.length, 3);
  });

  it("o script de stop, compartilhado, não pertence a nenhuma prévia", () => {
    // Ele é reescrito com conteúdo IDÊNTICO a cada chamada (só cita o
    // pid), então sobrescrevê-lo não muda o que é executado.
    const list = runFiles(previewRun());
    assert.ok(!list.includes("sfx-stop.command"));
  });
});

describe("nativeFileOf · inalterado", () => {
  it("devolve o caminho nativo de uma URL file://", () => {
    assert.equal(nativeFileOf("file:///s/whoosh%201.wav"), "/s/whoosh 1.wav");
  });

  it("recusa o que não é arquivo local", () => {
    assert.equal(nativeFileOf("https://exemplo/som.wav"), null);
  });
});
