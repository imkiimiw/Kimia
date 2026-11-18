"""Alembic environment (async engine). URL from WANGER_NEWS_DATABASE_URL, never from a file."""

from __future__ import annotations

import asyncio
from logging.config import fileConfig
from typing import Any

from alembic import context
from sqlalchemy.engine import Connection

from wanger_news.db import tables  # noqa: F401 — registers every table on Base.metadata
from wanger_news.db.base import Base
from wanger_news.db.engine import create_engine
from wanger_news.settings import Settings

config = context.config
if config.config_file_name is not None and not config.attributes.get("skip_logging"):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    explicit = config.attributes.get("database_url")
    if explicit:
        return str(explicit)
    settings: Settings = config.attributes.get("settings") or Settings()
    if settings.database_url is None:
        raise RuntimeError("WANGER_NEWS_DATABASE_URL is not set")
    return settings.database_url.get_secret_value()


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=connection.dialect.name == "sqlite",  # SQLite cannot ALTER most things
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def _run_async() -> None:
    engine = create_engine(_url())
    try:
        async with engine.connect() as conn:
            await conn.run_sync(_configure)
            await conn.commit()
    finally:
        await engine.dispose()


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connection: Any = config.attributes.get("connection")
    if connection is not None:  # tests pass a live sync connection
        _configure(connection)
        return
    asyncio.run(_run_async())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
