/**
 * Legendas — a ponte com o whisper.cpp.
 *
 * ── Por que não a transcrição do Premiere ──────────────────────────
 * A do Premiere erra pontuação e acento com frequência, que é o que
 * dá trabalho de corrigir depois. Medido numa amostra pt-BR limpa
 * antes de escrever isto: o large-v3-turbo acertou 53 de 53 palavras,
 * os 15 acentos e as duas interrogações, a 8× tempo real num M4.
 *
 * ── O caminho ──────────────────────────────────────────────────────
 * Vale o mesmo que vale para o ffmpeg e o yt-dlp: o UXP não tem
 * `child_process`, só `shell.openPath`. O script é GERADO aqui, roda
 * pelo runner silencioso (sem Terminal) e devolve por arquivo.
 *
 *   ffmpeg extrai 16 kHz mono  →  whisper-cli transcreve  →  JSON
 *
 * O JSON vira transcrição da Adobe em `toAdobe.ts` e entra no projeto
 * por `Transcript.createImportTextSegmentsAction` — a mesma estrutura
 * que o Corte de Silêncios já lê, agora escrita em vez de lida.
 *
 * ── O binário ──────────────────────────────────────────────────────
 * O MODELO se provisiona sozinho (Hugging Face, URLs conferidas). O
 * BINÁRIO não: o whisper.cpp publica build pronta para Windows e
 * Linux, mas não para macOS. Então ele é PROCURADO, como o ffmpeg, e
 * quem não tiver recebe a linha exata para instalar. É a única peça
 * do plugin que ainda pede um passo do editor, e o painel diz isso na
 * cara em vez de falhar com erro genérico.
 */
import { dispatch, withdraw } from "../download/runner";
import {
  describe,
  isWindows,
  nativePath,
  readText,
  remove,
  shellQuote,
  shellModule,
  wait,
  workspace,
  write,
  type Workspace,
} from "../silence/workspace";

const q = shellQuote;

const RESULT_FILE = "cc-result.json";
const STAGE_FILE = "cc-stage.txt";
const STARTED_FILE = "cc-started.txt";
const OUT_BASE = "cc-out";
const SCRIPT_FILE = "captions.command";
const SCRIPT_FILE_WIN = "captions.bat";

const POLL_MS = 400;
/** Transcrever é lento; provisionar o modelo, mais ainda. */
const TIMEOUT_MS = 60 * 60 * 1000;

/** Onde procurar o whisper-cli. A ordem é a mesma lógica do ffmpeg. */
const WHISPER_CANDIDATES = [
  "/Library/Application Support/Framelab/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cpp",
  "/usr/local/bin/whisper-cpp",
];

// ── modelos ────────────────────────────────────────────────────────

export interface WhisperModel {
  readonly id: string;
  readonly label: string;
  /** O que aparece na linha secundária do menu. */
  readonly note: string;
  readonly file: string;
  readonly url: string;
  readonly megabytes: number;
}

/**
 * A escada de modelos. Tamanhos e URLs conferidos ao vivo; o do meio
 * é o padrão porque foi o medido — qualidade de topo a 8× tempo real.
 */
export const MODELS: readonly WhisperModel[] = [
  {
    id: "small",
    label: "Rápido",
    note: "181 MB · bom para rascunho",
    file: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    megabytes: 181,
  },
  {
    id: "turbo",
    label: "Equilibrado",
    note: "547 MB · o recomendado",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    megabytes: 547,
  },
  {
    id: "large",
    label: "Máxima",
    note: "1 GB · mais lento",
    file: "ggml-large-v3-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
    megabytes: 1031,
  },
];

/**
 * Os idiomas oferecidos.
 *
 * A ordem é de uso, não alfabética: português primeiro porque é o que
 * o painel mais transcreve. `auto` fica por último e é um degrau pior
 * que dizer qual — um trecho curto classificado errado arrasta a
 * transcrição inteira.
 */
export interface Language {
  readonly id: string;
  readonly label: string;
}

export const LANGUAGES: readonly Language[] = [
  { id: "pt", label: "Português" },
  { id: "en", label: "Inglês" },
  { id: "es", label: "Espanhol" },
  { id: "it", label: "Italiano" },
  { id: "fr", label: "Francês" },
  { id: "de", label: "Alemão" },
  { id: "ja", label: "Japonês" },
  { id: "zh", label: "Chinês" },
  { id: "ko", label: "Coreano" },
  { id: "ru", label: "Russo" },
  { id: "ar", label: "Árabe" },
  { id: "hi", label: "Híndi" },
  { id: "auto", label: "Detectar" },
];

