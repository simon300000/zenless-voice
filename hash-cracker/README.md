# Zenless hash cracker

Run these commands from the repository root:

```sh
npm run build:hash-cracker
npm run crack
```

The npm commands support Windows, Linux, and macOS. Native build scripts are
also available:

```sh
# Linux/macOS
./hash-cracker/build.sh

# Windows PowerShell
./hash-cracker/build.ps1
```

`VOICE_HASH_THREADS` sets the worker thread count. By default, the cracker uses
the number of hardware threads reported by the operating system.

`VOICE_RESULT_PATH` changes the input directory containing `wav/` and `wem/`.
The default is `result/`.

When `StreamingAssets/GalGamePerform/manifest.json` is available, `npm run
crack` also extracts the official GalScript `voiceKey` values and adds them to
the filename dictionary automatically. GalScript leaves first try only the
speaker-compatible official `VoiceData` prefixes; the full prefix set remains
as a fallback for authored directory aliases. `VOICE_GALGAME_PERFORM_PATH`
changes that resource directory.
