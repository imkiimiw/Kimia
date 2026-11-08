"""Text layout with RAQM (HarfBuzz shaping + FriBiDi): correct Persian joining and ligatures, bidi
for mixed text, right-to-left aware wrapping, auto-fit. Without RAQM, text features are disabled
rather than drawn broken (spec §7.2)."""
from __future__ import annotations

import re
import unicodedata

from PIL import ImageFont, features

from ..config import FONTS_DIR

FONTS = {
    "vazirmatn": ("Vazirmatn-Regular.ttf", "Vazirmatn-Bold.ttf"),
    "sahel": ("Sahel.ttf", "Sahel-Bold.ttf"),
    "samim": ("Samim.ttf", "Samim-Bold.ttf"),
}
_EMOJI = re.compile(r"[\U0001f000-\U0001faff\U00002600-\U000027bf\U0000fe0f\U0000200d\U0001f1e6-\U0001f1ff]")


def raqm_available() -> bool:
    return bool(features.check("raqm"))


def fonts_available() -> bool:
    return all((FONTS_DIR / f).exists() for pair in FONTS.values() for f in pair)


def font(name: str, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    files = FONTS.get(name, FONTS["vazirmatn"])
    return ImageFont.truetype(str(FONTS_DIR / files[1 if bold else 0]), size, layout_engine=ImageFont.Layout.RAQM)


def base_direction(text: str) -> str:
    """Paragraph direction by the Unicode bidi rule P2: the first strong letter decides (R/AL → rtl);
    digits and punctuation are weak, so a line of only numbers stays ltr."""
    for ch in text:
        kind = unicodedata.bidirectional(ch)
        if kind in ("R", "AL"):
            return "rtl"
        if kind == "L":
            return "ltr"
    return "ltr"


def strip_emoji(text: str) -> tuple[str, bool]:
    out = _EMOJI.sub("", text)
    return out, out != text


def clean(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[\U0000202a-\U0000202e\U00002066-\U00002069]", "", text)  # bidi overrides: never trusted
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _width(f: ImageFont.FreeTypeFont, s: str, direction: str) -> float:
    return f.getlength(s, direction=direction) if s else 0.0


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: float) -> list[tuple[str, str]]:
    """Lines (text, direction). Words are kept whole; a word wider than a line is split by graphemes."""
    lines: list[tuple[str, str]] = []
    for para in text.split("\n"):
        direction = base_direction(para)
        words = para.split(" ")
        cur = ""
        for w in words:
            candidate = f"{cur} {w}" if cur else w
            if _width(f, candidate, direction) <= max_width:
                cur = candidate
                continue
            if cur:
                lines.append((cur, direction))
                cur = ""
            if _width(f, w, direction) <= max_width:
                cur = w
                continue
            piece = ""
            for ch in w:  # an unbreakable word: split it
                if _width(f, piece + ch, direction) > max_width and piece:
                    lines.append((piece, direction))
                    piece = ch
                else:
                    piece += ch
            cur = piece
        lines.append((cur, direction))
    return lines


def fit(text: str, font_name: str, box_w: int, box_h: int, bold: bool = False, line_spacing: float = 1.35,
        max_size: int = 160, min_size: int = 12, scale: float = 1.0):
    """Largest font size (× scale) whose wrapped text fits the box. → (font, lines, line_height)."""
    lo, hi = min_size, max_size
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        f = font(font_name, mid, bold)
        lines = wrap(text, f, box_w)
        lh = int(mid * line_spacing)
        if lh * len(lines) <= box_h and all(_width(f, s, d) <= box_w for s, d in lines):
            best = (f, lines, lh, mid)
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        f = font(font_name, min_size, bold)
        return f, wrap(text, f, box_w), int(min_size * line_spacing)
    size = max(min_size, min(max_size * 2, int(best[3] * scale)))
    if size == best[3]:
        return best[0], best[1], best[2]
    f = font(font_name, size, bold)
    return f, wrap(text, f, box_w), int(size * line_spacing)


def line_width(f, s, direction) -> float:
    return _width(f, s, direction)
