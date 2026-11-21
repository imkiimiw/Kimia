"""Same-event detection (dedup level 3, spec §7): embeddings + names + time. Pure functions.

The embedding cosine is the main signal (multilingual: a Persian post can match an English
report). Shared proper names and closeness in time support it. The rule is conservative: a
false merge would hide a different event inside another story.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime

from wanger_news.config.models import StoryConfig
from wanger_news.domain.text import normalize_for_match

# Capitalised words that start sentences or name days/months, not entities.
_NOT_NAMES = frozenset(
    [
        "a",
        "an",
        "the",
        "this",
        "that",
        "these",
        "those",
        "it",
        "its",
        "he",
        "she",
        "they",
        "we",
        "you",
        "i",
        "in",
        "on",
        "at",
        "by",
        "for",
        "from",
        "with",
        "as",
        "of",
        "to",
        "and",
        "or",
        "but",
        "if",
        "after",
        "before",
        "when",
        "while",
        "where",
        "why",
        "how",
        "what",
        "who",
        "new",
        "more",
        "most",
        "some",
        "many",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
        "live",
        "watch",
        "breaking",
        "update",
        "video",
        "photos",
        "opinion",
        "analysis",
        "read",
        "here",
        "there",
        "today",
        "yesterday",
        "tomorrow",
    ]
)
_CAP_PHRASE = re.compile(
    r"\b([A-Z][\w'’\-]*(?:\s+(?:of|de|al|bin|von|van|the)?\s*[A-Z][\w'’\-]*)*)"
)


def normalize(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm else [0.0 for _ in vector]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def add_to_centroid(
    centroid: Sequence[float] | None, members: int, vector: Sequence[float]
) -> list[float]:
    """The normalized running mean of member embeddings."""
    unit = normalize(vector)
    if not centroid or members <= 0 or len(centroid) != len(unit):
        return unit
    return normalize([c * members + v for c, v in zip(centroid, unit, strict=True)])


def extract_entities(text: str, limit: int = 30) -> list[str]:
    """Proper-name candidates from Latin-script text (capitalised phrases), normalized.

    Persian has no capital letters: for Persian text this finds Latin names only and the
    embeddings carry the rest. Names the AI declares in a summary are added later.
    """
    found: dict[str, None] = {}
    for match in _CAP_PHRASE.finditer(text):
        words = match.group(1).split()
        # trim stop words at the edges only: "The Bank of England" → "Bank of England"
        while words and words[0].lower() in _NOT_NAMES:
            words.pop(0)
        while words and words[-1].lower() in _NOT_NAMES:
            words.pop()
        phrase = " ".join(words)
        if len(phrase) < 3:
            continue
        found.setdefault(normalize_for_match(phrase), None)
        if len(found) >= limit:
            break
    return list(found)


def overlap(a: Iterable[str], b: Iterable[str]) -> float:
    """Jaccard of two name sets; names also match when one contains the other ("Smith")."""
    left, right = set(a), set(b)
    if not left or not right:
        return 0.0
    shared = sum(
        1
        for x in left
        if any(x == y or f" {x} " in f" {y} " or f" {y} " in f" {x} " for y in right)
    )
    return shared / (len(left) + len(right) - shared)


def time_proximity(a: datetime, b: datetime, cfg: StoryConfig) -> float:
    hours = abs((a - b).total_seconds()) / 3600
    if hours <= cfg.time_full_hours:
        return 1.0
    if hours >= cfg.window_hours:
        return 0.0
    return 1 - (hours - cfg.time_full_hours) / (cfg.window_hours - cfg.time_full_hours)


@dataclass(frozen=True, slots=True)
class EventMatch:
    cosine: float
    entities: float
    time: float
    score: float
    same_event: bool

    def as_dict(self) -> dict[str, float | bool]:
        return {
            "cosine": round(self.cosine, 4),
            "entities": round(self.entities, 3),
            "time": round(self.time, 3),
            "score": round(self.score, 4),
            "same_event": self.same_event,
        }


def match(
    *,
    vector: Sequence[float],
    names: Iterable[str],
    when: datetime,
    centroid: Sequence[float],
    story_names: Iterable[str],
    story_time: datetime,
    cfg: StoryConfig,
) -> EventMatch:
    cos = cosine(vector, centroid)
    ent = overlap(names, story_names)
    near = time_proximity(when, story_time, cfg)
    w = cfg.score_weights
    total = sum(w.values()) or 1.0
    score = (
        w.get("cosine", 0) * cos + w.get("entities", 0) * ent + w.get("time", 0) * near
    ) / total
    same = (
        near > 0
        and cos >= cfg.min_cosine
        and (cos >= cfg.strong_cosine or ent >= cfg.min_entity_overlap)
    )
    return EventMatch(cos, ent, near, score, same)
