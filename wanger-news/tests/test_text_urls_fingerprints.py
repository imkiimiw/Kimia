"""Text normalization, URL normalization (dedup level 1) and SimHash (level 2)."""

from __future__ import annotations

import pytest

from wanger_news.config.models import DedupConfig
from wanger_news.domain.fingerprint import (
    content_hash,
    from_signed64,
    hamming,
    simhash64,
    to_signed64,
)
from wanger_news.domain.normalize import url_policy
from wanger_news.domain.text import (
    clean_text,
    detect_language,
    html_to_text,
    normalize_for_match,
    to_ascii_digits,
    to_persian_digits,
    tokens,
    truncate,
)
from wanger_news.domain.urls import normalize_url, url_key

from .conftest import make_config


@pytest.fixture(scope="module")
def policy():  # type: ignore[no-untyped-def]
    return url_policy(make_config().pipeline.dedup)


# ------------------------------------------------------------------ text


def test_persian_and_arabic_letters_and_digits_are_unified() -> None:
    assert normalize_for_match("كيك ۱۲۳ ٤٥") == normalize_for_match("کیک 123 45")
    assert to_ascii_digits("۱۴۰۵/۰۸/۲۷") == "1405/08/27"
    assert to_persian_digits("2026") == "۲۰۲۶"


def test_zwnj_and_diacritics_do_not_change_the_match_form() -> None:
    assert normalize_for_match("می‌شود") == normalize_for_match("می شود")
    assert normalize_for_match("رأی") == normalize_for_match("رای")
    assert normalize_for_match("مُحَمَّد") == normalize_for_match("محمد")


def test_html_to_text_drops_tags_scripts_and_unescapes() -> None:
    text = html_to_text("<p>A &amp; B</p><script>alert('x')</script><p>second <b>line</b></p>")
    assert text == "A & B\n\nsecond line"
    assert "alert" not in text


def test_html_to_text_survives_garbage() -> None:
    assert html_to_text("<p>unclosed <b>tag & stuff") == "unclosed tag & stuff"


def test_clean_text_removes_invisible_and_control_characters() -> None:
    assert clean_text("a​b\x00c  \t d\r\n\n\n e") == "abc d\n\ne"


def test_truncate_cuts_at_a_word_boundary() -> None:
    out = truncate("one two three four five six seven", 20)
    assert len(out) <= 20
    assert out.endswith("…")
    assert not out[:-1].endswith(" ")
    assert truncate("short", 20) == "short"


@pytest.mark.parametrize(
    ("text", "lang"),
    [
        ("سلام دنیا، این یک خبر است", "fa"),
        ("مرحبا بالعالم", "ar"),
        ("Hello world", "en"),
        ("12345", None),
    ],
)
def test_detect_language(text: str, lang: str | None) -> None:
    assert detect_language(text) == lang


def test_tokens_ignore_links_mentions_and_hashtags() -> None:
    assert tokens("خبر فوری https://t.me/x/1 @channel #خبر") == tokens("خبر فوری")


# ------------------------------------------------------------------ urls


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "https://www.bbc.co.uk/news/world-1?utm_source=rss&at_medium=RSS",
            "https://bbc.co.uk/news/world-1",
        ),
        ("HTTPS://WWW.Example.COM:443/a//b/?b=2&a=1#frag", "https://example.com/a/b?a=1&b=2"),
        ("http://example.com:80/", "http://example.com/"),
        ("https://example.com/path/?fbclid=abc&id=7", "https://example.com/path?id=7"),
        ("https://m.example.com/story", "https://example.com/story"),
        ("https://user:pw@example.com/x", "https://example.com/x"),
        ("https://example.com:8443/x", "https://example.com:8443/x"),
        ("https://example.com/%7Euser", "https://example.com/~user"),
    ],
)
def test_normalize_url(policy, raw: str, expected: str) -> None:  # type: ignore[no-untyped-def]
    assert normalize_url(raw, policy) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "ftp://example.com/x", "javascript:alert(1)", "not a url", "https://", "http://[::1"],
)
def test_unusable_urls_are_rejected(policy, raw: str) -> None:  # type: ignore[no-untyped-def]
    assert normalize_url(raw, policy) is None


def test_url_key_ignores_the_scheme(policy) -> None:  # type: ignore[no-untyped-def]
    a = normalize_url("http://example.com/a", policy)
    b = normalize_url("https://www.example.com/a/", policy)
    assert a is not None and b is not None
    assert url_key(a) == url_key(b)


def test_keep_meaningful_query_parameters(policy) -> None:  # type: ignore[no-untyped-def]
    assert (
        normalize_url("https://example.com/watch?v=abc", policy)
        == "https://example.com/watch?v=abc"
    )


# ------------------------------------------------------------------ fingerprints


def test_content_hash_ignores_noise_but_not_content() -> None:
    a = content_hash("Breaking: fire at port", "Ten people hurt https://x.example/1 #news")
    b = content_hash("BREAKING: Fire at port!", "Ten people hurt @somechannel")
    c = content_hash("Breaking: fire at port", "Twelve people hurt")
    assert a == b
    assert a != c
    assert content_hash("", "") is None


def test_simhash_is_close_for_small_edits_and_far_for_different_texts() -> None:
    cfg = DedupConfig()
    base = (
        "The central bank raised its main interest rate by half a point on Tuesday, "
        "citing record inflation and a weakening currency"
    )
    edited = base + ", analysts said"
    other = (
        "Astronomers say the images, taken by a new space telescope, show a planet forming "
        "inside a disc of gas and dust around a young star"
    )
    h_base = simhash64(tokens(base), cfg.shingle_size)
    assert hamming(h_base, simhash64(tokens(base), cfg.shingle_size)) == 0
    assert hamming(h_base, simhash64(tokens(edited), cfg.shingle_size)) <= 10
    assert hamming(h_base, simhash64(tokens(other), cfg.shingle_size)) > 16


def test_signed_conversion_round_trips() -> None:
    for value in (0, 1, (1 << 63) - 1, 1 << 63, (1 << 64) - 1):
        signed = to_signed64(value)
        assert -(1 << 63) <= signed < (1 << 63)
        assert from_signed64(signed) == value


def test_near_duplicate_confirmation_needs_same_words_and_same_numbers() -> None:
    from wanger_news.services.dedup import same_text

    a = set(tokens("Death toll from the earthquake rises to 20, officials say"))
    reordered = set(tokens("Officials say the death toll from the earthquake rises to 20"))
    updated = set(tokens("Death toll from the earthquake rises to 25, officials say"))
    other = set(tokens("Parliament approves the new budget after a long debate"))
    assert same_text(a, reordered, 0.8, True) == 1.0
    assert same_text(a, updated, 0.8, True) is None  # a changed figure is news, not a repeat
    assert same_text(a, updated, 0.8, False) is not None
    assert same_text(a, other, 0.8, True) is None
    assert same_text(set(), a, 0.8, True) is None
