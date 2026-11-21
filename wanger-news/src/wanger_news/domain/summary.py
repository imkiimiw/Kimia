"""A Persian rendering of one article, as the AI (or an admin) produced it. Untrusted until the
hallucination guard has checked it against the source text."""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

_MARKDOWN = re.compile(r"(\*\*|__|`+|^#+\s*)", re.MULTILINE)


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class Entity(_Model):
    fa: str = Field(description="the name as written in the Persian text")
    original: str = Field(description="the name exactly as written in the source text")
    type: Literal["person", "organization", "place", "other"] = "other"


class Quote(_Model):
    fa: str = Field(description="the quotation as it appears inside «» in the Persian text")
    original: str = Field(description="the same quotation copied verbatim from the source text")
    speaker: str = Field(default="", description="who said it, as named in the source")


class Support(_Model):
    source_id: str = Field(description="the id of the source that states it, e.g. s12")
    evidence: str = Field(description="a verbatim excerpt of THAT source supporting the claim")


class Claim(_Model):
    text: str = Field(description="one factual statement of the Persian text")
    evidence: str = Field(default="", description="(single source) a verbatim excerpt")
    support: list[Support] = Field(default=[], description="every source that states it")


class Version(_Model):
    source_id: str
    statement: str = Field(description="what this source says, in Persian, without its name")
    evidence: str = Field(description="a verbatim excerpt of this source")


class Contradiction(_Model):
    topic: str = Field(
        description="what the sources disagree about, in Persian (e.g. شمار قربانیان)"
    )
    versions: list[Version] = Field(min_length=2)


class ImportanceFactors(_Model):
    """0–10 each (spec §8). Judgements, not facts: they only order the queue."""

    people_affected: int = Field(default=0, ge=0, le=10)
    significance: int = Field(default=0, ge=0, le=10)
    severity: int = Field(default=0, ge=0, le=10)
    geographic_scope: int = Field(default=0, ge=0, le=10)
    continuation: int = Field(default=0, ge=0, le=10)
    international_impact: int = Field(default=0, ge=0, le=10)


class SummaryDraft(_Model):
    title: str
    summary: str = Field(description="1-3 (or 3-6) short paragraphs separated by a blank line")
    key_points: list[str] = []
    category: str | None = None
    importance: ImportanceFactors | None = None
    entities: list[Entity] = []
    quotes: list[Quote] = []
    claims: list[Claim] = []
    contradictions: list[Contradiction] = []
    excluded_sources: list[str] = Field(default=[], description="sources about another event")
    insufficient_information: bool = False

    def texts(self) -> list[str]:
        """Every piece of Persian text that will reach readers."""
        return [self.title, self.summary, *self.key_points]

    def cleaned(self) -> SummaryDraft:
        """Strip markdown the model may add (we render HTML ourselves)."""

        def clean(text: str) -> str:
            return _MARKDOWN.sub("", text).strip()

        return self.model_copy(
            update={
                "title": clean(self.title).rstrip(".۔"),
                "summary": clean(self.summary),
                "key_points": [
                    clean(k).lstrip("•-–* ").strip() for k in self.key_points if clean(k)
                ],
            }
        )
