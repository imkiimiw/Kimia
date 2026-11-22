"""Parsing every feed flavour, including broken ones, and normalizing entries into drafts."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from wanger_news.adapters.feeds.parser import FeedParseError, parse_feed
from wanger_news.domain.article import Rejected, check_draft
from wanger_news.domain.feed import RawEntry
from wanger_news.domain.normalize import entry_to_draft, url_policy

from .conftest import NOW, feed, make_config


def test_rss2() -> None:
    parsed = parse_feed(
        feed("rss2.xml"), "https://alpha.example/rss.xml", 50, "application/rss+xml"
    )
    assert parsed.warning is None
    assert parsed.language == "en"
    assert len(parsed.entries) == 5
    first = parsed.entries[0]
    assert first.title.startswith("Central bank raises")
    assert first.published == datetime(2026, 11, 18, 10, 0, tzinfo=UTC)
    assert first.images[0].url == "https://img.alpha.example/economy.jpg"
    assert "<script>" not in first.summary_html  # feedparser sanitizes


def test_atom_and_html_summary() -> None:
    parsed = parse_feed(
        feed("atom.xml"), "https://beta.example/atom.xml", 50, "application/atom+xml"
    )
    assert [e.link for e in parsed.entries] == [
        "https://beta.example/2026/11/18/central-bank-rates/",
        "https://beta.example/2026/11/18/chip/",
    ]
    assert parsed.entries[1].published == datetime(2026, 11, 18, 11, 15, tzinfo=UTC)


def test_rdf() -> None:
    parsed = parse_feed(feed("rdf.xml"), "https://gamma.example/rss", 50, "application/rdf+xml")
    assert len(parsed.entries) == 1
    assert parsed.entries[0].published == datetime(2026, 11, 18, 9, 0, tzinfo=UTC)


def test_broken_feed_keeps_what_is_usable() -> None:
    parsed = parse_feed(feed("broken.xml"), "https://delta.example/rss", 50, "application/rss+xml")
    assert parsed.warning is not None
    assert parsed.entries and parsed.entries[0].title.startswith("Museum returns")


@pytest.mark.parametrize("body", [b"", b"   ", feed("not_a_feed.html")])
def test_not_a_feed_raises(body: bytes) -> None:
    with pytest.raises(FeedParseError):
        parse_feed(body, "https://x.example/", 50, "text/html")


def test_max_entries() -> None:
    assert len(parse_feed(feed("rss2.xml"), "https://alpha.example/rss.xml", 2).entries) == 2


def _draft(entry: RawEntry):  # type: ignore[no-untyped-def]
    cfg = make_config()
    source = cfg.source("alpha")
    assert source is not None
    pipe = cfg.pipeline
    return entry_to_draft(entry, source, NOW, pipe.ingest, pipe.dedup, url_policy(pipe.dedup))


def test_entry_to_draft_normalizes_everything() -> None:
    entry = parse_feed(feed("rss2.xml"), "https://alpha.example/rss.xml", 50).entries[0]
    draft = _draft(entry)
    assert draft.canonical_url == "https://alpha.example/news/economy-123"
    assert draft.external_id == "alpha-123"
    assert "alert" not in draft.description_original
    assert draft.content_hash and draft.content_hash.startswith("sha256:")
    assert draft.simhash is not None and draft.token_count > 10
    assert draft.language == "en" and draft.country == "GB"


def test_entry_without_usable_link_is_rejected() -> None:
    entry = RawEntry(
        guid="x",
        link="javascript:alert(1)",
        title="A long enough title here",
        summary_html="",
        content_html="",
        author=None,
        published=NOW,
    )
    with pytest.raises(Rejected, match="no_valid_url"):
        _draft(entry)


def test_short_title_rejected_and_future_date_clamped() -> None:
    cfg = make_config().pipeline.ingest
    short = RawEntry(
        guid="s",
        link="https://alpha.example/s",
        title="Hi",
        summary_html="",
        content_html="",
        author=None,
        published=NOW,
    )
    with pytest.raises(Rejected, match="title_too_short"):
        check_draft(_draft(short), cfg)
    future = RawEntry(
        guid="f",
        link="https://alpha.example/f",
        title="From the far future",
        summary_html="",
        content_html="",
        author=None,
        published=datetime(2027, 1, 1, tzinfo=UTC),
    )
    assert check_draft(_draft(future), cfg).published_at == NOW
