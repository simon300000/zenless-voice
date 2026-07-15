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
