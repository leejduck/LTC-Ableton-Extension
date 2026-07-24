# Release checklist

## Source verification

- [ ] Use Node.js 24.14.1 or newer.
- [ ] Confirm the current Ableton Extensions SDK and CLI release.
- [ ] Run `npm run verify`.
- [ ] Inspect the `.ablx` archive and confirm it contains only `manifest.json` and the configured bundle.
- [ ] Keep `manifest.version` strictly numeric (`major.minor.patch`); the current Live installer rejects prerelease suffixes. Preserve the stable `ducktc-ltc-generator` public identifier in `name` and use `displayName` for the human-facing product name.
- [ ] Record the package SHA-256.

## Ableton Live validation

- [ ] Install into a clean Extensions-capable Live 12 Suite build.
- [ ] Confirm Developer Mode is off for installed-package testing.
- [ ] Confirm installation and Extension-host startup without errors.
- [ ] Generate 23.976 NDF LTC.
- [ ] Generate 24 NDF LTC from an Arrangement MIDI clip.
- [ ] Generate 25 NDF LTC.
- [ ] Generate 29.97 NDF LTC.
- [ ] Generate 29.97 DF across a non-tenth minute boundary.
- [ ] Generate 30 NDF LTC.
- [ ] Confirm the resulting audio clips are unwarped and match source placement.
- [ ] Select multiple separated MIDI clips with selection overhang; confirm one separate WAV and audio clip per MIDI clip and no media in gaps or overhang.
- [ ] Confirm generated audio clips inherit every source MIDI clip color.
- [ ] Confirm the shared-track mode works across multiple source MIDI tracks whose chronological order differs from track order.
- [ ] Confirm the per-source-track mode creates exactly one output per owning MIDI track.
- [ ] Confirm a boundary-crossing clip is warned and excluded without changing its source.
- [ ] Confirm overlapping regions block shared output, while overlaps across distinct source tracks remain available in per-source mode.
- [ ] Confirm overlapping selected take lanes under one MIDI track are rejected.
- [ ] Confirm duplicate timecode names receive separate, deterministic project filenames.
- [ ] Confirm mixed FPS/DF clips use their actual filenames and a `MIXED FORMATS` shared-track label.
- [ ] Cancel during rendering and confirm no Live tracks or clips remain.
- [ ] Inject or reproduce a late failure and confirm created tracks are rolled back and imported-orphan warnings are visible.
- [ ] Confirm invalid names do not create tracks or audio.
- [ ] Confirm saved defaults survive Live relaunch.
- [ ] Confirm generated LTC decodes in an independent receiver.
- [ ] Remove all temporary test tracks and clips from the operator's Set.

## Public-build gate

- [ ] Repeat the smoke test on Ableton's first public Extensions-capable Live build.
- [ ] Update the README compatibility statement with the exact public version.
- [ ] Package from the verified commit and attach the `.ablx` plus SHA-256 to the release.
