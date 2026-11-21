"""Human in the loop (spec §11): review cards in the admins' private chats.

A card shows why the item needs a human, its scores, the guard's issues and the exact post that
would be published, with ✅ Approve · 📤 Publish now · ✏️ Edit · ❌ Reject. The bot has no server,
so taps and edits are read on the next run (getUpdates) — the card says so.

- Approve → queued (posted in priority order). Publish now → queued ahead of everything, in the
  next publish stage, outside the per-run cap.
- Edit → the bot asks for the new text as a reply; the reply becomes a human summary and a new
  card is sent (it still needs Approve/Publish).
- Every card of an item is closed (buttons replaced by the outcome) when anyone decides.
- Items waiting longer than ``review.expire_after_hours`` expire.
"""

from __future__ import annotations

import contextlib
import logging
from datetime import timedelta
from typing import Any

from wanger_news.adapters.telegram.client import TelegramError
from wanger_news.adapters.telegram.types import CallbackQuery, Message
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, ReviewRequest, Summary
from wanger_news.domain import guard as guard_layer1
from wanger_news.domain.claims import STATUS_FA as CLAIM_STATUS_FA
from wanger_news.domain.claims import summarize_statuses
from wanger_news.domain.enums import (
    ArticleStatus,
    ClusterRole,
    JobStatus,
    ReviewAction,
    SourceType,
    Stage,
    SummaryOrigin,
    Transport,
)
from wanger_news.domain.guard import GuardReport
from wanger_news.domain.scoring import confidence, label
from wanger_news.domain.summary import SummaryDraft
from wanger_news.domain.text import to_persian_digits
from wanger_news.formatting.telegram_html import esc
from wanger_news.formatting.templates_fa import ReviewCard, reason_fa, render_review_card
from wanger_news.services.context import RunContext
from wanger_news.services.posts import PostBuilder

log = logging.getLogger("wanger_news.review")

CALLBACK_PREFIX = "rv"
ACTION_CODES = {
    "a": ReviewAction.APPROVE,
    "p": ReviewAction.PUBLISH,
    "e": ReviewAction.EDIT,
    "r": ReviewAction.REJECT,
}
CODES = {action: code for code, action in ACTION_CODES.items()}
DECIDABLE = {
    ArticleStatus.PENDING_REVIEW.value,
    ArticleStatus.HELD.value,
    ArticleStatus.QUEUED.value,
    ArticleStatus.AI_PENDING.value,
}
OUTCOME_FA = {
    ReviewAction.APPROVE: "✅ تأیید شد — در صف انتشار",
    ReviewAction.PUBLISH: "📤 در اجرای بعدی منتشر می‌شود",
    ReviewAction.REJECT: "❌ رد شد",
    "edited": "✏️ ویرایش شد — کارت تازه فرستاده شد",
    "expired": "⌛ منقضی شد",
    "closed": "بسته شد",
}


def callback_data(action: ReviewAction, article_id: int) -> str:
    return f"{CALLBACK_PREFIX}:{CODES[action]}:{article_id}"


def parse_callback(data: str | None) -> tuple[ReviewAction, int] | None:
    parts = (data or "").split(":")
    if len(parts) != 3 or parts[0] != CALLBACK_PREFIX or parts[1] not in ACTION_CODES:
        return None
    try:
        return ACTION_CODES[parts[1]], int(parts[2])
    except ValueError:
        return None


def keyboard(article_id: int, *, has_text: bool) -> dict[str, Any]:
    first = []
    if has_text:
        first = [
            {"text": "✅ تأیید", "callback_data": callback_data(ReviewAction.APPROVE, article_id)},
            {
                "text": "📤 انتشار فوری",
                "callback_data": callback_data(ReviewAction.PUBLISH, article_id),
            },
        ]
    second = [
        {"text": "✏️ ویرایش", "callback_data": callback_data(ReviewAction.EDIT, article_id)},
        {"text": "❌ رد", "callback_data": callback_data(ReviewAction.REJECT, article_id)},
    ]
    return {"inline_keyboard": [row for row in (first, second) if row]}


