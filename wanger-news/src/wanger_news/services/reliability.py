"""Source reliability learning (Phase 5): weekly SUGGESTIONS, applied only by the owner.

Signals per source over ``reliability.window_days``: the admins' decisions on its items, the
hallucination guard's verdicts on texts made from it, how often its claims were confirmed by
another independent origin, and published corrections of stories it led
(``domain/reliability.suggest``). Every suggestion and decision is a ``reliability_history``
row; an applied score is stored with the panel's settings and used from the next run.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import ReliabilityHistory
from wanger_news.domain.enums import Transport
from wanger_news.domain.reliability import Signals, suggest
from wanger_news.domain.text import to_persian_digits
from wanger_news.formatting.telegram_html import esc
from wanger_news.services.context import RunContext
from wanger_news.services.overrides import RELIABILITY_KEY

SUGGESTED, APPLIED, DISMISSED, SUPERSEDED = "suggested", "applied", "dismissed", "superseded"


@dataclass(slots=True)
class LearningReport:
    skipped: str | None = None
    suggested: int = 0


class ReliabilityService:
    def __init__(self, config: AppConfig, base: AppConfig | None = None) -> None:
        self._cfg = config  # this run's config (applied scores included)
        self._base = base or config
        self._learn = config.pipeline.reliability

    async def signals(
        self, repos: Repositories, since_days: float, now: datetime
    ) -> dict[str, Signals]:
        since = now - timedelta(days=since_days)
        a = repos.analytics
        decisions = await a.source_decisions(since)
        guard = await a.source_guard(since)
        corrected = await a.corrected_sources(since)
        claims = await a.claim_rows(since)
        owners = await a.article_sources(i for _, ids in claims for i in ids)
        claim_counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
        for status, ids in claims:
            for owner in {owners[i] for i in ids if i in owners}:
                claim_counts[owner][0] += 1
                claim_counts[owner][1] += status == "confirmed"
        out = {}
        for source in self._cfg.sources.sources:
            if source.transport is not Transport.RSS:
                continue
            d, g = decisions.get(source.id, {}), guard.get(source.id, {})
            out[source.id] = Signals(
                approved=d.get("approve", 0) + d.get("publish", 0),
                rejected=d.get("reject", 0),
                summarized=g.get("passed", 0) + g.get("failed", 0),
                guard_failed=g.get("failed", 0),
                claims=claim_counts[source.id][0],
                confirmed=claim_counts[source.id][1],
                corrections=corrected.get(source.id, 0),
            )
        return out

    async def run(self, repos: Repositories, ctx: RunContext) -> LearningReport:
        report = LearningReport()
        if not self._learn.enabled:
            report.skipped = "disabled"
            return report
        latest = await repos.reliability.latest()
        if latest is not None and latest.created_at > ctx.now() - timedelta(
            days=self._learn.every_days
        ):
            report.skipped = "not_due"
            return report
        signals = await self.signals(repos, self._learn.window_days, ctx.now())
        pending = {r.source_id: r for r in await repos.reliability.by_status(SUGGESTED)}
        lines = []
        for source_id, sig in signals.items():
            source = self._cfg.source(source_id)
            if source is None:
                continue
            found = suggest(source.reliability_score, sig, self._learn)
            if found is None:
                continue
            if source_id in pending:
                pending[source_id].status = SUPERSEDED
            await repos.reliability.add(
                ReliabilityHistory(
                    source_id=source_id,
                    old_score=found.old,
                    new_score=found.new,
                    signals=sig.as_dict(),
                    explanation="؛ ".join(found.parts),
                    status=SUGGESTED,
                    created_at=ctx.now(),
                )
            )
            report.suggested += 1
            lines.append(
                f"• {esc(source.name)}: {to_persian_digits(str(found.old))} → "
                f"{to_persian_digits(str(found.new))}"
            )
        if not report.suggested:  # remember the check, so it runs weekly, not every run
            await repos.reliability.add(
                ReliabilityHistory(
                    source_id="*",
                    old_score=0,
                    new_score=0,
                    signals={},
                    explanation="no suggestion this week",
                    status=DISMISSED,
                    created_at=ctx.now(),
                )
            )
        await repos.commit()
        if report.suggested:
            await ctx.notify_owner(
                repos,
                "🎯 <b>پیشنهاد تغییر اعتبار منابع</b>\n"
                + "\n".join(lines[:10])
                + "\nهیچ‌کدام خودکار اعمال نمی‌شود: /panel ← 🎯 اعتبار منابع",
                kind="reliability",
            )
        return report

    async def decide(
        self, repos: Repositories, ctx: RunContext, row_id: int, apply: bool, admin_id: int
    ) -> str:
        row = await repos.reliability.get(row_id)
        if row is None or row.status != SUGGESTED:
            return "این پیشنهاد دیگر باز نیست."
        row.status = APPLIED if apply else DISMISSED
        row.decided_by, row.decided_at = admin_id, ctx.now()
        if apply:
            scores = dict(await repos.settings.get(RELIABILITY_KEY) or {})
            scores[row.source_id] = row.new_score
            await repos.settings.set(RELIABILITY_KEY, scores, ctx.now())
        await repos.commit()
        source = self._base.source(row.source_id)
        name = source.name if source else row.source_id
        if apply:
            return (
                f"✅ اعتبار {esc(name)} از اجرای بعدی {to_persian_digits(str(row.new_score))} است."
            )
        return f"❌ پیشنهاد برای {esc(name)} رد شد."
