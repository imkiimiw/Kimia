"""Phase 4 integration: 🔴 breaking, early warning (trends), related stories, story timeline in
update posts, the daily brief and the new admin commands."""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa

from wanger_news.db.tables import PublishedPost, StoryCluster, TrendAlert

from .conftest import OWNER, Harness, Updates, make_config, source_entries
from .fake_ai import FakeAI

DIMS = 768


def unit(i: int, j: int | None = None, cos: float = 1.0) -> list[float]:
    """A unit vector on axis i, or tilted towards axis j so its cosine with axis i is ``cos``."""
    v = [0.0] * DIMS
    v[i] = cos
    if j is not None:
        v[j] = (1 - cos**2) ** 0.5
    return v


def outlet(sid: str) -> dict[str, Any]:
    return {
        "id": f"{sid}{sid}",
        "name": f"{sid.upper()} News",
        "language": "en",
        "category": "world",
        "country": "GB",
        "source_type": "newspaper",
        "reliability_score": 80,
        "owner_group": f"{sid}-group",
        "rss_url": f"https://{sid}.example/rss",
        "rate_limit": {"min_fetch_interval_minutes": 0},
    }


def rss(*items: tuple[str, str, str]) -> bytes:
    """(title, text, minute of 11:MM on 18 Nov 2026) per item."""
    body = "".join(
        f"<item><title>{t}</title><link>https://x.example/{abs(hash(t))}</link>"
        f"<guid>https://x.example/{abs(hash(t))}</guid><description>{d}</description>"
        f"<pubDate>Wed, 18 Nov 2026 11:{m} GMT</pubDate></item>"
        for t, d, m in items
    )
    return (
        f'<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>{body}</channel></rss>'
    ).encode()


def setup(h: Harness, ids: str, *, vectors: dict[str, list[float]], **cfg: Any) -> FakeAI:
    h.config = make_config([outlet(i) for i in ids] + [source_entries()[3]], **cfg)
    h.server.routes.clear()
    for i in ids:
        h.server.add(f"https://{i}.example/rss", rss())
    ai = FakeAI(vectors=vectors)
    h.ai = ai
    return ai


def feed(h: Harness, sid: str, title: str, text: str, minute: str = "30:00") -> None:
    h.server.add(f"https://{sid}.example/rss", rss((title, text, minute)))


def posts(h: Harness) -> list[dict[str, Any]]:
    return [p for _, p in h.telegram.channel_posts()]


def text_of(payload: dict[str, Any]) -> str:
    return str(payload.get("text") or payload.get("caption") or "")


async def stories(h: Harness) -> list[StoryCluster]:
    return [r[0] for r in await h.rows(sa.select(StoryCluster).order_by(StoryCluster.id))]


CHILE = (
    "Strong earthquake shakes central Chile",
    "A strong earthquake struck central Chile on Wednesday, damaging buildings in "
    "Santiago, officials said.",
)
JAPAN = (
    "Earthquake hits northern Japan coast",
    "An earthquake struck off northern Japan on Wednesday and rail services were halted, "
    "the weather agency said.",
)
KENYA = (
    "Kenya opens new rail line to Uganda border",
    "Kenya opened a new railway line on Wednesday linking Nairobi with the Uganda border, "
    "the transport ministry said.",
)
NORWAY = (
    "Norway raises fuel tax for shipping",
    "Norway will raise fuel taxes for coastal shipping from next year, the finance "
    "ministry said on Wednesday.",
)
PERU = (
    "Peru central bank holds interest rate",
    "The central bank of Peru kept its benchmark interest rate unchanged on Wednesday, "
    "citing slower inflation.",
)


# ------------------------------------------------------------------ breaking


async def test_a_crisis_is_published_as_breaking(harness: Harness) -> None:
    setup(harness, "a", vectors={"Chile": unit(0)})
    feed(harness, "a", *CHILE)
    await harness.run()
    [post] = posts(harness)
    assert text_of(post).startswith("🔴 <b>")
    [article] = [a for a in await harness.articles() if a.source_id == "aa"]
    assert article.breaking and article.breaking_reason == "priority:100"
    [story] = await stories(harness)
    assert story.breaking_at is not None
    assert "breaking" in [e["event"] for e in story.timeline]
    [row] = [r[0] for r in await harness.rows(sa.select(PublishedPost))]
    assert row.breaking is True


async def test_ordinary_news_is_not_breaking(harness: Harness) -> None:
    setup(harness, "a", vectors={"Kenya": unit(0)})
    feed(harness, "a", *KENYA)
    await harness.run()
    [post] = posts(harness)
    assert not text_of(post).startswith("🔴")
    [article] = [a for a in await harness.articles() if a.source_id == "aa"]
    assert not article.breaking and article.breaking_reason == "not_important"


