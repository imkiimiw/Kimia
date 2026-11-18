"""Bot API client outcome classes, configuration loading, settings and log redaction."""

from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from wanger_news.adapters.telegram.client import (
    TelegramClient,
    TelegramNotSent,
    TelegramRateLimited,
    TelegramUncertain,
)
from wanger_news.config.loader import ConfigError, expand, load_config
from wanger_news.domain.chatref import ChatRef, ChatRefError
from wanger_news.logging_setup import JsonFormatter, Redactor
from wanger_news.services.targets import TargetError, resolve_target
from wanger_news.settings import Settings

from .conftest import MAIN_CHANNEL, ROOT, TEST_CHANNEL

TOKEN = "123456789:AAEexampleexampleexampleexample_abc"


def client(handler, sleeps: list[float] | None = None) -> TelegramClient:  # type: ignore[no-untyped-def]
    async def sleep(s: float) -> None:
        if sleeps is not None:
            sleeps.append(s)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return TelegramClient(SecretStr(TOKEN), http, rate_limit_max_wait=30, sleep=sleep)


async def test_ok_result_is_unwrapped() -> None:
    bot = client(lambda r: httpx.Response(200, json={"ok": True, "result": {"message_id": 7}}))
    assert await bot.call("sendMessage", {"chat_id": 1, "text": "x"}) == {"message_id": 7}


async def test_short_429_is_waited_out_once() -> None:
    answers = iter(
        [
            httpx.Response(
                429,
                json={
                    "ok": False,
                    "error_code": 429,
                    "description": "Too Many",
                    "parameters": {"retry_after": 3},
                },
            ),
            httpx.Response(200, json={"ok": True, "result": True}),
        ]
    )
    sleeps: list[float] = []
    assert await client(lambda r: next(answers), sleeps).call("sendMessage", {}) is True
    assert sleeps == [3.0]


async def test_long_429_raises_rate_limited() -> None:
    bot = client(
        lambda r: httpx.Response(
            429,
            json={
                "ok": False,
                "error_code": 429,
                "description": "Too Many",
                "parameters": {"retry_after": 99},
            },
        )
    )
    with pytest.raises(TelegramRateLimited) as info:
        await bot.call("sendMessage", {})
    assert info.value.retry_after == 99


