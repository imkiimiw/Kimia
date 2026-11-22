"""TRENDS stage (Phase 4): early warning «⚠️ موضوع در حال رشد».

Counts reports per topic — a story (one event) or a name — and alerts when a topic has
unusually many reports from several outlets in the last window (``domain/trends.py``). The
alert is a count, not a claim: it goes to the admins, and to the channel only when the owner
turns ``trends.post_to_channel`` on. One alert per topic per ``cooldown_hours``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import StoryCluster, TrendAlert
from wanger_news.domain.text import normalize_for_match
from wanger_news.domain.trends import Observation, Trend, detect
from wanger_news.formatting.templates_fa import TrendAlert as TrendAlertView
from wanger_news.formatting.templates_fa import render_trend_alert
from wanger_news.services.context import RunContext
from wanger_news.services.publish import PublishService
from wanger_news.services.stories import timeline_event

#: reports read per run for trend detection (a day of 16 feeds is far below this)
MAX_ROWS = 20000
#: summaries read to find the Persian spelling of names
MAX_SUMMARIES = 2000


@dataclass(slots=True)
class TrendReport:
    detected: int = 0
    alerted: int = 0
    cooling: int = 0
    posted: int = 0
    skipped: str | None = None
    labels: list[str] = field(default_factory=list)


class TrendService:
    def __init__(self, config: AppConfig, publisher: PublishService) -> None:
        self._cfg = config
        self._trends = config.pipeline.trends
        self._publisher = publisher

    async def detect(self, repos: Repositories, now: datetime) -> list[Trend]:
        """Current trends (nothing stored, nothing sent) — also used by /trends."""
        since = now - timedelta(hours=self._trends.baseline_hours)
        rows = await repos.articles.trend_rows(since, MAX_ROWS)
        if not rows or rows[0][2] > now - timedelta(hours=self._trends.min_history_hours):
            return []  # warming up: too little history to know what is unusual
        stories = await repos.stories.by_ids(cid for _, _, _, cid, _ in rows if cid is not None)
        persian = await self._persian_names(repos, since)
        observations: list[Observation] = []
        for _, source_id, at, cluster_id, entities in rows:
            source = self._cfg.source(source_id)
            group = source.group if source else source_id
            name = source.name if source else source_id
            if cluster_id is not None and cluster_id in stories:
                observations.append(
                    Observation(
                        kind="story",
                        key=f"story:{cluster_id}",
                        label=self._story_label(stories[cluster_id]),
                        at=at,
                        source=group,
                        source_name=name,
                        cluster_id=cluster_id,
                    )
                )
            for entity in entities or []:
                key = str(entity.get("name") or "")
                if not key:
                    continue
                shown = str(entity.get("display") or key)
                fa = persian.get(key)
                observations.append(
                    Observation(
                        kind="entity",
                        key=f"entity:{key}",
                        label=f"{fa} ({shown})" if fa and fa != shown else shown,
                        at=at,
                        source=group,
                        source_name=name,
                        cluster_id=cluster_id,
                    )
                )
        return detect(observations, now=now, cfg=self._trends)

    async def run(
        self, repos: Repositories, ctx: RunContext, *, paused: bool = False
    ) -> TrendReport:
        report = TrendReport()
        if not self._trends.enabled:
            report.skipped = "disabled"
            return report
        now = ctx.now()
        trends = await self.detect(repos, now)
        report.detected = len(trends)
        for trend in trends:
            if report.alerted >= self._trends.max_alerts_per_run:
                break
            last = await repos.trends.last_for(trend.key)
            if last is not None and last.created_at > now - timedelta(
                hours=self._trends.cooldown_hours
            ):
                report.cooling += 1
                continue
            alert = await repos.trends.add(
                TrendAlert(
                    kind=trend.kind,
                    key=trend.key,
                    label=trend.label[:500],
                    window_start=trend.window_start,
                    window_end=trend.window_end,
                    reports=trend.reports,
                    sources=trend.sources,
                    baseline=trend.baseline,
                    ratio=trend.ratio,
                    cluster_id=trend.cluster_id,
                    details=trend.as_dict(),
                    created_at=now,
                )
            )
            if trend.kind == "story" and trend.cluster_id is not None:
                story = await repos.stories.get(trend.cluster_id)
                if story is not None:
                    timeline_event(
                        story,
                        now.isoformat(),
                        "trend",
                        reports=trend.reports,
                        sources=trend.sources,
                    )
            text = render_trend_alert(
                TrendAlertView(
                    label=trend.label,
                    reports=trend.reports,
                    sources=trend.sources,
                    window_minutes=self._trends.window_minutes,
                    usual=trend.baseline,
                    source_names=trend.source_names,
                )
            )
            await repos.commit()
            if self._trends.notify_admins:
                await self._notify_admins(ctx, text)
            if self._trends.post_to_channel and not paused:
                outcome = await self._publisher.send_extra(
                    repos, ctx, key=f"trend:{alert.id}", kind="trend", text=text
                )
                report.posted += outcome == "sent"
            alert.notified = True
            await repos.commit()
            report.alerted += 1
            report.labels.append(trend.label)
        return report

    async def _notify_admins(self, ctx: RunContext, text: str) -> None:
        """Every admin gets the alert (it is not a review item, so no buttons)."""
        recipients = [ctx.owner_id, *sorted(i for i in ctx.admin_ids if i != ctx.owner_id)]
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [trend alert to {recipients}] ---\n{text}\n")
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
                ctx.count("trend_notices_sent")
            except Exception:  # an admin who never started the bot must not stop the run
                ctx.count("trend_notices_failed")

    @staticmethod
    def _story_label(story: StoryCluster) -> str:
        said = story.published_text or {}
        return str(said.get("title") or story.title or story.event_id)

    @staticmethod
    async def _persian_names(repos: Repositories, since: datetime) -> dict[str, str]:
        """Normalized original spelling → the Persian spelling a summary used for it."""
        names: dict[str, str] = {}
        for entities in await repos.summaries.entities_since(since, MAX_SUMMARIES):
            for entity in entities:
                original, fa = entity.get("original"), entity.get("fa")
                if original and fa:
                    names.setdefault(normalize_for_match(str(original)), str(fa))
        return names
