"""Image tools (spec §7.1, C4). Op ids are short so they fit in callback_data."""
from __future__ import annotations

import struct
from pathlib import Path
from typing import Literal, Optional

from PIL import Image, ImageDraw, ImageFilter, ImageOps
from pydantic import Field

from . import imageio as io_
from . import textlayout as tl
from .base import Input, Operation, Params, Processor, Result, ToolError

HEX = r"^#?[0-9a-fA-F]{6}$"
FONT = Literal["vazirmatn", "sahel", "samim"]


def _one(inputs: list[Input], limits: dict, notes: list[str]):
    inp = inputs[0]
    im, icc = io_.load(inp.path, inp.type, limits, notes)
    return inp, im, icc


def _result(outputs, notes, **stats) -> Result:
    return Result(outputs=outputs, notes=notes, stats=stats)


def _edit(inputs, workdir, limits, suffix, transform, fmt: str | None = None, quality: int = 92) -> Result:
    """Load one image → transform(im) → save in its own format (or fmt)."""
    notes: list[str] = []
    inp, im, icc = _one(inputs, limits, notes)
    out_im = transform(im, notes)
    io_.check_size(*out_im.size, limits)
    fmt = fmt or io_.keep_format(inp.type)
    path, out = io_.output(workdir, 0, inp.name, suffix, fmt)
    io_.save(out_im, path, fmt, notes, quality=quality, icc=icc)
    return _result([out], notes, width=out_im.width, height=out_im.height)


# ---- convert --------------------------------------------------------------------------------------
class ConvertP(Params):
    format: Literal["jpg", "png", "webp", "gif", "bmp", "tiff", "ico", "avif", "heic"]
    quality: int = Field(90, ge=1, le=100)
    background: str = Field("#ffffff", pattern=HEX)


def convert(inputs, p: ConvertP, workdir: Path, limits: dict) -> Result:
    if p.format not in io_.write_formats():
        raise ToolError("IMAGE_UNSUPPORTED")
    notes: list[str] = []
    inp, im, icc = _one(inputs, limits, notes)
    path, out = io_.output(workdir, 0, inp.name, "", p.format)
    io_.save(im, path, p.format, notes, quality=p.quality, icc=icc, background=io_.parse_color(p.background))
    return _result([out], notes, width=im.width, height=im.height)


# ---- resize ---------------------------------------------------------------------------------------
class ResizeP(Params):
    mode: Literal["percent", "width", "height", "fit", "exact"] = "percent"
    percent: int = Field(50, ge=1, le=400)
    width: Optional[int] = Field(None, ge=1, le=20000)
    height: Optional[int] = Field(None, ge=1, le=20000)
    upscale: bool = False


def target_size(w: int, h: int, p: ResizeP) -> tuple[int, int]:
    if p.mode == "percent":
        return max(1, round(w * p.percent / 100)), max(1, round(h * p.percent / 100))
    if p.mode == "width":
        if not p.width:
            raise ToolError("BAD_PARAMS")
        return p.width, max(1, round(h * p.width / w))
    if p.mode == "height":
        if not p.height:
            raise ToolError("BAD_PARAMS")
        return max(1, round(w * p.height / h)), p.height
    if not p.width or not p.height:
        raise ToolError("BAD_PARAMS")
    if p.mode == "exact":
        return p.width, p.height
    scale = min(p.width / w, p.height / h)  # fit inside the box, aspect kept
    return max(1, round(w * scale)), max(1, round(h * scale))


def _resample(im: Image.Image, size: tuple[int, int]) -> Image.Image:
    if im.mode == "RGBA":  # premultiplied, so transparent edges don't turn dark
        return im.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    return im.resize(size, Image.Resampling.LANCZOS)


