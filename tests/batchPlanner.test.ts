import assert from "node:assert/strict";
import test from "node:test";
import {
  BatchPlanningError,
  createBatchPlan,
  parseTrackNameSettings,
  partitionSelection,
  resolveEffectiveFormat,
  type BatchSourceClip,
} from "../src/batchPlanner.js";
import {
  FRAME_RATE_29_97,
  parseTimecodeString,
} from "../src/ltcGenerator.js";

function source(
  overrides: Partial<BatchSourceClip> = {},
): BatchSourceClip {
  return {
    id: "clip-1",
    sourceTrackId: "track-1",
    sourceTrackName: "MIDI LTC",
    sourceTrackIndex: 0,
    sourceOrder: 0,
    name: "01:00:00:00 30 NDF",
    startBeat: 8,
    endBeat: 16,
    durationBeats: 8,
    durationSeconds: 4,
    color: 12,
    ...overrides,
  };
}

test("uses an Arrangement selection only as an inclusion envelope", () => {
  const exactLeft = source({
    id: "left",
    startBeat: 0,
    endBeat: 8,
    durationBeats: 8,
  });
  const exactRight = source({
    id: "right",
    sourceOrder: 1,
    startBeat: 24,
    endBeat: 32,
    durationBeats: 8,
  });
  const partialLeft = source({
    id: "partial-left",
    sourceOrder: 2,
    startBeat: -2,
    endBeat: 4,
    durationBeats: 6,
  });
  const partialRight = source({
    id: "partial-right",
    sourceOrder: 3,
    startBeat: 30,
    endBeat: 36,
    durationBeats: 6,
  });
  const outside = source({
    id: "outside",
    sourceOrder: 4,
    startBeat: 40,
    endBeat: 48,
    durationBeats: 8,
  });

  const result = partitionSelection(
    [exactRight, partialRight, outside, exactLeft, partialLeft, exactLeft],
    { startBeat: 0, endBeat: 32 },
  );

  assert.deepEqual(result.included.map((clip) => clip.id), ["left", "right"]);
  assert.deepEqual(
    result.partial.map((clip) => clip.id),
    ["partial-left", "partial-right"],
  );
  assert.deepEqual(result.outside.map((clip) => clip.id), ["outside"]);
  assert.equal(result.included[0]!.startBeat, 0);
  assert.equal(result.included[1]!.endBeat, 32);
});

test("resolves settings independently for each clip without mutating defaults", () => {
  const defaults = { fps: 30, dropFrame: false };

  const inherited = resolveEffectiveFormat(
    parseTimecodeString("01:00:00:00")!,
    "LTC | 25 NDF | 16b | 48k",
    defaults,
  );
  assert.deepEqual(inherited, { fps: 25, dropFrame: false });

  const explicitClip = resolveEffectiveFormat(
    parseTimecodeString("01:00:00:00 24 NDF")!,
    "LTC | 25 NDF | 16b | 48k",
    defaults,
  );
  assert.deepEqual(explicitClip, { fps: 24, dropFrame: false });

  const ndfOverlay = resolveEffectiveFormat(
    parseTimecodeString("01:00:00:00 NDF")!,
    "LTC | 29.97 DF | 16b | 48k",
    defaults,
  );
  assert.deepEqual(ndfOverlay, {
    fps: FRAME_RATE_29_97,
    dropFrame: false,
  });

  const semicolon = resolveEffectiveFormat(
    parseTimecodeString("01:00:00;00")!,
    "LTC | 25 NDF | 16b | 48k",
    defaults,
  );
  assert.deepEqual(semicolon, {
    fps: FRAME_RATE_29_97,
    dropFrame: true,
  });
  assert.deepEqual(defaults, { fps: 30, dropFrame: false });
});

