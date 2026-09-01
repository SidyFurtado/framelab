/**
 * Corte de Silêncios — a ponte com o ffmpeg.
 *
 * ── Como um plugin UXP roda um binário ─────────────────────────────
 * O UXP não tem `child_process`. O que ele tem, documentado pela
 * Adobe, é `shell.openPath(caminho)`, que abre um arquivo com o
 * aplicativo padrão do sistema — e um script executável é "aberto"
 * sendo executado. As duas limitações da API são que não dá para
 * passar argumentos nem capturar a saída, e nenhuma das duas pesa
 * aqui: o script é GERADO por nós, então os argumentos já vão escritos
 * dentro dele, e o resultado volta por arquivo em vez de por stdout.
 *
 * O ciclo é: escreve o script → `openPath` (o usuário aprova uma vez,
 * podendo marcar "lembrar") → o script roda o ffmpeg e escreve
 * `progress.txt` a cada job e `result.json` no fim → o painel enxerga
 * o progresso e o fim lendo esses dois arquivos.
 *
 * Uma execução por varredura, nunca uma por clipe: cada `openPath` é
 * um diálogo de consentimento, e doze diálogos seguidos não são uma
 * ferramenta, são um castigo.
 *
 * O `result.json` é escrito em `.tmp` e renomeado. Sem isso o painel
 * leria um JSON pela metade e chamaria de falha uma extração que deu
 * certo.
 *
 * Os DOIS endereços de cada arquivo — o do `fs` e o nativo — vêm de
 * `workspace.ts`; a razão de existirem dois está lá.
 */
import { EnvelopeBuilder, PCM_SAMPLE_RATE, type Envelope } from "./waveform";
import { ensureSilentLauncher } from "../download/runner";
import {
  describe,
  fsModule,
  fsPath,
  isWindows,
  join,
  nativePath,
  forgetWorkspace,
  readText,
  remove,
  shellModule,
  uxpModule,
  shellQuote,
  batValue,
  wait,
  workspace,
  workspaceAttempts,
  write,
  type Workspace,
} from "./workspace";

/** Um trecho de mídia a extrair. */
export interface AudioJob {
  mediaPath: string;
  /** Início da extração, em segundos de mídia. */
  offsetSeconds: number;
  durationSeconds: number;
  /** Nome do PCM dentro da pasta de trabalho. */
  file: string;
}

export interface ExtractionResult {
  ok: boolean;
  /** Código curto: "ffmpeg-not-found", "ffmpeg-failed", "timeout"… */
  error: string | null;
  /** Caminho do binário que o script encontrou. */
  ffmpegPath: string | null;
  /** Caminho do script, para o usuário rodar à mão se precisar. */
  scriptPath: string | null;
}

const RESULT_FILE = "result.json";
const PROGRESS_FILE = "progress.txt";
/** Escrito na primeira linha útil do script: prova que ele rodou. */
const STARTED_FILE = "sil-started.txt";
const CONFIG_FILE = "silence-config.json";
const SCRIPT_FILE = "extract.command";
const SCRIPT_FILE_WIN = "extract.bat";

/** Passo do polling e teto de espera. */
const POLL_MS = 350;
/**
 * Depois do primeiro meio minuto o passo abre.
 *
 * Cada volta faz uma leitura SÍNCRONA de arquivo na thread do painel, e
 * uma extração longa mantinha isso a cada 350 ms por até vinte minutos.
 * Os primeiros segundos continuam rápidos, que é quando a resposta é
 * "não achei o ffmpeg" e o editor está olhando.
 */
const POLL_SLOW_MS = 1200;
const POLL_FAST_WINDOW_MS = 30 * 1000;
const TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Executa um passo do host e etiqueta a falha com o nome dele.
 *
 * O UXP do Premiere responde a API não implementada com mensagens
 * genéricas — "Route not found" é a mais comum, e sozinha não diz nada:
 * ela aparecia na barra de status sem apontar qual chamada morreu.
 * Toda ponte com o host passa por aqui para que a mensagem diga onde.
 */
async function step<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    console.error(`[Silêncios] ${label} falhou:`, cause);
    throw new Error(`${label} — ${describe(cause)}`);
  }
}

function scriptName(): string {
  return isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
}

// ── configuração ───────────────────────────────────────────────────

