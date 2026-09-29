/**
 * Os scripts do agente residente.
 *
 * O caso que este arquivo existe para travar: no Windows, o job rodava
 * com `Run(..., True)`, que não devolve o controle até o processo sair.
 * O VBScript tem uma linha de execução só, então NADA mais corria nesse
 * meio-tempo — inclusive o carimbo de vida, que vale 8 segundos. Todo
 * job mais longo que isso fazia o painel concluir que o agente havia
 * morrido: ticket retirado, Terminal aberto com diálogo, e a guarda de
 * instância única — que é o próprio carimbo — liberando um segundo
 * agente para disputar a mesma fila.
 *
 * Os dois geradores são funções puras que devolvem texto, então o que se
 * prova aqui é o texto. Não roda VBScript nem bash: o que está sob teste
 * é a ESTRUTURA do laço, e é ela que estava errada.
 *
 * O último bloco compara as garantias das duas plataformas — os códigos
 * não precisam ser iguais, as promessas precisam.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentBash,
  agentVbs,
  infoPlist,
} from "../src/tools/download/runner";
import type { Workspace } from "../src/tools/silence/workspace";

const SPACE: Workspace = {
  fsBase: "plugin-data:/edit-toolbox-audio",
  nativeBase: "C:\\Users\\editor\\AppData\\Local\\EditToolbox",
  sync: true,
  origin: "teste",
};

const vbs = agentVbs(SPACE);
const bash = agentBash();

/**
 * As linhas entre dois marcadores, para falar de ordem.
 *
 * O fim casa por linha INTEIRA (sem indentação), não por conter: "Next"
 * também está dentro de "On Error Resume Next", e um marcador frouxo
 * fechava o trecho antes da hora — dando um teste que passa por engano.
 */
function between(script: string, from: string, to: string): string[] {
  const lines = script.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(from));
  assert.ok(start >= 0, `não achei "${from}"`);
  const end = lines.findIndex((line, at) => at > start && line.trim() === to);
  assert.ok(end > start, `não achei a linha "${to}" depois de "${from}"`);
  return lines.slice(start, end + 1);
}

