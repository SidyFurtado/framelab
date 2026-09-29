/**
 * A transação da atualização.
 *
 * O caso que este arquivo existe para travar: uma escrita que falha no
 * MEIO da troca. Antes da transação, isso deixava `index.html` da versão
 * nova ao lado de `index.js` da antiga — um painel que não abre, e sem o
 * atualizador dentro dele para tentar de novo.
 *
 * A regra provada aqui é uma só: ou a instalação antiga inteira, ou a
 * nova inteira. Estado misto é aceitável só quando a própria volta atrás
 * falha — e aí tem de ser dito em voz alta, nunca engolido.
 *
 * A pasta do plugin é uma pasta de mentira em memória, que pode ser
 * mandada falhar em qualquer operação e em qualquer arquivo. Nenhuma
 * asserção depende do UXP.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  installBundle,
  type BundleFile,
  type InstallTarget,
} from "../src/shell/installBundle";

// ── a pasta de mentira ─────────────────────────────────────────────

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function text(data: ArrayBuffer | null | undefined): string | null {
  return data ? new TextDecoder().decode(data) : null;
}

interface FakeOptions {
  /** Falha o write deste nome exato. */
  failWrite?: (name: string, attempt: number) => boolean;
  failRead?: (name: string) => boolean;
  failDelete?: (name: string) => boolean;
  /** Com rename, a troca não reescreve bytes. */
  rename?: boolean;
  failRename?: (name: string) => boolean;
}

function folder(
  initial: Record<string, string>,
  options: FakeOptions = {}
): {
  target: InstallTarget;
  files: Map<string, ArrayBuffer>;
  snapshot(): Record<string, string>;
  writes: string[];
  deletes: string[];
} {
  const files = new Map<string, ArrayBuffer>();
  for (const [name, content] of Object.entries(initial)) {
    files.set(name, bytes(content));
  }
  const writes: string[] = [];
  const deletes: string[] = [];
  const attempts = new Map<string, number>();

  const target: InstallTarget = {
    async writeFile(name, data) {
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      if (options.failWrite?.(name, attempt)) {
        throw new Error(`disco recusou ${name}`);
      }
      writes.push(name);
      files.set(name, data);
    },
    async readFile(name) {
      if (options.failRead?.(name)) {
        throw new Error(`leitura recusada em ${name}`);
      }
      return files.get(name) ?? null;
    },
    async deleteFile(name) {
      if (!files.has(name)) {
        return; // não existir não é falha
      }
      if (options.failDelete?.(name)) {
        throw new Error(`não consegui apagar ${name}`);
      }
      deletes.push(name);
      files.delete(name);
    },
  };

  if (options.rename) {
    target.replaceFrom = async (stagedName, targetName) => {
      if (options.failRename?.(targetName)) {
        throw new Error(`rename recusado em ${targetName}`);
      }
      const held = files.get(stagedName);
      if (!held) {
        throw new Error(`${stagedName} não está lá`);
      }
      files.delete(stagedName);
      files.set(targetName, held);
      writes.push(targetName);
    };
  }

  return {
    target,
    files,
    writes,
    deletes,
    snapshot() {
      const out: Record<string, string> = {};
      for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        out[name] = new TextDecoder().decode(data);
      }
      return out;
    },
  };
}

const BUNDLE: BundleFile[] = [
  { filename: "manifest.json", data: bytes('{"version":"2.0.0"}') },
  { filename: "index.html", data: bytes("<html>novo</html>") },
  { filename: "index.js", data: bytes("console.log('novo')") },
];

const OLD = {
  "manifest.json": '{"version":"1.0.0"}',
  "index.html": "<html>velho</html>",
  "index.js": "console.log('velho')",
};

/** Nenhum rastro da transação sobrou na pasta. */
function noLeftovers(snapshot: Record<string, string>): void {
  const leftovers = Object.keys(snapshot).filter(
    (name) => name.endsWith(".framelab-new") || name.endsWith(".framelab-bak")
  );
  assert.deepEqual(leftovers, [], `sobrou rastro: ${leftovers.join(", ")}`);
}

// ── sucesso ────────────────────────────────────────────────────────

