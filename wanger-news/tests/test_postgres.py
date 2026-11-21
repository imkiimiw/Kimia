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
