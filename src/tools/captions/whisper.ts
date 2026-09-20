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
import { dispatch, stampVerdict, withdraw } from "../download/runner";
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

/*
 * Os nomes ABAIXO são moldes, não endereços.
 *
 * Os geradores de script escrevem estes nomes, e `transcribe` troca
 * cada um pelo nome carimbado da execução antes de gravar o script
 * (ver o bloco de carimbo lá). Ficam aqui num lugar só porque a troca
 * é textual: um nome que aparecesse escrito à mão no script escaparia
 * dela e voltaria a ser compartilhado entre execuções.
 */
const RESULT_FILE = "cc-result.json";
const STAGE_FILE = "cc-stage.txt";
/**
 * O stderr do whisper, guardado em vez de jogado fora.
 *
 * Nele vão o progresso (`progress = 37%`), os tempos por etapa e os
 * "fallbacks" — as redecodificações a temperatura mais alta que
 * multiplicam o tempo em áudio difícil. Sem isto, "está demorando"
 * não tinha diagnóstico possível: cinco minutos de "Transcrevendo…"
 * e nenhum número.
 */
const WHISPER_LOG = "cc-whisper.log";
const STARTED_FILE = "cc-started.txt";
/** Quanto o motor levou, escrito pelo script. Ver `readTiming`. */
const TIMING_FILE = "cc-timing.txt";
const OUT_BASE = "cc-out";
/** O WAV de 16 kHz montado pelo ffmpeg. ~115 MB numa hora de fala. */
const AUDIO_FILE = "cc-audio.wav";
/** Os 30s que a detecção de idioma olha. Ver o gate nos dois scripts. */
const PROBE_FILE = "cc-probe.wav";
/**
 * O que o `-dl` imprimiu, no Windows.
 *
 * O bash lê a saída para uma variável; o cmd não tem como fazer isso
 * sem um `for /f` sobre um comando entre aspas dentro de aspas. O
 * arquivo custa nada e fica legível quando a detecção erra.
 */
const DETECT_FILE = "cc-detect.txt";
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
  /**
   * Largura da busca em feixe.
   *
   * É o botão de velocidade que ninguém vê. O whisper.cpp assume 5, e
   * 5 custa de duas a três vezes o tempo de uma busca estreita — o
   * grosso da espera sai daqui, não do tamanho do modelo. O feixe
   * largo compensa onde o modelo erra e precisa de uma segunda
   * opinião; num modelo que já acerta, ele paga caro por pouco. Por
   * isso o valor acompanha a escada: largo no pequeno, estreito no
   * grande.
   */
  readonly beamSize: number;
}

/**
 * A escada de modelos. Tamanhos e URLs conferidos ao vivo; o do meio
 * é o padrão porque foi o medido — qualidade de topo a 8× tempo real.
 */
