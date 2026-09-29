/**
 * O portão de versão do Premiere na atualização.
 *
 * O caso que este arquivo existe para travar: `minPremiereVersion` era
 * publicado no `version.json`, declarado no tipo, e **nunca lido**. Uma
 * release que passasse a exigir uma API nova era instalada em cima de um
 * Premiere antigo — o editor autorizava a atualização e ficava com um
 * painel que não abre. A única checagem de host (`checkHostCapabilities`)
 * roda no start SEGUINTE, quando o estrago já foi feito.
 *
 * São dois portões: o da oferta (o selo não aparece) e o da gravação
 * (não baixa nem grava um byte). O segundo existe porque o primeiro é
 * visual, e estado velho, corrida ou chamada direta furam o visual.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { compareVersions } from "../src/bridge/premiere";
import { PluginUpdater } from "../src/shell/updater";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── o comparador puro ──────────────────────────────────────────────

describe("compareVersions · numérico, não textual", () => {
  it("mesma versão dá empate", () => {
    assert.equal(compareVersions("25.0.0", "25.0.0"), 0);
  });

  it("host mais novo vem depois", () => {
    assert.equal(compareVersions("26.5.1", "25.0.0"), 1);
    assert.equal(compareVersions("25.1", "25.0.9"), 1);
  });

  it("host mais antigo vem antes", () => {
    assert.equal(compareVersions("24.6.3", "25.0.0"), -1);
  });

  it("25.10 é MAIOR que 25.9 — onde o texto erra", () => {
    assert.equal(compareVersions("25.10", "25.9"), 1);
    assert.equal(compareVersions("25.9", "25.10"), -1);
    // A prova de que uma comparação de string erraria aqui.
    assert.ok("25.10" < "25.9");
  });

  it("segmento ausente conta como zero: 25 é 25.0 é 25.0.0", () => {
    assert.equal(compareVersions("25", "25.0"), 0);
    assert.equal(compareVersions("25", "25.0.0"), 0);
    assert.equal(compareVersions("25.0.0", "25"), 0);
    assert.equal(compareVersions("25", "25.0.1"), -1);
    assert.equal(compareVersions("25.1", "25"), 1);
  });

  it("um sufixo de build não invalida a versão", () => {
    // Recusar "25.1.0 (Build 42)" seria bloquear quem está em dia.
    assert.equal(compareVersions("25.1.0 (Build 42)", "25.0.0"), 1);
    assert.equal(compareVersions("v25.0.0", "25.0.0"), 0);
    assert.equal(compareVersions(" 25.0.0", "25.0.0"), 0);
  });

  it("o que não é versão devolve null, e não zero", () => {
    // `isNewerVersion` converte lixo em 0.0.0; aqui a dúvida é dúvida.
    assert.equal(compareVersions("", "25.0.0"), null);
    assert.equal(compareVersions("desconhecida", "25.0.0"), null);
    assert.equal(compareVersions("25.0.0", ""), null);
    assert.equal(compareVersions("25.0.0", "muito nova"), null);
    assert.equal(compareVersions("25.0.0", "25.x"), null);
  });
});

// ── os dois portões, de verdade ────────────────────────────────────

/** Um `version.json` de mentira, servido ao updater. */
function servirManifesto(manifest: Record<string, unknown>): { fetches: number } {
  const state = { fetches: 0 };
  globalThis.fetch = (() => {
    state.fetches += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => manifest,
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
  }) as unknown as typeof globalThis.fetch;
  return state;
}

const NOVA = {
  version: "9.9.9",
  releaseDate: "2026-09-25",
  changelog: "",
  downloadUrl: "",
  minPremiereVersion: "25.0.0",
};

function updater(hostVersion: string): PluginUpdater {
  return new PluginUpdater("0.4.1", () => hostVersion);
}

