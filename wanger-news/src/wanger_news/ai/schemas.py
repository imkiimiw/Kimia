"""What each AI operation must answer (validated with Pydantic; anything else is a failure).

``json_schema`` turns a model into the self-contained JSON Schema sent with the request and
written into the prompt (references inlined, titles and defaults dropped).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from wanger_news.domain.summary import Entity, ImportanceFactors, SummaryDraft


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class SummarizedArticle(SummaryDraft):
    id: str


class SummarizeOutput(_Model):
    articles: list[SummarizedArticle]


class CorrectionProposal(_Model):
    """Phase 5: a published fact that a new report shows to be wrong (not merely updated)."""

    item: str = Field(description="what was wrong, in Persian (e.g. «شمار کشته‌ها»)")
    old: str = Field(description="what the published Persian text said, as it said it")
    new: str = Field(description="the correct value, in Persian, as the new report states it")
    source_id: str = Field(description="the NEW report that states the correct value")
    evidence: str = Field(description="word-for-word excerpt of that report with the value")


class UpdatedArticle(SummarizedArticle):
    """An update to a published story: only what is NEW (Phase 3); corrections (Phase 5)."""

    same_event: bool = True
    has_new_information: bool = True
    corrections: list[CorrectionProposal] = Field(default_factory=list)


class UpdateOutput(_Model):
    articles: list[UpdatedArticle]


class ClaimVerdict(_Model):
    index: int = Field(ge=0)
    supported: bool
    reason: str = ""


class VerifiedArticle(_Model):
    id: str
    claims: list[ClaimVerdict] = []
    unsupported_statements: list[str] = []


class VerifyOutput(_Model):
    articles: list[VerifiedArticle]


class TranslateOutput(_Model):
    text: str


class ClassifiedArticle(_Model):
    id: str
    category: str
    importance: ImportanceFactors


class ClassifyOutput(_Model):
    articles: list[ClassifiedArticle]


class ExtractedClaim(_Model):
    claim: str
    source: str = ""
    evidence: str


class ClaimsOutput(_Model):
    claims: list[ExtractedClaim]


class EntitiesOutput(_Model):
    class Item(_Model):
        name: str
        type: Literal["person", "organization", "place", "other"] = "other"

    entities: list[Item]


__all__ = [
    "ClaimsOutput",
    "ClassifyOutput",
    "EntitiesOutput",
    "Entity",
    "SummarizeOutput",
    "TranslateOutput",
    "UpdateOutput",
    "VerifyOutput",
    "json_schema",
]

_DROP = {"title", "default"}


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    raw = model.model_json_schema()
    defs = raw.pop("$defs", {})

    def inline(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                return inline(defs[node["$ref"].rsplit("/", 1)[-1]])
            if "anyOf" in node:  # Optional[X] → X (absence is allowed by "required")
                options = [o for o in node["anyOf"] if o.get("type") != "null"]
                if len(options) == 1:
                    merged = {**{k: v for k, v in node.items() if k != "anyOf"}, **options[0]}
                    return inline(merged)
            out = {}
            for key, value in node.items():
                if key == "properties" and isinstance(value, dict):
                    out[key] = {name: inline(sub) for name, sub in value.items()}  # field names
                elif key not in _DROP:
                    out[key] = inline(value)
            return out
        if isinstance(node, list):
            return [inline(v) for v in node]
        return node

    result = inline(raw)
    assert isinstance(result, dict)
    return result