test("parses delimited track settings without mistaking bit depth or words for format", () => {
  assert.deepEqual(parseTrackNameSettings("LTC | 29.97 DF | 16b | 48k"), {
    fps: FRAME_RATE_29_97,
    unsupportedFps: undefined,
    dropFrame: true,
    bitDepth: 16,
    sampleRate: 48_000,
  });
  assert.deepEqual(parseTrackNameSettings("LTC_30DF"), {
    fps: 30,
    unsupportedFps: undefined,
    dropFrame: true,
    bitDepth: undefined,
    sampleRate: undefined,
  });
  assert.deepEqual(parseTrackNameSettings("LTC capture 24-bit | 48k"), {
    fps: undefined,
    unsupportedFps: undefined,
    dropFrame: undefined,
    bitDepth: 24,
    sampleRate: 48_000,
  });
  assert.deepEqual(parseTrackNameSettings("LTC Soundfile | 25"), {
    fps: 25,
    unsupportedFps: undefined,
    dropFrame: undefined,
    bitDepth: undefined,
    sampleRate: undefined,
  });
  assert.deepEqual(parseTrackNameSettings("LTC | 26 NDF"), {
    fps: undefined,
    unsupportedFps: 26,
    dropFrame: false,
    bitDepth: undefined,
    sampleRate: undefined,
  });
});

test("plans one separate file and exact source region per separated clip", () => {
  const clips = [
    source({
      id: "a",
      sourceOrder: 0,
      name: "01:00:00:00 30 NDF",
      startBeat: 8,
      endBeat: 16,
      durationBeats: 8,
      color: 10,
    }),
    source({
      id: "b",
      sourceOrder: 1,
      name: "01:15:00:00 30 NDF",
      startBeat: 32,
      endBeat: 40,
      durationBeats: 8,
      color: 20,
    }),
    source({
      id: "c",
      sourceOrder: 2,
      name: "01:30:00:00 30 NDF",
      startBeat: 64,
      endBeat: 72,
      durationBeats: 8,
      color: 30,
    }),
  ];
  const plan = createBatchPlan(clips, { fps: 25, dropFrame: false }, "shared");

  assert.equal(plan.destinations.length, 1);
  assert.equal(plan.destinations[0]!.trackName, "LTC | 30 NDF | 16b | 48k");
  assert.deepEqual(
    plan.clips.map((clip) => ({
      id: clip.source.id,
      startBeat: clip.source.startBeat,
      durationBeats: clip.source.durationBeats,
      color: clip.source.color,
      fileName: clip.fileName,
    })),
    [
      {
        id: "a",
        startBeat: 8,
        durationBeats: 8,
        color: 10,
        fileName: "01-00-00-00_30NDF",
      },
      {
        id: "b",
        startBeat: 32,
        durationBeats: 8,
        color: 20,
        fileName: "01-15-00-00_30NDF",
      },
      {
        id: "c",
        startBeat: 64,
        durationBeats: 8,
        color: 30,
        fileName: "01-30-00-00_30NDF",
      },
    ],
  );
});

test("adds deterministic suffixes to duplicate timecode filenames", () => {
  const first = source({
    id: "first",
    sourceTrackIndex: 0,
    sourceOrder: 2,
    startBeat: 8,
    endBeat: 16,
  });
  const second = source({
    id: "second",
    sourceTrackId: "track-2",
    sourceTrackName: "Second MIDI",
    sourceTrackIndex: 1,
    sourceOrder: 4,
    startBeat: 24,
    endBeat: 32,
  });

  const forward = createBatchPlan(
    [first, second],
    { fps: 30, dropFrame: false },
    "shared",
  );
  const reversed = createBatchPlan(
    [second, first],
    { fps: 30, dropFrame: false },
    "shared",
  );

  assert.deepEqual(
    forward.clips.map((clip) => clip.fileName),
    [
      "01-00-00-00_30NDF__T01-C003",
      "01-00-00-00_30NDF__T02-C005",
    ],
  );
  assert.deepEqual(
    reversed.clips.map((clip) => clip.fileName),
    forward.clips.map((clip) => clip.fileName),
  );
});

test("rejects overlap on a shared track but allows different source destinations", () => {
  const first = source({
    id: "first",
    startBeat: 8,
    endBeat: 20,
    durationBeats: 12,
  });
  const second = source({
    id: "second",
    sourceTrackId: "track-2",
    sourceTrackName: "Second MIDI",
    sourceTrackIndex: 1,
    startBeat: 16,
    endBeat: 24,
    durationBeats: 8,
  });

  assert.throws(
    () => createBatchPlan(
      [first, second],
      { fps: 30, dropFrame: false },
      "shared",
    ),
    (error: unknown) => (
      error instanceof BatchPlanningError
      && error.issues.some((issue) => issue.includes("Output overlap"))
    ),
  );

  const perSource = createBatchPlan(
    [first, second],
    { fps: 30, dropFrame: false },
    "per-source-track",
  );
  assert.equal(perSource.destinations.length, 2);
  assert.equal(
    perSource.destinations[0]!.trackName,
    "LTC | MIDI LTC | 30 NDF | 16b | 48k",
  );
});

