/**
 * Premiere host bridge (Product Shell layer).
 *
 * Owns the single point of contact with the `premierepro` runtime module and
 * the read-only host status shown by the Shell.
 */
import type {
  premierepro,
  Sequence,
  VideoClipTrackItem,
} from "@adobe/premierepro";

/** Resolves the Premiere runtime, or null when running outside the host. */
export function getPremiere(): premierepro | null {
  if (typeof require !== "function") {
    return null;
  }
  try {
    return require("premierepro") ?? null;
  } catch {
    return null;
  }
}

export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One clip on the track the strip shows, positioned in sequence time.
 *
 * The start and end matter: laying clips end to end hides the gaps, and
 * a playhead drawn over that lands nowhere near where it really is.
 */
export interface SelectionClip {
  startSeconds: number;
  endSeconds: number;
  selected: boolean;
}

export interface SelectionSummary {
  /** Clips of the track the strip shows, for context. */
  clips: SelectionClip[];
  /** Sequence time the strip spans. */
  rangeStart: number;
  rangeEnd: number;
  /** Selected clips across EVERY video track — what Apply will touch. */
  selectedCount: number;
  /** Combined duration of every selected clip, in seconds. */
  selectedSeconds: number;
  /** Label of the track the strip shows. */
  trackLabel: string | null;
  /** true when the selection reaches tracks the strip does not show. */
  spansTracks: boolean;
  /** Playhead as a fraction of [rangeStart, rangeEnd], or null if outside. */
  playheadRatio: number | null;
}

const EMPTY_SELECTION: SelectionSummary = {
  clips: [],
  rangeStart: 0,
  rangeEnd: 0,
  selectedCount: 0,
  selectedSeconds: 0,
  trackLabel: null,
  spansTracks: false,
  playheadRatio: null,
};

/**
 * Read-only view of what a Tool would act on.
 *
 * The count spans every video track, because that is what the Tools
 * act on — reporting only the busiest track made the button badge
 * disagree with what Apply actually wrote. The strip still shows one
 * track, since a strip of every track would be a timeline, not a hint.
 * Never throws, never mutates.
 */
export async function readSelection(): Promise<SelectionSummary> {
  const ppro = getPremiere();
  if (!ppro) {
    return EMPTY_SELECTION;
  }

  try {
    const project = await ppro.Project.getActiveProject();
    const sequence = project ? await project.getActiveSequence() : null;
    if (!sequence) {
      return EMPTY_SELECTION;
    }

    const trackCount = await sequence.getVideoTrackCount();
    let best: SelectionClip[] = [];
    let bestSelected = 0;
    let bestIndex = -1;
    let totalSelected = 0;
    let totalSeconds = 0;

    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      const track = await sequence.getVideoTrack(trackIndex);
      if (!track) {
        continue;
      }

      const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);

      /*
       * As três leituras de cada item são independentes entre si e
       * entre itens — em paralelo, a faixa inteira custa uma rodada de
       * ida-e-volta em vez de três POR item em série. Esta função roda
       * na abertura do painel e a cada foco de janela: numa sequência
       * longa, era ela que segurava a strip por segundos.
       */
      const reads = await Promise.all(
        items.map(async (item) => {
          // TickTime is a callable type in the typings, so it is never
          // truthiness-checked — read the seconds and validate the number.
          const [start, end, isSelected] = await Promise.all([
            item.getStartTime(),
            item.getEndTime(),
            item.getIsSelected(),
          ]);
          return { startSeconds: start.seconds, endSeconds: end.seconds, isSelected };
        })
      );

      const clips: SelectionClip[] = [];
      let selected = 0;
      for (const read of reads) {
        if (!(read.endSeconds > read.startSeconds)) {
          continue;
        }
        if (read.isSelected) {
          selected += 1;
          totalSelected += 1;
          totalSeconds += read.endSeconds - read.startSeconds;
        }
        clips.push({
          startSeconds: read.startSeconds,
          endSeconds: read.endSeconds,
          selected: read.isSelected,
        });
      }

      if (selected > bestSelected) {
        best = clips;
        bestSelected = selected;
        bestIndex = trackIndex;
      }
    }

    if (totalSelected === 0) {
      return EMPTY_SELECTION;
    }

    // Um laço em vez de espalhar o array: uma faixa com dezenas de
    // milhares de itens estoura o limite de argumentos de Math.min.
    let rangeStart = Number.POSITIVE_INFINITY;
    let rangeEnd = Number.NEGATIVE_INFINITY;
    for (const clip of best) {
      if (clip.startSeconds < rangeStart) {
        rangeStart = clip.startSeconds;
      }
      if (clip.endSeconds > rangeEnd) {
        rangeEnd = clip.endSeconds;
      }
    }
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
      return EMPTY_SELECTION;
    }

    return {
      clips: best,
      rangeStart,
      rangeEnd,
      selectedCount: totalSelected,
      selectedSeconds: totalSeconds,
      trackLabel: `V${bestIndex + 1}`,
      spansTracks: totalSelected > bestSelected,
      playheadRatio: await readPlayheadRatio(sequence, rangeStart, rangeEnd),
    };
  } catch {
    return EMPTY_SELECTION;
  }
}

