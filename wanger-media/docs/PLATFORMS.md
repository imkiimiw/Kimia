# Platforms — research for Wanger Media

Checked **2026-11-05** (Phase 0), updated **2026-11-06** (Phase 3) for `@Wanger_mediabot`
(app9080356648, CLI 0.2.0). **Built so far (Phase 3): X/Twitter, Pinterest, Snapchat** — see §7 for
what was measured with the real adapters. Every other platform is UNAVAILABLE until its adapter is
built (Phase 7); the statuses given for them below are what we *expect*.

Legend: **Official** = in the platform's own docs · **Measured** = observed today from Telegram
Serverless with a temporary `tgcloud run` probe (read-only, never deployed, deleted afterwards;
honest User-Agent `WangerMediaBot/…`, no cookies, no login) · **Unverified** = from third-party
sources or not testable yet. Measurements can change without notice: platforms change their pages.

## 1. Telegram Serverless facts (brief §3)

| Item | Result | Source |
|---|---|---|
| Bot | `@Wanger_mediabot`, id 9080356648, `can_join_groups: true`, `can_read_all_group_messages: false` (**privacy mode is ON**), inline off. Cloud: revision 0, no modules, no tables, webhook "in sync", 5 updates pending. | Measured |
| CPU per invocation | **≈ 3 s** — two loops were stopped with `CPU timer exceeded` at 3 005 ms. | Measured |
| Wall clock | A 7.3 s HTTP response completed. An earlier bot in this repo measured ≈ 30 s under `tgcloud run`. Not documented. | Measured / other bot |
| `fetch` | **30 MB per response** (streaming doesn't raise it). Redirects followed; `res.url` = final URL. 3 of ~40 requests failed with `fetch: request failed` after ≈ 5.0 s, while a 7 s response succeeded → treat ≈ 5 s stalls as possible and retry once when the budget allows. | Official + Measured |
| Bot API sizes | Upload 50 MB (photo 10 MB); `getFile` 20 MB. By URL Telegram fetches ≤ 20 MB (photo ≤ 5 MB) itself — Bot API docs. | Official |
| Scheduler / cron / timers | **None.** Not in the docs or CLI; `setTimeout`, `setInterval`, `queueMicrotask` are absent. Code runs only during an update, an endpoint call or `tgcloud run`. | Official + Measured |
| DB reads | **`Sqlite query rows_read limit exceeded`** once a query reads ≈ 50 000 rows (a recursive count of 24 000 rows ≈ 48 000 reads passed; 25 500 failed). Very large queries fail with a generic `Sqlite error`. | Measured |
| DB statement size | A statement with **4 000 bound parameters worked, 4 096 failed** (`Run error`). The ~10k-row insert cap in the brief is probably this limit: rows × columns ≤ ~4 000 (inferred; no table written). | Measured |
| DB writes | Speed of separate writes not measured (no tables exist; Phase 1 measures on its own tables). No transactions (an earlier bot: `BEGIN` → not authorized); one statement = one atomic step. | Other bot |
| Globals | Present: `TextEncoder`, `TextDecoder`, `Intl`, `crypto`, `WebAssembly`. **Absent:** `URL`, `URLSearchParams`, `atob`, `btoa`, `AbortController`, `structuredClone`, `Blob`, `Response`, `Headers`, `ReadableStream`, `DecompressionStream`, `performance`, `Buffer`, `process`. → URLs are parsed by our own strict parser; a `fetch` can't be cancelled by us. | Measured |
| Network egress | Facebook answered in Dutch and Meta's CDN host was `scontent-ams2` → Telegram's servers appear to be in the **Netherlands**. Geo-limited content follows NL availability (we never work around it). | Measured (inferred) |
| Module count | Not documented; earlier bots here: 104 modules refused, 88 and 94 deployed. | Other bot |
| Pricing / quotas | None published. | Official |

## 2. Methods and the legal frame

- `official` — a documented API with owner-provided credentials. `public` — what the platform itself
  serves without login (oEmbed, Open Graph tags, its own public/embed JSON). `external` — an
  owner-run service (§6 contract below). **Third-party scraper services are none of these.**
- Almost every platform's terms forbid automated collection ("scraping") without permission, even of
  public pages. Enabling `public` is therefore the owner's informed choice per platform (risk note
  first, audit-logged). Copyright stays with the creators: the user accepts the disclaimer, every
  caption names the platform and links the source, and nothing is re-watermarked or cropped.
