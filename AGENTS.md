# Agent guidance

This repository extracts Zenless voice audio and annotates it from game-authored evidence. Keep changes scoped to this checkout; `ZenlessData/` and nested tools have separate source histories.

- For setup and pipeline operations, use [dev.md](dev.md).
- For annotation changes, inspect `update.ts`, `galgame-perform.ts` and `hash-cracker/`. Release-specific obfuscated fields must be checked against the selected `ZenlessData` revision.
- For separately requested Apple Silicon ASR audits, use [ASR audit](docs/asr-audit.md). The pipeline has no `VOICE_WHISPER_EVIDENCE` input; ASR must not become authored metadata.

Preserve source-backed event/audio/text relationships and leave ambiguous fields blank. Do not hand-edit extracted game JSON. Keep `result/`, `StreamingAssets/` and native build outputs out of code changes.

Use ESM TypeScript and the surrounding file style. `wwise/source/` is curated third-party decoder code; changes belong to an intentional decoder update.

Finish the requested change and relevant local checks, fixing regressions it causes. Documentation edits need path/command checks; TypeScript and native changes need the affected build or focused fixtures. Do not run full extraction merely to validate prose. Report verification limits.

`parquet.py` uploads to Hugging Face. Downloads, publication, deletion of existing outputs, commits and pushes need authorization for that operation; existing authorization remains valid. Preserve pre-existing work and use a separate output directory for extraction checks.
