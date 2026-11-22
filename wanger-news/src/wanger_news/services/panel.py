"""The owner's panel inside the bot (/panel, or /start from the owner).

One message with inline buttons, edited in place: status, channels (test / main / source
channels, where posts go), RSS sources on/off, publish mode per category, pause/resume, items
waiting for review, trends and the daily brief. Owner only.

There is no server (option A): every tap is read on the next run, so the screen changes a few
minutes after the tap. What the panel changes is stored in ``settings``
(``services/overrides.py``) and used from the next run on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from wanger_news.adapters.telegram.client import TelegramError, TelegramNotSent
from wanger_news.adapters.telegram.types import CallbackQuery, Message
from wanger_news.config.models import AppConfig, SourceConfig
from wanger_news.db.repositories import Repositories
from wanger_news.domain.chatref import ChatRef, ChatRefError
from wanger_news.domain.enums import ArticleStatus, PublishMode, Transport
from wanger_news.domain.text import to_persian_digits
from wanger_news.formatting.telegram_html import bold, esc
from wanger_news.services import overrides
from wanger_news.services.ai_stage import MODES_KEY, modes_from
from wanger_news.services.commands import PAUSED_KEY, TARGET_KEY, CommandService
from wanger_news.services.context import RunContext
from wanger_news.services.overrides import Channel, Overrides

PROMPT_KEY = "panel.prompt"
PAGE_SIZE = 8
MODE_ICON = {"auto": "🤖", "semi": "🧐", "manual": "✋"}
MODE_FA = {"auto": "خودکار", "semi": "نیمه‌خودکار", "manual": "دستی"}
NEXT_MODE = {"semi": "auto", "auto": "manual", "manual": "semi"}
ROLE_FA = {"test": "کانال تست", "main": "کانال اصلی (مقصد)", "source": "کانال منبع"}
LATER = "تغییر از اجرای بعدی اعمال می‌شود."

Keyboard = list[list[dict[str, str]]]


def button(text: str, data: str) -> dict[str, str]:
    return {"text": text, "callback_data": data[:64]}


def fa(n: int) -> str:
    return to_persian_digits(str(n))


@dataclass(frozen=True, slots=True)
class Screen:
    text: str
    keyboard: Keyboard


class PanelService:
    def __init__(self, config: AppConfig, base: AppConfig, commands: CommandService) -> None:
        self._cfg = config  # this run's config (panel switches already applied)
        self._base = base  # the config files, before the panel's switches
        self._commands = commands

    # ---------------------------------------------------------------- entry points
    @staticmethod
    def is_owner(ctx: RunContext, user_id: int | None) -> bool:
        return user_id is not None and user_id == ctx.owner_id

    async def open(self, repos: Repositories, ctx: RunContext, chat_id: int) -> str:
        await self._send(ctx, chat_id, await self._home(repos, ctx))
        return "panel:open"

    async def on_callback(self, repos: Repositories, ctx: RunContext, query: CallbackQuery) -> str:
        data = query.data or ""
        if not self.is_owner(ctx, query.from_user.id):
            await self._answer(ctx, query.id, "این پنل فقط برای مالک ربات است.")
            return "panel:not_owner"
        parts = data.split(":")[1:]
        screen, note = await self._route(repos, ctx, parts, query)
        if note:
            screen = Screen(f"{screen.text}\n\n{note}", screen.keyboard)
        await self._answer(ctx, query.id, "")
        if query.message is not None:
            await self._edit(ctx, query.message.chat.id, query.message.message_id, screen)
        return f"panel:{parts[0] if parts else 'home'}"

    async def on_reply(self, repos: Repositories, ctx: RunContext, message: Message) -> str | None:
        """The owner's answer to «send the channel» (a reply to the bot's prompt)."""
        prompt = await repos.settings.get(PROMPT_KEY)
        reply_to = message.reply_to_message
        if not isinstance(prompt, dict) or reply_to is None:
            return None
        if reply_to.message_id != prompt.get("message_id") or message.chat.id != prompt.get(
            "chat_id"
        ):
            return None
        sender = message.from_user.id if message.from_user else None
        if not self.is_owner(ctx, sender):
            return None
        await repos.settings.set(PROMPT_KEY, None, ctx.now())
        ref = self._ref_from(message)
        text = await self.set_channel(repos, ctx, str(prompt.get("action")), ref)
        screen = await self._channels(repos, ctx)
        await self._send(ctx, message.chat.id, Screen(f"{text}\n\n{screen.text}", screen.keyboard))
        return "panel:channel_set"

    async def channel_command(self, repos: Repositories, ctx: RunContext, args: str) -> str:
        """/channel test @x · /channel main @x · /channel source add|remove @x ·
        /channel target test|main — the same as the buttons, for those who prefer typing."""
        parts = args.split()
        if len(parts) == 2 and parts[0] in ("test", "main"):
            return await self.set_channel(repos, ctx, parts[0], parts[1])
        if len(parts) == 3 and parts[:2] == ["source", "add"]:
            return await self.set_channel(repos, ctx, "source", parts[2])
        if len(parts) == 3 and parts[:2] == ["source", "remove"]:
            return await self._remove_source(repos, ctx, parts[2])
        if len(parts) == 2 and parts[0] == "target":
            return await self._set_target(repos, ctx, parts[1])
        return (await self._channels(repos, ctx)).text + (
            "\n\nبا دستور: /channel test @نام · /channel main @نام · "
            "/channel source add @نام · /channel source remove @نام · /channel target test|main"
        )

    # ---------------------------------------------------------------- routing
    async def _route(
        self, repos: Repositories, ctx: RunContext, parts: list[str], query: CallbackQuery
    ) -> tuple[Screen, str]:
        head = parts[0] if parts else "home"
        note = ""
        if head == "status":
            return self._text_screen(await self._commands.status_text(repos, ctx)), ""
        if head == "pend":
            return self._text_screen(await self._commands.pending_text(repos, ctx)), ""
        if head == "trends":
            return self._text_screen(await self._commands.trends_text(repos, ctx)), ""
        if head == "brief":
            return self._text_screen(await self._commands.brief_text(repos, ctx)), ""
        if head == "pause":
            paused = bool(await repos.settings.get(PAUSED_KEY, False))
            await repos.settings.set(PAUSED_KEY, not paused, ctx.now())
            note = "▶️ انتشار ادامه پیدا می‌کند." if paused else "⏸ انتشار متوقف شد."
            return await self._home(repos, ctx), note
        if head == "ch":
            if parts[1:2] == ["set"] and len(parts) > 2:
                await self._prompt(repos, ctx, query, parts[2])
                note = "✉️ پیامی برایتان فرستادم؛ نام کانال را در پاسخ به آن بفرستید."
            elif parts[1:2] == ["del"] and len(parts) > 2:
                note = await self._remove_source(repos, ctx, ":".join(parts[2:]))
            elif parts[1:2] == ["target"] and len(parts) > 2:
                note = await self._set_target(repos, ctx, parts[2])
            return await self._channels(repos, ctx), note
        if head == "src":
            page = 0
            if parts[1:2] == ["t"] and len(parts) > 3:
                note = await self._toggle_source(repos, ctx, parts[2])
                page = int(parts[3]) if parts[3].isdigit() else 0
            elif parts[1:2] == ["x"] and len(parts) > 3:
                source = self._base.source(parts[2])
                reason = (source.inactive_reason if source else None) or "—"
                note = f"🔒 {esc(source.name if source else parts[2])}: {esc(reason)}"
                page = int(parts[3]) if parts[3].isdigit() else 0
            elif parts[1:2] == ["p"] and len(parts) > 2 and parts[2].isdigit():
                page = int(parts[2])
            return await self._sources(repos, page), note
        if head == "mode":
            if parts[1:2] == ["d"]:
                note = await self._cycle_mode(repos, ctx, None)
            elif parts[1:2] == ["c"] and len(parts) > 2:
                note = await self._cycle_mode(repos, ctx, parts[2])
            return await self._modes(repos), note
        return await self._home(repos, ctx), ""

    def _text_screen(self, text: str) -> Screen:
        return Screen(text, [[button("🔙 بازگشت", "pn:home")]])

    # ---------------------------------------------------------------- screens
    async def _home(self, repos: Repositories, ctx: RunContext) -> Screen:
        paused = bool(await repos.settings.get(PAUSED_KEY, False))
        counts = await repos.articles.status_counts()
        target_role = await self._target_role(repos, ctx)
        test, main = await self._effective_channels(repos, ctx)
        where = main if target_role == "main" else test
        lines = [
            bold("🎛 پنل مدیریت Wanger News"),
            f"انتشار: {'⏸ متوقف' if paused else '▶️ فعال'} · مقصد: {esc(ROLE_FA[target_role])}"
            + (f" ({esc(where.ref)})" if where else " (تنظیم نشده)"),
            f"منتظر بررسی: {fa(counts.get(ArticleStatus.PENDING_REVIEW.value, 0))} · "
            f"در صف انتشار: {fa(counts.get(ArticleStatus.QUEUED.value, 0))}",
            "",
            "ℹ️ ربات سرور همیشه‌روشن ندارد: هر دکمه در اجرای بعدی (چند دقیقه بعد) اثر می‌کند.",
        ]
        keyboard = [
            [button("📊 وضعیت", "pn:status"), button("📡 کانال‌ها", "pn:ch")],
            [button("📰 منابع خبری", "pn:src"), button("⚙️ حالت انتشار", "pn:mode")],
            [button("🧐 منتظر بررسی", "pn:pend"), button("📈 روندها", "pn:trends")],
            [
                button("🗞 خلاصهٔ روز", "pn:brief"),
                button("▶️ ادامهٔ انتشار" if paused else "⏸ توقف انتشار", "pn:pause"),
            ],
            [button("🔄 تازه‌سازی", "pn:home")],
        ]
        return Screen("\n".join(lines), keyboard)

    async def _channels(self, repos: Repositories, ctx: RunContext) -> Screen:
        ov = await Overrides.read(repos)
        test, main = await self._effective_channels(repos, ctx)
        target_role = await self._target_role(repos, ctx)
        sources = self._source_channels(ov)

        def show(channel: Channel | None) -> str:
            if channel is None:
                return "تنظیم نشده"
            return esc(channel.ref) + (f" — {esc(channel.title)}" if channel.title else "")

        lines = [
            bold("📡 کانال‌ها"),
            f"🧪 کانال تست: {show(test)}",
            f"📢 کانال اصلی (مقصد): {show(main)}",
            f"🎯 پست‌ها الان می‌روند به: {esc(ROLE_FA[target_role])}",
            "📥 کانال‌های منبع:",
            *([f"• {show(c)}" for c in sources] or ["• هیچ"]),
            "",
            "ربات باید در همهٔ این کانال‌ها ادمین باشد (در کانال تست و اصلی با اجازهٔ ارسال پست).",
            LATER,
        ]
        other = "main" if target_role == "test" else "test"
        keyboard: Keyboard = [
            [button("✏️ کانال تست", "pn:ch:set:test"), button("✏️ کانال اصلی", "pn:ch:set:main")],
            [button(f"🎯 انتشار در {ROLE_FA[other]}", f"pn:ch:target:{other}")],
            [button("➕ افزودن کانال منبع", "pn:ch:set:source")],
            *[[button(f"➖ حذف {c.ref}", f"pn:ch:del:{c.ref}")] for c in sources],
            [button("🔙 بازگشت", "pn:home")],
        ]
        return Screen("\n".join(lines), keyboard)

    async def _sources(self, repos: Repositories, page: int) -> Screen:
        ov = await Overrides.read(repos)
        effective = overrides.apply(self._base, ov)
        rss = [s for s in effective.sources.sources if s.transport is Transport.RSS]
        pages = max(1, (len(rss) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = min(max(page, 0), pages - 1)
        shown = rss[page * PAGE_SIZE : (page + 1) * PAGE_SIZE]
        keyboard: Keyboard = []
        for source in shown:
            base = self._base.source(source.id)
            if base is not None and base.switchable:
                mark = "✅" if source.active else "⚪️"
                keyboard.append([button(f"{mark} {source.name}", f"pn:src:t:{source.id}:{page}")])
            else:
                keyboard.append([button(f"🔒 {source.name}", f"pn:src:x:{source.id}:{page}")])
        nav = []
        if page > 0:
            nav.append(button("◀️ قبلی", f"pn:src:p:{page - 1}"))
        if page < pages - 1:
            nav.append(button("بعدی ▶️", f"pn:src:p:{page + 1}"))
        if nav:
            keyboard.append(nav)
        keyboard.append([button("🔙 بازگشت", "pn:home")])
        active = sum(1 for s in rss if s.active)
        text = "\n".join(
            [
                bold("📰 منابع خبری"),
                f"فعال: {fa(active)} از {fa(len(rss))} · صفحهٔ {fa(page + 1)} از {fa(pages)}",
                "✅ فعال · ⚪️ غیرفعال (با زدن روشن می‌شود) · 🔒 به دلیل حقوقی یا فنی خاموش",
                "توضیح مالکیت و منبع مالی هر منبع در config/sources.yaml است.",
                LATER,
            ]
        )
        return Screen(text, keyboard)

    async def _modes(self, repos: Repositories) -> Screen:
        modes = modes_from(self._cfg, await repos.settings.get(MODES_KEY))
        default = modes.default.value
        lines = [
            bold("⚙️ حالت انتشار"),
            "🤖 خودکار: اگر بررسی خودکار رد نکند، موضوع حساس یا متناقض نباشد و اطمینان و اهمیت "
            "دست‌کم ۵۰ باشد، بدون تأیید شما منتشر می‌شود.",
            "🧐 نیمه‌خودکار: برای هر خبر کارت بررسی می‌آید و با ✅ منتشر می‌شود.",
            "✋ دستی: فقط وقتی خودتان از «منتظر بررسی» یا /publish انتخاب کنید.",
            "خبرهای حساس (جنگ، مرگ، کودتا، انتخابات، رهبران…)، متناقض و ردشده در هر حالتی کارت "
            "بررسی می‌گیرند.",
            f"پیش‌فرض: {MODE_ICON[default]} {MODE_FA[default]} — روی هر دسته بزنید تا عوض شود.",
        ]
        keyboard: Keyboard = [
            [button(f"پیش‌فرض: {MODE_ICON[default]} {MODE_FA[default]}", "pn:mode:d")]
        ]
        row: list[dict[str, str]] = []
        for category in self._cfg.categories.categories:
            mode = modes.for_category(category.id).value
            own = category.id in modes.categories
            row.append(
                button(
                    f"{MODE_ICON[mode]} {category.name_fa}{'' if own else ' ·'}",
                    f"pn:mode:c:{category.id}",
                )
            )
            if len(row) == 2:
                keyboard.append(row)
                row = []
        if row:
            keyboard.append(row)
        keyboard.append([button("🔙 بازگشت", "pn:home")])
        lines.append("«·» یعنی این دسته از پیش‌فرض پیروی می‌کند.")
        return Screen("\n".join(lines), keyboard)

    # ---------------------------------------------------------------- actions
    async def _prompt(
        self, repos: Repositories, ctx: RunContext, query: CallbackQuery, action: str
    ) -> None:
        if action not in ROLE_FA:
            return
        chat_id = query.message.chat.id if query.message else query.from_user.id
        text = (
            f"✏️ <b>{esc(ROLE_FA[action])}</b>\n"
            "نام کاربری یا لینک کانال را <b>در پاسخ به همین پیام</b> بفرستید، مثلاً @mychannel "
            "یا https://t.me/mychannel. برای کانال خصوصی، یک پست از آن کانال را برای من "
            "فوروارد کنید (در پاسخ به همین پیام).\n"
            "ربات باید ادمین آن کانال باشد"
            + (" و اجازهٔ ارسال پست داشته باشد." if action != "source" else ".")
        )
        message_id = await self._send_raw(
            ctx, chat_id, text, {"force_reply": True, "input_field_placeholder": "@channel"}
        )
        await repos.settings.set(
            PROMPT_KEY, {"message_id": message_id, "chat_id": chat_id, "action": action}, ctx.now()
        )

    async def set_channel(
        self, repos: Repositories, ctx: RunContext, action: str, raw: str | None
    ) -> str:
        if action not in ROLE_FA:
            return "نوع کانال نامعلوم است."
        if not raw:
            return "نام کانال را نفهمیدم. مثلاً @mychannel بفرستید."
        try:
            ref = ChatRef.parse(raw)
        except ChatRefError:
            return f"«{esc(raw[:60])}» نام کانال نیست. مثلاً @mychannel یا https://t.me/mychannel."
        channel, problem = await self._inspect(ctx, ref, need_post=action != "source")
        if channel is None:
            return f"✖ {problem}"
        ov = await Overrides.read(repos)
        test, main = await self._effective_channels(repos, ctx)
        targets = {c.ref.lower() for c in (test, main) if c is not None}
        same = channel.ref.lower()
        if action == "source":
            if same in targets:
                return "✖ کانال تست یا اصلی نمی‌تواند کانال منبع هم باشد (پست‌ها دور خودشان می‌چرخند)."
            if same in {c.ref.lower() for c in self._source_channels(ov)}:
                return f"این کانال همین الان کانال منبع است: {esc(channel.ref)}"
            ov.sources = [*ov.sources, channel]
            ov.removed.discard(self._config_source_id(channel) or "")
        else:
            other = main if action == "test" else test
            if other is not None and other.ref.lower() == same:
                return "✖ کانال تست و کانال اصلی باید دو کانال جدا باشند."
            if same in {c.ref.lower() for c in self._source_channels(ov)}:
                return "✖ این کانال، کانال منبع است؛ اول آن را از منابع حذف کنید."
            if action == "test":
                ov.test = channel
            else:
                ov.main = channel
        await ov.save(repos, ctx.now())
        return f"✅ {esc(ROLE_FA[action])}: {esc(channel.ref)} ({esc(channel.title)}). {LATER}"

    async def _remove_source(self, repos: Repositories, ctx: RunContext, raw: str) -> str:
        ov = await Overrides.read(repos)
        wanted = raw.lower()
        before = len(ov.sources)
        ov.sources = [c for c in ov.sources if c.ref.lower() != wanted]
        if len(ov.sources) == before:
            source_id = self._config_source_id(Channel(raw))
            if source_id is None:
                return f"«{esc(raw)}» در کانال‌های منبع نیست."
            ov.removed.add(source_id)
        await ov.save(repos, ctx.now())
        return f"✅ {esc(raw)} از کانال‌های منبع حذف شد. {LATER}"

    async def _set_target(self, repos: Repositories, ctx: RunContext, role: str) -> str:
        if role not in ("test", "main"):
            return "مقصد باید test یا main باشد."
        _, main = await self._effective_channels(repos, ctx)
        if role == "main" and main is None:
            return "✖ کانال اصلی هنوز تنظیم نشده؛ اول «✏️ کانال اصلی» را بزنید."
        await repos.settings.set(TARGET_KEY, role, ctx.now())
        return f"✅ از اجرای بعدی پست‌ها در {ROLE_FA[role]} منتشر می‌شوند."

    async def _toggle_source(self, repos: Repositories, ctx: RunContext, source_id: str) -> str:
        base = self._base.source(source_id)
        if base is None or not base.switchable:
            return "این منبع را نمی‌شود از ربات روشن یا خاموش کرد."
        ov = await Overrides.read(repos)
        now_on = ov.active.get(source_id, base.active)
        if (not now_on) == base.active:
            ov.active.pop(source_id, None)  # back to the config file's value
        else:
            ov.active[source_id] = not now_on
        await ov.save(repos, ctx.now())
        state = "روشن" if not now_on else "خاموش"
        return f"✅ {esc(base.name)} {state} شد. {LATER}"

    async def _cycle_mode(self, repos: Repositories, ctx: RunContext, category: str | None) -> str:
        stored = dict(await repos.settings.get(MODES_KEY) or {})
        modes = modes_from(self._cfg, stored)
        if category is None:
            new = NEXT_MODE[modes.default.value]
            stored["default"] = new
            label = "پیش‌فرض"
        else:
            if self._cfg.categories.get(category) is None:
                return "دستهٔ نامعلوم."
            new = NEXT_MODE[modes.for_category(category).value]
            own = dict(stored.get("categories") or {})
            if new == modes.default.value:
                own.pop(category, None)
            else:
                own[category] = new
            stored["categories"] = own
            cat = self._cfg.categories.get(category)
            label = cat.name_fa if cat else category
        PublishMode(new)  # validates
        await repos.settings.set(MODES_KEY, stored, ctx.now())
        return f"✅ {esc(label)}: {MODE_ICON[new]} {MODE_FA[new]} (از اجرای بعدی)"

    # ---------------------------------------------------------------- helpers
    async def _target_role(self, repos: Repositories, ctx: RunContext) -> str:
        stored = await repos.settings.get(TARGET_KEY)
        if stored in ("test", "main"):
            return str(stored)
        return ctx.target.role.value if ctx.target is not None else "test"

    async def _effective_channels(
        self, repos: Repositories, ctx: RunContext
    ) -> tuple[Channel | None, Channel | None]:
        ov = await Overrides.read(repos)
        env_test = ctx.channels.get("test") or (ctx.target.chat if ctx.target else None)
        env_main = ctx.channels.get("main")
        test = ov.test or (Channel(str(env_test.api_value)) if env_test else None)
        main = ov.main or (Channel(str(env_main.api_value)) if env_main else None)
        return test, main

    def _source_channels(self, ov: Overrides) -> list[Channel]:
        effective = overrides.apply(self._base, ov)
        out = []
        for source in effective.sources.sources:
            if source.transport is Transport.TELEGRAM_CHANNEL and source.active and source.telegram:
                ref = str(source.telegram.chat_ref.api_value)
                out.append(Channel(ref, source.name if source.name != ref else ""))
        return out

    def _config_source_id(self, channel: Channel) -> str | None:
        """The configured source channel this reference names (to switch it off)."""
        try:
            chat = channel.chat
        except ChatRefError:
            return None
        for source in self._base.sources.sources:
            if source.transport is Transport.TELEGRAM_CHANNEL and source.telegram is not None:
                try:
                    if (
                        str(source.telegram.chat_ref.api_value).lower()
                        == str(chat.api_value).lower()
                    ):
                        return source.id
                except ChatRefError:
                    continue
        return None

    @staticmethod
    def _ref_from(message: Message) -> str | None:
        origin = message.forward_origin
        if origin is not None and origin.type == "channel" and origin.chat is not None:
            return f"@{origin.chat.username}" if origin.chat.username else str(origin.chat.id)
        text = (message.text or "").strip().split()
        return text[0] if text else None

    async def _inspect(
        self, ctx: RunContext, ref: ChatRef, *, need_post: bool
    ) -> tuple[Channel | None, str]:
        """Is it a channel, and is the bot an admin there (with the right to post)?"""
        if ctx.bot is None:
            return Channel(str(ref.api_value)), ""
        try:
            me = await ctx.bot.call("getMe", idempotent=True)
            chat = await ctx.bot.call("getChat", {"chat_id": ref.api_value}, idempotent=True)
            if chat.get("type") != "channel":
                return None, "این یک کانال نیست."
            member: dict[str, Any] = await ctx.bot.call(
                "getChatMember", {"chat_id": chat["id"], "user_id": me["id"]}, idempotent=True
            )
        except TelegramError as exc:
            return None, (
                "ربات این کانال را نمی‌بیند. ربات را ادمین کانال کنید و دوباره بفرستید. "
                f"({esc((exc.description or '')[:80])})"
            )
        status = member.get("status")
        if status not in ("administrator", "creator"):
            return None, "ربات در این کانال ادمین نیست. اول ربات را ادمین کنید."
        if need_post and status == "administrator" and not member.get("can_post_messages", False):
            return None, "ربات ادمین است ولی اجازهٔ «ارسال پست» ندارد."
        username = chat.get("username")
        return Channel(
            f"@{username}" if username else str(chat["id"]), str(chat.get("title") or "")
        ), ""

    # ---------------------------------------------------------------- Bot API
    async def _send(self, ctx: RunContext, chat_id: int, screen: Screen) -> None:
        await self._send_raw(ctx, chat_id, screen.text, {"inline_keyboard": screen.keyboard})

    async def _send_raw(
        self, ctx: RunContext, chat_id: int, text: str, markup: dict[str, Any]
    ) -> int | None:
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [panel to {chat_id}] ---\n{text}\n")
            return None
        result = await ctx.bot.call(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "reply_markup": markup,
                "link_preview_options": {"is_disabled": True},
            },
        )
        return int(result["message_id"])

    async def _edit(self, ctx: RunContext, chat_id: int, message_id: int, screen: Screen) -> None:
        if ctx.dry_run or ctx.bot is None:
            ctx.out(f"--- [panel edit {chat_id}/{message_id}] ---\n{screen.text}\n")
            return
        try:
            await ctx.bot.call(
                "editMessageText",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "text": screen.text,
                    "parse_mode": "HTML",
                    "reply_markup": {"inline_keyboard": screen.keyboard},
                    "link_preview_options": {"is_disabled": True},
                },
            )
        except TelegramNotSent as exc:
            if "not modified" not in (exc.description or ""):
                await self._send(ctx, chat_id, screen)  # too old to edit: a fresh panel

    async def _answer(self, ctx: RunContext, query_id: str, text: str) -> None:
        if ctx.dry_run or ctx.bot is None:
            return
        try:
            payload: dict[str, Any] = {"callback_query_id": query_id}
            if text:
                payload["text"] = text
            await ctx.bot.call("answerCallbackQuery", payload)
        except TelegramError:
            pass  # read on a later run: Telegram no longer accepts the answer


def describe_source(source: SourceConfig) -> str:  # pragma: no cover - used in docs/tests
    return f"{source.name} ({source.id})"
