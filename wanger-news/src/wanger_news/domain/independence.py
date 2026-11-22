"""Which reports of a story are independent (spec §8)?

Five sites running the same AP text are ONE source. Two reports are the same origin when their
outlets share an ``owner_group``, when one is a recorded copy of the other (L1/L2 duplicate),
or when their texts are nearly the same (a syndicated wire copy).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from wanger_news.domain.text import tokens


@dataclass(frozen=True, slots=True)
class Report:
    article_id: int
    source_id: str
    source_name: str
    owner_group: str
    reliability: int
    primary: bool  # agency / government / official organisation
    text: str
    copy_of: int | None = None  # a recorded duplicate of this article id


@dataclass(slots=True)
class Origin:
    reports: list[Report] = field(default_factory=list)

    @property
    def best(self) -> Report:
        """The most reliable report speaks for the origin (primary first, then reliability)."""
        return max(self.reports, key=lambda r: (r.primary, r.reliability, -r.article_id))

    @property
    def article_ids(self) -> list[int]:
        return sorted(r.article_id for r in self.reports)


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def origins(reports: Sequence[Report], syndication_min_jaccard: float) -> list[Origin]:
    """Group reports into independent origins (union-find), most reliable origin first."""
    parent = list(range(len(reports)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        parent[find(i)] = find(j)

    words = [set(tokens(r.text)) for r in reports]
    index = {r.article_id: i for i, r in enumerate(reports)}
    for i, a in enumerate(reports):
        if a.copy_of is not None and a.copy_of in index:
            union(i, index[a.copy_of])
        for j in range(i + 1, len(reports)):
            b = reports[j]
            if (
                a.owner_group == b.owner_group
                or _jaccard(words[i], words[j]) >= syndication_min_jaccard
            ):
                union(i, j)
    groups: dict[int, Origin] = {}
    for i, report in enumerate(reports):
        groups.setdefault(find(i), Origin()).reports.append(report)
    return sorted(
        groups.values(), key=lambda o: (not o.best.primary, -o.best.reliability, o.best.article_id)
    )


def origin_of(article_id: int, groups: Sequence[Origin]) -> int | None:
    for n, origin in enumerate(groups):
        if article_id in origin.article_ids:
            return n
    return None
