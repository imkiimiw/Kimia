"""SEARCH (Phase 6): find what was published — by words, then by meaning.

Used by the bot (``/search``), the admin API (``/api/search``) and the mobile API
(``/api/v1/search``, main channel only). Text search runs in the database (bounded by time and
LIMIT). Semantic search embeds the query once (the embedding quota, recorded in ``ai_runs``) and
compares it with the centroids of published stories. Results are always posts that were
published, each with its link.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from wanger_news.ai.provider import AIError, AIProvider
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import AIRun, Article, PublishedPost
from wanger_news.domain.chatref import post_url
from wanger_news.domain.enums import AIRunStatus
from wanger_news.domain.search import QueryError, query_terms, rank, snippet

Mode = Literal["auto", "text", "semantic"]


@dataclass(frozen=True, slots=True)
class SearchHit:
    article_id: int
    story_id: int | None
    title: str
    snippet: str
    post_url: str | None  # the channel post
    source_url: str | None
    chat: str
    kind: str  # story | update
    sent_at: datetime
    category: str | None
    match: Literal["text", "semantic"]
    score: float | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "article_id": self.article_id,
            "story_id": self.story_id,
            "title": self.title,
            "snippet": self.snippet,
            "post_url": self.post_url,
            "source_url": self.source_url,
            "kind": self.kind,
            "sent_at": self.sent_at.isoformat(),
            "category": self.category,
            "match": self.match,
            "score": self.score,
        }


@dataclass(slots=True)
class SearchResult:
    query: str
    hits: list[SearchHit] = field(default_factory=list)
    error: str | None = None  # too_short | too_long | only_common_words | disabled
    semantic: str = "not_used"  # not_used | used | unavailable | failed | disabled

    def as_dict(self) -> dict[str, object]:
        return {
            "query": self.query,
            "error": self.error,
            "semantic": self.semantic,
            "hits": [h.as_dict() for h in self.hits],
        }


class SearchService:
    def __init__(self, config: AppConfig, ai: AIProvider | None) -> None:
        self._cfg = config
        self._search = config.pipeline.search
        self._ai = ai

    async def search(
        self,
        repos: Repositories,
        now: datetime,
        query: str,
        *,
        chats: Sequence[str] | None,
        mode: Mode = "auto",
        limit: int | None = None,
        run_id: str = "search",
    ) -> SearchResult:
        result = SearchResult(query=query.strip()[: self._search.max_query_chars])
        if not self._search.enabled:
            result.error = "disabled"
            return result
        cfg = self._search
        try:
            terms = query_terms(
                query,
                min_chars=cfg.min_query_chars,
                max_chars=cfg.max_query_chars,
                max_terms=cfg.max_terms,
            )
        except QueryError as exc:
            result.error = str(exc)
            return result
        size = min(limit or cfg.max_results, 50)
        since = now - timedelta(days=cfg.window_days)
        seen: set[int] = set()
        if mode in ("auto", "text"):
            rows = await repos.published.search_text(
                terms, chats=chats, since=since, limit=size * 3
            )
            for post, article in rows:
                if article.id in seen:
                    continue
                seen.add(article.id)
                result.hits.append(await self._hit(repos, post, article, terms, "text"))
                if len(result.hits) >= size:
                    return result
        if mode == "text":
            return result
        await self._semantic(repos, now, query, chats, since, size, seen, result, run_id)
        return result

    async def _semantic(
        self,
        repos: Repositories,
        now: datetime,
        query: str,
        chats: Sequence[str] | None,
        since: datetime,
        size: int,
        seen: set[int],
        result: SearchResult,
        run_id: str,
    ) -> None:
        cfg = self._search
        story_cfg = self._cfg.pipeline.story
        if not cfg.semantic:
            result.semantic = "disabled"
            return
        if self._ai is None:
            result.semantic = "unavailable"
            return
        record = AIRun(
            run_id=run_id,
            provider=self._ai.name,
            model=story_cfg.embedding_model,
            operation="embed",
            prompt_version="search",
            article_ids=[],
            started_at=now,
        )
        try:
            vectors = await self._ai.embed(
                [query.strip()[: cfg.max_query_chars]],
                model=story_cfg.embedding_model,
                dimensions=story_cfg.embedding_dimensions,
            )
        except AIError as exc:
            record.status, record.error, record.finished_at = exc.status, str(exc)[:500], now
            await repos.ai_runs.add(record)
            await repos.commit()
            result.semantic = "failed"
            return
        record.status, record.finished_at = AIRunStatus.OK.value, now
        await repos.ai_runs.add(record)
        await repos.commit()
        result.semantic = "used"
        stories = await repos.published.stories_with_centroid(since, cfg.semantic_candidates)
        ranked = rank(
            vectors[0],
            [(s.id, s.centroid or []) for s in stories],
            min_similarity=cfg.min_similarity,
            limit=size * 2,
        )
        posts = await repos.published.story_posts([r.id for r in ranked], chats)
        first: dict[int, tuple[PublishedPost, Article]] = {}
        for post, article in posts:  # newest first: keep the story's latest post
            if post.cluster_id is not None and post.cluster_id not in first:
                first[post.cluster_id] = (post, article)
        for r in ranked:
            if r.id not in first:
                continue
            post, article = first[r.id]
            if article.id in seen:
                continue
            seen.add(article.id)
            result.hits.append(await self._hit(repos, post, article, [], "semantic", r.score))
            if len(result.hits) >= size:
                return

    async def _hit(
        self,
        repos: Repositories,
        post: PublishedPost,
        article: Article,
        terms: Sequence[Sequence[str]],
        match: Literal["text", "semantic"],
        score: float | None = None,
    ) -> SearchHit:
        summary = await repos.summaries.get(article.summary_id)
        title = summary.title if summary is not None else article.title_original
        body = summary.summary if summary is not None else article.description_original
        return SearchHit(
            article_id=article.id,
            story_id=article.cluster_id,
            title=title,
            snippet=snippet(body or "", terms),
            post_url=post_url(post.chat_id, post.message_ids[0] if post.message_ids else None),
            source_url=article.canonical_url or article.url,
            chat=post.chat_id,
            kind=post.kind,
            sent_at=post.sent_at or article.effective_at,
            category=article.category,
            match=match,
            score=score,
        )
