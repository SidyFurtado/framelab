/**
 * Legendas — a ponte com o projeto do Premiere.
 *
 * ── Trabalha por FAIXA, não por seleção ────────────────────────────
 * Numa edição de verdade o áudio não acompanha o vídeo: são várias
 * faixas, vários clipes, e o editor já organizou tudo isso. Pedir que
 * ele selecione clipe por clipe é pedir que refaça um trabalho já
 * feito. Então a ferramenta lê as faixas de áudio da sequência, conta
 * quantas são, e transcreve a que ele escolher — ou todas.
 *
 * O áudio da faixa vai para o whisper montado e CONTÍNUO, em tempo de
 * sequência (ver `timeline.ts`): uma passada só, com o contexto que a
 * pontuação precisa, e uma frase partida num corte sai como frase.
 * Depois o resultado é recortado de volta por clipe e reconvertido
 * para tempo de mídia, porque é assim que o Premiere guarda
 * transcrição — no item de projeto.
 *
 * ── O que o host decide, não nós ───────────────────────────────────
 * Se o Premiere substitui a transcrição existente ou soma a ela, e se
 * as legendas nascem sozinhas ou só depois de "Criar legendas a
 * partir da transcrição", é comportamento do host — a API não diz. Por
 * isso o painel avisa quando o clipe já tinha transcrição, em vez de
 * prometer o que não controla.
 */
import type {
  premierepro,
  ClipProjectItem,
  CompoundAction,
  Project,
} from "@adobe/premierepro";
import { getPremiere, describeError } from "../../bridge/premiere";
import { whisperToAdobe, countWords, type AdobeTranscript } from "./toAdobe";
import { applyGlossary, parseGlossary, promptFrom, type Correction } from "./glossary";
import { effectiveGlossary } from "./baseGlossary";
import { transcribe, describeError as describeWhisperError, type WhisperModel } from "./whisper";
import { readSnapshots, writeSnapshot, readLastRun, writeLastRun } from "./config";
import { diffCorrections, worthLearning, type Candidate } from "./learn";
import { readTranscript } from "../silence/transcript";
import { shapesToTry, rememberShape } from "./schemas";
import { buildCues, cuesToSrt, SRT_DEFAULTS, type SrtOptions } from "./srt";
import { nativePath } from "../silence/workspace";
import { workspace, write } from "../silence/workspace";
import {
  assembleArgs,
  splitByClip,
  trackLabel,
  type TrackClip,
} from "./timeline";

/** Um clipe de áudio, com o handle que a importação precisa. */
export interface AudioClip extends TrackClip {
  clipItem: ClipProjectItem;
  /** true quando já tem transcrição do Premiere. */
  hadTranscript: boolean;
  /** Preenchido depois de transcrever. */
  words: number;
  corrections: Correction[];
}

/** Uma faixa de áudio da sequência. */
export interface AudioTrackInfo {
  index: number;
  /** "A1", "A2"… como o editor a conhece. */
  label: string;
  clips: AudioClip[];
  /** Quantos clipes têm arquivo no disco. */
  usable: number;
}

export interface TrackScan {
  tracks: AudioTrackInfo[];
  /** Soma dos clipes utilizáveis de todas as faixas. */
  usable: number;
  /**
   * Quadros por segundo da sequência, ou 0 se o host não disse.
   *
   * A legenda é alinhada a esta grade e o intervalo entre legendas é
   * contado nela — é o que o Premiere pede em quadros, e é o que
   * impede uma legenda de entrar no meio de um quadro.
   */
  fps: number;
}

function commitTransaction(
  project: Project,
  label: string,
  build: (tx: CompoundAction) => void
): boolean {
  let committed = false;
  project.lockedAccess(() => {
    committed = project.executeTransaction(build, label);
  });
  return committed;
}

/**
 * Lê as faixas de áudio da sequência ativa. Sem seleção nenhuma.
 *
 * Nunca lança por causa de um clipe: o que não dá para ler fica de
 * fora da contagem e os outros seguem.
 */
