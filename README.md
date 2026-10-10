# Plexo

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors)](https://github.com/sponsors/anmolkapil)

Plexo is a download manager for Windows, macOS, and Linux that downloads one file over several internet connections at the same time. If your computer has Wi-Fi and a phone tethered over USB, Plexo uses both for the same download. It handles direct links, magnet links, and `.torrent` files, with a queue, a downloads list, and speed and data limits for each network.

https://github.com/user-attachments/assets/e57728f4-fb63-441f-839c-174eef954b17

## Download Plexo

Get the installer for your computer from [getplexo.app](https://getplexo.app/#downloads), or pick a file from [GitHub Releases](https://github.com/anmolkapil/plexo/releases). Builds are available for macOS (Apple silicon and Intel), Windows 10 and 11 (x64 and ARM64), and Linux (AppImage and `.deb`, x86_64 and ARM64).

Plexo isn't code-signed yet, so the first launch needs one extra step:

- **macOS** says Plexo is damaged: move it to Applications, run `xattr -dr com.apple.quarantine /Applications/Plexo.app` in Terminal, and open it again
- **Windows** shows "Windows protected your PC": click **More info**, then **Run anyway**

## What Plexo does

Plexo splits each download across every network you select, so a second connection adds to your speed instead of sitting idle.

### Direct downloads

- **Several networks, many streams each**: a file is split into blocks of up to 8 MB that streams on every network fetch in parallel. Each network starts with 8 streams and doubles to 16 and 32 once they're all receiving. You can also pick a fixed 4, 8, 16, or 32 in the **New download** dialog.
- **Faster networks do more of the work**: a stream takes the next block as soon as it's free, so a fast network fetches more blocks than a slow one.
- **No slow finish**: near the end, a free stream races a slow block from where it got to, and the first to finish wins
- **Pause and resume**: progress is saved as you go. Before resuming, Plexo checks the file on the server hasn't changed, and refuses rather than mixing two versions.
- **Survives restarts and sleep**: a download running when Plexo quits comes back paused. Streams restart as soon as the computer wakes or a network gets a new address, and Plexo keeps the computer awake while a download runs.
- **Fix expired links**: paste a fresh link to the same file and the download carries on from where it stopped
- **Backs off when a server asks**: if a server refuses some streams (403, 429, 503, or no answer), that network drops to the streams it accepted, then gets one more back each minute

### Torrents

- **Magnet links and `.torrent` files**: paste a link or open a file in Plexo. You can also open a `.torrent` with Plexo from your file manager, and on macOS and Linux, a magnet link from your browser. Plexo never makes itself the default over a torrent client you already have.
- **Choose files**: pick which files to download before it starts, and change your choice while it runs
- **Peers spread across networks**: each new peer connects through the network with the fewest. Switching a network off moves its peers to the others.
- **Uploads on every network**: peers get pieces back over each network, USB-tethered ones included, so they keep sending to you

### Queue and downloads list

- **Queue**: two downloads run at once by default, and you can set one to eight. The rest wait and start on their own when a slot opens.
- **Downloads list**: downloads are grouped as Downloading, Queued, Paused, Needs attention, and Finished, and finished downloads stay in the list after a restart
- **Actions on several downloads at once**: select downloads to pause, resume, retry, cancel, remove them from the list, or move their files to Trash
- **Links from the clipboard**: opening **New download** fills in a link you've copied

### Limits and networks

- **Speed limits**: a total limit for all downloads, a per-network limit, and **Slow mode**, a one-click lower limit (2 MB/s by default) for when you're on a call
- **Data limits**: a daily, weekly, or monthly allowance per network. Plexo stops using a network once its allowance is used up.
- **Named networks**: Plexo shows adapters by their real names (Wi-Fi, Ethernet, iPhone) instead of `en0`. You can rename and recolor them.
- **Live view**: throughput charts, time left, per-stream stats, and a grid of every block colored by the network that fetched it

## Set up more than one network

Plexo adds speed only when each network reaches the internet through its own connection. Wi-Fi from your home router plus a phone tethered over USB works. Wi-Fi and Ethernet plugged into the same router doesn't: both share the router's single connection, so the total stays the same.

Plexo can only use a connection your operating system shows as a network adapter. Two setups need an extra step:

- **Windows turns Wi-Fi off when Ethernet is plugged in**: open the Group Policy Editor (`gpedit.msc`), go to _Computer Configuration_ › _Administrative Templates_ › _Network_ › _Windows Connection Manager_, and set **Minimize the number of simultaneous connections to the Internet or a Windows domain** to **Disabled**
- **An Android phone over USB on macOS**: macOS has no driver for Android's USB tethering. Install TetherKit, as described in [Use an Android phone over USB on macOS](#use-an-android-phone-over-usb-on-macos).

On Windows, install your phone maker's driver if the phone doesn't appear in Network Settings. An adapter appearing in Plexo doesn't guarantee it reaches the internet: VPN, virtual, and isolated adapters show up too. Check each network's latency and speed in Plexo.

## Manage your downloads

The menu in the header filters the list to **All downloads**, **In progress**, **Finished**, or **Needs attention**. Click a download's name to see its progress in detail.

Tick downloads to select them, or use **Select all** for the filtered list. The header then shows each action with how many of the selected downloads it applies to:

- **Pause** downloading or queued downloads, and **Resume** paused ones
- **Retry** downloads that failed and can recover. A download whose link expired has its own **Fix link** button, and one that can't resume has **Download again**.
- **Remove from list** takes finished downloads off the list and leaves their files on your computer. **Clear finished list** does this for every finished download.
- **Cancel downloads…** stops unfinished downloads and deletes what they downloaded so far
- **Move files to Trash…** moves finished downloads' files to the Trash, or the Recycle Bin on Windows. For a torrent, Plexo moves only the files it downloaded and leaves anything else you added to the folder.

Cancel and Move to Trash ask you to confirm first.

## Set speed and data limits

Open **Speed & data limits…** from the networks menu. Changes apply as you make them.

Under **All downloads**, set the total speed limit, the Slow mode speed, and how many downloads run at once. While Slow mode is on, its speed replaces the total limit, and per-network limits still apply.

Choose a network to set its speed limit in KB/s or MB/s, and its data allowance in GB per **Day**, **Week**, or **Month**. The allowance counts what Plexo downloads on that network, torrents included; uploads and other apps don't count. Days reset at midnight, weeks on Monday, and months on the 1st, all in your local time, and usage is kept across restarts.

Two buttons manage a network's limits, and both ask you to confirm:

- **Reset data usage…** sets the network's usage for the current period back to zero, so a network that hit its allowance can be used again
- **Remove limits…** clears the network's speed and data limits and keeps its recorded usage

## Schedule overnight downloads

Open **Networks → Speed & data limits… → All downloads** and find **Download schedule**. Enable the schedule, choose start and stop times in your computer’s local time, pick repeat days, and optionally set an end date. For a free-data window from midnight to 7 AM, use **00:00** and **07:00**.

Outside those hours, new downloads and downloads you resume wait in the queue. At the stop time, active downloads and torrent uploads stop, keeping progress for the next window. Downloads you pause yourself stay paused. Scheduled work survives restarting Plexo; when the end date passes, it stays waiting until you change or disable the schedule. Disabling the schedule lets the queue start immediately.

For a window crossing midnight, repeat days and the end date refer to the day it starts. Keep Plexo running and the computer awake for the scheduled start; Plexo keeps the computer awake while downloading, but does not wake a sleeping computer. Checking links and fetching magnet metadata when adding downloads can still use data outside the scheduled hours. The schedule controls Plexo’s transfers, not other apps or Plexo’s update check.

## How Plexo combines networks

Your operating system sends all of a computer's traffic through one default connection and leaves the others idle. Plexo opens its own connections on each network you select, and downloads different parts of the file on each.

```text
                    ┌── Wi-Fi (192.168.1.40) ──────┐
                    │                              │
File ──→ Split ─────┼── Ethernet (10.0.0.12) ──────┼──→ Assembled file
                    │                              │
                    └── USB tether (172.20.10.3) ──┘
```

It needs no virtual adapter, VPN, kernel extension, or administrator rights.

### Direct downloads use HTTP range requests

Most servers can send any slice of a file on request. A request with `Range: bytes=8388608-16777215` gets back bytes 8 MB to 16 MB with status `206 Partial Content`. Plexo first asks for a single byte. A `206` answer proves the server supports ranges and tells Plexo the file's size, name, and version (`ETag` and `Last-Modified`). A server that ignores ranges gets an ordinary single-stream download.

Each stream connects from one network's own address, so its traffic goes out through that network. On Linux, Plexo also pins the socket to the network device.

```typescript
https.request({
  hostname: 'releases.ubuntu.com',
  path: '/ubuntu-26.04.1-desktop-amd64.iso',
  localAddress: '172.20.10.3', // the USB tether's address
  headers: { Range: 'bytes=8388608-16777215' }
})
```

### Streams share one queue of blocks

Splitting a file into equal halves, one per network, makes the download only as fast as the slower network. Plexo cuts the file into blocks of up to 8 MB instead, and puts them all in one queue:

1. Each stream takes the next block in the queue, fetches it, then takes another. It keeps its connection to the server open between blocks, so it connects only once.
2. A faster network finishes its blocks sooner and takes more of them. If a network slows down or drops, the others keep draining the queue.
3. Once the queue is empty, a free stream can race a block that another stream is fetching too slowly. The first to finish wins. The streams table marks the racing stream **BACKUP**.

8 MB keeps the queue balanced between mismatched networks, and caps what a failed stream throws away. Small files get smaller blocks, never under 1 MB, so every stream has at least two.

Each block is written straight to its place in `<filename>.plexo`, a staging file next to the destination. When every block is in, Plexo renames it to the final name, picking a numbered name if that one is taken. The destination needs room for one copy of the file.

### Torrents pin each peer to a network

Plexo runs torrents with [WebTorrent](https://github.com/webtorrent/webtorrent) and opens every peer connection from one network's address. To keep every peer on a network Plexo chose, it turns off the parts that would connect on their own: uTP, WebRTC, web seeds, UPnP and NAT-PMP port mapping, and local peer discovery. Peers are found through HTTP/UDP trackers and the DHT. Torrents that are v2-only aren't supported yet.

### Resuming checks the file hasn't changed

Pausing closes every connection and keeps the staging file plus a small progress record in Plexo's app data. Resuming asks the server for the file's `ETag` and `Last-Modified` again. If they match, each block continues from the last saved byte. If they don't, the file changed on the server, and Plexo refuses to resume instead of joining two versions into a corrupt file.

## Use an Android phone over USB on macOS

macOS has no driver for RNDIS (Remote Network Driver Interface Specification), the protocol Android's USB tethering uses. The phone charges, but no network adapter appears. [TetherKit](https://github.com/XiaoMiku01/TetherKit) is an open-source driver that runs without a kernel extension and adds one.

1. Install TetherKit:

   ```bash
   brew install XiaoMiku01/tap/tetherkit
   ```

2. Connect your phone over USB.
3. On the phone, open **Settings › Network & internet › Hotspot & tethering** and turn on **USB tethering**.
4. Open Plexo. The phone appears in the networks list.

Thanks to [@XiaoMiku01](https://github.com/XiaoMiku01) for building and open-sourcing TetherKit.

## Build Plexo from source

You need Node.js 22.12 or later and npm 9 or later.

```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo
npm install
npm run dev
```

Run the end-to-end tests with Playwright. [CONTRIBUTING.md](CONTRIBUTING.md#end-to-end-tests) covers the options and debugging flags.

```bash
npm run test:e2e:smoke   # smoke tests
npm run test:e2e         # the full suite
```

Package the app for each platform:

- **macOS**: `npm run build:mac` writes `dist/mac/Plexo.app`. A build made on your own Mac isn't quarantined, so it opens without the first-launch step.
- **Windows**: `npm run build:win`, from PowerShell, writes the installer to `dist/`. For an app you run without installing, use `npm run build:unpack` and open `dist/win-unpacked/plexo.exe`.
- **Linux**: `npm run build:linux` writes the AppImage and `.deb` packages to `dist/`

Local builds are unsigned.

## Contributing

Contributions are welcome, from download engine work to testing Plexo on new network setups. Areas that need help:

- Download and torrent throughput
- Network adapter names on Linux
- Testing with 5G tethering, Wi-Fi 6, and 10 GbE
- The interface and documentation

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and how to open a pull request.

## Built with

Electron, React 19, TypeScript, Tailwind CSS v4, Base UI, Zustand, WebTorrent, and Lucide icons. electron-vite builds it, electron-builder packages it, and Playwright tests it.

## Support Plexo

If Plexo is useful to you:

- Star the repository
- [Report a bug or suggest a feature](https://github.com/anmolkapil/plexo/issues)
- [Sponsor development](https://github.com/sponsors/anmolkapil)

## License

MIT. See [LICENSE](LICENSE).
