# C0 spikes

Probes used in Phase C0 to measure Telegram Serverless for this bot. Results: [../docs/LIMITS.md](../docs/LIMITS.md).
Nothing here is deployed. `scripts/spike.mjs` copies the probe into `tgcloud/` as `zz_*` modules, runs it
once with `tgcloud run` (through `scripts/tg.mjs`, this bot only) and always deletes the copies again.
**Never run `push` while a spike is running** — the CLI uploads every file under `tgcloud/`.

| File | What it is |
|---|---|
| `endpoints/zz_core.js` | Platform probe without libraries: `clock`, `globals`, `cpu`, `mem`, `wasm`, `wasm_big`, `net`, `wall`, `bot`, `file_up`, `file_rt`, `file_content`, `file_over`, `file_head`, `file_parallel`, `file_names`, `file_cleanup` |
| `endpoints/zz_lib.js` + `bench.js` | Vendored-library benchmarks (shared with the local runner): `zip_store`, `zip_deflate`, `zip_many`, `gzip`, `crc32`, `pdf_images`, `pdf_png`, `pdf_load`, `cpu` |
| `local.mjs` | The same benchmarks in local Node, as a baseline: `node spikes/local.mjs [big.pdf]` |
| `outside-send.mjs` | Sending/editing with the **bot token** from outside Serverless (needs `Converter_BOT_TOKEN`) |
| `vendor/` | fflate 0.8.3 and @cantoo/pdf-lib 2.11.1 (MIT, licenses next to them); move to `tgcloud/lib/vendor/` in C2 |

Examples (from `bots/converter/`):

```bash
npm run spike -- core '{ case: "globals" }'
npm run spike -- core '{ case: "cpu", sync: true, iters: 2.6e9 }'
npm run spike -- lib  '{ case: "zip_deflate", level: 6 }'
npm run spike -- lib  "{ case: 'pdf_load', then: 'split', url: 'https://…/big.pdf' }"
npm run spike -- size 0.999        # module-size probe (MB)
```

The database is touched only with `SELECT 1` (clock reads: `Date.now()` is frozen during synchronous
work and catches up after I/O). The `file_*`, `bot` cases call the real Bot API: `file_*` send silent
test messages to the owner's private chat and delete them (`file_up`/`file_rt` leave theirs for
`file_cleanup`, which takes the message ids).
