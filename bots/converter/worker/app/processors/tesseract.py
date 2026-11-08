"""Tesseract OCR (spec §7.1, C5): preprocessing (EXIF transpose, grayscale, upscale of small text,
deskew, optional adaptive threshold), OSD script detection and the language choice. Tesseract is
called as a program (no Python binding needed) inside the sandboxed child, one thread, with a timeout."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path

from PIL import Image, ImageFilter, ImageMath, ImageOps, ImageStat

from .base import ToolError

LANGS = ("fas", "eng", "ara", "deu", "fra", "spa", "tur")
# Optional (docs/OCR_BENCHMARK.md: not better on average, worse on short lines, 2× slower).
TESSDATA_BEST = Path(os.environ.get("TESSDATA_BEST_DIR", "/nonexistent-tessdata-best"))
_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "OMP_THREAD_LIMIT": "1", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
TESSERACT = shutil.which("tesseract", path=_ENV["PATH"]) or "/usr/bin/tesseract"  # absolute: never a PATH lookup


def available() -> dict:
    """{'version': '5.3.4', 'langs': [...]} or {} when Tesseract isn't installed."""
    try:
        v = subprocess.run([TESSERACT, "--version"], capture_output=True, text=True, timeout=10, env=_ENV)
        langs = subprocess.run([TESSERACT, "--list-langs"], capture_output=True, text=True, timeout=10, env=_ENV)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    m = re.search(r"tesseract\s+v?([\d.]+)", v.stdout + v.stderr)
    have = set(langs.stdout.split()[1:] if langs.stdout else [])
    best = {p.stem for p in TESSDATA_BEST.glob("*.traineddata")} if TESSDATA_BEST.is_dir() else set()
    return {"version": m.group(1) if m else "?", "langs": sorted(have & set(LANGS)), "osd": "osd" in have,
            "best": sorted(best & set(LANGS))}


# ---- preprocessing --------------------------------------------------------------------------------
# Measured on the benchmark set (docs/OCR_BENCHMARK.md): upscaling by image width hurt large text and
# a white fill after rotation hurt photos, so every step is decided per image.
TARGET_LINE_PX = 42  # ink height of a text line after upscaling (about 20–30 px x-height)
SMALL_LINE_PX = 20  # lines lower than this are upscaled (measured: 14–16 px lines gain, 22–30 px lines lose)


def _ink_rows(gray: Image.Image) -> list[int]:
    """Heights of the horizontal bands that hold ink (text lines), on a ≤ 1600-px copy."""
    scale = min(1.0, 1600 / max(gray.size))
    small = gray if scale == 1.0 else gray.resize((max(1, round(gray.width * scale)), max(1, round(gray.height * scale))))
    bg = ImageStat.Stat(small).median[0]
    ink = small.point(lambda v: 255 if v < bg - 50 else 0)
    col = ink.resize((1, ink.height), Image.Resampling.BOX)
    profile = col.get_flattened_data() if hasattr(col, "get_flattened_data") else col.getdata()
    runs, cur = [], 0
    for v in profile:
        if v > 3:
            cur += 1
        elif cur:
            runs.append(cur)
            cur = 0
    if cur:
        runs.append(cur)
    return [round(r / scale) for r in runs if r >= 3]


def line_height(gray: Image.Image) -> int | None:
    runs = sorted(_ink_rows(gray))
    return runs[len(runs) // 2] if runs else None


def upscale(gray: Image.Image, max_factor: float = 3.0) -> Image.Image:
    """Small text (lines < TARGET_LINE_PX) is enlarged; normal and large text is left alone."""
    h = line_height(gray)
    if not h or h >= SMALL_LINE_PX:
        return gray
    f = min(max_factor, TARGET_LINE_PX / h)
    return gray.resize((round(gray.width * f), round(gray.height * f)), Image.Resampling.LANCZOS)


def skew_angle(gray: Image.Image, span: float = 6.0, step: float = 0.5) -> float:
    """Degrees to rotate (counter-clockwise) so text lines are horizontal: the angle whose row
    profile is the most uneven (lines of ink vs gaps). Pillow only: row means via a 1-px-wide resize."""
    small = gray.copy()
    small.thumbnail((900, 900))
    bg = ImageStat.Stat(small).median[0]
    ink = small.point(lambda v: 255 if v < bg - 50 else 0)
    best, best_var = 0.0, -1.0
    a = -span
    while a <= span + 1e-9:
        rot = ink.rotate(a, resample=Image.Resampling.NEAREST, expand=False, fillcolor=0)
        var = ImageStat.Stat(rot.resize((1, rot.height), Image.Resampling.BOX)).var[0]
        if var > best_var:
            best, best_var = a, var
        a += step
    return best


def deskew(gray: Image.Image) -> Image.Image:
    a = skew_angle(gray)
    if abs(a) < 0.5:
        return gray
    bg = int(ImageStat.Stat(gray).median[0])  # the page's own colour, not white wedges
    return gray.rotate(a, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=bg)


def uneven_light(gray: Image.Image) -> bool:
    """A photo with a shadow/gradient: the background (text blurred away) varies a lot."""
    small = gray.copy()
    small.thumbnail((400, 400))
    back = small.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(12))
    lo, hi = back.getextrema()
    return hi - lo > 45


