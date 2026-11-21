"""Importance and confidence (spec §8): 0–100, explainable — every score keeps its breakdown."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from wanger_news.config.models import ScoringConfig
from wanger_news.domain.enums import SourceType
from wanger_news.domain.summary import ImportanceFactors

LABELS_FA = {
    "confirmed": "تأییدشده",
    "likely": "احتمال بالا",
    "preliminary": "گزارش اولیه",
    "unconfirmed": "تأییدنشده",
}
GUARD_STATES = ("passed", "after_rewrite", "human", "failed")


@dataclass(frozen=True, slots=True)
class Score:
    value: int
    breakdown: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"value": self.value, **self.breakdown}


def _weighted(components: dict[str, float], weights: dict[str, float]) -> int:
    used = {k: w for k, w in weights.items() if k in components and w > 0}
    total = sum(used.values())
    if total == 0:
        return 0
    return round(sum(components[k] * w for k, w in used.items()) / total)


def recency(age_hours: float, cfg: ScoringConfig) -> float:
    if age_hours <= cfg.recency_full_hours:
        return 100.0
    if age_hours >= cfg.recency_zero_hours:
        return 0.0
    span = cfg.recency_zero_hours - cfg.recency_full_hours
    return 100.0 * (cfg.recency_zero_hours - age_hours) / span


def importance(
    rule_priority: int, factors: ImportanceFactors | None, age_hours: float, cfg: ScoringConfig
) -> Score:
    components: dict[str, float] = {
        "rule_priority": float(rule_priority),
        "recency": recency(age_hours, cfg),
    }
    if factors is not None:
        for name, value in factors.model_dump().items():
            components[name] = float(value) * 10
    value = max(0, min(100, _weighted(components, cfg.importance_weights)))
    return Score(
        value,
        {
            "components": {k: round(v) for k, v in components.items()},
            "weights": {k: w for k, w in cfg.importance_weights.items() if k in components},
            "ai_factors": factors is not None,
        },
    )


def confidence(
    *,
    reliability: int,
    source_type: SourceType | None,
    quality: int,
    guard_state: str,
    independent_sources: int,
    cfg: ScoringConfig,
) -> Score:
    if guard_state not in GUARD_STATES:
        raise ValueError(f"unknown guard state {guard_state!r}")
    primary = source_type in cfg.primary_source_types if source_type else False
    components = {
        "reliability": float(reliability),
        "primary_source": float(
            cfg.primary_source_score if primary else cfg.secondary_source_score
        ),
        "quality": float(quality),
        "guard": float(cfg.guard_scores.get(guard_state, 0)),
    }
    raw = _weighted(components, cfg.confidence_weights)
    capped = min(raw, cfg.single_source_cap) if independent_sources <= 1 else raw
    if guard_state == "failed":
        capped = min(capped, cfg.guard_failed_cap)
    return Score(
        capped,
        {
            "components": {k: round(v) for k, v in components.items()},
            "weights": dict(cfg.confidence_weights),
            "raw": raw,
            "independent_sources": independent_sources,
            "single_source_cap": cfg.single_source_cap if independent_sources <= 1 else None,
            "capped": capped < raw,
            "guard_state": guard_state,
        },
    )


def label(value: int, cfg: ScoringConfig) -> str:
    """confirmed / likely / preliminary / unconfirmed."""
    t = cfg.label_thresholds
    if value >= t.get("confirmed", 90):
        return "confirmed"
    if value >= t.get("likely", 70):
        return "likely"
    if value >= t.get("preliminary", 50):
        return "preliminary"
    return "unconfirmed"
