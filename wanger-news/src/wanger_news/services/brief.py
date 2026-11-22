"""DAILY BRIEF stage (Phase 4): once a day, the stories already published in the channel.

Only titles that were already published (validated or approved by a human) and links to their
posts — no new AI text, so the brief adds no new claim. Due at ``daily_brief.local_time``
(Tehran); cron is late or irregular, so the first run after that time sends it, and a run more
than ``max_late_hours`` late skips the day instead of sending yesterday's brief at night.
At most once per day and channel (same claim → send → record protocol as articles).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import StoryCluster
from wanger_news.domain.chatref import post_url
from wanger_news.domain.enums import PostStatus
from wanger_news.domain.jalali import format_date_fa
from wanger_news.domain.scoring import label
from wanger_news.formatting.templates_fa import BriefItem, DailyBrief, render_brief
from wanger_news.services.context import RunContext
from wanger_news.services.publish import PublishService

ADMIN_BRIEF_KEY = "daily_brief.sent_to_admins"
DONE = (PostStatus.SENT.value, PostStatus.UNCERTAIN.value, PostStatus.CLAIMED.value)


@dataclass(slots=True)
class BriefReport:
    outcome: str = "not_due"  # not_due | missed | done | too_few | sent | preview | failed …
    items: int = 0


class BriefService:
    def __init__(self, config: AppConfig, publisher: PublishService) -> None:
        self._cfg = config
        self._brief = config.pipeline.daily_brief
        self._publisher = publisher

    def due(self, now: datetime) -> tuple[str, str]:
        """(state, local date) — state is not_due, due or missed."""
        local = now.astimezone(ZoneInfo(self._cfg.pipeline.timezone))
        hour, minute = (int(x) for x in self._brief.local_time.split(":"))
        due_at = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        day = local.date().isoformat()
        if local < due_at:
            return "not_due", day
        if local - due_at > timedelta(hours=self._brief.max_late_hours):
            return "missed", day
        return "due", day

    async def compose(self, repos: Repositories, ctx: RunContext) -> str | None:
        """The brief's HTML, or None when there are too few published stories."""
        if ctx.target is None:
            return None
        now = ctx.now()
        since = now - timedelta(hours=self._brief.window_hours)
        stories = await repos.stories.published_in(ctx.target.key, since, self._brief.max_items * 3)
        items = [item for s in stories if (item := self._item(s, ctx.target.key)) is not None]
        items = items[: self._brief.max_items]
        if len(items) < self._brief.min_items:
            return None
        trends: list[tuple[str, int]] = []
        if self._brief.include_trends:
            seen: set[str] = set()
            for alert in await repos.trends.since(since, 20):
                if alert.label not in seen:
                    seen.add(alert.label)
                    trends.append((alert.label, alert.reports))
        return render_brief(
            DailyBrief(
                date=format_date_fa(now, self._cfg.pipeline.timezone),
                items=items,
                trends=trends[:3],
            )
        )

    def _item(self, story: StoryCluster, chat: str) -> BriefItem | None:
        title = str((story.published_text or {}).get("title") or "")
        if not title:
            return None
        posts = [
            e
            for e in story.timeline or []
            if e.get("chat") == chat
            and e.get("message_ids")
            and e.get("event") in ("published", "published_by_hand")
        ]
        first = int(posts[0]["message_ids"][0]) if posts else story.post_message_id
        updates = sum(
            1
            for e in story.timeline or []
            if e.get("event") == "update_published" and e.get("chat") == chat
        )
        status = (
            "conflicting"
            if story.contradictions
            else label(story.confidence_score or 0, self._cfg.pipeline.scoring)
        )
        return BriefItem(
            title=title,
            url=post_url(chat, first),
            status=status,
            breaking=story.breaking_at is not None,
            updates=updates,
        )

    async def run(self, repos: Repositories, ctx: RunContext) -> BriefReport:
        report = BriefReport()
        if not self._brief.enabled:
            report.outcome = "disabled"
            return report
        if ctx.target is None:
            report.outcome = "no_target"
            return report
        state, day = self.due(ctx.now())
        if state != "due":
            report.outcome = state
            return report
        key = f"brief:{day}"
        if self._brief.destination == "channel":
            existing = await repos.posts.get(f"{key}:chat:{ctx.target.key}")
            if existing is not None and existing.status in DONE:
                report.outcome = "done"
                return report
        elif await repos.settings.get(ADMIN_BRIEF_KEY) == day:
            report.outcome = "done"
            return report
        text = await self.compose(repos, ctx)
        if text is None:
            report.outcome = "too_few"
            return report
        report.items = text.count("📌")
        if self._brief.destination == "channel":
            report.outcome = await self._publisher.send_extra(
                repos, ctx, key=key, kind="brief", text=text
            )
            return report
        await self._to_admins(ctx, text)
        await repos.settings.set(ADMIN_BRIEF_KEY, day, ctx.now())
        await repos.commit()
        report.outcome = "sent_to_admins"
        return report

    async def _to_admins(self, ctx: RunContext, text: str) -> None:
        recipients = [ctx.owner_id, *sorted(i for i in ctx.admin_ids if i != ctx.owner_id)]
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [daily brief to {recipients}] ---\n{text}\n")
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
                ctx.count("brief_admin_failed")
