/**
 * O agente residente: o trabalho roda sem Terminal E sem pedir de novo.
 *
 * ── O problema ─────────────────────────────────────────────────────
 * O UXP não tem `child_process`. A única porta para o mundo é
 * `shell.openPath`, e a documentação da Adobe é explícita:
 *
 *   "Upon either function call, the user will get a runtime consent
 *    dialog. Only after they agree will the API call execute."
 *
 * Um diálogo POR CHAMADA, sem memória e sem como desligar. Como cada
 * ferramenta chamava `openPath` uma vez por ação, o painel pedia
 * permissão para analisar, de novo para baixar, de novo para varrer
 * silêncios, de novo para transcrever. Não há ajuste de manifesto que
 * conserte isso — `launchProcess` autoriza a API, não dispensa o
 * consentimento.
 *
 * ── A saída ────────────────────────────────────────────────────────
 * Se não dá para pedir menos vezes por chamada, chama-se menos vezes.
 * O `.app` deixa de ser um lançador de UM script e vira um AGENTE: um
 * laço que fica de pé enquanto o painel estiver aberto, olhando uma
 * fila de arquivos. Lançá-lo custa um consentimento; dali em diante
 * cada trabalho é um arquivo de texto na fila — zero diálogos.
 *
 *   painel                          agente (.app, sem janela)
 *   ──────                          ─────────────────────────
 *   escreve trabalho.command
 *   escreve agent-go-<tag>.txt  →   vê o pedido, roda o script
 *   lê os arquivos de resultado ←   escreve resultado, volta a esperar
 *
 * ── Como ele morre ─────────────────────────────────────────────────
 * Duas rédeas, porque um processo que sobrevive ao Premiere é pior que
 * um diálogo a mais:
 *
 *   • o PAINEL carimba `agent-panel.txt` a cada 20s enquanto está
 *     aberto; o agente sai se o carimbo passar de 90s — cobre fechar o
 *     painel, fechar o Premiere e o Premiere travar;
 *   • um teto absoluto de horas, para o caso de tudo mais falhar.
 *
 * E o agente carimba `agent-alive.txt` a cada ~2s: é assim que o
 * painel sabe se pode enfileirar ou se precisa lançar (e pedir).
 *
 * ── Quando não der ─────────────────────────────────────────────────
 * A rede de segurança antiga continua inteira: quem chama espera o
 * carimbo de início do script e, se ele não vier, cai no `openPath`
 * direto com Terminal e tudo. Um agente quebrado — numa build de host
 * que recuse o lançamento, ou no Windows, onde não pude testar —
 * degrada exatamente para o comportamento de hoje, não para uma
 * ferramenta morta.
 *
 * Gatekeeper não pega: quarentena é atributo de arquivo BAIXADO, e
 * este bundle nasce localmente, escrito pelo fs do UXP.
 */
