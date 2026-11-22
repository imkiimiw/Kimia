"""Corrections (Phase 5, spec §10): «⚠️ اصلاح خبر» as a reply under the published post.

Two origins:
- the AI, when a new report about a published story says a published fact was wrong
  (``corrections`` in the update answer), checked by ``domain/corrections.check``;
- an admin: ``/correct <news id> | item | wrong value | correct value | source``.
Either way a card goes to the admins (✅ publish / ❌ reject); only an approved correction is
posted, in the publish stage (so a pause, a dry run and the at-most-once key all apply).
"""

from __future__ import annotations

import logging
from typing import Any

from wanger_news.adapters.telegram.client import TelegramError
from wanger_news.adapters.telegram.types import CallbackQuery
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Correction, StoryCluster
from wanger_news.domain.corrections import Proposal, check, correction_text
from wanger_news.domain.text import to_ascii_digits
from wanger_news.formatting.telegram_html import esc
from wanger_news.formatting.templates_fa import render_correction, render_correction_card
from wanger_news.services.context import RunContext
from wanger_news.services.publish import PublishService
from wanger_news.services.stories import timeline_event

log = logging.getLogger("wanger_news")

PROPOSED, APPROVED, PUBLISHED, REJECTED, INVALID = (
    "proposed",
    "approved",
    "published",
    "rejected",
    "invalid",
)


def published_text(story: StoryCluster) -> str:
    said = story.published_text or {}
    parts = [str(said.get("title") or ""), str(said.get("summary") or "")]
    parts += [str(p) for p in said.get("key_points") or []]
    for update in said.get("updates") or []:
        parts += [str(update.get("title") or ""), str(update.get("summary") or "")]
    return "\n".join(parts)