describe("GATE 1 · a oferta", () => {
  it("host exatamente na versão mínima: oferece", async () => {
    servirManifesto(NOVA);
    const result = await updater("25.0.0").checkForUpdates();
    assert.equal(result.hasUpdate, true);
    assert.equal(result.error, undefined);
  });

  it("host acima da mínima: oferece", async () => {
    servirManifesto(NOVA);
    const result = await updater("26.5.1").checkForUpdates();
    assert.equal(result.hasUpdate, true);
  });

  it("host abaixo: NÃO é oferecida, e a frase nomeia as duas versões", async () => {
    servirManifesto(NOVA);
    const result = await updater("24.6.3").checkForUpdates();

    assert.equal(result.hasUpdate, false, "ofereceu uma atualização incompatível");
    assert.match(result.error ?? "", /requer Adobe Premiere Pro 25\.0\.0 ou superior/);
    assert.match(result.error ?? "", /Você está usando 24\.6\.3/);
  });

  it("25.9 não atende um mínimo de 25.10", async () => {
    servirManifesto({ ...NOVA, minPremiereVersion: "25.10" });
    const result = await updater("25.9").checkForUpdates();
    assert.equal(result.hasUpdate, false);
  });

  it("versão do host ilegível: não oferece", async () => {
    servirManifesto(NOVA);
    const result = await updater("").checkForUpdates();
    assert.equal(result.hasUpdate, false);
    assert.match(result.error ?? "", /não consegui descobrir a versão/i);
  });

  it("mínimo mal escrito: não oferece — dúvida não instala", async () => {
    servirManifesto({ ...NOVA, minPremiereVersion: "a mais nova" });
    const result = await updater("26.0.0").checkForUpdates();
    assert.equal(result.hasUpdate, false);
    assert.match(result.error ?? "", /não reconheci a versão/i);
  });

  it("manifesto SEM o campo continua instalável: ele é opcional", async () => {
    // Releases antigas não traziam `minPremiereVersion`; ausência não
    // pode bloquear uma atualização que sempre funcionou.
    const { minPremiereVersion: _ignorado, ...semCampo } = NOVA;
    servirManifesto(semCampo);
    const result = await updater("22.0.0").checkForUpdates();
    assert.equal(result.hasUpdate, true);
  });

  it("campo vazio é tratado como ausente", async () => {
    servirManifesto({ ...NOVA, minPremiereVersion: "" });
    const result = await updater("22.0.0").checkForUpdates();
    assert.equal(result.hasUpdate, true);
  });

  it("sem atualização nenhuma, o portão não inventa erro", async () => {
    servirManifesto({ ...NOVA, version: "0.0.1" });
    const result = await updater("1.0.0").checkForUpdates();
    assert.equal(result.hasUpdate, false);
    assert.equal(result.error, undefined);
  });
});

describe("GATE 2 · antes de baixar e de gravar", () => {
  it("chamada direta de applyUpdate incompatível é recusada", async () => {
    // O selo pode ter vindo de um manifesto anterior, o modal pode estar
    // aberto desde antes, e `applyUpdate` é público.
    const servidor = servirManifesto(NOVA);
    const outcome = await updater("24.0.0").applyUpdate();

    assert.equal(outcome.success, false);
    assert.match(outcome.message, /requer Adobe Premiere Pro 25\.0\.0 ou superior/);
    assert.equal(outcome.requiresReload, false);
    // Uma busca (a do manifesto) e NENHUM download de arquivo.
    assert.equal(servidor.fetches, 1, "baixou arquivo de uma atualização recusada");
  });

  it("installBundle não é alcançado: o progresso nem começa", async () => {
    // `installBundle` só é chamado depois de "Baixando a atualização…",
    // que por sua vez vem depois de "Conectando ao GitHub…". Nenhum
    // passo significa nenhuma escrita.
    servirManifesto(NOVA);
    const passos: string[] = [];
    const outcome = await updater("24.0.0").applyUpdate((step) => passos.push(step));

    assert.equal(outcome.success, false);
    assert.deepEqual(passos, [], "a instalação começou mesmo incompatível");
  });

  it("host ilegível também bloqueia a gravação", async () => {
    servirManifesto(NOVA);
    const outcome = await updater("").applyUpdate();
    assert.equal(outcome.success, false);
    assert.match(outcome.message, /não consegui descobrir a versão/i);
  });

  it("mínimo inválido bloqueia a gravação", async () => {
    servirManifesto({ ...NOVA, minPremiereVersion: "25.x" });
    const outcome = await updater("26.0.0").applyUpdate();
    assert.equal(outcome.success, false);
    assert.match(outcome.message, /não reconheci a versão/i);
  });

  it("host compatível passa do portão e segue o fluxo de sempre", async () => {
    // Não instala de verdade aqui (o fs do UXP não existe no teste): o
    // que se prova é que o portão NÃO é o que barra, e que o download
    // chegou a ser tentado.
    servirManifesto(NOVA);
    const passos: string[] = [];
    const outcome = await updater("25.0.0").applyUpdate((step) => passos.push(step));

    assert.ok(
      passos.includes("Conectando ao GitHub..."),
      "o portão barrou um host compatível"
    );
    assert.doesNotMatch(outcome.message, /requer Adobe Premiere Pro/);
    assert.doesNotMatch(outcome.message, /versão do Premiere/);
  });

  it("manifesto sem o campo segue instalável pelo caminho de sempre", async () => {
    const { minPremiereVersion: _ignorado, ...semCampo } = NOVA;
    servirManifesto(semCampo);
    const passos: string[] = [];
    await updater("20.0.0").applyUpdate((step) => passos.push(step));
    assert.ok(passos.includes("Conectando ao GitHub..."));
  });
});
