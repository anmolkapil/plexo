# Changelog

All notable changes to `plexo-cli` are documented in this file.

## [0.2.0] - 2026-10-31

### Security
- **Proxy Authentication:** Refuse non-loopback `--host` bindings unless `--auth user:pass` or `--allow-remote` is specified.
- **Timing-Safe Auth:** Validate `Proxy-Authorization` Basic header via `hmac.compare_digest` to prevent side-channel timing attacks. Returns HTTP 407 on failure.
- **SSRF Prevention:** Restrict HTTP `CONNECT` tunneling strictly to ports 80 and 443 by default.

### Correctness & Networking
- **Multi-OS Socket Binding:** Added `bind_socket_to_interface` using `SO_BINDTODEVICE` on Linux and `IP_BOUND_IF` on macOS to eliminate default-gateway routing bottlenecks.
- **Diagnostic Engine:** Added `plexo doctor` command to verify real-time per-NIC throughput deltas.
- **BitTorrent Engine:** Enforced SHA-1 piece verification and marked CLI feature as experimental (`--experimental`).

### Packaging & Performance
- **Modular Extras:** Core install is featherlight. Video engine dependencies (`yt-dlp`, `curl_cffi`, `imageio-ffmpeg`) moved to optional extra `plexo-cli[video]`.
- **System FFmpeg:** Automatically detect and utilize system `ffmpeg` on PATH before falling back to bundled binary.
- **PyPI Trusted Publishing:** Added GitHub Actions OIDC workflow for automated, tokenless releases.

### Compliance
- **Fair Use Notice:** Added one-time educational & compliance disclaimer on first run of `plexo video`.
- **DRM Policy:** Explicitly disclaimed DRM/paywall circumvention in documentation and CLI.
