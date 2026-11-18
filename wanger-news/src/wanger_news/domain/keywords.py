"""Whole-word keyword matching on normalized text (shared by classification and filters)."""

from __future__ import annotations

import re
from collections.abc import Iterable

from wanger_news.domain.text import normalize_for_match


class KeywordMatcher:
    """Matches any of a list of keywords; reports which ones matched (explainability)."""

    def __init__(self, keywords: Iterable[str]) -> None:
        patterns: list[str] = []
        for raw in keywords:
            wildcard = raw.endswith("*")
            norm = normalize_for_match(raw.rstrip("*"))
            if not norm:
                continue
            body = re.escape(norm).replace(r"\ ", r"\s+")
            patterns.append(body + (r"\w*" if wildcard else ""))
        # longest first so "central bank" wins over "bank"
        patterns.sort(key=len, reverse=True)
        self._regex = (
            re.compile(r"(?<!\w)(?:" + "|".join(patterns) + r")(?!\w)") if patterns else None
        )

    def __bool__(self) -> bool:
        return self._regex is not None

    def find(self, normalized_text: str) -> list[str]:
        """Distinct matches, in order of appearance. The text must be ``normalize_for_match``ed."""
        if self._regex is None:
            return []
        seen: dict[str, None] = {}
        for match in self._regex.finditer(normalized_text):
            seen.setdefault(match.group(0), None)
        return list(seen)
