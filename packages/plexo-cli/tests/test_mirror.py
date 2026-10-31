"""Tests for multi-source mirror bonding downloads."""

import hashlib
import http.server
import socketserver
import tempfile
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from plexo.cli import main
from plexo.core.adapter import NetworkAdapter
from plexo.core.client import BoundRangeClient, probe_mirrors
from plexo.core.engine import BondingDownloadEngine


TEST_PAYLOAD = b"MIRROR_BONDING_PAYLOAD_CHUNK_DATA_!" * 1024 * 32  # ~1.15 MB


class MockMirrorHandler(http.server.BaseHTTPRequestHandler):
    """HTTP Range server representing a mirror."""

    DATA = TEST_PAYLOAD
    FAIL_MODE = False  # If True, returns HTTP 500

    def do_HEAD(self):
        if self.FAIL_MODE:
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(self.DATA)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def do_GET(self):
        if self.FAIL_MODE:
            self.send_response(500)
            self.end_headers()
            return

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
        pass


class FailingMirrorHandler(http.server.BaseHTTPRequestHandler):
    """Mirror that always returns HTTP 500 error."""

    def do_HEAD(self):
        self.send_response(500)
        self.end_headers()

    def do_GET(self):
        self.send_response(500)
        self.end_headers()

    def log_message(self, format, *args):
        pass


@pytest.fixture
def two_mirror_servers():
    server1 = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
    port1 = server1.server_address[1]
    t1 = threading.Thread(target=server1.serve_forever, daemon=True)
    t1.start()

    server2 = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
    port2 = server2.server_address[1]
    t2 = threading.Thread(target=server2.serve_forever, daemon=True)
    t2.start()

    url1 = f"http://127.0.0.1:{port1}/content.bin"
    url2 = f"http://127.0.0.1:{port2}/content.bin"

    yield url1, url2

    server1.shutdown()
    server2.shutdown()


@pytest.fixture
def failing_and_healthy_mirrors():
    dead_server = socketserver.TCPServer(("127.0.0.1", 0), FailingMirrorHandler)
    dead_port = dead_server.server_address[1]
    t_dead = threading.Thread(target=dead_server.serve_forever, daemon=True)
    t_dead.start()

    healthy_server = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
    healthy_port = healthy_server.server_address[1]
    t_healthy = threading.Thread(target=healthy_server.serve_forever, daemon=True)
    t_healthy.start()

    dead_url = f"http://127.0.0.1:{dead_port}/dead.bin"
    healthy_url = f"http://127.0.0.1:{healthy_port}/healthy.bin"

    yield dead_url, healthy_url

    dead_server.shutdown()
    healthy_server.shutdown()


