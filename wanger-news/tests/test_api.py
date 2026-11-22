"""Phase 5: the admin dashboard API (FastAPI), in-process through ASGI — no network."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession

pytest.importorskip("fastapi")

from wanger_news.api.app import ApiDeps, create_app
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Correction, ReliabilityHistory
from wanger_news.domain.enums import ArticleStatus

from .conftest import ADMIN, OWNER, Harness, make_config

TOKEN = "test-token-0123456789"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


async def client(h: Harness) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        ApiDeps(
            config=h.config,
            engine=h.engine,
            token=SecretStr(TOKEN),
            clock=h.clock,
            owner_id=OWNER,
            admin_ids=frozenset({OWNER, ADMIN}),
            bot=h.telegram,
            target=h.target,
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://api"
    ) as c:
        yield c


@pytest.fixture
async def api(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    harness.config = make_config(mode="semi")
    await harness.run()
    async for c in client(harness):
        yield c


def test_no_token_no_api(harness: Harness) -> None:
    with pytest.raises(ValueError, match="never runs without a token"):
        create_app(
            ApiDeps(
                config=harness.config,
                engine=harness.engine,
                token=SecretStr(""),
                clock=harness.clock,
                owner_id=OWNER,
                admin_ids=frozenset({OWNER}),
            )
        )


async def test_every_route_but_health_needs_the_token(api: httpx.AsyncClient) -> None:
    assert (await api.get("/health")).json()["ok"] is True
    assert (await api.get("/api/status")).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert (await api.get("/api/status", headers=bad)).status_code == 401
    status = (await api.get("/api/status", headers=AUTH)).json()
    assert status["paused"] is False and status["articles"]["pending_review"] >= 1


async def test_news_and_a_decision_through_the_review_code(
    api: httpx.AsyncClient, harness: Harness
) -> None:
    pending = (
        await api.get("/api/articles", params={"status": "pending_review"}, headers=AUTH)
    ).json()
    assert pending and all(a["status"] == "pending_review" for a in pending)
    first = pending[0]
    detail = (await api.get(f"/api/articles/{first['id']}", headers=AUTH)).json()
    assert detail["summary"]["title"] and "claims" in detail
    answer = (await api.post(f"/api/articles/{first['id']}/approve", headers=AUTH)).json()
    assert answer["result"]
    article = next(a for a in await harness.articles() if a.id == first["id"])
    assert article.status == ArticleStatus.QUEUED and article.approved_by == OWNER
    assert (await api.post(f"/api/articles/{first['id']}/delete", headers=AUTH)).status_code == 400
    assert (await api.get("/api/articles/999999", headers=AUTH)).status_code == 404


async def test_stories_sources_rules_and_analytics(api: httpx.AsyncClient) -> None:
    stories = (await api.get("/api/stories", headers=AUTH)).json()
    assert stories
    story = (await api.get(f"/api/stories/{stories[0]['id']}", headers=AUTH)).json()
    assert story["members"] and "timeline" in story
    sources = {s["id"]: s for s in (await api.get("/api/sources", headers=AUTH)).json()}
    assert sources["alpha"]["switchable"] is True
    off = (await api.post("/api/sources/alpha/toggle", headers=AUTH)).json()
    assert off == {"id": "alpha", "active": False, "from": "next run"}
    assert (await api.post("/api/sources/source-channel/toggle", headers=AUTH)).status_code == 400
    assert (await api.get("/api/rules", headers=AUTH)).json() == []
    assert (await api.post("/api/rules/none/toggle", headers=AUTH)).status_code == 404
    report = (await api.get("/api/analytics", params={"days": 7}, headers=AUTH)).json()
    assert report["ai_calls"] >= 1 and "articles_by_source" in report
    assert "current" in (await api.get("/api/trends", headers=AUTH)).json()


async def test_corrections_and_reliability_decisions(
    api: httpx.AsyncClient, harness: Harness
) -> None:
    async with AsyncSession(harness.engine, expire_on_commit=False) as session:
        repos = Repositories(session)
        correction = await repos.corrections.add(
            Correction(
                cluster_id=1,
                article_id=1,
                source_name="X",
                item="شمار",
                old_value="۲۰",
                new_value="۲۵",
                origin="human",
                status="proposed",
                problems=[],
                review_messages=[],
                created_at=harness.clock.now(),
            )
        )
        suggestion = await repos.reliability.add(
            ReliabilityHistory(
                source_id="alpha",
                old_score=80,
                new_score=74,
                signals={},
                explanation="x",
                status="suggested",
                created_at=harness.clock.now(),
            )
        )
        await repos.commit()
        ids: dict[str, Any] = {"c": correction.id, "r": suggestion.id}
    listed = (await api.get("/api/corrections", headers=AUTH)).json()
    assert listed[0]["text"].startswith("در نسخهٔ قبلی این خبر")
    ok = await api.post(f"/api/corrections/{ids['c']}/approve", headers=AUTH)
    assert ok.json()["result"] == "approved"
    assert (await api.post(f"/api/corrections/{ids['c']}/approve", headers=AUTH)).status_code == 409
    assert (await api.get("/api/reliability", headers=AUTH)).json()[0]["new"] == 74
    applied = (await api.post(f"/api/reliability/{ids['r']}/apply", headers=AUTH)).json()
    assert "۷۴" in applied["result"]
