// The worker client (C4): signed requests to the optional Python worker (spec §2, §8) and the
// worker's capabilities, cached in `settings` (10 min when it answers, 2 min when it doesn't, so a
// dead worker hides its tools quickly and isn't asked on every update).
//   signature = hex(HMAC-SHA256(WORKER_SECRET, `${ts}.${nonce}.${METHOD}.${path}.` + body))
//   headers X-Wanger-Timestamp, X-Wanger-Nonce (fresh per attempt), X-Wanger-Signature
// The secret is read here and only used for the HMAC; it is never sent, logged or traced.
import { fetch } from 'sdk';
import { WORKER_CAPS_TTL_S, WORKER_DOWN_TTL_S } from './config.js';
import * as store from './db/files.js';
import { addError, getSecret, getSetting, hasSecret, setSetting } from './db/system.js';
import * as log from './log.js';
import { nowS } from './util.js';

const enc = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export class WorkerError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** HMAC-SHA256 of `message` (bytes) → lowercase hex. */
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)));
}

export const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));

/** The three auth headers for one request. `path` includes the query string. */
export async function signedHeaders(secret, method, path, body, ts = nowS(), nonce = newNonce()) {
  const head = enc.encode(`${ts}.${nonce}.${method}.${path}.`);
  const msg = new Uint8Array(head.length + body.length);
  msg.set(head, 0);
  msg.set(body, head.length);
  return { 'X-Wanger-Timestamp': String(ts), 'X-Wanger-Nonce': nonce, 'X-Wanger-Signature': await hmacHex(secret, msg) };
}

async function config() {
  const [url, secret] = await Promise.all([getSecret('WORKER_URL'), getSecret('WORKER_SECRET')]);
  return url && secret ? { url: url.replace(/\/+$/, ''), secret } : null;
}

/**
 * One signed request. → { status, data }. Throws WorkerError: NOT_CONFIGURED, UNREACHABLE, AUTH (401:
 * the secrets don't match — reported to the errors table). A network failure is retried once with a
 * fresh nonce for POST only (job submission is idempotent by job id); reads fail fast, because a dead
 * host costs 1.6–3.2 s per attempt on Serverless (measured in C4, docs/LIMITS.md §6d).
 */
export async function request(ctx, method, path, payload, { retry = method === 'POST' } = {}) {
  const cfg = await config();
  if (!cfg) throw new WorkerError('NOT_CONFIGURED');
  const body = payload === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(payload));
  let res = null;
  for (let attempt = 0; attempt < (retry ? 2 : 1) && !res; attempt++) {
    const headers = { ...(await signedHeaders(cfg.secret, method, path, body)), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) };
    try {
      res = await fetch(cfg.url + path, { method, headers, ...(payload === undefined ? {} : { body }) });
    } catch {
      res = null;
    }
  }
  if (!res) throw new WorkerError('UNREACHABLE');
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.status === 401) {
    log.error('worker.auth_failed', { update_id: ctx.updateId, error_code: data && data.error });
    await addError(ctx.now, 'worker', 'WORKER_AUTH', data && data.error ? String(data.error) : null);
    throw new WorkerError('AUTH', 401);
  }
  return { status: res.status, data };
}

const compact = (caps) => ({
  version: caps.version || '?',
  ops: Object.keys(caps.ops || {}),
  inputs: Object.fromEntries(Object.entries(caps.ops || {}).map(([k, v]) => [k, v.inputs || []])),
  write: (caps.formats && caps.formats.image_write) || [],
  maxMb: (caps.limits && caps.limits.max_input_mb) || 20,
  features: Object.fromEntries(Object.entries(caps.features || {}).filter(([, v]) => typeof v === 'boolean')),
  ocrLangs: (caps.ocr && caps.ocr.langs) || [],
  ocrMaxPages: (caps.ocr && caps.ocr.max_pages) || 20,
});

/**
 * The worker as the bot sees it → ctx.worker = { configured, available, ops: Set, inputs, write, maxMb, why }.
 * Reads the cache; asks the worker when the cache is stale (or `refresh`).
 */
