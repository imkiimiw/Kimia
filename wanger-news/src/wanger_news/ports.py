"""Ports (interfaces) the services depend on. Adapters implement them; tests fake them.

Phase 1 implements: Clock, FeedFetcher (adapters/http), BotApi (adapters/telegram), EventMatcher
(no-op). AIProvider is defined in wanger_news.ai.provider and implemented in Phase 2.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from wanger_news.adapters.http.fetcher import FetchResult
from wanger_news.domain.article import ArticleDraft


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FeedFetcher(Protocol):
    async def fetch(
        self, url: str, *, etag: str | None = None, last_modified: str | None = None
    ) -> FetchResult: ...


class BotApi(Protocol):
    async def call(
        self, method: str, payload: dict[str, Any] | None = None, *, idempotent: bool = False
    ) -> Any: ...


class EventMatcher(Protocol):
    """Level-3 duplicate detection: "same event" (embeddings + entities + time + place).

    Phase 3 implements it with pgvector. Returns the id of the article that reported the same
    event, or None.
    """

    async def find_same_event(self, draft: ArticleDraft) -> int | None: ...


class NullEventMatcher:
    async def find_same_event(self, draft: ArticleDraft) -> int | None:
        return None


class MotherBot(Protocol):
    """Link to the owner's "mother bot" (spec §0). Interface only in Phase 1.

    A later phase implements it (e.g. a signed HTTPS call or a Telegram message to the mother
    bot). It must never block or fail a run: implementations swallow their own errors.
    """

    async def report_run(self, summary: dict[str, Any]) -> None: ...

    async def report_event(self, kind: str, payload: dict[str, Any]) -> None: ...


class NullMotherBot:
    async def report_run(self, summary: dict[str, Any]) -> None:
        return None

    async def report_event(self, kind: str, payload: dict[str, Any]) -> None:
        return None
