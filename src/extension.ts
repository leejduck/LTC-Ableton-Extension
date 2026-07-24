import {
  DataModelObject,
  MidiClip,
  MidiTrack,
  TakeLane,
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type AudioTrack,
  type Handle,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  BatchPlanningError,
  SELECTION_EPSILON_BEATS,
  createBatchPlan,
  parseTrackNameSettings,
  partitionSelection,
  resolveEffectiveFormat,
  type BatchPlan,
  type BatchSourceClip,
  type LtcDefaults,
  type OutputMode,
} from "./batchPlanner.js";
import {
  buildBatchPreflightDialogUrl,
  buildNoticeDialogUrl,
  type BatchModeOption,
} from "./dialogs.js";
import {
  FRAME_RATE_29_97,
  formatFrameRate,
  normalizeFrameRate,
  writeLtcWavFile,
} from "./ltcGenerator.js";

const API_VERSION = "1.0.0" as const;
const BIT_DEPTH = 16;
const SAMPLE_RATE = 48_000;
const CLIP_POSITION_TOLERANCE_BEATS = 1e-5;
const PROGRESS_DIALOG_SETTLE_MS = 500;

class GenerationCancelledError extends Error {
  constructor() {
    super("LTC generation was cancelled.");
    this.name = "GenerationCancelledError";
  }
}

class ExecutionCleanupError extends Error {
  readonly cancelled: boolean;
  readonly cleanupNotes: string[];

  constructor(
    original: unknown,
    cleanupNotes: string[],
    cancelled: boolean,
  ) {
    super(errorMessage(original), { cause: original });
    this.name = "ExecutionCleanupError";
    this.cancelled = cancelled;
    this.cleanupNotes = cleanupNotes;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GenerationCancelledError();
  }
}

async function waitForProgressDialogToSettle(): Promise<void> {
  // Live 12.4.5b8 can create an empty WebView when a modal dialog is opened
  // immediately after a progress dialog closes. The SDK waits for its close
  // callback, but Live still needs one short UI turn to release the window.
  await new Promise((resolve) => setTimeout(resolve, PROGRESS_DIALOG_SETTLE_MS));
}

