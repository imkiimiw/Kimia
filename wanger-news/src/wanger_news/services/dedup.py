"""DEDUPLICATE stage: level 1 (exact keys), level 2 (SimHash), level 3 (event — Phase 3 port)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from wanger_news.config.models import DedupConfig
from wanger_news.db.repositories import NearCandidate, Repositories
from wanger_news.db.tables import Article
from wanger_news.domain.article import ArticleDraft
from wanger_news.domain.enums import PUBLISHED_LIKE, ArticleStatus, DedupLevel, FingerprintKind
from wanger_news.domain.fingerprint import from_signed64, hamming
from wanger_news.domain.text import tokens
from wanger_news.domain.urls import url_key
from wanger_news.ports import EventMatcher

#: Below this many words, identical text is too generic to call two posts "the same"
#: (e.g. a photo captioned only "#خبر"); media / link / origin keys still apply.
EXACT_TEXT_MIN_TOKENS = 3

_KIND_FA = {
    FingerprintKind.URL.value: "لینک یکسان",
    FingerprintKind.CONTENT.value: "متن یکسان",
    FingerprintKind.MEDIA.value: "رسانهٔ یکسان",
    FingerprintKind.TG_ORIGIN.value: "فوروارد از همان پست",
    "near": "متن بسیار مشابه",
    "event": "همان رویداد",
}


def describe_match(kind: str) -> str:
    return _KIND_FA.get(kind, kind)


@dataclass(frozen=True, slots=True)
class DedupHit:
    original_id: int
    level: DedupLevel
    kind: str  # fingerprint kind, "near" or "event"
    distance: int | None = None


def fingerprints_of(draft: ArticleDraft) -> list[tuple[FingerprintKind, str]]:
    prints: list[tuple[FingerprintKind, str]] = []
    if draft.canonical_url:
        prints.append((FingerprintKind.URL, url_key(draft.canonical_url)))
    if draft.content_hash and draft.token_count >= EXACT_TEXT_MIN_TOKENS:
        prints.append((FingerprintKind.CONTENT, draft.content_hash))
    if draft.telegram is not None:
        prints.extend((FingerprintKind.URL, url_key(link)) for link in draft.telegram.links)
        prints.extend((FingerprintKind.MEDIA, fid) for fid in draft.telegram.file_unique_ids)
        if draft.telegram.forward_origin:
            prints.append((FingerprintKind.TG_ORIGIN, draft.telegram.forward_origin))
    return prints


class NearIndex:
    """Recent SimHashes kept in memory for one run (loaded once, extended on every insert)."""

    def __init__(self, candidates: list[NearCandidate]) -> None:
        self.items = candidates

    def add(self, article: Article) -> None:
        if article.simhash is not None:
            self.items.insert(
                0,
                NearCandidate(
                    article.id,
                    article.simhash,
                    article.status,
                    article.duplicate_of_id or article.id,
                ),
            )

    def within(self, simhash: int, max_distance: int) -> list[tuple[NearCandidate, int]]:
        """Prefilter: candidates within ``max_distance`` bits, closest first."""
        value = from_signed64(simhash)
        found = [
            (cand, distance)
            for cand in self.items
            if (distance := hamming(value, from_signed64(cand.simhash))) <= max_distance
        ]
        return sorted(found, key=lambda item: item[1])


def _numbers(words: set[str]) -> set[str]:
    return {w for w in words if any(ch.isdigit() for ch in w)}


def same_text(a: set[str], b: set[str], min_jaccard: float, same_numbers: bool) -> float | None:
    """Confirmation after the SimHash prefilter: token-set Jaccard, and (by default) identical
    numbers — "toll rises to 20" vs "to 25" is an update, never a duplicate."""
    if not a or not b:
        return None
    if same_numbers and _numbers(a) != _numbers(b):
        return None
    jaccard = len(a & b) / len(a | b)
    return jaccard if jaccard >= min_jaccard else None


def article_words(article: Article) -> set[str]:
    body = article.description_original or article.content_original
    return set(tokens(f"{article.title_original}\n{body}"))


def draft_words(draft: ArticleDraft) -> set[str]:
    return set(tokens(f"{draft.title_original}\n{draft.body_text}"))


class DedupService:
    def __init__(self, cfg: DedupConfig, events: EventMatcher) -> None:
        self._cfg = cfg
        self._events = events
        self.index = NearIndex([])

    async def prepare(self, repos: Repositories, now: datetime) -> None:
        since = now - timedelta(hours=self._cfg.near_duplicate_window_hours)
        self.index = NearIndex(
            await repos.articles.near_candidates(
                since, self._cfg.near_duplicate_min_tokens, self._cfg.near_duplicate_max_candidates
            )
        )

    async def root(self, repos: Repositories, article: Article) -> Article:
        """Follow duplicate_of links to the original (bounded, in case of a bad chain)."""
        current = article
        for _ in range(5):
            if current.duplicate_of_id is None:
                return current
            parent = await repos.articles.get(current.duplicate_of_id)
            if parent is None:
                return current
            current = parent
        return current

    async def _near_matches(
        self, repos: Repositories, draft: ArticleDraft
    ) -> list[tuple[Article, int]]:
        """Level 2: SimHash prefilter, then a Jaccard + same-numbers confirmation."""
        cfg = self._cfg
        if draft.simhash is None or draft.token_count < cfg.near_duplicate_min_tokens:
            return []
        words = draft_words(draft)
        matches: list[tuple[Article, int]] = []
        seen: set[int] = set()
        for cand, distance in self.index.within(draft.simhash, cfg.near_duplicate_max_hamming):
            article = await repos.articles.get(cand.article_id)
            if (
                article is None
                or same_text(
                    words,
                    article_words(article),
                    cfg.near_duplicate_min_jaccard,
                    cfg.near_duplicate_same_numbers,
                )
                is None
            ):
                continue
            original = await self.root(repos, article)
            if original.id not in seen:
                seen.add(original.id)
                matches.append((original, distance))
        return matches

    async def check(self, repos: Repositories, draft: ArticleDraft) -> DedupHit | None:
        """Is this draft a copy of anything already stored (any status)?"""
        matches = await repos.articles.match_fingerprints(fingerprints_of(draft))
        if matches:
            article, kind = matches[0]
            original = await self.root(repos, article)
            return DedupHit(original.id, DedupLevel.EXACT, kind)
        for original, distance in await self._near_matches(repos, draft):
            return DedupHit(original.id, DedupLevel.NEAR, "near", distance)
        event_original = await self._events.find_same_event(draft)
        if event_original is not None:
            return DedupHit(event_original, DedupLevel.EVENT, "event")
        return None

    async def check_published(
        self, repos: Repositories, draft: ArticleDraft
    ) -> tuple[DedupHit | None, list[Article]]:
        """For source-channel posts: "was this posted before?"

        Returns (hit on something already published, unpublished copies the human post
        supersedes). Filtered/stale/expired copies were never posted, so they do not block.
        """
        published: DedupHit | None = None
        superseded: dict[int, Article] = {}
        waiting = {
            ArticleStatus.NEW.value,
            ArticleStatus.QUEUED.value,
            ArticleStatus.PENDING_REVIEW.value,
        }
        for article, kind in await repos.articles.match_fingerprints(fingerprints_of(draft)):
            original = await self.root(repos, article)
            if original.status in {s.value for s in PUBLISHED_LIKE}:
                published = published or DedupHit(original.id, DedupLevel.EXACT, kind)
            elif original.status in waiting:
                superseded[original.id] = original
        if published is None:
            for original, distance in await self._near_matches(repos, draft):
                if original.status in {s.value for s in PUBLISHED_LIKE}:
                    published = DedupHit(original.id, DedupLevel.NEAR, "near", distance)
                    break
                if original.status in waiting:
                    superseded[original.id] = original
        return published, list(superseded.values())
