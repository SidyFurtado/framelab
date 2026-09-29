/**
 * Identidade por execução na extração de áudio e na cópia da legenda.
 *
 * O caso que este arquivo existe para travar: o assistente executa o
 * arquivo que o ticket NOMEIA, lendo-o na hora de executar. Com o script
 * num nome fixo, um ticket atrasado — fila longa, ou a queda para o
 * Terminal já disparada — rodava o texto da execução SEGUINTE.
 *
 *   • no Silêncios: dois ffmpeg em paralelo sobre os mesmos arquivos de
 *     PCM, com risco de um `.wav` truncado que a detecção depois lê como
 *     onda válida;
 *   • no Traduzir: pior — o arquivo de SAÍDA também era fixo, então quem
 *     pediu a legenda A recebia o conteúdo da B, com "ok" no estado e
 *     nada na tela. Uma tradução da legenda errada, em silêncio.
 *
 * O que se prova aqui é a identidade e o isolamento dos artefatos.
 * `extractAudio` e `copyViaAgent` falam com o host; os geradores de nome
 * e de texto são puros.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractionRun,
  extractionScript,
  runFiles,
  type AudioJob,
} from "../src/tools/silence/ffmpeg";
import { copyRun, copyRunFiles, copyScript } from "../src/tools/translate/source";

const WORK = "/Users/editor/Library/Caches/EditToolbox";

const JOBS_A: AudioJob[] = [
  {
    file: "pcm-a-1.raw",
    mediaPath: "/Volumes/Drive/bruto A.mov",
    offsetSeconds: 0,
    durationSeconds: 12.5,
  },
];
const JOBS_B: AudioJob[] = [
  {
    file: "pcm-b-1.raw",
    mediaPath: "/Volumes/Drive/bruto B.mov",
    offsetSeconds: 3,
    durationSeconds: 40,
  },
];

// ── Silêncios ──────────────────────────────────────────────────────

describe("extractionRun · uma identidade por extração", () => {
  it("duas extrações recebem nomes de script diferentes", () => {
    const a = extractionRun(false);
    const b = extractionRun(false);
    assert.notEqual(a.script, b.script);
    assert.notEqual(a.result, b.result);
    assert.notEqual(a.progress, b.progress);
    assert.notEqual(a.started, b.started);
  });

  it("nem no MESMO milissegundo os nomes se repetem", () => {
    // Duas execuções com a mesma etiqueta compartilhariam TODOS os
    // artefatos — o defeito de volta, e pior.
    const runs = Array.from({ length: 200 }, () => extractionRun(false));
    assert.equal(new Set(runs.map((run) => run.script)).size, runs.length);
    assert.equal(new Set(runs.map((run) => run.result)).size, runs.length);
  });

  it("o script carimbado respeita a extensão de cada plataforma", () => {
    assert.match(extractionRun(false).script, /^extract-.+\.command$/);
    assert.match(extractionRun(true).script, /^extract-.+\.bat$/);
  });

  it("a grafia de resultado, progresso e início não mudou de contrato", () => {
    const run = extractionRun(false);
    assert.match(run.result, /^sil-.+-result\.json$/);
    assert.match(run.progress, /^sil-.+-progress\.txt$/);
    assert.match(run.started, /^sil-.+-started\.txt$/);
  });

  it("os quatro artefatos carregam a etiqueta da própria execução", () => {
    const run = extractionRun(false);
    for (const name of runFiles(run)) {
      assert.ok(name.includes(run.tag), `${name} não carrega a etiqueta`);
    }
    assert.equal(runFiles(run).length, 4, "o script tem de estar no rodízio");
    assert.ok(runFiles(run).includes(run.script));
  });

  it("três execuções rápidas não compartilham artefato nenhum", () => {
    const runs = [extractionRun(false), extractionRun(false), extractionRun(false)];
    const seen = new Set<string>();
    for (const run of runs) {
      for (const name of runFiles(run)) {
        assert.ok(!seen.has(name), `${name} é de mais de uma execução`);
        seen.add(name);
      }
    }
    assert.equal(seen.size, 12);
  });
});

describe("extractionScript · A executa A, B executa B", () => {
  it("cada script escreve só nos SEUS arquivos de protocolo", () => {
    const a = extractionRun(false);
    const b = extractionRun(false);
    const scriptA = extractionScript(a, JOBS_A, WORK, "");
    const scriptB = extractionScript(b, JOBS_B, WORK, "");

    assert.ok(scriptA.includes(a.result));
    assert.ok(scriptA.includes(a.progress));
    assert.ok(scriptA.includes(a.started));
    assert.ok(!scriptA.includes(b.result), "A escreveria no resultado de B");
    assert.ok(!scriptA.includes(b.progress));
    assert.ok(!scriptA.includes(b.started));
    assert.ok(!scriptB.includes(a.result), "B escreveria no resultado de A");
  });

  it("A mantém o seu comando depois de B ser criada", () => {
    // O ponto do defeito: antes, B reescrevia o ARQUIVO de A. Agora o
    // texto de A é um valor, e o nome do arquivo dele é só dele.
    const a = extractionRun(false);
    const scriptA = extractionScript(a, JOBS_A, WORK, "");
    const antes = scriptA;

    const b = extractionRun(false);
    const scriptB = extractionScript(b, JOBS_B, WORK, "");

    assert.equal(scriptA, antes);
    assert.notEqual(scriptA, scriptB);
    assert.ok(!scriptA.includes(b.tag), "a etiqueta de B apareceu no script de A");
  });

  it("cada script trata o SEU trecho de mídia, com os argumentos dele", () => {
    const scriptA = extractionScript(extractionRun(false), JOBS_A, WORK, "");
    const scriptB = extractionScript(extractionRun(false), JOBS_B, WORK, "");

    assert.ok(scriptA.includes("pcm-a-1.raw"));
    assert.ok(scriptA.includes("bruto A.mov"));
    assert.ok(!scriptA.includes("pcm-b-1.raw"), "A escreveria o PCM de B");

    assert.ok(scriptB.includes("pcm-b-1.raw"));
    assert.ok(scriptB.includes("bruto B.mov"));
    // Os recortes de cada um sobrevivem à substituição de nomes.
    assert.ok(scriptA.includes("12.5") && scriptB.includes("40"));
  });

  it("caminho com espaço continua citado nas duas plataformas", () => {
    const run = extractionRun(false);
    const unix = extractionScript(run, JOBS_A, WORK, "", false);
    assert.ok(unix.includes("'/Volumes/Drive/bruto A.mov'"));

    const win = extractionScript(extractionRun(true), JOBS_A, "C:\\Work", "", true);
    assert.ok(win.includes('"/Volumes/Drive/bruto A.mov"') || win.includes("bruto A.mov"));
  });

  it("uma execução só continua igual à de antes", () => {
    const run = extractionRun(false);
    const script = extractionScript(run, JOBS_A, WORK, "");
    assert.ok(script.startsWith("#!/bin/bash"));
    // O carimbo de início vem antes do trabalho, e o resultado no fim —
    // é o protocolo que o polling lê.
    assert.ok(script.indexOf(run.started) < script.indexOf(run.result));
    // O `mv` do temporário continua lá: é o que evita ler JSON pela metade.
    assert.ok(script.includes(`${run.result}.tmp`));
  });

  it("o ffmpeg escolhido à mão entra no script", () => {
    const script = extractionScript(
      extractionRun(false),
      JOBS_A,
      WORK,
      "/opt/homebrew/bin/ffmpeg"
    );
    assert.ok(script.includes("/opt/homebrew/bin/ffmpeg"));
  });
});

describe("runFiles · o rodízio alcança só a execução encerrada", () => {
  it("as listas de duas execuções são disjuntas", () => {
    const a = extractionRun(false);
    const b = extractionRun(false);
    const mine = new Set(runFiles(a));
    for (const name of runFiles(b)) {
      assert.ok(!mine.has(name), `${name} sairia no rodízio de A`);
    }
  });

  it("o script antigo entra no rodízio — senão a pasta cresce para sempre", () => {
    const a = extractionRun(false);
    assert.ok(
      runFiles(a).some((name) => name.startsWith("extract-")),
      "o script carimbado ficaria na pasta sem ninguém para apagá-lo"
    );
  });

  it("o PCM dos jobs não entra: ele é carimbado por quem monta os jobs", () => {
    const list = runFiles(extractionRun(false));
    assert.ok(!list.some((name) => name.includes("pcm-")));
  });
});

// ── Traduzir ───────────────────────────────────────────────────────

describe("copyRun · o mesmo isolamento na cópia da legenda", () => {
  it("duas cópias recebem script, saída e estado diferentes", () => {
    const a = copyRun();
    const b = copyRun();
    assert.notEqual(a.script, b.script);
    // A SAÍDA é o que tornava este caso pior: com nome fixo, A lia o
    // conteúdo que B copiou.
    assert.notEqual(a.out, b.out);
    assert.notEqual(a.done, b.done);
  });

  it("nem no mesmo milissegundo os nomes se repetem", () => {
    const runs = Array.from({ length: 200 }, () => copyRun());
    assert.equal(new Set(runs.map((run) => run.script)).size, runs.length);
    assert.equal(new Set(runs.map((run) => run.out)).size, runs.length);
  });

  it("os três artefatos carregam a etiqueta, e o script está na limpeza", () => {
    const run = copyRun();
    for (const name of copyRunFiles(run)) {
      assert.ok(name.includes(run.tag));
    }
    assert.equal(copyRunFiles(run).length, 3);
    assert.ok(copyRunFiles(run).includes(run.script));
  });

  it("cada script copia PARA a sua saída e relata NO seu estado", () => {
    const a = copyRun();
    const b = copyRun();
    const scriptA = copyScript(a, "/Users/ed/Desktop/legenda A.srt", WORK);
    const scriptB = copyScript(b, "/Users/ed/Desktop/legenda B.srt", WORK);

    assert.ok(scriptA.includes(a.out) && scriptA.includes(a.done));
    assert.ok(!scriptA.includes(b.out), "A copiaria para a saída de B");
    assert.ok(!scriptA.includes(b.done));
    assert.ok(scriptB.includes(b.out));
    assert.ok(!scriptB.includes(a.out), "B copiaria para a saída de A");
  });

  it("cada script copia o SEU arquivo de origem", () => {
    const scriptA = copyScript(copyRun(), "/Users/ed/legenda A.srt", WORK);
    const scriptB = copyScript(copyRun(), "/Users/ed/legenda B.srt", WORK);
    assert.ok(scriptA.includes("legenda A.srt"));
    assert.ok(!scriptA.includes("legenda B.srt"), "A copiaria a legenda de B");
    assert.ok(scriptB.includes("legenda B.srt"));
  });

  it("A mantém o seu comando depois de B ser criada", () => {
    const a = copyRun();
    const scriptA = copyScript(a, "/Users/ed/A.srt", WORK);
    const antes = scriptA;
    const b = copyRun();
    copyScript(b, "/Users/ed/B.srt", WORK);
    assert.equal(scriptA, antes);
    assert.ok(!scriptA.includes(b.tag));
  });

  it("três cópias rápidas não compartilham artefato nenhum", () => {
    const runs = [copyRun(), copyRun(), copyRun()];
    const seen = new Set<string>();
    for (const run of runs) {
      for (const name of copyRunFiles(run)) {
        assert.ok(!seen.has(name), `${name} é de mais de uma cópia`);
        seen.add(name);
      }
    }
    assert.equal(seen.size, 9);
  });

  it("as listas de limpeza de duas cópias são disjuntas", () => {
    const mine = new Set(copyRunFiles(copyRun()));
    for (const name of copyRunFiles(copyRun())) {
      assert.ok(!mine.has(name));
    }
  });

  it("espaço e apóstrofo no caminho continuam escapados", () => {
    const script = copyScript(copyRun(), "/Users/ed/editor's cut.srt", WORK);
    assert.ok(script.includes(`'/Users/ed/editor'\\''s cut.srt'`));
    assert.ok(script.includes(`WORK='${WORK}'`));
  });

  it("uma cópia só continua igual à de antes", () => {
    const run = copyRun();
    const script = copyScript(run, "/Users/ed/A.srt", WORK);
    assert.ok(script.startsWith("#!/bin/bash"));
    assert.ok(script.includes("set -u"));
    // O erro do `cp` continua indo para o estado junto de "falhou".
    assert.ok(script.includes(`printf 'falhou %s' "$ERR"`));
    assert.ok(script.includes("printf ok"));
  });
});

// ── o cruzamento entre os dois fluxos ──────────────────────────────

describe("os dois fluxos não se alcançam", () => {
  it("nenhum nome de extração colide com um nome de cópia", () => {
    const extraction = new Set(runFiles(extractionRun(false)));
    for (const name of copyRunFiles(copyRun())) {
      assert.ok(!extraction.has(name));
    }
  });
});
