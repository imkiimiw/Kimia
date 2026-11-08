"""PDF tools on the worker (spec §5, §7.4; C5): text extraction, PDF → images, compress, watermark
(Persian included) and unlock with a password. Libraries: pypdfium2 (render, text) and pikepdf/qpdf
(MPL-2.0 / Apache-2.0: rewrite, decrypt, compress)."""
from __future__ import annotations

import io
import unicodedata
import zipfile
import zlib
from pathlib import Path
from typing import Literal

import pikepdf
from PIL import Image, ImageDraw
from pydantic import Field

from . import imageio as io_
from . import pdfio
from . import textlayout as tl
from .base import Input, Operation, Output, Params, Processor, Result, ToolError

PDF = frozenset({"pdf"})
TEXT_MAX_PAGES = 500
IMAGES_MAX_PAGES = 50
SEND_SEPARATELY = 10


def _base(name: str) -> str:
    return io_.out_name(name, "", "x")[:-2]


def _check_pdf_output(path: Path) -> None:
    try:
        with pikepdf.open(path) as chk:
            if len(chk.pages) == 0:
                raise ToolError("OUTPUT_INVALID")
    except pikepdf.PdfError as exc:
        raise ToolError("OUTPUT_INVALID") from exc


def _open_pike(path: Path, password: str = "") -> pikepdf.Pdf:
    try:
        return pikepdf.open(path, password=password)
    except pikepdf.PasswordError as exc:
        raise ToolError("PDF_BAD_PASSWORD" if password else "PDF_ENCRYPTED") from exc
    except pikepdf.PdfError as exc:
        raise ToolError("PDF_DAMAGED") from exc


# ---- text extraction ------------------------------------------------------------------------------------
class TextP(Params):
    pass


_PRESENTATION = ("\U0000fb50", "\U0000fdff", "\U0000fe70", "\U0000feff")


def _presentation_share(text: str) -> float:
    arabic = [c for c in text if "\U00000600" <= c <= "\U000006ff" or _PRESENTATION[0] <= c <= _PRESENTATION[1]
              or _PRESENTATION[2] <= c <= _PRESENTATION[3]]
    if not arabic:
        return 0.0
    forms = sum(1 for c in arabic if c >= _PRESENTATION[0])
    return forms / len(arabic)


