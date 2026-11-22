"""Re-sending a source-channel post under the target channel's name (owner's decision).

Removes the source's Telegram IDs — @mentions, t.me / telegram.me links (as text or as a
link) and links to users — keeps every other formatting entity (bold, links to websites …),
drops lines that held nothing but an ID («🆔 @channel»), then adds the target channel's
@username and the poster's name as a hashtag. Pure: text + Bot API entities in, the same out.
Entity offsets are UTF-16 code units (Bot API); the work happens on code points.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from dataclasses import dataclass, field
from typing import Any

_TG_LINK = re.compile(
    r"(?:https?://)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)/[^\s]*", re.IGNORECASE
)
_MENTION = re.compile(r"(?<![\w@])@[A-Za-z][A-Za-z0-9_]{3,31}\b")
_WORD = re.compile(r"\w")
_HASHTAG_JUNK = re.compile(r"[^\w]+")


@dataclass(frozen=True, slots=True)
class Styled:
    text: str
    entities: list[dict[str, Any]] = field(default_factory=list)


def _utf16_prefix(text: str) -> list[int]:
    """prefix[i] = UTF-16 offset of code point i (prefix[len] = total length)."""
    out = [0]
    for ch in text:
        out.append(out[-1] + (2 if ord(ch) > 0xFFFF else 1))
    return out


def _is_tg_link(url: str | None) -> bool:
    return bool(url) and _TG_LINK.fullmatch(url.strip()) is not None  # type: ignore[union-attr]


def _remove(
    text: str, spans: list[tuple[int, int]], entities: list[dict[str, Any]]
) -> tuple[str, list[dict[str, Any]]]:
    """Cut code-point spans out of the text; entities move with it, or go if cut away.
    Entities here carry code-point ``start``/``end`` (converted back by the caller)."""
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    def moved(i: int) -> int:
        shift = 0
        for start, end in merged:
            if i >= end:
                shift += end - start
            elif i > start:
                return start - shift
            else:
                break
        return i - shift

    pieces, last = [], 0
    for start, end in merged:
        pieces.append(text[last:start])
        last = end
    pieces.append(text[last:])
    kept = []
    for entity in entities:
        start, end = moved(entity["start"]), moved(entity["end"])
        if end > start:
            kept.append({**entity, "start": start, "end": end})
    return "".join(pieces), kept


def strip_ids(text: str, entities: list[dict[str, Any]]) -> Styled:
    """The post without the source's Telegram IDs (see module doc)."""
    prefix = _utf16_prefix(text)
    work: list[dict[str, Any]] = []
    cut: list[tuple[int, int]] = []
    for raw in entities:
        start = bisect_left(prefix, int(raw.get("offset", 0)))
        end = bisect_left(prefix, int(raw.get("offset", 0)) + int(raw.get("length", 0)))
        kind = raw.get("type")
        piece = text[start:end]
        if (
            kind == "mention"
            or (kind == "url" and _is_tg_link(piece))
            or (kind == "text_link" and _is_tg_link(raw.get("url")))
        ):
            cut.append((start, end))
        elif kind == "text_mention":
            continue  # the name stays, the link to the account goes
        elif kind not in ("mention", "hashtag", "cashtag", "bot_command", "url", "email"):
            # formatting and website links stay; Telegram detects the plain ones again
            work.append(
                {
                    **{k: v for k, v in raw.items() if k not in ("offset", "length")},
                    "start": start,
                    "end": end,
                }
            )
    cut += [m.span() for m in _TG_LINK.finditer(text)]
    cut += [m.span() for m in _MENTION.finditer(text)]
    touched = {text.count("\n", 0, start) for start, _ in cut}
    stripped, work = _remove(text, cut, work)

    # lines that held only an ID («🆔 @channel») or pointed to one («عضو شوید: t.me/…») go
    lines, drop, pos = stripped.split("\n"), [], 0
    for number, line in enumerate(lines):
        dangling = line.rstrip().endswith((":", "："))
        if number in touched and (dangling or not _WORD.search(line)):
            drop.append((pos, pos + len(line) + 1))
        pos += len(line) + 1
    stripped, work = _remove(stripped, drop, work)
    stripped, work = _tidy(stripped, work)
    return _to_utf16(stripped, work)


def _tidy(text: str, entities: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Blank-line runs → one blank line; no space or newlines at either end."""
    cut = [m.span() for m in re.finditer(r"\n{3,}", text)]
    cut = [(start + 2, end) for start, end in cut]
    text, entities = _remove(text, cut, entities)
    lead = len(text) - len(text.lstrip())
    trail = len(text.rstrip())
    text, entities = _remove(text, [(0, lead), (trail, len(text))], entities)
    return text, entities


def _to_utf16(text: str, entities: list[dict[str, Any]]) -> Styled:
    prefix = _utf16_prefix(text)
    out = []
    for entity in entities:
        start, end = entity.pop("start"), entity.pop("end")
        out.append({**entity, "offset": prefix[start], "length": prefix[end] - prefix[start]})
    return Styled(text, out)


def hashtag(name: str | None) -> str | None:
    """«علی رضایی» → «علی_رضایی»; None when nothing usable is left."""
    if not name:
        return None
    tag = _HASHTAG_JUNK.sub("_", name).strip("_")[:60]
    return tag if tag and not tag.isdigit() else None


def rebrand(
    text: str,
    entities: list[dict[str, Any]],
    *,
    channel_username: str | None,
    author: str | None,
    channel_id_line: str,
    author_line: str,
) -> Styled:
    """The post without the source's IDs, signed for the target channel."""
    body = strip_ids(text, entities)
    lines = []
    tag = hashtag(author)
    if tag and author_line:
        lines.append(author_line.format(hashtag=tag))
    if channel_username and channel_id_line:
        lines.append(channel_id_line.format(username=channel_username))
    if not lines:
        return body
    joiner = "\n\n" if body.text else ""
    full = body.text + joiner + "\n".join(lines)
    extra = []
    prefix = _utf16_prefix(full)
    for match in re.finditer(r"#\w+|@[A-Za-z][A-Za-z0-9_]{3,31}", full[len(body.text) :]):
        start = len(body.text) + match.start()
        end = len(body.text) + match.end()
        extra.append(
            {
                "type": "hashtag" if match.group().startswith("#") else "mention",
                "offset": prefix[start],
                "length": prefix[end] - prefix[start],
            }
        )
    return Styled(full, [*body.entities, *extra])
