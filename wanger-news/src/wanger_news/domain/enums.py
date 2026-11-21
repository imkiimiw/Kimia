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
    AI_PENDING = "ai_pending"  # passed the gate, waiting for the AI stage (summary + guard)
    QUEUED = "queued"  # ready: validated (or human-curated / human-approved), waiting to be posted
    PENDING_REVIEW = "pending_review"  # waits for a human decision (review card in PM)
    HELD = "held"  # manual publish mode: prepared, posted only when an admin picks it
    REJECTED = "rejected"  # a human rejected it
    MERGED = "merged"  # part of a story: its report is carried by the story's posts (Phase 3)
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


class ClusterRole(StrEnum):
    """An article's place in its story (Phase 3)."""

    LEAD = "lead"  # its post represents the story
    SUPPORT = "support"  # joined before the summary: one more source for it
    UPDATE = "update"  # joined after publication (or while the lead waited): maybe news
    CORROBORATION = "corroboration"  # same origin, or nothing new: counted, not posted
    HUMAN = "human"  # a source-channel post (copied as it is)
    EXTERNAL = "external"  # posted by hand in a target channel


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
    CLUSTER = "cluster"
    AI_SUMMARIZE = "ai_summarize"
    AI_UPDATE = "ai_update"
    PUBLISH = "publish"
    SOURCE_POST = "source_post"
    REVIEW = "review"


class PublishMode(StrEnum):
    """Spec §11, per category. MVP default: semi."""

    AUTO = "auto"  # validated + confident + not sensitive → posted without a human
    SEMI = "semi"  # AI prepares, an admin approves
    MANUAL = "manual"  # prepared and held; an admin picks what to post


class SummaryOrigin(StrEnum):
    AI = "ai"
    REWRITE = "rewrite"  # the guard's one rewrite pass
    HUMAN = "human"  # an admin's edit


class AIRunStatus(StrEnum):
    OK = "ok"
    INVALID_OUTPUT = "invalid_output"  # not JSON / wrong schema / wrong ids
    BLOCKED = "blocked"  # safety or recitation block, or a truncated answer
    QUOTA = "quota"  # 429 / quota: the rest waits for the next run
    ERROR = "error"  # transport or server error


class ReviewAction(StrEnum):
    APPROVE = "approve"
    PUBLISH = "publish"  # approve and post in this run, ahead of the queue
    EDIT = "edit"
    REJECT = "reject"


class RunStatus(StrEnum):
    RUNNING = "running"
    OK = "ok"
    PARTIAL = "partial"  # finished, but some sources or posts failed
    FAILED = "failed"
    SKIPPED_LOCKED = "skipped_locked"
