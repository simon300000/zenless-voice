# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Zenless Zone Zero voice dataset pipeline. Extracts voice audio from PCK archives, annotates metadata by cross-referencing game configs, and publishes to Hugging Face at `simon3000/zenless-voice`.

This project follows the shared 3-stage pattern documented in the monorepo-level `../CLAUDE.md`. This file covers only what differs from that pattern.

## Commands

```bash
npm run build    # Build native extractor tools + type-check TypeScript
npm run watch    # Continuous type-checking
npm run export   # node index.js — extract PCK → WAV
npm run update   # node update.js — annotate metadata, update README stats
python3 parquet.py  # Push to Hugging Face Hub
```

## How annotation works (zenless-specific)

ZenlessData ships with **obfuscated field names** — unlike GenshinData/StarRailData, field names change per release. So `update.ts` cannot reference known keys. Instead it uses three independent matching layers:

### 1. Config traversal (event → text discovery)

Recursively walks every JSON in `ZenlessData/FileCfg/` and `ZenlessData/Data/`. For each record containing a string matching `Play_VO`, `Stop_VO`, `Play_Amb_VO`, etc., it collects all TextMap IDs found in the same record. A transcript candidate must:
- Exist in both Chinese and English TextMaps
- Contain sentence-ending punctuation in both languages
- Be 4+ characters long

### 2. Wwise BNK parsing (event → audio source)

Parses BNK files (already unpacked to `result/wem/`) for HIRC objects:
- **Type 2 (Sound)**: Contains embedded source audio IDs (matching wav filenames)
- **Type 3 (Action)**: Links sounds to events
- **Type 4 (Event)**: The voice event, identified by FNV-1 32-bit hash of its name

The chain is: event name → FNV-1 hash → BNK event ID → action IDs → sound IDs → source (wav) IDs.

### 3. Speaker inference (fallback)

`AvatarBaseTemplateTb.json` provides English display names (e.g., "Anby") keyed by internal aliases. If a config record didn't include a speaker, `update.ts` checks whether the event name contains exactly one known avatar alias and assigns that speaker.

### Whisper evidence (optional)

Set `VOICE_WHISPER_EVIDENCE=/path/to/whisper.jsonl` to provide ASR transcripts. Each line: `{"filename": "/absolute/path.wav", "transcript": "..."}`. The transcript is normalized and matched against TextMap — only exact 1:1 matches are accepted. When a Whisper match contradicts a config-derived transcript, the config annotation is discarded (Whisper + TextMap exact match is considered stronger).

### macOS Whisper runtime

Only on macOS running Apple Silicon, generate local Whisper evidence with
`mlx-whisper` instead of the PyTorch/OpenAI Whisper MPS path. This is a
macOS-only rule; other platforms should keep using their appropriate existing
Whisper runtime. Use the model exactly as
`mlx-community/whisper-large-v3-turbo`; keep the default Hugging Face download
address and cache behavior, and do not set `HF_ENDPOINT` or a model mirror.
Network proxy variables are acceptable when required. If the default Xet
transfer stalls behind a proxy, `HF_HUB_DISABLE_XET=1` may be used because it
changes only the transfer backend, not the download address.

For isolated Chinese WAV checks, use `language="zh"`, `temperature=0.0`, and
`condition_on_previous_text=False`, and process many files in one Python
process so the model loads only once. MLX Whisper output remains evidence only:
do not write it directly into final metadata. Preserve the existing exact
TextMap-backed acceptance rule and leave uncertain fields blank.

## Key differences from sibling projects

| Aspect | genshin-voice | starrail-voice | zenless-voice |
|--------|---------------|----------------|---------------|
| Game data | `GenshinData/` | `StarRailData/` | `ZenlessData/` |
| Extraction | Single PCK pass | Two-pass (PCK → BNK) | Single PCK pass |
| Config fields | Known keys | Known keys | **Obfuscated** — heuristic traversal |
| Event matching | FNV-1 64-bit hash | FNV-1 64-bit hash | FNV-1 32-bit hash (via BNK HIRC parse) |
| Speaker source | Config fields | Config fields | AvatarBase alias inference |
| Whisper | Not supported | Not supported | `VOICE_WHISPER_EVIDENCE` env var |

## Submodules

- `hoyo-voice-extractor/` — shared extraction library (same as sibling projects)
- `ZenlessData/` — game data from `https://git.mero.moe/dimbreath/ZenlessData.git`

## Environment variables

| Variable | Purpose |
|----------|---------|
| `VOICE_SOURCE_PATH` | Override PCK source directory (default: `StreamingAssets/Audio/Windows/Full`) |
| `VOICE_RESULT_PATH` | Override output directory (default: `result/`) |
| `VOICE_WHISPER_EVIDENCE` | Path to Whisper JSONL evidence file for transcript matching |
