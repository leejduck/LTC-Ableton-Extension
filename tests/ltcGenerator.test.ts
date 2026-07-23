import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FRAME_RATE_23_976,
  FRAME_RATE_29_97,
  buildFileName,
  buildLTCFrame,
  decodeLTCFrame,
  durationToCoveringFrames,
  frameNumberToTimecode,
  generateLTCSignal,
  normalizeFrameRate,
  parseTimecodeString,
  secondsToFrames,
  timecodeToFrameNumber,
  validateTimecode,
  writeLtcWavFile,
} from "../src/ltcGenerator.js";

test("normalizes only supported LTC frame rates", () => {
  assert.equal(normalizeFrameRate(23.976), FRAME_RATE_23_976);
  assert.equal(normalizeFrameRate(23.98), FRAME_RATE_23_976);
  assert.equal(normalizeFrameRate(29.97), FRAME_RATE_29_97);
  assert.equal(normalizeFrameRate(24), 24);
  assert.equal(normalizeFrameRate(25), 25);
  assert.equal(normalizeFrameRate(30), 30);
  assert.equal(normalizeFrameRate(60), null);
});

test("parses supported clip-name formats and distinguishes NDF from DF", () => {
  assert.deepEqual(parseTimecodeString("01:02:03:04 24 NDF"), {
    hours: 1,
    minutes: 2,
    seconds: 3,
    frames: 4,
    fps: 24,
    dropFrame: false,
  });
  assert.deepEqual(parseTimecodeString("01:02:03;04"), {
    hours: 1,
    minutes: 2,
    seconds: 3,
    frames: 4,
    fps: FRAME_RATE_29_97,
    dropFrame: true,
  });
  assert.deepEqual(parseTimecodeString("1h30m15s12f 29.97 NDF"), {
    hours: 1,
    minutes: 30,
    seconds: 15,
    frames: 12,
    fps: FRAME_RATE_29_97,
    dropFrame: false,
  });
  assert.equal(parseTimecodeString("01:00:00:00 29.97 DROP-FRAME")?.dropFrame, true);
  assert.equal(parseTimecodeString("01:00:00:00 29.97 NON-DROP-FRAME")?.dropFrame, false);
  assert.equal(parseTimecodeString("01:00:00:00 25")?.dropFrame, false);
  assert.deepEqual(parseTimecodeString("45m"), {
    hours: 0,
    minutes: 45,
    seconds: 0,
    frames: 0,
    fps: undefined,
    dropFrame: undefined,
  });
});

test("rejects ambiguous or invalid timecode labels", () => {
  for (const value of [
    "",
    "lights go",
    "00:00:00:30 30 NDF",
    "24:00:00:00 30 NDF",
    "00:60:00:00 30 NDF",
    "00:00:60:00 30 NDF",
    "00:01:00;00",
    "00:01:00;01",
    "00:00:00:00 60 NDF",
    "00:00:00:00 25 DF",
    "00:00:00;00 NDF",
    "00:00:00:00 29.97 DROP-FRAME NDF",
    "00:00:00:00 30 DF NDF",
    "00:00:00;00 24",
    "00:00:00;00 24 DF",
  ]) {
    assert.equal(parseTimecodeString(value), null, value);
  }
});

test("validates drop-frame restrictions", () => {
  assert.equal(validateTimecode(0, 1, 0, 0, 29.97, true)?.includes("do not exist"), true);
  assert.equal(validateTimecode(0, 1, 0, 2, 29.97, true), null);
  assert.equal(validateTimecode(0, 0, 0, 0, 25, true)?.includes("only at 29.97"), true);
});

