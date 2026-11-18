"""What a feed parser produces (transport-neutral, so the domain does not depend on adapters)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from wanger_news.domain.article import ImageRef


@dataclass(frozen=True, slots=True)
class RawEntry:
    guid: str | None
    link: str | None
    title: str
    summary_html: str
    content_html: str
    author: str | None
    published: datetime | None
    tags: list[str] = field(default_factory=list)
    images: list[ImageRef] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ParsedFeed:
    title: str
    language: str | None
    entries: list[RawEntry]
    warning: str | None  # feedparser "bozo" reason when the feed was malformed but usable