function sameNumber(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function isArrangementSelection(value: unknown): value is ArrangementSelection {
  if (!value || typeof value !== "object") {
    return false;
  }
  const selection = value as Partial<ArrangementSelection>;
  return (
    typeof selection.time_selection_start === "number"
    && typeof selection.time_selection_end === "number"
    && Array.isArray(selection.selected_lanes)
  );
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);
  const storageDirectory = (
    context.environment.storageDirectory
    || context.environment.tempDirectory
    || os.tmpdir()
  );
  const settingsPath = path.join(storageDirectory, "ltc-settings.json");

  let defaultFps = 30;
  let defaultDropFrame = false;
  let generationInProgress = false;
  let settingsWriteQueue: Promise<void> = Promise.resolve();

  async function loadDefaults(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
        frameRate?: unknown;
        dropFrame?: unknown;
      };
      const normalized = typeof parsed.frameRate === "number"
        ? normalizeFrameRate(parsed.frameRate)
        : null;
      if (normalized !== null) {
        defaultFps = normalized;
      }
      if (typeof parsed.dropFrame === "boolean") {
        defaultDropFrame = (
          parsed.dropFrame
          && defaultFps === FRAME_RATE_29_97
        );
      }
    } catch {
      // Missing or malformed settings use the built-in defaults.
    }
  }

  const defaultsReady = loadDefaults();

  function snapshotDefaults(): LtcDefaults {
    return { fps: defaultFps, dropFrame: defaultDropFrame };
  }

  function saveDefaults(): Promise<void> {
    const payload = JSON.stringify(
      { frameRate: defaultFps, dropFrame: defaultDropFrame },
      null,
      2,
    );
    const tempSettingsPath = `${settingsPath}.tmp`;
    const operation = settingsWriteQueue.then(async () => {
      await fs.mkdir(storageDirectory, { recursive: true });
      await fs.writeFile(tempSettingsPath, payload, "utf8");
      await fs.rename(tempSettingsPath, settingsPath);
    });
    settingsWriteQueue = operation.catch(() => {});
    return operation;
  }

  async function showNotice(
    title: string,
    message: string,
    details: string[] = [],
  ): Promise<void> {
    try {
      await context.ui.showModalDialog(
        buildNoticeDialogUrl(title, message, details.slice(0, 25)),
        480,
        Math.min(520, 190 + (Math.min(details.length, 10) * 22)),
      );
    } catch (error) {
      console.warn(`Unable to show '${title}' dialog: ${errorMessage(error)}`);
    }
  }

  function ownerMidiTrack(
    object: DataModelObject<typeof API_VERSION>,
  ): MidiTrack<typeof API_VERSION> | null {
    let current: DataModelObject<typeof API_VERSION> | null = object;
    const visited = new Set<string>();
    while (current) {
      if (current instanceof MidiTrack) {
        return current;
      }
      const id = current.handle.id.toString();
      if (visited.has(id)) {
        break;
      }
      visited.add(id);
      current = current.parent;
    }
    return null;
  }

  function assertArrangementMidiClip(
    clip: MidiClip<typeof API_VERSION>,
  ): void {
    const parent = clip.parent;
    if (
      parent instanceof MidiTrack
      || (
        parent instanceof TakeLane
        && ownerMidiTrack(parent) instanceof MidiTrack
      )
    ) {
      return;
    }
    throw new Error(
      "Generate LTC supports Arrangement MIDI clips. Session-view clips do not have an Arrangement placement.",
    );
  }

  function sourceOrdersForTrack(
    owner: MidiTrack<typeof API_VERSION>,
  ): Map<string, number> {
    const clipsById = new Map<string, MidiClip<typeof API_VERSION>>();
    const addClip = (candidate: DataModelObject<typeof API_VERSION>): void => {
      if (candidate instanceof MidiClip) {
        clipsById.set(candidate.handle.id.toString(), candidate);
      }
    };
    owner.arrangementClips.forEach(addClip);
    owner.takeLanes.forEach((lane) => lane.clips.forEach(addClip));
    const ordered = [...clipsById.values()].sort((a, b) => (
      a.startTime - b.startTime
      || a.endTime - b.endTime
      || a.name.localeCompare(b.name)
      || a.handle.id.toString().localeCompare(b.handle.id.toString())
    ));
    return new Map(
      ordered.map((candidate, index) => [
        candidate.handle.id.toString(),
        index,
      ]),
    );
  }

  function snapshotSourceClip(
    clip: MidiClip<typeof API_VERSION>,
    options: {
      owner?: MidiTrack<typeof API_VERSION>;
      sourceOrder?: number;
      sourceTrackIndex?: number;
      tempo?: number;
    } = {},
  ): BatchSourceClip {
    const owner = options.owner ?? ownerMidiTrack(clip);
    if (!owner) {
      throw new Error(`Unable to find the MIDI track that owns '${clip.name}'.`);
    }
    const discoveredTrackIndex = context.application.song.tracks.indexOf(owner);
    const sourceTrackIndex = (
      options.sourceTrackIndex
      ?? (discoveredTrackIndex >= 0
        ? discoveredTrackIndex
        : Number.MAX_SAFE_INTEGER)
    );
    const durationBeats = clip.duration;
    const tempo = options.tempo ?? context.application.song.tempo;
    if (!Number.isFinite(tempo) || tempo <= 0) {
      throw new Error("Live reported an invalid song tempo.");
    }
    return {
      id: clip.handle.id.toString(),
      sourceTrackId: owner.handle.id.toString(),
      sourceTrackName: owner.name,
      sourceTrackIndex,
      sourceOrder: (
        options.sourceOrder
        ?? sourceOrdersForTrack(owner).get(clip.handle.id.toString())
        ?? Number.MAX_SAFE_INTEGER
      ),
      name: clip.name,
      startBeat: clip.startTime,
      endBeat: clip.endTime,
      durationBeats,
      // This only sizes the source file. Playback remains explicitly unwarped,
      // so LTC cadence never follows Live's BPM.
      durationSeconds: (durationBeats * 60) / tempo,
      color: clip.color,
    };
  }

  function collectSelectionCandidates(
    selection: ArrangementSelection,
  ): {
    sources: BatchSourceClip[];
    sourceObjects: Map<string, MidiClip<typeof API_VERSION>>;
  } {
    const clipsById = new Map<string, MidiClip<typeof API_VERSION>>();
    for (const handle of selection.selected_lanes) {
      const selectedObject = context.getObjectFromHandle(
        handle,
        DataModelObject,
      );
      if (selectedObject instanceof MidiTrack) {
        for (const clip of selectedObject.arrangementClips) {
          if (clip instanceof MidiClip) {
            clipsById.set(clip.handle.id.toString(), clip);
          }
        }
      } else if (
        selectedObject instanceof TakeLane
        && ownerMidiTrack(selectedObject)
      ) {
        for (const clip of selectedObject.clips) {
          if (clip instanceof MidiClip) {
            clipsById.set(clip.handle.id.toString(), clip);
          }
        }
      }
    }

    const sources: BatchSourceClip[] = [];
    const sourceObjects = new Map<string, MidiClip<typeof API_VERSION>>();
    const sourceOrderCache = new Map<string, Map<string, number>>();
    const songTracks = context.application.song.tracks;
    const sourceTrackIndices = new Map(
      songTracks.map((track, index) => [track.handle.id.toString(), index]),
    );
    const tempo = context.application.song.tempo;
    for (const clip of clipsById.values()) {
      if (
        clip.endTime <= selection.time_selection_start + SELECTION_EPSILON_BEATS
        || clip.startTime >= selection.time_selection_end - SELECTION_EPSILON_BEATS
      ) {
        continue;
      }
      const owner = ownerMidiTrack(clip);
      if (!owner) {
        continue;
      }
      const ownerId = owner.handle.id.toString();
      let sourceOrders = sourceOrderCache.get(ownerId);
      if (!sourceOrders) {
        sourceOrders = sourceOrdersForTrack(owner);
        sourceOrderCache.set(ownerId, sourceOrders);
      }
      const clipId = clip.handle.id.toString();
      sources.push(snapshotSourceClip(clip, {
        owner,
        sourceOrder: sourceOrders.get(clipId),
        sourceTrackIndex: sourceTrackIndices.get(ownerId),
        tempo,
      }));
      sourceObjects.set(clipId, clip);
    }
    return { sources, sourceObjects };
  }

  function validateSourceObjects(
    plan: BatchPlan,
    sourceObjects: Map<string, MidiClip<typeof API_VERSION>>,
  ): void {
    for (const planned of plan.clips) {
      const current = sourceObjects.get(planned.source.id);
      if (!current) {
        throw new Error(
          `The source clip '${planned.source.name}' is no longer available.`,
        );
      }
      const currentOwner = ownerMidiTrack(current);
      const currentTrackIndex = currentOwner
        ? context.application.song.tracks.indexOf(currentOwner)
        : -1;
      const currentTempo = context.application.song.tempo;
      const plannedTempo = (
        planned.source.durationBeats * 60
      ) / planned.source.durationSeconds;
      const unchanged = (
        current.name === planned.source.name
        && sameNumber(
          current.startTime,
          planned.source.startBeat,
          CLIP_POSITION_TOLERANCE_BEATS,
        )
        && sameNumber(
          current.endTime,
          planned.source.endBeat,
          CLIP_POSITION_TOLERANCE_BEATS,
        )
        && sameNumber(
          current.duration,
          planned.source.durationBeats,
          CLIP_POSITION_TOLERANCE_BEATS,
        )
        && current.color === planned.source.color
        && currentOwner?.handle.id.toString() === planned.source.sourceTrackId
        && currentOwner?.name === planned.source.sourceTrackName
        && currentTrackIndex === planned.source.sourceTrackIndex
        && sameNumber(currentTempo, plannedTempo, 1e-9)
      );
      if (!unchanged) {
        throw new Error(
          `The source clip '${planned.source.name}' changed after preflight. Run batch generation again.`,
        );
      }
    }
  }

  async function rollbackCreatedTracks(
    tracks: AudioTrack<typeof API_VERSION>[],
  ): Promise<string[]> {
    const failures: string[] = [];
    for (const track of [...tracks].reverse()) {
      let trackName = "created LTC track";
      try {
        trackName = track.name;
      } catch {
        // The object may already have been invalidated by Live.
      }
      try {
        await context.application.song.deleteTrack(track);
      } catch (error) {
        failures.push(`Could not delete '${trackName}': ${errorMessage(error)}`);
      }
    }
    return failures;
  }

  async function executePlan(
    plan: BatchPlan,
    sourceObjects: Map<string, MidiClip<typeof API_VERSION>>,
    update: (text: string, progress?: number) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const tempRoot = context.environment.tempDirectory || os.tmpdir();
    await fs.mkdir(tempRoot, { recursive: true });
    const workDirectory = await fs.mkdtemp(
      path.join(tempRoot, "duck-ltc-batch-"),
    );
    const renderedPaths = new Map<string, string>();
    const importedPaths = new Map<string, string>();
    const createdTracks: AudioTrack<typeof API_VERSION>[] = [];

    try {
      const clipCount = plan.clips.length;

      // Finish every source WAV before changing the Live Set.
      for (let index = 0; index < clipCount; index += 1) {
        throwIfCancelled(signal);
        const clip = plan.clips[index]!;
        await update(
          `Rendering ${index + 1}/${clipCount}: ${clip.fileName}`,
          (index / clipCount) * 50,
        );
        throwIfCancelled(signal);
        const tempPath = path.join(workDirectory, `${clip.fileName}.wav`);
        try {
          await writeLtcWavFile(
            tempPath,
            clip.startFrame,
            clip.totalFrames,
            clip.fps,
            clip.dropFrame,
            SAMPLE_RATE,
            0,
            0.8,
            signal,
          );
        } catch (error) {
          if (signal.aborted) {
            throw new GenerationCancelledError();
          }
          throw error;
        }
        throwIfCancelled(signal);
        const stats = await fs.stat(tempPath);
        if (!stats.isFile() || stats.size <= 44) {
          throw new Error(`Generated WAV '${clip.fileName}.wav' is empty.`);
        }
        renderedPaths.set(clip.source.id, tempPath);
      }

      // Revalidate immediately before any Live mutation or project import.
      validateSourceObjects(plan, sourceObjects);
      throwIfCancelled(signal);

      // Create rollbackable destinations before any irreversible project import.
      const tracksByDestination = new Map<
        string,
        AudioTrack<typeof API_VERSION>
      >();
      for (let index = 0; index < plan.destinations.length; index += 1) {
        throwIfCancelled(signal);
        const destination = plan.destinations[index]!;
        await update(
          `Creating LTC track ${index + 1}/${plan.destinations.length}`,
          50 + ((index / plan.destinations.length) * 10),
        );
        throwIfCancelled(signal);
        const track = await context.application.song.createAudioTrack();
        createdTracks.push(track);
        track.name = destination.trackName;
        tracksByDestination.set(destination.key, track);
      }

      for (let index = 0; index < clipCount; index += 1) {
        throwIfCancelled(signal);
        const planned = plan.clips[index]!;
        await update(
          `Importing ${index + 1}/${clipCount}: ${planned.fileName}.wav`,
          60 + ((index / clipCount) * 40),
        );
        throwIfCancelled(signal);
        const tempPath = renderedPaths.get(planned.source.id);
        if (!tempPath) {
          throw new Error(`Missing rendered WAV for '${planned.source.name}'.`);
        }
        const importedPath = await context.resources.importIntoProject(tempPath);
        importedPaths.set(planned.source.id, importedPath);
        throwIfCancelled(signal);
        await update(
          `Placing ${index + 1}/${clipCount}: ${planned.fileName}`,
          60 + (((index + 0.5) / clipCount) * 40),
        );
        throwIfCancelled(signal);
        const destination = tracksByDestination.get(planned.destinationKey);
        if (!destination) {
          throw new Error(`Missing output destination for '${planned.source.name}'.`);
        }

        const audioClip = await destination.createAudioClip({
          filePath: importedPath,
          startTime: planned.source.startBeat,
          duration: planned.source.durationBeats,
          isWarped: false,
        });
        audioClip.name = planned.fileName;
        audioClip.color = planned.source.color;
        audioClip.looping = false;
        if (audioClip.warping) {
          audioClip.warping = false;
        }
        if (audioClip.warping) {
          throw new Error(`Live did not disable Warp for '${planned.fileName}'.`);
        }
        if (audioClip.looping) {
          throw new Error(`Live did not disable looping for '${planned.fileName}'.`);
        }
        if (audioClip.color !== planned.source.color) {
          throw new Error(`Live did not preserve the color for '${planned.fileName}'.`);
        }
        if (audioClip.name !== planned.fileName) {
          throw new Error(`Live did not preserve the name for '${planned.fileName}'.`);
        }
        if (
          !sameNumber(
            audioClip.startTime,
            planned.source.startBeat,
            CLIP_POSITION_TOLERANCE_BEATS,
          )
          || !sameNumber(
            audioClip.duration,
            planned.source.durationBeats,
            CLIP_POSITION_TOLERANCE_BEATS,
          )
        ) {
          throw new Error(
            `Live truncated or moved '${planned.fileName}'. Batch placement was aborted.`,
          );
        }
        throwIfCancelled(signal);
      }

      await update(
        `Created ${clipCount} separate LTC clip${clipCount === 1 ? "" : "s"}.`,
        100,
      );
      console.log(
        `duckTC LTC Generator created ${clipCount} separate WAV-backed clip${clipCount === 1 ? "" : "s"} on ${plan.destinations.length} new track${plan.destinations.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      const rollbackFailures = await rollbackCreatedTracks(createdTracks);
      const cleanupNotes: string[] = [];
      if (rollbackFailures.length > 0) {
        console.error("LTC rollback was incomplete:", rollbackFailures);
        cleanupNotes.push(
          `Rollback could not remove ${rollbackFailures.length} created Live track${rollbackFailures.length === 1 ? "" : "s"}.`,
        );
      }
      if (importedPaths.size > 0) {
        const orphanWarning = (
          `${importedPaths.size} imported LTC project asset${importedPaths.size === 1 ? "" : "s"} may remain unused. The current Extensions API cannot remove imported project assets during rollback.`
        );
        console.warn(orphanWarning);
        cleanupNotes.push(orphanWarning);
      }
      if (cleanupNotes.length > 0) {
        throw new ExecutionCleanupError(
          error,
          cleanupNotes,
          error instanceof GenerationCancelledError,
        );
      }
      throw error;
    } finally {
      try {
        await fs.rm(workDirectory, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `Unable to remove temporary LTC files: ${errorMessage(error)}`,
        );
      }
    }
  }

  async function runPlan(
    plan: BatchPlan,
    sourceObjects: Map<string, MidiClip<typeof API_VERSION>>,
  ): Promise<void> {
    if (generationInProgress) {
      await showNotice(
        "LTC generation is already running",
        "Wait for the current LTC job to finish or cancel it before starting another.",
      );
      return;
    }

    generationInProgress = true;
    try {
      validateSourceObjects(plan, sourceObjects);
      await context.ui.withinProgressDialog(
        `Creating ${plan.clips.length} LTC clip${plan.clips.length === 1 ? "" : "s"}…`,
        { progress: 0 },
        async (update, signal) => executePlan(
          plan,
          sourceObjects,
          update,
          signal,
        ),
      );
      // The final 100% progress update and the newly placed clips are the
      // success confirmation. Live 12.4.5b8 can open an empty WebView if a
      // success modal is chained directly after its progress dialog.
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        console.log("LTC generation cancelled; created Live tracks were rolled back.");
        return;
      }
      if (error instanceof ExecutionCleanupError && error.cancelled) {
        console.warn(
          `LTC generation cancelled with cleanup warnings: ${error.cleanupNotes.join(" ")}`,
        );
        await waitForProgressDialogToSettle();
        await showNotice(
          "LTC generation cancelled",
          "Created Live tracks were rolled back where possible, but cleanup needs your attention.",
          error.cleanupNotes,
        );
        return;
      }
      const details = error instanceof BatchPlanningError
        ? error.issues
          : error instanceof ExecutionCleanupError
          ? error.cleanupNotes
          : [];
      console.error(`Error generating LTC: ${errorMessage(error)}`);
      await waitForProgressDialogToSettle();
      await showNotice(
        "LTC generation failed",
        errorMessage(error),
        details,
      );
    } finally {
      generationInProgress = false;
    }
  }

  async function generateSingle(handle: unknown): Promise<void> {
    await defaultsReady;
    const clip = context.getObjectFromHandle(handle as Handle, MidiClip);
    assertArrangementMidiClip(clip);
    const source = snapshotSourceClip(clip);
    const plan = createBatchPlan([source], snapshotDefaults(), "shared");
    await runPlan(plan, new Map([[source.id, clip]]));
  }

  function planAttempt(
    sources: BatchSourceClip[],
    mode: OutputMode,
  ): BatchModeOption {
    try {
      return {
        mode,
        enabled: true,
        plan: createBatchPlan(sources, snapshotDefaults(), mode),
      };
    } catch (error) {
      return {
        mode,
        enabled: false,
        issues: error instanceof BatchPlanningError
          ? error.issues
          : [errorMessage(error)],
      };
    }
  }

  async function generateBatch(value: unknown): Promise<void> {
    await defaultsReady;
    if (!isArrangementSelection(value)) {
      throw new Error("Live did not provide a valid Arrangement selection.");
    }

    const collected = collectSelectionCandidates(value);
    const partition = partitionSelection(collected.sources, {
      startBeat: value.time_selection_start,
      endBeat: value.time_selection_end,
    });
    if (partition.included.length === 0) {
      await showNotice(
        "No MIDI clips to generate",
        "Select one or more complete MIDI clip regions on MIDI lanes, then run batch generation again.",
        partition.partial.length > 0
          ? partition.partial.map(
            (clip) => `${clip.sourceTrackName} — ${clip.name} crosses the selection boundary.`,
          )
          : [],
      );
      return;
    }

    const options = [
      planAttempt(partition.included, "shared"),
      planAttempt(partition.included, "per-source-track"),
    ];
    const enabledOptions = options.filter((option) => option.enabled);
    if (enabledOptions.length === 0) {
      const issues = [...new Set(
        options.flatMap((option) => option.issues ?? []),
      )];
      await showNotice(
        "Batch preflight failed",
        "No files or Live tracks were created.",
        issues,
      );
      return;
    }

    let resultText: string;
    try {
      resultText = await context.ui.showModalDialog(
        buildBatchPreflightDialogUrl(options, partition.partial),
        680,
        570,
      );
    } catch {
      console.log("Batch LTC preflight was closed without generating.");
      return;
    }

    let result: { confirmed?: boolean; mode?: OutputMode };
    try {
      result = JSON.parse(resultText) as {
        confirmed?: boolean;
        mode?: OutputMode;
      };
    } catch {
      throw new Error("The batch preflight dialog returned an invalid response.");
    }
    if (!result.confirmed) {
      return;
    }

    const selectedOption = options.find(
      (option) => option.mode === result.mode && option.enabled,
    );
    if (!selectedOption?.plan) {
      throw new Error("The selected batch output mode is not available.");
    }
    await runPlan(selectedOption.plan, collected.sourceObjects);
  }

  async function setDefaultFps(rate: number): Promise<void> {
    await defaultsReady;
    const normalized = normalizeFrameRate(rate);
    if (normalized === null) {
      throw new Error(`Unsupported LTC frame rate: ${rate}`);
    }
    defaultFps = normalized;
    if (defaultDropFrame && defaultFps !== FRAME_RATE_29_97) {
      defaultDropFrame = false;
    }
    await saveDefaults();
    console.log(
      `Saved LTC default: ${formatFrameRate(defaultFps)} ${defaultDropFrame ? "DF" : "NDF"}.`,
    );
  }

  async function setDefaultDropFrame(value: boolean): Promise<void> {
    await defaultsReady;
    if (value) {
      defaultFps = FRAME_RATE_29_97;
    }
    defaultDropFrame = value;
    await saveDefaults();
    console.log(
      `Saved LTC default: ${formatFrameRate(defaultFps)} ${defaultDropFrame ? "DF" : "NDF"}.`,
    );
  }

  async function showDefaults(handle?: unknown): Promise<void> {
    await defaultsReady;
    let format = snapshotDefaults();
    let source = "saved defaults";
    if (handle) {
      let track: MidiTrack<typeof API_VERSION> | null = null;
      try {
        track = context.getObjectFromHandle(handle as Handle, MidiTrack);
      } catch {
        // Show saved defaults when the supplied object is not a MIDI track.
      }
      if (track && parseTrackNameSettings(track.name)) {
        format = resolveEffectiveFormat(
          {
            hours: 0,
            minutes: 0,
            seconds: 0,
            frames: 0,
          },
          track.name,
          snapshotDefaults(),
        );
        source = `track '${track.name}' over saved defaults`;
      }
    }
    const summary = `${formatFrameRate(format.fps)} ${format.dropFrame ? "DF" : "NDF"}, ${BIT_DEPTH}-bit, ${SAMPLE_RATE / 1000} kHz`;
    console.log(`Current LTC settings (${source}): ${summary}`);
    await showNotice("Current LTC settings", summary, [`Source: ${source}`]);
  }

  async function renameSelectedTrack(handle: unknown): Promise<void> {
    await defaultsReady;
    const track = context.getObjectFromHandle(handle as Handle, MidiTrack);
    const format = snapshotDefaults();
    track.name = `LTC | ${formatFrameRate(format.fps)} ${format.dropFrame ? "DF" : "NDF"} | ${BIT_DEPTH}b | ${SAMPLE_RATE / 1000}k`;
    console.log(`Renamed selected track to '${track.name}'.`);
  }

  function reportCommandError(error: unknown): void {
    console.error(`duckTC LTC Generator: ${errorMessage(error)}`);
    void showNotice("duckTC LTC Generator", errorMessage(error));
  }

  context.commands.registerCommand("generate-ltc", (...args: unknown[]) => {
    void generateSingle(args[0]).catch(reportCommandError);
  });
  context.commands.registerCommand(
    "duckTC.generate-selected-ltc",
    (...args: unknown[]) => {
      void generateBatch(args[0]).catch(reportCommandError);
    },
  );

  context.ui.registerContextMenuAction(
    "MidiClip",
    "Generate LTC",
    "generate-ltc",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    "Generate Selected LTC…",
    "duckTC.generate-selected-ltc",
  );

  const registerSettingsCommand = (
    commandId: string,
    action: () => Promise<void>,
  ): void => {
    context.commands.registerCommand(commandId, () => {
      void action().catch(reportCommandError);
    });
  };
  registerSettingsCommand("ltc-set-fps-23.976", () => setDefaultFps(23.976));
  registerSettingsCommand("ltc-set-fps-24", () => setDefaultFps(24));
  registerSettingsCommand("ltc-set-fps-25", () => setDefaultFps(25));
  registerSettingsCommand("ltc-set-fps-29.97", () => setDefaultFps(29.97));
  registerSettingsCommand("ltc-set-fps-30", () => setDefaultFps(30));
  registerSettingsCommand("ltc-set-dropframe", () => setDefaultDropFrame(true));
  registerSettingsCommand(
    "ltc-set-nondropframe",
    () => setDefaultDropFrame(false),
  );

  context.commands.registerCommand("ltc-show-defaults", (...args: unknown[]) => {
    void showDefaults(args[0]).catch(reportCommandError);
  });
  context.commands.registerCommand("ltc-rename-track", (...args: unknown[]) => {
    void renameSelectedTrack(args[0]).catch(reportCommandError);
  });

  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Set FPS to 23.976",
    "ltc-set-fps-23.976",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Set FPS to 24",
    "ltc-set-fps-24",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Set FPS to 25",
    "ltc-set-fps-25",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Set FPS to 29.97",
    "ltc-set-fps-29.97",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Set FPS to 30",
    "ltc-set-fps-30",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Enable Drop Frame",
    "ltc-set-dropframe",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Disable Drop Frame",
    "ltc-set-nondropframe",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Show Defaults",
    "ltc-show-defaults",
  );
  context.ui.registerContextMenuAction(
    "MidiTrack",
    "LTC: Rename Track with Defaults",
    "ltc-rename-track",
  );
}