export async function scanTracks(): Promise<TrackScan> {
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
    throw new Error("Nenhuma sequência aberta.");
  }

  // O relógio da sequência, quando o host o entrega. Não é fatal
  // perdê-lo: sem ele a legenda simplesmente não é alinhada a quadro.
  let fps = 0;
  try {
    const settings = await sequence.getSettings();
    const rate = settings?.getVideoFrameRate?.();
    if (rate && Number.isFinite(rate.value) && rate.value > 0) {
      fps = rate.value;
    }
  } catch {
    /* sequência sem ajustes legíveis: seguir sem alinhar */
  }

  const tracks: AudioTrackInfo[] = [];
  const count = await sequence.getAudioTrackCount();

  for (let index = 0; index < count; index += 1) {
    const track = await sequence.getAudioTrack(index);
    if (!track) {
      continue;
    }
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    const clips: AudioClip[] = [];

    for (const item of items) {
      const clip = await readClip(ppro, item, index);
      if (clip) {
        clips.push(clip);
      }
    }

    tracks.push({
      index,
      label: trackLabel(index),
      clips,
      usable: clips.length,
    });
  }

  return {
    tracks,
    usable: tracks.reduce((total, track) => total + track.usable, 0),
    fps,
  };
}

async function readClip(
  ppro: premierepro,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  trackIndex: number
): Promise<AudioClip | null> {
  try {
    const speed = await item.getSpeed().catch(() => 1);
    if (Number.isFinite(speed) && Math.abs(speed - 1) > 0.001) {
      // Velocidade alterada quebra a conta entre tempo de sequência e
      // tempo de mídia; melhor deixar de fora que legendar torto.
      return null;
    }

    const start = await item.getStartTime();
    const end = await item.getEndTime();
    const inPoint = await item.getInPoint();
    const projectItem = await item.getProjectItem();
    if (!projectItem) {
      return null;
    }
    const clipItem = ppro.ClipProjectItem.cast(projectItem);
    const mediaPath = await clipItem.getMediaFilePath().catch(() => "");
    if (!mediaPath) {
      return null;
    }
    const name = await item.getName().catch(() => projectItem.name ?? "clipe");

    let hadTranscript = false;
    try {
      hadTranscript = ppro.Transcript?.hasTranscript?.(clipItem) === true;
    } catch {
      /* build sem a checagem: seguir sem o aviso */
    }

    return {
      key: `${trackIndex}:${start.ticks}`,
      name,
      mediaPath,
      seqStart: start.seconds,
      seqEnd: end.seconds,
      inPoint: inPoint.seconds,
      trackIndex,
      clipItem,
      hadTranscript,
      words: 0,
      corrections: [],
    };
  } catch {
    return null;
  }
}

export interface RunOptions {
  model: WhisperModel;
  language: string;
  glossaryText: string;
  /** Índice da faixa, ou "all" para todas. */
  track: number | "all";
  /** A régua da legenda. Ausente = a de fábrica. */
  srt?: SrtOptions;
  onStage?: (text: string) => void;
  cancelled?: () => boolean;
  onManual?: (scriptPath: string, reason: string) => void;
}

export interface RunResult {
  ok: boolean;
  message: string;
  imported: number;
  /** Caminho do .srt gerado, quando deu para gerar. */
  srtPath: string | null;
  /** Quantas legendas o .srt tem. */
  cues: number;
  /**
   * O que aconteceu em cada etapa.
   *
   * Existe porque "a legenda não aconteceu" pode ser cinco coisas
   * diferentes — não achou clipe, o motor não rodou, rodou e não ouviu
   * fala, ouviu e o recorte por clipe não casou, ou o Premiere recusou
   * a importação. Sem isto, todas viram a mesma frase e não há como
   * consertar de longe.
   */
  stages: string[];
}

/** Os clipes que a escolha do editor abrange. */
export function clipsFor(scan: TrackScan, track: number | "all"): AudioClip[] {
  const chosen =
    track === "all"
      ? scan.tracks
      : scan.tracks.filter((entry) => entry.index === track);
  return chosen.flatMap((entry) => entry.clips);
}

/**
 * Transcreve a faixa escolhida numa passada e importa por clipe.
 */
