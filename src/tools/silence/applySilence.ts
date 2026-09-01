/**
 * Corte de Silêncios — timeline.
 *
 * ── Por que o corte é feito assim ──────────────────────────────────
 * O UXP não tem razor. A Adobe confirmou no fórum de desenvolvedores
 * que não há API de split planejada para o 1.0, e não existe nada em
 * `SequenceEditor` que parta um track item em dois. O que existe é
 * suficiente para chegar ao mesmo resultado: remove-se o item original
 * e reescrevem-se, por cima, N instâncias do MESMO ClipProjectItem —
 * cada uma com o in/out do trecho que sobrevive, posicionada onde
 * deveria cair depois de fechar os silêncios. Para o editor, o
 * resultado é indistinguível de ter passado a lâmina.
 *
 * O preço é honesto e está dito na interface: o track item novo nasce
 * limpo, então efeitos, keyframes e volume aplicados NAQUELE clipe da
 * timeline não sobrevivem ao corte. Por isso a ferramenta corta antes
 * de o clipe receber tratamento — que é a ordem natural do trabalho.
 *
 * Cada segmento vai numa transação própria porque o in/out precisa
 * estar no item de projeto ANTES do overwrite que o consome; ações
 * dentro de uma mesma transação não observam os efeitos umas das
 * outras. Como isso empilha um passo de undo por segmento, a
 * ferramenta guarda o estado anterior e oferece o próprio "Desfazer",
 * que devolve cada clipe original inteiro numa passada só.
 */
import type {
  premierepro,
  AudioClipTrackItem,
  ClipProjectItem,
  CompoundAction,
  FolderItem,
  Project,
  ProjectItem,
  Sequence,
  SequenceEditor,
  TrackItemSelection,
  VideoClipTrackItem,
} from "@adobe/premierepro";
import {
  describeError,
  getPremiere,
  readTicksPerFrame,
  snapTicksToFrame,
} from "../../bridge/premiere";
import { planSegments, type SegmentPlan, type VoicedSpan } from "./detect";
import { readTranscript, type TranscriptStatus } from "./transcript";
import type { DetectionMode, SilenceParams } from "./presets";
import {
  describeExtractionError,
  extractAudio,
  readEnvelope,
  type AudioJob,
} from "./ffmpeg";
import {
  resolveThreshold,
  spansFromEnvelope,
  type Envelope,
} from "./waveform";

/** Ticks por segundo do Premiere, quando o host não souber informar. */
const TICKS_PER_SECOND_FALLBACK = 254016000000n;

export type ClipStatus =
  | "ready"
  | "nothing"
  | "no-transcript"
  | "no-speech"
  | "no-media"
  | "speed"
  | "error";

/** Um clipe da seleção, com tudo que o painel e o executor precisam. */
export interface ClipTarget {
  key: string;
  name: string;
  /** -1 quando o clipe não tem essa mídia na seleção. */
  trackVideo: number;
  trackAudio: number;
  /** Posição na sequência, em ticks. */
  startTicks: string;
  endTicks: string;
  /** Trecho do source que está na timeline, em ticks. */
  inTicks: string;
  outTicks: string;
  /** O mesmo trecho em segundos — o espaço em que o plano é calculado. */
  sourceStart: number;
  sourceEnd: number;
  durationSeconds: number;
  status: ClipStatus;
  /** Preenchido quando `status` é "error". */
  detail: string | null;
  /**
   * true quando existe um item de áudio da MESMA mídia, no mesmo
   * lugar, que ficou fora da seleção. Cortar só o vídeo dessincroniza
   * o áudio em silêncio — a interface avisa antes.
   */
  orphanAudio: boolean;
  /** Cache da transcrição: permite recalcular sem reler o host. */
  words: VoicedSpan[];
  /** Modo onda: a curva de dB, que sobrevive à leitura do PCM. */
  envelope: Envelope | null;
  /** Limiar aplicado na última conta, em dBFS. Para a interface mostrar. */
  thresholdDb: number | null;
  /** Caminho da mídia no disco — o que o ffmpeg recebe. */
  mediaPath: string | null;
  plan: SegmentPlan | null;

  /**
   * Id do item de projeto que alimenta o clipe.
   *
   * É a única identidade que atravessa uma transação: os handles abaixo
   * o Premiere invalida assim que o projeto muda.
   */
  projectItemId: string;

  // Handles vivos, válidos enquanto a seleção não mudar.
  videoItem: VideoClipTrackItem | null;
  audioItem: AudioClipTrackItem | null;
  projectItem: ProjectItem;
  clipItem: ClipProjectItem;
}

export interface SilenceScan {
  mode: DetectionMode;
  clips: ClipTarget[];
  /** Duração de um frame da sequência, em segundos. */
  frameSeconds: number;
  ticksPerFrame: bigint | null;
  /** Soma das durações de tudo que foi lido. */
  totalSeconds: number;
  /** Soma do que sai, considerando só os clipes prontos. */
  removedSeconds: number;
  /** Número de cortes que serão feitos. */
  cuts: number;
  /** Clipes com plano de corte válido. */
  readyCount: number;
}

export interface SilenceResult {
  ok: boolean;
  message: string;
  snapshot: CutSnapshot | null;
}

/** O necessário para devolver a timeline ao estado anterior. */
export interface CutSnapshot {
  runs: RunSnapshot[];
  clipCount: number;
  cuts: number;
  removedSeconds: number;
}

interface RunSnapshot {
  trackVideo: number;
  trackAudio: number;
  /** Região da sequência que a ferramenta reescreveu. */
  writtenStart: string;
  writtenEnd: string;
  originals: Array<{
    /** O que sobrevive: o id relê o handle quando ele morre. */
    projectItemId: string;
    /** Handle do momento do corte, só como último recurso. */
    projectItem: ProjectItem;
    startTicks: string;
    inTicks: string;
    outTicks: string;
  }>;
}

// ── leitura ────────────────────────────────────────────────────────

export interface ScanOptions {
  mode: DetectionMode;
  /** Caminho do ffmpeg escolhido à mão. Vazio = o script descobre. */
  ffmpegPath: string;
  /** Frase de estado, para a barra do Shell. */
  onStage?: (text: string) => void;
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
  /** O sistema recusou executar: o script existe e pode ir na mão. */
  onManual?: (scriptPath: string, reason: string) => void;
}

