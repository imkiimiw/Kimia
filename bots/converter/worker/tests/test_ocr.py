import json
import shutil

import pytest
from PIL import Image, ImageDraw

from app.processors import ocr as O
from app.processors import tesseract as T
from app.processors import textlayout as tl
from app.processors.base import Input, ToolError
from tests.conftest import LIMITS
from tests.pdf_fixtures import image_pdf

pytestmark = pytest.mark.skipif(not shutil.which("tesseract") or "fas" not in T.available().get("langs", []),
                                reason="Tesseract with fas is not installed")


def page(text="سلام دنیا، آزمایش ۱۴۰۵", size=46, w=1100, h=260):
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    f = tl.font("vazirmatn", size)
    d.text((w - 40, h // 2), text, font=f, fill="black", anchor="rm", direction="rtl", language="fa")
    return im


def run(tmp_path, data, type_="png", name="scan.png", lang="auto"):
    p = tmp_path / f"in_{name}"
    p.write_bytes(data)
    wd = tmp_path / "wd"
    wd.mkdir(exist_ok=True)
    return O.ocr([Input(p, name, type_)], O.OcrP(lang=lang), wd, LIMITS)


def png(im):
    import io
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def test_persian_photo(tmp_path):
    res = run(tmp_path, png(page("کتابخانه ملی ایران در سال ۱۳۱۶ تأسیس شد", 44, 1300)))
    assert "کتابخانه ملی" in res.text and "سال ۱۳۱۶" in res.text
    assert res.stats["langs"] == "fas+eng" and res.stats["script"] == "fa"


def test_rotated_page_is_turned_upright(tmp_path):
    lines = ["کتابخانه ملی ایران در سال ۱۳۱۶ تأسیس شد", "و امروز بیش از ده میلیون منبع دارد",
             "پژوهشگران نسخه\U0000200cهای خطی را می\U0000200cبینند", "تالار مطالعه هر روز باز است"]
    im = Image.new("RGB", (1300, 900), "white")
    d = ImageDraw.Draw(im)
    for k, ln in enumerate(lines):
        d.text((1260, 150 + k * 160), ln, font=tl.font("vazirmatn", 52), fill="black", anchor="rm", direction="rtl", language="fa")
    for deg in (90, 180):
        res = run(tmp_path, png(im.rotate(deg, expand=True)))
        assert "کتابخانه" in res.text and "میلیون" in res.text, deg


def test_english_and_user_language(tmp_path):
    im = Image.new("RGB", (900, 200), "white")
    ImageDraw.Draw(im).text((30, 70), "Invoice number 4821", font=tl.font("vazirmatn", 48), fill="black")
    res = run(tmp_path, png(im))
    assert "Invoice number 4821" in res.text and res.stats["langs"] == "eng"
    assert T.choose_langs("Arabic", "ara") == "ara+eng" and T.choose_langs("Latin", "deu") == "deu+eng"
    assert T.choose_langs(None, "auto") == "fas+eng"


def test_scanned_pdf_pages_and_limits(tmp_path):
    res = run(tmp_path, image_pdf([page("این صفحه\U0000200cی نخست سند است"), page("و این صفحه\U0000200cی پایانی سند است")]), "pdf", "scan.pdf")
    first, second = res.text.split("— 2 —")
    assert first.startswith("— 1 —") and "نخست" in first and "پایانی" in second
    assert res.stats["models"] in ("best", "fast")
    with pytest.raises(ToolError) as e:
        run(tmp_path, image_pdf([Image.new("RGB", (50, 50), "white")] * 21), "pdf", "long.pdf")
    assert e.value.code == "OCR_TOO_MANY_PAGES" and e.value.vars == {"max": 20}


def test_blank_image_has_no_text(tmp_path):
    with pytest.raises(ToolError) as e:
        run(tmp_path, png(Image.new("RGB", (600, 400), "white")))
    assert e.value.code == "OCR_NO_TEXT"


def test_preprocessing_steps():
    small = page("متن ریز", 14, 300, 60).convert("L")
    assert T.line_height(small) < T.SMALL_LINE_PX and T.upscale(small).width > small.width
    big = page().convert("L")
    assert T.upscale(big) is big
    tilted = page("یک خط متن نسبتاً بلند برای آزمایش کجی", 40, 1400, 300).convert("L").rotate(3, expand=True, fillcolor=255)
    assert 2 <= abs(T.skew_angle(tilted)) <= 4


def test_benchmark_set_is_reproducible():
    from pathlib import Path
    f = Path(__file__).resolve().parents[1] / "bench" / "set" / "truth.json"
    if not f.exists():
        pytest.skip("the benchmark set isn't part of the image")
    assert len(json.loads(f.read_text(encoding="utf-8"))) == 24
