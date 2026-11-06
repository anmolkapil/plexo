# Plexo for Android (preview)

Plexo's idea on a phone: download one file over **Wi-Fi, mobile data and Ethernet/USB tether at the
same time**, with each network pulling its own blocks of the file.

No root and no VPN. Android normally keeps only its preferred network up; this app asks for every
kind (`ConnectivityManager.requestNetwork`) and sends each stream through one of them
(`Network.socketFactory` + `Network.getAllByName`).

## How it maps to the desktop app

| Desktop (Electron) | Android (this folder) |
| --- | --- |
| `src/main/network/*` binds sockets to an interface | `NetworkHub.kt` — one `Link` per network, OkHttp client bound to it |
| `src/main/download/plan.ts` block sizes (1–8 MiB) | same sizing in `Engine.kt` |
| `scheduler.ts` pool of blocks + racing the slowest block | `claim()` in `Engine.kt` |
| Networks list, live speed, per-network share bar | `Ui.kt` (Compose, same colour tokens as `main.css`) |
| Saves to a chosen folder | Saves to `Downloads/Plexo` through MediaStore (no storage permission) |

## Not there yet

- Adaptive stream count (desktop doubles streams per network once they all receive data; Android
  starts a fixed 6 per network).
- Torrents, Usenet, Telegram, browser extension, scheduling, speed limits.
- HLS (the parser exists in `src/main/download/hls/` for the desktop engine; no Android transfer yet).
- Resume checks the saved block offsets only; it does not compare ETag/Last-Modified.
- A download that is a single connection (server without ranges) uses one network only.

## Build

CI builds it (`.github/workflows/android.yml`) and attaches `plexo-android.apk` as a build artifact;
push a tag `android-v0.1.0` to publish it as a release. Locally: JDK 17, Android SDK 35, Gradle 8.11+,
then `gradle -p android assembleRelease`.
