"""Source-channel posts re-sent without the source's Telegram IDs (owner's decision)."""

from __future__ import annotations

from wanger_news.domain.rebrand import hashtag, rebrand, strip_ids


def u16(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def piece(text: str, entity: dict[str, object]) -> str:
    raw = text.encode("utf-16-le")
    start, length = int(entity["offset"]), int(entity["length"])  # type: ignore[call-overload]
    return raw[start * 2 : (start + length) * 2].decode("utf-16-le")


def test_ids_go_formatting_and_website_links_stay() -> None:
    head = "🔥 خبر مهم امروز\nجزئیات در "
    text = head + "وبسایت\n\n🆔 @source_ch\nعضو شوید: https://t.me/source_ch"
    entities = [
        {"type": "bold", "offset": u16("🔥 "), "length": u16("خبر مهم")},
        {"type": "text_link", "offset": u16(head), "length": 6, "url": "https://example.com/a"},
        {"type": "mention", "offset": u16(head + "وبسایت\n\n🆔 "), "length": 10},
    ]
    out = strip_ids(text, entities)
    assert out.text == "🔥 خبر مهم امروز\nجزئیات در وبسایت"
    assert [piece(out.text, e) for e in out.entities] == ["خبر مهم", "وبسایت"]
    assert out.entities[1]["url"] == "https://example.com/a"


def test_links_to_channels_and_user_accounts_are_removed() -> None:
    text = "متن کامل را اینجا بخوانید و با علی تماس بگیرید."
    entities = [
        {"type": "text_link", "offset": 11, "length": 5, "url": "https://t.me/source_ch/12"},
        {"type": "text_mention", "offset": 30, "length": 3, "user": {"id": 1, "first_name": "A"}},
    ]
    out = strip_ids(text, entities)
    assert "اینجا" not in out.text and "علی" in out.text
    assert out.entities == []


def test_plain_ids_without_entities_and_telegram_me() -> None:
    out = strip_ids("خبر\nکانال ما: telegram.me/abc_news\nتماس: @abc_admin", [])
    assert out.text == "خبر"


def test_signature_lines_and_hashtag() -> None:
    out = rebrand(
        "سلام",
        [],
        channel_username="maghsad98",
        author="Ali Rezaei‌ (admin)",
        channel_id_line="🆔 @{username}",
        author_line="✍️ #{hashtag}",
    )
    assert out.text == "سلام\n\n✍️ #Ali_Rezaei_admin\n🆔 @maghsad98"
    assert [(e["type"], piece(out.text, e)) for e in out.entities] == [
        ("hashtag", "#Ali_Rezaei_admin"),
        ("mention", "@maghsad98"),
    ]
    assert hashtag("علی رضایی") == "علی_رضایی" and hashtag("۱۲۳") is None and hashtag("") is None
    bare = rebrand(
        "سلام",
        [],
        channel_username=None,
        author=None,
        channel_id_line="🆔 @{username}",
        author_line="✍️ #{hashtag}",
    )
    assert bare.text == "سلام"
