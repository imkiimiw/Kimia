"""Phase 2 integration: AI stage (summarize → guard → rewrite → route), review cards and buttons,
edits, publish modes, settings and the main channel. FakeAI + FakeTelegram, in-memory DB."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from wanger_news.ai.provider import AIBlocked, AIBudgetExhausted, AIResult, AIUnavailable
from wanger_news.ai.schemas import SummarizeOutput
from wanger_news.db.tables import AIRun, Article, ReviewRequest, Summary
from wanger_news.domain.enums import ArticleStatus

from .conftest import (
    ADMIN,
    MAIN_CHANNEL,
    OWNER,
    TEST_CHANNEL,
    Harness,
    Updates,
    make_config,
    source_entries,
    standard_feeds,
)
from .fake_ai import FakeAI

ECONOMY = "Central bank raises"
BAD_NUMBER = {"summary": "نرخ بهره به ۹۹ درصد رسید."}  # 99 is not in the source


async def article(h: Harness, title_start: str, source: str | None = None) -> Article:
    for a in await h.articles():
        if a.title_original.startswith(title_start) and (source is None or a.source_id == source):
            return a
    raise AssertionError(title_start)


def cards(h: Harness, chat_id: int = OWNER) -> list[dict[str, Any]]:
    return [p for p in h.telegram.messages_to(chat_id) if p["text"].startswith("🧐")]


def buttons(card: dict[str, Any]) -> list[str]:
    return [b["callback_data"] for row in card["reply_markup"]["inline_keyboard"] for b in row]


async def summary_of(h: Harness, a: Article) -> Summary:
    rows = await h.rows(sa.select(Summary).where(Summary.id == a.summary_id))
    return rows[0][0]


# ------------------------------------------------------------------ semi mode and buttons


async def test_semi_mode_sends_review_cards_and_publishes_nothing(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    summary = await harness.run()
    assert harness.telegram.channel_posts() == []
    waiting = [a for a in await harness.articles() if a.status == ArticleStatus.PENDING_REVIEW]
    assert len(waiting) == 5
    assert all(a.summary_id and a.importance_score and a.confidence_score for a in waiting)
    assert len(cards(harness, OWNER)) == 5 and len(cards(harness, ADMIN)) == 5
    first = cards(harness)[0]
    assert {d.split(":")[1] for d in buttons(first)} == {"a", "p", "e", "r"}
    assert "پیش‌نمایش" in first["text"] and "عنوان فارسی آزمایشی" in first["text"]
    runs = [r[0] for r in await harness.rows(sa.select(AIRun.operation).order_by(AIRun.id))]
    assert runs == ["summarize", "verify", "summarize", "verify"]
    assert summary.counters["ai_processed"] == 5
    # a second run sends no duplicate cards
    harness.clock.advance(minutes=15)
    await harness.run()
    assert len(cards(harness, OWNER)) == 5


async def test_approve_button_publishes_and_closes_every_card(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    harness.telegram.updates = [Updates().callback(f"rv:a:{economy.id}")]
    harness.clock.advance(minutes=15)
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    assert economy.status == ArticleStatus.PUBLISHED and economy.approved_by == OWNER
    [(method, post)] = harness.telegram.channel_posts()
    assert method == "sendPhoto" and "عنوان فارسی آزمایشی" in post["caption"]
    edits = [p for m, p in harness.telegram.calls if m == "editMessageReplyMarkup"]
    assert len(edits) == 2  # owner's and admin's card
    assert "تأیید شد" in edits[0]["reply_markup"]["inline_keyboard"][0][0]["text"]
    answers = [p for m, p in harness.telegram.calls if m == "answerCallbackQuery"]
    assert answers and "تأیید" in answers[0]["text"]
    still_open = await harness.scalar(
        sa.select(sa.func.count())
        .select_from(ReviewRequest)
        .where(ReviewRequest.article_id == economy.id, ReviewRequest.status == "open")
    )
    assert still_open == 0


async def test_publish_now_goes_first_and_outside_the_cap(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    chip = await article(harness, "Startup unveils")
    up = Updates()
    harness.telegram.updates = [up.callback(f"rv:a:{chip.id}"), up.callback(f"rv:p:{economy.id}")]
    await harness.run(max_posts=1)
    posts = harness.telegram.channel_posts()
    assert len(posts) == 2
    assert "economy-123" in (posts[0][1].get("caption") or posts[0][1].get("text"))


async def test_reject_button(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    harness.telegram.updates = [Updates().callback(f"rv:r:{economy.id}")]
    await harness.run()
    harness.clock.advance(minutes=15)
    await harness.run()
    assert (await article(harness, ECONOMY, "alpha")).status == ArticleStatus.REJECTED
    assert harness.telegram.channel_posts() == []


async def test_strangers_cannot_press_buttons(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    harness.telegram.updates = [Updates().callback(f"rv:a:{economy.id}", user_id=999)]
    await harness.run()
    assert (await article(harness, ECONOMY, "alpha")).status == ArticleStatus.PENDING_REVIEW
    answers = [p for m, p in harness.telegram.calls if m == "answerCallbackQuery"]
    assert "اجازه" in answers[0]["text"]


async def test_edit_by_reply_then_approve(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    up = Updates()
    harness.telegram.updates = [up.callback(f"rv:e:{economy.id}")]
    await harness.run()
    prompt = [p for p in harness.telegram.messages_to(OWNER) if "ویرایش خبر" in p["text"]][-1]
    assert prompt["reply_markup"]["force_reply"] is True
    prompt_id = harness.telegram.next_id  # FakeTelegram numbered the prompt last
    edited = "عنوان ویرایش‌شده توسط ادمین\nمتن ویرایش‌شده خبر.\n• نکتهٔ تازه"
    harness.telegram.updates.append(up.reply(edited, prompt_id))
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    human = await summary_of(harness, economy)
    assert human.origin == "human" and human.created_by == OWNER
    assert human.title == "عنوان ویرایش‌شده توسط ادمین" and human.key_points == ["نکتهٔ تازه"]
    assert economy.status == ArticleStatus.PENDING_REVIEW and economy.review_reason == "human_edit"
    fresh = [c for c in cards(harness) if "عنوان ویرایش‌شده" in c["text"]]
    assert fresh and "ویرایش شد" in fresh[0]["text"]
    harness.telegram.updates.append(up.callback(f"rv:a:{economy.id}"))
    await harness.run()
    [(_, post)] = harness.telegram.channel_posts()
    assert "عنوان ویرایش‌شده توسط ادمین" in post["caption"] and "نکتهٔ تازه" in post["caption"]


# ------------------------------------------------------------------ guard and routing


async def test_sensitive_items_need_a_human_even_in_auto_mode(harness: Harness) -> None:
    await harness.run()  # the harness default is auto
    troops = await article(harness, "Troops advance")
    assert troops.status == ArticleStatus.PENDING_REVIEW
    assert troops.review_reason and troops.review_reason.startswith("sensitive:")
    assert (await article(harness, ECONOMY, "alpha")).status == ArticleStatus.PUBLISHED
    assert any("موضوع حساس" in c["text"] for c in cards(harness))


async def test_hallucinated_number_is_rewritten_then_published(harness: Harness) -> None:
    assert harness.ai is not None
    harness.ai.drafts["central bank raised"] = BAD_NUMBER
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    assert economy.status == ArticleStatus.PUBLISHED
    final = await summary_of(harness, economy)
    assert final.origin == "rewrite" and final.valid and "۹۹" not in final.summary
    assert economy.confidence and economy.confidence["guard_state"] == "after_rewrite"
    assert "rewrite" in harness.ai.operations()


async def test_failing_twice_goes_to_a_human_and_is_never_published(harness: Harness) -> None:
    assert harness.ai is not None
    harness.ai.drafts["central bank raised"] = BAD_NUMBER
    harness.ai.rewrites["central bank raised"] = BAD_NUMBER
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    assert (
        economy.status == ArticleStatus.PENDING_REVIEW and economy.review_reason == "guard_failed"
    )
    assert (economy.confidence_score or 100) < 50  # failed verification = "unconfirmed"
    card = next(c for c in cards(harness) if "economy-123" in c["text"])
    assert "عدد در منبع نیست: 99" in card["text"]
    assert all(
        "economy-123" not in (p.get("caption") or p.get("text") or "")
        for _, p in harness.telegram.channel_posts()
    )


async def test_verifier_findings_trigger_the_rewrite(harness: Harness) -> None:
    assert harness.ai is not None
    harness.ai.drafts["central bank raised"] = {
        "summary": "بانک نرخ را بالا برد و جملهٔ ساختگی گفت."
    }
    harness.ai.unsupported["central bank raised"] = ["جملهٔ ساختگی"]
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    assert economy.status == ArticleStatus.PUBLISHED
    assert (await summary_of(harness, economy)).origin == "rewrite"


async def test_ids_the_model_invents_are_ignored_and_missing_ones_retried(harness: Harness) -> None:
    class Sloppy(FakeAI):
        async def summarize(self, items, *, language, categories):  # type: ignore[no-untyped-def]
            result = await super().summarize(items, language=language, categories=categories)
            arts = result.data.articles
            forged = arts[0].model_copy(update={"id": "a999999"})
            data = SummarizeOutput(articles=[forged, *arts[1:]])  # first id missing, one invented
            return AIResult(data=data, usage=result.usage)

    harness.ai = Sloppy()
    await harness.run()
    missing = [a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]
    assert len(missing) == 2  # the first item of each batch waits for another attempt
    assert all(a.summary_id is None for a in missing)


# ------------------------------------------------------------------ budget and failures


async def test_quota_leaves_items_for_the_next_run(harness: Harness) -> None:
    assert harness.ai is not None
    harness.ai.fail("summarize", AIBudgetExhausted("RESOURCE_EXHAUSTED"))
    summary = await harness.run()
    assert any(k.startswith("ai_stopped:quota") for k in summary.counters)
    pending = [a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]
    assert len(pending) == 5
    statuses = [r[0] for r in await harness.rows(sa.select(AIRun.status))]
    assert statuses == ["quota"]
    harness.clock.advance(minutes=15)
    await harness.run()
    assert not [a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]


async def test_provider_outage_is_reported_and_items_wait(harness: Harness) -> None:
    assert harness.ai is not None
    harness.ai.fail("summarize", AIUnavailable("gemini 503: overloaded"))
    summary = await harness.run()
    assert any("ai:" in e for e in summary.errors)
    assert len([a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]) == 5


async def test_a_blocked_batch_is_retried_item_by_item(harness: Harness) -> None:
    harness.config = make_config(ai={"max_calls_per_run": 20})
    assert harness.ai is not None
    harness.ai.fail("summarize", AIBlocked("blocked (SAFETY)"))
    await harness.run()
    assert not [a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]
    singles = [ids for op, ids in harness.ai.calls if op == "summarize"][1:]
    assert all(len(ids) == 1 for ids in singles[:4])


async def test_an_item_that_keeps_failing_goes_to_a_human_without_text(harness: Harness) -> None:
    harness.config = make_config(source_entries()[2:3])  # only gamma (one article)
    assert harness.ai is not None
    for _ in range(3):
        harness.ai.fail("summarize", AIBlocked("blocked (SAFETY)"))
    for _ in range(3):
        await harness.run()
        harness.clock.advance(minutes=15)
    genome = await article(harness, "Researchers map")
    assert genome.status == ArticleStatus.PENDING_REVIEW and genome.summary_id is None
    card = cards(harness)[0]
    assert "متن فارسی آماده نیست" in card["text"]
    assert {d.split(":")[1] for d in buttons(card)} == {"e", "r"}  # nothing to approve yet


async def test_per_run_budget(harness: Harness) -> None:
    harness.config = make_config(ai={"max_calls_per_run": 2})
    summary = await harness.run()
    assert summary.counters["ai_calls"] == 2
    assert summary.counters.get("ai_stopped:budget") == 1
    assert len([a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]) == 1


async def test_daily_budget_counts_earlier_runs(harness: Harness) -> None:
    harness.config = make_config(ai={"max_calls_per_day": 2})
    await harness.run()
    harness.clock.advance(minutes=15)
    summary = await harness.run()
    assert summary.counters.get("ai_calls", 0) == 0
    assert len([a for a in await harness.articles() if a.status == ArticleStatus.AI_PENDING]) == 1


async def test_reprocessing_reuses_the_cached_summary(harness: Harness) -> None:
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    from sqlalchemy.ext.asyncio import AsyncSession

    async with AsyncSession(harness.engine) as session:
        await session.execute(
            sa.update(Article)
            .where(Article.id == economy.id)
            .values(status=ArticleStatus.AI_PENDING.value)
        )
        await session.commit()
    assert harness.ai is not None
    before = len(harness.ai.calls)
    harness.clock.advance(minutes=15)
    summary = await harness.run()
    assert summary.counters["ai_cached"] == 1 and len(harness.ai.calls) == before


async def test_without_a_provider_feed_items_wait_and_expire(harness: Harness) -> None:
    harness.ai = None
    summary = await harness.run()
    assert any(k.startswith("ai_skipped:") for k in summary.counters)
    assert harness.telegram.channel_posts() == []
    harness.clock.advance(hours=13)
    harness.server.routes.clear()
    harness.ai = FakeAI()
    await harness.run()
    assert harness.ai.calls == []
    assert len([a for a in await harness.articles() if a.status == ArticleStatus.EXPIRED]) == 5


async def test_dry_run_previews_ai_posts_and_keeps_nothing(harness: Harness) -> None:
    summary = await harness.run(dry_run=True)
    assert summary.counters["posts_previewed"] > 0
    assert any("عنوان فارسی آزمایشی" in line for line in harness.output)
    assert await harness.scalar(sa.select(sa.func.count()).select_from(AIRun)) == 0
    assert harness.ai is not None and len(harness.ai.calls) == 2  # dry_run_max_calls


# ------------------------------------------------------------------ modes, settings, channel


async def test_manual_mode_holds_items_until_an_admin_picks_one(harness: Harness) -> None:
    harness.config = make_config(mode="manual")
    await harness.run()
    economy = await article(harness, ECONOMY, "alpha")
    assert economy.status == ArticleStatus.HELD
    assert cards(harness) == [] or all("موضوع حساس" in c["text"] for c in cards(harness))
    up = Updates()
    harness.telegram.updates = [up.private("/pending"), up.private(f"/publish {economy.id}")]
    await harness.run()
    listing = harness.telegram.owner_messages()
    assert any(f"#{economy.id}" in m and "حالت دستی" in m for m in listing)
    assert (await article(harness, ECONOMY, "alpha")).status == ArticleStatus.PUBLISHED


async def test_settings_switch_mode_and_target(harness: Harness) -> None:
    harness.config = make_config(mode="semi")
    harness.channels = {"test": TEST_CHANNEL, "main": MAIN_CHANNEL}
    up = Updates()
    harness.telegram.updates = [
        up.private("/settings mode technology auto"),
        up.private("/settings target main"),
        up.private("/settings"),
    ]
    harness.server.routes.clear()
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert "technology = auto" in replies[0] and "کانال اصلی" in replies[1]
    assert "technology: auto" in replies[2]
    standard_feeds(harness.server)
    harness.clock.advance(minutes=15)
    await harness.run()
    posts = harness.telegram.channel_posts()
    assert [p["chat_id"] for _, p in posts] == ["@wanger_main"]  # the technology item only
    chip = await article(harness, "Startup unveils")
    assert chip.status == ArticleStatus.PUBLISHED and chip.publish_mode == "auto"


async def test_target_main_needs_a_main_channel(harness: Harness) -> None:
    harness.channels = {"test": TEST_CHANNEL, "main": None}
    harness.telegram.updates = [Updates().private("/settings target main")]
    harness.server.routes.clear()
    await harness.run()
    assert "تنظیم نشده" in harness.telegram.owner_messages()[0]


async def test_the_published_ai_post(harness: Harness) -> None:
    await harness.run()
    caption = next(p["caption"] for m, p in harness.telegram.channel_posts() if m == "sendPhoto")
    for expected in (
        "<b>عنوان فارسی آزمایشی</b>",
        "• نکتهٔ کلیدی آزمایشی",
        "📌 وضعیت: گزارش اولیه",
        "⚠️ این خبر در حال حاضر فقط بر اساس گزارش Alpha News است",
        "📰 منابع: Alpha News",
        "#اقتصاد",
        "🖼 تصویر: Alpha News",
    ):
        assert expected in caption, expected
    economy = await article(harness, ECONOMY, "alpha")
    assert economy.confidence_score == 69 and economy.confidence["single_source_cap"] == 69
    assert set(economy.importance["components"]) >= {"rule_priority", "severity", "recency"}
    summary = await summary_of(harness, economy)
    assert summary.prompt_version == "summarize_fake_v1" and summary.guard == {
        "passed": True,
        "issues": [],
    }


async def test_status_shows_ai_usage(harness: Harness) -> None:
    await harness.run()
    harness.telegram.updates = [Updates().private("/status")]
    harness.server.routes.clear()
    await harness.run()
    status = harness.telegram.owner_messages()[-1]
    assert "هوش مصنوعی" in status and "در انتظار بررسی انسانی" in status
