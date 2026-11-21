"""Phase 1 tables. ALL state lives here (GitHub Actions runs are stateless).

Later phases add their own tables in their own migrations (story_clusters, claims, evidence,
entities, translations, summaries, corrections, ai_runs, reliability_history …) — see
ARCHITECTURE.md §Data model.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from wanger_news.db.base import Base, BigId, EmbeddingType, JSONType

_now = sa.text("CURRENT_TIMESTAMP")


class Admin(Base):
    __tablename__ = "admins"
    telegram_id: Mapped[int] = mapped_column(sa.BigInteger, primary_key=True, autoincrement=False)
    role: Mapped[str] = mapped_column(sa.String(16))
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class Source(Base):
    __tablename__ = "sources"
    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    name: Mapped[str] = mapped_column(sa.String(120))
    domain: Mapped[str | None] = mapped_column(sa.String(255))
    country: Mapped[str | None] = mapped_column(sa.String(3))
    language: Mapped[str] = mapped_column(sa.String(8))
    category: Mapped[str] = mapped_column(sa.String(32))
    source_type: Mapped[str] = mapped_column(sa.String(32))
    transport: Mapped[str] = mapped_column(sa.String(32))
    reliability_score: Mapped[int] = mapped_column(sa.Integer)
    active: Mapped[bool] = mapped_column(sa.Boolean)
    inactive_reason: Mapped[str | None] = mapped_column(sa.Text)
    priority: Mapped[int] = mapped_column(sa.Integer)
    owner_group: Mapped[str] = mapped_column(sa.String(64))
    in_config: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.true())
    config: Mapped[dict[str, Any]] = mapped_column(JSONType)
    config_hash: Mapped[str] = mapped_column(sa.String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class SourceHealth(Base):
    __tablename__ = "source_health"
    source_id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    state: Mapped[str] = mapped_column(sa.String(16), server_default="closed")
    consecutive_failures: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    total_failures: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    total_successes: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    cooldown_minutes: Mapped[int | None] = mapped_column(sa.Integer)
    opened_until: Mapped[datetime | None] = mapped_column()
    last_attempt_at: Mapped[datetime | None] = mapped_column()
    last_success_at: Mapped[datetime | None] = mapped_column()
    last_error: Mapped[str | None] = mapped_column(sa.Text)
    last_error_at: Mapped[datetime | None] = mapped_column()
    last_item_count: Mapped[int | None] = mapped_column(sa.Integer)
    last_new_count: Mapped[int | None] = mapped_column(sa.Integer)
    etag: Mapped[str | None] = mapped_column(sa.String(512))
    last_modified: Mapped[str | None] = mapped_column(sa.String(128))
    robots_allowed: Mapped[bool | None] = mapped_column(sa.Boolean)
    robots_reason: Mapped[str | None] = mapped_column(sa.String(200))
    robots_checked_at: Mapped[datetime | None] = mapped_column()
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class Article(Base):
    __tablename__ = "articles"
    __table_args__ = (
        sa.UniqueConstraint("source_id", "external_id"),
        sa.Index("ix_articles_status_priority", "status", "priority", "effective_at"),
    )
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    source_id: Mapped[str] = mapped_column(sa.String(64))
    transport: Mapped[str] = mapped_column(sa.String(32))
    external_id: Mapped[str] = mapped_column(sa.String(512))
    url: Mapped[str | None] = mapped_column(sa.Text)
    canonical_url: Mapped[str | None] = mapped_column(sa.Text)
    title_original: Mapped[str] = mapped_column(sa.Text)
    description_original: Mapped[str] = mapped_column(sa.Text, server_default="")
    content_original: Mapped[str] = mapped_column(sa.Text, server_default="")
    author: Mapped[str | None] = mapped_column(sa.String(200))
    published_at: Mapped[datetime | None] = mapped_column()
    fetched_at: Mapped[datetime] = mapped_column(index=True)
    effective_at: Mapped[datetime] = mapped_column()  # published_at, else fetched_at
    language: Mapped[str] = mapped_column(sa.String(8))
    country: Mapped[str | None] = mapped_column(sa.String(3))
    category: Mapped[str | None] = mapped_column(sa.String(32))
    tags: Mapped[list[str]] = mapped_column(JSONType, default=list)
    entities: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    images: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    telegram: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    content_hash: Mapped[str | None] = mapped_column(sa.String(80), index=True)
    simhash: Mapped[int | None] = mapped_column(sa.BigInteger)
    token_count: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    quality_score: Mapped[int | None] = mapped_column(sa.Integer)
    priority: Mapped[int] = mapped_column(sa.Integer, server_default="50")
    sensitive: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.false())
    classification: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    status: Mapped[str] = mapped_column(sa.String(24))
    status_reason: Mapped[str | None] = mapped_column(sa.String(300))
    duplicate_of_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True)
    dedup_level: Mapped[str | None] = mapped_column(sa.String(16))
    dedup_distance: Mapped[int | None] = mapped_column(sa.Integer)
    # Phase 2 (migration 0002)
    summary_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    importance_score: Mapped[int | None] = mapped_column(sa.Integer)
    importance: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    confidence_score: Mapped[int | None] = mapped_column(sa.Integer)
    confidence: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    publish_mode: Mapped[str | None] = mapped_column(sa.String(8))
    review_reason: Mapped[str | None] = mapped_column(sa.String(300))
    approved_by: Mapped[int | None] = mapped_column(sa.BigInteger)
    approved_at: Mapped[datetime | None] = mapped_column()
    publish_now: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.false())
    # Phase 3 (migration 0003)
    cluster_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True)
    cluster_role: Mapped[str | None] = mapped_column(sa.String(16))
    cluster_score: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    embedding: Mapped[list[float] | None] = mapped_column(EmbeddingType)
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class ArticleFingerprint(Base):
    """Exact-duplicate keys (level 1): url / content / media / tg_origin."""

    __tablename__ = "article_fingerprints"
    __table_args__ = (sa.Index("ix_article_fingerprints_kind_value", "kind", "value"),)
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    kind: Mapped[str] = mapped_column(sa.String(16))
    value: Mapped[str] = mapped_column(sa.String(255))
    created_at: Mapped[datetime] = mapped_column(server_default=_now)


class PublishedPost(Base):
    """One row per (article, channel). The unique idempotency key makes a double post impossible."""

    __tablename__ = "published_posts"
    __table_args__ = (sa.Index("ix_published_posts_status_claimed_at", "status", "claimed_at"),)
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    idempotency_key: Mapped[str] = mapped_column(sa.String(200), unique=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    channel_role: Mapped[str] = mapped_column(sa.String(8))
    chat_id: Mapped[str] = mapped_column(sa.String(64))
    method: Mapped[str] = mapped_column(sa.String(32))
    status: Mapped[str] = mapped_column(sa.String(16))
    message_ids: Mapped[list[int]] = mapped_column(JSONType, default=list)
    text: Mapped[str | None] = mapped_column(sa.Text)
    attempts: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    error: Mapped[str | None] = mapped_column(sa.Text)
    claimed_by: Mapped[str | None] = mapped_column(sa.String(64))
    claimed_at: Mapped[datetime | None] = mapped_column()
    sent_at: Mapped[datetime | None] = mapped_column()
    kind: Mapped[str] = mapped_column(sa.String(16), server_default="story")  # story | update
    cluster_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    reply_to_message_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class ProcessingJob(Base):
    """Per article and stage: done / failed / skipped, attempts and the last error."""

    __tablename__ = "processing_jobs"
    __table_args__ = (sa.UniqueConstraint("article_id", "stage"),)
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger)
    stage: Mapped[str] = mapped_column(sa.String(24))
    status: Mapped[str] = mapped_column(sa.String(16))
    attempts: Mapped[int] = mapped_column(sa.Integer, server_default="1")
    run_id: Mapped[str | None] = mapped_column(sa.String(64))
    error: Mapped[str | None] = mapped_column(sa.Text)
    details: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    started_at: Mapped[datetime] = mapped_column()
    finished_at: Mapped[datetime | None] = mapped_column(index=True)


class PipelineRun(Base):
    __tablename__ = "pipeline_runs"
    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    started_at: Mapped[datetime] = mapped_column(index=True)
    finished_at: Mapped[datetime | None] = mapped_column()
    status: Mapped[str] = mapped_column(sa.String(24))
    dry_run: Mapped[bool] = mapped_column(sa.Boolean)
    trigger: Mapped[str] = mapped_column(sa.String(24))
    summary: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    error: Mapped[str | None] = mapped_column(sa.Text)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(sa.String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONType)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class Lock(Base):
    """Lease locks: a crashed holder's lock simply expires."""

    __tablename__ = "locks"
    name: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    holder: Mapped[str] = mapped_column(sa.String(64))
    acquired_at: Mapped[datetime] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column()


