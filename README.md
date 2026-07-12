# Zenless Voice

Voice-line extraction and annotation pipeline for [Zenless Zone Zero](https://zenless.hoyoverse.com/).

<!-- STATS -->
Last update at `2026-07-12`, game version `3.0.0`

`360691` wavs

`101984` without speaker (28%)

`298708` without transcription (83%)

`83705` without inGameFilename (23%)
<!-- STATS_END -->

## Usage

```bash
git submodule update --init --recursive
npm install
npm run build
npm run export
npm run update
```

`index.ts` reads PCK archives from `StreamingAssets/Audio/Windows/Full` by default. Use `VOICE_SOURCE_PATH` or `VOICE_RESULT_PATH` to override those paths.

ZenlessData uses obfuscated config fields, so `update.ts` matches only event-to-audio paths that are unambiguous in both the game config and extracted Wwise banks. Unmatched rows are intentionally retained with blank annotations.

## Acknowledgements

Speaker, source-path, and transcription links are reconstructed from `ZenlessData` by the repository's hash cracker.

Special thanks to Escartem for [**AnimeWwise**](https://github.com/Escartem/AnimeWwise) and its `nap.map` data. The project provided an important reference for researching and validating Zenless Zone Zero's Wwise source-path naming and filename-hash rules.
