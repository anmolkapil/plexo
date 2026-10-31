"""Magnet URI and .torrent file metadata parser."""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional
from urllib.parse import parse_qs, unquote, urlparse
from .bencode import bdecode, bencode


@dataclass
class TorrentFileEntry:
    """Represents an individual file within a multi-file or single-file torrent."""
    index: int  # 1-based index (e.g. 1, 2, 3...)
    path: str
    length: int
    offset_start: int
    offset_end: int

    @property
    def size_mb(self) -> float:
        return self.length / (1024 * 1024)

    @property
    def size_gb(self) -> float:
        return self.length / (1024 * 1024 * 1024)


@dataclass
class TorrentMetadata:
    """Represents resolved BitTorrent swarm metadata."""
    name: str
    info_hash: bytes
    total_length: int
    piece_length: int
    pieces: List[bytes] = field(default_factory=list)
    trackers: List[str] = field(default_factory=list)
    files: List[TorrentFileEntry] = field(default_factory=list)

    @property
    def info_hash_hex(self) -> str:
        return self.info_hash.hex()

    @property
    def num_pieces(self) -> int:
        return len(self.pieces) if self.pieces else 0

    def get_piece_range_for_files(self, selected_indices: List[int]) -> List[int]:
        """Returns the piece indices required to download only the selected file indices."""
        if not selected_indices:
            return list(range(self.num_pieces))

        if self.piece_length <= 0:
            return list(range(self.num_pieces))

        required = set()
        for f in self.files:
            if f.index in selected_indices:
                p_start = f.offset_start // self.piece_length
                p_end = f.offset_end // self.piece_length
                for p in range(p_start, min(p_end + 1, self.num_pieces)):
                    required.add(p)

        return sorted(list(required))


def parse_magnet(uri: str) -> TorrentMetadata:
    """Parses a magnet link into a TorrentMetadata instance."""
    if not uri.startswith("magnet:?"):
        raise ValueError("Invalid magnet URI: must start with 'magnet:?'")

    parsed = urlparse(uri)
    params = parse_qs(parsed.query)

    xt_list = params.get("xt", [])
    btih = None
    for xt in xt_list:
        if xt.startswith("urn:btih:"):
            btih = xt[len("urn:btih:"):]
            break

    if not btih:
        raise ValueError("Magnet URI missing required 'urn:btih:' info hash.")

    if len(btih) == 40:
        info_hash = bytes.fromhex(btih)
    elif len(btih) == 32:
        info_hash = base64.b32decode(btih.upper())
    else:
        raise ValueError(f"Invalid BTIH length: {len(btih)}")

    dn = params.get("dn", ["torrent_download"])[0]
    name = unquote(dn)
    trackers = [unquote(tr) for tr in params.get("tr", [])]

    return TorrentMetadata(
        name=name,
        info_hash=info_hash,
        total_length=0,
        piece_length=0,
        trackers=trackers,
        files=[TorrentFileEntry(index=1, path=name, length=0, offset_start=0, offset_end=0)],
    )


def parse_torrent_file(path: str | Path) -> TorrentMetadata:
    """Parses a .torrent file from disk with full multi-file manifest."""
    with open(path, "rb") as f:
        data = f.read()

    meta = bdecode(data)
    info = meta.get("info", {})

    info_bytes = bencode(info)
    info_hash = hashlib.sha1(info_bytes).digest()

    name = info.get("name", b"download").decode("utf-8", errors="replace")
    piece_length = info.get("piece length", 0)
    raw_pieces = info.get("pieces", b"")
    pieces = [raw_pieces[i : i + 20] for i in range(0, len(raw_pieces), 20)]

    files: List[TorrentFileEntry] = []
    current_offset = 0

    if "files" in info:
        # Multi-file torrent (e.g. TV season packs, game folders)
        for idx, f in enumerate(info["files"], start=1):
            flen = f.get("length", 0)
            path_parts = [p.decode("utf-8", errors="replace") for p in f.get("path", [])]
            rel_path = "/".join(path_parts) if path_parts else f"file_{idx}"
            files.append(
                TorrentFileEntry(
                    index=idx,
                    path=rel_path,
                    length=flen,
                    offset_start=current_offset,
                    offset_end=current_offset + flen - 1 if flen > 0 else current_offset,
                )
            )
            current_offset += flen
        total_length = current_offset
    else:
        # Single-file torrent
        total_length = info.get("length", 0)
        files.append(
            TorrentFileEntry(
                index=1,
                path=name,
                length=total_length,
                offset_start=0,
                offset_end=total_length - 1 if total_length > 0 else 0,
            )
        )

    trackers = []
    if "announce" in meta:
        trackers.append(meta["announce"].decode("ascii", errors="ignore"))
    if "announce-list" in meta:
        for tier in meta["announce-list"]:
            for tr in tier:
                trackers.append(tr.decode("ascii", errors="ignore"))

    return TorrentMetadata(
        name=name,
        info_hash=info_hash,
        total_length=total_length,
        piece_length=piece_length,
        pieces=pieces,
        trackers=list(dict.fromkeys(trackers)),
        files=files,
    )
