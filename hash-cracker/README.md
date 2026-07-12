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
