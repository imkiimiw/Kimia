"""A deterministic AIProvider for tests: faithful Persian drafts unless told otherwise."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from wanger_news.ai.provider import AIResult, AIUsage
from wanger_news.ai.schemas import (
    ClaimsOutput,
    ClassifyOutput,
    EntitiesOutput,
    SummarizeOutput,
    TranslateOutput,
    VerifyOutput,
)

GENERIC = {
    "title": "عنوان فارسی آزمایشی",
    "summary": "متن خلاصهٔ آزمایشی بر اساس همین منبع است.",
    "key_points": ["نکتهٔ کلیدی آزمایشی"],
    "importance": {
        "people_affected": 5,
        "significance": 6,
        "severity": 4,
        "geographic_scope": 5,
        "continuation": 3,
        "international_impact": 5,
    },
}


def evidence_from(text: str, words: int = 8) -> str:
    """A verbatim excerpt: the first words of the source text."""
    return " ".join(re.sub(r"\s+", " ", text).split(" ")[:words])


@dataclass
class FakeAI:
    name: str = "fake"
    #: substring of the source text → draft fields that replace the generic ones
    drafts: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: substring of the source text → fields used by the rewrite instead
    rewrites: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: substring of the source text → statements the verifier calls unsupported
    unsupported: dict[str, list[str]] = field(default_factory=dict)
    failures: dict[str, list[Exception]] = field(default_factory=dict)
    calls: list[tuple[str, list[str]]] = field(default_factory=list)

    def fail(self, operation: str, exc: Exception) -> None:
        self.failures.setdefault(operation, []).append(exc)

    def _usage(self, operation: str) -> AIUsage:
        return AIUsage(
            model="fake-model",
            prompt_version=self.prompt_version(operation),
            input_tokens=100,
            output_tokens=50,
            cost_usd=0.0001,
        )

    def _check(self, operation: str, ids: list[str]) -> None:
        self.calls.append((operation, ids))
        queue = self.failures.get(operation)
        if queue:
            raise queue.pop(0)

    @staticmethod
    def _match(table: dict[str, Any], text: str) -> Any:
        return next((v for k, v in table.items() if k in text), None)

    def _draft(self, item: dict[str, Any], table: dict[str, dict[str, Any]]) -> dict[str, Any]:
        text = str(item.get("text") or item.get("source_text") or "")
        draft: dict[str, Any] = {
            **GENERIC,
            "id": item["id"],
            "claims": [{"text": "ادعای اصلی خبر", "evidence": evidence_from(text)}],
        }
        draft.update(self._match(table, text) or {})
        return draft

    def operations(self) -> list[str]:
        return [op for op, _ in self.calls]

    def prompt_version(self, operation: str, language: str = "any") -> str:
        return f"{operation}_fake_v1"

    def model_for(self, operation: str) -> str:
        return "fake-model"

    async def summarize(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]:
        self._check("summarize", [i["id"] for i in items])
        data = SummarizeOutput.model_validate(
            {"articles": [self._draft(i, self.drafts) for i in items]}
        )
        return AIResult(data=data, usage=self._usage("summarize"), raw="{}")

    async def verify(self, items: Sequence[dict[str, Any]]) -> AIResult[VerifyOutput]:
        self._check("verify", [i["id"] for i in items])
        out = []
        for item in items:
            bad = self._match(self.unsupported, str(item.get("source_text", ""))) or []
            draft_text = " ".join(
                [item["draft"].get("summary", ""), *item["draft"].get("key_points", [])]
            )
            out.append(
                {
                    "id": item["id"],
                    "claims": [
                        {"index": c["index"], "supported": True} for c in item.get("claims", [])
                    ],
                    "unsupported_statements": [s for s in bad if s in draft_text],
                }
            )
        return AIResult(
            data=VerifyOutput.model_validate({"articles": out}),
            usage=self._usage("verify"),
            raw="{}",
        )

    async def rewrite(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]:
        self._check("rewrite", [i["id"] for i in items])
        data = SummarizeOutput.model_validate(
            {"articles": [self._draft(i, self.rewrites) for i in items]}
        )
        return AIResult(data=data, usage=self._usage("rewrite"), raw="{}")

    async def translate(self, text: str, *, language: str) -> AIResult[TranslateOutput]:
        self._check("translate", [])
        return AIResult(data=TranslateOutput(text="ترجمه"), usage=self._usage("translate"))

    async def classify(
        self, items: Sequence[dict[str, Any]], *, categories: Sequence[str]
    ) -> AIResult[ClassifyOutput]:
        raise NotImplementedError

    async def extract_claims(self, item: dict[str, Any]) -> AIResult[ClaimsOutput]:
        raise NotImplementedError

    async def extract_entities(self, item: dict[str, Any]) -> AIResult[EntitiesOutput]:
        raise NotImplementedError

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.0] for _ in texts]