/**
 * Lê a seleção da timeline e monta o plano de corte de cada clipe.
 *
 * Nunca lança por causa de um clipe: o que não dá para cortar vira uma
 * linha com motivo na lista, e os outros seguem. Lança só quando não
 * há sequência, ou quando a extração de áudio inteira falhou — aí não
 * existe plano nenhum a mostrar.
 */
export async function scanSelection(
  params: SilenceParams,
  options: ScanOptions
): Promise<SilenceScan> {
  const ppro = getPremiere();
  if (!ppro) {
    throw new Error("Premiere UXP runtime indisponível.");
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new Error("Nenhum projeto aberto.");
  }
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new Error("Abra uma sequência na timeline primeiro.");
  }

  const ticksPerFrame = await readTicksPerFrame(sequence);
  const perSecond = ticksPerSecond(ppro);
  const frameSeconds = ticksPerFrame
    ? Number(ticksPerFrame) / Number(perSecond)
    : 1 / 30;

  options.onStage?.("Lendo a seleção…");
  const pairs = await collectSelectedPairs(ppro, sequence);
  const clips: ClipTarget[] = [];

  for (const pair of pairs) {
    const target = await describePair(ppro, pair, options.mode);
    if (target) {
      clips.push(target);
    }
  }

  if (options.mode === "waveform") {
    await attachEnvelopes(clips, options);
  }

  const scan: SilenceScan = {
    mode: options.mode,
    clips,
    frameSeconds,
    ticksPerFrame,
    totalSeconds: 0,
    removedSeconds: 0,
    cuts: 0,
    readyCount: 0,
  };
  recomputePlans(scan, params);
  return scan;
}

/**
 * Recalcula o plano de todos os clipes com os parâmetros atuais.
 *
 * Roda inteiro em memória, com a transcrição já lida — é o que
 * permite arrastar um slider e ver o total mudar na hora.
 */
export function recomputePlans(scan: SilenceScan, params: SilenceParams): void {
  let removed = 0;
  let cuts = 0;
  let ready = 0;
  let total = 0;

  for (const clip of scan.clips) {
    total += clip.durationSeconds;
    if (clip.status === "error" || clip.status === "speed" || clip.status === "no-media") {
      continue;
    }

    const voiced = voicedSpansFor(scan.mode, clip, params);
    if (voiced.length === 0) {
      clip.plan = null;
      // "no-transcript" já foi decidido na leitura; não sobrescreve.
      if (clip.status !== "no-transcript") {
        clip.status = "no-speech";
      }
      continue;
    }

    const plan = planSegments(
      voiced,
      { start: clip.sourceStart, end: clip.sourceEnd },
      params,
      scan.frameSeconds
    );

    // Um plano que apagaria o clipe inteiro é um plano errado — no modo
    // onda, um limiar acima da própria voz; no modo transcrição, uma
    // transcrição que não bate com este trecho do source.
    if (plan.keep.length === 0) {
      clip.plan = null;
      clip.status = "no-speech";
      continue;
    }

    clip.plan = plan;
    if (plan.drop.length === 0) {
      clip.status = "nothing";
      continue;
    }

    clip.status = "ready";
    ready += 1;
    cuts += plan.drop.length;
    removed += plan.removedSeconds;
  }

  scan.totalSeconds = total;
  scan.removedSeconds = removed;
  scan.cuts = cuts;
  scan.readyCount = ready;
}

/**
 * De onde saem os intervalos de fala deste clipe.
 *
 * É o único ponto em que os dois modos divergem. Na onda, o limiar é
 * resolvido AQUI, a cada recálculo, contra a curva já em memória — é
 * por isso que arrastar o slider de dB responde na hora em vez de
 * chamar o ffmpeg de novo.
 */
function voicedSpansFor(
  mode: DetectionMode,
  clip: ClipTarget,
  params: SilenceParams
): VoicedSpan[] {
  if (mode === "transcript") {
    clip.thresholdDb = null;
    return clip.words;
  }
  if (!clip.envelope || clip.envelope.db.length === 0) {
    clip.thresholdDb = null;
    return [];
  }
  const threshold = resolveThreshold(
    clip.envelope,
    params.autoThreshold,
    params.dbMargin,
    params.dbThreshold
  );
  clip.thresholdDb = threshold.db;
  return spansFromEnvelope(clip.envelope, threshold.db);
}

// ── seleção ────────────────────────────────────────────────────────

interface SelectedPair {
  videoItem: VideoClipTrackItem | null;
  audioItem: AudioClipTrackItem | null;
  trackVideo: number;
  trackAudio: number;
  /** Mesma mídia, mesmo lugar: o que casa vídeo com áudio. */
  identity: string | null;
  orphanAudio: boolean;
}

/**
 * Os clipes selecionados, com vídeo e áudio do mesmo clipe já casados.
 *
 * Um clipe linkado aparece duas vezes na timeline — uma faixa de vídeo
 * e uma de áudio — e precisa ser tratado como uma coisa só: o
 * overwrite recoloca as duas mídias de uma vez, e processá-las
 * separadamente escreveria o áudio duas vezes.
 */
async function collectSelectedPairs(
  ppro: premierepro,
  sequence: Sequence
): Promise<SelectedPair[]> {
  const pairs: SelectedPair[] = [];
  const byIdentity = new Map<string, SelectedPair>();
  /** Áudio da mesma mídia e do mesmo lugar que NÃO está selecionado. */
  const loose = new Set<string>();

  const videoCount = await sequence.getVideoTrackCount();
  for (let index = 0; index < videoCount; index++) {
    const track = await sequence.getVideoTrack(index);
    if (!track) {
      continue;
    }
    for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      if (!(await item.getIsSelected())) {
        continue;
      }
      const key = await itemIdentity(item);
      const pair: SelectedPair = {
        videoItem: item,
        audioItem: null,
        trackVideo: index,
        trackAudio: -1,
        identity: key,
        orphanAudio: false,
      };
      pairs.push(pair);
      if (key) {
        byIdentity.set(key, pair);
      }
    }
  }

  const audioCount = await sequence.getAudioTrackCount();
  for (let index = 0; index < audioCount; index++) {
    const track = await sequence.getAudioTrack(index);
    if (!track) {
      continue;
    }
    for (const item of track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      if (!(await item.getIsSelected())) {
        // Guardado, não ignorado: um áudio linkado fora da seleção é
        // exatamente o que dessincroniza o clipe depois do corte. A
        // identidade só é calculada quando há vídeo selecionado que
        // possa ficar órfão — são três chamadas ao host por item.
        if (byIdentity.size > 0) {
          const orphan = await itemIdentity(item);
          if (orphan) {
            loose.add(orphan);
          }
        }
        continue;
      }
      const key = await itemIdentity(item);
      const linked = key ? byIdentity.get(key) : undefined;
      if (linked && linked.trackAudio === -1) {
        linked.audioItem = item;
        linked.trackAudio = index;
        continue;
      }
      pairs.push({
        videoItem: null,
        audioItem: item,
        trackVideo: -1,
        trackAudio: index,
        identity: key,
        orphanAudio: false,
      });
    }
  }

  for (const pair of pairs) {
    if (pair.videoItem && pair.trackAudio === -1 && pair.identity) {
      pair.orphanAudio = loose.has(pair.identity);
    }
  }

  return pairs;
}