export async function transcribeTracks(
  scan: TrackScan,
  options: RunOptions
): Promise<RunResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return { ok: false, message: "Premiere UXP runtime indisponível.", imported: 0, stages: [], srtPath: null, cues: 0 };
  }
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    return { ok: false, message: "Nenhum projeto aberto.", imported: 0, stages: [], srtPath: null, cues: 0 };
  }
  if (!ppro.Transcript?.importFromJSON || !ppro.Transcript?.createImportTextSegmentsAction) {
    return {
      ok: false,
      message: "Esta versão do Premiere não aceita importar transcrição pelo painel.",
      imported: 0,
      stages: ["API de transcrição ausente neste host"],
      srtPath: null,
      cues: 0,
    };
  }

  const stages: string[] = [];
  const clips = clipsFor(scan, options.track);
  stages.push(`clipes na escolha: ${clips.length}`);
  if (clips.length === 0) {
    return {
      ok: false,
      message: "Nenhum clipe de áudio nessa escolha.",
      imported: 0,
      stages,
      srtPath: null,
      cues: 0,
    };
  }

  const terms = parseGlossary(effectiveGlossary(options.glossaryText));
  const assembled = assembleArgs(clips);
  options.onStage?.("Iniciando motor Whisper…");

  const result = await transcribe(
    assembled,
    options.model,
    options.language,
    promptFrom(terms),
    options.onStage,
    options.cancelled,
    options.onManual
  );

  if (!result.ok || !result.json) {
    stages.push(`motor: ${result.error ?? "sem resposta"}`);
    return {
      ok: false,
      message: describeWhisperError(result.error, result.detected),
      imported: 0,
      stages,
      srtPath: null,
      cues: 0,
    };
  }
  stages.push("motor: concluiu");
  options.onStage?.("Processando transcrição e glossário…");

  // A transcrição sai em tempo de SEQUÊNCIA; cada clipe recebe a sua
  // parte, já convertida para tempo de mídia.
  // O `baseOffset` devolve os carimbos ao tempo de sequência: a
  // montagem começou no primeiro clipe, não no zero.
  const sequenceWide = whisperToAdobe(result.json, assembled.baseOffset);
  const heard = countWords(sequenceWide);
  stages.push(`palavras ouvidas: ${heard}`);

  /*
   * O .srt e o cache vêm ANTES do recorte por clipe — nenhum dos dois
   * depende dele. O .srt é a linha do tempo inteira em tempo de
   * sequência; o cache é o que foi ouvido. Gerá-los depois do recorte
   * fazia uma falha no encaixe levar junto o único resultado que
   * chega à timeline.
   */
  options.onStage?.("Gerando arquivo .srt…");
  const emitted = await emitSrt(
    project,
    sequenceWide,
    options.srt ?? SRT_DEFAULTS,
    scan.fps,
    stages
  );
  const { srtPath, cues } = emitted;
  const srtInProject = emitted.inProject;

  /*
   * O ouvido fica guardado.
   *
   * Mudar "caracteres por linha" não muda uma palavra do que foi
   * ouvido — muda só como as palavras viram legenda. Guardando a
   * transcrição em tempo de sequência, o painel refaz o .srt com
   * outros limites em um segundo, em vez de rodar o motor de novo.
   */
  await writeLastRun({
    at: Date.now(),
    fps: scan.fps,
    clips: clips.length,
    label:
      options.track === "all"
        ? `${clips.length} ${clips.length === 1 ? "clipe" : "clipes"}, todas as faixas`
        : `${clips.length} ${clips.length === 1 ? "clipe" : "clipes"} de ${trackLabel(options.track)}`,
    transcript: sequenceWide,
  });

  const perClip = splitByClip(sequenceWide, clips);
  const placed = [...perClip.values()].reduce(
    (total, transcript) => total + countWords(transcript),
    0
  );
  stages.push(`palavras encaixadas em clipes: ${placed}`);
  // Ouviu muito e encaixou nada é sintoma de relógio desalinhado entre
  // a montagem e as posições dos clipes — vale dizer, não engolir.
  if (heard > 0 && placed === 0) {
    return {
      // O .srt já existe e é utilizável: ele sai do tempo de sequência
      // e não passa pelo encaixe que falhou. Devolvê-lo é a diferença
      // entre "não deu" e "está no seu projeto, e me avise disto".
      ok: cues > 0,
      message:
        `O motor ouviu ${heard} palavras, mas nenhuma caiu dentro dos clipes ` +
        "— os tempos não bateram. " +
        (cues > 0
          ? `Ainda assim o .srt saiu com ${cues} legendas` +
            (srtInProject ? " e está no seu projeto. " : `: ${srtPath}. `) +
            "Me mande esta mensagem mesmo assim."
          : "Me mande esta mensagem."),
      imported: 0,
      stages,
      srtPath,
      cues,
    };
  }

  let imported = 0;
  const failures: string[] = [];
  /** O motivo exato de cada recusa, para o diagnóstico do painel. */
  const notes: string[] = [];
  options.onStage?.("Importando legendas para o Premiere…");

  for (const clip of clips) {
    const raw = perClip.get(clip.key);
    if (!raw) {
      // Clipe sem fala: música, ambiência, silêncio. Não é falha.
      continue;
    }
    const { transcript, corrections } = applyGlossary(raw, terms);
    clip.words = countWords(transcript);
    clip.corrections = corrections;
    if (clip.words === 0) {
      continue;
    }

    if (importInto(ppro, project, clip, transcript, options.language, notes)) {
      imported += 1;
      await writeSnapshot(clip.mediaPath, transcript);
    } else {
      failures.push(clip.name);
    }
  }

  stages.push(`importados: ${imported}`);
  if (failures.length > 0) {
    stages.push(`recusados pelo Premiere: ${failures.length}`);
    // Só os motivos distintos: vinte clipes recusados pela mesma razão
    // são uma linha, não vinte.
    for (const note of [...new Set(notes)].slice(0, 4)) {
      stages.push(note);
    }
    // O host sabe o formato que aceita; recusa é a hora de perguntar.
    stages.push(...(await describeHostSchema(scan)));
  }

  if (imported === 0) {
    // Mesmo sem a transcrição entrar nos itens, o .srt salva o dia: é
    // ele que vira legenda na timeline.
    if (cues > 0) {
      return {
        ok: true,
        message:
          `${cues} legendas geradas. ` +
          (srtInProject
            ? "O .srt está no seu projeto — arraste para a timeline."
            : `Arquivo salvo: ${srtPath}`),
        imported: 0,
        stages,
        srtPath,
        cues,
      };
    }
    return {
      ok: false,
      message:
        failures.length > 0
          ? `O Premiere recusou a importação de ${failures.length} clipe(s).`
          : "Nenhuma fala reconhecida nesta faixa.",
      imported: 0,
      stages,
      srtPath,
      cues,
    };
  }

  const head = `${imported} ${imported === 1 ? "clipe transcrito" : "clipes transcritos"}`;
  const comoAplicar = srtInProject
    ? ` · ${cues} legendas no .srt dentro do projeto — arraste para a timeline`
    : cues > 0
      ? ` · .srt salvo em ${srtPath}`
      : "";
  return {
    ok: failures.length === 0,
    message: `${head}${comoAplicar}`,
    imported,
    stages,
    srtPath,
    cues,
  };
}