test("checks shared-track conflicts chronologically across source tracks", () => {
  const laterClipOnFirstTrack = source({
    id: "later",
    sourceTrackIndex: 0,
    startBeat: 32,
    endBeat: 40,
    durationBeats: 8,
  });
  const earlierClipOnSecondTrack = source({
    id: "earlier",
    sourceTrackId: "track-2",
    sourceTrackName: "Second MIDI",
    sourceTrackIndex: 1,
    startBeat: 8,
    endBeat: 16,
    durationBeats: 8,
  });

  const plan = createBatchPlan(
    [laterClipOnFirstTrack, earlierClipOnSecondTrack],
    { fps: 30, dropFrame: false },
    "shared",
  );
  assert.equal(plan.destinations.length, 1);
  assert.deepEqual(
    plan.destinations[0]!.clipIds,
    ["earlier", "later"],
  );
});

test("rejects overlapping take-lane regions grouped under one source MIDI track", () => {
  const firstTake = source({
    id: "take-1",
    sourceOrder: 0,
    startBeat: 8,
    endBeat: 20,
    durationBeats: 12,
  });
  const secondTake = source({
    id: "take-2",
    sourceOrder: 1,
    startBeat: 12,
    endBeat: 24,
    durationBeats: 12,
  });

  assert.throws(
    () => createBatchPlan(
      [firstTake, secondTake],
      { fps: 30, dropFrame: false },
      "per-source-track",
    ),
    (error: unknown) => (
      error instanceof BatchPlanningError
      && error.issues.some((issue) => issue.includes("Output overlap"))
    ),
  );
});

test("allows adjacent clips and labels mixed-format destinations truthfully", () => {
  const plan = createBatchPlan(
    [
      source({
        id: "first",
        name: "01:00:00:00 25 NDF",
        startBeat: 8,
        endBeat: 16,
        durationBeats: 8,
      }),
      source({
        id: "second",
        sourceOrder: 1,
        name: "01:15:00:00 30 NDF",
        startBeat: 16,
        endBeat: 24,
        durationBeats: 8,
      }),
    ],
    { fps: 30, dropFrame: false },
    "shared",
  );

  assert.equal(
    plan.destinations[0]!.trackName,
    "LTC | MIXED FORMATS | 16b | 48k",
  );
});

test("validates frame fields against the final track-resolved rate", () => {
  assert.throws(
    () => createBatchPlan(
      [
        source({
          name: "01:00:00:29",
          sourceTrackName: "LTC | 25 NDF | 16b | 48k",
        }),
      ],
      { fps: 30, dropFrame: false },
      "shared",
    ),
    (error: unknown) => (
      error instanceof BatchPlanningError
      && error.issues.some((issue) => issue.includes("Frames must be between"))
    ),
  );
});

test("rejects unsupported FPS tokens in an owning track name", () => {
  assert.throws(
    () => createBatchPlan(
      [
        source({
          name: "01:00:00:00",
          sourceTrackName: "LTC | 26 NDF",
        }),
      ],
      { fps: 30, dropFrame: false },
      "shared",
    ),
    (error: unknown) => (
      error instanceof BatchPlanningError
      && error.issues.some((issue) => issue.includes("Unsupported LTC frame rate"))
    ),
  );
});

test("rejects a region shorter than one complete LTC frame", () => {
  assert.throws(
    () => createBatchPlan(
      [
        source({
          durationBeats: 0.02,
          durationSeconds: 0.01,
          endBeat: 8.02,
        }),
      ],
      { fps: 30, dropFrame: false },
      "shared",
    ),
    (error: unknown) => (
      error instanceof BatchPlanningError
      && error.issues.some((issue) => issue.includes("shorter than one complete LTC frame"))
    ),
  );
});
