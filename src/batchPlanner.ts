import {
  FRAME_RATE_29_97,
  buildFileName,
  durationToCoveringFrames,
  formatFrameRate,
  normalizeFrameRate,
  parseTimecodeString,
  timecodeToFrameNumber,
  type ParsedTimecode,
} from "./ltcGenerator.js";

export const SELECTION_EPSILON_BEATS = 1e-7;

export type OutputMode = "shared" | "per-source-track";

export interface LtcDefaults {
  fps: number;
  dropFrame: boolean;
}

export interface TrackNameSettings {
  fps?: number;
  unsupportedFps?: number;
  dropFrame?: boolean;
  bitDepth?: number;
  sampleRate?: number;
}

export interface BatchSourceClip {
  id: string;
  sourceTrackId: string;
  sourceTrackName: string;
  sourceTrackIndex: number;
  sourceOrder: number;
  name: string;
  startBeat: number;
  endBeat: number;
  durationBeats: number;
  durationSeconds: number;
  color: number;
}

export interface SelectionBounds {
  startBeat: number;
  endBeat: number;
}

export interface SelectionPartition {
  included: BatchSourceClip[];
  partial: BatchSourceClip[];
  outside: BatchSourceClip[];
}

export interface EffectiveLtcFormat {
  fps: number;
  dropFrame: boolean;
}

export interface PlannedClip {
  source: BatchSourceClip;
  destinationKey: string;
  fps: number;
  dropFrame: boolean;
  startFrame: number;
  totalFrames: number;
  baseName: string;
  fileName: string;
}

export interface DestinationPlan {
  key: string;
  sourceTrackId?: string;
  sourceTrackName?: string;
  trackName: string;
  clipIds: string[];
}

export interface BatchPlan {
  mode: OutputMode;
  clips: PlannedClip[];
  destinations: DestinationPlan[];
}

export class BatchPlanningError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.name = "BatchPlanningError";
    this.issues = issues;
  }
}

function compareSourceClips(a: BatchSourceClip, b: BatchSourceClip): number {
  return (
    a.sourceTrackIndex - b.sourceTrackIndex
    || a.startBeat - b.startBeat
    || a.endBeat - b.endBeat
    || a.sourceOrder - b.sourceOrder
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  );
}

function formatDescriptor(format: EffectiveLtcFormat): string {
  return `${formatFrameRate(format.fps)} ${format.dropFrame ? "DF" : "NDF"}`;
}

function trackLabelFor(
  clips: PlannedClip[],
  sourceTrackName?: string,
): string {
  const formats = new Map<string, EffectiveLtcFormat>();
  for (const clip of clips) {
    const format = { fps: clip.fps, dropFrame: clip.dropFrame };
    formats.set(formatDescriptor(format), format);
  }
  const formatLabel = formats.size === 1
    ? formats.keys().next().value as string
    : "MIXED FORMATS";
  const sourceLabel = sourceTrackName?.trim();
  return sourceLabel
    ? `LTC | ${sourceLabel} | ${formatLabel} | 16b | 48k`
    : `LTC | ${formatLabel} | 16b | 48k`;
}

export function parseTrackNameSettings(name: string): TrackNameSettings | null {
  if (!name || !name.trim().toUpperCase().startsWith("LTC")) {
    return null;
  }

  const upper = name.toUpperCase();
  const fpsMatch = upper.match(
    /(?:^|[\s|_-])((?:23\.976|23\.98|24|25|29\.97|30))(?:\s*FPS)?(?!\s*[-_]?\s*(?:B|BIT|BITS)\b)(?=$|[\s|_-]|(?:NDF|DF)\b)/,
  );
  const parsedFps = fpsMatch ? Number(fpsMatch[1]) : undefined;
  const fps = parsedFps === undefined
    ? undefined
    : normalizeFrameRate(parsedFps) ?? undefined;
  const rateLikeMatch = fps === undefined
    ? upper.match(
      /(?:^|[\s|_-])(\d+(?:\.\d+)?)(?:\s*FPS\b|(?=\s*(?:NDF|DF)\b))/,
    )
    : null;
  const rateLikeValue = rateLikeMatch ? Number(rateLikeMatch[1]) : undefined;
  const unsupportedFps = (
    rateLikeValue !== undefined
    && normalizeFrameRate(rateLikeValue) === null
  )
    ? rateLikeValue
    : undefined;

  let dropFrame: boolean | undefined;
  if (
    /(?:^|[^A-Z])NDF\b/.test(upper)
    || /\bNON[-_\s]?DROP(?:[-_\s]?FRAME)?\b/.test(upper)
  ) {
    dropFrame = false;
  } else if (
    /(?:^|[^A-Z])DF\b/.test(upper)
    || /\bDROP[-_\s]?FRAME\b/.test(upper)
  ) {
    dropFrame = true;
  }

  const bitMatch = upper.match(/(16|24|32)[-_\s]*(?:B|BIT|BITS)\b/);
  const bitDepth = bitMatch ? Number(bitMatch[1]) : undefined;
  const sampleRateMatch = upper.match(/(44\.1|48|88\.2|96)\s*K(?:HZ)?/);
  const sampleRate = sampleRateMatch
    ? Math.round(Number(sampleRateMatch[1]) * 1000)
    : undefined;

  if (
    fps === undefined
    && unsupportedFps === undefined
    && dropFrame === undefined
    && bitDepth === undefined
    && sampleRate === undefined
  ) {
    return null;
  }
  return { fps, unsupportedFps, dropFrame, bitDepth, sampleRate };
}

