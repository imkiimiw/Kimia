"""Closed sets of values used across the code base (stored as plain strings in the DB)."""

from __future__ import annotations

from enum import StrEnum


class SourceType(StrEnum):
    NEWS_AGENCY = "news_agency"
    NEWSPAPER = "newspaper"
    TV = "tv"
    GOVERNMENT = "government"
    OFFICIAL_ORGANIZATION = "official_organization"
    SPECIALIZED_MEDIA = "specialized_media"
    BLOG = "blog"
    SOCIAL_OFFICIAL_ACCOUNT = "social_official_account"


class Transport(StrEnum):
    """How items of a source are obtained."""

    RSS = "rss"
    TELEGRAM_CHANNEL = "telegram_channel"
    API = "api"  # interface only (later phase)
    SCRAPE = "scrape"  # interface only (later phase), never for paywalled content


class ArticleStatus(StrEnum):
    NEW = "new"  # stored, waiting for classification
    QUEUED = "queued"  # passed the gate, waiting to be published
    PENDING_REVIEW = "pending_review"  # sensitive: needs a human (review UI arrives in Phase 2)
    PUBLISHED = "published"
    DUPLICATE = "duplicate"
    FILTERED = "filtered"  # below the gate, or black/whitelist
    THROTTLED = "throttled"  # source produced an abnormal burst
    STALE = "stale"  # too old when first seen (backfill protection)
    EXPIRED = "expired"  # too old when its turn to publish came
    FAILED = "failed"  # publishing failed permanently
    UNCERTAIN = "uncertain"  # the send may or may not have happened: never re-sent automatically
    EXTERNAL = "external"  # seen in a target channel, posted by a human (dedup reference only)


#: Statuses that mean "this content reached (or may have reached) a channel".
PUBLISHED_LIKE: frozenset[ArticleStatus] = frozenset(
    {ArticleStatus.PUBLISHED, ArticleStatus.UNCERTAIN, ArticleStatus.EXTERNAL}
)


class DedupLevel(StrEnum):
    EXACT = "exact"  # same normalized URL / content hash / media / forwarded origin
    NEAR = "near"  # SimHash distance within the configured threshold
    EVENT = "event"  # same event (Phase 3, embeddings + entities)


class FingerprintKind(StrEnum):
    URL = "url"
    CONTENT = "content"
    MEDIA = "media"
    TG_ORIGIN = "tg_origin"


class PostStatus(StrEnum):
    CLAIMED = "claimed"  # claimed by a run, the send is in progress
    SENT = "sent"
    FAILED = "failed"  # definitely not sent; may be retried while attempts remain
    UNCERTAIN = "uncertain"  # the outcome is unknown; never retried automatically


class ChannelRole(StrEnum):
    TEST = "test"
    MAIN = "main"


class JobStatus(StrEnum):
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


class Stage(StrEnum):
    INGEST = "ingest"
    CLASSIFY = "classify"
    PUBLISH = "publish"
    SOURCE_POST = "source_post"


class RunStatus(StrEnum):
    RUNNING = "running"
    OK = "ok"
    PARTIAL = "partial"  # finished, but some sources or posts failed
    FAILED = "failed"
    SKIPPED_LOCKED = "skipped_locked"
