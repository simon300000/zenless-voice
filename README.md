# Zenless Voice

Voice-line extraction and annotation pipeline for [Zenless Zone Zero](https://zenless.hoyoverse.com/).

<!-- STATS -->
Last update at `2026-07-13`, game version `3.0.0`

`360691` wavs

`83768` without speaker (23%)

`113634` without transcription (32%)

`65489` without inGameFilename (18%)
<!-- STATS_END -->

## Usage

```bash
git submodule update --init --recursive
npm install
npm run build
npm run download
npm run export
npm run update
```

`npm run download` reads the game version from the latest `ZenlessData` commit message, lets HoyoDown select the reachable region automatically, then downloads the Chinese, English, Japanese, and Korean voice packages into `StreamingAssets`. The download is several gigabytes per language and requires the official CDN to be reachable.
Use `npm run download -- --dry-run` to resolve the four manifests without writing files.

`index.ts` recursively reads PCK archives from `StreamingAssets` by default. Use `VOICE_SOURCE_PATH` or `VOICE_RESULT_PATH` to override those paths.

ZenlessData uses obfuscated config fields, so `update.ts` matches only event-to-audio paths that are unambiguous in both the game config and extracted Wwise banks. Unmatched rows are intentionally retained with blank annotations.

`npm run download` also asks HoyoDown for the official resource catalog and the
small set of blocks containing GalGame Perform assets. During `npm run update`,
TypeScript unpacks their `mhy1`/CAB data and directly pairs each GalScript
node's `dialogueKey` with its exact `externalVoiceKey`/`voiceKey`; no
per-speaker/local ordinal is treated as the scene-global TextMap ordinal.
Use `npm run download -- --perform-only` to refresh only these resources without
checking or downloading the four voice packages.

## Acknowledgements

Speaker, source-path, and transcription links are reconstructed from `ZenlessData` by the repository's hash cracker.

Special thanks to Escartem for [**AnimeWwise**](https://github.com/Escartem/AnimeWwise) and its `nap.map` data. The project provided an important reference for researching and validating Zenless Zone Zero's Wwise source-path naming and filename-hash rules.
