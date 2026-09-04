/**
 * Organize Project — scan, classify, organize, undo.
 *
 * Folder hierarchy:
 * 📁 Sequencias
 *    ├── 📁 Principal (standalone main sequences without repeated names)
 *    ├── 📁 Nested (standalone nested sequences without repeated names)
 *    └── 📁 [NomeBase] (groups of sequences sharing base name, e.g. VB3.03)
 * 📁 Videos
 * 📁 Audio
 * 📁 Imagens
 * 📁 Graficos & Motion
 * 📁 Itens do Premiere (Adjustment Layers, Color Mattes, Black Video, etc.)
 * 📁 Outros
 *
 * SAFETY RULES:
 * - Only loose items at the project root are collected and organized.
 * - Existing bins (user-created folders, 3rd-party plugin bins like Animation Composer, etc.)
 *   and all files inside them are strictly IGNORED and PRESERVED.
 * - Existing category bins are reused rather than duplicated.
 * - Undo only removes newly created bins, never pre-existing bins.
 * - All operations execute inside atomic undoable transactions.
 */
import type {
  premierepro,
  CompoundAction,
  ProjectItem,
  FolderItem,
  ClipProjectItem,
  Project,
  Sequence,
} from "@adobe/premierepro";
import { getPremiere, describeError } from "../../bridge/premiere";

/**
 * Every write to the project goes through here.
 *
 * `executeTransaction` on its own is not enough: without the surrounding
 * `lockedAccess` the project can change between the handles being read
 * and the actions being built, and Premiere then rejects the whole thing
 * with "The script object is no longer valid" — which is exactly what
 * this Tool was doing on its first bin creation. The Zoom and Curves
 * tools have always paired the two; this one never did.
 *
 * Returns false when the host refuses the transaction.
 */
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

// ── classification buckets ─────────────────────────────────────────

export type ItemCategory =
  | "video"
  | "audio"
  | "image"
  | "graphics"
  | "caption"
  | "sequence"
  | "sequence-nested"
  | "premiere"
  | "other";

export type TopCategory =
  | "sequence"
  | "video"
  | "audio"
  | "image"
  | "graphics"
  | "caption"
  | "premiere"
  | "other";

/** Subpasta de Audio. `null` quando não dá para saber sem chutar. */
export type AudioKind = "sfx" | "music";

export interface ClassifiedItem {
  item: ProjectItem;
  clip: ClipProjectItem | null;
  name: string;
  id: string;
  category: ItemCategory;
  /** Só para category === "audio". null fica solto na pasta Audio. */
  audioKind: AudioKind | null;
  /** For sequences only: the base prefix (e.g. "VB3.03" from "VB3.03 - Body"). */
  sequenceBase: string | null;
  parentId: string;
}

export interface SequenceGroup {
  base: string;
  items: ClassifiedItem[];
}

export interface ScanResult {
  items: ClassifiedItem[];
  counts: Record<ItemCategory, number>;
  totalSequences: number;
  /** Sequence groups that have 2+ members (gets a subfolder like "VB3.03" inside "Sequencias"). */
  sequenceGroups: SequenceGroup[];
  /** Standalone normal sequences (gets "Principal" subfolder inside "Sequencias"). */
  standalonePrincipal: ClassifiedItem[];
  /** Standalone nested sequences (gets "Nested" subfolder inside "Sequencias"). */
  standaloneNested: ClassifiedItem[];
  /** Áudios que a heurística conseguiu classificar, por subpasta. */
  audioKindCounts: Record<AudioKind, number>;
}

export interface OrganizeSnapshot {
  moves: Array<{ itemId: string; originalParentId: string }>;
  createdBinIds: string[];
}

export interface OrganizeResult {
  ok: boolean;
  message: string;
  snapshot: OrganizeSnapshot | null;
}

// ── file extension maps ────────────────────────────────────────────

const VIDEO_EXTS = new Set([
  "mp4", "mov", "avi", "mkv", "mxf", "r3d", "braw", "ari",
  "wmv", "flv", "m4v", "ts", "m2ts", "mts", "3gp", "webm",
  "prores", "dnxhd", "dnxhr", "cine",
]);

const AUDIO_EXTS = new Set([
  "wav", "mp3", "aac", "aif", "aiff", "flac", "ogg", "m4a",
  "wma", "opus", "ac3", "eac3",
]);

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "png", "tiff", "tif", "bmp", "psd", "exr",
  "dpx", "gif", "webp", "svg", "ico", "heic", "heif", "raw",
  "cr2", "nef", "arw", "dng", "tga",
]);

const GRAPHICS_EXTS = new Set([
  "mogrt", "prproj", "aep", "ai", "eps", "pdf",
]);

const CAPTION_EXTS = new Set([
  "srt", "vtt", "sbv", "sub", "ass", "ssa", "dfxp", "scc", "mcc", "stl",
]);

// Known synthetic Premiere item name patterns (case-insensitive substring match)
const PREMIERE_SYNTHETIC_NAMES = [
  "adjustment layer",
  "camada de ajuste",
  "capa de ajuste",
  "color matte",
  "cor fosca",
  "fosco de cor",
  "solid color",
  "color sólido",
  "black video",
  "vídeo preto",
  "video preto",
  "video negro",
  "transparent video",
  "vídeo transparente",
  "video transparente",
  "bars and tone",
  "barras e tom",
  "barras y tono",
  "universal counting leader",
  "contagem regressiva",
];

