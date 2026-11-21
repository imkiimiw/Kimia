"""Where a prepared item goes next (spec §11). Pure: every rule is unit-tested."""

from __future__ import annotations

from dataclasses import dataclass

from wanger_news.config.models import AutoPublishConfig
from wanger_news.domain.enums import ArticleStatus, PublishMode

#: confidence below this is "unconfirmed" and never goes out without a human (spec §8)
NEVER_AUTO_BELOW = 50


@dataclass(frozen=True, slots=True)
class Route:
    status: ArticleStatus
    reason: str


def route(
    *,
    mode: PublishMode,
    sensitive_topics: list[str],
    guard_passed: bool,
    insufficient: bool,
    confidence: int,
    importance: int,
    auto: AutoPublishConfig,
    conflicting: bool = False,
) -> Route:
    """The order matters: the safety reasons win over the mode."""
    if not guard_passed:
        return Route(ArticleStatus.PENDING_REVIEW, "guard_failed")
    if insufficient:
        return Route(ArticleStatus.PENDING_REVIEW, "insufficient_information")
    if conflicting:  # sources contradict each other: a human reads both versions first
        return Route(ArticleStatus.PENDING_REVIEW, "conflicting_reports")
    if sensitive_topics:
        return Route(ArticleStatus.PENDING_REVIEW, "sensitive:" + ",".join(sensitive_topics))
    if confidence < NEVER_AUTO_BELOW:
        return Route(ArticleStatus.PENDING_REVIEW, "low_confidence")
    if mode is PublishMode.MANUAL:
        return Route(ArticleStatus.HELD, "manual_mode")
    if mode is PublishMode.SEMI:
        return Route(ArticleStatus.PENDING_REVIEW, "semi_auto")
    if confidence < auto.min_confidence or importance < auto.min_importance:
        return Route(ArticleStatus.PENDING_REVIEW, "below_auto_threshold")
    return Route(ArticleStatus.QUEUED, "auto")
