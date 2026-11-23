"""Admin Dashboard API (Phase 5, spec §16): FastAPI over the bot's own services.

For option B (a server; ``python -m wanger_news api``). Every route needs
``Authorization: Bearer <WANGER_NEWS_API_TOKEN>`` (compared in constant time); without a token
configured the app refuses to start. Decisions go through exactly the code the bot's buttons
use (ReviewService.decide, CorrectionService, ReliabilityService, the panel's overrides), so the
API can never do what the bot would not: it cannot publish without the guard, skip a review a
safety rule requires, or switch on a locked source.
"""

from __future__ import annotations

import hmac
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import SecretStr
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from wanger_news import PHASE, __version__
from wanger_news.ai.provider import AIProvider
from wanger_news.api.dashboard import mount_dashboard
from wanger_news.api.mobile import mobile_router
from wanger_news.config.models import AppConfig
from wanger_news.db.repositories import Repositories
from wanger_news.db.tables import Article, StoryCluster
from wanger_news.domain.enums import ArticleStatus, ChannelRole, ReviewAction, Transport
from wanger_news.ports import BotApi, Clock
from wanger_news.services import overrides
from wanger_news.services.analytics import AnalyticsService
from wanger_news.services.commands import PAUSED_KEY, TARGET_KEY
from wanger_news.services.context import RunContext, Target
from wanger_news.services.corrections import CorrectionService
from wanger_news.services.overrides import Overrides, apply
from wanger_news.services.posts import PostBuilder
from wanger_news.services.publish import PublishService
from wanger_news.services.reliability import ReliabilityService
from wanger_news.services.review import ReviewService
from wanger_news.services.search import Mode, SearchService
from wanger_news.services.trends import TrendService
from wanger_news.services.weekly import WeeklyService


@dataclass(slots=True)
class ApiDeps:
    config: AppConfig  # the config files (the panel's switches are applied per request)
    engine: AsyncEngine
    token: SecretStr
    clock: Clock
    owner_id: int
    admin_ids: frozenset[int]
    bot: BotApi | None = None
    target: Target | None = None
    channels: dict[str, Any] = field(default_factory=dict)
    # Phase 6
    mobile_token: SecretStr | None = None  # read-only /api/v1; None = not served
    ai: AIProvider | None = None  # semantic search (one embedding per search)