def parse_edit(text: str) -> SummaryDraft | None:
    """An admin's text: first line = title, then paragraphs; trailing "•"/"-" lines = key points."""
    lines = [line.rstrip() for line in text.strip().splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    if len(lines) < 2:
        return None
    title, rest = lines[0].strip(), lines[1:]
    points: list[str] = []
    while rest and rest[-1].strip().startswith(("•", "-", "*")):
        points.insert(0, rest.pop().strip().lstrip("•-* ").strip())
    while rest and not rest[-1].strip():
        rest.pop()
    body = "\n".join(rest).strip()
    if not body:
        return None
    return SummaryDraft(title=title, summary=body, key_points=points)


class ReviewService:
    def __init__(self, config: AppConfig, posts: PostBuilder) -> None:
        self._cfg = config
        self._review = config.editorial.review
        self._posts = posts
        self._topics = {t.id: t.name_fa for t in config.categories.sensitive_topics}

    # ---------------------------------------------------------------- cards
    def _recipients(self, ctx: RunContext) -> list[int]:
        if self._review.send_to == "owner":
            return [ctx.owner_id]
        return [ctx.owner_id, *sorted(i for i in ctx.admin_ids if i != ctx.owner_id)]

    async def card_html(self, repos: Repositories, article: Article) -> tuple[str, bool]:
        summary = await repos.summaries.get(article.summary_id)
        rendered = await self._posts.build(repos, article)
        report = GuardReport.from_dict(summary.guard if summary else None)
        cat = self._cfg.categories.get(article.category or "")
        card = ReviewCard(
            article_id=article.id,
            reason=reason_fa(article.review_reason, self._topics),
            importance=article.importance_score,
            confidence=article.confidence_score,
            confidence_label=(
                label(article.confidence_score, self._cfg.pipeline.scoring)
                if article.confidence_score is not None
                else None
            ),
            source_name=self._posts.source_name(article),
            category_tag=cat.hashtag if cat else None,
            issues=guard_layer1.describe(report),
            preview=rendered.text if rendered else None,
            original_title=article.title_original,
            original_url=article.canonical_url or article.url or "",
            **await self._story_lines(repos, article),
        )
        return render_review_card(card, self._review.preview_chars), rendered is not None

    async def _story_lines(self, repos: Repositories, article: Article) -> dict[str, str | None]:
        """Phase 3 lines: independent sources, claim statuses, the story an update belongs to."""
        story = await repos.stories.get(article.cluster_id)
        lines: dict[str, str | None] = {
            "sources_line": None,
            "claims_line": None,
            "update_of": None,
        }
        if story is not None and story.sources:
            names = "، ".join(dict.fromkeys(s["name"] for s in story.sources))
            lines["sources_line"] = (
                f"منابع مستقل: {to_persian_digits(str(len(story.sources)))} ({names})"
            )
        if (
            story is not None
            and article.cluster_role == ClusterRole.UPDATE.value
            and story.published_at is not None
        ):
            lines["update_of"] = story.title or ""
        claims = await repos.stories.claims_for(article.summary_id)
        if claims:
            counts = summarize_statuses([c.status for c in claims])
            lines["claims_line"] = "ادعاها: " + "، ".join(
                f"{to_persian_digits(str(n))} {CLAIM_STATUS_FA.get(status, status)}"
                for status, n in sorted(counts.items(), key=lambda kv: -kv[1])
            )
        return lines

    async def send_cards(self, repos: Repositories, ctx: RunContext) -> int:
        await self._expire(repos, ctx)
        if self._review.max_cards_per_run == 0:
            return 0
        sent = 0
        for article in await repos.reviews.needing_cards(self._review.max_cards_per_run):
            html_text, has_text = await self.card_html(repos, article)
            markup = keyboard(article.id, has_text=has_text)
            for admin in self._recipients(ctx):
                message_id = await self._send(ctx, admin, html_text, markup)
                if message_id is None and not ctx.dry_run:
                    continue
                await repos.reviews.add(
                    ReviewRequest(
                        article_id=article.id,
                        kind="card",
                        admin_id=admin,
                        chat_id=admin,
                        message_id=message_id,
                        status="open",
                        created_at=ctx.now(),
                    )
                )
            await repos.jobs.record(
                article.id,
                Stage.REVIEW,
                JobStatus.DONE,
                ctx.run_id,
                ctx.now(),
                details={"card": True},
            )
            await repos.commit()
            sent += 1
        return sent

    async def _send(
        self, ctx: RunContext, chat_id: int, html_text: str, markup: dict[str, Any] | None
    ) -> int | None:
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [review card to {chat_id}] ---\n{html_text}\n")
            return None
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": html_text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        if markup:
            payload["reply_markup"] = markup
        try:
            result = await ctx.bot.call("sendMessage", payload)
        except TelegramError as exc:  # e.g. an admin who never started the bot
            log.warning("review_card_failed", extra={"chat_id": chat_id, "error": str(exc)[:200]})
            return None
        return int(result["message_id"])

    async def _close_cards(
        self, repos: Repositories, ctx: RunContext, article_id: int, outcome: str, by: int | None
    ) -> None:
        text = OUTCOME_FA.get(outcome, outcome)
        for request in await repos.reviews.open_for(article_id):
            await repos.reviews.close(request, outcome, ctx.now(), by)
            if request.kind != "card" or request.message_id is None:
                continue
            if ctx.dry_run or ctx.bot is None:
                ctx.out(f"--- [card #{article_id} closed: {text}] ---")
                continue
            # replace the buttons with the outcome; the card text stays as a record.
            # A deleted or too old message cannot be edited: the decision stands anyway.
            with contextlib.suppress(TelegramError):
                await ctx.bot.call(
                    "editMessageReplyMarkup",
                    {
                        "chat_id": request.chat_id,
                        "message_id": request.message_id,
                        "reply_markup": {
                            "inline_keyboard": [
                                [
                                    {
                                        "text": text,
                                        "callback_data": f"{CALLBACK_PREFIX}:x:{article_id}",
                                    }
                                ]
                            ]
                        },
                    },
                )

    async def _expire(self, repos: Repositories, ctx: RunContext) -> None:
        """Waiting too long makes news stale: pending items after review.expire_after_hours,
        held (manual-mode) items after publish.max_publish_age_hours."""
        now = ctx.now()
        waits = {
            ArticleStatus.PENDING_REVIEW: timedelta(hours=self._review.expire_after_hours),
            ArticleStatus.HELD: timedelta(hours=self._cfg.pipeline.publish.max_publish_age_hours),
        }
        for status, wait in waits.items():
            for article in await repos.articles.by_status(status, 500):
                if article.transport == Transport.RSS.value and article.updated_at < now - wait:
                    await repos.articles.set_status(
                        article, ArticleStatus.EXPIRED, now, "nobody decided in time"
                    )
                    await self._close_cards(repos, ctx, article.id, "expired", None)
        await repos.commit()

    # ---------------------------------------------------------------- decisions
    async def decide(
        self,
        repos: Repositories,
        ctx: RunContext,
        article_id: int,
        action: ReviewAction,
        admin_id: int,
    ) -> str:
        """Shared by the buttons and the /approve /reject /publish commands. Returns a short
        Persian answer for the admin."""
        article = await repos.articles.get(article_id)
        if article is None:
            return "خبری با این شماره پیدا نشد."
        if article.status not in DECIDABLE:
            return f"این خبر دیگر منتظر تصمیم نیست (وضعیت: {article.status})."
        now = ctx.now()
        if action is ReviewAction.EDIT:
            await self._ask_for_edit(repos, ctx, article, admin_id)
            return "✏️ متن تازه را در پاسخ (Reply) به پیامی که فرستادم بنویسید."
        if action is ReviewAction.REJECT:
            article.review_reason = f"rejected by {admin_id}"
            await repos.articles.set_status(
                article, ArticleStatus.REJECTED, now, f"rejected by {admin_id}"
            )
            await self._close_cards(repos, ctx, article.id, action.value, admin_id)
            await self._log(repos, ctx, article, action, admin_id)
            return OUTCOME_FA[action]
        human_source = article.transport == Transport.TELEGRAM_CHANNEL.value
        if not human_source and article.summary_id is None:
            return "متن فارسی آماده نیست؛ اول «✏️ ویرایش» را بزنید و متن را بنویسید."
        article.approved_by = admin_id
        article.approved_at = now
        article.publish_now = action is ReviewAction.PUBLISH
        article.review_reason = None
        await repos.articles.set_status(
            article, ArticleStatus.QUEUED, now, f"{action.value} by {admin_id}"
        )
        await self._close_cards(repos, ctx, article.id, action.value, admin_id)
        await self._log(repos, ctx, article, action, admin_id)
        return OUTCOME_FA[action]

    async def _log(
        self,
        repos: Repositories,
        ctx: RunContext,
        article: Article,
        action: ReviewAction,
        admin_id: int,
    ) -> None:
        await repos.jobs.record(
            article.id,
            Stage.REVIEW,
            JobStatus.DONE,
            ctx.run_id,
            ctx.now(),
            details={"action": action.value, "by": admin_id},
        )
        await ctx.event(
            repos,
            "info",
            "review_decision",
            article_id=article.id,
            action=action.value,
            admin=admin_id,
        )

    async def _ask_for_edit(
        self, repos: Repositories, ctx: RunContext, article: Article, admin_id: int
    ) -> None:
        summary = await repos.summaries.get(article.summary_id)
        current = ""
        if summary is not None:
            current = "\n".join(
                [summary.title, "", summary.summary, *(f"• {p}" for p in summary.key_points or [])]
            )
        text = (
            f"✏️ <b>ویرایش خبر #{article.id}</b>\n"
            "متن تازه را در پاسخ (Reply) به همین پیام بفرستید: خط اول عنوان، بعد متن خبر؛ "
            "خط‌هایی که با • شروع شوند نکته‌های کلیدی‌اند.\n\n"
            + (f"<code>{esc(current[:3000])}</code>" if current else "")
        )
        message_id = None
        if not ctx.dry_run and ctx.bot is not None:
            try:
                result = await ctx.bot.call(
                    "sendMessage",
                    {
                        "chat_id": admin_id,
                        "text": text,
                        "parse_mode": "HTML",
                        "reply_markup": {
                            "force_reply": True,
                            "input_field_placeholder": "متن تازه",
                        },
                    },
                )
                message_id = int(result["message_id"])
            except TelegramError as exc:
                log.warning("edit_prompt_failed", extra={"error": str(exc)[:200]})
                return
        else:
            ctx.out(f"--- [edit prompt to {admin_id}] ---\n{text}\n")
        await repos.reviews.add(
            ReviewRequest(
                article_id=article.id,
                kind="edit_prompt",
                admin_id=admin_id,
                chat_id=admin_id,
                message_id=message_id,
                status="open",
                created_at=ctx.now(),
            )
        )

    # ---------------------------------------------------------------- updates
    async def on_callback(self, repos: Repositories, ctx: RunContext, query: CallbackQuery) -> str:
        if query.from_user.id not in ctx.admin_ids:
            await self._answer(ctx, query.id, "اجازهٔ این کار را ندارید.")
            return "ignored:not_admin"
        parsed = parse_callback(query.data)
        if parsed is None:
            await self._answer(ctx, query.id, "")
            return "ignored:callback"
        action, article_id = parsed
        answer = await self.decide(repos, ctx, article_id, action, query.from_user.id)
        await self._answer(ctx, query.id, answer)
        return f"review:{action.value}"

    async def _answer(self, ctx: RunContext, query_id: str, text: str) -> None:
        if ctx.dry_run or ctx.bot is None:
            return
        # answered too late (the next run): Telegram refuses, the decision stands
        with contextlib.suppress(TelegramError):
            await ctx.bot.call(
                "answerCallbackQuery", {"callback_query_id": query_id, "text": text[:190]}
            )

    async def on_edit_reply(
        self, repos: Repositories, ctx: RunContext, message: Message
    ) -> str | None:
        """None when the message is not a reply to one of our edit prompts."""
        reply = message.reply_to_message
        if reply is None:
            return None
        request = await repos.reviews.edit_prompt(message.chat.id, reply.message_id)
        if request is None:
            return None
        article = await repos.articles.get(request.article_id)
        draft = parse_edit(message.body)
        if article is None or article.status not in DECIDABLE:
            await repos.reviews.close(request, "closed", ctx.now(), message.chat.id)
            return "review:edit_too_late"
        if draft is None:
            await self._send(
                ctx,
                message.chat.id,
                "متن کوتاه است: خط اول عنوان و حداقل یک خط متن لازم است. "
                "دوباره در پاسخ به همان پیام بفرستید.",
                None,
            )
            return "review:edit_invalid"
        await self._save_edit(repos, ctx, article, draft, message.chat.id)
        await repos.reviews.close(request, "edited", ctx.now(), message.chat.id)
        return "review:edited"

    async def _save_edit(
        self,
        repos: Repositories,
        ctx: RunContext,
        article: Article,
        draft: SummaryDraft,
        admin_id: int,
    ) -> None:
        now = ctx.now()
        previous = await repos.summaries.get(article.summary_id)
        source_text = f"{article.title_original}\n\n{article.description_original}"
        # advisory only: a human wrote it and a human approves it, but show what does not match
        report = guard_layer1.check(draft, [source_text], self._cfg.pipeline.guard)
        summary = await repos.summaries.add(
            Summary(
                article_id=article.id,
                language=self._cfg.pipeline.ai.output_language,
                origin=SummaryOrigin.HUMAN.value,
                prompt_version="human",
                model=None,
                source_hash=previous.source_hash if previous else "human",
                title=draft.title,
                summary=draft.summary,
                key_points=draft.key_points,
                entities=[],
                quotes=[],
                claims=[],
                category=article.category,
                importance_factors=previous.importance_factors if previous else None,
                insufficient=False,
                guard=report.as_dict(),
                valid=True,
                created_by=admin_id,
                created_at=now,
            )
        )
        article.summary_id = summary.id
        source = self._cfg.source(article.source_id)
        conf = confidence(
            reliability=source.reliability_score if source else 50,
            source_type=source.source_type if source else SourceType.BLOG,
            quality=article.quality_score or 0,
            guard_state="human",
            independent_sources=1,
            cfg=self._cfg.pipeline.scoring,
        )
        article.confidence_score, article.confidence = conf.value, conf.as_dict()
        article.review_reason = "human_edit"
        await repos.articles.set_status(article, ArticleStatus.PENDING_REVIEW, now, "human_edit")
        await self._close_cards(repos, ctx, article.id, "edited", admin_id)
