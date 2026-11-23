"""The link to the owner's mother bot (spec §0; Phase 6): signed JSON reports over HTTPS.

Implements the ``MotherBot`` port. Every request is a POST of one JSON document::

    {"bot": "wanger-news", "version": "...", "kind": "run|published|review|error|weekly|ping",
     "sent_at": "<ISO time>", "payload": {...}}

with ``X-Wanger-Timestamp`` (Unix seconds) and ``X-Wanger-Signature: sha256=<hex>`` = HMAC-SHA256
of ``<timestamp>.<body>`` with the shared ``WANGER_NEWS_MOTHER_SECRET``. The receiver checks the
signature and rejects timestamps older than a few minutes (``verify_signature``). Payloads are
counts and ids, never secrets or article text. Errors are logged and swallowed: the link can
never fail or slow down a run beyond ``mother_bot.timeout_seconds``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr

from wanger_news import __version__
from wanger_news.config.models import MotherBotConfig

log = logging.getLogger("wanger_news")

SIGNATURE_HEADER = "X-Wanger-Signature"
TIMESTAMP_HEADER = "X-Wanger-Timestamp"
EVENT_HEADER = "X-Wanger-Event"
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


class MotherBotError(ValueError):
    pass


def check_url(url: str) -> str:
    """HTTPS only (plain HTTP only to this machine, for development)."""
    parts = urlsplit(url.strip())
    if parts.scheme == "https" and parts.hostname:
        return url.strip()
    if parts.scheme == "http" and parts.hostname in LOCAL_HOSTS:
        return url.strip()
    raise MotherBotError("WANGER_NEWS_MOTHER_URL must be an https:// address")


def sign(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + digest.hexdigest()


def verify_signature(
    secret: str, timestamp: str, body: bytes, signature: str, *, now: float, max_skew: int = 300
) -> bool:
    """For the receiving side (and tests): a valid signature on a fresh timestamp."""
    if not timestamp.isdigit() or abs(now - int(timestamp)) > max_skew:
        return False
    return hmac.compare_digest(sign(secret, timestamp, body), signature)


class HttpMotherBot:
    def __init__(
        self,
        url: str,
        secret: SecretStr,
        client: httpx.AsyncClient,
        config: MotherBotConfig,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if not secret.get_secret_value():
            raise MotherBotError("WANGER_NEWS_MOTHER_SECRET is empty")
        self._url = check_url(url)
        self._secret = secret
        self._client = client
        self._cfg = config
        self._clock = clock

    @property
    def host(self) -> str:
        return urlsplit(self._url).hostname or ""

    async def report_run(self, summary: dict[str, Any]) -> None:
        if "run" in self._cfg.events:
            await self._post("run", summary)

    async def report_event(self, kind: str, payload: dict[str, Any]) -> None:
        if kind in self._cfg.events:
            await self._post(kind, payload)

    async def ping(self) -> str | None:
        """doctor: one signed ``ping``. None when the mother bot answered 2xx, else why not."""
        return await self._post("ping", {"hello": "wanger-news"})

    async def _post(self, kind: str, payload: dict[str, Any]) -> str | None:
        document = {
            "bot": "wanger-news",
            "version": __version__,
            "kind": kind,
            "sent_at": datetime.fromtimestamp(self._clock(), UTC).isoformat(),
            "payload": payload,
        }
        body = json.dumps(document, ensure_ascii=False, default=str, separators=(",", ":")).encode()
        timestamp = str(int(self._clock()))
        headers = {
            "Content-Type": "application/json",
            "User-Agent": f"wanger-news/{__version__}",
            TIMESTAMP_HEADER: timestamp,
            SIGNATURE_HEADER: sign(self._secret.get_secret_value(), timestamp, body),
            EVENT_HEADER: kind,
        }
        try:
            response = await self._client.post(
                self._url,
                content=body,
                headers=headers,
                timeout=self._cfg.timeout_seconds,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            log.warning("mother_bot_unreachable", extra={"kind": kind, "error": type(exc).__name__})
            return f"unreachable ({type(exc).__name__})"
        if not 200 <= response.status_code < 300:
            log.warning("mother_bot_rejected", extra={"kind": kind, "status": response.status_code})
            return f"HTTP {response.status_code}"
        return None
