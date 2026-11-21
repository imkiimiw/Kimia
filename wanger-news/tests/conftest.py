"""Shared test helpers. Everything is offline: feeds come from fixtures through httpx.MockTransport,
DNS from a static resolver, Telegram from FakeTelegram, the database is in-memory SQLite."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news.adapters.http.fetcher import SafeFetcher
from wanger_news.adapters.http.ssrf import StaticResolver, UrlGuard
from wanger_news.adapters.telegram.client import TelegramNotSent, TelegramUncertain
from wanger_news.config.loader import load_config
from wanger_news.config.models import AppConfig, SourceConfig, SourcesFile
from wanger_news.db.engine import MEMORY_URL, create_all, create_engine
from wanger_news.db.repositories import Repositories
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ChannelRole
from wanger_news.services.context import Target
from wanger_news.services.pipeline import Deps, Pipeline, RunOptions, RunSummary

from .fake_ai import FakeAI

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
OWNER = 5557901897
ADMIN = 7000001
TEST_CHANNEL = ChatRef.parse("@wanger_test")
MAIN_CHANNEL = ChatRef.parse("@wanger_main")
SOURCE_CHANNEL_ID = -1001111111111
SOURCE_CHANNEL_USERNAME = "wanger_source"
PUBLIC_IP = ["93.184.216.34"]


def feed(name: str) -> bytes:
    return (FIXTURES / "feeds" / name).read_bytes()


class FakeClock:
    def __init__(self, now: datetime = NOW) -> None:
        self.current = now

    def now(self) -> datetime:
        return self.current

    def advance(self, **kwargs: float) -> None:
        self.current += timedelta(**kwargs)


async def no_sleep(_seconds: float) -> None:
    return None


# ------------------------------------------------------------------------------- feeds


Responder = Callable[[httpx.Request], httpx.Response]


class FeedServer:
    """URL → response. A value may be a callable (to raise timeouts, count calls …)."""

    def __init__(self) -> None:
        self.routes: dict[str, Responder | tuple[int, bytes, dict[str, str]]] = {}
        self.requests: list[httpx.Request] = []

    def add(
        self, url: str, body: bytes = b"", status: int = 200, headers: dict[str, str] | None = None
    ) -> None:
        self.routes[url] = (status, body, headers or {"content-type": "application/rss+xml"})

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        route = self.routes.get(url)
        if route is None:
            if url.endswith("/robots.txt"):
                return httpx.Response(404)
            return httpx.Response(404, text="not found")
        if callable(route):
            return route(request)
        status, body, headers = route
        return httpx.Response(status, content=body, headers=headers)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


# ------------------------------------------------------------------------------- telegram


@dataclass
class FakeTelegram:
    """A small Bot API emulator: getUpdates with offset semantics, sends with message ids."""

    updates: list[dict[str, Any]] = field(default_factory=list)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    failures: dict[str, list[Exception]] = field(default_factory=dict)
    next_id: int = 1000
    confirmed_below: int = 0

    async def call(
        self, method: str, payload: dict[str, Any] | None = None, *, idempotent: bool = False
    ) -> Any:
        payload = payload or {}
        self.calls.append((method, payload))
        queue = self.failures.get(method)
        if queue:
            raise queue.pop(0)
        if method == "getUpdates":
            offset = int(payload.get("offset", 0))
            if offset:
                self.confirmed_below = max(self.confirmed_below, offset)
            pending = [u for u in self.updates if u["update_id"] >= self.confirmed_below]
            return pending[: int(payload.get("limit", 100))]
        if method in ("sendMessage", "sendPhoto", "copyMessage"):
            self.next_id += 1
            return {"message_id": self.next_id}
        if method == "copyMessages":
            out = []
            for _ in payload["message_ids"]:
                self.next_id += 1
                out.append({"message_id": self.next_id})
            return out
        if method == "getMe":
            return {"id": 42, "username": "wanger_news_bot"}
        if method in ("answerCallbackQuery", "editMessageReplyMarkup", "editMessageText"):
            return True
        raise AssertionError(f"unexpected method {method}")

    def sent(self, *methods: str) -> list[dict[str, Any]]:
        wanted = methods or ("sendMessage", "sendPhoto", "copyMessage", "copyMessages")
        return [p for m, p in self.calls if m in wanted]

    @staticmethod
    def _is_channel(chat_id: Any) -> bool:
        return (isinstance(chat_id, str) and chat_id.startswith("@")) or (
            isinstance(chat_id, int) and chat_id < 0
        )

    def channel_posts(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            (m, p)
            for m, p in self.calls
            if m in ("sendMessage", "sendPhoto", "copyMessage", "copyMessages")
            and self._is_channel(p.get("chat_id"))
        ]

    def messages_to(self, chat_id: int) -> list[dict[str, Any]]:
        return [p for m, p in self.calls if m == "sendMessage" and p.get("chat_id") == chat_id]

    def owner_messages(self) -> list[str]:
        return [p["text"] for p in self.messages_to(OWNER)]

    def owner_notices(self) -> list[str]:
        """Owner messages that are not review cards."""
        return [t for t in self.owner_messages() if not t.startswith("🧐")]

    def fail(self, method: str, exc: Exception) -> None:
        self.failures.setdefault(method, []).append(exc)


def not_sent(code: int = 400, description: str = "Bad Request") -> TelegramNotSent:
    return TelegramNotSent(f"{code} {description}", code=code, description=description)


def uncertain() -> TelegramUncertain:
    return TelegramUncertain("sendMessage: ReadTimeout")


# ------------------------------------------------------------------------------- updates


class Updates:
    """Builds Bot API update payloads."""

    def __init__(self) -> None:
        self.next_update = 500
        self.next_message = 10

    def _update(self, key: str, message: dict[str, Any]) -> dict[str, Any]:
        self.next_update += 1
        return {"update_id": self.next_update, key: message}

    def channel_post(
        self,
        text: str | None = None,
        *,
        chat_id: int = SOURCE_CHANNEL_ID,
        username: str | None = SOURCE_CHANNEL_USERNAME,
        date: datetime = NOW,
        photo: str | None = None,
        caption: str | None = None,
        entities: list[dict[str, Any]] | None = None,
        media_group_id: str | None = None,
        forward_from: tuple[int, int] | None = None,
    ) -> dict[str, Any]:
        self.next_message += 1
        message: dict[str, Any] = {
            "message_id": self.next_message,
            "date": int(date.timestamp()),
            "chat": {
                "id": chat_id,
                "type": "channel",
                "title": "Source",
                **({"username": username} if username else {}),
            },
        }
        if text is not None:
            message["text"] = text
            if entities:
                message["entities"] = entities
        if photo is not None:
            message["photo"] = [
                {
                    "file_id": f"small-{photo}",
                    "file_unique_id": f"{photo}-s",
                    "width": 90,
                    "height": 90,
                },
                {"file_id": f"big-{photo}", "file_unique_id": photo, "width": 1280, "height": 720},
            ]
            if caption is not None:
                message["caption"] = caption
                if entities:
                    message["caption_entities"] = entities
        if media_group_id:
            message["media_group_id"] = media_group_id
        if forward_from:
            message["forward_origin"] = {
                "type": "channel",
                "date": int(date.timestamp()) - 60,
                "chat": {"id": forward_from[0], "type": "channel", "title": "Origin"},
                "message_id": forward_from[1],
            }
        return self._update("channel_post", message)

    def callback(self, data: str, *, user_id: int = OWNER, message_id: int = 1) -> dict[str, Any]:
        self.next_update += 1
        return {
            "update_id": self.next_update,
            "callback_query": {
                "id": f"cq{self.next_update}",
                "data": data,
                "from": {"id": user_id, "is_bot": False, "first_name": "U"},
                "message": {
                    "message_id": message_id,
                    "date": int(NOW.timestamp()),
                    "chat": {"id": user_id, "type": "private"},
                },
            },
        }

    def reply(self, text: str, reply_to: int, *, user_id: int = OWNER) -> dict[str, Any]:
        update = self.private(text, user_id=user_id)
        update["message"]["reply_to_message"] = {
            "message_id": reply_to,
            "date": int(NOW.timestamp()),
            "chat": {"id": user_id, "type": "private"},
        }
        return update

    def private(self, text: str, *, user_id: int = OWNER) -> dict[str, Any]:
        self.next_message += 1
        return self._update(
            "message",
            {
                "message_id": self.next_message,
                "date": int(NOW.timestamp()),
                "chat": {"id": user_id, "type": "private"},
                "from": {"id": user_id, "is_bot": False, "first_name": "U"},
                "text": text,
                **(
                    {
                        "entities": [
                            {"type": "bot_command", "offset": 0, "length": len(text.split()[0])}
                        ]
                    }
                    if text.startswith("/")
                    else {}
                ),
            },
        )


# ------------------------------------------------------------------------------- config


def source_entries(*extra: dict[str, Any]) -> list[dict[str, Any]]:
    base = [
        {
            "id": "alpha",
            "name": "Alpha News",
            "country": "GB",
            "language": "en",
            "category": "world",
            "source_type": "news_agency",
            "reliability_score": 80,
            "rss_url": "https://alpha.example/rss.xml",
            "owner_group": "alpha-group",
        },
        {
            "id": "beta",
            "name": "Beta Wire",
            "country": "US",
            "language": "en",
            "category": "world",
            "source_type": "news_agency",
            "reliability_score": 75,
            "rss_url": "https://beta.example/atom.xml",
        },
        {
            "id": "gamma",
            "name": "Gamma",
            "country": "DE",
            "language": "en",
            "category": "science",
            "source_type": "specialized_media",
            "reliability_score": 70,
            "rss_url": "https://gamma.example/rss",
        },
        {
            "id": "source-channel",
            "name": "کانال منبع",
            "country": "INT",
            "language": "fa",
            "category": "world",
            "source_type": "social_official_account",
            "reliability_score": 70,
            "transport": "telegram_channel",
            "telegram": {"chat": f"@{SOURCE_CHANNEL_USERNAME}"},
        },
    ]
    return [*base, *extra]


def make_config(sources: list[dict[str, Any]] | None = None, **pipeline: Any) -> AppConfig:
    real = load_config(ROOT / "config", env={})
    sources_file = SourcesFile(
        sources=[
            SourceConfig.model_validate(s)
            for s in (sources if sources is not None else source_entries())
        ]
    )
    pipe = real.pipeline.model_dump()
    pipe["http"].update(respect_robots_txt=False, retries=1)
    pipe["publish"].update(min_interval_seconds=0)
    pipe["story"].update(settle_minutes=0)  # tests run a story through in one run
    editorial = real.editorial.model_dump()
    # the harness publishes without a human (auto) unless a test asks for "semi"/"manual"
    editorial["publish_modes"]["default"] = pipeline.pop("mode", "auto")
    for section, values in pipeline.items():
        if section == "editorial":
            for key, value in values.items():
                editorial[key].update(value)
            continue
        pipe[section].update(values)
    return AppConfig(
        sources=sources_file,
        categories=real.categories,
        filters=real.filters,
        pipeline=type(real.pipeline).model_validate(pipe),
        editorial=type(real.editorial).model_validate(editorial),
    )


def standard_feeds(server: FeedServer) -> None:
    server.add("https://alpha.example/rss.xml", feed("rss2.xml"))
    server.add(
        "https://beta.example/atom.xml",
        feed("atom.xml"),
        headers={"content-type": "application/atom+xml"},
    )
    server.add("https://gamma.example/rss", feed("rdf.xml"))


# ------------------------------------------------------------------------------- harness


@dataclass
class Harness:
    engine: AsyncEngine
    config: AppConfig
    clock: FakeClock
    server: FeedServer
    telegram: FakeTelegram
    http: httpx.AsyncClient
    target: Target | None
    output: list[str]
    observed: list[ChatRef]
    ai: FakeAI | None = None
    channels: dict[str, ChatRef | None] = field(default_factory=dict)

    def pipeline(self, *, telegram: bool = True) -> Pipeline:
        http_cfg = self.config.pipeline.http
        fetcher = SafeFetcher(
            self.http,
            UrlGuard(StaticResolver({}, default=PUBLIC_IP), http_cfg.allowed_ports),
            http_cfg,
            sleep=no_sleep,
        )
        return Pipeline(
            Deps(
                config=self.config,
                engine=self.engine,
                clock=self.clock,
                fetcher=fetcher,
                robots=None,
                bot=self.telegram if telegram else None,
                target=self.target,
                observed_chats=self.observed,
                owner_id=OWNER,
                admin_ids=frozenset({OWNER, ADMIN}),
                ai=self.ai,
                channels=self.channels,
                out=self.output.append,
                sleep=no_sleep,
            )
        )

    async def run(self, **opts: Any) -> RunSummary:
        telegram = opts.pop("telegram", True)
        return await self.pipeline(telegram=telegram).run_once(RunOptions(**opts))

    async def repos(self) -> AsyncIterator[Repositories]:  # pragma: no cover - helper
        async with AsyncSession(self.engine, expire_on_commit=False) as session:
            yield Repositories(session)

    async def scalar(self, stmt: Any) -> Any:
        async with AsyncSession(self.engine) as session:
            return await session.scalar(stmt)

    async def rows(self, stmt: Any) -> list[Any]:
        async with AsyncSession(self.engine) as session:
            return list((await session.execute(stmt)).all())

    async def articles(self) -> list[Any]:
        from wanger_news.db.tables import Article

        async with AsyncSession(self.engine) as session:
            return list((await session.scalars(sa.select(Article).order_by(Article.id))).all())


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    eng = create_engine(MEMORY_URL)
    await create_all(eng)
    yield eng
    await eng.dispose()


@pytest.fixture
async def harness(engine: AsyncEngine) -> AsyncIterator[Harness]:
    server = FeedServer()
    standard_feeds(server)
    async with server.client() as http:
        yield Harness(
            engine=engine,
            config=make_config(),
            clock=FakeClock(),
            server=server,
            telegram=FakeTelegram(),
            http=http,
            target=Target(ChannelRole.TEST, TEST_CHANNEL),
            output=[],
            observed=[TEST_CHANNEL],
            ai=FakeAI(),
        )
