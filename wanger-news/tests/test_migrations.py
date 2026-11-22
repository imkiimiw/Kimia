"""Migrations upgrade and downgrade cleanly, and match the ORM models (no drift)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.runtime.migration import MigrationContext

from wanger_news.db.base import Base

ROOT = Path(__file__).resolve().parents[1]
PHASE1_TABLES = {
    "admins",
    "sources",
    "source_health",
    "articles",
    "article_fingerprints",
    "published_posts",
    "processing_jobs",
    "pipeline_runs",
    "settings",
    "locks",
    "telegram_updates",
    "system_logs",
}
PHASE2_TABLES = {"ai_runs", "summaries", "review_requests"}
PHASE3_TABLES = {"story_clusters", "claims", "evidence"}
PHASE4_TABLES = {"trend_alerts"}
PHASE5_TABLES = {"corrections", "reliability_history"}
ALL_TABLES = PHASE1_TABLES | PHASE2_TABLES | PHASE3_TABLES | PHASE4_TABLES | PHASE5_TABLES


def alembic_config(url: str) -> Config:
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    cfg.attributes["database_url"] = url
    cfg.attributes["skip_logging"] = True
    return cfg


def sync_url(url: str) -> str:
    return (
        url.replace("+aiosqlite", "")
        .replace("postgresql://", "postgresql+psycopg://")
        .replace("postgres://", "postgresql+psycopg://")
    )


def tables(url: str) -> set[str]:
    engine = sa.create_engine(sync_url(url))
    try:
        return set(sa.inspect(engine).get_table_names()) - {"alembic_version"}
    finally:
        engine.dispose()


def drift(url: str) -> list[object]:
    engine = sa.create_engine(sync_url(url))
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn, opts={"compare_type": True})
            return list(compare_metadata(ctx, Base.metadata))
    finally:
        engine.dispose()


def status_of(url: str, external_id: str) -> str:
    engine = sa.create_engine(sync_url(url))
    try:
        with engine.connect() as conn:
            return str(
                conn.execute(
                    sa.text("SELECT status FROM articles WHERE external_id = :e"),
                    {"e": external_id},
                ).scalar_one()
            )
    finally:
        engine.dispose()


def insert_phase1_rows(url: str) -> None:
    engine = sa.create_engine(sync_url(url))
    now = "2026-11-18 12:00:00+00"
    try:
        with engine.begin() as conn:
            for ext, transport, status in (
                ("rss-q", "rss", "queued"),
                ("rss-p", "rss", "pending_review"),
                ("tg-q", "telegram_channel", "queued"),
            ):
                conn.execute(
                    sa.text(
                        "INSERT INTO articles (source_id, transport, external_id, title_original, "
                        "fetched_at, effective_at, language, tags, entities, images, status) VALUES "
                        "('s', :t, :e, 'title', :n, :n, 'en', '[]', '[]', '[]', :s)"
                    ),
                    {"t": transport, "e": ext, "n": now, "s": status},
                )
    finally:
        engine.dispose()


def insert_brief_post(url: str) -> None:
    engine = sa.create_engine(sync_url(url))
    try:
        with engine.begin() as conn:
            conn.execute(
                sa.text(
                    "INSERT INTO published_posts (idempotency_key, article_id, channel_role,"
                    " chat_id, method, status, message_ids, attempts, kind, breaking,"
                    " created_at, updated_at) VALUES ('brief:2026-11-21:@t', NULL, 'test', '@t',"
                    " 'send', 'sent', '[]', 1, 'brief', false, CURRENT_TIMESTAMP,"
                    " CURRENT_TIMESTAMP)"
                )
            )
    finally:
        engine.dispose()


def count_posts(url: str) -> int:
    engine = sa.create_engine(sync_url(url))
    try:
        with engine.connect() as conn:
            return int(conn.execute(sa.text("SELECT count(*) FROM published_posts")).scalar_one())
    finally:
        engine.dispose()


def roundtrip(url: str) -> None:
    cfg = alembic_config(url)
    command.downgrade(cfg, "base")  # a clean start even after an interrupted earlier run
    command.upgrade(cfg, "0001")
    assert tables(url) == PHASE1_TABLES
    insert_phase1_rows(url)
    command.upgrade(cfg, "head")
    assert tables(url) == ALL_TABLES
    assert drift(url) == []
    # Phase 1 items from feeds had no Persian summary: they wait for the AI stage now
    assert status_of(url, "rss-q") == "ai_pending"
    assert status_of(url, "rss-p") == "ai_pending"
    assert status_of(url, "tg-q") == "queued"  # source-channel posts need no AI
    # Phase 4: a post without an article (daily brief) cannot exist below 0004
    insert_brief_post(url)
    command.downgrade(cfg, "0003")
    assert tables(url) == ALL_TABLES - PHASE4_TABLES - PHASE5_TABLES
    assert count_posts(url) == 0
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0001")
    assert tables(url) == PHASE1_TABLES
    assert status_of(url, "rss-q") == "queued"
    command.downgrade(cfg, "base")
    assert tables(url) == set()
    command.upgrade(cfg, "head")  # and up again: downgrade left nothing behind
    assert tables(url) == ALL_TABLES
    command.downgrade(cfg, "base")


def test_sqlite_upgrade_downgrade(tmp_path: Path) -> None:
    roundtrip(f"sqlite+aiosqlite:///{tmp_path / 'm.db'}")


@pytest.mark.postgres
def test_postgres_upgrade_downgrade() -> None:
    url = os.environ.get("WANGER_NEWS_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("WANGER_NEWS_TEST_POSTGRES_URL not set")
    roundtrip(url)
