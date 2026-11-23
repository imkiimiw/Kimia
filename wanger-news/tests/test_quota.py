"""The daily AI quota spread evenly over the day, and learned from Google's 429 answer."""

from __future__ import annotations

import httpx
import sqlalchemy as sa

from wanger_news.ai.provider import AIBudgetExhausted
from wanger_news.domain.quota import paced_allowance

from .conftest import Harness, make_config
from .fake_ai import FakeAI

SLOT = 10 / (24 * 60)


def test_the_quota_is_spread_over_the_day() -> None:
    assert (
        paced_allowance(
            quota=150, used=0, elapsed_fraction=0, interval_fraction=SLOT, per_run_cap=24
        )
        == 1
    )  # too little for a batch: wait
    assert (
        paced_allowance(
            quota=150, used=70, elapsed_fraction=0.5, interval_fraction=SLOT, per_run_cap=24
        )
        == 6
    )
    # missed runs leave their share to later runs, within the per-run cap
    assert (
        paced_allowance(
            quota=150, used=0, elapsed_fraction=0.5, interval_fraction=SLOT, per_run_cap=24
        )
        == 24
    )
    # never more than the quota, even at the end of the day
    assert (
        paced_allowance(
            quota=150, used=149, elapsed_fraction=0.999, interval_fraction=SLOT, per_run_cap=24
        )
        == 1
    )
    assert (
        paced_allowance(
            quota=150, used=150, elapsed_fraction=1.2, interval_fraction=SLOT, per_run_cap=24
        )
        == 0
    )


def test_a_whole_day_of_runs_uses_exactly_the_quota() -> None:
    used, quota = 0, 150
    for run in range(144):  # every 10 minutes
        allowed = paced_allowance(
            quota=quota,
            used=used,
            elapsed_fraction=run * SLOT,
            interval_fraction=SLOT,
            per_run_cap=24,
        )
        used += allowed if allowed >= 2 else 0  # a batch needs summarize + verify
    assert quota - 2 <= used <= quota


async def test_the_real_daily_quota_is_learned_from_google(harness: Harness) -> None:
    harness.config = make_config(ai={"pace_daily_quota": True, "max_calls_per_day": 10000})
    ai = FakeAI()
    error = AIBudgetExhausted("gemini quota: RESOURCE_EXHAUSTED")
    error.daily_limit = 1000
    ai.fail("summarize", error)
    harness.ai = ai
    summary = await harness.run()
    assert any(k.startswith("ai_stopped:quota") for k in summary.counters)
    stored = await harness.scalar(
        sa.text("select value from settings where key = 'ai.daily_quota'")
    )
    assert str(stored).strip('"') == "1000"


def test_the_quota_value_is_read_from_a_429_answer() -> None:
    from wanger_news.ai.gemini import _daily_limit

    body = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                    "violations": [
                        {
                            "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                            "quotaValue": "15",
                        },
                        {
                            "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                            "quotaValue": "1000",
                        },
                    ],
                }
            ],
        }
    }
    assert _daily_limit(httpx.Response(429, json=body)) == 1000
    assert _daily_limit(httpx.Response(429, text="no json")) is None


async def test_the_owner_sets_the_daily_quota(harness: Harness) -> None:
    from .conftest import ADMIN, Updates

    updates = Updates()
    harness.telegram.updates = [
        updates.private("/quota ۱۰۰۰"),
        updates.private("/quota 5", user_id=ADMIN),
        updates.private("/quota"),
    ]
    harness.server.routes.clear()
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert "سهمیه: ۱۰۰۰ درخواست در روز" in replies[0]
    assert "فقط برای مالک" in harness.telegram.messages_to(ADMIN)[-1]["text"]
    assert "سهمیه: ۱۰۰۰" in replies[1]
    stored = await harness.scalar(
        sa.text("select value from settings where key = 'ai.daily_quota'")
    )
    assert str(stored) == "1000"