export const MODELS: readonly WhisperModel[] = [
  {
    id: "small",
    label: "Rápido",
    note: "181 MB · o mais rápido, erra mais em nome próprio",
    file: "ggml-small-q5_1.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    megabytes: 181,
    beamSize: 5,
  },
  {
    id: "turbo",
    label: "Equilibrado",
    note: "547 MB · o recomendado — 10 min de vídeo em ~3 min",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    megabytes: 547,
    beamSize: 3,
  },
  {
    id: "large",
    label: "Máxima",
    note: "1 GB · bem mais lento, e nos testes não acertou mais que o Equilibrado",
    file: "ggml-large-v3-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
    megabytes: 1031,
    beamSize: 2,
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
  /** No `language-mismatch`: o que o motor ouviu de verdade. */
  detected?: string;
  /** O JSON cru do whisper, quando deu certo. */
  json: string | null;
  scriptPath: string | null;
  /**
   * Quanto o motor levou e para quanto áudio, em segundos.
   *
   * Existe para "está lento" virar um número: `8 min para 12 min de
   * áudio` é uma frase que dá para comparar entre modelos e entre
   * máquinas; "demorou" não é.
   */
  timing?: { elapsedSeconds: number; audioSeconds: number } | null;
}

/** Lê o carimbo de tempo que o script deixou. Ausente não é erro. */
function readTiming(
  space: Workspace,
  timingFile: string
): { elapsedSeconds: number; audioSeconds: number } | null {
  const raw = readText(space, timingFile);
  if (!raw) return null;
  const [gasto, audio] = raw.split(/\s+/).map((n) => Number.parseFloat(n));
  return Number.isFinite(gasto) && Number.isFinite(audio)
    ? { elapsedSeconds: gasto, audioSeconds: audio }
    : null;
}

export interface StageReport {
  (stage: string): void;
}

/**
 * Os arquivos da execução anterior, para a próxima limpar.
 *
 * Não dá para apagá-los no fim da execução: quando o editor cancela, é
 * justamente o órfão que ainda vai escrever neles. Quem varre é a
 * execução seguinte, que já não depende de nada daquela.
 */
let previousRunFiles: string[] = [];

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

  /*
   * Cada execução ganha os SEUS arquivos, e o SEU script.
   *
   * Cancelar no painel só levanta uma bandeira — o whisper e o ffmpeg
   * seguem moendo. Com nomes fixos, o órfão terminava DEPOIS da
   * execução seguinte e escrevia por cima do `cc-out.json` dela: a
   * transcrição do vídeo abandonado entrava no projeto do vídeo novo,
   * sem erro nenhum na tela. Carimbado por execução, o órfão escreve
   * nos nomes velhos e ninguém mais os lê.
   *
   * O script vai junto no carimbo, e não só por simetria: reescrever
   * o .command enquanto o bash dele ainda está rodando é trocar o
   * texto que ele ainda vai ler.
   */
  const tag = Date.now().toString(36);
  const run = {
    result: `cc-${tag}-result.json`,
    stage: `cc-${tag}-stage.txt`,
    started: `cc-${tag}-started.txt`,
    log: `cc-${tag}-whisper.log`,
    timing: `cc-${tag}-timing.txt`,
    outBase: `cc-${tag}-out`,
    audio: `cc-${tag}-audio.wav`,
    probe: `cc-${tag}-probe.wav`,
    detect: `cc-${tag}-detect.txt`,
    script: scriptName(tag),
  };
  const outJson = `${run.outBase}.json`;
  const scriptPath = nativePath(space, run.script);

  /*
   * A limpeza é da execução ANTERIOR e dos nomes fixos que as versões
   * antigas do plugin deixaram na pasta — nunca dos nomes desta, que
   * ainda não existem. O WAV é o que pesa: cada órfão deixa ~115 MB
   * por hora de fala.
   */
  for (const name of [
    ...previousRunFiles,
    RESULT_FILE,
    STAGE_FILE,
    STARTED_FILE,
    WHISPER_LOG,
    TIMING_FILE,
    `${OUT_BASE}.json`,
    AUDIO_FILE,
    PROBE_FILE,
    DETECT_FILE,
    SCRIPT_FILE,
    SCRIPT_FILE_WIN,
  ]) {
    await remove(space, name);
  }
  previousRunFiles = [...Object.values(run), outJson];

  const script = (isWindows()
    ? windowsScript(job, model, language, space.nativeBase, prompt)
    : unixScript(job, model, language, space.nativeBase, prompt))
    .split(RESULT_FILE).join(run.result)
    .split(STAGE_FILE).join(run.stage)
    .split(STARTED_FILE).join(run.started)
    .split(WHISPER_LOG).join(run.log)
    .split(TIMING_FILE).join(run.timing)
    .split(AUDIO_FILE).join(run.audio)
    .split(PROBE_FILE).join(run.probe)
    .split(DETECT_FILE).join(run.detect)
    // Por último: "cc-out" é prefixo de nada, mas é substring curta o
    // bastante para morder um nome já carimbado se vier antes.
    .split(OUT_BASE).join(run.outBase);
  await write(space, run.script, script, true);

  // Sem janela, como o resto do plugin. O Terminal é o plano B.
  const PURPOSE = "Transcrever o áudio das faixas escolhidas.";
  let launchError: string | null = null;
  const sent = await dispatch(run.script);
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

  let stampDeadline = Date.now() + 8000;
  /** Quanto se espera por vez enquanto o agente estiver vivo e ocupado. */
  const BUSY_GRACE_MS = 8000;
  /*
   * Até quando vale esperar na fila. Sem teto, um agente preso num
   * trabalho eterno faria a transcrição esperar o tempo limite inteiro
   * e terminar com a mensagem errada. Três minutos dá folga para o
   * trabalho da frente sair; o que passar disso cai para o Terminal.
   */
  const BUSY_LIMIT = Date.now() + 180_000;
  const deadline = Date.now() + TIMEOUT_MS;
  let lastStage = "";

  while (Date.now() < deadline) {
    if (cancelled?.()) {
      return { ok: false, error: "cancelled", json: null, scriptPath };
    }

    if (awaitingStamp && Date.now() > stampDeadline) {
      /*
       * O prazo estourou. Antes de desistir, pergunta se o agente está
       * vivo: um agente que continua carimbando não morreu, só está
       * ocupado com outro trabalho — baixar um vídeo e transcrevê-lo em
       * seguida é o caso banal. Para esse a resposta certa é esperar,
       * não abrir um Terminal com diálogo de autorização, que é
       * exatamente o que o agente existe para evitar.
       */
      const verdict = await stampVerdict();
      if (verdict === "busy" && Date.now() < BUSY_LIMIT) {
        stampDeadline = Date.now() + BUSY_GRACE_MS;
        console.log("[Legendas] na fila: o agente está com outro trabalho.");
      } else if (!readText(space, run.started)) {
        awaitingStamp = false;
        // Sai da fila antes: um agente que acordasse depois
        // transcreveria por cima do resultado já pronto.
        await withdraw(sent.ticket);
        try {
          await shell.openPath(scriptPath, PURPOSE);
        } catch (cause) {
          launchError = describe(cause);
          onManual?.(scriptPath, launchError);
        }
      } else {
        // O trabalho já começou: não há o que esperar nem para onde cair.
        awaitingStamp = false;
      }
    }

    const stage = readText(space, run.stage);
    // "Transcrevendo…" por cinco minutos é o que faz parecer travado.
    // O whisper sabe o percentual; ele só nunca chegava até aqui.
    const percent = stage?.startsWith("Transcrevendo") ? whisperProgress(space, run.log) : null;
    const shown = percent === null ? stage : `${stage} ${percent}%`;
    if (shown && shown !== lastStage) {
      lastStage = shown;
      onStage?.(shown);
    }

    const raw = readText(space, run.result);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {
          ok?: boolean;
          error?: string;
          detected?: string;
        };
        if (parsed.ok !== true) {
          return {
            ok: false,
            error: parsed.error ?? "failed",
            detected: parsed.detected,
            json: null,
            scriptPath,
          };
        }
        // Conferido de novo AQUI, e não só no topo do laço: o motor
        // pode terminar no mesmo instante em que o editor cancela, e
        // um resultado que chega depois do cancelamento não é um
        // resultado — é o trabalho anterior pedindo para entrar.
        if (cancelled?.()) {
          return { ok: false, error: "cancelled", json: null, scriptPath };
        }
        return {
          ok: true,
          error: null,
          json: readJson(space, outJson),
          scriptPath,
          timing: readTiming(space, run.timing),
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
/** O último `progress = N%` que o whisper escreveu, ou null. */
function whisperProgress(space: Workspace, logFile: string): number | null {
  const log = readText(space, logFile);
  if (!log) return null;
  const hits = log.match(/progress\s*=\s*(\d+)%/g);
  if (!hits) return null;
  const last = /(\d+)%/.exec(hits[hits.length - 1]);
  return last ? Number.parseInt(last[1], 10) : null;
}

function readJson(space: Workspace, name: string): string | null {
  const raw = readText(space, name);
  if (!raw) {
    console.error("[Legendas] whisper terminou mas não deixou JSON.");
    return null;
  }
  return raw;
}

/** Sem carimbo devolve o nome antigo — é o que a limpeza procura. */
function scriptName(tag?: string): string {
  const base = isWindows() ? SCRIPT_FILE_WIN : SCRIPT_FILE;
  return tag ? base.replace(".", `-${tag}.`) : base;
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
    // Nativo, custe o que custar: sob Rosetta o whisper e o ffmpeg rodam
    // emulados e uma transcrição de minutos vira uma de dezenas.
    'if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ] && command -v arch >/dev/null 2>&1; then exec arch -arm64 /bin/bash "$0" "$@"; fi',
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
      `-vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/${AUDIO_FILE}" || fail audio-extract`,

    /*
     * O IDIOMA É CONFERIDO ANTES.
     *
     * Forçar `-l fr` num áudio em português não dá erro: o whisper
     * obedece e devolve francês fluente, inventado, com pontuação
     * perfeita. Foi o que aconteceu — dois minutos de motor para
     * produzir uma tradução alucinada que ninguém pediu, sem um aviso.
     *
     * Detectar custa ~4s (só o encoder nos primeiros 30s) contra os
     * minutos da transcrição inteira, e acerta com folga: 99,9% neste
     * áudio. Barato demais para não fazer.
     *
     * Só barra quando a detecção está CONFIANTE e discorda — sotaque
     * carregado e áudio ruim baixam a certeza, e nesses casos quem
     * manda é a escolha do editor.
     */
    ...(language === "auto"
      ? []
      : [
          'stage "Conferindo o idioma…"',
          // O `-dl` só olha os primeiros 30s, mas LÊ o arquivo inteiro
          // antes de decidir isso: numa faixa de uma hora são ~115 MB
          // de PCM carregados para usar meio por cento deles. Um
          // recorte custa centésimos de segundo e poupa a leitura.
          `"$FFMPEG" -v error -y -t 30 -i "$WORK/${AUDIO_FILE}" -c copy "$WORK/${PROBE_FILE}" 2>/dev/null || cp "$WORK/${AUDIO_FILE}" "$WORK/${PROBE_FILE}"`,
          `DET=$("$WHISPER" -m "$MODEL" -f "$WORK/${PROBE_FILE}" -dl 2>&1 || true)`,
          `rm -f "$WORK/${PROBE_FILE}"`,
          `DETLANG=$(printf '%s' "$DET" | sed -n 's/.*auto-detected language: \\([a-z][a-z]*\\).*/\\1/p' | head -1)`,
          `DETP=$(printf '%s' "$DET" | sed -n 's/.*p = \\([0-9.]*\\).*/\\1/p' | head -1)`,
          // A probabilidade entra como VARIÁVEL do awk. Escrita como
          // `$DETP` dentro do programa, o awk a lê como número de
          // campo — e em BEGIN não há campo nenhum, então a comparação
          // dava sempre falso e a checagem inteira era decorativa.
          // `p+0` cobre o caso de a detecção não ter dito nada.
          `if [ -n "$DETLANG" ] && [ "$DETLANG" != ${q(language)} ] && ` +
            `awk -v p="$DETP" 'BEGIN{exit !(p+0 > 0.70)}' 2>/dev/null; then`,
          `  printf '{"ok":false,"error":"language-mismatch","detected":"%s","p":"%s"}' ` +
            `"$DETLANG" "$DETP" > "$WORK/${RESULT_FILE}.tmp"`,
          `  mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
          `  rm -f "$WORK/${AUDIO_FILE}"`,
          "  exit 1",
          "fi",
        ]),

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
    // Núcleos de desempenho, não todos: num Apple Silicon os de
    // eficiência atrasam o conjunto. Fora do macOS cai para o total.
    'THREADS=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu 2>/dev/null || echo 4)',
    /*
     * Flash attention: de graça, quando o binário tem.
     *
     * Nas builds recentes do whisper.cpp o `-fa` acelera a atenção no
     * Metal sem mexer no resultado. Nas antigas ele não existe — e um
     * argumento desconhecido não é ignorado, o whisper MORRE nele. Daí
     * a pergunta ao `--help` antes: quem tem, usa; quem não tem, roda
     * como rodava.
     */
    `FA=""; "$WHISPER" --help 2>&1 | grep -q -- "-fa" && FA="-fa"`,
    // O relógio de parede desta etapa, para o painel poder dizer
    // "3 min para 10 min de áudio" em vez de só "demorou".
    "T0=$(date +%s)",
    /*
     * `-pp` é uma BANDEIRA. Escrito `-pp false`, o `false` virava um
     * segundo arquivo de entrada ("input file not found 'false'") — o
     * whisper reclamava e seguia, mas o progresso nunca chegou ao
     * painel. O stderr vai para o log, não para o nada: é dele que
     * saem o percentual e o diagnóstico de lentidão.
     */
    `"$WHISPER" -m "$MODEL" -f "$WORK/${AUDIO_FILE}" -l ${q(language)} ` +
      `-t "$THREADS" $FA -bs ${model.beamSize} -bo ${model.beamSize} -sns -et 2.4 -lpt -1.0 ` +
      (prompt ? `--prompt ${q(prompt)} ` : "") +
      `-ojf -of "$WORK/${OUT_BASE}" -pp >/dev/null 2>"$WORK/${WHISPER_LOG}" || fail whisper-failed`,
    // Quanto levou, e para quantos segundos de áudio. É o número que
    // transforma "está lento" em algo que dá para conferir.
    `printf '%s %s' "$(( $(date +%s) - T0 ))" ${q(job.durationSeconds.toFixed(1))} > "$WORK/${TIMING_FILE}"`,
    `if [ ! -f "$WORK/${OUT_BASE}.json" ]; then fail no-output; fi`,

    // O WAV de 16 kHz de uma hora de fala são ~115 MB; some assim que
    // vira transcrição.
    `rm -f "$WORK/${AUDIO_FILE}"`,
    'stage "Pronto."',
    `printf '{"ok":true}' > "$WORK/${RESULT_FILE}.tmp"`,
    `mv "$WORK/${RESULT_FILE}.tmp" "$WORK/${RESULT_FILE}"`,
    // Só fecha janela se o Terminal JÁ estiver aberto. `tell application
    // "Terminal"` LANÇA o Terminal quando ele não está rodando — era isto
    // que fazia uma janela vazia aparecer no FIM de cada trabalho, mesmo
    // com o agente silencioso funcionando.
    `if pgrep -xq Terminal; then osascript -e 'tell application "Terminal" to close (every window whose name contains "Framelab")' >/dev/null 2>&1 & fi`,
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
  /*
   * Resultado em `.tmp` e só então `move` — como em todo o resto do
   * plugin, e como o `fail()` do script do macOS. O painel relê o
   * arquivo de resultado a cada 400ms; escrever direto no nome que ele
   * observa abre uma janela em que a leitura pega meio JSON. O `mv` do
   * lado Unix fechou essa janela há tempos; o .bat era o único lugar
   * que ainda escrevia por cima do nome observado.
   */
  const emit = (json: string, indent = ""): string[] => [
    `${indent}>"%WORK%\\${RESULT_FILE}.tmp" echo ${json}`,
    `${indent}move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
  ];
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
    ...emit('{"ok":false,"error":"ffmpeg-not-found"}', "  "),
    "  exit /b 1",
    ")",
    'set "WHISPER="',
    'for %%i in (whisper-cli.exe) do @set "WHISPER=%%~$PATH:i"',
    'if "%WHISPER%"=="" (',
    ...emit('{"ok":false,"error":"whisper-not-found"}', "  "),
    "  exit /b 1",
    ")",
    `set "MODEL=%WORK%\\${bat(model.file)}"`,

    /*
     * O modelo baixa para `.tmp` e só então vira o nome final — o
     * mesmo `curl -o "$MODEL.tmp"` do macOS.
     *
     * Escrevendo direto no nome final, uma internet que caiu no meio
     * do gigabyte deixava o arquivo truncado LÁ, e a execução seguinte
     * só olhava `if not exist`: o modelo "existia", o whisper morria
     * ao carregá-lo, e o painel dizia whisper-failed — uma falha de
     * rede vestida de falha do motor, que não se conserta sozinha
     * nunca mais, porque o download nunca mais é tentado.
     *
     * `if errorlevel 1` e não `%ERRORLEVEL%`: dentro de um bloco entre
     * parênteses o segundo é expandido na hora de LER o bloco, quando
     * o curl ainda nem rodou. (Como o resto do .bat, não testado num
     * Windows real.)
     */
    'if not exist "%MODEL%" (',
    `  >"%WORK%\\${STAGE_FILE}" echo Baixando o modelo (${model.megabytes} MB)...`,
    `  curl.exe -fsSL --retry 3 -o "%MODEL%.tmp" "${model.url}"`,
    "  if errorlevel 1 (",
    `    del /q "%MODEL%.tmp" 2>nul`,
    ...emit('{"ok":false,"error":"model-download"}', "    "),
    "    exit /b 1",
    "  )",
    `  move /y "%MODEL%.tmp" "%MODEL%" >nul`,
    ")",
    `>"%WORK%\\${STAGE_FILE}" echo Montando o audio da faixa...`,
    `"%FFMPEG%" -v error -y ` +
      job.inputs.map((args) => args.map((a) => `"${bat(a)}"`).join(" ")).join(" ") +
      ` -filter_complex "${bat(job.filter)}" -map "[out]" ` +
      `-t ${job.durationSeconds.toFixed(6)} ` +
      `-vn -ac 1 -ar 16000 -c:a pcm_s16le "%WORK%\\${AUDIO_FILE}"`,
    "if errorlevel 1 (",
    ...emit('{"ok":false,"error":"audio-extract"}', "  "),
    "  exit /b 1",
    ")",

    /*
     * O MESMO gate de idioma do macOS, pelo mesmo motivo: forçar `-l fr`
     * num áudio em português não dá erro, dá francês inventado com
     * pontuação perfeita — minutos de motor para produzir uma tradução
     * que ninguém pediu. Detectar custa ~4s contra isso.
     *
     * Duas diferenças de tradução para o cmd, ambas sem Windows real
     * para conferir (vale para o arquivo inteiro):
     *  · `!VAR:*texto=!` corta tudo até o texto, inclusive — é o que o
     *    `sed` faz do outro lado, e não depende do prefixo que o
     *    whisper imprime antes de "auto-detected language:".
     *  · o cmd não compara número com ponto. `gtr` entre "0.99" e
     *    "0.70" é comparação de TEXTO, que dá o mesmo resultado aqui
     *    porque o whisper sempre imprime a probabilidade com um dígito
     *    antes do ponto.
     */
    ...(language === "auto"
      ? []
      : [
          `>"%WORK%\\${STAGE_FILE}" echo Conferindo o idioma...`,
          // O `-dl` só olha os primeiros 30s, mas lê o arquivo inteiro
          // antes de decidir isso. O recorte poupa a leitura.
          `"%FFMPEG%" -v error -y -t 30 -i "%WORK%\\${AUDIO_FILE}" -c copy "%WORK%\\${PROBE_FILE}" 2>nul`,
          `if not exist "%WORK%\\${PROBE_FILE}" copy /y "%WORK%\\${AUDIO_FILE}" "%WORK%\\${PROBE_FILE}" >nul`,
          `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\${PROBE_FILE}" -dl >"%WORK%\\${DETECT_FILE}" 2>&1`,
          `del /q "%WORK%\\${PROBE_FILE}" 2>nul`,
          "setlocal enabledelayedexpansion",
          'set "DETLINE="',
          'set "DETLANG="',
          'set "DETP="',
          `for /f "delims=" %%L in ('findstr /c:"auto-detected language" "%WORK%\\${DETECT_FILE}"') do set "DETLINE=%%L"`,
          'set "DETREST=!DETLINE:*auto-detected language: =!"',
          // `pt (p = 0.99)` com espaço e parênteses por delimitador:
          // token 1 é o idioma, token 4 é a probabilidade.
          'for /f "tokens=1,4 delims= ()" %%a in ("!DETREST!") do (set "DETLANG=%%a" & set "DETP=%%b")',
          // Detecção muda ou insegura: quem manda é a escolha do editor.
          "if \"!DETLANG!\"==\"\" goto :cc_lang_ok",
          `if /i "!DETLANG!"=="${bat(language)}" goto :cc_lang_ok`,
          'if not "!DETP!" gtr "0.70" goto :cc_lang_ok',
          `>"%WORK%\\${RESULT_FILE}.tmp" echo {"ok":false,"error":"language-mismatch","detected":"!DETLANG!","p":"!DETP!"}`,
          `move /y "%WORK%\\${RESULT_FILE}.tmp" "%WORK%\\${RESULT_FILE}" >nul`,
          `del /q "%WORK%\\${AUDIO_FILE}" 2>nul`,
          "endlocal",
          "exit /b 1",
          ":cc_lang_ok",
          "endlocal",
        ]),

    `>"%WORK%\\${STAGE_FILE}" echo Transcrevendo...`,
    // O feixe vem do modelo, não de um 5 fixo: é o mesmo botão de
    // velocidade que o macOS usa, e num modelo grande ele é o
    // principal responsável pela espera.
    `"%WHISPER%" -m "%MODEL%" -f "%WORK%\\${AUDIO_FILE}" -l ${bat(language)} ` +
      `-bs ${model.beamSize} -bo ${model.beamSize} -sns -et 2.4 -lpt -1.0 ` +
      (prompt ? `--prompt "${bat(prompt)}" ` : "") +
      `-ojf -of "%WORK%\\${OUT_BASE}" -pp >nul 2>"%WORK%\\${WHISPER_LOG}"`,
    "if errorlevel 1 (",
    ...emit('{"ok":false,"error":"whisper-failed"}', "  "),
    "  exit /b 1",
    ")",
    `del /q "%WORK%\\${AUDIO_FILE}" 2>nul`,
    ...emit('{"ok":true}'),
    "exit /b 0",
  ];
  return lines.join("\r\n") + "\r\n";
}

// ── mensagens ──────────────────────────────────────────────────────

export function describeError(code: string | null, detected?: string): string {
  if (code === "language-mismatch") {
    // `findLanguage` cai no primeiro da lista quando não conhece o
    // código — mostrar "Português" para um alemão detectado seria
    // trocar um erro por outro. Melhor o código cru.
    const conhecido = LANGUAGES.find((entry) => entry.id === detected);
    const ouvido = conhecido?.label ?? (detected ? detected.toUpperCase() : "outro idioma");
    return (
      `O áudio parece estar em ${ouvido}, não no idioma escolhido. ` +
      "Troque o idioma acima (ou use Detectar) e transcreva de novo — " +
      "forçar o idioma errado faz o motor inventar uma tradução."
    );
  }
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
