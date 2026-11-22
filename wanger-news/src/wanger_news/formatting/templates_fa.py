"""Persian post templates (spec §10). Every dynamic value is escaped here and nowhere else.

Phase 1 has no AI, so an RSS item is posted with its ORIGINAL title and the feed's own short
teaser (never the full article), the single-source warning, the source and the link.
Other languages get their own template module later (the renderer is chosen per language).
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
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
    related: list[dict[str, object]] = field(default_factory=list)  # Phase 4: linked stories


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
class ContradictionLine:
    """One disagreement between sources, rendered by a fixed sentence (no AI prose)."""

    topic: str
    versions: list[tuple[str, str]]  # (outlet, what it says — a Persian predicate)
    earlier: str | None = None  # the outlet that published first, when the times differ clearly


@dataclass(frozen=True, slots=True)
class PostLink:
    """An earlier channel post (Phase 4: related stories, story timeline)."""

    title: str
    url: str | None
    when: str | None = None  # already formatted (Tehran time)


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
    update: bool = False  # Phase 3: a follow-up to a published story (sent as a reply)
    contradictions: list[ContradictionLine] = field(default_factory=list)
    timeline: list[PostLink] = field(default_factory=list)  # Phase 4: earlier posts of the story
    related: list[PostLink] = field(default_factory=list)  # Phase 4: related earlier stories


def _link_line(item: PostLink, title_chars: int = 90) -> str:
    title = truncate(item.title, title_chars)
    text = link(item.url, title) if item.url else esc(title)
    return f"• {esc(item.when)} — {text}" if item.when else f"• {text}"


def contradiction_sentence(line: ContradictionLine) -> str:
    """«گزارش‌ها دربارهٔ X متفاوت است؛ رویترز …، در حالی که بی‌بی‌سی ….» (spec §8 example)."""
    parts = [f"{outlet} {statement}".strip() for outlet, statement in line.versions]
    body = f"{parts[0]}، در حالی که {parts[1]}" if len(parts) == 2 else "؛ ".join(parts)
    text = f"گزارش‌ها دربارهٔ {line.topic} متفاوت است؛ {body}."
    if line.earlier:
        text += f" (این گزارش‌ها در زمان‌های متفاوتی منتشر شده‌اند؛ گزارش {line.earlier} زودتر بود.)"
    return text


def _summary_html(post: SummaryPost, with_image: bool) -> str:
    head = ("🔴 " if post.breaking else "") + ("🔄 <b>به‌روزرسانی:</b> " if post.update else "")
    blocks = [head + bold(post.title)]
    paragraphs = [p.strip() for p in post.summary.split("\n") if p.strip()]
    blocks.extend(esc(p) for p in paragraphs)
    if post.key_points:
        blocks.append("\n".join(f"• {esc(point)}" for point in post.key_points))
    if post.contradictions:
        blocks.append("\n".join(f"⚖️ {esc(contradiction_sentence(c))}" for c in post.contradictions))
    if post.timeline:
        blocks.append("🧵 <b>روند خبر:</b>\n" + "\n".join(_link_line(t) for t in post.timeline))
    status = STATUS_LABELS_FA.get(post.status, post.status)
    lines = [f"📌 وضعیت: {esc(status)}"]
    if len(post.source_names) == 1 and not post.update:
        lines.append(
            f"⚠️ این خبر در حال حاضر فقط بر اساس گزارش {esc(post.source_names[0])} "
            "است و ممکن است تغییر کند."
        )
    blocks.append("\n".join(lines))
    meta = [
        f"📰 {'منابع تازه' if post.update else 'منابع'}: {esc('، '.join(post.source_names))}",
        "🔗 " + link(post.source_url, "منبع اصلی"),
    ]
    if with_image:
        meta.append(f"🖼 تصویر: {esc(post.source_names[0])}")
    blocks.append("\n".join(meta))
    if post.related:
        blocks.append("🔗 <b>مرتبط:</b>\n" + "\n".join(_link_line(r) for r in post.related))
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
    "conflicting_reports": "منابع با هم تناقض دارند",
    "rule": "قانون ویرایشی",
}


def reason_fa(reason: str | None, topic_names: dict[str, str]) -> str:
    if not reason:
        return "—"
    if reason.startswith("sensitive:"):
        topics = [topic_names.get(t, t) for t in reason.split(":", 1)[1].split(",") if t]
        return "موضوع حساس: " + "، ".join(topics)
    if reason.startswith("rule:"):
        return f"قانون ویرایشی «{reason.split(':', 1)[1]}»"
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
    sources_line: str | None = None  # Phase 3: independent sources of the story
    claims_line: str | None = None  # Phase 3: claim statuses
    update_of: str | None = None  # Phase 3: the published story this update belongs to
    breaking: bool = False  # Phase 4


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
    if card.update_of:
        head.insert(1, f"🔄 به‌روزرسانی خبر منتشرشده: {esc(card.update_of[:120])}")
    if card.breaking:
        head.insert(1, "🔴 <b>خبر فوری</b> — لطفاً زودتر تصمیم بگیرید")
    if card.sources_line:
        head.append(f"📚 {esc(card.sources_line)}")
    if card.claims_line:
        head.append(f"🧾 {esc(card.claims_line)}")
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


# ------------------------------------------------------------------ Phase 4: real time


@dataclass(frozen=True, slots=True)
class TrendAlert:
    label: str
    reports: int
    sources: int
    window_minutes: int
    usual: float  # usual reports per window
    source_names: list[str]


def render_trend_alert(alert: TrendAlert) -> str:
    """«⚠️ موضوع در حال رشد: …» (spec, Phase 4). Only counts: nothing here is a claim."""

    def fa(value: float | int) -> str:
        return to_persian_digits(str(value))

    usual = round(alert.usual, 1)
    usual_text = fa(int(usual)) if usual == int(usual) else fa(usual).replace(".", "٫")
    window = fa(alert.window_minutes)
    before = (
        f"معمولاً حدود {usual_text} گزارش در هر {window} دقیقه."
        if usual > 0
        else "پیش از این، گزارشی دربارهٔ آن ثبت نشده بود."
    )
    lines = [
        f"⚠️ <b>موضوع در حال رشد:</b> تعداد گزارش‌ها دربارهٔ «{esc(alert.label)}» در "
        f"{window} دقیقهٔ اخیر به شکل غیرعادی افزایش یافته است.",
        f"📊 {fa(alert.reports)} گزارش از {fa(alert.sources)} منبع؛ {before}",
    ]
    if alert.source_names:
        lines.append("📰 منابع: " + esc("، ".join(alert.source_names[:6])))
    lines.append("ℹ️ این هشدار فقط بر اساس شمار گزارش‌هاست و به معنی تأیید محتوای آن‌ها نیست.")
    return "\n".join(lines)


@dataclass(frozen=True, slots=True)
class BriefItem:
    title: str
    url: str | None
    status: str  # a key of STATUS_LABELS_FA
    breaking: bool = False
    updates: int = 0


@dataclass(frozen=True, slots=True)
class DailyBrief:
    date: str  # Jalali, already formatted
    items: list[BriefItem]
    trends: list[tuple[str, int]] = field(default_factory=list)  # (topic, reports)


def render_brief(brief: DailyBrief) -> str:
    """The day's published stories, most important first — only titles already published
    (no new AI text), each linked to its post."""
    blocks = [f"🗞 <b>خلاصهٔ خبرهای امروز</b> — {esc(brief.date)}"]
    lines = []
    for n, item in enumerate(brief.items, 1):
        title = truncate(item.title, 110)
        text = link(item.url, title) if item.url else esc(title)
        status = STATUS_LABELS_FA.get(item.status, item.status)
        extra = f" · {to_persian_digits(str(item.updates))} به‌روزرسانی" if item.updates else ""
        mark = "🔴 " if item.breaking else ""
        lines.append(f"{to_persian_digits(str(n))}. {mark}{text}\n   📌 {esc(status)}{extra}")
    blocks.append("\n".join(lines))
    if brief.trends:
        topics = "، ".join(
            f"{esc(label)} ({to_persian_digits(str(count))} گزارش)" for label, count in brief.trends
        )
        blocks.append(f"📈 موضوع‌های پرگزارش امروز: {topics}")
    blocks.append("#خلاصه_روز")
    return "\n\n".join(blocks)


TIMELINE_EVENTS_FA = {
    "created": "رویداد ثبت شد",
    "joined": "منبع تازه",
    "summarized": "خلاصه آماده شد",
    "update_ready": "به‌روزرسانی آماده شد",
    "published": "منتشر شد",
    "published_by_hand": "پست دستی در کانال",
    "update_published": "به‌روزرسانی منتشر شد",
    "corroborated": "تأیید منبع دیگر (بدون اطلاعات تازه)",
    "detached": "یک منبع جدا شد (رویداد دیگر)",
    "new_lead": "گزارش اصلی عوض شد",
    "breaking": "🔴 خبر فوری",
    "trend": "⚠️ موضوع در حال رشد",
}


def render_story_timeline(title: str, lines: list[tuple[str, str, str]], limit: int = 40) -> str:
    """Admin view of a story's timeline: (time, event, detail) rows, oldest first."""
    rows = [
        f"• {esc(when)} — {esc(TIMELINE_EVENTS_FA.get(event, event))}"
        + (f": {esc(detail)}" if detail else "")
        for when, event, detail in lines[-limit:]
    ]
    head = f"🧵 <b>روند خبر</b>: {esc(truncate(title, 150))}"
    if len(lines) > limit:
        head += f"\n(فقط {to_persian_digits(str(limit))} رویداد آخر)"
    return head + "\n" + "\n".join(rows)


# ------------------------------------------------------------------ Phase 5: corrections


def render_correction(sentence: str) -> str:
    """«⚠️ اصلاح خبر» (spec §10); ``sentence`` from domain/corrections.correction_text."""
    return f"⚠️ <b>اصلاح خبر</b>\n{esc(sentence)}"


def render_correction_card(
    correction_id: int, story_title: str, sentence: str, evidence: str | None, origin: str
) -> str:
    who = "پیشنهاد هوش مصنوعی از گزارش تازه" if origin == "ai" else "نوشتهٔ ادمین"
    lines = [
        f"⚠️ <b>پیشنهاد اصلاح #{to_persian_digits(str(correction_id))}</b> — {esc(who)}",
        f"خبر منتشرشده: {esc(truncate(story_title, 150))}",
        "",
        "━━━━━━ پیش‌نمایش ━━━━━━",
        render_correction(sentence),
    ]
    if evidence:
        lines += ["", f"📎 شاهد از منبع: «{esc(truncate(evidence, 300))}»"]
    lines += ["", "اگر تأیید کنید، به‌صورت Reply زیر پست منتشرشده می‌رود."]
    return "\n".join(lines)
