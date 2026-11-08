# Wanger Converter — worker

The optional Python worker for heavy conversions (spec §2, §8). The bot on Telegram Serverless works
without it; worker-only tools appear in the bot only after the owner stores `WORKER_URL` and
`WORKER_SECRET` and the worker reports them in `/v1/capabilities`.

**C4 tools:** image convert (JPG, PNG, WEBP, GIF, BMP, TIFF, ICO, AVIF, HEIC), resize, crop, rotate,
flip, compress, strip metadata, grayscale, blur, sharpen, colour mode, watermark, text on image, and
text → image.
**C5 tools:** offline OCR with Tesseract 5 (fas eng ara deu fra spa tur + OSD; photos and scanned PDFs
≤ 20 pages; preprocessing measured in `../docs/OCR_BENCHMARK.md`), PDF text extraction, PDF → images,
PDF compress, PDF watermark (Persian), PDF unlock with a password (never stored).
Benchmark tools: `bench/` (`make_set.py`, `run_tesseract.py`, `score.py`) — not part of the image.

## How it works
- `app/main.py` — FastAPI. Every `/v1` request is signed by the bot (`app/security.py`):
  `HMAC-SHA256(WORKER_SECRET, "{ts}.{nonce}.{METHOD}.{path?query}." + body)` in
  `X-Wanger-Timestamp` / `X-Wanger-Nonce` / `X-Wanger-Signature`, ±300 s, each nonce once.
- `app/queue.py` — a durable SQLite queue (`/data/worker.sqlite`): `light` and `heavy` queues, idempotent
  by job id, per-user concurrency (2 light / 1 heavy) and at most 5 active jobs per user. Jobs caught
  by a restart fail with a message (never re-run silently: that could send a result twice). User text
  (text → image) is removed from the row when the job ends.
- `app/runner.py` — threads that claim jobs, download inputs with the bot token, run the operation in
  the sandbox, validate the output, send it with `sendDocument`, and edit the bot's status message.
- `app/sandbox.py` + `app/sandbox_entry.py` — every operation runs in a fresh child process: own process
  group (killed as a group on timeout/cancel), `RLIMIT_AS/CPU/FSIZE/NOFILE/CORE`, minimal environment
  (no token, no secret), `python -I`, files only inside the job's temp dir.
- `app/telegram.py` — the only Bot API client; methods outside an allowlist (`setWebhook`,
  `deleteWebhook`, `getUpdates`, …) raise before any request.
- `app/processors/` — plugins. An operation declares an id (≤ 8 chars, used in `callback_data`), a
  pydantic params model (validated at submit time), its inputs, queue, timeout and required engine
  features. `app/registry.py` self-tests the engines at start-up and only announces what works.
- Images: header size checked before decoding (`MAX_IMAGE_PIXELS`, `MAX_SIDE`), only the decoder of
  the detected type may run, EXIF orientation applied, EXIF never copied to outputs, ICC kept,
  transparency flattened for formats without alpha (with a note), every output re-opened and verified.
- Text: RAQM (HarfBuzz + FriBiDi) shaping with the bundled OFL fonts Vazirmatn, Sahel and Samim
  (`fonts/*-OFL.txt`). Without RAQM, text tools are not announced.

## Run locally
```bash
cd bots/converter/worker
pip install -r requirements-dev.txt      # Python ≥ 3.12; Linux: libfribidi0 (Persian text) and
# tesseract-ocr tesseract-ocr-osd tesseract-ocr-{fas,eng,ara,deu,fra,spa,tur} (offline OCR)
ruff check app tests bench && python -m pytest -q
BOT_TOKEN=… WORKER_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") \
  DATA_DIR=./.data TMP_DIR=./.tmp uvicorn app.main:app_factory --factory --port 8080
```

## Docker
```bash
cp .env.example .env        # fill BOT_TOKEN, WORKER_SECRET, WORKER_DOMAIN
docker compose up -d --build                    # worker only, on 127.0.0.1:8080
docker compose --profile tls up -d --build      # + Caddy with an automatic HTTPS certificate
docker build --target test .                    # the test suite inside the image's environment
```
The image runs as uid 10001 with a read-only root filesystem, no capabilities, `tini` as PID 1 and a
healthcheck on `/readyz`. Hosting options and a step-by-step guide: [`../docs/HOSTING.md`](../docs/HOSTING.md).

## Connect the bot
In a private chat with the bot (owner only; the message is deleted right away):
```
/secret set WORKER_URL https://your-worker-domain
/secret set WORKER_SECRET <the same value as in .env>
```
`/panel → 🛠 Worker` then shows its health and tools.
