# Meme bot (Telegram Serverless)

People upload memes to the bot in a private chat and add keywords. Anyone can then search them in
any chat with `@yourbot keyword` and send them. The bot stores **no media**, only Telegram's `file_id` /
`file_unique_id` and the metadata. It runs entirely on [Telegram Serverless](https://core.telegram.org/bots/serverless)
(code, database and webhook live inside Telegram), uses free services only, and speaks Persian
(default) and English.

Platform limits, and what in the plan has to work differently: **[docs/PLATFORM.md](docs/PLATFORM.md)**.

## Phase 1 — what works

| Feature | How |
|---|---|
| /start, language | The first /start asks for the language (فارسی / English) with buttons. /lang changes it later. Texts live in `tgcloud/lib/locales/*.js`. |
| Upload | Send a photo, GIF, video, sticker or voice message → the bot asks for keywords → saved. One meme at a time (albums are refused). A new meme replaces one still waiting for keywords. /cancel or the ✖️ button drops it. A pending meme expires after 24 h. |
| Duplicates | Detected by `file_unique_id`, both when the meme arrives and again on save. |
| Backup | Every saved meme is **forwarded** to your private backup channel, and its channel message id is stored. If the user deleted the original first, the bot sends it to the channel by file_id with the caption `#m<id>`. A failure never blocks the upload: the owner gets an alert (at most every 3 h), and older failures are retried on the next successful backup. |
| Inline search | `@bot words`: every word must match (a prefix of a keyword word; a one-letter word must match exactly). Ranked by usage count, then newest. 50 per page with `next_offset`. Uses `InlineQueryResultCached*` (photo, gif, video, sticker, voice; video and voice carry the keywords as their required title). |
| Empty query | `@bot` alone: the memes you sent recently, then your own latest uploads, then the most popular ones, with no duplicates. `is_personal` is on, and there's an "📤 Upload" button (opens `/start upload`). |
| No results | An "upload it yourself" button above the (empty) results. It's the modern replacement for `switch_pm`. |
| Usage count | From `chosen_inline_result`. One user re-sending the same meme counts once per hour. |
| My memes | /my: a paged list. Tap a meme to see it, then 🗑 Delete → confirm. The list refreshes. You can only touch your own memes; every id in a button is re-checked. |
| Persian normalisation | ي/ی ك/ک ى ئ ة ۀ أ إ آ unified, Persian, Arabic and Latin digits unified, diacritics, tatweel and zero-width/bidi characters removed. ZWNJ: `می‌خوام`, `میخوام` and `می خوام` all find each other. Punctuation and extra spaces ignored, emoji searchable. See `tgcloud/lib/normalize.js`. |
| Daily limit | 20 uploads per user per day, resetting at 00:00 Tehran time. The owner has no limit. |
| Anti-spam | More than 20 messages a minute in the private chat → muted for 10 minutes (one warning). Keywords containing links, @usernames or e-mails are refused, since they would show up as titles in inline results. |
| Owner /setup | Sets the command menu and bot descriptions in both languages, and checks that inline mode is on and that the bot can post in the backup channel. |

## Phase 2 — moderation and admin panel

| Feature | How |
|---|---|
| Approval | A new meme is **pending**: only its uploader finds it (in search and on their empty-query page) until an admin approves it. The uploader is told when it is approved or rejected. A rejected file can't be uploaded again. Admins' own uploads are public at once. |
| Trust | After **N** admin-approved memes (default 5, changed in ⚙️ Settings; 0 = never), a user's uploads are public at once. They are told when they reach it. |
| Admin panel | `/admin` (also in the owner's command menu after `/setup`): counts, then 📥 Approval queue · 🚩 Reports · 👤 Find user / ban · 🚫 Banned list. The owner also gets 📢 Forced join · 📣 Broadcast · ⚙️ Settings · 👮 Admins. |
| Approval queue | One card per meme (the meme, its keywords, the uploader and how many of their memes were approved): ✅ Approve · ❌ Reject · 🚫 Reject + ban (asks for confirmation) · ⏭ Next. After an action, the buttons turn into a label ("✅ Approved — name") and the next card comes. If two admins press at the same time, only one action happens; the other admin sees "already handled". New waiting memes are announced to admins at most every 30 minutes. |
| Reports | A user who sees a bad meme **sends or forwards it to the bot**. The bot recognises it and shows 🚩 Report, then a reason (🔞 inappropriate · 🤬 offensive · 📢 ad/spam · ❔ other). One report per user per meme, at most 10 a day. After **K** different reports (default 3; 0 = never) the meme is hidden until an admin reviews it. The 🚩 Reports card shows the count and reasons: ✅ Keep · 🗑 Remove (the uploader is told) · 🚫 Remove + ban. |
| Bans | 👤 Find user: a numeric id or @username → the user's card (memes, approvals, trust) → 🚫 Ban / ✅ Unban, 🙈 Reject all their memes (asks for confirmation). Banning rejects their waiting memes. A banned user gets "you are banned" at most once a day, then silence; inline mode gives them nothing. The owner and admins can't be banned. |
| Admins | The owner adds admins (id or @username of someone who wrote to the bot). Admins get the queue, reports and bans; settings, channels, broadcast and the admin list stay with the owner. Roles are read fresh on every press. |
| Forced join | Optional. The owner adds up to 5 channels: @username, a t.me link, a `-100…` id, or a forwarded post. The bot must be an **admin** there; for private channels it creates an invite link. Non-members get a lock message with the channel buttons and "✅ I joined". In inline mode they get no results and a "join the channels" button (`/start join`). Membership is cached (10 min if they're a member, 15 s if not), so inline stays fast. If a channel can't be checked, it is skipped (so it can't lock everyone out) and the owner is alerted. Admins are exempt. |
| Broadcast | 📣 → send any single message → "send to N users?" → ✅. It is copied to every user who wrote to the bot, except banned users and those who blocked it. There is no scheduler, so it goes out in batches: 25 per "▶️ Next batch", plus 5 with every other message the bot receives, until done (the owner is told). Nobody gets it twice. Telegram's rate limit (429) pauses it and it then continues. Users who blocked the bot are marked and skipped. Keep your message until it's done. |

## Phase 3 — personal features

| Feature | How |
|---|---|
| Favourites | Send or forward any meme to the bot: the reply has **⭐ Add to favourites** (for someone else's public meme there's also 🚩). Tap it again to remove it; the button changes in place. Favourites are also on `/my` and `/fav` cards. In any chat, `@bot fav` lists them, newest starred first; `@bot fav word` searches inside them. `/fav` shows a paged list, and each item opens as a card. Up to 500 per user. If a meme is deleted, it disappears from everyone's favourites. |
| Private collection | The keywords question has **🔒 Save privately: off/on**. A private meme needs no approval and only its owner sees it, in search, on the empty-query page and in `/my` (marked 🔒). It counts toward the daily limit and is backed up like any upload. It never blocks someone else's public upload of the same file. **🌍 Publish** (on the `/my` card, or when you send it again) makes it public under the usual approval rules; if the same file is already public, you get that one as a favourite instead. |
| Edit keywords | `/my` → a meme → **✏️ Edit keywords** → send the new ones (same rules as uploading; `/cancel` or ✖️ stops). Private and pending memes, and memes of trusted users or admins, are updated directly. A public meme of an untrusted user **goes back to the approval queue**, so approved keywords can't be swapped for spam. |
| Hashtags | Write `#football` or `#جام_جهانی` among the keywords. `@bot #football` finds memes **tagged** that way (prefix works: `#جام`); a plain `football` finds them too. `/tags` (or ⭐/#️⃣ in the menu) lists the most used public tags; tap one to search it. |
| Type filter | Start the query with a type word: `@bot gif lol`, `@bot گیف خنده`, `@bot sticker`, `@bot ویس`, `@bot عکس #فوتبال`. Words: photo/pic/image/عکس · gif/گیف · video/ویدیو/فیلم · sticker/استیکر · voice/ویس. It combines with favourites: `@bot fav gif`. Each locale file declares its own words in `_words`, so a new language brings its own. A type word only counts as **the first word**, so a meme can still have "gif" as a keyword. |

## Phase 4 — social

| Feature | How |
|---|---|
| The channel | One channel only: **Wanger Chaos** (`@WangerChaos`, `-1004475337598`), set as the default in `scripts/gen-env.mjs`. The bot never posts anywhere else; forced-join channels are only checked. The channel is **public**, so it runs in `public` mode. A meme is posted when it becomes public (a trusted or admin upload, an admin approval, a private meme published), as a clean copy: keywords, the bot's @username and a 👍 button, **never the uploader's name**. Private, waiting and rejected memes are never posted. If a meme is removed (after reports, by its uploader, or sent back to the queue by an edit), its post is deleted; edited keywords update the caption. Approved memes that aren't in the channel yet go out two at a time with each new post. A failed post never blocks anything; the owner is alerted. (`MEMEBOT_BACKUP_MODE=all` forwards every upload as-is; use it only with a private channel.) |
| Likes | 👍 is under every meme sent through inline mode (it can be switched off in ⚙️ Settings), under channel posts, and on "already in the bot" answers. One like per person per meme, tap again to unlike; you can't like your own meme. The button shows the new total. Outside the private chat only 👍 works, and the bot never writes into a channel or group because of a button. |
| Ranking | Every result is ranked by **score = uses + 3 × likes**, newest first on ties. The score is a stored, indexed column, so ranking stays fast. |
| Profile | `/profile` (👤 in the menu) shows your public memes, total sends, likes received, and this week's points and rank, plus **🙈 Hide my name**: you then appear as "anonymous" in the leaderboard and your profile can't be opened. Others' profiles open from the leaderboard. |
| Weekly leaderboard | `/top` (🏆) lists the top 5 memes and top 5 uploaders of **this week** or **last week** (⏮). Weeks run Saturday to Friday, Tehran time, with Jalali dates. Points = sends + 3 × likes of public memes in that week; banned users are left out. 🥇🥈🥉 open the meme (⭐, 👍, try it); 👤 opens an uploader's profile. |
| Meme of the day | Posted to Wanger Chaos once a day. There is no scheduler, so the first message, button press or sent meme after **12:00 Tehran** posts it. It picks yesterday's best public meme by that day's points, otherwise the week's best, otherwise the best ever, never one posted in the last 30 days. Each post has 👍 and a link to the bot. It can be switched off in ⚙️ Settings. A failure alerts the owner and retries 30 minutes later. |

## Phase 5 — stats, and moderators

| Feature | How |
|---|---|
| Moderators | Owner panel → **👮 Admins and moderators** → **➕ Moderator (approve/reject)** or **➕ Admin**. Send the person's numeric id or @username, or **forward any message from them**. They are told and get `/admin` in their own command menu. A **🛡 moderator** sees only the approval queue: ✅ approve / ❌ reject / ⏭ next, with no ban button, no reports, no users and no stats, and isn't sent report notifications. A **👮 admin** also gets reports, users and bans, and stats. 🔁 switches a person between the two roles and ❌ removes them; they're told either way and their menu is reset. Staff can't be banned. Everything else (settings, channels, broadcast, this list) stays with the owner. Roles are read fresh on every button press. |
| Stats | Admin panel → **📊 Stats** (owner and admins). **Overview:** users (total, new in 24 h / 7 days, active in 7 days, blocked the bot, banned); memes (public, waiting, private, rejected or hidden); uploads, searches and the share of searches with no result (today / 7 / 30 days); memes sent and likes in 7 days. **🔎 Most searched** and **😕 No result**: the top 20 queries of the last 7 or 30 days. The no-result list shows the memes people want and the bot lacks; each has a 🔎 button to try it yourself. |
| How a search is counted | Inline queries arrive per keystroke (س, سل, سلا…), so each user's latest query waits and is counted **once**, when they move on: they send a result, or their next query isn't a continuation of it (typing on or deleting back) within 30 s, or they clear the text. Queries are normalised the same way as search, so ي/ی, digits and ZWNJ variants count together. Favourites (`fav …`) and empty queries aren't counted. Counting happens **after** the answer is sent, so search stays as fast as before. Old data is pruned daily (queries after 60 days). |

## Phase 6 — AI (Google Gemini, free tier)

| Feature | How |
|---|---|
| Keyword suggestions | After you send a meme, the keywords question appears at once as before; about 2–5 s later it is edited to add **🤖 AI suggestions** (mostly Persian, plus names of well-known people, films or games) and a **✅ Use the suggested keywords** button. You can press it, or ignore it and type your own. |
| Text in the image (OCR) | The text inside the meme is read, saved (`memes.ocr`), and its words are added to the search index (up to 20), so `@bot <a word written on the meme>` finds it even if the keywords don't mention it. Editing the keywords keeps those words. |
| "May be inappropriate" flag | If the AI thinks a meme may be inappropriate (nudity, gore, hate symbols), the meme **always waits for approval**, even from a trusted user, and the queue card shows **⚠️ AI: may be inappropriate (reason)**. The card also shows the text read from the image. Staff uploads and private memes aren't held. The admin decides; the AI never rejects anything. |
| If you answer before the AI | The meme is saved with your keywords; when the AI result arrives it is added to the saved meme (OCR words indexed). If it was flagged and had gone public, it goes back to the queue and its channel post is deleted. |
| What is analysed | Photos (a size of at most 800 px), the thumbnail of GIFs, videos and animated stickers, static stickers as they are. Voice messages have no image, so no AI. One Gemini call per upload; nothing AI runs during inline search. |
| Key and limits | The owner sets the key with **`/aikey <key>`** (the bot deletes that message at once and checks the key with Google first), `/aikey` shows whether one is set, `/aikey off` removes it. It is stored only in the bot's database, never in code. At most 500 calls a day; if Google answers "quota exceeded" (429), AI pauses for an hour. Without AI (no key, switched off, paused, or any error) uploads work exactly as before. |
| Switch and status | ⚙️ Settings → **🤖 AI** on/off, with today's calls or "paused". 📊 Stats shows AI calls today and in 30 days. |
| Privacy | The image is sent to Google. On the free tier Google may use it to improve its products; `/help` tells users. |

All limits are in `tgcloud/lib/config.js`; the switches and thresholds are in ⚙️ Settings.

## Setup

### 1. In Telegram

1. [@BotFather](https://t.me/BotFather) → your bot → **Serverless** → turn it on. Then **CLI Access** → copy the
   access token (it looks like `app<id>:<secret>`; it is **not** the bot token).
2. @BotFather → `/setinline` → your bot → placeholder text, e.g. `جستجوی میم…`. Without it, inline mode is off.
3. @BotFather → `/setinlinefeedback` → your bot → **100%** (Enabled). Without it, usage counts and "recently sent" stay empty.
4. Create a **private channel** for backups. Add the bot as an **admin with "Post messages"**. Get the
   channel id (`-100…`). For example, open the channel in Telegram Web: the address ends in `#-100…`.

### 2. Local settings

```bash
cd memebot
npm install
cp .env.example .env     # then fill it in (or set the same variables in the environment)
```

| Variable | What |
|---|---|
| `Meme_BOT_TGCLOUD_TOKEN` | The CLI access token from step 1. Only `scripts/tg.mjs` reads it, and it passes it to the CLI for that one process. |
| `MEMEBOT_BACKUP_CHANNEL_ID` | The one channel the bot posts to (default `-1004475337598` = @WangerChaos; `off` = none). Written into `tgcloud/lib/env.js` at build time, because deployed code can't read env vars. |
| `MEMEBOT_BACKUP_MODE` | `public` (default): only approved memes, clean copies. `all`: every upload forwarded (private channels only). |
| `MEMEBOT_MOTD_CHANNEL_ID` | Meme of the day; defaults to the same channel (`off` = none). |
| `MEMEBOT_OWNER_ID` | Your numeric Telegram id. Defaults to `5557901897`. |

### 3. Deploy

```bash
npm run deploy           # gen-env → migrate --local --safe → push → migrate --safe → webhook check
```

The database is migrated **before** the new code goes live: the old code ignores new tables and
columns, so a deploy never has new code running against an old database.

Then, as the owner, send **/setup** to the bot. Its report should show ✅ for inline mode and the backup channel.

For Phase 6, create a free Gemini API key at [aistudio.google.com](https://aistudio.google.com) (from a
country where the Gemini API is offered) and send `/aikey <key>` to the bot as the owner.

Always run the CLI through `npm run tg -- <command>` (e.g. `npm run tg -- status`, `npm run tg -- diff`).
It uses `memebot/.tgcloud/`, so it can never touch your other bots. A bare `npx tgcloud` from the
repository root would act on the to-do bot.

## How to test

**Locally (no token needed):**

```bash
npm test     # static platform checks → unit tests (normalisation, query syntax, calendar, locales) → 46 end-to-end scenarios
```

The end-to-end scenarios run the real handlers against a local stand-in for the SDK
(`test/sdk/`, SQLite) and a strict mock Bot API (`test/mock-telegram.mjs`). The mock rejects what
Telegram rejects: >50 results, a video/voice result without a title, `next_offset` >64 bytes, bad
HTML, a button answered twice, forwarding a deleted message, and so on.

**On the platform without Telegram** (after a deploy, so the tables exist):

```bash
npm run tg -- run handlers/inline_query '{ id: "t1", from: { id: 1, language_code: "fa" }, query: "گربه", offset: "" }'
```

`run` executes your local code on the platform against the bot's real database and prints every
Bot API call (the `trace`). Here `answerInlineQuery` fails because `t1` isn't a real query id, but the
trace still shows the results it built.

**In Telegram (Phase 1 checklist):**

1. `/start` → pick a language → welcome with buttons.
2. Send a photo → the bot asks for keywords → write `گربه‌ی عصبانی` → "saved". The meme shows up in the backup channel.
3. In any chat type `@yourbot گربه`, then `@yourbot گربه ي` (Arabic ي), then `@yourbot گربهی`. All three find it. Send it.
4. Type just `@yourbot` → the meme you just sent comes first, with an "📤 Upload" button on top.
5. Send the same photo again → "already in the bot".
6. Upload a GIF, a video, a sticker and a voice message, and search each one.
7. `@yourbot something-that-does-not-exist` → the "upload it yourself" button → it opens the bot with the upload help.
8. `/my` → open a meme → 🗑 Delete → confirm → it disappears from the list and from search.
9. Write keywords containing `@channel` or a link → refused.

**Phase 2 checklist** (you are the owner):

1. `/admin` → ⚙️ Settings: approval is **on**. Set "publish automatically after" as you like.
2. From another account (or ask a friend): upload a meme. They get "waiting for approval", and you get "📥 1 meme waiting".
   Search it from your account → not found. From theirs → found.
3. `/admin` → 📥 Approval queue → ✅ Approve. They are told, and now everyone finds it. Upload another one and ❌ Reject it.
4. From the other account, forward one of your public memes to the bot → 🚩 Report → pick a reason. You get "🚩 reported".
   `/admin` → 🚩 Reports → ✅ Keep or 🗑 Remove.
5. `/admin` → 👤 Find user → their @username → 🚫 Ban. They get "banned", and inline gives them nothing. Then ✅ Unban.
6. 👮 Admins → ➕ → their @username: their `/admin` shows the queue, reports and bans only.
7. 📢 Forced join → ➕ → `@yourchannel` (make the bot an admin there first). The other account gets the lock until it joins. Turn it off again if you like.
8. 📣 Broadcast → send a test message → ✅ Send → watch the counters; press ▶️ until it says done.

**Phase 3 checklist** (send `/setup` once more so the menu gets /fav and /tags):

1. Forward a public meme to the bot → ⭐ → the button turns into ★. In any chat type `@yourbot fav` → it's there. `@yourbot fav gif` → only GIFs.
2. `/fav` → open it → ★ to remove it.
3. Send a new meme → on the keywords question tap 🔒 (it shows "on ✅") → keywords → "saved to your private collection".
   `@yourbot <word>` finds it for you, not from another account. `/my` shows it with 🔒 → 🌍 Publish.
4. `/my` → a meme → ✏️ Edit keywords → `گل #فوتبال`. From an untrusted account, a public meme goes back to the queue.
5. `@yourbot #فوتبال`, `@yourbot گیف`, `@yourbot sticker`, and `/tags`.

**Phase 4 checklist** (send `/setup` once more for /top and /profile):

1. Upload a meme as the owner. It appears in Wanger Chaos at once: keywords, @bot and 👍, no uploader name. A meme from an untrusted account appears only after ✅ Approve.
2. Send a meme to a group through `@yourbot …`, then tap 👍 under it from another account: it shows 👍 1. Tap again: 👍.
3. Tap 👍 under a post in the channel.
4. `/top` (this week / ⏮ last week), `/profile`, then 🙈 Hide my name and look at `/top` again.
5. After 12:00 Tehran, the first message to the bot posts the meme of the day in the channel.
6. `/my` → delete a public meme: its channel post disappears.

**Phase 5 checklist:**

1. `/admin` → 👮 Admins and moderators → ➕ Moderator → forward a message from a friend. They get "you are a moderator", and their `/admin` shows only the approval queue.
2. Upload from a third account. The moderator gets "📥 1 meme waiting", approves it, and can't ban or open stats.
3. 🔁 switches them to admin (they now see reports, users and 📊), and ❌ removes them.
4. Search for a few things inline, including something that doesn't exist, then send a result or search something else. `/admin` → 📊 Stats → 🔎 Most searched / 😕 No result.

**Phase 6 checklist:**

1. `/aikey` as the owner: it should say the key is set. ⚙️ Settings shows 🤖 AI: on · today N of 500.
2. Send a meme with text on it. A few seconds later the question shows 🤖 suggestions; press ✅ Use the suggested keywords.
3. Search inline for a word that is written on the meme but isn't in its keywords: it is found.
4. Upload again and type your own keywords quickly, before the suggestions appear: the meme is saved with yours, and the text on it is still searchable a moment later.
5. From an untrusted account, upload something the AI should flag; `/admin` → 📥 queue: the card shows ⚠️ and the reason.

## Layout

```
memebot/
  tgcloud/                         deployed to Telegram Serverless
    schema.js                      users, memes, meme_words (search index), recent_uses, kv,
                                   reports, admins, channels, broadcasts, favorites,
                                   likes, meme_week, user_week, meme_day, motd,
                                   stat_day, search_q, search_pending
    handlers/                      message, callback_query, inline_query, chosen_inline_result → lib/router.js
    lib/
      router.js                    order of checks + table of every callback_data
      upload.js  backup.js         upload flow (pending / public), backup channel
      inline.js                    inline search / home page / usage counts (ban and join gates)
      mine.js                      "my memes" list, card, delete
      menu.js  owner.js            welcome, help, language picker, owner /setup
      admin.js                     admin panel: users, bans, admins, settings, channels
      review.js                    approval queue, reports (admin and user side), banUser
      join.js  broadcast.js        forced join (cached checks), resumable broadcast
      collection.js                favourites (⭐), likes (👍), /fav, /tags
      social.js  socialstore.js    profile, weekly leaderboard, public meme card; likes and counters
      motd.js  jobs.js             meme of the day; work done on the side of updates (no scheduler)
      ai.js                        Gemini: image choice, key, quota, one call → keywords, OCR, flag
      stats.js  statsstore.js      stats screens; daily counters and once-per-query search counting
      store.js  adminstore.js      every database query (Phase 1 / Phase 2)
      normalize.js                 Persian normalisation and search words
      i18n.js  locales/            t(), digits, plurals; fa.js (default), en.js, index.js (add languages here)
      tg.js  bot.js  util.js  config.js
      env.js                       generated by scripts/gen-env.mjs (git-ignored)
  scripts/tg.mjs                   CLI wrapper (token var, isolation, proxy)
  scripts/gen-env.mjs              writes tgcloud/lib/env.js from .env / the environment
  test/                            static.mjs, unit.test.mjs, e2e.mjs, mock-telegram.mjs, sdk/
  docs/PLATFORM.md                 platform check (limits, what won't work, alternatives)
  docs/tgcloud-sdk.md              SDK reference
```

## Adding a language

Copy `tgcloud/lib/locales/en.js` to `<code>.js`, translate the values, import it in
`tgcloud/lib/locales/index.js`, then run `npm test` (it checks every key and placeholder), deploy,
and send `/setup` again so the command menu gets the new language.