def adaptive_threshold(gray: Image.Image, offset: int = 12) -> Image.Image:
    """Local-mean threshold (uneven lighting in photos): ink where the pixel is darker than its
    neighbourhood by more than `offset`. The window follows the text size."""
    h = line_height(gray) or 40
    mean = gray.filter(ImageFilter.BoxBlur(max(8, h)))
    out = ImageMath.lambda_eval(lambda a: ((a["g"] - a["m"] + offset) > 0) * 255, g=gray, m=mean)
    return out.convert("L")


def crop_to_text(gray: Image.Image) -> Image.Image:
    """Crop to the ink plus a margin: Tesseract's layout analysis splits a lone Persian line in a wide
    white page into nonsense blocks (measured), and cropping fixes it."""
    bg = ImageStat.Stat(gray).median[0]
    box = gray.point(lambda v: 255 if v < bg - 50 else 0).getbbox()
    if not box:
        return gray
    m = max(20, (line_height(gray) or 40) // 2)
    box = (max(0, box[0] - m), max(0, box[1] - m), min(gray.width, box[2] + m), min(gray.height, box[3] + m))
    if (box[2] - box[0]) * (box[3] - box[1]) > 0.9 * gray.width * gray.height:
        return gray
    return gray.crop(box)


def prepare(im: Image.Image, *, do_upscale=True, do_deskew=True, threshold: bool | None = False, crop=True) -> Image.Image:
    """The measured pipeline: upscale small text + deskew. Thresholding is off by default — on the
    benchmark it lowered accuracy (Tesseract binarizes itself); None = only with uneven lighting."""
    gray = ImageOps.grayscale(im if im.mode != "RGBA" else _flatten(im))
    if do_upscale:
        gray = upscale(gray)
    if do_deskew:
        gray = deskew(gray)
    if threshold or (threshold is None and uneven_light(gray)):
        gray = adaptive_threshold(gray)
    if crop:
        gray = crop_to_text(gray)
    return gray


def _flatten(im: Image.Image) -> Image.Image:
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, mask=im.getchannel("A"))
    return bg


# ---- running Tesseract -------------------------------------------------------------------------------
def _run(args: list[str], timeout: float) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([TESSERACT, *args], capture_output=True, timeout=timeout, env=_ENV)
    except subprocess.TimeoutExpired as exc:
        raise ToolError("TIMEOUT") from exc
    except OSError as exc:
        raise ToolError("OCR_ENGINE_MISSING") from exc


def osd(path: Path, timeout: float = 20) -> dict:
    """{'rotate': deg clockwise to fix, 'script': 'Arabic'|'Latin'|…, 'conf': float} or {} (too little text)."""
    r = _run([str(path), "stdout", "--psm", "0", "-l", "osd"], timeout)
    out = r.stdout.decode("utf-8", "replace")
    rot = re.search(r"Rotate:\s*(\d+)", out)
    oconf = re.search(r"Orientation confidence:\s*([\d.]+)", out)
    script = re.search(r"Script:\s*(\w+)", out)
    conf = re.search(r"Script confidence:\s*([\d.]+)", out)
    if not script:
        return {}
    return {"rotate": int(rot.group(1)) if rot else 0, "orient_conf": float(oconf.group(1)) if oconf else 0.0,
            "script": script.group(1), "conf": float(conf.group(1)) if conf else 0.0}


