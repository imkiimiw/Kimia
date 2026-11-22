"""Phase 5 operations: analytics, cost tracking, source reliability learning."""

from __future__ import annotations

import sqlalchemy as sa

from wanger_news.config.models import ReliabilityConfig
from wanger_news.db.tables import ReliabilityHistory
from wanger_news.domain.enums import ArticleStatus
from wanger_news.domain.reliability import Signals, suggest
from wanger_news.services.overrides import RELIABILITY_KEY, Overrides, apply

from .conftest import OWNER, Harness, Updates, make_config

# ------------------------------------------------------------------ the formula


def test_suggestions_need_evidence_and_stay_small() -> None:
    cfg = ReliabilityConfig()
    assert suggest(80, Signals(approved=2, rejected=2), cfg) is None  # too few decisions
    up = suggest(70, Signals(approved=10, claims=10, confirmed=9), cfg)
    assert up is not None and up.new == 79 and up.change == 9
    assert any("تأیید ادمین ۱۰۰٪" in p for p in up.parts)
    down = suggest(
        80, Signals(approved=1, rejected=9, summarized=10, guard_failed=5, corrections=2), cfg
    )
    assert down is not None and down.new == 70  # clamped to max_step 10
    assert suggest(80, Signals(approved=8, rejected=2), cfg) is None  # change +1 < min_change


# ------------------------------------------------------------------ analytics and costs


async def test_report_and_command(harness: Harness) -> None:
    await harness.run()
    harness.telegram.updates = [Updates().private("/report 7")]
    harness.server.routes.clear()
    await harness.run()
    report = next(t for t in harness.telegram.owner_messages() if t.startswith("<b>💰"))
    assert "آمار و هزینهٔ ۷ روز اخیر" in report and "📥 خبر دریافت‌شده" in report
    assert "🤖 هوش مصنوعی" in report and "summarize" in report and "برآورد ماهانه" in report


async def test_the_budget_alert_comes_once_a_month(harness: Harness) -> None:
    harness.config = make_config(costs={"monthly_budget_usd": 0.0001})
    summary = await harness.run()
    assert summary.counters["budget_alert"] == 1
    assert any("هشدار هزینه" in t for t in harness.telegram.owner_messages())
    harness.clock.advance(minutes=15)
    assert "budget_alert" not in (await harness.run()).counters


# ------------------------------------------------------------------ reliability learning


async def test_a_suggestion_is_applied_only_by_the_owner(harness: Harness) -> None:
    harness.config = make_config(mode="semi", reliability={"min_samples": 1, "min_change": 1})
    await harness.run()  # cards for the alpha/beta/gamma items
    alpha = [
        a
        for a in await harness.articles()
        if a.source_id == "alpha" and a.status == ArticleStatus.PENDING_REVIEW
    ]
    assert alpha
    updates = Updates()
    harness.telegram.updates = [updates.callback(f"rv:r:{a.id}") for a in alpha]
    harness.clock.advance(days=8)  # the weekly check is due again
    harness.server.routes.clear()
    summary = await harness.run()
    assert summary.counters["reliability_suggested"] >= 1
    row = next(
        r[0]
        for r in await harness.rows(sa.select(ReliabilityHistory))
        if r[0].source_id == "alpha" and r[0].status == "suggested"
    )
    assert row.new_score < row.old_score == 80
    assert "تأیید ادمین ۰٪" in row.explanation
    notice = next(t for t in harness.telegram.owner_messages() if "پیشنهاد تغییر اعتبار" in t)
    assert "Alpha News" in notice and "خودکار اعمال نمی‌شود" in notice
    # nothing changed yet
    assert (
        await harness.scalar(sa.text(f"select value from settings where key='{RELIABILITY_KEY}'"))
        is None
    )
    harness.telegram.updates = [updates.callback(f"pn:rel:a:{row.id}", user_id=OWNER)]
    harness.clock.advance(minutes=15)
    await harness.run()
    row = next(r[0] for r in await harness.rows(sa.select(ReliabilityHistory)) if r[0].id == row.id)
    assert row.status == "applied" and row.decided_by == OWNER
    effective = apply(harness.config, Overrides(scores={"alpha": row.new_score}))
    alpha_source = effective.source("alpha")
    assert alpha_source is not None and alpha_source.reliability_score == row.new_score


async def test_the_weekly_check_does_not_repeat_every_run(harness: Harness) -> None:
    first = await harness.run()
    assert "reliability_suggested" not in first.counters  # no evidence yet
    rows = await harness.rows(sa.select(ReliabilityHistory))
    assert len(rows) == 1 and rows[0][0].source_id == "*"  # the check itself is remembered
    harness.clock.advance(minutes=15)
    await harness.run()
    assert len(await harness.rows(sa.select(ReliabilityHistory))) == 1