- Never: DRM, private/login-only/age-gated/paywalled content, cookies or accounts, block or geo or
  rate-limit workarounds, browser impersonation.

## 3. Summary

| Platform | Official API (for others' public posts) | `public` on Serverless (measured) | Expected status | ToS risk of `public` |
|---|---|---|---|---|
| **X / Twitter** ✅ built | Paid pay-per-use (no free tier for new devs) | ✅ media (photos, complete MP4 videos/GIFs); FxTwitter as free third-party method | **SUPPORTED** | High |
| **Pinterest** ✅ built | Needs app review (Standard access) + OAuth | ✅ image pins and video pins (MP4); Idea Pins: cover image only | **LIMITED** | High |
| **Snapchat** ✅ built | Allowlisted partners only | ✅ Spotlight MP4 | **LIMITED** (Spotlight only) | High |
| Discord | — | ✅ host reachable; links must still be signed | SUPPORTED (direct attachments) | Low |
| Instagram | Own / business accounts, app review | ⚠️ embed page exposes media | LIMITED | Very high |
| Facebook | Own pages only | metadata (oEmbed html, og:image) | METADATA_ONLY | High |
| Threads | Own account only | oEmbed reachable ❓ | METADATA_ONLY | High |
| TikTok | No download API | metadata; video file 403 without cookies | METADATA_ONLY | High |
| YouTube | Data API: metadata only | metadata (oEmbed) | METADATA_ONLY | (no download) |
| Reddit | Approval only; new requests closing | JSON 403; oEmbed metadata | METADATA_ONLY | Medium |
| LinkedIn | Approved orgs, own content | 403 | UNAVAILABLE | High |
| Spotify | (not needed) | metadata (oEmbed + Open Graph) | METADATA_ONLY (DRM) | Low |
| SoundCloud | Needs paid Artist Pro to register | metadata (oEmbed) | METADATA_ONLY | Low |
| Twitch | Free app; clip download only for channel editors | metadata (Open Graph); API needs OAuth token | METADATA_ONLY | Low |

## 4. Per platform

### X / Twitter — proposed for Phase 3
- **Official:** X API v2. Since Feb 2026 new developers get pay-per-use only, reportedly ≈ $0.005 per
  post read (Unverified: third-party pages; check docs.x.com). Needs the owner's developer account,
  credits and a bearer token → money decision; not needed for Phase 3.
- **Public (Measured):** X's own embed JSON `cdn.syndication.twimg.com/tweet-result?id=<id>&token=<t>`
  (`t` is derived from the id exactly as X's embed script does; not a credential) → JSON with
  `mediaDetails`: photos on `pbs.twimg.com`, videos/GIFs as `video_info.variants` — **complete MP4
  files with audio** at several bitrates on `video.twimg.com`; `possibly_sensitive` flag. HEAD gives
  `Content-Length`; `Range: bytes=0-0` → 206. Samples: 77 s video → variants of 143 MB, 41 MB and
  smaller; 25 s video → 19 MB / 5.5 MB. Latency 0.26–4.4 s; 2 of 8 calls failed at ≈ 5 s (`fetch: request failed`). A missing
  post → 404 HTML. `publish.x.com/oembed` → html + author (metadata fallback).
- **Limits:** protected / deleted posts aren't served; `possibly_sensitive` posts are refused (could
  be age-gated). If X starts rejecting the endpoint → TEMPORARILY_DISABLED, no workaround.
- **Terms:** X's Terms: "crawling or scraping the Services in any form, for any purpose without our
  prior written consent is expressly prohibited" (since Sept 2023). Copyright: the poster's.
- **Built (Phase 3):** `public` and `thirdparty` (FxTwitter, allowed by the owner) — SUPPORTED
  (photo, album ≤ 4, video, GIF); `official` needs paid credentials (not built).

### Pinterest — proposed for Phase 3
- **Official:** API v5 — Trial access is sandbox-only; Standard (production) needs a review with a
  screen recording of the OAuth flow. OAuth needs a public callback URL, which Serverless doesn't
  offer (brief §11.8) → REQUIRES_APPROVAL.
- **Public (Measured):** the JSON behind Pinterest's official embed widget,
  `widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=<id>` → images (236x, 564x), description,
  pinner, board, `is_video`. `i.pinimg.com/originals/<same path>` → 200 with `Content-Length` and
  Range. `pinterest.com/oembed.json` → thumbnail; pin pages carry `og:image`. **Correction (Phase
  3):** for a video pin the same pin-info JSON has `videos.video_list` with a complete MP4
  (`V_720P`, `v1.pinimg.com`) next to an HLS playlist — Phase 0 had only looked at users' pin lists,
  which lack it. Idea Pins (`story_pin_data`) carry no video file. `pin.it` short links redirect via
  `api.pinterest.com` to `/pin/<id>/` (tested against a simulated chain; no real short link checked).
- **Terms:** scraping / automated collection without Pinterest's prior permission is forbidden.
  Pins are often re-posts: the caption credits the source.
- **Built (Phase 3):** `public` — image pins (original, else 564x) and video pins (MP4); Idea Pins
  send their cover image with a note → platform LIMITED.

### Snapchat — proposed for Phase 3
- **Official:** Public Profile API (metadata/stats) requires an OAuth app plus allowlisting by a Snap
  contact → REQUIRES_APPROVAL. Snap Kit gives no media.
- **Public (Measured):** public Spotlight pages (`snapchat.com/spotlight/<id>`, redirect to
  `snapchat.com/@user/spotlight/<id>`) carry Open Graph `og:video` = an MP4 on `cf-st.sc-cdn.net`
  (sample 540×960, 1.56 MB, Range 206) and `og:image`, title with the creator. Stories, profiles and
  `t.snapchat.com` short links: Unverified.
- **Terms:** robots, spiders, crawlers and scrapers are forbidden.
- **Built (Phase 3):** `public` for Spotlight links (also `snapchat.com/t/…` short links) → platform
  LIMITED (stories and other link types answer "this kind of link isn't supported").

### Discord
- **Public:** only direct attachment links (`cdn.discordapp.com` / `media.discordapp.net`). Since
  Dec 2023 they carry signed `ex`/`is`/`hm` parameters and expire (~24 h, Unverified); unsigned or
  expired → 404 "This content is no longer available." (Measured). Message links need login →
  UNAVAILABLE. Discord's CDN has been used for malware: deliver media types only (checked by
  Content-Type), never executables or archives.