import {
  describe,
  ensureDir,
  exists,
  isWindows,
  nativePath,
  remove,
  readText,
  shellModule,
  wait,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

/**
 * A versão do agente. Sobe quando o LAÇO muda.
 *
 * Está no nome do bundle porque o LaunchServices guarda aplicativo por
 * caminho: reescrever o miolo mantendo o caminho é a receita para o
 * macOS lançar a versão em cache. Está também no carimbo de vida
 * porque um agente da versão anterior pode estar de pé quando o plugin
 * é atualizado — o painel manda esse sair antes de lançar o novo.
 */
const AGENT_VERSION = "2";

const ALIVE_FILE = "agent-alive.txt";
const PANEL_FILE = "agent-panel.txt";
const STOP_FILE = "agent-stop.txt";
const GO_PREFIX = "agent-go-";

/** Depois disto o carimbo do agente não vale mais. Ele bate a cada ~2s. */
const ALIVE_GRACE_SECONDS = 8;
/** De quanto em quanto o painel diz que ainda está aqui. */
const PANEL_BEAT_MS = 20_000;
/** O agente desiste se o painel ficar este tempo calado. */
const PANEL_GRACE_SECONDS = 90;
/** Teto absoluto de vida, em voltas de meio segundo. ~8 horas. */
const MAX_TICKS = 57_600;

export type DispatchMode =
  /** Enfileirado num agente que já estava de pé — nenhum diálogo. */
  | "agent"
  /** O agente foi lançado agora: um consentimento, uma vez. */
  | "launched"
  /** O lançamento foi recusado; quem chamou cai para o plano B. */
  | "denied";

export interface DispatchResult {
  mode: DispatchMode;
  error: string | null;
  /**
   * O pedido deixado na fila, para poder ser retirado.
   *
   * Quem chama desiste do agente depois de alguns segundos sem sinal
   * e roda o script pelo caminho antigo. Se o pedido continuasse na
   * fila, um agente que acordasse depois rodaria o MESMO trabalho de
   * novo — baixando o vídeo duas vezes, ou transcrevendo por cima do
   * resultado que já estava pronto.
   */
  ticket: string | null;
}

/**
 * O texto do diálogo de consentimento.
 *
 * Descreve o que está sendo lançado — o assistente — e não a ação que
 * o disparou. Dizer "baixar vídeo" numa caixa que na verdade inicia um
 * processo residente seria mentir sobre o que se pede, e a frase final
 * é o que impede o editor de achar que vai ser perguntado de novo.
 */
const CONSENT_TEXT =
  "Iniciar o assistente do Framelab, que executa as tarefas do painel " +
  "(baixar, converter áudio, transcrever) sem abrir o Terminal. " +
  "Só é preciso autorizar uma vez por sessão do Premiere.";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** O painel diz que ainda está aqui. */
async function beat(space: Workspace): Promise<void> {
  await write(space, PANEL_FILE, String(nowSeconds()));
}

type AgentState =
  /** De pé e desta versão: pode receber trabalho. */
  | "live"
  /** De pé, mas de uma versão anterior do plugin. */
  | "old"
  /** Não há agente. */
  | "gone";

function agentState(space: Workspace): AgentState {
  const raw = readText(space, ALIVE_FILE);
  if (!raw) {
    return "gone";
  }
  const [stampText, version] = raw.split(/\s+/);
  const stamp = Number.parseInt(stampText ?? "", 10);
  if (!Number.isFinite(stamp) || nowSeconds() - stamp > ALIVE_GRACE_SECONDS) {
    return "gone";
  }
  return version === AGENT_VERSION ? "live" : "old";
}

/** Só para o diagnóstico do painel. */
export async function agentIsUp(): Promise<boolean> {
  try {
    return agentState(await workspace()) === "live";
  } catch {
    return false;
  }
}

/**
 * Manda o script para execução.
 *
 * O trabalho é enfileirado ANTES de lançar: assim um agente recém-nascido
 * já encontra o que fazer na primeira volta, sem uma ida e volta extra.
 */
export async function dispatch(scriptName: string): Promise<DispatchResult> {
  const space = await workspace();
  // Antes de qualquer coisa: um carimbo velho faria o agente que
  // acabamos de lançar sair achando que o painel não existe mais.
  await beat(space);

  if (agentState(space) === "old") {
    // Conviver com dois agentes é pior que esperar um segundo: os dois
    // disputariam a mesma fila.
    await write(space, STOP_FILE, "1");
    for (let attempt = 0; attempt < 12 && agentState(space) !== "gone"; attempt += 1) {
      await wait(250);
    }
    await remove(space, STOP_FILE);
  }

  const ticket = `${GO_PREFIX}${Date.now().toString(36)}.txt`;
  await write(space, ticket, scriptName);

  if (agentState(space) === "live") {
    return { mode: "agent", error: null, ticket };
  }

  const shell = shellModule();
  if (!shell) {
    await remove(space, ticket);
    return { mode: "denied", error: 'require("uxp").shell não resolveu', ticket: null };
  }
  try {
    /*
     * `openPath` tem duas formas de falhar.
     *
     * A tipagem da Adobe é explícita: "Promise that resolves with ''
     * if succeeded or String containing the error message if failed."
     * Ou seja, negar o consentimento pode RESOLVER com um texto de
     * erro em vez de lançar — e o código antigo, que só tinha
     * `catch`, tratava uma recusa como sucesso e ficava oito segundos
     * esperando um carimbo que nunca viria.
     */
    const refusal = await shell.openPath(await ensureAgentBundle(space), CONSENT_TEXT);
    if (typeof refusal === "string" && refusal.trim().length > 0) {
      await remove(space, ticket);
      return { mode: "denied", error: refusal.trim(), ticket: null };
    }
    return { mode: "launched", error: null, ticket };
  } catch (cause) {
    // Sem agente, o pedido na fila é lixo que o próximo lançamento
    // executaria fora de hora.
    await remove(space, ticket);
    return { mode: "denied", error: describe(cause), ticket: null };
  }
}

/**
 * Tira da fila um pedido que não vai mais ser esperado.
 *
 * Chamado quando quem pediu desistiu do agente e foi pelo caminho
 * antigo: sem isto, o mesmo trabalho rodaria duas vezes.
 */
export async function withdraw(ticket: string | null): Promise<void> {
  if (!ticket) {
    return;
  }
  try {
    await remove(await workspace(), ticket);
  } catch {
    // A pasta sumiu; não há pedido para retirar.
  }
}

// ── o batimento do painel ──────────────────────────────────────────

let heartbeat: number | null = null;

/**
 * O painel passa a dar sinal de vida. Chamado uma vez, na abertura.
 *
 * É o que autoriza o agente a continuar existindo — e, do outro lado,
 * o que garante que ele saia sozinho quando esta janela fechar.
 */
export function startAgentHeartbeat(): void {
  if (heartbeat !== null) {
    return;
  }
  const tick = (): void => {
    void (async () => {
      try {
        await beat(await workspace());
      } catch {
        // Pasta de trabalho indisponível: o agente sai por conta.
      }
    })();
  };
  tick();
  heartbeat = window.setInterval(tick, PANEL_BEAT_MS);
}

export function stopAgentHeartbeat(): void {
  if (heartbeat !== null) {
    window.clearInterval(heartbeat);
    heartbeat = null;
  }
}

// ── o bundle ───────────────────────────────────────────────────────

/** Escreve (ou reescreve) o agente e devolve o caminho nativo dele. */
async function ensureAgentBundle(space: Workspace): Promise<string> {
  if (isWindows()) {
    const name = `FramelabAgent-${AGENT_VERSION}.vbs`;
    await write(space, name, agentVbs(space));
    return nativePath(space, name);
  }

  const app = `FramelabAgent-${AGENT_VERSION}.app`;
  await ensureDir(space, app);
  await ensureDir(space, `${app}/Contents`);
  await ensureDir(space, `${app}/Contents/MacOS`);
  await write(space, `${app}/Contents/Info.plist`, infoPlist());
  await write(space, `${app}/Contents/PkgInfo`, "APPL????");
  await write(space, `${app}/Contents/MacOS/run`, agentBash(), true);

  // O executável é a peça sem a qual o bundle é uma pasta inerte: se
  // ele não ficou lá, é melhor falhar agora e cair no Terminal do que
  // lançar um .app vazio e esperar oito segundos por um carimbo que
  // nunca vem.
  if (!exists(space, `${app}/Contents/MacOS/run`)) {
    throw new Error("o bundle do agente não pôde ser escrito");
  }
  return nativePath(space, app);
}

/** LSUIElement é a linha que importa: agente, sem janela e sem Dock. */
export function infoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>CFBundleName</key><string>Framelab Agent</string>",
    `  <key>CFBundleIdentifier</key><string>com.framelab.agent.v${AGENT_VERSION}</string>`,
    "  <key>CFBundleExecutable</key><string>run</string>",
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    `  <key>CFBundleShortVersionString</key><string>${AGENT_VERSION}.0</string>`,
    "  <key>LSUIElement</key><true/>",
    "  <key>LSBackgroundOnly</key><true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * O laço, em bash.
 *
 * Acha a pasta de trabalho subindo a partir de si mesmo — o bundle
 * mora DENTRO dela — e nunca escreve em stdout: tudo que importa sai
 * por arquivo, e não ecoar é metade do ponto de existir.
 */
export function agentBash(): string {
  return [
    "#!/bin/bash",
    "# Gerado pelo Framelab — agente residente. Pode apagar.",
    'DIR="$(cd "$(dirname "$0")/../../.." && pwd)"',
    'cd "$DIR" || exit 1',
    `LOCK="$DIR/agent-lock"`,
    `ALIVE="$DIR/${ALIVE_FILE}"`,
    `PANEL="$DIR/${PANEL_FILE}"`,
    `STOP="$DIR/${STOP_FILE}"`,
    "",
    "# O carimbo vai por arquivo temporário: o painel nunca deve ler",
    "# um carimbo pela metade e concluir que o agente morreu.",
    "stamp() {",
    `  printf '%s ${AGENT_VERSION}' "$(date +%s)" > "$ALIVE.tmp" 2>/dev/null &&`,
    '    mv -f "$ALIVE.tmp" "$ALIVE" 2>/dev/null',
    "}",
    "",
    "# Idade em segundos do carimbo de um arquivo. Sem arquivo = velho.",
    "age() {",
    "  local t",
    "  t=$(cut -d' ' -f1 < \"$1\" 2>/dev/null)",
    "  case \"$t\" in ''|*[!0-9]*) echo 999999; return;; esac",
    '  echo $(( $(date +%s) - t ))',
    "}",
    "",
    "# Um agente por pasta de trabalho. mkdir é atômico; se o dono do",
    "# lock parou de dar sinal, ele morreu e este assume o lugar.",
    'if ! mkdir "$LOCK" 2>/dev/null; then',
    `  if [ "$(age "$ALIVE")" -lt ${ALIVE_GRACE_SECONDS} ]; then exit 0; fi`,
    "fi",
    `trap 'rm -rf "$LOCK"; rm -f "$ALIVE"' EXIT`,
    "stamp",
    "",
    "tick=0",
    "while :; do",
    "  tick=$((tick+1))",
    `  [ "$tick" -gt ${MAX_TICKS} ] && break`,
    "  # ~2s entre carimbos: 0,5s deixaria quatro escritas por segundo",
    "  # rodando por horas, para nada.",
    "  [ $((tick % 4)) -eq 1 ] && stamp",
    '  [ -f "$STOP" ] && break',
    "  # O painel fechou, ou o Premiere saiu: não há mais para quem",
    "  # trabalhar. É esta linha que impede um processo órfão.",
    `  [ "$(age "$PANEL")" -gt ${PANEL_GRACE_SECONDS} ] && break`,
    "",
    `  for go in "$DIR"/${GO_PREFIX}*.txt; do`,
    '    [ -e "$go" ] || continue',
    '    job=$(cat "$go" 2>/dev/null)',
    '    rm -f "$go"',
    "    # O nome vem de um arquivo; nome com caminho não é nome.",
    "    case \"$job\" in ''|*/*|*..*) continue;; esac",
    '    [ -f "$DIR/$job" ] || continue',
    '    /bin/bash "$DIR/$job" > /dev/null 2>&1 &',
    "    pid=$!",
    "    # Segue carimbando enquanto o trabalho roda: uma transcrição de",
    "    # meia hora não pode parecer um agente morto para o painel. O",
    "    # sinal do painel NÃO é checado aqui — trabalho começado",
    "    # termina, mesmo que a janela feche no meio.",
    '    while kill -0 "$pid" 2>/dev/null; do',
    "      stamp",
    "      sleep 0.5",
    "    done",
    '    wait "$pid" 2>/dev/null',
    "  done",
    "",
    "  sleep 0.5",
    "done",
    'rm -rf "$LOCK"',
    'rm -f "$ALIVE"',
    "",
  ].join("\n");
}

/**
 * O mesmo laço em VBScript — o `wscript` roda sem janela nenhuma.
 *
 * VBScript e não `.bat` porque o batch não tem aritmética de datas
 * decente, e porque o `.vbs` já era a rota silenciosa do Windows.
 * Literal de data com `#` para não depender do locale da máquina.
 *
 * Não pude testar em Windows: a rede de segurança de quem chama —
 * esperar o carimbo do script e cair no console — é o que garante que
 * um agente que não funcione lá não vire ferramenta morta.
 */
export function agentVbs(space: Workspace): string {
  const dir = nativePath(space, "").replace(/[\\/]+$/, "").replace(/"/g, '""');
  return [
    "' Gerado pelo Framelab - agente residente. Pode apagar.",
    "Option Explicit",
    "Dim fso, sh, dir, aliveF, panelF, stopF, tick, f, gp, pend, job, jobPath",
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    `dir = "${dir}"`,
    `aliveF = dir & "\\${ALIVE_FILE}"`,
    `panelF = dir & "\\${PANEL_FILE}"`,
    `stopF = dir & "\\${STOP_FILE}"`,
    "",
    "Function Epoch()",
    '  Epoch = DateDiff("s", #1/1/1970 00:00:00#, Now())',
    "End Function",
    "",
    "Function AgeOf(path)",
    "  Dim t, h",
    "  AgeOf = 999999",
    "  If Not fso.FileExists(path) Then Exit Function",
    "  On Error Resume Next",
    "  Set h = fso.OpenTextFile(path, 1)",
    "  t = Trim(Split(h.ReadAll & \" \", \" \")(0))",
    "  h.Close",
    "  On Error GoTo 0",
    "  If IsNumeric(t) Then AgeOf = Epoch() - CLng(t)",
    "End Function",
    "",
    "Sub Stamp()",
    "  Dim h",
    "  On Error Resume Next",
    "  Set h = fso.CreateTextFile(aliveF, True)",
    `  h.Write Epoch() & " ${AGENT_VERSION}"`,
    "  h.Close",
    "  On Error GoTo 0",
    "End Sub",
    "",
    "' Um agente por pasta: quem chegar com o dono ainda vivo desiste.",
    `If AgeOf(aliveF) < ${ALIVE_GRACE_SECONDS} Then WScript.Quit 0`,
    "Stamp",
    "",
    "tick = 0",
    "Do",
    "  tick = tick + 1",
    `  If tick > ${MAX_TICKS} Then Exit Do`,
    "  If (tick Mod 4) = 1 Then Stamp",
    "  If fso.FileExists(stopF) Then Exit Do",
    `  If AgeOf(panelF) > ${PANEL_GRACE_SECONDS} Then Exit Do`,
    "",
    "  ' Os nomes primeiro, a execução depois: apagar arquivo enquanto",
    "  ' se percorre a coleção Files é mexer no chão em que se pisa.",
    "  pend = \"\"",
    "  For Each f In fso.GetFolder(dir).Files",
    `    If Left(f.Name, ${GO_PREFIX.length}) = "${GO_PREFIX}" Then`,
    '      pend = pend & f.Path & vbTab',
    "    End If",
    "  Next",
    '  If pend <> "" Then',
    '    For Each gp In Split(Left(pend, Len(pend) - 1), vbTab)',
    "      job = \"\"",
    "      On Error Resume Next",
    "      job = Trim(fso.OpenTextFile(gp, 1).ReadAll)",
    "      fso.DeleteFile gp, True",
    "      On Error GoTo 0",
    '      If job <> "" And InStr(job, "\\") = 0 And InStr(job, "/") = 0 _',
    '         And InStr(job, "..") = 0 Then',
    '        jobPath = dir & "\\" & job',
    "        If fso.FileExists(jobPath) Then",
    "          Stamp",
    "          ' 0 = sem janela, True = espera terminar.",
    '          sh.Run "cmd /c """ & jobPath & """", 0, True',
    "          Stamp",
    "        End If",
    "      End If",
    "    Next",
    "  End If",
    "",
    "  WScript.Sleep 500",
    "Loop",
    "On Error Resume Next",
    "fso.DeleteFile aliveF, True",
    "",
  ].join("\r\n");
}
