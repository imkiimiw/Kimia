"""Analytics and cost tracking (Phase 5): what came in, what went out, what humans decided,
how fast, what the AI used and what it would cost on a paid plan. Read only."""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.domain.text import to_persian_digits
from wanger_news.formatting.telegram_html import bold, esc
from wanger_news.services.context import RunContext

BUDGET_ALERT_KEY = "costs.alerted_month"


@dataclass(slots=True)
class Report:
    days: float
    since: datetime
    articles_by_status: dict[str, int] = field(default_factory=dict)
    articles_by_source: dict[str, int] = field(default_factory=dict)
    articles_by_category: dict[str, int] = field(default_factory=dict)
    posts_by_kind: dict[str, int] = field(default_factory=dict)
    review_outcomes: dict[str, int] = field(default_factory=dict)
    median_minutes_to_publish: float | None = None
    ai_by_operation: dict[str, dict[str, float]] = field(default_factory=dict)
    ai_by_model: dict[str, dict[str, float]] = field(default_factory=dict)
    guard: dict[str, int] = field(default_factory=dict)
    stories: dict[str, int] = field(default_factory=dict)
    corrections: dict[str, int] = field(default_factory=dict)

    @property
    def ai_cost(self) -> float:
        return sum(v["cost_usd"] for v in self.ai_by_operation.values())

    @property
    def ai_calls(self) -> int:
        return int(sum(v["calls"] for v in self.ai_by_operation.values()))

    @property
    def monthly_cost(self) -> float:
        return self.ai_cost * 30 / self.days if self.days else 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "days": self.days,
            "since": self.since.isoformat(),
            "articles_by_status": self.articles_by_status,
            "articles_by_source": self.articles_by_source,
            "articles_by_category": self.articles_by_category,
            "posts_by_kind": self.posts_by_kind,
            "review_outcomes": self.review_outcomes,
            "median_minutes_to_publish": self.median_minutes_to_publish,
            "ai_by_operation": self.ai_by_operation,
            "ai_by_model": self.ai_by_model,
            "ai_calls": self.ai_calls,
            "ai_cost_usd": round(self.ai_cost, 4),
            "monthly_cost_usd_estimate": round(self.monthly_cost, 2),
            "guard": self.guard,
            "stories": self.stories,
            "corrections": self.corrections,
        }


class AnalyticsService:
    def __init__(self, config: AppConfig) -> None:
        self._cfg = config

    async def report(self, repos: Repositories, now: datetime, days: float = 7) -> Report:
        since = now - timedelta(days=days)
        a = repos.analytics
        minutes = await a.minutes_to_publish(since)
        return Report(
            days=days,
            since=since,
            articles_by_status=await a.articles_by("status", since),
            articles_by_source=await a.articles_by("source_id", since),
            articles_by_category=await a.articles_by("category", since),
            posts_by_kind=await a.posts_by_kind(since),
            review_outcomes=await a.review_outcomes(since),
            median_minutes_to_publish=statistics.median(minutes) if minutes else None,
            ai_by_operation=await a.ai_by("operation", since),
            ai_by_model=await a.ai_by("model", since),
            guard=await a.guard_results(since),
            stories=await a.story_counts(since),
            corrections=await a.corrections_by_status(since),
        )

    def render(self, r: Report) -> str:
        def fa(n: float) -> str:
            return to_persian_digits(str(int(n)))

        total = sum(r.articles_by_status.values())
        posts = sum(r.posts_by_kind.values())
        out = [bold(f"💰 آمار و هزینهٔ {fa(r.days)} روز اخیر")]
        out.append(f"📥 خبر دریافت‌شده: {fa(total)} · 📤 پست منتشرشده: {fa(posts)}")
        if r.posts_by_kind:
            kinds = {
                "story": "خبر",
                "update": "به‌روزرسانی",
                "brief": "خلاصهٔ روز",
                "trend": "هشدار روند",
                "correction": "اصلاحیه",
            }
            out.append(
                "   "
                + " · ".join(
                    f"{kinds.get(k, k)}: {fa(n)}" for k, n in sorted(r.posts_by_kind.items())
                )
            )
        if r.median_minutes_to_publish is not None:
            out.append(f"⏱ میانهٔ زمان از دریافت تا انتشار: {fa(r.median_minutes_to_publish)} دقیقه")
        decided = r.review_outcomes
        if decided:
            ok = decided.get("approve", 0) + decided.get("publish", 0)
            out.append(
                f"🧐 تصمیم ادمین: تأیید {fa(ok)} · رد {fa(decided.get('reject', 0))} · "
                f"ویرایش {fa(decided.get('edited', 0))} · منقضی {fa(decided.get('expired', 0))}"
            )
        guard_total = sum(r.guard.values())
        if guard_total:
            failed = r.guard.get("failed", 0)
            out.append(
                f"🛡 بررسی ضدتوهم: {fa(guard_total)} متن، رد {fa(failed)} "
                f"({fa(round(100 * failed / guard_total))}٪)"
            )
        if r.stories:
            out.append(
                f"🧩 رویداد تازه: {fa(r.stories.get('stories', 0))} · "
                f"چندمنبعی: {fa(r.stories.get('multi_source', 0))}"
            )
        if r.corrections:
            out.append(
                "⚠️ اصلاحیه: "
                + " · ".join(f"{esc(k)} {fa(n)}" for k, n in sorted(r.corrections.items()))
            )
        out.append("")
        out.append(bold("🤖 هوش مصنوعی"))
        out.append(
            f"فراخوانی: {fa(r.ai_calls)} · هزینهٔ برآوردی: ${r.ai_cost:.2f} · "
            f"برآورد ماهانه: ${r.monthly_cost:.2f}"
        )
        for op, v in sorted(r.ai_by_operation.items()):
            tokens = fa(v["input_tokens"] + v["output_tokens"])
            errors = f" · خطا {fa(v['errors'])}" if v["errors"] else ""
            out.append(f"• {esc(op)}: {fa(v['calls'])} فراخوانی · {tokens} توکن{errors}")
        out.append("(روی سهمیهٔ رایگان هزینه‌ای پرداخت نمی‌شود؛ عدد برآورد پلن پولی است.)")
        top = sorted(r.articles_by_source.items(), key=lambda kv: -kv[1])[:6]
        if top:
            out.append("")
            out.append(bold("📰 بیشترین خبر از"))
            for source_id, n in top:
                source = self._cfg.source(source_id)
                out.append(f"• {esc(source.name if source else source_id)}: {fa(n)}")
        return "\n".join(out)

    async def check_budget(self, repos: Repositories, ctx: RunContext) -> bool:
        """Warn the owner once a month when the estimated monthly cost nears the budget."""
        costs = self._cfg.pipeline.costs
        if costs.monthly_budget_usd <= 0:
            return False
        report = await self.report(repos, ctx.now(), days=7)
        if report.monthly_cost < costs.monthly_budget_usd * costs.alert_at_fraction:
            return False
        month = ctx.now().strftime("%Y-%m")
        if await repos.settings.get(BUDGET_ALERT_KEY) == month:
            return False
        await ctx.notify_owner(
            repos,
            "💸 <b>هشدار هزینه</b>\n"
            f"برآورد هزینهٔ ماهانهٔ هوش مصنوعی ${report.monthly_cost:.2f} است؛ "
            f"بودجه ${costs.monthly_budget_usd:.2f}. سقف‌ها در config/pipeline.yaml ← ai.",
            kind="budget",
        )
        await repos.settings.set(BUDGET_ALERT_KEY, month, ctx.now())
        return True