class TelegramUpdate(Base):
    """Inbox of getUpdates results; stored before the offset is confirmed to Telegram."""

    __tablename__ = "telegram_updates"
    update_id: Mapped[int] = mapped_column(sa.BigInteger, primary_key=True, autoincrement=False)
    kind: Mapped[str] = mapped_column(sa.String(24))
    chat_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONType)
    received_at: Mapped[datetime] = mapped_column()
    processed_at: Mapped[datetime | None] = mapped_column(index=True)
    outcome: Mapped[str | None] = mapped_column(sa.String(64))


class SystemLog(Base):
    __tablename__ = "system_logs"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(index=True)
    level: Mapped[str] = mapped_column(sa.String(10))
    event: Mapped[str] = mapped_column(sa.String(100))
    run_id: Mapped[str | None] = mapped_column(sa.String(64))
    context: Mapped[dict[str, Any] | None] = mapped_column(JSONType)


# ------------------------------------------------------------------------------ Phase 2


class AIRun(Base):
    """Every AI call (spec §15): time, items, model, prompt version, tokens, cost, result, error."""

    __tablename__ = "ai_runs"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    run_id: Mapped[str | None] = mapped_column(sa.String(64), index=True)
    provider: Mapped[str] = mapped_column(sa.String(32))
    model: Mapped[str] = mapped_column(sa.String(64))
    operation: Mapped[str] = mapped_column(sa.String(32))
    prompt_version: Mapped[str] = mapped_column(sa.String(64))
    article_ids: Mapped[list[int]] = mapped_column(JSONType, default=list)
    status: Mapped[str] = mapped_column(sa.String(24))
    started_at: Mapped[datetime] = mapped_column(index=True)
    finished_at: Mapped[datetime | None] = mapped_column()
    input_tokens: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    output_tokens: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    thinking_tokens: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    cost_usd: Mapped[float] = mapped_column(sa.Float, server_default="0")
    error: Mapped[str | None] = mapped_column(sa.Text)
    response_excerpt: Mapped[str | None] = mapped_column(sa.Text)