/**
 * Escreve o .srt e o coloca no projeto.
 *
 * O .srt sai da transcrição em tempo de SEQUÊNCIA, antes do recorte
 * por clipe — é a linha do tempo inteira, que é o que uma faixa de
 * legenda precisa. Gerado sempre, mesmo que a importação da
 * transcrição falhe: é o caminho que não depende do host aceitar nada,
 * já que a API do Premiere não permite criar faixa de legenda.
 *
 * Entrar no projeto é a parte que pode falhar sem ser fatal: o arquivo
 * está no disco, e o painel mostra o caminho.
 */
async function emitSrt(
  project: Project,
  transcript: AdobeTranscript,
  options: SrtOptions,
  fps: number,
  stages: string[]
): Promise<{ srtPath: string | null; cues: number; inProject: boolean }> {
  let srtPath: string | null = null;
  let cues = 0;
  try {
    const built = buildCues(transcript, options, fps);
    cues = built.length;
    if (cues > 0) {
      const space = await workspace();
      const name = `legendas-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}.srt`;
      await write(space, name, cuesToSrt(built));
      srtPath = nativePath(space, name);
      stages.push(`legendas no .srt: ${cues}`);
    }
  } catch (cause) {
    stages.push(`falha ao gerar o .srt: ${describeError(cause)}`);
    return { srtPath: null, cues: 0, inProject: false };
  }

  let inProject = false;
  if (srtPath) {
    try {
      inProject = (await project.importFiles([srtPath], true)) === true;
    } catch (cause) {
      stages.push(`o .srt não entrou no projeto: ${describeError(cause)}`);
    }
  }
  return { srtPath, cues, inProject };
}

