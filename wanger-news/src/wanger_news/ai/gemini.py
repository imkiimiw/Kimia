"""Google Gemini over REST (``models/{model}:generateContent``), JSON answers only.

- The API key goes in the ``x-goog-api-key`` header, never in a URL, and never in an error.
- ``responseMimeType=application/json`` plus the schema (``responseJsonSchema``); the schema is
  also in the prompt, so if the API refuses the schema field we retry once without it.
- Safety blocks, recitation blocks and truncated answers are reported as AIBlocked: such an item
  goes to a human instead of being published.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, SecretStr, ValidationError

from wanger_news.ai.prompts import PromptLibrary
from wanger_news.ai.provider import (
    AIBlocked,
    AIBudgetExhausted,
    AIInvalidOutput,
    AIResult,
    AIUnavailable,
    AIUsage,
)
from wanger_news.ai.schemas import (
    ClaimsOutput,
    ClassifyOutput,
    EntitiesOutput,
    SummarizeOutput,
    TranslateOutput,
    UpdateOutput,
    VerifyOutput,
    json_schema,
)
from wanger_news.config.models import AIConfig

T = TypeVar("T", bound=BaseModel)

SAFETY_CATEGORIES = (
    "HARM_CATEGORY_HARASSMENT",
    "HARM_CATEGORY_HATE_SPEECH",
    "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    "HARM_CATEGORY_DANGEROUS_CONTENT",
)
#: news about wars and crimes must be summarisable; only high-probability harm is blocked
SAFETY_THRESHOLD = "BLOCK_ONLY_HIGH"
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
#: server errors that mean "this model is busy": another model may answer
OVERLOADED = ("gemini 500", "gemini 503", "gemini 504")
log = logging.getLogger("wanger_news")


class GeminiProvider:
    name = "gemini"

    def __init__(
        self, api_key: SecretStr, http: httpx.AsyncClient, cfg: AIConfig, prompts: PromptLibrary
    ) -> None:
        self._key = api_key
        self._http = http
        self._cfg = cfg
        self._prompts = prompts
        self._schema_field_ok = cfg.schema_mode == "json_schema"

    # ---------------------------------------------------------------- operations
    def prompt_version(self, operation: str, language: str = "any") -> str:
        return self._prompts.get(operation, language).version

    def model_for(self, operation: str) -> str:
        return self._cfg.verifier if operation == "verify" else self._cfg.model

    async def summarize(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]:
        return await self._call(
            "summarize", language, list(items), SummarizeOutput, categories=", ".join(categories)
        )

    async def verify(self, items: Sequence[dict[str, Any]]) -> AIResult[VerifyOutput]:
        return await self._call("verify", "any", list(items), VerifyOutput)

    async def update(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[UpdateOutput]:
        return await self._call(
            "update", language, list(items), UpdateOutput, categories=", ".join(categories)
        )

    async def rewrite(
        self, items: Sequence[dict[str, Any]], *, language: str, categories: Sequence[str]
    ) -> AIResult[SummarizeOutput]:
        return await self._call(
            "rewrite", language, list(items), SummarizeOutput, categories=", ".join(categories)
        )

    async def translate(self, text: str, *, language: str) -> AIResult[TranslateOutput]:
        return await self._call("translate", language, {"text": text}, TranslateOutput)

    async def classify(
        self, items: Sequence[dict[str, Any]], *, categories: Sequence[str]
    ) -> AIResult[ClassifyOutput]:
        return await self._call(
            "classify", "any", list(items), ClassifyOutput, categories=", ".join(categories)
        )

    async def extract_claims(self, item: dict[str, Any]) -> AIResult[ClaimsOutput]:
        return await self._call("extract_claims", "any", item, ClaimsOutput)

    async def extract_entities(self, item: dict[str, Any]) -> AIResult[EntitiesOutput]:
        return await self._call("extract_entities", "any", item, EntitiesOutput)

    async def embed(
        self, texts: Sequence[str], *, model: str | None = None, dimensions: int | None = None
    ) -> list[list[float]]:
        """One batch request (Phase 3 clustering). taskType CLUSTERING, optional smaller
        vectors (outputDimensionality); vectors are normalized by the caller."""
        name = model or DEFAULT_EMBEDDING_MODEL
        url = f"{self._cfg.api_base}/models/{name}:batchEmbedContents"
        requests: list[dict[str, Any]] = []
        for text in texts:
            request: dict[str, Any] = {
                "model": f"models/{name}",
                "content": {"parts": [{"text": text}]},
                "taskType": "CLUSTERING",
            }
            if dimensions:
                request["outputDimensionality"] = dimensions
            requests.append(request)
        data = await self._post(url, {"requests": requests})
        try:
            vectors = [list(map(float, e["values"])) for e in data["embeddings"]]
        except (KeyError, TypeError, ValueError) as exc:
            raise AIInvalidOutput(f"embeddings: unexpected answer ({type(exc).__name__})") from None
        if len(vectors) != len(texts):
            raise AIInvalidOutput(f"embeddings: {len(vectors)} vectors for {len(texts)} texts")
        return vectors

    # ---------------------------------------------------------------- transport
    async def _call(
        self, operation: str, language: str, data: Any, output: type[T], **values: str
    ) -> AIResult[T]:
        prompt = self._prompts.get(operation, language)
        schema = json_schema(output)
        rendered = prompt.render(data, schema, **values)
        model = self.model_for(operation)
        generation: dict[str, Any] = {
            "temperature": self._cfg.temperature,
            "maxOutputTokens": self._cfg.max_output_tokens,
            "responseMimeType": "application/json",
        }
        if self._cfg.thinking_level:
            generation["thinkingConfig"] = {"thinkingLevel": self._cfg.thinking_level}
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": rendered.system}]},
            "contents": [{"role": "user", "parts": [{"text": rendered.user}]}],
            "generationConfig": generation,
            "safetySettings": [
                {"category": c, "threshold": SAFETY_THRESHOLD} for c in SAFETY_CATEGORIES
            ],
        }
        if self._schema_field_ok:
            generation["responseJsonSchema"] = schema
        models = [model, *(m for m in self._cfg.fallback_models if m != model)]
        for n, model in enumerate(models):
            url = f"{self._cfg.api_base}/models/{model}:generateContent"
            try:
                try:
                    answer = await self._post(url, body)
                except AIUnavailable as exc:
                    if not self._drop_unsupported(str(exc), generation):
                        raise
                    answer = await self._post(url, body)
                break
            except AIUnavailable as exc:
                # an overloaded model ("high demand", 503): the next configured model may answer
                if n + 1 < len(models) and str(exc).startswith(OVERLOADED):
                    log.warning(
                        "ai_model_overloaded", extra={"model": model, "next": models[n + 1]}
                    )
                    continue
                raise
        usage = self._usage(answer, model, prompt.version)
        text = self._text(answer, usage)
        try:
            parsed = output.model_validate_json(_FENCE.sub("", text).strip())
        except (ValidationError, ValueError) as exc:
            raise AIInvalidOutput(
                f"{operation}: answer does not match the schema: {str(exc)[:300]}",
                usage,
                text[:4000],
            ) from None
        return AIResult(data=parsed, usage=usage, raw=text[:4000])

    def _drop_unsupported(self, error: str, generation: dict[str, Any]) -> bool:
        """A 400 about an optional field we send: drop it and retry once (the schema is also in
        the prompt, and the thinking level is only a cost optimisation)."""
        text = error.lower()
        if not text.startswith("gemini 400"):
            return False
        if "schema" in text and "responseJsonSchema" in generation:
            self._schema_field_ok = False
            generation.pop("responseJsonSchema")
            return True
        if "thinking" in text and "thinkingConfig" in generation:
            generation.pop("thinkingConfig")
            return True
        return False

    async def _post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "x-goog-api-key": self._key.get_secret_value(),
            "content-type": "application/json",
        }
        try:
            resp = await self._http.post(
                url, json=body, headers=headers, timeout=self._cfg.timeout_seconds
            )
        except httpx.TimeoutException:
            raise AIUnavailable("gemini: timeout") from None
        except httpx.TransportError as exc:
            raise AIUnavailable(f"gemini: {type(exc).__name__}") from None
        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                raise AIUnavailable("gemini: answer is not JSON") from None
            if not isinstance(data, dict):
                raise AIUnavailable("gemini: unexpected answer")
            return data
        message = _error_message(resp)
        if resp.status_code == 429:
            raise AIBudgetExhausted(f"gemini quota: {message}")
        if resp.status_code in (401, 403):
            raise AIUnavailable(f"gemini auth ({resp.status_code}): check the API key — {message}")
        if resp.status_code == 404:
            raise AIUnavailable(f"gemini: model or method not found — {message}")
        raise AIUnavailable(f"gemini {resp.status_code}: {message}")

    def _usage(self, answer: dict[str, Any], model: str, version: str) -> AIUsage:
        meta = answer.get("usageMetadata") or {}
        prompt_tokens = int(meta.get("promptTokenCount") or 0)
        output_tokens = int(meta.get("candidatesTokenCount") or 0)
        thinking = int(meta.get("thoughtsTokenCount") or 0)
        cost = (
            prompt_tokens * self._cfg.price_input_per_million
            + (output_tokens + thinking) * self._cfg.price_output_per_million
        ) / 1_000_000
        return AIUsage(
            model=model,
            prompt_version=version,
            input_tokens=prompt_tokens,
            output_tokens=output_tokens,
            thinking_tokens=thinking,
            cost_usd=round(cost, 6),
        )

    @staticmethod
    def _text(answer: dict[str, Any], usage: AIUsage) -> str:
        feedback = answer.get("promptFeedback") or {}
        if feedback.get("blockReason"):
            raise AIBlocked(f"gemini blocked the prompt: {feedback['blockReason']}", usage)
        candidates = answer.get("candidates") or []
        if not candidates:
            raise AIBlocked("gemini returned no candidate", usage)
        candidate = candidates[0]
        reason = candidate.get("finishReason", "STOP")
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if reason != "STOP":
            kind = "truncated (MAX_TOKENS)" if reason == "MAX_TOKENS" else f"blocked ({reason})"
            raise AIBlocked(f"gemini answer {kind}", usage, text[:4000])
        if not text.strip():
            raise AIInvalidOutput("gemini returned an empty answer", usage)
        return text


def _error_message(resp: httpx.Response) -> str:
    try:
        error = resp.json().get("error", {})
        if isinstance(error, list):  # some endpoints wrap errors in a list
            error = error[0].get("error", {}) if error else {}
        text = f"{error.get('status', '')} {error.get('message', '')}".strip()
    except (ValueError, AttributeError):
        text = resp.text
    return json.dumps(text[:300], ensure_ascii=False)[1:-1]
