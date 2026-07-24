import * as os from "os";
import * as fs from "fs/promises";
import * as path from "path";
import { Buffer } from "buffer";

/**
 * This module encapsulates all logic related to parsing timecode strings,
 * converting between timecode and frame numbers, generating a biphase‑mark
 * encoded Linear Timecode (LTC) audio signal and encoding it as a WAV file.
 *
 * The functions here were previously defined inline in the extension
 * implementation.  Separating them into their own module makes it easy to
 * iterate on and improve the timecode generation independently of the
 * Ableton Live integration.  No Live‑specific APIs are referenced here.
 */

export const FRAME_RATE_23_976 = 24000 / 1001;
export const FRAME_RATE_29_97 = 30000 / 1001;
export const SUPPORTED_FRAME_RATES = [
  FRAME_RATE_23_976,
  24,
  25,
  FRAME_RATE_29_97,
  30,
] as const;

export type ParsedTimecode = {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  fps?: number;
  dropFrame?: boolean;
};

/**
 * Map common user-facing rate spellings to the exact rate used for synthesis.
 * 23.98 and 29.97 are treated as the standard 24000/1001 and 30000/1001 rates.
 */
export function normalizeFrameRate(fps: number): number | null {
  if (!Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  for (const supportedRate of SUPPORTED_FRAME_RATES) {
    if (Math.abs(fps - supportedRate) < 0.01) {
      return supportedRate;
    }
  }
  return null;
}

export function formatFrameRate(fps: number): string {
  const normalized = normalizeFrameRate(fps);
  if (normalized === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  if (normalized === FRAME_RATE_23_976) return "23.976";
  if (normalized === FRAME_RATE_29_97) return "29.97";
  return normalized.toString();
}

export function validateTimecode(
  hours: number,
  minutes: number,
  seconds: number,
  frames: number,
  fps: number,
  dropFrame: boolean,
): string | null {
  const values = [hours, minutes, seconds, frames];
  if (values.some((value) => !Number.isInteger(value))) {
    return "Timecode fields must be whole numbers.";
  }
  if (hours < 0 || hours > 23) return "Hours must be between 0 and 23.";
  if (minutes < 0 || minutes > 59) return "Minutes must be between 0 and 59.";
  if (seconds < 0 || seconds > 59) return "Seconds must be between 0 and 59.";

  const normalized = normalizeFrameRate(fps);
  if (normalized === null) {
    return `Unsupported frame rate '${fps}'. Use 23.976, 24, 25, 29.97, or 30.`;
  }
  const nominalRate = Math.round(normalized);
  if (frames < 0 || frames >= nominalRate) {
    return `Frames must be between 0 and ${nominalRate - 1} at ${formatFrameRate(normalized)} fps.`;
  }
  if (dropFrame && normalized !== FRAME_RATE_29_97) {
    return "Drop-frame timecode is supported only at 29.97 fps.";
  }
  if (
    dropFrame
    && minutes % 10 !== 0
    && seconds === 0
    && frames < 2
  ) {
    return "Frame numbers 00 and 01 do not exist at the start of this drop-frame minute.";
  }
  return null;
}

/**
 * Parse a timecode and optional frame-rate specification from a clip name.
 *
 * Supported examples:
 *  - 01:02:03:04 24 NDF
 *  - 01:02:03;04 (semicolon selects 29.97 DF)
 *  - 1h30m15s12f 29.97 NDF
 *  - 45m
 */
export function parseTimecodeString(rawName: string): ParsedTimecode | null {
  const trimmed = rawName?.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/);
  const timePart = tokens.shift();
  if (!timePart) return null;

  let fps: number | undefined;
  let dropFrame: boolean | undefined;
  const semicolonDropFrame = timePart.includes(";");

  if (tokens.length > 0) {
    let spec = tokens.join("").toUpperCase().replaceAll(/[\s_-]+/gu, "");
    const specifiesNdf = /(?:NDF|NONDROP(?:FRAME)?)/u.test(spec);
    const withoutNdf = spec
      .replaceAll(/NONDROP(?:FRAME)?/gu, "")
      .replaceAll(/NDF/gu, "");
    const specifiesDf = /(?:DF|DROPFRAME)/u.test(withoutNdf);

    if (specifiesNdf && specifiesDf) return null;

    if (specifiesNdf) {
      dropFrame = false;
    } else if (specifiesDf) {
      dropFrame = true;
    }

    spec = spec
      .replace(/NONDROP(?:FRAME)?/gu, "")
      .replace(/NDF/gu, "")
      .replace(/DROPFRAME/gu, "")
      .replace(/DF/gu, "")
      .replace(/FPS/gu, "");

    if (spec.length > 0) {
      if (!/^\d+(?:\.\d+)?$/u.test(spec)) return null;
      const normalizedRate = normalizeFrameRate(Number(spec));
      if (normalizedRate === null) return null;
      fps = normalizedRate;
    }
  }

  if (semicolonDropFrame) {
    if (dropFrame === false) return null;
    if (fps !== undefined && fps !== FRAME_RATE_29_97) return null;
    if (!/^\d{1,2}:\d{1,2}:\d{1,2};\d{1,2}$/u.test(timePart)) {
      return null;
    }
    dropFrame = true;
    fps = FRAME_RATE_29_97;
  } else if (dropFrame === true && fps === undefined) {
    fps = FRAME_RATE_29_97;
  } else if (
    fps !== undefined
    && fps !== FRAME_RATE_29_97
    && dropFrame === undefined
  ) {
    dropFrame = false;
  }

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let frames = 0;

  if (timePart.includes(":") || timePart.includes(";")) {
    const parts = timePart.split(/[:;]/gu);
    if (
      parts.length < 2
      || parts.length > 4
      || parts.some((part) => !/^\d{1,2}$/u.test(part))
    ) {
      return null;
    }
    [hours, minutes, seconds, frames] = [
      Number(parts[0]),
      Number(parts[1]),
      parts.length >= 3 ? Number(parts[2]) : 0,
      parts.length === 4 ? Number(parts[3]) : 0,
    ];
  } else {
    const match = timePart.match(
      /^(?:(\d{1,2})h)?(?:(\d{1,2})m)?(?:(\d{1,2})s)?(?:(\d{1,2})f)?$/iu,
    );
    if (!match || !match.slice(1).some(Boolean)) return null;
    hours = match[1] ? Number(match[1]) : 0;
    minutes = match[2] ? Number(match[2]) : 0;
    seconds = match[3] ? Number(match[3]) : 0;
    frames = match[4] ? Number(match[4]) : 0;
  }

  const validationRate = fps ?? 30;
  const validationError = validateTimecode(
    hours,
    minutes,
    seconds,
    frames,
    validationRate,
    dropFrame ?? false,
  );
  if (validationError) return null;

  return { hours, minutes, seconds, frames, fps, dropFrame };
}

/**
 * Convert a timecode (hours, minutes, seconds, frames) into an absolute frame number.
 * Handles drop‑frame numbering for 29.97 fps by skipping frames 0 and 1 at the start of
 * each minute except every tenth minute.
 */
export function timecodeToFrameNumber(
  h: number,
  m: number,
  s: number,
  f: number,
  fps: number,
  dropFrame: boolean,
): number {
  const validationError = validateTimecode(h, m, s, f, fps, dropFrame);
  if (validationError) throw new RangeError(validationError);

  const normalizedRate = normalizeFrameRate(fps)!;
  const frameRateInt = Math.round(normalizedRate);
  let absoluteFrames = ((h * 3600 + m * 60 + s) * frameRateInt) + f;
  if (dropFrame) {
    const totalMinutes = h * 60 + m;
    const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
    absoluteFrames -= dropped;
  }
  return absoluteFrames;
}

/**
 * Convert a duration in seconds into the closest whole number of real LTC frames.
 */
export function secondsToFrames(durationSec: number, fps: number): number {
  const normalizedRate = normalizeFrameRate(fps);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new RangeError("Duration must be a non-negative number.");
  }
  if (normalizedRate === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  return Math.round(durationSec * normalizedRate);
}

/**
 * Return enough whole LTC frame periods to cover a requested duration.
 * Unlike {@link secondsToFrames}, this never rounds the source audio shorter
 * than the Live clip region.
 */
export function durationToCoveringFrames(durationSec: number, fps: number): number {
  const normalizedRate = normalizeFrameRate(fps);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new RangeError("Duration must be a non-negative number.");
  }
  if (normalizedRate === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  return Math.ceil(durationSec * normalizedRate);
}

/**
 * Reverse an absolute frame number into timecode components. For drop‑frame timecodes,
 * reinsert the skipped frames according to SMPTE drop‑frame rules: frame numbers 0 and 1
 * are omitted at the start of each minute except every tenth minute.
 */
export function frameNumberToTimecode(
  frameNumber: number,
  fps: number,
  dropFrame: boolean,
): { hours: number; minutes: number; seconds: number; frames: number } {
  if (!Number.isInteger(frameNumber) || frameNumber < 0) {
    throw new RangeError("Frame number must be a non-negative whole number.");
  }
  const normalizedRate = normalizeFrameRate(fps);
  if (normalizedRate === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  if (dropFrame && normalizedRate !== FRAME_RATE_29_97) {
    throw new RangeError("Drop-frame timecode is supported only at 29.97 fps.");
  }

  const nominalRate = Math.round(normalizedRate);
  let labelledFrameNumber: number;
  if (dropFrame) {
    const framesPer10Minutes = 17982;
    const framesPer24Hours = 2589408;
    const wrapped = frameNumber % framesPer24Hours;
    const complete10MinuteBlocks = Math.floor(wrapped / framesPer10Minutes);
    const remainder = wrapped % framesPer10Minutes;
    const droppedLabels = (18 * complete10MinuteBlocks)
      + (remainder > 1 ? 2 * Math.floor((remainder - 2) / 1798) : 0);
    labelledFrameNumber = wrapped + droppedLabels;
  } else {
    const framesPer24Hours = nominalRate * 60 * 60 * 24;
    labelledFrameNumber = frameNumber % framesPer24Hours;
  }

  const hours = Math.floor(labelledFrameNumber / (nominalRate * 3600)) % 24;
  const minutes = Math.floor(labelledFrameNumber / (nominalRate * 60)) % 60;
  const seconds = Math.floor(labelledFrameNumber / nominalRate) % 60;
  const frame = labelledFrameNumber % nominalRate;
  return { hours, minutes, seconds, frames: frame };
}

/**
 * Build an 80‑bit LTC frame from the given timecode. Parity bits and the sync
 * pattern (0x3FFD) are added as specified by SMPTE 12M.
 *
 * User bits and binary-group flags are cleared. The correct phase-correction
 * parity bit is calculated at bit 27, or bit 59 for 25 fps.
 */
export function buildLTCFrame(
  hours: number,
  minutes: number,
  seconds: number,
  frames: number,
  fps: number,
  dropFrame: boolean,
): number[] {
  const validationError = validateTimecode(
    hours,
    minutes,
    seconds,
    frames,
    fps,
    dropFrame,
  );
  if (validationError) throw new RangeError(validationError);

  const normalizedRate = normalizeFrameRate(fps)!;
  const bits: number[] = new Array(80).fill(0);
  const setBit = (index: number, value: number) => {
    bits[index] = value & 1;
  };
  const bcd = (value: number, bitsCount: number) => {
    const arr: number[] = [];
    for (let i = 0; i < bitsCount; i++) {
      arr.push((value >> i) & 1);
    }
    return arr;
  };
  // Frame units (bits 0–3)
  bcd(frames % 10, 4).forEach((bit, i) => setBit(i, bit));
  // Frame tens (bits 8–9)
  bcd(Math.floor(frames / 10), 2).forEach((bit, i) => setBit(8 + i, bit));
  // Drop‑frame flag (bit 10)
  setBit(10, dropFrame ? 1 : 0);
  // Colour‑frame flag (bit 11) always cleared for compatibility
  setBit(11, 0);
  // Seconds units (bits 16–19)
  bcd(seconds % 10, 4).forEach((bit, i) => setBit(16 + i, bit));
  // Seconds tens (bits 24–26)
  bcd(Math.floor(seconds / 10), 3).forEach((bit, i) => setBit(24 + i, bit));
  // Minutes units (bits 32–35)
  bcd(minutes % 10, 4).forEach((bit, i) => setBit(32 + i, bit));
  // Minutes tens (bits 40–42)
  bcd(Math.floor(minutes / 10), 3).forEach((bit, i) => setBit(40 + i, bit));
  // Hours units (bits 48–51)
  bcd(hours % 10, 4).forEach((bit, i) => setBit(48 + i, bit));
  // Hours tens (bits 56–57)
  bcd(Math.floor(hours / 10), 2).forEach((bit, i) => setBit(56 + i, bit));
  // SMPTE sync word in transmission order: 0011 1111 1111 1101.
  const syncPattern = 0x3ffd;
  for (let i = 0; i < 16; i++) {
    const bitVal = (syncPattern >> i) & 1;
    setBit(64 + (15 - i), bitVal);
  }

  const parityBit = normalizedRate === 25 ? 59 : 27;
  setBit(parityBit, 0);
  const zeroCount = bits.reduce((count, bit) => count + (bit === 0 ? 1 : 0), 0);
  if (zeroCount % 2 !== 0) {
    setBit(parityBit, 1);
  }
  return bits;
}

type SynthesisState = {
  phase: number;
  sampleRemainder: number;
  filterPrevious?: number;
};

function validateSynthesisArguments(
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  sampleRate: number,
  cutoffHz: number | undefined,
  amplitude: number,
): number {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
    throw new RangeError("Start frame must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new RangeError("Frame count must be a non-negative safe integer.");
  }
  const normalizedRate = normalizeFrameRate(fps);
  if (normalizedRate === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  if (dropFrame && normalizedRate !== FRAME_RATE_29_97) {
    throw new RangeError("Drop-frame timecode is supported only at 29.97 fps.");
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("Sample rate must be a positive whole number.");
  }
  if (sampleRate / (normalizedRate * 80) < 2) {
    throw new RangeError("Sample rate is too low to represent LTC biphase transitions.");
  }
  if (cutoffHz !== undefined && (!Number.isFinite(cutoffHz) || cutoffHz < 0 || cutoffHz >= sampleRate / 2)) {
    throw new RangeError("Filter cutoff must be between 0 Hz and the Nyquist frequency.");
  }
  if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 1) {
    throw new RangeError("Amplitude must be greater than 0 and no greater than 1.");
  }
  return normalizedRate;
}

function synthesizeLtcChunk(
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  sampleRate: number,
  cutoffHz: number | undefined,
  amplitude: number,
  state: SynthesisState,
): Float32Array {
  const normalizedRate = validateSynthesisArguments(
    startFrame,
    frameCount,
    fps,
    dropFrame,
    sampleRate,
    cutoffHz,
    amplitude,
  );
  if (frameCount === 0) return new Float32Array(0);

  const samplesPerBit = sampleRate / (normalizedRate * 80);
  const capacity = Math.ceil((frameCount * sampleRate) / normalizedRate) + 2;
  const rawSamples = new Float32Array(capacity);
  let sampleIndex = 0;

  const writeRun = (idealLength: number): void => {
    const runLength = Math.floor(idealLength + state.sampleRemainder);
    state.sampleRemainder += idealLength - runLength;
    state.phase = -state.phase;
    rawSamples.fill(state.phase * amplitude, sampleIndex, sampleIndex + runLength);
    sampleIndex += runLength;
  };

  for (let i = 0; i < frameCount; i++) {
    const absoluteFrame = startFrame + i;
    const timecode = frameNumberToTimecode(absoluteFrame, normalizedRate, dropFrame);
    const bits = buildLTCFrame(
      timecode.hours,
      timecode.minutes,
      timecode.seconds,
      timecode.frames,
      normalizedRate,
      dropFrame,
    );

    for (const bit of bits) {
      if (bit === 0) {
        // Every bit cell starts with a transition.
        writeRun(samplesPerBit);
      } else {
        // A one bit has the boundary transition plus another at the midpoint.
        writeRun(samplesPerBit / 2);
        writeRun(samplesPerBit / 2);
      }
    }
  }

  const samples = rawSamples.subarray(0, sampleIndex);
  if (!cutoffHz) return samples;

  const filtered = new Float32Array(samples.length);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  let previous = state.filterPrevious ?? samples[0];
  for (let i = 0; i < samples.length; i++) {
    previous += alpha * (samples[i] - previous);
    filtered[i] = previous;
  }
  state.filterPrevious = previous;
  return filtered;
}

function synthesizeTerminalGuard(
  fps: number,
  sampleRate: number,
  cutoffHz: number | undefined,
  amplitude: number,
  state: SynthesisState,
): Float32Array {
  const normalizedRate = normalizeFrameRate(fps);
  if (normalizedRate === null) {
    throw new RangeError(`Unsupported LTC frame rate: ${fps}`);
  }
  const guardLength = Math.max(
    1,
    Math.round(sampleRate / (normalizedRate * 80 * 2)),
  );
  state.phase = -state.phase;
  const guard = new Float32Array(guardLength);
  guard.fill(state.phase * amplitude);
  if (!cutoffHz) return guard;

  const filtered = new Float32Array(guard.length);
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  let previous = state.filterPrevious ?? guard[0];
  for (let i = 0; i < guard.length; i++) {
    previous += alpha * (guard[i] - previous);
    filtered[i] = previous;
  }
  state.filterPrevious = previous;
  return filtered;
}

/**
 * Generate an LTC signal for the given frame range.  The result is a
 * Float32Array with values between –1 and 1 at the specified sample rate.
 * Fractional sample periods are accumulated so 23.976 and 29.97 run at their
 * exact physical rates instead of the rounded 24/30 fps rates.
 */
export function generateLTCSignal(
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  sampleRate: number,
  /**
   * Optional low‑pass filter cutoff frequency in hertz.  Professional LTC
   * encoders may apply a low-pass filter to reduce high-frequency energy.
   * When undefined or zero, no filtering is applied.
   */
  cutoffHz?: number,
  /**
   * Amplitude scaling factor.  Many hardware LTC generators output a reduced
   * amplitude (around 0.7–0.8 FS) to leave headroom and ensure decoders
   * reliably lock on to the biphase signal.  Defaults to 0.8.
   */
  amplitude: number = 0.8,
): Float32Array {
  return synthesizeLtcChunk(
    startFrame,
    frameCount,
    fps,
    dropFrame,
    sampleRate,
    cutoffHz,
    amplitude,
    { phase: 1, sampleRemainder: 0.5 },
  );
}

function buildWavHeader(sampleRate: number, sampleCount: number): Buffer {
  const dataSize = sampleCount * 2;
  if (dataSize > 0xffffffff - 36) {
    throw new RangeError("The generated LTC exceeds the 4 GB RIFF/WAV size limit.");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

function encodePcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return pcm;
}

/**
 * Encode a Float32Array of samples into a 16‑bit PCM WAV Buffer.  This
 * function writes a RIFF/WAVE header followed by interleaved little‑endian
 * samples.  The amplitude is clipped to the range [–1, 1].
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("Sample rate must be a positive whole number.");
  }
  return Buffer.concat([buildWavHeader(sampleRate, samples.length), encodePcm16(samples)]);
}

/**
 * Stream LTC to a 16-bit mono WAV without holding the full show-length signal
 * and encoded file in memory. A half-bit terminal transition is appended so
 * decoders can close and report the final LTC frame.
 */
export async function writeLtcWavFile(
  filePath: string,
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  sampleRate = 48000,
  cutoffHz = 0,
  amplitude = 0.8,
  abortSignal?: AbortSignal,
): Promise<string> {
  const normalizedRate = validateSynthesisArguments(
    startFrame,
    frameCount,
    fps,
    dropFrame,
    sampleRate,
    cutoffHz,
    amplitude,
  );
  const contentSamples = Math.round((frameCount * sampleRate) / normalizedRate);
  const terminalGuardSamples = Math.max(
    1,
    Math.round(sampleRate / (normalizedRate * 80 * 2)),
  );
  const expectedSamples = contentSamples + terminalGuardSamples;
  const header = buildWavHeader(sampleRate, expectedSamples);
  const partialPath = `${filePath}.partial-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let handle: fs.FileHandle | undefined;
  let samplesWritten = 0;
  const synthesisState: SynthesisState = { phase: 1, sampleRemainder: 0.5 };
  const throwIfAborted = (): void => {
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error("LTC WAV generation was cancelled.");
    }
  };

  try {
    throwIfAborted();
    handle = await fs.open(partialPath, "wx");
    await handle.writeFile(header);
    const framesPerChunk = 300;
    for (let offset = 0; offset < frameCount; offset += framesPerChunk) {
      throwIfAborted();
      const chunkFrames = Math.min(framesPerChunk, frameCount - offset);
      const samples = synthesizeLtcChunk(
        startFrame + offset,
        chunkFrames,
        normalizedRate,
        dropFrame,
        sampleRate,
        cutoffHz,
        amplitude,
        synthesisState,
      );
      await handle.writeFile(encodePcm16(samples));
      samplesWritten += samples.length;
    }
    throwIfAborted();
    const terminalGuard = synthesizeTerminalGuard(
      normalizedRate,
      sampleRate,
      cutoffHz,
      amplitude,
      synthesisState,
    );
    await handle.writeFile(encodePcm16(terminalGuard));
    samplesWritten += terminalGuard.length;
    throwIfAborted();
    await handle.close();
    handle = undefined;

    if (samplesWritten !== expectedSamples) {
      throw new Error(
        `LTC synthesis wrote ${samplesWritten} samples; expected ${expectedSamples}.`,
      );
    }
    await fs.rm(filePath, { force: true });
    await fs.rename(partialPath, filePath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original synthesis or write error.
      }
    }
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw err;
  }
  return filePath;
}

/**
 * Construct a file name based on the timecode and frame‑rate for the generated WAV.
 */
export function buildFileName(
  hours: number,
  minutes: number,
  seconds: number,
  frames: number,
  fps: number,
  dropFrame: boolean,
): string {
  const hh = hours.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");
  const ff = frames.toString().padStart(2, "0");
  return `${hh}-${mm}-${ss}-${ff}_${formatFrameRate(fps)}${dropFrame ? "DF" : "NDF"}`;
}

/**
 * Decode an 80‑bit LTC frame into its constituent timecode fields and flags.
 * This helper is the inverse of {@link buildLTCFrame} and can be used to
 * verify that the bits were packed correctly.  It interprets the BCD fields
 * and extracts the drop‑frame and colour‑frame flags as booleans.  User
 * bits and binary‑group flags are ignored.
 */
export function decodeLTCFrame(bits: number[]): {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  dropFrame: boolean;
  colourFrame: boolean;
} {
  const readBits = (start: number, length: number) => {
    let value = 0;
    for (let i = 0; i < length; i++) {
      value |= (bits[start + i] & 1) << i;
    }
    return value;
  };
  const frameUnits = readBits(0, 4);
  const frameTens = readBits(8, 2);
  const secondsUnits = readBits(16, 4);
  const secondsTens = readBits(24, 3);
  const minutesUnits = readBits(32, 4);
  const minutesTens = readBits(40, 3);
  const hoursUnits = readBits(48, 4);
  const hoursTens = readBits(56, 2);
  const dropFrameFlag = bits[10] === 1;
  const colourFlag = bits[11] === 1;
  return {
    hours: hoursTens * 10 + hoursUnits,
    minutes: minutesTens * 10 + minutesUnits,
    seconds: secondsTens * 10 + secondsUnits,
    frames: frameTens * 10 + frameUnits,
    dropFrame: dropFrameFlag,
    colourFrame: colourFlag,
  };
}

/**
 * Write a human‑readable metadata file describing each frame in an LTC sequence.
 * This function iterates over the range of frames to be generated and decodes
 * the corresponding LTC bits into timecode fields, writing one line per frame
 * to the specified file.  Each line contains the frame index within the
 * sequence, the decoded timecode (HH:MM:SS:FF) and the state of the drop‑frame
 * and colour‑frame flags.  This is useful for offline testing without a
 * hardware reader or ltcdump.
 */
export async function writeLtcMetadata(
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  outPath: string,
): Promise<string> {
  const lines: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    const absFrame = startFrame + i;
    const { hours, minutes, seconds, frames } = frameNumberToTimecode(absFrame, fps, dropFrame);
    const bits = buildLTCFrame(hours, minutes, seconds, frames, fps, dropFrame);
    const decoded = decodeLTCFrame(bits);
    const tc = `${decoded.hours.toString().padStart(2, "0")}:${decoded.minutes
      .toString()
      .padStart(2, "0")}:${decoded.seconds.toString().padStart(2, "0")}:${decoded.frames
      .toString()
      .padStart(2, "0")}`;
    lines.push(
      `${i}\t${tc}\tDF=${decoded.dropFrame ? 1 : 0}\tCF=${decoded.colourFrame ? 1 : 0}`,
    );
  }
  await fs.writeFile(outPath, lines.join("\n"), { encoding: "utf8" });
  return outPath;
}

/**
 * Utility function to write a generated LTC signal to a temporary file.  This
 * helper streams the WAV to a unique temporary directory and returns the full
 * path. It can be used in contexts outside of Ableton Live.
 */
export async function writeLtcWav(
  startFrame: number,
  frameCount: number,
  fps: number,
  dropFrame: boolean,
  sampleRate = 48000,
  /**
   * Optional low‑pass filter cutoff for the WAV output.  Defaults to
   * 3 kHz.
   */
  cutoffHz: number = 3000,
  /**
   * Amplitude scaling factor for the generated WAV.  Defaults to 0.8.
   */
  amplitude: number = 0.8,
): Promise<string> {
  const start = frameNumberToTimecode(startFrame, fps, dropFrame);
  const baseName = buildFileName(
    start.hours,
    start.minutes,
    start.seconds,
    start.frames,
    fps,
    dropFrame,
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "duck-ltc-"));
  const filePath = path.join(tempDir, `${baseName}.wav`);
  return writeLtcWavFile(
    filePath,
    startFrame,
    frameCount,
    fps,
    dropFrame,
    sampleRate,
    cutoffHz,
    amplitude,
  );
}
