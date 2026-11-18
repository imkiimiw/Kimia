"""The source channel: posts are copied to the target channel unless already published.

Also: getUpdates offset handling, albums, posts made by hand in the target channel, unknown
channels, and the owner-only commands.
"""

from __future__ import annotations

import sqlalchemy as sa

from wanger_news.db.tables import Article, Setting, TelegramUpdate
from wanger_news.domain.enums import ArticleStatus

from .conftest import (
    NOW,
    OWNER,
    SOURCE_CHANNEL_ID,
    Harness,
    Updates,
)

LONG_TEXT = (
    "خبر فوری: زلزله‌ای به بزرگی ۶ ریشتر امروز صبح شهر نمونه را لرزاند و "
    "مقام‌های محلی می‌گویند تیم‌های امداد به منطقه اعزام شده‌اند."
)


def copies(h: Harness) -> list[tuple[str, dict]]:  # type: ignore[type-arg]
    return [(m, p) for m, p in h.telegram.calls if m in ("copyMessage", "copyMessages")]


async def run_inbox(h: Harness) -> None:
    """A run with no feeds: only the Telegram inbox (and publishing) do anything."""
    h.server.routes.clear()
    await h.run()


async def test_new_source_post_is_copied_to_the_test_channel(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT)]
    await run_inbox(harness)
    [(method, payload)] = copies(harness)
    assert method == "copyMessage"
    assert payload == {
        "chat_id": "@wanger_test",
        "from_chat_id": SOURCE_CHANNEL_ID,
        "message_id": up.next_message,
    }
    [article] = [a for a in await harness.articles() if a.source_id == "source-channel"]
    assert article.status == ArticleStatus.PUBLISHED
    assert article.priority == 80  # human-curated posts go first


async def test_reposting_the_same_text_is_skipped_and_reported(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT)]
    await run_inbox(harness)
    harness.clock.advance(minutes=15)
    harness.telegram.updates.append(up.channel_post(LONG_TEXT + " #فوری"))  # same text + hashtag
    await run_inbox(harness)
    assert len(copies(harness)) == 1
    [notice] = harness.telegram.owner_messages()
    assert "پست تکراری منتشر نشد" in notice and "متن یکسان" in notice
    assert "https://t.me/wanger_source/" in notice


async def test_near_identical_text_is_skipped(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT)]
    await run_inbox(harness)
    harness.telegram.updates.append(up.channel_post(LONG_TEXT.replace("امروز صبح", "صبح امروز")))
    await run_inbox(harness)
    assert len(copies(harness)) == 1
    assert "متن بسیار مشابه" in harness.telegram.owner_messages()[0]


