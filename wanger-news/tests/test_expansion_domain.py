"""Phase 6, pure parts: search terms and ranking, the weekly report, edition selection, the
English guard, the mother bot's signatures, the mobile API's cursor and rate limit."""

from __future__ import annotations

import pytest

from wanger_news.adapters.mother import MotherBotError, check_url, sign, verify_signature
from wanger_news.config.models import EditionConfig, GuardConfig
from wanger_news.db.repositories import like_pattern
from wanger_news.domain.editions import EditionItem, check_english, selects
from wanger_news.domain.search import QueryError, query_terms, rank, snippet
from wanger_news.domain.weekly import StoryFact, WeeklyFacts, build, top_trends

# ------------------------------------------------------------------ search


def test_query_terms_normalize_and_drop_common_words() -> None:
    # Arabic ي/ك become Persian, ZWNJ splits, common words go, digits get both spellings
    assert query_terms("بانك مركزي و نرخ ۱۲") == [
        ["بانک"],
        ["مرکزی"],
        ["نرخ"],
        ["12", "۱۲"],
    ]
    assert query_terms("The Bank of England") == [["bank"], ["england"]]
    assert query_terms("نفت نفت NAFT naft") == [["نفت"], ["naft"]]


@pytest.mark.parametrize(
    ("query", "error"),
    [("a", "too_short"), ("و در به", "only_common_words"), ("x" * 300, "too_long")],
)
def test_unsearchable_queries(query: str, error: str) -> None:
    with pytest.raises(QueryError, match=error):
        query_terms(query, max_chars=200)


def test_terms_are_capped() -> None:
    assert len(query_terms("one two three four five six seven", max_terms=3)) == 3


def test_like_patterns_match_literally() -> None:
    assert like_pattern("50%_off") == "%50\\%\\_off%"


def test_semantic_ranking_keeps_close_stories_only() -> None:
    query = [1.0, 0.0, 0.0]
    candidates = [(1, [1.0, 0.0, 0.0]), (2, [0.8, 0.6, 0.0]), (3, [0.0, 1.0, 0.0]), (4, [1.0])]
    ranked = rank(query, candidates, min_similarity=0.7, limit=5)
    assert [(r.id, r.score) for r in ranked] == [(1, 1.0), (2, 0.8)]
    assert rank(query, candidates, min_similarity=0.7, limit=1)[0].id == 1


def test_snippet_shows_the_matching_part() -> None:
    text = "آغاز " + "کلمه " * 60 + "هدف اینجاست " + "پایان " * 60
    piece = snippet(text, [["هدف"]], width=60)
    assert "هدف" in piece and piece.startswith("…") and piece.endswith("…")
    assert snippet("کوتاه", [["نیست"]]) == "کوتاه"


# ------------------------------------------------------------------ weekly report


def fact(sid: int, importance: int, sources: int = 1, updates: int = 0, **kw: object) -> StoryFact:
    return StoryFact(
        story_id=sid,
        title=f"story {sid}",
        url=f"https://t.me/c/{sid}",
        category=str(kw.get("category", "world")),
        importance=importance,
        independent_sources=sources,
        source_names=tuple(kw.get("names", ("A",))),  # type: ignore[arg-type]
        status="likely",
        contradictions=int(kw.get("contradictions", 0)),  # type: ignore[call-overload]
        updates=updates,
        new=bool(kw.get("new", True)),
    )


def test_the_weekly_report_counts_and_ranks_what_was_published() -> None:
    facts = WeeklyFacts(
        stories=[
            fact(1, 90, sources=3, names=("A", "B", "C")),
            fact(2, 60, updates=4, category="economy"),
            fact(3, 75, sources=2, contradictions=1, names=("A", "B")),
            fact(4, 40, updates=2, new=False),  # an older story that developed this week
        ],
        update_posts=6,
        source_posts=2,
        breaking_posts=1,
        corrections=1,
        trends=[("Gaza", 12), ("Gaza", 30), ("oil", 9)],
        previous_stories=2,
    )
    report = build(
        facts, top=2, developing=2, trends=5, sources=2, category_names={"world": "جهان"}
    )
    assert report.stories == 3  # only stories first published this week
    assert [s.story_id for s in report.top] == [1, 3]
    assert [s.story_id for s in report.developing] == [2, 4]  # top stories are not repeated
    assert report.multi_source == 2 and report.contradictions == 1
    assert report.categories == [("جهان", 2), ("economy", 1)]
    assert report.trends == [("Gaza", 30), ("oil", 9)]
    assert report.sources == [("A", 3), ("B", 2)]
    assert report.change_percent == 50


def test_trends_keep_the_largest_count_per_topic() -> None:
    assert top_trends([("a", 1), ("b", 5), ("a", 7)], 1) == [("a", 7)]


# ------------------------------------------------------------------ editions


