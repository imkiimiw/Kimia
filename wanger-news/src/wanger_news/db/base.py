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


class PgVector(sa.types.UserDefinedType[list[float]]):
    """pgvector's ``vector`` (no fixed dimension, so the embedding size can change in config).

    Sent as its text form ``[0.1,0.2]`` with an explicit cast; read back into a list of floats.
    """

    cache_ok = True

    def get_col_spec(self, **kw: Any) -> str:
        return "vector"

    def bind_processor(self, dialect: Dialect) -> Any:
        def process(value: Any) -> str | None:
            if value is None:
                return None
            return "[" + ",".join(repr(float(x)) for x in value) + "]"

        return process

    def result_processor(self, dialect: Dialect, coltype: Any) -> Any:
        def process(value: Any) -> list[float] | None:
            if value is None:
                return None
            if isinstance(value, str):
                inner = value.strip().strip("[]")
                return [float(x) for x in inner.split(",") if x.strip()]
            return [float(x) for x in value]

        return process

    def bind_expression(self, bindvalue: Any) -> Any:
        return sa.cast(bindvalue, self)


#: embeddings: pgvector on PostgreSQL, a JSON list elsewhere (tests, dry runs)
EmbeddingType = sa.JSON().with_variant(PgVector(), "postgresql")


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
