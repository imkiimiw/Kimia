"""Rule-based classification (Phase 1): category, hashtags, priority and sensitive topics.

Deterministic and explainable: every decision keeps the keywords that caused it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from wanger_news.config.models import CategoriesFile, ClassificationConfig
from wanger_news.domain.keywords import KeywordMatcher
from wanger_news.domain.text import normalize_for_match


@dataclass(frozen=True, slots=True)
class Classification:
    category: str
    hashtags: list[str]
    priority: int
    priority_label: str
    sensitive_topics: list[str]
    scores: dict[str, int] = field(default_factory=dict)
    matched: dict[str, list[str]] = field(default_factory=dict)

    @property
    def sensitive(self) -> bool:
        return bool(self.sensitive_topics)

    def explain(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "scores": self.scores,
            "priority": self.priority,
            "priority_label": self.priority_label,
            "sensitive_topics": self.sensitive_topics,
            "matched": self.matched,
        }


class RuleClassifier:
    def __init__(self, categories: CategoriesFile, cfg: ClassificationConfig) -> None:
        self._cfg = cfg
        self._categories = categories
        self._category_matchers = [
            (c.id, KeywordMatcher(c.keywords.all())) for c in categories.categories
        ]
        self._priority_matchers = [
            (r.priority, r.label, KeywordMatcher(r.keywords.all()))
            for r in sorted(categories.priority_rules, key=lambda r: r.priority, reverse=True)
        ]
        self._sensitive_matchers = [
            (t.id, KeywordMatcher(t.keywords.all())) for t in categories.sensitive_topics
        ]

    def classify(self, title: str, body: str, default_category: str) -> Classification:
        title_n = normalize_for_match(title)
        body_n = normalize_for_match(body)
        both = f"{title_n} {body_n}"
        matched: dict[str, list[str]] = {}

        scores: dict[str, int] = {}
        for cat_id, matcher in self._category_matchers:
            in_title = matcher.find(title_n)
            in_body = matcher.find(body_n)
            score = self._cfg.title_weight * len(in_title) + self._cfg.body_weight * len(in_body)
            if score:
                scores[cat_id] = score
                matched[f"category:{cat_id}"] = list(dict.fromkeys(in_title + in_body))

        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        if ranked and ranked[0][1] >= self._cfg.min_category_score:
            category = ranked[0][0]
        else:
            category = default_category

        priority, label = self._priority(both, category, matched)
        sensitive = []
        for topic_id, matcher in self._sensitive_matchers:
            hits = matcher.find(both)
            if hits:
                sensitive.append(topic_id)
                matched[f"sensitive:{topic_id}"] = hits

        return Classification(
            category=category,
            hashtags=self._hashtags(category, ranked),
            priority=priority,
            priority_label=label,
            sensitive_topics=sensitive,
            scores=dict(ranked),
            matched=matched,
        )

    def _priority(self, text: str, category: str, matched: dict[str, list[str]]) -> tuple[int, str]:
        for priority, label, matcher in self._priority_matchers:
            hits = matcher.find(text)
            if hits:
                matched[f"priority:{label}"] = hits
                return priority, label
        cat = self._categories.get(category)
        if cat is not None and cat.base_priority is not None:
            return cat.base_priority, f"category:{category}"
        return self._categories.default_priority, "default"

    def _hashtags(self, category: str, ranked: list[tuple[str, int]]) -> list[str]:
        limit = self._cfg.max_hashtags
        if limit == 0:
            return []
        ordered = [category] + [
            cat_id
            for cat_id, score in ranked
            if cat_id != category and score >= self._cfg.secondary_hashtag_min_score
        ]
        tags: list[str] = []
        for cat_id in ordered:
            cat = self._categories.get(cat_id)
            if cat is not None and cat.hashtag not in tags:
                tags.append(cat.hashtag)
            if len(tags) >= limit:
                break
        return tags
