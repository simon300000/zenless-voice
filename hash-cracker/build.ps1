$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
cmake -S $Root -B "$Root/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$Root/build" --config Release

