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
    AIRun,
    Article,
    ArticleFingerprint,
    Claim,
    Correction,
    Evidence,
    Lock,
    PipelineRun,
    ProcessingJob,
    PublishedPost,
    ReliabilityHistory,
    ReviewRequest,
    Setting,
    Source,
    SourceHealth,
    StoryCluster,
    Summary,
    SystemLog,
    TelegramUpdate,
    TrendAlert,
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
    Transport,
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

    async def by_external_id(self, source_id: str, external_id: str) -> Article | None:
        return await self.s.scalar(
            sa.select(Article).where(
                Article.source_id == source_id, Article.external_id == external_id
            )
        )

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

    async def by_status(
        self, status: ArticleStatus, limit: int, *, newest_first: bool = False
    ) -> list[Article]:
        """Highest priority first; within a priority oldest first (chronological posting) or
        newest first (the AI stage: fresh news is worth the quota more)."""
        when = Article.effective_at.desc() if newest_first else Article.effective_at.asc()
        stmt = (
            sa.select(Article)
            .where(Article.status == status.value)
            .order_by(Article.priority.desc(), when, Article.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def publish_queue(self, limit: int) -> list[Article]:
        """What to post next: "publish now" first, then 🔴 breaking, then importance (else
        priority), oldest first."""
        rank = sa.func.coalesce(Article.importance_score, Article.priority)
        stmt = (
            sa.select(Article)
            .where(Article.status == ArticleStatus.QUEUED.value)
            .order_by(
                Article.publish_now.desc(),
                Article.breaking.desc(),
                rank.desc(),
                Article.effective_at.asc(),
                Article.id.asc(),
            )
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def trend_rows(
        self, since: datetime, limit: int
    ) -> list[tuple[int, str, datetime, int | None, list[dict[str, Any]] | None]]:
        """(id, source, time, story, names) of feed reports since a moment — the raw material of
        trend detection. Copies, our own posts and filtered items are not reports."""
        not_reports = [
            ArticleStatus.DUPLICATE.value,
            ArticleStatus.EXTERNAL.value,
            ArticleStatus.FILTERED.value,
            ArticleStatus.STALE.value,
            ArticleStatus.THROTTLED.value,
        ]
        stmt = (
            sa.select(
                Article.id,
                Article.source_id,
                Article.effective_at,
                Article.cluster_id,
                Article.entities,
            )
            .where(
                Article.effective_at >= since,
                Article.transport == Transport.RSS.value,
                Article.status.not_in(not_reports),
            )
            .order_by(Article.effective_at.asc(), Article.id.asc())
            .limit(limit)
        )
        return [
            (int(i), str(src), when, cid, names)
            for i, src, when, cid, names in (await self.s.execute(stmt)).all()
        ]

    async def recent(self, statuses: Sequence[ArticleStatus], limit: int) -> list[Article]:
        stmt = (
            sa.select(Article)
            .where(Article.status.in_([s.value for s in statuses]))
            .order_by(Article.updated_at.desc(), Article.id.desc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def count_new_since(self, source_id: str, since: datetime) -> int:
        """Items counted against the source's hourly burst limit."""
        counted = [
            ArticleStatus.NEW,
            ArticleStatus.AI_PENDING,
            ArticleStatus.QUEUED,
            ArticleStatus.PUBLISHED,
            ArticleStatus.PENDING_REVIEW,
            ArticleStatus.HELD,
            ArticleStatus.REJECTED,
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
        article_id: int | None,
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

    async def breaking_sent_since(self, chat_id: str, since: datetime) -> int:
        """🔴 posts sent (or possibly sent) to this chat since a moment (hourly cap)."""
        stmt = (
            sa.select(sa.func.count())
            .select_from(PublishedPost)
            .where(
                PublishedPost.chat_id == chat_id,
                PublishedPost.breaking.is_(True),
                PublishedPost.status.in_(
                    [PostStatus.SENT.value, PostStatus.UNCERTAIN.value, PostStatus.CLAIMED.value]
                ),
                PublishedPost.claimed_at >= since,
            )
        )
        return int(await self.s.scalar(stmt) or 0)

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

    async def attempts(self, article_id: int, stage: Stage) -> int:
        value = await self.s.scalar(
            sa.select(ProcessingJob.attempts).where(
                ProcessingJob.article_id == article_id, ProcessingJob.stage == stage.value
            )
        )
        return int(value or 0)


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
            ArticleStatus.AI_PENDING.value,
            ArticleStatus.HELD.value,
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
            # no foreign keys: children first (summaries and review requests of those items)
            await self.s.execute(sa.delete(Summary).where(Summary.article_id.in_(old_ids)))
            await self.s.execute(
                sa.delete(ReviewRequest).where(ReviewRequest.article_id.in_(old_ids))
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
        removed["ai_runs"] = await self._delete(
            AIRun, AIRun.started_at, now - timedelta(days=max(logs_days, 2))
        )
        return removed

    async def _delete(self, table: Any, column: Any, before: datetime) -> int:
        key = sa.inspect(table).primary_key[0]
        result = await self.s.execute(sa.delete(table).where(column < before).returning(key))
        return len(result.all())


class SummaryRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, summary: Summary) -> Summary:
        self.s.add(summary)
        await self.s.flush()
        return summary

    async def get(self, summary_id: int | None) -> Summary | None:
        return None if summary_id is None else await self.s.get(Summary, summary_id)

    async def entities_since(self, since: datetime, limit: int) -> list[list[dict[str, Any]]]:
        """The names declared by recent summaries (Persian spelling + original)."""
        stmt = (
            sa.select(Summary.entities)
            .where(Summary.created_at >= since)
            .order_by(Summary.id.desc())
            .limit(limit)
        )
        return [list(e or []) for e in (await self.s.scalars(stmt)).all()]

    async def cached(self, source_hash: str, prompt_version: str, language: str) -> Summary | None:
        """A valid AI summary of exactly this source text with this prompt (spec §4 cache)."""
        stmt = (
            sa.select(Summary)
            .where(
                Summary.source_hash == source_hash,
                Summary.prompt_version == prompt_version,
                Summary.language == language,
                Summary.valid.is_(True),
                Summary.origin != "human",
            )
            .order_by(Summary.id.desc())
            .limit(1)
        )
        return await self.s.scalar(stmt)


class AIRunRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, run: AIRun) -> None:
        self.s.add(run)
        await self.s.flush()

    async def calls_since(
        self, since: datetime, *, operation: str | None = None, exclude: str | None = "embed"
    ) -> int:
        """Calls that count against a provider quota (every attempt that reached it).
        Embedding calls have their own quota, so they are left out unless asked for."""
        stmt = sa.select(sa.func.count()).select_from(AIRun).where(AIRun.started_at >= since)
        if operation is not None:
            stmt = stmt.where(AIRun.operation == operation)
        elif exclude is not None:
            stmt = stmt.where(AIRun.operation != exclude)
        return int(await self.s.scalar(stmt) or 0)

    async def usage_since(self, since: datetime) -> dict[str, float]:
        row = (
            await self.s.execute(
                sa.select(
                    sa.func.count(),
                    sa.func.coalesce(sa.func.sum(AIRun.input_tokens), 0),
                    sa.func.coalesce(sa.func.sum(AIRun.output_tokens), 0),
                    sa.func.coalesce(sa.func.sum(AIRun.cost_usd), 0.0),
                ).where(AIRun.started_at >= since)
            )
        ).one()
        return {
            "calls": int(row[0]),
            "input_tokens": int(row[1]),
            "output_tokens": int(row[2]),
            "cost_usd": float(row[3]),
        }


class ReviewRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, request: ReviewRequest) -> ReviewRequest:
        self.s.add(request)
        await self.s.flush()
        return request

    async def needing_cards(self, limit: int) -> list[Article]:
        """Items waiting for a human that have no open card yet: most important first."""
        open_card = (
            sa.select(ReviewRequest.id)
            .where(
                ReviewRequest.article_id == Article.id,
                ReviewRequest.status == "open",
                ReviewRequest.kind == "card",
            )
            .exists()
        )
        rank = sa.func.coalesce(Article.importance_score, Article.priority)
        stmt = (
            sa.select(Article)
            .where(Article.status == ArticleStatus.PENDING_REVIEW.value, ~open_card)
            .order_by(
                Article.breaking.desc(), rank.desc(), Article.effective_at.desc(), Article.id.asc()
            )
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def open_for(self, article_id: int, kind: str | None = None) -> list[ReviewRequest]:
        stmt = sa.select(ReviewRequest).where(
            ReviewRequest.article_id == article_id, ReviewRequest.status == "open"
        )
        if kind is not None:
            stmt = stmt.where(ReviewRequest.kind == kind)
        return list((await self.s.scalars(stmt.order_by(ReviewRequest.id))).all())

    async def edit_prompt(self, chat_id: int, message_id: int) -> ReviewRequest | None:
        return await self.s.scalar(
            sa.select(ReviewRequest).where(
                ReviewRequest.kind == "edit_prompt",
                ReviewRequest.status == "open",
                ReviewRequest.chat_id == chat_id,
                ReviewRequest.message_id == message_id,
            )
        )

    async def close(
        self, request: ReviewRequest, outcome: str, now: datetime, by: int | None = None
    ) -> None:
        request.status = "closed"
        request.outcome = outcome[:32]
        request.closed_at = now
        request.closed_by = by
        await self.s.flush()


class StoryRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, cluster: StoryCluster) -> StoryCluster:
        self.s.add(cluster)
        await self.s.flush()
        return cluster

    async def get(self, cluster_id: int | None) -> StoryCluster | None:
        return None if cluster_id is None else await self.s.get(StoryCluster, cluster_id)

    async def candidates(self, since: datetime, limit: int) -> list[StoryCluster]:
        """Recent stories that can still collect reports (they have an embedding centroid)."""
        stmt = (
            sa.select(StoryCluster)
            .where(StoryCluster.last_updated >= since, StoryCluster.centroid.is_not(None))
            .order_by(StoryCluster.last_updated.desc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def unclustered(
        self, since: datetime, statuses: Sequence[ArticleStatus], limit: int
    ) -> list[Article]:
        stmt = (
            sa.select(Article)
            .where(
                Article.cluster_id.is_(None),
                Article.effective_at >= since,
                Article.status.in_([s.value for s in statuses]),
            )
            .order_by(Article.effective_at.asc(), Article.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def unclustered_duplicates(self, limit: int) -> list[Article]:
        stmt = (
            sa.select(Article)
            .where(
                Article.cluster_id.is_(None),
                Article.status == ArticleStatus.DUPLICATE.value,
                Article.duplicate_of_id.is_not(None),
            )
            .order_by(Article.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def members(self, cluster_id: int) -> list[Article]:
        stmt = sa.select(Article).where(Article.cluster_id == cluster_id).order_by(Article.id)
        return list((await self.s.scalars(stmt)).all())

    async def by_role(self, role: str, status: ArticleStatus, limit: int) -> list[Article]:
        stmt = (
            sa.select(Article)
            .where(Article.cluster_role == role, Article.status == status.value)
            .order_by(Article.priority.desc(), Article.effective_at.asc(), Article.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def add_claim(self, claim: Claim, evidence: Sequence[Evidence]) -> Claim:
        self.s.add(claim)
        await self.s.flush()
        for item in evidence:
            item.claim_id = claim.id
            self.s.add(item)
        await self.s.flush()
        return claim

    async def claims_for(self, summary_id: int | None) -> list[Claim]:
        if summary_id is None:
            return []
        stmt = sa.select(Claim).where(Claim.summary_id == summary_id).order_by(Claim.id)
        return list((await self.s.scalars(stmt)).all())

    async def by_ids(self, ids: Iterable[int]) -> dict[int, StoryCluster]:
        wanted = sorted(set(ids))
        if not wanted:
            return {}
        stmt = sa.select(StoryCluster).where(StoryCluster.id.in_(wanted))
        return {s.id: s for s in (await self.s.scalars(stmt)).all()}

    async def by_event_id(self, event_id: str) -> StoryCluster | None:
        return await self.s.scalar(sa.select(StoryCluster).where(StoryCluster.event_id == event_id))

    async def published_in(self, chat: str, since: datetime, limit: int) -> list[StoryCluster]:
        """Stories posted in this channel since a moment, most important first."""
        stmt = (
            sa.select(StoryCluster)
            .where(
                StoryCluster.post_chat == chat,
                StoryCluster.published_at >= since,
                StoryCluster.post_message_id.is_not(None),
            )
            .order_by(
                sa.func.coalesce(StoryCluster.importance_score, 0).desc(),
                StoryCluster.published_at.asc(),
                StoryCluster.id.asc(),
            )
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def related_candidates(
        self, chat: str, since: datetime, exclude: int, limit: int
    ) -> list[StoryCluster]:
        """Earlier stories posted in this channel that a new post may link to."""
        stmt = (
            sa.select(StoryCluster)
            .where(
                StoryCluster.post_chat == chat,
                StoryCluster.published_at >= since,
                StoryCluster.post_message_id.is_not(None),
                StoryCluster.id != exclude,
            )
            .order_by(StoryCluster.published_at.desc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())


class TrendRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, alert: TrendAlert) -> TrendAlert:
        self.s.add(alert)
        await self.s.flush()
        return alert

    async def last_for(self, key: str) -> TrendAlert | None:
        return await self.s.scalar(
            sa.select(TrendAlert)
            .where(TrendAlert.key == key)
            .order_by(TrendAlert.created_at.desc())
            .limit(1)
        )

    async def since(self, since: datetime, limit: int) -> list[TrendAlert]:
        stmt = (
            sa.select(TrendAlert)
            .where(TrendAlert.created_at >= since)
            .order_by(TrendAlert.reports.desc(), TrendAlert.created_at.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())


class CorrectionRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, correction: Correction) -> Correction:
        self.s.add(correction)
        await self.s.flush()
        return correction

    async def get(self, correction_id: int) -> Correction | None:
        return await self.s.get(Correction, correction_id)

    async def by_status(self, status: str, limit: int) -> list[Correction]:
        stmt = (
            sa.select(Correction)
            .where(Correction.status == status)
            .order_by(Correction.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def for_story(self, cluster_id: int) -> list[Correction]:
        stmt = sa.select(Correction).where(Correction.cluster_id == cluster_id)
        return list((await self.s.scalars(stmt)).all())

    async def since(self, since: datetime) -> list[Correction]:
        stmt = sa.select(Correction).where(Correction.created_at >= since)
        return list((await self.s.scalars(stmt)).all())


class ReliabilityRepo:
    def __init__(self, session: AsyncSession) -> None:
        self.s = session

    async def add(self, row: ReliabilityHistory) -> ReliabilityHistory:
        self.s.add(row)
        await self.s.flush()
        return row

    async def get(self, row_id: int) -> ReliabilityHistory | None:
        return await self.s.get(ReliabilityHistory, row_id)

    async def by_status(self, status: str, limit: int = 100) -> list[ReliabilityHistory]:
        stmt = (
            sa.select(ReliabilityHistory)
            .where(ReliabilityHistory.status == status)
            .order_by(ReliabilityHistory.id.asc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())

    async def latest(self) -> ReliabilityHistory | None:
        return await self.s.scalar(
            sa.select(ReliabilityHistory).order_by(ReliabilityHistory.created_at.desc()).limit(1)
        )

    async def history(self, source_id: str, limit: int = 20) -> list[ReliabilityHistory]:
        stmt = (
            sa.select(ReliabilityHistory)
            .where(ReliabilityHistory.source_id == source_id)
            .order_by(ReliabilityHistory.created_at.desc())
            .limit(limit)
        )
        return list((await self.s.scalars(stmt)).all())


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
        self.summaries = SummaryRepo(session)
        self.ai_runs = AIRunRepo(session)
        self.reviews = ReviewRepo(session)
        self.stories = StoryRepo(session)
        self.trends = TrendRepo(session)
        self.corrections = CorrectionRepo(session)
        self.reliability = ReliabilityRepo(session)

    async def commit(self) -> None:
        await self.session.commit()

    async def rollback(self) -> None:
        await self.session.rollback()
