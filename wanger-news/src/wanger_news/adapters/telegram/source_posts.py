"""A channel post (or an album of posts) → ArticleDraft, with everything needed for dedup."""

from __future__ import annotations

from datetime import UTC, datetime

from wanger_news.adapters.telegram.types import Message, entity_text
from wanger_news.config.models import DedupConfig, SourceConfig
from wanger_news.domain.article import ArticleDraft, TelegramRef
from wanger_news.domain.enums import Transport
from wanger_news.domain.normalize import fingerprints
from wanger_news.domain.text import clean_text, detect_language, truncate
from wanger_news.domain.urls import UrlPolicy, normalize_url

_URL_ENTITY = "url"
_TEXT_LINK = "text_link"
TITLE_CHARS = 200


def post_links(message: Message, policy: UrlPolicy) -> list[str]:
    links: list[str] = []
    for entity in message.body_entities:
        raw = None
        if entity.type == _URL_ENTITY:
            raw = entity_text(message.body, entity)
            if not raw.lower().startswith(("http://", "https://")):
                raw = "https://" + raw
        elif entity.type == _TEXT_LINK:
            raw = entity.url
        canonical = normalize_url(raw or "", policy)
        if canonical and canonical not in links:
            links.append(canonical)
    return links


def public_link(username: str | None, message_id: int) -> str | None:
    return f"https://t.me/{username}/{message_id}" if username else None


def posts_to_draft(
    messages: list[Message],
    source: SourceConfig | None,
    *,
    source_id: str,
    fetched_at: datetime,
    dedup: DedupConfig,
    policy: UrlPolicy,
    fallback_language: str = "fa",
) -> ArticleDraft:
    """``messages`` are the parts of one post (one message, or every part of an album)."""
    messages = sorted(messages, key=lambda m: m.message_id)
    first = messages[0]
    body = clean_text("\n".join(m.body for m in messages if m.body))
    lines = [line for line in body.split("\n") if line.strip()]
    title = truncate(lines[0], TITLE_CHARS) if lines else ""
    links: list[str] = []
    media_kinds: list[str] = []
    file_ids: list[str] = []
    for message in messages:
        links.extend(link for link in post_links(message, policy) if link not in links)
        for kind, ref in message.media():
            media_kinds.append(kind)
            file_ids.append(ref.file_unique_id)
    origin = next((m.forward_origin.key() for m in messages if m.forward_origin), None)
    chat = first.chat
    prints = fingerprints(title, body, dedup)
    language = detect_language(body) or (source.language if source else fallback_language)
    url = public_link(chat.username, first.message_id)
    return ArticleDraft(
        source_id=source_id,
        transport=Transport.TELEGRAM_CHANNEL,
        external_id=f"tg:{chat.id}:{first.message_id}",
        url=url,
        canonical_url=normalize_url(url, policy) if url else None,
        title_original=title,
        description_original=body,
        published_at=datetime.fromtimestamp(first.date, tz=UTC),
        fetched_at=fetched_at,
        language=language,
        country=source.country if source else None,
        telegram=TelegramRef(
            chat_id=chat.id,
            chat_username=chat.username,
            message_ids=[m.message_id for m in messages],
            media_group_id=first.media_group_id,
            media_kinds=media_kinds,
            file_unique_ids=file_ids,
            forward_origin=origin,
            links=links,
        ),
        content_hash=prints.content_hash,
        simhash=prints.simhash,
        token_count=prints.token_count,
    )
