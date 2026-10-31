"""Tests for sparse file allocation and concurrent chunk writing."""

import hashlib
import tempfile
from pathlib import Path
import pytest
from plexo.core.sparse import SparseFileWriter


def test_sparse_file_allocation_and_writes():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "test_file.bin"
        total_size = 1024 * 1024  # 1 MB

        # Generate reference payload
        chunk_1 = b"A" * 512
        chunk_2 = b"B" * 512
        offset_1 = 0
        offset_2 = 1000

        with SparseFileWriter(target, total_size) as writer:
            writer.write_chunk(offset_1, chunk_1)
            writer.write_chunk(offset_2, chunk_2)
            writer.flush()

        assert target.exists()
        assert target.stat().st_size == total_size

        # Verify contents at written offsets
        with open(target, "rb") as f:
            f.seek(offset_1)
            assert f.read(len(chunk_1)) == chunk_1

            f.seek(offset_2)
            assert f.read(len(chunk_2)) == chunk_2


def test_sparse_file_out_of_bounds():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "bounds_test.bin"
        total_size = 100

        with SparseFileWriter(target, total_size) as writer:
            with pytest.raises(ValueError):
                writer.write_chunk(90, b"X" * 20)  # 90 + 20 = 110 > 100


def test_sparse_file_checksum():
    with tempfile.TemporaryDirectory() as tmpdir:
        target = Path(tmpdir) / "checksum_test.bin"
        payload = b"Hello, Plexo Multi-Network Bonding!"
        total_size = len(payload)

        with SparseFileWriter(target, total_size) as writer:
            writer.write_chunk(0, payload)
            calc_hash = writer.calculate_checksum("sha256")

        expected_hash = hashlib.sha256(payload).hexdigest()
        assert calc_hash == expected_hash
