# Changelog

## 1.1.0 release candidate

- Added batch LTC generation from a multi-lane Arrangement time selection.
- Added a preflight dialog with a recommended shared-track layout and a per-source-MIDI-track layout.
- Kept every selected MIDI region as its own project-managed WAV and Arrangement audio clip.
- Preserved exact source clip bounds, empty gaps, selection overhang, and source clip colors.
- Explicitly disabled and verified Warp and looping on every generated audio clip.
- Resolved LTC format independently for each clip using clip name, owning track override, then saved defaults.
- Added truthful uniform or `MIXED FORMATS` destination track labels without renaming pre-existing tracks.
- Added deterministic suffixes when multiple clips would otherwise have the same filename.
- Added full-selection preflight, partial-boundary warnings, chronological overlap detection, progress, cancellation, one-job locking, and rollback of tracks created by a failed job.
- Added visible error and cleanup dialogs, a final 100% progress state, and explicit warnings for project assets the current SDK cannot remove after a late failure.
- Avoided chaining a success WebView after progress completion, which can open blank in Ableton Live 12.4.5b8; rare failure dialogs wait for Live's progress UI to settle.
- Made settings initialization single-shot and settings writes serialized and atomic.
- Preserved the existing single-clip **Generate LTC** command on the shared planning/execution path.
- Updated the installed Extension display name to **duckTC LTC Generator**.

## 1.0.0 release candidate

- Added exact 23.976 and 29.97 synthesis rates.
- Corrected 29.97 drop-frame conversion and 24-hour wrapping.
- Corrected biphase-mark transitions and phase-correction parity.
- Added the terminal half-bit transition used by duckTC Web v0.6.13 so the final LTC frame is decodable.
- Hardened clip-name parsing and rejected invalid or contradictory frame-rate modes.
- Streamed long LTC files to disk instead of allocating the entire show-length WAV in memory.
- Made temporary generation paths unique and cleaned them after project import.
- Added all supported frame-rate menu options and validated persistent defaults.
- Added unit tests and independent libltc decode verification.
- Changed the bundled entry point to CommonJS `.cjs` for the Live Node host.
- Documented that Developer Mode must be off when testing an installed `.ablx`, because Live otherwise leaves the Extension Host under manual developer control.
