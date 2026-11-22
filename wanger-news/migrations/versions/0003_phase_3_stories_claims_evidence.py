"""Phase 3: story clusters, claims, evidence; embeddings (pgvector) and story fields.

PostgreSQL gets the pgvector extension (CREATE EXTENSION IF NOT EXISTS vector — available on
Neon, Supabase and the pgvector/pgvector image); embeddings use the dimension-free ``vector``
type. SQLite stores them as JSON. Downgrade keeps the extension (other objects may use it).
Types are spelled out here (no application imports).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-21 14:17:37.974725
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


class _Vector(sa.types.UserDefinedType):  # type: ignore[type-arg]
    """Frozen copy of pgvector's dimension-free ``vector`` column type."""

    cache_ok = True

    def get_col_spec(self, **kw: object) -> str:
        return "vector"


revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "claims",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("cluster_id", sa.BigInteger(), nullable=True),
        sa.Column("summary_id", sa.BigInteger(), nullable=False),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("confidence", sa.Integer(), nullable=False),
        sa.Column(
            "source_article_ids",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "versions",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_claims")),
    )
    op.create_index(op.f("ix_claims_cluster_id"), "claims", ["cluster_id"], unique=False)
    op.create_index(op.f("ix_claims_summary_id"), "claims", ["summary_id"], unique=False)
    op.create_table(
        "evidence",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("claim_id", sa.BigInteger(), nullable=False),
        sa.Column("article_id", sa.BigInteger(), nullable=False),
        sa.Column("excerpt", sa.Text(), nullable=False),
        sa.Column("supports", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_evidence")),
    )
    op.create_index(op.f("ix_evidence_claim_id"), "evidence", ["claim_id"], unique=False)
    op.create_table(
        "story_clusters",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("event_id", sa.String(length=32), nullable=False),
        sa.Column("lead_article_id", sa.BigInteger(), nullable=True),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("summary_id", sa.BigInteger(), nullable=True),
        sa.Column("category", sa.String(length=32), nullable=True),
        sa.Column(
            "entities",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "locations",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_updated", sa.DateTime(timezone=True), nullable=False),
        sa.Column("importance_score", sa.Integer(), nullable=True),
        sa.Column("confidence_score", sa.Integer(), nullable=True),
        sa.Column("independent_sources", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "sources",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("member_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("centroid", sa.JSON().with_variant(_Vector(), "postgresql"), nullable=True),
        sa.Column("contradictions", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "timeline",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("post_chat", sa.String(length=64), nullable=True),
        sa.Column("post_message_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "published_text",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
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
        sa.PrimaryKeyConstraint("id", name=op.f("pk_story_clusters")),
        sa.UniqueConstraint("event_id", name=op.f("uq_story_clusters_event_id")),
    )
    op.create_index(
        op.f("ix_story_clusters_last_updated"), "story_clusters", ["last_updated"], unique=False
    )
    with op.batch_alter_table("articles") as batch:
        batch.add_column(sa.Column("cluster_id", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("cluster_role", sa.String(length=16), nullable=True))
        batch.add_column(
            sa.Column(
                "cluster_score",
                sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
                nullable=True,
            )
        )
        batch.add_column(
            sa.Column("embedding", sa.JSON().with_variant(_Vector(), "postgresql"), nullable=True)
        )
    op.create_index(op.f("ix_articles_cluster_id"), "articles", ["cluster_id"], unique=False)
    with op.batch_alter_table("published_posts") as batch:
        batch.add_column(
            sa.Column("kind", sa.String(length=16), server_default="story", nullable=False)
        )
        batch.add_column(sa.Column("cluster_id", sa.BigInteger(), nullable=True))
        batch.add_column(sa.Column("reply_to_message_id", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("published_posts") as batch:
        batch.drop_column("reply_to_message_id")
        batch.drop_column("cluster_id")
        batch.drop_column("kind")
    op.drop_index(op.f("ix_articles_cluster_id"), table_name="articles")
    with op.batch_alter_table("articles") as batch:
        batch.drop_column("embedding")
        batch.drop_column("cluster_score")
        batch.drop_column("cluster_role")
        batch.drop_column("cluster_id")
    op.drop_index(op.f("ix_story_clusters_last_updated"), table_name="story_clusters")
    op.drop_table("story_clusters")
    op.drop_index(op.f("ix_evidence_claim_id"), table_name="evidence")
    op.drop_table("evidence")
    op.drop_index(op.f("ix_claims_summary_id"), table_name="claims")
    op.drop_index(op.f("ix_claims_cluster_id"), table_name="claims")
    op.drop_table("claims")
