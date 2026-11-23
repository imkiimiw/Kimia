"""PUBLISH: queued items → the target channel, at most once each (ADR-004).

Protocol per item: claim (unique idempotency key, committed) → send → record (committed).
- definite failure → ``failed`` (retried while attempts remain; chat-level errors stop the run)
- unknown outcome (timeout after sending, 5xx) → ``uncertain``: never re-sent, owner told
- a claim left behind by a crashed run → ``uncertain`` as well
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from wanger_news.adapters.telegram.client import (
    TelegramNotSent,
    TelegramRateLimited,
    TelegramUncertain,
)
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, PublishedPost, StoryCluster
from wanger_news.domain.enums import (
    ArticleStatus,
    ChannelRole,
    ClusterRole,
    JobStatus,
    PostStatus,
    Stage,
    Transport,
)
from wanger_news.domain.rebrand import Styled, rebrand, strip_ids
from wanger_news.formatting.telegram_html import esc, split_html, utf16_len
from wanger_news.formatting.templates_fa import RenderedPost
from wanger_news.services.context import RunContext, Target
from wanger_news.services.posts import PostBuilder
from wanger_news.services.stories import timeline_event

#: Telegram error descriptions that concern the channel, not the post: stop, don't burn attempts.
CHAT_LEVEL_ERRORS = (
    "chat not found",
    "not enough rights",
    "need administrator rights",
    "bot is not a member",
    "bot was kicked",
    "have no rights",
    "chat_admin_required",
    "channel_private",
    "peer_id_invalid",
)
#: a photo URL Telegram cannot fetch: fall back to a text post
PHOTO_ERRORS = (
    "wrong file identifier",
    "failed to get http url content",
    "wrong type of the web page",
    "photo_invalid_dimensions",
    "image_process_failed",
    "wrong remote file",
)


def is_chat_level(exc: TelegramNotSent) -> bool:
    if exc.code == 403:
        return True
    description = (exc.description or "").lower()
    return any(marker in description for marker in CHAT_LEVEL_ERRORS)


def idempotency_key(article_id: int, target: Target) -> str:
    return f"article:{article_id}:chat:{target.key}"


@dataclass(slots=True)
class PublishReport:
    sent: int = 0
    previewed: int = 0
    failed: int = 0
    uncertain: int = 0
    expired: int = 0
    skipped: str | None = None
    errors: list[str] = field(default_factory=list)


#: message kinds whose caption copyMessage can replace
CAPTIONED = ("photo", "video", "animation", "document", "audio", "voice")
#: kinds sendMediaGroup accepts
ALBUM_KINDS = ("photo", "video", "document", "audio")


@dataclass(frozen=True, slots=True)
class Relay:
    """How a source-channel post goes out: ``text`` / ``caption`` / ``album`` (re-sent without
    the source's IDs), ``copy`` (unchanged) or ``empty`` (nothing left but IDs: not sent)."""

    kind: str
    styled: Styled | None = None
    caption_index: int = 0


@dataclass(frozen=True, slots=True)
class Delivery:
    method: str
    message_ids: list[int]
    text: str | None


class PublishService:
    def __init__(
        self, config: AppConfig, sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    ) -> None:
        self._cfg = config
        self._sleep = sleep
        self.posts = PostBuilder(config)
        self.last_message_ids: list[int] = []  # of the last send_extra (correction posts)

    async def run(self, repos: Repositories, ctx: RunContext, *, paused: bool) -> PublishReport:
        report = PublishReport()
        cfg = self._cfg.pipeline.publish
        if paused:
            report.skipped = "paused"
            return report
        if ctx.target is None:
            report.skipped = "no target channel configured"
            return report
        if ctx.bot is None and not ctx.dry_run:
            report.skipped = "no bot token"
            return report
        if not ctx.dry_run:
            await self.reconcile_stale_claims(repos, ctx)
        limit = cfg.max_posts_per_run if ctx.max_posts is None else ctx.max_posts
        if limit <= 0:
            report.skipped = "max_posts_per_run is 0"
            return report
        max_age = timedelta(hours=cfg.max_publish_age_hours)
        counted = 0  # "publish now" (an admin's button) does not count against the cap
        for article in await repos.articles.publish_queue(limit * 4 + 10):
            if counted >= limit and not article.publish_now:
                break
            now = ctx.now()
            human = (
                article.transport == Transport.TELEGRAM_CHANNEL.value
                or article.approved_by is not None
            )
            relay = self.relay(article, ctx.target)
            if relay.kind == "empty":
                await repos.articles.set_status(
                    article, ArticleStatus.FILTERED, now, "nothing left after removing the IDs"
                )
                await repos.commit()
                continue
            if not human and article.effective_at < now - max_age:
                await repos.articles.set_status(
                    article, ArticleStatus.EXPIRED, now, "too old to publish"
                )
                await repos.commit()
                report.expired += 1
                continue
            rendered = None
            breaking = article.breaking and await self._breaking_allowed(repos, ctx, ctx.target)
            if article.breaking and not breaking:
                ctx.count("breaking_capped")
            if article.transport != Transport.TELEGRAM_CHANNEL.value:
                rendered = await self.posts.build(
                    repos, article, target=ctx.target, now=now, breaking=breaking
                )
                if rendered is None:  # never post unprocessed text: back to the AI stage
                    await repos.articles.set_status(
                        article, ArticleStatus.AI_PENDING, now, "queued without a Persian summary"
                    )
                    await repos.commit()
                    continue
            if not article.publish_now:
                counted += 1
            if ctx.dry_run:
                self._preview(ctx, article, rendered)
                report.previewed += 1
                continue
            stop = await self._publish_one(
                repos, ctx, ctx.target, article, rendered, report, breaking=breaking
            )
            if stop:
                break
            if cfg.min_interval_seconds:
                await self._sleep(cfg.min_interval_seconds)
        return report

    def _preview(self, ctx: RunContext, article: Article, rendered: RenderedPost | None) -> None:
        header = (
            f"=== [dry-run] #{article.id} {article.source_id} priority={article.priority}"
            f" importance={article.importance_score} confidence={article.confidence_score}"
        )
        if article.transport == Transport.TELEGRAM_CHANNEL.value:
            tg = article.telegram or {}
            relay = self.relay(article, ctx.target)
            body = relay.styled.text if relay.styled is not None else article.title_original
            ctx.out(
                f"{header} → {relay.kind} {tg.get('message_ids')} from {tg.get('chat_id')} "
                f"to {ctx.target.chat if ctx.target else '-'}\n{body}\n"
            )
            return
        assert rendered is not None
        photo = f" (photo: {rendered.photo_url})" if rendered.photo_url else ""
        ctx.out(f"{header}{photo}\n{rendered.text}\n")

    async def _publish_one(
        self,
        repos: Repositories,
        ctx: RunContext,
        target: Target,
        article: Article,
        rendered: RenderedPost | None,
        report: PublishReport,
        *,
        breaking: bool = False,
    ) -> bool:
        """Returns True when publishing must stop for this run."""
        cfg = self._cfg.pipeline.publish
        key = idempotency_key(article.id, target)
        method = "copy" if article.transport == Transport.TELEGRAM_CHANNEL.value else "send"
        post = await repos.posts.claim(
            key=key,
            article_id=article.id,
            role=target.role,
            chat_id=target.key,
            method=method,
            run_id=ctx.run_id,
            now=ctx.now(),
            max_attempts=cfg.max_attempts,
        )
        if post is None:
            existing = await repos.posts.get(key)
            await self._sync_article(repos, ctx, article, existing)
            await repos.commit()
            return False
        story = await repos.stories.get(article.cluster_id)
        reply_to = self._reply_target(article, story, target)
        post.kind = "update" if article.cluster_role == ClusterRole.UPDATE.value else "story"
        post.cluster_id = story.id if story is not None else None
        post.reply_to_message_id = reply_to
        post.breaking = breaking
        await repos.commit()  # the claim is durable BEFORE anything is sent

        try:
            delivery = await self._deliver(ctx, target, article, rendered, reply_to)
        except TelegramRateLimited as exc:
            await self._failed(repos, ctx, post, article, exc, count_attempt=False)
            report.errors.append(f"rate limited {exc.retry_after}s")
            return True
        except TelegramUncertain as exc:
            await repos.posts.finish(post, PostStatus.UNCERTAIN, ctx.now(), error=str(exc))
            await repos.articles.set_status(article, ArticleStatus.UNCERTAIN, ctx.now(), str(exc))
            await repos.jobs.record(
                article.id,
                Stage.PUBLISH,
                JobStatus.FAILED,
                ctx.run_id,
                ctx.now(),
                error=f"uncertain: {exc}",
            )
            await repos.commit()
            report.uncertain += 1
            await ctx.notify_owner(
                repos, self._uncertain_notice(article, str(exc)), kind="uncertain"
            )
            await repos.commit()
            return False
        except TelegramNotSent as exc:
            chat_level = is_chat_level(exc)
            await self._failed(repos, ctx, post, article, exc, count_attempt=not chat_level)
            report.failed += 1
            report.errors.append(str(exc)[:200])
            if chat_level:
                await ctx.notify_owner(
                    repos,
                    "⛔️ <b>انتشار متوقف شد</b>\nربات نمی‌تواند در کانال "
                    f"{esc(str(target.chat))} پست بگذارد:\n{esc(exc.description[:300])}\n"
                    "ربات باید ادمین کانال با اجازهٔ ارسال پست باشد.",
                    kind="chat_level_error",
                )
                await repos.commit()
                return True
            return False

        now = ctx.now()
        await repos.posts.finish(
            post,
            PostStatus.SENT,
            now,
            message_ids=delivery.message_ids,
            text=delivery.text,
            method=delivery.method,
        )
        article.publish_now = False
        await repos.articles.set_status(
            article, ArticleStatus.PUBLISHED, now, f"sent to {target.role.value}"
        )
        if story is not None:
            await self._story_published(repos, story, article, target, delivery, now)
            if rendered is not None and rendered.related:
                story.related = rendered.related
        await repos.jobs.record(
            article.id,
            Stage.PUBLISH,
            JobStatus.DONE,
            ctx.run_id,
            now,
            details={"message_ids": delivery.message_ids, "method": delivery.method},
        )
        await repos.commit()
        report.sent += 1
        return False

    async def _failed(
        self,
        repos: Repositories,
        ctx: RunContext,
        post: PublishedPost,
        article: Article,
        exc: TelegramNotSent,
        *,
        count_attempt: bool,
    ) -> None:
        now = ctx.now()
        if not count_attempt:
            post.attempts = max(0, post.attempts - 1)
        await repos.posts.finish(post, PostStatus.FAILED, now, error=str(exc))
        exhausted = count_attempt and post.attempts >= self._cfg.pipeline.publish.max_attempts
        permanent = count_attempt and exc.code == 400
        if exhausted or permanent:
            await repos.articles.set_status(article, ArticleStatus.FAILED, now, str(exc)[:300])
        await repos.jobs.record(
            article.id, Stage.PUBLISH, JobStatus.FAILED, ctx.run_id, now, error=str(exc)[:500]
        )
        await repos.commit()

    async def _sync_article(
        self, repos: Repositories, ctx: RunContext, article: Article, post: PublishedPost | None
    ) -> None:
        """The key is taken: bring the article's status in line with its post row."""
        if post is None:
            return
        mapping = {
            PostStatus.SENT.value: ArticleStatus.PUBLISHED,
            PostStatus.UNCERTAIN.value: ArticleStatus.UNCERTAIN,
            PostStatus.FAILED.value: ArticleStatus.FAILED,
        }
        status = mapping.get(post.status)
        if status is not None:
            await repos.articles.set_status(article, status, ctx.now(), f"post {post.status}")

    async def reconcile_stale_claims(self, repos: Repositories, ctx: RunContext) -> None:
        ttl = timedelta(minutes=self._cfg.pipeline.locks.pipeline_ttl_minutes)
        for post in await repos.posts.stale_claims(ctx.now() - ttl):
            await repos.posts.finish(
                post, PostStatus.UNCERTAIN, ctx.now(), error="claim expired: a run stopped mid-send"
            )
            article = (
                await repos.articles.get(post.article_id) if post.article_id is not None else None
            )
            if article is None or post.channel_role == ChannelRole.EDITION.value:
                # a brief, a trend alert, or an edition's copy (the article itself was sent)
                await ctx.notify_owner(
                    repos,
                    "❓ <b>وضعیت یک پست نامشخص است</b>\n"
                    f"{esc(post.kind)} ({esc(post.idempotency_key)}): اجرای قبلی وسط ارسال قطع شد. "
                    "دوباره ارسال نمی‌شود؛ لطفاً کانال را بررسی کنید.",
                    kind="uncertain",
                )
            else:
                await repos.articles.set_status(
                    article, ArticleStatus.UNCERTAIN, ctx.now(), "claim expired"
                )
                await ctx.notify_owner(
                    repos, self._uncertain_notice(article, "claim expired"), kind="uncertain"
                )
            await repos.commit()

    def _uncertain_notice(self, article: Article, reason: str) -> str:
        return (
            "❓ <b>وضعیت یک پست نامشخص است</b>\n"
            f"خبر #{article.id}: {esc(article.title_original[:150])}\n"
            f"علت: {esc(reason[:200])}\n"
            "برای جلوگیری از پست تکراری، دوباره ارسال نمی‌شود. لطفاً کانال را بررسی کنید."
        )

    async def _breaking_allowed(
        self, repos: Repositories, ctx: RunContext, target: Target | None
    ) -> bool:
        """At most ``breaking.max_per_hour`` 🔴 posts per channel: more would numb readers."""
        if target is None:
            return False
        cap = self._cfg.pipeline.breaking.max_per_hour
        sent = await repos.posts.breaking_sent_since(target.key, ctx.now() - timedelta(hours=1))
        return sent < cap

    # ---------------------------------------------------------------- posts without an article
    async def send_extra(
        self,
        repos: Repositories,
        ctx: RunContext,
        *,
        key: str,
        kind: str,
        text: str,
        reply_to: int | None = None,
    ) -> str:
        """A daily brief or a trend alert to the target channel, with the same at-most-once
        protocol as articles. Returns sent | exists | failed | uncertain | preview | skipped."""
        target = ctx.target
        if target is None or (ctx.bot is None and not ctx.dry_run):
            return "skipped"
        if ctx.dry_run:
            ctx.out(f"=== [dry-run] {kind} → {target.chat}\n{text}\n")
            return "preview"
        full_key = f"{key}:chat:{target.key}"
        post = await repos.posts.claim(
            key=full_key,
            article_id=None,
            role=target.role,
            chat_id=target.key,
            method="send",
            run_id=ctx.run_id,
            now=ctx.now(),
            max_attempts=self._cfg.pipeline.publish.max_attempts,
        )
        if post is None:
            return "exists"
        post.kind = kind
        await repos.commit()
        post.reply_to_message_id = reply_to
        try:
            delivery = await self._send_text(ctx, target, text, reply_to)
        except TelegramUncertain as exc:
            await repos.posts.finish(post, PostStatus.UNCERTAIN, ctx.now(), error=str(exc))
            await repos.commit()
            return "uncertain"
        except (TelegramNotSent, TelegramRateLimited) as exc:
            await repos.posts.finish(post, PostStatus.FAILED, ctx.now(), error=str(exc))
            await repos.commit()
            return "failed"
        await repos.posts.finish(
            post,
            PostStatus.SENT,
            ctx.now(),
            message_ids=delivery.message_ids,
            text=delivery.text,
            method=delivery.method,
        )
        await repos.commit()
        self.last_message_ids = delivery.message_ids
        return "sent"

    # ---------------------------------------------------------------- editions (Phase 6)
    async def send_edition(
        self,
        repos: Repositories,
        ctx: RunContext,
        target: Target,
        article: Article,
        rendered: RenderedPost | None,
        *,
        kind: str,
        cluster_id: int | None,
        reply_to: int | None,
        breaking: bool,
    ) -> str:
        """An item already published in the main channel, copied to an edition channel. Same
        claim → send → record; the article's status and its story stay as the main post left
        them. Returns sent | exists | failed | uncertain | rate_limited."""
        cfg = self._cfg.pipeline.publish
        key = idempotency_key(article.id, target)
        post = await repos.posts.claim(
            key=key,
            article_id=article.id,
            role=target.role,
            chat_id=target.key,
            method="copy" if article.transport == Transport.TELEGRAM_CHANNEL.value else "send",
            run_id=ctx.run_id,
            now=ctx.now(),
            max_attempts=cfg.max_attempts,
        )
        if post is None:
            return "exists"
        post.kind = kind
        post.cluster_id = cluster_id
        post.reply_to_message_id = reply_to
        post.breaking = breaking
        await repos.commit()  # the claim is durable BEFORE anything is sent
        try:
            delivery = await self._deliver(ctx, target, article, rendered, reply_to)
        except TelegramRateLimited as exc:
            post.attempts = max(0, post.attempts - 1)
            await repos.posts.finish(post, PostStatus.FAILED, ctx.now(), error=str(exc))
            await repos.commit()
            return "rate_limited"
        except TelegramUncertain as exc:
            await repos.posts.finish(post, PostStatus.UNCERTAIN, ctx.now(), error=str(exc))
            await repos.commit()
            return "uncertain"
        except TelegramNotSent as exc:
            await repos.posts.finish(post, PostStatus.FAILED, ctx.now(), error=str(exc))
            await repos.commit()
            return "chat_error" if is_chat_level(exc) else "failed"
        await repos.posts.finish(
            post,
            PostStatus.SENT,
            ctx.now(),
            message_ids=delivery.message_ids,
            text=delivery.text,
            method=delivery.method,
        )
        await repos.commit()
        return "sent"

    # ---------------------------------------------------------------- stories
    @staticmethod
    def _reply_target(article: Article, story: StoryCluster | None, target: Target) -> int | None:
        """An update replies to the story's last post — in the same channel only."""
        if article.cluster_role != ClusterRole.UPDATE.value or story is None:
            return None
        if story.post_message_id is None or story.post_chat != target.key:
            return None
        return story.post_message_id

    async def _story_published(
        self,
        repos: Repositories,
        story: StoryCluster,
        article: Article,
        target: Target,
        delivery: Delivery,
        now: datetime,
    ) -> None:
        """Remember where the story is, what it said, and keep the timeline."""
        summary = await repos.summaries.get(article.summary_id)
        update = article.cluster_role == ClusterRole.UPDATE.value
        if summary is not None:
            said = {
                "title": summary.title,
                "summary": summary.summary,
                "key_points": list(summary.key_points or []),
            }
        else:  # a source-channel post copied as it is
            said = {
                "title": article.title_original,
                "summary": article.description_original,
                "key_points": [],
            }
        if update and story.published_text:
            story.published_text = {
                **story.published_text,
                "updates": [*story.published_text.get("updates", []), said],
            }
        elif story.published_text is None or story.lead_article_id == article.id:
            story.published_text = said
        if story.published_at is None:
            story.published_at = now
            story.lead_article_id = story.lead_article_id or article.id
        if delivery.message_ids:
            story.post_chat = target.key
            story.post_message_id = delivery.message_ids[0]
        timeline_event(
            story,
            now.isoformat(),
            "update_published" if update else "published",
            article_id=article.id,
            message_ids=delivery.message_ids,
            chat=target.key,
        )
        story.updated_at = now

    # ---------------------------------------------------------------- Bot API calls
    async def _deliver(
        self,
        ctx: RunContext,
        target: Target,
        article: Article,
        rendered: RenderedPost | None,
        reply_to: int | None = None,
    ) -> Delivery:
        assert ctx.bot is not None
        if article.transport == Transport.TELEGRAM_CHANNEL.value:
            return await self._copy(ctx, target, article)
        assert rendered is not None
        reply = _reply(reply_to)
        if rendered.photo_url:
            try:
                result = await ctx.bot.call(
                    "sendPhoto",
                    {
                        "chat_id": target.chat.api_value,
                        "photo": rendered.photo_url,
                        "caption": rendered.text,
                        "parse_mode": "HTML",
                        **reply,
                    },
                )
                return Delivery("sendPhoto", [int(result["message_id"])], rendered.text)
            except TelegramNotSent as exc:
                if not any(m in (exc.description or "").lower() for m in PHOTO_ERRORS):
                    raise
                return await self._send_text(
                    ctx, target, rendered.text_without_photo or rendered.text, reply_to
                )
        return await self._send_text(ctx, target, rendered.text, reply_to)

    async def _send_text(
        self, ctx: RunContext, target: Target, text: str, reply_to: int | None = None
    ) -> Delivery:
        assert ctx.bot is not None
        ids: list[int] = []
        for chunk in split_html(text, self._cfg.pipeline.publish.message_limit):
            payload: dict[str, Any] = {
                "chat_id": target.chat.api_value,
                "text": chunk,
                "parse_mode": "HTML",
                "link_preview_options": {
                    "is_disabled": not self._cfg.pipeline.publish.link_preview
                },
            }
            if ids:
                payload["reply_parameters"] = {"message_id": ids[0]}
            elif reply_to is not None:
                payload.update(_reply(reply_to))
            try:
                result = await ctx.bot.call("sendMessage", payload)
            except TelegramNotSent as exc:
                if ids:  # part of the post is out: a retry would repeat it
                    raise TelegramUncertain(f"partially sent ({len(ids)} parts): {exc}") from exc
                raise
            ids.append(int(result["message_id"]))
        return Delivery("sendMessage", ids, text)

    # ---------------------------------------------------------------- source-channel posts
    def relay(self, article: Article, target: Target | None) -> Relay:
        """The owner's "rebrand" rule for a source-channel post (``domain/rebrand.py``)."""
        cfg = self._cfg.pipeline.telegram.source_posts
        tg = article.telegram or {}
        items: list[dict[str, Any]] = list(tg.get("items") or [])
        if article.transport != Transport.TELEGRAM_CHANNEL.value:
            return Relay("copy")
        if cfg.mode != "rebrand" or not items or target is None:
            return Relay("copy")
        author = next(
            (str(i["author_signature"]) for i in items if i.get("author_signature")), None
        )

        def styled(item: dict[str, Any], limit: int) -> Styled | None:
            text, entities = str(item.get("text") or ""), list(item.get("entities") or [])
            full = rebrand(
                text,
                entities,
                channel_username=target.chat.username,
                author=author,
                channel_id_line=cfg.channel_id_line,
                author_line=cfg.author_line,
            )
            if utf16_len(full.text) <= limit:
                return full
            bare = strip_ids(text, entities)  # no room for the signature
            return bare if utf16_len(bare.text) <= limit else None

        publish = self._cfg.pipeline.publish
        if len(items) == 1:
            item = items[0]
            if item.get("kind") == "text":
                if not strip_ids(
                    str(item.get("text") or ""), list(item.get("entities") or [])
                ).text:
                    return Relay("empty")
                text = styled(item, publish.message_limit)
                return Relay("text", text) if text is not None else Relay("copy")
            if item.get("kind") in CAPTIONED:
                caption = styled(item, publish.caption_limit)
                return Relay("caption", caption) if caption is not None else Relay("copy")
            return Relay("copy")  # stickers, round videos: no caption to change
        if all(i.get("kind") in ALBUM_KINDS and i.get("file_id") for i in items):
            index = next((n for n, i in enumerate(items) if i.get("text")), 0)
            caption = styled(items[index], publish.caption_limit)
            if caption is not None:
                return Relay("album", caption, index)
        return Relay("copy")

    async def _copy(self, ctx: RunContext, target: Target, article: Article) -> Delivery:
        assert ctx.bot is not None
        tg = article.telegram or {}
        relay = self.relay(article, target)
        if relay.kind != "copy" and relay.styled is not None:
            return await self._resend(ctx, target, tg, relay)
        message_ids = [int(m) for m in tg.get("message_ids", [])]
        if len(message_ids) == 1:
            result = await ctx.bot.call(
                "copyMessage",
                {
                    "chat_id": target.chat.api_value,
                    "from_chat_id": tg["chat_id"],
                    "message_id": message_ids[0],
                },
            )
            return Delivery("copyMessage", [int(result["message_id"])], None)
        result = await ctx.bot.call(
            "copyMessages",
            {
                "chat_id": target.chat.api_value,
                "from_chat_id": tg["chat_id"],
                "message_ids": sorted(message_ids),
            },
        )
        return Delivery("copyMessages", [int(r["message_id"]) for r in result], None)

    async def _resend(
        self, ctx: RunContext, target: Target, tg: dict[str, Any], relay: Relay
    ) -> Delivery:
        """A source-channel post re-sent without the source's IDs, signed for the target."""
        assert ctx.bot is not None
        assert relay.styled is not None
        styled, items = relay.styled, list(tg.get("items") or [])
        if relay.kind == "text":
            result = await ctx.bot.call(
                "sendMessage",
                {
                    "chat_id": target.chat.api_value,
                    "text": styled.text,
                    "entities": styled.entities,
                },
            )
            return Delivery("sendMessage", [int(result["message_id"])], styled.text)
        if relay.kind == "caption":
            result = await ctx.bot.call(
                "copyMessage",
                {
                    "chat_id": target.chat.api_value,
                    "from_chat_id": tg["chat_id"],
                    "message_id": int(items[0]["message_id"]),
                    "caption": styled.text,
                    "caption_entities": styled.entities,
                },
            )
            return Delivery("copyMessage", [int(result["message_id"])], styled.text)
        media = []
        for n, item in enumerate(items):
            entry: dict[str, Any] = {"type": item["kind"], "media": item["file_id"]}
            if n == relay.caption_index:
                entry.update(caption=styled.text, caption_entities=styled.entities)
            media.append(entry)
        result = await ctx.bot.call(
            "sendMediaGroup", {"chat_id": target.chat.api_value, "media": media}
        )
        return Delivery("sendMediaGroup", [int(r["message_id"]) for r in result], styled.text)

    # ---------------------------------------------------------------- edits (Phase 5)
    async def edit_relayed(
        self, repos: Repositories, ctx: RunContext, article: Article, post: PublishedPost
    ) -> str:
        """The source post was edited: edit the bot's copy with the same rule (rebrand/copy)."""
        assert ctx.target is not None
        tg = article.telegram or {}
        items = list(tg.get("items") or [])
        relay = self.relay(article, ctx.target)
        if relay.kind == "empty":
            return "edit:empty"
        if relay.styled is not None:
            text, entities = relay.styled.text, relay.styled.entities
            index = relay.caption_index if relay.kind == "album" else 0
            as_caption = relay.kind in ("caption", "album")
        elif items:  # copy mode: the copy gets the edited text unchanged
            index = next((n for n, i in enumerate(items) if i.get("text")), 0)
            text = str(items[index].get("text") or "")
            entities = list(items[index].get("entities") or [])
            as_caption = items[index].get("kind") != "text"
        else:
            return "edit:not_editable"
        if index >= len(post.message_ids):
            return "edit:not_editable"
        method = "editMessageCaption" if as_caption else "editMessageText"
        payload: dict[str, Any] = {
            "chat_id": ctx.target.chat.api_value,
            "message_id": post.message_ids[index],
            ("caption" if as_caption else "text"): text,
            ("caption_entities" if as_caption else "entities"): entities,
        }
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"=== [dry-run] {method} {post.message_ids[index]}\n{text}\n")
            return "edit:preview"
        try:
            await ctx.bot.call(method, payload)
        except TelegramNotSent as exc:
            if "not modified" in (exc.description or ""):
                return "edit:unchanged"
            return "edit:failed"
        post.text = text
        story = await repos.stories.get(article.cluster_id)
        if story is not None:
            timeline_event(
                story, ctx.now().isoformat(), "source_post_edited", article_id=article.id
            )
        await repos.commit()
        return "edit:applied"


def _reply(message_id: int | None) -> dict[str, Any]:
    if message_id is None:
        return {}
    return {"reply_parameters": {"message_id": message_id, "allow_sending_without_reply": True}}