def resize(inputs, p: ResizeP, workdir: Path, limits: dict) -> Result:
    def tf(im, notes):
        w, h = target_size(im.width, im.height, p)
        if (w > im.width or h > im.height) and not p.upscale:
            notes.append("no_upscale")
            if p.mode == "exact":
                w, h = min(w, im.width), min(h, im.height)
            else:
                scale = min(1.0, im.width / w, im.height / h)
                w, h = max(1, round(w * scale)), max(1, round(h * scale))
        io_.check_size(w, h, limits)
        return im if (w, h) == im.size else _resample(im, (w, h))
    return _edit(inputs, workdir, limits, "_resized", tf)


# ---- crop -------------------------------------------------------------------------------------------
class CropP(Params):
    ratio: Literal["1:1", "4:3", "3:4", "16:9", "9:16", "4:5", "3:2", "2:3"] = "1:1"
    gravity: Literal["center", "top", "bottom", "left", "right"] = "center"


def crop_box(w: int, h: int, ratio: str, gravity: str) -> tuple[int, int, int, int]:
    a, b = (int(x) for x in ratio.split(":"))
    if w * b > h * a:  # too wide: cut the sides
        cw, ch = max(1, h * a // b), h
    else:
        cw, ch = w, max(1, w * b // a)
    x = (w - cw) // 2
    y = (h - ch) // 2
    if gravity == "top":
        y = 0
    elif gravity == "bottom":
        y = h - ch
    elif gravity == "left":
        x = 0
    elif gravity == "right":
        x = w - cw
    return x, y, x + cw, y + ch


def crop(inputs, p: CropP, workdir: Path, limits: dict) -> Result:
    return _edit(inputs, workdir, limits, "_cropped", lambda im, n: im.crop(crop_box(im.width, im.height, p.ratio, p.gravity)))


# ---- rotate / flip -----------------------------------------------------------------------------------
class RotateP(Params):
    angle: int = Field(90, ge=-359, le=359)  # clockwise degrees
    background: str = Field("#ffffff", pattern=HEX)


def rotate(inputs, p: RotateP, workdir: Path, limits: dict) -> Result:
    def tf(im, notes):
        a = p.angle % 360
        exact = {90: Image.Transpose.ROTATE_270, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_90}
        if a == 0:
            return im
        if a in exact:  # lossless pixel moves
            return im.transpose(exact[a])
        if im.mode == "RGBA":
            fill = (0, 0, 0, 0)
        elif im.mode == "L":
            fill = sum(io_.parse_color(p.background)) // 3
        else:
            fill = io_.parse_color(p.background)
        return im.rotate(-a, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=fill)
    return _edit(inputs, workdir, limits, "_rotated", tf)


class FlipP(Params):
    axis: Literal["h", "v"] = "h"


def flip(inputs, p: FlipP, workdir: Path, limits: dict) -> Result:
    t = Image.Transpose.FLIP_LEFT_RIGHT if p.axis == "h" else Image.Transpose.FLIP_TOP_BOTTOM
    return _edit(inputs, workdir, limits, "_flipped", lambda im, n: im.transpose(t))


# ---- compress -------------------------------------------------------------------------------------
class CompressP(Params):
    quality: int = Field(75, ge=10, le=95)
    max_side: Optional[int] = Field(None, ge=64, le=20000)
    format: Literal["keep", "jpg", "webp"] = "keep"


def compress(inputs, p: CompressP, workdir: Path, limits: dict) -> Result:
    notes: list[str] = []
    inp, im, icc = _one(inputs, limits, notes)
    if p.max_side and max(im.size) > p.max_side:
        scale = p.max_side / max(im.size)
        im = _resample(im, (max(1, round(im.width * scale)), max(1, round(im.height * scale))))
    if p.format != "keep":
        fmt = p.format
    else:
        fmt = io_.keep_format(inp.type)
        if fmt in ("bmp", "tiff", "gif"):
            fmt = "png"
    candidates: list[tuple[int, Path]] = []
    path, out = io_.output(workdir, 0, inp.name, "_compressed", fmt)
    io_.save(im, path, fmt, notes, quality=p.quality, icc=icc)
    candidates.append((path.stat().st_size, path))
    if fmt == "png" and p.quality <= 80 and im.width * im.height <= 12_000_000:
        # lossy PNG: a 256-colour palette (with alpha when needed), kept only when smaller
        q = (im if im.mode == "RGBA" else im.convert("RGB")).quantize(
            256, method=Image.Quantize.FASTOCTREE if im.mode == "RGBA" else Image.Quantize.MEDIANCUT)
        alt = workdir / "out0_q.png"
        q.save(alt, format="PNG", optimize=True)
        io_.verify(alt, ["PNG"])
        candidates.append((alt.stat().st_size, alt))
    size, best = min(candidates)
    if best != path:
        best.replace(path)
    original = inp.path.stat().st_size
    if size >= original:
        notes.append("compress_not_smaller")
        return _result([], notes, before=original, after=size)
    return _result([out], notes, before=original, after=size)


# ---- strip metadata --------------------------------------------------------------------------------
class StripP(Params):
    keep_icc: bool = True


_JPEG_DROP = {0xE1, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEF, 0xFE}
_PNG_DROP = {b"tEXt", b"zTXt", b"iTXt", b"eXIf", b"tIME"}


def _orientation(path: Path, type_: str) -> int:
    try:
        with io_.open_image(path, type_) as im:
            return int(im.getexif().get(0x0112, 1) or 1)
    except Exception:  # noqa: BLE001
        return 1


def strip_jpeg(data: bytes, keep_icc: bool, orientation: int) -> bytes:
    """Lossless: drop APP1 (EXIF/XMP), APP3–APP13 (IPTC …), APP15 and comments; keep JFIF, Adobe
    (colour transform) and — unless asked — the ICC profile. A non-default orientation survives as a
    minimal EXIF block so the photo still displays upright without re-encoding."""
    if data[:2] != b"\xff\xd8":
        raise ToolError("IMAGE_DAMAGED")
    out = bytearray(b"\xff\xd8")
    if orientation != 1:
        ex = Image.Exif()
        ex[0x0112] = orientation
        blob = b"Exif\x00\x00" + ex.tobytes()
        out += b"\xff\xe1" + struct.pack(">H", len(blob) + 2) + blob
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            raise ToolError("IMAGE_DAMAGED")
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker == 0xDA:  # start of scan: the rest is image data
            out += data[i:]
            return bytes(out)
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            out += data[i:i + 2]
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        seg = data[i:i + 2 + length]
        drop = marker in _JPEG_DROP or (marker == 0xE2 and (not keep_icc or not seg[4:16].startswith(b"ICC_PROFILE")))
        if not drop:
            out += seg
        i += 2 + length
    raise ToolError("IMAGE_DAMAGED")


def strip_png(data: bytes, keep_icc: bool) -> bytes:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ToolError("IMAGE_DAMAGED")
    out = bytearray(data[:8])
    i = 8
    while i + 8 <= len(data):
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        chunk = data[i:i + 12 + length]
        if len(chunk) < 12 + length:
            raise ToolError("IMAGE_DAMAGED")
        if kind not in _PNG_DROP and not (kind == b"iCCP" and not keep_icc):
            out += chunk
        i += 12 + length
        if kind == b"IEND":
            return bytes(out)
    raise ToolError("IMAGE_DAMAGED")


def strip(inputs, p: StripP, workdir: Path, limits: dict) -> Result:
    inp = inputs[0]
    notes = ["metadata_removed"]
    with io_.open_image(inp.path, inp.type) as probe:  # dimensions/format sanity before touching bytes
        io_.check_size(*probe.size, limits)
    if inp.type in ("jpeg", "png"):
        data = inp.path.read_bytes()
        fmt = "jpg" if inp.type == "jpeg" else "png"
        new = strip_jpeg(data, p.keep_icc, _orientation(inp.path, inp.type)) if fmt == "jpg" else strip_png(data, p.keep_icc)
        path, out = io_.output(workdir, 0, inp.name, "_clean", fmt)
        path.write_bytes(new)
        io_.verify(path, io_.DECODERS[inp.type])
        return _result([out], notes, before=len(data), after=len(new), lossless=True)
    sub: list[str] = []
    inp_, im, icc = _one(inputs, limits, sub)
    fmt = io_.keep_format(inp.type)
    path, out = io_.output(workdir, 0, inp.name, "_clean", fmt)
    io_.save(im, path, fmt, sub, quality=95, icc=icc if p.keep_icc else None)
    return _result([out], notes + sub, lossless=False)


# ---- colour filters -----------------------------------------------------------------------------------
class NoP(Params):
    pass


def grayscale(inputs, p: NoP, workdir: Path, limits: dict) -> Result:
    def tf(im, notes):
        if im.mode == "RGBA":
            return Image.merge("LA", (im.convert("L"), im.getchannel("A"))).convert("RGBA")
        return im.convert("L")
    return _edit(inputs, workdir, limits, "_gray", tf)


class BlurP(Params):
    radius: float = Field(4, ge=0.5, le=50)


def blur(inputs, p: BlurP, workdir: Path, limits: dict) -> Result:
    def tf(im, notes):
        r = p.radius * max(1.0, max(im.size) / 2000)  # same look on big photos
        return im.filter(ImageFilter.GaussianBlur(r))
    return _edit(inputs, workdir, limits, "_blurred", tf)


class SharpenP(Params):
    amount: int = Field(150, ge=10, le=500)


def sharpen(inputs, p: SharpenP, workdir: Path, limits: dict) -> Result:
    return _edit(inputs, workdir, limits, "_sharp",
                 lambda im, n: im.filter(ImageFilter.UnsharpMask(radius=2, percent=p.amount, threshold=3)))


class ColorP(Params):
    mode: Literal["bw", "sepia", "invert", "cmyk", "rgb"] = "sepia"


def color_mode(inputs, p: ColorP, workdir: Path, limits: dict) -> Result:
    notes: list[str] = []
    inp, im, icc = _one(inputs, limits, notes)
    fmt = io_.keep_format(inp.type)
    alpha = im.getchannel("A") if im.mode == "RGBA" else None
    rgb = io_.flatten(im) if im.mode == "RGBA" else im.convert("RGB")
    if p.mode == "bw":
        out_im = rgb.convert("L").convert("1", dither=Image.Dither.FLOYDSTEINBERG).convert("L")
    elif p.mode == "sepia":
        gray = rgb.convert("L")
        out_im = ImageOps.colorize(gray, black=(40, 26, 13), white=(255, 240, 192), mid=(160, 120, 80))
    elif p.mode == "invert":
        out_im = ImageOps.invert(rgb)
    elif p.mode == "cmyk":
        out_im = rgb.convert("CMYK")
        if fmt not in ("jpg", "tiff"):
            fmt = "jpg"
        alpha = None
        icc = None
    else:
        out_im = rgb
    if alpha is not None and p.mode != "cmyk":
        out_im = out_im.convert("RGBA")
        out_im.putalpha(alpha)
    path, out = io_.output(workdir, 0, inp.name, f"_{p.mode}", fmt)
    if p.mode == "cmyk":
        pil = io_.FORMATS[fmt][0]
        out_im.save(path, format=pil, **({"quality": 92} if fmt == "jpg" else {"compression": "tiff_lzw"}))
        io_.verify(path, [pil])
    else:
        io_.save(out_im, path, fmt, notes, quality=92, icc=icc)
    return _result([out], notes)


# ---- text on images (need RAQM) ------------------------------------------------------------------------
def _prepare_text(text: str, notes: list[str], max_len: int) -> str:
    text = tl.clean(text)
    text, had = tl.strip_emoji(text)
    if had:
        notes.append("emoji_removed")
    text = "\n".join(" ".join(line.split()) for line in text.split("\n")).strip()
    if len(text) > max_len:
        raise ToolError("TEXT_TOO_LONG", max=max_len)
    if not text:
        raise ToolError("NO_TEXT")
    return text


def draw_lines(draw: ImageDraw.ImageDraw, lines, f, lh: int, box: tuple[int, int, int, int], fill,
               align: str = "center", stroke: int = 0, stroke_fill=None) -> None:
    x0, y0, x1, y1 = box
    ascent, descent = f.getmetrics()
    total = lh * len(lines)
    y = y0 + max(0, (y1 - y0 - total) // 2)
    for s, d in lines:
        w = tl.line_width(f, s, d)
        if align == "center":
            x = x0 + (x1 - x0 - w) / 2
        elif (align == "auto" and d == "rtl") or align == "right":
            x = x1 - w
        else:
            x = x0
        base = y + (lh - (ascent + descent)) / 2 + ascent
        if s:
            draw.text((x, base), s, font=f, fill=fill, anchor="ls", direction=d,
                      language="fa" if d == "rtl" else None, stroke_width=stroke, stroke_fill=stroke_fill)
        y += lh


SIZES = {"s": 0.035, "m": 0.055, "l": 0.085}
COLORS = {"white": ((255, 255, 255), (0, 0, 0)), "black": ((0, 0, 0), (255, 255, 255)),
          "yellow": ((255, 214, 10), (0, 0, 0))}


class WatermarkP(Params):
    text: str = Field(min_length=1, max_length=100)
    position: Literal["br", "bl", "tr", "tl", "c", "tile"] = "br"
    opacity: int = Field(50, ge=10, le=100)
    size: Literal["s", "m", "l"] = "m"
    color: Literal["white", "black"] = "white"
    font: FONT = "vazirmatn"


def watermark(inputs, p: WatermarkP, workdir: Path, limits: dict) -> Result:
    notes: list[str] = []
    text = _prepare_text(p.text, notes, 100).replace("\n", " ")
    inp, im, icc = _one(inputs, limits, notes)
    base = im.convert("RGBA")
    W, H = base.size
    size = max(12, int(min(W, H) * SIZES[p.size]))
    f = tl.font(p.font, size, bold=True)
    d = tl.base_direction(text)
    fill, shadow = COLORS[p.color]
    a = round(255 * p.opacity / 100)
    stroke = max(1, size // 18)
    tw = int(tl.line_width(f, text, d)) + 2 * stroke + 2
    asc, desc = f.getmetrics()
    th = asc + desc + 2 * stroke + 2
    stamp = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    ImageDraw.Draw(stamp).text((stroke + 1, stroke + 1 + asc), text, font=f, fill=fill + (a,), anchor="ls", direction=d,
                               language="fa" if d == "rtl" else None, stroke_width=stroke, stroke_fill=shadow + (a // 2,))
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    margin = max(8, int(min(W, H) * 0.03))
    if p.position == "tile":
        tile = stamp.rotate(30, expand=True, resample=Image.Resampling.BICUBIC)
        step_x, step_y = tile.width + margin * 3, tile.height + margin * 3
        for row, y in enumerate(range(-tile.height // 2, H, step_y)):
            for x in range(-tile.width // 2 + (step_x // 2 if row % 2 else 0), W, step_x):
                layer.paste(tile, (x, y))  # tiles never overlap: a plain copy (clipped at the edges)
    else:
        if tw > W - 2 * margin:  # never wider than the photo
            scale = (W - 2 * margin) / tw
            stamp = stamp.resize((max(1, int(tw * scale)), max(1, int(th * scale))), Image.Resampling.LANCZOS)
        sw, sh = stamp.size
        pos = {"br": (W - sw - margin, H - sh - margin), "bl": (margin, H - sh - margin),
               "tr": (W - sw - margin, margin), "tl": (margin, margin), "c": ((W - sw) // 2, (H - sh) // 2)}[p.position]
        layer.alpha_composite(stamp, (max(0, pos[0]), max(0, pos[1])))
    out_im = Image.alpha_composite(base, layer)
    if im.mode != "RGBA":
        out_im = out_im.convert("RGB")
    fmt = io_.keep_format(inp.type)
    path, out = io_.output(workdir, 0, inp.name, "_watermarked", fmt)
    io_.save(out_im, path, fmt, notes, quality=92, icc=icc)
    return _result([out], notes)


class TextP(Params):
    text: str = Field(min_length=1, max_length=500)
    position: Literal["top", "bottom", "center"] = "bottom"
    size: Literal["s", "m", "l"] = "m"
    color: Literal["white", "black", "yellow"] = "white"
    band: bool = True
    font: FONT = "vazirmatn"


def add_text(inputs, p: TextP, workdir: Path, limits: dict) -> Result:
    notes: list[str] = []
    text = _prepare_text(p.text, notes, 500)
    inp, im, icc = _one(inputs, limits, notes)
    base = im.convert("RGBA")
    W, H = base.size
    frac = {"s": 0.18, "m": 0.28, "l": 0.42}[p.size]
    pad = max(8, int(min(W, H) * 0.03))
    box_h = max(24, int(H * frac))
    box_w = W - 2 * pad
    cap = max(14, int(min(W, H) * {"s": 0.06, "m": 0.09, "l": 0.13}[p.size]))
    f, lines, lh = tl.fit(text, p.font, box_w, box_h - pad, bold=True, max_size=cap, min_size=12)
    used_h = lh * len(lines) + pad
    if used_h > box_h:
        notes.append("text_shrunk")
    top = {"top": 0, "bottom": H - min(H, used_h + pad), "center": (H - used_h) // 2}[p.position]
    bottom = min(H, top + used_h + pad)
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    fill, shadow = COLORS[p.color]
    if p.band:
        draw.rectangle((0, top, W, bottom), fill=shadow + (140,))
    draw_lines(draw, lines, f, lh, (pad, top + pad // 2, W - pad, bottom - pad // 2), fill + (255,), "center",
               stroke=0 if p.band else max(1, lh // 22), stroke_fill=shadow + (255,))
    out_im = Image.alpha_composite(base, layer)
    if im.mode != "RGBA":
        out_im = out_im.convert("RGB")
    fmt = io_.keep_format(inp.type)
    path, out = io_.output(workdir, 0, inp.name, "_text", fmt)
    io_.save(out_im, path, fmt, notes, quality=92, icc=icc)
    return _result([out], notes)


def _ops() -> list[Operation]:
    R = frozenset(io_.read_types())
    L = dict(inputs=R, group="image")
    return [
        Operation("img.cv", params=ConvertP, fn=convert, **L),
        Operation("img.rs", params=ResizeP, fn=resize, **L),
        Operation("img.cr", params=CropP, fn=crop, **L),
        Operation("img.ro", params=RotateP, fn=rotate, **L),
        Operation("img.fl", params=FlipP, fn=flip, **L),
        Operation("img.cp", params=CompressP, fn=compress, **L),
        Operation("img.sm", params=StripP, fn=strip, **L),
        Operation("img.gr", params=NoP, fn=grayscale, **L),
        Operation("img.bl", params=BlurP, fn=blur, **L),
        Operation("img.sh", params=SharpenP, fn=sharpen, **L),
        Operation("img.cm", params=ColorP, fn=color_mode, **L),
        Operation("img.wm", params=WatermarkP, fn=watermark, requires=("raqm", "fonts"), **L),
        Operation("img.tx", params=TextP, fn=add_text, requires=("raqm", "fonts"), **L),
    ]


PROCESSOR = Processor("images", _ops())
