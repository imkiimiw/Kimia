"""Builds the channel post of an article from its Persian summary and its story. The review
card preview uses the same builder, so an admin approves exactly what will be published."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, StoryCluster
from wanger_news.domain.chatref import post_url
from wanger_news.domain.claims import CONFLICTING
from wanger_news.domain.enums import ClusterRole
from wanger_news.domain.jalali import format_time_fa
from wanger_news.domain.related import Candidate, Related, find_related
from wanger_news.domain.scoring import label
from wanger_news.formatting.templates_fa import (
    ContradictionLine,
    PostLink,
    RenderedPost,
    SummaryPost,
    render_summary,
)
from wanger_news.services.context import Target

#: timeline events that are channel posts of the story
POST_EVENTS = ("published", "update_published", "published_by_hand")

#: publication times this far apart are worth mentioning next to a contradiction
TIME_GAP_WORTH_NOTING = timedelta(hours=2)


class PostBuilder:
    def __init__(self, config: AppConfig) -> None:
        self._cfg = config

    def source_name(self, article: Article) -> str:
        source = self._cfg.source(article.source_id)
        return source.name if source else article.source_id

    async def build(
        self,
        repos: Repositories,
        article: Article,
        *,
        target: Target | None = None,
        now: datetime | None = None,
        breaking: bool | None = None,
    ) -> RenderedPost | None:
        """None when there is no Persian text to publish (no summary yet).

        With a ``target`` (the channel the post goes to) the post also links the story's
        earlier posts (update posts) and related earlier stories (Phase 4)."""
        summary = await repos.summaries.get(article.summary_id)
        if summary is None:
            return None
        story = await repos.stories.get(article.cluster_id)
        update = article.cluster_role == ClusterRole.UPDATE.value
        contradictions = await self._contradictions(repos, summary.id)
        names, url = await self._sources(repos, article, story, update)
        status = (
            "conflicting"
            if contradictions
            else label(article.confidence_score or 0, self._cfg.pipeline.scoring)
        )
        images = article.images or []
        post = SummaryPost(
            title=summary.title,
            summary=summary.summary,
            key_points=list(summary.key_points or []),
            status=status,
            source_names=names,
            source_url=url,
            hashtags=list((article.classification or {}).get("hashtags") or []),
            image_url=images[0]["url"] if images and not update else None,
            update=update,
            contradictions=contradictions,
            breaking=article.breaking if breaking is None else breaking,
        )
        related: list[Related] = []
        if story is not None and target is not None and now is not None:
            if update:
                post = replace(post, timeline=await self._timeline(repos, story, target, now))
            else:
                related, links = await self._related(repos, story, target, now)
                post = replace(post, related=links)
        rendered = render_summary(post, self._cfg.pipeline.publish)
        return replace(rendered, related=[r.as_dict() for r in related])

    # ---------------------------------------------------------------- Phase 4 links
    async def _timeline(
        self, repos: Repositories, story: StoryCluster, target: Target, now: datetime
    ) -> list[PostLink]:
        """The story's earlier posts in this channel (shown when there are enough of them)."""
        cfg = self._cfg.pipeline.timeline
        if not cfg.enabled:
            return []
        posts = [
            e
            for e in story.timeline or []
            if e.get("event") in POST_EVENTS
            and e.get("chat") == target.key
            and e.get("message_ids")
        ]
        if len(posts) < cfg.min_previous_posts:
            return []
        links = []
        for event in posts[-cfg.max_entries :]:
            article = await repos.articles.get(int(event["article_id"]))
            title = await self._title(repos, article) if article is not None else story.title or ""
            links.append(
                PostLink(
                    title=title,
                    url=post_url(target.key, int(event["message_ids"][0])),
                    when=format_time_fa(
                        datetime.fromisoformat(str(event["at"])), now, self._cfg.pipeline.timezone
                    ),
                )
            )
        return links

    async def _related(
        self, repos: Repositories, story: StoryCluster, target: Target, now: datetime
    ) -> tuple[list[Related], list[PostLink]]:
        cfg = self._cfg.pipeline.related
        if not cfg.enabled or cfg.max_links == 0:
            return [], []
        earlier = await repos.stories.related_candidates(
            target.key, now - timedelta(days=cfg.window_days), story.id, cfg.max_candidates
        )
        found = find_related(
            story.centroid,
            story.entities or [],
            [Candidate(s.id, s.centroid, s.entities or []) for s in earlier],
            cfg,
        )
        by_id = {s.id: s for s in earlier}
        links = [
            PostLink(
                title=str((by_id[r.story_id].published_text or {}).get("title") or ""),
                url=post_url(by_id[r.story_id].post_chat, by_id[r.story_id].post_message_id),
            )
            for r in found
        ]
        return found, [link for link in links if link.title]

    async def _title(self, repos: Repositories, article: Article) -> str:
        summary = await repos.summaries.get(article.summary_id)
        return summary.title if summary is not None else article.title_original

    async def _sources(
        self, repos: Repositories, article: Article, story: StoryCluster | None, update: bool
    ) -> tuple[list[str], str]:
        """Story post: one name per independent origin, link to the most reliable one.
        Update post: the new report(s) only."""
        fallback = article.canonical_url or article.url or ""
        if story is None or not story.sources or update:
            return [self.source_name(article)], fallback
        names = list(dict.fromkeys(s["name"] for s in story.sources))
        best_id = story.sources[0].get("article_id")
        best = await repos.articles.get(int(best_id)) if best_id else None
        url = (best.canonical_url or best.url) if best is not None else None
        return names, url or fallback

    async def _contradictions(
        self, repos: Repositories, summary_id: int
    ) -> list[ContradictionLine]:
        """Disagreements are stored as the summary's ``conflicting`` claims with their versions."""
        lines: list[ContradictionLine] = []
        for claim in await repos.stories.claims_for(summary_id):
            if claim.status != CONFLICTING or not claim.versions:
                continue
            versions = [
                (str(v.get("source_id", "")), str(v.get("statement", ""))) for v in claim.versions
            ]
            lines.append(await self._line(repos, claim.text, versions))
        return lines

    async def _line(
        self, repos: Repositories, topic: str, versions: list[tuple[str, str]]
    ) -> ContradictionLine:
        named: list[tuple[str, str]] = []
        times = []
        for source_id, statement in versions:
            article = (
                await repos.articles.get(int(source_id[1:])) if source_id[1:].isdigit() else None
            )
            outlet = self.source_name(article) if article else source_id
            named.append((outlet, statement))
            if article is not None:
                times.append((article.effective_at, outlet))
        earlier = None
        if len(times) >= 2:
            times.sort()
            if times[-1][0] - times[0][0] >= TIME_GAP_WORTH_NOTING:
                earlier = times[0][1]
        return ContradictionLine(topic=topic, versions=named, earlier=earlier)
