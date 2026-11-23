"""Phase 6: indexes for search, the mobile feed, the weekly report and edition replies.

No new tables: English edition texts are ``summaries`` rows (language ``en``), editions are
panel settings, the weekly report is a ``published_posts`` row (kind ``weekly``).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-23 03:30:00
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_published_posts_chat_status_sent_at",
        "published_posts",
        ["chat_id", "status", "sent_at"],
    )
    op.create_index("ix_published_posts_cluster_chat", "published_posts", ["cluster_id", "chat_id"])
    op.create_index("ix_story_clusters_published_at", "story_clusters", ["published_at"])


def downgrade() -> None:
    op.drop_index("ix_story_clusters_published_at", table_name="story_clusters")
    op.drop_index("ix_published_posts_cluster_chat", table_name="published_posts")
    op.drop_index("ix_published_posts_chat_status_sent_at", table_name="published_posts")
