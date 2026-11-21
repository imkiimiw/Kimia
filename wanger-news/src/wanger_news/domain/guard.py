"""Hallucination guard, layer 1 (spec §9): deterministic, cheap, mandatory. No AI involved.

Every check compares the Persian draft with the SOURCE text the AI was given:
- every number/date written with digits must exist in the source (digits unified first);
- every Latin-script name in the Persian text, and every declared entity, must be in the source;
- every «quotation» must be declared, and its original must be (nearly) verbatim in the source;
- every claim must carry evidence that is (nearly) verbatim in the source;
- the text must be Persian, within limits, and free of links/mentions/markup.

Any issue means: one rewrite without the unsupported parts, then a human. Never published as is.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from typing import Any

from wanger_news.config.models import GuardConfig
from wanger_news.domain.summary import SummaryDraft
from wanger_news.domain.text import detect_language, normalize_for_match, to_ascii_digits, tokens

_NUMBER = re.compile(r"\d+(?:[.,٫٬]\d+)*")
_THOUSANDS = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_SCALED = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(thousand|million|billion|trillion|bn|m|k|هزار|میلیون|میلیارد)\b",
    re.IGNORECASE,
)
_SCALE = {
    "thousand": 3,
    "k": 3,
    "هزار": 3,
    "million": 6,
    "m": 6,
    "میلیون": 6,
    "billion": 9,
    "bn": 9,
    "میلیارد": 9,
    "trillion": 12,
}
_UNITS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "dozen": 12,
    "hundred": 100,
    "thousand": 1000,
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
    "tenth": 10,
    "once": 1,
    "twice": 2,
    "یک": 1,
    "دو": 2,
    "سه": 3,
    "چهار": 4,
    "پنج": 5,
    "شش": 6,
    "هفت": 7,
    "هشت": 8,
    "نه": 9,
    "ده": 10,
    "یازده": 11,
    "دوازده": 12,
    "سیزده": 13,
    "چهارده": 14,
    "پانزده": 15,
    "شانزده": 16,
    "هفده": 17,
    "هجده": 18,
    "نوزده": 19,
    "بیست": 20,
    "سی": 30,
    "چهل": 40,
    "پنجاه": 50,
    "شصت": 60,
    "هفتاد": 70,
    "هشتاد": 80,
    "نود": 90,
    "صد": 100,
    "هزار": 1000,
}
_TENS = {
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_TENS_WORDS = re.compile(
    r"\b(" + "|".join(_TENS) + r")(?:[-\s](one|two|three|four|five|six|"
    r"seven|eight|nine))?\b",
    re.IGNORECASE,
)
_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9.'’&\-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9.'’&\-]*)*")
_QUOTED = re.compile(r"«([^»]{2,})»|“([^”]{2,})”|\"([^\"]{2,})\"")
_LINK = re.compile(r"(?:https?://|www\.)\S+|(?<!\w)@\w{3,}|<[a-zA-Z/][^>]*>", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class Issue:
    kind: str
    detail: str


@dataclass(slots=True)
class GuardReport:
    issues: list[Issue] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.issues

    def add(self, kind: str, detail: str) -> None:
        issue = Issue(kind, detail[:200])
        if issue not in self.issues:
            self.issues.append(issue)

    def extend(self, other: GuardReport) -> None:
        for issue in other.issues:
            self.add(issue.kind, issue.detail)

    def as_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "issues": [{"kind": i.kind, "detail": i.detail} for i in self.issues],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> GuardReport:
        report = cls()
        for item in (data or {}).get("issues", []):
            report.add(str(item.get("kind")), str(item.get("detail")))
        return report


# ------------------------------------------------------------------ numbers


def _canonical(raw: str) -> set[str]:
    """Spellings of one number token → canonical decimal strings ("1,000" → "1000")."""
    text = raw.replace("٬", "").replace("٫", ".")
    variants = set()
    if _THOUSANDS.match(text):
        variants.add(text.replace(",", ""))
    elif "," in text:
        variants.add(text.replace(",", ""))
        variants.add(text.replace(",", "."))
    else:
        variants.add(text)
    out = set()
    for variant in variants:
        try:
            value = Decimal(variant)
        except InvalidOperation:
            continue
        out.add(format(value.normalize(), "f"))
    return out


def numbers_in(text: str) -> set[str]:
    found: set[str] = set()
    for match in _NUMBER.finditer(to_ascii_digits(text)):
        found |= _canonical(match.group())
    return found


def source_numbers(text: str) -> set[str]:
    """Numbers a faithful translation may write with digits: the source's own digits, number
    words ("two", "دو", "twenty-five") and scaled values ("1.2 million" → 1200000)."""
    ascii_text = to_ascii_digits(text)
    found = numbers_in(ascii_text)
    for word in re.findall(r"[^\W\d_]+", ascii_text.lower()):
        if word in _UNITS:
            found.add(str(_UNITS[word]))
    for match in _TENS_WORDS.finditer(ascii_text):
        tens = _TENS[match.group(1).lower()]
        unit = _UNITS.get((match.group(2) or "").lower(), 0)
        found.add(str(tens + unit))
    for match in _SCALED.finditer(ascii_text):
        for base in _canonical(match.group(1)):
            scaled = Decimal(base).scaleb(_SCALE[match.group(2).lower()])
            found.add(format(scaled.normalize(), "f"))
    return found


# ------------------------------------------------------------------ similarity


def _phrase(text: str) -> str:
    return " " + " ".join(tokens(text)) + " "


def window_similarity(needle: str, haystack: str) -> float:
    """How well ``needle`` appears as one contiguous passage of ``haystack`` (0..1).
    Normalized tokens, so punctuation, case, ZWNJ and Arabic/Persian letter forms do not matter."""
    words = tokens(needle)
    hay = tokens(haystack)
    if not words or not hay:
        return 0.0
    if _phrase(needle) in _phrase(haystack):
        return 1.0
    size = len(words)
    best = 0.0
    for start in range(0, max(1, len(hay) - size + 1)):
        window = hay[start : start + size + max(1, size // 5)]
        ratio = SequenceMatcher(None, words, window, autojunk=False).ratio()
        if ratio > best:
            best = ratio
            if best >= 0.99:
                break
    return best


def _contains_name(name: str, source_phrase: str) -> bool:
    words = tokens(name)
    return bool(words) and (" " + " ".join(words) + " ") in source_phrase


# ------------------------------------------------------------------ the guard


def check(
    draft: SummaryDraft, sources: Sequence[str] | Mapping[str, str], cfg: GuardConfig
) -> GuardReport:
    """``sources``: the texts the AI was given — a list, or source id → text for a story with
    several sources (then every piece of evidence must come from the source it names)."""
    report = GuardReport()
    by_id: dict[str, str] = dict(sources) if isinstance(sources, Mapping) else {}
    source = "\n".join(by_id.values()) if by_id else "\n".join(sources)
    source_phrase = _phrase(source)
    _check_shape(draft, cfg, report)
    _check_numbers(draft, source, report)
    _check_latin(draft, source_phrase, report)
    _check_entities(draft, source_phrase, report)
    _check_quotes(draft, source, cfg, report)
    _check_claims(draft, source, by_id, cfg, report)
    _check_contradictions(draft, by_id, cfg, report)
    return report


def _check_shape(draft: SummaryDraft, cfg: GuardConfig, report: GuardReport) -> None:
    if not draft.title:
        report.add("empty", "title")
    if not draft.summary:
        report.add("empty", "summary")
    if len(draft.title) > cfg.max_title_chars:
        report.add("too_long", f"title {len(draft.title)} chars")
    if len(draft.summary) > cfg.max_summary_chars:
        report.add("too_long", f"summary {len(draft.summary)} chars")
    if len(draft.key_points) > cfg.max_key_points:
        report.add("too_long", f"{len(draft.key_points)} key points")
    whole = "\n".join(draft.texts())
    if whole.strip() and detect_language(whole) != "fa":  # Persian vs Arabic: judged on all text
        report.add("not_persian", whole[:60])
    for text in draft.texts():
        if detect_language(text) == "en":  # any part mostly in Latin script
            report.add("not_persian", text[:60])
        match = _LINK.search(text)
        if match:
            report.add("forbidden_markup", match.group(0))


def _check_numbers(draft: SummaryDraft, source: str, report: GuardReport) -> None:
    allowed = source_numbers(source)
    written: set[str] = set()
    texts = [
        *draft.texts(),
        *(c.text for c in draft.claims),
        *(q.fa for q in draft.quotes),
        *(c.topic for c in draft.contradictions),
    ]
    for text in texts:
        written |= numbers_in(text)
    for number in sorted(written):
        if number not in allowed:
            report.add("number_not_in_source", number)


def _check_latin(draft: SummaryDraft, source_phrase: str, report: GuardReport) -> None:
    for text in draft.texts():
        for match in _LATIN.finditer(text):
            name = match.group(0).strip(" .'’-")
            if len(name) < 2 or name.isdigit():
                continue
            if not _contains_name(name, source_phrase):
                report.add("name_not_in_source", name)


def _check_entities(draft: SummaryDraft, source_phrase: str, report: GuardReport) -> None:
    body = normalize_for_match(" ".join(draft.texts()))
    for entity in draft.entities:
        used = normalize_for_match(entity.fa) in body if entity.fa else True
        if used and not _contains_name(entity.original, source_phrase):
            report.add("name_not_in_source", entity.original or entity.fa)


def _check_quotes(draft: SummaryDraft, source: str, cfg: GuardConfig, report: GuardReport) -> None:
    declared = [(normalize_for_match(q.fa), q) for q in draft.quotes]
    for text in draft.texts():
        for match in _QUOTED.finditer(text):
            span = normalize_for_match(next(g for g in match.groups() if g))
            if not any(span and (span in fa or fa in span) for fa, _ in declared if fa):
                report.add("undeclared_quote", span[:80])
    for _, quote in declared:
        if window_similarity(quote.original, source) < cfg.quote_min_similarity:
            report.add("quote_not_in_source", quote.original[:80])


def _check_claims(
    draft: SummaryDraft, source: str, by_id: dict[str, str], cfg: GuardConfig, report: GuardReport
) -> None:
    for claim in draft.claims:
        supports = [s for s in claim.support if s.evidence.strip()]
        if not supports and not claim.evidence.strip():
            report.add("claim_without_evidence", claim.text[:80])
            continue
        if (
            claim.evidence.strip()
            and window_similarity(claim.evidence, source) < cfg.evidence_min_similarity
        ):
            report.add("evidence_not_in_source", claim.evidence[:80])
        for support in supports:
            text = by_id.get(support.source_id, source if not by_id else None)
            if text is None:
                report.add("unknown_source", support.source_id)
            elif window_similarity(support.evidence, text) < cfg.evidence_min_similarity:
                report.add(
                    "evidence_not_in_source", f"{support.source_id}: {support.evidence[:70]}"
                )


def _check_contradictions(
    draft: SummaryDraft, by_id: dict[str, str], cfg: GuardConfig, report: GuardReport
) -> None:
    """Each side of a reported disagreement must really be in the source it is credited to,
    numbers included: the system reports both versions, it never invents one."""
    for item in draft.contradictions:
        if len({v.source_id for v in item.versions}) < 2:
            report.add("contradiction_one_source", item.topic[:80])
        for version in item.versions:
            text = by_id.get(version.source_id)
            if text is None:
                report.add("unknown_source", version.source_id)
                continue
            if window_similarity(version.evidence, text) < cfg.evidence_min_similarity:
                report.add(
                    "evidence_not_in_source", f"{version.source_id}: {version.evidence[:70]}"
                )
            missing = numbers_in(version.statement) - source_numbers(text)
            for number in sorted(missing):
                report.add("number_not_in_source", f"{version.source_id}: {number}")


def unsupported_parts(report: GuardReport) -> list[str]:
    """What the rewrite must remove, in plain words for the prompt."""
    return [f"{i.kind}: {i.detail}" for i in report.issues]


def describe(report: GuardReport, limit: int = 5) -> list[str]:
    """Persian one-liners for the review card."""
    labels = {
        "number_not_in_source": "عدد در منبع نیست",
        "name_not_in_source": "نام در منبع نیست",
        "undeclared_quote": "نقل‌قول بدون منبع",
        "quote_not_in_source": "نقل‌قول با منبع نمی‌خواند",
        "claim_without_evidence": "ادعای بدون شاهد",
        "evidence_not_in_source": "شاهد در منبع نیست",
        "not_persian": "متن فارسی نیست",
        "forbidden_markup": "لینک/نشانه‌گذاری غیرمجاز",
        "too_long": "طولانی",
        "empty": "خالی",
        "unsupported_claim": "ادعای تأییدنشده (بررسی AI)",
        "unsupported_statement": "جملهٔ بدون پشتوانه (بررسی AI)",
        "unknown_source": "منبع ناشناخته",
        "contradiction_one_source": "تناقض با یک منبع",
        "verification_unavailable": "بررسی دوم انجام نشد",
    }
    lines = [f"{labels.get(i.kind, i.kind)}: {i.detail}" for i in report.issues[:limit]]
    if len(report.issues) > limit:
        lines.append(f"… و {len(report.issues) - limit} مورد دیگر")
    return lines


def merge(reports: Iterable[GuardReport]) -> GuardReport:
    merged = GuardReport()
    for report in reports:
        merged.extend(report)
    return merged
