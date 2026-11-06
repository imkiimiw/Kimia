# Wanger Media — large-file relay (the `external` service)

The bot runs on Telegram Serverless, where the cloud Bot API takes uploads up to **50 MB**. This small
service, on a server you rent, lets the bot send bigger files (up to **2000 MB**): the bot finds the
file exactly as before (same platforms, same switches, same checks), and when it is too big it hands
the job to this service. The service downloads that one file from the platform's CDN (only the hosts
the bot allows), uploads it to the chat through Telegram's own **local Bot API server**, and deletes it.
Contract and reasoning: [../docs/PHASE8.md](../docs/PHASE8.md).

It never: logs in anywhere, uses cookies, gets around blocks or rate limits, touches DRM content, or
keeps files. It ships no "resolve" engine (it answers `UNSUPPORTED`) — see PHASE8.md §1 for why.

## What you need (costs and accounts are yours)

1. A small Linux server with Docker (1 vCPU, 1–2 GB RAM, ≥ 20 GB disk). Traffic matters: a 500 MB
   video is 500 MB in and 500 MB out.
2. A domain name pointing at the server (for HTTPS), e.g. `dl.example.com`.
3. `api_id` and `api_hash` from <https://my.telegram.org> → API development tools (your Telegram account).
4. The bot token from @BotFather (`/token`) — it stays on the server only.

## ⚠️ Test with a test bot first

Telegram's documentation says a bot should call `logOut` on the cloud Bot API before it is used through
a local Bot API server, "otherwise there is no guarantee that the bot will receive updates". This bot
gets its updates through Serverless (the cloud), and the relay uses the local server **only to send**.
Whether sending through a local server affects the delivery of updates to Serverless is **not
verified**. Before using the real bot token: create a test bot, set up Serverless for it, and use the
relay with it for a day. Also check the bot still answers normally. **Never call `logOut` for
@Wanger_mediabot.** That would cut it off from Serverless.

## Setup

```sh
git clone <this repository> && cd <repository>/wanger-media/external-service
cp .env.example .env        # then edit .env: DOMAIN, API_KEY (long random), BOT_TOKEN, TELEGRAM_API_ID/HASH
docker compose up -d --build
curl -H "Authorization: Bearer <API_KEY>" https://<DOMAIN>/v1/health
```

A good key: `openssl rand -hex 32`. Then in Telegram: `/admin` → 🧩 Platforms → 🔌 External service
→ 🔗 Address (`https://<DOMAIN>`) → 🔑 Key (the message is deleted at once) → 🩺 Test → 📦 Relay: turn
on. Optional: 📏 Max size (51–2000 MB).

When is it used? Only in private chats, for a post with one file, when nothing fits 50 MB — or
when the user's preferred quality is "best" and a bigger ready-made file exists. Groups keep
their own size limit. If the service doesn't accept a job, the bot falls back to what it can send itself.

## Updating and stopping

`git pull && docker compose up -d --build` · `docker compose down` (the bot then simply sends what it
can by itself; remove the service in the admin panel to stop trying).
