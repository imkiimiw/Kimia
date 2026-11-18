"""The article draft: one normalized item from any source, validated before it is stored."""

from __future__ import annotations

from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field, field_validator

from wanger_news.config.models import IngestConfig
from wanger_news.domain.enums import Transport


class ImageRef(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    width: int | None = None
    height: int | None = None


class TelegramRef(BaseModel):
    """Where a Telegram post lives, so it can be copied (``copyMessage`` / ``copyMessages``)."""

    model_config = ConfigDict(frozen=True)

    chat_id: int
    chat_username: str | None = None
    message_ids: list[int] = Field(min_length=1)
    media_group_id: str | None = None
    media_kinds: list[str] = []
    file_unique_ids: list[str] = []
    forward_origin: str | None = None  # "chat:<id>:<message_id>" / "user:<id>" / "hidden:<name>"
    links: list[str] = []  # canonical URLs found in the post


class ArticleDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str
    transport: Transport
    external_id: str = Field(min_length=1, max_length=512)
    url: str | None = None
    canonical_url: str | None = None
    title_original: str
    description_original: str = ""
    content_original: str = ""
    author: str | None = None
    published_at: datetime | None = None
    fetched_at: datetime
    language: str
    country: str | None = None
    tags: list[str] = []
    images: list[ImageRef] = []
    telegram: TelegramRef | None = None
    content_hash: str | None = None
    simhash: int | None = None  # signed 64-bit
    token_count: int = 0

    @field_validator("published_at", "fetched_at")
    @classmethod
    def _aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("datetimes must be timezone-aware (UTC)")
        return value

    @property
    def effective_time(self) -> datetime:
        return self.published_at or self.fetched_at

    @property
    def body_text(self) -> str:
        return self.description_original or self.content_original


class Rejected(Exception):
    """A feed entry that cannot become an article (reason is logged and counted)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def check_draft(draft: ArticleDraft, cfg: IngestConfig) -> ArticleDraft:
    """Business validation (VALIDATE stage). Raises Rejected; may clamp a future date."""
    if draft.transport is Transport.RSS:
        if len(draft.title_original) < cfg.min_title_chars:
            raise Rejected("title_too_short")
        if not draft.canonical_url:
            raise Rejected("no_valid_url")
    elif not (draft.title_original or draft.telegram):
        raise Rejected("empty_post")
    if draft.published_at is not None:
        skew = timedelta(minutes=cfg.max_future_skew_minutes)
        if draft.published_at > draft.fetched_at + skew:
            # A wrong clock at the publisher must not make an item look fresh for days.
            draft = draft.model_copy(update={"published_at": draft.fetched_at})
    return draft
