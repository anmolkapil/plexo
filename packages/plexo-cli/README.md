# ⚡ Plexo CLI (`plexo-cli`)

[![PyPI version](https://img.shields.io/pypi/v/plexo-cli.svg?color=blue)](https://pypi.org/project/plexo-cli/)
[![Python versions](https://img.shields.io/pypi/pyversions/plexo-cli.svg)](https://pypi.org/project/plexo-cli/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-55%20passed-success.svg)](tests/)

> **Universal, lightweight, terminal-first multi-network bandwidth bonding, video downloader, and torrent engine.**  
> Combines Wi-Fi, Ethernet, and Mobile 5G tethering into one unified high-speed pipe directly from your command line.

---

## 🚀 Key Features

* **🌐 Multi-Socket Bandwidth Bonding:** Binds parallel download workers to distinct physical network interfaces using source-IP socket routing (`urllib3.PoolManager(source_address=(NIC_IP, 0))`).
* **📹 Universal Video Downloader (`plexo video`):** Extracts, downloads, and muxes video/audio streams across 1,800+ platforms (YouTube, Instagram Reels, TikTok, Twitter/X, Reddit, Vimeo) using multi-network bonding.
* **🎯 Mathematical Quality Fallback:** Targets your exact desired resolution (e.g. `--quality 1080p`), gracefully falling back to the nearest highest available resolution (`height <= requested`) if 1080p is unavailable.
* **🎵 Multi-Track & Audio Extraction:** Download isolated high-bitrate audio (`--audio-only`), specify audio language tracks (`--audio-lang`), and fetch multi-language subtitles (`--sub en,es`).
* **⚡ Zero-Copy Stream Muxing:** Combines separate DASH/HLS high-resolution video and audio streams seamlessly via zero-copy FFmpeg (`-c copy`) in 0.1 seconds without CPU strain.
* **🧲 BitTorrent Multi-Homing Swarm:** Slices BitTorrent peer swarms across multiple network adapters simultaneously with SHA-1 piece verification.
* **🎬 Watch While Downloading (`--sequential`):** Prioritizes file headers (moov container) and opening frames so media players like **VLC** can stream video immediately from byte 0.
* **🪞 Multi-Source Mirror Bonding (`-m / --mirror`):** Pulls chunks simultaneously across distinct server mirrors (e.g. Mirror A on Wi-Fi, Mirror B on 5G) to bypass server-side IP throttling.
* **🛡️ Per-Adapter Data Quotas (`-q / --quota`):** Protects mobile hotspot data caps (e.g. `-q usb=1.5GB`). When the cap is reached, that connection rests while unlimited Wi-Fi finishes the rest.
* **📂 Selective Torrent Downloads (`--list`, `--select`):** Inspect contents of multi-file season packs and download only the specific episodes you need.
* **📋 Background Clipboard Watcher (`plexo watch`):** IDM-style daemon that monitors the system clipboard and auto-captures `.mp4`, `.mkv`, `.zip`, `.iso`, or `magnet:` links.
* **⚡ Zero-Touch Local Acceleration Proxy (`plexo proxy`):** Runs a local forward proxy (`127.0.0.1:8899`) to bond traffic for `pip`, `curl`, `git`, and `huggingface-cli`.
* **💾 Smart Checkpointing & Instant Resume (`.plexo`):** Non-destructive NTFS/ext4 sparse file pre-allocation with zero-overhead resume on interrupted downloads.

---

## 📦 Installation

### From PyPI
```bash
pip install plexo-cli
```

### From Source (Editable Mode)
```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo/packages/plexo-cli
pip install -e .
```

---

## 🛠️ CLI Command Reference

### 1. Discover Active Interfaces: `plexo adapters`
Scans and validates all active physical, Ethernet, and wireless interfaces, verifying outward internet reachability via canary probes:
```bash
plexo adapters
```

*Example Output:*
```text
+-------------------+---------------+----------+---------+--------+
| Adapter Name      | IP Address    | Type     | State   | Canary |
+-------------------+---------------+----------+---------+--------+
| Wi-Fi (Hostel)    | 192.168.1.104 | Wi-Fi    | UP      | ONLINE |
| Phone 5G USB      | 192.168.43.55 | Ethernet | UP      | ONLINE |
+-------------------+---------------+----------+---------+--------+
```

---

### 2. Bonded HTTP Downloads: `plexo download`

#### Basic Parallel Download
```bash
plexo download "https://example.com/largefile.zip" -o "largefile.zip"
```

#### Watch While Downloading (`--sequential`)
Download chunks in strict chronological order so you can open and watch the video in VLC within 30 seconds:
```bash
plexo download "https://example.com/movie.mp4" --sequential -o "movie.mp4"
```

#### Multi-Source Mirror Bonding (`-m / --mirror`)
Distribute chunk downloads across multiple server mirrors and multiple adapters:
```bash
plexo download "https://mirror1.com/ubuntu.iso" -m "https://mirror2.com/ubuntu.iso" -o "ubuntu.iso"
```

#### Protect Mobile Data Caps (`-q / --quota`)
Specify a maximum data quota for any adapter by name or IP:
```bash
# Cap Phone USB tethering to 1.5 GB, let Wi-Fi pull the rest:
plexo download "<url>" -q "usb=1.5GB"

# Cap a specific network IP to 500 MB:
plexo download "<url>" -q "192.168.43.55=500MB"
```

#### Authenticated / Protected Filelockers (`--cookie`, `--referer`, `-H`)
```bash
plexo download "<protected-url>" \
  --cookie "session_token=abcdef123456" \
  --referer "https://filelocker.com/view" \
  -H "Authorization: Bearer my_token"
```

---

### 3. Universal Video Downloader: `plexo video`
Download high-resolution videos, Reels, and audio tracks across 1,800+ platforms with multi-network socket bonding and automatic zero-copy muxing:

#### Basic Video Download
```bash
# Target 1080p (falls back smoothly to 720p or highest available if 1080p is absent):
plexo video "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Download Instagram Reels, TikTok, Twitter/X, or Reddit videos:
plexo video "https://www.instagram.com/reel/C3b45x..."
plexo video "https://x.com/user/status/123456789"
```

#### Resolution Fallback Hierarchy (`-q / --quality`)
```bash
# Target 4K resolution (2160p):
plexo video "<url>" -q 4k

# Target specific vertical resolution:
plexo video "<url>" -q 720p

# Always grab highest available resolution:
plexo video "<url>" -q best
```

#### Audio Extraction & Language Selection (`--audio-only`, `--audio-lang`)
```bash
# Extract high-bitrate audio track only (m4a/opus/mp3):
plexo video "https://www.youtube.com/watch?v=..." --audio-only

# Specify preferred audio language track:
plexo video "<url>" --audio-lang en
```

#### Subtitle Extraction (`--sub`)
```bash
# Download English and Spanish subtitles:
plexo video "<url>" --sub en,es
```

#### Inspect Available Formats (`--list`)
Inspect video codecs, resolutions, audio streams, and available subtitles without downloading any media bytes:
```bash
plexo video "<url>" --list
```

#### Smart Auto-Delegation in `plexo download`
If you pass a streaming video link directly to `plexo download`, Plexo automatically recognizes the media host and hands off execution to the video downloader engine:
```bash
plexo download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
# [INFO] Media stream URL detected. Delegating to plexo video...
```

---

### 4. BitTorrent Swarm Multi-Homing: `plexo torrent`

#### Magnet Links & `.torrent` Files
```bash
# Magnet URI:
plexo torrent "magnet:?xt=urn:btih:EXAMPLE_HASH&dn=Debian" -o "D:\Downloads"

# Local .torrent file:
plexo torrent "debian.torrent" -o "D:\Downloads"
```

#### Inspect Torrent Files (`--list`)
```bash
plexo torrent "magnet:?xt=urn:btih:..." --list
```

#### Download Selected Files (`--select`)
Download only specific files or episodes from large torrents:
```bash
# Download only Episode 1 (index 1):
plexo torrent "magnet:?xt=urn:btih:..." --select 1

# Download multiple episodes:
plexo torrent "magnet:?xt=urn:btih:..." --select 1,2,5
```

#### Sequential Torrent Playback (`--sequential`)
```bash
plexo torrent "magnet:?xt=urn:btih:..." --sequential -o "D:\Movies"
```

---

### 5. Background Clipboard Watcher: `plexo watch`
Listens in the background for copied download links (`.mp4`, `.mkv`, `.zip`, `.iso`, `magnet:`, etc.):

```bash
# Interactive mode (prompts [Y/n] when a downloadable URL is copied):
plexo watch

# Headless / Auto-download mode:
plexo watch -a -o "D:\Downloads"

# Auto-download with sequential streaming:
plexo watch -a --sequential -o "D:\Movies"
```

---

### 6. Local Acceleration Proxy: `plexo proxy`
Accelerate development tools across bonded network connections:

```bash
# Start proxy on default port 8899:
plexo proxy --port 8899
```

In another terminal, direct tools to use the proxy:
```bash
# Accelerate pip:
pip install torch torchvision --proxy http://127.0.0.1:8899

# Accelerate curl / Hugging Face CLI:
export HTTPS_PROXY="http://127.0.0.1:8899"
curl -O https://example.com/dataset.tar.gz
```

---

### 7. Probe Server Capabilities: `plexo info`
Inspect remote server headers, file size, MIME type, and byte-range support:
```bash
plexo info
```

---

## 🧪 Verification & Testing

The package includes a comprehensive automated test suite testing live sockets, mock mirrors, sparse file allocation, torrent bencoding, QoS quota enforcement, clipboard regex extractors, yt-dlp stream resolution, and zero-copy stream muxing:

```bash
pytest packages/plexo-cli -v
```
```text
tests/test_adapter.py            PASSED (3/3)
tests/test_sparse.py             PASSED (3/3)
tests/test_torrent.py            PASSED (4/4)
tests/test_engine.py             PASSED (5/5)
tests/test_mirror.py             PASSED (9/9)
tests/test_watcher.py            PASSED (12/12)
tests/test_video_resolver.py     PASSED (9/9)
tests/test_video_downloader.py   PASSED (10/10)
============================= 55 passed in 12.52s =============================
```

---

## 🔧 Troubleshooting & Known Issues

### 1. `plexo` is not recognized as a command
* **Cause:** On Windows (especially Microsoft Store Python editions), user CLI binaries are installed into a sandboxed `Scripts` directory not included in `$env:PATH`.
* **Fix:** Invoke the module directly via Python:
  ```bash
  python -m plexo download "<url>"
  ```
  Or add your user scripts directory (`python -c "import sysconfig; print(sysconfig.get_path('scripts'))"`) to your Windows environment `PATH`.

### 2. Multi-adapter progress bars stuck at `0.0%`
* **Resolved in v0.1.2:** Earlier UI loops updated task speeds without setting `completed=transferred_bytes`, leaving sub-interface progress bars visually locked at `0.0%` even while multi-network bonding was downloading at full wire speed. This is now fixed with real-time per-adapter byte accounting.

### 3. Download appears paused right at 100%
* **Resolved in v0.1.2:** After downloading multi-hundred MB or GB files, the sparse file writer computes a full SHA-256 integrity checksum. A live console status spinner (`Verifying file checksum (SHA-256)...`) now clearly indicates verification in progress.

### 4. Cloudflare Worker / CDN links dropping
* **Architecture Note:** URLs proxied through serverless edge workers (e.g. `*.workers.dev`) or filelockers may cap parallel sub-requests or disallow concurrent multi-IP HTTP `Range` slices. If a remote host rejects range slices, Plexo automatically falls back to single-stream mode on the primary connection.

---

## 📄 License
MIT © Anmol Kapil & Jagjot Singh
