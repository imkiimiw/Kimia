"""What the owner changed in the bot's panel, applied over the environment and config files.

Stored in ``settings`` (so it survives stateless runs) and read at the start of every run:
- the test / main channel (over ``WANGER_NEWS_TEST_CHANNEL`` / ``WANGER_NEWS_MAIN_CHANNEL``);
- source channels added in the panel, and configured ones switched off;
- RSS sources switched on/off — only those the owner may switch (``SourceConfig.switchable``:
  active ones, and inactive "Candidate" ones). Sources off for a legal or technical reason
  (paywall, licence, broken feed) cannot be switched on from the bot.
Panel changes therefore take effect from the next run.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news.config.models import AppConfig, SourceConfig, SourcesFile
from wanger_news.db.repositories import Repositories
from wanger_news.domain.chatref import ChatRef, ChatRefError
from wanger_news.domain.enums import Transport

log = logging.getLogger("wanger_news")

CHANNELS_KEY = "panel.channels"
SOURCES_KEY = "panel.sources"
RULES_KEY = "panel.rules"
RELIABILITY_KEY = "panel.reliability"  # source id → score the owner applied (Phase 5)


@dataclass(frozen=True, slots=True)
class Channel:
    ref: str  # "@name" or "-100…"
    title: str = ""

    @property
    def chat(self) -> ChatRef:
        return ChatRef.parse(self.ref)


@dataclass(slots=True)
class Overrides:
    test: Channel | None = None
    main: Channel | None = None
    sources: list[Channel] = field(default_factory=list)  # source channels added in the panel
    removed: set[str] = field(default_factory=set)  # configured source channels switched off
    active: dict[str, bool] = field(default_factory=dict)  # RSS source id → on/off
    rules: dict[str, bool] = field(default_factory=dict)  # editorial rule id → on/off
    scores: dict[str, int] = field(default_factory=dict)  # source id → applied reliability

    # ---------------------------------------------------------------- storage
    @classmethod
    def from_settings(
        cls, channels: Any, sources: Any, rules: Any = None, scores: Any = None
    ) -> Overrides:
        ch = channels if isinstance(channels, dict) else {}

        def one(value: Any) -> Channel | None:
            if isinstance(value, dict) and value.get("ref"):
                return Channel(str(value["ref"]), str(value.get("title") or ""))
            return None

        return cls(
            test=one(ch.get("test")),
            main=one(ch.get("main")),
            sources=[c for c in (one(v) for v in ch.get("sources") or []) if c is not None],
            removed={str(x) for x in ch.get("removed") or []},
            active={str(k): bool(v) for k, v in (sources or {}).items()}
            if isinstance(sources, dict)
            else {},
            rules={str(k): bool(v) for k, v in rules.items()} if isinstance(rules, dict) else {},
            scores={str(k): int(v) for k, v in scores.items()} if isinstance(scores, dict) else {},
        )

    def channels_value(self) -> dict[str, Any]:
        def one(c: Channel | None) -> dict[str, str] | None:
            return {"ref": c.ref, "title": c.title} if c is not None else None

        return {
            "test": one(self.test),
            "main": one(self.main),
            "sources": [one(c) for c in self.sources],
            "removed": sorted(self.removed),
        }

    @classmethod
    async def read(cls, repos: Repositories) -> Overrides:
        return cls.from_settings(
            await repos.settings.get(CHANNELS_KEY),
            await repos.settings.get(SOURCES_KEY),
            await repos.settings.get(RULES_KEY),
            await repos.settings.get(RELIABILITY_KEY),
        )

    async def save(self, repos: Repositories, now: Any) -> None:
        await repos.settings.set(CHANNELS_KEY, self.channels_value(), now)
        await repos.settings.set(SOURCES_KEY, dict(sorted(self.active.items())), now)
        await repos.settings.set(RULES_KEY, dict(sorted(self.rules.items())), now)


async def load(engine: AsyncEngine) -> Overrides:
    """The panel's settings, or none (a database without the settings table yet)."""
    try:
        async with AsyncSession(engine) as session:
            return await Overrides.read(Repositories(session))
    except sa.exc.SQLAlchemyError as exc:
        log.warning("panel_overrides_unreadable", extra={"error": type(exc).__name__})
        return Overrides()


def source_channel_id(chat: ChatRef) -> str:
    """A stable source id for a channel added in the panel."""
    if chat.username:
        return f"tg-{chat.username.lower()}"[:64].replace("_", "-")
    return f"tg-{abs(chat.chat_id or 0)}"


def channel_ref(chat: ChatRef | None) -> str | None:
    return str(chat.api_value) if chat is not None else None


def apply(config: AppConfig, ov: Overrides) -> AppConfig:
    """The config this run works with: panel switches and channels over the files."""
    template = next(
        (s for s in config.sources.sources if s.transport is Transport.TELEGRAM_CHANNEL), None
    )
    sources: list[SourceConfig] = []
    known_chats: set[str] = set()
    for source in config.sources.sources:
        data = source.model_dump()
        if source.id in ov.scores:
            data["reliability_score"] = max(0, min(100, ov.scores[source.id]))
        if source.transport is Transport.TELEGRAM_CHANNEL:
            if source.id in ov.removed and source.active:
                data.update(active=False, inactive_reason="switched off in the bot panel")
            elif source.active and source.telegram is not None:
                known_chats.add(channel_ref(source.telegram.chat_ref) or "")
        elif source.id in ov.active and source.switchable:
            on = ov.active[source.id]
            data.update(active=on, inactive_reason=None if on else "switched off in the bot panel")
        sources.append(SourceConfig.model_validate(data))
    taken = {s.id for s in sources}
    for channel in ov.sources:
        try:
            chat = channel.chat
        except ChatRefError:
            continue
        if channel_ref(chat) in known_chats:
            continue
        sid = source_channel_id(chat)
        if sid in taken:
            continue
        base = template.model_dump() if template is not None else _DEFAULT_CHANNEL_SOURCE
        sources.append(
            SourceConfig.model_validate(
                {
                    **base,
                    "id": sid,
                    "name": (channel.title or channel.ref)[:120],
                    "telegram": {"chat": channel.ref},
                    "active": True,
                    "inactive_reason": None,
                    "notes": "Added in the bot panel.",
                }
            )
        )
        taken.add(sid)
    rules = [
        r.model_copy(update={"enabled": ov.rules[r.id]}) if r.id in ov.rules else r
        for r in config.rules.rules
    ]
    return config.model_copy(
        update={
            "sources": SourcesFile(sources=sources),
            "rules": config.rules.model_copy(update={"rules": rules}),
        }
    )


def channels(
    test: ChatRef | None, main: ChatRef | None, ov: Overrides
) -> tuple[ChatRef | None, ChatRef | None]:
    """Test and main channel: the panel's choice over the environment."""
    return (ov.test.chat if ov.test else test), (ov.main.chat if ov.main else main)


_DEFAULT_CHANNEL_SOURCE: dict[str, Any] = {
    "country": "INT",
    "language": "fa",
    "category": "world",
    "source_type": "social_official_account",
    "transport": "telegram_channel",
    "reliability_score": 70,
    "priority": 80,
    "owner_group": "wanger",
}
