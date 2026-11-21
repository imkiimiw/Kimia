"""Is this item 🔴 breaking news (spec §10)? Pure and explainable.

Breaking changes the marker, the order of the queues and the settle wait — never the safety
checks: a breaking item still needs a validated text, and sensitive topics still go to a human.
"""

from __future__ import annotations

from dataclasses import dataclass

from wanger_news.config.models import BreakingConfig


@dataclass(frozen=True, slots=True)
class Breaking:
    breaking: bool
    reason: str  # why (e.g. "priority:100") or why not (e.g. "stale:240m")


def decide(
    *,
    priority: int,
    importance: int,
    confidence: int,
    age_minutes: float,
    update: bool,
    cfg: BreakingConfig,
) -> Breaking:
    if not cfg.enabled:
        return Breaking(False, "disabled")
    if update and not cfg.allow_updates:
        return Breaking(False, "update")
    reasons = []
    if priority >= cfg.min_priority:
        reasons.append(f"priority:{priority}")
    if importance >= cfg.min_importance:
        reasons.append(f"importance:{importance}")
    if not reasons:
        return Breaking(False, "not_important")
    if confidence < cfg.min_confidence:
        return Breaking(False, f"low_confidence:{confidence}")
    if age_minutes > cfg.max_age_minutes:
        return Breaking(False, f"stale:{round(age_minutes)}m")
    return Breaking(True, ",".join(reasons))
