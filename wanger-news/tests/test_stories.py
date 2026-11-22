"""Phase 3 integration: stories (same event across outlets), independent sources, claims and
evidence, contradictions, update posts as replies, corroboration, detaching, human posts."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from wanger_news.db.tables import Article, Claim, Evidence, PublishedPost, StoryCluster
from wanger_news.domain.enums import ArticleStatus

from .conftest import Harness, Updates, make_config, source_entries
from .fake_ai import FakeAI

GENOA = [1.0] + [0.0] * 767  # one fixed embedding: every report mentioning Genoa is that event
DELTA_TEXT = (
    "A motorway bridge collapsed in Genoa on Tuesday, officials said, and at least "
    "20 people were injured."
)
EPSILON_TEXT = (
    "Rescue teams worked through the night in Genoa where a viaduct gave way; local "
    "authorities put the number of injured at 25."
)


def outlet(sid: str, name: str, group: str, rel: int, kind: str) -> dict[str, Any]:
    return {
        "id": sid,
        "name": name,
        "language": "en",
        "category": "world",
        "country": "IT",
        "source_type": kind,
        "reliability_score": rel,
        "owner_group": group,
        "rss_url": f"https://{sid}.example/rss",
        "rate_limit": {"min_fetch_interval_minutes": 0},
    }


def rss(*items: tuple[str, str, str, str]) -> bytes:
    body = "".join(
        f"<item><title>{t}</title><link>{link}</link><guid>{link}</guid>"
        f"<description>{d}</description><pubDate>{when}</pubDate></item>"
        for t, d, link, when in items
    )
    return (
        f'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>{body}</channel></rss>'
    ).encode()


DELTA = (
    "Bridge collapses in Genoa, at least 20 injured",
    DELTA_TEXT,
    "https://delta.example/genoa",
    "Wed, 18 Nov 2026 11:00:00 GMT",
)
EPSILON = (
    "Genoa disaster: rescuers search rubble after viaduct failure",
    EPSILON_TEXT,
    "https://epsilon.example/genoa",
    "Wed, 18 Nov 2026 11:20:00 GMT",
)


def setup(h: Harness, *, delta: bool = True, epsilon: bool = True, **cfg: Any) -> FakeAI:
    h.config = make_config(
        [
            outlet("delta", "Delta Agency", "delta-group", 85, "news_agency"),
            outlet("epsilon", "Epsilon Times", "epsilon-group", 80, "newspaper"),
            source_entries()[3],  # the source channel
        ],
        **cfg,
    )
    h.server.routes.clear()
    serve(h, delta=delta, epsilon=epsilon)
    ai = FakeAI(vectors={"Genoa": GENOA})
    h.ai = ai
    return ai


def serve(h: Harness, *, delta: bool, epsilon: bool) -> None:
    h.server.add("https://delta.example/rss", rss(DELTA) if delta else rss())
    h.server.add("https://epsilon.example/rss", rss(EPSILON) if epsilon else rss())


async def by_source(h: Harness, source_id: str) -> Article:
    return next(a for a in await h.articles() if a.source_id == source_id)


async def stories(h: Harness) -> list[StoryCluster]:
    return [r[0] for r in await h.rows(sa.select(StoryCluster).order_by(StoryCluster.id))]


def posts(h: Harness) -> list[tuple[str, dict[str, Any]]]:
    return h.telegram.channel_posts()


def text_of(payload: dict[str, Any]) -> str:
    return str(payload.get("text") or payload.get("caption") or "")


# ------------------------------------------------------------------ one story, several sources


async def test_two_outlets_one_story_one_post_with_both_sources(harness: Harness) -> None:
    ai = setup(harness)
    await harness.run()
    [story] = await stories(harness)
    delta, epsilon = await by_source(harness, "delta"), await by_source(harness, "epsilon")
    assert delta.cluster_id == epsilon.cluster_id == story.id
    assert (delta.cluster_role, epsilon.cluster_role) == ("lead", "support")
    assert epsilon.status == ArticleStatus.MERGED and delta.status == ArticleStatus.PUBLISHED
    assert story.independent_sources == 2 and story.published_at is not None
    summarize = [ids for op, ids in ai.calls if op == "summarize"]
    assert summarize == [[f"a{delta.id}"]]  # ONE summary of the story
    [(_, post)] = posts(harness)
    text = text_of(post)
    assert "📰 منابع: Delta Agency، Epsilon Times" in text
    assert "فقط بر اساس گزارش" not in text  # not a single-source story
    assert delta.confidence_score is not None and delta.confidence_score > 69
    assert "📌 وضعیت: احتمال بالا" in text or "📌 وضعیت: تأییدشده" in text
    claims = [r[0] for r in await harness.rows(sa.select(Claim))]
    assert [c.status for c in claims] == ["confirmed"]  # stated by two independent origins
    assert sorted(claims[0].source_article_ids) == sorted([delta.id, epsilon.id])
    evidence = [r[0] for r in await harness.rows(sa.select(Evidence))]
    assert {e.article_id for e in evidence} == {delta.id, epsilon.id}
    events = [e["event"] for e in story.timeline]
    assert events[:3] == ["created", "joined", "summarized"] and "published" in events


async def test_a_wire_copy_is_one_source(harness: Harness) -> None:
    setup(harness)
    # the same wire story under a slightly different headline, with one line added
    copy = (
        "Genoa bridge collapses, at least 20 injured",
        DELTA_TEXT + " Rescue work continues.",
        EPSILON[2],
        EPSILON[3],
    )
    harness.server.add("https://epsilon.example/rss", rss(copy))
    await harness.run()
    [story] = await stories(harness)
    assert story.independent_sources == 1
    [(_, post)] = posts(harness)
    assert "فقط بر اساس گزارش Delta Agency" in text_of(post)
    delta = await by_source(harness, "delta")
    assert delta.confidence_score == 69  # single-source cap


async def test_an_excluded_source_leaves_the_story(harness: Harness) -> None:
    ai = setup(harness)
    ai.drafts["Genoa"] = {"excluded_sources": ["$S1"]}
    await harness.run()
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.status == ArticleStatus.AI_PENDING and epsilon.cluster_role == "lead"
    assert len(await stories(harness)) == 2
    [(_, post)] = posts(harness)
    assert "Epsilon Times" not in text_of(post)


# ------------------------------------------------------------------ contradictions


async def test_contradicting_sources_are_reported_side_by_side_after_review(
    harness: Harness,
) -> None:
    ai = setup(harness)
    ai.drafts["Genoa"] = {
        "contradictions": [
            {
                "topic": "شمار مصدومان",
                "versions": [
                    {
                        "source_id": "$S0",
                        "statement": "شمار مصدومان را ۲۰ نفر اعلام کرده",
                        "evidence": "at least 20 people were injured",
                    },
                    {
                        "source_id": "$S1",
                        "statement": "رقم ۲۵ نفر را گزارش کرده",
                        "evidence": "local authorities put the number of injured at 25",
                    },
                ],
            }
        ]
    }
    await harness.run()
    delta = await by_source(harness, "delta")
    assert delta.status == ArticleStatus.PENDING_REVIEW
    assert delta.review_reason == "conflicting_reports"
    assert posts(harness) == []
    conflicting = [
        r[0] for r in await harness.rows(sa.select(Claim).where(Claim.status == "conflicting"))
    ]
    assert len(conflicting) == 1 and len(conflicting[0].versions or []) == 2
    card = next(p for p in harness.telegram.owner_messages() if p.startswith("🧐"))
    assert "تناقض" in card and "متناقض" in card
    harness.telegram.updates = [Updates().callback(f"rv:a:{delta.id}")]
    await harness.run()
    [(_, post)] = posts(harness)
    text = text_of(post)
    assert (
        "⚖️ گزارش‌ها دربارهٔ شمار مصدومان متفاوت است؛ Delta Agency شمار مصدومان را ۲۰ نفر "
        "اعلام کرده، در حالی که Epsilon Times رقم ۲۵ نفر را گزارش کرده."
    ) in text
    assert "📌 وضعیت: متناقض" in text
    assert (delta.confidence_score or 100) <= 69


async def test_a_contradiction_with_an_invented_number_fails_the_guard(harness: Harness) -> None:
    ai = setup(harness)
    bad = {
        "contradictions": [
            {
                "topic": "شمار مصدومان",
                "versions": [
                    {
                        "source_id": "$S0",
                        "statement": "۴۰ نفر",
                        "evidence": "at least 20 people were injured",
                    },
                    {
                        "source_id": "$S1",
                        "statement": "۲۵ نفر",
                        "evidence": "put the number of injured at 25",
                    },
                ],
            }
        ]
    }
    ai.drafts["Genoa"] = bad
    ai.rewrites["Genoa"] = bad
    await harness.run()
    delta = await by_source(harness, "delta")
    assert delta.status == ArticleStatus.PENDING_REVIEW and delta.review_reason == "guard_failed"


# ------------------------------------------------------------------ updates


async def publish_delta_first(harness: Harness) -> FakeAI:
    ai = setup(harness, epsilon=False)
    await harness.run()
    assert len(posts(harness)) == 1
    serve(harness, delta=True, epsilon=True)
    harness.clock.advance(minutes=30)
    return ai


async def test_a_new_independent_report_becomes_an_update_reply(harness: Harness) -> None:
    ai = await publish_delta_first(harness)
    first_id = harness.telegram.next_id
    await harness.run()
    assert "update" in ai.operations()
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.cluster_role == "update" and epsilon.status == ArticleStatus.PUBLISHED
    _, update = posts(harness)[-1]
    assert update["reply_parameters"] == {
        "message_id": first_id,
        "allow_sending_without_reply": True,
    }
    text = text_of(update)
    assert "🔄 <b>به‌روزرسانی:</b>" in text and "📰 منابع تازه: Epsilon Times" in text
    [story] = await stories(harness)
    assert story.post_message_id == harness.telegram.next_id and story.independent_sources == 2
    assert [e["event"] for e in story.timeline][-1] == "update_published"
    row = (
        await harness.rows(sa.select(PublishedPost).where(PublishedPost.article_id == epsilon.id))
    )[0][0]
    assert row.kind == "update" and row.reply_to_message_id == first_id


async def test_nothing_new_is_a_corroboration_without_a_post(harness: Harness) -> None:
    ai = await publish_delta_first(harness)
    ai.updates["viaduct"] = {"has_new_information": False}
    await harness.run()
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.status == ArticleStatus.MERGED and epsilon.cluster_role == "corroboration"
    assert len(posts(harness)) == 1
    [story] = await stories(harness)
    assert story.independent_sources == 2
    assert "corroborated" in [e["event"] for e in story.timeline]


async def test_a_different_event_is_detached_and_published_on_its_own(harness: Harness) -> None:
    ai = await publish_delta_first(harness)
    ai.updates["viaduct"] = {"same_event": False}
    await harness.run()
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.cluster_role == "lead" and len(await stories(harness)) == 2
    harness.clock.advance(minutes=15)
    await harness.run()
    assert len(posts(harness)) == 2
    assert "reply_parameters" not in posts(harness)[-1][1]


async def test_waiting_update_takes_over_when_the_lead_is_rejected(harness: Harness) -> None:
    setup(harness, epsilon=False, mode="semi")
    await harness.run()
    delta = await by_source(harness, "delta")
    serve(harness, delta=True, epsilon=True)
    harness.clock.advance(minutes=30)
    await harness.run()  # epsilon waits: the story is summarised but not out
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.cluster_role == "update" and epsilon.status == ArticleStatus.AI_PENDING
    harness.telegram.updates = [Updates().callback(f"rv:r:{delta.id}")]
    harness.clock.advance(minutes=15)
    await harness.run()
    harness.clock.advance(minutes=15)
    await harness.run()
    epsilon = await by_source(harness, "epsilon")
    assert epsilon.cluster_role == "lead" and epsilon.status == ArticleStatus.PENDING_REVIEW


# ------------------------------------------------------------------ human posts and fallbacks


async def test_a_source_channel_post_about_a_published_story_is_still_copied(
    harness: Harness,
) -> None:
    await publish_delta_first(harness)
    serve(harness, delta=True, epsilon=False)
    harness.telegram.updates = [
        Updates().channel_post(
            "خبر ما دربارهٔ Genoa و فروریختن پل با جزئیات بیشتر از خبرنگار خودمان"
        )
    ]
    await harness.run()
    relayed = [p for m, p in posts(harness) if m == "sendMessage" and "parse_mode" not in p]
    assert len(relayed) == 1 and relayed[0]["text"].endswith("🆔 @wanger_test")
    human = next(a for a in await harness.articles() if a.source_id == "source-channel")
    assert human.cluster_role == "human" and len(await stories(harness)) == 1


def hand_post(updates: Updates) -> dict[str, Any]:
    """A post the admins made by hand in the channel the bot publishes to (the test channel)."""
    return updates.channel_post(
        "پل بزرگ Genoa فرو ریخت و تیم‌های امداد در محل هستند",
        chat_id=-1002222222222,
        username="wanger_test",
    )


async def test_a_hand_made_post_takes_over_an_unpublished_story(harness: Harness) -> None:
    ai = setup(harness, epsilon=False, story={"settle_minutes": 15})
    ai.updates["Genoa"] = {"has_new_information": False}
    updates = Updates()
    harness.telegram.updates = [hand_post(updates)]
    await harness.run()
    [story] = await stories(harness)
    assert story.published_at is not None and story.post_message_id == updates.next_message
    delta = await by_source(harness, "delta")
    assert "summarize" not in ai.operations() and "update" in ai.operations()
    assert delta.cluster_role == "corroboration" and delta.status == ArticleStatus.MERGED
    assert posts(harness) == []  # nothing beyond what was posted by hand


async def test_an_update_replies_to_the_hand_made_post(harness: Harness) -> None:
    setup(harness, epsilon=False)
    updates = Updates()
    harness.telegram.updates = [hand_post(updates)]
    await harness.run()
    delta = await by_source(harness, "delta")
    assert delta.cluster_role == "update" and delta.status == ArticleStatus.PUBLISHED
    [(_, post)] = posts(harness)
    assert post["reply_parameters"]["message_id"] == updates.next_message
    assert "🔄 <b>به‌روزرسانی:</b>" in text_of(post)


async def test_without_a_provider_every_report_is_its_own_story(harness: Harness) -> None:
    setup(harness)
    harness.ai = None
    summary = await harness.run()
    assert any(k.startswith("stories_skipped:") for k in summary.counters)
    assert len(await stories(harness)) == 2
    assert all(s.centroid is None for s in await stories(harness))


async def test_a_story_waits_to_settle_unless_urgent(harness: Harness) -> None:
    ai = setup(harness, story={"settle_minutes": 15})
    summary = await harness.run()
    assert "summarize" not in ai.operations() and summary.counters["ai_waiting"] == 1
    harness.clock.advance(minutes=16)
    await harness.run()
    assert "summarize" in ai.operations() and len(posts(harness)) == 1
