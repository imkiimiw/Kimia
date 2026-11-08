"""Structured JSON logs (structlog). The bot token and the worker secret are redacted from every event,
and file contents, OCR text and user text never reach a log line (only ids, codes and sizes)."""
from __future__ import annotations

import logging
import re
import sys

import structlog

_SECRETS: list[str] = []
_TOKEN_RE = re.compile(r"\d{6,12}:[A-Za-z0-9_-]{30,}")


def add_secret(value: str | None) -> None:
    if value and len(value) >= 8:
        _SECRETS.append(value)


def redact(text: str) -> str:
    for s in _SECRETS:
        text = text.replace(s, "[REDACTED]")
    return _TOKEN_RE.sub("[REDACTED]", text)


def _redactor(_, __, event: dict) -> dict:
    return {k: redact(v) if isinstance(v, str) else v for k, v in event.items()}


def setup(level: str = "INFO") -> None:
    logging.basicConfig(stream=sys.stdout, level=level, format="%(message)s")
    for noisy in ("httpx", "httpcore"):  # httpx logs request URLs, which contain the bot token
        logging.getLogger(noisy).setLevel(logging.WARNING)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.format_exc_info,
            _redactor,
            structlog.processors.JSONRenderer(ensure_ascii=False),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get(name: str = "worker"):
    return structlog.get_logger(name)
