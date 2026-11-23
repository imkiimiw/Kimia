"""English post template (Phase 6, English editions). Every dynamic value is escaped here.

Same layout as the Persian post (spec §10): title, summary, key points, status, sources, link.
Only texts that passed the English guard reach it (``domain/editions.check_english``).
"""

from __future__ import annotations

from dataclasses import dataclass

from wanger_news.config.models import PublishConfig
from wanger_news.formatting.telegram_html import bold, esc, link, utf16_len
from wanger_news.formatting.templates_fa import RenderedPost

STATUS_LABELS_EN = {
    "confirmed": "Confirmed",
    "likely": "Likely",
    "preliminary": "Initial report",
    "unconfirmed": "Unconfirmed",
    "conflicting": "Conflicting reports",
}


@dataclass(frozen=True, slots=True)
class EnglishPost:
    title: str
    summary: str
    key_points: list[str]
    status: str  # a key of STATUS_LABELS_EN
    source_names: list[str]
    source_url: str
    image_url: str | None = None
    breaking: bool = False
    update: bool = False


def _html(post: EnglishPost, with_image: bool) -> str:
    head = ("🔴 " if post.breaking else "") + ("🔄 <b>Update:</b> " if post.update else "")
    blocks = [head + bold(post.title)]
    blocks.extend(esc(p.strip()) for p in post.summary.split("\n") if p.strip())
    if post.key_points:
        blocks.append("\n".join(f"• {esc(point)}" for point in post.key_points))
    lines = [f"📌 Status: {esc(STATUS_LABELS_EN.get(post.status, post.status))}"]
    if len(post.source_names) == 1 and not post.update:
        lines.append(
            f"⚠️ This report currently rests on {esc(post.source_names[0])} alone and may change."
        )
    blocks.append("\n".join(lines))
    meta = [
        f"📰 {'New sources' if post.update else 'Sources'}: {esc(', '.join(post.source_names))}",
        "🔗 " + link(post.source_url, "Original source"),
    ]
    if with_image:
        meta.append(f"🖼 Image: {esc(post.source_names[0])}")
    blocks.append("\n".join(meta))
    return "\n\n".join(blocks)


def render_summary_en(post: EnglishPost, cfg: PublishConfig) -> RenderedPost:
    plain = _html(post, with_image=False)
    if post.image_url and cfg.use_feed_images:
        text = _html(post, with_image=True)
        if utf16_len(text) <= cfg.caption_limit:
            return RenderedPost(text=text, photo_url=post.image_url, text_without_photo=plain)
    return RenderedPost(text=plain, photo_url=None)