export interface SilenceConfig {
  /** Caminho do ffmpeg escolhido à mão. Vazio = descobrir sozinho. */
  ffmpegPath: string;
  /** Último modo de detecção usado. Escolha de máquina, não de projeto. */
  mode: "waveform" | "transcript";
}

export async function readConfig(): Promise<SilenceConfig> {
  const fallback: SilenceConfig = { ffmpegPath: "", mode: "waveform" };
  try {
    const raw = readText(await workspace(), CONFIG_FILE);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<SilenceConfig>;
    return {
      ffmpegPath: typeof parsed.ffmpegPath === "string" ? parsed.ffmpegPath : "",
      mode: parsed.mode === "transcript" ? "transcript" : "waveform",
    };
  } catch {
    return fallback;
  }
}

export async function writeConfig(config: SilenceConfig): Promise<void> {
  try {
    await write(await workspace(), CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (cause) {
    console.error("[Silêncios] não foi possível salvar a configuração:", cause);
  }
}

// ── execução ───────────────────────────────────────────────────────

export interface ExtractionProgress {
  (done: number, total: number): void;
}

/**
 * Extrai o áudio dos trechos pedidos.
 *
 * Devolve assim que `result.json` aparece — ou quando `cancelled()`
 * disser que o editor desistiu.
 */
export async function extractAudio(
  jobs: readonly AudioJob[],
  ffmpegPath: string,
  onProgress?: ExtractionProgress,
  cancelled?: () => boolean,
  /** Chamado quando o sistema recusa executar: o script existe e pode
   *  ser rodado à mão. O polling segue esperando por ele. */
  onManual?: (scriptPath: string, reason: string) => void
): Promise<ExtractionResult> {
  const shell = shellModule();
  if (!shell) {
    return { ok: false, error: "uxp-unavailable", ffmpegPath: null, scriptPath: null };
  }

  const space = await step("pasta de trabalho", () => workspace());
  const scriptPath = nativePath(space, scriptName());

  /*
   * Cada execução ganha os seus arquivos de resultado e progresso,
   * renomeados no texto do script num ponto só. Cancelar deixa um
   * script órfão terminando; com nomes por execução, ele escreve nos
   * nomes velhos e a varredura nova não engole o resultado dele. (Os
   * PCMs já vêm carimbados por execução de quem monta os jobs.)
   */
  const tag = Date.now().toString(36);
  const runResult = `sil-${tag}-result.json`;
  const runProgress = `sil-${tag}-progress.txt`;
  const runStarted = `sil-${tag}-started.txt`;

  await remove(space, runResult);
  await remove(space, runProgress);
  await remove(space, runStarted);
  for (const job of jobs) {
    await remove(space, job.file);
  }

  // O script vive no mundo de fora: todo caminho DENTRO dele é nativo.
  const script = (isWindows()
    ? windowsScript(jobs, space.nativeBase, ffmpegPath)
    : unixScript(jobs, space.nativeBase, ffmpegPath))
    .split(RESULT_FILE).join(runResult)
    .split(PROGRESS_FILE).join(runProgress)
    .split(STARTED_FILE).join(runStarted);
  await step("escrever o script", () => write(space, scriptName(), script, true));

  /*
   * Primeiro sem janela: o mesmo runner silencioso do Baixar Vídeos —
   * a janela do Terminal piscando era a reclamação número um do beta,
   * e esta ferramenta era a que faltava. Se o lançamento falhar, ou o
   * carimbo de início não aparecer, o Terminal volta como plano B.
   */
  let launchError: string | null = null;
  let awaitingStamp = false;
  try {
    const launcher = await ensureSilentLauncher(scriptName());
    await shell.openPath(
      launcher.path,
      "Extrair o áudio dos clipes selecionados com o ffmpeg, para detectar os silêncios pela onda."
    );
    awaitingStamp = true;
  } catch (cause) {
    console.error("[Silêncios] runner silencioso recusado:", describe(cause));
  }
  if (!awaitingStamp) {
    try {
      await shell.openPath(
        scriptPath,
        "Extrair o áudio dos clipes selecionados com o ffmpeg, para detectar os silêncios pela onda."
      );
    } catch (cause) {
      launchError = describe(cause);
      console.error("[Silêncios] openPath recusou:", cause);
      onManual?.(scriptPath, launchError);
    }
  }
  const stampDeadline = Date.now() + 8000;

  const started = Date.now();
  const deadline = started + TIMEOUT_MS;
  let lastDone = -1;
  let tick = 0;
  while (Date.now() < deadline) {
    if (cancelled?.()) {
      return { ok: false, error: "cancelled", ffmpegPath: null, scriptPath };
    }

    if (awaitingStamp && Date.now() > stampDeadline) {
      awaitingStamp = false;
      if (!readText(space, runStarted)) {
        console.warn("[Silêncios] sem carimbo do runner — caindo para o Terminal.");
        try {
          await shell.openPath(scriptPath, "Extrair o áudio dos clipes selecionados.");
        } catch (cause) {
          launchError = describe(cause);
          onManual?.(scriptPath, launchError);
        }
      }
    }

    // Progress is a nicety; the result file is what ends the wait. Reading
    // both every cycle was two synchronous reads per step, all the way to
    // the timeout.
    if (tick % 3 === 0) {
      const done = readProgress(space, runProgress);
      if (done !== null && done !== lastDone) {
        lastDone = done;
        onProgress?.(done, jobs.length);
      }
    }
    tick += 1;

    const raw = readText(space, runResult);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; error?: string; ffmpeg?: string };
        return {
          ok: parsed.ok === true,
          error: parsed.ok === true ? null : parsed.error ?? "ffmpeg-failed",
          ffmpegPath: typeof parsed.ffmpeg === "string" ? parsed.ffmpeg : null,
          scriptPath,
        };
      } catch {
        // JSON ainda pela metade: o `mv` do script torna isso raro,
        // mas uma leitura a mais custa um passo e nada mais.
      }
    }
    await wait(
      Date.now() - started < POLL_FAST_WINDOW_MS ? POLL_MS : POLL_SLOW_MS
    );
  }

  return {
    ok: false,
    error: launchError ? `launch-denied: ${launchError}` : "timeout",
    ffmpegPath: null,
    scriptPath,
  };
}