function isSyntheticName(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return PREMIERE_SYNTHETIC_NAMES.some((pattern) => lower.includes(pattern));
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

function categoryFromExtension(ext: string): ItemCategory {
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (GRAPHICS_EXTS.has(ext)) return "graphics";
  if (CAPTION_EXTS.has(ext)) return "caption";
  return "other";
}

// ── SFX contra trilha ──────────────────────────────────────────────

/*
 * Aqui não existe a pasta curada do ADR-010: a entrada é o que o editor
 * arrastou para o projeto, então a separação tem mesmo de ser inferida.
 *
 * Por isso a regra tem um piso de confiança. O que a heurística não
 * souber dizer fica solto na pasta Audio, nunca é chutado para dentro de
 * uma subpasta — arquivar errado o material de alguém custa mais caro do
 * que não arquivar.
 */

const SFX_HINTS =
  /(^|[^a-z])(sfx|fx|efeito|efeitos|effects?|foley|whoosh|swoosh|impact|riser|braam|stinger|transition|ambien(ce|te)|hit)([^a-z]|$)/i;

const MUSIC_HINTS =
  /(^|[^a-z])(music|m[uú]sica|musicas|trilha|soundtrack|score|song|beat|instrumental|bgm)([^a-z]|$)/i;

/** Acima disto ninguém chama de efeito. */
const MUSIC_MIN_SECONDS = 45;
/** Abaixo disto ninguém chama de trilha. */
const SFX_MAX_SECONDS = 8;

function folderPartOf(mediaPath: string): string {
  const cut = Math.max(mediaPath.lastIndexOf("/"), mediaPath.lastIndexOf("\\"));
  return cut > 0 ? mediaPath.slice(0, cut) : "";
}

/**
 * Formatos que na prática só carregam trilha ou locução.
 *
 * Biblioteca de efeito profissional entrega .wav; ninguém distribui um
 * whoosh em .mp3. Só entra em jogo quando a duração não pôde ser lida —
 * é o último recurso, não um atalho.
 */
const MUSIC_LEANING_EXTS = new Set(["mp3", "m4a", "aac", "ogg", "opus", "wma"]);

/**
 * Duração da mídia em segundos, ou null se o host não disser.
 *
 * `Media.duration` é a duração real do arquivo. Os in/out do project item
 * são outra coisa — o trecho marcado, que num item nunca marcado não
 * responde nada útil — e usá-los deixava toda música sem classificação.
 */
async function audioSeconds(
  ppro: premierepro,
  clip: ClipProjectItem | null
): Promise<number | null> {
  if (!clip) {
    return null;
  }

  try {
    const media = await clip.getMedia();
    const seconds = media?.duration?.seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      return seconds;
    }
  } catch {
    // Cai para os in/out abaixo.
  }

  try {
    const audio = ppro.Constants.MediaType.AUDIO;
    const inPoint = await clip.getInPoint(audio);
    const outPoint = await clip.getOutPoint(audio);
    const seconds = outPoint.seconds - inPoint.seconds;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * Em ordem de confiança: como o editor arquivou, como nomeou, a duração
 * — e a duração só decide nas pontas, onde não é chute. Se nada disso
 * responder, o formato do arquivo desempata.
 */
async function audioKindOf(
  ppro: premierepro,
  clip: ClipProjectItem | null,
  name: string,
  mediaPath: string
): Promise<AudioKind | null> {
  const folder = folderPartOf(mediaPath);
  const seconds = await audioSeconds(ppro, clip);

  const decided = ((): AudioKind | null => {
    if (SFX_HINTS.test(folder)) return "sfx";
    if (MUSIC_HINTS.test(folder)) return "music";

    if (SFX_HINTS.test(name)) return "sfx";
    if (MUSIC_HINTS.test(name)) return "music";

    if (seconds !== null) {
      if (seconds >= MUSIC_MIN_SECONDS) return "music";
      if (seconds <= SFX_MAX_SECONDS) return "sfx";
      return null;
    }

    // Duração ilegível: o formato é o que sobra.
    const ext = extensionOf(mediaPath || name);
    return MUSIC_LEANING_EXTS.has(ext) ? "music" : null;
  })();

  console.log(
    `[Organize] audio "${name}" | ${seconds === null ? "duração ilegível" : `${seconds.toFixed(1)}s`}` +
    ` | pasta "${folder}" | -> ${decided ?? "solto em Audio"}`
  );

  return decided;
}

// ── public labels ──────────────────────────────────────────────────

export const AUDIO_KIND_LABELS: Record<AudioKind, string> = {
  music: "Musicas",
  sfx: "SFX",
};

export const TOP_CATEGORY_LABELS: Record<TopCategory, string> = {
  sequence: "Sequencias",
  video: "Videos",
  audio: "Audio",
  image: "Imagens",
  graphics: "Graficos & Motion",
  caption: "Legendas",
  premiere: "Itens do Premiere",
  other: "Outros",
};

export const TOP_CATEGORY_ORDER: readonly TopCategory[] = [
  "sequence",
  "video",
  "audio",
  "image",
  "graphics",
  "caption",
  "premiere",
  "other",
];

// ── sequence name grouping ─────────────────────────────────────────

const NAME_SEPARATORS = [" - ", " _ ", " – ", " — "];

function sequenceBaseName(name: string): string {
  const trimmed = name.trim();
  for (const sep of NAME_SEPARATORS) {
    const idx = trimmed.indexOf(sep);
    if (idx > 0) {
      return trimmed.slice(0, idx).trim();
    }
  }
  return trimmed;
}

/**
 * Detects whether a sequence name indicates it is a nested or sub-sequence.
 *
 * Catches Premiere Pro's default naming in multiple languages:
 * - English: "Nested Sequence 01", "Nested Sequence 1", etc.
 * - Portuguese: "Sequência aninhada 01", "Sequencia aninhada 01", "Seq aninhada", etc.
 * - Spanish: "Secuencia anidada 01", etc.
 * - French: "Séquence imbriquée 01", etc.
 * - German: "Gefaltete Sequenz 01", etc.
 * - Italian: "Sequenza nidificata 01", etc.
 *
 * Also recognizes common editor naming conventions:
 * - Substring cues: "nested", "aninhad", "anidad", "imbriqu", "nidificat"
 * - Delimited tokens: "nest", "nests", "subseq", "subsequence", "subsequencia", "subsequência"
 *   (using token boundary checks so words like "honest", "earnest", "nestle" don't match).
 */
export function isNestedSequenceName(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();

  // Explicit keywords that unambiguously denote a nested sequence in video editing
  if (
    lower.includes("nested") ||
    lower.includes("aninhad") ||
    lower.includes("anidad") ||
    lower.includes("imbriqu") ||
    lower.includes("nidificat") ||
    lower.includes("gefaltet")
  ) {
    return true;
  }

  // Tokenize by non-alphanumeric delimiters (spaces, _, -, ., [], (), etc.)
  // Preserve accented characters (\u00C0-\u017F) so e.g. "subsequência" doesn't split
  const tokens = lower.split(/[^a-z0-9\u00C0-\u017F]+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token === "nest" ||
      token === "nests" ||
      token === "subseq" ||
      token === "subseqs" ||
      token === "subsequence" ||
      token === "subsequences" ||
      token === "subsequencia" ||
      token === "subsequencias" ||
      token === "subsequência" ||
      token === "subsequências"
    ) {
      return true;
    }

    // Also match hyphenated/separated "sub-sequence", "sub-seq", "sub-sequencia"
    if (
      token === "sub" &&
      i + 1 < tokens.length &&
      (tokens[i + 1] === "seq" ||
        tokens[i + 1] === "seqs" ||
        tokens[i + 1] === "sequence" ||
        tokens[i + 1] === "sequences" ||
        tokens[i + 1] === "sequencia" ||
        tokens[i + 1] === "sequencias" ||
        tokens[i + 1] === "sequência" ||
        tokens[i + 1] === "sequências")
    ) {
      return true;
    }
  }

  return false;
}

// ── scan ───────────────────────────────────────────────────────────

/**
 * Scans loose items sitting in the root folder and classifies them.
 *
 * Existing bins (user folders, Animation Composer, Premiere Composer, etc.)
 * and items already organized inside bins are strictly ignored.
 */
export async function scanProject(): Promise<ScanResult> {
  const ppro = getPremiere();
  if (!ppro) {
    throw new Error("Premiere UXP runtime indisponível.");
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new Error("Nenhum projeto aberto.");
  }

  // 1. Collect ONLY loose ProjectItems directly in the root (skipping all bins)
  const rootFolder = await project.getRootItem();
  const rootLooseItems = await collectRootLooseItems(ppro, rootFolder);

  /*
   * The project's own list of sequences.
   *
   * Asking each item "are you a sequence?" put two video files under
   * Sequencias. `getSequences()` is the project stating what its
   * sequences are, which is a different kind of answer from an item
   * describing itself — and the only one that cannot be contradicted.
   */
  const projectSequenceGuids = new Set<string>();
  const projectSequenceNames = new Set<string>();
  let projectSequences: Sequence[] = [];
  try {
    projectSequences = await project.getSequences();
    for (const seq of projectSequences) {
      try {
        if (seq.guid) projectSequenceGuids.add(String(seq.guid));
      } catch { /* sem guid legível */ }
      try {
        if (seq.name) projectSequenceNames.add(seq.name);
      } catch { /* sem nome legível */ }
    }
  } catch {
    // Host não respondeu; os sinais por item assumem abaixo.
  }
  const hasProjectSequenceList =
    projectSequenceGuids.size > 0 || projectSequenceNames.size > 0;

  // 2. Identify sequences and detect nesting across project
  const nestedDetection = await detectNestedSequences(
    ppro,
    projectSequences,
    projectSequenceNames
  );

  // 3. Classify each loose item
  const classified: ClassifiedItem[] = [];
  const diagnostics: string[] = [];
  for (const { item, parentId } of rootLooseItems) {
    const id = item.getId();
    const name = item.name ?? "";

    // Double check: skip bins
    if (item.type === ppro.ProjectItem.TYPE_BIN || item.type === ppro.ProjectItem.TYPE_ROOT) {
      continue;
    }

    let clip: ClipProjectItem | null = null;
    try {
      clip = ppro.ClipProjectItem.cast(item);
    } catch {
      clip = null;
    }

    // Read the media path before deciding anything: it is what settles
    // sequence against clip. A sequence has no file behind it.
    let mediaPath = "";
    let canChangePath = true;
    if (clip) {
      try {
        mediaPath = (await clip.getMediaFilePath()) || "";
      } catch {
        mediaPath = "";
      }
      try {
        canChangePath = await clip.canChangeMediaPath();
      } catch {
        canChangePath = true;
      }
    }

    const ext = extensionOf(mediaPath || name);
    const hasRealMedia =
      mediaPath !== "" &&
      (VIDEO_EXTS.has(ext) ||
        AUDIO_EXTS.has(ext) ||
        IMAGE_EXTS.has(ext) ||
        GRAPHICS_EXTS.has(ext) ||
        CAPTION_EXTS.has(ext));

    /*
     * Three signals, because one was not enough: a video was being filed
     * under Sequencias. `getContentType()` states it outright, so it
     * leads; `isSequence()` answers when the host will not; and a real
     * media file on disk vetoes both, since no sequence has one.
     */
    // Sinais do item, guardados crus para o diagnóstico.
    let claimsSequence = false;
    let contentTypeRaw: unknown = undefined;
    let ownGuid: string | null = null;

    if (clip) {
      try {
        claimsSequence = await clip.isSequence();
      } catch {
        claimsSequence = false;
      }
      try {
        contentTypeRaw = await clip.getContentType();
      } catch {
        contentTypeRaw = undefined;
      }
      try {
        const own = await clip.getSequence();
        ownGuid = own ? String(own.guid) : null;
      } catch {
        ownGuid = null;
      }
    }

    /*
     * A lista do projeto decide quando existe. Um item só é sequência se
     * o projeto o reconhece como uma — por guid, ou pelo nome quando o
     * guid não vem. Os sinais do próprio item viraram fallback, porque
     * foram justamente eles que erraram.
     */
    let isSeq: boolean;
    if (hasProjectSequenceList) {
      isSeq =
        (ownGuid !== null && projectSequenceGuids.has(ownGuid)) ||
        (ownGuid === null && projectSequenceNames.has(name) && !hasRealMedia);
    } else {
      const sequenceConst = ppro.Constants?.ContentType?.SEQUENCE;
      const byContentType =
        sequenceConst !== undefined && contentTypeRaw === sequenceConst;
      isSeq = (claimsSequence || byContentType) && !hasRealMedia;
    }

    let category: ItemCategory;
    let seqBase: string | null = null;
    let audioKind: AudioKind | null = null;
    let mediaPathForKind = "";

    if (isSeq) {
      const isNestedByName = isNestedSequenceName(name);
      const isNestedByTimeline =
        nestedDetection.ids.has(id) ||
        nestedDetection.names.has(name.trim().toLowerCase()) ||
        (ownGuid !== null && nestedDetection.guids.has(ownGuid));
      const isNested = isNestedByName || isNestedByTimeline;

      category = isNested ? "sequence-nested" : "sequence";
      seqBase = sequenceBaseName(name);
    } else {
      // Identify Premiere synthetic items (Adjustment Layers, Color Mattes, Black Video, etc.)
      if (
        isSyntheticName(name) ||
        (!canChangePath && !ext) ||
        (!mediaPath && !ext)
      ) {
        category = "premiere";
      } else {
        category = categoryFromExtension(ext);
      }
      mediaPathForKind = mediaPath;
    }

    if (category === "audio") {
      audioKind = await audioKindOf(ppro, clip, name, mediaPathForKind);
    }

    diagnostics.push(
      `  ${category.padEnd(16)} ${name}\n` +
        `      isSequence=${claimsSequence}` +
        ` contentType=${String(contentTypeRaw)}` +
        ` guid=${ownGuid ?? "—"}` +
        ` noProjeto=${ownGuid !== null && projectSequenceGuids.has(ownGuid)}` +
        ` nomeNaLista=${projectSequenceNames.has(name)}` +
        ` isNestedByName=${isNestedSequenceName(name)}` +
        ` isNestedByTimeline=${nestedDetection.ids.has(id) || nestedDetection.names.has(name.trim().toLowerCase())}\n` +
        `      ext="${ext}" mídia="${mediaPath}"`
    );

    classified.push({
      item, clip, name, id, category, audioKind, sequenceBase: seqBase, parentId,
    });
  }

  // 4. Count per category
  const counts: Record<ItemCategory, number> = {
    video: 0, audio: 0, image: 0, graphics: 0, caption: 0,
    sequence: 0, "sequence-nested": 0, premiere: 0, other: 0,
  };
  const audioKindCounts: Record<AudioKind, number> = { sfx: 0, music: 0 };
  for (const c of classified) {
    counts[c.category]++;
    if (c.audioKind) {
      audioKindCounts[c.audioKind]++;
    }
  }

  const totalSequences = counts.sequence + counts["sequence-nested"];

  // Todos os sinais crus por item. Enquanto a classificação depender de
  // como o host responde, isto é o que transforma um palpite em fato.
  console.log(
    `[Organize] o projeto declara ${projectSequenceNames.size} sequência(s): ` +
      `${[...projectSequenceNames].join(", ") || "—"}\n` +
      "[Organize] classificação:\n" +
      diagnostics.join("\n")
  );

  // 5. Group ALL sequences together by sequenceBase
  const allSequences = classified.filter(
    (c) => c.category === "sequence" || c.category === "sequence-nested"
  );

  const seqMap = new Map<string, ClassifiedItem[]>();
  for (const seqItem of allSequences) {
    const base = seqItem.sequenceBase ?? seqItem.name;
    const list = seqMap.get(base);
    if (list) {
      list.push(seqItem);
    } else {
      seqMap.set(base, [seqItem]);
    }
  }

  const sequenceGroups: SequenceGroup[] = [];
  const standalonePrincipal: ClassifiedItem[] = [];
  const standaloneNested: ClassifiedItem[] = [];

  for (const [base, members] of seqMap) {
    // Se a base for um identificador genérico de sequência aninhada (ex: "Nested", "Nested Sequence", "Sequência aninhada"),
    // vai para a pasta dedicada "Nested" em vez de criar uma subpasta de grupo ad-hoc redundante.
    if (members.length >= 2 && !isNestedSequenceName(base)) {
      sequenceGroups.push({ base, items: members });
    } else {
      for (const member of members) {
        if (member.category === "sequence-nested") {
          standaloneNested.push(member);
        } else {
          standalonePrincipal.push(member);
        }
      }
    }
  }

  return {
    items: classified,
    counts,
    totalSequences,
    sequenceGroups,
    standalonePrincipal,
    standaloneNested,
    audioKindCounts,
  };
}

// ── collect loose items at root ────────────────────────────────────

interface CollectedItem {
  item: ProjectItem;
  parentId: string;
}

/**
 * Collects the items this Tool is allowed to move.
 *
 * Two places: loose at the project root, and directly inside the Tool's
 * own top-level category bins. The second is what makes a re-run able to
 * refine what an earlier run filed — without it, an audio file already
 * sitting in "Audio" was invisible, so the SFX/Musicas subfolders could
 * never be created for material that had already been organized once.
 *
 * User-created folders, 3rd party plugin folders (Animation Composer and
 * the like), and anything nested deeper stay strictly IGNORED. A bin only
 * counts as ours if its name is exactly one of TOP_CATEGORY_LABELS.
 */
async function collectRootLooseItems(
  ppro: premierepro,
  rootFolder: FolderItem
): Promise<CollectedItem[]> {
  const result: CollectedItem[] = [];
  const ourBinNames = new Set<string>(Object.values(TOP_CATEGORY_LABELS));
  const children = await rootFolder.getItems();

  for (const child of children) {
    if (child.type === ppro.ProjectItem.TYPE_ROOT) {
      continue;
    }

    if (child.type === ppro.ProjectItem.TYPE_BIN) {
      if (!ourBinNames.has(child.name)) {
        continue;
      }
      // One of ours: take what sits directly inside it, and leave any
      // subfolder of it alone — those are already sorted.
      try {
        const ourBin = ppro.FolderItem.cast(child);
        const binId = child.getId();
        for (const inner of await ourBin.getItems()) {
          if (
            inner.type === ppro.ProjectItem.TYPE_BIN ||
            inner.type === ppro.ProjectItem.TYPE_ROOT
          ) {
            continue;
          }
          result.push({ item: inner, parentId: binId });
        }
      } catch {
        // cast failed; leave the bin untouched
      }
      continue;
    }

    result.push({ item: child, parentId: "__root__" });
  }

  return result;
}

// ── detect nested sequences ────────────────────────────────────────

export interface NestedSequenceDetection {
  ids: Set<string>;
  names: Set<string>;
  guids: Set<string>;
}

async function detectNestedSequences(
  ppro: premierepro,
  sequences: Sequence[],
  projectSequenceNames: Set<string>
): Promise<NestedSequenceDetection> {
  const ids = new Set<string>();
  const names = new Set<string>();
  const guids = new Set<string>();
  /*
   * O veredito "é sequência?" depende só do project item, mas a
   * varredura pergunta por OCORRÊNCIA na timeline: cinco sequências de
   * trezentos clipes eram milhares de idas ao host para responder
   * sobre poucas dezenas de itens distintos. O memo derruba para uma
   * pergunta por item. E as faixas de vídeo e de áudio passam pelo
   * MESMO laço — eram dois blocos idênticos convidando a divergir.
   */
  const verdicts = new Map<string, boolean>();

  const scanTrack = async (track: {
    getTrackItems(kind: unknown, all: boolean): unknown;
  } | null): Promise<void> => {
    if (!track) return;
    try {
      const items = track.getTrackItems(
        ppro.Constants.TrackItemType.CLIP,
        false
      ) as Array<{
        getProjectItem(): Promise<ProjectItem | null>;
        getName?(): Promise<string> | string;
      }>;

      for (const ti of items) {
        try {
          // 1. Check track item name directly from the timeline
          try {
            const rawTiName = await Promise.resolve(ti.getName?.()).catch(() => "");
            const tiName = (rawTiName ?? "").trim();
            if (tiName && projectSequenceNames.has(tiName)) {
              names.add(tiName.toLowerCase());
            }
          } catch {
            // ignore
          }

          // 2. Check projectItem of track item
          const pi = await ti.getProjectItem();
          if (!pi) continue;

          const id = pi.getId();
          const piName = (pi.name ?? "").trim();
          if (piName && projectSequenceNames.has(piName)) {
            names.add(piName.toLowerCase());
          }

          let isSub = verdicts.get(id);
          if (isSub === undefined) {
            let claimsSeq = false;
            try {
              const clip = ppro.ClipProjectItem.cast(pi);
              claimsSeq = await clip.isSequence();
            } catch {
              claimsSeq = false;
            }
            isSub = claimsSeq || (piName !== "" && projectSequenceNames.has(piName));
            verdicts.set(id, isSub);
          }

          if (isSub) {
            ids.add(id);
            if (piName) {
              names.add(piName.toLowerCase());
            }
            try {
              const clip = ppro.ClipProjectItem.cast(pi);
              const own = await clip.getSequence();
              if (own && own.guid) {
                guids.add(String(own.guid));
              }
            } catch {
              // sem sequence handle
            }
          }
        } catch {
          // not a sequence clip
        }
      }
    } catch {
      // track error
    }
  };

  for (const seq of sequences) {
    try {
      const videoTrackCount = await seq.getVideoTrackCount();
      for (let t = 0; t < videoTrackCount; t++) {
        await scanTrack(await seq.getVideoTrack(t));
      }
      const audioTrackCount = await seq.getAudioTrackCount();
      for (let t = 0; t < audioTrackCount; t++) {
        await scanTrack(await seq.getAudioTrack(t));
      }
    } catch {
      // Host não respondeu nesta sequência; segue para as próximas
    }
  }

  return { ids, names, guids };
}

// ── organize ───────────────────────────────────────────────────────

/**
 * Creates folders and moves items into their target category bin.
 *
 * Every phase re-reads the project from `getRootItem()` instead of
 * carrying handles across transactions. Creating a bin invalidates the
 * handles taken before it, and Premiere answers "The script object is no
 * longer valid" the moment one is touched — so a handle is never allowed
 * to outlive the transaction it was read after.
 *
 * Each phase also names itself, so a failure says where it happened
 * instead of leaving the whole run a mystery.
 */
export async function organizeProject(scan: ScanResult): Promise<OrganizeResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    return { ok: false, message: "Nenhum projeto aberto.", snapshot: null };
  }

  const snapshot: OrganizeSnapshot = { moves: [], createdBinIds: [] };
  let phase = "iniciar";

  try {
    // ── Phase 1: top-level category bins ──────────────────────────
    phase = "ler a raiz do projeto";
    let root = await project.getRootItem();

    const existingTopNames = new Set<string>();
    for (const child of await root.getItems()) {
      if (child.type === ppro.ProjectItem.TYPE_BIN) {
        existingTopNames.add(child.name);
      }
    }

    phase = "criar as pastas principais";
    const wantedTop: Array<[TopCategory, number]> = [
      ["sequence", scan.totalSequences],
      ["video", scan.counts.video],
      ["audio", scan.counts.audio],
      ["image", scan.counts.image],
      ["graphics", scan.counts.graphics],
      ["caption", scan.counts.caption],
      ["premiere", scan.counts.premiere],
      ["other", scan.counts.other],
    ];
    let plannedTop = 0;
    const topCreated = commitTransaction(
      project,
      "Organizar Projeto — Criar Pastas Principais",
      (tx) => {
        for (const [cat, count] of wantedTop) {
          const label = TOP_CATEGORY_LABELS[cat];
          if (count > 0 && !existingTopNames.has(label)) {
            tx.addAction(root.createBinAction(label, true));
            plannedTop += 1;
          }
        }
      }
    );
    // An empty transaction also answers false, so only a refusal that had
    // work in it is a refusal. Letting this one pass silently meant phase 3
    // found no target bins, moved nothing, and reported "tudo já está no
    // lugar" over a project where nothing had been created.
    if (plannedTop > 0 && !topCreated) {
      return {
        ok: false,
        message: "O Premiere recusou a criação das pastas principais. Nada foi alterado.",
        snapshot: null,
      };
    }

    // ── Phase 2: subfolders, in one transaction ───────────────────
    phase = "reler as pastas principais";
    root = await project.getRootItem();
    const afterTop = await readBinLayout(ppro, root);

    for (const [cat, folder] of afterTop.top) {
      if (!existingTopNames.has(TOP_CATEGORY_LABELS[cat])) {
        const id = afterTop.ids.get(folder);
        if (id) snapshot.createdBinIds.push(id);
      }
    }

    const hadPrincipal = !!afterTop.seqPrincipal;
    const hadNested = !!afterTop.seqNested;
    const hadSeqGroups = new Set(afterTop.seqGroups.keys());
    const hadAudioKinds = new Set(afterTop.audioKind.keys());

    phase = "criar as subpastas";
    const seqBin = afterTop.top.get("sequence");
    const audioBin = afterTop.top.get("audio");
    let plannedSub = 0;
    const subCreated = commitTransaction(
      project,
      "Organizar Projeto — Subpastas",
      (tx) => {
        if (seqBin && scan.totalSequences > 0) {
          if (scan.standalonePrincipal.length > 0 && !hadPrincipal) {
            tx.addAction(seqBin.createBinAction("Principal", true));
            plannedSub += 1;
          }
          if (scan.standaloneNested.length > 0 && !hadNested) {
            tx.addAction(seqBin.createBinAction("Nested", true));
            plannedSub += 1;
          }
          for (const group of scan.sequenceGroups) {
            if (!hadSeqGroups.has(group.base)) {
              tx.addAction(seqBin.createBinAction(group.base, true));
              plannedSub += 1;
            }
          }
        }

        // Only the kinds actually found, so a project with nothing but
        // music never grows an empty SFX bin.
        if (audioBin) {
          for (const kind of ["music", "sfx"] as AudioKind[]) {
            if (scan.audioKindCounts[kind] > 0 && !hadAudioKinds.has(kind)) {
              tx.addAction(audioBin.createBinAction(AUDIO_KIND_LABELS[kind], true));
              plannedSub += 1;
            }
          }
        }
      }
    );
    if (plannedSub > 0 && !subCreated) {
      return {
        ok: false,
        message:
          "O Premiere recusou a criação das subpastas. As pastas principais " +
          "podem ter sido criadas; nenhum item foi movido.",
        snapshot: null,
      };
    }

    // ── Phase 3: move ─────────────────────────────────────────────
    phase = "reler a estrutura de pastas";
    root = await project.getRootItem();
    const layout = await readBinLayout(ppro, root);

    if (layout.seqPrincipal && !hadPrincipal) {
      const id = layout.ids.get(layout.seqPrincipal);
      if (id) snapshot.createdBinIds.push(id);
    }
    if (layout.seqNested && !hadNested) {
      const id = layout.ids.get(layout.seqNested);
      if (id) snapshot.createdBinIds.push(id);
    }
    for (const [name, folder] of layout.seqGroups) {
      if (!hadSeqGroups.has(name)) {
        const id = layout.ids.get(folder);
        if (id) snapshot.createdBinIds.push(id);
      }
    }
    for (const kind of ["music", "sfx"] as AudioKind[]) {
      const folder = layout.audioKind.get(kind);
      if (folder && !hadAudioKinds.has(kind)) {
        const id = layout.ids.get(folder);
        if (id) snapshot.createdBinIds.push(id);
      }
    }

    phase = "indexar os itens";
    const freshItems = new Map<string, ProjectItem>();
    await indexAllItems(ppro, root, freshItems);

    phase = "mover os itens";
    let movedCount = 0;
    let missingTargets = 0;
    const moveRoot = root;

    const moved = commitTransaction(project, "Organizar Projeto — Mover Itens", (tx) => {
      for (const classified of scan.items) {
        const { category, audioKind, sequenceBase, parentId } = classified;

        let targetBin: FolderItem | undefined;
        const seqTop = layout.top.get("sequence");

        if (category === "sequence" || category === "sequence-nested") {
          if (sequenceBase && layout.seqGroups.has(sequenceBase)) {
            targetBin = layout.seqGroups.get(sequenceBase);
          } else if (category === "sequence-nested") {
            targetBin = layout.seqNested ?? seqTop;
          } else {
            targetBin = layout.seqPrincipal ?? seqTop;
          }
        } else if (category === "audio") {
          // Sem classificação confiável o arquivo fica solto em Audio,
          // que é onde ele estaria de qualquer forma.
          targetBin =
            (audioKind ? layout.audioKind.get(audioKind) : undefined) ??
            layout.top.get("audio");
        } else {
          targetBin = layout.top.get(category as TopCategory);
        }

        if (!targetBin) {
          missingTargets += 1;
          continue;
        }

        // Already where it belongs. The scan now sees items inside the
        // Tool's own bins, so without this every pass would re-file
        // everything and fill the undo snapshot with no-ops.
        if (layout.ids.get(targetBin) === parentId) continue;

        // The handle from the scan is stale by now; the id is not.
        const freshItem = freshItems.get(classified.id);
        if (!freshItem) continue;

        snapshot.moves.push({
          itemId: classified.id,
          originalParentId: parentId,
        });

        tx.addAction(moveRoot.createMoveItemAction(freshItem, targetBin));
        movedCount++;
      }
    });

    // Uma transação vazia também devolve false, então só é recusa
    // quando havia algo para mover.
    if (movedCount > 0 && !moved) {
      return {
        ok: false,
        message: "O Premiere recusou a movimentação. Nada foi alterado.",
        snapshot: null,
      };
    }

    // "Nada a mover" is only true when there was nothing to move. When the
    // items had nowhere to go, saying it was a success over a failure.
    if (movedCount === 0 && missingTargets > 0) {
      return {
        ok: false,
        message:
          `${missingTargets} ${missingTargets === 1 ? "item ficou" : "itens ficaram"} sem ` +
          "pasta de destino. Confira se as pastas do plugin existem na raiz do projeto.",
        snapshot: null,
      };
    }

    return {
      ok: true,
      message: movedCount > 0
        ? `${movedCount} ${movedCount === 1 ? "item organizado" : "itens organizados"} com sucesso.` +
          (missingTargets > 0
            ? ` ${missingTargets} sem pasta de destino.`
            : "")
        : "Nada a mover — tudo já está no lugar.",
      snapshot,
    };
  } catch (cause) {
    console.error(`[Organize] falhou ao ${phase}:`, cause);
    return {
      ok: false,
      message: `Falha ao ${phase}: ${describeError(cause)}`,
      snapshot: null,
    };
  }
}