def create_app(deps: ApiDeps) -> FastAPI:
    if not deps.token.get_secret_value():
        raise ValueError("WANGER_NEWS_API_TOKEN is empty: the API never runs without a token")
    app = FastAPI(title="Wanger News admin API", version=__version__)
    publisher = PublishService(deps.config)
    review = ReviewService(deps.config, PostBuilder(deps.config))
    corrections = CorrectionService(deps.config, publisher)
    analytics = AnalyticsService(deps.config)
    trends = TrendService(deps.config, publisher)

    async def authorized(request: Request) -> None:
        given = request.headers.get("authorization", "")
        expected = f"Bearer {deps.token.get_secret_value()}"
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="invalid or missing token")

    async def repos() -> AsyncIterator[Repositories]:
        async with AsyncSession(deps.engine, expire_on_commit=False) as session:
            yield Repositories(session)

    def context(config: AppConfig) -> RunContext:
        return RunContext(
            run_id="api",
            config=config,
            clock=deps.clock,
            dry_run=False,
            owner_id=deps.owner_id,
            admin_ids=deps.admin_ids,
            bot=deps.bot,
            target=deps.target,
            channels=dict(deps.channels),
            out=lambda _text: None,
        )

    async def effective(r: Repositories) -> AppConfig:
        return apply(deps.config, await Overrides.read(r))

    auth = Depends(authorized)
    db = Depends(repos)

    def route(
        method: str, path: str
    ) -> Callable[[Callable[..., Awaitable[Any]]], Callable[..., Awaitable[Any]]]:
        return app.api_route(path, methods=[method], dependencies=[auth])

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "phase": PHASE}

    # ---------------------------------------------------------------- status and news
    @route("GET", "/api/status")
    async def status(r: Repositories = db) -> dict[str, Any]:
        runs = await r.runs.latest(1)
        return {
            "paused": bool(await r.settings.get(PAUSED_KEY, False)),
            "articles": await r.articles.status_counts(),
            "ai_24h": await r.ai_runs.usage_since(deps.clock.now() - timedelta(hours=24)),
            "last_run": {
                "id": runs[0].id,
                "status": runs[0].status,
                "started_at": runs[0].started_at.isoformat(),
            }
            if runs
            else None,
        }

    def article_json(a: Article, title: str | None = None) -> dict[str, Any]:
        return {
            "id": a.id,
            "source_id": a.source_id,
            "status": a.status,
            "title_original": a.title_original,
            "title_fa": title,
            "url": a.canonical_url or a.url,
            "category": a.category,
            "priority": a.priority,
            "importance": a.importance_score,
            "confidence": a.confidence_score,
            "breaking": a.breaking,
            "review_reason": a.review_reason,
            "story_id": a.cluster_id,
            "story_role": a.cluster_role,
            "published_at": a.published_at.isoformat() if a.published_at else None,
        }

    @route("GET", "/api/articles")
    async def articles(
        status: ArticleStatus | None = None,
        limit: int = Query(50, ge=1, le=200),
        r: Repositories = db,
    ) -> list[dict[str, Any]]:
        if status is not None:
            rows = await r.articles.by_status(status, limit)
        else:
            rows = await r.articles.recent(list(ArticleStatus), limit)
        out = []
        for a in rows:
            summary = await r.summaries.get(a.summary_id)
            out.append(article_json(a, summary.title if summary else None))
        return out

    @route("GET", "/api/articles/{article_id}")
    async def article(article_id: int, r: Repositories = db) -> dict[str, Any]:
        a = await r.articles.get(article_id)
        if a is None:
            raise HTTPException(status_code=404, detail="no such article")
        summary = await r.summaries.get(a.summary_id)
        claims = await r.stories.claims_for(a.summary_id)
        return {
            **article_json(a, summary.title if summary else None),
            "summary": {
                "title": summary.title,
                "summary": summary.summary,
                "key_points": summary.key_points,
                "valid": summary.valid,
                "guard": summary.guard,
                "origin": summary.origin,
            }
            if summary
            else None,
            "claims": [
                {"text": c.text, "status": c.status, "confidence": c.confidence} for c in claims
            ],
            "importance_breakdown": a.importance,
            "confidence_breakdown": a.confidence,
        }

    @route("POST", "/api/articles/{article_id}/{action}")
    async def decide(article_id: int, action: str, r: Repositories = db) -> dict[str, str]:
        actions = {
            "approve": ReviewAction.APPROVE,
            "publish": ReviewAction.PUBLISH,
            "reject": ReviewAction.REJECT,
        }
        if action not in actions:
            raise HTTPException(status_code=400, detail="action: approve | publish | reject")
        config = await effective(r)
        answer = await review.decide(r, context(config), article_id, actions[action], deps.owner_id)
        await r.commit()
        return {"result": answer}

    # ---------------------------------------------------------------- stories
    def story_json(s: StoryCluster) -> dict[str, Any]:
        return {
            "id": s.id,
            "event_id": s.event_id,
            "title": (s.published_text or {}).get("title") or s.title,
            "category": s.category,
            "importance": s.importance_score,
            "confidence": s.confidence_score,
            "independent_sources": s.independent_sources,
            "reports": s.member_count,
            "published_at": s.published_at.isoformat() if s.published_at else None,
            "breaking_at": s.breaking_at.isoformat() if s.breaking_at else None,
        }

    @route("GET", "/api/stories")
    async def stories(
        days: float = Query(2, gt=0, le=30),
        limit: int = Query(50, ge=1, le=200),
        r: Repositories = db,
    ) -> list[dict[str, Any]]:
        rows = await r.stories.candidates(deps.clock.now() - timedelta(days=days), limit)
        return [story_json(s) for s in rows]

    @route("GET", "/api/stories/{story_id}")
    async def story(story_id: int, r: Repositories = db) -> dict[str, Any]:
        s = await r.stories.get(story_id)
        if s is None:
            raise HTTPException(status_code=404, detail="no such story")
        members = await r.stories.members(s.id)
        return {
            **story_json(s),
            "sources": s.sources,
            "timeline": s.timeline,
            "related": s.related,
            "members": [article_json(a) for a in members],
            "corrections": [
                {
                    "id": c.id,
                    "status": c.status,
                    "item": c.item,
                    "old": c.old_value,
                    "new": c.new_value,
                    "source": c.source_name,
                }
                for c in await r.corrections.for_story(s.id)
            ],
        }

    # ---------------------------------------------------------------- sources and rules
    @route("GET", "/api/sources")
    async def sources(r: Repositories = db) -> list[dict[str, Any]]:
        config = await effective(r)
        health = await r.sources.all_health()
        out = []
        for s in config.sources.sources:
            base = deps.config.source(s.id)
            h = health.get(s.id)
            out.append(
                {
                    "id": s.id,
                    "name": s.name,
                    "transport": s.transport.value,
                    "active": s.active,
                    "switchable": bool(base and base.switchable),
                    "inactive_reason": s.inactive_reason,
                    "reliability_score": s.reliability_score,
                    "health": h.state if h else None,
                }
            )
        return out

    @route("POST", "/api/sources/{source_id}/toggle")
    async def toggle_source(source_id: str, r: Repositories = db) -> dict[str, Any]:
        base = deps.config.source(source_id)
        if base is None or base.transport is not Transport.RSS or not base.switchable:
            raise HTTPException(status_code=400, detail="this source cannot be switched")
        ov = await Overrides.read(r)
        now_on = ov.active.get(source_id, base.active)
        if (not now_on) == base.active:
            ov.active.pop(source_id, None)
        else:
            ov.active[source_id] = not now_on
        await ov.save(r, deps.clock.now())
        await r.commit()
        return {"id": source_id, "active": not now_on, "from": "next run"}

    @route("GET", "/api/rules")
    async def rules(r: Repositories = db) -> list[dict[str, Any]]:
        config = await effective(r)
        return [
            {
                "id": x.id,
                "description": x.description,
                "enabled": x.enabled,
                "if": x.when.model_dump(exclude_none=True),
                "then": x.then if isinstance(x.then, str) else x.then.model_dump(exclude_none=True),
            }
            for x in config.rules.rules
        ]

    @route("POST", "/api/rules/{rule_id}/toggle")
    async def toggle_rule(rule_id: str, r: Repositories = db) -> dict[str, Any]:
        rule = next((x for x in deps.config.rules.rules if x.id == rule_id), None)
        if rule is None:
            raise HTTPException(status_code=404, detail="no such rule")
        ov = await Overrides.read(r)
        now_on = ov.rules.get(rule_id, rule.enabled)
        if (not now_on) == rule.enabled:
            ov.rules.pop(rule_id, None)
        else:
            ov.rules[rule_id] = not now_on
        await ov.save(r, deps.clock.now())
        await r.commit()
        return {"id": rule_id, "enabled": not now_on, "from": "next run"}

    # ---------------------------------------------------------------- operations
    @route("GET", "/api/analytics")
    async def analytics_report(
        days: float = Query(7, gt=0, le=90), r: Repositories = db
    ) -> dict[str, Any]:
        return (await analytics.report(r, deps.clock.now(), days=days)).as_dict()

    @route("GET", "/api/trends")
    async def trends_now(r: Repositories = db) -> dict[str, Any]:
        current = await trends.detect(r, deps.clock.now())
        recent = await r.trends.since(deps.clock.now() - timedelta(hours=24), 50)
        return {
            "current": [{**t.as_dict(), "label": t.label} for t in current],
            "alerts_24h": [
                {
                    "label": a.label,
                    "reports": a.reports,
                    "sources": a.sources,
                    "created_at": a.created_at.isoformat(),
                }
                for a in recent
            ],
        }

    @route("GET", "/api/reliability")
    async def reliability_list(r: Repositories = db) -> list[dict[str, Any]]:
        return [
            {
                "id": x.id,
                "source_id": x.source_id,
                "old": x.old_score,
                "new": x.new_score,
                "explanation": x.explanation,
                "signals": x.signals,
                "created_at": x.created_at.isoformat(),
            }
            for x in await r.reliability.by_status("suggested")
        ]

    @route("POST", "/api/reliability/{row_id}/{action}")
    async def reliability_decide(row_id: int, action: str, r: Repositories = db) -> dict[str, str]:
        if action not in ("apply", "dismiss"):
            raise HTTPException(status_code=400, detail="action: apply | dismiss")
        config = await effective(r)
        service = ReliabilityService(config, deps.config)
        answer = await service.decide(r, context(config), row_id, action == "apply", deps.owner_id)
        return {"result": answer}

    @route("GET", "/api/corrections")
    async def corrections_list(
        status: str = "proposed", r: Repositories = db
    ) -> list[dict[str, Any]]:
        return [
            {
                "id": c.id,
                "story_id": c.cluster_id,
                "status": c.status,
                "origin": c.origin,
                "item": c.item,
                "old": c.old_value,
                "new": c.new_value,
                "source": c.source_name,
                "evidence": c.evidence,
                "problems": c.problems,
                "text": CorrectionService.sentence(c),
            }
            for c in await r.corrections.by_status(status, 100)
        ]

    @route("POST", "/api/corrections/{correction_id}/{action}")
    async def corrections_decide(
        correction_id: int, action: str, r: Repositories = db
    ) -> dict[str, str]:
        if action not in ("approve", "reject"):
            raise HTTPException(status_code=400, detail="action: approve | reject")
        row = await r.corrections.get(correction_id)
        if row is None or row.status != "proposed":
            raise HTTPException(status_code=409, detail="not an open proposal")
        row.status = "approved" if action == "approve" else "rejected"
        row.decided_by, row.decided_at = deps.owner_id, deps.clock.now()
        await r.commit()
        return {"result": row.status, "published": "in the next publishing run"}

    # ---------------------------------------------------------------- Phase 6
    search = SearchService(deps.config, deps.ai)
    weekly = WeeklyService(deps.config, publisher)

    async def chats(r: Repositories) -> list[str]:
        ov = await Overrides.read(r)
        test, main = overrides.channels(deps.channels.get("test"), deps.channels.get("main"), ov)
        return [str(c.api_value).lower() for c in (test, main) if c is not None]

    @route("GET", "/api/search")
    async def search_published(
        q: str = Query(..., min_length=1, max_length=500),
        mode: Mode = "auto",
        r: Repositories = db,
    ) -> dict[str, Any]:
        result = await search.search(
            r,
            deps.clock.now(),
            q,
            chats=await chats(r) or None,
            mode=mode,
            run_id="api",
        )
        return result.as_dict()

    @route("GET", "/api/weekly")
    async def weekly_report(r: Repositories = db) -> dict[str, Any]:
        config = await effective(r)
        ctx = context(config)
        ov = await Overrides.read(r)
        test, main = overrides.channels(deps.channels.get("test"), deps.channels.get("main"), ov)
        role = await r.settings.get(TARGET_KEY) or (
            deps.target.role.value if deps.target else "test"
        )
        chat = main if role == "main" and main is not None else test
        if chat is None and deps.target is not None:
            chat = deps.target.chat
        if chat is None:
            raise HTTPException(status_code=503, detail="no target channel configured")
        ctx.target = Target(
            ChannelRole.MAIN if main is not None and chat == main else ChannelRole.TEST, chat
        )
        report = await weekly.report(r, ctx.target.key, deps.clock.now())
        composed = await weekly.compose(r, ctx)
        return {"report": asdict(report), "text": composed[0] if composed else None}

    @route("GET", "/api/editions")
    async def editions(r: Repositories = db) -> list[dict[str, Any]]:
        config = await effective(r)
        return [e.model_dump(mode="json") for e in config.pipeline.editions.editions]

    @route("POST", "/api/editions/{edition_id}/toggle")
    async def toggle_edition(edition_id: str, r: Repositories = db) -> dict[str, Any]:
        config = await effective(r)
        current = next((e for e in config.pipeline.editions.editions if e.id == edition_id), None)
        if current is None:
            raise HTTPException(status_code=404, detail="no such edition")
        ov = await Overrides.read(r)
        changed = current.model_copy(update={"active": not current.active})
        ov.editions = [e for e in ov.editions if e.get("id") != edition_id]
        ov.editions.append(changed.model_dump(mode="json"))
        await ov.save(r, deps.clock.now())
        await r.commit()
        return {"id": edition_id, "active": changed.active, "from": "next run"}

    if deps.mobile_token is not None and deps.mobile_token.get_secret_value():
        app.include_router(
            mobile_router(
                config=deps.config,
                engine=deps.engine,
                token=deps.mobile_token,
                clock=deps.clock,
                channels=deps.channels,
                ai=deps.ai,
            )
        )
    public = deps.config.pipeline.public_api
    if public.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=public.cors_origins,
            allow_methods=["GET"],
            allow_headers=["Authorization"],
        )
    if public.dashboard:
        mount_dashboard(app)
    _ = corrections
    return app