/**
 * Where the playhead sits inside the range the strip draws.
 *
 * Measured against sequence time on both sides. The old version divided
 * the playhead's seconds by the summed clip durations, which only agreed
 * with the timeline on a track that starts at zero and has no gaps.
 */
async function readPlayheadRatio(
  sequence: Sequence,
  rangeStart: number,
  rangeEnd: number
): Promise<number | null> {
  try {
    const span = rangeEnd - rangeStart;
    if (!(span > 0)) {
      return null;
    }
    const position = await sequence.getPlayerPosition();
    const ratio = (position.seconds - rangeStart) / span;
    return ratio >= 0 && ratio <= 1 ? ratio : null;
  } catch {
    return null;
  }
}

// ── shared timeline helpers ────────────────────────────────────────

/**
 * A selected clip together with an identity that survives a rescan.
 *
 * Premiere exposes no unique id on a track item — `UniqueSerializeable`
 * casts project items, not clips — so identity is derived: the track,
 * the clip's name, and its source in and out points. That survives
 * dragging the clip along the timeline, and changes when it is trimmed,
 * which is exactly when a cached keyframe layout stops being valid.
 */
export interface ClipRef {
  clip: VideoClipTrackItem;
  key: string;
  trackIndex: number;
}

/**
 * Every selected video clip, in track order.
 *
 * Reading straight off the video tracks filters audio items and
 * anything else in the selection by construction.
 *
 * Two copies of the same clip on the same track — a copy/paste, which is
 * routine — derive the same identity, and a Map keyed on it silently
 * dropped one of them. So a repeat gets an occurrence suffix. The first
 * one keeps the bare key, which is what preserves the identity of every
 * ordinary clip across a drag along the timeline.
 */
export async function collectSelectedVideoClips(
  ppro: premierepro,
  sequence: Sequence
): Promise<ClipRef[]> {
  const refs: ClipRef[] = [];
  const seen = new Map<string, number>();
  const trackCount = await sequence.getVideoTrackCount();

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    const track = await sequence.getVideoTrack(trackIndex);
    if (!track) {
      continue;
    }
    const items = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    for (const item of items) {
      if (await item.getIsSelected()) {
        const base = await clipIdentity(item, trackIndex, refs.length);
        const repeat = seen.get(base) ?? 0;
        seen.set(base, repeat + 1);
        refs.push({
          clip: item,
          key: repeat === 0 ? base : `${base}#${repeat}`,
          trackIndex,
        });
      }
    }
  }
  return refs;
}

