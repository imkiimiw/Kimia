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
#: the shape of a Bot API token: digits, one colon, ~35 URL-safe characters
TOKEN_SHAPE = re.compile(r"\d{5,}:[A-Za-z0-9_-]{30,}")


def token_problems(raw: str) -> list[str]:
    """Why a value is not a bot token — described without revealing it."""
    if TOKEN_SHAPE.fullmatch(raw):
        return []
    hints = []
    if any(ch.isspace() for ch in raw):
        hints.append("it contains spaces or line breaks")
    if "http" in raw.lower() or "/" in raw:
        hints.append("it looks like a link, not a token")
    colons = raw.count(":")
    if colons != 1:
        hints.append(f"a token has exactly one ':' (this value has {colons})")
    elif not raw.split(":", 1)[0].isdigit():
        hints.append("the part before ':' must be digits only")
    if len(raw) < 40:
        hints.append(f"it is too short ({len(raw)} characters; a token has about 46)")
    return hints or ["it has characters a token never has"]


def describe_db_error(exc: BaseException) -> str:
    """A database connection error in one line, without the URL or the password."""
    text = str(exc)
    if "password authentication failed" in text:
        return (
            "the database rejected the password — copy the connection string again "
            "(Neon: Connect → show password → Copy) into WANGER_NEWS_DATABASE_URL"
        )
    if "could not translate host name" in text or "Name or service not known" in text:
        return "the database host name is wrong — check WANGER_NEWS_DATABASE_URL"
    if "does not exist" in text and "database" in text:
        return "the database name in WANGER_NEWS_DATABASE_URL does not exist"
    if "timeout" in text.lower():
        return "the database did not answer in time (is the project suspended or deleted?)"
    return f"cannot connect to the database ({type(exc).__name__})"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="WANGER_NEWS_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    bot_token: SecretStr | None = None
    database_url: SecretStr | None = None
    gemini_api_key: SecretStr | None = None
    api_token: SecretStr | None = None  # Phase 5: the admin API (option B); no token = no API
    # Phase 6
    mobile_api_token: SecretStr | None = None  # read-only /api/v1 (mobile app); none = no v1
    mother_url: str = ""  # the mother bot's HTTPS endpoint; empty = not connected
    mother_secret: SecretStr | None = None  # HMAC key shared with the mother bot
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

    @field_validator(
        "bot_token",
        "database_url",
        "gemini_api_key",
        "api_token",
        "mobile_api_token",
        "mother_secret",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.strip().strip("\"'")
            return value or None
        return value

    @field_validator("bot_token", mode="after")
    @classmethod
    def _bare_token(cls, value: SecretStr | None) -> SecretStr | None:
        # tolerate a token pasted as "bot123:ABC" (the form it takes inside API URLs), or
        # inside a longer paste (BotFather's whole message, an API URL): one token → that token
        if value is not None:
            raw = value.get_secret_value()
            if _BOT_PREFIX.match(raw):
                raw = raw[3:]
            if not TOKEN_SHAPE.fullmatch(raw):
                found = set(TOKEN_SHAPE.findall(raw))
                if len(found) == 1:
                    raw = found.pop()
            return SecretStr(raw)
        return value

    @field_validator("database_url", mode="after")
    @classmethod
    def _bare_url(cls, value: SecretStr | None) -> SecretStr | None:
        # tolerate Neon's "psql 'postgresql://…'" snippet pasted whole
        if value is not None:
            raw = value.get_secret_value()
            if raw.startswith("psql "):
                return SecretStr(raw[5:].strip().strip("\"'"))
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
        for secret in (
            self.bot_token,
            self.database_url,
            self.gemini_api_key,
            self.api_token,
            self.mobile_api_token,
            self.mother_secret,
        ):
            if secret is not None and secret.get_secret_value():
                out.append(secret.get_secret_value())
        return out
