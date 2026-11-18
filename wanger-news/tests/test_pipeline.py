"""Integration: RSS → Article → Telegram (FakeTelegram), on an in-memory database."""

from __future__ import annotations

import httpx
import sqlalchemy as sa

from wanger_news.db.tables import Article, PublishedPost, SourceHealth, SystemLog
from wanger_news.domain.enums import ArticleStatus, PostStatus, RunStatus

from .conftest import (
    MAIN_CHANNEL,
    OWNER,
    TEST_CHANNEL,
    Harness,
    feed,
    make_config,
    not_sent,
    source_entries,
    uncertain,
)


async def status_of(h: Harness, title_start: str) -> str:
    for article in await h.articles():
        if article.title_original.startswith(title_start):
            return article.status
    raise AssertionError(f"no article {title_start!r}")


async def test_rss_to_telegram_end_to_end(harness: Harness) -> None:
    summary = await harness.run()
    assert summary.status is RunStatus.OK, summary.errors

    posts = harness.telegram.channel_posts()
    assert posts, "something must be published"
    assert all(p["chat_id"] == "@wanger_test" for _, p in posts)  # test channel only
    texts = [p.get("text") or p.get("caption") for _, p in posts]
    assert all("📰 منبع:" in t and "منبع اصلی" in t for t in texts)
    # the economy story has a feed image → sendPhoto with a caption
    photo = [p for m, p in posts if m == "sendPhoto"]
    assert photo and photo[0]["photo"] == "https://img.alpha.example/economy.jpg"
    assert "Central bank raises" in photo[0]["caption"]
    assert photo[0]["parse_mode"] == "HTML"
    assert "utm_" not in photo[0]["caption"]

    assert await status_of(harness, "An old story") == ArticleStatus.STALE
    assert await status_of(harness, "Horoscope") == ArticleStatus.FILTERED
    assert await status_of(harness, "Troops advance") == ArticleStatus.PENDING_REVIEW  # sensitive
    assert await status_of(harness, "Central bank raises") == ArticleStatus.PUBLISHED


async def test_second_run_publishes_nothing_twice(harness: Harness) -> None:
    await harness.run()
    first = len(harness.telegram.channel_posts())
    harness.clock.advance(minutes=20)
    await harness.run()
    assert len(harness.telegram.channel_posts()) == first
    keys = await harness.rows(sa.select(PublishedPost.idempotency_key))
    assert len(keys) == len({k for (k,) in keys}) == first


async def test_near_duplicate_from_another_source_is_published_once(harness: Harness) -> None:
    await harness.run()
    central = [a for a in await harness.articles() if a.title_original.startswith("Central bank")]
    assert len(central) == 2
    statuses = sorted(a.status for a in central)
    assert statuses == [ArticleStatus.DUPLICATE, ArticleStatus.PUBLISHED]
    dup = next(a for a in central if a.status == ArticleStatus.DUPLICATE)
    assert dup.dedup_level == "near" and dup.duplicate_of_id is not None


async def test_exact_url_duplicate_across_sources(harness: Harness) -> None:
    copy = feed("rss2.xml").replace(b"alpha-123", b"other-guid")  # same link, new guid
    harness.config = make_config(
        source_entries(
            {
                "id": "delta",
                "name": "Delta",
                "language": "en",
                "category": "world",
                "source_type": "newspaper",
                "reliability_score": 60,
                "rss_url": "https://delta.example/rss",
            }
        )
    )
    harness.server.add("https://delta.example/rss", copy)
    await harness.run()
    delta = [a for a in await harness.articles() if a.source_id == "delta"]
    economy = next(a for a in delta if a.external_id == "other-guid")
    assert economy.status == ArticleStatus.DUPLICATE and economy.dedup_level == "exact"


