"""Hallucination guard layer 1, importance/confidence scoring and editorial routing (all pure)."""

from __future__ import annotations

from typing import Any

import pytest

from wanger_news.config.models import AutoPublishConfig, GuardConfig, ScoringConfig
from wanger_news.domain.editorial import route
from wanger_news.domain.enums import ArticleStatus, PublishMode, SourceType
from wanger_news.domain.guard import check, describe, numbers_in, source_numbers, window_similarity
from wanger_news.domain.scoring import confidence, importance, label, recency
from wanger_news.domain.summary import ImportanceFactors, SummaryDraft

SOURCE = (
    "The central bank raised its main interest rate by half a point to 4.25% on Tuesday, "
    'Governor Jane Smith told Reuters. "We will act decisively," she said. Two million people '
    "are affected and losses reached $1.2bn, according to the finance ministry. "
    "Twenty-five people were injured in protests on 18 November 2026."
)


def draft(**kw: Any) -> SummaryDraft:
    base: dict[str, Any] = {
        "title": "بانک مرکزی نرخ بهره را به ۴٫۲۵ درصد رساند",
        "summary": (
            "به گفتهٔ جین اسمیت (Jane Smith)، رئیس بانک مرکزی، نرخ بهره روز سه‌شنبه "
            "افزایش یافت. او گفت: «ما قاطعانه عمل خواهیم کرد.»\n\n"
            "حدود ۲ میلیون نفر تحت تأثیرند و زیان به ۱٫۲ میلیارد دلار رسید. "
            "در اعتراض‌های ۱۸ نوامبر ۲۰۲۶، ۲۵ نفر زخمی شدند."
        ),
        "key_points": ["نرخ بهره: ۴٫۲۵ درصد"],
        "quotes": [
            {
                "fa": "ما قاطعانه عمل خواهیم کرد.",
                "original": "We will act decisively",
                "speaker": "Jane Smith",
            }
        ],
        "claims": [
            {
                "text": "نرخ به ۴٫۲۵ درصد رسید",
                "evidence": "raised its main interest rate by half a point to 4.25%",
            }
        ],
        "entities": [{"fa": "جین اسمیت", "original": "Jane Smith", "type": "person"}],
    }
    base.update(kw)
    return SummaryDraft.model_validate(base)


def kinds(d: SummaryDraft, source: str = SOURCE) -> list[str]:
    return [i.kind for i in check(d, [source], GuardConfig()).issues]


def test_a_faithful_draft_passes() -> None:
    report = check(draft(), [SOURCE], GuardConfig())
    assert report.passed, report.issues


# ------------------------------------------------------------------ numbers


def test_number_spellings_are_unified() -> None:
    assert numbers_in("۱٬۲۰۰ و ۴٫۲۵ و 1,200 و 07") == {"1200", "4.25", "7"}
    assert {"2", "25", "1.2", "1200000000", "18", "2026"} <= source_numbers(SOURCE)


def test_invented_number_is_caught() -> None:
    assert kinds(draft(summary="شمار کشته‌ها به ۴۰ نفر رسید.")) == ["number_not_in_source"]


def test_numbers_in_claims_and_quotes_count_too() -> None:
    d = draft(
        claims=[{"text": "۳۰۰ نفر بازداشت شدند", "evidence": "Two million people are affected"}]
    )
    assert "number_not_in_source" in kinds(d)


def test_converted_dates_are_caught() -> None:
    # 18 November 2026 written as a Jalali date: 27 and 1405 are not in the source
    assert set(kinds(draft(summary="روز ۲۷ آبان ۱۴۰۵ تظاهرات شد."))) == {"number_not_in_source"}


def test_persian_source_number_words() -> None:
    source = "در این حادثه سه نفر زخمی شدند و بیست خانه آسیب دید."
    ok = SummaryDraft(title="حادثه", summary="۳ نفر زخمی شدند و ۲۰ خانه آسیب دید.")
    assert check(ok, [source], GuardConfig()).passed


# ------------------------------------------------------------------ names


def test_invented_latin_name_is_caught() -> None:
    d = draft(summary="به گزارش آسوشیتدپرس (Associated Press) نرخ بهره افزایش یافت.")
    assert kinds(d) == ["name_not_in_source"]


def test_declared_entity_must_be_in_the_source() -> None:
    d = draft(
        entities=[
            {"fa": "جین اسمیت", "original": "Jane Smith", "type": "person"},
            {"fa": "رئیس‌جمهور", "original": "President Miller", "type": "person"},
        ],
        summary=draft().summary + " رئیس‌جمهور هم واکنش نشان داد.",
    )
    assert kinds(d) == ["name_not_in_source"]


def test_unused_declared_entity_is_ignored() -> None:
    d = draft(entities=[{"fa": "کسی که در متن نیست", "original": "Nobody Here", "type": "person"}])
    assert kinds(d) == []


# ------------------------------------------------------------------ quotes and claims


def test_undeclared_quote_is_caught() -> None:
    d = draft(summary=draft().summary + " او افزود: «ما تسلیم نمی‌شویم».")
    assert kinds(d) == ["undeclared_quote"]


def test_quote_original_must_be_verbatim() -> None:
    d = draft(
        quotes=[
            {
                "fa": "ما قاطعانه عمل خواهیم کرد.",
                "original": "We shall never surrender",
                "speaker": "Jane Smith",
            }
        ]
    )
    assert kinds(d) == ["quote_not_in_source"]


