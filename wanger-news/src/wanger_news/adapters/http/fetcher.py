"""Outbound HTTP for feeds: SSRF guard on every hop, size cap, retries with backoff + jitter."""

from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin

import httpx

from wanger_news.adapters.http.ssrf import SsrfBlocked, UrlGuard
from wanger_news.config.models import HttpConfig

_REDIRECTS = frozenset({301, 302, 303, 307, 308})
FEED_ACCEPT = (
    "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, "
    "text/xml;q=0.9, */*;q=0.5"
)


@dataclass(frozen=True, slots=True)
class FetchResult:
    url: str  # final URL after redirects
    status: int
    body: bytes
    content_type: str | None
    etag: str | None
    last_modified: str | None
    not_modified: bool = False
    attempts: int = 1


class FetchError(Exception):
    """kind: timeout | connect | http_status | too_large | blocked | redirects"""

    def __init__(
        self,
        kind: str,
        message: str,
        retryable: bool,
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(f"{kind}: {message}")
        self.kind = kind
        self.message = message
        self.retryable = retryable
        self.status = status
        self.retry_after = retry_after


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


class SafeFetcher:
    def __init__(
        self,
        client: httpx.AsyncClient,
        guard: UrlGuard,
        cfg: HttpConfig,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self._client = client
        self._guard = guard
        self._cfg = cfg
        self._sleep = sleep
        self._rng = rng

    def backoff(self, attempt: int) -> float:
        """Exponential backoff with "equal jitter": half fixed, half random."""
        ceiling = min(
            float(self._cfg.backoff_max_seconds),
            float(self._cfg.backoff_base_seconds) * 2.0**attempt,
        )
        return ceiling / 2 + self._rng() * ceiling / 2

    async def fetch(
        self,
        url: str,
        *,
        etag: str | None = None,
        last_modified: str | None = None,
        accept: str = FEED_ACCEPT,
        retries: int | None = None,
    ) -> FetchResult:
        max_retries = self._cfg.retries if retries is None else retries
        attempt = 0
        while True:
            try:
                result = await self._fetch_once(url, etag, last_modified, accept)
                return replace(result, attempts=attempt + 1)
            except FetchError as exc:
                if not exc.retryable or attempt >= max_retries:
                    raise
                delay = self.backoff(attempt)
                if exc.retry_after is not None:
                    if exc.retry_after > self._cfg.retry_after_max_seconds:
                        raise
                    delay = max(delay, exc.retry_after)
                attempt += 1
                await self._sleep(delay)

    async def _fetch_once(
        self, url: str, etag: str | None, last_modified: str | None, accept: str
    ) -> FetchResult:
        headers = {"User-Agent": self._cfg.user_agent, "Accept": accept}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        current = url
        for _hop in range(self._cfg.max_redirects + 1):
            try:
                await self._guard.check(current)
            except SsrfBlocked as exc:
                raise FetchError("blocked", str(exc), retryable=False) from exc
            try:
                async with self._client.stream(
                    "GET", current, headers=headers, follow_redirects=False
                ) as resp:
                    if resp.status_code in _REDIRECTS:
                        location = resp.headers.get("location")
                        if not location:
                            raise FetchError(
                                "http_status", "redirect without location", False, resp.status_code
                            )
                        current = urljoin(current, location)
                        continue
                    return await self._read(current, resp)
            except httpx.TimeoutException as exc:
                raise FetchError("timeout", type(exc).__name__, retryable=True) from exc
            except httpx.TransportError as exc:
                raise FetchError("connect", type(exc).__name__, retryable=True) from exc
        raise FetchError("redirects", f"more than {self._cfg.max_redirects} redirects", False)

    async def _read(self, url: str, resp: httpx.Response) -> FetchResult:
        status = resp.status_code

        def result(body: bytes, not_modified: bool = False) -> FetchResult:
            return FetchResult(
                url=url,
                status=status,
                body=body,
                content_type=resp.headers.get("content-type"),
                etag=resp.headers.get("etag"),
                last_modified=resp.headers.get("last-modified"),
                not_modified=not_modified,
            )

        if status == 304:
            return result(b"", not_modified=True)
        if status == 429 or status >= 500:
            raise FetchError(
                "http_status",
                f"HTTP {status}",
                True,
                status,
                _retry_after(resp.headers.get("retry-after")),
            )
        if status >= 400:
            raise FetchError("http_status", f"HTTP {status}", False, status)
        limit = self._cfg.max_response_bytes
        declared = resp.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise FetchError("too_large", f"content-length {declared} > {limit}", False, status)
        body = bytearray()
        async for chunk in resp.aiter_bytes():
            body.extend(chunk)
            if len(body) > limit:
                raise FetchError("too_large", f"body > {limit} bytes", False, status)
        return result(bytes(body))
