"""Rule-based classification and the gate, on the real config/categories.yaml and filters.yaml."""

from __future__ import annotations

import pytest

from wanger_news.config.models import FilterLists, FiltersFile, GateConfig
from wanger_news.domain.classify import RuleClassifier
from wanger_news.domain.enums import ArticleStatus
from wanger_news.domain.gate import Gate, GateInput

from .conftest import make_config


@pytest.fixture(scope="module")
def classifier() -> RuleClassifier:
    cfg = make_config()
    return RuleClassifier(cfg.categories, cfg.pipeline.classification)


def test_category_from_keywords(classifier: RuleClassifier) -> None:
    cls = classifier.classify(
        "New smartphone chip cuts energy use",
        "The semiconductor design is aimed at phones.",
        "world",
    )
    assert cls.category == "technology"
    assert cls.hashtags[0] == "فناوری"
    assert "category:technology" in cls.matched


def test_falls_back_to_source_category(classifier: RuleClassifier) -> None:
    assert (
        classifier.classify("Quiet day", "Nothing in particular.", "science").category == "science"
    )


def test_persian_keywords_with_zwnj_and_arabic_letters(classifier: RuleClassifier) -> None:
    cls = classifier.classify(
        "آزمایش هسته‌ای جدید", "گزارش‌ها از يک آزمايش هسته‌اي خبر می‌دهند", "world"
    )
    assert cls.priority == 100
    assert cls.priority_label == "international_crisis"


def test_priority_tiers(classifier: RuleClassifier) -> None:
    assert classifier.classify("Strong earthquake hits the coast", "", "world").priority == 100
    assert classifier.classify("Central bank holds interest rates", "", "economy").priority == 80
    assert classifier.classify("Your weekly horoscope", "", "culture").priority == 20
    assert classifier.classify("Museum opens a new wing", "", "culture").priority == 40  # base


def test_wildcard_keywords(classifier: RuleClassifier) -> None:
    cls = classifier.classify("Voters head to the polls in elections", "", "politics")
    assert "election" in cls.sensitive_topics


@pytest.mark.parametrize(
    ("title", "topic"),
    [
        ("Troops advance as ceasefire collapses", "war"),
        ("Military coup in the capital", "coup"),
        ("Famous actor dies at 80", "celebrity_death"),
        ("Hostages freed after siege", "security_crisis"),
        ("Doctors claim a miracle cure", "medical_claim"),
        ("Putin meets Xi Jinping", "head_of_state"),
        ("رئیس‌جمهور به نیویورک رفت", "head_of_state"),
    ],
)
def test_sensitive_topics(classifier: RuleClassifier, title: str, topic: str) -> None:
    assert topic in classifier.classify(title, "", "world").sensitive_topics


def test_at_most_three_hashtags(classifier: RuleClassifier) -> None:
    cls = classifier.classify(
        "AI chip startup shares soar as central bank cuts rates amid inflation",
        "artificial intelligence machine learning chips semiconductor startup investors economy "
        "inflation gdp companies ceo merger",
        "world",
    )
    assert 1 <= len(cls.hashtags) <= 3
    assert len(set(cls.hashtags)) == len(cls.hashtags)


# ------------------------------------------------------------------ gate


def _gate(**lists: FilterLists) -> Gate:
    return Gate(FiltersFile(**lists), GateConfig(min_priority=50))


def _input(
    title: str = "A normal headline about the economy",
    *,
    human: bool = False,
    source: str = "alpha",
    country: str | None = "GB",
) -> GateInput:
    return GateInput(source_id=source, country=country, title=title, body="", human_curated=human)


def test_gate_paths(classifier: RuleClassifier) -> None:
    gate = _gate()
    normal = classifier.classify("Central bank holds interest rates", "", "economy")
    assert gate.decide(_input(), normal).status is ArticleStatus.QUEUED
    low = classifier.classify("Your weekly horoscope", "", "culture")
    assert gate.decide(_input(), low).status is ArticleStatus.FILTERED
    war = classifier.classify("Troops advance as ceasefire collapses", "", "world")
    decision = gate.decide(_input(), war)
    assert decision.status is ArticleStatus.PENDING_REVIEW
    assert "war" in decision.reason


def test_human_curated_posts_skip_the_gate(classifier: RuleClassifier) -> None:
    war = classifier.classify("Troops advance as ceasefire collapses", "", "world")
    gate = _gate(blacklist=FilterLists(keywords=["troops"]))
    assert gate.decide(_input(human=True), war).status is ArticleStatus.QUEUED


def test_blacklist_and_whitelist(classifier: RuleClassifier) -> None:
    cls = classifier.classify("Central bank holds interest rates", "", "economy")
    assert (
        _gate(blacklist=FilterLists(sources=["alpha"])).decide(_input(), cls).reason
        == "blacklist:source=alpha"
    )
    assert (
        _gate(blacklist=FilterLists(countries=["GB"])).decide(_input(), cls).status
        is ArticleStatus.FILTERED
    )
    headline = _input("Central bank holds interest rates")
    assert (
        _gate(blacklist=FilterLists(keywords=["central bank"])).decide(headline, cls).status
        is ArticleStatus.FILTERED
    )
    only_us = _gate(whitelist=FilterLists(countries=["US"]))
    assert only_us.decide(_input(), cls).reason == "not_whitelisted:country"
    assert only_us.decide(_input(country="US"), cls).status is ArticleStatus.QUEUED


def test_real_filters_drop_sponsored_content(classifier: RuleClassifier) -> None:
    cfg = make_config()
    gate = Gate(cfg.filters, cfg.pipeline.gate)
    cls = classifier.classify("Sponsored: the best bank accounts", "", "economy")
    assert (
        gate.decide(_input("Sponsored: the best bank accounts"), cls).status
        is ArticleStatus.FILTERED
    )
