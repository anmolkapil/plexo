# Plexo

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/anmolkapil)

A fast download manager for Windows, macOS, and Linux that speeds up downloads by pulling chunks in parallel across **multiple network connections at the same time**.

For example, if your computer has:

- Wi-Fi
- Ethernet
- USB-tethered phone (iPhone or Android)

Plexo can utilize all of them simultaneously to download the **same file**.

https://github.com/user-attachments/assets/e57728f4-fb63-441f-839c-174eef954b17

---

## ⚠️ Before you start

### Using Android USB tethering on macOS?

macOS does not natively provide an RNDIS driver, so Android phones with USB tethering enabled won't appear as network interfaces out of the box (this is also why legacy kernel extensions like `HoRNDIS` stopped working on Apple Silicon and modern macOS).

To use your Android phone's connection over USB, install **TetherKit** — a kext-free, user-space RNDIS driver.

See [Using a USB-tethered Android phone](#using-a-usb-tethered-android-phone) for setup instructions.

> Plexo can only route traffic through connections that your operating system recognizes as network interfaces.

---

## Why Plexo?

A single TCP connection rarely saturates your actual bandwidth. Even when your computer has multiple active networks — such as Wi-Fi and a tethered mobile phone — the operating system routes all traffic through a single default gateway, leaving the other interfaces completely idle.

Plexo changes that: it splits the file into independent byte ranges and downloads them simultaneously through distinct physical network interfaces.

```text
                    ┌── Wi-Fi (IP: 192.168.1.40) ────┐
                    │                                │
File ──→ Split ─────┼── Ethernet (IP: 10.0.0.12) ────┼──→ Assembled File
                    │                                │
                    └── USB Tether (IP: 172.20.10.3) ┘
```

**Multiple networks → concurrent HTTP range requests → aggregated bandwidth**

---

## Features

- 🚀 **Multi-interface, multi-connection downloads** — splits files into chunks of up to 8 MB and fans them out across worker connections bound to specific network interfaces (up to 8 parallel connections per interface, 32 total).
- 🔌 **Hardware interface detection** — queries Windows adapters via PowerShell `Get-NetAdapter` and macOS hardware ports via `networksetup` so Wi-Fi, Ethernet, tethered iPhones, and Thunderbolt bridges are labeled by real device names instead of bare BSD names (`en0`, `en6`).
- ⚖️ **Dynamic work-stealing queue** — chunks are leased from a shared pending queue; faster networks pull more chunks instead of waiting for slower connections to finish.
- ⏸️ **Resumable downloads** — cleanly pause or retry failed downloads without losing progress, preserving completed `part-N` chunk files on disk.
- 💾 **Relaunch recovery** — interrupted downloads are restored as paused after Plexo restarts, with progress and part files preserved in application data.
- 🛡️ **Safe, integrity-checked resume** — re-verifies remote `ETag` and `Last-Modified` validators before resuming, refusing to resume (rather than corrupting the file) if the server-side file has changed.
- 🔁 **Automatic retry with backoff** — failed chunks are automatically returned to the queue and retried with exponential backoff (up to 5 retries, 1s–15s backoff).
- 💤 **Stall detection & watchdog** — automatically drops and re-queues connections that remain open but silent (>20s without incoming data).
- 🔔 **Desktop notifications** — native desktop alerts when downloads complete or encounter errors.
- 💾 **Upfront disk-space verification** — verifies free disk space before writing any temporary part files.
- 🔀 **Mid-download redirect handling** — transparently follows 3xx HTTP redirects (up to 5 hops) during probing and individual chunk downloads.
- 📊 **Real-time telemetry** — live throughput graphs, rolling-window ETA calculation, and per-connection transfer stats.
- 🗺️ **Interactive progress grid** — 1:1 visual map of individual chunks, color-coded by the network interface that fetched each chunk with accurate per-network byte attribution.
- 🎨 **Network customization** — rename and recolor physical network interfaces with persistent user preferences.
- 🌓 **Light & Dark modes** — full theme support with an instant toggle between light and dark modes.
- 🧩 **Chrome & Edge Companion Extension** — automatically captures downloads from Chromium browsers, forwards authenticated session cookies, and transfers files into Plexo (see [`companion-extension/`](companion-extension/README.md)).

---

# How it works

Instead of downloading a file linearly over a single socket, Plexo requests arbitrary slices of the file simultaneously across multiple physical network interfaces. Three core technical primitives make this work:

### 1. HTTP range requests (`206 Partial Content`)

Most modern HTTP servers support byte-level slicing:

```http
GET /ubuntu-26.04.1-desktop-amd64.iso HTTP/1.1
Host: releases.ubuntu.com
Range: bytes=8388608-16777215
```

Servers advertise this capability with the `Accept-Ranges: bytes` response header and reply with HTTP status `206 Partial Content`. Because byte slices are stateless and independent, Plexo can request dozens of chunks at once, in any order, and stitch them together later.

#### Probing before downloading

Before starting a multi-connection download, Plexo sends a **1-byte ranged GET** (`Range: bytes=0-0`), following any redirects:

- Unlike a `HEAD` request (which servers and CDNs frequently misreport), receiving a `206 Partial Content` response conclusively proves that range requests are supported and functional.
- The probe response provides the total file size (`Content-Range` / `Content-Length`), suggested filename (`Content-Disposition`), and cache validators (`ETag` and `Last-Modified`).
- If the server answers with `200 OK` (ignoring the `Range` header), Plexo falls back to a standard single-connection stream instead of failing.

### 2. Multi-interface socket binding via `localAddress`

Every active network interface on your computer has its own local IP address — Wi-Fi might be `192.168.1.40`, while a USB-tethered phone is `172.20.10.3`.

A standard TCP socket leaves interface selection to the operating system's routing table. However, Node.js allows outbound HTTP/HTTPS requests to explicitly bind to a specific local IP using the `localAddress` option:

```js
https.request({
  hostname: 'releases.ubuntu.com',
  path: '/ubuntu-26.04.1-desktop-amd64.iso',
  localAddress: '172.20.10.3', // Forces this connection through the USB tether
  headers: {
    Range: 'bytes=8388608-16777215'
  }
})
```

This single option is Plexo's entire multi-network routing engine:

- **No virtual network adapters or VPN tunnels**
- **No packet bonding or link aggregation**
- **No kernel extensions (`kext`) or root privileges**
- **Zero native C/C++ dependencies**

### 3. Dynamic work-stealing queue

If you statically divide a 6 GB file into equal shares (e.g. 3 GB on Wi-Fi and 3 GB on mobile data), the total download speed is bottlenecked by the slower network.

Instead, Plexo uses a **dynamic work-stealing queue**:

1. The file is split into **chunks of up to 8 MB** (smaller for small files, so every network gets a share).
2. All chunks enter a centralized pending queue.
3. A pool of worker connections (up to 8 per interface, 32 total, never more than there are chunks to work on) continuously lease the next chunk from the queue as soon as they become free. Connections start interleaved across networks, so each network is served before any is served twice.
4. Faster interfaces finish chunks quicker and immediately pick up new ones; slower interfaces pull fewer chunks.
5. **Racing the tail.** Once no chunk is left waiting, a free connection can start a second attempt at a chunk another connection is fetching too slowly (one that still needs as long again as it has already taken, at least 5 seconds), picking up from where the first had got to. Whichever finishes first wins and the other is dropped. It costs a few bytes fetched twice at the very end, and it means one slow connection — or one slow network — can no longer hold the whole download back. A stream doing this is marked **BACKUP** in the streams table.

```text
Shared Pending Queue: [Chunk #4] [Chunk #5] [Chunk #6] [Chunk #7] [Chunk #8] ...
                            ↑           ↑           ↑
                         Worker 1    Worker 2    Worker 3
                         (Wi-Fi)     (Ethernet)  (USB Tether)
```

Work distribution is dynamically proportional to each interface's real-time throughput. If one network slows down or disconnects, remaining workers continue draining the queue without stalled shares.

### 4. File reassembly & stream pipeline

Each worker writes its assigned byte range directly to an isolated temporary file on disk (`part-0`, `part-1`, ... `part-N`).

Once the queue is drained and all chunk promises resolve:

- Plexo streams each `part-N` file sequentially into the final destination file using Node.js streams (`createReadStream` piped into `createWriteStream` with `{ flags: 'a' }`).
- The temporary chunk directory is cleaned up.
- The assembled file is verified against the expected byte length.

---

# Downloads are resumable

When you pause a download:

- Plexo aborts all active HTTP socket connections via `AbortController`.
- All completed `part-N` files remain cached on disk in a temporary directory.

When you resume:

1. **Validator check**: Plexo sends a probe request to compare the server's current `ETag` and `Last-Modified` headers against the values recorded when the download started.
2. **Safe resume**: If the validators match, Plexo checks which `part-N` files are already complete on disk, skips them, and queues only the remaining chunks.
3. **Guard against corruption**: If the file on the server has changed, Plexo refuses to resume to prevent combining incompatible slices into a corrupt file.

Download manifests and partial data are stored under Plexo's application-data directory. If Plexo
quits or crashes during a transfer, it restores that transfer as paused on the next launch. Explicitly
cancelling or removing a download still deletes its partial data.

---

# What is a chunk?

A **chunk** is the atomic unit of work in Plexo:

- **Size**: Up to 8 MB, with the final chunk sized to the remaining bytes. A file that is small next to its connection count gets smaller chunks (never under 1 MB) — at least two per connection — so a fast network can out-pull a slow one instead of being stuck behind it.
- **Transport**: One independent HTTP range request (`Range: bytes=START-END`).
- **Storage**: Written directly to an isolated `part-N` file in the download's temp directory.
- **Assignment**: Leased to an individual worker socket bound to a specific network interface.

```text
Chunk #0 → Range: bytes=0-8388607         → part-0 (Wi-Fi)
Chunk #1 → Range: bytes=8388608-16777215  → part-1 (Ethernet)
Chunk #2 → Range: bytes=16777216-25165823 → part-2 (USB Tether)
```

### Why up to 8 MB?

8 MB provides the optimal balance: large enough to minimize HTTP connection overhead and TLS handshakes, yet small enough to keep the work-stealing queue fluid, ensure fine-grained load balancing across mismatched connections, and keep retries cheap (a failed or stalled connection only discards at most 8 MB). Below about 1 MB a request costs more in round trips than splitting saves, so that is the floor; a file that small is one chunk.

---

# What is the progress grid?

The progress grid provides a real-time visual map of the entire download.

Every chunk maps **1:1 to its own square** in the grid. Square #N directly corresponds to the **Chunk #N** badge shown in the active streams table, allowing you to cross-reference active connections with their location in the file.

```text
Active Streams:
[Wi-Fi]      → Chunk #4
[Ethernet]   → Chunk #5
[USB Tether] → Chunk #6

Progress Grid:
[#1][#2][#3][#4][#5][#6][#7][#8]...
```

---

# Getting started

Plexo currently doesn't have pre-built releases, so you'll need to run it from source.

## Requirements

- **Windows 10/11, macOS, or Linux**: Windows uses its built-in Windows PowerShell for adapter metadata; macOS uses `networksetup`; Linux provides fallback interface detection and desktop network settings integration.
- **Node.js**: 22.12+ (Node 22 LTS recommended).
- **npm**: v9+ recommended.

---

## Run Plexo locally

Clone the repository:

```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo
```

Install dependencies:

```bash
npm install
```

Start the application in development mode:

```bash
npm run dev
```

---

## Running tests

Plexo includes an automated end-to-end test suite driven by Playwright:

```bash
npm run test:e2e:smoke          # quick smoke tests
npm run test:e2e                # full E2E test suite (including integrity and chaos tests)
```

See [CONTRIBUTING.md](CONTRIBUTING.md#end-to-end-tests) for testing options and debugging flags.

---

# Build the macOS app

To package Plexo as a standalone macOS application bundle:

```bash
npm run build:mac
```

The compiled application will be generated at:

```text
dist/mac/Plexo.app
```

> **Note on Gatekeeper:** The app is unsigned because it is not distributed with a paid Apple Developer certificate. However, because you compile it locally on your machine, macOS will not apply the quarantine flag (`com.apple.quarantine`). Gatekeeper only quarantines files downloaded from the web (via browsers, curl, etc.), so your locally built `Plexo.app` will launch cleanly without quarantine warnings.

## Build the Windows app

Run these commands from PowerShell in the project directory:

```powershell
npm install
npm run build:win
```

The installer is generated at `dist/plexo-1.0.0-setup.exe`. For an unpacked app, run
`npm run build:unpack` and launch `dist/win-unpacked/plexo.exe`.
Local builds are unsigned.

Windows uses native window controls, Ctrl+V hints, File Explorer integration, and Windows
Network Settings. Download filenames are normalized to Windows filename rules.

### USB tethering on Windows

Enable USB tethering on your phone and check that its adapter appears in Windows Network
Settings. Install the phone manufacturer's Windows driver if Windows does not recognize it.
TetherKit is only needed for the macOS setup below.

Each selected network needs a working IPv4 connection and a route to the download server.
Adapter detection does not guarantee Internet access: VPN, virtual, and isolated adapters may
also appear. Check per-network latency and transfer stats. Combined throughput depends on the
networks, Windows routing, and the server; it needs testing with your particular connections.

Linux packaging remains available via `npm run build:linux` (see [Build the Linux app](#build-the-linux-app)).

---

## Build the Linux app

To package Plexo for Linux:

```bash
npm run build:linux
```

The package will be generated in `dist/`.

---

# Using a USB-tethered Android phone

Android USB tethering requires an additional setup step on macOS.

macOS lacks native support for the **RNDIS (Remote Network Driver Interface Specification)** protocol. An Android phone with USB tethering enabled will charge and support MTP/ADB, but macOS will not expose it as a network interface (this is also why legacy kernel extensions like `HoRNDIS` stopped functioning on modern macOS and Apple Silicon).

## Install TetherKit

[TetherKit](https://github.com/XiaoMiku01/TetherKit) is an open-source, kext-free, user-space RNDIS driver that makes Android USB tethering available as a standard network interface on macOS.

Install it via Homebrew:

```bash
brew install XiaoMiku01/tap/tetherkit
```

### Steps:

1. Connect your Android device via USB.
2. On your phone, navigate to **Settings → Network & Internet → Hotspot & tethering** and enable **USB tethering**.
3. Once TetherKit is active, macOS registers the device as a network interface.
4. Open Plexo — the new interface will be automatically detected and ready to carry download chunks.

Special thanks to [@XiaoMiku01](https://github.com/XiaoMiku01) for developing and open-sourcing TetherKit!

---

# Contributing

Contributions are welcome! Whether you're optimizing download concurrency, improving UI responsiveness, or testing new tethering setups:

- 🐛 Fix bugs & edge cases
- 🚀 Improve download engine & socket throughput
- 🌐 Expand multi-interface detection to other platforms (Linux)
- 🎨 Enhance UI/UX and dark mode styling
- 🧪 Test diverse multi-network environments (5G tethering, Wi-Fi 6, 10GbE)
- 📖 Improve documentation & guides

For development setup, coding standards, and PR workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Tech stack

Plexo is built with:

- **Electron** — desktop runtime
- **React 19** — declarative UI
- **Tailwind CSS v4** & **Base UI** — modern styling and accessible component primitives
- **TypeScript** — end-to-end type safety
- **Zustand** — lightweight client state management
- **Lucide React** — icons
- **Playwright** — end-to-end testing suite
- **electron-vite** — fast HMR and build tooling
- **electron-builder** — multi-platform packaging (macOS, Windows, Linux)

---

# Support

If Plexo is useful to you, you can support it by:

- ⭐ Starring the repo
- 🐛 [Reporting bugs and suggesting features](https://github.com/anmolkapil/plexo/issues)
- ❤️ [Sponsoring development](https://github.com/sponsors/anmolkapil)

---

# License

MIT — see [LICENSE](LICENSE).
