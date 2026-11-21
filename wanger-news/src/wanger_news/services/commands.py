"""Admin commands in the bot's private chat (spec §12). Everyone else is ignored silently.

Replies arrive on the next run (no server: ADR-003), so /help says so.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from wanger_news import PHASE, __version__
from wanger_news.adapters.telegram.types import Message
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article
from wanger_news.domain.enums import ArticleStatus, PublishMode, ReviewAction
from wanger_news.domain.jalali import format_tehran
from wanger_news.domain.text import to_ascii_digits, to_persian_digits
from wanger_news.formatting.telegram_html import bold, esc, split_html
from wanger_news.formatting.templates_fa import reason_fa
from wanger_news.services.ai_stage import MODES_KEY, modes_from
from wanger_news.services.context import RunContext
from wanger_news.services.review import ReviewService

PAUSED_KEY = "publishing.paused"
TARGET_KEY = "publish.target"
LATER_PHASE: dict[str, int] = {}

STATUS_FA = {
    "new": "در انتظار پردازش",
    "ai_pending": "در انتظار هوش مصنوعی",
    "held": "آماده (حالت دستی)",
    "rejected": "ردشده",
    "queued": "در صف انتشار",
    "pending_review": "در انتظار بررسی انسانی",
    "published": "منتشرشده",
    "duplicate": "تکراری",
    "filtered": "فیلترشده",
    "throttled": "محدودشده",
    "stale": "قدیمی",
    "expired": "منقضی",
    "failed": "ناموفق",
    "uncertain": "نامشخص",
    "external": "پست دستی در کانال",
}


def parse_command(text: str) -> tuple[str, str] | None:
    if not text.startswith("/"):
        return None
    head, _, rest = text.strip().partition(" ")
    name = head[1:].split("@", 1)[0].lower()
    return (name, rest.strip()) if name else None


class CommandService:
    def __init__(self, config: AppConfig, review: ReviewService) -> None:
        self._cfg = config
        self._review = review

    async def handle(self, repos: Repositories, ctx: RunContext, message: Message) -> str:
        sender = message.from_user.id if message.from_user else None
        if message.chat.type != "private" or sender not in ctx.admin_ids:
            return "ignored:not_admin"
        parsed = parse_command(message.body)
        if parsed is None:
            return "ignored:not_command"
        name, args = parsed
        simple = {
            "start": self._help,
            "help": self._help,
            "status": self._status,
            "sources": self._sources,
            "categories": self._categories,
            "stats": self._stats,
            "pause": self._pause,
            "resume": self._resume,
            "news": self._news,
            "pending": self._pending,
        }
        decisions = {
            "approve": ReviewAction.APPROVE,
            "reject": ReviewAction.REJECT,
            "publish": ReviewAction.PUBLISH,
        }
        if name in simple:
            text = await simple[name](repos, ctx)
        elif name in decisions:
            text = await self._decide(repos, ctx, args, decisions[name], sender)
        elif name == "settings":
            text = await self._settings(repos, ctx, args)
        elif name in LATER_PHASE:
            text = (
                f"⏳ /{esc(name)} در فاز {to_persian_digits(str(LATER_PHASE[name]))} اضافه می‌شود."
            )
        else:
            text = "دستور ناشناخته. /help"
        await self._reply(ctx, message.chat.id, text)
        return f"command:{name}"

    async def _reply(self, ctx: RunContext, chat_id: int, text: str) -> None:
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [reply to {chat_id}] ---\n{text}\n")
            return
        for chunk in split_html(text, self._cfg.pipeline.publish.message_limit):
            await ctx.bot.call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": chunk,
                    "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": True},
                },
            )

    async def _help(self, repos: Repositories, ctx: RunContext) -> str:
        return "\n".join(
            [
                bold(f"Wanger News — فاز {to_persian_digits(str(PHASE))}"),
                "پاسخ دستورها در اجرای بعدی (هر چند دقیقه) می‌رسد.",
                "",
                "/status — وضعیت سیستم و صف",
                "/sources — منابع و سلامت آن‌ها",
                "/categories — دسته‌بندی‌ها",
                "/stats — آمار ۲۴ ساعت اخیر",
                "/pause — توقف انتشار (جمع‌آوری ادامه دارد)",
                "/resume — ادامهٔ انتشار",
                "/news — آخرین خبرهای منتشرشده و صف",
                "/pending — خبرهای منتظر بررسی",
                "/approve 12 · /publish 12 · /reject 12 — تصمیم دربارهٔ خبر #۱۲",
                "/settings — تنظیمات؛ /settings mode default auto|semi|manual،",
                "  /settings mode technology auto، /settings target test|main",
                "",
                "کارت‌های بررسی دکمه دارند: ✅ تأیید · 📤 انتشار فوری · ✏️ ویرایش · ❌ رد.",
            ]
        )

    async def _status(self, repos: Repositories, ctx: RunContext) -> str:
        paused = bool(await repos.settings.get(PAUSED_KEY, False))
        runs = await repos.runs.latest(2)
        previous = next((r for r in runs if r.id != ctx.run_id), None)
        counts = await repos.articles.status_counts()
        health = await repos.sources.all_health()
        failing = [sid for sid, h in health.items() if h.state != "closed"]
        target = (
            f"{ctx.target.chat} ({'کانال اصلی' if ctx.target.role == 'main' else 'کانال تست'})"
            if ctx.target
            else "تنظیم نشده"
        )
        ai = self._cfg.pipeline.ai
        usage = await repos.ai_runs.usage_since(ctx.now() - timedelta(hours=24))
        lines = [
            bold("📊 وضعیت"),
            f"نسخه: {esc(__version__)} · فاز {to_persian_digits(str(PHASE))}",
            f"انتشار: {'⏸ متوقف' if paused else '▶️ فعال'} · مقصد: {esc(target)}",
            f"هوش مصنوعی: {esc(ai.model)} · فراخوانی ۲۴ ساعت: "
            f"{to_persian_digits(str(int(usage['calls'])))} از سقف روزانه "
            f"{to_persian_digits(str(ai.max_calls_per_day))}",
        ]
        if previous is not None:
            when = format_tehran(previous.started_at, self._cfg.pipeline.timezone)
            lines.append(f"اجرای قبلی: {esc(when)} — {esc(previous.status)}")
        for key in ("ai_pending", "pending_review", "held", "queued", "uncertain", "failed"):
            lines.append(f"{STATUS_FA[key]}: {to_persian_digits(str(counts.get(key, 0)))}")
        lines.append(
            f"منابع با مشکل: {to_persian_digits(str(len(failing)))}"
            + (f" ({esc(', '.join(sorted(failing)))})" if failing else "")
        )
        recent = await repos.logs.recent(["error"], 3)
        if recent:
            lines.append("")
            lines.append(bold("آخرین خطاها"))
            lines.extend(f"• {esc(r.event)}" for r in recent)
        return "\n".join(lines)

    async def _sources(self, repos: Repositories, ctx: RunContext) -> str:
        health = await repos.sources.all_health()
        lines = [bold("📰 منابع")]
        for source in self._cfg.sources.sources:
            h = health.get(source.id)
            if not source.active:
                mark = "⚪️"
            elif h is None:
                mark = "🆕"
            elif h.state == "closed":
                mark = "🟢"
            else:
                mark = "🔴"
            extra = ""
            if h is not None and h.last_error and h.state != "closed":
                extra = f" — {esc(h.last_error[:60])}"
            lines.append(f"{mark} {esc(source.name)} <code>{esc(source.id)}</code>{extra}")
        lines.append("")
        lines.append("🟢 سالم · 🔴 مدار باز (موقتاً متوقف) · ⚪️ غیرفعال · 🆕 هنوز بررسی نشده")
        return "\n".join(lines)

    async def _categories(self, repos: Repositories, ctx: RunContext) -> str:
        lines = [bold("🗂 دسته‌بندی‌ها")]
        lines.extend(
            f"• {esc(c.name_fa)} — #{esc(c.hashtag)}" for c in self._cfg.categories.categories
        )
        return "\n".join(lines)

    async def _stats(self, repos: Repositories, ctx: RunContext) -> str:
        since = ctx.now() - timedelta(hours=24)
        counts = await repos.articles.status_counts(since)
        posts: dict[str, Any] = await repos.posts.count_by_status(since)
        lines = [
            bold("📈 ۲۴ ساعت اخیر"),
            f"خبر دریافت‌شده: {to_persian_digits(str(sum(counts.values())))}",
        ]
        for key, value in sorted(counts.items(), key=lambda kv: -kv[1]):
            lines.append(f"• {esc(STATUS_FA.get(key, key))}: {to_persian_digits(str(value))}")
        lines.append(f"پست ارسال‌شده: {to_persian_digits(str(posts.get('sent', 0)))}")
        return "\n".join(lines)

    async def _pause(self, repos: Repositories, ctx: RunContext) -> str:
        await repos.settings.set(PAUSED_KEY, True, ctx.now())
        return "⏸ انتشار متوقف شد. جمع‌آوری خبر ادامه دارد. /resume"

    async def _resume(self, repos: Repositories, ctx: RunContext) -> str:
        await repos.settings.set(PAUSED_KEY, False, ctx.now())
        return "▶️ انتشار ادامه پیدا می‌کند."

    async def _news(self, repos: Repositories, ctx: RunContext) -> str:
        published = await repos.articles.recent([ArticleStatus.PUBLISHED], 10)
        counts = await repos.articles.status_counts()
        lines = [bold("📰 آخرین خبرهای منتشرشده")]
        if not published:
            lines.append("هنوز خبری منتشر نشده.")
        for article in published:
            when = format_tehran(article.updated_at, self._cfg.pipeline.timezone)
            title = await self._title(repos, article)
            lines.append(f"• #{article.id} {esc(title[:90])} — {esc(when)}")
        lines.append("")
        lines.append(
            " · ".join(
                f"{STATUS_FA[k]}: {to_persian_digits(str(counts.get(k, 0)))}"
                for k in ("queued", "ai_pending", "pending_review", "held")
            )
        )
        return "\n".join(lines)

    async def _pending(self, repos: Repositories, ctx: RunContext) -> str:
        waiting = [
            *await repos.articles.by_status(ArticleStatus.PENDING_REVIEW, 15),
            *await repos.articles.by_status(ArticleStatus.HELD, 10),
        ]
        if not waiting:
            return "✅ خبری منتظر بررسی نیست."
        topics = {t.id: t.name_fa for t in self._cfg.categories.sensitive_topics}
        lines = [bold("🧐 منتظر تصمیم")]
        for article in waiting:
            title = await self._title(repos, article)
            reason = (
                reason_fa(article.review_reason, topics)
                if article.status == ArticleStatus.PENDING_REVIEW.value
                else "حالت دستی"
            )
            lines.append(f"• #{article.id} {esc(title[:80])} — {esc(reason)}")
        lines.append("")
        lines.append("/approve شماره · /publish شماره · /reject شماره")
        return "\n".join(lines)

    async def _title(self, repos: Repositories, article: Article) -> str:
        summary = await repos.summaries.get(article.summary_id)
        return summary.title if summary else article.title_original

    async def _decide(
        self,
        repos: Repositories,
        ctx: RunContext,
        args: str,
        action: ReviewAction,
        sender: int | None,
    ) -> str:
        number = to_ascii_digits(args.strip().lstrip("#"))
        if not number.isdigit() or sender is None:
            return f"شمارهٔ خبر را بنویسید، مثلاً /{action.value} 12"
        return esc(await self._review.decide(repos, ctx, int(number), action, sender))

    async def _settings(self, repos: Repositories, ctx: RunContext, args: str) -> str:
        parts = args.split()
        if parts[:1] == ["mode"] and len(parts) == 3:
            return await self._set_mode(repos, ctx, parts[1], parts[2])
        if parts[:1] == ["target"] and len(parts) == 2:
            return await self._set_target(repos, ctx, parts[1])
        if parts:
            return "نمونه: /settings mode default semi · /settings target main"
        modes = modes_from(self._cfg, await repos.settings.get(MODES_KEY))
        target = await repos.settings.get(TARGET_KEY) or "پیش‌فرض محیط"
        ai = self._cfg.pipeline.ai
        lines = [
            bold("⚙️ تنظیمات"),
            f"حالت انتشار پیش‌فرض: {esc(modes.default.value)}",
            *(f"• {esc(cat)}: {esc(mode.value)}" for cat, mode in modes.categories.items()),
            f"مقصد انتشار: {esc(str(target))}",
            f"مدل: {esc(ai.model)} · بررسی دوم (verify): {'روشن' if ai.verify else 'خاموش'}",
            f"سقف: {to_persian_digits(str(ai.max_calls_per_run))} فراخوانی در هر اجرا، "
            f"{to_persian_digits(str(ai.max_calls_per_day))} در روز",
            "auto = خودکار · semi = با تأیید ادمین · manual = فقط با انتخاب ادمین",
            "خبرهای حساس، ردشده در بررسی خودکار و با اطمینان زیر ۵۰ همیشه به بررسی انسانی می‌روند.",
        ]
        return "\n".join(lines)

    async def _set_mode(self, repos: Repositories, ctx: RunContext, scope: str, value: str) -> str:
        if value not in {m.value for m in PublishMode}:
            return "حالت باید auto یا semi یا manual باشد."
        known = {c.id for c in self._cfg.categories.categories}
        if scope != "default" and scope not in known:
            return f"دستهٔ ناشناخته: {esc(scope)}. /categories"
        stored = dict(await repos.settings.get(MODES_KEY) or {})
        if scope == "default":
            stored["default"] = value
        else:
            stored["categories"] = {**(stored.get("categories") or {}), scope: value}
        await repos.settings.set(MODES_KEY, stored, ctx.now())
        return f"✅ حالت انتشار {esc(scope)} = {esc(value)} (از اجرای بعدی)"

    async def _set_target(self, repos: Repositories, ctx: RunContext, value: str) -> str:
        if value not in ("test", "main"):
            return "مقصد باید test یا main باشد."
        if value == "main" and ctx.channels.get("main") is None:
            return "کانال اصلی تنظیم نشده (WANGER_NEWS_MAIN_CHANNEL)."
        await repos.settings.set(TARGET_KEY, value, ctx.now())
        where = "کانال اصلی" if value == "main" else "کانال تست"
        return f"✅ از اجرای بعدی پست‌ها در {where} منتشر می‌شوند."
