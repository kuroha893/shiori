#!/bin/sh
# Builds the now-playing library into resources/native, next to the perl script that loads it.
# Needs Apple's command line tools (xcode-select --install).
set -e
cd "$(dirname "$0")/.."
out=resources/native
mkdir -p "$out"
# The command line tools can carry a newer SDK than their own linker understands; the one for this macOS links.
sdk="$(xcrun --show-sdk-path)"
mine="$(dirname "$sdk")/MacOSX$(sw_vers -productVersion | cut -d. -f1).sdk"
[ -d "$mine" ] && sdk="$mine"
clang -isysroot "$sdk" -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 -dynamiclib -fobjc-arc -fvisibility=default -O2 \
  -framework Foundation -framework AppKit \
  -o "$out/libShioriNowPlaying.dylib" native/nowplaying/nowplaying.m
codesign --force --sign - "$out/libShioriNowPlaying.dylib"
cp native/nowplaying/nowplaying.pl "$out/nowplaying.pl"
