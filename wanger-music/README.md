# Wanger Music (`@Wange_Musicbot`)

A Telegram music bot that runs entirely on **Telegram Serverless**: instant search and delivery of
Telegram-hosted music (inline and in private chat), plus automatic publishing of new tracks to the
owner's channels. Built phase by phase from [docs/SPEC.md](docs/SPEC.md).

**Status: all 8 phases (core, catalog, search + inline, sources, destinations, automatic publishing, analytics, production hardening) are built, tested and deployed.** Deploy state: [docs/ROADMAP.md](docs/ROADMAP.md) · operations: [docs/OPERATIONS.md](docs/OPERATIONS.md) · review: [docs/REVIEW.md](docs/REVIEW.md).

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
| Sections for later phases (Sources, Destination Channels, Statistics) say honestly which phase adds them | admin panel |

| Phase 2 feature | Where |
|---|---|
| Send or forward an audio → a draft track: tags or "Artist - Title" file name, noise stripped, version markers and featured artists split, language detected | admin's private chat |
| Hard duplicates refused (same file or same channel post — removed tracks still block); soft duplicates (same song, ±3 s) flagged ⚠️; other versions (remix…) linked 🔗 | import card |
| Import card: ✅ Activate · ✏️ Title / Artist / Album · 🌐 Language · 🏷 Genre · 🖼 Cover · 🗑 Discard · ▶️ Play; a run of forwards → one summary message | admin's private chat |
| 🎵 Music: counts, filters (needs review, drafts, active, hidden, removed, by language), search (title/artist prefix or `t_<id>`), track card, hide / remove / restore, owner-only purge | admin panel |
| Optional archive channel: every activated track is copied there; failures alert the owner; the tick works the backlog | ⚙️ Settings |

| Phase 3 feature | Where |
|---|---|
| `@Wange_Musicbot <song or artist>` in any chat: cached audio results, 20 per page, personal, popular + newest for an empty query, «🔎 جستجو در ربات» when nothing matches | inline |
| Non-members get no results and «🔒 اول عضو کانال‌ها شو» (→ `/start join`) | inline |
| Plain text or `/search` → result buttons that send the audio; pages; an inline-search button | private chat |
| `/start t_<id>` sends that track (sharing, later channel captions); `/start search` | deep links |
| Persian-aware matching: ي/ی, ك/ک, «می‌خوام» = «میخوام» = «می خوام», ۲ = 2, prefixes (“week” → The Weeknd), artist aliases (“shadmehr”) | search |
| 🎤 Artists: other names for search; plays counted from inline choices and private sends; optional inline caption template | admin panel |

| Phase 4 feature | Where |
|---|---|
| 📡 Sources: channels (bot = admin) whose new audio posts are imported — mode off / draft / active, default language, enable, remove; never publishes | admin panel |
| Duplicates skipped (same post, same file); unregistered channels ignored; the owner is told about new drafts (≤ 1/h) and when the bot loses admin in a source | — |
| When the bot is made admin of a new channel, the owner chooses: Source · Destination · Force-join · Ignore | owner's chat |

| Phase 5 feature | Where |
|---|---|
| 📢 Destination channels: one-tap add for @WangerBeat (English) and @WangerFlow (Persian), or forward / @username / id; the bot's post (and edit/delete) rights are checked; new channels start disabled, auto-publish off, approval on | admin panel |
| Rules: languages, genres, excluded genres, minimum language confidence · post format (audio, or cover then audio) · schedule: interval, hours, daily limit, time zone · approval · enable / auto-publish | channel card |
| Caption template with variables, checked by a preview sent only to the owner (real matching track, or a sample) | channel card |
| Health: losing post rights disables the channel and alerts the owner; «🔄 Check rights»; soft removal keeps history | — |