async def test_only_so_many_breaking_posts_per_hour(harness: Harness) -> None:
    setup(harness, "ab", vectors={"Chile": unit(0), "Japan": unit(1)}, breaking={"max_per_hour": 1})
    feed(harness, "a", *CHILE)
    feed(harness, "b", *JAPAN)
    summary = await harness.run()
    texts = [text_of(p) for p in posts(harness)]
    assert len(texts) == 2 and sum(t.startswith("🔴") for t in texts) == 1
    assert summary.counters["breaking_capped"] == 1


async def test_breaking_review_cards_come_first_and_are_not_capped(harness: Harness) -> None:
    setup(
        harness,
        "abc",
        vectors={"Chile": unit(0), "Japan": unit(1), "Kenya": unit(2)},
        mode="semi",
        editorial={"review": {"max_cards_per_run": 1, "send_to": "owner"}},
    )
    feed(harness, "a", *CHILE)
    feed(harness, "b", *JAPAN)
    feed(harness, "c", *KENYA)
    await harness.run()
    cards = [t for t in harness.telegram.owner_messages() if t.startswith("🧐")]
    assert len(cards) == 2  # both breaking cards, the ordinary one waits for the next run
    assert all("🔴 <b>خبر فوری</b>" in c for c in cards)
    assert all("━━━━━━ پیش‌نمایش ━━━━━━\n🔴 <b>" in c for c in cards)


# ------------------------------------------------------------------ early warning


async def five_outlets_on_one_event(harness: Harness, **cfg: Any) -> None:
    setup(harness, "abcde", vectors={"Genoa": unit(0)}, **cfg)
    words = ["collapsed", "gave way", "fell", "broke apart", "came down"]
    for n, sid in enumerate("abcde"):
        feed(
            harness,
            sid,
            f"Genoa bridge {words[n]} report {sid}",
            f"A motorway bridge in Genoa {words[n]} on Wednesday, according to outlet {sid}.",
            f"{10 + n * 10}:00",
        )


async def test_many_outlets_on_one_new_event_raise_an_early_warning(harness: Harness) -> None:
    await five_outlets_on_one_event(harness)
    summary = await harness.run()
    assert summary.counters["trends_alerted"] == 1
    alerts = [t for t in harness.telegram.owner_messages() if t.startswith("⚠️ <b>موضوع")]
    assert len(alerts) == 1
    assert "در ۶۰ دقیقهٔ اخیر به شکل غیرعادی افزایش یافته است." in alerts[0]
    assert "📊 ۵ گزارش از ۵ منبع" in alerts[0]
    [row] = [r[0] for r in await harness.rows(sa.select(TrendAlert))]
    assert row.kind == "story" and row.reports == 5 and row.notified
    assert not [p for p in posts(harness) if "موضوع در حال رشد" in text_of(p)]  # admins only
    harness.clock.advance(minutes=10)
    summary = await harness.run()
    assert summary.counters["trends_cooling"] == 1  # no second alert for the same topic
    assert len(await harness.rows(sa.select(TrendAlert))) == 1


async def test_no_early_warning_without_enough_history(harness: Harness) -> None:
    await five_outlets_on_one_event(harness, trends={"min_history_hours": 6})
    summary = await harness.run()
    assert "trends_alerted" not in summary.counters
    assert not [t for t in harness.telegram.owner_messages() if t.startswith("⚠️ <b>موضوع")]


async def test_early_warning_in_the_channel_when_the_owner_wants_it(harness: Harness) -> None:
    await five_outlets_on_one_event(harness, trends={"post_to_channel": True})
    await harness.run()
    channel = [p for p in posts(harness) if "موضوع در حال رشد" in text_of(p)]
    assert len(channel) == 1
    [row] = [
        r[0]
        for r in await harness.rows(sa.select(PublishedPost).where(PublishedPost.kind == "trend"))
    ]
    assert row.article_id is None and row.status == "sent"


# ------------------------------------------------------------------ related and timeline


async def test_a_post_links_an_earlier_related_story(harness: Harness) -> None:
    setup(harness, "ab", vectors={"bridge": unit(0), "port": unit(0, 1, cos=0.8)})
    feed(harness, "a", "Genoa bridge collapses", "A motorway bridge in Genoa collapsed on Tuesday.")
    await harness.run()
    first_id = harness.telegram.next_id
    feed(
        harness,
        "b",
        "Genoa port reopens",
        "The port of Genoa reopened on Wednesday morning.",
        "45:00",
    )
    harness.clock.advance(minutes=30)
    await harness.run()
    second = text_of(posts(harness)[-1])
    assert f'🔗 <b>مرتبط:</b>\n• <a href="https://t.me/wanger_test/{first_id}">' in second
    first, later = await stories(harness)
    assert later.related and later.related[0]["story_id"] == first.id
    assert not first.related  # an unrelated earlier post gets no link back


