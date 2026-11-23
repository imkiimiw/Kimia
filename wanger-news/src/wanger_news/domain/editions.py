"""Editions (Phase 6 personalization and multilingual output). Pure.

An edition is an extra channel with its own selection (categories, minimum importance, breaking
only, updates, source posts) and language. It only ever receives what already reached the main
channel — selection narrows, it never decides anew. An English edition needs an English text
that passes the deterministic English guard (``check_english``); otherwise the item is skipped
for that edition (the Persian post stands; nothing goes out unchecked).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from wanger_news.config.models import EditionConfig, GuardConfig
from wanger_news.domain.guard import (
    _LINK,
    GuardReport,
    _contains_name,
    _phrase,
    numbers_in,
    source_numbers,
)
from wanger_news.domain.similarity import extract_entity_names
from wanger_news.domain.text import detect_language

_SENTENCE_START = re.compile(r"(?:^|[.!?:;]\s+|\n)([A-Z][a-z]+)\b")


@dataclass(frozen=True, slots=True)
class EditionItem:
    """What an edition's selection looks at."""

    category: str | None
    importance: int
    breaking: bool
    update: bool
    source_post: bool
    conflicting: bool


def selects(edition: EditionConfig, item: EditionItem) -> str | None:
    """None when the edition takes the item, else why not (a counter name)."""
    if item.source_post:
        if not edition.include_source_posts:
            return "source_posts_off"
        if edition.language != "fa":
            return "source_post_not_translated"  # human-curated posts are never machine-translated
        return None
    if item.update and not edition.include_updates:
        return "updates_off"
    if edition.categories and (item.category or "") not in edition.categories:
        return "category"
    if edition.breaking_only and not item.breaking:
        return "not_breaking"
    if item.importance < edition.min_importance:
        return "importance"
    if item.conflicting and edition.language != "fa":
        return "conflicting"  # contradictions are shown side by side in Persian only
    return None


def check_english(
    title: str,
    summary: str,
    key_points: Sequence[str],
    *,
    verified: str,
    sources: str,
    names: Iterable[str],
    cfg: GuardConfig,
) -> GuardReport:
    """The English edition may say nothing the verified Persian summary does not: every number
    is in the summary or the sources, every proper name in the sources or among the summary's
    declared original names; English only, no links or markup, within the length limits."""
    report = GuardReport()
    texts = [title, summary, *key_points]
    if not title.strip():
        report.add("empty", "title")
    if not summary.strip():
        report.add("empty", "summary")
    if len(title) > cfg.max_title_chars:
        report.add("too_long", f"title {len(title)} chars")
    if len(summary) > cfg.max_summary_chars:
        report.add("too_long", f"summary {len(summary)} chars")
    if len(key_points) > cfg.max_key_points:
        report.add("too_long", f"{len(key_points)} key points")
    for text in texts:
        if text.strip() and detect_language(text) != "en":
            report.add("not_english", text[:60])
        match = _LINK.search(text)
        if match:
            report.add("forbidden_markup", match.group(0))
    allowed = source_numbers(f"{verified}\n{sources}")
    for text in texts:
        for number in sorted(numbers_in(text)):
            if number not in allowed:
                report.add("number_not_in_source", number)
    known = _phrase(sources + "\n" + "\n".join(names))
    starts = {m.group(1) for text in texts for m in _SENTENCE_START.finditer(text)}
    for text in texts:
        for _key, shown in extract_entity_names(text, limit=60):
            if shown in starts:  # "Officials said …": a capitalised first word, not a name
                continue
            if not _contains_name(shown, known):
                report.add("name_not_in_source", shown)
    return report
