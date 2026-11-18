"""Engine creation. Accepts the URL as Neon/Supabase print it (``postgresql://…?sslmode=require``)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from wanger_news.db.base import Base

MEMORY_URL = "sqlite+aiosqlite://"


def async_url(raw: str) -> str:
    """``postgres://`` / ``postgresql://`` → the psycopg 3 async driver; sqlite → aiosqlite."""
    url = make_url(raw.strip())
    driver = url.drivername
    if driver in ("postgres", "postgresql", "postgresql+psycopg2", "postgresql+asyncpg"):
        url = url.set(drivername="postgresql+psycopg")
    elif driver == "sqlite":
        url = url.set(drivername="sqlite+aiosqlite")
    return url.render_as_string(hide_password=False)


def redact_url(raw: str) -> str:
    try:
        return make_url(raw).render_as_string(hide_password=True)
    except Exception:
        return "<unparseable database url>"


def create_engine(raw_url: str) -> AsyncEngine:
    url = async_url(raw_url)
    kwargs: dict[str, Any] = {"pool_pre_ping": True}
    if url.startswith("postgresql+psycopg"):
        # Poolers (Neon/Supabase PgBouncer in transaction mode) break server-side prepared
        # statements, so never prepare.
        kwargs["connect_args"] = {"prepare_threshold": None}
    elif url.startswith("sqlite"):
        kwargs = {}
        if url in (MEMORY_URL, "sqlite+aiosqlite:///:memory:"):
            kwargs = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}
    engine = create_async_engine(url, **kwargs)
    if url.startswith("sqlite"):
        # pysqlite's own transaction handling breaks SAVEPOINT (used by the dry run): turn it
        # off and emit BEGIN ourselves (the recipe from the SQLAlchemy SQLite dialect docs).
        @event.listens_for(engine.sync_engine, "connect")
        def _sqlite_connect(dbapi_conn: Any, _record: Any) -> None:
            dbapi_conn.isolation_level = None
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

        @event.listens_for(engine.sync_engine, "begin")
        def _sqlite_begin(conn: Any) -> None:
            conn.exec_driver_sql("BEGIN")

    return engine


def session_factory(engine: AsyncEngine) -> async_sessionmaker[Any]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def create_all(engine: AsyncEngine) -> None:
    """Only for the in-memory dry run and tests; real databases use Alembic migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
