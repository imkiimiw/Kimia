"""Text utilities: Persian/Arabic normalization, HTML → text, tokens, truncation.

Pure functions only (no I/O), so every rule here is unit-tested.
"""

from __future__ import annotations

import html
import re
import unicodedata
from html.parser import HTMLParser

ZWNJ = "‌"

_ARABIC_TO_PERSIAN = str.maketrans(
    {
        "ي": "ی",  # ي → ی
        "ى": "ی",  # ى → ی
        "ئ": "ی",  # ئ → ی
        "ك": "ک",  # ك → ک
        "ة": "ه",  # ة → ه
        "ۀ": "ه",  # ۀ → ه
        "أ": "ا",  # أ → ا
        "إ": "ا",  # إ → ا
        "ٱ": "ا",  # ٱ → ا
        "آ": "ا",  # آ → ا (matching only)
        "ؤ": "و",  # ؤ → و
    }
)
_TO_ASCII_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_TO_PERSIAN_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")
_DIACRITICS = re.compile("[ً-ٰٟۖ-ۭـ]")  # harakat, superscript alef, tatweel
_INVISIBLE = re.compile("[​‍-‏‪-‮⁦-⁩﻿­]")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_MENTION_OR_TAG = re.compile(r"(?<!\w)[@#][\w‌]+")
_SPACES = re.compile(r"[ \t  -   　]+")
_WORD = re.compile(r"\w+")
_ARABIC_SCRIPT = re.compile("[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]")
_PERSIAN_ONLY = re.compile("[پچژگکی\u06f0-\u06f9]")  # پ چ ژ گ ک ی and Persian digits ۰-۹
_LATIN = re.compile(r"[A-Za-z]")


def to_ascii_digits(text: str) -> str:
    return text.translate(_TO_ASCII_DIGITS)


def to_persian_digits(text: str) -> str:
    return text.translate(_TO_PERSIAN_DIGITS)


def clean_text(text: str) -> str:
    """Remove control/invisible characters (keeps ZWNJ and newlines), collapse spaces."""
    text = unicodedata.normalize("NFC", text)
    text = _CONTROL.sub("", text)
    text = _INVISIBLE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    out: list[str] = []
    blank = False
    for line in lines:
        if not line:
            blank = True
            continue
        if blank and out:
            out.append("")
        out.append(line)
        blank = False
    return "\n".join(out)


def normalize_for_match(text: str) -> str:
    """The form used for keyword matching, hashing and similarity (never for display)."""
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_ARABIC_TO_PERSIAN).translate(_TO_ASCII_DIGITS)
    text = _DIACRITICS.sub("", text)
    text = text.replace(ZWNJ, " ")
    text = _INVISIBLE.sub("", text)
    text = text.casefold()
    return _SPACES.sub(" ", text.replace("\n", " ")).strip()


def strip_noise(text: str) -> str:
    """Drop URLs, @mentions and #hashtags: they differ between copies of the same news."""
    return _MENTION_OR_TAG.sub(" ", _URL.sub(" ", text))


def tokens(text: str) -> list[str]:
    return _WORD.findall(normalize_for_match(strip_noise(text)))


def truncate(text: str, limit: int, ellipsis: str = "…") -> str:
    """Cut at a word boundary so the result (with the ellipsis) is at most ``limit`` chars."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    cut = text[: max(0, limit - len(ellipsis))]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,.;:-–—،؛") + ellipsis


def detect_language(text: str) -> str | None:
    """A cheap script-based guess: ``fa``, ``ar``, ``en`` or None. Good enough for routing."""
    arabic = len(_ARABIC_SCRIPT.findall(text))
    latin = len(_LATIN.findall(text))
    if arabic == 0 and latin == 0:
        return None
    if arabic >= latin:
        return "fa" if _PERSIAN_ONLY.search(text) else "ar"
    return "en"


_BLOCK_TAGS = frozenset(
    {
        "p",
        "div",
        "br",
        "li",
        "ul",
        "ol",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "tr",
        "blockquote",
        "section",
        "article",
        "figure",
        "figcaption",
        "header",
        "footer",
        "pre",
        "hr",
        "table",
    }
)
_SKIP_TAGS = frozenset({"script", "style", "noscript", "iframe", "object", "svg", "template"})


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP_TAGS:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n\n" if tag == "p" else "\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n\n" if tag == "p" else "\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def html_to_text(markup: str) -> str:
    """Untrusted feed HTML → plain text. Tags are dropped, never passed on."""
    if "<" not in markup and "&" not in markup:
        return clean_text(markup)
    parser = _TextExtractor()
    try:
        parser.feed(markup)
        parser.close()
        text = "".join(parser.parts)
    except Exception:  # malformed markup: fall back to a crude strip
        text = html.unescape(re.sub(r"<[^>]*>", " ", markup))
    return clean_text(text)
