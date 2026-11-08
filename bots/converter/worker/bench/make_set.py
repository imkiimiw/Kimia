"""Builds the OCR benchmark set (docs/OCR_BENCHMARK.md): rendered Persian, English and mixed texts in
three conditions — `screen` (a clean screenshot), `small` (small text at screen resolution) and
`photo` (rotated, blurred, unevenly lit, noisy, JPEG) — with the exact ground truth next to each image.
Synthetic on purpose: the ground truth is exact and the set is reproducible (seeded)."""
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.processors import textlayout as tl  # noqa: E402

OUT = Path(__file__).resolve().parent / "set"
Z = "\U0000200c"
TEXTS = {
    "fa1": f"کتاب{Z}خانه{Z}ی ملی ایران در سال ۱۳۱۶ تأسیس شد و امروز بیش از ده میلیون منبع دارد.\nپژوهشگران می{Z}توانند نسخه{Z}های خطی را در تالار مطالعه ببینند.",
    "fa2": f"هوا امروز ابری است و احتمال بارش باران در نیمه{Z}ی دوم روز وجود دارد.\nدمای هوا بین ۸ تا ۱۴ درجه{Z}ی سانتی{Z}گراد خواهد بود.",
    "fa3": f"برای ثبت{Z}نام در دوره، فرم را تکمیل کنید و رسید پرداخت را بفرستید.\nمهلت ثبت{Z}نام تا پایان آبان است.",
    "fa4": "شعر فارسی از دیرباز جایگاه ویژه\U0000200cای در فرهنگ ایرانیان داشته است.\nحافظ و سعدی هنوز در خانه\U0000200cهای بسیاری خوانده می\U0000200cشوند.".replace("\U0000200c", Z),
    "en1": "The quick brown fox jumps over the lazy dog.\nInvoice number 4821, due on 15 March 2026.",
    "en2": "Please keep this receipt for your records.\nTotal amount: 1,250.00 USD including tax.",
    "mx1": f"نسخه{Z}ی جدید Wanger Converter از فرمت PDF و DOCX پشتیبانی می{Z}کند.\nکد پیگیری: WC-7K3P9Q",
    "mx2": "جلسه\U0000200cی بعدی روز دوشنبه ساعت ۱۰:۳۰ در اتاق 204 برگزار می\U0000200cشود.\nایمیل: info@example.com".replace("\U0000200c", Z),
}
FONTS = ["vazirmatn", "sahel", "samim"]


def render(text: str, font_name: str, size: int, width: int) -> Image.Image:
    f = tl.font(font_name, size)
    lines = tl.wrap(text, f, width - 2 * size)
    lh = int(size * 1.6)
    img = Image.new("RGB", (width, lh * len(lines) + 2 * size), "white")
    d = ImageDraw.Draw(img)
    asc, desc = f.getmetrics()
    y = size
    for s, direction in lines:
        w = tl.line_width(f, s, direction)
        x = width - size - w if direction == "rtl" else size
        d.text((x, y + (lh - asc - desc) / 2 + asc), s, font=f, fill=(20, 20, 20), anchor="ls", direction=direction,
               language="fa" if direction == "rtl" else None)
        y += lh
    return img


def photo(img: Image.Image, rng: random.Random) -> Image.Image:
    img = img.rotate(rng.uniform(-3, 3), resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(235, 235, 230))
    w, h = img.size
    light = Image.linear_gradient("L").rotate(rng.choice([0, 90, 180, 270])).resize((w, h)).point(lambda v: 150 + v * 105 // 255)
    img = Image.composite(img, Image.new("RGB", (w, h), (120, 115, 110)), light)
    img = img.filter(ImageFilter.GaussianBlur(1.1))
    noise = Image.effect_noise((w, h), 18).convert("RGB")
    img = Image.blend(img, noise, 0.12)
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    rng = random.Random(1405)
    truth = {}
    for i, (key, text) in enumerate(TEXTS.items()):
        font = FONTS[i % len(FONTS)]
        cases = {"screen": render(text, font, 30, 1100), "small": render(text, font, 15, 560)}
        cases["photo"] = photo(render(text, font, 34, 1250), rng)
        for cond, img in cases.items():
            name = f"{key}_{cond}"
            if cond == "photo":
                img.save(OUT / f"{name}.jpg", "JPEG", quality=62)
                truth[f"{name}.jpg"] = text
            else:
                img.save(OUT / f"{name}.png", "PNG")
                truth[f"{name}.png"] = text
    (OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(truth), "images in", OUT)


if __name__ == "__main__":
    main()
