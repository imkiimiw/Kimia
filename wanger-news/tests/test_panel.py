"""The owner's panel inside the bot: channels, sources, modes, pause — and that its changes
are used from the next run on (like production, the harness applies them at the run start)."""

from __future__ import annotations

from typing import Any

from wanger_news.db.tables import Article
from wanger_news.domain.chatref import ChatRef
from wanger_news.services.ai_stage import MODES_KEY
from wanger_news.services.overrides import CHANNELS_KEY, SOURCES_KEY, Overrides, apply

from .conftest import ADMIN, OWNER, Harness, Updates, make_config, source_entries


def edits(h: Harness) -> list[dict[str, Any]]:
    return [p for m, p in h.telegram.calls if m == "editMessageText"]


def keyboard_texts(payload: dict[str, Any]) -> list[str]:
    return [b["text"] for row in payload["reply_markup"]["inline_keyboard"] for b in row]


async def setting(h: Harness, key: str) -> Any:
    from wanger_news.db.tables import Setting

    async with h.engine.connect():
        pass
    return await h.scalar(
        Setting.__table__.select().with_only_columns(Setting.value).where(Setting.key == key)
    )


def upd(h: Harness) -> Updates:
    """One update counter per test: Telegram never re-delivers an update id it confirmed."""
    if not hasattr(h, "_updates"):
        h._updates = Updates()  # type: ignore[attr-defined]
    return h._updates  # type: ignore[attr-defined,no-any-return]


async def tap(h: Harness, data: str, *, user: int = OWNER) -> None:
    h.telegram.updates = [upd(h).callback(data, user_id=user)]
    h.clock.advance(minutes=15)
    h.server.routes.clear()
    await h.run()


def with_channels(h: Harness) -> None:
    h.channels = {"test": ChatRef.parse("@wanger_test"), "main": None}


# ------------------------------------------------------------------ opening the panel


async def test_the_owner_opens_the_panel_others_cannot(harness: Harness) -> None:
    updates = upd(harness)
    harness.telegram.updates = [
        updates.private("/panel"),
        updates.private("/panel", user_id=ADMIN),
        updates.private("/start"),
    ]
    await harness.run()
    panels = [
        p
        for m, p in harness.telegram.calls
        if m == "sendMessage" and p["chat_id"] == OWNER and p["text"].startswith("<b>🎛")
    ]
    assert len(panels) == 2  # /panel and /start from the owner
    assert panels[0]["text"].startswith("<b>🎛 پنل مدیریت Wanger News</b>")
    assert "📡 کانال‌ها" in keyboard_texts(panels[0])
    assert any("فقط برای مالک" in p["text"] for p in harness.telegram.messages_to(ADMIN))


async def test_a_tap_from_someone_else_changes_nothing(harness: Harness) -> None:
    await tap(harness, "pn:pause", user=ADMIN)
    assert edits(harness) == []
    assert await setting(harness, "publishing.paused") is None


# ------------------------------------------------------------------ channels


async def test_the_owner_sets_the_test_channel_by_replying(harness: Harness) -> None:
    with_channels(harness)
    await tap(harness, "pn:ch:set:test")
    prompt = next(
        p
        for m, p in harness.telegram.calls
        if m == "sendMessage" and p.get("reply_markup", {}).get("force_reply")
    )
    prompt_id = harness.telegram.next_id
    assert "در پاسخ به همین پیام" in prompt["text"]
    harness.telegram.updates = [upd(harness).reply("@new_test", prompt_id)]
    harness.clock.advance(minutes=15)
    await harness.run()
    answer = harness.telegram.owner_messages()[-1]
    assert answer.startswith("✅ کانال تست: @new_test")
    stored = await setting(harness, CHANNELS_KEY)
    assert stored["test"] == {"ref": "@new_test", "title": "New_Test"}
    # the next run publishes in the new channel
    harness.config = make_config()
    from .conftest import standard_feeds

    standard_feeds(harness.server)
    harness.clock.advance(minutes=15)
    await harness.run()
    assert {p["chat_id"] for _, p in harness.telegram.channel_posts()} == {"@new_test"}


async def test_a_channel_where_the_bot_is_not_admin_is_refused(harness: Harness) -> None:
    with_channels(harness)
    harness.telegram.chats["@no_rights"] = {
        "id": -1009,
        "type": "channel",
        "title": "X",
        "username": "no_rights",
    }
    harness.telegram.not_admin.add(-1009)
    harness.telegram.updates = [upd(harness).private("/channel test @no_rights")]
    harness.server.routes.clear()
    await harness.run()
    assert "ربات در این کانال ادمین نیست" in harness.telegram.owner_messages()[-1]
    assert await setting(harness, CHANNELS_KEY) is None


async def test_source_channels_are_added_and_removed(harness: Harness) -> None:
    with_channels(harness)
    harness.telegram.chats["@second_src"] = {
        "id": -1003333,
        "type": "channel",
        "title": "Second",
        "username": "second_src",
    }
    updates = upd(harness)
    harness.telegram.updates = [
        updates.private("/channel source add @second_src"),
        updates.private("/channel source add @wanger_test"),
        updates.private("/channel source remove @wanger_source"),
    ]
    harness.server.routes.clear()
    await harness.run()
    replies = harness.telegram.owner_messages()
    assert replies[0].startswith("✅ کانال منبع: @second_src")
    assert "نمی‌تواند کانال منبع هم باشد" in replies[1]  # a target can never be a source
    assert "از کانال‌های منبع حذف شد" in replies[2]
    # next run: the new source works, the removed one is an unknown channel
    harness.telegram.updates = [
        updates.channel_post(
            "خبر تازه از منبع دوم دربارهٔ بازار ارز", chat_id=-1003333, username="second_src"
        ),
        updates.channel_post("خبر از منبع قدیمی که حذف شد"),
    ]
    harness.clock.advance(minutes=15)
    await harness.run()
    relayed = [p for m, p in harness.telegram.channel_posts() if m == "sendMessage"]
    assert len(relayed) == 1 and relayed[0]["text"].startswith("خبر تازه از منبع دوم")
    added = [a for a in await harness.articles() if a.source_id == "tg-second-src"]
    assert len(added) == 1


