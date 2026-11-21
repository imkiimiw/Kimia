"""Phase 4 pure logic: breaking, trends, related stories, links, times, brief and alert text."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from wanger_news.config.models import BreakingConfig, RelatedConfig, TrendsConfig
from wanger_news.domain.breaking import decide
from wanger_news.domain.chatref import post_url
from wanger_news.domain.jalali import format_date_fa, format_time_fa
from wanger_news.domain.related import Candidate, find_related
from wanger_news.domain.trends import Observation, detect
from wanger_news.formatting.templates_fa import (
    BriefItem,
    DailyBrief,
    PostLink,
    SummaryPost,
    TrendAlert,
    render_brief,
    render_summary,
    render_trend_alert,
)

from .conftest import make_config

T0 = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)


# ------------------------------------------------------------------ breaking


def test_breaking_needs_importance_freshness_and_confidence() -> None:
    cfg = BreakingConfig()
    common = {"importance": 60, "confidence": 69, "age_minutes": 30, "update": False, "cfg": cfg}
    assert decide(priority=100, **common).breaking
    assert decide(priority=100, **common).reason == "priority:100"
    assert not decide(priority=80, **common).breaking
    assert decide(priority=80, **{**common, "importance": 90}).reason == "importance:90"
    assert decide(priority=100, **{**common, "age_minutes": 240}).reason == "stale:240m"
    assert decide(priority=100, **{**common, "confidence": 49}).reason == "low_confidence:49"
    assert decide(priority=100, **{**common, "update": True}).reason == "update"
    off = BreakingConfig(enabled=False)
    assert decide(priority=100, **{**common, "cfg": off}).reason == "disabled"


# ------------------------------------------------------------------ trends


def obs(key: str, minutes_ago: float, source: str, cluster: int | None = None) -> Observation:
    kind = "story" if key.startswith("story:") else "entity"
    return Observation(
        kind,
        key,
        key.split(":", 1)[1],
        T0 - timedelta(minutes=minutes_ago),
        source,
        source.upper(),
        cluster,
    )


def test_a_new_topic_with_many_outlets_trends() -> None:
    items = [
        obs("story:1", m, s, 1) for m, s in [(5, "a"), (10, "b"), (20, "c"), (30, "d"), (40, "e")]
    ]
    [trend] = detect(items, now=T0, cfg=TrendsConfig())
    assert (trend.reports, trend.sources, trend.baseline, trend.ratio) == (5, 5, 0.0, 5.0)
    assert trend.cluster_id == 1 and trend.source_names == ["A", "B", "C", "D", "E"]


def test_a_topic_that_is_always_busy_does_not_trend() -> None:
    usual = [obs("entity:iran", 60 * h + 10, s) for h in range(1, 23) for s in "abc"]
    now = [obs("entity:iran", m, s) for m, s in [(5, "a"), (6, "b"), (7, "c"), (8, "d"), (9, "e")]]
    assert detect(usual + now, now=T0, cfg=TrendsConfig()) == []  # 5 vs usually 3: ratio 1.7


def test_one_outlet_cannot_make_a_trend() -> None:
    spam = [obs("entity:x", m, "a") for m in range(1, 30)]
    assert detect(spam, now=T0, cfg=TrendsConfig()) == []
    few = [*spam, obs("entity:x", 3, "b"), obs("entity:x", 4, "c")]  # a+a (capped) + b + c
    assert detect(few, now=T0, cfg=TrendsConfig()) == []
    enough = [*few, obs("entity:x", 5, "d")]
    assert detect(enough, now=T0, cfg=TrendsConfig())[0].reports == 5


def test_a_name_trending_only_inside_a_trending_story_is_not_alerted_twice() -> None:
    items = []
    for m, s in [(5, "a"), (10, "b"), (20, "c"), (30, "d"), (40, "e")]:
        items += [obs("story:7", m, s, 7), obs("entity:genoa", m, s, 7)]
    trends = detect(items, now=T0, cfg=TrendsConfig())
    assert [t.key for t in trends] == ["story:7"]
    loose = TrendsConfig(kinds=["entity"])
    assert [t.key for t in detect(items, now=T0, cfg=loose)] == ["entity:genoa"]


# ------------------------------------------------------------------ related, links, time


def test_related_by_meaning_or_shared_names() -> None:
    cfg = RelatedConfig()
    cands = [
        Candidate(1, [0.8, 0.6], []),  # cosine 0.8
        Candidate(2, [0.0, 1.0], ["genoa", "autostrade"]),  # 2 shared names
        Candidate(3, [0.0, 1.0], ["genoa"]),  # 1 shared name: not enough
        Candidate(4, None, []),
    ]
    found = find_related([1.0, 0.0], ["genoa", "autostrade", "italy"], cands, cfg)
    assert [r.story_id for r in found] == [1, 2]
    assert found[1].shared == ["autostrade", "genoa"]
    assert find_related([1.0, 0.0], [], cands, RelatedConfig(max_links=1))[0].story_id == 1


def test_post_links_and_persian_times() -> None:
    assert post_url("@wanger_test", 12) == "https://t.me/wanger_test/12"
    assert post_url("-1002222222222", 7) == "https://t.me/c/2222222222/7"
    assert post_url("12345", 7) is None and post_url(None, 7) is None
    assert format_time_fa(T0, T0) == "۱۵:۳۰"  # Tehran = UTC+3:30
    assert format_time_fa(T0 - timedelta(days=1), T0) == "۰۸/۲۶ ۱۵:۳۰"
    assert format_date_fa(T0) == "۱۴۰۵/۰۸/۲۷"


# ------------------------------------------------------------------ text


def test_trend_alert_and_brief_wording() -> None:
    alert = render_trend_alert(TrendAlert("پل جنوا (Genoa)", 8, 5, 60, 0.0, ["A", "B"]))
    assert alert.startswith(
        "⚠️ <b>موضوع در حال رشد:</b> تعداد گزارش‌ها دربارهٔ «پل جنوا (Genoa)» در ۶۰ دقیقهٔ "
        "اخیر به شکل غیرعادی افزایش یافته است."
    )
    assert "پیش از این، گزارشی دربارهٔ آن ثبت نشده بود." in alert
    assert "معمولاً حدود ۱٫۵ گزارش در هر ۶۰ دقیقه" in render_trend_alert(
        TrendAlert("x", 8, 5, 60, 1.5, [])
    )
    brief = render_brief(
        DailyBrief(
            "۱۴۰۵/۰۸/۲۷",
            [
                BriefItem(
                    "خبر <اول>", "https://t.me/wanger_test/1", "likely", breaking=True, updates=2
                ),
                BriefItem("خبر دوم", None, "preliminary"),
            ],
            trends=[("Genoa", 9)],
        )
    )
    assert brief.startswith("🗞 <b>خلاصهٔ خبرهای امروز</b> — ۱۴۰۵/۰۸/۲۷")
    assert '۱. 🔴 <a href="https://t.me/wanger_test/1">خبر &lt;اول&gt;</a>' in brief
    assert "📌 احتمال بالا · ۲ به‌روزرسانی" in brief and "۲. خبر دوم" in brief
    assert "📈 موضوع‌های پرگزارش امروز: Genoa (۹ گزارش)" in brief and brief.endswith("#خلاصه_روز")


def test_summary_post_with_timeline_and_related() -> None:
    cfg = make_config().pipeline.publish
    post = SummaryPost(
        title="به‌روزرسانی",
        summary="متن",
        key_points=[],
        status="likely",
        source_names=["A"],
        source_url="https://a.example/x",
        hashtags=[],
        update=True,
        timeline=[PostLink("خبر اول", "https://t.me/wanger_test/5", "۱۴:۰۰")],
        related=[PostLink("خبر مرتبط", "https://t.me/wanger_test/3")],
    )
    text = render_summary(post, cfg).text
    assert '🧵 <b>روند خبر:</b>\n• ۱۴:۰۰ — <a href="https://t.me/wanger_test/5">خبر اول</a>' in text
    assert '🔗 <b>مرتبط:</b>\n• <a href="https://t.me/wanger_test/3">خبر مرتبط</a>' in text