async def test_outcome_classes() -> None:
    bad = client(
        lambda r: httpx.Response(
            400, json={"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}
        )
    )
    with pytest.raises(TelegramNotSent):
        await bad.call("sendMessage", {})
    server_error = client(lambda r: httpx.Response(502, text="Bad Gateway"))
    with pytest.raises(TelegramUncertain):
        await server_error.call("sendMessage", {})
    with pytest.raises(TelegramNotSent):  # a read may simply be retried
        await server_error.call("getUpdates", {}, idempotent=True)

    def read_timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with pytest.raises(TelegramUncertain):
        await client(read_timeout).call("sendMessage", {})

    def refused(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(TelegramNotSent):
        await client(refused).call("sendMessage", {})


async def test_token_never_appears_in_errors() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(f"timeout for {request.url}", request=request)

    with pytest.raises(TelegramUncertain) as info:
        await client(boom).call("sendMessage", {})
    assert TOKEN not in str(info.value)
    assert info.value.__cause__ is None and info.value.__suppress_context__


def test_redaction_of_tokens_and_database_passwords() -> None:
    redact = Redactor(["super-secret-value"])
    text = redact(
        f"url=https://api.telegram.org/bot{TOKEN}/getMe "
        "db=postgresql://user:hunter2@host/db other=super-secret-value"
    )
    assert TOKEN not in text and "hunter2" not in text and "super-secret-value" not in text

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter(Redactor([])))
    logger = logging.getLogger("test.redaction")
    logger.addHandler(handler)
    logger.warning("failed", extra={"url": f"https://api.telegram.org/bot{TOKEN}/x"})
    line = json.loads(stream.getvalue())
    assert TOKEN not in stream.getvalue() and line["event"] == "failed"


# ------------------------------------------------------------------ config & settings


def test_real_config_is_valid() -> None:
    cfg = load_config(ROOT / "config", env={})
    assert len([s for s in cfg.active_sources if s.transport == "rss"]) >= 5
    channel = cfg.source("source-channel")
    assert channel is not None and not channel.active
    assert channel.inactive_reason == "chat not configured"


def test_source_channel_from_environment() -> None:
    cfg = load_config(ROOT / "config", env={"WANGER_NEWS_SOURCE_CHANNEL": "@my_source"})
    channel = cfg.source("source-channel")
    assert channel is not None and channel.active and channel.telegram is not None
    assert channel.telegram.chat_ref == ChatRef(username="my_source")


def test_env_expansion_with_defaults() -> None:
    assert expand({"a": ["${X}", "${Y:-dflt}", "plain"]}, {"X": "1"}) == {
        "a": ["1", "dflt", "plain"]
    }


def _write(tmp_path: Path, sources: str) -> Path:
    for name in ("categories.yaml", "filters.yaml", "pipeline.yaml"):
        (tmp_path / name).write_text((ROOT / "config" / name).read_text("utf-8"), "utf-8")
    (tmp_path / "sources.yaml").write_text(sources, "utf-8")
    return tmp_path


@pytest.mark.parametrize(
    ("sources", "message"),
    [
        (
            "sources:\n  - {id: a1, name: A, language: en, category: world, source_type: tv,"
            " reliability_score: 50}\n",
            "needs rss_url",
        ),
        (
            "sources:\n  - {id: a1, name: A, language: en, category: nope, source_type: tv,"
            " reliability_score: 50, rss_url: 'https://a.example/rss'}\n",
            "unknown category",
        ),
        (
            "sources:\n  - {id: a1, name: A, language: en, category: world, source_type: tv,"
            " reliability_score: 50, transport: api}\n",
            "not implemented",
        ),
        (
            "sources:\n  - {id: a1, name: A, language: en, category: world, source_type: tv,"
            " reliability_score: 50, rss_url: 'https://a.example/rss'}\n"
            "  - {id: a1, name: B, language: en, category: world, source_type: tv,"
            " reliability_score: 50, rss_url: 'https://b.example/rss'}\n",
            "duplicate source id",
        ),
        ("sources: [\n", "invalid YAML"),
    ],
)
def test_invalid_configs(tmp_path: Path, sources: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load_config(_write(tmp_path, sources), env={})


@pytest.mark.parametrize(
    ("raw", "ref"),
    [
        ("@Channel_Name", ChatRef(username="channel_name")),
        ("https://t.me/channel_name", ChatRef(username="channel_name")),
        ("-1001234567890", ChatRef(chat_id=-1001234567890)),
    ],
)
def test_chat_refs(raw: str, ref: ChatRef) -> None:
    assert ChatRef.parse(raw) == ref


def test_bad_chat_ref() -> None:
    with pytest.raises(ChatRefError):
        ChatRef.parse("not a channel!")


def test_settings_tolerate_pasted_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WANGER_NEWS_BOT_TOKEN", f"  bot{TOKEN} ")
    monkeypatch.setenv("WANGER_NEWS_ADMIN_IDS", "11, 22")
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    assert settings.bot_token is not None and settings.bot_token.get_secret_value() == TOKEN
    assert settings.admin_id_set == {5557901897, 11, 22}
    assert TOKEN not in repr(settings)


def test_phase_one_never_targets_the_main_channel() -> None:
    target = resolve_target(TEST_CHANNEL, MAIN_CHANNEL)
    assert target is not None and target.chat == TEST_CHANNEL and target.role == "test"
    with pytest.raises(TargetError):
        resolve_target(TEST_CHANNEL, MAIN_CHANNEL, want_main=True)
    with pytest.raises(TargetError):
        resolve_target(TEST_CHANNEL, TEST_CHANNEL)
    assert resolve_target(None, MAIN_CHANNEL) is None
