"""WEEKLY INTELLIGENCE REPORT stage (Phase 6): once a week, the week in numbers and stories.

Built from what was already published in the target channel (``domain/weekly``) — no AI. Due at
``weekly_report.weekday`` / ``local_time`` (Tehran). Like the daily brief, the first run after
that moment sends it, a run more than ``max_late_hours`` late skips the week, and it is sent at
most once per ISO week and channel (claim → send → record).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, PublishedPost
from wanger_news.domain.chatref import post_url
from wanger_news.domain.enums import Transport
from wanger_news.domain.jalali import format_date_fa
from wanger_news.domain.scoring import label
from wanger_news.domain.weekly import StoryFact, WeeklyFacts, WeeklyReport, build
from wanger_news.formatting.templates_fa import render_weekly
from wanger_news.services.brief import DONE
from wanger_news.services.context import RunContext
from wanger_news.services.publish import PublishService

ADMIN_WEEKLY_KEY = "weekly_report.sent_to_admins"
MAX_POSTS = 5000  # a week of posts is far below this on the free tier


@dataclass(slots=True)
class WeeklyOutcome:
    outcome: str = "not_due"  # not_due | missed | done | too_few | sent | preview | disabled …
    stories: int = 0


class WeeklyService:
    def __init__(self, config: AppConfig, publisher: PublishService) -> None:
        self._cfg = config
        self._weekly = config.pipeline.weekly_report
        self._publisher = publisher

    def due(self, now: datetime) -> tuple[str, str]:
        """(state, ISO week like ``2026-W48``) — state is not_due, due or missed."""
        local = now.astimezone(ZoneInfo(self._cfg.pipeline.timezone))
        hour, minute = (int(x) for x in self._weekly.local_time.split(":"))
        start_of_week = (local - timedelta(days=local.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        due_at = start_of_week + timedelta(days=self._weekly.weekday, hours=hour, minutes=minute)
        year, week, _ = local.isocalendar()
        tag = f"{year}-W{week:02d}"
        if local < due_at:
            return "not_due", tag
        if local - due_at > timedelta(hours=self._weekly.max_late_hours):
            return "missed", tag
        return "due", tag

    async def report(self, repos: Repositories, chat: str, now: datetime) -> WeeklyReport:
        cfg = self._weekly
        since = now - timedelta(days=cfg.window_days)
        rows = await repos.published.items(
            chats=[chat], since=since - timedelta(days=cfg.window_days), limit=MAX_POSTS
        )
        current = [(p, a) for p, a in rows if p.sent_at is not None and p.sent_at >= since]
        previous = sum(1 for p, _ in rows if p.kind == "story" and (p.sent_at or now) < since)
        facts = await self._facts(repos, chat, current, now, since)
        names = {c.id: c.name_fa for c in self._cfg.categories.categories}
        report = build(
            WeeklyFacts(
                stories=facts[0],
                update_posts=sum(1 for p, _ in current if p.kind == "update"),
                source_posts=facts[1],
                breaking_posts=sum(1 for p, _ in current if p.breaking),
                corrections=await repos.published.corrections_published(since),
                trends=[(t.label, t.reports) for t in await repos.trends.since(since, 500)],
                previous_stories=previous or None,
            ),
            top=cfg.top_stories,
            developing=cfg.developing,
            trends=cfg.trends,
            sources=cfg.sources,
            category_names=names,
        )
        return report

    async def _facts(
        self,
        repos: Repositories,
        chat: str,
        rows: list[tuple[PublishedPost, Article]],
        now: datetime,
        since: datetime,
    ) -> tuple[list[StoryFact], int]:
        first_post: dict[int, PublishedPost] = {}
        updates: Counter[int] = Counter()
        source_posts = 0
        loose: list[tuple[PublishedPost, Article]] = []  # story posts without a story
        for post, article in sorted(rows, key=lambda r: (r[0].sent_at or now, r[0].id)):
            if article.transport == Transport.TELEGRAM_CHANNEL.value:
                source_posts += 1
                continue
            if post.cluster_id is None:
                if post.kind == "story":
                    loose.append((post, article))
                continue
            if post.kind == "update":
                updates[post.cluster_id] += 1
            first_post.setdefault(post.cluster_id, post)
        stories = await repos.stories.by_ids(first_post)
        facts: list[StoryFact] = []
        for sid, post in first_post.items():
            story = stories.get(sid)
            if story is None or story.published_at is None:
                continue
            new = story.published_at >= since
            if not new and not updates.get(sid):
                continue
            title = str((story.published_text or {}).get("title") or story.title or "")
            if not title:
                continue
            facts.append(
                StoryFact(
                    story_id=sid,
                    title=title,
                    url=post_url(chat, post.message_ids[0] if post.message_ids else None),
                    category=story.category,
                    importance=story.importance_score or 0,
                    independent_sources=story.independent_sources or 1,
                    source_names=tuple(str(s.get("name", "")) for s in story.sources or []),
                    status="conflicting"
                    if story.contradictions
                    else label(story.confidence_score or 0, self._cfg.pipeline.scoring),
                    breaking=story.breaking_at is not None,
                    contradictions=story.contradictions or 0,
                    updates=updates.get(sid, 0),
                    new=new,
                )
            )
        for post, article in loose:
            summary = await repos.summaries.get(article.summary_id)
            source = self._cfg.source(article.source_id)
            facts.append(
                StoryFact(
                    story_id=-article.id,
                    title=summary.title if summary is not None else article.title_original,
                    url=post_url(chat, post.message_ids[0] if post.message_ids else None),
                    category=article.category,
                    importance=article.importance_score or 0,
                    independent_sources=1,
                    source_names=(source.name if source else article.source_id,),
                    status=label(article.confidence_score or 0, self._cfg.pipeline.scoring),
                    breaking=post.breaking,
                )
            )
        return facts, source_posts

    async def compose(self, repos: Repositories, ctx: RunContext) -> tuple[str, int] | None:
        """(HTML, stories) of this week's report, or None when too little was published."""
        if ctx.target is None:
            return None
        now = ctx.now()
        report = await self.report(repos, ctx.target.key, now)
        if report.stories < self._weekly.min_stories:
            return None
        zone = self._cfg.pipeline.timezone
        start = format_date_fa(now - timedelta(days=self._weekly.window_days), zone)
        return render_weekly(report, start=start, end=format_date_fa(now, zone)), report.stories

    async def run(self, repos: Repositories, ctx: RunContext) -> WeeklyOutcome:
        outcome = WeeklyOutcome()
        if not self._weekly.enabled:
            outcome.outcome = "disabled"
            return outcome
        if ctx.target is None:
            outcome.outcome = "no_target"
            return outcome
        state, week = self.due(ctx.now())
        if state != "due":
            outcome.outcome = state
            return outcome
        key = f"weekly:{week}"
        if self._weekly.destination == "channel":
            existing = await repos.posts.get(f"{key}:chat:{ctx.target.key}")
            if existing is not None and existing.status in DONE:
                outcome.outcome = "done"
                return outcome
        elif await repos.settings.get(ADMIN_WEEKLY_KEY) == week:
            outcome.outcome = "done"
            return outcome
        composed = await self.compose(repos, ctx)
        if composed is None:
            outcome.outcome = "too_few"
            return outcome
        text, outcome.stories = composed
        if self._weekly.destination == "channel":
            outcome.outcome = await self._publisher.send_extra(
                repos, ctx, key=key, kind="weekly", text=text
            )
            return outcome
        await self._to_admins(ctx, text)
        await repos.settings.set(ADMIN_WEEKLY_KEY, week, ctx.now())
        await repos.commit()
        outcome.outcome = "sent_to_admins"
        return outcome

    async def _to_admins(self, ctx: RunContext, text: str) -> None:
        recipients = [ctx.owner_id, *sorted(i for i in ctx.admin_ids if i != ctx.owner_id)]
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [weekly report to {recipients}] ---\n{text}\n")
            return
        for admin in recipients:
            try:
                await ctx.bot.call(
                    "sendMessage",
                    {
                        "chat_id": admin,
                        "text": text,
                        "parse_mode": "HTML",
                        "link_preview_options": {"is_disabled": True},
                    },
                )
            except Exception:  # an admin who never started the bot must not stop the run
                ctx.count("weekly_admin_failed")
