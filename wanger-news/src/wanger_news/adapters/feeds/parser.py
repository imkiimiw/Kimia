"""RSS / Atom / RDF parsing with feedparser. Feed content is untrusted input."""

from __future__ import annotations

import calendar
import time
from datetime import UTC, datetime
from typing import Any

import feedparser

from wanger_news.domain.article import ImageRef
from wanger_news.domain.feed import ParsedFeed, RawEntry
from wanger_news.formatting.telegram_html import safe_href


class FeedParseError(Exception):
    pass


def _when(entry: Any) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if isinstance(value, time.struct_time):
            try:
                return datetime.fromtimestamp(calendar.timegm(value), tz=UTC)
            except (OverflowError, ValueError, OSError):
                return None
    return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _images(entry: Any) -> list[ImageRef]:
    found: list[ImageRef] = []
    candidates: list[dict[str, Any]] = []
    for item in entry.get("media_content", []) or []:
        medium = str(item.get("medium", ""))
        kind = str(item.get("type", ""))
        if medium == "image" or kind.startswith("image/"):
            candidates.append(item)
    candidates.extend(entry.get("media_thumbnail", []) or [])
    for enclosure in entry.get("enclosures", []) or []:
        if str(enclosure.get("type", "")).startswith("image/"):
            candidates.append({"url": enclosure.get("href") or enclosure.get("url")})
    for item in candidates:
        url = str(item.get("url") or "").strip()
        if url and safe_href(url) and not url.startswith("tg:"):
            found.append(
                ImageRef(url=url, width=_int(item.get("width")), height=_int(item.get("height")))
            )
    # widest first; images without a size keep their feed order
    return sorted(found, key=lambda img: -(img.width or 0))


def parse_feed(
    body: bytes, base_url: str, max_entries: int, content_type: str | None = None
) -> ParsedFeed:
    if not body.strip():
        raise FeedParseError("empty response")
    headers = {"content-location": base_url}
    if content_type:
        headers["content-type"] = content_type
    parsed = feedparser.parse(
        body,
        response_headers=headers,
        sanitize_html=True,
        resolve_relative_uris=True,
    )
    warning = None
    if parsed.get("bozo"):
        warning = f"{type(parsed.get('bozo_exception')).__name__}: {parsed.get('bozo_exception')}"
        warning = warning[:300]
    if not parsed.get("version") and not parsed.entries:
        raise FeedParseError(warning or "not an RSS/Atom feed")
    entries: list[RawEntry] = []
    for entry in parsed.entries[:max_entries]:
        content = entry.get("content") or []
        content_html = " ".join(str(c.get("value", "")) for c in content if isinstance(c, dict))
        entries.append(
            RawEntry(
                guid=(entry.get("id") or None),
                link=(entry.get("link") or None),
                title=str(entry.get("title", "")),
                summary_html=str(entry.get("summary", "")),
                content_html=content_html,
                author=(str(entry.get("author")) if entry.get("author") else None),
                published=_when(entry),
                tags=[str(t.get("term")) for t in entry.get("tags", []) or [] if t.get("term")],
                images=_images(entry),
            )
        )
    feed = parsed.get("feed", {})
    language = feed.get("language")
    return ParsedFeed(
        title=str(feed.get("title", "")),
        language=str(language)[:2].lower() if language else None,
        entries=entries,
        warning=warning,
    )