export function resolveEffectiveFormat(
  parsed: ParsedTimecode,
  sourceTrackName: string,
  defaults: LtcDefaults,
): EffectiveLtcFormat {
  const normalizedDefault = normalizeFrameRate(defaults.fps);
  if (normalizedDefault === null) {
    throw new RangeError(`Unsupported saved LTC frame rate: ${defaults.fps}`);
  }

  let fps = normalizedDefault;
  let dropFrame = defaults.dropFrame;
  const trackSettings = parseTrackNameSettings(sourceTrackName);
  if (trackSettings?.unsupportedFps !== undefined) {
    throw new RangeError(
      `Unsupported LTC frame rate in track name: ${trackSettings.unsupportedFps}`,
    );
  }

  if (trackSettings?.fps !== undefined) {
    fps = trackSettings.fps;
    if (fps !== FRAME_RATE_29_97 && trackSettings.dropFrame === undefined) {
      dropFrame = false;
    }
  }
  if (trackSettings?.dropFrame !== undefined) {
    dropFrame = trackSettings.dropFrame;
    if (dropFrame && trackSettings.fps === undefined) {
      fps = FRAME_RATE_29_97;
    }
  }

  if (parsed.fps !== undefined) {
    const normalizedParsed = normalizeFrameRate(parsed.fps);
    if (normalizedParsed === null) {
      throw new RangeError(`Unsupported clip LTC frame rate: ${parsed.fps}`);
    }
    fps = normalizedParsed;
    if (fps !== FRAME_RATE_29_97 && parsed.dropFrame === undefined) {
      dropFrame = false;
    }
  }
  if (parsed.dropFrame !== undefined) {
    dropFrame = parsed.dropFrame;
    if (dropFrame && parsed.fps === undefined) {
      fps = FRAME_RATE_29_97;
    }
  }

  if (dropFrame && fps !== FRAME_RATE_29_97) {
    throw new RangeError("Drop-frame timecode requires 29.97 fps.");
  }
  return { fps, dropFrame };
}

export function partitionSelection(
  candidates: BatchSourceClip[],
  selection: SelectionBounds,
  epsilon = SELECTION_EPSILON_BEATS,
): SelectionPartition {
  if (
    !Number.isFinite(selection.startBeat)
    || !Number.isFinite(selection.endBeat)
    || selection.endBeat <= selection.startBeat
  ) {
    throw new BatchPlanningError(["The Arrangement time selection is empty or invalid."]);
  }

  const deduplicated = new Map<string, BatchSourceClip>();
  for (const clip of [...candidates].sort(compareSourceClips)) {
    if (!deduplicated.has(clip.id)) {
      deduplicated.set(clip.id, clip);
    }
  }

  const included: BatchSourceClip[] = [];
  const partial: BatchSourceClip[] = [];
  const outside: BatchSourceClip[] = [];
  for (const clip of deduplicated.values()) {
    const intersects = (
      clip.endBeat > selection.startBeat + epsilon
      && clip.startBeat < selection.endBeat - epsilon
    );
    const fullyContained = (
      clip.startBeat >= selection.startBeat - epsilon
      && clip.endBeat <= selection.endBeat + epsilon
    );
    if (fullyContained) {
      included.push(clip);
    } else if (intersects) {
      partial.push(clip);
    } else {
      outside.push(clip);
    }
  }

  return {
    included: included.sort(compareSourceClips),
    partial: partial.sort(compareSourceClips),
    outside: outside.sort(compareSourceClips),
  };
}

function destinationKeyFor(clip: BatchSourceClip, mode: OutputMode): string {
  return mode === "shared" ? "shared" : `source:${clip.sourceTrackId}`;
}

function collisionSuffix(clip: BatchSourceClip): string {
  const trackNumber = String(clip.sourceTrackIndex + 1).padStart(2, "0");
  const clipNumber = String(clip.sourceOrder + 1).padStart(3, "0");
  return `__T${trackNumber}-C${clipNumber}`;
}

