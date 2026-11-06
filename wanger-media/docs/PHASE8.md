# Phase 8 — the `external` service and an uploader (research, 2026-11-06)

Checked for the owner's standing approval ("all phases to the end"). **Unverified** marks anything
not measured or not in a platform's own docs.

## 1. What an external service can add — and what it must not

| Limit on Serverless / the cloud Bot API | Can an owner-run service lift it? | Within the brief's hard limits? |
|---|---|---|
| Uploads ≤ 50 MB, by URL ≤ 20 MB (cloud Bot API) | **Yes**: the official `telegram-bot-api` server in `--local` mode uploads files up to **2000 MB** ([tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api)). | Yes — the same public file the bot already found, just bigger. |
| ≈ 30 s wall time per invocation | Yes: the service works in the background and sends the file itself. | Yes. |
| Separate audio/video streams (YouTube, Reddit video), HLS (Twitch, SoundCloud) | Technically (ffmpeg). | Only where the streams are served openly. YouTube and TikTok actively block downloaders; the tools that still work there (e.g. yt-dlp's extractors) depend on getting around those measures, which the brief forbids "whatever the settings". |
| Platforms that answer Serverless with 403 (Reddit JSON, LinkedIn) | A different IP might get through. | **No** — that is working around a block. |
| DRM (Spotify) | — | **Never.** |

**Decision:** the service built in this phase is a **large-file relay**. For a post the bot already
resolved by its own allowed method, the service downloads the chosen file from that platform's
allowlisted CDN and uploads it to the chat through a local Bot API server (≤ 2000 MB). The
**resolve** half of the contract is implemented in the bot (any compliant service can plug in),
but the reference service ships **no resolve engine**: it answers `UNSUPPORTED`, because no engine
could be shown to stay within the hard limits for the platforms that would need it.

## 2. Contract (final; `docs/PLATFORMS.md` §6 was the draft)

All requests are `POST <base>/v1/…` or `GET <base>/v1/health` over HTTPS with
`Authorization: Bearer <key>`; JSON in and out. The key is stored by the owner in the bot's database
(Admin › Platforms › 🔌 External service), never shown again, and sent only to the service's host.

- `GET /v1/health` → `{ "ok": true, "version", "relay": { "max_bytes" } | null, "resolve": true|false }`
- `POST /v1/resolve` `{ "url", "platform", "max_bytes", "quality": "best"|"small", "request_id" }` →
  `{ "ok": true, "title", "author", "items": [{ "type": "photo"|"video"|"audio", "url", "bytes",
  "mime", "width", "height", "duration" }] }` or `{ "ok": false, "code": "NOT_FOUND"|"PRIVATE"|"DRM"|
  "TOO_LARGE"|"UNSUPPORTED"|"RATE_LIMITED"|"ERROR" }`. Item URLs must be HTTPS on the service's own
  host; the bot still applies every policy check, the size limits and the hard "never" list.
- `POST /v1/relay` `{ "request_id", "url", "allow_hosts": [...], "bytes", "type": "video"|"photo"|
  "gif", "chat_id", "reply_to_message_id", "caption", "fail_text" }` → `202 { "ok": true, "queued":
  true }` or `{ "ok": false, "code" }`. The service checks every redirect hop against `allow_hosts`
  (the platform's media CDNs), never downloads more than `bytes` (and its own maximum), sends the
  file with `caption` (Telegram HTML), sends `fail_text` if it can't, and deletes the file.

## 3. Hosting (owner's decision — costs money)

- A small VPS (1 vCPU, 1–2 GB RAM, ≥ 20 GB disk) with Docker; a domain (or a Cloudflare tunnel) for
  HTTPS. Price ranges of common providers: a few USD/EUR a month (Unverified, varies).
- `api_id` / `api_hash` from <https://my.telegram.org> (the owner's Telegram account) for the local
  Bot API server, and the **bot token** (BotFather) — both stay on the server only.
- Files pass through the server: its traffic and disk are the cost driver (a 500 MB video = 500 MB in
  + 500 MB out).

## 4. Uploader (posting from Telegram to other platforms)

| Platform | Upload API | What it takes | Blocker for us |
|---|---|---|---|
| YouTube | Data API `videos.insert` | Google Cloud project, OAuth consent; uploads from **unverified projects stay private** until a compliance audit | OAuth callback + audit |
| Instagram | Graph API content publishing (Reels, photos, carousels) | Professional account linked to a Facebook Page, `instagram_content_publish`, app review for others' accounts | OAuth + app review |
| TikTok | Content Posting API | Unaudited clients post **private only**, max 5 users / 24 h; public posting needs TikTok's audit | OAuth + audit |
| Facebook | Pages API | Page admin token, app review for pages you don't own | OAuth + app review |
| X | API v2 media upload + post | Paid pay-per-use credits | Money + OAuth |
| Pinterest | API v5 pins | Standard access after review | OAuth + review |
| Threads | Threads API publishing | Meta app, the user's OAuth | OAuth |
| Reddit | API | Approval under the Responsible Builder Policy | Approval |
| LinkedIn | Posts API | Approved partner programmes | Approval |
| Snapchat | Snap Kit / Creative Kit | Partner approval | Approval |
| Twitch | Upload API ended (VOD upload is not public) | — | No API |
| Spotify | **No upload API** (music goes through distributors) | — | No API |
| SoundCloud | API upload | Registering an app needs a paid Artist Pro plan | Money |
| Discord | Webhooks / bot | A webhook URL from the server admin | Possible, little value |

**OAuth on Serverless:** the bot has no public GET endpoint (endpoints need Mini App init data). A
callback could land on the Mini App's static page (`https://app9080356648.tgcloud.ai/oauth/...`) and
hand the code to an endpoint with the init data — **Unverified** (needs the flow to start and end in
Telegram's WebView). Every useful upload target also needs an app review or audit that only the owner
can apply for. **Not built:** nothing can work without the owner's developer accounts and approvals;
YouTube (private uploads work right after OAuth) is the cheapest first target if the owner wants one.

Sources: [tdlib/telegram-bot-api](https://github.com/tdlib/telegram-bot-api) · [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) ·
[Instagram content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing) ·
[TikTok content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) ·
third-party summaries: [postiz TikTok](https://docs.postiz.com/self-host/providers/tiktok), [vorplabs](https://vorplabs.com/agent-tools/tiktok-content-posting-api), [timetopost](https://timetopost.co/blog/how-to-upload-videos-youtube-api).