def test_multi_mirror_bonded_download(two_mirror_servers):
    mirror1, mirror2 = two_mirror_servers

    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "bonded_mirrors.bin"

        adapter1 = NetworkAdapter(
            name="Link-1",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="wifi",
            is_up=True,
            is_online=True,
        )
        adapter2 = NetworkAdapter(
            name="Link-2",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mirror1,
            mirrors=[mirror2],
            output_path=output_file,
            adapters=[adapter1, adapter2],
            chunk_size=128 * 1024,
            workers_per_adapter=1,
        )

        final_path = engine.execute()

        assert final_path.exists()
        assert final_path.stat().st_size == len(TEST_PAYLOAD)

        # Verify SHA-256 matches exactly
        expected_hash = hashlib.sha256(TEST_PAYLOAD).hexdigest()
        with open(final_path, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_hash

        # Verify both mirrors actively served chunks
        assert engine.mirror_bytes[mirror1] > 0
        assert engine.mirror_bytes[mirror2] > 0
        assert engine.mirror_bytes[mirror1] + engine.mirror_bytes[mirror2] == len(TEST_PAYLOAD)


def test_single_adapter_multi_mirror_download(two_mirror_servers):
    mirror1, mirror2 = two_mirror_servers

    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "single_adapter_mirrors.bin"

        adapter = NetworkAdapter(
            name="Single-NIC",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="wifi",
            is_up=True,
            is_online=True,
        )

        engine = BondingDownloadEngine(
            url=mirror1,
            mirrors=[mirror2],
            output_path=output_file,
            adapters=[adapter],
            chunk_size=128 * 1024,
            workers_per_adapter=2,
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert final_path.stat().st_size == len(TEST_PAYLOAD)

        # Chunks distributed across both mirrors even on a single adapter
        assert engine.mirror_bytes[mirror1] > 0
        assert engine.mirror_bytes[mirror2] > 0


def test_mirror_failover(failing_and_healthy_mirrors):
    dead_url, healthy_url = failing_and_healthy_mirrors

    with tempfile.TemporaryDirectory() as tmpdir:
        output_file = Path(tmpdir) / "failover_test.bin"

        adapter = NetworkAdapter(
            name="Test-NIC",
            ip_address="127.0.0.1",
            netmask="255.255.255.0",
            kind="ethernet",
            is_up=True,
            is_online=True,
        )

        # Primary URL is the dead mirror; secondary mirror is healthy
        engine = BondingDownloadEngine(
            url=dead_url,
            mirrors=[healthy_url],
            output_path=output_file,
            adapters=[adapter],
            chunk_size=128 * 1024,
            workers_per_adapter=1,
        )

        final_path = engine.execute()
        assert final_path.exists()
        assert final_path.stat().st_size == len(TEST_PAYLOAD)

        # Verify all bytes were fetched successfully from healthy mirror
        expected_hash = hashlib.sha256(TEST_PAYLOAD).hexdigest()
        with open(final_path, "rb") as f:
            assert hashlib.sha256(f.read()).hexdigest() == expected_hash

        assert engine.mirror_bytes[healthy_url] == len(TEST_PAYLOAD)


def test_probe_mirrors(two_mirror_servers):
    mirror1, mirror2 = two_mirror_servers
    probe, verified = probe_mirrors([mirror1, mirror2])

    assert probe.total_bytes == len(TEST_PAYLOAD)
    assert probe.accepts_ranges is True
    assert mirror1 in verified
    assert mirror2 in verified


def test_bound_range_client_fetch_range_from_mirrors(failing_and_healthy_mirrors):
    dead_url, healthy_url = failing_and_healthy_mirrors
    client = BoundRangeClient(local_ip="127.0.0.1")

    # Fetch range from list starting with failing mirror; should fall back to healthy mirror
    data = bytearray()
    for chunk in client.fetch_range_from_mirrors([dead_url, healthy_url], start_byte=0, end_byte=255):
        data.extend(chunk)

    assert len(data) == 256
    assert data == TEST_PAYLOAD[:256]


def test_cli_download_mirror_option():
    runner = CliRunner()
    result = runner.invoke(main, ["download", "--help"])
    assert result.exit_code == 0
    assert "-m" in result.output
    assert "--mirror" in result.output


def test_inflight_chunk_failover_to_mirror():
    class ProbeOkGetFailHandler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(TEST_PAYLOAD)))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

        def do_GET(self):
            # Probe HEAD succeeds, but range GET fails
            self.send_response(503)
            self.end_headers()

        def log_message(self, format, *args):
            pass

    server_flaky = socketserver.TCPServer(("127.0.0.1", 0), ProbeOkGetFailHandler)
    port_flaky = server_flaky.server_address[1]
    t1 = threading.Thread(target=server_flaky.serve_forever, daemon=True)
    t1.start()

    server_good = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
    port_good = server_good.server_address[1]
    t2 = threading.Thread(target=server_good.serve_forever, daemon=True)
    t2.start()

    flaky_url = f"http://127.0.0.1:{port_flaky}/file.bin"
    good_url = f"http://127.0.0.1:{port_good}/file.bin"

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file = Path(tmpdir) / "inflight_failover.bin"
            adapter = NetworkAdapter(
                name="Test-Adapter",
                ip_address="127.0.0.1",
                netmask="255.255.255.0",
                kind="ethernet",
                is_up=True,
                is_online=True,
            )

            engine = BondingDownloadEngine(
                url=flaky_url,
                mirrors=[good_url],
                output_path=output_file,
                adapters=[adapter],
                chunk_size=128 * 1024,
                workers_per_adapter=1,
            )

            final_path = engine.execute()
            assert final_path.exists()
            assert final_path.stat().st_size == len(TEST_PAYLOAD)

            expected_hash = hashlib.sha256(TEST_PAYLOAD).hexdigest()
            with open(final_path, "rb") as f:
                assert hashlib.sha256(f.read()).hexdigest() == expected_hash

            assert engine.mirror_bytes[good_url] == len(TEST_PAYLOAD)
    finally:
        server_flaky.shutdown()
        server_good.shutdown()


def test_three_mirrors_on_single_adapter():
    """Verify that chunks cycle across all mirrors when mirrors > adapters."""
    servers = []
    urls = []
    for _ in range(3):
        srv = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
        servers.append(srv)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        urls.append(f"http://127.0.0.1:{srv.server_address[1]}/chunk.bin")

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_file = Path(tmpdir) / "three_mirrors.bin"
            adapter = NetworkAdapter(
                name="Single-NIC",
                ip_address="127.0.0.1",
                netmask="255.255.255.0",
                kind="wifi",
                is_up=True,
                is_online=True,
            )

            engine = BondingDownloadEngine(
                url=urls[0],
                mirrors=urls[1:],
                output_path=output_file,
                adapters=[adapter],
                chunk_size=128 * 1024,
                workers_per_adapter=1,
            )

            final_path = engine.execute()
            assert final_path.exists()
            assert final_path.stat().st_size == len(TEST_PAYLOAD)

            # All 3 mirrors must have actively served chunks
            for u in urls:
                assert engine.mirror_bytes[u] > 0, f"Mirror {u} was not used!"
            assert sum(engine.mirror_bytes[u] for u in urls) == len(TEST_PAYLOAD)
    finally:
        for srv in servers:
            srv.shutdown()


def test_probe_mirrors_rejects_incompatible():
    class NoRangeHandler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(TEST_PAYLOAD)))
            self.end_headers()

        def log_message(self, format, *args):
            pass

    class BadSizeHandler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", "999")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

        def log_message(self, format, *args):
            pass

    srv_good = socketserver.TCPServer(("127.0.0.1", 0), MockMirrorHandler)
    srv_norange = socketserver.TCPServer(("127.0.0.1", 0), NoRangeHandler)
    srv_badsize = socketserver.TCPServer(("127.0.0.1", 0), BadSizeHandler)

    for srv in (srv_good, srv_norange, srv_badsize):
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    url_good = f"http://127.0.0.1:{srv_good.server_address[1]}/f.bin"
    url_norange = f"http://127.0.0.1:{srv_norange.server_address[1]}/f.bin"
    url_badsize = f"http://127.0.0.1:{srv_badsize.server_address[1]}/f.bin"

    try:
        probe, verified = probe_mirrors([url_good, url_norange, url_badsize])
        assert url_good in verified
        assert url_norange not in verified
        assert url_badsize not in verified
    finally:
        srv_good.shutdown()
        srv_norange.shutdown()
        srv_badsize.shutdown()
