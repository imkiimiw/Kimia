"""Shared image loading/saving rules (spec §7.1):
- dimensions checked from the header before decoding (MAX_IMAGE_PIXELS, MAX_SIDE); Pillow's
  decompression-bomb warning is an error (set in sandbox_entry);
- EXIF orientation applied, animated images use their first frame (with a note);
- CMYK (through its ICC profile when present), 16-bit, palette, 1-bit and other modes normalized;
- the ICC profile is kept (unless an operation strips it); EXIF is never copied to outputs —
  orientation is already applied and GPS/camera data stay private;
- transparency is flattened onto a background for formats without alpha (with a note);
- every output is re-opened and verified before it may be sent.
"""
from __future__ import annotations

import io
import re
from pathlib import Path

from PIL import Image, ImageOps, features

from .base import Output, ToolError

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF = True
except Exception:  # noqa: BLE001 — optional
    HEIF = False

READ_TYPES = frozenset({"jpeg", "png", "webp", "gif", "bmp", "tiff", "ico", "avif", "heic"})

# fmt id → (Pillow format, mime, extension, supports alpha, bot type id)
FORMATS = {
    "jpg": ("JPEG", "image/jpeg", "jpg", False, "jpeg"),
    "png": ("PNG", "image/png", "png", True, "png"),
    "webp": ("WEBP", "image/webp", "webp", True, "webp"),
    "gif": ("GIF", "image/gif", "gif", True, "gif"),
    "bmp": ("BMP", "image/bmp", "bmp", False, "bmp"),
    "tiff": ("TIFF", "image/tiff", "tiff", True, "tiff"),
    "ico": ("ICO", "image/x-icon", "ico", True, "ico"),
    "avif": ("AVIF", "image/avif", "avif", True, "avif"),
    "heic": ("HEIF", "image/heic", "heic", True, "heic"),
}
# The decoders Pillow may use for each detected type (Image.open(formats=…)): exotic decoders
# (FPX, SPIDER, XBM, PCX, WMF, …) are unreachable even if a file is crafted to look like them.
DECODERS = {"jpeg": ["JPEG", "MPO"], "png": ["PNG"], "webp": ["WEBP"], "gif": ["GIF"], "bmp": ["BMP", "DIB"],
            "tiff": ["TIFF"], "ico": ["ICO"], "avif": ["AVIF"], "heic": ["HEIF"]}
TYPE_TO_FMT = {"jpeg": "jpg", "png": "png", "webp": "webp", "gif": "gif", "bmp": "bmp", "tiff": "tiff",
               "ico": "ico", "avif": "avif", "heic": "heic"}


def write_formats() -> list[str]:
    out = ["jpg", "png", "webp", "gif", "bmp", "tiff", "ico"]
    if features.check("avif"):
        out.append("avif")
    if HEIF:
        out.append("heic")
    return out


def read_types() -> list[str]:
    out = sorted(READ_TYPES)
    if not features.check("avif"):
        out.remove("avif")
    if not HEIF:
        out.remove("heic")
    return out


