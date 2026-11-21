"""Persian post templates (spec §10). Every dynamic value is escaped here and nowhere else.

Phase 1 has no AI, so an RSS item is posted with its ORIGINAL title and the feed's own short
teaser (never the full article), the single-source warning, the source and the link.
Other languages get their own template module later (the renderer is chosen per language).
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime

from wanger_news.config.models import PublishConfig
from wanger_news.domain.jalali import format_tehran
from wanger_news.domain.text import to_persian_digits, truncate
from wanger_news.formatting.telegram_html import bold, esc, link, utf16_len

_TAGS = re.compile(r"<[^>]+>")

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
    text_without_photo: str | None = None  # the same post without the image credit


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
    """Phase 1 template (original-language teaser). Since Phase 2 the publisher only posts
    validated Persian summaries (``render_summary``); this stays for reference and tests.

    Fit the post into one caption (with the feed image) or one message (without)."""
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


# ------------------------------------------------------------------ Phase 2: AI summary posts

STATUS_LABELS_FA = {
    "confirmed": "تأییدشده",
    "likely": "احتمال بالا",
    "preliminary": "گزارش اولیه",
    "unconfirmed": "تأییدنشده",
    "conflicting": "متناقض",
}


@dataclass(frozen=True, slots=True)
class SummaryPost:
    """A validated (or human-approved) Persian rendering, ready for the channel (spec §10)."""

    title: str
    summary: str
    key_points: list[str]
    status: str  # a key of STATUS_LABELS_FA
    source_names: list[str]
    source_url: str
    hashtags: list[str]
    image_url: str | None = None
    breaking: bool = False  # Phase 4


def _summary_html(post: SummaryPost, with_image: bool) -> str:
    blocks = [("🔴 " if post.breaking else "") + bold(post.title)]
    paragraphs = [p.strip() for p in post.summary.split("\n") if p.strip()]
    blocks.extend(esc(p) for p in paragraphs)
    if post.key_points:
        blocks.append("\n".join(f"• {esc(point)}" for point in post.key_points))
    status = STATUS_LABELS_FA.get(post.status, post.status)
    lines = [f"📌 وضعیت: {esc(status)}"]
    if len(post.source_names) == 1:
        lines.append(
            f"⚠️ این خبر در حال حاضر فقط بر اساس گزارش {esc(post.source_names[0])} "
            "است و ممکن است تغییر کند."
        )
    blocks.append("\n".join(lines))
    meta = [
        f"📰 منابع: {esc('، '.join(post.source_names))}",
        "🔗 " + link(post.source_url, "منبع اصلی"),
    ]
    if with_image:
        meta.append(f"🖼 تصویر: {esc(post.source_names[0])}")
    blocks.append("\n".join(meta))
    if post.hashtags:
        blocks.append(" ".join("#" + esc(tag) for tag in post.hashtags[:3]))
    return "\n\n".join(blocks)


def render_summary(post: SummaryPost, cfg: PublishConfig) -> RenderedPost:
    """With the feed image when the whole post fits a caption; otherwise a text message
    (split later if longer than one message). The summary itself is never cut."""
    plain = _summary_html(post, with_image=False)
    if post.image_url and cfg.use_feed_images:
        text = _summary_html(post, with_image=True)
        if utf16_len(text) <= cfg.caption_limit:
            return RenderedPost(text=text, photo_url=post.image_url, text_without_photo=plain)
    return RenderedPost(text=plain, photo_url=None)


# ------------------------------------------------------------------ review cards

REASONS_FA = {
    "guard_failed": "بررسی خودکار ردش کرد",
    "insufficient_information": "اطلاعات منبع کافی نیست",
    "low_confidence": "اطمینان پایین",
    "semi_auto": "حالت نیمه‌خودکار",
    "below_auto_threshold": "زیر آستانهٔ انتشار خودکار",
    "manual_mode": "حالت دستی",
    "human_edit": "ویرایش شد — منتظر تأیید",
    "ai_failed": "هوش مصنوعی نتوانست پردازش کند",
}


def reason_fa(reason: str | None, topic_names: dict[str, str]) -> str:
    if not reason:
        return "—"
    if reason.startswith("sensitive:"):
        topics = [topic_names.get(t, t) for t in reason.split(":", 1)[1].split(",") if t]
        return "موضوع حساس: " + "، ".join(topics)
    return REASONS_FA.get(reason.split(":", 1)[0], reason)


@dataclass(frozen=True, slots=True)
class ReviewCard:
    article_id: int
    reason: str
    importance: int | None
    confidence: int | None
    confidence_label: str | None
    source_name: str
    category_tag: str | None
    issues: list[str]
    preview: str | None  # the post HTML as it would be published; None = no usable text yet
    original_title: str
    original_url: str


def render_review_card(card: ReviewCard, preview_chars: int) -> str:
    def fa_number(value: int | None) -> str:
        return to_persian_digits(str(value)) if value is not None else "—"

    head = [f"🧐 <b>بررسی خبر #{fa_number(card.article_id)}</b>", f"دلیل: {esc(card.reason)}"]
    scores = f"اهمیت: {fa_number(card.importance)} · اطمینان: {fa_number(card.confidence)}" + (
        f" ({esc(STATUS_LABELS_FA.get(card.confidence_label or '', ''))})"
        if card.confidence_label
        else ""
    )
    head.append(scores)
    head.append(
        f"منبع: {esc(card.source_name)}"
        + (f" · #{esc(card.category_tag)}" if card.category_tag else "")
    )
    blocks = ["\n".join(head)]
    if card.issues:
        blocks.append(
            "⚠️ <b>مشکلات بررسی خودکار</b>\n" + "\n".join(f"• {esc(i)}" for i in card.issues)
        )
    if card.preview is None:
        blocks.append(
            "متن فارسی آماده نیست. با «✏️ ویرایش» متن را بنویسید، یا رد کنید.\n"
            f"عنوان اصلی: {esc(card.original_title[:200])}\n" + link(card.original_url, "منبع اصلی")
        )
    else:
        preview = card.preview
        if utf16_len(preview) > preview_chars:
            preview = esc(truncate(_strip_tags(preview), preview_chars))
        blocks.append("━━━━━━ پیش‌نمایش ━━━━━━\n" + preview)
    return "\n\n".join(blocks)


def _strip_tags(markup: str) -> str:
    return html.unescape(_TAGS.sub("", markup))