class Summary(Base):
    """A Persian rendering of an article (AI, rewrite or a human edit) and its guard report.

    This is also the "translation": full articles are never translated (copyright, spec §3.4).
    """

    __tablename__ = "summaries"
    __table_args__ = (
        sa.Index("ix_summaries_source_hash_prompt_version", "source_hash", "prompt_version"),
    )
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    language: Mapped[str] = mapped_column(sa.String(8))
    origin: Mapped[str] = mapped_column(sa.String(16))
    prompt_version: Mapped[str] = mapped_column(sa.String(64))
    model: Mapped[str | None] = mapped_column(sa.String(64))
    source_hash: Mapped[str] = mapped_column(sa.String(80))
    title: Mapped[str] = mapped_column(sa.Text)
    summary: Mapped[str] = mapped_column(sa.Text)
    key_points: Mapped[list[str]] = mapped_column(JSONType, default=list)
    entities: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    quotes: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    claims: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    category: Mapped[str | None] = mapped_column(sa.String(32))
    importance_factors: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    insufficient: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.false())
    guard: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    valid: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.false())
    created_by: Mapped[int | None] = mapped_column(sa.BigInteger)
    created_at: Mapped[datetime] = mapped_column(server_default=_now)


class ReviewRequest(Base):
    """A review card (or an edit prompt) sent to an admin's private chat."""

    __tablename__ = "review_requests"
    __table_args__ = (sa.Index("ix_review_requests_status_kind", "status", "kind"),)
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    kind: Mapped[str] = mapped_column(sa.String(16))  # card | edit_prompt
    admin_id: Mapped[int] = mapped_column(sa.BigInteger)
    chat_id: Mapped[int] = mapped_column(sa.BigInteger)
    message_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    status: Mapped[str] = mapped_column(sa.String(16))  # open | closed
    outcome: Mapped[str | None] = mapped_column(sa.String(32))
    closed_by: Mapped[int | None] = mapped_column(sa.BigInteger)
    created_at: Mapped[datetime] = mapped_column()
    closed_at: Mapped[datetime | None] = mapped_column()


