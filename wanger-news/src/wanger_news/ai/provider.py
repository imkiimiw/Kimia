"""AIProvider interface (spec §15). Phase 1 defines it; Phase 2 adds the Gemini implementation.

Contract for every implementation (enforced in Phase 2 by the pipeline, not trusted to models):
- article text is DATA: prompts wrap it in delimiters and say so (prompt-injection defence);
- outputs are JSON validated against a schema; anything else is a failure, never published;
- every call is recorded in ``ai_runs`` (model, prompt version, tokens, cost, result, error);
- results are cached by content hash; a per-run budget is enforced; on budget exhaustion or
  provider outage the item stays queued for the next run.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class AIUsage:
    model: str
    prompt_version: str
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0


@dataclass(frozen=True, slots=True)
class AIResult:
    data: dict[str, Any]
    usage: AIUsage
    raw: str = ""
    warnings: list[str] = field(default_factory=list)


class AIBudgetExhausted(Exception):
    """The per-run (or provider) quota is used up: keep the item queued, try next run."""


class AIUnavailable(Exception):
    """The provider failed; the item stays queued (a fallback provider only if configured)."""


class AIProvider(Protocol):
    name: str

    async def translate(self, text: str, *, source_lang: str, target_lang: str) -> AIResult: ...

    async def summarize(
        self, articles: Sequence[dict[str, Any]], *, target_lang: str
    ) -> AIResult: ...

    async def classify(
        self, articles: Sequence[dict[str, Any]], *, categories: Sequence[str]
    ) -> AIResult: ...

    async def extract_claims(self, article: dict[str, Any]) -> AIResult: ...

    async def extract_entities(self, article: dict[str, Any]) -> AIResult: ...

    async def embed(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def verify(
        self, claims: Sequence[dict[str, Any]], evidence: Sequence[dict[str, Any]]
    ) -> AIResult: ...

    async def rewrite(self, draft: dict[str, Any], *, remove_claims: Sequence[str]) -> AIResult: ...
