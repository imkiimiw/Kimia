"""Trend detection / early warning (Phase 4). Pure: counts, no AI, nothing invented.

A topic (a story = one event, or a name) trends when, in the last ``window_minutes``, it has at
least ``min_reports`` reports from at least ``min_sources`` outlets AND that is ``min_ratio``
times its usual count per window over the preceding ``baseline_hours``. Each outlet counts at
most ``max_reports_per_source`` times per window, so one noisy feed cannot make a trend.
A brand-new topic has no history: its "usual" count is ``baseline_floor``.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from wanger_news.config.models import TrendsConfig


@dataclass(frozen=True, slots=True)
class Observation:
    kind: str  # story | entity
    key: str
    label: str
    at: datetime
    source: str  # outlet identity for counting (owner group)
    source_name: str = ""
    cluster_id: int | None = None


@dataclass(slots=True)
class Trend:
    kind: str
    key: str
    label: str
    reports: int
    sources: int
    baseline: float  # usual reports per window
    ratio: float
    window_start: datetime
    window_end: datetime
    cluster_id: int | None = None
    source_names: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "key": self.key,
            "reports": self.reports,
            "sources": self.sources,
            "baseline": round(self.baseline, 2),
            "ratio": round(self.ratio, 2),
            "source_names": self.source_names,
        }


def _capped(observations: Iterable[Observation], cap: int) -> int:
    per_source = Counter(o.source for o in observations)
    return sum(min(n, cap) for n in per_source.values())


def detect(observations: Sequence[Observation], *, now: datetime, cfg: TrendsConfig) -> list[Trend]:
    """Trending topics, strongest first (story trends before name trends they explain)."""
    window = timedelta(minutes=cfg.window_minutes)
    window_start = now - window
    baseline_start = now - timedelta(hours=cfg.baseline_hours)
    buckets = max(1.0, (window_start - baseline_start) / window)
    by_key: dict[str, list[Observation]] = defaultdict(list)
    for obs in observations:
        if baseline_start <= obs.at <= now and obs.kind in cfg.kinds:
            by_key[obs.key].append(obs)

    found: list[Trend] = []
    for key, items in by_key.items():
        current = [o for o in items if o.at >= window_start]
        if not current:
            continue
        reports = _capped(current, cfg.max_reports_per_source)
        sources = len({o.source for o in current})
        if reports < cfg.min_reports or sources < cfg.min_sources:
            continue
        history: dict[int, list[Observation]] = defaultdict(list)
        for o in items:
            if o.at < window_start:
                history[int((o.at - baseline_start) / window)].append(o)
        usual = sum(_capped(b, cfg.max_reports_per_source) for b in history.values()) / buckets
        ratio = reports / max(usual, cfg.baseline_floor)
        if ratio < cfg.min_ratio:
            continue
        clusters = Counter(o.cluster_id for o in current if o.cluster_id is not None)
        names = list(dict.fromkeys(o.source_name or o.source for o in current))
        found.append(
            Trend(
                kind=current[0].kind,
                key=key,
                label=current[-1].label,
                reports=reports,
                sources=sources,
                baseline=usual,
                ratio=ratio,
                window_start=window_start,
                window_end=now,
                cluster_id=(
                    current[0].cluster_id
                    if current[0].kind == "story"
                    else (clusters.most_common(1)[0][0] if clusters else None)
                ),
                source_names=names,
            )
        )
    return _without_echoes(found, observations, window_start, cfg)


def _without_echoes(
    trends: list[Trend], observations: Sequence[Observation], since: datetime, cfg: TrendsConfig
) -> list[Trend]:
    """A name trending only because one trending story mentions it is the same alert twice."""
    trending_stories = {t.cluster_id for t in trends if t.kind == "story"}
    kept = []
    for trend in trends:
        if trend.kind == "entity" and trend.cluster_id in trending_stories:
            current = [o for o in observations if o.key == trend.key and o.at >= since]
            share = sum(1 for o in current if o.cluster_id == trend.cluster_id) / len(current)
            if share >= cfg.entity_story_overlap:
                continue
        kept.append(trend)
    kept.sort(key=lambda t: (t.kind != "story", -t.ratio, -t.reports, t.key))
    return kept