export function findLanguage(id: string): Language {
  return LANGUAGES.find((language) => language.id === id) ?? LANGUAGES[0];
}

export function findModel(id: string): WhisperModel {
  return MODELS.find((model) => model.id === id) ?? MODELS[1];
}

// ── execução ───────────────────────────────────────────────────────

/**
 * O que transcrever: a faixa inteira, já montada.
 *
 * Não é mais "um arquivo com um recorte" — é a lista de entradas do
 * ffmpeg e o filtro que as põe nas suas posições de sequência (ver
 * `timeline.ts`). Uma passada do whisper para a faixa toda, que é o
 * que dá a ele o contexto de que a pontuação precisa.
 */
export interface TranscribeJob {
  /** Argumentos `-ss/-t/-i` de cada clipe, na ordem do filtro. */
  inputs: string[][];
  /** O `filter_complex` que monta a linha do tempo. */
  filter: string;
  /** Até onde vai a faixa, em segundos de sequência. */
  durationSeconds: number;
}

export interface TranscribeResult {
  ok: boolean;
  /** Código curto: "whisper-not-found", "ffmpeg-not-found", "failed"… */
  error: string | null;
  /** O JSON cru do whisper, quando deu certo. */
  json: string | null;
  scriptPath: string | null;
}

export interface StageReport {
  (stage: string): void;
}

/**
 * Transcreve um trecho. Devolve o JSON cru do whisper — a conversão
 * para o schema da Adobe é problema de `toAdobe.ts`, que é puro e
 * testável sem host.
 */
export async function transcribe(
  job: TranscribeJob,
  model: WhisperModel,
  language: string,
  /** O glossário do projeto, que enviesa o modelo. Vazio = sem viés. */
  prompt: string,
  onStage?: StageReport,
  cancelled?: () => boolean,
  onManual?: (scriptPath: string, reason: string) => void
): Promise<TranscribeResult> {
  const shell = shellModule();
  if (!shell) {
    return { ok: false, error: "uxp-unavailable", json: null, scriptPath: null };
  }

  const space = await workspace();
  const scriptPath = nativePath(space, scriptName());
  const outJson = `${OUT_BASE}.json`;

  for (const name of [RESULT_FILE, STAGE_FILE, STARTED_FILE, outJson, "cc-audio.wav"]) {
    await remove(space, name);
  }

  const script = isWindows()
    ? windowsScript(job, model, language, space.nativeBase, prompt)
    : unixScript(job, model, language, space.nativeBase, prompt);
  await write(space, scriptName(), script, true);

  // Sem janela, como o resto do plugin. O Terminal é o plano B.
  const PURPOSE = "Transcrever o áudio das faixas escolhidas.";
  let launchError: string | null = null;
  const sent = await dispatch(scriptName());
  let awaitingStamp = sent.mode !== "denied";
  if (!awaitingStamp) {
    console.error("[Legendas] agente recusado:", sent.error);
    try {
      await shell.openPath(scriptPath, PURPOSE);
    } catch (cause) {
      launchError = describe(cause);
      onManual?.(scriptPath, launchError);
    }
  }

  const stampDeadline = Date.now() + 8000;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastStage = "";

  while (Date.now() < deadline) {
    if (cancelled?.()) {
      return { ok: false, error: "cancelled", json: null, scriptPath };
    }

    if (awaitingStamp && Date.now() > stampDeadline) {
      awaitingStamp = false;
      if (!readText(space, STARTED_FILE)) {
        // Sai da fila antes: um agente que acordasse depois
        // transcreveria por cima do resultado já pronto.
        await withdraw(sent.ticket);
        try {
          await shell.openPath(scriptPath, PURPOSE);
        } catch (cause) {
          launchError = describe(cause);
          onManual?.(scriptPath, launchError);
        }
      }
    }

    const stage = readText(space, STAGE_FILE);
    if (stage && stage !== lastStage) {
      lastStage = stage;
      onStage?.(stage);
    }

    const raw = readText(space, RESULT_FILE);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
        if (parsed.ok !== true) {
          return {
            ok: false,
            error: parsed.error ?? "failed",
            json: null,
            scriptPath,
          };
        }
        return {
          ok: true,
          error: null,
          json: readJson(space, outJson),
          scriptPath,
        };
      } catch {
        // JSON pela metade; o `mv` do script torna isso raro.
      }
    }
    await wait(POLL_MS);
  }

  return {
    ok: false,
    error: launchError ? `launch-denied: ${launchError}` : "timeout",
    json: null,
    scriptPath,
  };
}

/**
 * O JSON do whisper pode passar de um megabyte numa fala longa —
 * `readText` corta em branco e devolve null se vier vazio, então a
 * leitura passa por aqui só para deixar o motivo claro no log.
 */