describe("agentVbs · o job não congela o carimbo", () => {
  it("não usa mais a espera bloqueante do Run", () => {
    // É a linha do defeito. Qualquer `Run` esperando o retorno segura o
    // script inteiro, e com ele o carimbo.
    assert.ok(
      !/sh\.Run[^\n]*,\s*True/.test(vbs),
      "voltou a esperar dentro do Run — o carimbo congela pelo tempo do job"
    );
    assert.match(vbs, /sh\.Run "cmd \/c " & q & wrapPath & q, 0, False/);
  });

  it("o job continua oculto: estilo de janela 0", () => {
    assert.match(vbs, /sh\.Run[^\n]*, 0, False/);
  });

  it("carimba enquanto o filho está vivo, a cada meia volta", () => {
    const wait = between(vbs, "Do While Not fso.FileExists(doneP)", "Loop");
    assert.ok(
      wait.some((line) => line.trim() === "Stamp"),
      "a espera não carimba — era exatamente o defeito"
    );
    assert.ok(wait.some((line) => /WScript\.Sleep 500/.test(line)));
  });

  it("a conclusão só é observada depois de o filho realmente sair", () => {
    // O invólucro só escreve o aviso DEPOIS do `call`, que só retorna
    // quando o job terminou. Nenhum outro sinal encerra a espera.
    const wrapper = between(vbs, "Set wh = fso.CreateTextFile(wrapPath", "wh.Close");
    const callAt = wrapper.findIndex((line) => line.includes('"call "'));
    const doneAt = wrapper.findIndex((line) => line.includes("echo %errorlevel%"));
    assert.ok(callAt >= 0 && doneAt > callAt, "o aviso não vem depois do call");
  });

  it("o aviso de conclusão chega por tmp+move, não meio escrito", () => {
    // Mesma disciplina do carimbo de vida: o arquivo aparece inteiro ou
    // não aparece. Sem isso a espera poderia ver o nome antes do código.
    assert.match(vbs, /move \/y " & q & doneP & "\.tmp"/);
    const wrapper = between(vbs, "Set wh = fso.CreateTextFile(wrapPath", "wh.Close");
    const tmpAt = wrapper.findIndex((line) => line.includes("echo %errorlevel%"));
    const moveAt = wrapper.findIndex((line) => line.includes("move /y"));
    assert.ok(moveAt > tmpAt, "o move tem de vir depois da escrita do tmp");
  });

  it("o código de saída é preservado, e não vira redirecionamento de handle", () => {
    // `echo 0> f` é lido pelo cmd como redirecionamento do handle 0, e 0
    // é o código de saída mais comum. O redirecionamento vem antes.
    assert.match(vbs, /"> " & q & doneP & "\.tmp" & q & " echo %errorlevel%"/);
    assert.ok(
      !/echo %errorlevel%>/.test(vbs),
      "echo com dígito colado no > perde o código de saída no caso de sucesso"
    );
  });

  it("o job é chamado com call, para o .bat devolver o controle", () => {
    // Os scripts .bat gerados terminam em `exit /b`, que sai só do
    // batch. Com `call`, o invólucro continua e grava o aviso.
    assert.match(vbs, /wh\.WriteLine "call " & q & jobPath & q/);
  });

  it("um aviso de um agente anterior não faz o job parecer pronto", () => {
    const lines = vbs.split(/\r?\n/);
    const named = lines.findIndex((line) => line.includes("doneP = dir &"));
    const cleared = lines.findIndex((line) =>
      /If fso\.FileExists\(doneP\) Then fso\.DeleteFile doneP, True/.test(line)
    );
    const launched = lines.findIndex((line) => line.includes("sh.Run"));
    assert.ok(cleared > named, "o aviso velho não é apagado depois de ser nomeado");
    assert.ok(
      launched > cleared,
      "o job é lançado antes de o aviso velho sair: ele pareceria pronto na hora"
    );
  });

  it("o invólucro e o aviso são limpos, e carimbados por execução", () => {
    assert.match(vbs, /wrapPath = dir & "\\agent-run-" & runN & "\.bat"/);
    assert.match(vbs, /doneP = dir & "\\agent-done-" & runN & "\.txt"/);
    assert.match(vbs, /runN = runN \+ 1/);
    // Nome por execução: sobrescrever um .bat que ainda executa é mexer
    // no chão em que se pisa.
    assert.match(vbs, /fso\.DeleteFile wrapPath, True/);
    assert.match(vbs, /fso\.DeleteFile doneP, True/);
  });

  it("um job por vez: a espera fica DENTRO do laço da fila", () => {
    const queue = between(vbs, "For Each gp In Split", "Next");
    assert.ok(queue.some((line) => line.includes("sh.Run")));
    assert.ok(
      queue.some((line) => line.includes("Do While Not fso.FileExists(doneP)")),
      "a espera saiu de dentro do laço: dois jobs poderiam correr juntos"
    );
  });

  it("a guarda de instância única segue de pé, e agora vê o agente trabalhando", () => {
    // A guarda É o carimbo. Com o carimbo renovado durante o job, ela
    // deixa de interpretar "ocupado" como "morto".
    assert.match(vbs, /If AgeOf\(aliveF\) < 8 Then WScript\.Quit 0/);
    assert.match(vbs, /^Stamp$/m);
  });

  it("o protocolo da fila não mudou de formato", () => {
    assert.match(vbs, /Left\(f\.Name, 9\) = "agent-go-"/);
    assert.match(vbs, /fso\.DeleteFile gp, True/);
    // A validação do nome do job continua: nome com caminho não é nome.
    assert.match(vbs, /InStr\(job, "\\"\) = 0/);
    assert.match(vbs, /InStr\(job, "\/"\) = 0/);
    assert.match(vbs, /InStr\(job, "\.\."\) = 0/);
  });

  it("os caminhos continuam citados, e a pasta escapada para o VBS", () => {
    const hostile: Workspace = { ...SPACE, nativeBase: 'C:\\pasta "do" editor\\' };
    const script = agentVbs(hostile);
    // Aspa dobrada é como o VBScript escreve uma aspa num literal.
    assert.match(script, /dir = "C:\\pasta ""do"" editor"/);
    // E a barra final não entra duas vezes no caminho.
    assert.ok(!/editor\\\\"/.test(script));
    // Tudo que vira linha de comando passa por q = Chr(34).
    assert.match(script, /^q = Chr\(34\)$/m);
  });

  it("os limites do protocolo continuam nos mesmos números", () => {
    assert.match(vbs, /If AgeOf\(panelF\) > 90 Then Exit Do/);
    assert.match(vbs, /If tick > 57600 Then Exit Do/);
    assert.match(vbs, /If \(tick Mod 4\) = 1 Then Stamp/);
  });
});

describe("agentBash · o comportamento de referência, intacto", () => {
  it("segue rodando o job destacado e carimbando enquanto ele vive", () => {
    assert.match(bash, /\/bin\/bash "\$DIR\/\$job" > \/dev\/null 2>&1 &/);
    const wait = between(bash, 'while kill -0 "$pid"', "done");
    assert.ok(wait.some((line) => line.trim() === "stamp"));
    assert.ok(wait.some((line) => /sleep 0\.5/.test(line)));
  });

  it("o lock de pasta e o carimbo com tmp+mv continuam lá", () => {
    assert.match(bash, /if ! mkdir "\$LOCK" 2>\/dev\/null; then/);
    assert.match(bash, /mv -f "\$ALIVE\.tmp" "\$ALIVE"/);
  });

  it("espera o término real antes de seguir para o próximo", () => {
    const lines = bash.split("\n");
    const waitAt = lines.findIndex((line) => line.includes('wait "$pid"'));
    const loopEndAt = lines.findIndex((line) => line.includes('while kill -0 "$pid"'));
    assert.ok(waitAt > loopEndAt);
  });
});

describe("as duas plataformas oferecem as mesmas garantias", () => {
  /** Cada garantia, com a evidência de cada lado. */
  const guarantees: Array<[string, RegExp, RegExp]> = [
    [
      "o agente segue vivo enquanto trabalha (carimbo dentro da espera)",
      /Do While Not fso\.FileExists\(doneP\)[\s\S]{0,200}?Stamp/,
      /while kill -0 "\$pid"[\s\S]{0,120}?stamp/,
    ],
    [
      "o filho é lançado sem bloquear a linha de execução",
      /sh\.Run[^\n]*, 0, False/,
      /"\$DIR\/\$job" > \/dev\/null 2>&1 &/,
    ],
    [
      "o término REAL do filho é observado antes de seguir",
      /Loop[\s\S]{0,400}?fso\.DeleteFile doneP/,
      /wait "\$pid"/,
    ],
    [
      "o job é serial: a espera está dentro do laço da fila",
      /For Each gp In Split[\s\S]*?Do While Not fso\.FileExists\(doneP\)[\s\S]*?Next/,
      /for go in[\s\S]*?while kill -0 "\$pid"[\s\S]*?done/,
    ],
  ];

  for (const [what, onVbs, onBash] of guarantees) {
    it(what, () => {
      assert.match(vbs, onVbs, `Windows não garante: ${what}`);
      assert.match(bash, onBash, `Unix não garante: ${what}`);
    });
  }

  it("nenhum dos dois checa o sinal do painel durante o job", () => {
    // Regra explícita do protocolo: trabalho começado termina, mesmo que
    // a janela feche no meio. Vale nos dois, e é o que evita um job
    // abortado pela metade.
    const vbsWait = between(vbs, "Do While Not fso.FileExists(doneP)", "Loop").join("\n");
    const bashWait = between(bash, 'while kill -0 "$pid"', "done").join("\n");
    assert.ok(!/panelF|stopF/.test(vbsWait));
    assert.ok(!/PANEL|STOP/.test(bashWait));
  });
});

describe("infoPlist · o bundle do macOS não mudou de contrato", () => {
  it("segue sem janela e sem Rosetta", () => {
    const plist = infoPlist();
    assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
    assert.match(plist, /<string>arm64<\/string>/);
  });

  it("a versão do agente subiu junto com a mudança do laço", () => {
    // O painel usa a versão para mandar um agente antigo sair antes de
    // lançar o novo. Sem subir, um agente com o laço velho — e com o
    // defeito — continuaria servindo a fila.
    assert.match(infoPlist(), /com\.framelab\.agent\.v4/);
    assert.match(agentVbs(SPACE), /Epoch\(\) & " 4 " & arch/);
    assert.match(agentBash(), /printf '%s 4 %s'/);
  });
});
