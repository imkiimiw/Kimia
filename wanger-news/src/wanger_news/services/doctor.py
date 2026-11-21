"""``doctor``: is the bot set up right? Token, webhook, channels and admin rights. Read-only."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from wanger_news.adapters.telegram.client import TelegramClient, TelegramError
from wanger_news.ai.prompts import PromptError, PromptLibrary
from wanger_news.config.models import AppConfig
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import Transport
from wanger_news.runtime import telegram_client
from wanger_news.settings import Settings


async def _chat_check(
    bot: TelegramClient,
    bot_id: int,
    label: str,
    ref: ChatRef,
    need_post: bool,
    out: Callable[[str], None],
) -> int:
    try:
        chat = await bot.call("getChat", {"chat_id": ref.api_value}, idempotent=True)
        member: dict[str, Any] = await bot.call(
            "getChatMember", {"chat_id": chat["id"], "user_id": bot_id}, idempotent=True
        )
    except TelegramError as exc:
        out(f"✖ {label} {ref}: {exc.description}")
        return 1
    status = member.get("status")
    if status not in ("administrator", "creator"):
        out(f"✖ {label} {ref} (id {chat['id']}): the bot is '{status}', it must be an admin")
        return 1
    if need_post and status == "administrator" and not member.get("can_post_messages", False):
        out(f"✖ {label} {ref}: the bot is admin but may not post messages")
        return 1
    out(f"✔ {label} {ref} → id {chat['id']} ({chat.get('title', '')}), bot is {status}")
    return 0


async def _ai_check(settings: Settings, config: AppConfig, out: Callable[[str], None]) -> int:
    ai = config.pipeline.ai
    try:
        PromptLibrary.load(settings.prompts_dir)
    except PromptError as exc:
        out(f"✖ prompts: {exc}")
        return 1
    if not ai.enabled:
        out("✖ ai.enabled is false: feed items will never be published (no Persian summary)")
        return 1
    if settings.gemini_api_key is None:
        out("✖ WANGER_NEWS_GEMINI_API_KEY is not set: feed items wait in ai_pending")
        return 1
    problems = 0
    async with httpx.AsyncClient(timeout=20) as http:
        for model in sorted({ai.model, ai.verifier}):
            try:  # model metadata: proves the key and the model name, uses no generation quota
                resp = await http.get(
                    f"{ai.api_base}/models/{model}",
                    headers={"x-goog-api-key": settings.gemini_api_key.get_secret_value()},
                )
            except httpx.HTTPError as exc:
                out(f"✖ Gemini {model}: {type(exc).__name__}")
                problems += 1
                continue
            if resp.status_code == 200:
                out(f"✔ Gemini model {model} is available to this key")
            else:
                out(f"✖ Gemini {model}: HTTP {resp.status_code} (key or model name)")
                problems += 1
    return problems


async def run_doctor(settings: Settings, config: AppConfig, out: Callable[[str], None]) -> int:
    problems = await _ai_check(settings, config, out)
    out(f"config: {len(config.active_sources)} active sources")
    if settings.bot_token is None:
        out("✖ WANGER_NEWS_BOT_TOKEN is not set")
        return 1
    async with telegram_client(config) as http:
        bot = TelegramClient(settings.bot_token, http, base_url=settings.telegram_api_base)
        try:
            me = await bot.call("getMe", idempotent=True)
            out(f"✔ bot @{me.get('username')} (id {me['id']})")
            hook = await bot.call("getWebhookInfo", idempotent=True)
        except TelegramError as exc:
            out(f"✖ Bot API: {exc.description}")
            return problems + 1
        if hook.get("url"):
            out(
                "✖ a webhook is set, getUpdates cannot work while it is: remove it with "
                "deleteWebhook (or switch this deployment to webhook mode, a later phase)"
            )
            problems += 1
        else:
            out("✔ no webhook (getUpdates mode)")
        if settings.test_channel_ref is None:
            out("✖ WANGER_NEWS_TEST_CHANNEL is not set: nothing will be posted")
            problems += 1
        else:
            problems += await _chat_check(
                bot, int(me["id"]), "test channel", settings.test_channel_ref, True, out
            )
        out(f"• publish target: {settings.publish_target} (/settings target can override)")
        if settings.main_channel_ref is not None:
            problems += await _chat_check(
                bot,
                int(me["id"]),
                "main channel",
                settings.main_channel_ref,
                True,
                out,
            )
        for source in config.sources.sources:
            if source.transport is not Transport.TELEGRAM_CHANNEL:
                continue
            if not source.active or source.telegram is None:
                out(f"• source {source.id}: inactive ({source.inactive_reason})")
                continue
            problems += await _chat_check(
                bot, int(me["id"]), f"source {source.id}", source.telegram.chat_ref, False, out
            )
    return problems