- **Expected:** SUPPORTED for valid attachment links. Low ToS risk (the user hands over a file link).

### Instagram
- **Official:** the Instagram API reads the logged-in professional account's own media; Business
  Discovery (other business accounts) needs app review and a professional account (Unverified
  details) → REQUIRES_APPROVAL. oEmbed is tokenless since 2026-06-15 but returns html only
  (`thumbnail_url` / `author_name` removed on 2025-11-03) (Official + Measured).
- **Public (Measured):** the public embed page `instagram.com/p/<code>/embed/captioned/` → 200 with
  CDN image URLs and a `video_url` (MP4) for the sampled public post. Reels, carousels, stability and
  rate limits: Unverified. Meta blocks automated access actively.
- **Terms:** Instagram forbids collecting information "in an automated way without our express
  permission"; Meta's Automated Data Collection Terms apply. Highest risk of the list.
- **Expected:** LIMITED (public posts only, if the owner accepts the risk).

### Facebook
- **Official:** Graph API only for pages the owner manages. oEmbed Post/Video tokenless → html only
  (Measured). **Public (Measured):** page HTML → `og:image`; public video `og:video`: Unverified.
- **Terms:** Meta Automated Data Collection Terms. **Expected:** METADATA_ONLY (LIMITED if public
  video files prove reachable).

### Threads
- **Official:** Threads API = the user's own account (OAuth). oEmbed is tokenless since 2026 (Meta;
  sources disagree on `graph.threads.net` vs `.com`). Measured: `graph.threads.net/v1.0/oembed`
  reachable; our test URL was not a real post (400) → Unverified. **Expected:** METADATA_ONLY.

