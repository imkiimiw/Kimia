"""Corrections of published stories (Phase 5, spec §10). Pure.

A correction says a published fact was WRONG, so it is held to a stricter standard than an
update: the old value must be in what we published, the new value must be in the new source
(numbers included) and the evidence must be a word-for-word excerpt of that source. Whatever
passes still goes to a human; nothing here publishes anything.
"""

from __future__ import annotations

from dataclasses import dataclass

from wanger_news.domain.guard import numbers_in, source_numbers, window_similarity
from wanger_news.domain.text import normalize_for_match, to_persian_digits


@dataclass(frozen=True, slots=True)
class Proposal:
    item: str
    old: str
    new: str
    source_id: str
    evidence: str


def check(
    proposal: Proposal,
    *,
    published: str,
    sources: dict[str, str],
    min_similarity: float,
) -> list[str]:
    """Problems (empty = the proposal may go to a human)."""
    problems = []
    if not proposal.item.strip() or not proposal.old.strip() or not proposal.new.strip():
        problems.append("empty field")
        return problems
    if normalize_for_match(proposal.old) == normalize_for_match(proposal.new):
        problems.append("old and new are the same")
    text = sources.get(proposal.source_id)
    if text is None:
        problems.append(f"unknown source {proposal.source_id}")
    else:
        if window_similarity(proposal.evidence, text) < min_similarity:
            problems.append("evidence is not in the source")
        missing = numbers_in(proposal.new) - source_numbers(text)
        if missing:
            problems.append("new number not in the source: " + ", ".join(sorted(missing)))
    old_numbers = numbers_in(proposal.old)
    if old_numbers:
        if old_numbers - numbers_in(published):
            problems.append("old number is not in the published text")
    elif normalize_for_match(proposal.old) not in normalize_for_match(published):
        problems.append("old value is not in the published text")
    return problems


def correction_text(item: str, old: str, new: str, source: str) -> str:
    """The spec §10 sentence (plain text; the template escapes it)."""
    noun = "رقم صحیح" if numbers_in(new) else "مورد صحیح"
    return (
        f"در نسخهٔ قبلی این خبر، {item} به اشتباه {to_persian_digits(old)} اعلام شده بود. "
        f"{noun} طبق گزارش جدید {source} {to_persian_digits(new)} است."
    )
