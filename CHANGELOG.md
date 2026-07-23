# Changelog

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