/**
 * Identidade de um item para casar vídeo com áudio.
 *
 * Mesma mídia, mesmo lugar na sequência, mesmo trecho do source: é o
 * que define um par linkado. Não há campo de link exposto pela API, e
 * essa tripla não colide na prática — dois clipes distintos não podem
 * ocupar o mesmo intervalo na mesma faixa.
 */
async function itemIdentity(
  item: VideoClipTrackItem | AudioClipTrackItem
): Promise<string | null> {
  try {
    const projectItem = await item.getProjectItem();
    const start = await item.getStartTime();
    const end = await item.getEndTime();
    return `${projectItem.getId()}|${start.ticks}|${end.ticks}`;
  } catch {
    return null;
  }
}

async function describePair(
  ppro: premierepro,
  pair: SelectedPair,
  mode: DetectionMode
): Promise<ClipTarget | null> {
  const item = pair.videoItem ?? pair.audioItem;
  if (!item) {
    return null;
  }

  try {
    const start = await item.getStartTime();
    const end = await item.getEndTime();
    const inPoint = await item.getInPoint();
    const outPoint = await item.getOutPoint();
    const projectItem = await item.getProjectItem();
    const name = await item.getName().catch(() => projectItem.name ?? "clipe");

    const base: Omit<ClipTarget, "status" | "detail" | "words" | "plan"> = {
      envelope: null,
      thresholdDb: null,
      mediaPath: null,
      key: `${pair.trackVideo}:${pair.trackAudio}:${start.ticks}`,
      name,
      trackVideo: pair.trackVideo,
      trackAudio: pair.trackAudio,
      startTicks: start.ticks,
      endTicks: end.ticks,
      inTicks: inPoint.ticks,
      outTicks: outPoint.ticks,
      sourceStart: inPoint.seconds,
      sourceEnd: outPoint.seconds,
      durationSeconds: Math.max(0, end.seconds - start.seconds),
      orphanAudio: pair.orphanAudio,
      videoItem: pair.videoItem,
      audioItem: pair.audioItem,
      projectItem,
      clipItem: ppro.ClipProjectItem.cast(projectItem),
      projectItemId: safeId(projectItem),
    };

    // Velocidade alterada quebra a conta: um segundo de source deixa de
    // valer um segundo de sequência, e cada tick calculado aqui cairia
    // no lugar errado. Melhor recusar do que cortar torto.
    const speed = await item.getSpeed().catch(() => 1);
    if (Number.isFinite(speed) && Math.abs(speed - 1) > 0.001) {
      return { ...base, status: "speed", detail: null, words: [], plan: null };
    }

    if (mode === "waveform") {
      // Sem caminho de mídia não há o que o ffmpeg leia: é o caso de
      // gráfico, cor sólida, camada de ajuste e mídia offline.
      const mediaPath = await base.clipItem
        .getMediaFilePath()
        .catch(() => "");
      return {
        ...base,
        mediaPath: mediaPath || null,
        status: mediaPath ? "no-speech" : "no-media",
        detail: null,
        words: [],
        plan: null,
      };
    }

    const transcript = await readTranscript(ppro, base.clipItem);
    if (transcript.status === "error" || transcript.status === "unsupported") {
      return {
        ...base,
        status: "error",
        detail:
          transcript.detail ??
          "API de transcrição indisponível nesta versão do Premiere.",
        words: [],
        plan: null,
      };
    }

    return {
      ...base,
      status: transcriptStatusToClip(transcript.status),
      detail: null,
      words: transcript.words,
      plan: null,
    };
  } catch (cause) {
    console.error("[Silêncios] falha ao ler clipe:", cause);
    return null;
  }
}

// ── modo onda ──────────────────────────────────────────────────────

/**
 * Curvas já extraídas, por arquivo de mídia.
 *
 * Vive pelo tempo da sessão. Reanalisar a mesma seleção, ou cortar um
 * segundo clipe do mesmo arquivo, não chama o ffmpeg de novo — e
 * chamar o ffmpeg é a única parte cara de tudo isto.
 */
const envelopeCache = new Map<string, { envelope: Envelope; at: number }>();

/**
 * Validade de uma curva.
 *
 * A chave é só caminho+trecho: um arquivo re-exportado NO MESMO
 * caminho serviria a onda antiga pela sessão inteira, e os cortes
 * cairiam onde os silêncios ESTAVAM. Dez minutos limitam o estrago ao
 * intervalo em que ninguém re-exporta sem re-analisar.
 */
const ENVELOPE_TTL_MS = 10 * 60 * 1000;

/**
 * Teto do cache.
 *
 * Dez minutos de áudio são ~30 mil floats por envelope. Sem teto o mapa
 * crescia pela sessão inteira, uma entrada por arquivo por trecho
 * varrido — e nada nunca o esvaziava.
 */
const ENVELOPE_CACHE_MAX = 24;

/** Folga antes e depois do trecho usado, para o limiar ter contexto. */
const PREROLL_SECONDS = 0.5;

/** Lookup that also refreshes recency, so the cap evicts the coldest. */
function cachedEnvelope(key: string): Envelope | undefined {
  const found = envelopeCache.get(key);
  if (!found) {
    return undefined;
  }
  if (Date.now() - found.at > ENVELOPE_TTL_MS) {
    envelopeCache.delete(key);
    return undefined;
  }
  envelopeCache.delete(key);
  envelopeCache.set(key, found);
  return found.envelope;
}