describe("installBundle · sucesso", () => {
  it("instala tudo e limpa os temporários", async () => {
    const disk = folder(OLD);
    const steps: Array<[string, number]> = [];

    const outcome = await installBundle(disk.target, BUNDLE, (step, percent) =>
      steps.push([step, percent])
    );

    assert.equal(outcome.ok, true);
    assert.equal(outcome.critical, false);
    assert.deepEqual(disk.snapshot(), {
      "index.html": "<html>novo</html>",
      "index.js": "console.log('novo')",
      "manifest.json": '{"version":"2.0.0"}',
    });
    noLeftovers(disk.snapshot());
    // A barra continua contando a mesma história, terminando em 100.
    assert.equal(steps[steps.length - 1][1], 100);
    assert.ok(steps.some(([step]) => step.startsWith("Gravando index.js")));
  });

  it("um arquivo novo do bundle, que ainda não existia, também entra", async () => {
    const disk = folder({ "index.js": "velho" });
    const outcome = await installBundle(disk.target, [
      { filename: "index.js", data: bytes("novo") },
      { filename: "index.css", data: bytes(".a{}") },
    ]);
    assert.equal(outcome.ok, true);
    assert.deepEqual(disk.snapshot(), { "index.css": ".a{}", "index.js": "novo" });
  });

  it("com rename disponível, a troca não reescreve bytes", async () => {
    const disk = folder(OLD, { rename: true });
    const outcome = await installBundle(disk.target, BUNDLE);
    assert.equal(outcome.ok, true);
    assert.deepEqual(disk.snapshot(), {
      "index.html": "<html>novo</html>",
      "index.js": "console.log('novo')",
      "manifest.json": '{"version":"2.0.0"}',
    });
    noLeftovers(disk.snapshot());
  });

  it("rename recusado no meio cai para a escrita e ainda instala", async () => {
    const disk = folder(OLD, {
      rename: true,
      failRename: (name) => name === "index.js",
    });
    const outcome = await installBundle(disk.target, BUNDLE);
    assert.equal(outcome.ok, true);
    assert.equal(text(disk.files.get("index.js")), "console.log('novo')");
    noLeftovers(disk.snapshot());
  });

  it("uma limpeza que falha não derruba uma atualização que deu certo", async () => {
    const disk = folder(OLD, { failDelete: (name) => name.endsWith(".framelab-bak") });
    const outcome = await installBundle(disk.target, BUNDLE);
    assert.equal(outcome.ok, true);
    assert.equal(text(disk.files.get("index.js")), "console.log('novo')");
  });
});

// ── falha ANTES do commit: nada é tocado ───────────────────────────

