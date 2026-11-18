"""robots.txt (RFC 9309): checked before fetching a feed, cached per host for a day."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from wanger_news.adapters.http.fetcher import FetchError, SafeFetcher


@dataclass(frozen=True, slots=True)
class RobotsDecision:
    allowed: bool
    reason: str


class RobotsChecker:
    """One robots.txt fetch per host per run; the per-source result is cached in the DB."""

    def __init__(self, fetcher: SafeFetcher, user_agent_token: str) -> None:
        self._fetcher = fetcher
        self._token = user_agent_token
        self._parsers: dict[str, RobotFileParser | RobotsDecision] = {}

    @staticmethod
    def robots_url(url: str) -> str:
        parts = urlsplit(url)
        return urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))

    async def check(self, url: str) -> RobotsDecision:
        robots_url = self.robots_url(url)
        cached = self._parsers.get(robots_url)
        if cached is None:
            cached = await self._load(robots_url)
            self._parsers[robots_url] = cached
        if isinstance(cached, RobotsDecision):
            return cached
        if cached.can_fetch(self._token, url):
            return RobotsDecision(True, "allowed")
        return RobotsDecision(False, "disallowed by robots.txt")

    async def _load(self, robots_url: str) -> RobotFileParser | RobotsDecision:
        try:
            result = await self._fetcher.fetch(robots_url, accept="text/plain, */*", retries=0)
        except FetchError as exc:
            if exc.status is not None and 400 <= exc.status < 500 and exc.status != 429:
                # RFC 9309 §2.3.1.3: robots.txt "unavailable" → no restrictions.
                return RobotsDecision(True, f"no robots.txt ({exc.status})")
            # §2.3.1.4: "unreachable" (5xx, network) → assume complete disallow for now.
            return RobotsDecision(False, f"robots.txt unreachable ({exc.kind})")
        parser = RobotFileParser()
        parser.parse(result.body.decode("utf-8", errors="replace").splitlines())
        return parser
