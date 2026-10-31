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

Not in Phase 1 (on purpose): **moderation**. Every upload is public at once. Don't announce the
bot publicly before Phase 2 (approval queue).

All limits are in `tgcloud/lib/config.js`.

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
| `MEMEBOT_BACKUP_CHANNEL_ID` | Backup channel id (`-100…` or `@username`). Written into `tgcloud/lib/env.js` at build time, because deployed code can't read env vars. |
| `MEMEBOT_OWNER_ID` | Your numeric Telegram id. Defaults to `5557901897`. |

### 3. Deploy

```bash
npm run deploy           # gen-env → push → migrate --safe (creates the 5 tables) → webhook check
```

Then, as the owner, send **/setup** to the bot. Its report should show ✅ for inline mode and the backup channel.

Always run the CLI through `npm run tg -- <command>` (e.g. `npm run tg -- status`, `npm run tg -- diff`).
It uses `memebot/.tgcloud/`, so it can never touch your other bots. A bare `npx tgcloud` from the
repository root would act on the to-do bot.

## How to test

**Locally (no token needed):**

```bash
npm test     # static platform checks → unit tests (normalisation, locales) → 21 end-to-end scenarios
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

## Layout

```
memebot/
  tgcloud/                         deployed to Telegram Serverless
    schema.js                      users, memes, meme_words (search index), recent_uses, kv
    handlers/                      message, callback_query, inline_query, chosen_inline_result → lib/router.js
    lib/
      router.js                    order of checks + table of every callback_data
      upload.js  backup.js         upload flow, backup channel
      inline.js                    inline search / home page / usage counts
      mine.js                      "my memes" list, card, delete
      menu.js  owner.js            welcome, help, language picker, owner /setup
      store.js                     every database query
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
