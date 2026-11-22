"""Phase 5: the editorial rules engine (spec §11) — YAML rules, strict direction only."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from wanger_news.config.loader import load_config
from wanger_news.config.models import Rule, RulesFile
from wanger_news.domain.editorial import Route, apply_rules
from wanger_news.domain.enums import ArticleStatus, PublishMode
from wanger_news.domain.rules import Facts, Outcome, evaluate

from .conftest import Harness, make_config

ROOT = Path(__file__).resolve().parents[1]


def rule(**data: object) -> Rule:
    return Rule.model_validate(data)


def test_conditions_are_all_of_and_lists_are_any_of() -> None:
    r = rule(
        id="r1",
        **{"if": {"category": ["world", "politics"], "confidence_lt": 80}},
        then="require_human_review",
    )
    assert evaluate([r], Facts(category="world", confidence=70)).review == ["r1"]
    assert evaluate([r], Facts(category="sports", confidence=70)).hits == []
    assert evaluate([r], Facts(category="world", confidence=85)).hits == []
    assert evaluate([r], Facts(category="world")).hits == []  # unknown confidence: no match


def test_every_condition_kind() -> None:
    facts = Facts(
        category="health",
        source="who",
        source_type="official_organization",
        language="en",
        sensitive_topics=("medical_claim",),
        breaking=True,
        contradiction=False,
        kind="update",
        confidence=60,
        importance=95,
        priority=80,
        independent_sources=1,
        text="New VACCINE trial results",
    )
    cond = {
        "source": "who",
        "source_type": "official_organization",
        "language": ["en", "fr"],
        "sensitive": True,
        "sensitive_topic": "medical_claim",
        "breaking": True,
        "contradiction": False,
        "kind": "update",
        "confidence_gte": 50,
        "importance_gt": 90,
        "priority_gte": 80,
        "independent_sources_lt": 2,
        "keyword_any": ["vaccine"],
    }
    assert evaluate([rule(id="all", **{"if": cond}, then="hold")], facts).hold == ["all"]


def test_actions_priority_mode_and_disabled_rules() -> None:
    rules = [
        rule(id="ra", **{"if": {"importance_gt": 90}}, then={"priority": "high"}),
        rule(id="rb", **{"if": {"category": "sports"}}, then={"mode": "manual", "priority": 30}),
        rule(id="rc", enabled=False, **{"if": {"category": "sports"}}, then="skip"),
    ]
    out = evaluate(rules, Facts(category="sports", importance=95))
    assert out.hits == ["ra", "rb"] and out.priority == 30 and out.mode is PublishMode.MANUAL
    assert out.skip == []


def test_rules_are_validated() -> None:
    with pytest.raises(ValidationError):
        rule(id="x", **{"if": {}}, then="hold")  # no condition
    with pytest.raises(ValidationError):
        rule(id="x", **{"if": {"category": "world"}}, then="merge")  # merge is for clustering
    with pytest.raises(ValidationError):
        rule(id="x", **{"if": {"duplicate_similarity_gt": 0.9}}, then="hold")
    with pytest.raises(ValidationError):
        rule(id="x", **{"if": {"category": "world"}}, then="publish_now")
    with pytest.raises(ValidationError):
        RulesFile.model_validate(
            {
                "rules": [
                    {"id": "dup", "if": {"category": "world"}, "then": "hold"},
                    {"id": "dup", "if": {"category": "world"}, "then": "skip"},
                ]
            }
        )
    with pytest.raises(ValidationError, match="unknown category"):
        make_config(rules=[{"id": "bad", "if": {"category": "nonsense"}, "then": "hold"}])


def test_the_repository_rules_load() -> None:
    config = load_config(ROOT / "config", env={})
    assert {r.id for r in config.rules.rules} >= {
        "war-needs-high-confidence",
        "merge-near-identical",
    }


def test_rules_only_ever_make_things_stricter() -> None:
    queued = Route(ArticleStatus.QUEUED, "auto")
    semi = Route(ArticleStatus.PENDING_REVIEW, "semi_auto")
    sensitive = Route(ArticleStatus.PENDING_REVIEW, "sensitive:war")
    assert apply_rules(queued, Outcome(review=["r"])) == Route(
        ArticleStatus.PENDING_REVIEW, "rule:r"
    )
    assert apply_rules(queued, Outcome(hold=["h"])).status is ArticleStatus.HELD
    assert apply_rules(semi, Outcome(hold=["h"])).status is ArticleStatus.HELD
    assert apply_rules(sensitive, Outcome(hold=["h"])) == sensitive  # a human still looks first
    assert apply_rules(sensitive, Outcome(skip=["s"])).status is ArticleStatus.FILTERED
    assert apply_rules(semi, Outcome(review=["r"])) == semi
    assert apply_rules(queued, Outcome()) == queued


# ------------------------------------------------------------------ in the pipeline


async def test_a_rule_sends_an_auto_item_to_review(harness: Harness) -> None:
    harness.config = make_config(
        rules=[
            {
                "id": "economy-by-hand",
                "description": "اقتصاد با تأیید",
                "if": {"category": "economy"},
                "then": "require_human_review",
            }
        ]
    )
    await harness.run()
    economy = next(a for a in await harness.articles() if a.category == "economy")
    assert economy.status == ArticleStatus.PENDING_REVIEW
    assert economy.review_reason == "rule:economy-by-hand"
    assert (economy.classification or {}).get("rules") == ["economy-by-hand"]
    card = next(t for t in harness.telegram.owner_messages() if "economy-by-hand" in t)
    assert "قانون ویرایشی «economy-by-hand»" in card


async def test_skip_and_priority_rules(harness: Harness) -> None:
    harness.config = make_config(
        rules=[
            {"id": "no-science", "if": {"category": "science"}, "then": "skip"},
            {"id": "economy-first", "if": {"category": "economy"}, "then": {"priority": 99}},
        ]
    )
    await harness.run()
    arts = await harness.articles()
    science = [a for a in arts if a.category == "science" and a.summary_id is not None]
    assert science and all(a.status == ArticleStatus.FILTERED for a in science)
    economy = next(a for a in arts if a.category == "economy")
    assert economy.priority == 99


async def test_a_merge_rule_joins_reports_the_normal_match_keeps_apart(harness: Harness) -> None:
    from wanger_news.db.tables import StoryCluster

    from .test_realtime import feed, setup, stories, unit

    vectors = {"railway": unit(0), "running": unit(0, 1, cos=0.95)}
    for with_rule, expected in ((False, 2), (True, 1)):
        rules = (
            [{"id": "merge-close", "if": {"duplicate_similarity_gt": 0.92}, "then": "merge"}]
            if with_rule
            else []
        )
        setup(harness, "ab", vectors=vectors, story={"strong_cosine": 0.99}, rules=rules)
        feed(harness, "a", "New railway opens", "A new railway opened on Wednesday in the north.")
        feed(harness, "b", "Trains start running", "Trains started running on the line today.")
        await harness.run()
        found = await stories(harness)
        assert len(found) == expected
        if with_rule:
            joined = next(a for a in await harness.articles() if a.cluster_role == "support")
            assert (joined.cluster_score or {}).get("rule") == "merge-close"
        async with harness.engine.begin() as conn:  # a clean database for the second pass
            from wanger_news.db.base import Base

            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        harness.telegram.calls.clear()
        _ = StoryCluster
