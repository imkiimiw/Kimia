# Wanger Music (`@Wange_Musicbot`)

A Telegram music bot that runs entirely on **Telegram Serverless**: instant search and delivery of
Telegram-hosted music (inline and in private chat), plus automatic publishing of new tracks to the
owner's channels. Built phase by phase from [docs/SPEC.md](docs/SPEC.md).

**Status: Phase 1 (core) is built and tested locally; it is not deployed yet.**

| Phase 1 feature | Where |
|---|---|
| Force-join gate: 3 seeded channels, parallel membership check, cached pass, failure mode open/closed, health per channel, owner alerts (≤ 1/h per channel) | `/start`, any message |
| «✅ عضو شدم» re-check; the message shrinks to the missing channels; the original `/start` payload continues after unlocking | join message |
| `/start [join \| search \| t_<id>]`, `/help`, `/lang` (فارسی / English), `/cancel` | private chat |
| `/admin` — only for the owner and admins; others see "unknown command" | private chat |
| 🔐 Force Join: list + health, add (@username, t.me link, id or forwarded post; bot must be admin), remove (confirm), enable/disable, reorder, invite link, failure mode, health check — max 10, applies at once | admin panel |
| 👥 Users: totals, find by id/@username, ban/unban, admins (add by id or forward, remove), scoped command menus | admin panel |
| ⚙️ Settings: default language, failure mode, pass TTL, staff bypass, inline/tick/broadcast/digest values, time zone, archive channel, sync command menus | admin panel |
| 🧪 System Status: version, bot, webhook, DB round trip, counts, last tick, force-join health, last 5 errors, «▶️ اجرای تیک» | admin panel |
| 📣 Broadcast: compose/forward → preview → confirm → batches with Pause / Resume / Cancel / «▶️ ادامه», 403 → user marked blocked, 429 cooldown, final report | admin panel |
| Background tick without cron: piggyback after updates, manual buttons, `endpoints/opsTick` via GitHub Actions every 30 min | — |
| Error boundary, update dedupe, structured JSON logs, audit log | — |
| Sections for later phases (Music, Sources, Destination Channels, Statistics) say honestly which phase adds them | admin panel |

## Run it

Everything runs from this folder. The repository root and its other folders are other bots.

```bash
cd wanger-music
npm ci
npm test                         # 73 tests: unit + end-to-end (local SDK emulation, fake Telegram)
export Music_BOT_TGCLOUD_TOKEN=app9280424458:…   # CLI access token (BotFather → bot → Serverless → CLI Access)
npm run tg -- status             # the CLI, for this bot only
npm run deploy                   # tests → stamp version → migrate --local --safe → push → migrate --safe → webhook
npm run smoke                    # read-only production check (System Status data)
```

`npm run deploy` applies only **safe** (additive) migration steps; anything marked warning/manual
stops and needs a human review (`npm run tg -- migrate --dry-run`). It never uses `--yes` or `--force`.

After the first deploy:
1. Send `/start` to the bot from the owner account (this also sets up the command menus).
2. Optional scheduled tick: add the repository secret **`WANGER_MUSIC_TGCLOUD_TOKEN`** (same CLI
   token) in GitHub → Settings → Secrets and variables → Actions. Until it exists the workflow skips.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [CONFIG](docs/CONFIG.md) ·
[PLATFORM_NOTES](docs/PLATFORM_NOTES.md) · [ROADMAP](docs/ROADMAP.md) · [SPEC](docs/SPEC.md).

## Known limitations (Phase 1)

- **No scheduler on the platform**: broadcast batches run when a tick runs (traffic, buttons, or the
  30-minute GitHub Actions schedule), so timing depends on those.
- `getWebhookInfo` is restricted for bots here; System Status shows `npm run tg -- webhook` instead.
- The membership check needs the bot to be an **admin** in every force-join channel (Telegram rule).
- Music, search, inline mode and channel publishing are Phases 2–6.

---

## راه‌اندازی سریع (فارسی)

**وضعیت: فاز ۱ ساخته و تست شده، ولی هنوز روی سرورلس دیپلوی نشده (منتظر تأیید شما).**

۱. توکن CLI ربات (BotFather ← ربات ← Serverless ← CLI Access) را در متغیر `Music_BOT_TGCLOUD_TOKEN` بگذارید
   (این توکن ربات نیست؛ هیچ‌وقت توکن ربات را جایی نفرستید).
۲. داخل پوشه‌ی `wanger-music`:
   ```bash
   npm ci && npm test        # همه‌ی تست‌ها باید سبز باشند
   npm run deploy            # ساخت جدول‌ها (فقط تغییرات امن) و آپلود کد
   ```
۳. از اکانت مالک (`5557901897`) به ربات `/start` بدهید، بعد `/admin`.
۴. ربات باید در هر سه کانال عضویت اجباری ادمین باشد (الان هست: @HIDE_i_SEEK، @Nepenthw_ir، @wangerBots).
۵. (اختیاری) برای تیک زمان‌بندی‌شده هر ۳۰ دقیقه، در گیت‌هاب سکرت `WANGER_MUSIC_TGCLOUD_TOKEN` را با همان توکن CLI بسازید.

کانال‌های مقصد (@WangerBeat برای آهنگ انگلیسی و @WangerFlow برای آهنگ فارسی) در **فاز ۵** اضافه می‌شوند؛
تا وقتی خودتان کانالی را فعال نکنید، ربات هیچ‌جا پست نمی‌گذارد.
