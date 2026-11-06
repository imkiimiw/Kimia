// Wanger Media external service — the large-file relay (docs/PHASE8.md). Node 22, no dependencies.
//   GET  /v1/health   → { ok, version, relay: { max_bytes }, resolve: false }
//   POST /v1/relay    → 202 { ok, queued } — downloads the file from the platform's CDN (every hop on
//                        the bot's allowlist, never more than the announced size), sends it to the chat
//                        through a local telegram-bot-api server (--local, ≤ 2000 MB), deletes it.
//   POST /v1/resolve  → { ok: false, code: 'UNSUPPORTED' } — no resolve engine is shipped (§1).
// Hard limits (brief §6), whatever the configuration: no DRM, no logging in, no cookies, no working
// around blocks, geo limits or rate limits; honest User-Agent.
// Environment: API_KEY, BOT_TOKEN, BOT_API_URL (default http://bot-api:8081), WORK_DIR (default /data/work,
// shared with the bot-api container), MAX_MB (default 2000, at most 2000), PORT (default 8080), MAX_JOBS (2).
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { allowedHost, authorized, MB, nextUrl, sendCall, validateRelay, VERSION } from './lib.mjs';

const env = process.env;
const API_KEY = env.API_KEY || '';
const BOT_TOKEN = env.BOT_TOKEN || '';
const BOT_API = (env.BOT_API_URL || 'http://bot-api:8081').replace(/\/+$/, '');
const WORK_DIR = env.WORK_DIR || '/data/work';
const MAX_BYTES = Math.min(Number(env.MAX_MB) || 2000, 2000) * MB;
const MAX_JOBS = Math.max(1, Number(env.MAX_JOBS) || 2);
const MAX_QUEUE = 20;
const UA = `WangerMediaRelay/${VERSION} (+https://t.me/Wanger_mediabot)`;
if (API_KEY.length < 16 || !BOT_TOKEN) {
  console.error('API_KEY (16+ characters) and BOT_TOKEN are required');
  process.exit(1);
}

const queue = [];
let running = 0;
const log = (...a) => console.log(new Date().toISOString(), ...a); // never the key, token or captions

async function download(job, path) {
  let url = job.url;
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowedHost(url, job.allow)) throw new Error('host not allowed');
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } }); // no cookies, ever
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = nextUrl(url, res.headers.get('location'));
      continue;
    }
    if (res.status !== 200 || !res.body) throw new Error('HTTP ' + res.status);
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > job.bytes) throw new Error('bigger than announced');
    let seen = 0;
    const limit = new TransformStream({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > job.bytes) ctl.error(new Error('bigger than announced'));
        else ctl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(limit)), createWriteStream(path));
    const size = (await stat(path)).size;
    if (size < job.bytes) throw new Error('short download');
    return size;
  }
  throw new Error('too many redirects');
}

async function bot(method, params) {
  const res = await fetch(`${BOT_API}/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.error_code || res.status}`);
  return j.result;
}

async function run(job) {
  const path = join(WORK_DIR, `${Date.now()}_${job.id.replace(/:/g, '_')}.bin`);
  const t0 = Date.now();
  try {
    await mkdir(WORK_DIR, { recursive: true });
    const size = await download(job, path);
    const call = sendCall(job, path);
    await bot(call.method, call.params);
    log('sent', job.id, Math.round(size / MB) + ' MB', Date.now() - t0 + ' ms');
  } catch (err) {
    log('failed', job.id, err.message);
    if (job.failText) {
      await bot('sendMessage', { chat_id: job.chatId, text: job.failText, ...(job.replyTo ? { reply_parameters: { message_id: job.replyTo, allow_sending_without_reply: true } } : {}) }).catch(() => {});
    }
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

function pump() {
  while (running < MAX_JOBS && queue.length) {
    const job = queue.shift();
    running++;
    run(job).finally(() => { running--; pump(); });
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 16384) throw new Error('too large');
  }
  return JSON.parse(s);
}

createServer(async (req, res) => {
  try {
    if (!authorized(req.headers.authorization, API_KEY)) return send(res, 401, { ok: false, code: 'ERROR' });
    if (req.method === 'GET' && req.url === '/v1/health') return send(res, 200, { ok: true, version: VERSION, relay: { max_bytes: MAX_BYTES }, resolve: false });
    if (req.method === 'POST' && req.url === '/v1/resolve') return send(res, 200, { ok: false, code: 'UNSUPPORTED' });
    if (req.method === 'POST' && req.url === '/v1/relay') {
      const v = validateRelay(await readJson(req), MAX_BYTES);
      if (v.code) return send(res, 400, { ok: false, code: v.code });
      if (queue.length >= MAX_QUEUE) return send(res, 429, { ok: false, code: 'RATE_LIMITED' });
      queue.push(v.job);
      pump();
      return send(res, 202, { ok: true, queued: true });
    }
    return send(res, 404, { ok: false, code: 'UNSUPPORTED' });
  } catch {
    return send(res, 400, { ok: false, code: 'ERROR' });
  }
}).listen(Number(env.PORT) || 8080, () => log(`relay ${VERSION} listening, max ${MAX_BYTES / MB} MB, ${MAX_JOBS} at a time`));
