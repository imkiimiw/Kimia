"""Claim statuses and confidence (spec §8). The system never picks a winner between two
versions: conflicting claims are reported side by side."""

from __future__ import annotations

from collections.abc import Sequence

CONFIRMED, LIKELY, UNCONFIRMED, CONFLICTING, REJECTED = (
    "confirmed",
    "likely",
    "unconfirmed",
    "conflicting",
    "rejected",
)
STATUS_FA = {
    CONFIRMED: "تأییدشده",
    LIKELY: "احتمال بالا",
    UNCONFIRMED: "تأییدنشده",
    CONFLICTING: "متناقض",
    REJECTED: "ردشده",
}


def claim_status(
    *,
    independent_supports: int,
    strongest_primary_reliability: int | None,
    conflicting: bool,
    rejected: bool,
    likely_min_reliability: int,
) -> str:
    """rejected: the verifier found no support · conflicting: sources disagree on it ·
    confirmed: two or more independent origins · likely: one strong primary source ·
    unconfirmed: otherwise (also when there is no usable evidence)."""
    if rejected:
        return REJECTED
    if conflicting:
        return CONFLICTING
    if independent_supports >= 2:
        return CONFIRMED
    if (
        independent_supports == 1
        and strongest_primary_reliability is not None
        and strongest_primary_reliability >= likely_min_reliability
    ):
        return LIKELY
    return UNCONFIRMED


def claim_confidence(status: str, reliabilities: Sequence[int]) -> int:
    """A small explainable number per claim: the status band, nudged by the best source."""
    base = {CONFIRMED: 85, LIKELY: 70, UNCONFIRMED: 45, CONFLICTING: 40, REJECTED: 0}[status]
    if status == REJECTED or not reliabilities:
        return base
    return max(0, min(100, base + (max(reliabilities) - 70) // 5))


def summarize_statuses(statuses: Sequence[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for status in statuses:
        counts[status] = counts.get(status, 0) + 1
    return counts
