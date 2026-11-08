import zipfile

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageChops

from app.processors import pdftools as P
from app.processors.base import Input, ToolError
from tests.conftest import LIMITS
from tests.pdf_fixtures import encrypt, image_pdf, noisy_image, text_pdf


def inp(tmp_path, data, name="doc.pdf"):
    p = tmp_path / f"in_{name}"
    p.write_bytes(data)
    return [Input(p, name, "pdf")]


def out_dir(tmp_path):
    d = tmp_path / "out"
    d.mkdir(exist_ok=True)
    return d


def render(path, i=0):
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[i].render(scale=1).to_pil().convert("L")
    finally:
        doc.close()


def test_text_extraction_with_page_markers(tmp_path):
    res = P.extract_text(inp(tmp_path, text_pdf(pages=2)), P.TextP(), out_dir(tmp_path), LIMITS)
    [o] = res.outputs
    text = o.path.read_bytes().decode("utf-8-sig")
    assert o.name == "doc.txt" and o.type == "text"
    assert "— 1 —" in text and "Hello PDF 2026 2" in text and res.stats["pages"] == 2
    assert res.notes == []


def test_scanned_pdf_has_no_text_and_says_so(tmp_path):
    with pytest.raises(ToolError) as e:
        P.extract_text(inp(tmp_path, image_pdf([Image.new("RGB", (300, 300), "white")])), P.TextP(), out_dir(tmp_path), LIMITS)
    assert e.value.code == "PDF_NO_TEXT"


def test_presentation_forms_are_detected():
    assert P._presentation_share("\U0000fef3\U0000fe8e\U0000fedf\U0000fe8e") == 1.0
    assert P._presentation_share("سلام") == 0.0
    assert P._presentation_share("hello") == 0.0


def test_pdf_to_images_separate_and_zip(tmp_path):
    res = P.to_images(inp(tmp_path, text_pdf(pages=3), "r.pdf"), P.ImagesP(dpi=100, format="png"), out_dir(tmp_path), LIMITS)
    assert [o.name for o in res.outputs] == ["r_p1.png", "r_p2.png", "r_p3.png"]
    with Image.open(res.outputs[0].path) as im:
        assert im.size == (850, 1100)  # 8.5 × 11 in at 100 dpi
    res = P.to_images(inp(tmp_path, text_pdf(pages=12), "big.pdf"), P.ImagesP(dpi=100), out_dir(tmp_path), LIMITS)
    [z] = res.outputs
    assert z.name == "big_pages.zip" and z.type == "zip"
    with zipfile.ZipFile(z.path) as zf:
        names = zf.namelist()
    assert len(names) == 12 and names[0] == "big_p01.jpg" and names[-1] == "big_p12.jpg"


def test_pdf_to_images_page_cap_and_pixel_cap(tmp_path):
    with pytest.raises(ToolError) as e:
        P.to_images(inp(tmp_path, text_pdf(pages=51)), P.ImagesP(), out_dir(tmp_path), LIMITS)
    assert e.value.code == "PDF_TOO_MANY_PAGES" and e.value.vars == {"max": 50, "pages": 51}
    small = {**LIMITS, "max_image_pixels": 200_000}
    res = P.to_images(inp(tmp_path, text_pdf()), P.ImagesP(dpi=300, format="png"), out_dir(tmp_path), small)
    with Image.open(res.outputs[0].path) as im:
        assert im.width * im.height <= 200_000


def test_compress_shrinks_images_or_says_it_cant(tmp_path):
    big = image_pdf([noisy_image()])
    res = P.compress(inp(tmp_path, big), P.CompressP(level="lo"), out_dir(tmp_path), LIMITS)
    assert res.outputs and res.stats["after"] < res.stats["before"] / 2 and res.stats["images"] == 1
    with pikepdf.open(res.outputs[0].path) as pdf:
        assert len(pdf.pages) == 1
    res = P.compress(inp(tmp_path, text_pdf()), P.CompressP(), out_dir(tmp_path), LIMITS)
    assert res.outputs == [] and res.notes == ["compress_not_smaller"]


@pytest.mark.parametrize("rotate", [0, 90])
def test_watermark_persian_on_every_page_even_rotated(tmp_path, rotate):
    src = image_pdf([Image.new("RGB", (600, 800), "white")] * 2, rotate=rotate)
    res = P.watermark(inp(tmp_path, src), P.WatermarkP(text="محرمانه — Wanger", opacity=60, color="red"), out_dir(tmp_path), LIMITS)
    [o] = res.outputs
    assert o.name == "doc_watermarked.pdf"
    before = inp(tmp_path, src)[0].path
    for i in (0, 1):
        a, b = render(before, i), render(o.path, i)
        assert a.size == b.size
        diff = ImageChops.difference(a, b).getbbox()
        assert diff is not None, "nothing drawn"
        cx, cy = b.width / 2, b.height / 2
        assert diff[0] < cx < diff[2] and diff[1] < cy < diff[3], "the diagonal mark crosses the centre"


def test_unlock_with_the_right_password_only(tmp_path):
    locked = encrypt(text_pdf())
    with pytest.raises(ToolError) as e:
        P.unlock(inp(tmp_path, locked), P.UnlockP(password="wrong"), out_dir(tmp_path), LIMITS)
    assert e.value.code == "PDF_BAD_PASSWORD"
    res = P.unlock(inp(tmp_path, locked), P.UnlockP(password="secret"), out_dir(tmp_path), LIMITS)
    with pikepdf.open(res.outputs[0].path) as pdf:
        assert not pdf.is_encrypted
    # other tools refuse an encrypted PDF clearly
    for fn, p in ((P.extract_text, P.TextP()), (P.compress, P.CompressP()), (P.to_images, P.ImagesP())):
        with pytest.raises(ToolError) as e:
            fn(inp(tmp_path, locked), p, out_dir(tmp_path), LIMITS)
        assert e.value.code == "PDF_ENCRYPTED"


def test_owner_only_restrictions_are_removed_without_a_password(tmp_path):
    res = P.unlock(inp(tmp_path, encrypt(text_pdf(), user="")), P.UnlockP(), out_dir(tmp_path), LIMITS)
    with pikepdf.open(res.outputs[0].path) as pdf:
        assert not pdf.is_encrypted
    res = P.unlock(inp(tmp_path, text_pdf()), P.UnlockP(), out_dir(tmp_path), LIMITS)
    assert res.notes == ["pdf_not_encrypted"]


def test_damaged_pdf(tmp_path):
    for fn, p in ((P.extract_text, P.TextP()), (P.compress, P.CompressP()), (P.unlock, P.UnlockP())):
        with pytest.raises(ToolError) as e:
            fn(inp(tmp_path, b"%PDF-1.7\nnot really"), p, out_dir(tmp_path), LIMITS)
        assert e.value.code == "PDF_DAMAGED"
