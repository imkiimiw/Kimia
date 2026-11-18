"""Structured JSON logs on stderr (stdout is for command output), with secret redaction."""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

_BOT_TOKEN = re.compile(r"(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}")
_URL_PASSWORD = re.compile(r"(://[^:/@\s]+:)[^@\s]+@")
_RESERVED = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}


class Redactor:
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        self._secrets = [s for s in secrets if len(s) >= 8]

    def __call__(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, "[REDACTED]")
        text = _BOT_TOKEN.sub("[REDACTED_TOKEN]", text)
        return _URL_PASSWORD.sub(r"\1***@", text)


class JsonFormatter(logging.Formatter):
    def __init__(self, redact: Redactor) -> None:
        super().__init__()
        self._redact = redact

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _RESERVED and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return self._redact(json.dumps(entry, ensure_ascii=False, default=str))


class TextFormatter(logging.Formatter):
    def __init__(self, redact: Redactor) -> None:
        super().__init__("%(asctime)s %(levelname)s %(name)s %(message)s")
        self._redact = redact

    def format(self, record: logging.LogRecord) -> str:
        extra = {
            k: v for k, v in vars(record).items() if k not in _RESERVED and not k.startswith("_")
        }
        line = super().format(record)
        if extra:
            line += " " + json.dumps(extra, ensure_ascii=False, default=str)
        return self._redact(line)


def configure(level: str = "INFO", fmt: str = "json", secrets: Iterable[str] = ()) -> None:
    handler = logging.StreamHandler(sys.stderr)
    redact = Redactor(secrets)
    handler.setFormatter(JsonFormatter(redact) if fmt == "json" else TextFormatter(redact))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # httpx logs full request URLs (the Bot API URL contains the token) at INFO.
    for noisy in ("httpx", "httpcore", "aiosqlite", "sqlalchemy.engine", "alembic.runtime.plugins"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