async def test_failing_sources_do_not_stop_the_others(harness: Harness) -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("no route", request=request)

    harness.config = make_config(
        source_entries(
            *[
                {
                    "id": sid,
                    "name": sid,
                    "language": "en",
                    "category": "world",
                    "source_type": "newspaper",
                    "reliability_score": 50,
                    "rss_url": f"https://{sid}.example/rss",
                }
                for sid in ("down", "html", "slow", "broken", "empty")
            ]
        )
    )
    harness.server.add("https://down.example/rss", b"oops", status=500)
    harness.server.add(
        "https://html.example/rss", feed("not_a_feed.html"), headers={"content-type": "text/html"}
    )
    harness.server.routes["https://slow.example/rss"] = timeout
    harness.server.add("https://broken.example/rss", feed("broken.xml"))
    harness.server.add("https://empty.example/rss", b"")

    summary = await harness.run()
    assert summary.status is RunStatus.PARTIAL
    assert summary.sources["alpha"]["ok"] and summary.sources["beta"]["ok"]
    for bad in ("down", "html", "slow", "empty"):
        assert summary.sources[bad]["ok"] is False, bad
    assert summary.sources["broken"]["ok"]  # malformed but usable
    # stored and classified (culture's base priority 40 is below the gate: filtered)
    assert await status_of(harness, "Museum returns") == ArticleStatus.FILTERED
    assert harness.telegram.channel_posts()
    health = {h.source_id: h for (h,) in await harness.rows(sa.select(SourceHealth))}
    assert health["down"].consecutive_failures == 1 and "HTTP 500" in (
        health["down"].last_error or ""
    )
    assert health["alpha"].state == "closed"
    logged = await harness.rows(sa.select(SystemLog.event))
    assert ("source_failed",) in logged


async def test_circuit_breaker_opens_and_recovers(harness: Harness) -> None:
    harness.config = make_config(
        source_entries(
            {
                "id": "down",
                "name": "Down",
                "language": "en",
                "category": "world",
                "source_type": "newspaper",
                "reliability_score": 50,
                "rss_url": "https://down.example/rss",
                "rate_limit": {"min_fetch_interval_minutes": 0},
            }
        ),
        circuit_breaker={"failure_threshold": 2, "cooldown_minutes": 30},
    )
    harness.server.add("https://down.example/rss", b"", status=503)
    for _ in range(2):
        await harness.run()
        harness.clock.advance(minutes=1)
    summary = await harness.run()
    assert summary.sources["down"] == {"skipped": "circuit_open"}
    harness.clock.advance(minutes=31)
    harness.server.add(
        "https://down.example/rss",
        feed("rdf.xml").replace(b"gamma.example/a/1", b"down.example/a/1"),
    )
    summary = await harness.run()
    assert summary.sources["down"]["ok"]  # half-open probe succeeded → closed again


async def test_unknown_send_outcome_is_never_retried(harness: Harness) -> None:
    harness.telegram.fail("sendPhoto", uncertain())
    await harness.run()
    economy = next(
        a
        for a in await harness.articles()
        if a.title_original.startswith("Central") and a.source_id == "alpha"
    )
    assert economy.status == ArticleStatus.UNCERTAIN
    assert any("نامشخص" in text for text in harness.telegram.owner_messages())
    before = len(harness.telegram.sent("sendPhoto"))
    harness.clock.advance(minutes=20)
    await harness.run()
    assert len(harness.telegram.sent("sendPhoto")) == before


async def test_claim_left_by_a_crashed_run_becomes_uncertain(harness: Harness) -> None:
    await harness.run(telegram=False)  # collect and queue only (no bot)
    queued = [a for a in await harness.articles() if a.status == ArticleStatus.QUEUED]
    victim = queued[0]
    from sqlalchemy.ext.asyncio import AsyncSession

    from wanger_news.db.repositories import Repositories
    from wanger_news.domain.enums import ChannelRole
    from wanger_news.services.context import Target
    from wanger_news.services.publish import idempotency_key

    async with AsyncSession(harness.engine, expire_on_commit=False) as session:
        repos = Repositories(session)
        await repos.posts.claim(
            key=idempotency_key(victim.id, Target(ChannelRole.TEST, TEST_CHANNEL)),
            article_id=victim.id,
            role=ChannelRole.TEST,
            chat_id="@wanger_test",
            method="send",
            run_id="crashed-run",
            now=harness.clock.now(),
            max_attempts=3,
        )
        await repos.commit()
    harness.clock.advance(minutes=30)
    await harness.run()
    post = (
        await harness.rows(sa.select(PublishedPost).where(PublishedPost.article_id == victim.id))
    )[0][0]
    assert post.status == PostStatus.UNCERTAIN
    sent_titles = [p.get("text") or p.get("caption") for _, p in harness.telegram.channel_posts()]
    assert not any(victim.title_original in (t or "") for t in sent_titles)


async def test_dry_run_sends_nothing_and_changes_nothing(harness: Harness) -> None:
    summary = await harness.run(dry_run=True)
    assert summary.counters["posts_previewed"] > 0
    assert harness.telegram.channel_posts() == []
    assert any("[dry-run]" in line for line in harness.output)
    assert await harness.scalar(sa.select(sa.func.count()).select_from(Article)) == 0
    # and the real run afterwards still publishes everything
    await harness.run()
    assert harness.telegram.channel_posts()


