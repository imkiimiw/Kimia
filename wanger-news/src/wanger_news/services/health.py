"""Per-source health and circuit breaker (closed → open → half_open → closed)."""

from __future__ import annotations

from datetime import datetime, timedelta

from wanger_news.config.models import CircuitBreakerConfig, SourceConfig
from wanger_news.db.tables import SourceHealth

CLOSED, OPEN, HALF_OPEN = "closed", "open", "half_open"


def may_attempt(health: SourceHealth, source: SourceConfig, now: datetime) -> tuple[bool, str]:
    if health.state == OPEN and health.opened_until is not None and health.opened_until > now:
        return False, "circuit_open"
    interval = timedelta(minutes=source.rate_limit.min_fetch_interval_minutes)
    if (
        health.state == CLOSED
        and health.last_attempt_at is not None
        and now - health.last_attempt_at < interval
    ):
        return False, "fetched_recently"
    return True, "half_open_probe" if health.state == OPEN else "ok"


def record_success(health: SourceHealth, now: datetime, *, items: int, new: int) -> None:
    health.state = CLOSED
    health.consecutive_failures = 0
    health.cooldown_minutes = None
    health.opened_until = None
    health.total_successes += 1
    health.last_attempt_at = now
    health.last_success_at = now
    health.last_item_count = items
    health.last_new_count = new
    health.updated_at = now


def record_failure(
    health: SourceHealth, now: datetime, error: str, cfg: CircuitBreakerConfig
) -> bool:
    """Returns True when this failure opened (or re-opened) the circuit."""
    was_probe = health.state == OPEN
    health.consecutive_failures += 1
    health.total_failures += 1
    health.last_attempt_at = now
    health.last_error = error[:1000]
    health.last_error_at = now
    health.updated_at = now
    if was_probe or health.consecutive_failures >= cfg.failure_threshold:
        previous = health.cooldown_minutes
        cooldown = (
            cfg.cooldown_minutes
            if previous is None
            else min(previous * 2, cfg.max_cooldown_minutes)
        )
        health.cooldown_minutes = cooldown
        health.state = OPEN
        health.opened_until = now + timedelta(minutes=cooldown)
        return True
    return False
