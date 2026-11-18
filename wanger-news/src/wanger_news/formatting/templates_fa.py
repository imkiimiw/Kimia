"""Persian post templates (spec §10). Every dynamic value is escaped here and nowhere else.

Phase 1 has no AI, so an RSS item is posted with its ORIGINAL title and the feed's own short
teaser (never the full article), the single-source warning, the source and the link.
Other languages get their own template module later (the renderer is chosen per language).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from wanger_news.config.models import PublishConfig
from wanger_news.domain.jalali import format_tehran
from wanger_news.domain.text import truncate
from wanger_news.formatting.telegram_html import bold, esc, link, utf16_len

LANGUAGE_NAMES_FA = {
    "en": "انگلیسی",
    "fa": "فارسی",
    "ar": "عربی",
    "tr": "ترکی",
    "fr": "فرانسوی",
    "de": "آلمانی",
    "ru": "روسی",
}


@dataclass(frozen=True, slots=True)
class PostInput:
    title: str
    teaser: str
    source_name: str
    url: str
    published_at: datetime | None
    language: str
    hashtags: list[str]
    image_url: str | None
    breaking: bool = False


@dataclass(frozen=True, slots=True)
class RenderedPost:
    text: str  # Telegram HTML
    photo_url: str | None  # when set, ``text`` is the caption and fits the caption limit


def _render(post: PostInput, teaser: str, with_image: bool, timezone: str) -> str:
    head = ("🔴 " if post.breaking else "") + bold(post.title)
    blocks = [head]
    if teaser:
        blocks.append(esc(teaser))
    blocks.append(
        "⚠️ <b>گزارش اولیه</b>\n"
        f"این خبر در حال حاضر فقط بر اساس گزارش {esc(post.source_name)} است و ممکن است تغییر کند."
    )
    meta = []
    if post.language != "fa":
        lang = LANGUAGE_NAMES_FA.get(post.language, post.language)
        meta.append(f"🌐 متن به زبان اصلی منبع ({esc(lang)}) است؛ ترجمه و خلاصهٔ فارسی از فاز ۲.")
    meta.append(f"📰 منبع: {esc(post.source_name)}")
    meta.append("🔗 " + link(post.url, "منبع اصلی"))
    if post.published_at is not None:
        meta.append(f"🕒 {esc(format_tehran(post.published_at, timezone))}")
    if with_image:
        meta.append(f"🖼 تصویر: {esc(post.source_name)}")
    blocks.append("\n".join(meta))
    if post.hashtags:
        blocks.append(" ".join("#" + esc(tag) for tag in post.hashtags[:3]))
    return "\n\n".join(blocks)


def render_article(post: PostInput, cfg: PublishConfig, timezone: str) -> RenderedPost:
    """Fit the post into one caption (with the feed image) or one message (without)."""
    teaser = truncate(post.teaser, cfg.description_excerpt_chars) if post.teaser else ""
    if post.image_url and cfg.use_feed_images:
        # shorten only the teaser until the caption fits; the facts lines are never cut
        budget = len(teaser)
        while True:
            text = _render(post, truncate(teaser, budget) if budget else "", True, timezone)
            if utf16_len(text) <= cfg.caption_limit:
                return RenderedPost(text=text, photo_url=post.image_url)
            if budget == 0:
                break
            budget = max(0, budget - 40) if budget > 60 else 0
    text = _render(post, teaser, False, timezone)
    if utf16_len(text) > cfg.message_limit:
        text = _render(post, "", False, timezone)
    return RenderedPost(text=text, photo_url=None)


def render_owner_notice(title: str, lines: list[str]) -> str:
    return "\n".join([bold(title), *(esc(line) for line in lines)])
