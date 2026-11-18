"""NORMALIZE stage: a parsed feed entry → an ArticleDraft (clean text, canonical URL, hashes)."""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import NamedTuple

from wanger_news.config.models import DedupConfig, IngestConfig, SourceConfig
from wanger_news.domain.article import ArticleDraft, Rejected
from wanger_news.domain.enums import Transport
from wanger_news.domain.feed import RawEntry
from wanger_news.domain.fingerprint import content_hash, simhash64, to_signed64
from wanger_news.domain.text import clean_text, detect_language, html_to_text, tokens, truncate
from wanger_news.domain.urls import UrlPolicy, normalize_url


def url_policy(cfg: DedupConfig) -> UrlPolicy:
    return UrlPolicy(
        tracking_params=frozenset(p.lower() for p in cfg.tracking_params),
        tracking_prefixes=tuple(p.lower() for p in cfg.tracking_param_prefixes),
        strip_host_prefixes=tuple(cfg.strip_host_prefixes),
    )


class Fingerprints(NamedTuple):
    content_hash: str | None
    simhash: int | None  # signed 64-bit, for a BIGINT column
    token_count: int


def fingerprints(title: str, body: str, dedup: DedupConfig) -> Fingerprints:
    words = tokens(f"{title}\n{body}")
    return Fingerprints(
        content_hash=content_hash(title, body),
        simhash=to_signed64(simhash64(words, dedup.shingle_size)) if words else None,
        token_count=len(words),
    )


def entry_to_draft(
    entry: RawEntry,
    source: SourceConfig,
    fetched_at: datetime,
    ingest: IngestConfig,
    dedup: DedupConfig,
    policy: UrlPolicy,
) -> ArticleDraft:
    title = truncate(
        clean_text(html_to_text(entry.title)).replace("\n", " "), ingest.max_title_chars
    )
    description = truncate(html_to_text(entry.summary_html), ingest.max_description_chars)
    content = truncate(html_to_text(entry.content_html), ingest.max_content_chars)
    if description and content.startswith(description[:80]):
        content = content if len(content) > len(description) else ""
    original_url = entry.link
    canonical = normalize_url(entry.link or "", policy)
    if canonical is None and entry.guid and entry.guid.startswith(("http://", "https://")):
        original_url, canonical = entry.guid, normalize_url(entry.guid, policy)
    if canonical is None:
        raise Rejected("no_valid_url")
    external = entry.guid or canonical
    if len(external) > 512:
        external = "sha256:" + hashlib.sha256(external.encode()).hexdigest()
    prints = fingerprints(title, description or content, dedup)
    language = source.language
    if source.language == "fa" and detect_language(title) == "en":
        language = "en"
    return ArticleDraft(
        source_id=source.id,
        transport=Transport.RSS,
        external_id=external,
        url=(original_url or canonical)[:2048],
        canonical_url=canonical,
        title_original=title,
        description_original=description,
        content_original=content,
        author=entry.author[:200] if entry.author else None,
        published_at=entry.published,
        fetched_at=fetched_at,
        language=language,
        country=source.country,
        tags=[t[:64] for t in entry.tags[:20]],
        images=entry.images[:3],
        content_hash=prints.content_hash,
        simhash=prints.simhash,
        token_count=prints.token_count,
    )
