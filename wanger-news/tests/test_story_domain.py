"""Phase 3 pure logic: same-event matching, independence of sources, claim statuses, confidence."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from wanger_news.config.models import ScoringConfig, StoryConfig
from wanger_news.domain.claims import (
    CONFIRMED,
    CONFLICTING,
    LIKELY,
    REJECTED,
    UNCONFIRMED,
    claim_confidence,
    claim_status,
)
from wanger_news.domain.enums import SourceType
from wanger_news.domain.independence import Report, origin_of, origins
from wanger_news.domain.scoring import confidence, independent_score, label
from wanger_news.domain.similarity import (
    add_to_centroid,
    cosine,
    extract_entities,
    match,
    normalize,
    overlap,
    time_proximity,
)

T0 = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)


def test_cosine_and_centroid() -> None:
    assert cosine([1, 0], [1, 0]) == pytest.approx(1.0)
    assert cosine([1, 0], [0, 1]) == pytest.approx(0.0)
    assert cosine([], [1]) == 0.0 and cosine([1, 2], [1]) == 0.0
    c = add_to_centroid(None, 0, [3, 4])
    assert c == pytest.approx([0.6, 0.8])
    c2 = add_to_centroid(c, 1, [0, 1])
    assert sum(x * x for x in c2) == pytest.approx(1.0)
    assert cosine(c2, [0.6, 0.8]) < 1 and cosine(c2, [0, 1]) < 1
    assert normalize([0, 0]) == [0.0, 0.0]


def test_entities_from_capitalised_phrases() -> None:
    names = extract_entities(
        "The Bank of England said on Tuesday that Governor Andrew Bailey "
        "will meet IMF officials in Washington."
    )
    assert "bank of england" in names
    assert "andrew bailey" in names or "governor andrew bailey" in names
    assert "washington" in names and "imf" in names
    assert "the" not in names and "tuesday" not in names
    assert extract_entities("هیچ نام لاتینی اینجا نیست") == []


def test_name_overlap_tolerates_partial_names() -> None:
    assert overlap(["andrew bailey", "bank of england"], ["bailey", "imf"]) > 0
    assert overlap([], ["x"]) == 0.0
    assert overlap(["paris"], ["paris"]) == 1.0


def test_time_proximity() -> None:
    cfg = StoryConfig()
    assert time_proximity(T0, T0 + timedelta(hours=3), cfg) == 1.0
    assert time_proximity(T0, T0 + timedelta(hours=100), cfg) == 0.0
    assert 0 < time_proximity(T0, T0 + timedelta(hours=30), cfg) < 1


def test_same_event_rule_is_conservative() -> None:
    cfg = StoryConfig()
    base = {"when": T0, "story_time": T0, "cfg": cfg}
    strong = match(vector=[1, 0], names=[], centroid=[1, 0.05], story_names=[], **base)
    assert strong.same_event  # very similar text alone is enough
    medium_vec = normalize([1, 0.55])  # cosine ≈ 0.876: needs shared names
    without_names = match(
        vector=[1, 0], names=["paris"], centroid=medium_vec, story_names=["london"], **base
    )
    with_names = match(
        vector=[1, 0], names=["paris", "louvre"], centroid=medium_vec, story_names=["paris"], **base
    )
    assert not without_names.same_event and with_names.same_event
    far = match(vector=[1, 0], names=[], centroid=[0, 1], story_names=[], **base)
    assert not far.same_event
    stale = match(
        vector=[1, 0],
        names=[],
        centroid=[1, 0],
        story_names=[],
        when=T0,
        story_time=T0 + timedelta(days=5),
        cfg=cfg,
    )
    assert not stale.same_event
    assert set(strong.as_dict()) == {"cosine", "entities", "time", "score", "same_event"}


# ------------------------------------------------------------------ independence


def report(
    aid: int,
    group: str,
    text: str,
    *,
    rel: int = 80,
    primary: bool = False,
    copy_of: int | None = None,
) -> Report:
    return Report(
        article_id=aid,
        source_id=f"s{aid}",
        source_name=f"Outlet {aid}",
        owner_group=group,
        reliability=rel,
        primary=primary,
        text=text,
        copy_of=copy_of,
    )


WIRE = "Officials said at least twenty people were killed when the bridge collapsed overnight"


def test_wire_copies_and_shared_owners_are_one_origin() -> None:
    groups = origins(
        [
            report(1, "ap", WIRE, rel=90, primary=True),
            report(2, "paper-a", WIRE + " according to AP"),  # syndicated copy
            report(3, "bbc", "The BBC's own reporter saw rescue teams at the collapsed bridge"),
            report(4, "bbc", "BBC Persian: rescue continues"),  # same owner as 3
            report(5, "x", "unrelated wording entirely", copy_of=3),  # recorded duplicate of 3
        ],
        syndication_min_jaccard=0.6,
    )
    assert len(groups) == 2
    assert groups[0].best.article_id == 1  # the primary agency speaks for its origin
    assert origin_of(2, groups) == origin_of(1, groups)
    assert origin_of(4, groups) == origin_of(3, groups) == origin_of(5, groups)
    assert origin_of(99, groups) is None


def test_different_wording_from_different_owners_is_independent() -> None:
    groups = origins(
        [
            report(1, "a", "Storm hits the coast with heavy rain"),
            report(2, "b", "Thousands without power after hurricane landfall"),
        ],
        0.6,
    )
    assert len(groups) == 2


# ------------------------------------------------------------------ claims and confidence


@pytest.mark.parametrize(
    ("kw", "expected"),
    [
        ({"independent_supports": 2}, CONFIRMED),
        ({"independent_supports": 1, "strongest_primary_reliability": 90}, LIKELY),
        ({"independent_supports": 1, "strongest_primary_reliability": 60}, UNCONFIRMED),
        ({"independent_supports": 1}, UNCONFIRMED),
        ({"independent_supports": 0}, UNCONFIRMED),
        ({"independent_supports": 3, "conflicting": True}, CONFLICTING),
        ({"independent_supports": 3, "rejected": True}, REJECTED),
    ],
)
def test_claim_status(kw: dict[str, object], expected: str) -> None:
    args: dict[str, object] = {
        "independent_supports": 0,
        "strongest_primary_reliability": None,
        "conflicting": False,
        "rejected": False,
        "likely_min_reliability": 80,
    }
    args.update(kw)
    assert claim_status(**args) == expected  # type: ignore[arg-type]


def test_claim_confidence_bands() -> None:
    assert claim_confidence(CONFIRMED, [90, 70]) > claim_confidence(LIKELY, [90])
    assert claim_confidence(REJECTED, [90]) == 0
    assert claim_confidence(UNCONFIRMED, []) == 45


def test_more_independent_sources_raise_confidence_up_to_confirmed() -> None:
    cfg = ScoringConfig()
    common = {
        "reliability": 85,
        "source_type": SourceType.NEWS_AGENCY,
        "quality": 95,
        "guard_state": "passed",
        "cfg": cfg,
    }
    one = confidence(independent_sources=1, **common)  # type: ignore[arg-type]
    two = confidence(independent_sources=2, **common)  # type: ignore[arg-type]
    three = confidence(independent_sources=3, **common)  # type: ignore[arg-type]
    assert one.value == 69 and "single_source" in one.breakdown["caps"]
    assert one.value < two.value <= three.value
    assert label(three.value, cfg) == "confirmed"
    assert independent_score(7, cfg) == 100 and independent_score(1, cfg) == 40


def test_contradictions_cap_confidence() -> None:
    cfg = ScoringConfig()
    conflicting = confidence(
        reliability=90,
        source_type=SourceType.NEWS_AGENCY,
        quality=100,
        guard_state="passed",
        independent_sources=3,
        contradictions=1,
        cfg=cfg,
    )
    assert conflicting.value <= 69 and "conflict" in conflicting.breakdown["caps"]
    assert conflicting.breakdown["components"]["consistency"] == 30


# ------------------------------------------------------------------ rendering and references


def test_contradiction_sentence_is_fixed_wording() -> None:
    from wanger_news.formatting.templates_fa import ContradictionLine, contradiction_sentence

    two = ContradictionLine(
        topic="شمار مصدومان",
        versions=[("رویترز", "از ۲۰ مصدوم خبر داده"), ("بی‌بی‌سی", "رقم ۲۵ نفر را گزارش کرده")],
    )
    assert contradiction_sentence(two) == (
        "گزارش‌ها دربارهٔ شمار مصدومان متفاوت است؛ رویترز از ۲۰ مصدوم خبر داده، در حالی که "
        "بی‌بی‌سی رقم ۲۵ نفر را گزارش کرده."
    )
    three = ContradictionLine(
        topic="محل",
        versions=[("الف", "می‌گوید شمال"), ("ب", "می‌گوید جنوب"), ("ج", "می‌گوید شرق")],
        earlier="الف",
    )
    text = contradiction_sentence(three)
    assert "الف می‌گوید شمال؛ ب می‌گوید جنوب؛ ج می‌گوید شرق." in text
    assert "گزارش الف زودتر بود" in text


def test_hand_post_reference() -> None:
    from wanger_news.db.tables import Article
    from wanger_news.services.stories import hand_post_ref

    post = Article(external_id="tg:-1002222222222:42", url="https://t.me/wanger_test/42")
    assert hand_post_ref(post) == (-1002222222222, "wanger_test", 42)
    assert hand_post_ref(Article(external_id="tg:-100:7", url=None)) == (-100, None, 7)
    assert hand_post_ref(Article(external_id="https://x.example/a", url=None)) is None
    assert hand_post_ref(Article(external_id="tg:x:7", url=None)) is None
