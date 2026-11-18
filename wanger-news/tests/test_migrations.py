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


def roundtrip(url: str) -> None:
    cfg = alembic_config(url)
    command.upgrade(cfg, "head")
    assert tables(url) == PHASE1_TABLES
    assert drift(url) == []
    command.downgrade(cfg, "base")
    assert tables(url) == set()
    command.upgrade(cfg, "head")  # and up again: downgrade left nothing behind
    assert tables(url) == PHASE1_TABLES
    command.downgrade(cfg, "base")


def test_sqlite_upgrade_downgrade(tmp_path: Path) -> None:
    roundtrip(f"sqlite+aiosqlite:///{tmp_path / 'm.db'}")


@pytest.mark.postgres
def test_postgres_upgrade_downgrade() -> None:
    url = os.environ.get("WANGER_NEWS_TEST_POSTGRES_URL")
    if not url:
        pytest.skip("WANGER_NEWS_TEST_POSTGRES_URL not set")
    roundtrip(url)
