"""The few texts the worker writes itself (status message edits). Keys and wording follow the bot's
lib/i18n/{fa,en}.js (job.*, status.*, err.*) so a job reads the same whichever side reports it."""
from __future__ import annotations

import html

FA = {
    "job.progress": "{status}\nکد پیگیری: <code>{code}</code>",
    "job.done": "✅ <code>{name}</code>\nکد پیگیری: <code>{code}</code>",
    "job.group_done": "✅ {n} فایل آماده شد.\nکد پیگیری: <code>{code}</code>",
    "job.more": "⚙️ کار دیگری با نتیجه",
    "status.QUEUED": "⏳ در صف",
    "status.QUEUED_POS": "⏳ در صف (نفر {pos})",
    "status.DOWNLOADING": "📥 دریافت",
    "status.PROCESSING": "⚙️ پردازش",
    "status.UPLOADING": "📤 ارسال",
    "status.CANCELLED": "🚫 لغو شد\nکد پیگیری: <code>{code}</code>",
    "status.EXPIRED": "⌛ سرور تبدیل خیلی شلوغ بود و کار انجام نشد؛ دوباره امتحان کنید.\nکد پیگیری: <code>{code}</code>",
    "note.animated_first_frame": "ℹ️ فایل متحرک بود؛ فقط فریم اول استفاده شد.",
    "note.compress_not_smaller": "ℹ️ این عکس از قبل بهینه است؛ نسخه\U0000200cی کوچک\U0000200cتری ساخته نشد.",
    "note.emoji_removed": "ℹ️ ایموجی\U0000200cها در عکس رسم نمی\U0000200cشوند و حذف شدند.",
    "note.no_upscale": "ℹ️ عکس از اندازه\U0000200cی خواسته\U0000200cشده کوچک\U0000200cتر بود و بزرگ نشد.",
    "note.transparency_flattened": "ℹ️ این قالب شفافیت ندارد؛ پس\U0000200cزمینه سفید شد.",
    "note.metadata_removed": "ℹ️ اطلاعات اضافه (EXIF، موقعیت مکانی، توضیحات) حذف شد.",
    "note.text_shrunk": "ℹ️ متن طولانی بود و با کوچک\U0000200cترین اندازه جا شد.",
    "err.TIMEOUT": "❌ انجام نشد: پردازش بیش از حد طول کشید. کد پیگیری: <code>{code}</code>",
    "err.IMAGE_DAMAGED": "❌ عکس خراب است یا خوانده نمی\U0000200cشود. کد پیگیری: <code>{code}</code>",
    "err.IMAGE_TOO_BIG": "❌ عکس بیشتر از {mp} مگاپیکسل یا ضلعش بیشتر از {side} پیکسل است. کد پیگیری: <code>{code}</code>",
    "err.IMAGE_UNSUPPORTED": "❌ این قالب عکس پشتیبانی نمی\U0000200cشود. کد پیگیری: <code>{code}</code>",
    "err.OUTPUT_TOO_BIG": "❌ نتیجه بزرگ\U0000200cتر از {mb} MB (سقف تلگرام) می\U0000200cشد. کد پیگیری: <code>{code}</code>",
    "err.OUTPUT_INVALID": "❌ انجام نشد: نتیجه سالم نبود و ارسال نشد. کد پیگیری: <code>{code}</code>",
    "err.TOO_BIG": "❌ انجام نشد: فایل بزرگ\U0000200cتر از سقف تلگرام است. کد پیگیری: <code>{code}</code>",
    "err.FILE_GONE": "❌ انجام نشد: فایل دیگر در دسترس تلگرام نیست؛ دوباره بفرستید. کد پیگیری: <code>{code}</code>",
    "err.DOWNLOAD_FAILED": "❌ انجام نشد: دریافت فایل از تلگرام ممکن نشد. دوباره امتحان کنید. کد پیگیری: <code>{code}</code>",
    "err.UPLOAD_FAILED": "❌ انجام نشد: ارسال نتیجه ممکن نشد. دوباره امتحان کنید. کد پیگیری: <code>{code}</code>",
    "err.TEXT_TOO_LONG": "❌ متن بیشتر از {max} حرف است. کد پیگیری: <code>{code}</code>",
    "err.NO_TEXT": "❌ متنی برای رسم نماند (فقط ایموجی یا فاصله بود). کد پیگیری: <code>{code}</code>",
    "err.TOO_MANY_INPUTS": "❌ این کار حداکثر {max} فایل می\U0000200cگیرد. کد پیگیری: <code>{code}</code>",
    "err.WORKER_RESTARTED": "❌ پردازش به\U0000200cخاطر راه\U0000200cاندازی دوباره\U0000200cی سرور قطع شد؛ دوباره امتحان کنید. کد پیگیری: <code>{code}</code>",
    "err.INTERNAL": "❌ مشکلی پیش آمد. کد پیگیری: <code>{code}</code>",
}