def sideways(gray: Image.Image) -> bool:
    """Text lines run vertically (a page turned by 90°): the column profile of the ink is far more
    uneven than the row profile."""
    small = gray.copy()
    small.thumbnail((800, 800))
    bg = ImageStat.Stat(small).median[0]
    ink = small.point(lambda v: 255 if v < bg - 50 else 0)
    rows = ImageStat.Stat(ink.resize((1, ink.height), Image.Resampling.BOX)).var[0]
    cols = ImageStat.Stat(ink.resize((ink.width, 1), Image.Resampling.BOX)).var[0]
    return cols > 2.5 * max(rows, 1e-6)


def mean_conf(path: Path, langs: str, timeout: float) -> float:
    """Tesseract's mean word confidence (0–100) for a quick read; fast models."""
    r = _run([str(path), "stdout", "-l", langs, "--psm", "3", "--oem", "1", "tsv"], timeout)
    confs = []
    for line in r.stdout.decode("utf-8", "replace").splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) >= 12 and cols[11].strip():
            try:
                c = float(cols[10])
            except ValueError:
                continue
            if c >= 0:
                confs.append(c)
    return sum(confs) / len(confs) if confs else 0.0


def orientation(im: Image.Image, work: Path, langs: str = "fas+eng", info: dict | None = None) -> int:
    """Degrees (clockwise) that turn the page upright. OSD first; OSD can't read sideways Persian
    ("Too few characters"), so a page whose lines run vertically is read both ways and the more
    confident reading wins."""
    gray = ImageOps.grayscale(im)
    path = work / "osd.png"
    gray.save(path)
    info = osd(path) if info is None else info
    if info.get("rotate") in (0, 90, 180, 270) and info.get("orient_conf", 0) >= 2.0:
        return info["rotate"]
    if not sideways(gray):
        return 0
    small = gray.copy()
    small.thumbnail((1400, 1400))
    best, best_conf = 0, -1.0
    for deg in (90, 270):
        small.rotate(-deg, expand=True, fillcolor=255).save(path)
        c = mean_conf(path, langs, 30)
        if c > best_conf:
            best, best_conf = deg, c
    return best


def choose_langs(script: str | None, user_lang: str) -> str:
    """Spec §7.1: Arabic script → fas+eng (Persian first; the user can pick Arabic), Latin → eng plus the
    user's chosen language. Script detection can't tell Persian from Arabic."""
    if user_lang == "ara":
        return "ara+eng"
    if user_lang == "fas":
        return "fas+eng"
    if user_lang in ("deu", "fra", "spa", "tur"):
        return f"{user_lang}+eng"
    if user_lang == "eng":
        return "eng"
    if script == "Latin":
        return "eng"
    return "fas+eng"


def single_line(gray: Image.Image) -> bool:
    return len(_ink_rows(gray)) == 1


def recognize(path: Path, langs: str, timeout: float, psm: int | None = None, best: bool = False) -> str:
    """psm None: 7 (one text line) when the image holds a single line — the automatic layout (3) splits a
    lone Persian line into nonsense blocks (measured) — else 3."""
    if psm is None:
        with Image.open(path) as im:
            psm = 7 if single_line(im.convert("L")) else 3
    args = [str(path), "stdout", "-l", langs, "--psm", str(psm), "--oem", "1"]
    if best and TESSDATA_BEST.is_dir() and all((TESSDATA_BEST / f"{lang}.traineddata").exists() for lang in langs.split("+")):
        args += ["--tessdata-dir", str(TESSDATA_BEST)]
    r = _run(args, timeout)
    if r.returncode != 0:
        raise ToolError("OCR_FAILED")
    return clean_text(r.stdout.decode("utf-8", "replace"))


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text).replace("\x0c", "")
    lines = [ln.rstrip() for ln in text.splitlines()]
    out = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", out)


def script_of(text: str) -> str:
    """'fa' (Arabic script), 'latin' or 'mixed' — like the bot's gemini.scriptOf."""
    arabic = sum(1 for c in text if "\U00000600" <= c <= "\U000006ff" or "\U0000fb50" <= c <= "\U0000feff")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    if arabic and latin and min(arabic, latin) / max(arabic, latin) > 0.15:
        return "mixed"
    return "fa" if arabic >= latin else "latin"