| Phase 6 feature | Where |
|---|---|
| A newly activated track goes to every enabled + auto-publish channel whose rules match — once per channel; earlier tracks only by the owner's «⏪ Earlier tracks» (preview + count) | automatic |
| Approval: digest to the owner and admins; review = the audio with the channel's caption + ✅ / ❌ / ⏭; the first reviewer wins | 🗳 Approvals |
| Worker on the tick: minimum interval, active hours, daily limit, 429 cooldown, backoff (1, 2, 4… min, 6 attempts), channel/file/caption errors handled and alerted | automatic |
| At most once: an interrupted send becomes ⚠️ uncertain; the owner marks it published or sends it again | 🗳 Approvals |
| History per track and per channel; removing a track cancels waiting posts; «🧹 Delete channel posts»; pause switch | track / channel cards, ⚙️ Settings |

| Phase 7 feature | Where |
|---|---|
| 📊 Statistics for today / 7 / 30 days: users (total, new, active, blocked or never started), inline and in-bot searches (+ no-result), plays, force-join conversions, tracks, top 5 | admin panel (owner + admins) |
| Per destination channel: published in the period and all time, awaiting approval, queued, failed, uncertain; per source: audio posts, imports, duplicates | 📊 Statistics |
| «📈 Daily» (14 days) and «🔥 Most played» (period + all time) | 📊 Statistics |
| Aggregated only (`stats_daily`): no per-user histories, no search texts; numbers recounted from the tables match direct counts | — |

| Phase 8 feature | Where |
|---|---|
| 💾 Backup: one JSON document of the core tables sent to the owner; optional weekly backup; download / restore scripts (verified on the staging bot: every row identical after a full restore) | 🧪 System Status, ⚙️ Settings, `scripts/backup.mjs` |
| Monitoring: warnings on System Status and owner alerts (≤ 1 per kind per 3 h) for rising errors, failing publications, a stopped schedule, long cooldowns and webhook problems reported by the GitHub job; the job fails visibly when the tick fails | 🧪 System Status, owner's chat |
| Flood guard (30 messages / presses per minute per user); quiet handling of users who blocked the bot; inline answers survive a broken file | — |
| Staging bot `@Wangermusic_bot` with a mirror script, fixtures, load test (inline p95 166 ms with 5000 tracks), query-plan review in CI | `scripts/staging.mjs`, `scripts/loadtest.mjs`, `npm run query-review` |

| After Phase 8 | Where |
|---|---|
| Groups as sources: a group where the bot is admin imports the songs members send (draft or straight into search) | 📡 Sources, or make the bot admin of the group |
| «✅ فعال‌سازی همه» (activate all) on a forwarded batch, and for all ready drafts | batch summary, 🎵 Music → drafts |
| Setting: tracks the owner/admins send go live at once | ⚙️ Settings |
| Language: guessed only when reliable (Persian script); Latin-letter titles wait for a one-tap choice on the track card; a correction re-routes waiting posts | 🎵 Music, ⚙️ Settings |
| 🆔 The channel's link as the last line of every post's caption (per channel, on by default) | 📢 Destination Channels |

## Run it

Everything runs from this folder. The repository root and its other folders are other bots.

```bash
cd wanger-music
npm ci
npm test                         # 186 tests: unit + end-to-end (local SDK emulation, fake Telegram)
npm run query-review             # query plans of every statement the tests run (no unexpected full scans)
export Music_BOT_TGCLOUD_TOKEN=app9280424458:…   # CLI access token (BotFather → bot → Serverless → CLI Access)
npm run tg -- status             # the CLI, for this bot only
npm run deploy                   # tests → stamp version → migrate --local --safe → push → migrate --safe → webhook
npm run smoke                    # read-only production check (System Status data + dashboard vs direct counts)
node scripts/backup.mjs export   # a backup now (sent to the owner); fetch / restore: docs/OPERATIONS.md
```

`npm run deploy` applies only **safe** (additive) migration steps; anything marked warning/manual
stops and needs a human review (`npm run tg -- migrate --dry-run`). It never uses `--yes` or `--force`.