function cacheEnvelope(key: string, envelope: Envelope): void {
  // A Map iterates in insertion order, so the first key is the coldest.
  while (envelopeCache.size >= ENVELOPE_CACHE_MAX) {
    const coldest = envelopeCache.keys().next().value;
    if (coldest === undefined) {
      break;
    }
    envelopeCache.delete(coldest);
  }
  envelopeCache.set(key, { envelope, at: Date.now() });
}

/**
 * Extrai o áudio do que a seleção usa e pendura a curva em cada clipe.
 *
 * Uma extração por ARQUIVO, cobrindo a união dos trechos usados: dez
 * clipes do mesmo bruto são um job só. E um único `openPath` para a
 * varredura inteira, porque cada um é um diálogo de consentimento.
 */
async function attachEnvelopes(
  clips: ClipTarget[],
  options: ScanOptions
): Promise<void> {
  interface MediaNeed {
    mediaPath: string;
    from: number;
    to: number;
    clips: ClipTarget[];
  }

  const needs = new Map<string, MediaNeed>();
  for (const clip of clips) {
    if (!clip.mediaPath || clip.status === "no-media" || clip.status === "speed") {
      continue;
    }
    const from = Math.max(0, clip.sourceStart - PREROLL_SECONDS);
    const to = clip.sourceEnd + PREROLL_SECONDS;
    const found = needs.get(clip.mediaPath);
    if (found) {
      found.from = Math.min(found.from, from);
      found.to = Math.max(found.to, to);
      found.clips.push(clip);
    } else {
      needs.set(clip.mediaPath, { mediaPath: clip.mediaPath, from, to, clips: [clip] });
    }
  }
  if (needs.size === 0) {
    return;
  }

  const jobs: AudioJob[] = [];
  const pending: MediaNeed[] = [];
  const runTag = Date.now().toString(36);
  let index = 0;
  for (const need of needs.values()) {
    const cached = cachedEnvelope(cacheKey(need.mediaPath, need.from, need.to));
    if (cached) {
      assignEnvelope(need.clips, cached);
      continue;
    }
    index += 1;
    jobs.push({
      mediaPath: need.mediaPath,
      offsetSeconds: need.from,
      durationSeconds: Math.max(0.1, need.to - need.from),
      // O carimbo isola execuções: cancelar deixa um script órfão
      // terminando de escrever, e sem nomes próprios a varredura
      // seguinte lia o PCM DELE como se fosse o dela.
      file: `audio-${runTag}-${index}.pcm`,
    });
    pending.push(need);
  }
  if (jobs.length === 0) {
    return;
  }

  options.onStage?.(
    jobs.length === 1
      ? "Extraindo o áudio com o ffmpeg…"
      : `Extraindo o áudio de ${jobs.length} arquivos…`
  );

  const run = await extractAudio(
    jobs,
    options.ffmpegPath,
    options.onProgress,
    options.cancelled,
    options.onManual
  );
  if (!run.ok) {
    throw new Error(describeExtractionError(run.error));
  }

  options.onStage?.("Medindo a onda…");
  for (let position = 0; position < jobs.length; position++) {
    const job = jobs[position];
    const need = pending[position];
    try {
      const envelope = await readEnvelope(job.file, job.offsetSeconds);
      cacheEnvelope(cacheKey(need.mediaPath, need.from, need.to), envelope);
      assignEnvelope(need.clips, envelope);
    } catch (cause) {
      const detail = describeError(cause);
      for (const clip of need.clips) {
        clip.status = "error";
        clip.detail = `Não foi possível ler o áudio extraído: ${detail}`;
      }
    }
  }
}

function assignEnvelope(clips: readonly ClipTarget[], envelope: Envelope): void {
  for (const clip of clips) {
    clip.envelope = envelope;
    // O plano decide o resto; aqui só deixa de ser "sem mídia".
    clip.status = "no-speech";
  }
}

function cacheKey(mediaPath: string, from: number, to: number): string {
  return `${mediaPath}|${from.toFixed(2)}|${to.toFixed(2)}`;
}

function transcriptStatusToClip(status: TranscriptStatus): ClipStatus {
  switch (status) {
    case "ok":
      return "ready";
    case "empty":
      return "no-speech";
    default:
      return "no-transcript";
  }
}
// ── execução ───────────────────────────────────────────────────────

/**
 * Um pedaço que sobrevive, já resolvido em ticks e posição final.
 *
 * Guarda o **id** do item de projeto, não o handle: o id atravessa
 * qualquer transação, o handle não. O handle vai junto só como último
 * recurso, para o caso de o id não aparecer na bin (subclipe, clipe
 * mesclado, mídia solta em projeto compartilhado).
 */
interface Write {
  projectItemId: string;
  fallbackItem: ProjectItem;
  inTicks: bigint;
  outTicks: bigint;
  position: bigint;
  trackVideo: number;
  trackAudio: number;
}

export interface ApplyProgress {
  (done: number, total: number): void;
}

/**
 * Os handles vivos do host.
 *
 * Toda transação muda o estado do projeto, e o Premiere invalida os
 * objetos de script criados antes dela — é exatamente daí que sai
 * "The script object is no longer valid". Então nada aqui é guardado
 * por muito tempo: `reopenHost` relê projeto, sequência, editor e a bin
 * inteira, e `commitStable` chama isso sozinho quando uma transação cai.
 */
interface HostHandles {
  project: Project;
  sequence: Sequence;
  editor: SequenceEditor;
  /** id do item de projeto → handle recém-lido da bin. */
  items: Map<string, ProjectItem>;
}

type OpenedHost =
  | { ok: true; host: HostHandles }
  | { ok: false; message: string };

async function openHost(ppro: premierepro): Promise<OpenedHost> {
  const project = await ppro.Project.getActiveProject();
  const sequence = project ? await project.getActiveSequence() : null;
  if (!project || !sequence) {
    return { ok: false, message: "Abra uma sequência na timeline." };
  }
  const editor = resolveEditor(ppro, sequence);
  if (!editor) {
    return { ok: false, message: "SequenceEditor indisponível nesta versão." };
  }
  const items = await buildProjectItemMap(ppro, project);
  return { ok: true, host: { project, sequence, editor, items } };
}

/** Relê tudo no lugar: o objeto `host` é o mesmo, o conteúdo é novo. */
async function reopenHost(ppro: premierepro, host: HostHandles): Promise<boolean> {
  const opened = await openHost(ppro);
  if (!opened.ok) {
    return false;
  }
  host.project = opened.host.project;
  host.sequence = opened.host.sequence;
  host.editor = opened.host.editor;
  host.items = opened.host.items;
  return true;
}