/** Abre a pasta de trabalho no Finder, para rodar o script à mão. */
export async function openWorkFolder(): Promise<void> {
  const shell = shellModule();
  if (!shell) {
    throw new Error("uxp.shell indisponível");
  }
  const space = await workspace();
  await shell.openPath(space.nativeBase, "Abrir a pasta do script de extração.");
}

function readProgress(space: Workspace, name: string): number | null {
  const text = readText(space, name);
  if (!text) {
    return null;
  }
  const parsed = Number.parseInt(text.split("/")[0] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}


// ── leitura do PCM ─────────────────────────────────────────────────

/** Bloco de leitura: grande o bastante para ser rápido, pequeno o bastante para não pesar. */
const READ_CHUNK = 1 << 20;

/**
 * Lê o PCM em blocos e devolve só a curva.
 *
 * Em blocos porque uma hora de áudio são 57 MB, e não há motivo para
 * eles existirem inteiros na memória: o que sobrevive à leitura é o
 * envelope, mil vezes menor.
 */
export async function readEnvelope(
  fileName: string,
  offsetSeconds: number
): Promise<Envelope> {
  const fs = fsModule();
  if (!fs) {
    throw new Error("Sistema de arquivos do UXP indisponível.");
  }
  const space = await workspace();
  const path = fsPath(space, fileName);
  const builder = new EnvelopeBuilder(PCM_SAMPLE_RATE, undefined, offsetSeconds);

  const fd = await step(`abrir ${fileName}`, () => fs.open(path, "r"));
  try {
    const buffer = new ArrayBuffer(READ_CHUNK);
    let position = 0;
    for (;;) {
      const { bytesRead } = await fs.read(fd, buffer, 0, READ_CHUNK, position);
      if (!bytesRead) {
        break;
      }
      builder.push(buffer, bytesRead);
      position += bytesRead;
    }
  } finally {
    await fs.close(fd).catch(() => undefined);
    // O PCM já virou envelope; uma hora de áudio são ~57 MB, e sem
    // esta linha os arquivos de varreduras antigas se acumulavam na
    // pasta do plugin para sempre.
    await remove(space, fileName);
  }

  return builder.finish();
}

// ── diagnóstico ────────────────────────────────────────────────────

export interface DiagnosticLine {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Testa a corrente inteira, elo por elo, e diz qual quebrou.
 *
 * Existe porque o caminho até o ffmpeg atravessa camadas que podem
 * faltar independentemente — módulos do UXP, endereçamento de arquivo,
 * escrita com bit de execução, e o `openPath` de fato executando — e
 * uma falha em qualquer uma delas chegava ao painel como uma frase
 * genérica do host. Cada linha daqui é uma resposta, não um palpite.
 *
 * O último teste é o de verdade: escreve um script mínimo, dispara, e
 * espera ele responder com o ffmpeg que encontrou.
 */
export async function diagnose(ffmpegPath: string): Promise<DiagnosticLine[]> {
  // The whole point of the diagnostic is what works NOW. Reporting the
  // route discovered at the start of the session would answer a question
  // nobody asked.
  forgetWorkspace();

  const lines: DiagnosticLine[] = [];
  const add = (label: string, ok: boolean, detail: string): void => {
    lines.push({ label, ok, detail });
  };

  const fs = fsModule();
  add("módulo fs", !!fs, fs ? "disponível" : 'require("fs") não resolveu');

  const shell = shellModule();
  add(
    "módulo uxp.shell",
    !!shell && typeof shell.openPath === "function",
    shell?.openPath ? "openPath disponível" : "openPath ausente"
  );

  try {
    const os = uxpModule<{ platform(): string; homedir(): string }>("os");
    add("módulo os", !!os?.homedir?.(), `${os?.platform?.() ?? "?"} · ${os?.homedir?.() ?? "sem homedir"}`);
  } catch (cause) {
    add("módulo os", false, describe(cause));
  }

  let space: Workspace;
  try {
    space = await workspace();
    add("endereço de escrita", true, `${space.fsBase} (${space.origin}, ${space.sync ? "sync" : "async"})`);
    add("caminho nativo", true, space.nativeBase);
  } catch (cause) {
    add("endereço de escrita", false, describe(cause));
    for (const line of workspaceAttempts()) {
      add("  tentativa", false, line);
    }
    return lines;
  }

  const probeName = isWindows() ? "probe.bat" : "probe.command";
  try {
    await remove(space, "probe.json");
    await write(space, probeName, probeScript(space.nativeBase, ffmpegPath), true);
    add("escrever script executável", true, nativePath(space, probeName));
  } catch (cause) {
    add("escrever script executável", false, describe(cause));
    return lines;
  }

  if (!shell) {
    return lines;
  }

  // The script goes first, and the folder is only opened when the script
  // is refused. Each openPath is a consent dialog, and asking twice to
  // answer one question is not a diagnostic, it is a toll.
  try {
    await shell.openPath(nativePath(space, probeName), "Testar o acesso ao ffmpeg.");
    add("openPath (script)", true, "disparado — aguardando resposta");
  } catch (cause) {
    add("openPath (script)", false, describe(cause));

    // Opening the FOLDER and opening a SCRIPT are different permissions.
    // If the folder opens and the script did not, the block is on the
    // executable, not on openPath — and the fix is another one.
    try {
      await shell.openPath(space.nativeBase, "Abrir a pasta de trabalho.");
      add("openPath (pasta)", true, "Finder abriu — o bloqueio é ao executável");
    } catch (folderCause) {
      add("openPath (pasta)", false, describe(folderCause));
    }
    add(
      "  contorno",
      false,
      `dê um duplo clique em ${probeName} na pasta que abriu`
    );
    return lines;
  }

  // Curto de propósito: é um script de duas linhas. Se não responder
  // em 20s, não foi executado.
  const deadline = Date.now() + 20000;
  let answer: string | null = null;
  while (Date.now() < deadline && !answer) {
    await wait(POLL_MS);
    answer = readText(space, "probe.json");
  }
  if (!answer) {
    add(
      "script executou",
      false,
      "sem resposta em 20s — o sistema abriu o arquivo em vez de executar, ou a autorização foi negada"
    );
    return lines;
  }

  try {
    const parsed = JSON.parse(answer) as { ffmpeg?: string };
    const found = typeof parsed.ffmpeg === "string" ? parsed.ffmpeg : "";
    add("script executou", true, "sim");
    add(
      "ffmpeg encontrado",
      found.length > 0,
      found.length > 0 ? found : "não encontrado nos caminhos conhecidos nem no PATH"
    );
  } catch {
    add("script executou", true, `resposta ilegível: ${answer.slice(0, 120)}`);
  }
  return lines;
}

// ── geração do script ──────────────────────────────────────────────


/**
 * Exportado para poder ser gerado e executado fora do Premiere: o
 * script é a parte com mais como-quebrar-calado de todo o arquivo
 * (aspas, caminho com apóstrofo, flags do ffmpeg, protocolo de
 * progresso), e é a que menos precisa do host para ser testada.
 */
export function unixScript(
  jobs: readonly AudioJob[],
  folder: string,
  ffmpegPath: string
): string {
  const lines: string[] = [
    "#!/bin/bash",
    "# Gerado pelo Framelab — Corte de Silêncios. Pode apagar.",
    `printf '\\033]0;Framelab — analisando áudio\\007'`,
    "set -u",
    `WORK=${shellQuote(folder)}`,
    `printf 1 > "$WORK/${STARTED_FILE}"`,
    `CUSTOM=${shellQuote(ffmpegPath)}`,
    "FFMPEG=''",
    // A ordem procura primeiro o que o editor escolheu, depois os
    // lugares onde Homebrew e MacPorts instalam, e só então o PATH —
    // que num shell não interativo pode nem ter /opt/homebrew.
    // "$WORK/ffmpeg" é o binário que o Baixar Vídeos provisiona na
    // primeira vez: quem usou o downloader nunca vê "instale o ffmpeg".
    'for candidate in "$CUSTOM" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
    '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
    "done",
    'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
    'if [ -z "$FFMPEG" ]; then',
    `  printf '{"ok":false,"error":"ffmpeg-not-found"}' > "$WORK/${RESULT_FILE}.tmp"`,
    `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    '  echo "ffmpeg não encontrado. Instale (brew install ffmpeg) ou informe o caminho no painel."',
    "  exit 1",
    "fi",
    'echo "ffmpeg: $FFMPEG"',
    "FAILED=0",
  ];

  jobs.forEach((job, index) => {
    const number = index + 1;
    lines.push(
      `echo "[${number}/${jobs.length}] $(basename ${shellQuote(job.mediaPath)})"`,
      // -vn descarta vídeo, -ac 1 soma os canais, -ar 8000 é o que a
      // energia da fala precisa, e o high-pass tira o grave que
      // inflaria o piso de ruído sem ser som audível.
      `"$FFMPEG" -v error -y -accurate_seek -ss ${job.offsetSeconds.toFixed(6)} ` +
        `-i ${shellQuote(job.mediaPath)} -t ${job.durationSeconds.toFixed(6)} ` +
        `-vn -ac 1 -ar ${PCM_SAMPLE_RATE} -af highpass=f=85 -f s16le ` +
        `${shellQuote(join(folder, job.file))} || FAILED=1`,
      `printf '%s/%s' ${number} ${jobs.length} > "$WORK/${PROGRESS_FILE}"`
    );
  });

  lines.push(
    'if [ "$FAILED" -eq 0 ]; then',
    `  printf '{"ok":true,"ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE}.tmp"`,
    "else",
    `  printf '{"ok":false,"error":"ffmpeg-failed","ffmpeg":"%s"}' "$FFMPEG" > "$WORK/${RESULT_FILE}.tmp"`,
    "fi",
    `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    'echo "Pronto. Pode voltar ao Premiere."',
    // Fecha só a própria janela, achada pelo título posto lá em cima.
    // Se o macOS negar a automação, a janela fica aberta e nada quebra.
    `osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 &`,
    "exit 0"
  );

  return lines.join("\n") + "\n";
}


/** Mesma coreografia em cmd.exe. Não testado num Windows real. */
export function windowsScript(
  jobs: readonly AudioJob[],
  folder: string,
  ffmpegPath: string
): string {
  const quote = (value: string): string => `"${batValue(value)}"`;
  const lines: string[] = [
    "@echo off",
    "rem Gerado pelo Framelab — Corte de Silêncios. Pode apagar.",
    `title Framelab - analisando audio`,
    `set "WORK=${batValue(folder)}"`,
    `>"%WORK%\\${STARTED_FILE}" echo 1`,
    `set "FFMPEG=${batValue(ffmpegPath)}"`,
    'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
    'if "%FFMPEG%"=="" (',
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ffmpeg-not-found"}`,
    `  move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "  echo ffmpeg nao encontrado. Informe o caminho no painel.",
    "  exit /b 1",
    ")",
    "set FAILED=0",
  ];

  jobs.forEach((job, index) => {
    const number = index + 1;
    lines.push(
      `echo [${number}/${jobs.length}]`,
      `"%FFMPEG%" -v error -y -accurate_seek -ss ${job.offsetSeconds.toFixed(6)} ` +
        `-i ${quote(job.mediaPath)} -t ${job.durationSeconds.toFixed(6)} ` +
        `-vn -ac 1 -ar ${PCM_SAMPLE_RATE} -af highpass=f=85 -f s16le ` +
        `${quote(join(folder, job.file))} || set FAILED=1`,
      `>"%WORK%\\${PROGRESS_FILE}" echo ${number}/${jobs.length}`
    );
  });

  lines.push(
    // Barra invertida crua dentro de JSON é escape inválido: o painel
    // não conseguia ler um sucesso e esperava os 20 minutos inteiros.
    // O cmd troca \ por / na expansão da variável.
    'set "FFJSON=%FFMPEG:\\=/%"',
    'if "%FAILED%"=="0" (',
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":true,"ffmpeg":"%FFJSON%"}`,
    ") else (",
    `  >"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"ffmpeg-failed"}`,
    ")",
    `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
    "exit /b 0"
  );

  return lines.join("\r\n") + "\r\n";
}

/** Script mínimo: só procura o ffmpeg e responde. Não toca em mídia. */
export function probeScript(folder: string, ffmpegPath: string): string {
  if (isWindows()) {
    return [
      "@echo off",
      `set "FFMPEG=${batValue(ffmpegPath)}"`,
      'if "%FFMPEG%"=="" for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
      'set "FFJSON=%FFMPEG:\\=/%"',
      `>"${batValue(folder)}\\probe.json" echo {"ffmpeg":"%FFJSON%"}`,
      "exit /b 0",
    ].join("\r\n") + "\r\n";
  }
  return [
    "#!/bin/bash",
    `printf '\\033]0;Framelab — teste\\007'`,
    "set -u",
    `CUSTOM=${shellQuote(ffmpegPath)}`,
    "FFMPEG=''",
    'for candidate in "$CUSTOM" /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg ' +
      shellQuote(join(folder, "ffmpeg")) + "; do",
    '  if [ -n "$candidate" ] && [ -x "$candidate" ]; then FFMPEG="$candidate"; break; fi',
    "done",
    'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
    `printf '{"ffmpeg":"%s"}' "$FFMPEG" > ${shellQuote(join(folder, "probe.json"))}`,
    'echo "Teste concluído. ffmpeg: $FFMPEG"',
    `osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 &`,
    "exit 0",
  ].join("\n") + "\n";
}

/** Mensagem de erro em português, a partir do código do script. */
export function describeExtractionError(code: string | null): string {
  if (!code) {
    return "Falha desconhecida na extração de áudio.";
  }
  if (code.startsWith("launch-denied")) {
    // O motivo cru importa: "not allowed" é permissão, "no handler" é o
    // sistema não saber abrir aquele tipo de arquivo. São consertos
    // diferentes, e a frase genérica escondia os dois.
    const raw = code.slice("launch-denied:".length).trim();
    return (
      "O sistema não executou o script" +
      (raw ? ` (${raw})` : "") +
      ". Use \"Abrir pasta\" e dê um duplo clique em extract.command — " +
      "o painel continua esperando o resultado."
    );
  }
  switch (code) {
    case "ffmpeg-not-found":
      return (
        "ffmpeg não encontrado. Instale com \"brew install ffmpeg\" ou informe " +
        "o caminho do binário no campo abaixo."
      );
    case "ffmpeg-failed":
      return "O ffmpeg não conseguiu ler algum arquivo. Veja a janela do Terminal.";
    case "timeout":
      return "A extração passou de 20 minutos e foi abandonada.";
    case "cancelled":
      return "Extração cancelada.";
    case "uxp-unavailable":
      return "Este build do Premiere não expõe shell/fs do UXP.";
    default:
      return `Falha na extração: ${code}`;
  }
}
