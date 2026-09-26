# Plexo

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/anmolkapil)

A fast download manager for Windows, macOS, and Linux that speeds up downloads by pulling chunks in parallel across **multiple network connections at the same time**.

For example, if your computer has:

- Wi-Fi
- Ethernet
- USB-tethered phone (iPhone or Android)
- Cellular

Plexo can utilize all of them simultaneously to download the **same file**.

https://github.com/user-attachments/assets/e57728f4-fb63-441f-839c-174eef954b17

---

## ⚠️ Before you start

### Combining multiple network connections?

To successfully combine bandwidth across multiple network adapters (on Windows, macOS, or Linux):

- **Use distinct internet connections:**
  - Each connection must have its own gateway / subnet (e.g., **Wi-Fi** via home router + **USB Tethering** via mobile phone, or two distinct WAN networks).
  - Connecting both Wi-Fi and Ethernet to the **same router** (same local subnet like `192.168.1.0/24`) will not increase speeds: both share the same upstream broadband connection, and operating system routing will send all packets through whichever interface has the lower metric or higher priority (usually Ethernet).

### Wi-Fi disconnecting when Ethernet is plugged in on Windows?

Some Windows 10/11 installations automatically disconnect or sleep Wi-Fi when an active Ethernet cable is detected.

If Wi-Fi turns off when Ethernet is plugged in: open **Group Policy Editor** (`gpedit.msc`) → _Computer Configuration_ → _Administrative Templates_ → _Network_ → _Windows Connection Manager_ → set **"Minimize the number of simultaneous connections to the Internet or a Windows domain"** to **Disabled**.

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
                    ┌── Wi-Fi (IP: 192.168.1.40) ──────┐
                    │                                  │
                    ├── Ethernet (IP: 10.0.0.12) ──────┤
File ──→ Split ─────┤                                  ├──→ Assembled File
                    ├── USB Tether (IP: 172.20.10.3) ──┤
                    │                                  │
                    └── Cellular (IP: 21.169.64.78) ───┘
