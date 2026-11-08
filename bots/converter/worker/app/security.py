"""HMAC request signing shared with the bot (spec §2, §8).

signature = hex(HMAC-SHA256(WORKER_SECRET, f"{ts}.{nonce}.{METHOD}.{path_with_query}." + body))
headers:    X-Wanger-Timestamp: <unix seconds>
            X-Wanger-Nonce:     <16–64 chars [A-Za-z0-9_-], fresh per request, retries included>
            X-Wanger-Signature: <hex>

Accepted only within ±300 s, compared in constant time, and each nonce once (replay cache). The nonce
lets the bot retry the very same idempotent request (same job id, same body) inside one second
without the retry looking like a replay.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time

WINDOW_S = 300
_NONCE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def sign(secret: str, ts: int, nonce: str, method: str, path: str, body: bytes) -> str:
    msg = f"{ts}.{nonce}.{method.upper()}.{path}.".encode() + body
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


class AuthError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def verify(secret: str, ts_header: str | None, nonce: str | None, sig_header: str | None, method: str, path: str,
           body: bytes, seen, now: float | None = None) -> None:
    """Raises AuthError. `seen(nonce) -> bool` records a nonce and says whether it was new."""
    if not ts_header or not sig_header or not nonce:
        raise AuthError("MISSING_SIGNATURE")
    if not _NONCE.match(nonce):
        raise AuthError("BAD_NONCE")
    try:
        ts = int(ts_header)
    except ValueError as exc:
        raise AuthError("BAD_TIMESTAMP") from exc
    now = time.time() if now is None else now
    if abs(now - ts) > WINDOW_S:
        raise AuthError("STALE_TIMESTAMP")
    expected = sign(secret, ts, nonce, method, path, body)
    if not hmac.compare_digest(expected, sig_header.strip().lower()):
        raise AuthError("BAD_SIGNATURE")
    if not seen(nonce):
        raise AuthError("REPLAY")
