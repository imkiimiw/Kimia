"""PostgreSQL-only checks (real concurrency, real savepoints, JSONB). Run with
WANGER_NEWS_TEST_POSTGRES_URL=postgresql://… (CI uses a postgres service); skipped otherwise."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news.db.base import Base
from wanger_news.db.engine import create_engine
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, PublishedPost
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ChannelRole
from wanger_news.services.context import Target

from .conftest import NOW, FakeClock, FakeTelegram, FeedServer, Harness, make_config, standard_feeds
from .fake_ai import FakeAI

URL = os.environ.get("WANGER_NEWS_TEST_POSTGRES_URL")
pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not URL, reason="WANGER_NEWS_TEST_POSTGRES_URL not set"),
]


@pytest.fixture
async def pg() -> AsyncIterator[AsyncEngine]:
    assert URL is not None
    engine = create_engine(URL)
    async with engine.begin() as conn:
        await conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture
async def pg_harness(pg: AsyncEngine) -> AsyncIterator[Harness]:
    server = FeedServer()
    standard_feeds(server)
    async with server.client() as http:
        yield Harness(
            engine=pg,
            config=make_config(),
            clock=FakeClock(),
            server=server,
            telegram=FakeTelegram(),
            http=http,
            target=Target(ChannelRole.TEST, ChatRef.parse("@wanger_test")),
            output=[],
            observed=[ChatRef.parse("@wanger_test")],
            ai=FakeAI(),
        )


async def test_only_one_of_many_concurrent_lock_attempts_wins(pg: AsyncEngine) -> None:
    async def attempt(i: int) -> bool:
        async with AsyncSession(pg) as session:
            ok = await Repositories(session).locks.acquire(
                "pipeline", f"run-{i}", NOW, timedelta(minutes=15)
            )
            await session.commit()
            return ok

    results = await asyncio.gather(*(attempt(i) for i in range(8)))
    assert sum(results) == 1


async def test_only_one_of_many_concurrent_claims_wins(pg: AsyncEngine) -> None:
    async def claim(i: int) -> bool:
        async with AsyncSession(pg) as session:
            post = await Repositories(session).posts.claim(
                key="article:1:chat:@wanger_test",
                article_id=1,
                role=ChannelRole.TEST,
                chat_id="@wanger_test",
                method="send",
                run_id=f"run-{i}",
                now=NOW,
                max_attempts=3,
            )
            await session.commit()
            return post is not None

    results = await asyncio.gather(*(claim(i) for i in range(8)))
    assert sum(results) == 1


async def test_pipeline_on_postgres_is_idempotent(pg_harness: Harness) -> None:
    await pg_harness.run()
    first = len(pg_harness.telegram.channel_posts())
    assert first > 0
    pg_harness.clock.advance(minutes=20)
    await pg_harness.run()
    assert len(pg_harness.telegram.channel_posts()) == first
    async with AsyncSession(pg_harness.engine) as session:
        sent = await session.scalar(sa.select(sa.func.count()).select_from(PublishedPost))
    assert sent == first


async def test_dry_run_rolls_back_on_postgres(pg_harness: Harness) -> None:
    summary = await pg_harness.run(dry_run=True)
    assert summary.counters["posts_previewed"] > 0
    async with AsyncSession(pg_harness.engine) as session:
        assert await session.scalar(sa.select(sa.func.count()).select_from(Article)) == 0


async def test_stories_on_postgres_use_pgvector(pg_harness: Harness) -> None:
    """Embeddings round-trip through the pgvector column; two outlets → one story."""
    from wanger_news.db.tables import StoryCluster

    from .test_stories import setup

    setup(pg_harness)
    await pg_harness.run()
    async with AsyncSession(pg_harness.engine) as session:
        column_type = await session.scalar(
            sa.text(
                "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
                "WHERE attrelid = 'story_clusters'::regclass AND attname = 'centroid'"
            )
        )
        stories = list((await session.scalars(sa.select(StoryCluster))).all())
        article = await session.scalar(sa.select(Article).where(Article.source_id == "delta"))
    assert column_type == "vector"
    assert len(stories) == 1 and stories[0].independent_sources == 2
    assert stories[0].centroid is not None and stories[0].centroid[0] == pytest.approx(1.0)
    assert article is not None and article.embedding is not None and len(article.embedding) == 768
    assert len(pg_harness.telegram.channel_posts()) == 1


async def test_trends_and_daily_brief_on_postgres(pg_harness: Harness) -> None:
    """The Phase 4 queries (trend rows, breaking cap, published stories, brief claim)."""
    from .test_realtime import five_outlets_on_one_event, posts, text_of

    await five_outlets_on_one_event(pg_harness, daily_brief={"min_items": 1})
    summary = await pg_harness.run()
    assert summary.counters["trends_alerted"] == 1
    pg_harness.clock.advance(hours=5, minutes=35)  # 21:05 Tehran
    summary = await pg_harness.run()
    assert summary.counters["brief:sent"] == 1
    assert text_of(posts(pg_harness)[-1]).startswith("🗞 <b>خلاصهٔ خبرهای امروز</b>")
    pg_harness.clock.advance(minutes=15)
    assert (await pg_harness.run()).counters["brief:done"] == 1