async def test_the_second_update_lists_the_story_so_far(harness: Harness) -> None:
    setup(harness, "abc", vectors={"Genoa": unit(0)})
    reports = {
        "a": ("Genoa bridge collapses", "A motorway bridge in Genoa collapsed on Tuesday."),
        "b": ("Genoa rescue continues", "Rescue teams in Genoa searched the site overnight."),
        "c": ("Genoa inquiry opened", "Prosecutors in Genoa opened an inquiry on Wednesday."),
    }
    ids = []
    for n, sid in enumerate("abc"):
        feed(harness, sid, *reports[sid], f"{10 + n}:00")
        await harness.run()
        ids.append(harness.telegram.next_id)
        harness.clock.advance(minutes=30)
    texts = [text_of(p) for p in posts(harness)]
    assert len(texts) == 3
    assert "🧵" not in texts[1]  # one earlier post: the reply already shows it
    assert "🧵 <b>روند خبر:</b>" in texts[2]
    for message_id in ids[:2]:
        assert f'<a href="https://t.me/wanger_test/{message_id}">' in texts[2]


# ------------------------------------------------------------------ daily brief


async def three_stories(harness: Harness, **cfg: Any) -> None:
    setup(harness, "abc", vectors={"Kenya": unit(0), "Norway": unit(1), "Peru": unit(2)}, **cfg)
    for sid, item in zip("abc", (KENYA, NORWAY, PERU), strict=True):
        feed(harness, sid, *item)
    await harness.run()
    assert len(posts(harness)) == 3


async def test_the_daily_brief_goes_out_once_at_its_time(harness: Harness) -> None:
    await three_stories(harness)
    harness.clock.advance(hours=5, minutes=35)  # 17:35 UTC = 21:05 Tehran
    summary = await harness.run()
    assert summary.counters["brief:sent"] == 1
    brief = text_of(posts(harness)[-1])
    assert brief.startswith("🗞 <b>خلاصهٔ خبرهای امروز</b> — ۱۴۰۵/۰۸/۲۷")
    assert brief.count("📌") == 3 and brief.endswith("#خلاصه_روز")
    assert '<a href="https://t.me/wanger_test/' in brief
    [row] = [
        r[0]
        for r in await harness.rows(sa.select(PublishedPost).where(PublishedPost.kind == "brief"))
    ]
    assert row.article_id is None and row.idempotency_key == "brief:2026-11-18:chat:@wanger_test"
    harness.clock.advance(minutes=15)
    summary = await harness.run()
    assert summary.counters["brief:done"] == 1 and len(posts(harness)) == 4


async def test_no_brief_before_its_time_with_too_few_stories_or_when_too_late(
    harness: Harness,
) -> None:
    await three_stories(harness)
    assert not any(k.startswith("brief:") for k in (await harness.run()).counters)  # 15:30
    harness.config = make_config(
        harness.config.sources.model_dump()["sources"], daily_brief={"local_time": "08:00"}
    )
    assert (await harness.run()).counters["brief:missed"] == 1  # 7.5 h late: skip the day
    harness.config = make_config(
        harness.config.sources.model_dump()["sources"],
        daily_brief={"local_time": "15:00", "min_items": 4},
    )
    assert (await harness.run()).counters["brief:too_few"] == 1


async def test_a_dry_run_shows_the_brief_and_sends_nothing(harness: Harness) -> None:
    await three_stories(harness)
    harness.clock.advance(hours=5, minutes=35)
    await harness.run(dry_run=True)
    assert len(posts(harness)) == 3
    assert any("🗞 <b>خلاصهٔ خبرهای امروز</b>" in line for line in harness.output)


# ------------------------------------------------------------------ commands


async def test_trends_timeline_and_brief_commands(harness: Harness) -> None:
    await five_outlets_on_one_event(harness)
    await harness.run()
    lead = next(a for a in await harness.articles() if a.cluster_role == "lead")
    updates = Updates()
    harness.telegram.updates = [
        updates.private("/trends"),
        updates.private(f"/timeline {lead.id}"),
        updates.private("/brief"),
    ]
    harness.clock.advance(minutes=5)
    await harness.run()
    replies = harness.telegram.owner_messages()
    trends = next(t for t in replies if t.startswith("<b>📈 موضوع‌های در حال رشد"))
    assert "۵ گزارش از ۵ منبع" in trends and "هشدارهای ۲۴ ساعت اخیر" in trends
    timeline = next(t for t in replies if t.startswith("🧵 <b>روند خبر</b>"))
    assert "رویداد ثبت شد" in timeline and "منبع تازه" in timeline and "منتشر شد" in timeline
    assert "گزارش‌ها: ۵" in timeline  # five reports; near-identical texts = one origin
    brief = next(t for t in replies if "خلاصهٔ روز" in t or "خلاصهٔ خبرهای امروز" in t)
    assert "منتشر نمی‌شود" in brief or "هنوز خبر کافی" in brief
    assert all(m != OWNER for m in [p.get("chat_id") for p in posts(harness)])
