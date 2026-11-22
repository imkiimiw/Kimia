"""Telegram ``parse_mode=HTML`` building blocks: escaping, links and length-safe splitting.

Lengths are measured on the HTML source in UTF-16 code units (Telegram counts UTF-16, and the
source is always at least as long as the visible text), so a chunk that fits here always fits.
"""

from __future__ import annotations

import html
import re
from urllib.parse import urlsplit

_ATOM = re.compile(r"<[^>]+>|&#?\w+;|\s+|[^<&\s]+|[<&]")
_TAG = re.compile(r"^<(/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*?(/?)>$")
_PARAGRAPH = "\n\n"


def esc(text: str) -> str:
    """Escape text for Telegram HTML (``<``, ``>``, ``&``; quotes are safe outside attributes)."""
    return html.escape(text, quote=False)


def safe_href(url: str) -> str | None:
    try:
        scheme = urlsplit(url).scheme.lower()
    except ValueError:
        return None
    return url if scheme in {"http", "https", "tg"} else None


def link(url: str, label: str) -> str:
    """``<a>`` for http(s)/tg URLs only; anything else degrades to the escaped label."""
    href = safe_href(url)
    if href is None:
        return esc(label)
    return f'<a href="{html.escape(href, quote=True)}">{esc(label)}</a>'


def bold(text: str) -> str:
    return f"<b>{esc(text)}</b>"


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def split_html(markup: str, limit: int) -> list[str]:
    """Split valid Telegram HTML into chunks of at most ``limit`` UTF-16 units.

    Prefers paragraph boundaries, then whitespace. Never cuts inside a tag or an entity; tags
    open at a cut are closed at the end of the chunk and reopened at the start of the next one.
    """
    if utf16_len(markup) <= limit:
        return [markup]
    chunks: list[str] = []
    current = ""
    for paragraph in markup.split(_PARAGRAPH):
        candidate = f"{current}{_PARAGRAPH}{paragraph}" if current else paragraph
        if utf16_len(candidate) <= limit:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ""
        if utf16_len(paragraph) <= limit:
            current = paragraph
        else:
            pieces = _split_atoms(paragraph, limit)
            chunks.extend(pieces[:-1])
            current = pieces[-1]
    if current:
        chunks.append(current)
    return [c for c in (chunk.strip() for chunk in chunks) if c]


def _split_atoms(markup: str, limit: int) -> list[str]:
    chunks: list[str] = []
    open_tags: list[tuple[str, str]] = []  # (name, full opening tag)
    current = ""

    def closing() -> str:
        return "".join(f"</{name}>" for name, _ in reversed(open_tags))

    def reopening() -> str:
        return "".join(tag for _, tag in open_tags)

    for atom in _expand_long(_ATOM.findall(markup), max(1, limit // 4)):
        if utf16_len(current + atom + closing()) > limit and current.strip():
            chunks.append(current.rstrip() + closing())
            current = reopening() + ("" if atom.isspace() else atom)
        else:
            current += atom
        match = _TAG.match(atom)
        if match:
            closing_tag, name, self_closing = match.group(1), match.group(2).lower(), match.group(3)
            if closing_tag:
                for i in range(len(open_tags) - 1, -1, -1):
                    if open_tags[i][0] == name:
                        del open_tags[i]
                        break
            elif not self_closing:
                open_tags.append((name, atom))
    if current.strip():
        chunks.append(current)
    return chunks


def _expand_long(atoms: list[str], max_len: int) -> list[str]:
    """Cut words longer than ``max_len`` (URLs, run-on text) into pieces."""
    out: list[str] = []
    for atom in atoms:
        if atom.startswith(("<", "&")) or utf16_len(atom) <= max_len:
            out.append(atom)
        else:
            out.extend(atom[i : i + max_len] for i in range(0, len(atom), max_len))
    return out
