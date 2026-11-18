"""PUBLISH: queued items → the target channel, at most once each (ADR-004).

Protocol per item: claim (unique idempotency key, committed) → send → record (committed).
- definite failure → ``failed`` (retried while attempts remain; chat-level errors stop the run)
- unknown outcome (timeout after sending, 5xx) → ``uncertain``: never re-sent, owner told
- a claim left behind by a crashed run → ``uncertain`` as well
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import timedelta
from typing import Any

from wanger_news.adapters.telegram.client import (
    TelegramNotSent,
    TelegramRateLimited,
    TelegramUncertain,
)
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, PublishedPost
from wanger_news.domain.enums import ArticleStatus, JobStatus, PostStatus, Stage, Transport
from wanger_news.formatting.telegram_html import esc, split_html
from wanger_news.formatting.templates_fa import PostInput, RenderedPost, render_article
from wanger_news.services.context import RunContext, Target

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

    def post_input(self, article: Article) -> PostInput:
        source = self._cfg.source(article.source_id)
        images = article.images or []
        hashtags = (article.classification or {}).get("hashtags") or []
        return PostInput(
            title=article.title_original,
            teaser=article.description_original or article.content_original,
            source_name=source.name if source else article.source_id,
            url=article.canonical_url or article.url or "",
            published_at=article.published_at,
            language=article.language,
            hashtags=list(hashtags),
            image_url=images[0]["url"] if images else None,
        )

    def render(self, article: Article) -> RenderedPost:
        return render_article(
            self.post_input(article), self._cfg.pipeline.publish, self._cfg.pipeline.timezone
        )

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
        candidates = await repos.articles.by_status(ArticleStatus.QUEUED, limit * 4 + 10)
        for article in candidates:
            if report.sent + report.previewed >= limit:
                break
            now = ctx.now()
            human = article.transport == Transport.TELEGRAM_CHANNEL.value
            if not human and article.effective_at < now - max_age:
                await repos.articles.set_status(
                    article, ArticleStatus.EXPIRED, now, "too old to publish"
                )
                await repos.commit()
                report.expired += 1
                continue
            if ctx.dry_run:
                self._preview(ctx, article)
                report.previewed += 1
                continue
            stop = await self._publish_one(repos, ctx, ctx.target, article, report)
            if stop:
                break
            if cfg.min_interval_seconds and report.sent < limit:
                await self._sleep(cfg.min_interval_seconds)
        return report

    def _preview(self, ctx: RunContext, article: Article) -> None:
        header = f"=== [dry-run] #{article.id} {article.source_id} priority={article.priority}"
        if article.transport == Transport.TELEGRAM_CHANNEL.value:
            tg = article.telegram or {}
            ctx.out(
                f"{header} → copy {tg.get('message_ids')} from {tg.get('chat_id')} "
                f"to {ctx.target.chat if ctx.target else '-'}\n{article.title_original}\n"
            )
            return
        rendered = self.render(article)
        photo = f" (photo: {rendered.photo_url})" if rendered.photo_url else ""
        ctx.out(f"{header}{photo}\n{rendered.text}\n")

    async def _publish_one(
        self,
        repos: Repositories,
        ctx: RunContext,
        target: Target,
        article: Article,
        report: PublishReport,
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
        await repos.commit()  # the claim is durable BEFORE anything is sent

        try:
            delivery = await self._deliver(ctx, target, article)
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
        await repos.articles.set_status(
            article, ArticleStatus.PUBLISHED, now, f"sent to {target.role.value}"
        )
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
            article = await repos.articles.get(post.article_id)
            if article is not None:
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

    # ---------------------------------------------------------------- Bot API calls
    async def _deliver(self, ctx: RunContext, target: Target, article: Article) -> Delivery:
        assert ctx.bot is not None
        if article.transport == Transport.TELEGRAM_CHANNEL.value:
            return await self._copy(ctx, target, article)
        rendered = self.render(article)
        if rendered.photo_url:
            try:
                result = await ctx.bot.call(
                    "sendPhoto",
                    {
                        "chat_id": target.chat.api_value,
                        "photo": rendered.photo_url,
                        "caption": rendered.text,
                        "parse_mode": "HTML",
                    },
                )
                return Delivery("sendPhoto", [int(result["message_id"])], rendered.text)
            except TelegramNotSent as exc:
                if not any(m in (exc.description or "").lower() for m in PHOTO_ERRORS):
                    raise
                rendered = render_article(
                    replace(self.post_input(article), image_url=None),
                    self._cfg.pipeline.publish,
                    self._cfg.pipeline.timezone,
                )
        return await self._send_text(ctx, target, rendered.text)

    async def _send_text(self, ctx: RunContext, target: Target, text: str) -> Delivery:
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
            try:
                result = await ctx.bot.call("sendMessage", payload)
            except TelegramNotSent as exc:
                if ids:  # part of the post is out: a retry would repeat it
                    raise TelegramUncertain(f"partially sent ({len(ids)} parts): {exc}") from exc
                raise
            ids.append(int(result["message_id"]))
        return Delivery("sendMessage", ids, text)

    async def _copy(self, ctx: RunContext, target: Target, article: Article) -> Delivery:
        assert ctx.bot is not None
        tg = article.telegram or {}
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