export async function loadWorker(ctx, { refresh = false } = {}) {
  if (ctx.worker && !refresh) return ctx.worker;
  const [hasUrl, hasKey] = await Promise.all([hasSecret('WORKER_URL'), hasSecret('WORKER_SECRET')]);
  if (!hasUrl || !hasKey) return (ctx.worker = { configured: false, available: false, ops: new Set(), inputs: {}, write: [], maxMb: 20, why: 'NOT_CONFIGURED' });
  let cached = refresh ? null : await getSetting('worker.caps', null);
  const fresh = cached && cached.at > ctx.now - (cached.ok ? WORKER_CAPS_TTL_S : WORKER_DOWN_TTL_S);
  if (!fresh) {
    // claim the refresh first, so concurrent updates keep using the old answer instead of all asking
    if (cached) await setSetting('worker.caps', { ...cached, at: ctx.now - (cached.ok ? WORKER_CAPS_TTL_S : WORKER_DOWN_TTL_S) + 30 }, ctx.now);
    try {
      const r = await request(ctx, 'GET', '/v1/capabilities');
      cached = r.status === 200 && r.data && r.data.ops ? { at: ctx.now, ok: true, caps: compact(r.data) } : { at: ctx.now, ok: false, why: `HTTP_${r.status}` };
    } catch (e) {
      cached = { at: ctx.now, ok: false, why: e.code || 'UNREACHABLE' };
    }
    await setSetting('worker.caps', cached, ctx.now);
    if (!cached.ok) log.warn('worker.down', { update_id: ctx.updateId, error_code: cached.why });
  }
  const caps = cached.ok ? cached.caps : null;
  ctx.worker = {
    configured: true, available: !!caps, ops: new Set(caps ? caps.ops : []), inputs: caps ? caps.inputs : {}, write: caps ? caps.write : [],
    maxMb: caps ? caps.maxMb : 20, version: caps ? caps.version : null, features: caps ? caps.features : {}, why: cached.ok ? null : cached.why, at: cached.at,
    ocrLangs: caps ? caps.ocrLangs || [] : [], ocrMaxPages: caps ? caps.ocrMaxPages || 20 : 20,
  };
  return ctx.worker;
}

/** A failed call means the worker is down: hide its tools now (re-checked after WORKER_DOWN_TTL_S). */
export async function markDown(ctx, why) {
  await setSetting('worker.caps', { at: ctx.now, ok: false, why }, ctx.now);
  if (ctx.worker) ctx.worker = { ...ctx.worker, available: false, ops: new Set(), why };
}

export const clearCache = (now) => setSetting('worker.caps', null, now);

const FINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
const ACTIVE = new Set(['QUEUED', 'DOWNLOADING', 'PROCESSING', 'UPLOADING']);
const TYPE_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WEBP', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', ico: 'ICO', avif: 'AVIF', heic: 'HEIC' };

/**
 * Brings a bot job row (engine 'worker') up to date from the worker (spec §5: lazily, on /status,
 * history, the result button and housekeeping). → { job (row, updated), remote (worker's view) | null }
 */
export async function syncJob(ctx, job) {
  if (!job || job.engine !== 'worker' || FINAL.has(job.status)) return { job, remote: null };
  let r;
  try {
    r = await request(ctx, 'GET', `/v1/jobs/${job.id}?user_id=${job.user_id}`);
  } catch {
    return { job, remote: null };
  }
  if (r.status === 404) {
    // the worker forgets finished jobs after a day; a job it never saw is lost
    if (job.created_at < ctx.now - 86400) {
      await store.syncWorkerJob(job.id, { status: 'EXPIRED', errorCode: 'WORKER_LOST', finishedAt: ctx.now });
      return { job: { ...job, status: 'EXPIRED', error_code: 'WORKER_LOST' }, remote: null };
    }
    return { job, remote: null };
  }
  const w = r.data && r.data.job;
  if (r.status !== 200 || !w || !(FINAL.has(w.status) || ACTIVE.has(w.status))) return { job, remote: null };
  const outs = w.outputs || [];
  const one = outs.length === 1 ? outs[0] : null;
  const upd = {
    status: w.status,
    outputType: one ? TYPE_LABEL[one.type] || String(one.type || '').toUpperCase() : outs.length ? `${outs.length} files` : null,
    outputSize: outs.length ? outs.reduce((s, o) => s + (o.size || 0), 0) : null,
    outputFileId: one ? one.file_id : null,
    errorCode: w.error_code || null,
    finishedAt: w.finished_at ? Math.floor(w.finished_at) : null,
  };
  if (w.status !== job.status || FINAL.has(w.status)) await store.syncWorkerJob(job.id, upd);
  return {
    job: { ...job, status: upd.status, output_type: upd.outputType, output_size: upd.outputSize, output_file_id: upd.outputFileId, error_code: upd.errorCode, finished_at: upd.finishedAt },
    remote: w,
  };
}

/** Housekeeping: a few unfinished worker jobs (oldest first) are synced, so lists don't show them running forever. */
export async function syncStale(ctx, limit = 3) {
  const w = await loadWorker(ctx);
  if (!w.configured) return 0;
  const rows = await store.activeWorkerJobs(limit, ctx.now - 120);
  let n = 0;
  for (const j of rows) { const { job } = await syncJob(ctx, j); if (job.status !== j.status) n++; }
  return n;
}
