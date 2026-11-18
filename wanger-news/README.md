# Wanger News

پلتفرم جمع‌آوری، راستی‌آزمایی و انتشار خبر (اول تلگرام). خبرها را از منابع معتبر می‌گیرد، تکراری‌ها را حذف
می‌کند، دسته‌بندی و اولویت‌بندی می‌کند و با ذکر منبع در کانال تلگرام منتشر می‌کند. علاوه بر RSS، یک
**کانال منبع تلگرام** هم دارد: هر پستی آن‌جا بگذارید، اگر قبلاً منتشر نشده باشد در کانال مقصد کپی می‌شود.

**وضعیت: فاز ۱** — فقط در **کانال تست** منتشر می‌کند. برنامه و وضعیت: [PLAN.md](PLAN.md) · معماری و
تصمیم‌ها: [ARCHITECTURE.md](ARCHITECTURE.md) · آخرین تست زندهٔ منابع: [docs/SOURCES_CHECK.md](docs/SOURCES_CHECK.md).

این پوشه یک پروژهٔ Python مستقل است؛ بقیهٔ پوشه‌های مخزن ربات‌های دیگرند و دست نخورده‌اند.

## فاز ۱ چه می‌کند

| بخش | توضیح |
|---|---|
| منابع | `config/sources.yaml` (افزودن منبع بدون تغییر کد). ۱۶ منبع فعال و تست‌شده؛ منابع بدون فید عمومی یا پشت paywall با دلیل غیرفعال‌اند؛ منابع فارسی نامزد، منتظر انتخاب شما |
| دریافت | دریافت هم‌زمان، `ETag`/`If-Modified-Since`، timeout، retry با backoff و jitter، circuit breaker برای هر منبع، احترام به robots.txt، محافظت SSRF، سقف حجم پاسخ |
| نرمال‌سازی | متن تمیز از HTML، URL استاندارد (حذف utm و پارامترهای ردیابی)، یکسان‌سازی حروف و ارقام فارسی/عربی، زمان UTC |
| تکراری | سطح ۱: لینک/متن/رسانه/فوروارد یکسان · سطح ۲: SimHash + تأیید Jaccard با «اعداد یکسان» · سطح ۳: interface (فاز ۳) |
| دسته‌بندی | کلیدواژه‌ای و قابل‌توضیح (`config/categories.yaml`): ۱۵ دسته، اولویت ۱۰۰/۸۰/۵۰/۲۰، حداکثر ۳ هشتگ |
| دروازه | فقط اولویت ≥ ۵۰؛ لیست سیاه/سفید (`config/filters.yaml`)؛ **موضوعات حساس** (جنگ، مرگ، کودتا، انتخابات، …) هرگز خودکار منتشر نمی‌شوند |
| انتشار | HTML امن، عنوان + خلاصهٔ کوتاه خود فید (نه متن کامل) + «گزارش اولیه» + منبع + لینک + زمان تهران، تصویر فقط از خود فید؛ هر خبر حداکثر یک بار |
| کانال منبع | `copyMessage` (آلبوم با `copyMessages`)؛ اگر همان پست/متن/عکس/لینک/فوروارد قبلاً منتشر شده، منتشر نمی‌شود و به مالک خبر داده می‌شود |
| دستورها (فقط مالک/ادمین، در پی‌وی) | `/start /help /status /sources /categories /stats /pause /resume` (بقیه از فاز ۲). پاسخ در اجرای بعدی می‌رسد |

## راه‌اندازی رایگان (GitHub Actions + Neon)

1. **ربات**: در [@BotFather](https://t.me/BotFather) ربات بسازید و توکن را بردارید. ربات را **ادمین کانال تست**
   (با اجازهٔ ارسال پست) و **ادمین کانال منبع** کنید. از حساب مالک یک بار به ربات `/start` بدهید.
2. **دیتابیس**: در [neon.tech](https://neon.tech) یک پروژهٔ رایگان بسازید و Connection string را کپی کنید
   (`postgresql://…?sslmode=require`). Supabase هم کار می‌کند.
3. **GitHub** ← Settings ← Secrets and variables ← Actions:
   - Secrets: `WANGER_NEWS_BOT_TOKEN`، `WANGER_NEWS_DATABASE_URL`
   - Variables: `WANGER_NEWS_TEST_CHANNEL` (مثل `@my_test`)، `WANGER_NEWS_SOURCE_CHANNEL`،
     در صورت نیاز `WANGER_NEWS_ADMIN_IDS` (شناسه‌های عددی با کاما)
4. فایل `.github/workflows/news.yml` باید روی **branch پیش‌فرض** باشد (cron فقط از آن‌جا اجرا می‌شود).
5. Actions ← **Wanger News** ← Run workflow: اول `migrate`، بعد `doctor` (توکن، webhook، کانال‌ها و ادمین بودن
   ربات را بررسی می‌کند)، بعد `run-once`. از آن به بعد هر ۱۵ دقیقه خودکار اجرا می‌شود.

> GitHub زمان‌بندی را دقیق اجرا نمی‌کند و ممکن است دیر کند؛ سیستم به این وابسته نیست. اگر مخزن ۶۰ روز
> فعالیتی نداشته باشد، GitHub زمان‌بندی را خاموش می‌کند. تلگرام update‌ها را فقط ۲۴ ساعت نگه می‌دارد.

## اجرای محلی

```bash
cd wanger-news
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev]"
cp .env.example .env            # و مقدارها را پر کنید
.venv/bin/python -m wanger_news validate-config
.venv/bin/python -m wanger_news run-once --dry-run   # بدون دیتابیس هم کار می‌کند؛ هیچ چیز ارسال نمی‌شود
.venv/bin/python -m wanger_news migrate
.venv/bin/python -m wanger_news doctor
.venv/bin/python -m wanger_news run-once
```

| دستور | کار |
|---|---|
| `run-once [--dry-run] [--max-posts N] [--source ID] [--no-telegram]` | یک دور کامل |
| `worker [--interval S]` | اجرای پیوسته (گزینهٔ B) |
| `check-sources [--all] [--markdown]` | تست زندهٔ فیدها و robots.txt |
| `migrate [upgrade\|downgrade] [rev]` · `db-check` | مایگریشن‌ها |
| `doctor` · `validate-config` | بررسی تنظیمات |

گزینهٔ B (سرور): `docker compose up -d` (postgres + migrate + worker).

## تست

```bash
.venv/bin/pytest -q                                   # بدون اینترنت
WANGER_NEWS_TEST_POSTGRES_URL=postgresql://… .venv/bin/pytest -q   # + تست‌های PostgreSQL
.venv/bin/ruff check src tests migrations && .venv/bin/mypy
```

## ساختار

```
config/            منابع، دسته‌ها، فیلترها، همهٔ آستانه‌ها (بدون عدد جادویی در کد)
src/wanger_news/
  domain/          منطق خالص: متن، URL، fingerprint، دسته‌بندی، دروازه، تقویم شمسی
  formatting/      HTML تلگرام (escape، تقسیم پیام) و قالب فارسی پست
  adapters/        HTTP امن، robots.txt، feedparser، Bot API، تبدیل پست کانال
  db/              مدل‌ها و همهٔ SQL
  services/        دریافت، تکراری، دسته‌بندی، انتشار، صندوق تلگرام، دستورها، pipeline
  ai/provider.py   interface هوش مصنوعی (پیاده‌سازی در فاز ۲)
migrations/        Alembic
tests/             تست‌ها با fixture و mock (بدون اینترنت)
```
