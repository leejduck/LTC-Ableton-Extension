# LTC Ableton Extension

Generate an unwarped SMPTE LTC audio clip from an Arrangement-view MIDI clip. The MIDI clip's name supplies the starting timecode, and its region supplies the placement and duration.

The Extension is a one-shot, offline tool: right-click a MIDI clip, choose **Generate LTC**, and Live creates a new audio track containing the generated LTC file.

## Compatibility status

- Ableton Live 12 Suite 12.4.5b8 on macOS: release-candidate validation in progress.
- Ableton Extensions API: 1.0.0 using the current `1.0.0-beta.0` SDK package.
- Extension development runtime: Node.js 24.16.0 or newer.
- Current stable Live 12.4.3 does not include Extensions. A final smoke test is required when Ableton releases the Extensions-capable public build.

Ableton currently documents Extensions as a Live 12 Suite beta feature. See the [Ableton Extensions FAQ](https://help.ableton.com/hc/en-us/articles/27303428331420-Ableton-Extensions-FAQ) and [Extensions SDK page](https://ableton.github.io/extensions-sdk/).

## Supported LTC formats

| Frame rate | Mode |
| --- | --- |
| 23.976 (`24000/1001`) | Non-drop |
| 24 | Non-drop |
| 25 | Non-drop |
| 29.97 (`30000/1001`) | Non-drop or drop-frame |
| 30 | Non-drop |

The generator uses the exact fractional rates for 23.976 and 29.97, correct 29.97 drop-frame label skipping, SMPTE BCD field layout, phase-correction parity, and biphase-mark encoding. A terminal half-bit transition closes the final frame for downstream decoders.

## Clip naming

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

## Install and use

1. In an Extensions-capable Ableton Live 12 Suite build, open **Settings → Extensions**.
2. Install the release `.ablx` package using **Choose file** or drag it into the Extensions panel.
3. Keep **Developer Mode** off for normal installed-extension use. Developer Mode stops Live's managed Extension Host and is intended only when you launch the host yourself with `npm start` or `extensions-cli run`.
4. Create an Arrangement-view MIDI clip covering the desired LTC region.
5. Rename it with the starting timecode.
6. Right-click the MIDI clip and choose **Extensions → timecode-generator: Generate LTC**.
7. Confirm that Live creates an unwarped audio clip on a new LTC audio track at the same Arrangement position.

### The Extensions menu is missing

If the extension is listed as installed but no **Extensions** submenu appears when you right-click a MIDI clip:

1. Open **Settings → Extensions**.
2. Turn **Developer Mode** off.
3. Right-click the MIDI clip again. Live should start its managed Extension Host automatically.

When Developer Mode is on, Live deliberately shuts down its managed Extension Host and waits for a developer-run host process. This can make a correctly installed `.ablx` look inactive without showing a package error.

## Important tempo limitation

The Extensions API currently exposes the MIDI region in beats and the song's current tempo, but not a beat-to-time conversion across a tempo automation map. Use a constant tempo across the source MIDI clip. A region spanning tempo changes may not produce an audio file with the correct real-time length.

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

The Extension does not make network requests. Generation uses a unique temporary directory, imports the finished WAV into the Live project, and removes the temporary working files afterward.

## Source and third-party licensing

No open-source license is granted for the LTC Ableton Extension source at this time. The independent test harness uses the vendored [libltc](https://github.com/x42/libltc) source under its own LGPL-3.0-or-later terms; its license and notices remain in `vendor/libltc/`.

The Ableton Extensions SDK and CLI are not part of this repository. Their use and redistribution are governed by Ableton's license.
