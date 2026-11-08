"""Offline OCR with Tesseract (spec §7.1, C5): photos and scanned PDFs (≤ OCR_MAX_PAGES pages, rendered
at 300 dpi). Auto mode: OSD finds the script and the page rotation; Arabic script → fas+eng (Persian
first), Latin → eng. The text is returned as `Result.text`; the runner delivers it like the bot's
Gemini OCR (in the message, or a .txt when long)."""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from . import imageio as io_
from . import pdfio
from . import tesseract as T
from .base import Input, Operation, Params, Processor, Result, ToolError

OCR_MAX_PAGES = 20
PDF_DPI = 300
BEST_MAX_PAGES = 5  # optional tessdata_best (TESSDATA_BEST_DIR) only on short jobs: ≈ 2× the time


class OcrP(Params):
    lang: Literal["auto", "fas", "ara", "eng", "deu", "fra", "spa", "tur"] = "auto"


def _pages(inp: Input, limits: dict, notes: list[str]):
    if inp.type == "pdf":
        doc = pdfio.open_pdf(inp.path)
        try:
            n = pdfio.page_count(doc)
            if n > OCR_MAX_PAGES:
                raise ToolError("OCR_TOO_MANY_PAGES", max=OCR_MAX_PAGES)
            for i in range(n):
                yield pdfio.render(doc, i, PDF_DPI, limits)
        finally:
            doc.close()
    else:
        im, _icc = io_.load(inp.path, inp.type, limits, notes)
        yield im


def ocr(inputs: list[Input], p: OcrP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    notes: list[str] = []
    texts: list[str] = []
    script = None
    langs = None
    pdf = inp.type == "pdf"
    best = True
    if pdf:
        doc = pdfio.open_pdf(inp.path)
        best = pdfio.page_count(doc) <= BEST_MAX_PAGES
        doc.close()
    for i, im in enumerate(_pages(inp, limits, notes)):
        # upright first (on the page as it is), then upscale + deskew: both measure text lines, which a
        # page turned by 90° doesn't have horizontally
        path = workdir / f"page{i}.png"
        im.convert("L").save(path)
        info = T.osd(path)
        rot = T.orientation(im, workdir, info=info)
        if rot in (90, 180, 270):
            im = im.rotate(-rot, expand=True, fillcolor=(255, 255, 255))
            if not info.get("script"):
                im.convert("L").save(path)
                info = T.osd(path) or info
        T.prepare(im).save(path)
        if langs is None and (info.get("script") or i == 0):
            script = info.get("script")
            langs = T.choose_langs(script, p.lang)
        # fast models by default; tessdata_best only if installed (TESSDATA_BEST_DIR) and ≤ BEST_MAX_PAGES
        text = T.recognize(path, langs, timeout=60, best=best)
        if p.lang == "auto" and not script and langs != "eng" and T.script_of(text) == "latin":
            langs = "eng"  # OSD needs more text than a short line; the first read shows the script
            text = T.recognize(path, langs, timeout=60, best=best)
        path.unlink(missing_ok=True)
        texts.append(f"— {i + 1} —\n{text}" if pdf else text)
    joined = "\n\n".join(t for t in texts if t.strip()).strip()
    if not joined or (pdf and all(len(t.split("\n", 1)[-1].strip()) == 0 for t in texts)):
        raise ToolError("OCR_NO_TEXT")
    return Result(text=joined, notes=notes, stats={"pages": len(texts), "langs": langs, "script": T.script_of(joined),
                                                   "models": "best" if best else "fast"})


PROCESSOR = Processor("ocr", [
    Operation("ocr", inputs=frozenset(io_.read_types()) | {"pdf"}, params=OcrP, fn=ocr, group="ocr", queue="heavy",
              requires=("tesseract",), timeout_s=60, timeout_per_page_s=25),
])
