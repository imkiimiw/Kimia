"""AIProvider interface (spec §15). Gemini is the first implementation (ai/gemini.py); OpenAI,
Anthropic or a local model are further adapters with no change elsewhere.

Contract every implementation keeps (the pipeline enforces it too, it never trusts a model):
- article text is DATA: delimited with a random boundary, declared as data (ai/prompts.py);
- answers are JSON validated against the operation's schema (ai/schemas.py), else an error;
- errors are classified: quota (wait for the next run), unavailable, blocked, invalid output;
- nothing is written to the database here: the AI stage records every call in ``ai_runs``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, Protocol, TypeVar

from pydantic import BaseModel

from wanger_news.ai.schemas import (
    ClaimsOutput,
    ClassifyOutput,
    EntitiesOutput,
    SummarizeOutput,
    TranslateOutput,
    UpdateOutput,
    VerifyOutput,
)

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True, slots=True)
class AIUsage:
    model: str
    prompt_version: str
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: float = 0.0


@dataclass(frozen=True, slots=True)
class AIResult(Generic[T]):
    data: T
    usage: AIUsage
    raw: str = ""
    warnings: list[str] = field(default_factory=list)


class AIError(Exception):
    """Base class. ``usage`` is filled when the provider charged tokens before failing."""

    status = "error"

    def __init__(self, message: str, usage: AIUsage | None = None, raw: str = "") -> None:
        super().__init__(message)
        self.usage = usage
        self.raw = raw


class AIBudgetExhausted(AIError):
    """Our per-run/per-day budget or the provider's quota is used up: try again next run."""

    status = "quota"


class AIUnavailable(AIError):
    """Transport, auth, unknown model, server error: the items stay queued."""

    status = "error"


class AIBlocked(AIError):
    """The provider refused or cut the answer (safety, recitation, max tokens)."""

    status = "blocked"


class AIInvalidOutput(AIError):
    """Not JSON, wrong schema, or ids that do not match the request."""

    status = "invalid_output"


class AIProvider(Protocol):
    name: str

    async def summarize(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]: ...

    async def verify(self, items: Sequence[dict[str, Any]]) -> AIResult[VerifyOutput]: ...

    async def update(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[UpdateOutput]: ...

    async def rewrite(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]: ...

    async def translate(self, text: str, *, language: str) -> AIResult[TranslateOutput]: ...

    async def classify(
        self, items: Sequence[dict[str, Any]], *, categories: Sequence[str]
    ) -> AIResult[ClassifyOutput]: ...

    async def extract_claims(self, item: dict[str, Any]) -> AIResult[ClaimsOutput]: ...

    async def extract_entities(self, item: dict[str, Any]) -> AIResult[EntitiesOutput]: ...

    async def embed(
        self, texts: Sequence[str], *, model: str | None = None, dimensions: int | None = None
    ) -> list[list[float]]: ...

    def prompt_version(self, operation: str, language: str = "any") -> str: ...

    def model_for(self, operation: str) -> str: ...
