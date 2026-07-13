# Repository Guidelines

## Project Structure & Module Organization

The root TypeScript pipeline is deliberately small: `index.ts` extracts voice
archives, `update.ts` enriches metadata from game configs, and `parquet.py`
exports the generated metadata. `ZenlessData/` is the game-data submodule; do
not hand-edit its extracted JSON files. Runtime output belongs in the ignored
`result/` directory, while unextracted game audio is expected under the ignored
`StreamingAssets/` directory.

`hoyo-voice-extractor/` contains the reusable extractor package. Its
TypeScript API is in `index.ts` and `tools.ts`; `quickpck/` and `wwise/` build
the native C++ batch tools. `fnvjs/` is a vendored TypeScript hashing library
with its own build and Jest configuration. Treat `wwise/source/` as curated
third-party decoder code: make changes there only when updating the snapshot.

## Build, Test, and Development Commands

Run `git submodule update --init --recursive` once after cloning, then `npm
install`. Use the following from the repository root:

- `npm run build` builds both CMake tools and TypeScript projects.
- `npm run watch` type-checks both TypeScript projects continuously.
- `npm run export` extracts PCK audio; set `VOICE_SOURCE_PATH` or
  `VOICE_RESULT_PATH` to use non-default locations.
- `npm run update` annotates WAV metadata and refreshes README statistics.
- `python3 parquet.py` produces the final Parquet export.

For focused native work, run `./hoyo-voice-extractor/quickpck/build.sh` or
`./hoyo-voice-extractor/wwise/build.sh`. Run the only existing unit suite with
`npm test` inside `hoyo-voice-extractor/fnvjs/`.

## Coding Style & Naming Conventions

Use ESM TypeScript with two-space indentation, single quotes, no semicolons,
and concise camelCase identifiers, matching the root files. Keep paths
portable using Node's `path` helpers. C++ targets require C++17 and compile
with `-Wall -Wextra -Wpedantic` (or `/W4`); preserve the existing naming and
error-handling style. `fnvjs` alone has ESLint/Prettier settings—do not impose
them on unrelated files without an intentional repository-wide change.

## Testing and Change Validation

There is no root automated test suite yet. At minimum, run `npm run build` for
TypeScript or native-tool changes. For `fnvjs`, run `npm test` in its folder.
Exercise extractor changes on a small audio fixture where possible; do not
commit generated `result/`, `StreamingAssets/`, build directories, or large
game-data replacements.

## macOS Whisper Evidence

Only on macOS running Apple Silicon, use `mlx-whisper` for local ASR audits
instead of the PyTorch/OpenAI Whisper MPS path. This is a macOS-only rule;
other platforms should keep using their appropriate existing Whisper runtime.
Use the model exactly as
`mlx-community/whisper-large-v3-turbo`; keep the default Hugging Face download
address and cache behavior, and do not set `HF_ENDPOINT` or a model mirror.
Network proxy variables are acceptable when required. If the default Xet
transfer stalls behind a proxy, `HF_HUB_DISABLE_XET=1` may be used because it
changes only the transfer backend, not the download address.

For isolated Chinese WAV checks, use `language="zh"`, `temperature=0.0`, and
`condition_on_previous_text=False`. Run many files in one Python process so
the MLX model is loaded only once. Whisper output is evidence for finding or
rejecting associations only: never copy it directly into final metadata.
Final transcription and speaker values must still be supported by game config
or TextMap evidence; leave uncertain fields blank.

## Commits & Pull Requests

The available history contains only `Initial commit`, so no established commit
format exists. Use short imperative subjects, such as `Annotate unmatched voice
events`. Keep commits scoped. PRs should explain the pipeline impact, list
validation commands, link relevant issues, and include before/after metadata
samples for extraction or annotation changes.
