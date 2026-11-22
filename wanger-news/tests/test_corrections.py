"""Phase 5: corrections of published stories (spec §10) and edits of source-channel posts."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from wanger_news.db.tables import Correction, PublishedPost
from wanger_news.domain.corrections import Proposal, check, correction_text
from wanger_news.formatting.templates_fa import render_correction

from .conftest import NOW, Harness, Updates
from .test_stories import by_source, posts, serve, setup, stories, text_of

PUBLISHED = "پل بزرگراه فرو ریخت و دست‌کم ۲۰ نفر مصدوم شدند."
SOURCE = "Officials now put the number of injured at 25, after a recount on Wednesday."


def proposal(**over: str) -> Proposal:
    data = {
        "item": "شمار مصدومان",
        "old": "۲۰",
        "new": "۲۵",
        "source_id": "s9",
        "evidence": "put the number of injured at 25",
    }
    return Proposal(**{**data, **over})


def problems(p: Proposal) -> list[str]:
    return check(p, published=PUBLISHED, sources={"s9": SOURCE}, min_similarity=0.85)


def test_a_correction_must_be_backed_on_both_sides() -> None:
    assert problems(proposal()) == []
    assert "old number is not in the published text" in problems(proposal(old="۳۰"))
    assert any("new number not in the source" in p for p in problems(proposal(new="۴۰")))
    assert "evidence is not in the source" in problems(proposal(evidence="forty people died"))
    assert "unknown source s1" in problems(proposal(source_id="s1"))
    assert "old and new are the same" in problems(proposal(new="۲۰", evidence="20"))
    assert "old value is not in the published text" in problems(
        proposal(item="محل", old="میلان", new="جنوا", evidence="after a recount")
    )


def test_the_spec_sentence() -> None:
    assert correction_text("شمار مصدومان", "20", "25", "رویترز") == (
        "در نسخهٔ قبلی این خبر، شمار مصدومان به اشتباه ۲۰ اعلام شده بود. "
        "رقم صحیح طبق گزارش جدید رویترز ۲۵ است."
    )
    assert "مورد صحیح" in correction_text("محل", "میلان", "جنوا", "رویترز")
    assert render_correction("x").startswith("⚠️ <b>اصلاح خبر</b>\n")


# ------------------------------------------------------------------ the AI path


async def published_story(harness: Harness) -> Any:
    ai = setup(harness, epsilon=False)
    ai.drafts["Genoa"] = {
        "summary": "پل بزرگراه فرو ریخت و دست‌کم ۲۰ نفر مصدوم شدند.",
        "key_points": [],
    }
    await harness.run()
    serve(harness, delta=True, epsilon=True)
    harness.clock.advance(minutes=30)
    return ai


async def test_a_proposed_correction_waits_for_a_human_then_replies(harness: Harness) -> None:
    ai = await published_story(harness)
    ai.updates["viaduct"] = {
        "corrections": [
            {
                "item": "شمار مصدومان",
                "old": "۲۰",
                "new": "۲۵",
                "source_id": "$S0",
                "evidence": "local authorities put the number of injured at 25",
            }
        ]
    }
    await harness.run()
    [row] = [r[0] for r in await harness.rows(sa.select(Correction))]
    assert row.status == "proposed" and row.origin == "ai" and row.source_name == "Epsilon Times"
    card = next(t for t in harness.telegram.owner_messages() if t.startswith("⚠️ <b>پیشنهاد اصلاح"))
    assert "به اشتباه ۲۰ اعلام شده بود" in card and "Epsilon Times ۲۵" in card
    assert not [p for _, p in posts(harness) if "اصلاح خبر" in text_of(p)]  # not before a human
    harness.telegram.updates = [Updates().callback(f"cr:a:{row.id}")]
    harness.clock.advance(minutes=15)
    await harness.run()
    correction = next(p for _, p in posts(harness) if "اصلاح خبر" in text_of(p))
    assert text_of(correction).startswith("⚠️ <b>اصلاح خبر</b>\nدر نسخهٔ قبلی این خبر، شمار")
    [story] = await stories(harness)
    assert correction["reply_parameters"]["message_id"] == story.post_message_id
    row = (await harness.rows(sa.select(Correction)))[0][0]
    assert row.status == "published" and row.post_message_id is not None
    assert "correction_published" in [e["event"] for e in story.timeline]
    [sent] = [
        r[0]
        for r in await harness.rows(
            sa.select(PublishedPost).where(PublishedPost.kind == "correction")
        )
    ]
    assert sent.article_id is None and sent.idempotency_key.startswith(f"correction:{row.id}:")


async def test_an_unbacked_correction_never_reaches_a_human(harness: Harness) -> None:
    ai = await published_story(harness)
    ai.updates["viaduct"] = {
        "corrections": [
            {
                "item": "شمار مصدومان",
                "old": "۳۰",
                "new": "۲۵",
                "source_id": "$S0",
                "evidence": "local authorities put the number of injured at 25",
            }
        ]
    }
    await harness.run()
    [row] = [r[0] for r in await harness.rows(sa.select(Correction))]
    assert row.status == "invalid" and "old number is not in the published text" in row.problems
    assert not [t for t in harness.telegram.owner_messages() if "پیشنهاد اصلاح" in t]


async def test_an_admin_correction_and_a_rejection(harness: Harness) -> None:
    await published_story(harness)
    delta = await by_source(harness, "delta")
    updates = Updates()
    harness.telegram.updates = [
        updates.private(f"/correct {delta.id} | شمار مصدومان | ۲۰ | ۲۲ | پلیس جنوا"),
        updates.private("/correct oops"),
    ]
    serve(harness, delta=True, epsilon=False)
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert any(r.startswith("✅ پیشنهاد اصلاح #") for r in replies)
    assert any("قالب: /correct" in r for r in replies)
    [row] = [r[0] for r in await harness.rows(sa.select(Correction))]
    assert row.origin == "human" and row.status == "proposed"
    harness.telegram.updates = [updates.callback(f"cr:r:{row.id}")]
    harness.clock.advance(minutes=15)
    await harness.run()
    row = (await harness.rows(sa.select(Correction)))[0][0]
    assert row.status == "rejected"
    assert not [p for _, p in posts(harness) if "اصلاح خبر" in text_of(p)]


# ------------------------------------------------------------------ edits in the source channel


async def test_an_edited_source_post_is_edited_in_the_target(harness: Harness) -> None:
    harness.server.routes.clear()
    updates = Updates()
    original = updates.channel_post("خبر اول دربارهٔ بازار ارز امروز تهران")
    harness.telegram.updates = [original]
    await harness.run()
    [(_, sent)] = [(m, p) for m, p in harness.telegram.channel_posts() if m == "sendMessage"]
    message = original["channel_post"]
    edited = {
        **message,
        "text": "خبر اصلاح‌شده دربارهٔ بازار ارز امروز تهران\n🆔 @wanger_source",
        "edit_date": int(NOW.timestamp()) + 60,
    }
    updates.next_update += 1
    harness.telegram.updates = [{"update_id": updates.next_update, "edited_channel_post": edited}]
    harness.clock.advance(minutes=15)
    await harness.run()
    [edit] = [p for m, p in harness.telegram.calls if m == "editMessageText"]
    assert edit["chat_id"] == "@wanger_test" and edit["message_id"] == harness.telegram.next_id
    assert edit["text"] == "خبر اصلاح‌شده دربارهٔ بازار ارز امروز تهران\n\n🆔 @wanger_test"
    assert sent["text"].startswith("خبر اول")
