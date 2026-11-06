# Operations: deploy, back up, restore, recover

All commands run in `wanger-music/`. Never run bare `npx tgcloud` (it could act on another bot in
this repository); use the wrappers below.

## Environments

| | Production | Staging |
|---|---|---|
| Bot | `@Wange_Musicbot` (app9280424458) | `@Wangermusic_bot` (app9217669709) |
| CLI token | `Music_BOT_TGCLOUD_TOKEN` | `WANGER_STAGING_TGCLOUD_TOKEN`, or a file named by `WANGER_STAGING_TOKEN_FILE` |
| CLI | `npm run tg -- <cmd>` | `node scripts/staging.mjs tg <cmd>` (its own folder and CLI state, outside the repo) |
| Differences | — | `BOT_ID`/`BOT_USERNAME` of the staging bot (`WANGER_STAGING_BOT_USERNAME=Wangermusic_bot`), no force-join seed, no suggested channels: staging can't touch the real channels |

CLI tokens come from BotFather → the bot → Serverless → CLI Access. They are not bot tokens; never
paste either into a chat. If one leaks, regenerate it there and update the variable and the GitHub
secret `WANGER_MUSIC_TGCLOUD_TOKEN`.

## Deploy

1. `npm test` and `npm run query-review` — both green.
2. Staging: `node scripts/staging.mjs deploy`, then `npm run smoke -- --staging`.
3. Production: `npm run deploy` — tests → version stamp → `migrate --local --safe` → push →
   `migrate --safe` → dry-run → webhook check. Only additive (safe) schema steps are applied; a
   warning/manual step stops the deploy: read it with `npm run tg -- migrate --dry-run` and decide.
   Never `--yes`, never `push --force`.
4. `npm run smoke` — read-only production check (System Status data; the 📊 dashboard compared
   with direct SQL counts).
5. Take a backup (🧪 System Status → «💾») after a deploy that changed the schema.

`deploy` refuses while a temporary `tgcloud/endpoints/zz_*.js` exists (a smoke/backup run that was
interrupted): delete it first.

## Roll back code

Schema changes are additive, so older code runs on the newer schema (it ignores new columns).

```bash
git log --oneline -- wanger-music/tgcloud     # find the last good commit
git checkout <good-commit> -- tgcloud          # put its modules in the working tree
npm run tg -- push                             # deploy them (push sends the working tree)
git checkout HEAD -- tgcloud                   # back to the current code locally
```

Then fix forward and deploy normally. Never drop columns by deleting them from `schema.js`
(`.deprecated()` is the only way, and needs a review).

## Backups

- **What**: settings, users, force-join channels, artists + aliases, sources, tracks, destination
  channels, publications, broadcasts, stats_daily, audit_log — as one JSON document. Not included:
  the search index (rebuilt from tracks), update dedupe, error log, alerts, flows, import sessions
  (short-lived), and **audio files** (only their `file_id`s, which work for this bot only — the
  optional archive channel keeps copies of the audio).
- **How**: 🧪 System Status → «💾 بکاپ بگیر»; or ⚙️ Settings → weekly backup (off by default; runs
  from the tick); or `node scripts/backup.mjs export`. The document goes to the owner's private chat
  (≤ 50 MB, Telegram's limit). Keep it private: it holds user ids and names.
- **Download** the last backup without the app: `node scripts/backup.mjs fetch backup.json` (≤ 20 MB,
  the Bot API download limit; bigger files: save from Telegram).

## Restore

Rehearse on staging first. A restore upserts by primary key.

```bash
node scripts/backup.mjs restore backup.json --staging --replace   # full restore into staging
node scripts/backup.mjs restore backup.json --staging             # merge (no tables emptied)
node scripts/backup.mjs restore backup.json --production          # asks you to type the bot username
node scripts/backup.mjs restore backup.json --staging --tables tracks,artists,artist_aliases
```

- Without `--replace`: rows with the same id are overwritten; rows added after the backup stay;
  a row that clashes on another unique value (e.g. a user who re-joined under a new id) is skipped
  and counted.
- `--replace` empties each restored table first (5000 rows per statement) — for an empty or broken
  database.
- After the rows: the search index is rebuilt (the script drives it), stats are recounted on the
  next tick, and the row counts are compared with the backup's. The restore's own audit row and
  1–3 internal settings are expected extra rows.
- Into a different bot (e.g. a production backup into staging): data restores, but audio won't send
  — `file_id`s belong to the bot that received the file. Re-import from the archive channel instead.
- Speed: ~5 min for 7000 rows / 1.6 MB (each chunk is one `tgcloud run`; the platform rate-limits
  the CLI, the script waits and retries).

## Monitoring and alerts

The owner gets (throttled) alerts for: errors (each kind ≤ 1 per 30 min); a force-join channel
the bot can't check; a destination channel that lost post rights; publishing failures and uncertain
posts; an archive failure; and, from the Phase 8 monitor on every tick (each kind ≤ 1 per 3 h):
≥ 10 errors in an hour, ≥ 3 failed/uncertain publications in 24 h, the scheduled tick not seen for
2 h, a Telegram cooldown over 10 min, and the webhook report from the GitHub job (out of sync,
≥ 100 pending updates, an error in the last hour). 🧪 System Status lists the current warnings.

The GitHub job `.github/workflows/wanger-music-tick.yml` (every 30 min, needs the secret) runs the
tick with the webhook state from `tgcloud webhook`, and **fails when the tick fails** — GitHub then
e-mails the repository owner, which still works when the bot can't message anyone.

## When something is wrong

| Symptom | Do |
|---|---|
| The bot doesn't answer | `npm run tg -- webhook` (in sync? pending?) → `npm run tg -- webhook sync`; `npm run smoke`; GitHub Actions runs |
| "errors in the last hour" alert | 🧪 System Status → latest errors; reproduce with `npm run tg -- run handlers/<name> '<payload>'` on staging |
| Posts stuck / uncertain | 🗳 Approvals → uncertain / failed; ⚙️ «توقف همه‌ی انتشارها» stops the worker at once |
| Telegram 429 cooldown | Wait; bulk work resumes by itself; interactive replies are not delayed |
| A deploy broke something | Roll back code (above), then fix forward |
| Data lost or corrupted | Restore the latest backup (staging rehearsal first) |
| "Run error" / "rows_written limit exceeded" in logs | A statement over the platform limits (4096 values / 10 000 rows): batch it (docs/PLATFORM_NOTES.md) |