def item(**kw: object) -> EditionItem:
    base: dict[str, object] = {
        "category": "world",
        "importance": 70,
        "breaking": False,
        "update": False,
        "source_post": False,
        "conflicting": False,
    }
    base.update(kw)
    return EditionItem(**base)  # type: ignore[arg-type]


def test_an_edition_only_narrows_the_selection() -> None:
    every = EditionConfig(id="all", chat="@all_news")
    assert selects(every, item()) is None
    assert selects(every, item(source_post=True)) == "source_posts_off"
    picky = EditionConfig(
        id="biz",
        chat="@biz_news",
        categories=["economy"],
        min_importance=60,
        breaking_only=True,
        include_updates=False,
    )
    assert selects(picky, item()) == "category"
    assert selects(picky, item(category="economy")) == "not_breaking"
    assert selects(picky, item(category="economy", breaking=True, importance=50)) == "importance"
    assert selects(picky, item(category="economy", breaking=True)) is None
    assert selects(picky, item(category="economy", breaking=True, update=True)) == "updates_off"
    english = EditionConfig(id="en", chat="@en_news", language="en", include_source_posts=True)
    assert selects(english, item(conflicting=True)) == "conflicting"
    assert selects(english, item(source_post=True)) == "source_post_not_translated"


def test_edition_chat_and_id_are_validated() -> None:
    with pytest.raises(ValueError, match="chat"):
        EditionConfig(id="x1", chat="not a channel!")
    with pytest.raises(ValueError, match="id"):
        EditionConfig(id="Bad Id", chat="@ok_channel")


VERIFIED = "زلزله‌ای به بزرگی ۶ ریشتر شیلی را لرزاند و ۱۲ نفر زخمی شدند."
SOURCES = (
    "A magnitude 6 earthquake struck Chile on Wednesday; 12 people were injured, Reuters said."
)


def english(title: str, summary: str, points: list[str] | None = None) -> list[str]:
    report = check_english(
        title,
        summary,
        points or [],
        verified=VERIFIED,
        sources=SOURCES,
        names=["Santiago"],
        cfg=GuardConfig(),
    )
    return [f"{i.kind}:{i.detail}" for i in report.issues]


def test_a_faithful_english_edition_passes() -> None:
    assert (
        english(
            "Earthquake shakes Chile",
            "A magnitude 6 earthquake struck Chile and 12 people were injured, Reuters said.",
            ["Damage was reported in Santiago"],
        )
        == []
    )


def test_the_english_guard_catches_what_the_persian_did_not_say() -> None:
    assert "number_not_in_source:40" in english("Quake in Chile", "About 40 people died.")
    assert "name_not_in_source:Valparaiso" in english(
        "Quake in Chile", "The quake hit near Valparaiso, officials said."
    )
    assert any(i.startswith("not_english") for i in english("زلزله", "متن فارسی"))
    assert any(
        i.startswith("forbidden_markup")
        for i in english("Quake", "More at https://evil.example now.")
    )
    assert "empty:summary" in english("Quake", "")


# ------------------------------------------------------------------ mother bot


def test_mother_bot_signatures() -> None:
    body = b'{"kind":"run"}'
    signature = sign("s3cret", "1700000000", body)
    assert signature.startswith("sha256=")
    assert verify_signature("s3cret", "1700000000", body, signature, now=1700000100)
    assert not verify_signature("s3cret", "1700000000", body, signature, now=1700001000)  # old
    assert not verify_signature("s3cret", "1700000000", body + b" ", signature, now=1700000000)
    assert not verify_signature("other", "1700000000", body, signature, now=1700000000)


def test_mother_bot_urls_must_be_https() -> None:
    assert check_url("https://mother.example/hook") == "https://mother.example/hook"
    assert check_url("http://127.0.0.1:8000/hook").startswith("http://127.0.0.1")
    for bad in ("http://mother.example/hook", "ftp://x", "mother.example"):
        with pytest.raises(MotherBotError):
            check_url(bad)


# ------------------------------------------------------------------ mobile API helpers


def test_cursor_round_trip_and_rate_limit() -> None:
    pytest.importorskip("fastapi")
    from datetime import UTC, datetime

    from fastapi import HTTPException

    from wanger_news.api.mobile import RateLimiter, decode_cursor, encode_cursor

    at = datetime(2026, 11, 18, 12, 30, tzinfo=UTC)
    assert decode_cursor(encode_cursor(at, 42)) == (at, 42)
    with pytest.raises(HTTPException):
        decode_cursor("not-a-cursor!!")
    now = [0.0]
    limiter = RateLimiter(2, clock=lambda: now[0])
    assert limiter.allow("a") and limiter.allow("a") and not limiter.allow("a")
    assert limiter.allow("b")
    now[0] = 61.0
    assert limiter.allow("a")