### TikTok
- **Official:** Display API (OAuth, the user's own videos), Research API (academic approval), no API
  for downloading others' videos. oEmbed is public.
- **Public (Measured):** oEmbed → html only in our sample (no thumbnail/author). The video page →
  200 with `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON (`playAddr`, `downloadAddr`, cover, author), but
  fetching `playAddr` **without cookies → 403**. We never use cookies → no video.
- **Terms:** automated scraping/extraction forbidden without written approval (Unverified wording).
- **Expected:** METADATA_ONLY (title, author, cover from the page JSON; cover fetch Unverified).

### YouTube
- **Official:** Data API v3 (free API key) = metadata only. Terms: no downloading unless YouTube shows
  a download link; most qualities are separate audio/video streams anyway.
- **Measured:** oEmbed → title, author, thumbnail. **Expected:** METADATA_ONLY.

### Reddit
- **Official:** self-service API keys ended Nov 2025 (Responsible Builder Policy); access needs
  approval; new public-API requests reportedly closed 2026-10-31 (Unverified) → REQUIRES_APPROVAL.
- **Measured:** `www.reddit.com/…json` → 403, `old.reddit.com` → redirect to login (blocked from
  Serverless). `reddit.com/oembed` → title, author, html. Hosted video (`v.redd.it`) is separate
  audio/video streams. Direct `i.redd.it` image links: Unverified.
- **Expected:** METADATA_ONLY.

### LinkedIn
- **Official:** reading members' posts is a restricted private permission; Community Management API
  only for registered organisations, own content → REQUIRES_APPROVAL.
- **Measured:** 403 to Serverless. **Expected:** UNAVAILABLE.

### Spotify
- DRM → metadata only (brief §7). **Measured:** oEmbed → title + cover (no artist); the track page's
  Open Graph → title, "Artist · Album · Song · Year", 640 px cover. Its `og:audio` 30-s preview is
  **not** used (brief: metadata only). No credentials needed (the Web API's dev mode now needs the
  owner's Premium — not required). **Expected:** METADATA_ONLY.

### SoundCloud
- **Official:** registering an API app needs a paid **Artist Pro** subscription (SoundCloud docs);
  client credentials cover public search/playback/resolve. Streams are HLS segments (no merging), and
  downloads exist only where the uploader enabled them (Unverified). Money decision, not needed now.
- **Measured:** oEmbed → title, description, author, 500 px artwork. **Expected:** METADATA_ONLY.

### Twitch
- **Official:** Helix with a free app (client credentials; the owner's Twitch account needs 2FA) →
  clip/video metadata. "Get Clips Download" (open beta) returns files only with an editor's
  `editor:manage:clips` / `channel:manage:clips` authorisation for that channel → strangers' clips
  can't be downloaded. VODs are HLS.
- **Measured:** Helix without a token → 401; channel pages have Open Graph title/image.
  **Expected:** METADATA_ONLY.

## 5. Proposal: the first 3 platforms

**X/Twitter, Pinterest, Snapchat (Spotlight).** All three were verified *from Serverless* to serve
real media files publicly, without login or cookies, with sizes known before downloading. Together
they exercise every delivery path in §6 of the brief: photo albums (`sendMediaGroup`), large videos
with smaller ready-made variants (X), images by URL and by upload (Pinterest), short MP4 by URL
(Snapchat). Lowest-risk substitute for any of them: **Discord** attachments.

The metadata-only platforms (Spotify, YouTube, SoundCloud, TikTok, Reddit, Twitch) are cheap and
truthful to add later in Phase 7, one per session.

## 6. `external` service contract (draft; finalised in Phase 3, not built)

`POST <owner's base URL>/v1/resolve`, header `Authorization: Bearer <key stored by the owner>`, JSON
`{ "url", "platform", "max_bytes", "quality": "best"|"small", "request_id" }` →
`{ "ok": true, "title", "author", "items": [{ "type": "photo"|"video"|"audio"|"document", "url",
"bytes", "mime", "width", "height", "duration", "variant" }] }` or
`{ "ok": false, "code": "NOT_FOUND"|"PRIVATE"|"DRM"|"TOO_LARGE"|"UNSUPPORTED"|"RATE_LIMITED"|"ERROR" }`.
Item URLs must be HTTPS on the service's own host; the bot still applies every policy check (§6 of
the brief), the size limits and the hard "never" list.

## Sources

