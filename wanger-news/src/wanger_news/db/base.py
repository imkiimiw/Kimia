"""SQLAlchemy base, portable column types (PostgreSQL in production, SQLite for tests/dry runs)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

#: JSONB on PostgreSQL, JSON elsewhere.
JSONType = sa.JSON().with_variant(JSONB(), "postgresql")

#: 64-bit auto-increment id (SQLite only auto-increments INTEGER PRIMARY KEY).
BigId = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


class UTCDateTime(sa.TypeDecorator[datetime]):
    """Always timezone-aware UTC in Python, whatever the backend stores."""

    impl = sa.DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetime given to a UTC column")
        value = value.astimezone(UTC)
        return value.replace(tzinfo=None) if dialect.name == "sqlite" else value

    def process_result_value(self, value: Any, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        moment: datetime = datetime.fromisoformat(value) if isinstance(value, str) else value
        if moment.tzinfo is None:
            return moment.replace(tzinfo=UTC)
        return moment.astimezone(UTC)


class Base(DeclarativeBase):
    metadata = sa.MetaData(naming_convention=NAMING_CONVENTION)
    type_annotation_map = {datetime: UTCDateTime()}  # noqa: RUF012 — SQLAlchemy API
