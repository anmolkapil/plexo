"""Tests for clipboard watcher and automatic download detection."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from plexo.cli import main
from plexo.ui.watcher import (
    ClipboardWatcher,
    extract_download_links,
    get_clipboard_text,
)


def test_extract_download_links_direct_urls():
    text = (
        "Check this out: https://download.documentfoundation.org/libreoffice/stable/24.2.0/win/x86_64/LibreOffice_24.2.0_Win_x86-64.msi "
        "and also http://archive.ubuntu.com/ubuntu/dists/noble/main/installer-amd64/current/legacy-images/netboot/mini.iso."
    )
    links = extract_download_links(text)
    assert len(links) == 2
    assert links[0] == "https://download.documentfoundation.org/libreoffice/stable/24.2.0/win/x86_64/LibreOffice_24.2.0_Win_x86-64.msi"
    assert links[1] == "http://archive.ubuntu.com/ubuntu/dists/noble/main/installer-amd64/current/legacy-images/netboot/mini.iso"


def test_extract_download_links_with_query_params_and_punctuation():
    text = (
        "Download here: (https://example.com/builds/release-v1.0.tar.gz?token=abc123xyz&download=true)! "
        "or [http://speedtest.tele2.net/10MB.zip]."
    )
    links = extract_download_links(text)
    assert len(links) == 2
    assert links[0] == "https://example.com/builds/release-v1.0.tar.gz?token=abc123xyz&download=true"
    assert links[1] == "http://speedtest.tele2.net/10MB.zip"


def test_extract_download_links_magnet():
    text = "magnet:?xt=urn:btih:3b245504cf5f11bbdbe1201cea6a6bf45a004e3a&dn=Arch+Linux+2026&tr=udp%3A%2F%2Ftracker.archlinux.org%3A6969"
    links = extract_download_links(text)
    assert len(links) == 1
    assert links[0] == text


def test_extract_download_links_ignore_non_download_urls():
    text = "Visit https://google.com or https://github.com/torvalds/linux or https://news.ycombinator.com/item?id=123"
    links = extract_download_links(text)
    assert len(links) == 0


def test_extract_download_links_empty_and_duplicate():
    assert extract_download_links("") == []
    text = "https://example.com/file.zip and again https://example.com/file.zip"
    links = extract_download_links(text)
    assert len(links) == 1
    assert links[0] == "https://example.com/file.zip"


def test_clipboard_watcher_auto_download(tmp_path):
    mock_clipboard_data = ["https://example.com/data_archive.7z"]
    mock_handler = MagicMock()

    def mock_get_clipboard():
        return mock_clipboard_data[0] if mock_clipboard_data else None

    watcher = ClipboardWatcher(
        poll_interval=0.1,
        auto_download=True,
        output_dir=tmp_path,
        clipboard_getter=mock_get_clipboard,
        download_handler=mock_handler,
    )

    # First check: finds new link and calls handler
    new_links = watcher.check_clipboard()
    assert new_links == ["https://example.com/data_archive.7z"]
    mock_handler.assert_called_once_with("https://example.com/data_archive.7z", tmp_path)

    # Second check with same clipboard content: deduplicated, handler NOT called again
    mock_handler.reset_mock()
    new_links_2 = watcher.check_clipboard()
    assert new_links_2 == []
    mock_handler.assert_not_called()


def test_clipboard_watcher_interactive_confirm(tmp_path):
    mock_handler = MagicMock()

    watcher = ClipboardWatcher(
        poll_interval=0.1,
        auto_download=False,
        output_dir=tmp_path,
        clipboard_getter=lambda: "https://example.com/video.mp4",
        download_handler=mock_handler,
    )

    # When user accepts prompt (click.confirm returns True)
    with patch("click.confirm", return_value=True):
        new_links = watcher.check_clipboard()
        assert new_links == ["https://example.com/video.mp4"]
        mock_handler.assert_called_once_with("https://example.com/video.mp4", tmp_path)


def test_clipboard_watcher_interactive_decline(tmp_path):
    mock_handler = MagicMock()

    watcher = ClipboardWatcher(
        poll_interval=0.1,
        auto_download=False,
        output_dir=tmp_path,
        clipboard_getter=lambda: "https://example.com/distribution.iso",
        download_handler=mock_handler,
    )

    # When user declines prompt (click.confirm returns False)
    with patch("click.confirm", return_value=False):
        new_links = watcher.check_clipboard()
        assert new_links == ["https://example.com/distribution.iso"]
        mock_handler.assert_not_called()


def test_clipboard_watcher_run_max_iterations(tmp_path):
    mock_handler = MagicMock()
    watcher = ClipboardWatcher(
        poll_interval=0.01,
        auto_download=True,
        output_dir=tmp_path,
        clipboard_getter=lambda: "magnet:?xt=urn:btih:da39a3ee5e6b4b0d3255bfef95601890afd80709",
        download_handler=mock_handler,
    )

    # Runs 2 iterations and exits cleanly
    watcher.run(max_iterations=2)
    mock_handler.assert_called_once()


def test_cli_watch_help():
    runner = CliRunner()
    result = runner.invoke(main, ["watch", "--help"])
    assert result.exit_code == 0
    assert "--auto-download" in result.output
    assert "--output-dir" in result.output
    assert "--poll-interval" in result.output


def test_extract_download_links_extended_formats():
    text = (
        "Packages: https://pypi.org/packages/package-1.0-py3-none-any.whl "
        "and https://repo.maven.apache.org/maven2/org/example/lib.jar "
        "and https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.8.tar.zst"
    )
    links = extract_download_links(text)
    assert len(links) == 3
    assert links[0] == "https://pypi.org/packages/package-1.0-py3-none-any.whl"
    assert links[1] == "https://repo.maven.apache.org/maven2/org/example/lib.jar"
    assert links[2] == "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.8.tar.zst"


def test_clipboard_watcher_creates_nonexistent_output_dir(tmp_path):
    nested_dir = tmp_path / "deep" / "nested" / "downloads"
    assert not nested_dir.exists()
    mock_engine = MagicMock()
    mock_engine._prepare.return_value = MagicMock(filename="file.zip", total_bytes=100)
    mock_engine.mirrors = ["https://example.com/file.zip"]
    dummy_file = nested_dir / "file.zip"
    dummy_file.parent.mkdir(parents=True, exist_ok=True)
    dummy_file.write_bytes(b"data")
    mock_engine.execute.return_value = dummy_file

    with patch("plexo.core.adapter.get_bonded_pool", return_value=[MagicMock(ip_address="127.0.0.1", name="eth0", kind="ethernet")]), \
         patch("plexo.core.engine.BondingDownloadEngine", return_value=mock_engine), \
         patch("plexo.core.sparse.SparseFileWriter"):
        watcher = ClipboardWatcher(
            poll_interval=0.1,
            auto_download=True,
            output_dir=nested_dir,
            clipboard_getter=lambda: "https://example.com/file.zip",
        )
        watcher._default_download_handler("https://example.com/file.zip", nested_dir)
        assert nested_dir.exists()
        mock_engine.execute.assert_called_once()
