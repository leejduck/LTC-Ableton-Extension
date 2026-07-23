# duckTC LTC Generator

### Extension for Ableton Live

Turn an Arrangement-view MIDI clip into an unwarped SMPTE LTC audio clip. The MIDI clip name supplies the starting timecode, while the clip region supplies its placement and duration.

duckTC LTC Generator is an offline, one-shot workflow: right-click a MIDI clip, choose **Generate LTC**, and the Extension creates a new audio track containing the generated LTC file.

> **Public beta notice:** Ableton Extensions are currently available through supported Ableton Live 12 Suite beta builds. This project is a tested release candidate, not yet a final commercial release.

## Current status

- Successfully tested with Ableton Live 12 Suite 12.4.5b8 on macOS.
- Generated LTC successfully synchronized a grandMA3 Command Wing LTC input without observed packet or synchronization issues.
- Built against Ableton Extensions API 1.0.0 using the `1.0.0-beta.0` SDK.
- Uses Node.js 24.16.0 or newer for the Extension development runtime.
- A final macOS and Windows smoke test is required on Ableton's first public Extensions-capable Live release.

Ableton currently documents Extensions as a Live 12 Suite beta feature. See the [Ableton Extensions FAQ](https://help.ableton.com/hc/en-us/articles/27303428331420-Ableton-Extensions-FAQ) and [Extensions SDK page](https://ableton.github.io/extensions-sdk/).

## What it creates

- Mono, 48 kHz, 16-bit PCM LTC audio
- An unwarped Arrangement audio clip
- A new LTC audio track aligned with the source MIDI clip
- A project-managed audio asset that remains available after temporary generation files are removed

## Supported LTC formats

| Frame rate | Mode |
| --- | --- |
| 23.976 (`24000/1001`) | Non-drop |
| 24 | Non-drop |
| 25 | Non-drop |
| 29.97 (`30000/1001`) | Non-drop or drop-frame |
| 30 | Non-drop |

The generator uses the exact fractional rates for 23.976 and 29.97, correct 29.97 drop-frame label skipping, SMPTE BCD field layout, phase-correction parity, and biphase-mark encoding. A terminal half-bit transition closes the final frame for downstream decoders.

## Install

1. Open **Settings → Extensions** in an Extensions-capable Ableton Live 12 Suite build.
2. Install the release `.ablx` file using **Choose file**, or drag it into the Extensions panel.
3. Keep **Developer Mode** off for normal installed-extension use.
4. Create an Arrangement-view MIDI clip covering the desired LTC region.
5. Rename the clip with its starting timecode.
6. Right-click the MIDI clip and choose **Extensions → timecode-generator: Generate LTC**.
7. Confirm that Live creates an unwarped audio clip on a new LTC audio track at the same Arrangement position.

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

### The Extensions menu is missing

If the extension is listed as installed but no **Extensions** submenu appears when you right-click a MIDI clip:

1. Open **Settings → Extensions**.
2. Turn **Developer Mode** off.
3. Right-click the MIDI clip again. Live should start its managed Extension Host automatically.

When Developer Mode is on, Live deliberately shuts down its managed Extension Host and waits for a developer-run host process. This can make a correctly installed `.ablx` look inactive without showing a package error.

## Current limitations

- Use a constant tempo across the source MIDI clip. The current Extensions API exposes the region in beats and the song's current tempo, but not a beat-to-time conversion across a tempo automation map. A region spanning tempo changes may produce an audio file with the wrong real-time length.
- Each generation currently creates a new LTC audio track.
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

Then use Node.js 24.16.0 or newer:

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
