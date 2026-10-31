"""Tests for BitTorrent metadata parsing, bencoding, and multi-adapter piece downloading."""

import hashlib
import tempfile
from pathlib import Path
import pytest
from plexo.core.adapter import NetworkAdapter
from plexo.torrent.bencode import bdecode, bencode
from plexo.torrent.client import TorrentBondingEngine
from plexo.torrent.metadata import TorrentMetadata, parse_magnet


def test_bencode_bdecode_roundtrip():
    original = {
        "announce": "http://tracker.example.com/announce",
        "info": {
            "name": "sample.iso",
            "piece length": 262144,
            "length": 1048576,
            "pieces": b"12345678901234567890",
        },
    }
    encoded = bencode(original)
    assert isinstance(encoded, bytes)

    decoded = bdecode(encoded)
    assert decoded["announce"] == b"http://tracker.example.com/announce"
    assert decoded["info"]["name"] == b"sample.iso"
    assert decoded["info"]["length"] == 1048576


def test_parse_magnet_uri():
    uri = (
        "magnet:?xt=urn:btih:da39a3ee5e6b4b0d3255bfef95601890afd80709"
        "&dn=Ubuntu_Linux.iso"
        "&tr=http%3A%2F%2Ftracker.ubuntu.com%2Fannounce"
    )
    meta = parse_magnet(uri)
    assert meta.name == "Ubuntu_Linux.iso"
    assert meta.info_hash_hex == "da39a3ee5e6b4b0d3255bfef95601890afd80709"
    assert len(meta.trackers) == 1
    assert "tracker.ubuntu.com" in meta.trackers[0]


def test_torrent_bonding_engine_download():
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create 2 pieces of data
        piece_size = 1024
        p1 = b"T" * piece_size
        p2 = b"T" * piece_size

        h1 = hashlib.sha1(p1).digest()
        h2 = hashlib.sha1(p2).digest()

        meta = TorrentMetadata(
            name="test_torrent_payload.bin",
            info_hash=hashlib.sha1(b"info_mock").digest(),
            total_length=piece_size * 2,
            piece_length=piece_size,
            pieces=[h1, h2],
            trackers=["http://mock.tracker/announce"],
        )

        mock_nic_1 = NetworkAdapter(
            name="Hostel-WiFi",
            ip_address="192.168.1.50",
            netmask="255.255.255.0",
            kind="wifi",
            is_up=True,
            is_online=True,
        )
        mock_nic_2 = NetworkAdapter(
            name="Phone-5G-USB",
            ip_address="192.168.43.10",
            netmask="255.255.255.0",
            kind="usb",
            is_up=True,
            is_online=True,
        )

        engine = TorrentBondingEngine(
            metadata=meta,
            output_dir=tmpdir,
            adapters=[mock_nic_1, mock_nic_2],
        )

        final_path = engine.download()

        assert final_path.exists()
        assert final_path.stat().st_size == piece_size * 2

        with open(final_path, "rb") as f:
            content = f.read()

        assert content == p1 + p2


def test_torrent_multi_file_selection():
    from plexo.torrent.metadata import TorrentFileEntry
    with tempfile.TemporaryDirectory() as tmpdir:
        piece_size = 1024
        p1 = b"T" * piece_size
        p2 = b"T" * piece_size

        h1 = hashlib.sha1(p1).digest()
        h2 = hashlib.sha1(p2).digest()

        f1 = TorrentFileEntry(index=1, path="Season 1/Ep1.mkv", length=piece_size, offset_start=0, offset_end=piece_size - 1)
        f2 = TorrentFileEntry(index=2, path="Season 1/Ep2.mkv", length=piece_size, offset_start=piece_size, offset_end=piece_size * 2 - 1)

        meta = TorrentMetadata(
            name="Series.S01",
            info_hash=hashlib.sha1(b"info_mock").digest(),
            total_length=piece_size * 2,
            piece_length=piece_size,
            pieces=[h1, h2],
            trackers=["http://mock.tracker/announce"],
            files=[f1, f2],
        )

        required_pieces = meta.get_piece_range_for_files([2])
        assert required_pieces == [1]

        mock_nic = NetworkAdapter(
            name="Hostel-WiFi",
            ip_address="192.168.1.50",
            netmask="255.255.255.0",
            kind="wifi",
            is_up=True,
            is_online=True,
        )

        engine = TorrentBondingEngine(
            metadata=meta,
            output_dir=tmpdir,
            adapters=[mock_nic],
            selected_files=[2],
        )

        final_path = engine.download()
        assert final_path.exists()