export async function applyCuts(
  scan: SilenceScan,
  onProgress?: ApplyProgress
): Promise<SilenceResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
  }

  const ready = scan.clips.filter(
    (clip) => clip.status === "ready" && clip.plan && clip.plan.drop.length > 0
  );
  if (ready.length === 0) {
    return { ok: false, message: "Nada para cortar na seleção.", snapshot: null };
  }

  try {
    const opened = await openHost(ppro);
    if (!opened.ok) {
      return { ok: false, message: opened.message, snapshot: null };
    }
    const host = opened.host;

    // Os handles da varredura já envelheceram: entre analisar e cortar
    // rodou o ffmpeg, uma janela de Terminal roubou o foco e o Premiere
    // invalidou os objetos. Aqui só o **id** do item de projeto é
    // colhido — é o que atravessa as transações que vêm a seguir.
    const identified = await identifyClips(ppro, host, ready);
    if (!identified.ok) {
      return { ok: false, message: identified.message, snapshot: null };
    }

    const perSecond = ticksPerSecond(ppro);
    const runs = groupIntoRuns(ready);
    const snapshot: CutSnapshot = {
      runs: [],
      clipCount: ready.length,
      cuts: scan.cuts,
      removedSeconds: scan.removedSeconds,
    };

    // Total de escritas, para a barra de progresso significar algo.
    let totalWrites = 0;
    const plannedRuns = runs.map((run) => {
      const writes = planRun(run, scan, perSecond);
      totalWrites += writes.length;
      return { run, writes };
    });

    let done = 0;
    for (const { run, writes } of plannedRuns) {
      if (writes.length === 0) {
        continue;
      }

      // 1. Tira os originais do caminho. Sem ripple: o resto da
      //    timeline não pode se mexer enquanto reescrevemos aqui.
      const removed = await removeRun(ppro, host, run);
      if (!removed.ok) {
        // Esta run não foi tocada: ela não entra no snapshot, senão o
        // Desfazer apagaria e reescreveria clipes que estão intactos.
        return {
          ok: false,
          message: removed.message,
          snapshot: snapshot.runs.length > 0 ? snapshot : null,
        };
      }

      const runStart = BigInt(run[0].startTicks);
      const lastWrite = writes[writes.length - 1];
      snapshot.runs.push({
        trackVideo: run[0].trackVideo,
        trackAudio: run[0].trackAudio,
        writtenStart: runStart.toString(),
        writtenEnd: (lastWrite.position + (lastWrite.outTicks - lastWrite.inTicks)).toString(),
        originals: run.map((clip) => ({
          projectItemId: clip.projectItemId,
          projectItem: clip.projectItem,
          startTicks: clip.startTicks,
          inTicks: clip.inTicks,
          outTicks: clip.outTicks,
        })),
      });

      // 2. Reescreve cada trecho. O in/out entra na transação
      //    anterior ao overwrite que o consome — ver o cabeçalho.
      const written = await writeSegments(ppro, host, writes, () => {
        done += 1;
        onProgress?.(done, totalWrites);
      });
      if (!written.ok) {
        return {
          ok: false,
          message:
            stepMessage("a escrita de um trecho", written.error) +
            " Use Desfazer corte para recuperar os clipes originais.",
          snapshot,
        };
      }
    }

    const message =
      `${scan.cuts} ${scan.cuts === 1 ? "corte feito" : "cortes feitos"} em ` +
      `${ready.length} ${ready.length === 1 ? "clipe" : "clipes"} · ` +
      `${formatClock(scan.removedSeconds)} removidos.`;
    return { ok: true, message, snapshot };
  } catch (cause) {
    return { ok: false, message: describeError(cause), snapshot: null };
  }
}

/**
 * Constrói um mapa de todos os ProjectItems do projeto (nas bins e na raiz).
 * Isso garante referências permanentes a nível de projeto, imunes à
 * deleção de itens na timeline.
 */
async function buildProjectItemMap(
  ppro: premierepro,
  project: Project
): Promise<Map<string, ProjectItem>> {
  const map = new Map<string, ProjectItem>();
  try {
    const rootFolder = await project.getRootItem();
    if (!rootFolder) {
      return map;
    }
    const stack: FolderItem[] = [rootFolder];
    while (stack.length > 0) {
      const folder = stack.pop()!;
      try {
        const items = await folder.getItems();
        for (const item of items) {
          const id = safeId(item);
          if (id) {
            map.set(id, item);
          }
          if (item.type === ppro.ProjectItem.TYPE_BIN) {
            try {
              stack.push(ppro.FolderItem.cast(item));
            } catch {
              // Uma bin que não aceita o cast é uma bin a menos, não um erro.
            }
          }
        }
      } catch {
        // Bin ilegível: segue para as outras.
      }
    }
  } catch {
    // Sem raiz de projeto o mapa fica vazio, e o fallback assume.
  }
  return map;
}

/**
 * Descobre, para cada clipe, o id do item de projeto que o alimenta.
 *
 * O id é o que atravessa as transações: o handle lido a partir do track
 * item morre junto com o track item que a remoção apaga, mas o id
 * reencontra o mesmo item na bin depois — quantas vezes for preciso.
 */
async function identifyClips(
  ppro: premierepro,
  host: HostHandles,
  clips: readonly ClipTarget[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const clip of clips) {
    const located = await locateRun(ppro, host, [clip]);
    if (!located.ok) {
      return located;
    }
    const anchor = located.items[0];
    if (!anchor) {
      return { ok: false, message: `"${clip.name}" não foi encontrado na timeline.` };
    }
    try {
      const fromTrack = await anchor.getProjectItem();
      const id = safeId(fromTrack);
      const permanent = (id && host.items.get(id)) || fromTrack;
      clip.projectItemId = id;
      clip.projectItem = permanent;
      clip.clipItem = ppro.ClipProjectItem.cast(permanent);
    } catch (cause) {
      return {
        ok: false,
        message: `Não foi possível ler o item de projeto de "${clip.name}" (${describeError(
          cause
        )}).`,
      };
    }
  }
  return { ok: true };
}

/**
 * Relê da timeline, agora, os itens de uma run.
 *
 * Chamado imediatamente antes da remoção: entre o plano e este ponto
 * rodaram outras transações, e os handles daquele momento já morreram.
 * A posição na sequência é o que sobrevive a tudo, então é por ela que
 * os itens são reencontrados.
 */
