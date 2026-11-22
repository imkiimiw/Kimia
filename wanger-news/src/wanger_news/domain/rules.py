"""Editorial rules engine (spec §11): YAML rules, evaluated in order, every hit recorded.

Pure. ``evaluate`` sees the facts of one item and returns what the rules ask for; the caller
applies it AFTER the safety routing (``domain/editorial.py``), and only in the strict
direction: a rule may send an item to a human, hold it or skip it, change its priority or its
publish mode — it can never turn a "needs a human" into "publish".
"""

from __future__ import annotations

import operator
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from wanger_news.config.models import Rule, RuleCondition, RuleSet
from wanger_news.domain.enums import PublishMode


@dataclass(frozen=True, slots=True)
class Facts:
    category: str | None = None
    source: str | None = None
    source_type: str | None = None
    language: str | None = None
    sensitive_topics: tuple[str, ...] = ()
    breaking: bool = False
    contradiction: bool = False
    kind: str = "story"
    confidence: int | None = None
    importance: int | None = None
    priority: int | None = None
    independent_sources: int | None = None
    text: str = ""
    duplicate_similarity: float | None = None


@dataclass(slots=True)
class Outcome:
    hits: list[str] = field(default_factory=list)
    review: list[str] = field(default_factory=list)
    hold: list[str] = field(default_factory=list)
    skip: list[str] = field(default_factory=list)
    merge: list[str] = field(default_factory=list)
    new_story: list[str] = field(default_factory=list)
    priority: int | None = None
    mode: PublishMode | None = None


def _any(value: str | None, wanted: str | Sequence[str] | None) -> bool:
    if wanted is None:
        return True
    options = [wanted] if isinstance(wanted, str) else list(wanted)
    return value is not None and value in options


def _values(value: object) -> list[str] | None:
    """A condition value as a list of strings (None = no condition)."""
    if value is None:
        return None
    if isinstance(value, list):
        return [str(v) for v in value]
    return [str(value)]


#: (condition field, fact field, comparison)
NUMERIC: tuple[tuple[str, str, Callable[[float, float], bool]], ...] = (
    ("confidence_lt", "confidence", operator.lt),
    ("confidence_gte", "confidence", operator.ge),
    ("importance_gt", "importance", operator.gt),
    ("importance_lte", "importance", operator.le),
    ("priority_gte", "priority", operator.ge),
    ("priority_lt", "priority", operator.lt),
    ("independent_sources_lt", "independent_sources", operator.lt),
    ("independent_sources_gte", "independent_sources", operator.ge),
    ("duplicate_similarity_gt", "duplicate_similarity", operator.gt),
)


def matches(cond: RuleCondition, f: Facts) -> bool:
    topics = _values(cond.sensitive_topic)
    checks = [
        _any(f.category, cond.category),
        _any(f.source, cond.source),
        _any(f.source_type, _values(cond.source_type)),
        _any(f.language, cond.language),
        cond.sensitive is None or cond.sensitive == bool(f.sensitive_topics),
        topics is None or bool(set(f.sensitive_topics) & set(topics)),
        cond.breaking is None or cond.breaking == f.breaking,
        cond.contradiction is None or cond.contradiction == f.contradiction,
        cond.kind is None or cond.kind == f.kind,
    ]
    for limit_name, fact_name, compare in NUMERIC:
        limit = getattr(cond, limit_name)
        if limit is not None:
            value = getattr(f, fact_name)
            checks.append(value is not None and compare(value, limit))
    if cond.keyword_any:
        text = f.text.lower()
        checks.append(any(word.lower() in text for word in cond.keyword_any))
    return all(checks)


def evaluate(rules: Sequence[Rule], facts: Facts) -> Outcome:
    """All enabled rules that match, in file order. Priority: the last rule that sets it."""
    out = Outcome()
    for rule in rules:
        if not rule.enabled or not matches(rule.when, facts):
            continue
        out.hits.append(rule.id)
        action = rule.then
        if isinstance(action, RuleSet):
            if action.priority_value is not None:
                out.priority = action.priority_value
            if action.mode is not None:
                out.mode = action.mode
        elif action == "require_human_review":
            out.review.append(rule.id)
        elif action == "hold":
            out.hold.append(rule.id)
        elif action == "skip":
            out.skip.append(rule.id)
        elif action == "merge":
            out.merge.append(rule.id)
        elif action == "new_story":
            out.new_story.append(rule.id)
    return out