Telegram: [Serverless](https://core.telegram.org/bots/serverless) ("Recent changes: October 6, 2026").
X: [TechCrunch on the scraping clause](https://techcrunch.com/2023/09/08/x-updates-its-terms-to-ban-crawling-and-scraping),
[pay-per-use summary (third-party)](https://www.postproxy.dev/blog/x-api-pricing-2026/),
[react-tweet](https://github.com/vercel-labs/react-tweet/releases).
Reddit: [Responsible Builder Policy thread](https://r.datuan.dev/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/npnaxhk/?context=3),
[Oct 31 cutoff (third-party)](https://www.redditapis.com/blogs/reddit-data-api-october-31-cutoff-2026).
Meta: [oEmbed updates](https://developers.facebook.com/blog/post/2025/04/08/oembed-updates/),
[2025 changelog](https://developers.facebook.com/docs/graph-api/changelog/non-versioned-changes/nvc-2025),
[tokenless oEmbed](https://developers.facebook.com/blog/post/2026/06/15/tokenless-access-to-meta-oembed-apis/),
[Threads embed](https://developers.secure.facebook.com/docs/threads/tools-and-resources/embed-a-threads-post),
[Instagram terms](https://help.instagram.com/581066165581870).
TikTok: [Embed videos](https://developers.tiktok.com/doc/embed-videos),
[terms excerpt (third-party)](https://conductatlas.com/platform/tiktok/tiktok-terms-of-service/prohibition-on-scraping-and-data-extraction/).
Pinterest: [access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/),
[Business terms](https://business.pinterest.com/business-terms-of-service/).
Snapchat: [Public Profile API](https://developers.snap.com/api/marketing-api/Public-Profile-API/Introduction),
[terms excerpt (third-party)](https://conductatlas.com/platform/snapchat/snapchat-terms-of-service/provision/CA-P-024173/prohibition-on-automated-scraping-of-services/).
Twitch: [Get Clips Download beta](https://discuss.dev.twitch.com/t/get-clips-download-twitch-api-endpoint-now-available-in-open-beta/64334).
Spotify: [Feb 2026 dev-mode changes](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
SoundCloud: [API guide](https://developers.soundcloud.com/docs/api/guide).
LinkedIn: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api).
Discord: [signed CDN links](https://github.com/useapi/discord-cdn-proxy/blob/main/README.md),
[BleepingComputer](https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware-delivery).
YouTube: [API Services terms](https://developers.google.com/youtube/terms).

## 7. Phase 3 measurements (2026-11-06, real adapters run with `tgcloud run`, no messages sent)

| Check | Result |
|---|---|
| sdk `fetch` redirects | `redirect: 'manual'` works (3xx with `Location`); `'error'` throws. The adapters follow redirects themselves and check every hop against the allowlist. |
| **HEAD to Snapchat's CDN** | A `HEAD` to `cf-st.sc-cdn.net` **kills the whole invocation** with an HTTP 500 from the platform — not an exception the code can catch (seen in Phase 0 and again now). A one-byte Range GET works (206, `bytes 0-0/1558733`). → Snapchat sizes are probed with Range only; HEAD is used only where measured safe (X, Pinterest). |
| X `public` (syndication) | Video post: 5 + 4 MP4 variants, 136 / 39 / 9.9 / 3 / 1 MB and 18.1 / 5.2 / 1.5 / 0.4 MB → auto picks 9.9 MB and 18.1 MB (by URL). Photos 1.8–2.9 MB originals. GIF and a NASA video fine. 0.4–2.7 s per post. |
| X `thirdparty` (FxTwitter) | Same variants as syndication (URLs carry `?tag=…`), 0.56 s. |
| Pinterest | Image pin: the `originals/` URL gave no size for one pin (missing original) → the 564x variant was used. Video pin: 0.9 MB MP4. Idea Pin: cover image. |
| Snapchat | Spotlight → 1.5 MB MP4 by Range probe; 0.46 s. |
| Health checks | X, Pinterest, Snapchat: all working. |
| Transient failures | Range/HEAD to `i.pinimg.com` / `v1.pinimg.com` failed once with `fetch: request failed` after ≈ 5 s, then worked three times in a row (20–1800 ms). The pipeline treats an unknown size as "by URL only". |
| Text | Pinterest descriptions and X text contain HTML entities (`&#8217;`, `&amp;`): decoded before captions are built. |