async function locateRun(
  ppro: premierepro,
  host: HostHandles,
  run: readonly ClipTarget[]
): Promise<
  | { ok: true; items: Array<VideoClipTrackItem | AudioClipTrackItem> }
  | { ok: false; message: string }
> {
  const items: Array<VideoClipTrackItem | AudioClipTrackItem> = [];
  try {
    for (const clip of run) {
      if (clip.trackVideo >= 0) {
        const track = await host.sequence.getVideoTrack(clip.trackVideo);
        const found = track
          ? await findByPosition(
              track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false),
              clip
            )
          : null;
        if (!found) {
          return {
            ok: false,
            message: `"${clip.name}" não está mais onde estava. Analise de novo.`,
          };
        }
        items.push(found);
      }

      if (clip.trackAudio >= 0) {
        const track = await host.sequence.getAudioTrack(clip.trackAudio);
        const found = track
          ? await findByPosition(
              track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false),
              clip
            )
          : null;
        if (!found) {
          return {
            ok: false,
            message: `O áudio de "${clip.name}" não está mais onde estava. Analise de novo.`,
          };
        }
        items.push(found);
      }
    }
  } catch (cause) {
    return {
      ok: false,
      message: `Não foi possível reler a timeline (${describeError(cause)}). Analise de novo.`,
    };
  }
  return { ok: true, items };
}

async function findByPosition(
  items: Array<VideoClipTrackItem | AudioClipTrackItem>,
  clip: ClipTarget
): Promise<VideoClipTrackItem | AudioClipTrackItem | null> {
  for (const item of items) {
    const start = await item.getStartTime();
    if (compareTicks(start.ticks, clip.startTicks) !== 0) {
      continue;
    }
    const end = await item.getEndTime();
    if (compareTicks(end.ticks, clip.endTicks) === 0) {
      return item;
    }
  }
  return null;
}

function safeId(item: ProjectItem): string {
  try {
    return item.getId();
  } catch {
    return "";
  }
}

/**
 * Sequências de clipes encostados, na mesma dupla de faixas.
 *
 * A compactação acontece dentro de uma sequência dessas: os trechos
 * mantidos são empurrados para a esquerda até encostarem, e a sobra
 * vira um espaço único no fim. Clipes separados por um buraco não
 * entram na mesma sequência — puxar um para o outro invadiria o que
 * estiver no meio.
 */
function groupIntoRuns(clips: ClipTarget[]): ClipTarget[][] {
  const byTrack = new Map<string, ClipTarget[]>();
  for (const clip of clips) {
    const key = `${clip.trackVideo}:${clip.trackAudio}`;
    const list = byTrack.get(key);
    if (list) {
      list.push(clip);
    } else {
      byTrack.set(key, [clip]);
    }
  }

  const runs: ClipTarget[][] = [];
  for (const list of byTrack.values()) {
    list.sort((a, b) => compareTicks(a.startTicks, b.startTicks));
    let current: ClipTarget[] = [];
    for (const clip of list) {
      const previous = current[current.length - 1];
      if (previous && compareTicks(previous.endTicks, clip.startTicks) === 0) {
        current.push(clip);
      } else {
        if (current.length > 0) {
          runs.push(current);
        }
        current = [clip];
      }
    }
    if (current.length > 0) {
      runs.push(current);
    }
  }
  return runs;
}

/** Converte os planos de uma sequência de clipes em escritas. */
function planRun(
  run: ClipTarget[],
  scan: SilenceScan,
  perSecond: bigint
): Write[] {
  const writes: Write[] = [];
  const frame = scan.ticksPerFrame;
  let cursor = BigInt(run[0].startTicks);

  for (const clip of run) {
    const plan = clip.plan;
    if (!plan) {
      continue;
    }
    const inTicks = BigInt(clip.inTicks);
    const outTicks = BigInt(clip.outTicks);
    const minimum = frame ?? 1n;

    for (const span of plan.keep) {
      let from = toTicks(clip.sourceStart, span.start, inTicks, perSecond);
      let to = toTicks(clip.sourceStart, span.end, inTicks, perSecond);
      from = BigInt(snapTicksToFrame(from.toString(), frame));
      to = BigInt(snapTicksToFrame(to.toString(), frame));

      if (from < inTicks) {
        from = inTicks;
      }
      if (to > outTicks) {
        to = outTicks;
      }
      if (to - from < minimum) {
        continue;
      }

      writes.push({
        projectItemId: clip.projectItemId,
        fallbackItem: clip.projectItem,
        inTicks: from,
        outTicks: to,
        position: cursor,
        trackVideo: clip.trackVideo,
        trackAudio: clip.trackAudio,
      });
      cursor += to - from;
    }
  }
  return writes;
}

/**
 * Tira os originais de uma run do caminho.
 *
 * Os itens são relidos aqui, não reaproveitados do plano, e a seleção
 * nasce e morre dentro do callback — as duas coisas que mantinham
 * handles mortos vivos por tempo demais.
 */
async function removeRun(
  ppro: premierepro,
  host: HostHandles,
  run: readonly ClipTarget[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const located = await locateRun(ppro, host, run);
    if (!located.ok) {
      // O clipe não está mais lá: tentar de novo não muda nada.
      return located;
    }
    const result = removeItems(ppro, host, located.items);
    if (result.ok) {
      return { ok: true };
    }
    if (attempt > 0 || !(await reopenHost(ppro, host))) {
      return {
        ok: false,
        message: stepMessage("a remoção dos clipes originais", result.error),
      };
    }
  }
  return { ok: false, message: stepMessage("a remoção dos clipes originais", null) };
}

/**
 * A remoção propriamente dita.
 *
 * `createEmptySelection` entrega a seleção por callback, e o objeto
 * entregue vale no escopo desse callback. Guardá-lo para usar depois
 * era uma das fontes de "The script object is no longer valid" — então
 * o caminho principal roda a transação inteira lá dentro, com a
 * seleção ainda viva.
 *
 * O caminho de reserva existe porque nem todo build do Premiere aceita
 * uma transação dentro desse callback. Aí a seleção sai do escopo e a
 * transação vai fora — que é o comportamento antigo, mantido só como
 * segunda tentativa.
 */
