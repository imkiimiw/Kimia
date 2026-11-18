"""Telegram HTML: escaping, safe links, splitting long messages, the Persian post template."""

from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest

from wanger_news.config.models import PublishConfig
from wanger_news.domain.jalali import format_tehran, gregorian_to_jalali
from wanger_news.formatting.telegram_html import bold, esc, link, split_html, utf16_len
from wanger_news.formatting.templates_fa import PostInput, render_article

TAG = re.compile(r"</?([a-z]+)[^>]*>")


def balanced(markup: str) -> bool:
    stack: list[str] = []
    for match in TAG.finditer(markup):
        name = match.group(1)
        if match.group(0).startswith("</"):
            if not stack or stack.pop() != name:
                return False
        else:
            stack.append(name)
    return not stack


def test_escape() -> None:
    assert esc('<script>&"x"') == '&lt;script&gt;&amp;"x"'
    assert bold("a<b") == "<b>a&lt;b</b>"


@pytest.mark.parametrize("url", ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"])
def test_links_only_for_web_schemes(url: str) -> None:
    assert link(url, "label") == "label"


def test_link_attribute_is_escaped() -> None:
    assert (
        link('https://x.example/?a=1&b="2"', "L")
        == '<a href="https://x.example/?a=1&amp;b=&quot;2&quot;">L</a>'
    )


def test_utf16_length_counts_emoji_twice() -> None:
    assert utf16_len("😀a") == 3


def test_short_message_is_not_split() -> None:
    assert split_html("<b>hi</b>", 4096) == ["<b>hi</b>"]


def test_split_prefers_paragraphs() -> None:
    paragraphs = [f"<b>title {i}</b>\n" + "word " * 40 for i in range(10)]
    chunks = split_html("\n\n".join(paragraphs), 600)
    assert len(chunks) > 1
    assert all(utf16_len(c) <= 600 for c in chunks)
    assert all(balanced(c) for c in chunks)
    assert "".join(chunks).count("<b>title") == 10


def test_split_a_huge_paragraph_keeps_tags_and_entities_whole() -> None:
    body = "<b>" + " ".join(["A&amp;B", "😀", "سلام"] * 400) + "</b>"
    chunks = split_html(body, 500)
    assert len(chunks) > 2
    for chunk in chunks:
        assert utf16_len(chunk) <= 500
        assert balanced(chunk)
        assert chunk.startswith("<b>") and chunk.endswith("</b>")
        assert not re.search(r"&(?![a-z#0-9]+;)", chunk)  # no cut entity


def test_split_a_single_enormous_word() -> None:
    chunks = split_html("x" * 5000, 1000)
    assert all(utf16_len(c) <= 1000 for c in chunks)
    assert "".join(chunks) == "x" * 5000


# ------------------------------------------------------------------ jalali


@pytest.mark.parametrize(
    ("greg", "jalali"),
    [
        ((2026, 3, 21), (1405, 1, 1)),
        ((2024, 3, 20), (1403, 1, 1)),
        ((2026, 11, 18), (1405, 8, 27)),
        ((2025, 3, 20), (1403, 12, 30)),
        ((2000, 1, 1), (1378, 10, 11)),
    ],
)
def test_gregorian_to_jalali(greg: tuple[int, int, int], jalali: tuple[int, int, int]) -> None:
    assert gregorian_to_jalali(*greg) == jalali


def test_tehran_display_time() -> None:
    # 20:45 UTC is 00:15 the next day in Tehran (UTC+3:30)
    assert format_tehran(datetime(2026, 11, 18, 20, 45, tzinfo=UTC)) == "۱۴۰۵/۰۸/۲۸ ساعت ۰۰:۱۵"


# ------------------------------------------------------------------ template


def post(**kw: object) -> PostInput:
    base: dict[str, object] = {
        "title": "Central bank <raises> rates & more",
        "teaser": "Short teaser. " * 10,
        "source_name": "Alpha <News>",
        "url": "https://alpha.example/a?x=1&y=2",
        "published_at": datetime(2026, 11, 18, 10, 0, tzinfo=UTC),
        "language": "en",
        "hashtags": ["اقتصاد", "جهان", "سیاست", "ایران"],
        "image_url": None,
    }
    base.update(kw)
    return PostInput(**base)  # type: ignore[arg-type]


def test_template_escapes_and_credits_the_source() -> None:
    out = render_article(post(), PublishConfig(), "Asia/Tehran")
    assert out.photo_url is None
    assert "<b>Central bank &lt;raises&gt; rates &amp; more</b>" in out.text
    assert "گزارش اولیه" in out.text and "Alpha &lt;News&gt;" in out.text
    assert '<a href="https://alpha.example/a?x=1&amp;y=2">منبع اصلی</a>' in out.text
    assert "۱۴۰۵/۰۸/۲۷" in out.text
    assert out.text.count("#") == 3  # at most three hashtags
    assert "زبان اصلی منبع" in out.text
    assert balanced(out.text)


def test_persian_source_has_no_language_note() -> None:
    assert (
        "زبان اصلی" not in render_article(post(language="fa"), PublishConfig(), "Asia/Tehran").text
    )


def test_teaser_is_an_excerpt_not_the_full_text() -> None:
    long_teaser = "word " * 2000
    out = render_article(
        post(teaser=long_teaser), PublishConfig(description_excerpt_chars=300), "Asia/Tehran"
    )
    assert utf16_len(out.text) < 1200
    assert "…" in out.text


def test_image_post_fits_the_caption_limit() -> None:
    cfg = PublishConfig(caption_limit=1024, description_excerpt_chars=900)
    out = render_article(
        post(teaser="sentence " * 200, image_url="https://img.example/a.jpg"), cfg, "Asia/Tehran"
    )
    assert out.photo_url == "https://img.example/a.jpg"
    assert utf16_len(out.text) <= 1024
    assert "🖼 تصویر" in out.text


def test_image_dropped_when_even_the_facts_do_not_fit() -> None:
    cfg = PublishConfig(caption_limit=100)
    out = render_article(post(image_url="https://img.example/a.jpg"), cfg, "Asia/Tehran")
    assert out.photo_url is None
    assert "🖼" not in out.text


def test_images_can_be_switched_off() -> None:
    out = render_article(
        post(image_url="https://img.example/a.jpg"),
        PublishConfig(use_feed_images=False),
        "Asia/Tehran",
    )
    assert out.photo_url is None
