"""Phase 2: AI runs, Persian summaries, review requests; scores and review fields on articles.

Data: Phase 1 items that were waiting (queued / pending_review, from feeds) had no Persian
summary, so they move to `ai_pending`; downgrade maps the new statuses back to Phase 1 ones.
Types are spelled out (no application imports). Works on PostgreSQL and SQLite.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-21 12:53:38.524913
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_runs",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("run_id", sa.String(length=64), nullable=True),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=32), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column(
            "article_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("input_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("output_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("thinking_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cost_usd", sa.Float(), server_default="0", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("response_excerpt", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_runs")),
    )
    op.create_index(op.f("ix_ai_runs_run_id"), "ai_runs", ["run_id"], unique=False)
    op.create_index(op.f("ix_ai_runs_started_at"), "ai_runs", ["started_at"], unique=False)
    op.create_table(
        "review_requests",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("admin_id", sa.BigInteger(), nullable=False),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("message_id", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("outcome", sa.String(length=32), nullable=True),
        sa.Column("closed_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_review_requests")),
    )
    op.create_index(
        op.f("ix_review_requests_article_id"), "review_requests", ["article_id"], unique=False
    )
    op.create_index(
        "ix_review_requests_status_kind", "review_requests", ["status", "kind"], unique=False
    )
    op.create_table(
        "summaries",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("language", sa.String(length=8), nullable=False),
        sa.Column("origin", sa.String(length=16), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=True),
        sa.Column("source_hash", sa.String(length=80), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column(
            "key_points",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "entities",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "quotes",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "claims",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("category", sa.String(length=32), nullable=True),
        sa.Column(
            "importance_factors",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("insufficient", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "guard",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("valid", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_summaries")),
    )
    op.create_index(op.f("ix_summaries_article_id"), "summaries", ["article_id"], unique=False)
    op.create_index(
        "ix_summaries_source_hash_prompt_version",
        "summaries",
        ["source_hash", "prompt_version"],
        unique=False,
    )
    with op.batch_alter_table("articles") as batch:
        batch.add_column(sa.Column("summary_id", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("importance_score", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column(
                "importance",
                sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
                nullable=True,
            )
        )
        batch.add_column(sa.Column("confidence_score", sa.Integer(), nullable=True))
        batch.add_column(
            sa.Column(
                "confidence",
                sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
                nullable=True,
            )
        )
        batch.add_column(sa.Column("publish_mode", sa.String(length=8), nullable=True))
        batch.add_column(sa.Column("review_reason", sa.String(length=300), nullable=True))
        batch.add_column(sa.Column("approved_by", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(
            sa.Column("publish_now", sa.Boolean(), server_default=sa.text("false"), nullable=False)
        )
    op.execute(
        "UPDATE articles SET status = 'ai_pending' "
        "WHERE transport = 'rss' AND status IN ('queued', 'pending_review')"
    )


def downgrade() -> None:
    op.execute("UPDATE articles SET status = 'queued' WHERE status = 'ai_pending'")
    op.execute("UPDATE articles SET status = 'pending_review' WHERE status = 'held'")
    op.execute("UPDATE articles SET status = 'filtered' WHERE status = 'rejected'")
    with op.batch_alter_table("articles") as batch:
        batch.drop_column("publish_now")
        batch.drop_column("approved_at")
        batch.drop_column("approved_by")
        batch.drop_column("review_reason")
        batch.drop_column("publish_mode")
        batch.drop_column("confidence")
        batch.drop_column("confidence_score")
        batch.drop_column("importance")
        batch.drop_column("importance_score")
        batch.drop_column("summary_id")
    op.drop_index("ix_summaries_source_hash_prompt_version", table_name="summaries")
    op.drop_index(op.f("ix_summaries_article_id"), table_name="summaries")
    op.drop_table("summaries")
    op.drop_index("ix_review_requests_status_kind", table_name="review_requests")
    op.drop_index(op.f("ix_review_requests_article_id"), table_name="review_requests")
    op.drop_table("review_requests")
    op.drop_index(op.f("ix_ai_runs_started_at"), table_name="ai_runs")
    op.drop_index(op.f("ix_ai_runs_run_id"), table_name="ai_runs")
    op.drop_table("ai_runs")
