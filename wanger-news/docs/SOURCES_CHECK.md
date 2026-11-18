# Live source check — 2026-11-18

Command: `python -m wanger_news check-sources --all --markdown` (real network, the project's own
fetcher: SSRF guard, robots.txt, size cap, feedparser). Run from the development container;
GitHub runners may see different results (geo-blocking, bot protection). The `test` job of
`.github/workflows/news.yml` repeats a live dry run on every push.

Result: **26/29 RSS feeds OK**. All **16 active** sources work; 7 Persian candidates work too.

| source | active | result | entries | newest item | with image | robots.txt |
|---|---|---|---|---|---|---|
| `bbc-world` | yes | ok | 33 | 2026-11-18 17:51 UTC | 33 | allowed |
| `guardian-world` | yes | ok | 45 | 2026-11-18 17:56 UTC | 0 | allowed |
| `aljazeera` | yes | ok | 25 | 2026-11-18 17:50 UTC | 0 | allowed |
| `dw-en` | yes | ok | 50 | 2026-11-18 17:52 UTC | 0 | allowed |
| `france24-en` | yes | ok | 24 | 2026-11-18 18:17 UTC | 23 | allowed |
| `npr-world` | yes | ok | 10 | 2026-11-18 18:15 UTC | 0 | no robots.txt (404) |
| `politico` | yes | ok | 30 | 2026-11-18 12:00 UTC | 19 | no robots.txt (404) |
| `cnn-world` | no | ok | 29 | 2023-09-18 02:57 UTC | 25 | no robots.txt (404) |
| `cnbc` | no | error: http_status: HTTP 403 | - | - | - | no robots.txt (403) |
| `bloomberg` | no | ok | 20 | 2026-11-18 17:55 UTC | 0 | no robots.txt (404) |
| `ft` | no | ok | 11 | 2026-11-18 17:05 UTC | 11 | allowed |
| `un-news` | yes | ok | 30 | 2026-11-18 12:00 UTC | 30 | allowed |
| `who-news` | yes | ok | 50 | 2026-10-10 07:49 UTC | 0 | allowed |
| `nasa` | yes | ok | 10 | 2026-11-18 17:50 UTC | 1 | allowed |
| `ars-technica` | yes | ok | 20 | 2026-11-18 18:10 UTC | 20 | no robots.txt (404) |
| `the-verge` | yes | ok | 10 | 2026-11-18 18:00 UTC | 0 | allowed |
| `techcrunch` | yes | ok | 20 | 2026-11-18 18:04 UTC | 0 | allowed |
| `mit-tech-review` | yes | ok | 10 | 2026-11-18 14:42 UTC | 0 | allowed |
| `nature` | yes | ok | 50 | 2026-11-18 00:00 UTC | 0 | allowed |
| `sciencedaily` | yes | ok | 50 | 2026-11-18 12:33 UTC | 0 | allowed |
| `bbc-persian` | no | ok | 29 | 2026-11-18 18:09 UTC | 29 | allowed |
| `dw-persian` | no | ok | 20 | 2026-11-18 15:44 UTC | 0 | allowed |
| `euronews-persian` | no | ok | 50 | 2026-11-18 18:19 UTC | 0 | allowed |
| `independent-persian` | no | ok | 10 | 2026-11-18 17:43 UTC | 0 | allowed |
| `radio-farda` | no | ok | 20 | 2026-11-18 17:30 UTC | 20 | allowed |
| `voa-persian` | no | ok | 20 | 2026-11-18 17:35 UTC | 20 | allowed |
| `iran-international` | no | ok | 50 | 2026-11-18 17:36 UTC | 50 | allowed |
| `irna` | no | skipped: robots.txt unreachable (timeout) | - | - | - | robots.txt unreachable (timeout) |
| `isna` | no | skipped: robots.txt unreachable (timeout) | - | - | - | robots.txt unreachable (timeout) |

Not RSS (not in the table): `reuters`, `ap` — no public feed exists (licensed APIs only), so they
are recorded inactive with the reason. `source-channel` is the Telegram source channel.

Notes
- `cnn-world` answers but its newest item is from 2023-09: CNN stopped updating rss.cnn.com.
- `cnbc` refuses non-browser clients with 403; not bypassed (spec §5: no circumvention).
- `bloomberg`, `ft` work technically but their articles are paywalled → inactive (spec §3.4).
- `who-news` works but its newest item is from 2026-10-10 (rarely updated); kept active.
- Domestic Iranian sites (IRNA, ISNA; Mehr, Tasnim, Khabaronline, Zoomit, Digiato were probed
  with curl too) did not answer from this network — likely blocked outside Iran. They would need a
  runner inside Iran (option B) — the owner's decision.
- "with image" counts entries whose feed itself carries an image (media:content / thumbnail /
  enclosure); only those images are ever posted, credited to the source.
