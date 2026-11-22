"""Environment settings (secrets and per-deployment values). Never hard-code any of these."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from wanger_news.domain.chatref import ChatRef

DEFAULT_OWNER_ID = 5557901897
_BOT_PREFIX = re.compile(r"^bot\d+:", re.IGNORECASE)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="WANGER_NEWS_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    bot_token: SecretStr | None = None
    database_url: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    owner_id: int = DEFAULT_OWNER_ID
    admin_ids: str = ""  # comma-separated numeric ids, besides the owner
    test_channel: str = ""
    main_channel: str = ""
    config_dir: Path = Path("config")
    prompts_dir: Path = Path("prompts")
    publish_target: Literal["test", "main"] = "test"  # /settings target overrides it
    log_level: str = "INFO"
    log_format: Literal["json", "text"] = "json"
    telegram_api_base: str = "https://api.telegram.org"

    @field_validator("bot_token", "database_url", "gemini_api_key", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip().strip("\"'")
            return value or None
        return value

    @field_validator("bot_token", mode="after")
    @classmethod
    def _bare_token(cls, value: SecretStr | None) -> SecretStr | None:
        # tolerate a token pasted as "bot123:ABC" (the form it takes inside API URLs)
        if value is not None:
            raw = value.get_secret_value()
            if _BOT_PREFIX.match(raw):
                return SecretStr(raw[3:])
        return value

    @property
    def admin_id_set(self) -> frozenset[int]:
        ids = {self.owner_id}
        for part in self.admin_ids.replace(";", ",").split(","):
            part = part.strip()
            if part:
                ids.add(int(part))
        return frozenset(ids)

    @property
    def test_channel_ref(self) -> ChatRef | None:
        return ChatRef.parse(self.test_channel) if self.test_channel.strip() else None

    @property
    def main_channel_ref(self) -> ChatRef | None:
        return ChatRef.parse(self.main_channel) if self.main_channel.strip() else None

    def secrets(self) -> list[str]:
        """Secret values, for log redaction."""
        out = []
        for secret in (self.bot_token, self.database_url, self.gemini_api_key):
            if secret is not None and secret.get_secret_value():
                out.append(secret.get_secret_value())
        return out