def too_big(limits: dict) -> ToolError:
    return ToolError("IMAGE_TOO_BIG", mp=int(limits["max_image_pixels"]) // 1_000_000, side=int(limits["max_side"]))


def check_size(w: int, h: int, limits: dict) -> None:
    if w <= 0 or h <= 0:
        raise ToolError("IMAGE_DAMAGED")
    if w * h > int(limits["max_image_pixels"]) or max(w, h) > int(limits["max_side"]):
        raise too_big(limits)


def _to_8bit(im: Image.Image) -> Image.Image:
    if im.mode in ("I;16", "I;16B", "I;16L", "I;16N"):
        return im.convert("I").point(lambda v: v * (1 / 256)).convert("L")
    if im.mode == "I":
        lo, hi = im.getextrema()
        if hi > 255:
            scale = 255 / hi if hi > 0 else 1
            return im.point(lambda v: v * scale).convert("L")
        return im.convert("L")
    if im.mode == "F":
        return im.convert("L")
    return im


def normalize(im: Image.Image, icc: bytes | None) -> tuple[Image.Image, bytes | None]:
    """→ an RGB, RGBA or L image (+ the ICC profile that still applies to it)."""
    if im.mode == "CMYK":
        if icc:
            try:
                from PIL import ImageCms

                src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
                dst = ImageCms.createProfile("sRGB")
                return ImageCms.profileToProfile(im, src, dst, outputMode="RGB"), None
            except Exception:  # noqa: BLE001, S110 — a broken profile: plain conversion
                pass
        return im.convert("RGB"), None
    im = _to_8bit(im)
    if im.mode == "1":
        return im.convert("L"), icc
    if im.mode in ("P", "PA"):
        has_alpha = im.mode == "PA" or "transparency" in im.info
        return im.convert("RGBA" if has_alpha else "RGB"), icc
    if im.mode in ("LA", "La", "RGBa"):
        return im.convert("RGBA"), icc
    if im.mode in ("RGB", "RGBA", "L"):
        return im, icc
    return im.convert("RGB"), None  # RGBX, YCbCr, LAB, HSV …


def open_image(path: Path, type_: str) -> Image.Image:
    decoders = DECODERS.get(type_)
    if not decoders:
        raise ToolError("IMAGE_UNSUPPORTED")
    return Image.open(path, formats=decoders)


def load(path: Path, type_: str, limits: dict, notes: list[str]) -> tuple[Image.Image, bytes | None]:
    with open_image(path, type_) as im:
        check_size(*im.size, limits)
        if getattr(im, "n_frames", 1) > 1:
            if "animated_first_frame" not in notes:
                notes.append("animated_first_frame")
            im.seek(0)
        icc = im.info.get("icc_profile")
        im.load()
        out = ImageOps.exif_transpose(im)
        if out is im:
            out = im.copy()
    return normalize(out, icc)


def has_alpha(im: Image.Image) -> bool:
    if im.mode not in ("RGBA", "LA"):
        return False
    return im.getchannel("A").getextrema()[0] < 255


def flatten(im: Image.Image, background=(255, 255, 255)) -> Image.Image:
    if im.mode not in ("RGBA", "LA"):
        return im
    bg = Image.new("RGB", im.size, background)
    bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").getchannel("A"))
    return bg


def parse_color(hex_: str) -> tuple[int, int, int]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", hex_ or "")
    if not m:
        return (255, 255, 255)
    v = m.group(1)
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def save(im: Image.Image, path: Path, fmt: str, notes: list[str], quality: int = 90, icc: bytes | None = None,
         background=(255, 255, 255), optimize: bool = True) -> None:
    pil, _mime, _ext, alpha, _type = FORMATS[fmt]
    if not alpha and im.mode in ("RGBA", "LA"):
        if has_alpha(im) and "transparency_flattened" not in notes:
            notes.append("transparency_flattened")
        im = flatten(im, background)
    kw: dict = {}
    if icc and fmt in ("jpg", "png", "webp", "tiff", "avif", "heic"):
        kw["icc_profile"] = icc
    big = im.width * im.height > 4_000_000
    if fmt == "jpg":
        im = im if im.mode in ("RGB", "L") else im.convert("RGB")
        kw.update(quality=quality, optimize=optimize and not big, progressive=True)
    elif fmt == "png":
        kw.update(optimize=optimize and not big)
    elif fmt == "webp":
        kw.update(quality=quality, method=4)
    elif fmt == "gif":
        pass
    elif fmt == "bmp":
        im = im if im.mode in ("RGB", "L") else im.convert("RGB")
    elif fmt == "tiff":
        kw.update(compression="tiff_lzw")
    elif fmt == "ico":
        im = im.copy()
        im.thumbnail((256, 256), Image.Resampling.LANCZOS)
        side = max(im.size)
        kw["sizes"] = [(s, s) for s in (16, 24, 32, 48, 64, 128, 256) if s <= side] or [im.size]
    elif fmt in ("avif", "heic"):
        kw.update(quality=quality)
    im.save(path, format=pil, **kw)
    verify(path, [pil])


def verify(path: Path, formats: list[str] | None = None) -> None:
    """Re-open an output with the decoder of the format it must be in and let Pillow verify it."""
    try:
        if path.stat().st_size == 0:
            raise ToolError("OUTPUT_INVALID")
        with Image.open(path, formats=formats) as chk:
            chk.verify()
    except ToolError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ToolError("OUTPUT_INVALID") from exc


_UNSAFE = re.compile(r"[\U00000000-\U0000001f\U0000007f/\\:*?\"<>|]")
NAME_BASE_MAX = 64


def out_name(name: str, suffix: str, ext: str) -> str:
    """Like the bot's names.withSuffix: the input's base (≤ 64 chars incl. the suffix) + suffix + ext."""
    clean = _UNSAFE.sub("_", name).strip(" .")
    m = re.fullmatch(r"(.+)\.([A-Za-z0-9]{1,16})", clean)
    base = (m.group(1) if m else clean).strip(" .") or "image"
    room = max(1, NAME_BASE_MAX - len(suffix))
    return f"{base[:room]}{suffix}.{ext}"


def output(workdir: Path, index: int, name: str, suffix: str, fmt: str) -> tuple[Path, Output]:
    pil, mime, ext, _a, type_ = FORMATS[fmt]
    path = workdir / f"out{index}.{ext}"
    return path, Output(path=path, name=out_name(name, suffix, ext), mime=mime, type=type_)


def keep_format(type_: str) -> str:
    """The output format for an in-place edit: the input's own, when writable."""
    fmt = TYPE_TO_FMT.get(type_, "png")
    if fmt not in write_formats():
        return "jpg" if fmt == "heic" else "png"
    if fmt == "ico":
        return "png"  # ICO caps at 256 px: an edit keeps full size
    return fmt
