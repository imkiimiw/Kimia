"""Per-run context shared by the services: ids, clock, config, output, owner notices, counters."""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.domain.chatref import ChatRef
from wanger_news.domain.enums import ChannelRole
from wanger_news.ports import BotApi, Clock

log = logging.getLogger("wanger_news")


@dataclass(frozen=True, slots=True)
class Target:
    """Where posts go. Phase 1: only ever the test channel (see services.targets)."""

    role: ChannelRole
    chat: ChatRef

    @property
    def key(self) -> str:
        return str(self.chat.api_value).lower()


@dataclass(slots=True)
class RunContext:
    run_id: str
    config: AppConfig
    clock: Clock
    dry_run: bool
    owner_id: int
    admin_ids: frozenset[int]
    bot: BotApi | None
    target: Target | None
    observed_chats: list[ChatRef] = field(default_factory=list)  # all configured target channels
    channels: dict[str, ChatRef | None] = field(default_factory=dict)  # role → configured chat
    edition_chats: list[ChatRef] = field(default_factory=list)  # Phase 6: never a source
    mother_events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)  # sent after
    out: Callable[[str], None] = print
    counters: Counter[str] = field(default_factory=Counter)
    errors: list[str] = field(default_factory=list)
    notices_sent: int = 0
    max_posts: int | None = None
    only_sources: frozenset[str] | None = None

    def now(self) -> datetime:
        return self.clock.now()

    def count(self, key: str, n: int = 1) -> None:
        self.counters[key] += n

    def error(self, message: str) -> None:
        self.errors.append(message[:300])

    async def event(self, repos: Repositories, level: str, event: str, **context: Any) -> None:
        """A log line, plus a row in system_logs for warnings and errors (shown by /status)."""
        log.log(
            logging.getLevelName(level.upper()), event, extra={"run_id": self.run_id, **context}
        )
        if level in ("warning", "error"):
            await repos.logs.add(level, event, self.now(), self.run_id, context or None)

    async def notify_owner(self, repos: Repositories, html_text: str, *, kind: str) -> None:
        """A private message to the owner, capped per run. Dry runs print it instead."""
        cap = self.config.pipeline.telegram.max_owner_notices_per_run
        if self.notices_sent >= cap:
            self.count("notices_suppressed")
            return
        self.notices_sent += 1
        if self.dry_run or self.bot is None:
            self.out(f"--- [owner notice: {kind}] ---\n{html_text}\n")
            return
        try:
            await self.bot.call(
                "sendMessage",
                {
                    "chat_id": self.owner_id,
                    "text": html_text,
                    "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": True},
                },
            )
            self.count("notices_sent")
        except Exception as exc:  # the owner may not have started the bot yet
            await self.event(
                repos, "warning", "owner_notice_failed", kind=kind, error=str(exc)[:200]
            )
