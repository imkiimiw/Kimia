"""Text → image (spec §7.2): Persian-correct shaping (RAQM), presets, 8 themes, auto-fit, RTL-aware
wrapping and alignment. Emoji are removed with a note (no colour-emoji font is shipped)."""
from __future__ import annotations

from pathlib import Path
from typing import Literal

from PIL import Image, ImageDraw
from pydantic import Field

from . import imageio as io_
from . import textlayout as tl
from .base import Operation, Params, Processor, Result
from .images import _prepare_text, draw_lines

PRESETS = {"square": (1080, 1080), "post": (1080, 1350), "story": (1080, 1920), "wide": (1920, 1080)}
# theme → (top colour, bottom colour, text colour)
THEMES = {
    "light": ((255, 255, 255), (255, 255, 255), (31, 41, 55)),
    "dark": ((17, 24, 39), (17, 24, 39), (249, 250, 251)),
    "sepia": ((244, 236, 216), (236, 224, 196), (91, 70, 54)),
    "ocean": ((15, 32, 39), (44, 83, 100), (255, 255, 255)),
    "sunset": ((255, 126, 95), (254, 180, 123), (45, 27, 18)),
    "forest": ((27, 67, 50), (45, 106, 79), (241, 250, 238)),
    "rose": ((255, 240, 243), (255, 204, 213), (89, 13, 34)),
    "night": ((35, 37, 38), (65, 67, 69), (255, 209, 102)),
}
CAPS = {"s": 64, "m": 100, "l": 140}  # largest font size at 1080 px width
MAX_TEXT = 2000


class TtiP(Params):
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    preset: Literal["square", "post", "story", "wide"] = "square"
    theme: Literal["light", "dark", "sepia", "ocean", "sunset", "forest", "rose", "night"] = "light"
    font: Literal["vazirmatn", "sahel", "samim"] = "vazirmatn"
    align: Literal["auto", "center"] = "auto"
    size: Literal["s", "m", "l"] = "m"
    bold: bool = False
    format: Literal["png", "jpg"] = "png"


def background(size: tuple[int, int], top, bottom) -> Image.Image:
    if top == bottom:
        return Image.new("RGB", size, top)
    mask = Image.linear_gradient("L").resize(size)
    return Image.composite(Image.new("RGB", size, bottom), Image.new("RGB", size, top), mask)


def render(p: TtiP, notes: list[str]) -> Image.Image:
    text = _prepare_text(p.text, notes, MAX_TEXT)
    W, H = PRESETS[p.preset]
    top, bottom, fg = THEMES[p.theme]
    img = background((W, H), top, bottom)
    pad = int(min(W, H) * 0.08)
    box = (pad, pad, W - pad, H - pad)
    cap = int(CAPS[p.size] * min(W, H) / 1080)
    f, lines, lh = tl.fit(text, p.font, box[2] - box[0], box[3] - box[1], bold=p.bold, max_size=cap, min_size=12)
    if lh * len(lines) > box[3] - box[1]:
        notes.append("text_shrunk")
        lines = lines[: max(1, (box[3] - box[1]) // lh)]
    draw_lines(ImageDraw.Draw(img), lines, f, lh, box, fg, p.align)
    return img


def text_to_image(inputs, p: TtiP, workdir: Path, limits: dict) -> Result:
    notes: list[str] = []
    img = render(p, notes)
    path, out = io_.output(workdir, 0, "text", "", p.format)
    io_.save(img, path, p.format, notes, quality=95)
    return Result(outputs=[out], notes=notes, stats={"width": img.width, "height": img.height})


PROCESSOR = Processor("text_image", [
    Operation("tti", inputs=frozenset(), params=TtiP, fn=text_to_image, min_inputs=0, max_inputs=0,
              requires=("raqm", "fonts"), group="text"),
])
