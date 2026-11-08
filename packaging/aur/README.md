# AUR Packaging for Plexo (`plexo-bin`)

This directory contains the Arch User Repository (AUR) package files for Plexo.

## Files

- **`PKGBUILD`**: Package build recipe for `makepkg`. It fetches the official GitHub release `.deb` packages for `x86_64` and `aarch64`, installs the binaries into `/opt/Plexo`, and configures the desktop integration and launcher wrapper.
- **`plexo.sh`**: Wrapper script installed to `/usr/bin/plexo`. It checks for user-defined flags in `~/.config/plexo-flags.conf` (e.g. Wayland flags like `--ozone-platform-hint=auto`).
- **`.SRCINFO`**: Machine-readable metadata file read by the AUR website and AUR helpers (`yay`, `paru`).

## Local Testing

To test building the package on an Arch Linux machine:

```bash
cd packaging/aur
makepkg -s -f
```

To inspect the generated package:

```bash
pacman -Qlp plexo-bin-*.pkg.tar.zst
```

To test local installation:

```bash
sudo pacman -U plexo-bin-*.pkg.tar.zst
```

## Updating .SRCINFO

Whenever `PKGBUILD` is modified (version bump, checksum update), regenerate `.SRCINFO`:

```bash
makepkg --printsrcinfo > .SRCINFO
```

## Publishing to AUR

1. Ensure you have an account on [aur.archlinux.org](https://aur.archlinux.org/) with your SSH public key configured in your profile.
2. Clone the AUR repository:
   ```bash
   git clone ssh://aur@aur.archlinux.org/plexo-bin.git
   ```
3. Copy `PKGBUILD`, `.SRCINFO`, and `plexo.sh` into the cloned repository:
   ```bash
   cp packaging/aur/{PKGBUILD,.SRCINFO,plexo.sh} plexo-bin/
   cd plexo-bin
   ```
4. Verify, commit, and push:
   ```bash
   makepkg -s -f
   git add PKGBUILD .SRCINFO plexo.sh
   git commit -m "feat: release v<version>"
   git push origin master
   ```
