<p align="center">
  <img src="build/icon.png" width="128" alt="Plexo icon">
</p>

<h1 align="center">Plexo</h1>

<p align="center">
  Download files and torrents faster by combining all your internet connections.<br>
  Plexo combines Wi-Fi, Ethernet, mobile networks, and other available connections to boost your download speeds.
</p>

<p align="center">
  <a href="https://getplexo.app">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="packages/plexo-cli">CLI</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#build-from-source">Build</a>
</p>

<p align="center">
  <a href="https://github.com/anmolkapil/plexo/releases/latest"><img src="https://img.shields.io/github/v/release/anmolkapil/plexo?label=release" alt="Latest release"></a>
  <a href="https://github.com/anmolkapil/plexo/releases"><img src="https://img.shields.io/github/downloads/anmolkapil/plexo/total" alt="Downloads"></a>
  <a href="https://github.com/anmolkapil/plexo/actions/workflows/ci.yml"><img src="https://github.com/anmolkapil/plexo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="https://getplexo.app/#downloads"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-black" alt="macOS, Windows and Linux"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/anmolkapil/plexo" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://ko-fi.com/I5Q128RXSP"><img src="https://storage.ko-fi.com/cdn/kofi6.png" height="48" alt="Buy me a coffee on Ko-fi"></a>
</p>

<p align="center">
  For anything private, email <a href="mailto:hello@getplexo.app"><strong>hello@getplexo.app</strong></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/240800?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-240800" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/240800/daily?language=TypeScript" alt="anmolkapil%2Fplexo | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/240800?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-240800" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/240800/daily" alt="anmolkapil%2Fplexo | Trendshift" width="250" height="55"/></a>
  <a href="https://trendshift.io/repositories/240800?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-240800" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/240800/weekly?language=TypeScript" alt="anmolkapil%2Fplexo | Trendshift" width="250" height="55"/></a>
</p>

https://github.com/user-attachments/assets/e57728f4-fb63-441f-839c-174eef954b17

## Features

### Multi-network downloads

- Combine multiple internet connections for faster downloads
- Enable or disable networks during a download
- Rename networks and customize their colors
- Download file chunks in parallel across connections
- Balance chunks across connections, with faster networks handling more of the download
- Automatically adjust parallel streams to network, server and disk performance
- Race slow chunks on idle connections to avoid a slow finish
- View live speeds, time remaining and per-network progress

### Browser integration

- Capture downloads or send individual links to Plexo
- Download files using your browser’s authenticated session
- Exclude websites and skip small files

### Download management

- Download direct links, magnet links and `.torrent` files
- Select torrent files before or during a download
- Pause and resume supported downloads across restarts
- Automatically reconnect downloads after sleep
- Replace expired links without losing progress
- Queue downloads and configure concurrent downloads
- Pause, resume, retry or remove downloads in bulk

### Bandwidth controls

- Set global and per-network speed limits
- Switch to Slow mode for calls and streaming
- Set daily, weekly or monthly data allowances
- Schedule downloads by time and day

### Standalone CLI (`plexo-cli`)

- Lightweight terminal-first multi-network bonding: `pip install plexo-cli`
- Supports direct range bonding, multi-source mirrors (`-m`), sequential video streaming (`--sequential`), torrent multi-homing (`plexo torrent`), per-adapter quotas (`-q`), clipboard watching (`plexo watch`), and local acceleration proxy (`plexo proxy`).
- See [packages/plexo-cli](packages/plexo-cli) for detailed documentation and guides.

## Troubleshooting

If your problem isn't covered here, [open an issue](https://github.com/anmolkapil/plexo/issues).

<details>
<summary><strong>Windows says "Windows protected your PC"</strong></summary>
<br>

The installer isn't code-signed yet. Click **More info**, then **Run anyway**.

</details>

<details>
<summary><strong>A second network doesn't make downloads faster</strong></summary>
<br>

Plexo adds speed only when each network reaches the internet through its own connection. Wi-Fi from your home router plus a phone tethered over USB works. Wi-Fi and Ethernet plugged into the same router doesn't: both share one connection, so the total stays the same.

VPN, virtual, and isolated adapters show up in Plexo too, so check each network's latency and speed there.

</details>

<details>
<summary><strong>A network doesn't appear in Plexo</strong></summary>
<br>