describe("installBundle · falha antes da troca", () => {
  it("o ensaio falha no primeiro arquivo: instalação antiga intacta", async () => {
    const disk = folder(OLD, {
      failWrite: (name) => name === "manifest.json.framelab-new",
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, false);
    assert.match(outcome.message, /Nada foi alterado/);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("o ensaio falha no ÚLTIMO arquivo: nem o primeiro ativo foi tocado", async () => {
    // É o caso do arquivo grande: `index.js` é o que estoura a cota, e
    // ele é o último a ser ensaiado.
    const disk = folder(OLD, {
      failWrite: (name) => name === "index.js.framelab-new",
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /index\.js/);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("não dá para ler o ativo, então não dá para voltar: recusa antes", async () => {
    const disk = folder(OLD, { failRead: (name) => name === "index.html" });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /cópia/);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("não dá para gravar a cópia: recusa antes de trocar", async () => {
    const disk = folder(OLD, {
      failWrite: (name) => name === "index.html.framelab-bak",
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Nada foi alterado/);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("arquivo vazio no lote é recusado sem tocar em nada", async () => {
    const disk = folder(OLD);
    const outcome = await installBundle(disk.target, [
      { filename: "index.js", data: bytes("ok") },
      { filename: "index.html", data: new ArrayBuffer(0) },
    ]);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /vazio/);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("lote sem arquivos é recusado", async () => {
    const disk = folder(OLD);
    const outcome = await installBundle(disk.target, []);
    assert.equal(outcome.ok, false);
    assert.deepEqual(disk.snapshot(), OLD);
  });
});

// ── falha DURANTE o commit: a volta atrás ──────────────────────────

describe("installBundle · falha na troca, com volta atrás", () => {
  it("falha no PRIMEIRO arquivo trocado: volta ao estado antigo", async () => {
    // O ensaio passa (tentativa 1 do `.new`); a troca do ativo falha.
    const disk = folder(OLD, {
      failWrite: (name) => name === "manifest.json",
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, false);
    assert.match(outcome.message, /versão anterior foi restaurada/);
    assert.deepEqual(disk.snapshot(), OLD);
    noLeftovers(disk.snapshot());
  });

  it("falha DEPOIS de dois arquivos já trocados: os dois voltam", async () => {
    const disk = folder(OLD, { failWrite: (name) => name === "index.js" });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, false);
    // O ponto do P0: nenhuma mistura. Nem manifest.json nem index.html
    // ficaram na versão nova.
    assert.deepEqual(disk.snapshot(), OLD);
    assert.deepEqual(outcome.unrestored, []);
    noLeftovers(disk.snapshot());
  });

  it("o mesmo com rename: o que já tinha sido renomeado volta", async () => {
    const disk = folder(OLD, {
      rename: true,
      failRename: (name) => name === "index.js",
      // Sem o caminho de escrita como reserva, a troca falha de verdade.
      failWrite: (name) => name === "index.js",
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, false);
    assert.deepEqual(disk.snapshot(), OLD);
  });

  it("um arquivo que NÃO existia antes é apagado na volta", async () => {
    const disk = folder({ "index.js": "velho" }, {
      failWrite: (name) => name === "index.js",
    });
    const outcome = await installBundle(disk.target, [
      { filename: "index.css", data: bytes(".novo{}") },
      { filename: "index.js", data: bytes("novo") },
    ]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, false);
    // `index.css` não existia: a volta é não existir.
    assert.deepEqual(disk.snapshot(), { "index.js": "velho" });
  });

  it("a cópia NÃO é apagada antes de a troca terminar", async () => {
    // Prova de ordem: no instante em que a troca do último arquivo é
    // tentada, os `.bak` dos anteriores ainda têm de estar na pasta.
    const disk = folder(OLD);
    let bakAtCommitTime: string[] = [];
    const inner = disk.target.writeFile.bind(disk.target);
    disk.target.writeFile = async (name, data) => {
      if (name === "index.js") {
        bakAtCommitTime = Object.keys(disk.snapshot()).filter((f) =>
          f.endsWith(".framelab-bak")
        );
        throw new Error("disco recusou index.js");
      }
      return inner(name, data);
    };

    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.deepEqual(bakAtCommitTime.sort(), [
      "index.html.framelab-bak",
      "index.js.framelab-bak",
      "manifest.json.framelab-bak",
    ]);
    assert.deepEqual(disk.snapshot(), OLD);
  });
});

// ── falha NA volta atrás: o estado que se anuncia ──────────────────

describe("installBundle · a volta atrás falha", () => {
  it("reporta falha CRÍTICA, nomeia o arquivo e preserva a cópia", async () => {
    const disk = folder(OLD, {
      // A troca de index.js falha; a restauração de manifest.json
      // também (é a segunda escrita naquele nome).
      failWrite: (name, attempt) =>
        name === "index.js" || (name === "manifest.json" && attempt === 2),
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.critical, true);
    assert.deepEqual(outcome.unrestored, ["manifest.json"]);
    assert.match(outcome.message, /FALHA CRÍTICA/);
    assert.match(outcome.message, /manifest\.json/);
    // O material de recuperação FICA: é o que permite consertar à mão.
    const snapshot = disk.snapshot();
    assert.equal(snapshot["manifest.json.framelab-bak"], OLD["manifest.json"]);
    assert.equal(snapshot["index.html.framelab-bak"], OLD["index.html"]);
    // E a mensagem ensina o que fazer com eles.
    assert.match(outcome.message, /framelab-bak/);
  });

  it("uma falha na volta não esconde as outras restaurações", async () => {
    const disk = folder(OLD, {
      failWrite: (name, attempt) =>
        name === "index.js" || (name === "index.html" && attempt === 2),
    });
    const outcome = await installBundle(disk.target, BUNDLE);

    assert.equal(outcome.critical, true);
    assert.deepEqual(outcome.unrestored, ["index.html"]);
    // manifest.json voltou ao antigo mesmo com o vizinho falhando.
    assert.equal(text(disk.files.get("manifest.json")), OLD["manifest.json"]);
  });

  it("apagar na volta e não conseguir também é crítico", async () => {
    // O arquivo novo do bundle foi gravado e não sai: a instalação
    // antiga não volta a ser o que era, e isso tem de ser dito.
    const disk = folder({ "index.js": "velho" }, {
      failWrite: (name) => name === "index.js",
      failDelete: (name) => name === "index.css",
    });
    const outcome = await installBundle(disk.target, [
      { filename: "index.css", data: bytes(".novo{}") },
      { filename: "index.js", data: bytes("novo") },
    ]);

    assert.equal(outcome.critical, true);
    assert.deepEqual(outcome.unrestored, ["index.css"]);
  });

  it("nunca lança: todo final é um outcome", async () => {
    const disk = folder(OLD, { failWrite: () => true, failRead: () => true });
    await assert.doesNotReject(() => installBundle(disk.target, BUNDLE));
  });
});
