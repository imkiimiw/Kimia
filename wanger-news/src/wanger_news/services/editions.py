"""EDITIONS stage (Phase 6): personalization per channel and multilingual output.

Each edition channel gets a filtered copy of what was published in the MAIN channel
(``editions.follow``): its categories, minimum importance, breaking only, updates, source posts
(``domain/editions.selects``). Nothing new is decided here — an edition only narrows. Updates
reply to the story's post in the same edition; an update whose story never went to the edition
is skipped there.

English editions: the verified Persian summary is rendered in English by the AI (``localize``,
prompt ``localize.en.v1``) inside the same paced daily quota, checked by the English guard
(``domain/editions.check_english``) and stored as a ``summaries`` row (language ``en``). A text
that fails the guard is never posted; the item is skipped for that edition. Human-curated
source-channel posts and conflicting stories are never machine-translated.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta

from wanger_news.ai.provider import AIBudgetExhausted, AIError, AIProvider
from wanger_news.config.models import AppConfig, EditionConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import AIRun, Article, PublishedPost, StoryCluster, Summary
from wanger_news.domain.chatref import ChatRefError
from wanger_news.domain.editions import EditionItem, check_english, selects
from wanger_news.domain.enums import AIRunStatus, ChannelRole, ClusterRole, Transport
from wanger_news.domain.scoring import label
from wanger_news.formatting.telegram_html import esc
from wanger_news.formatting.templates_en import EnglishPost, render_summary_en
from wanger_news.formatting.templates_fa import RenderedPost
from wanger_news.services.context import RunContext, Target
from wanger_news.services.publish import PublishService, idempotency_key
from wanger_news.services.stories import text_of

MAX_LOCALIZE_ATTEMPTS = 2  # per article and language; then the item stays Persian-only
MAX_ITEMS = 500


@dataclass(slots=True)
class EditionReport:
    skipped: str | None = None
    sent: int = 0
    previewed: int = 0
    failed: int = 0
    translated: int = 0
    translation_rejected: int = 0
    waiting_translation: int = 0
    outcomes: dict[str, int] = field(default_factory=dict)
    sent_articles: list[int] = field(default_factory=list)


class EditionService:
    def __init__(
        self,
        config: AppConfig,
        publisher: PublishService,
        ai: AIProvider | None,
        *,
        allowance: Callable[[Repositories, RunContext], Awaitable[int]] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._cfg = config
        self._editions = config.pipeline.editions
        self._publisher = publisher
        self._ai = ai
        self._allowance = allowance
        self._sleep = sleep
        self._translations_left = 0
        self._ai_calls = 0

    def active(self) -> list[EditionConfig]:
        return [e for e in self._editions.editions if e.active]

    async def run(self, repos: Repositories, ctx: RunContext, *, paused: bool) -> EditionReport:
        report = EditionReport()
        editions = self.active()
        if not self._editions.enabled or not editions:
            report.skipped = "none"
            return report
        if paused:
            report.skipped = "paused"
            return report
        if ctx.target is None:
            report.skipped = "no_target"
            return report
        if self._editions.follow == "main" and ctx.target.role is not ChannelRole.MAIN:
            report.skipped = "test_mode"  # editions only copy what reached the main channel
            return report
        if ctx.bot is None and not ctx.dry_run:
            report.skipped = "no_bot"
            return report
        now = ctx.now()
        rows = await repos.published.items(
            chats=[ctx.target.key],
            since=now - timedelta(hours=self._editions.window_hours),
            limit=MAX_ITEMS,
            oldest_first=True,
        )
        if not rows:
            return report
        self._translations_left = 0
        if self._ai is not None and any(e.language != "fa" for e in editions):
            allowed = await self._allowance(repos, ctx) if self._allowance else 0
            self._translations_left = min(self._editions.max_translations_per_run, allowed)
        reserved = {
            str(chat.api_value).lower() for chat in ctx.channels.values() if chat is not None
        }
        for edition in editions:
            try:
                target = Target(ChannelRole.EDITION, edition.chat_ref)
            except ChatRefError:
                continue
            if target.key in reserved:
                report.outcomes["edition_is_test_or_main"] = 1
                continue
            await self._edition(repos, ctx, edition, target, rows, report)
        return report

    async def _edition(
        self,
        repos: Repositories,
        ctx: RunContext,
        edition: EditionConfig,
        target: Target,
        rows: list[tuple[PublishedPost, Article]],
        report: EditionReport,
    ) -> None:
        sent = 0
        for post, article in rows:
            if sent >= self._editions.max_posts_per_run:
                break
            if await repos.posts.get(idempotency_key(article.id, target)) is not None:
                continue
            story = await repos.stories.get(article.cluster_id)
            source_post = article.transport == Transport.TELEGRAM_CHANNEL.value
            update = post.kind == "update" or article.cluster_role == ClusterRole.UPDATE.value
            item = EditionItem(
                category=article.category,
                importance=article.importance_score or 0,
                breaking=post.breaking,
                update=update,
                source_post=source_post,
                conflicting=bool(story is not None and story.contradictions),
            )
            if selects(edition, item) is not None:
                continue
            reply_to = None
            if update:
                parent = (
                    await repos.published.first_in_chat(story.id, target.key)
                    if story is not None
                    else None
                )
                if parent is None or not parent.message_ids:
                    continue  # the story itself never went to this edition
                reply_to = parent.message_ids[0]
            rendered: RenderedPost | None = None
            if not source_post:
                rendered = await self._render(repos, ctx, edition, target, article, story, post)
                if rendered is None:
                    continue
            if ctx.dry_run:
                body = rendered.text if rendered is not None else article.title_original
                ctx.out(f"=== [dry-run] edition {edition.id} → {target.chat}\n{body}\n")
                report.previewed += 1
                sent += 1
                continue
            outcome = await self._publisher.send_edition(
                repos,
                ctx,
                target,
                article,
                rendered,
                kind="update" if update else "story",
                cluster_id=story.id if story is not None else None,
                reply_to=reply_to,
                breaking=post.breaking,
            )
            report.outcomes[outcome] = report.outcomes.get(outcome, 0) + 1
            if outcome == "sent":
                sent += 1
                report.sent += 1
                report.sent_articles.append(article.id)
            elif outcome in ("failed", "uncertain", "chat_error", "rate_limited"):
                report.failed += 1
            if outcome == "chat_error":
                await ctx.notify_owner(
                    repos,
                    "⛔️ <b>نسخهٔ کانال متوقف شد</b>\n"
                    f"ربات نمی‌تواند در کانال {esc(str(target.chat))} (نسخهٔ {esc(edition.id)}) "
                    "پست بگذارد. ربات باید ادمین آن کانال با اجازهٔ ارسال پست باشد.",
                    kind="edition_chat_error",
                )
                await repos.commit()
                return
            if outcome == "rate_limited":
                return

    async def _render(
        self,
        repos: Repositories,
        ctx: RunContext,
        edition: EditionConfig,
        target: Target,
        article: Article,
        story: StoryCluster | None,
        post: PublishedPost,
    ) -> RenderedPost | None:
        builder = self._publisher.posts
        if edition.language == "fa":
            return await builder.build(
                repos, article, target=target, now=ctx.now(), breaking=post.breaking
            )
        english = await repos.published.summary_in(article.id, edition.language)
        if english is None:
            english = await self._localize(repos, ctx, article, story, edition.language)
        if english is None:
            return None
        update = article.cluster_role == ClusterRole.UPDATE.value
        names, url = await builder.sources(repos, article, story, update)
        images = article.images or []
        status = label(article.confidence_score or 0, self._cfg.pipeline.scoring)
        return render_summary_en(
            EnglishPost(
                title=english.title,
                summary=english.summary,
                key_points=list(english.key_points or []),
                status=status,
                source_names=names,
                source_url=url,
                image_url=images[0]["url"] if images and not update else None,
                breaking=post.breaking,
                update=update,
            ),
            self._cfg.pipeline.publish,
        )

    async def _localize(
        self,
        repos: Repositories,
        ctx: RunContext,
        article: Article,
        story: StoryCluster | None,
        language: str,
    ) -> Summary | None:
        """One verified Persian summary → the edition's language, guarded and stored."""
        verified = await repos.summaries.get(article.summary_id)
        if verified is None or self._ai is None:
            return None
        if await repos.published.attempts_in(article.id, language) >= MAX_LOCALIZE_ATTEMPTS:
            return None
        if self._translations_left <= 0:
            ctx.count(f"edition_waiting_translation:{language}")
            return None
        sources = await self._sources(repos, article, story)
        item = {
            "id": f"a{article.id}",
            "summary": {
                "title": verified.title,
                "summary": verified.summary,
                "key_points": list(verified.key_points or []),
            },
            "sources": [
                {"source_id": f"S{n}", "text": text_of(a, 2000)} for n, a in enumerate(sources)
            ],
        }
        self._translations_left -= 1
        if self._ai_calls:
            await self._sleep(60.0 / self._cfg.pipeline.ai.requests_per_minute)
        self._ai_calls += 1
        record = AIRun(
            run_id=ctx.run_id,
            provider=self._ai.name,
            model=self._ai.model_for("localize"),
            operation="localize",
            prompt_version=self._ai.prompt_version("localize", language),
            article_ids=[article.id],
            started_at=ctx.now(),
        )
        try:
            result = await self._ai.localize(item, language=language)
        except AIError as exc:
            record.status, record.error, record.finished_at = exc.status, str(exc)[:2000], ctx.now()
            await repos.ai_runs.add(record)
            await repos.commit()
            if isinstance(exc, AIBudgetExhausted):
                self._translations_left = 0
            ctx.count(f"edition_translation_failed:{exc.status}")
            return None
        usage = result.usage
        record.status, record.finished_at = AIRunStatus.OK.value, ctx.now()
        if usage is not None:
            record.model, record.prompt_version = usage.model, usage.prompt_version
            record.input_tokens, record.output_tokens = usage.input_tokens, usage.output_tokens
            record.thinking_tokens, record.cost_usd = usage.thinking_tokens, usage.cost_usd
        await repos.ai_runs.add(record)
        out = result.data
        guard = check_english(
            out.title,
            out.summary,
            out.key_points,
            verified="\n".join([verified.title, verified.summary, *verified.key_points]),
            sources="\n".join(text_of(a, 6000) for a in sources),
            names=[str(e.get("original") or "") for e in verified.entities or []],
            cfg=self._cfg.pipeline.guard,
        )
        summary = await repos.summaries.add(
            Summary(
                article_id=article.id,
                language=language,
                origin="localized",
                prompt_version=record.prompt_version,
                model=record.model,
                source_hash=verified.source_hash,
                title=out.title,
                summary=out.summary,
                key_points=list(out.key_points),
                category=verified.category,
                guard=guard.as_dict(),
                valid=guard.passed,
            )
        )
        await repos.commit()
        ctx.count(f"edition_translated:{language}" if guard.passed else "edition_guard_rejected")
        return summary if guard.passed else None

    async def _sources(
        self, repos: Repositories, article: Article, story: StoryCluster | None
    ) -> list[Article]:
        """The reports the verified summary was made from (the story's sources, max 5)."""
        out = [article]
        if story is not None:
            for entry in (story.sources or [])[:5]:
                aid = entry.get("article_id")
                if aid and int(aid) != article.id:
                    found = await repos.articles.get(int(aid))
                    if found is not None:
                        out.append(found)
        return out
