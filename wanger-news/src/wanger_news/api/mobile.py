"""Mobile / public API (Phase 6, option B): read-only ``/api/v1`` over what was PUBLISHED.

Its own token (``WANGER_NEWS_MOBILE_API_TOKEN``, separate from the admin token, so a token
shipped inside an app can never change anything). It only reads posts already sent to the feed
channel (``public_api.feed_channel``, the main channel by default) — never queued, rejected or
pending items, never review data. Keyset pagination (``cursor``), a per-client request limit
and, when configured, CORS for the listed origins.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news.ai.provider import AIProvider
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, PublishedPost
from wanger_news.domain.chatref import ChatRef, post_url
from wanger_news.domain.enums import Transport
from wanger_news.domain.scoring import label
from wanger_news.ports import Clock
from wanger_news.services import overrides
from wanger_news.services.publish import PublishService
from wanger_news.services.search import SearchService
from wanger_news.services.weekly import WeeklyService

FEED_WINDOW_DAYS = 365
MAX_SCANS = 10


@dataclass(slots=True)
class RateLimiter:
    """A fixed one-minute window per client address (one process; option B runs one)."""

    per_minute: int
    clock: Callable[[], float] = time.monotonic
    _windows: dict[str, tuple[float, int]] = field(default_factory=dict)

    def allow(self, client: str) -> bool:
        now = self.clock()
        start, count = self._windows.get(client, (now, 0))
        if now - start >= 60:
            start, count = now, 0
        if count >= self.per_minute:
            self._windows[client] = (start, count)
            return False
        self._windows[client] = (start, count + 1)
        if len(self._windows) > 10_000:  # forget idle clients
            self._windows = {k: v for k, v in self._windows.items() if now - v[0] < 60}
        return True


def encode_cursor(sent_at: datetime, post_id: int) -> str:
    raw = f"{sent_at.isoformat()}|{post_id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        at, _, pid = base64.urlsafe_b64decode(padded.encode()).decode().partition("|")
        return datetime.fromisoformat(at), int(pid)
    except (ValueError, binascii.Error, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="invalid cursor") from None


def mobile_router(
    *,
    config: AppConfig,
    engine: AsyncEngine,
    token: SecretStr,
    clock: Clock,
    channels: dict[str, ChatRef | None],
    ai: AIProvider | None = None,
    limiter: RateLimiter | None = None,
) -> APIRouter:
    cfg = config.pipeline.public_api
    limiter = limiter or RateLimiter(cfg.requests_per_minute)
    search = SearchService(config, ai)
    weekly_service = WeeklyService(config, PublishService(config))  # numbers only; sends nothing

    async def authorized(request: Request) -> None:
        client = request.client.host if request.client else "-"
        if not limiter.allow(client):
            raise HTTPException(status_code=429, detail="too many requests")
        given = request.headers.get("authorization", "")
        expected = f"Bearer {token.get_secret_value()}"
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="invalid or missing token")

    async def repos() -> AsyncIterator[Repositories]:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield Repositories(session)

    router = APIRouter(prefix="/api/v1", dependencies=[Depends(authorized)])
    db = Depends(repos)

    async def feed_chat(r: Repositories) -> str:
        """The feed channel as the bot panel set it (over the environment)."""
        ov = await overrides.Overrides.read(r)
        test, main = overrides.channels(channels.get("test"), channels.get("main"), ov)
        chat = main if cfg.feed_channel == "main" else test
        if chat is None:
            raise HTTPException(status_code=503, detail="the feed channel is not configured")
        return str(chat.api_value).lower()

    async def item(
        r: Repositories, post: PublishedPost, article: Article, lang: str
    ) -> dict[str, Any]:
        summary = None
        if lang != "fa":
            summary = await r.published.summary_in(article.id, lang)
        if summary is None:
            summary = await r.summaries.get(article.summary_id)
        story = await r.stories.get(article.cluster_id)
        source = config.source(article.source_id)
        if article.transport == Transport.TELEGRAM_CHANNEL.value or summary is None:
            text = post.text or article.title_original
            title, _, rest = text.strip().partition("\n")
            body = {"title": title[:200], "summary": rest.strip(), "key_points": []}
            language = article.language
        else:
            body = {
                "title": summary.title,
                "summary": summary.summary,
                "key_points": list(summary.key_points or []),
            }
            language = summary.language
        names = (
            list(dict.fromkeys(str(s.get("name")) for s in story.sources))
            if story is not None and story.sources
            else [source.name if source else article.source_id]
        )
        return {
            "id": article.id,
            "story_id": article.cluster_id,
            "kind": "source_post"
            if article.transport == Transport.TELEGRAM_CHANNEL.value
            else post.kind,
            "language": language,
            **body,
            "category": article.category,
            "breaking": post.breaking,
            "status": "conflicting"
            if story is not None and story.contradictions
            else label(article.confidence_score or 0, config.pipeline.scoring),
            "sources": names,
            "source_url": article.canonical_url or article.url,
            "post_url": post_url(post.chat_id, post.message_ids[0] if post.message_ids else None),
            "published_at": (post.sent_at or article.effective_at).isoformat(),
        }

    @router.get("/feed")
    async def feed(
        cursor: str | None = None,
        limit: int | None = Query(None, ge=1),
        category: str | None = None,
        lang: str = Query("fa", pattern="^(fa|en)$"),
        r: Repositories = db,
    ) -> dict[str, Any]:
        size = min(limit or cfg.page_size, cfg.max_page_size)
        chat = await feed_chat(r)
        scan = decode_cursor(cursor) if cursor else None
        since = clock.now() - timedelta(days=FEED_WINDOW_DAYS)
        out: list[dict[str, Any]] = []
        last: PublishedPost | None = None
        more = False
        for _ in range(MAX_SCANS):  # bounded, also when a category filters most rows out
            batch = size * 3 if category else size + 1
            rows = await r.published.items(chats=[chat], since=since, limit=batch, before=scan)
            for post, article in rows:
                if post.sent_at is None:
                    continue
                if len(out) == size:
                    more = True
                    break
                scan = (post.sent_at, post.id)
                if category and article.category != category:
                    continue
                out.append(await item(r, post, article, lang))
                last = post
            if more or len(rows) < batch:
                break
        next_cursor = None
        if more and last is not None and last.sent_at is not None:
            next_cursor = encode_cursor(last.sent_at, last.id)
        return {"items": out, "next_cursor": next_cursor}

    @router.get("/stories/{story_id}")
    async def story(story_id: int, lang: str = Query("fa", pattern="^(fa|en)$"),
                    r: Repositories = db) -> dict[str, Any]:  # fmt: skip
        chat = await feed_chat(r)
        posts = await r.published.story_posts([story_id], [chat])
        if not posts:
            raise HTTPException(status_code=404, detail="no such published story")
        s = await r.stories.get(story_id)
        assert s is not None
        ordered = sorted(posts, key=lambda pa: (pa[0].sent_at or clock.now(), pa[0].id))
        return {
            "id": s.id,
            "title": (s.published_text or {}).get("title") or s.title,
            "category": s.category,
            "independent_sources": s.independent_sources,
            "breaking": s.breaking_at is not None,
            "posts": [await item(r, p, a, lang) for p, a in ordered],
        }

    @router.get("/search")
    async def search_feed(
        q: str = Query(..., min_length=1, max_length=500),
        semantic: bool = False,
        r: Repositories = db,
    ) -> dict[str, Any]:
        chat = await feed_chat(r)
        result = await search.search(
            r, clock.now(), q, chats=[chat], mode="auto" if semantic else "text", run_id="api-v1"
        )
        hits = [{k: v for k, v in hit.as_dict().items() if k != "score"} for hit in result.hits]
        return {**result.as_dict(), "hits": hits}

    @router.get("/categories")
    async def categories() -> list[dict[str, str]]:
        return [
            {"id": c.id, "name_fa": c.name_fa, "name_en": c.name_en}
            for c in config.categories.categories
        ]

    @router.get("/weekly")
    async def weekly(r: Repositories = db) -> dict[str, Any]:
        chat = await feed_chat(r)
        report = await weekly_service.report(r, chat, clock.now())
        return asdict(report)

    return router
