"""PDF helpers shared by the PDF tools and OCR: open with pdfium (Apache-2.0/BSD) — never PyMuPDF or
Ghostscript (AGPL, spec §7.4) — map its errors to user-facing codes, render pages under the pixel cap."""
from __future__ import annotations

from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

from .base import ToolError


def open_pdf(path: Path, password: str | None = None) -> pdfium.PdfDocument:
    try:
        return pdfium.PdfDocument(str(path), password=password or None)
    except pdfium.PdfiumError as exc:
        msg = str(exc).lower()
        if "password" in msg:
            raise ToolError("PDF_BAD_PASSWORD" if password else "PDF_ENCRYPTED") from exc
        raise ToolError("PDF_DAMAGED") from exc


def page_count(doc: pdfium.PdfDocument) -> int:
    n = len(doc)
    if n <= 0:
        raise ToolError("PDF_DAMAGED")
    return n


def render(doc: pdfium.PdfDocument, index: int, dpi: int, limits: dict) -> Image.Image:
    """One page as an RGB image at `dpi`, lowered when the page would exceed MAX_IMAGE_PIXELS/MAX_SIDE."""
    page = doc[index]
    try:
        w_pt, h_pt = page.get_size()
        scale = dpi / 72
        max_px, max_side = int(limits["max_image_pixels"]), int(limits["max_side"])
        w, h = w_pt * scale, h_pt * scale
        if w <= 0 or h <= 0:
            raise ToolError("PDF_DAMAGED")
        shrink = min(1.0, max_side / max(w, h), (max_px / (w * h)) ** 0.5 * 0.995)  # pdfium rounds sizes up
        bitmap = page.render(scale=scale * shrink, rotation=0, fill_color=(255, 255, 255, 255))
        return bitmap.to_pil().convert("RGB")
    finally:
        page.close()
