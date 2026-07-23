import {
  initialize,
  MidiClip,
  MidiTrack,
  type ActivationContext,
  type Handle,
} from "@ableton-extensions/sdk";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  FRAME_RATE_29_97,
  formatFrameRate,
  normalizeFrameRate,
  parseTimecodeString,
  timecodeToFrameNumber,
  durationToCoveringFrames,
  buildFileName,
  writeLtcWavFile,
} from "./ltcGenerator.js";

const BIT_DEPTH = 16;
const SAMPLE_RATE = 48000;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // -------------------------------------------------------------------------
  // Global LTC defaults and configuration handling
  // -------------------------------------------------------------------------
  // These variables hold the default frame rate and drop‑frame mode used when
  // a clip name omits the FPS specification.  They are initialised to
  // industry‑standard defaults (30 fps non‑drop) and may be overridden by
  // settings stored on disk or changed via context menu commands.
  let defaultFps = 30;
  let defaultDropFrame = false;
  // Determine a directory for persistent storage.  The environment provides
  // storageDirectory for extension‑specific data.  Fallback to the temp
  // directory if unavailable.
  const storageDir = context.environment.storageDirectory || context.environment.tempDirectory || os.tmpdir();
  const configFileName = "ltc-settings.json";
  /**
   * Load defaults from the settings file if it exists.  Any missing fields
   * leave the in‑memory defaults unchanged.
   */
  async function loadDefaults(): Promise<void> {
    try {
      const configPath = path.join(storageDir, configFileName);
      const data = await fs.readFile(configPath, { encoding: "utf8" });
      const parsed = JSON.parse(data);
      const storedRate = typeof parsed.frameRate === "number"
        ? normalizeFrameRate(parsed.frameRate)
        : null;
      if (storedRate !== null) {
        defaultFps = storedRate;
      }
      if (typeof parsed.dropFrame === "boolean") {
        defaultDropFrame = parsed.dropFrame && defaultFps === FRAME_RATE_29_97;
      }
    } catch (err) {
      // Missing file or parse error: use built‑in defaults.
    }
  }
  /**
   * Persist the current defaults to the settings file.  The directory is
   * created on demand.
   */
  async function saveDefaults(): Promise<void> {
    try {
      await fs.mkdir(storageDir, { recursive: true });
      const configPath = path.join(storageDir, configFileName);
      const payload = { frameRate: defaultFps, dropFrame: defaultDropFrame };
      await fs.writeFile(configPath, JSON.stringify(payload, null, 2), { encoding: "utf8" });
    } catch (err) {
      // err is typed as unknown; coerce to any for message extraction
      const e: any = err;
      console.error(`Error saving LTC defaults: ${e && e.message ? e.message : String(err)}`);
    }
  }
  // Load defaults once when the extension activates.  Do not await here so
  // activation continues; the defaults will be applied before the first use.
  loadDefaults().catch(() => {});
  /**
   * Asynchronous handler that generates the LTC WAV and places it in the Live Set.
   * Accepts the raw handle passed by Live and resolves it to a MidiClip.
   */
  async function generateLtcFromHandle(handle: unknown): Promise<void> {
    let workDir: string | undefined;
    try {
      // Ensure defaults have been loaded before proceeding.  Without awaiting
      // loadDefaults() here the defaults might still be pending when the user
      // invokes the command immediately after activation.
      await loadDefaults();
      // Resolve the handle into a MidiClip.  The context provides a helper
      // to resolve handles; this throws if the handle is invalid or not a MidiClip.
      const clip = context.getObjectFromHandle(handle as Handle, MidiClip);
      // Guard: verify the object is indeed a MidiClip.
      if (!(clip instanceof MidiClip)) {
        console.log("Selected item is not a MIDI clip.");
        return;
      }
      // Before parsing/generating, treat the MIDI track name as the highest-priority
      // source for global LTC defaults.  This lets manual track renames such as
      // "LTC | 25 NDF | 16b | 48k" override the stored JSON defaults.
      await applyTrackNameOverridesForClip(clip);
      // Parse the clip name into a timecode and optional per-clip frame rate specification.
      const parsed = parseTimecodeString(clip.name);
      if (!parsed) {
        console.log(
          `Unable to parse timecode from clip name '${clip.name}'. Use formats like '1h30m', '01:00' or '05:30:00;00' followed by an optional frame rate.`
        );
        return;
      }
      console.log(`Parsed timecode for '${clip.name}':`, parsed);
      // Retrieve tempo and duration from the clip.  Duration is expressed in beats;
      // convert to seconds using the current song tempo.
      const tempo = context.application.song.tempo;
      const startBeat = clip.startTime;
      const durationBeats = clip.duration;
      const durationSeconds = (durationBeats * 60) / tempo;
      // Apply global defaults when FPS or dropFrame is undefined in the clip name.
      const hours = parsed.hours;
      const minutes = parsed.minutes;
      const seconds = parsed.seconds;
      const frames = parsed.frames;
      const fpsToUse = normalizeFrameRate(
        parsed.fps !== undefined ? parsed.fps : defaultFps,
      );
      if (fpsToUse === null) {
        throw new RangeError("The selected LTC frame rate is not supported.");
      }
      const dropToUse = parsed.dropFrame !== undefined ? parsed.dropFrame : defaultDropFrame;
      console.log(`Using frame rate ${formatFrameRate(fpsToUse)} ${dropToUse ? "DF" : "NDF"}`);
      const startFrame = timecodeToFrameNumber(hours, minutes, seconds, frames, fpsToUse, dropToUse);
      const totalFrames = durationToCoveringFrames(durationSeconds, fpsToUse);
      if (totalFrames < 1) {
        throw new RangeError("The selected MIDI clip is too short to generate LTC.");
      }
      console.log(`Generating ${totalFrames} frames of LTC starting at frame ${startFrame}`);
      const tempRoot = context.environment.tempDirectory || os.tmpdir();
      await fs.mkdir(tempRoot, { recursive: true });
      workDir = await fs.mkdtemp(path.join(tempRoot, "duck-ltc-"));
      const baseName = buildFileName(
        hours,
        minutes,
        seconds,
        frames,
        fpsToUse,
        dropToUse,
      );
      const tempPath = path.join(workDir, `${baseName}.wav`);
      await writeLtcWavFile(
        tempPath,
        startFrame,
        totalFrames,
        fpsToUse,
        dropToUse,
        SAMPLE_RATE,
      );
      // Import the file into the project; Live manages the copy from this point.
      const importedPath = await context.resources.importIntoProject(tempPath);
      // Create a new audio track for the LTC signal and name it based on current
      // defaults.  This provides immediate visual feedback in the arrangement.
      const audioTrack = await context.application.song.createAudioTrack();
      audioTrack.name = buildTrackName();
      // Place the audio clip on the arrangement matching the MIDI clip's start and length.
      const audioClip = await audioTrack.createAudioClip({
        filePath: importedPath,
        startTime: startBeat,
        duration: durationBeats,
        isWarped: false,
      });
      audioClip.name = baseName;
      console.log(
        `LTC audio generated and placed on track '${audioTrack.name}'.`
      );
      // Also rename the first existing LTC track, if any, to reflect current defaults.
      updateLtcTrackName();
    } catch (err) {
      const e: any = err;
      console.error(`Error generating LTC: ${e && e.message ? e.message : String(err)}`);
    } finally {
      if (workDir) {
        try {
          await fs.rm(workDir, { recursive: true, force: true });
        } catch (err) {
          const e: any = err;
          console.warn(`Unable to remove temporary LTC files: ${e && e.message ? e.message : String(err)}`);
        }
      }
    }
  }
  // Register the command with a synchronous callback. The callback launches the
  // asynchronous handler and logs any errors. The callback signature must
  // match '(...args: unknown[]) => void', so do not mark it 'async'.
  context.commands.registerCommand("generate-ltc", (...args: unknown[]): void => {
    const handle = args[0];
    generateLtcFromHandle(handle).catch((err) => {
      console.error(`Error generating LTC: ${err.message || err}`);
    });
  });
  // Add the action to the MIDI clip context menu so users can invoke the command.
  context.ui.registerContextMenuAction("MidiClip", "Generate LTC", "generate-ltc");

  // -------------------------------------------------------------------------
  // Commands and context‑menu entries for managing LTC defaults
  // -------------------------------------------------------------------------
  // Helper to set a new frame rate and persist it
  function setDefaultFps(rate: number): void {
    const normalizedRate = normalizeFrameRate(rate);
    if (normalizedRate === null) {
      console.error(`Unsupported LTC frame rate: ${rate}`);
      return;
    }
    defaultFps = normalizedRate;
    if (defaultDropFrame && defaultFps !== FRAME_RATE_29_97) {
      defaultDropFrame = false;
      console.log("Drop-frame was disabled because it is available only at 29.97 fps.");
    }
    void saveDefaults();
    console.log(`LTC default frame rate set to ${formatFrameRate(defaultFps)}`);
    // Update the name on any existing LTC track to reflect the new setting
    updateLtcTrackName();
  }
  // Helper to set drop‑frame mode and persist it
  function setDefaultDropFrame(value: boolean): void {
    if (value && defaultFps !== FRAME_RATE_29_97) {
      defaultFps = FRAME_RATE_29_97;
      console.log("LTC default frame rate set to 29.97 for drop-frame timecode.");
    }
    defaultDropFrame = value;
    void saveDefaults();
    console.log(`LTC default drop frame set to ${value}`);
    // Rename the LTC track with the updated drop‑frame setting
    updateLtcTrackName();
  }
  // Show current defaults in the console.  If a MIDI track handle is supplied,
  // read LTC settings from that track name first so manually renamed tracks can
  // override the stored defaults.
  async function showDefaults(handle?: unknown): Promise<void> {
    await loadDefaults();
    if (handle) {
      try {
        const track = context.getObjectFromHandle(handle as Handle, MidiTrack);
        await applySettingsFromTrackName(track.name, `selected track '${track.name}'`);
      } catch (err) {
        const ltcTrack = findFirstLtcMidiTrack();
        if (ltcTrack) {
          await applySettingsFromTrackName(ltcTrack.name, `first LTC MIDI track '${ltcTrack.name}'`);
        }
      }
    } else {
      const ltcTrack = findFirstLtcMidiTrack();
      if (ltcTrack) {
        await applySettingsFromTrackName(ltcTrack.name, `first LTC MIDI track '${ltcTrack.name}'`);
      }
    }
    console.log(
      `Current LTC defaults: ${defaultFps} fps ${defaultDropFrame ? "DF" : "NDF"}, ${BIT_DEPTH}-bit, ${SAMPLE_RATE / 1000} kHz`
    );
  }

  /**
   * Create a human‑readable track name from the current defaults.  The
   * resulting name includes the frame rate, drop‑frame state, bit depth and
   * sample rate.  Example: "LTC | 29.97 DF | 16b | 48k".
   */
  function buildTrackName(): string {
    const fpsString = formatFrameRate(defaultFps);
    const dfString = defaultDropFrame ? "DF" : "NDF";
    const bitString = `${BIT_DEPTH}b`;
    const srString = `${Math.round(SAMPLE_RATE / 1000)}k`;
    return `LTC | ${fpsString} ${dfString} | ${bitString} | ${srString}`;
  }

  /**
   * Parse global LTC settings from a track name.  Supported examples:
   *   LTC | 30 NDF | 16b | 48k
   *   LTC | 29.97 DF | 16b | 48k
   *   LTC 25 NDF
   *   LTC_30DF
   *
   * Track-name settings are intentionally limited to global LTC format values.
   * The time offset should still come from the MIDI clip name.  Bit depth and
   * sample rate are parsed only for user feedback; the generator remains fixed
   * at 16-bit / 48 kHz until those parameters are explicitly made configurable.
   */
  function parseSettingsFromTrackName(name: string): { fps?: number; dropFrame?: boolean; bitDepth?: number; sampleRate?: number } | null {
    if (!name || !name.trim().toUpperCase().startsWith("LTC")) {
      return null;
    }
    const upper = name.toUpperCase();
    const fpsMatch = upper.match(/(?:^|[^0-9])((?:23\.976|23\.98|24|25|29\.97|30))(?:\s*FPS)?(?:[^0-9]|$)/);
    const parsedFps = fpsMatch ? parseFloat(fpsMatch[1]) : undefined;
    const fps = parsedFps === undefined
      ? undefined
      : normalizeFrameRate(parsedFps) ?? undefined;
    let dropFrame: boolean | undefined;
    if (upper.includes("NDF") || upper.includes("NON-DROP") || upper.includes("NON DROP")) {
      dropFrame = false;
    } else if (upper.includes("DF") || upper.includes("DROP-FRAME") || upper.includes("DROP FRAME")) {
      dropFrame = true;
    }
    const bitMatch = upper.match(/(16|24|32)\s*(?:B|BIT|BITS)/);
    const bitDepth = bitMatch ? parseInt(bitMatch[1], 10) : undefined;
    const srMatch = upper.match(/(44\.1|48|88\.2|96)\s*K(?:HZ)?/);
    const sampleRate = srMatch ? Math.round(parseFloat(srMatch[1]) * 1000) : undefined;
    if (fps === undefined && dropFrame === undefined && bitDepth === undefined && sampleRate === undefined) {
      return null;
    }
    return { fps, dropFrame, bitDepth, sampleRate };
  }

  /**
   * Apply any LTC format settings found in a track name and persist them to the
   * defaults file.  This is the mechanism that allows manual track renames such
   * as "LTC | 25 NDF | 16b | 48k" to override the stored defaults.
   */
  async function applySettingsFromTrackName(trackName: string, sourceLabel: string): Promise<boolean> {
    const parsed = parseSettingsFromTrackName(trackName);
    if (!parsed) {
      return false;
    }
    const proposedFps = parsed.fps === undefined
      ? (parsed.dropFrame ? FRAME_RATE_29_97 : defaultFps)
      : parsed.fps;
    const proposedDropFrame = parsed.dropFrame === undefined
      ? (parsed.fps !== undefined && parsed.fps !== FRAME_RATE_29_97 ? false : defaultDropFrame)
      : parsed.dropFrame;
    if (proposedDropFrame && proposedFps !== FRAME_RATE_29_97) {
      console.error(
        `Ignored invalid LTC settings from ${sourceLabel}: drop-frame requires 29.97 fps.`,
      );
      return true;
    }
    let changed = false;
    if (proposedFps !== defaultFps) {
      defaultFps = proposedFps;
      changed = true;
    }
    if (proposedDropFrame !== defaultDropFrame) {
      defaultDropFrame = proposedDropFrame;
      changed = true;
    }
    if (parsed.bitDepth !== undefined && parsed.bitDepth !== BIT_DEPTH) {
      console.log(`Track name requested ${parsed.bitDepth}-bit LTC, but this version generates ${BIT_DEPTH}-bit WAV files.`);
    }
    if (parsed.sampleRate !== undefined && parsed.sampleRate !== SAMPLE_RATE) {
      console.log(`Track name requested ${parsed.sampleRate / 1000} kHz LTC, but this version generates ${SAMPLE_RATE / 1000} kHz WAV files.`);
    }
    if (changed) {
      await saveDefaults();
      console.log(`LTC defaults updated from ${sourceLabel}: ${defaultFps} fps ${defaultDropFrame ? "DF" : "NDF"}, ${BIT_DEPTH}-bit, ${SAMPLE_RATE / 1000} kHz`);
    } else {
      console.log(`LTC settings read from ${sourceLabel}: ${defaultFps} fps ${defaultDropFrame ? "DF" : "NDF"}, ${BIT_DEPTH}-bit, ${SAMPLE_RATE / 1000} kHz`);
    }
    return true;
  }

  /**
   * Try to find the MIDI track that owns the clip used for generation.  The SDK
   * does not expose a direct clip.parentTrack property, so this scans the song's
   * MIDI tracks and compares arrangement clips by object identity first, then by
   * stable clip properties as a fallback.
   */
  function findMidiTrackForClip(clip: MidiClip<"1.0.0">): MidiTrack<"1.0.0"> | null {
    try {
      const tracks = context.application.song.tracks;
      for (const track of tracks) {
        if (!(track instanceof MidiTrack)) {
          continue;
        }
        for (const arrangementClip of track.arrangementClips) {
          if (arrangementClip === clip) {
            return track;
          }
          if (arrangementClip instanceof MidiClip) {
            const sameName = arrangementClip.name === clip.name;
            const sameStart = arrangementClip.startTime === clip.startTime;
            const sameEnd = arrangementClip.endTime === clip.endTime;
            const sameDuration = arrangementClip.duration === clip.duration;
            if (sameName && sameStart && sameEnd && sameDuration) {
              return track;
            }
          }
        }
      }
    } catch (err) {
      // Ignore lookup failures and fall back to first LTC MIDI track.
    }
    return null;
  }

  /**
   * Locate the first MIDI track with an LTC prefix.  This supports the workflow
   * where the user manually renames the dedicated LTC generator MIDI track and
   * expects those settings to become the new defaults.
   */
  function findFirstLtcMidiTrack(): MidiTrack<"1.0.0"> | null {
    try {
      const tracks = context.application.song.tracks;
      for (const track of tracks) {
        if (track instanceof MidiTrack && typeof track.name === "string" && track.name.toUpperCase().startsWith("LTC")) {
          return track;
        }
      }
    } catch (err) {
      // ignore lookup failures
    }
    return null;
  }

  /**
   * Highest-priority settings source: manual MIDI track name.  Used before LTC
   * generation and before showing defaults so the track header can override the
   * stored JSON defaults.
   */
  async function applyTrackNameOverridesForClip(clip: MidiClip<"1.0.0">): Promise<void> {
    const ownerTrack = findMidiTrackForClip(clip);
    if (ownerTrack && await applySettingsFromTrackName(ownerTrack.name, `track '${ownerTrack.name}'`)) {
      return;
    }
    const ltcTrack = findFirstLtcMidiTrack();
    if (ltcTrack) {
      await applySettingsFromTrackName(ltcTrack.name, `first LTC MIDI track '${ltcTrack.name}'`);
    }
  }

  /**
   * Iterate over the tracks in the current song and rename the first track
   * whose name begins with "LTC".  This allows the extension to provide
   * visual feedback to the user about the current timecode settings.  If no
   * track is named "LTC", no action is taken.  Renaming is done
   * synchronously; Live updates the UI accordingly.
   */
  function updateLtcTrackName(): void {
    try {
      const tracks = context.application.song.tracks;
      for (const track of tracks) {
        if (typeof track.name === "string" && track.name.toUpperCase().startsWith("LTC")) {
          track.name = buildTrackName();
          break;
        }
      }
    } catch (err) {
      // ignore errors when renaming
    }
  }
  // Register commands
  context.commands.registerCommand("ltc-set-fps-23.976", () => setDefaultFps(23.976));
  context.commands.registerCommand("ltc-set-fps-24", () => setDefaultFps(24));
  context.commands.registerCommand("ltc-set-fps-25", () => setDefaultFps(25));
  context.commands.registerCommand("ltc-set-fps-29.97", () => setDefaultFps(29.97));
  context.commands.registerCommand("ltc-set-fps-30", () => setDefaultFps(30));
  context.commands.registerCommand("ltc-set-dropframe", () => setDefaultDropFrame(true));
  context.commands.registerCommand("ltc-set-nondropframe", () => setDefaultDropFrame(false));
  context.commands.registerCommand("ltc-show-defaults", (...args: unknown[]) => {
    showDefaults(args[0]).catch((err) => {
      const e: any = err;
      console.error(`Error showing LTC defaults: ${e && e.message ? e.message : String(err)}`);
    });
  });

  // Command to rename the selected MIDI track to reflect current defaults. When invoked
  // via the context‑menu on a MidiTrack, the first argument is the handle of that track.
  // This command resolves the handle into a MidiTrack and sets its name using
  // buildTrackName(). If no handle or resolution fails, it falls back to updating the
  // first existing LTC track.
  context.commands.registerCommand("ltc-rename-track", (...args: unknown[]) => {
    const maybeHandle = args && args.length > 0 ? args[0] : undefined;
    if (maybeHandle) {
      try {
        // Attempt to resolve the handle into a MidiTrack. If successful, rename it.
        const track = context.getObjectFromHandle(maybeHandle as Handle, MidiTrack);
        if (track && typeof track.name === "string") {
          track.name = buildTrackName();
          console.log(`Renamed selected track to '${track.name}'.`);
          return;
        }
      } catch (err) {
        // Fallback to global update below.
      }
    }
    // Fallback: update the first LTC track in the song.
    updateLtcTrackName();
    console.log(`LTC track renamed to reflect current defaults.`);
  });
  // Register context‑menu actions in the arrangement background so users can adjust
  // defaults without selecting a clip.  These entries appear when right‑clicking
  // an empty area of the Arrangement view.
  // Register context‑menu actions on MIDI tracks so users can adjust defaults without a clip.
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Set FPS to 23.976", "ltc-set-fps-23.976");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Set FPS to 24", "ltc-set-fps-24");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Set FPS to 25", "ltc-set-fps-25");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Set FPS to 29.97", "ltc-set-fps-29.97");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Set FPS to 30", "ltc-set-fps-30");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Enable Drop Frame", "ltc-set-dropframe");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Disable Drop Frame", "ltc-set-nondropframe");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Show Defaults", "ltc-show-defaults");
  context.ui.registerContextMenuAction("MidiTrack", "LTC: Rename Track with Defaults", "ltc-rename-track");
}
