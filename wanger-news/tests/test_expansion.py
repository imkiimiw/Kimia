"""Phase 6 integration: weekly report, search, editions (personalization + English), the
owner's edition commands, the mother bot link, the mobile API and the dashboard."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import sqlalchemy as sa
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncSession

from wanger_news.adapters.mother import (
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    HttpMotherBot,
    verify_signature,
)
from wanger_news.config.models import MotherBotConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import AIRun, PublishedPost, Summary, TelegramUpdate
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ChannelRole
from wanger_news.services.context import Target
from wanger_news.services.overrides import EDITIONS_KEY, Overrides, apply
from wanger_news.services.pipeline import RunOptions
from wanger_news.services.search import SearchService

from .conftest import ADMIN, OWNER, Harness, Updates
from .test_realtime import KENYA, NORWAY, PERU, feed, posts, setup, text_of, unit

MAIN = ChatRef.parse("@wanger_main")
VECTORS = {"Kenya": unit(0), "Norway": unit(1), "Peru": unit(2)}


async def publish_three(h: Harness, **cfg: Any) -> None:
    """Three single-source stories, published in one run (as test_realtime.three_stories)."""
    setup(h, "abc", vectors=VECTORS, **cfg)
    for sid, story in zip("abc", (KENYA, NORWAY, PERU), strict=True):
        feed(h, sid, *story)
    await h.run()


def chat_posts(h: Harness, chat: str) -> list[dict[str, Any]]:
    return [p for p in posts(h) if p.get("chat_id") == chat]


async def sent_rows(h: Harness, **where: Any) -> list[PublishedPost]:
    stmt = sa.select(PublishedPost).order_by(PublishedPost.id)
    for key, value in where.items():
        stmt = stmt.where(getattr(PublishedPost, key) == value)
    return [r[0] for r in await h.rows(stmt)]


def as_main(h: Harness) -> None:
    h.target = Target(ChannelRole.MAIN, MAIN)
    h.observed = [MAIN]


# ------------------------------------------------------------------ weekly report

WEEKLY_NOW = {"weekday": 2, "local_time": "15:00", "min_stories": 3}  # Wed 15:00 Tehran


async def test_the_weekly_report_goes_out_once_with_what_was_published(harness: Harness) -> None:
    await publish_three(harness, weekly_report=WEEKLY_NOW)
    weekly = [t for t in map(text_of, posts(harness)) if t.startswith("🗓")]
    assert len(weekly) == 1
    text = weekly[0]
    assert text.startswith("🗓 <b>گزارش هفتگی Wanger News</b>")
    assert "📰 خبرهای منتشرشده: ۳" in text and "⭐️ <b>مهم‌ترین رویدادهای هفته</b>" in text
    assert text.count('<a href="https://t.me/wanger_test/') == 3 and text.endswith("#گزارش_هفتگی")
    year, week, _ = harness.clock.now().isocalendar()
    [row] = await sent_rows(harness, kind="weekly")
    assert row.article_id is None
    assert row.idempotency_key == f"weekly:{year}-W{week:02d}:chat:@wanger_test"
    harness.clock.advance(minutes=15)
    await harness.run()
    assert len([t for t in map(text_of, posts(harness)) if t.startswith("🗓")]) == 1


async def test_no_weekly_report_before_its_day_too_late_or_with_too_little(
    harness: Harness,
) -> None:
    await publish_three(harness, weekly_report={"weekday": 4})  # Friday
    assert not any(t.startswith("🗓") for t in map(text_of, posts(harness)))
    setup(harness, "abc", vectors=VECTORS, weekly_report={"weekday": 2, "local_time": "01:00"})
    assert (await harness.run()).counters["weekly:missed"] == 1  # 14.5 h late
    setup(harness, "abc", vectors=VECTORS, weekly_report={**WEEKLY_NOW, "min_stories": 4})
    assert (await harness.run()).counters["weekly:too_few"] == 1


async def test_weekly_preview_and_search_commands(harness: Harness) -> None:
    await publish_three(harness, weekly_report={"min_stories": 3})  # Friday: not due today
    updates = Updates()
    harness.telegram.updates = [
        updates.private("/weekly"),
        updates.private("/search kenya RAIL"),
        updates.private("/search و در"),
    ]
    harness.clock.advance(minutes=5)
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert any(r.startswith("🗓 <b>گزارش هفتگی") and "پیش‌نمایش" in r for r in replies)
    found = next(r for r in replies if r.startswith("🔎 <b>جستجو:</b> kenya RAIL"))
    assert found.count("https://t.me/wanger_test/") == 1
    assert any("کلمه‌های خیلی رایج" in r for r in replies)
    assert not any(t.startswith("🗓") for t in map(text_of, posts(harness)))  # preview only


# ------------------------------------------------------------------ search


async def test_text_and_semantic_search_over_published_posts(harness: Harness) -> None:
    await publish_three(harness)
    service = SearchService(harness.config, harness.ai)
    async with AsyncSession(harness.engine, expire_on_commit=False) as session:
        repos = Repositories(session)
        now = harness.clock.now()
        text = await service.search(repos, now, "Kenya rail", chats=None, mode="text")
        assert [h.match for h in text.hits] == ["text"]
        assert text.hits[0].post_url and text.hits[0].post_url.startswith("https://t.me/")
        both = await service.search(repos, now, "Kenya Norway", chats=None, mode="text")
        assert both.hits == []  # every term must match
        other = await service.search(repos, now, "Kenya", chats=["@elsewhere"], mode="text")
        assert other.hits == []
        meaning = await service.search(repos, now, "Kenya", chats=None, mode="semantic")
        assert meaning.semantic == "used"
        assert [(h.match, h.score) for h in meaning.hits] == [("semantic", 1.0)]
        assert meaning.hits[0].article_id == text.hits[0].article_id
    [embed] = [
        r[0] for r in await harness.rows(sa.select(AIRun).where(AIRun.prompt_version == "search"))
    ]
    assert embed.operation == "embed" and embed.status == "ok"


async def test_semantic_search_without_ai_falls_back_to_text(harness: Harness) -> None:
    await publish_three(harness)
    service = SearchService(harness.config, None)
    async with AsyncSession(harness.engine, expire_on_commit=False) as session:
        result = await service.search(
            Repositories(session), harness.clock.now(), "Peru", chats=None
        )
    assert result.semantic == "unavailable" and len(result.hits) == 1


# ------------------------------------------------------------------ editions

PERSIAN_EDITION = {"id": "all-fa", "chat": "@wanger_ed"}  # every category (Peru is economy)


async def test_an_edition_gets_what_reached_the_main_channel_once(harness: Harness) -> None:
    as_main(harness)
    await publish_three(harness, editions={"editions": [PERSIAN_EDITION]})
    edition = chat_posts(harness, "@wanger_ed")
    main = chat_posts(harness, "@wanger_main")
    assert len(edition) == 3 and len(main) == 3
    assert [text_of(p) for p in edition] == [text_of(p) for p in main]  # same verified post
    rows = await sent_rows(harness, chat_id="@wanger_ed")
    assert {r.channel_role for r in rows} == {"edition"} and all(r.status == "sent" for r in rows)
    assert rows[0].idempotency_key == f"article:{rows[0].article_id}:chat:@wanger_ed"
    harness.clock.advance(minutes=15)
    summary = await harness.run()
    assert len(chat_posts(harness, "@wanger_ed")) == 3 and "editions_sent" not in summary.counters


async def test_editions_wait_while_the_bot_publishes_to_the_test_channel(
    harness: Harness,
) -> None:
    await publish_three(harness, editions={"editions": [PERSIAN_EDITION]})
    assert chat_posts(harness, "@wanger_ed") == []
    summary = await harness.run()
    assert summary.counters["editions_skipped:test_mode"] == 1
    setup(
        harness, "abc", vectors=VECTORS, editions={"follow": "any", "editions": [PERSIAN_EDITION]}
    )
    await harness.run()  # "any": the owner chose to copy from the test channel too
    assert len(chat_posts(harness, "@wanger_ed")) == 3


async def test_an_edition_filters_by_category_and_importance(harness: Harness) -> None:
    as_main(harness)
    tech = {"id": "tech", "chat": "@wanger_tech", "categories": ["technology"]}
    big = {"id": "big", "chat": "@wanger_big", "min_importance": 101 - 1}
    await publish_three(harness, editions={"editions": [tech, big]})
    assert chat_posts(harness, "@wanger_tech") == [] and chat_posts(harness, "@wanger_big") == []


async def test_the_english_edition_posts_only_guarded_translations(harness: Harness) -> None:
    as_main(harness)
    english = {"id": "en", "chat": "@wanger_en", "language": "en"}
    setup(harness, "abc", vectors=VECTORS, editions={"editions": [english]})
    assert harness.ai is not None
    harness.ai.localized = {"Kenya": {"summary": "Officials said 250 people were hurt."}}
    for sid, story in zip("abc", (KENYA, NORWAY, PERU), strict=True):
        feed(harness, sid, *story)
    summary = await harness.run()
    sent = chat_posts(harness, "@wanger_en")
    assert len(sent) == 2  # Kenya: the English text invented a number
    assert all("📌 Status:" in text_of(p) and "Original source" in text_of(p) for p in sent)
    assert summary.counters["edition_guard_rejected"] == 1
    rows = [r[0] for r in await harness.rows(sa.select(Summary).where(Summary.language == "en"))]
    assert sorted(r.valid for r in rows) == [False, True, True]
    rejected = next(r for r in rows if not r.valid)
    assert rejected.guard["issues"][0] == {"kind": "number_not_in_source", "detail": "250"}
    # one more try for the rejected item, then never again
    for _ in range(2):
        harness.clock.advance(minutes=15)
        await harness.run()
    assert harness.ai.operations().count("localize") == 4
    assert len(chat_posts(harness, "@wanger_en")) == 2


async def test_posts_in_an_edition_channel_are_never_source_posts(harness: Harness) -> None:
    setup(harness, "a", vectors=VECTORS, editions={"editions": [PERSIAN_EDITION]})
    updates = Updates()
    harness.telegram.updates = [
        updates.channel_post("یک پست دستی در کانال نسخه", chat_id=-1004444, username="wanger_ed")
    ]
    await harness.run()
    [outcome] = [r[0] for r in await harness.rows(sa.select(TelegramUpdate.outcome))]
    assert outcome == "ignored:edition_channel"
    assert not any("منبع تعریف نشده" in t for t in harness.telegram.owner_messages())


# ------------------------------------------------------------------ the owner's edition commands


async def test_the_owner_manages_editions_from_the_bot(harness: Harness) -> None:
    updates = Updates()
    harness.telegram.updates = [
        updates.private("/edition add @wanger_ed en"),
        updates.private("/edition set ed-wanger-ed categories=world min=۵۰ breaking=on"),
        updates.private("/edition set ed-wanger-ed categories=nope"),
        updates.private("/edition add @wanger_test"),
        updates.private("/edition", user_id=ADMIN),
    ]
    harness.server.routes.clear()
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert replies[0].startswith("✅ نسخهٔ ed-wanger-ed: @wanger_ed (انگلیسی)")
    assert "حداقل اهمیت: ۵۰" in replies[1] and "فقط خبر فوری" in replies[1]
    assert "دستهٔ نامعلوم: nope" in replies[2]
    assert "کانال تست یا اصلی نمی‌تواند نسخه هم باشد" in replies[3]
    assert "فقط برای مالک" in harness.telegram.messages_to(ADMIN)[-1]["text"]
    stored = await harness.scalar(
        sa.text(f"select value from settings where key = '{EDITIONS_KEY}'")
    )
    [edition] = json.loads(stored) if isinstance(stored, str) else stored
    assert edition["language"] == "en" and edition["min_importance"] == 50
    effective = apply(harness.config, Overrides.from_settings(None, None, editions=[edition]))
    assert [e.id for e in effective.pipeline.editions.editions] == ["ed-wanger-ed"]
    # the panel's buttons: language back to Persian, then remove it
    harness.telegram.updates = [updates.callback("pn:ed:l:ed-wanger-ed")]
    harness.clock.advance(minutes=10)
    await harness.run()
    screen = [p for m, p in harness.telegram.calls if m == "editMessageText"][-1]["text"]
    assert "زبان: فارسی" in screen
    harness.telegram.updates = [updates.private("/edition remove ed-wanger-ed")]
    harness.clock.advance(minutes=10)
    await harness.run()
    assert "حذف شد" in harness.telegram.owner_messages()[-1]


# ------------------------------------------------------------------ mother bot


class RecordingMother:
    def __init__(self) -> None:
        self.runs: list[dict[str, Any]] = []
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def report_run(self, summary: dict[str, Any]) -> None:
        self.runs.append(summary)

    async def report_event(self, kind: str, payload: dict[str, Any]) -> None:
        self.events.append((kind, payload))


async def test_each_run_and_its_events_reach_the_mother_bot(harness: Harness) -> None:
    setup(harness, "abc", vectors=VECTORS, weekly_report=WEEKLY_NOW)
    for sid, story in zip("abc", (KENYA, NORWAY, PERU), strict=True):
        feed(harness, sid, *story)
    pipeline = harness.pipeline()
    mother = RecordingMother()
    pipeline.d.mother = mother
    summary = await pipeline.run_once(RunOptions())
    [run] = mother.runs
    assert run["run_id"] == summary.run_id and run["dry_run"] is False
    kinds = {kind: payload for kind, payload in mother.events}
    assert kinds["published"]["posts"] == 3 and kinds["published"]["channel"] == "test"
    assert kinds["weekly"]["stories"] == 3


async def test_the_http_mother_bot_signs_filters_and_never_raises() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        mother = HttpMotherBot(
            "https://mother.example/hook",
            SecretStr("s3cret"),
            http,
            MotherBotConfig(events=["run", "weekly"]),
            clock=lambda: 1_700_000_000.0,
        )
        await mother.report_run({"run_id": "r1", "counters": {"posts_sent": 2}})
        await mother.report_event("published", {"posts": 2})  # not subscribed
        await mother.report_event("weekly", {"stories": 9})
        assert await mother.ping() is None
    assert [json.loads(r.content)["kind"] for r in seen] == ["run", "weekly", "ping"]
    first = seen[0]
    assert verify_signature(
        "s3cret",
        first.headers[TIMESTAMP_HEADER],
        first.content,
        first.headers[SIGNATURE_HEADER],
        now=1_700_000_000,
    )
    assert json.loads(first.content)["payload"]["counters"] == {"posts_sent": 2}

    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    async with httpx.AsyncClient(transport=httpx.MockTransport(broken)) as http:
        down = HttpMotherBot(
            "https://mother.example/hook", SecretStr("s3cret"), http, MotherBotConfig()
        )
        await down.report_run({"run_id": "r2"})  # swallowed
        assert await down.ping() == "unreachable (ConnectError)"


# ------------------------------------------------------------------ admin, mobile API, dashboard

TOKEN = "admin-token-0123456789"
MOBILE = "mobile-token-0123456789"


async def api_client(h: Harness, **extra: Any) -> AsyncIterator[httpx.AsyncClient]:
    pytest.importorskip("fastapi")
    from wanger_news.api.app import ApiDeps, create_app

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
            channels={"test": ChatRef.parse("@wanger_test"), "main": None},
            ai=h.ai,
            **extra,
        )
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://api"
    ) as c:
        yield c


ADMIN_AUTH = {"Authorization": f"Bearer {TOKEN}"}
MOBILE_AUTH = {"Authorization": f"Bearer {MOBILE}"}


@pytest.fixture
async def published(harness: Harness) -> Harness:
    pytest.importorskip("fastapi")
    await publish_three(
        harness, public_api={"feed_channel": "test"}, weekly_report={"min_stories": 3}
    )
    return harness


async def test_admin_search_weekly_and_editions_routes(published: Harness) -> None:
    async for api in api_client(published):
        found = (await api.get("/api/search", params={"q": "Norway"}, headers=ADMIN_AUTH)).json()
        assert len(found["hits"]) == 1 and found["hits"][0]["match"] == "text"
        assert (await api.get("/api/search", params={"q": "x"})).status_code == 401
        weekly = (await api.get("/api/weekly", headers=ADMIN_AUTH)).json()
        assert weekly["report"]["stories"] == 3 and weekly["text"].startswith("🗓")
        assert (await api.get("/api/editions", headers=ADMIN_AUTH)).json() == []
        assert (await api.post("/api/editions/none/toggle", headers=ADMIN_AUTH)).status_code == 404
        # no mobile token configured: there is no /api/v1 at all
        assert (await api.get("/api/v1/feed", headers=MOBILE_AUTH)).status_code == 404


async def test_the_mobile_feed_is_read_only_paginated_and_needs_its_own_token(
    published: Harness,
) -> None:
    async for api in api_client(published, mobile_token=SecretStr(MOBILE)):
        assert (await api.get("/api/v1/feed")).status_code == 401
        assert (await api.get("/api/v1/feed", headers=ADMIN_AUTH)).status_code == 401
        first = (await api.get("/api/v1/feed", params={"limit": 2}, headers=MOBILE_AUTH)).json()
        assert len(first["items"]) == 2 and first["next_cursor"]
        item = first["items"][0]
        assert item["title"] == "عنوان فارسی آزمایشی" and item["language"] == "fa"
        assert item["post_url"].startswith("https://t.me/wanger_test/")
        assert item["status"] and item["sources"] and item["kind"] == "story"
        second = (
            await api.get(
                "/api/v1/feed",
                params={"limit": 2, "cursor": first["next_cursor"]},
                headers=MOBILE_AUTH,
            )
        ).json()
        assert len(second["items"]) == 1 and second["next_cursor"] is None
        ids = [i["id"] for i in first["items"] + second["items"]]
        assert len(set(ids)) == 3
        assert (
            await api.get("/api/v1/feed", params={"cursor": "bad!"}, headers=MOBILE_AUTH)
        ).status_code == 400
        none = await api.get("/api/v1/feed", params={"category": "sport"}, headers=MOBILE_AUTH)
        assert none.json()["items"] == []
        story = (await api.get(f"/api/v1/stories/{item['story_id']}", headers=MOBILE_AUTH)).json()
        assert [p["id"] for p in story["posts"]] == [item["id"]]
        assert (await api.get("/api/v1/stories/999999", headers=MOBILE_AUTH)).status_code == 404
        hits = (await api.get("/api/v1/search", params={"q": "Peru"}, headers=MOBILE_AUTH)).json()
        assert len(hits["hits"]) == 1 and "score" not in hits["hits"][0]
        cats = (await api.get("/api/v1/categories", headers=MOBILE_AUTH)).json()
        assert {"id", "name_fa", "name_en"} <= set(cats[0])
        weekly = (await api.get("/api/v1/weekly", headers=MOBILE_AUTH)).json()
        assert weekly["stories"] == 3
        # read-only: nothing to post or change
        assert (await api.post("/api/v1/feed", headers=MOBILE_AUTH)).status_code == 405


async def test_the_dashboard_is_static_and_locked_down(published: Harness) -> None:
    async for api in api_client(published):
        page = await api.get("/dashboard")
        assert page.status_code == 200 and "text/html" in page.headers["content-type"]
        csp = page.headers["content-security-policy"]
        assert "script-src 'self'" in csp and "frame-ancestors 'none'" in csp
        assert page.headers["x-content-type-options"] == "nosniff"
        script = await api.get("/dashboard/app.js")
        assert "javascript" in script.headers["content-type"]
        assert "innerHTML" not in script.text  # untrusted text is only ever textContent
        assert "sessionStorage" in script.text and "localStorage" not in script.text
        assert (await api.get("/dashboard/app.css")).status_code == 200


async def test_cors_allows_only_reading_from_listed_origins(published: Harness) -> None:
    published.config = published.config.model_copy(
        update={
            "pipeline": published.config.pipeline.model_copy(
                update={
                    "public_api": published.config.pipeline.public_api.model_copy(
                        update={"cors_origins": ["https://app.example"]}
                    )
                }
            )
        }
    )
    async for api in api_client(published, mobile_token=SecretStr(MOBILE)):
        ok = await api.options(
            "/api/v1/feed",
            headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET"},
        )
        assert ok.headers.get("access-control-allow-origin") == "https://app.example"
        post = await api.options(
            "/api/articles/1/publish",
            headers={"Origin": "https://app.example", "Access-Control-Request-Method": "POST"},
        )
        assert post.status_code == 400
        other = await api.options(
            "/api/v1/feed",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
        )
        assert "access-control-allow-origin" not in other.headers


async def test_an_update_replies_to_the_story_post_in_the_edition(harness: Harness) -> None:
    from . import test_stories as stories_test

    as_main(harness)
    stories_test.setup(harness, epsilon=False, editions={"editions": [PERSIAN_EDITION]})
    await harness.run()
    [first] = chat_posts(harness, "@wanger_ed")
    [edition_story] = await sent_rows(harness, chat_id="@wanger_ed")
    stories_test.serve(harness, delta=True, epsilon=True)
    harness.clock.advance(minutes=30)
    await harness.run()
    edition = chat_posts(harness, "@wanger_ed")
    assert len(edition) == 2 and "🔄 <b>به‌روزرسانی:</b>" in text_of(edition[1])
    assert edition[1]["reply_parameters"]["message_id"] == edition_story.message_ids[0]
    assert "reply_parameters" not in first
    main = chat_posts(harness, "@wanger_main")
    assert edition[1]["reply_parameters"] != main[1]["reply_parameters"]  # its own channel's post
    [update_row] = await sent_rows(harness, chat_id="@wanger_ed", kind="update")
    assert update_row.reply_to_message_id == edition_story.message_ids[0]
