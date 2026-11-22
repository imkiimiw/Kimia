"""Phase 5: corrections of published stories, reliability learning history.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-22 21:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
_UTC = sa.DateTime(timezone=True)
_ID = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "corrections",
        sa.Column("id", _ID, autoincrement=True, nullable=False),
        sa.Column("cluster_id", sa.BigInteger(), nullable=True),
        sa.Column("article_id", sa.BigInteger(), nullable=True),
        sa.Column("source_article_id", sa.BigInteger(), nullable=True),
        sa.Column("source_name", sa.String(length=120), nullable=False),
        sa.Column("item", sa.Text(), nullable=False),
        sa.Column("old_value", sa.Text(), nullable=False),
        sa.Column("new_value", sa.Text(), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=True),
        sa.Column("origin", sa.String(length=8), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("problems", _JSON, nullable=False),
        sa.Column("review_messages", _JSON, nullable=False),
        sa.Column("decided_by", sa.BigInteger(), nullable=True),
        sa.Column("decided_at", _UTC, nullable=True),
        sa.Column("post_chat", sa.String(length=64), nullable=True),
        sa.Column("post_message_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", _UTC, nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_corrections")),
    )
    op.create_index(op.f("ix_corrections_cluster_id"), "corrections", ["cluster_id"])
    op.create_index(op.f("ix_corrections_status"), "corrections", ["status"])
    op.create_table(
        "reliability_history",
        sa.Column("id", _ID, autoincrement=True, nullable=False),
        sa.Column("source_id", sa.String(length=64), nullable=False),
        sa.Column("old_score", sa.Integer(), nullable=False),
        sa.Column("new_score", sa.Integer(), nullable=False),
        sa.Column("signals", _JSON, nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("decided_by", sa.BigInteger(), nullable=True),
        sa.Column("decided_at", _UTC, nullable=True),
        sa.Column("created_at", _UTC, nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_reliability_history")),
    )
    op.create_index(op.f("ix_reliability_history_status"), "reliability_history", ["status"])
    op.create_index(
        "ix_reliability_history_source_created", "reliability_history", ["source_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_reliability_history_source_created", table_name="reliability_history")
    op.drop_index(op.f("ix_reliability_history_status"), table_name="reliability_history")
    op.drop_table("reliability_history")
    op.drop_index(op.f("ix_corrections_status"), table_name="corrections")
    op.drop_index(op.f("ix_corrections_cluster_id"), table_name="corrections")
    op.drop_table("corrections")