class CorrectionService:
    def __init__(self, config: AppConfig, publisher: PublishService) -> None:
        self._cfg = config
        self._publisher = publisher

    # ---------------------------------------------------------------- proposals
    async def propose(
        self,
        repos: Repositories,
        ctx: RunContext,
        story: StoryCluster,
        proposals: list[dict[str, Any]],
        sources: dict[str, str],
        names: dict[str, str],
    ) -> int:
        """Store the AI's proposals; those failing the check are kept as ``invalid`` (for the
        record), the others wait for a human. Returns how many wait."""
        waiting = 0
        text = published_text(story)
        for raw in proposals:
            proposal = Proposal(
                item=str(raw.get("item", "")),
                old=str(raw.get("old", "")),
                new=str(raw.get("new", "")),
                source_id=str(raw.get("source_id", "")),
                evidence=str(raw.get("evidence", "")),
            )
            problems = check(
                proposal,
                published=text,
                sources=sources,
                min_similarity=self._cfg.pipeline.guard.evidence_min_similarity,
            )
            source_article = proposal.source_id[1:] if proposal.source_id[1:].isdigit() else None
            row = await repos.corrections.add(
                Correction(
                    cluster_id=story.id,
                    article_id=story.lead_article_id,
                    source_article_id=int(source_article) if source_article else None,
                    source_name=names.get(proposal.source_id, proposal.source_id)[:120],
                    item=proposal.item,
                    old_value=proposal.old,
                    new_value=proposal.new,
                    evidence=proposal.evidence,
                    origin="ai",
                    status=INVALID if problems else PROPOSED,
                    problems=problems,
                    review_messages=[],
                    created_at=ctx.now(),
                )
            )
            timeline_event(
                story,
                ctx.now().isoformat(),
                "correction_proposed" if not problems else "correction_refused",
                correction_id=row.id,
            )
            waiting += 0 if problems else 1
        return waiting

    async def from_admin(
        self, repos: Repositories, ctx: RunContext, args: str, admin_id: int
    ) -> str:
        """/correct 12 | شمار مصدومان | ۲۰ | ۲۵ | رویترز"""
        parts = [p.strip() for p in args.split("|")]
        if len(parts) != 5 or not to_ascii_digits(parts[0]).lstrip("#").isdigit():
            return (
                "قالب: /correct شمارهٔ_خبر | مورد | مقدار اشتباه | مقدار درست | منبع\n"
                "مثال: /correct 12 | شمار مصدومان | ۲۰ | ۲۵ | رویترز"
            )
        article = await repos.articles.get(int(to_ascii_digits(parts[0]).lstrip("#")))
        story = await repos.stories.get(article.cluster_id) if article is not None else None
        if story is None or story.published_at is None:
            return "این خبر منتشر نشده یا عضو هیچ رویدادی نیست."
        if not all(parts[1:]):
            return "هیچ‌کدام از بخش‌ها نباید خالی باشد."
        row = await repos.corrections.add(
            Correction(
                cluster_id=story.id,
                article_id=story.lead_article_id,
                source_article_id=None,
                source_name=parts[4][:120],
                item=parts[1],
                old_value=parts[2],
                new_value=parts[3],
                evidence=None,
                origin="human",
                status=PROPOSED,
                problems=[],
                review_messages=[],
                decided_by=admin_id,
                created_at=ctx.now(),
            )
        )
        timeline_event(story, ctx.now().isoformat(), "correction_proposed", correction_id=row.id)
        return f"✅ پیشنهاد اصلاح #{row.id} ثبت شد؛ کارت تأیید آن در همین اجرا می‌آید."

    # ---------------------------------------------------------------- cards
    async def send_cards(self, repos: Repositories, ctx: RunContext) -> int:
        sent = 0
        for row in await repos.corrections.by_status(PROPOSED, 10):
            if row.review_messages:
                continue
            story = await repos.stories.get(row.cluster_id)
            title = str(((story.published_text or {}) if story else {}).get("title") or "")
            text = render_correction_card(
                row.id, title, self.sentence(row), row.evidence, row.origin
            )
            markup = {
                "inline_keyboard": [
                    [
                        {"text": "✅ انتشار اصلاحیه", "callback_data": f"cr:a:{row.id}"},
                        {"text": "❌ رد", "callback_data": f"cr:r:{row.id}"},
                    ]
                ]
            }
            messages = []
            for admin in [ctx.owner_id, *sorted(i for i in ctx.admin_ids if i != ctx.owner_id)]:
                message_id = await self._send(ctx, admin, text, markup)
                if message_id is not None:
                    messages.append({"chat_id": admin, "message_id": message_id})
            row.review_messages = messages or [{"chat_id": ctx.owner_id, "message_id": 0}]
            await repos.commit()
            sent += 1
        return sent

    async def on_callback(self, repos: Repositories, ctx: RunContext, query: CallbackQuery) -> str:
        parts = (query.data or "").split(":")
        if len(parts) != 3 or not parts[2].isdigit() or parts[1] not in ("a", "r"):
            return "ignored:bad_callback"
        if query.from_user.id not in ctx.admin_ids:
            return "ignored:not_admin"
        row = await repos.corrections.get(int(parts[2]))
        if row is None or row.status != PROPOSED:
            await self._close(ctx, row, "این پیشنهاد قبلاً تصمیم گرفته شده است.")
            return "correction:already_decided"
        row.status = APPROVED if parts[1] == "a" else REJECTED
        row.decided_by, row.decided_at = query.from_user.id, ctx.now()
        await repos.commit()
        outcome = (
            "✅ تأیید شد؛ در اجرای انتشار زیر پست اصلی می‌رود."
            if row.status == APPROVED
            else "❌ رد شد."
        )
        await self._close(ctx, row, outcome)
        return f"correction:{row.status}"

    # ---------------------------------------------------------------- publishing
    async def publish_approved(self, repos: Repositories, ctx: RunContext) -> int:
        sent = 0
        for row in await repos.corrections.by_status(APPROVED, 10):
            story = await repos.stories.get(row.cluster_id)
            if story is None:
                continue
            reply_to = (
                story.post_message_id
                if ctx.target is not None and story.post_chat == ctx.target.key
                else None
            )
            outcome = await self._publisher.send_extra(
                repos,
                ctx,
                key=f"correction:{row.id}",
                kind="correction",
                text=render_correction(self.sentence(row)),
                reply_to=reply_to,
            )
            if outcome in ("sent", "exists"):
                row.status = PUBLISHED
                if outcome == "sent" and ctx.target is not None:
                    row.post_chat = ctx.target.key
                    ids = self._publisher.last_message_ids
                    row.post_message_id = ids[0] if ids else None
                timeline_event(
                    story, ctx.now().isoformat(), "correction_published", correction_id=row.id
                )
                await repos.commit()
                sent += 1
        return sent

    @staticmethod
    def sentence(row: Correction) -> str:
        return correction_text(row.item, row.old_value, row.new_value, row.source_name)

    # ---------------------------------------------------------------- Bot API
    async def _send(
        self, ctx: RunContext, chat_id: int, text: str, markup: dict[str, Any]
    ) -> int | None:
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [correction card to {chat_id}] ---\n{text}\n")
            return None
        try:
            result = await ctx.bot.call(
                "sendMessage",
                {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "reply_markup": markup},
            )
        except TelegramError as exc:
            log.warning("correction_card_failed", extra={"error": str(exc)[:200]})
            return None
        return int(result["message_id"])

    async def _close(self, ctx: RunContext, row: Correction | None, outcome: str) -> None:
        if row is None or ctx.dry_run or ctx.bot is None:
            return
        for message in row.review_messages or []:
            if not message.get("message_id"):
                continue
            try:
                await ctx.bot.call(
                    "editMessageReplyMarkup",
                    {
                        "chat_id": message["chat_id"],
                        "message_id": message["message_id"],
                        "reply_markup": {
                            "inline_keyboard": [[{"text": outcome, "callback_data": "noop"}]]
                        },
                    },
                )
            except TelegramError:
                continue
        _ = esc
