"""Golden-ish checks that Persian is shaped, ordered and wrapped correctly (spec §7.2). Exact pixel
hashes would break on every FreeType/HarfBuzz update, so these assert properties that only hold when
shaping and bidi really work."""
import pytest
from PIL import Image, ImageChops, ImageDraw, ImageFont

from app.processors import text_image as tti
from app.processors import textlayout as tl
from app.processors.base import ToolError

pytestmark = pytest.mark.skipif(not tl.raqm_available(), reason="RAQM missing: text features are disabled")


@pytest.fixture(scope="module")
def f():
    return tl.font("vazirmatn", 48)


def test_lam_alef_ligature_is_narrower_than_its_letters(f):
    assert f.getlength("لا", direction="rtl") < f.getlength("ل") + f.getlength("ا")


def test_letters_join(f):
    word = "سلام"
    assert f.getlength(word, direction="rtl") < sum(f.getlength(c) for c in word) * 0.9


def render(text, direction, font, size=(400, 80)):
    img = Image.new("L", size, 0)
    ImageDraw.Draw(img).text((10, 60), text, font=font, fill=255, anchor="ls", direction=direction)
    return img


def same(a, b):
    diff = ImageChops.difference(a, b)
    return diff.getbbox() is None or sum(diff.histogram()[64:]) < 20


def test_bidi_puts_numbers_left_of_persian_words(f):
    visual = render("12 ب", "ltr", f)  # what correct bidi must look like
    assert same(render("ب 12", "rtl", f), visual)
    basic = ImageFont.truetype(str(tl.FONTS_DIR / "Vazirmatn-Regular.ttf"), 48, layout_engine=ImageFont.Layout.BASIC)
    assert not same(render("ب 12", None, basic), visual)  # without RAQM the order is wrong


def test_paragraph_direction_orders_mixed_runs(f):
    visual = render("دنیا Hello", "ltr", f)
    assert same(render("Hello دنیا", "rtl", f), visual)
    assert not same(render("Hello دنیا", "ltr", f), visual)


def test_every_persian_letter_and_digit_has_a_glyph():
    missing = render("\U0000e000", "ltr", tl.font("vazirmatn", 32), (60, 60))  # private use → .notdef box
    chars = "ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهیءآأؤئ" + "۰۱۲۳۴۵۶۷۸۹" + "،؛؟"
    for name in tl.FONTS:
        font = tl.font(name, 32)
        for ch in chars:
            glyph = render(ch, "rtl", font, (60, 60))
            assert glyph.getbbox() is not None, (name, ch)
            assert ImageChops.difference(glyph, missing).getbbox() is not None, f"tofu: {name} {ch!r}"


def test_zwnj_keeps_letters_apart(f):
    joined = f.getlength("میشود", direction="rtl")
    apart = f.getlength("می\U0000200cشود", direction="rtl")
    assert apart > joined


def test_wrap_keeps_words_whole_and_lines_inside(f):
    text = "این یک متن طولانی فارسی است که باید در چند خط شکسته شود و هیچ کلمه\U0000200cای نصفه نماند"
    lines = tl.wrap(text, f, 300)
    assert len(lines) > 2
    assert all(tl.line_width(f, s, d) <= 300 for s, d in lines)
    assert " ".join(s for s, _ in lines) == text
    assert {d for _, d in lines} == {"rtl"}


def test_direction_follows_the_first_strong_letter():
    assert tl.base_direction("123 سلام") == "rtl"
    assert tl.base_direction("Hello سلام") == "ltr"
    assert tl.base_direction("۱۲۳") == "ltr"


def test_bidi_overrides_are_removed():
    assert tl.clean("a\U0000202eb\U00002066c") == "abc"


def test_auto_fit_gives_short_text_a_bigger_font():
    short = tl.fit("سلام", "vazirmatn", 800, 800, max_size=200)
    long = tl.fit("سلام " * 200, "vazirmatn", 800, 800, max_size=200)
    assert short[0].size > long[0].size
    f_long, lines, lh = long
    assert lh * len(lines) <= 800


@pytest.mark.parametrize("preset", list(tti.PRESETS))
@pytest.mark.parametrize("theme", list(tti.THEMES))
def test_every_preset_and_theme_renders(preset, theme):
    img = tti.render(tti.TtiP(text="سلام دنیا Hello", preset=preset, theme=theme), [])
    assert img.size == tti.PRESETS[preset]
    bg = tti.THEMES[theme][0]
    assert ImageChops.difference(img, Image.new("RGB", img.size, bg)).getbbox() is not None


def test_rtl_text_is_right_aligned_in_auto_mode():
    img = tti.render(tti.TtiP(text="سلام", preset="wide", theme="dark", size="s"), [])
    box = ImageChops.difference(img, Image.new("RGB", img.size, tti.THEMES["dark"][0])).getbbox()
    pad = int(1080 * 0.08)
    assert box[2] >= img.width - pad - 4 and box[0] > img.width // 2


def test_emoji_note_and_limits(tmp_path):
    notes = []
    tti.render(tti.TtiP(text="سلام 🌹"), notes)
    assert notes == ["emoji_removed"]
    with pytest.raises(ToolError) as e:
        tti.render(tti.TtiP(text="🌹 🌹"), [])
    assert e.value.code == "NO_TEXT"


def test_operation_writes_a_verified_png(tmp_path):
    res = tti.text_to_image([], tti.TtiP(text="آزمایش", format="jpg"), tmp_path, {})
    [o] = res.outputs
    assert o.name == "text.jpg" and o.mime == "image/jpeg"
    with Image.open(o.path) as im:
        assert im.size == (1080, 1080)
