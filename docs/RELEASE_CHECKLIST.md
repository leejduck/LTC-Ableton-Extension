# Release checklist

## Source verification

- [ ] Use Node.js 24.16.0 or newer.
- [ ] Confirm the current Ableton Extensions SDK and CLI release.
- [ ] Run `npm run verify`.
- [ ] Inspect the `.ablx` archive and confirm it contains only `manifest.json` and the configured bundle.
- [ ] Record the package SHA-256.

## Ableton Live validation

- [ ] Install into a clean Extensions-capable Live 12 Suite build.
- [ ] Confirm Developer Mode is off for installed-package testing.
- [ ] Confirm installation and Extension-host startup without errors.
- [ ] Generate 24 NDF LTC from an Arrangement MIDI clip.
- [ ] Generate 25 NDF LTC.
- [ ] Generate 29.97 NDF LTC.
- [ ] Generate 29.97 DF across a non-tenth minute boundary.
- [ ] Generate 30 NDF LTC.
- [ ] Confirm the resulting audio clips are unwarped and match source placement.
- [ ] Confirm invalid names do not create tracks or audio.
- [ ] Confirm saved defaults survive Live relaunch.
- [ ] Confirm generated LTC decodes in an independent receiver.
- [ ] Remove all temporary test tracks and clips from the operator's Set.

## Public-build gate

- [ ] Repeat the smoke test on Ableton's first public Extensions-capable Live build.
- [ ] Update the README compatibility statement with the exact public version.
- [ ] Package from the verified commit and attach the `.ablx` plus SHA-256 to the release.