```

**Multiple networks → concurrent HTTP range requests → aggregated bandwidth**

---

## Features

- 🚀 **Multi-interface, multi-connection downloads** — splits files into chunks of up to 8 MB and fans them out across worker connections bound to specific network interfaces, each kept open from one chunk to the next. Each interface starts with 8 connections and doubles once they are all receiving, up to 32; if the server refuses one (503, 429, 403), that interface keeps the connections the server accepted.
- 🔌 **Hardware interface detection** — queries Windows adapters via PowerShell `Get-NetAdapter` and macOS hardware ports via `networksetup` so Wi-Fi, Ethernet, tethered iPhones, and Thunderbolt bridges are labeled by real device names instead of bare BSD names (`en0`, `en6`).
- ⚖️ **Dynamic work-stealing queue** — chunks are leased from a shared pending queue; faster networks pull more chunks instead of waiting for slower connections to finish.
- ⏸️ **Resumable downloads** — cleanly pause and resume downloads with progress saved in a destination-side staging file.
- 💾 **Relaunch recovery** — interrupted downloads are restored as paused after Plexo restarts, with a small manifest in application data.
- 🛡️ **Safe, integrity-checked resume** — re-verifies remote `ETag` and `Last-Modified` validators before resuming, refusing to resume (rather than corrupting the file) if the server-side file has changed.
- 🔁 **Automatic retry with backoff** — failed chunks go back to the queue and are retried with jittered exponential backoff (1s–15s). A dropped connection is retried for as long as its network is there; a busy server (429, 503, …) is waited out, honouring `Retry-After`; a server that answers wrongly gets 5 retries.
- 🔄 **Network changes and sleep** — a network that gets a new address, or a computer that wakes from sleep, gets its connections going again at once instead of waiting out a backoff; the computer is kept awake while a download runs.
- 💤 **Stall detection & watchdog** — automatically drops and re-queues connections that remain open but silent (>20s without incoming data, not counting time spent waiting on the disk).
- 🔔 **Desktop notifications** — native desktop alerts when downloads complete or encounter errors.
- 💾 **Upfront disk-space verification** — checks the destination volume before writing the staging file.
- 🔀 **Mid-download redirect handling** — transparently follows 3xx HTTP redirects (up to 5 hops) during probing and individual chunk downloads.
- 📊 **Real-time telemetry** — live throughput graphs, rolling-window ETA calculation, and per-connection transfer stats.
- 🗺️ **Interactive progress grid** — 1:1 visual map of individual chunks, color-coded by the network interface that fetched each chunk with accurate per-network byte attribution.
- 🎨 **Network customization** — rename and recolor physical network interfaces with persistent user preferences.
- 🌓 **Light & Dark modes** — full theme support with an instant toggle between light and dark modes.

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

### 2. Multi-interface socket binding

Every active network interface on your computer has local IP addresses — Wi-Fi might have both IPv4 and IPv6, while a USB-tethered phone has its own addresses.

A standard TCP socket leaves interface selection to the operating system's routing table. Plexo resolves the server, chooses an address of the same IP family on each selected interface, then binds that address for its HTTP/HTTPS connections. On Linux it also pins the socket to the device.

```js
https.request({
  hostname: 'releases.ubuntu.com',
  path: '/ubuntu-26.04.1-desktop-amd64.iso',
  localAddress: '172.20.10.3', // Source address on the USB tether
  headers: {
    Range: 'bytes=8388608-16777215'
  }
})
```

The interface binding keeps each worker on its selected network:

- **No virtual network adapters or VPN tunnels**
- **No packet bonding or link aggregation**
- **No kernel extensions (`kext`) or root privileges**

### 3. Dynamic work-stealing queue

If you statically divide a 6 GB file into equal shares (e.g. 3 GB on Wi-Fi and 3 GB on mobile data), the total download speed is bottlenecked by the slower network.

Instead, Plexo uses a **dynamic work-stealing queue**:

1. The file is split into **chunks of up to 8 MB** (smaller for small files, so every network gets a share).
2. All chunks enter a centralized pending queue.
3. A pool of worker connections continuously lease the next chunk from the queue as soon as they become free. Each keeps its one connection to the server from chunk to chunk, so it pays for the handshake and TCP's slow start once, not per chunk. Connections start interleaved across networks, so each network is served before any is served twice.
   - **How many.** Each network starts with 4. More help only when something limits each connection on its own (a server capping per-connection speed, or a long, lossy route), not once the network itself is full, so Plexo measures instead of guessing. Once speeds have settled, it doubles one network's connections, waits for them to settle again, and keeps them only if that network got at least 15% faster, net of anything the other networks lost beyond their usual ups and downs (two networks behind one router share its uplink). Otherwise the new connections close, and their chunks go back to the queue to carry on from where they got to. So do extra connections the server turns away. Up to 16 per network, and never more than there are chunks for.
4. Faster interfaces finish chunks quicker and immediately pick up new ones; slower interfaces pull fewer chunks.
5. **Racing the tail.** Once no chunk is left waiting, a free connection can start a second attempt at a chunk another connection is fetching too slowly (as soon as the free connection would finish it in under half the time the chunk still needs; a chunk whose second attempt is stuck too can get one more), picking up from where the first had got to. Whichever finishes first wins and the other is dropped. It costs a few bytes fetched twice at the very end, and it means one slow connection — or one slow network — can no longer hold the whole download back. A stream doing this is marked **BACKUP** in the streams table.

```text
Shared Pending Queue: [Chunk #4]  [Chunk #5]  [Chunk #6]  [Chunk #7]  [Chunk #8]  ...
                          ↑           ↑           ↑           ↑
                       Worker 1    Worker 2    Worker 3    Worker 4
                       (Wi-Fi)    (Ethernet) (USB Tether) (Cellular)
```

Work distribution is dynamically proportional to each interface's real-time throughput. If one network slows down or disconnects, remaining workers continue draining the queue without stalled shares.

### 4. Direct-to-destination storage

Each worker writes its assigned byte range at its final offset in one staging file beside the chosen destination. Workers use separate file handles and explicit byte positions, so non-overlapping ranges can be written in parallel.

While downloading, the folder contains `<filename>.plexo` and no empty file under the final name. Once every range is complete, Plexo flushes the partial file, checks for a filename collision, and renames it into place in the same folder. If the final name is taken, Plexo chooses a numbered name. This works on drives such as exFAT without a full-file assembly copy, so the destination needs approximately one file's worth of space.

---

# Downloads are resumable

When you pause a download:

- Plexo aborts all active HTTP socket connections via `AbortController`.
- The staging file remains beside the chosen destination, and progress is saved in a small manifest.

When you resume:

1. **Validator check**: Plexo sends a probe request to compare the server's current `ETag` and `Last-Modified` headers against the values recorded when the download started.
2. **Safe resume**: If the validators match, Plexo resumes each range from the last saved byte offset in the staging file.
3. **Guard against corruption**: If the file on the server has changed, Plexo refuses to resume to prevent combining incompatible slices into a corrupt file.

Download manifests are stored under Plexo's application-data directory; large partial data stays beside the destination. If Plexo quits or crashes during a transfer, it restores that transfer as paused on the next launch. Cancelling or removing a download deletes its staging file.

---

# What is a chunk?

A **chunk** is the atomic unit of work in Plexo:

- **Size**: Up to 8 MB, with the final chunk sized to the remaining bytes. A file that is small next to its connection count gets smaller chunks (never under 1 MB) — at least two per connection — so a fast network can out-pull a slow one instead of being stuck behind it.
- **Transport**: One independent HTTP range request (`Range: bytes=START-END`).
- **Storage**: Written at its final byte offset in the destination-side staging file.
- **Assignment**: Leased to an individual worker socket bound to a specific network interface.

```text
Chunk #0 → Range: bytes=0-8388607         → staging offset 0 (Wi-Fi)
Chunk #1 → Range: bytes=8388608-16777215  → staging offset 8388608 (Ethernet)
Chunk #2 → Range: bytes=16777216-25165823 → staging offset 16777216 (USB Tether)
Chunk #3 → Range: bytes=25165824-33554431 → staging offset 25165824 (Cellular)
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
[Cellular]   → Chunk #7

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