function readJson(space: Workspace, name: string): string | null {
  const raw = readText(space, name);
  if (!raw) {
    console.error("[Legendas] whisper terminou mas não deixou JSON.");
    return null;
  }
  return raw;
}

function scriptName(): string {
  return isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
}

// ── geração do script ──────────────────────────────────────────────

export function unixScript(
  job: TranscribeJob,
  model: WhisperModel,
  language: string,
  folder: string,
  prompt = ""
): string {
  const lines = [
    "#!/bin/bash",
    "# Gerado pelo Framelab — Legendas. Pode apagar.",
    `printf '\\033]0;Framelab — transcrevendo\\007'`,
    "set -u",
    `WORK=${q(folder)}`,
    'cd "$WORK" || exit 1',
    `printf 1 > "$WORK/${STARTED_FILE}"`,
    `stage() { printf '%s' "$1" > "$WORK/${STAGE_FILE}"; }`,
    `fail() { printf '{"ok":false,"error":"%s"}' "$1" > "$WORK/${RESULT_FILE}.tmp"; ` +
      `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"; exit 1; }`,

    // ── ffmpeg: o mesmo que o resto do plugin provisiona ──
    "FFMPEG=''",
    'for c in "$HOME/Library/Application Support/Framelab/bin/ffmpeg" ' +
      '"/Library/Application Support/Framelab/bin/ffmpeg" /opt/homebrew/bin/ffmpeg ' +
      '/usr/local/bin/ffmpeg /opt/local/bin/ffmpeg /usr/bin/ffmpeg "$WORK/ffmpeg"; do',
    '  if [ -x "$c" ]; then FFMPEG="$c"; break; fi',
    "done",
    'if [ -z "$FFMPEG" ]; then FFMPEG="$(command -v ffmpeg 2>/dev/null || true)"; fi',
    'if [ -z "$FFMPEG" ]; then fail ffmpeg-not-found; fi',

    // ── whisper: procurado nas pastas integradas e no sistema ──
    "WHISPER=''",
    `for c in "$HOME/Library/Application Support/Framelab/bin/whisper-cli" ${WHISPER_CANDIDATES.map(q).join(" ")} "$WORK/whisper-cli"; do`,
    '  if [ -x "$c" ]; then WHISPER="$c"; break; fi',
    "done",
    'if [ -z "$WHISPER" ]; then WHISPER="$(command -v whisper-cli 2>/dev/null || true)"; fi',
    'if [ -z "$WHISPER" ]; then fail whisper-not-found; fi',

    // ── modelo: esse sim, baixado sozinho ──
    `MODEL="$WORK/${model.file}"`,
    'if [ ! -f "$MODEL" ]; then',
    `  stage "Baixando o modelo de transcrição (${model.megabytes} MB, só na primeira vez)…"`,
    `  if ! curl -fsSL --retry 3 -o "$MODEL.tmp" ${q(model.url)}; then rm -f "$MODEL.tmp"; fail model-download; fi`,
    '  mv "$MODEL.tmp" "$MODEL"',
    "fi",

    // ── áudio: a faixa inteira montada em tempo de sequência ──
    'stage "Montando o áudio da faixa…"',
    `"$FFMPEG" -v error -y ` +
      job.inputs.map((args) => args.map(q).join(" ")).join(" ") +
      ` -filter_complex ${q(job.filter)} -map "[out]" ` +
      `-t ${job.durationSeconds.toFixed(6)} ` +
      `-vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/cc-audio.wav" || fail audio-extract`,

    'stage "Transcrevendo…"',
    /*
     * As opções que separam uma legenda boa de uma sofrível, medidas
     * antes de entrarem aqui:
     *   --prompt      enviesa para os termos do projeto (foi o que
     *                 recuperou o nome próprio que virava outra coisa)
     *   -bs/-bo 5     busca em feixe em vez de gulosa
     *   -sns          descarta marcador de não-fala ("[música]")
     *   -et/-lpt      recusa segmento com entropia alta, que é como o
     *                 whisper alucina texto no silêncio
     */
    `"$WHISPER" -m "$MODEL" -f "$WORK/cc-audio.wav" -l ${q(language)} ` +
      `-bs 5 -bo 5 -sns -et 2.4 -lpt -1.0 ` +
      (prompt ? `--prompt ${q(prompt)} ` : "") +
      `-ojf -of "$WORK/${OUT_BASE}" -pp false >/dev/null 2>&1 || fail whisper-failed`,
    `if [ ! -f "$WORK/${OUT_BASE}.json" ]; then fail no-output; fi`,

    // O WAV de 16 kHz de uma hora de fala são ~115 MB; some assim que
    // vira transcrição.
    'rm -f "$WORK/cc-audio.wav"',
    'stage "Pronto."',
    `printf '{"ok":true}' > "$WORK/${RESULT_FILE}.tmp"`,
    `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    `osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 &`,
    "exit 0",
  ];
  return lines.join("\n") + "\n";
}

/** Mesma coreografia em cmd.exe. Não testado num Windows real. */
export function windowsScript(
  job: TranscribeJob,
  model: WhisperModel,
  language: string,
  folder: string,
  prompt = ""
): string {
  const bat = (value: string): string =>
    value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
  const lines = [
    "@echo off",
    "rem Gerado pelo Framelab - Legendas. Pode apagar.",
    "title Framelab - transcrevendo",
    `set "WORK=${bat(folder)}"`,
    'cd /d "%WORK%"',
    `>"%WORK%\\${STARTED_FILE}" echo 1`,
    'set "FFMPEG="',
    'for %%i in (ffmpeg.exe) do @set "FFMPEG=%%~$PATH:i"',
    `if "%FFMPEG%"=="" if exist "%WORK%\\ffmpeg.exe" set "FFMPEG=%WORK%\\ffmpeg.exe"`,
    'if "%FFMPEG%"=="" (',
    `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"ffmpeg-not-found"}`,
    "  exit /b 1",
    ")",
    'set "WHISPER="',
    'for %%i in (whisper-cli.exe) do @set "WHISPER=%%~$PATH:i"',
    'if "%WHISPER%"=="" (',
    `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"whisper-not-found"}`,
    "  exit /b 1",
    ")",
    `set "MODEL=%WORK%\\${bat(model.file)}"`,
    'if not exist "%MODEL%" (',
    `  >"%WORK%\\${STAGE_FILE}" echo Baixando o modelo (${model.megabytes} MB)...`,
    `  curl.exe -fsSL --retry 3 -o "%MODEL%" "${model.url}"`,
    ")",
    `>"%WORK%\\${STAGE_FILE}" echo Montando o audio da faixa...`,
    `"%FFMPEG%" -v error -y ` +
      job.inputs.map((args) => args.map((a) => `"${bat(a)}"`).join(" ")).join(" ") +
      ` -filter_complex "${bat(job.filter)}" -map "[out]" ` +
      `-t ${job.durationSeconds.toFixed(6)} ` +
      `-vn -ac 1 -ar 16000 -c:a pcm_s16le "%WORK%\\cc-audio.wav"`,
    "if errorlevel 1 (",
    `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"audio-extract"}`,
    "  exit /b 1",
    ")",
    `>"%WORK%\\${STAGE_FILE}" echo Transcrevendo...`,
    `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\cc-audio.wav" -l ${bat(language)} ` +
      `-bs 5 -bo 5 -sns -et 2.4 -lpt -1.0 ` +
      (prompt ? `--prompt "${bat(prompt)}" ` : "") +
      `-ojf -of "%WORK%\\${OUT_BASE}" -pp false >nul 2>&1`,
    "if errorlevel 1 (",
    `  >"%WORK%\\${RESULT_FILE}" echo {"ok":false,"error":"whisper-failed"}`,
    "  exit /b 1",
    ")",
    `del /q "%WORK%\\cc-audio.wav" 2>nul`,
    `>"%WORK%\\${RESULT_FILE}" echo {"ok":true}`,
    "exit /b 0",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ── mensagens ──────────────────────────────────────────────────────

export function describeError(code: string | null): string {
  switch (code) {
    case "whisper-not-found":
      return (
        "O motor de transcrição não está instalado. No Terminal: " +
        '"brew install whisper-cpp" — depois volte e analise de novo.'
      );
    case "ffmpeg-not-found":
      return (
        'ffmpeg não encontrado. Instale com "brew install ffmpeg", ou use ' +
        "a ferramenta Baixar Vídeos uma vez, que ela o provisiona sozinha."
      );
    case "model-download":
      return "Não foi possível baixar o modelo. Confira a internet e tente de novo.";
    case "audio-extract":
      return "O ffmpeg não conseguiu ler o áudio deste clipe.";
    case "whisper-failed":
      return "O motor de transcrição não concluiu. Veja o console do UXP.";
    case "no-output":
      return "A transcrição terminou sem produzir arquivo.";
    case "cancelled":
      return "Transcrição cancelada.";
    case "timeout":
      return "A transcrição passou de uma hora e foi abandonada.";
    case "uxp-unavailable":
      return "Este build do Premiere não expõe shell/fs do UXP.";
    default:
      return code ? `Falha: ${code}` : "Falha desconhecida na transcrição.";
  }
}
