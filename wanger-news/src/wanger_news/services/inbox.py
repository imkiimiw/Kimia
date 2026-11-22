"""Telegram updates without a server (ADR-003): getUpdates on every run, state in the DB.

1. poll: getUpdates from the stored offset; every update is stored BEFORE the offset moves
   (the next getUpdates call confirms them to Telegram), so a crash loses nothing.
2. process: admin commands (private chat), source-channel posts (copied if never published),
   posts made by hand in a target channel (remembered, so they are not repeated).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Coroutine
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError

from wanger_news.adapters.telegram.source_posts import posts_to_draft, public_link
from wanger_news.adapters.telegram.types import Message, Update
from wanger_news.config.models import AppConfig, SourceConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, TelegramUpdate
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ArticleStatus, DedupLevel, JobStatus, Stage, Transport
from wanger_news.domain.normalize import url_policy
from wanger_news.formatting.telegram_html import esc, link
from wanger_news.services.commands import CommandService
from wanger_news.services.context import RunContext
from wanger_news.services.dedup import DedupService, describe_match, fingerprints_of
from wanger_news.services.review import ReviewService

log = logging.getLogger("wanger_news.inbox")

OFFSET_KEY = "telegram.offset"
ALLOWED_UPDATES = ["message", "channel_post", "edited_channel_post", "callback_query"]
PAGE_SIZE = 100
EXTERNAL_SOURCE_ID = "target-channel"


class InboxService:
    def __init__(
        self,
        config: AppConfig,
        dedup: DedupService,
        commands: CommandService,
        review: ReviewService,
        publisher: Any = None,  # PublishService, for edits of published source posts
    ) -> None:
        self._publisher = publisher
        self._cfg = config
        self._dedup = dedup
        self._commands = commands
        self._review = review
        self._policy = url_policy(config.pipeline.dedup)
        self._sources = [
            (s, s.telegram.chat_ref)
            for s in config.active_sources
            if s.transport is Transport.TELEGRAM_CHANNEL and s.telegram is not None
        ]

    # ---------------------------------------------------------------- poll
    async def poll(self, repos: Repositories, ctx: RunContext) -> int:
        if ctx.bot is None:
            return 0
        offset = int(await repos.settings.get(OFFSET_KEY, 0) or 0)
        pages = 1 if ctx.dry_run else self._cfg.pipeline.telegram.poll_max_pages
        stored = 0
        for _ in range(pages):
            payload: dict[str, Any] = {
                "timeout": 0,
                "limit": PAGE_SIZE,
                "allowed_updates": ALLOWED_UPDATES,
            }
            if offset:
                payload["offset"] = offset
            raw = await ctx.bot.call("getUpdates", payload, idempotent=True)
            if not raw:
                break
            kinds = []
            for item in raw:
                try:
                    upd = Update.model_validate(item)
                    kinds.append((upd.kind, upd.chat_id))
                except ValidationError:
                    kinds.append(("invalid", None))
            stored += await repos.updates.store(raw, kinds, ctx.now())
            offset = max(int(item["update_id"]) for item in raw) + 1
            await repos.settings.set(OFFSET_KEY, offset, ctx.now())
            await repos.commit()  # stored first; the next getUpdates(offset) confirms them
            if len(raw) < PAGE_SIZE or ctx.dry_run:
                break
        return stored

    # ---------------------------------------------------------------- process
    async def process(self, repos: Repositories, ctx: RunContext) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        # plain values only: a rollback in one update expires every ORM row of the session
        pending = [(row.update_id, row.payload) for row in await repos.updates.pending()]
        albums: dict[tuple[int, str], list[tuple[int, Message]]] = defaultdict(list)
        for update_id, payload in pending:
            try:
                update = Update.model_validate(payload)
            except ValidationError:
                await self._mark(repos, ctx, [update_id], "invalid")
                counts["invalid"] += 1
                continue
            post = update.channel_post
            if post is not None and post.media_group_id:
                albums[(post.chat.id, post.media_group_id)].append((update_id, post))
                continue
            outcome = await self._guarded(repos, ctx, [update_id], self._handle(repos, ctx, update))
            counts[outcome.split(":", 1)[0]] += 1
        settle = timedelta(seconds=self._cfg.pipeline.telegram.album_settle_seconds)
        for parts in albums.values():
            newest = max(datetime.fromtimestamp(m.date, UTC) for _, m in parts)
            if ctx.now() - newest < settle:
                counts["album_waiting"] += 1  # more parts may still arrive; next run
                continue
            work = self._channel_post(repos, ctx, [m for _, m in parts])
            outcome = await self._guarded(repos, ctx, [uid for uid, _ in parts], work)
            counts[outcome.split(":", 1)[0]] += 1
        await repos.commit()
        return dict(counts)

    async def _guarded(
        self,
        repos: Repositories,
        ctx: RunContext,
        update_ids: list[int],
        work: Coroutine[Any, Any, str],
    ) -> str:
        """Run one update's work; on any error roll it back, but still mark it processed."""
        try:
            outcome = await work
        except Exception as exc:  # one bad update must not block the inbox
            await repos.rollback()
            log.exception("update_failed", extra={"update_ids": update_ids})
            outcome = f"error:{type(exc).__name__}"
        await self._mark(repos, ctx, update_ids, outcome)
        return outcome

    async def _mark(
        self, repos: Repositories, ctx: RunContext, update_ids: list[int], outcome: str
    ) -> None:
        for update_id in update_ids:
            row = await repos.session.get(TelegramUpdate, update_id)
            if row is not None:
                await repos.updates.mark(row, outcome, ctx.now())
        await repos.commit()

    async def _handle(self, repos: Repositories, ctx: RunContext, update: Update) -> str:
        if update.callback_query is not None:
            panel = self._commands.panel
            data = update.callback_query.data or ""
            if panel is not None and data.startswith("pn:"):
                return str(await panel.on_callback(repos, ctx, update.callback_query))
            corrections = self._commands.corrections
            if corrections is not None and data.startswith("cr:"):
                return str(await corrections.on_callback(repos, ctx, update.callback_query))
            return await self._review.on_callback(repos, ctx, update.callback_query)
        if update.message is not None:
            message = update.message
            sender = message.from_user.id if message.from_user else None
            if message.chat.type == "private" and self._commands.panel is not None:
                answered = await self._commands.panel.on_reply(repos, ctx, message)
                if answered is not None:
                    return str(answered)
            if message.chat.type == "private" and sender in ctx.admin_ids:
                edited = await self._review.on_edit_reply(repos, ctx, message)
                if edited is not None:
                    return edited
            return await self._commands.handle(repos, ctx, message)
        if update.channel_post is not None:
            return await self._channel_post(repos, ctx, [update.channel_post])
        if update.edited_channel_post is not None:
            return await self._edited_post(repos, ctx, update.edited_channel_post)
        return "ignored:kind"

    # ---------------------------------------------------------------- edits (Phase 5)
    async def _edited_post(self, repos: Repositories, ctx: RunContext, message: Message) -> str:
        """An admin edited a source-channel post: keep the stored text current and, when the
        post is already out, edit the bot's copy in the target channel the same way."""
        chat = message.chat
        if self._is_target(ctx, chat.id, chat.username):
            return "ignored:target_edit"
        source = self._source_for(chat.id, chat.username)
        if source is None:
            return "ignored:unknown_channel"
        article = await repos.articles.by_external_id(
            source.id, f"tg:{chat.id}:{message.message_id}"
        )
        if article is None:
            return "ignored:edit_of_unknown_post"
        tg = dict(article.telegram or {})
        items = [dict(i) for i in tg.get("items") or []]
        for item in items:
            if item.get("message_id") == message.message_id:
                item["text"] = message.body
                item["entities"] = [e.model_dump(exclude_none=True) for e in message.body_entities]
                item["author_signature"] = message.author_signature or item.get("author_signature")
        article.telegram = {**tg, "items": items}
        article.description_original = message.body or article.description_original
        await repos.commit()
        if article.status != ArticleStatus.PUBLISHED.value or ctx.target is None:
            return "edit:stored"
        if self._publisher is None:
            return "edit:stored"
        post = await repos.posts.last_sent(article.id, ctx.target.role)
        if post is None or not post.message_ids:
            return "edit:not_in_this_channel"
        return str(await self._publisher.edit_relayed(repos, ctx, article, post))

    # ---------------------------------------------------------------- channel posts
    def _source_for(self, chat_id: int, username: str | None) -> SourceConfig | None:
        for source, ref in self._sources:
            if ref.matches(chat_id, username):
                return source
        return None

    def _is_target(self, ctx: RunContext, chat_id: int, username: str | None) -> bool:
        return any(ref.matches(chat_id, username) for ref in ctx.observed_chats)

    async def _channel_post(
        self, repos: Repositories, ctx: RunContext, messages: list[Message]
    ) -> str:
        chat = messages[0].chat
        if self._is_target(ctx, chat.id, chat.username):  # never a source: posts would loop
            if not self._cfg.pipeline.telegram.observe_target_channels:
                return "ignored:target_channel"
            return await self._observe_target_post(repos, ctx, messages)
        source = self._source_for(chat.id, chat.username)
        if source is not None:
            return await self._source_post(repos, ctx, source, messages)
        await self._unknown_channel(repos, ctx, chat.id, chat.title, chat.username)
        return "ignored:unknown_channel"

    async def _source_post(
        self, repos: Repositories, ctx: RunContext, source: SourceConfig, messages: list[Message]
    ) -> str:
        now = ctx.now()
        draft = posts_to_draft(
            messages,
            source,
            source_id=source.id,
            fetched_at=now,
            dedup=self._cfg.pipeline.dedup,
            policy=self._policy,
        )
        if await repos.articles.known_external_ids(source.id, [draft.external_id]):
            return "duplicate:already_stored"
        published, superseded = await self._dedup.check_published(repos, draft)
        if published is not None:
            article = await repos.articles.insert(draft, ArticleStatus.NEW, now)
            await repos.articles.mark_duplicate(
                article, published.original_id, published.level, now, published.distance
            )
            await repos.articles.add_fingerprints(article.id, fingerprints_of(draft), now)
            await repos.jobs.record(
                article.id,
                Stage.SOURCE_POST,
                JobStatus.SKIPPED,
                ctx.run_id,
                now,
                details={"duplicate_of": published.original_id, "match": published.kind},
            )
            await ctx.event(
                repos,
                "info",
                "source_post_duplicate",
                article_id=article.id,
                duplicate_of=published.original_id,
                match=published.kind,
            )
            if self._cfg.pipeline.telegram.notify_owner_on_duplicate:
                original = await repos.articles.get(published.original_id)
                await ctx.notify_owner(
                    repos,
                    await self._duplicate_notice(repos, ctx, article, original, published.kind),
                    kind="duplicate",
                )
            return "duplicate:published_before"
        article = await repos.articles.insert(
            draft, ArticleStatus.NEW, now, priority=self._cfg.pipeline.telegram.source_post_priority
        )
        await repos.articles.add_fingerprints(article.id, fingerprints_of(draft), now)
        self._dedup.index.add(article)
        for other in superseded:  # the human post replaces automatic copies still waiting
            await repos.articles.mark_duplicate(other, article.id, DedupLevel.EXACT, now)
            other.status_reason = f"superseded by source-channel post #{article.id}"
        await repos.jobs.record(
            article.id,
            Stage.SOURCE_POST,
            JobStatus.DONE,
            ctx.run_id,
            now,
            details={"superseded": [o.id for o in superseded]},
        )
        return "source_post:new"

    async def _observe_target_post(
        self, repos: Repositories, ctx: RunContext, messages: list[Message]
    ) -> str:
        now = ctx.now()
        draft = posts_to_draft(
            messages,
            None,
            source_id=EXTERNAL_SOURCE_ID,
            fetched_at=now,
            dedup=self._cfg.pipeline.dedup,
            policy=self._policy,
        )
        if await repos.articles.known_external_ids(EXTERNAL_SOURCE_ID, [draft.external_id]):
            return "external:already_stored"
        article = await repos.articles.insert(
            draft, ArticleStatus.EXTERNAL, now, reason="posted in a target channel"
        )
        await repos.articles.add_fingerprints(article.id, fingerprints_of(draft), now)
        self._dedup.index.add(article)
        return "external:recorded"

    async def _unknown_channel(
        self,
        repos: Repositories,
        ctx: RunContext,
        chat_id: int,
        title: str | None,
        username: str | None,
    ) -> None:
        key = f"telegram.unknown_chat.{chat_id}"
        if await repos.settings.get(key):
            return
        await repos.settings.set(key, True, ctx.now())
        name = f"@{username}" if username else (title or str(chat_id))
        await ctx.notify_owner(
            repos,
            "ℹ️ <b>پست از کانالی که منبع تعریف نشده</b>\n"
            f"کانال: {esc(name)}\nشناسهٔ عددی: <code>{chat_id}</code>\n"
            "اگر این کانال منبع است، این شناسه را در WANGER_NEWS_SOURCE_CHANNEL بگذارید.",
            kind="unknown_channel",
        )

    async def _duplicate_notice(
        self,
        repos: Repositories,
        ctx: RunContext,
        article: Article,
        original: Article | None,
        kind: str,
    ) -> str:
        tg = article.telegram or {}
        here = public_link(tg.get("chat_username"), int(tg["message_ids"][0])) if tg else None
        lines = [
            "🔁 <b>پست تکراری منتشر نشد</b>",
            "این پست کانال منبع قبلاً منتشر شده بود: " + esc(describe_match(kind)) + ".",
        ]
        if here:
            lines.append("پست منبع: " + link(here, here))
        if original is not None:
            lines.append(f"نسخهٔ قبلی: {esc(original.title_original[:120])}")
            where = await self._published_link(repos, ctx, original)
            if where:
                lines.append("محل انتشار: " + link(where, where))
        return "\n".join(lines)

    async def _published_link(
        self, repos: Repositories, ctx: RunContext, original: Article
    ) -> str | None:
        if ctx.target is None:
            return original.canonical_url
        post = await repos.posts.last_sent(original.id, ctx.target.role)
        if post is not None and post.message_ids and ctx.target.chat.username:
            return f"https://t.me/{ctx.target.chat.username}/{post.message_ids[0]}"
        if original.status == ArticleStatus.EXTERNAL.value and original.url:
            return original.url
        return original.canonical_url


def chat_refs(*refs: ChatRef | None) -> list[ChatRef]:
    return [r for r in refs if r is not None]
