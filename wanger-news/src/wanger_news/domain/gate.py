"""The gate (spec §6): only items worth the expensive stages continue. Pure logic."""

from __future__ import annotations

from dataclasses import dataclass

from wanger_news.config.models import FilterLists, FiltersFile, GateConfig
from wanger_news.domain.classify import Classification
from wanger_news.domain.enums import ArticleStatus
from wanger_news.domain.keywords import KeywordMatcher
from wanger_news.domain.text import normalize_for_match


@dataclass(frozen=True, slots=True)
class GateDecision:
    status: ArticleStatus
    reason: str


@dataclass(frozen=True, slots=True)
class GateInput:
    source_id: str
    country: str | None
    title: str
    body: str
    human_curated: bool  # posts from our own source channel: a human already chose them


class Gate:
    def __init__(self, filters: FiltersFile, cfg: GateConfig) -> None:
        self._cfg = cfg
        self._black = filters.blacklist
        self._white = filters.whitelist
        self._black_kw = KeywordMatcher(filters.blacklist.keywords)
        self._white_kw = KeywordMatcher(filters.whitelist.keywords)

    def decide(self, item: GateInput, cls: Classification) -> GateDecision:
        if item.human_curated:  # an admin posted it in the source channel on purpose
            return GateDecision(ArticleStatus.QUEUED, "human_curated")
        text = normalize_for_match(f"{item.title} {item.body}")
        reason = self._listed(self._black, self._black_kw, item, cls.category, text)
        if reason:
            return GateDecision(ArticleStatus.FILTERED, f"blacklist:{reason}")
        missing = self._whitelist_miss(item, cls.category, text)
        if missing:
            return GateDecision(ArticleStatus.FILTERED, f"not_whitelisted:{missing}")
        if cls.priority < self._cfg.min_priority:
            return GateDecision(ArticleStatus.FILTERED, f"below_gate:{cls.priority}")
        if cls.sensitive:
            return GateDecision(
                ArticleStatus.PENDING_REVIEW, "sensitive:" + ",".join(cls.sensitive_topics)
            )
        return GateDecision(ArticleStatus.QUEUED, "passed")

    @staticmethod
    def _listed(
        lists: FilterLists, kw: KeywordMatcher, item: GateInput, category: str, text: str
    ) -> str | None:
        if item.source_id in lists.sources:
            return f"source={item.source_id}"
        if item.country and item.country in lists.countries:
            return f"country={item.country}"
        if category in lists.categories:
            return f"category={category}"
        hits = kw.find(text)
        if hits:
            return f"keyword={hits[0]}"
        return None

    def _whitelist_miss(self, item: GateInput, category: str, text: str) -> str | None:
        white = self._white
        if white.sources and item.source_id not in white.sources:
            return "source"
        if white.countries and item.country not in white.countries:
            return "country"
        if white.categories and category not in white.categories:
            return "category"
        if self._white_kw and not self._white_kw.find(text):
            return "keyword"
        return None