def test_claims_need_verbatim_evidence() -> None:
    assert kinds(draft(claims=[{"text": "نرخ بالا رفت", "evidence": ""}])) == [
        "claim_without_evidence"
    ]
    bad = draft(claims=[{"text": "نرخ بالا رفت", "evidence": "the bank cut rates to zero"}])
    assert kinds(bad) == ["evidence_not_in_source"]


def test_evidence_tolerates_punctuation_and_case() -> None:
    d = draft(
        claims=[
            {"text": "زیان", "evidence": "LOSSES reached $1.2bn according to the Finance Ministry"}
        ]
    )
    assert kinds(d) == []
    assert window_similarity("governor jane smith told reuters", SOURCE) == 1.0


# ------------------------------------------------------------------ shape


def test_shape_checks() -> None:
    assert "not_persian" in kinds(draft(summary="The bank raised rates."))
    assert "forbidden_markup" in kinds(draft(summary="جزئیات: https://evil.example/x"))
    assert "forbidden_markup" in kinds(draft(summary="کانال @somechannel را ببینید"))
    assert "too_long" in kinds(draft(title="ا" * 300))
    assert "empty" in kinds(draft(summary=""))


def test_markdown_is_cleaned_before_checking() -> None:
    d = draft(title="**عنوان**", key_points=["- نکته", "• دیگری", ""]).cleaned()
    assert d.title == "عنوان" and d.key_points == ["نکته", "دیگری"]


def test_issues_are_described_in_persian() -> None:
    report = check(draft(summary="شمار کشته‌ها به ۴۰ نفر رسید."), [SOURCE], GuardConfig())
    assert describe(report) == ["عدد در منبع نیست: 40"]


# ------------------------------------------------------------------ scoring


def test_recency() -> None:
    cfg = ScoringConfig()
    assert recency(1, cfg) == 100 and recency(30, cfg) == 0 and 0 < recency(12, cfg) < 100


def test_importance_with_and_without_ai_factors() -> None:
    cfg = ScoringConfig()
    without = importance(80, None, 1, cfg)
    assert without.value == round((2 * 80 + 0.5 * 100) / 2.5)
    assert without.breakdown["ai_factors"] is False
    high = importance(
        80,
        ImportanceFactors(
            people_affected=9,
            significance=9,
            severity=8,
            geographic_scope=9,
            continuation=7,
            international_impact=9,
        ),
        1,
        cfg,
    )
    low = importance(80, ImportanceFactors(), 1, cfg)
    assert high.value > without.value > low.value
    assert set(high.breakdown["components"]) >= {"severity", "recency", "rule_priority"}


def test_confidence_is_capped_for_a_single_source() -> None:
    cfg = ScoringConfig()
    one = confidence(
        reliability=95,
        source_type=SourceType.NEWS_AGENCY,
        quality=100,
        guard_state="passed",
        independent_sources=1,
        cfg=cfg,
    )
    two = confidence(
        reliability=95,
        source_type=SourceType.NEWS_AGENCY,
        quality=100,
        guard_state="passed",
        independent_sources=2,
        cfg=cfg,
    )
    assert one.value == 69 and one.breakdown["single_source_cap"] == 69
    assert two.value > 69 and label(two.value, cfg) in ("confirmed", "likely")
    assert label(one.value, cfg) == "preliminary"
    failed = confidence(
        reliability=95,
        source_type=SourceType.BLOG,
        quality=40,
        guard_state="failed",
        independent_sources=1,
        cfg=cfg,
    )
    assert label(failed.value, cfg) == "unconfirmed"
    with pytest.raises(ValueError):
        confidence(
            reliability=1,
            source_type=None,
            quality=1,
            guard_state="??",
            independent_sources=1,
            cfg=cfg,
        )


# ------------------------------------------------------------------ routing


@pytest.mark.parametrize(
    ("kw", "status", "reason"),
    [
        ({"guard_passed": False}, ArticleStatus.PENDING_REVIEW, "guard_failed"),
        ({"insufficient": True}, ArticleStatus.PENDING_REVIEW, "insufficient_information"),
        ({"sensitive_topics": ["war"]}, ArticleStatus.PENDING_REVIEW, "sensitive:war"),
        ({"confidence": 40}, ArticleStatus.PENDING_REVIEW, "low_confidence"),
        ({"mode": PublishMode.MANUAL}, ArticleStatus.HELD, "manual_mode"),
        ({"mode": PublishMode.SEMI}, ArticleStatus.PENDING_REVIEW, "semi_auto"),
        ({"importance": 30}, ArticleStatus.PENDING_REVIEW, "below_auto_threshold"),
        ({}, ArticleStatus.QUEUED, "auto"),
        (
            {"sensitive_topics": ["war"], "mode": PublishMode.MANUAL},
            ArticleStatus.PENDING_REVIEW,
            "sensitive:war",
        ),
    ],
)
def test_routing(kw: dict[str, Any], status: ArticleStatus, reason: str) -> None:
    args: dict[str, Any] = {
        "mode": PublishMode.AUTO,
        "sensitive_topics": [],
        "guard_passed": True,
        "insufficient": False,
        "confidence": 65,
        "importance": 70,
        "auto": AutoPublishConfig(),
    }
    args.update(kw)
    decided = route(**args)
    assert (decided.status, decided.reason) == (status, reason)


def test_auto_publish_can_never_be_configured_below_50() -> None:
    with pytest.raises(ValueError):
        AutoPublishConfig(min_confidence=40)
