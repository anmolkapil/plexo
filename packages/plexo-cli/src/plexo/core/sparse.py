"""Sparse file allocation and concurrent chunk writer.

Allows multiple worker threads/tasks to write disjoint byte ranges
directly into their target offsets concurrently.
"""

from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path
from typing import BinaryIO, Optional


class SparseFileWriter:
    """Manages thread-safe random-access writes into a pre-allocated file."""

    def __init__(self, target_path: str | Path, total_bytes: int):
        self.target_path = Path(target_path).resolve()
        self.total_bytes = total_bytes
        self._lock = threading.Lock()
        self._file: Optional[BinaryIO] = None
        self._written_bytes = 0

        # Ensure parent directory exists
        self.target_path.parent.mkdir(parents=True, exist_ok=True)
        self._allocate()

    def _allocate(self) -> None:
        """Pre-allocates the file size on disk or preserves existing if size matches."""
        needs_allocate = True
        if self.target_path.exists():
            try:
                if self.target_path.stat().st_size == self.total_bytes:
                    needs_allocate = False
            except OSError:
                pass

        if needs_allocate:
            with open(self.target_path, "wb") as f:
                if self.total_bytes > 0:
                    f.seek(self.total_bytes - 1)
                    f.write(b"\0")
                f.flush()

        # Open in r+b mode for concurrent random-access writes
        self._file = open(self.target_path, "r+b")

    def write_chunk(self, offset: int, data: bytes) -> int:
        """Writes a byte block at the specified offset."""
        if not self._file:
            raise RuntimeError("File writer is closed.")

        length = len(data)
        if offset + length > self.total_bytes:
            raise ValueError(
                f"Write out of bounds: offset {offset} + len {length} > total {self.total_bytes}"
            )

        with self._lock:
            self._file.seek(offset)
            self._file.write(data)
            self._written_bytes += length

        return length

    def flush(self) -> None:
        """Flushes written buffers to disk."""
        with self._lock:
            if self._file:
                self._file.flush()
                try:
                    os.fsync(self._file.fileno())
                except OSError:
                    pass

    def close(self) -> None:
        """Closes the underlying file handle."""
        with self._lock:
            if self._file:
                try:
                    self._file.flush()
                    self._file.close()
                finally:
                    self._file = None

    def calculate_checksum(self, algorithm: str = "sha256") -> str:
        """Calculates file checksum to verify integrity."""
        self.flush()
        hasher = hashlib.new(algorithm)
        with open(self.target_path, "rb") as f:
            while chunk := f.read(1024 * 1024):  # 1 MB blocks
                hasher.update(chunk)
        return hasher.hexdigest()

    def __enter__(self) -> "SparseFileWriter":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.close()
