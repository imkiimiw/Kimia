"""Phase 4: breaking flags, related stories, trend alerts, posts without an article (brief, trend).

``published_posts.article_id`` becomes nullable: a daily brief or a trend alert belongs to no
article but gets the same claim → send → record protocol (one idempotency key per post).
Downgrade deletes those rows first (they cannot exist in the Phase 3 schema).
Types are spelled out here (no application imports).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-21 19:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
_UTC = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "trend_alerts",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("key", sa.String(length=200), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("window_start", _UTC, nullable=False),
        sa.Column("window_end", _UTC, nullable=False),
        sa.Column("reports", sa.Integer(), nullable=False),
        sa.Column("sources", sa.Integer(), nullable=False),
        sa.Column("baseline", sa.Float(), nullable=False),
        sa.Column("ratio", sa.Float(), nullable=False),
        sa.Column("cluster_id", sa.BigInteger(), nullable=True),
        sa.Column("details", _JSON, nullable=False),
        sa.Column("notified", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", _UTC, nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trend_alerts")),
    )
    op.create_index(
        op.f("ix_trend_alerts_created_at"), "trend_alerts", ["created_at"], unique=False
    )
    op.create_index(
        "ix_trend_alerts_key_created_at", "trend_alerts", ["key", "created_at"], unique=False
    )
    with op.batch_alter_table("articles") as batch:
        batch.add_column(
            sa.Column("breaking", sa.Boolean(), server_default=sa.text("false"), nullable=False)
        )
        batch.add_column(sa.Column("breaking_reason", sa.String(length=200), nullable=True))
    with op.batch_alter_table("story_clusters") as batch:
        batch.add_column(sa.Column("breaking_at", _UTC, nullable=True))
        batch.add_column(
            sa.Column("related", _JSON, server_default=sa.text("'[]'"), nullable=False)
        )
    with op.batch_alter_table("published_posts") as batch:
        batch.alter_column("article_id", existing_type=sa.BigInteger(), nullable=True)
        batch.add_column(
            sa.Column("breaking", sa.Boolean(), server_default=sa.text("false"), nullable=False)
        )


def downgrade() -> None:
    op.execute("DELETE FROM published_posts WHERE article_id IS NULL")
    with op.batch_alter_table("published_posts") as batch:
        batch.drop_column("breaking")
        batch.alter_column("article_id", existing_type=sa.BigInteger(), nullable=False)
    with op.batch_alter_table("story_clusters") as batch:
        batch.drop_column("related")
        batch.drop_column("breaking_at")
    with op.batch_alter_table("articles") as batch:
        batch.drop_column("breaking_reason")
        batch.drop_column("breaking")
    op.drop_index("ix_trend_alerts_key_created_at", table_name="trend_alerts")
    op.drop_index(op.f("ix_trend_alerts_created_at"), table_name="trend_alerts")
    op.drop_table("trend_alerts")