export interface RebuildResult {
  ok: boolean;
  message: string;
  srtPath: string | null;
  cues: number;
}

/**
 * Refaz o .srt com outros limites, sem ouvir nada de novo.
 *
 * É o que torna os controles utilizáveis: caracteres por linha,
 * número de linhas e tempos mudam só a forma, não o conteúdo. Rodar o
 * motor outra vez para responder "e se fossem 32 caracteres?" custaria
 * minutos e ninguém experimentaria — aqui custa um segundo.
 */
export async function rebuildSrt(options: SrtOptions): Promise<RebuildResult> {
  const last = await readLastRun();
  if (!last) {
    return {
      ok: false,
      message: "Nada transcrito ainda nesta máquina — transcreva uma vez primeiro.",
      srtPath: null,
      cues: 0,
    };
  }
  const ppro = getPremiere();
  const project = ppro ? await ppro.Project.getActiveProject() : null;
  if (!project) {
    return { ok: false, message: "Nenhum projeto aberto.", srtPath: null, cues: 0 };
  }

  const stages: string[] = [];
  const { srtPath, cues, inProject } = await emitSrt(
    project,
    last.transcript,
    options,
    last.fps,
    stages
  );
  if (cues === 0) {
    return {
      ok: false,
      message: stages[0] ?? "Estes limites não produziram nenhuma legenda.",
      srtPath: null,
      cues: 0,
    };
  }
  return {
    ok: true,
    message:
      `${cues} legendas refeitas de ${last.label}. ` +
      (inProject
        ? "O .srt novo está no seu projeto — arraste para a timeline."
        : `Arquivo salvo: ${srtPath}`),
    srtPath,
    cues,
  };
}

/**
 * Entrega a transcrição ao item de projeto.
 *
 * Tenta cada forma de JSON até uma passar (ver `schemas.ts`) e guarda
 * a que funcionou. O motivo de cada recusa vai para o console e para
 * `notes`: sem separar "o host não montou o objeto" de "o host
 * recusou a transação", as duas falhas viravam a mesma frase e não
 * havia como saber qual consertar.
 */
function importInto(
  ppro: premierepro,
  project: Project,
  clip: AudioClip,
  transcript: AdobeTranscript,
  language: string,
  notes: string[]
): boolean {
  for (const shape of shapesToTry()) {
    let segments: unknown = null;
    try {
      segments = ppro.Transcript.importFromJSON(shape.build(transcript, language));
    } catch (cause) {
      notes.push(`${shape.id}: importFromJSON lançou — ${describeError(cause)}`);
      continue;
    }
    if (!segments) {
      notes.push(`${shape.id}: importFromJSON devolveu vazio`);
      continue;
    }
    try {
      const ok = commitTransaction(project, "Importar transcrição", (tx) => {
        tx.addAction(
          ppro.Transcript.createImportTextSegmentsAction(
            segments as Parameters<typeof ppro.Transcript.createImportTextSegmentsAction>[0],
            clip.clipItem
          )
        );
      });
      if (ok) {
        rememberShape(shape.id);
        return true;
      }
      notes.push(`${shape.id}: o host recusou a transação`);
    } catch (cause) {
      notes.push(`${shape.id}: a transação lançou — ${describeError(cause)}`);
    }
  }
  return false;
}

