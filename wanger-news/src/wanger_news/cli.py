"""Command line: ``python -m wanger_news <command>``.

run-once        one full pipeline pass (GitHub Actions cron entrypoint)
worker          run-once in a loop (option B: Docker)
check-sources   live-test feeds (fetch + robots.txt + parse), no database needed
validate-config load and validate config/*.yaml
doctor          check token, channels, webhook and database revision
db-check        exit 1 unless the database is at the latest migration
migrate         alembic upgrade/downgrade (wraps the alembic CLI)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from collections.abc import Coroutine, Sequence
from pathlib import Path
from typing import Any

from wanger_news import PHASE, __version__
from wanger_news.config.loader import ConfigError, load_config
from wanger_news.config.models import AppConfig
from wanger_news.logging_setup import configure
from wanger_news.settings import Settings

log = logging.getLogger("wanger_news.cli")

EXIT_OK, EXIT_SETUP, EXIT_RUN_FAILED = 0, 1, 2


def _out(text: str) -> None:
    sys.stdout.write(text + ("" if text.endswith("\n") else "\n"))
    sys.stdout.flush()


def _run(coro: Coroutine[Any, Any, int]) -> int:
    if sys.platform == "win32":  # psycopg's async mode needs the selector loop on Windows
        loop_factory = asyncio.SelectorEventLoop
        with asyncio.Runner(loop_factory=loop_factory) as runner:
            return runner.run(coro)
    return asyncio.run(coro)


def _load(settings: Settings) -> AppConfig:
    return load_config(settings.config_dir)


# ---------------------------------------------------------------- run-once / worker


async def _run_once(settings: Settings, args: argparse.Namespace) -> int:
    from wanger_news.runtime import SetupError, build
    from wanger_news.services.pipeline import Pipeline, RunOptions
    from wanger_news.services.targets import TargetError

    config = _load(settings)
    if not args.dry_run and settings.database_url is not None:
        problem = await _revision_problem(settings)
        if problem:
            _out(f"✖ {problem}")
            return EXIT_SETUP
    opts = RunOptions(
        dry_run=args.dry_run,
        trigger=args.trigger,
        max_posts=args.max_posts,
        only_sources=frozenset(args.source) if args.source else None,
        skip_telegram=args.no_telegram,
    )
    try:
        async with build(settings, config, dry_run=args.dry_run, out=_out) as deps:
            if deps.target is None:
                _out(
                    "ℹ WANGER_NEWS_TEST_CHANNEL is not set: items are collected and queued, "
                    "nothing is posted"
                )
            summary = await Pipeline(deps).run_once(opts)
    except (SetupError, TargetError) as exc:
        _out(f"✖ {exc}")
        return EXIT_SETUP
    _out(json.dumps(summary.as_dict(), ensure_ascii=False, indent=2))
    return EXIT_RUN_FAILED if summary.status.value == "failed" else EXIT_OK


async def _worker(settings: Settings, args: argparse.Namespace) -> int:
    config = _load(settings)
    interval = args.interval or config.pipeline.worker.interval_seconds
    while True:
        started = time.monotonic()
        try:
            await _run_once(settings, args)
        except Exception:
            log.exception("worker_run_crashed")
        await asyncio.sleep(max(5.0, interval - (time.monotonic() - started)))


# ---------------------------------------------------------------- check-sources


async def _check_sources(settings: Settings, args: argparse.Namespace) -> int:
    from wanger_news.adapters.feeds.parser import FeedParseError, parse_feed
    from wanger_news.adapters.http.fetcher import FetchError, SafeFetcher
    from wanger_news.adapters.http.robots import RobotsChecker
    from wanger_news.adapters.http.ssrf import SystemResolver, UrlGuard
    from wanger_news.domain.enums import Transport
    from wanger_news.runtime import feed_client

    config = _load(settings)
    http = config.pipeline.http
    sources = [s for s in config.sources.sources if s.transport is Transport.RSS and s.rss_url]
    if args.source:
        sources = [s for s in sources if s.id in set(args.source)]
    elif not args.all:
        sources = [s for s in sources if s.active]
    rows: list[dict[str, Any]] = []
    async with feed_client(config) as client:
        fetcher = SafeFetcher(client, UrlGuard(SystemResolver(), http.allowed_ports), http)
        robots = RobotsChecker(fetcher, http.robots_user_agent)

        async def one(source: Any) -> dict[str, Any]:
            row: dict[str, Any] = {"id": source.id, "active": source.active, "url": source.rss_url}
            try:
                decision = await robots.check(source.rss_url)
                row["robots"] = decision.reason
                if not decision.allowed:
                    row["result"] = f"skipped: {decision.reason}"
                    return row
                result = await fetcher.fetch(source.rss_url)
                feed = parse_feed(
                    result.body,
                    result.url,
                    config.pipeline.ingest.max_entries_per_feed,
                    result.content_type,
                )
                dates = [e.published for e in feed.entries if e.published]
                row.update(
                    result="ok",
                    http=result.status,
                    entries=len(feed.entries),
                    newest=max(dates).strftime("%Y-%m-%d %H:%M UTC") if dates else "-",
                    images=sum(1 for e in feed.entries if e.images),
                    warning=feed.warning or "",
                )
            except (FetchError, FeedParseError) as exc:
                row["result"] = f"error: {exc}"
            return row

        rows = list(await asyncio.gather(*(one(s) for s in sources)))
    ok = sum(1 for r in rows if r.get("result") == "ok")
    if args.markdown:
        _out("| source | active | result | entries | newest item | with image | robots.txt |")
        _out("|---|---|---|---|---|---|---|")
        for r in rows:
            _out(
                f"| `{r['id']}` | {'yes' if r['active'] else 'no'} | {r.get('result')} | "
                f"{r.get('entries', '-')} | {r.get('newest', '-')} | {r.get('images', '-')} | "
                f"{r.get('robots', '-')} |"
            )
    else:
        for r in rows:
            _out(json.dumps(r, ensure_ascii=False))
    _out(f"{ok}/{len(rows)} feeds OK")
    return EXIT_OK if ok == len(rows) else EXIT_RUN_FAILED


# ---------------------------------------------------------------- database


def _alembic_config(settings: Settings) -> Any:
    from alembic.config import Config

    ini = Path("alembic.ini")
    if not ini.is_file():
        raise ConfigError("alembic.ini not found: run from the wanger-news/ folder")
    cfg = Config(str(ini))
    cfg.attributes["settings"] = settings
    return cfg


async def _revision_problem(settings: Settings) -> str | None:
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory
    from sqlalchemy.exc import SQLAlchemyError

    from wanger_news.db.engine import create_engine
    from wanger_news.settings import describe_db_error

    assert settings.database_url is not None
    head = ScriptDirectory.from_config(_alembic_config(settings)).get_current_head()
    engine = create_engine(settings.database_url.get_secret_value())
    try:
        async with engine.connect() as conn:
            current = await conn.run_sync(
                lambda sync_conn: MigrationContext.configure(sync_conn).get_current_revision()
            )
    except (SQLAlchemyError, OSError) as exc:  # a clear line, not a traceback with the host
        return describe_db_error(exc)
    finally:
        await engine.dispose()
    if current != head:
        return (
            f"database is at revision {current or 'none'}, code expects {head}: "
            "run `python -m wanger_news migrate` first"
        )
    return None


async def _db_check(settings: Settings, _args: argparse.Namespace) -> int:
    if settings.database_url is None:
        _out("✖ WANGER_NEWS_DATABASE_URL is not set")
        return EXIT_SETUP
    problem = await _revision_problem(settings)
    _out(f"✖ {problem}" if problem else "✔ database is at the latest migration")
    return EXIT_SETUP if problem else EXIT_OK


def _migrate(settings: Settings, args: argparse.Namespace) -> int:
    from alembic import command

    if settings.database_url is None:
        _out("✖ WANGER_NEWS_DATABASE_URL is not set")
        return EXIT_SETUP
    cfg = _alembic_config(settings)
    if args.direction == "upgrade":
        command.upgrade(cfg, args.revision or "head")
    else:
        command.downgrade(cfg, args.revision or "-1")
    _out(f"✔ {args.direction} {args.revision or ('head' if args.direction == 'upgrade' else '-1')}")
    return EXIT_OK


# ---------------------------------------------------------------- api (Phase 5)


def _api(settings: Settings, args: argparse.Namespace) -> int:
    """Serve the admin API. Needs WANGER_NEWS_API_TOKEN, a database and the [api] extra."""
    try:
        import uvicorn
    except ImportError:
        _out("✖ the API needs the extra: pip install 'wanger-news[api]'")
        return EXIT_SETUP
    if settings.api_token is None:
        _out("✖ WANGER_NEWS_API_TOKEN is not set: the API never runs without a token")
        return EXIT_SETUP
    if settings.database_url is None:
        _out("✖ WANGER_NEWS_DATABASE_URL is not set")
        return EXIT_SETUP
    import httpx

    from wanger_news.adapters.telegram.client import TelegramClient
    from wanger_news.api.app import ApiDeps, create_app
    from wanger_news.db.engine import create_engine
    from wanger_news.ports import SystemClock
    from wanger_news.services.targets import resolve_target

    config = _load(settings)
    engine = create_engine(settings.database_url.get_secret_value())
    bot = None
    if settings.bot_token is not None:
        bot = TelegramClient(settings.bot_token, httpx.AsyncClient(timeout=20))
    test, main = settings.test_channel_ref, settings.main_channel_ref
    ai = None  # semantic search needs one embedding per search
    if settings.gemini_api_key is not None and config.pipeline.ai.enabled:
        from wanger_news.ai.gemini import GeminiProvider
        from wanger_news.ai.prompts import PromptLibrary

        ai = GeminiProvider(
            settings.gemini_api_key,
            httpx.AsyncClient(timeout=config.pipeline.ai.timeout_seconds),
            config.pipeline.ai,
            PromptLibrary.load(settings.prompts_dir),
        )
    app = create_app(
        ApiDeps(
            config=config,
            engine=engine,
            token=settings.api_token,
            clock=SystemClock(),
            owner_id=settings.owner_id,
            admin_ids=settings.admin_id_set,
            bot=bot,
            target=resolve_target(test, main),
            channels={"test": test, "main": main},
            mobile_token=settings.mobile_api_token,
            ai=ai,
        )
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return EXIT_OK


# ---------------------------------------------------------------- doctor


async def _doctor(settings: Settings, _args: argparse.Namespace) -> int:
    from wanger_news.services.doctor import run_doctor

    config = _load(settings)
    channels = None
    if settings.database_url is not None:  # what the owner set in the bot panel counts
        from wanger_news.db.engine import create_engine
        from wanger_news.services import overrides

        engine = create_engine(settings.database_url.get_secret_value())
        try:
            panel = await overrides.load(engine)
        finally:
            await engine.dispose()
        config = overrides.apply(config, panel)
        channels = overrides.channels(settings.test_channel_ref, settings.main_channel_ref, panel)
    problems = await run_doctor(settings, config, _out, channels=channels)
    if settings.database_url is not None:
        problem = await _revision_problem(settings)
        _out(f"✖ {problem}" if problem else "✔ database is at the latest migration")
        problems += 1 if problem else 0
    else:
        _out("✖ WANGER_NEWS_DATABASE_URL is not set")
        problems += 1
    _out("all good" if not problems else f"{problems} problem(s)")
    return EXIT_OK if not problems else EXIT_SETUP


def _validate(settings: Settings, _args: argparse.Namespace) -> int:
    config = _load(settings)
    active = config.active_sources
    _out(
        f"✔ config OK: {len(config.sources.sources)} sources ({len(active)} active), "
        f"{len(config.categories.categories)} categories"
    )
    for source in config.sources.sources:
        if not source.active and source.inactive_reason:
            _out(f"  - {source.id}: inactive — {source.inactive_reason}")
    return EXIT_OK


# ---------------------------------------------------------------- entrypoint


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wanger_news", description=f"Wanger News {__version__} (phase {PHASE})"
    )
    sub = p.add_subparsers(dest="command", required=True)

    def run_args(sp: argparse.ArgumentParser) -> None:
        sp.add_argument(
            "--dry-run",
            action="store_true",
            help="show the posts instead of sending them; the database is not changed",
        )
        sp.add_argument("--max-posts", type=int, default=None)
        sp.add_argument("--source", action="append", help="only this source id (repeatable)")
        sp.add_argument("--no-telegram", action="store_true", help="skip getUpdates and sending")
        sp.add_argument("--trigger", default="manual", choices=["manual", "cron", "worker"])

    run_args(sub.add_parser("run-once", help="one full pipeline pass"))
    worker = sub.add_parser("worker", help="run-once in a loop")
    run_args(worker)
    worker.add_argument("--interval", type=int, default=None)
    check = sub.add_parser("check-sources", help="live-test the RSS feeds")
    check.add_argument("--source", action="append")
    check.add_argument("--all", action="store_true", help="include inactive sources")
    check.add_argument("--markdown", action="store_true")
    sub.add_parser("validate-config")
    sub.add_parser("doctor")
    api = sub.add_parser("api", help="admin dashboard API (option B; needs the [api] extra)")
    api.add_argument("--host", default="0.0.0.0")  # noqa: S104 — inside the container
    api.add_argument("--port", type=int, default=8080)
    sub.add_parser("db-check")
    migrate = sub.add_parser("migrate")
    migrate.add_argument(
        "direction", nargs="?", default="upgrade", choices=["upgrade", "downgrade"]
    )
    migrate.add_argument("revision", nargs="?", default=None)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    settings = Settings()
    if args.command == "worker":
        args.trigger = "worker"
    configure(settings.log_level, settings.log_format, settings.secrets())
    try:
        if args.command == "run-once":
            return _run(_run_once(settings, args))
        if args.command == "worker":
            return _run(_worker(settings, args))
        if args.command == "check-sources":
            return _run(_check_sources(settings, args))
        if args.command == "doctor":
            return _run(_doctor(settings, args))
        if args.command == "api":
            return _api(settings, args)
        if args.command == "db-check":
            return _run(_db_check(settings, args))
        if args.command == "migrate":
            return _migrate(settings, args)
        return _validate(settings, args)
    except ConfigError as exc:
        _out(f"✖ {exc}")
        return EXIT_SETUP
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
