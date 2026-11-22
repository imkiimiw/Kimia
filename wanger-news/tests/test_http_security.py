"""SSRF guard, the safe fetcher (redirects, size cap, retries/backoff, 304) and robots.txt."""

from __future__ import annotations

import httpx
import pytest

from wanger_news.adapters.http.fetcher import FetchError, SafeFetcher
from wanger_news.adapters.http.robots import RobotsChecker
from wanger_news.adapters.http.ssrf import SsrfBlocked, StaticResolver, UrlGuard, is_public_address
from wanger_news.config.models import HttpConfig

PUBLIC = ["93.184.216.34"]


@pytest.mark.parametrize(
    ("address", "public"),
    [
        ("93.184.216.34", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
        ("::1", False),
        ("fd00::1", False),
        ("::ffff:127.0.0.1", False),
        ("2606:4700::1111", True),
        ("224.0.0.1", False),
        ("not-an-ip", False),
    ],
)
def test_public_addresses(address: str, public: bool) -> None:
    assert is_public_address(address) is public


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/x",
        "file:///etc/passwd",
        "http://localhost/x",
        "http://127.0.0.1/x",
        "http://[::1]/x",
        "http://user:pw@example.com/x",
        "http://example.com:22/x",
        "http://metadata.internal/x",
        "http://private.example/x",
        "gopher://example.com/",
    ],
)
async def test_guard_blocks(url: str) -> None:
    guard = UrlGuard(StaticResolver({"private.example": ["10.0.0.5"]}, default=PUBLIC), [80, 443])
    with pytest.raises(SsrfBlocked):
        await guard.check(url)


async def test_guard_blocks_mixed_resolution() -> None:
    guard = UrlGuard(StaticResolver({"rebind.example": ["93.184.216.34", "127.0.0.1"]}), [80, 443])
    with pytest.raises(SsrfBlocked):
        await guard.check("https://rebind.example/feed")


async def test_guard_allows_public() -> None:
    guard = UrlGuard(StaticResolver({}, default=PUBLIC), [80, 443])
    await guard.check("https://example.com/feed.xml")


def make_fetcher(handler, **cfg) -> tuple[SafeFetcher, list[float]]:  # type: ignore[no-untyped-def]
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resolver = StaticResolver({"internal.example": ["192.168.0.10"]}, default=PUBLIC)
    fetcher = SafeFetcher(
        client, UrlGuard(resolver, [80, 443]), HttpConfig(**cfg), sleep=sleep, rng=lambda: 0.5
    )
    return fetcher, sleeps


async def test_redirect_to_private_address_is_blocked() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://internal.example/admin"})

    fetcher, _ = make_fetcher(handler)
    with pytest.raises(FetchError) as info:
        await fetcher.fetch("https://example.com/feed")
    assert info.value.kind == "blocked"


async def test_redirects_are_followed_and_limited() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/final":
            return httpx.Response(200, content=b"<rss/>")
        return httpx.Response(301, headers={"location": "/final"})

    fetcher, _ = make_fetcher(handler)
    result = await fetcher.fetch("https://example.com/start")
    assert result.url == "https://example.com/final" and result.body == b"<rss/>"

    def loop(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/again"})

    fetcher, _ = make_fetcher(loop, max_redirects=3)
    with pytest.raises(FetchError) as info:
        await fetcher.fetch("https://example.com/start")
    assert info.value.kind == "redirects"


async def test_response_size_is_capped() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 20_000)

    fetcher, _ = make_fetcher(handler, max_response_bytes=10_000)
    with pytest.raises(FetchError) as info:
        await fetcher.fetch("https://example.com/huge")
    assert info.value.kind == "too_large"


async def test_retries_with_exponential_backoff_then_succeeds() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(503)
        return httpx.Response(200, content=b"ok")

    fetcher, sleeps = make_fetcher(
        handler, retries=2, backoff_base_seconds=1, backoff_max_seconds=8
    )
    result = await fetcher.fetch("https://example.com/flaky")
    assert result.body == b"ok" and result.attempts == 3
    assert sleeps == [0.75, 1.5]  # equal jitter with rng=0.5: base*2^n * 0.75


async def test_timeouts_are_retried_and_4xx_are_not() -> None:
    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    fetcher, sleeps = make_fetcher(timeout, retries=1)
    with pytest.raises(FetchError) as info:
        await fetcher.fetch("https://example.com/slow")
    assert info.value.kind == "timeout" and len(sleeps) == 1

    fetcher, sleeps = make_fetcher(lambda r: httpx.Response(404), retries=3)
    with pytest.raises(FetchError) as info:
        await fetcher.fetch("https://example.com/missing")
    assert info.value.status == 404 and sleeps == []


async def test_long_retry_after_gives_up_for_this_run() -> None:
    fetcher, sleeps = make_fetcher(lambda r: httpx.Response(429, headers={"retry-after": "3600"}))
    with pytest.raises(FetchError):
        await fetcher.fetch("https://example.com/busy")
    assert sleeps == []


async def test_conditional_get_and_304() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(304)

    fetcher, _ = make_fetcher(handler)
    result = await fetcher.fetch("https://example.com/feed", etag='"v1"', last_modified="Tue")
    assert result.not_modified
    assert seen["if-none-match"] == '"v1"' and seen["if-modified-since"] == "Tue"
    assert seen["user-agent"].startswith("WangerNewsBot")


async def test_robots_txt() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "deny.example":
            return httpx.Response(200, text="User-agent: WangerNewsBot\nDisallow: /feeds/\n")
        if request.url.host == "down.example":
            return httpx.Response(503)
        return httpx.Response(404)

    fetcher, _ = make_fetcher(handler, retries=0)
    robots = RobotsChecker(fetcher, "WangerNewsBot")
    assert not (await robots.check("https://deny.example/feeds/all.xml")).allowed
    assert (await robots.check("https://deny.example/other.xml")).allowed
    assert (await robots.check("https://none.example/feed.xml")).allowed  # 404 → no rules
    assert not (await robots.check("https://down.example/feed.xml")).allowed  # 5xx → disallow