function removeItems(
  ppro: premierepro,
  host: HostHandles,
  items: readonly (VideoClipTrackItem | AudioClipTrackItem)[]
): CommitResult {
  if (items.length === 0) {
    return { ok: true, error: null };
  }

  const scoped = removeInsideSelectionScope(ppro, host, items);
  if (scoped.ok) {
    return scoped;
  }
  const escaped = removeOutsideSelectionScope(ppro, host, items);
  return escaped.ok || escaped.error ? escaped : scoped;
}

/** Transação dentro do callback, com a seleção viva. */
function removeInsideSelectionScope(
  ppro: premierepro,
  host: HostHandles,
  items: readonly (VideoClipTrackItem | AudioClipTrackItem)[]
): CommitResult {
  let outcome: CommitResult = { ok: false, error: null };
  let entered = false;
  try {
    ppro.TrackItemSelection.createEmptySelection((selection: TrackItemSelection) => {
      entered = true;
      for (const item of items) {
        selection.addItem(item, true);
      }
      outcome = commit(host.project, "Cortar silêncios — remover original", (tx) => {
        tx.addAction(
          host.editor.createRemoveItemsAction(
            selection,
            false,
            ppro.Constants.MediaType.ANY
          )
        );
      });
    });
  } catch (cause) {
    return { ok: false, error: cause };
  }
  if (!entered) {
    return {
      ok: false,
      error: new Error("o Premiere não entregou a seleção dos clipes."),
    };
  }
  return outcome;
}

/** Seleção montada no callback, transação fora dele. */
function removeOutsideSelectionScope(
  ppro: premierepro,
  host: HostHandles,
  items: readonly (VideoClipTrackItem | AudioClipTrackItem)[]
): CommitResult {
  let selection: TrackItemSelection | null = null;
  try {
    ppro.TrackItemSelection.createEmptySelection((created: TrackItemSelection) => {
      selection = created;
    });
    const target = selection as TrackItemSelection | null;
    if (!target) {
      return {
        ok: false,
        error: new Error("o Premiere não entregou a seleção dos clipes."),
      };
    }
    for (const item of items) {
      target.addItem(item, true);
    }
    return commit(host.project, "Cortar silêncios — remover original", (tx) => {
      tx.addAction(
        host.editor.createRemoveItemsAction(
          target,
          false,
          ppro.Constants.MediaType.ANY
        )
      );
    });
  } catch (cause) {
    return { ok: false, error: cause };
  }
}

/**
 * Escreve os trechos, um por transação.
 *
 * Cada transação carrega o overwrite do trecho ANTERIOR e prepara o
 * in/out do próximo: é a única ordem em que o item de projeto já está
 * apontando para o trecho certo quando o overwrite acontece.
 *
 * Os handles do item de projeto são resolvidos DENTRO do `build`, a
 * cada tentativa — nunca reaproveitados de antes da transação passada.
 */
async function writeSegments(
  ppro: premierepro,
  host: HostHandles,
  writes: readonly Write[],
  onWritten: () => void
): Promise<CommitResult> {
  let pending: Write | null = null;

  for (const write of writes) {
    const previous = pending;
    const result = await commitStable(ppro, host, "Cortar silêncios", (live, tx) => {
      if (previous) {
        tx.addAction(
          live.editor.createOverwriteItemAction(
            resolveProjectItem(ppro, live, previous).projectItem,
            ppro.TickTime.createWithTicks(previous.position.toString()),
            previous.trackVideo,
            previous.trackAudio
          )
        );
      }
      const target = resolveProjectItem(ppro, live, write);
      tx.addAction(target.clipItem.createClearInOutPointsAction());
      tx.addAction(
        target.clipItem.createSetInOutPointsAction(
          ppro.TickTime.createWithTicks(write.inTicks.toString()),
          ppro.TickTime.createWithTicks(write.outTicks.toString())
        )
      );
    });
    if (!result.ok) {
      return result;
    }
    if (previous) {
      onWritten();
    }
    pending = write;
  }

  if (!pending) {
    return { ok: true, error: null };
  }
  const last = pending;
  const result = await commitStable(ppro, host, "Cortar silêncios", (live, tx) => {
    const target = resolveProjectItem(ppro, live, last);
    tx.addAction(
      live.editor.createOverwriteItemAction(
        target.projectItem,
        ppro.TickTime.createWithTicks(last.position.toString()),
        last.trackVideo,
        last.trackAudio
      )
    );
    // Devolve o item de projeto ao estado neutro: um in/out esquecido
    // ali muda o que o editor recebe ao arrastar o clipe da bin.
    tx.addAction(target.clipItem.createClearInOutPointsAction());
  });
  if (result.ok) {
    onWritten();
  }
  return result;
}

/** O item de projeto desta escrita, relido da bin do host atual. */
function resolveProjectItem(
  ppro: premierepro,
  host: HostHandles,
  write: Write
): { projectItem: ProjectItem; clipItem: ClipProjectItem } {
  const fresh = write.projectItemId ? host.items.get(write.projectItemId) : undefined;
  const projectItem = fresh ?? write.fallbackItem;
  return { projectItem, clipItem: ppro.ClipProjectItem.cast(projectItem) };
}

// ── desfazer ───────────────────────────────────────────────────────

/**
 * Devolve os clipes originais no lugar.
 *
 * Apaga tudo que a ferramenta escreveu na região e reescreve cada
 * original com o in/out que tinha. O que não volta é o que o overwrite
 * já tinha levado na ida — efeitos e keyframes daquele track item.
 */
export async function undoCuts(snapshot: CutSnapshot): Promise<SilenceResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot };
  }

  try {
    const opened = await openHost(ppro);
    if (!opened.ok) {
      return { ok: false, message: opened.message, snapshot };
    }
    const host = opened.host;

    for (const run of snapshot.runs) {
      const cleared = await clearRange(ppro, host, run);
      if (!cleared.ok) {
        return { ok: false, message: cleared.message, snapshot };
      }

      const writes: Write[] = run.originals.map((original) => ({
        projectItemId: original.projectItemId,
        fallbackItem: original.projectItem,
        inTicks: BigInt(original.inTicks),
        outTicks: BigInt(original.outTicks),
        position: BigInt(original.startTicks),
        trackVideo: run.trackVideo,
        trackAudio: run.trackAudio,
      }));
      const restored = await writeSegments(ppro, host, writes, () => {});
      if (!restored.ok) {
        return {
          ok: false,
          message: stepMessage("a recolocação dos clipes originais", restored.error),
          snapshot,
        };
      }
    }

    return {
      ok: true,
      message: `${snapshot.clipCount} ${
        snapshot.clipCount === 1 ? "clipe restaurado" : "clipes restaurados"
      }.`,
      snapshot: null,
    };
  } catch (cause) {
    return { ok: false, message: describeError(cause), snapshot };
  }
}

