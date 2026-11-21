"""Telegram chat references: ``@username``, ``t.me/username`` or a numeric id (``-100…``)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_USERNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
_TME = re.compile(r"^(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me)/(?:s/)?([A-Za-z0-9_]+)/?$")


class ChatRefError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ChatRef:
    """A chat named either by numeric id or by (lower-cased) public username."""

    chat_id: int | None = None
    username: str | None = None

    @classmethod
    def parse(cls, raw: str | int) -> ChatRef:
        if isinstance(raw, int):
            return cls(chat_id=raw)
        text = raw.strip()
        if re.fullmatch(r"-?\d{5,20}", text):
            return cls(chat_id=int(text))
        match = _TME.match(text)
        if match:
            text = match.group(1)
        text = text.removeprefix("@")
        if not _USERNAME.match(text):
            raise ChatRefError(f"not a Telegram chat reference: {raw!r}")
        return cls(username=text.lower())

    def matches(self, chat_id: int, username: str | None) -> bool:
        if self.chat_id is not None:
            return self.chat_id == chat_id
        return username is not None and self.username == username.lower()

    @property
    def api_value(self) -> int | str:
        """The value Bot API methods accept as ``chat_id``."""
        if self.chat_id is not None:
            return self.chat_id
        return f"@{self.username}"

    def __str__(self) -> str:
        return str(self.api_value)


def post_url(chat_key: str | None, message_id: int | None) -> str | None:
    """Link to a channel post from a target key (``@name`` or ``-100…``). Links to a private
    channel (``t.me/c/…``) open for its members only."""
    if not chat_key or message_id is None:
        return None
    if chat_key.startswith("@"):
        return f"https://t.me/{chat_key[1:]}/{message_id}"
    if chat_key.startswith("-100") and chat_key[4:].isdigit():
        return f"https://t.me/c/{chat_key[4:]}/{message_id}"
    return None