test("converts drop-frame labels to and from absolute frame numbers", () => {
  assert.equal(timecodeToFrameNumber(0, 1, 0, 2, 29.97, true), 1800);
  assert.equal(timecodeToFrameNumber(0, 10, 0, 0, 29.97, true), 17982);
  assert.equal(timecodeToFrameNumber(1, 0, 0, 0, 29.97, true), 107892);

  assert.deepEqual(frameNumberToTimecode(1800, 29.97, true), {
    hours: 0,
    minutes: 1,
    seconds: 0,
    frames: 2,
  });
  assert.deepEqual(frameNumberToTimecode(17982, 29.97, true), {
    hours: 0,
    minutes: 10,
    seconds: 0,
    frames: 0,
  });
  assert.deepEqual(frameNumberToTimecode(107892, 29.97, true), {
    hours: 1,
    minutes: 0,
    seconds: 0,
    frames: 0,
  });
  assert.deepEqual(frameNumberToTimecode(2589408, 29.97, true), {
    hours: 0,
    minutes: 0,
    seconds: 0,
    frames: 0,
  });
});

test("uses exact fractional frame rates for duration and sample counts", () => {
  assert.equal(secondsToFrames(10.01, 29.97), 300);
  assert.equal(secondsToFrames(10.01, 23.976), 240);
  assert.equal(generateLTCSignal(0, 300, 29.97, false, 48000).length, 480480);
  assert.equal(generateLTCSignal(0, 240, 23.976, false, 48000).length, 480480);
  assert.equal(generateLTCSignal(0, 30, 30, false, 48000).length, 48000);
  assert.equal(generateLTCSignal(0, 25, 25, false, 48000).length, 48000);
  assert.equal(generateLTCSignal(0, 24, 24, false, 48000).length, 48000);
});

test("rounds Live-region frame counts up so source audio covers the clip", () => {
  assert.equal(secondsToFrames(1.01, 30), 30);
  assert.equal(durationToCoveringFrames(1.01, 30), 31);
  assert.equal(durationToCoveringFrames(1, 30), 30);
  assert.equal(durationToCoveringFrames(10.01, 29.97), 300);
});

test("packs BCD fields, sync word, DF flag, and even-zero phase parity", () => {
  for (const [fps, parityBit] of [[24, 27], [25, 59], [29.97, 27], [30, 27]] as const) {
    const bits = buildLTCFrame(12, 34, 56, 12, fps, fps === 29.97);
    assert.equal(bits.length, 80);
    assert.deepEqual(decodeLTCFrame(bits), {
      hours: 12,
      minutes: 34,
      seconds: 56,
      frames: 12,
      dropFrame: fps === 29.97,
      colourFrame: false,
    });
    assert.deepEqual(bits.slice(64), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]);
    assert.equal(bits.filter((bit) => bit === 0).length % 2, 0);
    assert.ok(bits[parityBit] === 0 || bits[parityBit] === 1);
  }
});

test("streams a correctly sized 16-bit mono WAV with stable naming", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "duck-ltc-test-"));
  const filePath = path.join(directory, "streamed.wav");
  try {
    await writeLtcWavFile(filePath, 1800, 601, 29.97, true);
    const contentSamples = Math.round((601 * 48000) / FRAME_RATE_29_97);
    const terminalGuardSamples = Math.max(
      1,
      Math.round(48000 / (FRAME_RATE_29_97 * 80 * 2)),
    );
    const expectedSamples = contentSamples + terminalGuardSamples;
    assert.equal((await stat(filePath)).size, 44 + (expectedSamples * 2));

    const header = (await readFile(filePath)).subarray(0, 44);
    assert.equal(header.toString("ascii", 0, 4), "RIFF");
    assert.equal(header.toString("ascii", 8, 12), "WAVE");
    assert.equal(header.readUInt16LE(20), 1);
    assert.equal(header.readUInt16LE(22), 1);
    assert.equal(header.readUInt32LE(24), 48000);
    assert.equal(header.readUInt16LE(34), 16);
    assert.equal(header.readUInt32LE(40), expectedSamples * 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.equal(
    buildFileName(1, 2, 3, 4, 29.97, true),
    "01-02-03-04_29.97DF",
  );
});
