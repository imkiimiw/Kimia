"""All SQL lives here (ORM / parameterized statements only — never string-built SQL)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.ext.asyncio import AsyncSession

from wanger_news.config.models import SourceConfig
from wanger_news.db.tables import (
    Admin,
    Article,
    ArticleFingerprint,
    Lock,
    PipelineRun,
    ProcessingJob,
    PublishedPost,
    Setting,
    Source,
    SourceHealth,
    SystemLog,
    TelegramUpdate,
)
from wanger_news.domain.article import ArticleDraft
from wanger_news.domain.enums import (
    ArticleStatus,
    ChannelRole,
    DedupLevel,
    FingerprintKind,
    JobStatus,
    PostStatus,
    RunStatus,
    Stage,
)

FINGERPRINT_MAX = 255


def _insert(session: AsyncSession, table: Any) -> Any:
    """INSERT with the dialect's ON CONFLICT support (PostgreSQL in production, SQLite in tests)."""
    name = session.get_bind().dialect.name
    if name == "postgresql":
        return postgresql.insert(table)
    if name == "sqlite":
        return sqlite.insert(table)
    raise RuntimeError(f"unsupported database dialect: {name}")


def fingerprint_value(value: str) -> str:
    if len(value) <= FINGERPRINT_MAX:
        return value
    return "h:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------------------------


class SettingsRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def get(self, key: str, default: Any = None) -> Any:
        row = await self.s.get(Setting, key)
        return default if row is None else row.value

    async def set(self, key: str, value: Any, now: datetime) -> None:
        stmt = _insert(self.s, Setting).values(key=key, value=value, updated_at=now)
        stmt = stmt.on_conflict_do_update(
            index_elements=["key"], set_={"value": stmt.excluded.value, "updated_at": now}
        )
        await self.s.execute(stmt)


class LockRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def acquire(self, name: str, holder: str, now: datetime, ttl: timedelta) -> bool:
        stmt = _insert(self.s, Lock).values(
            name=name, holder=holder, acquired_at=now, expires_at=now + ttl
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["name"],
            set_={"holder": holder, "acquired_at": now, "expires_at": now + ttl},
            where=Lock.expires_at < now,
        ).returning(Lock.holder)
        row = (await self.s.execute(stmt)).first()
        return row is not None and row[0] == holder

    async def extend(self, name: str, holder: str, until: datetime) -> bool:
        result = await self.s.execute(
            sa.update(Lock)
            .where(Lock.name == name, Lock.holder == holder)
            .values(expires_at=until)
            .returning(Lock.name)
        )
        return result.first() is not None

    async def release(self, name: str, holder: str) -> None:
        await self.s.execute(sa.delete(Lock).where(Lock.name == name, Lock.holder == holder))


class AdminRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def sync(self, owner_id: int, admin_ids: Iterable[int], now: datetime) -> None:
        wanted = {owner_id: "owner", **{i: "admin" for i in admin_ids if i != owner_id}}
        for telegram_id, role in wanted.items():
            stmt = _insert(self.s, Admin).values(
                telegram_id=telegram_id, role=role, created_at=now, updated_at=now
            )
            await self.s.execute(
                stmt.on_conflict_do_update(
                    index_elements=["telegram_id"], set_={"role": role, "updated_at": now}
                )
            )
        await self.s.execute(sa.delete(Admin).where(Admin.telegram_id.not_in(list(wanted))))


class SourceRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def sync(self, configs: Sequence[SourceConfig], now: datetime) -> None:
        """Mirror config/sources.yaml into the table (removed sources stay, inactive)."""
        for cfg in configs:
            data = cfg.model_dump(mode="json")
            digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
            values = {
                "name": cfg.name,
                "domain": cfg.domain,
                "country": cfg.country,
                "language": cfg.language,
                "category": cfg.category,
                "source_type": cfg.source_type.value,
                "transport": cfg.transport.value,
                "reliability_score": cfg.reliability_score,
                "active": cfg.active,
                "inactive_reason": cfg.inactive_reason,
                "priority": cfg.priority,
                "owner_group": cfg.group,
                "in_config": True,
                "config": data,
                "config_hash": digest,
                "updated_at": now,
            }
            stmt = _insert(self.s, Source).values(id=cfg.id, created_at=now, **values)
            await self.s.execute(stmt.on_conflict_do_update(index_elements=["id"], set_=values))
        ids = [c.id for c in configs]
        await self.s.execute(
            sa.update(Source)
            .where(Source.id.not_in(ids), Source.in_config.is_(True))
            .values(
                in_config=False, active=False, inactive_reason="removed from config", updated_at=now
            )
        )

    async def health(self, source_id: str, now: datetime) -> SourceHealth:
        row = await self.s.get(SourceHealth, source_id)
        if row is None:
            row = SourceHealth(
                source_id=source_id,
                state="closed",
                consecutive_failures=0,
                total_failures=0,
                total_successes=0,
                updated_at=now,
            )
            self.s.add(row)
            await self.s.flush()
        return row

    async def all_health(self) -> dict[str, SourceHealth]:
        rows = (await self.s.scalars(sa.select(SourceHealth))).all()
        return {r.source_id: r for r in rows}

    async def all_sources(self) -> list[Source]:
        return list((await self.s.scalars(sa.select(Source).order_by(Source.id))).all())


@dataclass(frozen=True, slots=True)
class NearCandidate:
    article_id: int
    simhash: int
    status: str
    original_id: int


class ArticleRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def get(self, article_id: int) -> Article | None:
        return await self.s.get(Article, article_id)

    async def known_external_ids(self, source_id: str, external_ids: Sequence[str]) -> set[str]:
        if not external_ids:
            return set()
        rows = await self.s.scalars(
            sa.select(Article.external_id).where(
                Article.source_id == source_id, Article.external_id.in_(list(external_ids))
            )
        )
        return set(rows.all())

    async def insert(
        self,
        draft: ArticleDraft,
        status: ArticleStatus,
        now: datetime,
        *,
        reason: str | None = None,
        priority: int = 50,
    ) -> Article:
        article = Article(
            source_id=draft.source_id,
            transport=draft.transport.value,
            external_id=draft.external_id,
            url=draft.url,
            canonical_url=draft.canonical_url,
            title_original=draft.title_original,
            description_original=draft.description_original,
            content_original=draft.content_original,
            author=draft.author,
            published_at=draft.published_at,
            fetched_at=draft.fetched_at,
            effective_at=draft.effective_time,
            language=draft.language,
            country=draft.country,
            tags=draft.tags,
            entities=[],
            images=[i.model_dump() for i in draft.images],
            telegram=draft.telegram.model_dump() if draft.telegram else None,
            content_hash=draft.content_hash,
            simhash=draft.simhash,
            token_count=draft.token_count,
            priority=priority,
            sensitive=False,
            status=status.value,
            status_reason=reason,
            created_at=now,
            updated_at=now,
        )
        self.s.add(article)
        await self.s.flush()
        return article

    async def add_fingerprints(
        self, article_id: int, prints: Iterable[tuple[FingerprintKind, str]], now: datetime
    ) -> None:
        unique = {(kind.value, fingerprint_value(value)) for kind, value in prints if value}
        for kind, value in sorted(unique):
            self.s.add(
                ArticleFingerprint(article_id=article_id, kind=kind, value=value, created_at=now)
            )
        await self.s.flush()

    async def match_fingerprints(
        self,
        prints: Iterable[tuple[FingerprintKind, str]],
        statuses: Iterable[ArticleStatus] | None = None,
        exclude_id: int | None = None,
    ) -> list[tuple[Article, str]]:
        """Articles sharing any exact key, oldest first, with the key kind that matched."""
        pairs = {(kind.value, fingerprint_value(value)) for kind, value in prints if value}
        if not pairs:
            return []
        stmt = (
            sa.select(Article, ArticleFingerprint.kind)
            .join(ArticleFingerprint, ArticleFingerprint.article_id == Article.id)
            .where(sa.tuple_(ArticleFingerprint.kind, ArticleFingerprint.value).in_(list(pairs)))
            .order_by(Article.id)
            .limit(50)
        )
        if statuses is not None:
            stmt = stmt.where(Article.status.in_([s.value for s in statuses]))
        if exclude_id is not None:
            stmt = stmt.where(Article.id != exclude_id)
        rows = (await self.s.execute(stmt)).all()
        seen: dict[int, tuple[Article, str]] = {}
        for article, kind in rows:
            seen.setdefault(article.id, (article, kind))
        return list(seen.values())

    async def near_candidates(
        self, since: datetime, min_tokens: int, limit: int
    ) -> list[NearCandidate]:
        rows = await self.s.execute(
            sa.select(Article.id, Article.simhash, Article.status, Article.duplicate_of_id)
            .where(
                Article.fetched_at >= since,
                Article.simhash.is_not(None),
                Article.token_count >= min_tokens,
            )
            .order_by(Article.id.desc())
            .limit(limit)
        )
        return [
            NearCandidate(article_id=r[0], simhash=r[1], status=r[2], original_id=r[3] or r[0])
            for r in rows.all()
            if r[1] is not None
        ]

    async def by_status(self, status: ArticleStatus, limit: int) -> list[Article]:
        """Highest priority first; oldest first within a priority (chronological posting)."""
        stmt = (
            sa.select(Article)
            .where(Article.status == status.value)
            .order_by(Article.priority.desc(), Article.effective_at.asc(), Article.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def count_new_since(self, source_id: str, since: datetime) -> int:
        """Items counted against the source's hourly burst limit."""
        counted = [
            ArticleStatus.NEW,
            ArticleStatus.QUEUED,
            ArticleStatus.PUBLISHED,
            ArticleStatus.PENDING_REVIEW,
            ArticleStatus.FILTERED,
        ]
        result = await self.s.scalar(
            sa.select(sa.func.count())
            .select_from(Article)
            .where(
                Article.source_id == source_id,
                Article.fetched_at >= since,
                Article.status.in_([s.value for s in counted]),
            )
        )
        return int(result or 0)

    async def set_status(
        self, article: Article, status: ArticleStatus, now: datetime, reason: str | None = None
    ) -> None:
        article.status = status.value
        article.status_reason = reason
        article.updated_at = now
        await self.s.flush()

    async def mark_duplicate(
        self,
        article: Article,
        original_id: int,
        level: DedupLevel,
        now: datetime,
        distance: int | None = None,
    ) -> None:
        article.duplicate_of_id = original_id
        article.dedup_level = level.value
        article.dedup_distance = distance
        await self.set_status(
            article, ArticleStatus.DUPLICATE, now, f"{level.value} duplicate of #{original_id}"
        )

    async def status_counts(self, since: datetime | None = None) -> dict[str, int]:
        stmt = sa.select(Article.status, sa.func.count()).group_by(Article.status)
        if since is not None:
            stmt = stmt.where(Article.fetched_at >= since)
        return {status: int(count) for status, count in (await self.s.execute(stmt)).all()}


class PostRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def get(self, key: str) -> PublishedPost | None:
        return await self.s.scalar(
            sa.select(PublishedPost).where(PublishedPost.idempotency_key == key)
        )

    async def claim(
        self,
        *,
        key: str,
        article_id: int,
        role: ChannelRole,
        chat_id: str,
        method: str,
        run_id: str,
        now: datetime,
        max_attempts: int,
    ) -> PublishedPost | None:
        """Atomically take the right to send. None → someone else holds it, or it is done."""
        stmt = (
            _insert(self.s, PublishedPost)
            .values(
                idempotency_key=key,
                article_id=article_id,
                channel_role=role.value,
                chat_id=chat_id,
                method=method,
                status=PostStatus.CLAIMED.value,
                message_ids=[],
                attempts=1,
                claimed_by=run_id,
                claimed_at=now,
                created_at=now,
                updated_at=now,
            )
            .on_conflict_do_nothing(index_elements=["idempotency_key"])
            .returning(PublishedPost.id)
        )
        # RETURNING, never rowcount: psycopg's async cursor reports -1 for this statement.
        inserted = (await self.s.execute(stmt)).first()
        if inserted is None:
            # A definite failure may be retried while attempts remain — still one claimant only.
            retried = await self.s.execute(
                sa.update(PublishedPost)
                .where(
                    PublishedPost.idempotency_key == key,
                    PublishedPost.status == PostStatus.FAILED.value,
                    PublishedPost.attempts < max_attempts,
                )
                .values(
                    status=PostStatus.CLAIMED.value,
                    claimed_by=run_id,
                    claimed_at=now,
                    attempts=PublishedPost.attempts + 1,
                    method=method,
                    updated_at=now,
                )
                .returning(PublishedPost.id)
            )
            if retried.first() is None:
                return None
        post = await self.get(key)
        if post is not None:
            await self.s.refresh(post)
        return post

    async def finish(
        self,
        post: PublishedPost,
        status: PostStatus,
        now: datetime,
        *,
        message_ids: list[int] | None = None,
        error: str | None = None,
        text: str | None = None,
        method: str | None = None,
    ) -> None:
        post.status = status.value
        post.updated_at = now
        if message_ids is not None:
            post.message_ids = message_ids
        if error is not None:
            post.error = error[:2000]
        if text is not None:
            post.text = text
        if method is not None:
            post.method = method
        if status is PostStatus.SENT:
            post.sent_at = now
        await self.s.flush()

    async def stale_claims(self, older_than: datetime) -> list[PublishedPost]:
        stmt = sa.select(PublishedPost).where(
            PublishedPost.status == PostStatus.CLAIMED.value, PublishedPost.claimed_at < older_than
        )
        return list((await self.s.scalars(stmt)).all())

    async def last_sent(self, article_id: int, role: ChannelRole) -> PublishedPost | None:
        return await self.s.scalar(
            sa.select(PublishedPost)
            .where(
                PublishedPost.article_id == article_id,
                PublishedPost.channel_role == role.value,
                PublishedPost.status == PostStatus.SENT.value,
            )
            .order_by(PublishedPost.id.desc())
            .limit(1)
        )

    async def count_by_status(self, since: datetime) -> dict[str, int]:
        stmt = (
            sa.select(PublishedPost.status, sa.func.count())
            .where(PublishedPost.created_at >= since)
            .group_by(PublishedPost.status)
        )
        return {status: int(n) for status, n in (await self.s.execute(stmt)).all()}


class JobRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def record(
        self,
        article_id: int,
        stage: Stage,
        status: JobStatus,
        run_id: str,
        now: datetime,
        *,
        error: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        stmt = _insert(self.s, ProcessingJob).values(
            article_id=article_id,
            stage=stage.value,
            status=status.value,
            attempts=1,
            run_id=run_id,
            error=error,
            details=details,
            started_at=now,
            finished_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["article_id", "stage"],
            set_={
                "status": status.value,
                "attempts": ProcessingJob.attempts + 1,
                "run_id": run_id,
                "error": error,
                "details": details,
                "finished_at": now,
            },
        )
        await self.s.execute(stmt)


class UpdateRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def store(
        self,
        updates: Sequence[dict[str, Any]],
        kinds: Sequence[tuple[str, int | None]],
        now: datetime,
    ) -> int:
        stored = 0
        for payload, (kind, chat_id) in zip(updates, kinds, strict=True):
            stmt = (
                _insert(self.s, TelegramUpdate)
                .values(
                    update_id=int(payload["update_id"]),
                    kind=kind,
                    chat_id=chat_id,
                    payload=payload,
                    received_at=now,
                )
                .on_conflict_do_nothing(index_elements=["update_id"])
                .returning(TelegramUpdate.update_id)
            )
            if (await self.s.execute(stmt)).first() is not None:
                stored += 1
        return stored

    async def pending(self, limit: int = 1000) -> list[TelegramUpdate]:
        stmt = (
            sa.select(TelegramUpdate)
            .where(TelegramUpdate.processed_at.is_(None))
            .order_by(TelegramUpdate.update_id)
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def mark(self, update: TelegramUpdate, outcome: str, now: datetime) -> None:
        update.processed_at = now
        update.outcome = outcome[:64]
        await self.s.flush()


class RunRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def start(self, run_id: str, now: datetime, *, dry_run: bool, trigger: str) -> None:
        self.s.add(
            PipelineRun(
                id=run_id,
                started_at=now,
                status=RunStatus.RUNNING.value,
                dry_run=dry_run,
                trigger=trigger,
            )
        )
        await self.s.flush()

    async def finish(
        self,
        run_id: str,
        status: RunStatus,
        now: datetime,
        summary: dict[str, Any],
        error: str | None = None,
    ) -> None:
        await self.s.execute(
            sa.update(PipelineRun)
            .where(PipelineRun.id == run_id)
            .values(status=status.value, finished_at=now, summary=summary, error=error)
        )

    async def latest(self, limit: int = 1) -> list[PipelineRun]:
        stmt = sa.select(PipelineRun).order_by(PipelineRun.started_at.desc()).limit(limit)
        return list((await self.s.scalars(stmt)).all())


class LogRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(
        self,
        level: str,
        event: str,
        now: datetime,
        run_id: str | None,
        context: dict[str, Any] | None = None,
    ) -> None:
        self.s.add(
            SystemLog(
                created_at=now, level=level, event=event[:100], run_id=run_id, context=context
            )
        )
        await self.s.flush()

    async def recent(self, levels: Sequence[str], limit: int) -> list[SystemLog]:
        stmt = (
            sa.select(SystemLog)
            .where(SystemLog.level.in_(list(levels)))
            .order_by(SystemLog.id.desc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())


class MaintenanceRepo:
    """Retention: keeps the free-tier database small. Published articles are kept."""

    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def purge(
        self,
        now: datetime,
        *,
        articles_days: int,
        jobs_days: int,
        updates_days: int,
        logs_days: int,
        batch: int,
    ) -> dict[str, int]:
        removed: dict[str, int] = {}
        keep = [
            ArticleStatus.PUBLISHED.value,
            ArticleStatus.UNCERTAIN.value,
            ArticleStatus.EXTERNAL.value,
            ArticleStatus.QUEUED.value,
            ArticleStatus.PENDING_REVIEW.value,
            ArticleStatus.NEW.value,
        ]
        old_ids = list(
            (
                await self.s.scalars(
                    sa.select(Article.id)
                    .where(
                        Article.fetched_at < now - timedelta(days=articles_days),
                        Article.status.not_in(keep),
                    )
                    .limit(batch)
                )
            ).all()
        )
        if old_ids:
            await self.s.execute(
                sa.delete(ArticleFingerprint).where(ArticleFingerprint.article_id.in_(old_ids))
            )
            await self.s.execute(
                sa.delete(ProcessingJob).where(ProcessingJob.article_id.in_(old_ids))
            )
            await self.s.execute(sa.delete(Article).where(Article.id.in_(old_ids)))
        removed["articles"] = len(old_ids)
        removed["jobs"] = await self._delete(
            ProcessingJob, ProcessingJob.finished_at, now - timedelta(days=jobs_days)
        )
        removed["updates"] = await self._delete(
            TelegramUpdate, TelegramUpdate.processed_at, now - timedelta(days=updates_days)
        )
        removed["logs"] = await self._delete(
            SystemLog, SystemLog.created_at, now - timedelta(days=logs_days)
        )
        removed["runs"] = await self._delete(
            PipelineRun, PipelineRun.started_at, now - timedelta(days=logs_days)
        )
        return removed

    async def _delete(self, table: Any, column: Any, before: datetime) -> int:
        key = sa.inspect(table).primary_key[0]
        result = await self.s.execute(sa.delete(table).where(column < before).returning(key))
        return len(result.all())


class Repositories:
    """Everything one unit of work needs, sharing one session."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.settings = SettingsRepo(session)
        self.locks = LockRepo(session)
        self.admins = AdminRepo(session)
        self.sources = SourceRepo(session)
        self.articles = ArticleRepo(session)
        self.posts = PostRepo(session)
        self.jobs = JobRepo(session)
        self.updates = UpdateRepo(session)
        self.runs = RunRepo(session)
        self.logs = LogRepo(session)
        self.maintenance = MaintenanceRepo(session)

    async def commit(self) -> None:
        await self.session.commit()

    async def rollback(self) -> None:
        await self.session.rollback()
