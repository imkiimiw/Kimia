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
    "ocr.head": "📝 متن استخراج\U0000200cشده ({script}) — کد پیگیری: <code>{code}</code>",
    "ocr.engine": "(آفلاین، Tesseract)",
    "ocr.script_fa": "فارسی/عربی",
    "ocr.script_latin": "لاتین",
    "ocr.script_mixed": "فارسی/عربی و لاتین",
    "ocr.copy": "📋 کپی متن",
    "ocr.docx": "📄 دریافت DOCX",
    "note.pdf_text_visual": "⚠️ متن فارسی این PDF به\U0000200cصورت شکل\U0000200cهای جدا و به ترتیب نمایشی ذخیره شده و احتمالاً به\U0000200cهم\U0000200cریخته است؛ «📝 استخراج متن (OCR)» نتیجه\U0000200cی بهتری می\U0000200cدهد.",
    "note.pdf_text_persian": "ℹ️ متن فارسی در PDFها گاهی به\U0000200cهم\U0000200cریخته ذخیره می\U0000200cشود؛ اگر متن خراب بود، «📝 استخراج متن (OCR)» را امتحان کنید.",
    "note.pdf_text_truncated": "ℹ️ فقط متن ۵۰۰ صفحه\U0000200cی اول استخراج شد.",
    "note.pdf_not_encrypted": "ℹ️ این PDF رمز نداشت؛ همان فایل دوباره ذخیره شد.",
    "err.OCR_NO_TEXT": "ℹ️ متنی در این فایل پیدا نشد. کد پیگیری: <code>{code}</code>",
    "err.OCR_TOO_MANY_PAGES": "❌ برای استخراج متن، PDF حداکثر {max} صفحه داشته باشد (اول صفحه\U0000200cها را جدا کنید). کد پیگیری: <code>{code}</code>",
    "err.OCR_FAILED": "❌ استخراج متن انجام نشد. کد پیگیری: <code>{code}</code>",
    "err.OCR_ENGINE_MISSING": "❌ موتور استخراج متن روی سرور نصب نیست. کد پیگیری: <code>{code}</code>",
    "err.PDF_ENCRYPTED": "❌ PDF رمز دارد؛ اول «🔓 باز کردن با رمز» را بزنید. کد پیگیری: <code>{code}</code>",
    "err.PDF_BAD_PASSWORD": "❌ رمز PDF درست نیست. کد پیگیری: <code>{code}</code>",
    "err.PDF_DAMAGED": "❌ PDF خراب است یا خوانده نمی\U0000200cشود. کد پیگیری: <code>{code}</code>",
    "err.PDF_NO_TEXT": "ℹ️ این PDF متن قابل\U0000200cانتخاب ندارد (احتمالاً اسکن است)؛ «📝 استخراج متن (OCR)» را بزنید. کد پیگیری: <code>{code}</code>",
    "err.PDF_TOO_MANY_PAGES": "❌ این PDF {pages} صفحه دارد؛ حداکثر {max} صفحه پشتیبانی می\U0000200cشود. کد پیگیری: <code>{code}</code>",
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
    "ocr.head": "📝 Extracted text ({script}) — tracking code: <code>{code}</code>",
    "ocr.engine": "(offline, Tesseract)",
    "ocr.script_fa": "Persian/Arabic",
    "ocr.script_latin": "Latin",
    "ocr.script_mixed": "Persian/Arabic and Latin",
    "ocr.copy": "📋 Copy text",
    "ocr.docx": "📄 Get DOCX",
    "note.pdf_text_visual": "⚠️ This PDF stores Persian as separate shaped glyphs in display order, so the text is probably scrambled; «📝 Extract text (OCR)» gives a better result.",
    "note.pdf_text_persian": "ℹ️ Persian text in PDFs is sometimes stored scrambled; if it looks broken, try «📝 Extract text (OCR)».",
    "note.pdf_text_truncated": "ℹ️ Only the text of the first 500 pages was extracted.",
    "note.pdf_not_encrypted": "ℹ️ This PDF had no password; it was saved again as it is.",
    "err.OCR_NO_TEXT": "ℹ️ No text was found in this file. Tracking code: <code>{code}</code>",
    "err.OCR_TOO_MANY_PAGES": "❌ For text extraction a PDF may have at most {max} pages (split it first). Tracking code: <code>{code}</code>",
    "err.OCR_FAILED": "❌ Text extraction failed. Tracking code: <code>{code}</code>",
    "err.OCR_ENGINE_MISSING": "❌ The OCR engine isn't installed on the server. Tracking code: <code>{code}</code>",
    "err.PDF_ENCRYPTED": "❌ The PDF has a password; tap «🔓 Unlock with password» first. Tracking code: <code>{code}</code>",
    "err.PDF_BAD_PASSWORD": "❌ The PDF password is wrong. Tracking code: <code>{code}</code>",
    "err.PDF_DAMAGED": "❌ The PDF is damaged or unreadable. Tracking code: <code>{code}</code>",
    "err.PDF_NO_TEXT": "ℹ️ This PDF has no selectable text (probably a scan); tap «📝 Extract text (OCR)». Tracking code: <code>{code}</code>",
    "err.PDF_TOO_MANY_PAGES": "❌ This PDF has {pages} pages; at most {max} are supported. Tracking code: <code>{code}</code>",
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
