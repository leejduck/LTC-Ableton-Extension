# duckTC LTC Generator

### Extension for Ableton Live

Turn one or more Arrangement-view MIDI clips into unwarped SMPTE LTC audio clips. Each MIDI clip name supplies its starting timecode, while its own region supplies placement and duration.

duckTC LTC Generator works offline. Generate one clip directly, or select a full-show range and create separate, color-matched LTC clips on one shared track or on one output track per source MIDI track.

> **Public beta notice:** Ableton Extensions are currently available through supported Ableton Live 12 Suite beta builds. This project is a tested release candidate, not yet a final commercial release.

## Current status

- Successfully tested with Ableton Live 12 Suite 12.4.5b8 on macOS.
- Generated LTC successfully synchronized a grandMA3 Command Wing LTC input without observed packet or synchronization issues.
- Built against Ableton Extensions API 1.0.0 using the `1.0.0-beta.0` SDK.
- Uses Node.js 24.14.1 or newer, matching the current Live beta Extension Host requirement.
- A final macOS and Windows smoke test is required on Ableton's first public Extensions-capable Live release.

Ableton currently documents Extensions as a Live 12 Suite beta feature. See the [Ableton Extensions FAQ](https://help.ableton.com/hc/en-us/articles/27303428331420-Ableton-Extensions-FAQ) and [Extensions SDK page](https://ableton.github.io/extensions-sdk/).

## What it creates

- Mono, 48 kHz, 16-bit PCM LTC audio
- Explicitly unwarped, non-looping Arrangement audio clips
- One distinct project-managed WAV per source MIDI clip
- Output clips aligned exactly to their source MIDI regions and carrying the source clip colors
- Empty Arrangement gaps where the selected MIDI regions have gaps
- New LTC output track(s) labeled with the actual common format or `MIXED FORMATS`

## Supported LTC formats

| Frame rate | Mode |
| --- | --- |
| 23.976 (`24000/1001`) | Non-drop |
| 24 | Non-drop |
| 25 | Non-drop |
| 29.97 (`30000/1001`) | Non-drop or drop-frame |
| 30 | Non-drop |

The generator uses the exact fractional rates for 23.976 and 29.97, correct 29.97 drop-frame label skipping, SMPTE BCD field layout, phase-correction parity, and biphase-mark encoding. The source WAV appends a terminal half-bit transition, and the independent decoder tests report the final generated frame; exact placed-clip boundary behavior remains part of Live-host release validation.

## Install

1. Open **Settings → Extensions** in an Extensions-capable Ableton Live 12 Suite build.
2. Install the release `.ablx` file using **Choose file**, or drag it into the Extensions panel.
3. Keep **Developer Mode** off for normal installed-extension use.
4. Create Arrangement-view MIDI clips covering the desired LTC regions.
5. Rename every clip with its own starting timecode.
6. For one region, right-click its MIDI clip and choose **Extensions → duckTC LTC Generator: Generate LTC**.
7. For a batch, make an Arrangement time selection across the required MIDI lane(s), fully enclosing every clip to include. Right-click inside the selection and choose **Extensions → duckTC LTC Generator: Generate Selected LTC…**.
8. Review the complete preflight list and choose **One shared LTC track** or **One LTC track per source MIDI track**.
9. Confirm that Live creates separate unwarped audio clips at the same positions, with the same durations and colors as their source MIDI clips.

Developer Mode stops Live's managed Extension Host and is intended only when a developer launches the host manually with `npm start` or `extensions-cli run`.

## Clip naming and quick start

Name the source MIDI clip with a starting timecode. Examples:

```text
01:00:00:00
01:00:00:00 24 NDF
01:00:00:00 29.97 NDF
01:00:00;00
01:00:00:00 29.97 DF
1h30m15s12f 25 NDF
```

A semicolon selects 29.97 drop-frame. Frame numbers `00` and `01` at the start of non-tenth drop-frame minutes are rejected because those labels do not exist.

When the clip name does not specify a frame rate, the Extension uses its saved default. The owning MIDI track can override defaults with a name such as:

```text
LTC | 29.97 DF | 16b | 48k
```

The output is currently fixed at mono, 48 kHz, 16-bit PCM.

## Batch selection behavior

The Arrangement time selection is an inclusion envelope, not an output region:

- Only MIDI clips fully contained by both the selected time range and selected MIDI lanes are generated.
- Clips crossing a selection boundary are listed as warnings and skipped.
- Selection overhang before the first clip and after the last clip stays empty.
- Gaps between source clips stay empty; the Extension never creates a composite show-length WAV or silent filler media.
- Every included clip gets a separate source WAV whose filename states the complete starting timecode and actual FPS/DF mode.
- The recommended shared-track mode rejects overlapping regions. Adjacent and separated regions are allowed.
- The per-source mode creates one destination audio track per owning MIDI track. Overlaps on the same source track, including overlapping selected take lanes, are rejected.
- Duplicate timecode filenames receive deterministic track/clip suffixes.

The preflight happens before WAV rendering or Live Set changes. Rendering completes before import; Live tracks created by a failed or cancelled job are rolled back. The current Extensions API cannot delete already imported project assets, so the Extension reports any unused imported files after a late failure.

### The Extensions menu is missing

If the extension is listed as installed but no **Extensions** submenu appears when you right-click a MIDI clip:

1. Open **Settings → Extensions**.
2. Turn **Developer Mode** off.
3. Right-click the MIDI clip again. Live should start its managed Extension Host automatically.

When Developer Mode is on, Live deliberately shuts down its managed Extension Host and waits for a developer-run host process. This can make a correctly installed `.ablx` look inactive without showing a package error.

## Current limitations

- Use a constant tempo across the source MIDI clip. The current Extensions API exposes the region in beats and the song's current tempo, but not a beat-to-time conversion across a tempo automation map. A region spanning tempo changes may therefore produce a source file with the wrong real-time length. The generated clip is always unwarped, so LTC cadence itself never speeds up, slows down, or follows Live's BPM.
- Every command currently creates new destination track(s); automatic replacement or reuse of an earlier generated LTC track is not yet implemented.
- This release candidate is supported only on explicitly tested Extensions-capable Live 12 Suite builds.
- For the cleanest LTC boundaries, disable **Settings → Record, Warp & Launch → Create Fades on Clip Edges** before generation. When enabled, Live may apply a short fade to the beginning and end of the placed clip, potentially costing the first or last decoded LTC frame. This does not alter the generated WAV source and is not considered a release blocker. See Ableton's [clip-edge fade documentation](https://help.ableton.com/hc/en-us/articles/209069969-Create-Fades-on-Clip-Edges-to-avoid-clicks).

## Privacy and network use

The Extension works locally and does not make network requests. It does not require an account, collect telemetry, or perform online license validation.

Generation uses a unique temporary directory, imports the completed WAV into the Live project, and removes its temporary working files afterward.

## Releases and support

Versioned `.ablx` packages and checksums will be published through this repository's [Releases](https://github.com/leejduck/LTC-Ableton-Extension/releases) page once the public-release test matrix is complete.

Use [GitHub Issues](https://github.com/leejduck/LTC-Ableton-Extension/issues) for reproducible defects and compatibility reports. Include the operating system, exact Ableton Live version, source clip name, frame rate, and relevant Extension Host log output.

## Development

The Ableton SDK and CLI archives are intentionally not stored in this repository. Download the current Extensions SDK from Ableton's beta portal and place these files in `vendor/`:

```text
vendor/ableton-extensions-sdk-1.0.0-beta.0.tgz
vendor/ableton-extensions-cli-1.0.0-beta.0.tgz
```

Then use Node.js 24.14.1 or newer:

```sh
npm install
npm run verify
npm run package
```

`npm run verify` performs type checking, parser and timecode-vector tests, an independent vendored-libltc decode across all supported rates, and a production bundle.

## Source and third-party licensing

No open-source license is granted for the duckTC LTC Generator source at this time. Public visibility of this repository does not grant permission to redistribute, sublicense, or commercially reuse the source.

The independent test harness uses the vendored [libltc](https://github.com/x42/libltc) source under its own LGPL-3.0-or-later terms; its license and notices remain in `vendor/libltc/`.

The Ableton Extensions SDK and CLI are not part of this repository. Their use and redistribution are governed by Ableton's license.

Ableton and Live are trademarks of Ableton AG. duckTC LTC Generator is an independent product and is not affiliated with or endorsed by Ableton AG.