export async function undoOrganize(
  snapshot: OrganizeSnapshot
): Promise<OrganizeResult> {
  const ppro = getPremiere();
  if (!ppro) {
    return { ok: false, message: "Premiere UXP runtime indisponível.", snapshot: null };
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    return { ok: false, message: "Nenhum projeto aberto.", snapshot: null };
  }

  try {
    const rootFolder = await project.getRootItem();

    const allBins = new Map<string, FolderItem>();
    await indexBins(ppro, rootFolder, allBins);
    allBins.set("__root__", rootFolder);

    const allItemsById = new Map<string, ProjectItem>();
    await indexAllItems(ppro, rootFolder, allItemsById);

    // Phase 1: Move items back to original parents
    let restoredCount = 0;
    let lostCount = 0;

    const restored = commitTransaction(
      project,
      "Desfazer Organização — Restaurar Itens",
      (tx) => {
        for (const move of snapshot.moves) {
          const item = allItemsById.get(move.itemId);
          const originalParent = allBins.get(move.originalParentId);
          if (!item || !originalParent) {
            lostCount++;
            continue;
          }

          const moveAction = rootFolder.createMoveItemAction(item, originalParent);
          tx.addAction(moveAction);
          restoredCount++;
        }
      }
    );

    // `restoredCount` counts what was planned, not what the host accepted.
    // Reporting it either way painted the panel green over an undo that
    // had not happened — and returning a null snapshot took away the only
    // chance of trying again.
    if (restoredCount > 0 && !restored) {
      return {
        ok: false,
        message: "O Premiere recusou a restauração dos itens. Nada foi movido de volta.",
        snapshot,
      };
    }

    // Phase 2: Remove ONLY newly created bins (deepest first).
    // Re-read from the host: the restore above moved items, so every
    // handle taken before it is a snapshot of a project that changed.
    const rootAfterRestore = await project.getRootItem();
    const updatedBins = new Map<string, FolderItem>();
    await indexBins(ppro, rootAfterRestore, updatedBins);

    /*
     * A bin the Tool created is not the Tool's to delete unconditionally.
     * The editor organises, then drags ten new files into "Videos", then
     * presses Desfazer — and removing the bin takes the ten files with it.
     * Nothing about the word "desfazer" promises that.
     *
     * So each candidate is read back and only removed when what is left
     * inside it is nothing, or is only other bins that are themselves
     * being removed. `createdBinIds` is filled parents-first, so walking
     * it backwards settles the children before their parent is judged.
     */
    interface BinCandidate {
      id: string;
      folder: FolderItem;
      childIds: string[];
    }

    const candidates: BinCandidate[] = [];
    for (const id of snapshot.createdBinIds) {
      const folder = updatedBins.get(id);
      if (!folder) {
        continue;
      }
      let childIds: string[];
      try {
        childIds = (await folder.getItems()).map((child) => safeId(child));
      } catch {
        // Unreadable: leaving a folder standing is the cheap mistake.
        continue;
      }
      candidates.push({ id, folder, childIds });
    }

    const removableIds = new Set<string>();
    let keptBins = 0;
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index]!;
      const hasForeignContent = candidate.childIds.some(
        (childId) => !removableIds.has(childId)
      );
      if (hasForeignContent) {
        keptBins += 1;
        continue;
      }
      removableIds.add(candidate.id);
    }

    const binsToRemove = candidates
      .filter((candidate) => removableIds.has(candidate.id))
      .reverse();

    let binsRemoved = true;
    if (binsToRemove.length > 0) {
      binsRemoved = commitTransaction(
        project,
        "Desfazer Organização — Remover Pastas",
        (tx) => {
          for (const { folder } of binsToRemove) {
            const piCast = ppro.ProjectItem.cast(folder);
            const removeAction = rootAfterRestore.createRemoveItemAction(piCast);
            tx.addAction(removeAction);
          }
        }
      );
    }

    const notes: string[] = [];
    if (keptBins > 0) {
      notes.push(
        `${keptBins} ${keptBins === 1 ? "pasta mantida" : "pastas mantidas"} ` +
          "por ter conteúdo novo dentro."
      );
    }
    if (lostCount > 0) {
      notes.push(
        `${lostCount} ${lostCount === 1 ? "item não foi encontrado" : "itens não foram encontrados"} no projeto.`
      );
    }
    if (!binsRemoved) {
      notes.push("O Premiere recusou a remoção das pastas vazias.");
    }

    return {
      ok: true,
      message: [
        `${restoredCount} ${restoredCount === 1 ? "item restaurado" : "itens restaurados"}.`,
        ...notes,
      ].join(" "),
      snapshot: null,
    };
  } catch (cause) {
    // The snapshot survives a failure: it is the only way back.
    return {
      ok: false,
      message: `Falha ao desfazer: ${describeError(cause)}`,
      snapshot,
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────

/** The item's id, or "" when the host will not answer for it. */
function safeId(item: ProjectItem): string {
  try {
    return item.getId();
  } catch {
    return "";
  }
}

/** Bins que a fase 3 usa como destino, lidos do estado atual. */
interface BinLayout {
  top: Map<TopCategory, FolderItem>;
  audioKind: Map<AudioKind, FolderItem>;
  seqPrincipal?: FolderItem;
  seqNested?: FolderItem;
  seqGroups: Map<string, FolderItem>;
  /** FolderItem não expõe id; o ProjectItem de onde ele veio expõe. */
  ids: Map<FolderItem, string>;
}

/**
 * Lê a estrutura de pastas da ferramenta como ela está agora.
 *
 * Chamada depois da última transação que cria bins, para que nenhum
 * handle usado na movimentação tenha atravessado uma fronteira de
 * transação — é o que evita o "script object is no longer valid".
 */
async function readBinLayout(
  ppro: premierepro,
  rootFolder: FolderItem
): Promise<BinLayout> {
  const layout: BinLayout = {
    top: new Map(),
    audioKind: new Map(),
    seqGroups: new Map(),
    ids: new Map(),
  };

  for (const child of await rootFolder.getItems()) {
    if (child.type !== ppro.ProjectItem.TYPE_BIN) {
      continue;
    }
    let folder: FolderItem;
    try {
      folder = ppro.FolderItem.cast(child);
    } catch {
      continue;
    }
    layout.ids.set(folder, child.getId());

    const category = TOP_CATEGORY_ORDER.find(
      (cat) => TOP_CATEGORY_LABELS[cat] === child.name
    );
    if (!category) {
      continue;
    }
    layout.top.set(category, folder);

    if (category !== "audio" && category !== "sequence") {
      continue;
    }

    for (const sub of await folder.getItems()) {
      if (sub.type !== ppro.ProjectItem.TYPE_BIN) {
        continue;
      }
      let subFolder: FolderItem;
      try {
        subFolder = ppro.FolderItem.cast(sub);
      } catch {
        continue;
      }
      layout.ids.set(subFolder, sub.getId());

      if (category === "audio") {
        for (const kind of ["music", "sfx"] as AudioKind[]) {
          if (sub.name === AUDIO_KIND_LABELS[kind]) {
            layout.audioKind.set(kind, subFolder);
          }
        }
      } else if (sub.name === "Principal") {
        layout.seqPrincipal = subFolder;
      } else if (sub.name === "Nested") {
        layout.seqNested = subFolder;
      } else {
        layout.seqGroups.set(sub.name, subFolder);
      }
    }
  }

  return layout;
}

async function indexBins(
  ppro: premierepro,
  folder: FolderItem,
  map: Map<string, FolderItem>
): Promise<void> {
  const children = await folder.getItems();
  for (const child of children) {
    if (child.type === ppro.ProjectItem.TYPE_BIN) {
      try {
        const sub = ppro.FolderItem.cast(child);
        map.set(child.getId(), sub);
        await indexBins(ppro, sub, map);
      } catch { /* cast failed */ }
    }
  }
}

async function indexAllItems(
  ppro: premierepro,
  folder: FolderItem,
  map: Map<string, ProjectItem>
): Promise<void> {
  const children = await folder.getItems();
  for (const child of children) {
    map.set(child.getId(), child);
    if (child.type === ppro.ProjectItem.TYPE_BIN) {
      try {
        const sub = ppro.FolderItem.cast(child);
        await indexAllItems(ppro, sub, map);
      } catch { /* cast failed */ }
    }
  }
}