/**
 * Lê de volta o que está no Premiere agora e aprende com a diferença.
 *
 * Só PROPÕE: quem decide o que entra no glossário é o editor. Uma
 * troca inventada que entrasse sozinha contaminaria todas as
 * transcrições seguintes sem ninguém ver.
 */
export async function learnFromCorrections(
  scan: TrackScan,
  track: number | "all"
): Promise<{ candidates: Candidate[]; checked: number }> {
  const ppro = getPremiere();
  if (!ppro) {
    return { candidates: [], checked: 0 };
  }
  const snapshots = await readSnapshots();
  const all: Candidate[] = [];
  let checked = 0;

  for (const clip of clipsFor(scan, track)) {
    const written = snapshots[clip.mediaPath] as AdobeTranscript | undefined;
    if (!written?.segments) {
      continue;
    }
    const current = await readTranscript(ppro, clip.clipItem);
    if (current.status !== "ok" || current.words.length === 0) {
      continue;
    }
    checked += 1;
    const words = current.words
      .filter((word) => !!word.text)
      .map((word) => ({ text: word.text as string, start: word.start }));
    all.push(...diffCorrections(written, words));
  }

  // A mesma correção em clipes diferentes conta como repetição: é o
  // sinal mais forte de que é vocabulário, e não acaso.
  const tally = new Map<string, Candidate>();
  for (const candidate of all) {
    const found = tally.get(candidate.to);
    if (found) {
      found.times += candidate.times;
    } else {
      tally.set(candidate.to, { ...candidate });
    }
  }

  return {
    candidates: worthLearning([...tally.values()]).sort((a, b) => b.times - a.times),
    checked,
  };
}


/**
 * Pergunta ao Premiere qual é a forma certa do JSON.
 *
 * Quando a importação é recusada, adivinhar o schema é caro e lento —
 * mas o host tem a resposta: qualquer clipe que ELE mesmo transcreveu
 * exporta o formato exato que ele aceita. Esta função procura um,
 * exporta, grava o JSON cru na pasta de trabalho e devolve o desenho
 * da estrutura.
 *
 * Devolve linhas curtas de propósito: elas vão para o diagnóstico do
 * painel, que o editor copia. É o que transforma "recusou" em "recusou
 * porque falta o campo X".
 */
export async function describeHostSchema(scan: TrackScan): Promise<string[]> {
  const ppro = getPremiere();
  if (!ppro?.Transcript?.exportToJSON) {
    return [];
  }
  for (const clip of clipsFor(scan, "all")) {
    if (!clip.hadTranscript) {
      continue;
    }
    try {
      const raw = await ppro.Transcript.exportToJSON(clip.clipItem);
      if (typeof raw !== "string" || raw.trim().length === 0) {
        continue;
      }
      // Guardado inteiro: o resumo cabe no painel, o arquivo é o que
      // permite acertar o schema depois.
      try {
        await write(await workspace(), "cc-host-schema.json", raw);
      } catch {
        /* o resumo abaixo já vale sozinho */
      }
      return summarize(raw);
    } catch {
      // Este clipe não deixou exportar; tenta o próximo.
    }
  }
  return ["nenhum clipe da sequência tem transcrição do próprio Premiere"];
}

/** O desenho da estrutura, sem despejar o texto da fala. */
function summarize(raw: string): string[] {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const lines = [`schema do host — raiz: ${Object.keys(data).join(", ")}`];

    const segments = Array.isArray(data.segments) ? data.segments : null;
    if (segments && segments.length > 0 && typeof segments[0] === "object") {
      const segment = segments[0] as Record<string, unknown>;
      lines.push(`segmento: ${Object.keys(segment).join(", ")}`);
      const words = Array.isArray(segment.words) ? segment.words : null;
      if (words && words.length > 0 && typeof words[0] === "object") {
        lines.push(`palavra: ${Object.keys(words[0] as object).join(", ")}`);
      }
    }
    lines.push("JSON completo salvo em cc-host-schema.json");
    return lines;
  } catch {
    return ["o host exportou algo que não é JSON"];
  }
}
