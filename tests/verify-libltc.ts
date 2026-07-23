import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  FRAME_RATE_23_976,
  FRAME_RATE_29_97,
  frameNumberToTimecode,
  timecodeToFrameNumber,
  writeLtcWavFile,
} from "../src/ltcGenerator.js";

type DecodeCase = {
  name: string;
  fps: number;
  dropFrame: boolean;
  startFrame: number;
  frameCount: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workingDirectory = await mkdtemp(path.join(tmpdir(), "duck-ltc-libltc-"));
const decoderPath = path.join(workingDirectory, "libltc_decode_wav");
const compiler = process.platform === "darwin"
  ? { command: "xcrun", args: ["clang"] }
  : { command: "cc", args: [] };

function formatTimecode(frameNumber: number, fps: number, dropFrame: boolean): string {
  const timecode = frameNumberToTimecode(frameNumber, fps, dropFrame);
  return [
    timecode.hours,
    timecode.minutes,
    timecode.seconds,
    timecode.frames,
  ].map((field) => field.toString().padStart(2, "0")).join(":");
}

try {
  const compile = spawnSync(
    compiler.command,
    [
      ...compiler.args,
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-Ivendor/libltc/src",
      "tests/libltc_decode_wav.c",
      "vendor/libltc/src/ltc.c",
      "vendor/libltc/src/decoder.c",
      "vendor/libltc/src/encoder.c",
      "vendor/libltc/src/timecode.c",
      "-lm",
      "-o",
      decoderPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(
    compile.status,
    0,
    `Could not compile the independent libltc decoder:\n${compile.stderr}`,
  );

  const cases: DecodeCase[] = [
    {
      name: "23.976 NDF",
      fps: FRAME_RATE_23_976,
      dropFrame: false,
      startFrame: timecodeToFrameNumber(1, 0, 0, 0, FRAME_RATE_23_976, false),
      frameCount: 96,
    },
    {
      name: "24 NDF",
      fps: 24,
      dropFrame: false,
      startFrame: timecodeToFrameNumber(1, 0, 0, 0, 24, false),
      frameCount: 96,
    },
    {
      name: "25 NDF",
      fps: 25,
      dropFrame: false,
      startFrame: timecodeToFrameNumber(1, 0, 0, 0, 25, false),
      frameCount: 100,
    },
    {
      name: "29.97 NDF",
      fps: FRAME_RATE_29_97,
      dropFrame: false,
      startFrame: timecodeToFrameNumber(1, 0, 0, 0, FRAME_RATE_29_97, false),
      frameCount: 120,
    },
    {
      name: "29.97 DF minute boundary",
      fps: FRAME_RATE_29_97,
      dropFrame: true,
      startFrame: timecodeToFrameNumber(0, 0, 59, 28, FRAME_RATE_29_97, true),
      frameCount: 120,
    },
    {
      name: "30 NDF",
      fps: 30,
      dropFrame: false,
      startFrame: timecodeToFrameNumber(1, 0, 0, 0, 30, false),
      frameCount: 120,
    },
  ];

  for (const testCase of cases) {
    const wavPath = path.join(
      workingDirectory,
      `${testCase.name.replaceAll(/[^a-z0-9]+/giu, "-")}.wav`,
    );
    await writeLtcWavFile(
      wavPath,
      testCase.startFrame,
      testCase.frameCount,
      testCase.fps,
      testCase.dropFrame,
    );

    const decode = spawnSync(
      decoderPath,
      [wavPath, testCase.fps.toString()],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      decode.status,
      0,
      `${testCase.name} failed independent decoding:\n${decode.stderr}`,
    );
    const summary = decode.stdout.match(
      /SUMMARY count=(\d+) first=(\S+) first_df=(\d) last=(\S+) last_df=(\d)/u,
    );
    assert.ok(summary, `${testCase.name} did not produce a decoder summary.`);
    // The terminal half-bit transition closes the final LTC frame.
    const decodedFrameCount = testCase.frameCount;
    assert.equal(Number(summary[1]), decodedFrameCount, `${testCase.name} frame count`);
    assert.equal(
      summary[2],
      formatTimecode(testCase.startFrame, testCase.fps, testCase.dropFrame),
      `${testCase.name} first frame`,
    );
    assert.equal(Number(summary[3]), testCase.dropFrame ? 1 : 0, `${testCase.name} first DF flag`);
    assert.equal(
      summary[4],
      formatTimecode(
        testCase.startFrame + decodedFrameCount - 1,
        testCase.fps,
        testCase.dropFrame,
      ),
      `${testCase.name} last frame`,
    );
    assert.equal(Number(summary[5]), testCase.dropFrame ? 1 : 0, `${testCase.name} last DF flag`);
    console.log(`libltc decoded ${testCase.name}: ${summary[2]} through ${summary[4]} (${summary[1]} frames)`);
  }
} finally {
  await rm(workingDirectory, { recursive: true, force: true });
}
