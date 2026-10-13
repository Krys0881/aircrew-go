# Aircrew Go — Android companion for Aircrew (PERSONAL project)

Crew-first Android client: Capacitor 8 + React, Telegram via TDLib (JSON interface over JNI),
messages rendered by the **Mac app's own renderer and stylesheet** (imported from `../ai-gram/src/renderer`
through the `@aircrew` Vite alias — this repo expects `ai-gram` checked out next to it).

## Build (macOS)
Prereqs (free): `brew install openjdk@17 openjdk@21 cmake gperf` + `brew install --cask android-commandlinetools`;
SDK: `platform-tools`, `platforms;android-36`, `build-tools;37.0.0`, `cmake;3.22.1`, `ndk;23.2.8568313`.

1. **TDLib** (once, ~16 min): clone `tdlib/td`, then in `example/android/`
   `./build-openssl.sh <SDK> 23.2.8568313` and
   `./build-tdlib.sh <SDK> 23.2.8568313 third-party/openssl c++_static JSONJava 26 "arm64-v8a"`.
   Copy `tdlib/libs/arm64-v8a/libtdjsonjava.so` → `android/app/src/main/jniLibs/arm64-v8a/` (gitignored).
2. **Credentials**: `node scripts/gen-creds.mjs` (reads `../ai-gram/aircrew.keys.json` → `src/creds.ts`, gitignored).
3. **App**: `npm install && npx vite build && npx cap sync android`, then
   `cd android && JAVA_HOME=$(brew --prefix openjdk@21) ./gradlew assembleDebug`.
   APK: `android/app/build/outputs/apk/debug/app-debug.apk` (sideload; keep the same debug keystore to update in place).

Never commit `src/creds.ts`, `dist/`, `android/app/src/main/assets/public`, `jniLibs`, or keystores.