async def test_same_photo_or_same_forwarded_original_is_skipped(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [
        up.channel_post(photo="photo-A", caption="تصویر روز"),
        up.channel_post(text="نقل از کانال دیگر: " + LONG_TEXT, forward_from=(-100999, 77)),
    ]
    await run_inbox(harness)
    assert len(copies(harness)) == 2
    harness.telegram.updates += [
        up.channel_post(photo="photo-A", caption="همان عکس با متن دیگر"),
        up.channel_post(text="یک متن کاملا دیگر برای همان فوروارد", forward_from=(-100999, 77)),
    ]
    await run_inbox(harness)
    assert len(copies(harness)) == 2
    notices = harness.telegram.owner_messages()
    assert any("رسانهٔ یکسان" in n for n in notices)
    assert any("فوروارد از همان پست" in n for n in notices)


async def test_short_captions_alone_do_not_make_posts_equal(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [
        up.channel_post(photo="photo-1", caption="#خبر"),
        up.channel_post(photo="photo-2", caption="#خبر"),
    ]
    await run_inbox(harness)
    assert len(copies(harness)) == 2


async def test_post_whose_link_was_already_published_from_rss(harness: Harness) -> None:
    await harness.run()  # publishes the alpha economy story
    up = Updates()
    url = "https://www.alpha.example/news/economy-123?utm_source=telegram"
    text = f"نرخ بهره بالا رفت {url}"
    harness.telegram.updates = [
        up.channel_post(
            text, entities=[{"type": "url", "offset": text.index("https"), "length": len(url)}]
        )
    ]
    harness.clock.advance(minutes=15)
    await run_inbox(harness)
    assert copies(harness) == []
    assert "لینک یکسان" in harness.telegram.owner_messages()[0]


async def test_text_link_entity_counts_too(harness: Harness) -> None:
    await harness.run()
    up = Updates()
    text = "نرخ بهره بالا رفت (منبع)"
    harness.telegram.updates = [
        up.channel_post(
            text,
            entities=[
                {
                    "type": "text_link",
                    "offset": 0,
                    "length": 4,
                    "url": "https://alpha.example/news/economy-123/",
                }
            ],
        )
    ]
    await run_inbox(harness)
    assert copies(harness) == []


async def test_source_post_supersedes_an_unpublished_rss_copy(harness: Harness) -> None:
    await harness.run(telegram=False)  # RSS items are queued, nothing published yet
    up = Updates()
    url = "https://alpha.example/news/science-456"
    text = f"تلسکوپ تازه تصویر شکل‌گیری یک سیاره را ثبت کرد {url}"
    harness.telegram.updates = [
        up.channel_post(
            text, entities=[{"type": "url", "offset": text.index("https"), "length": len(url)}]
        )
    ]
    await harness.run()
    assert len(copies(harness)) == 1
    science = next(a for a in await harness.articles() if a.external_id == "alpha-456")
    assert science.status == ArticleStatus.DUPLICATE
    assert "superseded by source-channel post" in (science.status_reason or "")


async def test_album_is_copied_once_after_it_settles(harness: Harness) -> None:
    up = Updates()
    album = [
        up.channel_post(
            photo=f"album-{i}", caption="آلبوم" if i == 0 else None, media_group_id="g1", date=NOW
        )
        for i in range(3)
    ]
    harness.telegram.updates = album
    await run_inbox(harness)  # parts are 0 s old: wait for possible stragglers
    assert copies(harness) == []
    harness.clock.advance(seconds=30)
    await run_inbox(harness)
    [(method, payload)] = copies(harness)
    assert method == "copyMessages"
    assert payload["message_ids"] == sorted(u["channel_post"]["message_id"] for u in album)
    harness.clock.advance(minutes=10)
    await run_inbox(harness)
    assert len(copies(harness)) == 1


async def test_posts_made_by_hand_in_the_target_channel_count_as_published(
    harness: Harness,
) -> None:
    up = Updates()
    manual = up.channel_post(LONG_TEXT, chat_id=-1002222222222, username="wanger_test")
    harness.telegram.updates = [manual]
    await run_inbox(harness)
    [external] = [a for a in await harness.articles() if a.status == ArticleStatus.EXTERNAL]
    assert external.source_id == "target-channel"
    harness.telegram.updates.append(up.channel_post(LONG_TEXT))  # the same text in the source
    await run_inbox(harness)
    assert copies(harness) == []


async def test_unknown_channel_is_reported_once(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [
        up.channel_post("hello", chat_id=-1003333333333, username=None),
        up.channel_post("again", chat_id=-1003333333333, username=None),
    ]
    await run_inbox(harness)
    notices = harness.telegram.owner_messages()
    assert len(notices) == 1 and "-1003333333333" in notices[0]
    assert copies(harness) == []


async def test_updates_are_processed_exactly_once_and_offset_is_kept(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT), up.private("/status")]
    await run_inbox(harness)
    offset = await harness.scalar(sa.select(Setting.value).where(Setting.key == "telegram.offset"))
    assert offset == harness.telegram.updates[-1]["update_id"] + 1
    harness.clock.advance(minutes=15)
    await run_inbox(harness)
    # the second run confirmed the old updates (offset) and processed nothing again
    assert len(copies(harness)) == 1
    assert harness.telegram.confirmed_below == offset
    rows = await harness.rows(sa.select(TelegramUpdate.outcome).order_by(TelegramUpdate.update_id))
    assert [r[0] for r in rows] == ["source_post:new", "command:status"]


async def test_crash_after_storing_updates_loses_nothing(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT)]
    pipeline = harness.pipeline()
    from sqlalchemy.ext.asyncio import AsyncSession

    from wanger_news.db.repositories import Repositories

    async with AsyncSession(harness.engine, expire_on_commit=False) as session:
        repos = Repositories(session)
        ctx = pipeline._context(
            "crash",
            __import__("wanger_news.services.pipeline", fromlist=["RunOptions"]).RunOptions(),
        )
        assert await pipeline.inbox.poll(repos, ctx) == 1  # stored, then "crash"
    await run_inbox(harness)
    assert len(copies(harness)) == 1


async def test_owner_commands_and_strangers(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [
        up.private("/status"),
        up.private("/sources"),
        up.private("/status", user_id=12345),
        up.private("hello"),
    ]
    await run_inbox(harness)
    replies = harness.telegram.owner_messages()
    assert len(replies) == 2
    assert "وضعیت" in replies[0] and "منابع" in replies[1]
    to_stranger = [
        p for m, p in harness.telegram.calls if m == "sendMessage" and p["chat_id"] == 12345
    ]
    assert to_stranger == []


async def test_pause_and_resume(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.private("/pause")]
    await harness.run()
    assert harness.telegram.channel_posts() == []
    assert (
        await harness.scalar(
            sa.select(sa.func.count())
            .select_from(Article)
            .where(Article.status == ArticleStatus.QUEUED.value)
        )
        > 0
    )
    harness.telegram.updates.append(up.private("/resume"))
    harness.clock.advance(minutes=15)
    await harness.run()
    assert harness.telegram.channel_posts()


async def test_later_phase_commands_answer_honestly(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.private("/approve 12"), up.private("/help")]
    await run_inbox(harness)
    replies = harness.telegram.owner_messages()
    assert "فاز ۲" in replies[0]
    assert "/pause" in replies[1]
    assert all(
        m != "sendMessage" or p["chat_id"] == OWNER
        for m, p in harness.telegram.calls
        if m == "sendMessage"
    )


async def test_a_changed_number_is_published_as_new(harness: Harness) -> None:
    up = Updates()
    harness.telegram.updates = [up.channel_post(LONG_TEXT)]
    await run_inbox(harness)
    harness.telegram.updates.append(up.channel_post(LONG_TEXT.replace("۶ ریشتر", "۶.۴ ریشتر")))
    await run_inbox(harness)
    assert len(copies(harness)) == 2