/** Limpa a região que a ida reescreveu, relendo os itens na hora. */
async function clearRange(
  ppro: premierepro,
  host: HostHandles,
  run: RunSnapshot
): Promise<{ ok: true } | { ok: false; message: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const items = await itemsInRange(
      ppro,
      host.sequence,
      run.trackVideo,
      run.trackAudio,
      BigInt(run.writtenStart),
      BigInt(run.writtenEnd)
    );
    const result = removeItems(ppro, host, items);
    if (result.ok) {
      return { ok: true };
    }
    if (attempt > 0 || !(await reopenHost(ppro, host))) {
      return { ok: false, message: stepMessage("a limpeza do trecho", result.error) };
    }
  }
  return { ok: false, message: stepMessage("a limpeza do trecho", null) };
}

async function itemsInRange(
  ppro: premierepro,
  sequence: Sequence,
  trackVideo: number,
  trackAudio: number,
  from: bigint,
  to: bigint
): Promise<Array<VideoClipTrackItem | AudioClipTrackItem>> {
  const found: Array<VideoClipTrackItem | AudioClipTrackItem> = [];

  const pick = async (
    items: Array<VideoClipTrackItem | AudioClipTrackItem>
  ): Promise<void> => {
    for (const item of items) {
      const start = BigInt((await item.getStartTime()).ticks);
      const end = BigInt((await item.getEndTime()).ticks);
      if (start >= from && end <= to) {
        found.push(item);
      }
    }
  };

  if (trackVideo >= 0) {
    const track = await sequence.getVideoTrack(trackVideo);
    if (track) {
      await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
    }
  }
  if (trackAudio >= 0) {
    const track = await sequence.getAudioTrack(trackAudio);
    if (track) {
      await pick(track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false));
    }
  }
  return found;
}

// ── utilidades de host ─────────────────────────────────────────────

interface CommitResult {
  ok: boolean;
  /** Preenchido quando o host lançou, e não apenas recusou. */
  error: unknown;
}

/**
 * Toda escrita passa por aqui.
 *
 * `executeTransaction` sozinho não basta: sem o `lockedAccess` em
 * volta, o projeto pode mudar entre a leitura dos handles e a
 * montagem das ações. O callback é síncrono de propósito — a Adobe
 * exige isso, e um `await` lá dentro invalida os objetos no meio da
 * transação.
 *
 * E a exceção é capturada DENTRO do lock: deixá-la atravessar
 * `lockedAccess` deixava o projeto travado, e daí em diante toda
 * transação seguinte falhava também — um erro só virava a ferramenta
 * inteira parada.
 */
function commit(
  project: Project,
  label: string,
  build: (tx: CompoundAction) => void
): CommitResult {
  let ok = false;
  let error: unknown = null;
  try {
    project.lockedAccess(() => {
      try {
        ok = project.executeTransaction(build, label);
      } catch (cause) {
        error = cause;
      }
    });
  } catch (cause) {
    error = error ?? cause;
  }
  if (error) {
    console.error(`[Silêncios] transação "${label}" falhou:`, error);
  }
  return { ok, error };
}

/**
 * Uma transação que sobrevive ao envelhecimento dos handles.
 *
 * O `build` recebe o host e monta as ações NA HORA, nunca a partir de
 * um handle guardado antes. Se ainda assim a transação cair, o host é
 * reaberto — projeto, sequência, editor e bin — e ela vai de novo, com
 * objetos que o Premiere acabou de entregar.
 */
async function commitStable(
  ppro: premierepro,
  host: HostHandles,
  label: string,
  build: (host: HostHandles, tx: CompoundAction) => void
): Promise<CommitResult> {
  const first = commit(host.project, label, (tx) => build(host, tx));
  if (first.ok) {
    return first;
  }
  if (!(await reopenHost(ppro, host))) {
    return first;
  }
  const second = commit(host.project, label, (tx) => build(host, tx));
  if (second.ok || second.error) {
    return second;
  }
  return first;
}

/** Erro com o passo dito por extenso — a frase crua do host sozinha não localiza nada. */
function stepMessage(step: string, cause: unknown): string {
  const detail = cause ? describeError(cause).trim() : "";
  if (!detail) {
    return `O Premiere recusou ${step}.`;
  }
  return `O Premiere recusou ${step}: ${/[.!?]$/.test(detail) ? detail : `${detail}.`}`;
}

/**
 * O editor da sequência.
 *
 * O typings desta versão expõe `getEditor`, mas builds do Premiere
 * chegaram a expor a mesma coisa como `createForSequence`. Procurar as
 * duas custa uma linha e evita que a ferramenta morra inteira por causa
 * de um nome.
 */
function resolveEditor(ppro: premierepro, sequence: Sequence): SequenceEditor | null {
  const api = ppro.SequenceEditor as unknown as {
    getEditor?: (sequence: Sequence) => SequenceEditor;
    createForSequence?: (sequence: Sequence) => SequenceEditor;
  };
  try {
    if (typeof api?.getEditor === "function") {
      return api.getEditor(sequence) ?? null;
    }
    if (typeof api?.createForSequence === "function") {
      return api.createForSequence(sequence) ?? null;
    }
  } catch (cause) {
    console.error("[Silêncios] SequenceEditor indisponível:", cause);
  }
  return null;
}

function ticksPerSecond(ppro: premierepro): bigint {
  try {
    const one = ppro.TickTime?.TIME_ONE_SECOND;
    const ticks = one ? BigInt(one.ticks) : 0n;
    return ticks > 0n ? ticks : TICKS_PER_SECOND_FALLBACK;
  } catch {
    return TICKS_PER_SECOND_FALLBACK;
  }
}

/** Segundo de source → tick absoluto, ancorado no in point do clipe. */
function toTicks(
  sourceStart: number,
  seconds: number,
  inTicks: bigint,
  perSecond: bigint
): bigint {
  const offset = Math.round((seconds - sourceStart) * Number(perSecond));
  return inTicks + BigInt(offset);
}

function compareTicks(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
}
