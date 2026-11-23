"""The weekly intelligence report (Phase 6). Pure: published facts in, a report out.

Built only from what was already published in the channel (titles, counts, sources, trend
counts) — no new AI text, so the report cannot add a claim (golden rule 1, like the daily
brief). Every number in it is a count of published posts or stored records.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class StoryFact:
    story_id: int
    title: str
    url: str | None
    category: str | None
    importance: int
    independent_sources: int
    source_names: tuple[str, ...]
    status: str  # a key of STATUS_LABELS_FA
    breaking: bool = False
    contradictions: int = 0
    updates: int = 0  # update posts in the window
    new: bool = True  # first published in the window (False: an older story that developed)


@dataclass(frozen=True, slots=True)
class WeeklyFacts:
    stories: list[StoryFact]
    update_posts: int
    source_posts: int  # human-curated posts from the source channel
    breaking_posts: int
    corrections: int
    trends: list[tuple[str, int]]  # (topic, reports) of every alert in the window
    previous_stories: int | None = None


@dataclass(frozen=True, slots=True)
class WeeklyReport:
    stories: int
    update_posts: int
    source_posts: int
    breaking_posts: int
    corrections: int
    contradictions: int
    multi_source: int  # stories confirmed by 2+ independent origins
    categories: list[tuple[str, int]]
    top: list[StoryFact]
    developing: list[StoryFact]
    trends: list[tuple[str, int]]
    sources: list[tuple[str, int]]
    previous_stories: int | None = None
    change_percent: int | None = None
    extra: dict[str, int] = field(default_factory=dict)


def top_trends(alerts: Iterable[tuple[str, int]], limit: int) -> list[tuple[str, int]]:
    """One line per topic with its largest report count, biggest first."""
    best: dict[str, int] = {}
    for label, reports in alerts:
        best[label] = max(best.get(label, 0), reports)
    return sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]


def build(
    facts: WeeklyFacts,
    *,
    top: int,
    developing: int,
    trends: int,
    sources: int,
    category_names: dict[str, str],
) -> WeeklyReport:
    stories = [s for s in facts.stories if s.new]
    by_category = Counter(category_names.get(s.category or "", s.category or "—") for s in stories)
    ranked = sorted(
        stories, key=lambda s: (-s.importance, -s.independent_sources, -s.updates, s.story_id)
    )
    growing = sorted(
        (s for s in facts.stories if s.updates > 0), key=lambda s: (-s.updates, -s.importance)
    )
    cited = Counter(name for s in stories for name in dict.fromkeys(s.source_names))
    change = None
    if facts.previous_stories:
        change = round((len(stories) - facts.previous_stories) * 100 / facts.previous_stories)
    return WeeklyReport(
        stories=len(stories),
        update_posts=facts.update_posts,
        source_posts=facts.source_posts,
        breaking_posts=facts.breaking_posts,
        corrections=facts.corrections,
        contradictions=sum(1 for s in stories if s.contradictions),
        multi_source=sum(1 for s in stories if s.independent_sources >= 2),
        categories=sorted(by_category.items(), key=lambda kv: (-kv[1], kv[0])),
        top=ranked[:top],
        developing=_without(growing, ranked[:top])[:developing],
        trends=top_trends(facts.trends, trends),
        sources=sorted(cited.items(), key=lambda kv: (-kv[1], kv[0]))[:sources],
        previous_stories=facts.previous_stories,
        change_percent=change,
    )


def _without(items: Sequence[StoryFact], shown: Sequence[StoryFact]) -> list[StoryFact]:
    """Developing stories not already listed as top stories (fall back to all of them)."""
    ids = {s.story_id for s in shown}
    rest = [s for s in items if s.story_id not in ids]
    return rest or list(items)
