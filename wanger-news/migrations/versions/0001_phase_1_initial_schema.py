"""Phase 1 initial schema: sources, health, articles, fingerprints, posts, jobs, runs, inbox.

Types are spelled out (no imports from the application) so this migration never changes when
the code does. Works on PostgreSQL (production) and SQLite (tests).

Revision ID: 0001
Revises:
Create Date: 2026-11-18 18:03:48.635658
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "admins",
        sa.Column("telegram_id", sa.BigInteger(), autoincrement=False, nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("telegram_id", name=op.f("pk_admins")),
    )
    op.create_table(
        "article_fingerprints",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("value", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_article_fingerprints")),
    )
    op.create_index(
        op.f("ix_article_fingerprints_article_id"),
        "article_fingerprints",
        ["article_id"],
        unique=False,
    )
    op.create_index(
        "ix_article_fingerprints_kind_value",
        "article_fingerprints",
        ["kind", "value"],
        unique=False,
    )
    op.create_table(
        "articles",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("source_id", sa.String(length=64), nullable=False),
        sa.Column("transport", sa.String(length=32), nullable=False),
        sa.Column("external_id", sa.String(length=512), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("canonical_url", sa.Text(), nullable=True),
        sa.Column("title_original", sa.Text(), nullable=False),
        sa.Column("description_original", sa.Text(), server_default="", nullable=False),
        sa.Column("content_original", sa.Text(), server_default="", nullable=False),
        sa.Column("author", sa.String(length=200), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("language", sa.String(length=8), nullable=False),
        sa.Column("country", sa.String(length=3), nullable=True),
        sa.Column("category", sa.String(length=32), nullable=True),
        sa.Column(
            "tags",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "entities",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "images",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "telegram",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("content_hash", sa.String(length=80), nullable=True),
        sa.Column("simhash", sa.BigInteger(), nullable=True),
        sa.Column("token_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("quality_score", sa.Integer(), nullable=True),
        sa.Column("priority", sa.Integer(), server_default="50", nullable=False),
        sa.Column("sensitive", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "classification",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("status_reason", sa.String(length=300), nullable=True),
        sa.Column("duplicate_of_id", sa.BigInteger(), nullable=True),
        sa.Column("dedup_level", sa.String(length=16), nullable=True),
        sa.Column("dedup_distance", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_articles")),
        sa.UniqueConstraint(
            "source_id", "external_id", name=op.f("uq_articles_source_id_external_id")
        ),
    )
    op.create_index(op.f("ix_articles_content_hash"), "articles", ["content_hash"], unique=False)
    op.create_index(
        op.f("ix_articles_duplicate_of_id"), "articles", ["duplicate_of_id"], unique=False
    )
    op.create_index(op.f("ix_articles_fetched_at"), "articles", ["fetched_at"], unique=False)
    op.create_index(
        "ix_articles_status_priority",
        "articles",
        ["status", "priority", "effective_at"],
        unique=False,
    )
    op.create_table(
        "locks",
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("holder", sa.String(length=64), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("name", name=op.f("pk_locks")),
    )
    op.create_table(
        "pipeline_runs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("dry_run", sa.Boolean(), nullable=False),
        sa.Column("trigger", sa.String(length=24), nullable=False),
        sa.Column(
            "summary",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_pipeline_runs")),
    )
    op.create_index(
        op.f("ix_pipeline_runs_started_at"), "pipeline_runs", ["started_at"], unique=False
    )
    op.create_table(
        "processing_jobs",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("stage", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="1", nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "details",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_processing_jobs")),
        sa.UniqueConstraint(
            "article_id", "stage", name=op.f("uq_processing_jobs_article_id_stage")
        ),
    )
    op.create_index(
        op.f("ix_processing_jobs_finished_at"), "processing_jobs", ["finished_at"], unique=False
    )
    op.create_table(
        "published_posts",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("channel_role", sa.String(length=8), nullable=False),
        sa.Column("chat_id", sa.String(length=64), nullable=False),
        sa.Column("method", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column(
            "message_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("claimed_by", sa.String(length=64), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_published_posts")),
        sa.UniqueConstraint("idempotency_key", name=op.f("uq_published_posts_idempotency_key")),
    )
    op.create_index(
        op.f("ix_published_posts_article_id"), "published_posts", ["article_id"], unique=False
    )
    op.create_index(
        "ix_published_posts_status_claimed_at",
        "published_posts",
        ["status", "claimed_at"],
        unique=False,
    )
    op.create_table(
        "settings",
        sa.Column("key", sa.String(length=100), nullable=False),
        sa.Column(
            "value",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_settings")),
    )
    op.create_table(
        "source_health",
        sa.Column("source_id", sa.String(length=64), nullable=False),
        sa.Column("state", sa.String(length=16), server_default="closed", nullable=False),
        sa.Column("consecutive_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_successes", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cooldown_minutes", sa.Integer(), nullable=True),
        sa.Column("opened_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_item_count", sa.Integer(), nullable=True),
        sa.Column("last_new_count", sa.Integer(), nullable=True),
        sa.Column("etag", sa.String(length=512), nullable=True),
        sa.Column("last_modified", sa.String(length=128), nullable=True),
        sa.Column("robots_allowed", sa.Boolean(), nullable=True),
        sa.Column("robots_reason", sa.String(length=200), nullable=True),
        sa.Column("robots_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("source_id", name=op.f("pk_source_health")),
    )
    op.create_table(
        "sources",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("domain", sa.String(length=255), nullable=True),
        sa.Column("country", sa.String(length=3), nullable=True),
        sa.Column("language", sa.String(length=8), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=32), nullable=False),
        sa.Column("transport", sa.String(length=32), nullable=False),
        sa.Column("reliability_score", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("inactive_reason", sa.Text(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("owner_group", sa.String(length=64), nullable=False),
        sa.Column("in_config", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "config",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("config_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sources")),
    )
    op.create_table(
        "system_logs",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("level", sa.String(length=10), nullable=False),
        sa.Column("event", sa.String(length=100), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column(
            "context",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_system_logs")),
    )
    op.create_index(op.f("ix_system_logs_created_at"), "system_logs", ["created_at"], unique=False)
    op.create_table(
        "telegram_updates",
        sa.Column("update_id", sa.BigInteger(), autoincrement=False, nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("chat_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "payload",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("outcome", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("update_id", name=op.f("pk_telegram_updates")),
    )
    op.create_index(
        op.f("ix_telegram_updates_processed_at"), "telegram_updates", ["processed_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_telegram_updates_processed_at"), table_name="telegram_updates")
    op.drop_table("telegram_updates")
    op.drop_index(op.f("ix_system_logs_created_at"), table_name="system_logs")
    op.drop_table("system_logs")
    op.drop_table("sources")
    op.drop_table("source_health")
    op.drop_table("settings")
    op.drop_index("ix_published_posts_status_claimed_at", table_name="published_posts")
    op.drop_index(op.f("ix_published_posts_article_id"), table_name="published_posts")
    op.drop_table("published_posts")
    op.drop_index(op.f("ix_processing_jobs_finished_at"), table_name="processing_jobs")
    op.drop_table("processing_jobs")
    op.drop_index(op.f("ix_pipeline_runs_started_at"), table_name="pipeline_runs")
    op.drop_table("pipeline_runs")
    op.drop_table("locks")
    op.drop_index("ix_articles_status_priority", table_name="articles")
    op.drop_index(op.f("ix_articles_fetched_at"), table_name="articles")
    op.drop_index(op.f("ix_articles_duplicate_of_id"), table_name="articles")
    op.drop_index(op.f("ix_articles_content_hash"), table_name="articles")
    op.drop_table("articles")
    op.drop_index("ix_article_fingerprints_kind_value", table_name="article_fingerprints")
    op.drop_index(op.f("ix_article_fingerprints_article_id"), table_name="article_fingerprints")
    op.drop_table("article_fingerprints")
    op.drop_table("admins")
