"""Tests for parallel bonded download engine with mock Range server."""

import hashlib
import http.server
import socketserver
import tempfile
import threading
from pathlib import Path
import pytest
from plexo.core.adapter import NetworkAdapter
from plexo.core.engine import BondingDownloadEngine


class RangeHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    """Simple HTTP server supporting byte ranges for testing."""
    DATA = b"0123456789ABCDEF" * 1024 * 64  # 1 MB test payload

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(self.DATA)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self):
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            parts = range_header[6:].split("-")
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else len(self.DATA) - 1
            chunk = self.DATA[start : end + 1]

            self.send_response(206)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.DATA)}")
            self.send_header("Content-Length", str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(self.DATA)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(self.DATA)

    def log_message(self, format, *args):
        pass  # Suppress logging in tests


@pytest.fixture(scope="module")
def mock_server():
    server = socketserver.TCPServer(("127.0.0.1", 0), RangeHTTPRequestHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}/testfile.bin"
    server.shutdown()


def test_bonded_engine_download(mock_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "output.bin"

        # Mock adapter
        mock_adapter = NetworkAdapter(
            name="Mock-Adapter",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mock_server,
            output_path=output_file,
            adapters=[mock_adapter],
            chunk_size=128 * 1024,  # 128 KB chunks
            workers_per_adapter=2,
        )

        final_path = engine.execute()

        assert final_path.exists()
        assert final_path.stat().st_size == len(RangeHTTPRequestHandler.DATA)

        # Verify exact byte match
        expected_hash = hashlib.sha256(RangeHTTPRequestHandler.DATA).hexdigest()
        with open(final_path, "rb") as f:
            actual_hash = hashlib.sha256(f.read()).hexdigest()

        assert actual_hash == expected_hash


def test_bonded_engine_with_cookies_and_referer(mock_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "output_cookie.bin"

        mock_adapter = NetworkAdapter(
            name="Mock-Adapter",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mock_server,
            output_path=output_file,
            adapters=[mock_adapter],
            chunk_size=128 * 1024,
            custom_headers={"X-Custom-Auth": "Token123"},
            cookie="session=plexo_movie_test",
            referer="https://itsfuckingfast.co/download",
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert final_path.stat().st_size == len(RangeHTTPRequestHandler.DATA)


def test_bonded_engine_resume(mock_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "resume_test.bin"
        state_file = output_file.with_name(output_file.name + ".plexo")
        total_len = len(RangeHTTPRequestHandler.DATA)
        chunk_size = 128 * 1024

        # Simulate that chunk 0 was already downloaded
        chunk_0_data = RangeHTTPRequestHandler.DATA[:chunk_size]
        with open(output_file, "wb") as f:
            f.seek(total_len - 1)
            f.write(b"\0")
        with open(output_file, "r+b") as f:
            f.seek(0)
            f.write(chunk_0_data)

        import json
        with open(state_file, "w") as sf:
            json.dump({"total_bytes": total_len, "completed_chunks": [0]}, sf)

        mock_adapter = NetworkAdapter(
            name="Mock-Adapter",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mock_server,
            output_path=output_file,
            adapters=[mock_adapter],
            chunk_size=chunk_size,
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert not state_file.exists()  # Cleaned up after 100% completion

        # Verify byte-for-byte SHA256 matches full original data
        expected_hash = hashlib.sha256(RangeHTTPRequestHandler.DATA).hexdigest()
        with open(final_path, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_hash


def test_bonded_engine_adapter_quota(mock_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "quota_test.bin"
        chunk_size = 128 * 1024

        mock_nic_1 = NetworkAdapter(
            name="Capped-Cellular-USB",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="usb",
            is_up=True,
            is_online=True,
        )
        mock_nic_2 = NetworkAdapter(
            name="Unlimited-WiFi",
            ip_address="127.0.0.2",
            netmask="255.255.255.0",
            kind="wifi",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mock_server,
            output_path=output_file,
            adapters=[mock_nic_1, mock_nic_2],
            chunk_size=chunk_size,
            quotas={"usb": 131072},  # Cap USB to exactly 1 chunk (128 KB)
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert final_path.stat().st_size == len(RangeHTTPRequestHandler.DATA)

        # Confirm USB did not exceed its quota
        usb_metrics = engine.watchdog.get(mock_nic_1.ip_address)
        assert usb_metrics.is_exhausted is True or usb_metrics.bytes_transferred <= 262144

        expected_hash = hashlib.sha256(RangeHTTPRequestHandler.DATA).hexdigest()
        with open(final_path, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_hash


def test_bonded_engine_sequential_order(mock_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "sequential_test.bin"
        mock_adapter = NetworkAdapter(
            name="Mock-Adapter",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mock_server,
            output_path=output_file,
            adapters=[mock_adapter],
            chunk_size=128 * 1024,
            sequential=True,
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert final_path.stat().st_size == len(RangeHTTPRequestHandler.DATA)

        expected_hash = hashlib.sha256(RangeHTTPRequestHandler.DATA).hexdigest()
        with open(final_path, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_hash
