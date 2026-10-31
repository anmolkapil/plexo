"""Lightweight Bencoding encoder/decoder for BitTorrent metadata."""

from __future__ import annotations

from typing import Any, Tuple


def bdecode(data: bytes) -> Any:
    """Decodes bencoded bytes into Python types."""
    val, _ = _bdecode_part(data, 0)
    return val


def _bdecode_part(data: bytes, idx: int) -> Tuple[Any, int]:
    char = data[idx : idx + 1]

    if char == b"i":
        end = data.index(b"e", idx)
        return int(data[idx + 1 : end]), end + 1

    if char == b"l":
        items = []
        curr = idx + 1
        while data[curr : curr + 1] != b"e":
            item, curr = _bdecode_part(data, curr)
            items.append(item)
        return items, curr + 1

    if char == b"d":
        mapping = {}
        curr = idx + 1
        while data[curr : curr + 1] != b"e":
            key, curr = _bdecode_part(data, curr)
            val, curr = _bdecode_part(data, curr)
            mapping[key.decode("latin1")] = val
        return mapping, curr + 1

    # String / Bytes: <length>:<bytes>
    colon = data.index(b":", idx)
    length = int(data[idx:colon])
    start = colon + 1
    end = start + length
    return data[start:end], end


def bencode(val: Any) -> bytes:
    """Encodes Python types into bencoded bytes."""
    if isinstance(val, int):
        return f"i{val}e".encode("ascii")
    if isinstance(val, (bytes, bytearray)):
        return f"{len(val)}:".encode("ascii") + bytes(val)
    if isinstance(val, str):
        encoded = val.encode("utf-8")
        return f"{len(encoded)}:".encode("ascii") + encoded
    if isinstance(val, list):
        return b"l" + b"".join(bencode(i) for i in val) + b"e"
    if isinstance(val, dict):
        out = b"d"
        for k in sorted(val.keys()):
            out += bencode(k) + bencode(val[k])
        return out + b"e"
    raise TypeError(f"Cannot bencode type: {type(val)}")
