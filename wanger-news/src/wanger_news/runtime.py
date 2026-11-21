"""Wiring: real adapters from Settings + config (composition root). Tests build Deps directly."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx

from wanger_news.adapters.http.fetcher import SafeFetcher
from wanger_news.adapters.http.robots import RobotsChecker
from wanger_news.adapters.http.ssrf import SystemResolver, UrlGuard
from wanger_news.adapters.telegram.client import TelegramClient
from wanger_news.ai.gemini import GeminiProvider
from wanger_news.ai.prompts import PromptLibrary
from wanger_news.config.models import AppConfig
from wanger_news.db.engine import MEMORY_URL, create_all, create_engine
from wanger_news.ports import SystemClock
from wanger_news.services.inbox import chat_refs
from wanger_news.services.pipeline import Deps
from wanger_news.services.targets import resolve_target
from wanger_news.settings import Settings


class SetupError(Exception):
    pass


def feed_client(config: AppConfig) -> httpx.AsyncClient:
    http = config.pipeline.http
    timeout = httpx.Timeout(http.timeout_seconds, connect=http.connect_timeout_seconds)
    return httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        limits=httpx.Limits(max_connections=http.concurrency * 2),
    )


def telegram_client(config: AppConfig) -> httpx.AsyncClient:
    timeout = config.pipeline.telegram.request_timeout_seconds
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=5), follow_redirects=False)


@asynccontextmanager
async def build(
    settings: Settings, config: AppConfig, *, dry_run: bool, out: Callable[[str], None] = print
) -> AsyncIterator[Deps]:
    if settings.database_url is None:
        if not dry_run:
            raise SetupError(
                "WANGER_NEWS_DATABASE_URL is not set (only --dry-run works without it)"
            )
        out(
            "ℹ no database configured: dry run on an empty in-memory database "
            "(no history, so nothing counts as already published)\n"
        )
        engine = create_engine(MEMORY_URL)
        await create_all(engine)
    else:
        engine = create_engine(settings.database_url.get_secret_value())

    test, main = settings.test_channel_ref, settings.main_channel_ref
    target = resolve_target(test, main)  # validates the pair early (test ≠ main)
    http = config.pipeline.http
    async with (
        feed_client(config) as feeds,
        telegram_client(config) as tg_http,
        httpx.AsyncClient(timeout=config.pipeline.ai.timeout_seconds) as ai_http,
    ):
        ai = None
        if settings.gemini_api_key is not None and config.pipeline.ai.enabled:
            ai = GeminiProvider(
                settings.gemini_api_key,
                ai_http,
                config.pipeline.ai,
                PromptLibrary.load(settings.prompts_dir),
            )
        fetcher = SafeFetcher(feeds, UrlGuard(SystemResolver(), http.allowed_ports), http)
        robots = RobotsChecker(fetcher, http.robots_user_agent) if http.respect_robots_txt else None
        bot = None
        if settings.bot_token is not None:
            bot = TelegramClient(
                settings.bot_token,
                tg_http,
                base_url=settings.telegram_api_base,
                rate_limit_max_wait=config.pipeline.telegram.rate_limit_max_wait_seconds,
            )
        try:
            yield Deps(
                config=config,
                engine=engine,
                clock=SystemClock(),
                fetcher=fetcher,
                robots=robots,
                bot=bot,
                target=target,
                observed_chats=chat_refs(test, main),
                ai=ai,
                channels={"test": test, "main": main},
                default_target=settings.publish_target,
                owner_id=settings.owner_id,
                admin_ids=settings.admin_id_set,
                out=out,
            )
        finally:
            await engine.dispose()
