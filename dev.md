# Development

## Usage

```bash
git submodule update --init --recursive
npm install
npm run build
npm run download
npm run export
npm run update
```

`npm run download` downloads the Chinese, English, Japanese, and Korean voice packages into `StreamingAssets`.

- `npm run download -- --dry-run`: resolve manifests without downloading files.
- `npm run download -- --perform-only`: refresh only GalGame Perform resources.

Use `VOICE_SOURCE_PATH` and `VOICE_RESULT_PATH` to override the default input and output paths.

`npm run update` uses `ZenlessData` and extracted Wwise data to add source paths, speakers, and transcriptions. Ambiguous matches are left blank.

### Versioned native game-data annotation

`VOICE_DATA_PATH` selects an independent ZenlessData checkout. Set
`VOICE_GAME_DATA_PATH` to the matching Global readable export from
`hoyo-game-data` to use its verified `WemPathMap`, native dialogue nodes, and
localized TextMaps. The adapter checks the release and every consumed file's
inventory SHA-256, verifies path FNV-1 identities, and excludes bubble cues
whose displayed text need not be spoken. It writes native source provenance
and direct dialogue links into the result folder. `TextMap/Index.json` selects
the real native layer files and exposes missing Overwrite layers and revisions.
Lookup uses `overwrite -> main -> login` by key existence, including empty
strings. When the native Overwrite layer is absent, the explicitly recorded
same-release Global ZenlessData Overwrite layer is used above native main;
this is supplemental evidence, not an exported native hot-update claim.
The supplying Git commit, Data revision, layer origins and key counts are
recorded in `native-game-data-provenance.json`.

For isolated comparisons, `VOICE_HASH_MATCHES_PATH`, `VOICE_EVENT_WAVS_PATH`,
`VOICE_README_PATH`, and `VOICE_RESULT_JSON_PATH` select annotation inputs and
side outputs. `VOICE_WAV_PATH` allows an isolated metadata output directory to
reuse an existing verified WAV tree without copying or re-decoding the audio.
`VOICE_GALGAME_PERFORM_PATH` must select resources from the same
release; do not reuse a previous release's Perform resources. The native
export supplies dialogue links without needing those raw Perform resources.
When using an independent data checkout, invoke the hash cracker with explicit
arguments: `hash-cracker/build/bin/zenless-hash-cracker.exe <data> <wav-root> <matches.tsv> 12`.

Compile with `npx tsc -b hoyo-voice-extractor/tsconfig.json tsconfig.json`, then
run `node --test scripts/test-native-game-data.mjs` for the adapter fixtures.
`scripts/verify-voice-packages.py --help` documents the 3.2.0 package MD5 and
native-input comparison; `scripts/report-voice-coverage.py --help` documents
the coverage comparison and complete WAV-header/file-set checks.

## Build and side effects

`npm run build` builds HoyoDown, the native extractor, the hash cracker and TypeScript. `npm run update` runs the hash cracker before annotation and rewrites generated metadata and README statistics. Inspect `package.json` for individual build commands.

Extraction defaults to `StreamingAssets/`; generated audio is in `result/wav/`. Annotation also uses `hash-matches.tsv`, `event-wavs.tsv`, and GalGame Perform resources. `VOICE_HASH_MATCHES_PATH` and `VOICE_GALGAME_PERFORM_PATH` select alternative inputs. The current code does not read `VOICE_WHISPER_EVIDENCE`.

`python parquet.py` uploads metadata, audio and speaker archives to Hugging Face. It is a publication step, not a local Parquet-only or validation command. Run only within an authorized publication task.

For native-only work, use the matching `build.ps1` on Windows or `build.sh` on macOS/Linux under `hoyo-voice-extractor/quickpck` or `wwise`. The nested `fnvjs` package has its own tests; run them when changing that component. Use an isolated output for audio fixtures.
