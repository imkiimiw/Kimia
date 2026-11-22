"""A thin Bot API client (ADR-005). The token never appears in logs or exception messages.

Outcome classes matter for "never post twice":
- ``TelegramNotSent``: the request certainly did not take effect (connection never made, 4xx).
- ``TelegramUncertain``: it may have taken effect (timeout after sending, 5xx, broken response).
- ``TelegramRateLimited``: 429 with a ``retry_after`` longer than we are willing to wait.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from pydantic import SecretStr


class TelegramError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: int | None = None,
        description: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.description = description or message
        self.parameters = parameters or {}


class TelegramNotSent(TelegramError):
    pass


class TelegramUncertain(TelegramError):
    pass


class TelegramRateLimited(TelegramNotSent):
    def __init__(self, retry_after: float, description: str) -> None:
        super().__init__(
            f"rate limited for {retry_after}s",
            code=429,
            description=description,
            parameters={"retry_after": retry_after},
        )
        self.retry_after = retry_after


class TelegramClient:
    def __init__(
        self,
        token: SecretStr,
        http: httpx.AsyncClient,
        *,
        base_url: str = "https://api.telegram.org",
        rate_limit_max_wait: float = 30,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._token = token
        self._http = http
        self._base = base_url.rstrip("/")
        self._max_wait = rate_limit_max_wait
        self._sleep = sleep

    async def call(
        self, method: str, payload: dict[str, Any] | None = None, *, idempotent: bool = False
    ) -> Any:
        """Call a Bot API method and return its unwrapped ``result``.

        ``idempotent`` calls (reads like getUpdates/getMe) treat every transport error as
        retryable; a send is retried only after a 429 (Telegram did not perform it).
        """
        for attempt in range(2):
            try:
                return await self._call_once(method, payload or {}, idempotent=idempotent)
            except TelegramRateLimited as exc:
                if attempt or exc.retry_after > self._max_wait:
                    raise
                await self._sleep(exc.retry_after)
        raise AssertionError("unreachable")

    async def _call_once(self, method: str, payload: dict[str, Any], *, idempotent: bool) -> Any:
        url = f"{self._base}/bot{self._token.get_secret_value()}/{method}"
        uncertain_cls = TelegramNotSent if idempotent else TelegramUncertain
        try:
            resp = await self._http.post(url, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            raise TelegramNotSent(f"{method}: {type(exc).__name__} (not sent)") from None
        except httpx.TransportError as exc:  # read timeout, connection dropped mid-request …
            raise uncertain_cls(f"{method}: {type(exc).__name__}") from None
        try:
            data = resp.json()
        except ValueError:
            raise uncertain_cls(f"{method}: HTTP {resp.status_code}, not JSON") from None
        if not isinstance(data, dict):
            raise uncertain_cls(f"{method}: unexpected response")
        if data.get("ok"):
            return data.get("result")
        code = int(data.get("error_code") or resp.status_code)
        description = str(data.get("description") or "")
        parameters = data.get("parameters") or {}
        if code == 429:
            raise TelegramRateLimited(float(parameters.get("retry_after", 1)), description)
        if code >= 500:
            raise uncertain_cls(
                f"{method}: {code} {description}",
                code=code,
                description=description,
                parameters=parameters,
            )
        raise TelegramNotSent(
            f"{method}: {code} {description}",
            code=code,
            description=description,
            parameters=parameters,
        )
