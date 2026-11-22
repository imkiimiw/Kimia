"""A transparent 0–100 completeness score for an item (stored with its breakdown)."""

from __future__ import annotations

from dataclasses import dataclass

#: points per signal; the sum of the maxima is 100
POINTS = {"title": 25, "description": 30, "date": 20, "url": 15, "image": 10}
GOOD_TITLE = (20, 200)
GOOD_DESCRIPTION = 80
SHORT_DESCRIPTION = 20


@dataclass(frozen=True, slots=True)
class Quality:
    score: int
    breakdown: dict[str, int]


def assess(title: str, description: str, has_date: bool, has_url: bool, has_image: bool) -> Quality:
    parts = {
        "title": POINTS["title"]
        if GOOD_TITLE[0] <= len(title) <= GOOD_TITLE[1]
        else POINTS["title"] // 2
        if title
        else 0,
        "description": POINTS["description"]
        if len(description) >= GOOD_DESCRIPTION
        else POINTS["description"] // 2
        if len(description) >= SHORT_DESCRIPTION
        else 0,
        "date": POINTS["date"] if has_date else 0,
        "url": POINTS["url"] if has_url else 0,
        "image": POINTS["image"] if has_image else 0,
    }
    return Quality(score=sum(parts.values()), breakdown=parts)