Plexo can use any connection your operating system shows as a network adapter.

- **iPhone on macOS**: in **System Settings › Network**, open **iPhone USB** and turn off **Disable unless needed**
- **Android on macOS**: install TetherKit, as described below
- **Phone on Windows**: install your phone maker's driver if the phone doesn't appear in Network Settings

</details>

<details>
<summary><strong>Windows uses only one network</strong></summary>
<br>

If Windows turns Wi-Fi off when Ethernet is plugged in, open the Group Policy Editor (`gpedit.msc`), go to _Computer Configuration_ › _Administrative Templates_ › _Network_ › _Windows Connection Manager_, and set **Minimize the number of simultaneous connections to the Internet or a Windows domain** to **Disabled**.

If both stay connected but one sits idle in Plexo, Windows may be sending its traffic out the other network. Add your setup to [#65](https://github.com/anmolkapil/plexo/issues/65).

</details>

<details>
<summary><strong>A network stays idle after reconnecting a phone</strong></summary>
<br>

Pause the download, then resume it.

</details>

<details>
<summary><strong>Downloads to a hard drive are slow</strong></summary>
<br>

Leave **Streams** on **Auto** in **New download**. Auto lowers the streams when the disk can't keep up; a fixed number doesn't.

</details>

### Use an Android phone over USB on macOS

macOS has no driver for RNDIS, the protocol Android's USB tethering uses, so the phone charges but no network adapter appears. [TetherKit](https://github.com/XiaoMiku01/TetherKit) is an open-source app that adds one without a kernel extension.

1. Install TetherKit: `brew install XiaoMiku01/tap/tetherkit`
2. Connect your phone over USB.
3. On the phone, open **Settings › Network & internet › Hotspot & tethering** and turn on **USB tethering**.
4. Open TetherKit. On first run, approve its helper with your password.
5. Pick your phone, click **Connect**, then apply the IP settings.
6. Open Plexo. The phone appears in the networks list.

Thanks to [@XiaoMiku01](https://github.com/XiaoMiku01) for building and open-sourcing TetherKit.

## How it works

Plexo downloads different parts of the same file through each internet connection you select, then assembles them on disk.

For direct downloads, Plexo uses HTTP range requests to fetch chunks in parallel. Streams take new chunks from a shared queue as they finish, so faster connections handle more of the file. Plexo adjusts stream counts to network, server and disk performance. Near the end, idle streams can race slow chunks; the first to finish wins. Servers without range support use a single stream.

For torrents, Plexo distributes peer connections across your selected networks. New peers connect through the network with the fewest peers.

Each network needs its own internet connection to add bandwidth. Plexo combines connections for its own downloads and requires no VPN or virtual network adapter.

## Build from source

You need Node.js 22.13 or later and npm 9 or later.

```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo
npm ci
npm run dev
```

| Command                   | What it does                                                  |
| ------------------------- | ------------------------------------------------------------- |
| `npm run test:e2e:smoke`  | Playwright smoke tests                                        |
| `npm run test:e2e`        | The full end-to-end suite                                     |
| `npm run build:mac`       | Creates macOS packages in `dist/`                             |
| `npm run build:win`       | Creates the Windows installer in `dist/`                      |
| `npm run build:unpack`    | Creates an unpacked app for the current platform in `dist/`   |
| `npm run build:linux`     | Creates AppImage, `.deb`, `.rpm` and `.tar.gz` in `dist/`     |
| `npm run build:extension` | Builds the Chrome and Firefox extensions in `extension/dist/` |

Run platform packaging commands on the corresponding operating system. Local builds are unsigned unless signing credentials are configured. [CONTRIBUTING.md](CONTRIBUTING.md) covers packaging requirements, extension setup and testing.

## Contributing

Start with [open issues](https://github.com/anmolkapil/plexo/issues), or contribute a reproducible bug report, a fix, network compatibility testing or documentation improvements.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, required checks and pull request guidance. For a substantial feature, [open an issue](https://github.com/anmolkapil/plexo/issues/new) to discuss the approach before implementing it.

## Acknowledgements

Special thanks to [Dhananjay Bhosale](https://github.com/DhananjayBhosale) for code signing and notarizing the macOS app.

## License

[MIT](LICENSE), copyright 2026 Anmol Kapil.