def extract_text(inputs: list[Input], p: TextP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    doc = pdfio.open_pdf(inp.path)
    try:
        n = pdfio.page_count(doc)
        parts, raw_all = [], []
        for i in range(min(n, TEXT_MAX_PAGES)):
            page = doc[i]
            tp = page.get_textpage()
            raw = tp.get_text_bounded()
            tp.close()
            page.close()
            raw_all.append(raw)
            text = unicodedata.normalize("NFKC", raw).replace("\r\n", "\n").replace("\r", "\n").strip()
            parts.append(f"— {i + 1} —\n{text}" if n > 1 else text)
    finally:
        doc.close()
    joined = "\n\n".join(parts).strip()
    if sum(len(x.strip()) for x in raw_all) < 3:
        raise ToolError("PDF_NO_TEXT")
    notes = []
    if n > TEXT_MAX_PAGES:
        notes.append("pdf_text_truncated")
    share = _presentation_share("".join(raw_all))
    if share > 0.3:
        notes.append("pdf_text_visual")  # Persian stored as shaped glyphs in visual order: OCR is better
    elif any("\U00000600" <= c <= "\U000006ff" for c in joined):
        notes.append("pdf_text_persian")
    path = workdir / "out0.txt"
    path.write_bytes(("\U0000feff" + joined + "\n").encode("utf-8"))
    out = Output(path=path, name=f"{_base(inp.name)}.txt", mime="text/plain", type="text")
    return Result(outputs=[out], notes=notes, stats={"pages": n, "chars": len(joined)})


# ---- PDF → images ----------------------------------------------------------------------------------------
class ImagesP(Params):
    dpi: Literal[100, 150, 200, 300] = 150
    format: Literal["jpg", "png"] = "jpg"


def to_images(inputs: list[Input], p: ImagesP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    base = _base(inp.name)
    doc = pdfio.open_pdf(inp.path)
    notes: list[str] = []
    try:
        n = pdfio.page_count(doc)
        if n > IMAGES_MAX_PAGES:
            raise ToolError("PDF_TOO_MANY_PAGES", max=IMAGES_MAX_PAGES, pages=n)
        width = len(str(n))
        files = []
        for i in range(n):
            im = pdfio.render(doc, i, p.dpi, limits)
            fmt = p.format
            path, out = io_.output(workdir, i, f"{base}_p{str(i + 1).zfill(width)}", "", fmt)
            io_.save(im, path, fmt, notes, quality=88)
            files.append(out)
    finally:
        doc.close()
    if len(files) <= SEND_SEPARATELY:
        return Result(outputs=files, notes=notes, stats={"pages": n})
    zpath = workdir / "pages.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_STORED) as z:  # images are compressed already
        for f in files:
            z.write(f.path, f.name)
            f.path.unlink()
    return Result(outputs=[Output(zpath, f"{base}_pages.zip", "application/zip", "zip")], notes=notes, stats={"pages": n})


# ---- compress ---------------------------------------------------------------------------------------------
class CompressP(Params):
    level: Literal["hi", "md", "lo"] = "md"


LEVELS = {"hi": (80, 2500), "md": (65, 1800), "lo": (45, 1200)}
_SKIP_FILTERS = {"/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode"}


def _filters(obj) -> set[str]:
    f = obj.get("/Filter")
    if f is None:
        return set()
    return {str(x) for x in f} if isinstance(f, pikepdf.Array) else {str(f)}


def compress(inputs: list[Input], p: CompressP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    quality, max_side = LEVELS[p.level]
    pdf = _open_pike(inp.path)
    seen: set = set()
    changed = 0
    with pdf:
        for page in pdf.pages:
            for _name, raw in page.get_images().items():
                key = raw.objgen
                if key in seen or key == (0, 0):
                    continue
                seen.add(key)
                if raw.get("/SMask") is not None or raw.get("/Mask") is not None or raw.get("/ImageMask"):
                    continue
                if _filters(raw) & _SKIP_FILTERS or int(raw.get("/BitsPerComponent", 8)) != 8:
                    continue
                try:
                    pim = pikepdf.PdfImage(raw)
                    if str(pim.colorspace) not in ("/DeviceRGB", "/DeviceGray"):
                        continue
                    im = pim.as_pil_image()
                except Exception:  # noqa: BLE001, S112 — an image we can't decode stays as it is
                    continue
                io_.check_size(*im.size, limits)
                if max(im.size) > max_side:
                    im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                im = im.convert("L" if im.mode in ("L", "1") else "RGB")
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=quality, optimize=True)
                data = buf.getvalue()
                if len(data) >= len(raw.read_raw_bytes()):
                    continue
                raw.write(data, filter=pikepdf.Name.DCTDecode)
                raw.Width, raw.Height = im.width, im.height
                raw.ColorSpace = pikepdf.Name.DeviceGray if im.mode == "L" else pikepdf.Name.DeviceRGB
                raw.BitsPerComponent = 8
                for k in ("/DecodeParms", "/Decode"):
                    if k in raw:
                        del raw[k]
                changed += 1
        pdf.remove_unreferenced_resources()
        path = workdir / "out0.pdf"
        pdf.save(path, object_stream_mode=pikepdf.ObjectStreamMode.generate, compress_streams=True,
                 recompress_flate=True)
    _check_pdf_output(path)
    before, after = inp.path.stat().st_size, path.stat().st_size
    if after >= before:
        return Result(outputs=[], notes=["compress_not_smaller"], stats={"before": before, "after": after})
    out = Output(path=path, name=f"{_base(inp.name)}_compressed.pdf", mime="application/pdf", type="pdf")
    return Result(outputs=[out], stats={"before": before, "after": after, "images": changed})


# ---- watermark --------------------------------------------------------------------------------------------
class WatermarkP(Params):
    text: str = Field(min_length=1, max_length=100)
    position: Literal["diag", "bottom", "top"] = "diag"
    opacity: int = Field(25, ge=5, le=100)
    color: Literal["gray", "red", "blue", "black"] = "gray"


COLORS = {"gray": (110, 110, 110), "red": (200, 30, 30), "blue": (30, 70, 200), "black": (0, 0, 0)}


def stamp_image(text: str, color: tuple[int, int, int], opacity: int, px: int) -> Image.Image:
    """The text as an RGBA image (RAQM-shaped, so Persian is correct)."""
    f = tl.font("vazirmatn", px, bold=True)
    d = tl.base_direction(text)
    w = int(tl.line_width(f, text, d)) + px
    asc, desc = f.getmetrics()
    im = Image.new("RGBA", (max(1, w), asc + desc + px // 2), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((px // 2, px // 4 + asc), text, font=f, fill=color + (round(255 * opacity / 100),), anchor="ls",
                            direction=d, language="fa" if d == "rtl" else None)
    return im


def _xobject(pdf: pikepdf.Pdf, rgba: Image.Image) -> pikepdf.Stream:
    rgb, alpha = rgba.convert("RGB"), rgba.getchannel("A")
    smask = pikepdf.Stream(pdf, zlib.compress(alpha.tobytes()), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                           Width=alpha.width, Height=alpha.height, ColorSpace=pikepdf.Name.DeviceGray, BitsPerComponent=8,
                           Filter=pikepdf.Name.FlateDecode)
    return pikepdf.Stream(pdf, zlib.compress(rgb.tobytes()), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                          Width=rgb.width, Height=rgb.height, ColorSpace=pikepdf.Name.DeviceRGB, BitsPerComponent=8,
                          Filter=pikepdf.Name.FlateDecode, SMask=smask)


def watermark(inputs: list[Input], p: WatermarkP, workdir: Path, limits: dict) -> Result:
    from .images import _prepare_text
    notes: list[str] = []
    text = _prepare_text(p.text, notes, 100).replace("\n", " ")
    inp = inputs[0]
    pdf = _open_pike(inp.path)
    with pdf:
        stamp = stamp_image(text, COLORS[p.color], p.opacity, 120)
        if p.position == "diag":
            stamp = stamp.rotate(35, expand=True, resample=Image.Resampling.BICUBIC)
        xobj = _xobject(pdf, stamp)
        sw, sh = stamp.size
        for page in pdf.pages:
            box = [float(v) for v in page.mediabox]
            pw, ph = box[2] - box[0], box[3] - box[1]
            rot = int(page.obj.get("/Rotate", 0)) % 360
            vw, vh = (ph, pw) if rot in (90, 270) else (pw, ph)  # the page as the reader sees it
            frac = 0.75 if p.position == "diag" else 0.6
            scale = min(vw * frac / sw, vh * (0.6 if p.position == "diag" else 0.08) / sh)
            w, h = sw * scale, sh * scale
            x = (vw - w) / 2
            y = (vh - h) / 2 if p.position == "diag" else (vh * 0.04 if p.position == "bottom" else vh * 0.96 - h)
            # map the upright placement back into the (possibly rotated) page space
            if rot == 0:
                m = (w, 0, 0, h, box[0] + x, box[1] + y)
            elif rot == 90:
                m = (0, w, -h, 0, box[0] + pw - y, box[1] + x)
            elif rot == 180:
                m = (-w, 0, 0, -h, box[0] + pw - x, box[1] + ph - y)
            else:
                m = (0, -w, h, 0, box[0] + y, box[1] + ph - x)
            name = page.add_resource(xobj, pikepdf.Name.XObject, prefix="Wm")
            page.contents_add(pikepdf.Stream(pdf, b"q\n"), prepend=True)
            cm = " ".join(f"{v:.4f}" for v in m)
            page.contents_add(pikepdf.Stream(pdf, f"Q\nq {cm} cm {name} Do Q\n".encode()), prepend=False)
        path = workdir / "out0.pdf"
        pdf.save(path)
    _check_pdf_output(path)
    out = Output(path=path, name=f"{_base(inp.name)}_watermarked.pdf", mime="application/pdf", type="pdf")
    return Result(outputs=[out], notes=notes)


# ---- unlock -----------------------------------------------------------------------------------------------
class UnlockP(Params):
    password: str = Field("", max_length=128)


def unlock(inputs: list[Input], p: UnlockP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    pdf = _open_pike(inp.path, p.password)
    with pdf:
        was = pdf.is_encrypted
        path = workdir / "out0.pdf"
        pdf.save(path)  # no `encryption=` → saved without it
    _check_pdf_output(path)
    out = Output(path=path, name=f"{_base(inp.name)}_unlocked.pdf", mime="application/pdf", type="pdf")
    return Result(outputs=[out], notes=[] if was else ["pdf_not_encrypted"])


PROCESSOR = Processor("pdf", [
    Operation("pdf.tx", inputs=PDF, params=TextP, fn=extract_text, group="pdf", requires=("pdfium",), timeout_per_page_s=1),
    Operation("pdf.im", inputs=PDF, params=ImagesP, fn=to_images, group="pdf", queue="heavy", requires=("pdfium",),
              timeout_per_page_s=3),
    Operation("pdf.cp", inputs=PDF, params=CompressP, fn=compress, group="pdf", queue="heavy", requires=("pikepdf",),
              timeout_per_page_s=2),
    Operation("pdf.wm", inputs=PDF, params=WatermarkP, fn=watermark, group="pdf", requires=("pikepdf", "raqm", "fonts"),
              timeout_per_page_s=1),
    Operation("pdf.ul", inputs=PDF, params=UnlockP, fn=unlock, group="pdf", requires=("pikepdf",)),
])
