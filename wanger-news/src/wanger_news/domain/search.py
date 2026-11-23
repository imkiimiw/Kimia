"""Search over published news (Phase 6). Pure: query → terms, vectors → ranking.

Text search matches every term (AND); each term is a small group of spellings (Persian or
ASCII digits) of which one must match (OR). Semantic search ranks published stories by the
cosine of the query's embedding to the story centroid. Nothing here invents a result: hits are
always posts that were published.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from wanger_news.domain.similarity import cosine, normalize
from wanger_news.domain.text import ZWNJ, clean_text, to_ascii_digits, to_persian_digits

# Only the letters that differ between Arabic and Persian keyboards: stored texts keep آ, ۀ …
_LIGHT = str.maketrans({"ي": "ی", "ى": "ی", "ك": "ک"})
_WORD = re.compile(r"\w+")

#: words too common to narrow a search
STOPWORDS = frozenset(
    {
        # Persian
        "و", "در", "به", "از", "که", "این", "آن", "را", "با", "برای", "تا", "یا", "هم", "می",
        "شد", "شده", "است", "بود", "های", "ها", "یک", "اما", "بر", "هر",
        # English
        "the", "and", "for", "with", "from", "that", "this", "are", "was", "of", "in", "on",
        "to", "a", "an", "at", "by", "is",
    }
)  # fmt: skip


class QueryError(ValueError):
    """The query cannot be searched (too short, too long, only common words)."""


def query_terms(
    query: str, *, min_chars: int = 2, max_chars: int = 200, max_terms: int = 6
) -> list[list[str]]:
    """The query's terms, each with its spellings. Raises QueryError."""
    text = clean_text(query).translate(_LIGHT).replace(ZWNJ, " ")
    if len(text) > max_chars:
        raise QueryError("too_long")
    if len(text.strip()) < min_chars:
        raise QueryError("too_short")
    groups: list[list[str]] = []
    seen: set[str] = set()
    for word in _WORD.findall(text):
        key = word.casefold()
        ascii_key = to_ascii_digits(key)
        if ascii_key in seen or key in STOPWORDS:
            continue
        if len(key) < min_chars and not ascii_key.isdigit():
            continue
        seen.add(ascii_key)
        groups.append(sorted({key, ascii_key, to_persian_digits(ascii_key)}))
        if len(groups) == max_terms:
            break
    if not groups:
        raise QueryError("only_common_words")
    return groups


@dataclass(frozen=True, slots=True)
class Ranked:
    id: int
    score: float


def rank(
    query: Sequence[float],
    candidates: Sequence[tuple[int, Sequence[float]]],
    *,
    min_similarity: float,
    limit: int,
) -> list[Ranked]:
    """Candidates by cosine similarity to the query, best first, above the threshold."""
    q = normalize(query)
    scored = [
        Ranked(cid, round(cosine(q, vector), 4))
        for cid, vector in candidates
        if vector and len(vector) == len(q)
    ]
    kept = [r for r in scored if r.score >= min_similarity]
    kept.sort(key=lambda r: (-r.score, -r.id))
    return kept[:limit]


def snippet(text: str, terms: Sequence[Sequence[str]], width: int = 160) -> str:
    """A short piece of ``text`` around the first matching term (or its start)."""
    flat = " ".join(text.split())
    lower = flat.casefold()
    at = -1
    for group in terms:
        for spelling in group:
            at = lower.find(spelling)
            if at >= 0:
                break
        if at >= 0:
            break
    if at < 0 or len(flat) <= width:
        return flat[:width] + ("…" if len(flat) > width else "")
    start = max(0, at - width // 3)
    piece = flat[start : start + width]
    return ("…" if start else "") + piece + ("…" if start + width < len(flat) else "")