async function clipIdentity(
  clip: VideoClipTrackItem,
  trackIndex: number,
  ordinal: number
): Promise<string> {
  try {
    // getName is declared async, but part of the UXP surface answers a
    // raw value: calling .catch on a non-Promise throws, and the key
    // fell through to the positional variant with nothing actually wrong.
    const name = await Promise.resolve(clip.getName()).catch(() => "");
    const inPoint = await clip.getInPoint();
    const outPoint = await clip.getOutPoint();
    return `v${trackIndex}|${name}|${inPoint.ticks}|${outPoint.ticks}`;
  } catch {
    // Positional, and honest about it: a key that cannot be rebuilt is
    // better than one that silently matches the wrong clip.
    return `v${trackIndex}|#${ordinal}`;
  }
}

/**
 * Frame length in ticks, from the sequence settings.
 *
 * Keyframes placed off the frame grid are folded together by Premiere
 * or land where the editor cannot reproduce them by dragging, so every
 * generated keyframe time goes through `snapTicksToFrame` first.
 */
export async function readTicksPerFrame(
  sequence: Sequence
): Promise<bigint | null> {
  try {
    const settings = await sequence.getSettings();
    const rate = settings ? await settings.getVideoFrameRate() : null;
    const ticks = rate ? Number(rate.ticksPerFrame) : Number.NaN;
    return Number.isFinite(ticks) && ticks > 0 ? BigInt(Math.round(ticks)) : null;
  } catch {
    return null;
  }
}

/** Nearest frame boundary. Returns the input untouched if the grid is unknown. */
export function snapTicksToFrame(
  ticks: string,
  ticksPerFrame: bigint | null
): string {
  if (!ticksPerFrame || ticksPerFrame <= 0n) {
    return ticks;
  }
  try {
    const value = BigInt(ticks);
    if (value < 0n) {
      return ticks;
    }
    return (((value + ticksPerFrame / 2n) / ticksPerFrame) * ticksPerFrame).toString();
  } catch {
    return ticks;
  }
}

// ── host capability probe ──────────────────────────────────────────

/**
 * What the Tools reach for on the `premierepro` module.
 *
 * The manifest names a minimum Premiere version, and nothing checks that
 * the build actually has the APIs written against a newer typings
 * package. A missing one used to surface as an exception mid-apply, or
 * as a blank panel when it threw during mount. Probing at startup turns
 * that into a sentence naming the API.
 *
 * Only module-level surfaces can be probed — instance methods such as
 * `createSetInterpolationAtKeyframeAction` need a live sequence, and
 * those still report through the Tool's own error path.
 */
const REQUIRED_HOST_APIS: ReadonlyArray<[string, (ppro: premierepro) => unknown]> = [
  ["Project.getActiveProject", (ppro) => ppro.Project?.getActiveProject],
  ["TickTime.createWithTicks", (ppro) => ppro.TickTime?.createWithTicks],
  ["TickTime.createWithSeconds", (ppro) => ppro.TickTime?.createWithSeconds],
  ["PointF", (ppro) => ppro.PointF],
  ["Constants.TrackItemType", (ppro) => ppro.Constants?.TrackItemType],
  ["Constants.InterpolationMode", (ppro) => ppro.Constants?.InterpolationMode],
  ["Constants.MediaType", (ppro) => ppro.Constants?.MediaType],
  ["SequenceEditor", (ppro) => ppro.SequenceEditor],
  ["ClipProjectItem.cast", (ppro) => ppro.ClipProjectItem?.cast],
  [
    "TrackItemSelection.createEmptySelection",
    (ppro) => ppro.TrackItemSelection?.createEmptySelection,
  ],
  ["VideoFilterFactory.createComponent", (ppro) => ppro.VideoFilterFactory?.createComponent],
  ["VideoFilterFactory.getMatchNames", (ppro) => ppro.VideoFilterFactory?.getMatchNames],
];

export interface HostCheck {
  /** false only when the runtime resolved and something is genuinely absent. */
  ok: boolean;
  missing: string[];
}

export function checkHostCapabilities(): HostCheck {
  const ppro = getPremiere();
  if (!ppro) {
    // Outside the host there is nothing to be missing.
    return { ok: true, missing: [] };
  }

  const missing: string[] = [];
  for (const [name, read] of REQUIRED_HOST_APIS) {
    try {
      if (read(ppro) == null) {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}
