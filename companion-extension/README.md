# Plexo Download Companion (Chrome & Edge Extension)

The Plexo Companion extension captures downloads directly from your browser and transfers them into **Plexo**, accelerating your downloads across multiple network adapters simultaneously (e.g. Wi-Fi + Ethernet + Mobile USB tether).

---

## Features

- ⚡ **Seamless Download Interception**: Automatically catches browser file downloads (archives, videos, installers, ISOS, etc.) and transfers them to Plexo.
- 🍪 **Full Session & Cookie Support**: Passes session cookies and referrers to Plexo so authenticated downloads (Google Drive, university portals, private trackers) work smoothly.
- 🖱️ **Context Menus**: Right-click on any link, image, or media $\rightarrow$ *"Download with Plexo"*.
- 🛡️ **Zero-Disruption Fallback**: If Plexo is not running, the extension leaves your browser downloads alone without interrupting you.
- 🎛️ **Customizable Filters**: Configure matching file extensions, domain exclusions, or minimum file size thresholds in Extension Settings.

---

## How to Install in Google Chrome / Brave / Chromium

1. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
2. In the top-right corner, turn on **Developer mode**.
3. Click the **Load unpacked** button.
4. Select the `companion-extension` directory inside your Plexo project folder:
   ```text
   <path-to-plexo>\companion-extension
   ```
5. The **Plexo Download Companion** icon will now appear in your browser toolbar!

---

## How to Install in Microsoft Edge

1. Open Microsoft Edge and navigate to:
   ```text
   edge://extensions
   ```
2. In the left sidebar, turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `companion-extension` directory.
5. The extension is now active in Edge.

---

## How It Works

1. **Local Companion Server**:
   When Plexo Desktop is open, it listens locally on `127.0.0.1:41829`.
2. **Instant Link Transfer**:
   When you click a downloadable file in Chrome or Edge, the extension captures the download, sends the URL, cookies, and headers to Plexo over local HTTP, and cancels the slow single-connection browser download.
3. **Plexo Multi-Network Engine**:
   Plexo probes the link, splits it across all your active network connections (Wi-Fi, Ethernet, USB tether), and aggregates your available bandwidth!
