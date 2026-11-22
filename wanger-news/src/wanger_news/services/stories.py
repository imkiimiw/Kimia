"""CLUSTER stage (spec §7): every report joins a story — a new one, or the event it is about.

Per article, after the gate:
1. embed (title + start of text, batched, budgeted; no provider → no level-3 dedup);
2. compare with recent stories (domain/similarity.match: cosine + names + time);
3. join with a role that depends on where the story is:
   - not summarised yet  → ``support`` (merged: one more source for the multi-source summary);
   - summarised, waiting → ``update`` if from an independent origin (waits for publication),
                           else ``corroboration``;
   - published           → ``update`` if independent (the AI decides: new information or not),
                           else ``corroboration`` (counted as a source, nothing posted);
   - source-channel / hand-made posts become the story's representative (human first).
Recorded duplicates (L1/L2) join their original's story as corroborations.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from wanger_news.ai.provider import AIError, AIProvider
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import AIRun, Article, StoryCluster
from wanger_news.domain.enums import (
    AIRunStatus,
    ArticleStatus,
    ClusterRole,
    DedupLevel,
    JobStatus,
    Stage,
    Transport,
)
from wanger_news.domain.independence import Report, origins
from wanger_news.domain.rules import Facts
from wanger_news.domain.rules import evaluate as evaluate_rules
from wanger_news.domain.similarity import (
    add_to_centroid,
    extract_entity_names,
    match,
    normalize,
)
from wanger_news.services.context import RunContext

log = logging.getLogger("wanger_news.stories")

#: reports that take part in stories (feed items past the gate, posts, hand-made posts)
CLUSTERED = (
    ArticleStatus.AI_PENDING,
    ArticleStatus.PENDING_REVIEW,
    ArticleStatus.HELD,
    ArticleStatus.QUEUED,
    ArticleStatus.PUBLISHED,
    ArticleStatus.UNCERTAIN,
    ArticleStatus.EXTERNAL,
)
#: a lead in one of these will never be published: the story needs a new lead
DEAD = {
    ArticleStatus.REJECTED.value,
    ArticleStatus.EXPIRED.value,
    ArticleStatus.FAILED.value,
    ArticleStatus.DUPLICATE.value,
    ArticleStatus.FILTERED.value,
}
HUMAN_SOURCE_GROUP = "wanger"


@dataclass(slots=True)
class StoryReport:
    embedded: int = 0
    new_stories: int = 0
    joined: dict[str, int] = field(default_factory=dict)
    skipped: str | None = None


def text_of(article: Article, limit: int) -> str:
    body = article.description_original or article.content_original
    return f"{article.title_original}\n{body}"[:limit]


def is_human(article: Article) -> bool:
    return article.transport == Transport.TELEGRAM_CHANNEL.value


def hand_post_ref(article: Article) -> tuple[int, str | None, int] | None:
    """(chat id, username, message id) of a Telegram post, from ``tg:<chat>:<message>`` and
    its public ``t.me`` link."""
    parts = (article.external_id or "").split(":")
    if len(parts) != 3 or parts[0] != "tg":
        return None
    try:
        chat_id, message_id = int(parts[1]), int(parts[2])
    except ValueError:
        return None
    username = None
    if article.url and article.url.startswith("https://t.me/"):
        username = article.url.removeprefix("https://t.me/").split("/")[0] or None
    return chat_id, username, message_id


def timeline_event(cluster: StoryCluster, at: str, event: str, **data: Any) -> None:
    cluster.timeline = [*(cluster.timeline or []), {"at": at, "event": event, **data}]


class StoryService:
    def __init__(
        self,
        config: AppConfig,
        provider: AIProvider | None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._cfg = config
        self._story = config.pipeline.story
        self._provider = provider
        self._sleep = sleep

    # ---------------------------------------------------------------- entry point
    async def run(self, repos: Repositories, ctx: RunContext) -> StoryReport:
        report = StoryReport()
        await self._promote_orphans(repos, ctx)
        await self._attach_duplicates(repos, ctx, report)
        since = ctx.now() - timedelta(hours=self._story.window_hours)
        limit = max(1, self._story.max_embed_calls_per_run) * self._story.embed_batch_size
        articles = await repos.stories.unclustered(since, CLUSTERED, limit)
        if not articles:
            return report
        vectors = await self._embed(repos, ctx, articles, report)
        stories = await repos.stories.candidates(since, self._story.max_candidates)
        for article in articles:
            pairs = extract_entity_names(text_of(article, 4000))
            article.entities = [
                {"name": key, "display": shown, "kind": "heuristic"} for key, shown in pairs
            ]
            names = [key for key, _ in pairs]
            vector = vectors.get(article.id)
            article.embedding = vector
            best: tuple[StoryCluster, dict[str, Any]] | None = None
            closest: tuple[StoryCluster, dict[str, Any]] | None = None  # for the rules
            if vector is not None and self._story.enabled:
                for story in stories:
                    if story.centroid is None:
                        continue
                    found = match(
                        vector=vector,
                        names=names,
                        when=article.effective_at,
                        centroid=story.centroid,
                        story_names=story.entities or [],
                        story_time=story.last_updated,
                        cfg=self._story,
                    )
                    if found.same_event and (best is None or found.score > best[1]["score"]):
                        best = (story, found.as_dict())
                    if found.time > 0 and (closest is None or found.cosine > closest[1]["cosine"]):
                        closest = (story, found.as_dict())
                best = self._apply_cluster_rules(article, best, closest)
            if best is None:
                story = await self._new_story(repos, ctx, article)
                stories.insert(0, story)
                report.new_stories += 1
                role = article.cluster_role or ClusterRole.LEAD.value
            else:
                story, score = best
                role = await self._join(repos, ctx, story, article, score)
            report.joined[role] = report.joined.get(role, 0) + 1
            await repos.jobs.record(
                article.id,
                Stage.CLUSTER,
                JobStatus.DONE,
                ctx.run_id,
                ctx.now(),
                details={
                    "cluster_id": article.cluster_id,
                    "role": role,
                    "score": article.cluster_score,
                },
            )
            await repos.commit()
        return report

    # ---------------------------------------------------------------- embeddings
    async def _embed(
        self, repos: Repositories, ctx: RunContext, articles: list[Article], report: StoryReport
    ) -> dict[int, list[float]]:
        if not self._story.enabled:
            report.skipped = "stories disabled"
            return {}
        if self._provider is None:
            report.skipped = "no AI provider: every report is its own story"
            return {}
        out: dict[int, list[float]] = {}
        size = self._story.embed_batch_size
        for call, start in enumerate(range(0, len(articles), size)):
            if call >= self._story.max_embed_calls_per_run:
                break
            batch = articles[start : start + size]
            record = AIRun(
                run_id=ctx.run_id,
                provider=self._provider.name,
                model=self._story.embedding_model,
                operation="embed",
                prompt_version="-",
                article_ids=[a.id for a in batch],
                started_at=ctx.now(),
            )
            try:
                vectors = await self._provider.embed(
                    [text_of(a, self._story.embed_text_chars) for a in batch],
                    model=self._story.embedding_model,
                    dimensions=self._story.embedding_dimensions,
                )
            except AIError as exc:
                record.status, record.error, record.finished_at = (
                    exc.status,
                    str(exc)[:500],
                    ctx.now(),
                )
                await repos.ai_runs.add(record)
                report.skipped = f"embedding failed: {exc}"[:120]
                await ctx.event(repos, "warning", "embedding_failed", error=str(exc)[:200])
                break
            record.status, record.finished_at = AIRunStatus.OK.value, ctx.now()
            await repos.ai_runs.add(record)
            for article, vector in zip(batch, vectors, strict=True):
                out[article.id] = normalize(vector)
            report.embedded += len(batch)
        await repos.commit()
        return out

    # ---------------------------------------------------------------- membership
    async def _new_story(
        self, repos: Repositories, ctx: RunContext, article: Article
    ) -> StoryCluster:
        now = ctx.now()
        story = await repos.stories.add(
            StoryCluster(
                event_id="E" + uuid.uuid4().hex[:12],
                lead_article_id=article.id,
                title=article.title_original[:300],
                category=article.category,
                entities=[e["name"] for e in article.entities or []],
                locations=[],
                first_seen=article.effective_at,
                last_updated=now,
                member_count=0,
                centroid=None,
                timeline=[],
                sources=[],
                independent_sources=1,
                created_at=now,
                updated_at=now,
            )
        )
        article.cluster_id = story.id
        if article.status == ArticleStatus.EXTERNAL.value:
            article.cluster_role = ClusterRole.EXTERNAL.value
            self._mark_published_by_hand(ctx, story, article, now.isoformat())
        elif is_human(article):
            article.cluster_role = ClusterRole.HUMAN.value
        else:
            article.cluster_role = ClusterRole.LEAD.value
        article.cluster_score = {"new_story": True}
        timeline_event(
            story, now.isoformat(), "created", article_id=article.id, role=article.cluster_role
        )
        await self._refresh(repos, story, article)
        return story

    async def _join(
        self,
        repos: Repositories,
        ctx: RunContext,
        story: StoryCluster,
        article: Article,
        score: dict[str, Any],
    ) -> str:
        now = ctx.now()
        article.cluster_id = story.id
        article.cluster_score = score
        members = [m for m in await repos.stories.members(story.id) if m.id != article.id]
        lead = next((m for m in members if m.id == story.lead_article_id), None)
        if article.status == ArticleStatus.EXTERNAL.value:
            role = ClusterRole.EXTERNAL
            self._mark_published_by_hand(ctx, story, article, now.isoformat())
            await self._demote_unpublished_lead(repos, ctx, story, lead)
        elif is_human(article):
            role = ClusterRole.HUMAN
            if story.published_at is None:  # the human post represents the story from now on
                await self._demote_unpublished_lead(repos, ctx, story, lead)
                story.lead_article_id = article.id
        else:
            independent = self._independent(article, members)
            summarised = lead is not None and lead.summary_id is not None
            if (
                story.published_at is None
                and lead is not None
                and not summarised
                and lead.status == ArticleStatus.AI_PENDING.value
            ):
                role = ClusterRole.SUPPORT
            elif independent:
                role = ClusterRole.UPDATE  # waits until the story is out, then the AI decides
            else:
                role = ClusterRole.CORROBORATION
            if role in (ClusterRole.SUPPORT, ClusterRole.CORROBORATION):
                article.duplicate_of_id = story.lead_article_id
                article.dedup_level = DedupLevel.EVENT.value
                await repos.articles.set_status(
                    article, ArticleStatus.MERGED, now, f"{role.value} of story {story.event_id}"
                )
        article.cluster_role = role.value
        story.last_updated = now
        timeline_event(
            story,
            now.isoformat(),
            "joined",
            article_id=article.id,
            role=role.value,
            source=self._name(article),
        )
        await self._refresh(repos, story, article)
        return role.value

    def _apply_cluster_rules(
        self,
        article: Article,
        best: tuple[StoryCluster, dict[str, Any]] | None,
        closest: tuple[StoryCluster, dict[str, Any]] | None,
    ) -> tuple[StoryCluster, dict[str, Any]] | None:
        """``merge`` / ``new_story`` rules (rules.yaml, ``duplicate_similarity_gt``)."""
        rules = [r for r in self._cfg.rules.rules if r.then in ("merge", "new_story")]
        if not rules or closest is None:
            return best
        ruled = evaluate_rules(
            rules,
            Facts(
                category=article.category,
                source=article.source_id,
                language=article.language,
                duplicate_similarity=float(closest[1]["cosine"]),
            ),
        )
        if best is None and ruled.merge:
            return closest[0], {**closest[1], "rule": ruled.merge[0]}
        if best is not None and ruled.new_story:
            return None
        return best

    def _independent(self, article: Article, members: list[Article]) -> bool:
        """Is this report an origin of its own, compared with the story's feed reports?"""
        feed = [m for m in members if not is_human(m)]
        if not feed:
            return True
        groups = origins(
            [*map(self.report_of, feed), self.report_of(article)],
            self._story.syndication_min_jaccard,
        )
        mine = next(g for g in groups if article.id in g.article_ids)
        return len(mine.reports) == 1

    def report_of(self, article: Article) -> Report:
        source = self._cfg.source(article.source_id)
        primary = bool(
            source and source.source_type in self._cfg.pipeline.scoring.primary_source_types
        )
        return Report(
            article_id=article.id,
            source_id=article.source_id,
            source_name=self._name(article),
            owner_group=source.group if source else HUMAN_SOURCE_GROUP,
            reliability=source.reliability_score if source else 50,
            primary=primary,
            text=text_of(article, 2000),
            copy_of=article.duplicate_of_id if article.dedup_level in ("exact", "near") else None,
        )

    def _name(self, article: Article) -> str:
        source = self._cfg.source(article.source_id)
        return source.name if source else article.source_id

    @staticmethod
    def _mark_published_by_hand(
        ctx: RunContext, story: StoryCluster, article: Article, at: str
    ) -> None:
        """A post made by hand in a target channel now speaks for the story. When it is in
        the channel this run publishes to, later updates reply to it."""
        ref = hand_post_ref(article)
        here = ref is not None and ctx.target is not None and ctx.target.chat.matches(*ref[:2])
        if story.published_at is None:
            story.published_at = article.effective_at
            story.published_text = {
                "title": article.title_original,
                "summary": article.description_original,
                "key_points": [],
            }
            story.lead_article_id = article.id
        if here and ref is not None and ctx.target is not None:
            story.post_chat = ctx.target.key
            story.post_message_id = ref[2]
            timeline_event(
                story,
                at,
                "published_by_hand",
                article_id=article.id,
                message_ids=[ref[2]],
                chat=ctx.target.key,
            )
        else:
            timeline_event(story, at, "published_by_hand", article_id=article.id)

    async def _demote_unpublished_lead(
        self, repos: Repositories, ctx: RunContext, story: StoryCluster, lead: Article | None
    ) -> None:
        """A human post now speaks for the story: an automatic lead that no human approved
        becomes an update candidate (the AI will say whether it adds anything)."""
        if lead is None or is_human(lead) or lead.approved_by is not None:
            return
        if lead.status not in (
            ArticleStatus.AI_PENDING.value,
            ArticleStatus.PENDING_REVIEW.value,
            ArticleStatus.HELD.value,
            ArticleStatus.QUEUED.value,
        ):
            return
        lead.cluster_role = ClusterRole.UPDATE.value
        lead.summary_id = None
        lead.review_reason = None
        await repos.articles.set_status(
            lead, ArticleStatus.AI_PENDING, ctx.now(), "a human post now represents the story"
        )
        for request in await repos.reviews.open_for(lead.id):
            await repos.reviews.close(request, "superseded", ctx.now())

    async def _refresh(self, repos: Repositories, story: StoryCluster, article: Article) -> None:
        """Centroid, names, sources and counts after a member joined."""
        if article.embedding is not None:
            story.centroid = add_to_centroid(story.centroid, story.member_count, article.embedding)
        names = list(
            dict.fromkeys([*(story.entities or []), *(e["name"] for e in article.entities or [])])
        )
        story.entities = names[:60]
        story.member_count += 1
        await self.refresh_sources(repos, story)

    async def refresh_sources(self, repos: Repositories, story: StoryCluster) -> None:
        """Independent origins of the story's feed reports (own-channel posts are not sources)."""
        members = await repos.stories.members(story.id)
        feed = [m for m in members if not is_human(m)]
        groups = origins([self.report_of(m) for m in feed], self._story.syndication_min_jaccard)
        story.sources = [
            {
                "name": g.best.source_name,
                "source_id": g.best.source_id,
                "article_id": g.best.article_id,
                "article_ids": g.article_ids,
                "reliability": g.best.reliability,
                "primary": g.best.primary,
            }
            for g in groups
        ]
        story.independent_sources = max(1, len(groups))
        story.updated_at = story.last_updated

    # ---------------------------------------------------------------- housekeeping
    async def _attach_duplicates(
        self, repos: Repositories, ctx: RunContext, report: StoryReport
    ) -> None:
        for article in await repos.stories.unclustered_duplicates(500):
            if article.duplicate_of_id is None:
                continue
            original = await repos.articles.get(article.duplicate_of_id)
            if original is None or original.cluster_id is None:
                continue
            story = await repos.stories.get(original.cluster_id)
            if story is None:
                continue
            article.cluster_id = story.id
            article.cluster_role = ClusterRole.CORROBORATION.value
            story.member_count += 1
            timeline_event(
                story,
                ctx.now().isoformat(),
                "joined",
                article_id=article.id,
                role="corroboration",
                source=self._name(article),
            )
            await self._refresh(repos, story, article)
            report.joined["corroboration"] = report.joined.get("corroboration", 0) + 1
        await repos.commit()

    async def _promote_orphans(self, repos: Repositories, ctx: RunContext) -> None:
        """A waiting update whose story lead died (rejected, expired…) becomes the new lead."""
        for article in await repos.stories.by_role(
            ClusterRole.UPDATE.value, ArticleStatus.AI_PENDING, 200
        ):
            story = await repos.stories.get(article.cluster_id)
            if story is None or story.published_at is not None:
                continue
            lead = (
                await repos.articles.get(story.lead_article_id)
                if story.lead_article_id is not None
                else None
            )
            if lead is None or lead.status in DEAD:
                story.lead_article_id = article.id
                article.cluster_role = ClusterRole.LEAD.value
                timeline_event(story, ctx.now().isoformat(), "new_lead", article_id=article.id)
        await repos.commit()

    async def detach(
        self, repos: Repositories, ctx: RunContext, article: Article, reason: str
    ) -> StoryCluster:
        """The AI said this report is about a different event: give it a story of its own."""
        old = await repos.stories.get(article.cluster_id)
        if old is not None:
            timeline_event(
                old, ctx.now().isoformat(), "detached", article_id=article.id, reason=reason
            )
            old.member_count = max(0, old.member_count - 1)
        article.cluster_id = None
        article.duplicate_of_id = None
        article.dedup_level = None
        if article.status == ArticleStatus.MERGED.value:
            await repos.articles.set_status(
                article, ArticleStatus.AI_PENDING, ctx.now(), f"detached: {reason}"
            )
        story = await self._new_story(repos, ctx, article)
        if article.embedding is not None:
            story.centroid = list(article.embedding)
        if old is not None:
            # the old story must stop naming this outlet as one of its sources
            await self.refresh_sources(repos, old)
        return story
