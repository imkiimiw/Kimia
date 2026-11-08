"""Processor registry and capabilities (spec §8): operations come from processor modules; at start-up a
self-test decides which engine features exist, and only operations whose requirements are met are
announced to the bot. New tools = new modules listed in MODULES."""
from __future__ import annotations

import importlib
import io

from .config import VERSION
from .processors.base import Operation

MODULES = ("app.processors.images", "app.processors.text_image", "app.processors.pdftools", "app.processors.ocr")


def load_operations(extra: tuple[str, ...] | list[str] = ()) -> dict[str, Operation]:
    ops: dict[str, Operation] = {}
    for name in (*MODULES, *extra):
        mod = importlib.import_module(name)
        for op in mod.PROCESSOR.operations:
            if op.id in ops:
                raise RuntimeError(f"duplicate operation id {op.id}")
            if len(op.id) > 8:
                raise RuntimeError(f"operation id too long for callback_data: {op.id}")
            ops[op.id] = op
    return ops


def self_test() -> dict[str, bool]:
    """Exercise each engine feature once (not just 'is the module importable')."""
    from PIL import Image, ImageDraw, features

    from .processors import imageio, textlayout

    out = {"pillow": True, "raqm": False, "fonts": textlayout.fonts_available(), "webp": False, "avif": False,
           "heif": imageio.HEIF, "pdfium": False, "pikepdf": False, "tesseract": False}
    try:
        if features.check("raqm") and out["fonts"]:
            f = textlayout.font("vazirmatn", 24)
            img = Image.new("L", (120, 40), 0)
            ImageDraw.Draw(img).text((2, 2), "سلام", font=f, fill=255, direction="rtl")
            # shaping works: the joined word is narrower than its isolated letters
            joined = f.getlength("سلام", direction="rtl")
            apart = sum(f.getlength(c, direction="rtl") for c in "سلام")
            out["raqm"] = joined < apart and img.getbbox() is not None
    except Exception:  # noqa: BLE001
        out["raqm"] = False
    for key, fmt in (("webp", "WEBP"), ("avif", "AVIF")):
        try:
            buf = io.BytesIO()
            Image.new("RGB", (8, 8), (200, 10, 10)).save(buf, format=fmt)
            buf.seek(0)
            Image.open(buf).load()
            out[key] = True
        except Exception:  # noqa: BLE001
            out[key] = False
    if out["heif"]:
        try:
            buf = io.BytesIO()
            Image.new("RGB", (16, 16), (10, 200, 10)).save(buf, format="HEIF")
            buf.seek(0)
            Image.open(buf).load()
        except Exception:  # noqa: BLE001
            out["heif"] = False
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument.new()
        doc.new_page(200, 200)
        buf = io.BytesIO()
        doc.save(buf)
        out["pdfium"] = len(pdfium.PdfDocument(buf.getvalue())) == 1
    except Exception:  # noqa: BLE001
        out["pdfium"] = False
    try:
        import pikepdf

        with pikepdf.new() as p:
            p.add_blank_page()
            buf = io.BytesIO()
            p.save(buf)
        out["pikepdf"] = buf.getvalue().startswith(b"%PDF")
    except Exception:  # noqa: BLE001
        out["pikepdf"] = False
    from .processors import tesseract

    tess = tesseract.available()
    out["tesseract"] = bool(tess.get("langs")) and {"fas", "eng"} <= set(tess.get("langs", []))
    out["ocr_langs"] = tess.get("langs", [])
    out["ocr_best"] = tess.get("best", [])
    out["tesseract_version"] = tess.get("version")
    return out


def available(ops: dict[str, Operation], feats: dict[str, bool]) -> dict[str, Operation]:
    return {k: op for k, op in ops.items() if all(feats.get(r) is True for r in op.requires)}


def capabilities(ops: dict[str, Operation], feats: dict[str, bool], limits: dict) -> dict:
    from .processors import imageio

    writes = [f for f in imageio.write_formats() if not (f == "avif" and not feats["avif"])
              and not (f == "heic" and not feats["heif"]) and not (f == "webp" and not feats["webp"])]
    return {
        "version": VERSION,
        "features": feats,
        "ops": {k: {"group": op.group, "queue": op.queue, "inputs": sorted(op.inputs), "min_inputs": op.min_inputs,
                    "max_inputs": op.max_inputs} for k, op in sorted(available(ops, feats).items())},
        "formats": {"image_read": imageio.read_types(), "image_write": writes},
        "ocr": {"langs": [x for x in feats.get("ocr_langs", []) if x != "osd"], "max_pages": 20},
        "limits": limits,
    }