After the first deploy:
1. Send `/start` to the bot from the owner account (this also sets up the command menus).
2. Optional scheduled tick: add the repository secret **`WANGER_MUSIC_TGCLOUD_TOKEN`** (same CLI
   token) in GitHub → Settings → Secrets and variables → Actions. Until it exists the workflow skips.

Docs: [ARCHITECTURE](docs/ARCHITECTURE.md) · [CONFIG](docs/CONFIG.md) ·
[PLATFORM_NOTES](docs/PLATFORM_NOTES.md) · [ROADMAP](docs/ROADMAP.md) · [SPEC](docs/SPEC.md).

## Known limitations

- **No scheduler on the platform**: broadcast batches run when a tick runs (traffic, buttons, or the
  30-minute GitHub Actions schedule), so timing depends on those.
- `getWebhookInfo` is restricted for bots here; System Status shows `npm run tg -- webhook` instead.
- The membership check needs the bot to be an **admin** in every force-join channel (Telegram rule).
- Editing a title/artist changes the bot's catalog; Telegram keeps showing the file's own embedded tags and thumbnail (re-uploading with new tags is optional in the spec and deferred).
- Inline usage counts need BotFather `/setinlinefeedback` (set it to 100%).
- Source channels: only posts made after the bot became an admin arrive (bots can't read history).
- Publishing runs on the tick: posts go out when updates arrive, the owner taps «▶️ Run tick», or the
  GitHub Actions schedule runs (every 30 min) — timing depends on those.
- Statistics: inline searches are counted per first page of 3+ characters (Telegram sends a query per
  keystroke, so this overstates real searches); inline plays need `/setinlinefeedback`; event counts
  (searches, plays, conversions, source posts) start with Phase 7; days follow the `time_zone` setting.

---

## راه‌اندازی سریع (فارسی)

**وضعیت: هر ۸ فاز ساخته، تست و روی سرور اصلی دیپلوی شده‌اند.** بعد از آن: گروه هم می‌تواند منبع باشد، و دکمه‌ی «✅ فعال‌سازی همه» برای پیش‌نویس‌ها اضافه شد. راهنمای نگهداری (دیپلوی، بکاپ، بازگردانی، رفع مشکل): [docs/OPERATIONS.md](docs/OPERATIONS.md).

بکاپ (فاز ۸): /admin ← 🧪 وضعیت سیستم ← «💾 بکاپ بگیر» — فایل JSON برای خودتان فرستاده می‌شود؛ بکاپ هفتگی را در ⚙️ تنظیمات روشن کنید.

جستجو (فاز ۳): اسم آهنگ را در چت ربات بفرستید، یا در هر چتی بنویسید <code>@Wange_Musicbot اسم آهنگ</code>. برای شمارش استفاده از اینلاین، در BotFather دستور <code>/setinlinefeedback</code> را روی ۱۰۰٪ بگذارید.

افزودن آهنگ (فاز ۲): فایل صوتی را در چت خصوصی ربات بفرستید یا از کانال فوروارد کنید؛ پیش‌نویس ساخته می‌شود و با «✅ فعال کن» وارد آرشیو می‌شود. مدیریت: /admin ← 🎵 موزیک.

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

کانال‌های مقصد (@WangerBeat برای آهنگ انگلیسی و @WangerFlow برای آهنگ فارسی) را از /admin ← 📢 کانال‌های مقصد با یک دکمه اضافه کنید؛
تا وقتی خودتان کانالی را فعال و «انتشار خودکار» را روشن نکنید، ربات هیچ‌جا پست نمی‌گذارد.

آمار (فاز ۷): /admin ← 📊 آمار — امروز، ۷ و ۳۰ روز اخیر؛ «📈 روزانه» و «🔥 پرپخش‌ها». فقط عددهای جمع‌شده ذخیره می‌شود (نه تاریخچه‌ی هر کاربر و نه متن جستجوها).