export function createBatchPlan(
  sources: BatchSourceClip[],
  defaults: LtcDefaults,
  mode: OutputMode,
): BatchPlan {
  if (sources.length === 0) {
    throw new BatchPlanningError([
      "No fully contained MIDI clips were found in the selected MIDI lane(s).",
    ]);
  }

  const issues: string[] = [];
  const planned: PlannedClip[] = [];
  for (const source of [...sources].sort(compareSourceClips)) {
    if (
      !Number.isFinite(source.startBeat)
      || !Number.isFinite(source.endBeat)
      || !Number.isFinite(source.durationBeats)
      || !Number.isFinite(source.durationSeconds)
      || source.durationBeats <= 0
      || source.durationSeconds <= 0
      || source.endBeat <= source.startBeat
    ) {
      issues.push(`'${source.name}' on '${source.sourceTrackName}' has an invalid or empty region.`);
      continue;
    }

    const parsed = parseTimecodeString(source.name);
    if (!parsed) {
      issues.push(
        `Unable to parse '${source.name}' on '${source.sourceTrackName}'. Use a starting timecode such as 01:00:00:00 30 NDF.`,
      );
      continue;
    }

    try {
      const format = resolveEffectiveFormat(parsed, source.sourceTrackName, defaults);
      const startFrame = timecodeToFrameNumber(
        parsed.hours,
        parsed.minutes,
        parsed.seconds,
        parsed.frames,
        format.fps,
        format.dropFrame,
      );
      const totalFrames = durationToCoveringFrames(
        source.durationSeconds,
        format.fps,
      );
      const oneFrameSeconds = 1 / format.fps;
      if (source.durationSeconds + 1e-9 < oneFrameSeconds) {
        throw new RangeError(
          `The clip is shorter than one complete LTC frame at ${formatDescriptor(format)}.`,
        );
      }
      const baseName = buildFileName(
        parsed.hours,
        parsed.minutes,
        parsed.seconds,
        parsed.frames,
        format.fps,
        format.dropFrame,
      );
      planned.push({
        source,
        destinationKey: destinationKeyFor(source, mode),
        fps: format.fps,
        dropFrame: format.dropFrame,
        startFrame,
        totalFrames,
        baseName,
        fileName: baseName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`'${source.name}' on '${source.sourceTrackName}': ${message}`);
    }
  }

  if (issues.length > 0) {
    throw new BatchPlanningError(issues);
  }

  const byBaseName = new Map<string, PlannedClip[]>();
  for (const clip of planned) {
    const group = byBaseName.get(clip.baseName) ?? [];
    group.push(clip);
    byBaseName.set(clip.baseName, group);
  }
  for (const duplicates of byBaseName.values()) {
    if (duplicates.length > 1) {
      for (const clip of duplicates) {
        clip.fileName = `${clip.baseName}${collisionSuffix(clip.source)}`;
      }
    }
  }

  const byDestination = new Map<string, PlannedClip[]>();
  for (const clip of planned) {
    const group = byDestination.get(clip.destinationKey) ?? [];
    group.push(clip);
    byDestination.set(clip.destinationKey, group);
  }

  for (const clips of byDestination.values()) {
    clips.sort((a, b) => (
      a.source.startBeat - b.source.startBeat
      || a.source.endBeat - b.source.endBeat
      || compareSourceClips(a.source, b.source)
    ));
    for (let index = 1; index < clips.length; index += 1) {
      const previous = clips[index - 1]!;
      const current = clips[index]!;
      if (
        current.source.startBeat
        < previous.source.endBeat - SELECTION_EPSILON_BEATS
      ) {
        issues.push(
          `Output overlap: '${previous.source.name}' and '${current.source.name}' would occupy the same LTC track.`,
        );
      }
    }
  }
  if (issues.length > 0) {
    throw new BatchPlanningError(issues);
  }

  const destinations: DestinationPlan[] = [];
  for (const [key, clips] of byDestination.entries()) {
    const first = clips[0]!;
    const sourceTrackName = mode === "per-source-track"
      ? first.source.sourceTrackName
      : undefined;
    destinations.push({
      key,
      sourceTrackId: mode === "per-source-track"
        ? first.source.sourceTrackId
        : undefined,
      sourceTrackName,
      trackName: trackLabelFor(clips, sourceTrackName),
      clipIds: clips.map((clip) => clip.source.id),
    });
  }
  destinations.sort((a, b) => {
    const aFirst = planned.find((clip) => clip.destinationKey === a.key)!.source;
    const bFirst = planned.find((clip) => clip.destinationKey === b.key)!.source;
    return compareSourceClips(aFirst, bFirst);
  });

  return {
    mode,
    clips: planned,
    destinations,
  };
}
