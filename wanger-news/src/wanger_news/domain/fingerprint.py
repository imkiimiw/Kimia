"""Content fingerprints: exact content hash and 64-bit SimHash (near-duplicates, level 2)."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from wanger_news.domain.text import tokens

_MASK64 = (1 << 64) - 1
_SIGN64 = 1 << 63


def content_hash(title: str, body: str) -> str | None:
    """sha256 of the normalized text; None when there is no text at all."""
    normalized = " ".join(tokens(f"{title}\n{body}"))
    if not normalized:
        return None
    return "sha256:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _hash64(token: str) -> int:
    return int.from_bytes(hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest(), "big")


def simhash64(words: Sequence[str], shingle_size: int) -> int:
    """Charikar SimHash over word shingles. Returns an unsigned 64-bit integer."""
    if not words:
        return 0
    size = max(1, min(shingle_size, len(words)))
    weights = [0] * 64
    for i in range(len(words) - size + 1):
        h = _hash64(" ".join(words[i : i + size]))
        for bit in range(64):
            weights[bit] += 1 if (h >> bit) & 1 else -1
    value = 0
    for bit, weight in enumerate(weights):
        if weight > 0:
            value |= 1 << bit
    return value


def hamming(a: int, b: int) -> int:
    return ((a ^ b) & _MASK64).bit_count()


def to_signed64(value: int) -> int:
    """Store an unsigned 64-bit value in a signed BIGINT column."""
    value &= _MASK64
    return value - (1 << 64) if value & _SIGN64 else value


def from_signed64(value: int) -> int:
    return value & _MASK64