EN = {
    "job.progress": "{status}\nTracking code: <code>{code}</code>",
    "job.done": "✅ <code>{name}</code>\nTracking code: <code>{code}</code>",
    "job.group_done": "✅ {n} files are ready.\nTracking code: <code>{code}</code>",
    "job.more": "⚙️ Do more with the result",
    "status.QUEUED": "⏳ Queued",
    "status.QUEUED_POS": "⏳ Queued (position {pos})",
    "status.DOWNLOADING": "📥 Downloading",
    "status.PROCESSING": "⚙️ Processing",
    "status.UPLOADING": "📤 Sending",
    "status.CANCELLED": "🚫 Cancelled\nTracking code: <code>{code}</code>",
    "status.EXPIRED": "⌛ The conversion server was too busy and the job didn't run; try again.\nTracking code: <code>{code}</code>",
    "note.animated_first_frame": "ℹ️ The file was animated; only the first frame was used.",
    "note.compress_not_smaller": "ℹ️ This image is already optimized; no smaller version could be made.",
    "note.emoji_removed": "ℹ️ Emoji can't be drawn in the image and were removed.",
    "note.no_upscale": "ℹ️ The image was smaller than the requested size and wasn't enlarged.",
    "note.transparency_flattened": "ℹ️ This format has no transparency; the background became white.",
    "note.metadata_removed": "ℹ️ Extra data (EXIF, location, comments) was removed.",
    "note.text_shrunk": "ℹ️ The text was long and was fitted at the smallest size.",
    "err.TIMEOUT": "❌ Failed: processing took too long. Tracking code: <code>{code}</code>",
    "err.IMAGE_DAMAGED": "❌ The image is damaged or unreadable. Tracking code: <code>{code}</code>",
    "err.IMAGE_TOO_BIG": "❌ The image has more than {mp} megapixels or a side over {side} px. Tracking code: <code>{code}</code>",
    "err.IMAGE_UNSUPPORTED": "❌ This image format isn't supported. Tracking code: <code>{code}</code>",
    "err.OUTPUT_TOO_BIG": "❌ The result would be larger than {mb} MB (Telegram's limit). Tracking code: <code>{code}</code>",
    "err.OUTPUT_INVALID": "❌ Failed: the result wasn't valid and wasn't sent. Tracking code: <code>{code}</code>",
    "err.TOO_BIG": "❌ Failed: the file is larger than Telegram's limit. Tracking code: <code>{code}</code>",
    "err.FILE_GONE": "❌ Failed: Telegram no longer has this file; send it again. Tracking code: <code>{code}</code>",
    "err.DOWNLOAD_FAILED": "❌ Failed: couldn't download the file from Telegram. Try again. Tracking code: <code>{code}</code>",
    "err.UPLOAD_FAILED": "❌ Failed: couldn't send the result. Try again. Tracking code: <code>{code}</code>",
    "err.TEXT_TOO_LONG": "❌ The text is longer than {max} characters. Tracking code: <code>{code}</code>",
    "err.NO_TEXT": "❌ No text is left to draw (only emoji or spaces). Tracking code: <code>{code}</code>",
    "err.TOO_MANY_INPUTS": "❌ This tool takes at most {max} files. Tracking code: <code>{code}</code>",
    "err.WORKER_RESTARTED": "❌ Processing stopped because the server restarted; try again. Tracking code: <code>{code}</code>",
    "err.INTERNAL": "❌ Something went wrong. Tracking code: <code>{code}</code>",
}

TEXTS = {"fa": FA, "en": EN}


def t(lang: str, key: str, **vars_) -> str:
    """HTML-escaped interpolation (the messages use parse_mode HTML)."""
    table = TEXTS.get(lang, FA)
    template = table.get(key) or FA.get(key) or FA["err.INTERNAL"]
    safe = {k: html.escape(str(v), quote=False) for k, v in vars_.items()}
    try:
        return template.format(**safe)
    except (KeyError, IndexError):
        return template


def error_text(lang: str, code: str, vars_: dict, tracking: str) -> str:
    key = f"err.{code}"
    if key not in FA:
        key = "err.INTERNAL"
    return t(lang, key, code=tracking, **(vars_ or {}))