# ------------------------------------------------------------------------------ Phase 3


class StoryCluster(Base):
    """One event (spec §7). Lives on after publication so later reports become update posts."""

    __tablename__ = "story_clusters"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(sa.String(32), unique=True)
    lead_article_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    title: Mapped[str | None] = mapped_column(sa.Text)
    summary_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    category: Mapped[str | None] = mapped_column(sa.String(32))
    entities: Mapped[list[str]] = mapped_column(JSONType, default=list)
    locations: Mapped[list[str]] = mapped_column(JSONType, default=list)
    first_seen: Mapped[datetime] = mapped_column()
    last_updated: Mapped[datetime] = mapped_column(index=True)
    importance_score: Mapped[int | None] = mapped_column(sa.Integer)
    confidence_score: Mapped[int | None] = mapped_column(sa.Integer)
    independent_sources: Mapped[int] = mapped_column(sa.Integer, server_default="1")
    sources: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    member_count: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    centroid: Mapped[list[float] | None] = mapped_column(EmbeddingType)
    contradictions: Mapped[int] = mapped_column(sa.Integer, server_default="0")
    timeline: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, default=list)
    published_at: Mapped[datetime | None] = mapped_column()
    post_chat: Mapped[str | None] = mapped_column(sa.String(64))
    post_message_id: Mapped[int | None] = mapped_column(sa.BigInteger)
    published_text: Mapped[dict[str, Any] | None] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
    updated_at: Mapped[datetime] = mapped_column(server_default=_now)


class Claim(Base):
    """A factual claim of a published-or-pending text (spec §8): who says it, how sure we are."""

    __tablename__ = "claims"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    cluster_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True)
    summary_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger)
    text: Mapped[str] = mapped_column(sa.Text)
    status: Mapped[str] = mapped_column(
        sa.String(16)
    )  # confirmed likely unconfirmed conflicting rejected
    confidence: Mapped[int] = mapped_column(sa.Integer)
    source_article_ids: Mapped[list[int]] = mapped_column(JSONType, default=list)
    versions: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONType)
    created_at: Mapped[datetime] = mapped_column(server_default=_now)


class Evidence(Base):
    """A verbatim excerpt of one article that supports (or contradicts) a claim."""

    __tablename__ = "evidence"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    claim_id: Mapped[int] = mapped_column(sa.BigInteger, index=True)
    article_id: Mapped[int] = mapped_column(sa.BigInteger)
    excerpt: Mapped[str] = mapped_column(sa.Text)
    supports: Mapped[bool] = mapped_column(sa.Boolean, server_default=sa.true())
    created_at: Mapped[datetime] = mapped_column(server_default=_now)