async def test_the_target_switch_needs_a_main_channel(harness: Harness) -> None:
    with_channels(harness)
    await tap(harness, "pn:ch:target:main")
    assert "کانال اصلی هنوز تنظیم نشده" in edits(harness)[-1]["text"]
    harness.telegram.updates = [upd(harness).private("/channel main @main_news")]
    await harness.run()
    await tap(harness, "pn:ch:target:main")
    assert await setting(harness, "publish.target") == "main"
    screen = edits(harness)[-1]
    assert "🎯 پست‌ها الان می‌روند به: کانال اصلی (مقصد)" in screen["text"]
    assert "@main_news" in screen["text"]


# ------------------------------------------------------------------ sources, modes, pause


def config_with_candidates() -> Any:
    candidate = {
        "id": "fa-candidate",
        "name": "منبع فارسی نامزد",
        "language": "fa",
        "category": "world",
        "country": "GB",
        "source_type": "newspaper",
        "reliability_score": 70,
        "active": False,
        "inactive_reason": "Candidate — waiting for the owner's choice.",
        "rss_url": "https://fa.example/rss",
    }
    locked = {
        "id": "paywalled",
        "name": "Paywalled Daily",
        "language": "en",
        "category": "world",
        "country": "GB",
        "source_type": "newspaper",
        "reliability_score": 90,
        "active": False,
        "inactive_reason": "Articles are behind a paywall.",
        "rss_url": "https://pay.example/rss",
    }
    return make_config(source_entries(candidate, locked))


async def test_rss_sources_are_switched_but_locked_ones_stay_off(harness: Harness) -> None:
    harness.config = config_with_candidates()
    await tap(harness, "pn:src")
    names = keyboard_texts(edits(harness)[-1])
    assert "✅ Alpha News" in names and "⚪️ منبع فارسی نامزد" in names
    assert "🔒 Paywalled Daily" in names
    await tap(harness, "pn:src:t:alpha:0")
    await tap(harness, "pn:src:t:fa-candidate:0")
    await tap(harness, "pn:src:x:paywalled:0")
    assert "paywall" in edits(harness)[-1]["text"]
    assert await setting(harness, SOURCES_KEY) == {"alpha": False, "fa-candidate": True}
    ov = Overrides.from_settings(None, {"alpha": False, "fa-candidate": True, "paywalled": True})
    effective = apply(harness.config, ov)
    state = {s.id: s.active for s in effective.sources.sources}
    assert state["alpha"] is False and state["fa-candidate"] is True
    assert state["paywalled"] is False  # never from the bot
    # switching alpha back on returns to the file's value (no override left)
    await tap(harness, "pn:src:t:alpha:0")
    assert await setting(harness, SOURCES_KEY) == {"fa-candidate": True}


async def test_a_source_switched_off_is_not_fetched_on_the_next_run(harness: Harness) -> None:
    await tap(harness, "pn:src:t:alpha:0")
    from .conftest import standard_feeds

    standard_feeds(harness.server)
    harness.clock.advance(minutes=15)
    await harness.run()
    sources = {a.source_id for a in await harness.articles() if isinstance(a, Article)}
    assert "alpha" not in sources and "beta" in sources


async def test_publish_modes_cycle_per_category(harness: Harness) -> None:
    await tap(harness, "pn:mode")
    assert "🤖 خودکار" in edits(harness)[-1]["text"]
    await tap(harness, "pn:mode:c:technology")  # harness default is auto → manual
    assert await setting(harness, MODES_KEY) == {"categories": {"technology": "manual"}}
    await tap(harness, "pn:mode:c:technology")  # manual → semi
    await tap(harness, "pn:mode:c:technology")  # semi → auto = the default: override removed
    assert await setting(harness, MODES_KEY) == {"categories": {}}
    await tap(harness, "pn:mode:d")
    assert (await setting(harness, MODES_KEY))["default"] == "manual"


async def test_pause_from_the_panel_stops_publishing(harness: Harness) -> None:
    await tap(harness, "pn:pause")
    assert await setting(harness, "publishing.paused") is True
    assert "⏸ انتشار متوقف شد." in edits(harness)[-1]["text"]
    from .conftest import standard_feeds

    standard_feeds(harness.server)
    harness.clock.advance(minutes=15)
    summary = await harness.run()
    assert summary.counters["publish_skipped:paused"] == 1
    assert harness.telegram.channel_posts() == []


async def test_status_pending_trends_and_brief_screens(harness: Harness) -> None:
    for screen, marker in [
        ("pn:status", "📊 وضعیت"),
        ("pn:pend", "منتظر"),
        ("pn:trends", "موضوع‌های در حال رشد"),
        ("pn:brief", "خلاصه"),
    ]:
        await tap(harness, screen)
        payload = edits(harness)[-1]
        assert marker in payload["text"]
        assert keyboard_texts(payload) == ["🔙 بازگشت"]
