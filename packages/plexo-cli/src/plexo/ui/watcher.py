"""Clipboard watcher for automated bonded downloads.

Monitors system clipboard for downloadable URLs and BitTorrent magnet URIs,
prompting the user or immediately triggering bonded downloads across available
network adapters.
"""

from __future__ import annotations

import re
import sys
import threading
import time
from pathlib import Path
from typing import Callable, Optional

import click
from rich.console import Console
from rich.panel import Panel

MAGNET_REGEX = re.compile(
    r"magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s\"'<>]*",
    re.IGNORECASE,
)

DOWNLOAD_EXTENSIONS = (
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "txz", "zst",
    "iso", "img", "bin", "exe", "msi", "dmg", "pkg", "deb", "rpm", "apk", "whl", "jar",
    "mp4", "mkv", "avi", "mov", "webm", "flv", "mp3", "flac", "wav", "aac",
    "torrent", "pdf"
)

URL_REGEX = re.compile(
    r"https?://[^\s\"'<>]+\.(?:" + "|".join(DOWNLOAD_EXTENSIONS) + r")(?:\?[^\s\"'<>]*)?",
    re.IGNORECASE,
)


def _get_clipboard_windows() -> Optional[str]:
    """Retrieves clipboard text on Windows using native ctypes win32 API."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL

    CF_UNICODETEXT = 13

    for _ in range(5):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.02)
    else:
        return None

    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return None
        try:
            return ctypes.c_wchar_p(ptr).value
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def _get_clipboard_subprocess() -> Optional[str]:
    """Fallback subprocess-based clipboard reader across platforms."""
    import subprocess
    if sys.platform == "win32":
        try:
            res = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Get-Clipboard"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            return res.stdout.strip() if res.returncode == 0 else None
        except Exception:
            return None
    elif sys.platform == "darwin":
        try:
            res = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=2)
            return res.stdout if res.returncode == 0 else None
        except Exception:
            return None
    else:
        for cmd in (["xclip", "-selection", "clipboard", "-o"], ["wl-paste"]):
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
                if res.returncode == 0:
                    return res.stdout
            except Exception:
                continue
    return None


def get_clipboard_text() -> Optional[str]:
    """Reads current UTF-8/Unicode string from system clipboard."""
    if sys.platform == "win32":
        try:
            txt = _get_clipboard_windows()
            if txt is not None:
                return txt
        except Exception:
            pass

    try:
        txt = _get_clipboard_subprocess()
        if txt is not None:
            return txt
    except Exception:
        pass

    try:
        import tkinter as tk
        root = tk.Tk()
        root.withdraw()
        txt = root.clipboard_get()
        root.destroy()
        return txt
    except Exception:
        pass

    return None


def extract_download_links(text: str) -> list[str]:
    """Extracts all matching HTTP/HTTPS direct file URLs and magnet URIs."""
    if not text:
        return []
    links: list[str] = []
    # Magnet links
    for match in MAGNET_REGEX.finditer(text):
        link = match.group(0).rstrip(".,;!?:)]}>\"'")
        if link and link not in links:
            links.append(link)
    # Direct file URLs
    for match in URL_REGEX.finditer(text):
        link = match.group(0).rstrip(".,;!?:)]}>\"'")
        if link and link not in links:
            links.append(link)
    return links


class ClipboardWatcher:
    """Monitors system clipboard for downloadable URLs and torrent magnets."""

    def __init__(
        self,
        poll_interval: float = 1.0,
        auto_download: bool = False,
        output_dir: Optional[str | Path] = None,
        console: Optional[Console] = None,
        clipboard_getter: Optional[Callable[[], Optional[str]]] = None,
        download_handler: Optional[Callable[[str, Optional[Path]], None]] = None,
    ):
        self.poll_interval = max(0.1, poll_interval)
        self.auto_download = auto_download
        self.output_dir = Path(output_dir) if output_dir else Path.cwd()
        self.console = console or Console()
        self.get_clipboard = clipboard_getter or get_clipboard_text
        self.download_handler = download_handler or self._default_download_handler
        self._seen_links: set[str] = set()
        self._last_raw: Optional[str] = None
        self._stop_event = threading.Event()

    def stop(self) -> None:
        """Signals the watcher loop to terminate."""
        self._stop_event.set()

    def check_clipboard(self) -> list[str]:
        """Polls clipboard once, extracts new links, and triggers prompt or auto-download."""
        try:
            raw_text = self.get_clipboard()
        except Exception:
            return []

        if not raw_text or raw_text == self._last_raw:
            return []

        self._last_raw = raw_text
        links = extract_download_links(raw_text)
        new_links = [link for link in links if link not in self._seen_links]

        for link in new_links:
            self._seen_links.add(link)
            if self.auto_download:
                self.console.print(
                    f"\n[bold green][Auto-Download][/bold green] Detected link: [cyan]{link}[/cyan]"
                )
                self.download_handler(link, self.output_dir)
            else:
                self.console.print(
                    Panel.fit(
                        f"[bold yellow]Downloadable Link Detected in Clipboard[/bold yellow]\n"
                        f"[cyan]{link}[/cyan]",
                        border_style="yellow",
                    )
                )
                try:
                    if click.confirm("Start bonded download now?", default=True):
                        self.download_handler(link, self.output_dir)
                    else:
                        self.console.print("[dim]Download skipped.[/dim]")
                except (click.Abort, KeyboardInterrupt):
                    self.console.print("\n[dim]Download cancelled by user.[/dim]")

        return new_links

    def run(self, max_iterations: Optional[int] = None) -> None:
        """Runs the monitoring loop until stopped or interrupted."""
        self.console.print(
            Panel.fit(
                "[bold cyan]Plexo Clipboard Watcher Active[/bold cyan]\n"
                f"Mode: [yellow]{'Auto-Download (--auto-download)' if self.auto_download else 'Interactive Confirmation'}[/yellow]\n"
                f"Poll Interval: [green]{self.poll_interval}s[/green]\n"
                f"Destination: [magenta]{self.output_dir}[/magenta]\n"
                "[dim]Copy any direct file link or magnet link to start bonded transfer. Press Ctrl+C to exit.[/dim]",
                border_style="cyan",
            )
        )
        iterations = 0
        try:
            while not self._stop_event.is_set():
                if max_iterations is not None and iterations >= max_iterations:
                    break
                iterations += 1

                self.check_clipboard()

                if max_iterations is not None and iterations >= max_iterations:
                    break
                if self._stop_event.wait(self.poll_interval):
                    break
        except KeyboardInterrupt:
            self.console.print("\n[yellow]Clipboard watcher stopped.[/yellow]")

    def _default_download_handler(self, link: str, output_dir: Optional[Path]) -> None:
        """Invokes the appropriate bonding engine (torrent or HTTP)."""
        from ..core.adapter import get_bonded_pool
        from ..core.engine import BondingDownloadEngine
        from ..core.sparse import SparseFileWriter
        from ..ui.dashboard import TerminalDashboard

        target_dir = output_dir or self.output_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        adapters = get_bonded_pool()
        if not adapters:
            self.console.print("[bold red]Error: No active online network adapters detected.[/bold red]")
            return

        dashboard = TerminalDashboard(console=self.console)

        if link.startswith("magnet:?") or link.endswith(".torrent"):
            from ..torrent.metadata import parse_magnet, parse_torrent_file
            from ..torrent.client import TorrentBondingEngine
            try:
                meta = parse_magnet(link) if link.startswith("magnet:?") else parse_torrent_file(link)
                self.console.print(f"[bold cyan]Starting bonded torrent swarm:[/bold cyan] {meta.name}")
                dashboard.setup(meta.name, meta.total_length, adapters)
                engine = TorrentBondingEngine(
                    metadata=meta,
                    output_dir=str(target_dir),
                    adapters=adapters,
                )
                start_time = time.time()
                with dashboard.progress:
                    final_path = engine.download(progress_callback=dashboard.update)
                elapsed = time.time() - start_time
                total_bytes = final_path.stat().st_size
                with SparseFileWriter(final_path, total_bytes) as writer:
                    checksum = writer.calculate_checksum()
                dashboard.finish(final_path.name, total_bytes, elapsed, checksum)
            except Exception as e:
                self.console.print(f"[bold red]Torrent download failed:[/bold red] {e}")
        else:
            try:
                self.console.print(f"[bold cyan]Starting bonded HTTP download:[/bold cyan] {link}")
                engine = BondingDownloadEngine(
                    url=link,
                    output_path=target_dir,
                    adapters=adapters,
                )
                probe = engine._prepare()
                dashboard.setup(probe.filename, probe.total_bytes, adapters, mirrors=engine.mirrors)
                start_time = time.time()
                with dashboard.progress:
                    final_path = engine.execute(progress_callback=dashboard.update)
                elapsed = time.time() - start_time
                total_bytes = final_path.stat().st_size
                with SparseFileWriter(final_path, total_bytes) as writer:
                    checksum = writer.calculate_checksum()
                dashboard.finish(final_path.name, total_bytes, elapsed, checksum, mirrors=engine.mirrors)
            except Exception as e:
                self.console.print(f"[bold red]HTTP download failed:[/bold red] {e}")