async def test_max_posts_per_run_and_priority_order(harness: Harness) -> None:
    await harness.run(max_posts=1)
    posts = harness.telegram.channel_posts()
    assert len(posts) == 1
    assert "Central bank" in (posts[0][1].get("caption") or "")  # priority 80 goes first


async def test_photo_that_telegram_cannot_fetch_falls_back_to_text(harness: Harness) -> None:
    harness.telegram.fail(
        "sendPhoto", not_sent(400, "Bad Request: wrong file identifier/HTTP URL specified")
    )
    await harness.run()
    texts = [p["text"] for p in harness.telegram.sent("sendMessage") if p["chat_id"] != OWNER]
    assert any("Central bank raises" in t and "🖼" not in t for t in texts)
    assert await status_of(harness, "Central bank raises") == ArticleStatus.PUBLISHED


async def test_channel_level_error_stops_without_burning_attempts(harness: Harness) -> None:
    harness.telegram.fail(
        "sendPhoto", not_sent(403, "Forbidden: bot is not a member of the channel chat")
    )
    summary = await harness.run()
    assert len(harness.telegram.channel_posts()) == 1  # only the failed try
    assert any("انتشار متوقف شد" in t for t in harness.telegram.owner_messages())
    assert any("publish" in e for e in summary.errors)
    economy = await status_of(harness, "Central bank raises")
    assert economy == ArticleStatus.QUEUED  # will be retried once the bot is admin again
    post = (await harness.rows(sa.select(PublishedPost)))[0][0]
    assert post.status == PostStatus.FAILED and post.attempts == 0
    harness.clock.advance(minutes=20)
    await harness.run()
    assert await status_of(harness, "Central bank raises") == ArticleStatus.PUBLISHED


async def test_queued_items_expire_instead_of_being_posted_late(harness: Harness) -> None:
    await harness.run(telegram=False)
    harness.clock.advance(hours=30)
    harness.server.routes.clear()  # nothing new arrives
    await harness.run()
    assert harness.telegram.channel_posts() == []
    assert await status_of(harness, "Central bank raises") == ArticleStatus.EXPIRED


async def test_burst_from_one_source_is_throttled(harness: Harness) -> None:
    harness.config = make_config(
        source_entries(
            {
                "id": "burst",
                "name": "Burst",
                "language": "en",
                "category": "world",
                "source_type": "blog",
                "reliability_score": 40,
                "rss_url": "https://burst.example/rss",
                "rate_limit": {"max_new_items_per_hour": 2},
            }
        )
    )
    items = "".join(
        f"<item><title>Burst story number {i} about the economy</title>"
        f"<link>https://burst.example/{i}</link><guid>b{i}</guid>"
        f"<description>Story {i} " + "different words " * i + "</description>"
        f"<pubDate>Wed, 18 Nov 2026 11:{i:02d}:00 GMT</pubDate></item>"
        for i in range(6)
    )
    harness.server.add(
        "https://burst.example/rss",
        f'<?xml version="1.0"?><rss version="2.0"><channel><title>B</title>{items}'
        "</channel></rss>".encode(),
    )
    summary = await harness.run(telegram=False)
    assert summary.sources["burst"]["throttled"] == 4


async def test_concurrent_run_is_skipped_by_the_lock(harness: Harness) -> None:
    from sqlalchemy.ext.asyncio import AsyncSession

    from wanger_news.db.repositories import Repositories

    async with AsyncSession(harness.engine) as session:
        repos = Repositories(session)
        from datetime import timedelta

        assert await repos.locks.acquire(
            "pipeline", "other-run", harness.clock.now(), timedelta(minutes=15)
        )
        await repos.commit()
    summary = await harness.run()
    assert summary.status is RunStatus.SKIPPED_LOCKED
    assert harness.telegram.calls == []
    harness.clock.advance(minutes=16)  # the other holder's lease expired
    assert (await harness.run()).status is not RunStatus.SKIPPED_LOCKED


async def test_main_channel_is_never_used_in_phase_one(harness: Harness) -> None:
    harness.observed = [TEST_CHANNEL, MAIN_CHANNEL]
    await harness.run()
    chats = {p["chat_id"] for _, p in harness.telegram.channel_posts()}
    assert chats == {"@wanger_test"}


async def test_no_target_channel_means_queue_only(harness: Harness) -> None:
    harness.target = None
    summary = await harness.run()
    assert harness.telegram.channel_posts() == []
    assert summary.counters.get("publish_skipped:no target channel configured") == 1
    assert await status_of(harness, "Central bank raises") == ArticleStatus.QUEUED
