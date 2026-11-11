/*
 * Phase 0 platform probe. NOT a project module: scripts/probe.mjs copies this file to
 * tgcloud/endpoints/zz_probe.js, runs it with `tgcloud run` (local code on the platform, nothing
 * deployed), and deletes the copy again. It writes nothing to the database, sends no messages and
 * only calls read-only Bot API methods (getMe, getChat, optionally getFile on a file_id you pass).
 *
 * Input: { test: '<name>', n?: number, file_id?: string, chat?: string }
 */
import { db, api, fetch } from 'sdk';
import { sql } from 'sdk/db';

const has = (name) => {
  try {
    return typeof globalThis[name] !== 'undefined';
  } catch {
    return false;
  }
};

/* Date.now() is frozen during synchronous CPU work and advances across awaits, so time CPU work in
   slices separated by a cheap DB round trip. */
async function tick() {
  await db.get(sql`SELECT 1 AS one`);
  return Date.now();
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64encode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
const B64REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64REV[B64.charCodeAt(i)] = i;
function b64decode(s) {
  const len = s.length;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const n = (B64REV[s.charCodeAt(i)] << 18) | (B64REV[s.charCodeAt(i + 1)] << 12) | ((B64REV[s.charCodeAt(i + 2)] & 63) << 6) | (B64REV[s.charCodeAt(i + 3)] & 63);
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function bytesOf(n) {
  const b = new Uint8Array(n);
  let x = 2463534242;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 255;
  }
  return b;
}

/* (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)) */
const WASM_ADD = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

const TESTS = {
  async globals() {
    const names = [
      'WebAssembly', 'crypto', 'TextEncoder', 'TextDecoder', 'Intl', 'URL', 'URLSearchParams', 'atob', 'btoa',
      'structuredClone', 'CompressionStream', 'DecompressionStream', 'ReadableStream', 'Blob', 'Response', 'Headers',
      'AbortController', 'setTimeout', 'setInterval', 'queueMicrotask', 'performance', 'Buffer', 'process',
      'SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry',
    ];
    const present = names.filter(has);
    return {
      present,
      absent: names.filter((n) => !present.includes(n)),
      subtle: !!(globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === 'function'),
      randomUUID: !!(globalThis.crypto && typeof crypto.randomUUID === 'function'),
      getRandomValues: !!(globalThis.crypto && typeof crypto.getRandomValues === 'function'),
    };
  },

  async wasm() {
    if (!has('WebAssembly')) return { available: false };
    const out = { available: true, validate: WebAssembly.validate(WASM_ADD) };
    try {
      const m = new WebAssembly.Module(WASM_ADD);
      const inst = new WebAssembly.Instance(m, {});
      out.syncInstantiate = inst.exports.add(2, 3) === 5;
    } catch (e) {
      out.syncInstantiate = String(e && e.message);
    }
    try {
      const { instance } = await WebAssembly.instantiate(WASM_ADD, {});
      out.asyncInstantiate = instance.exports.add(20, 22) === 42;
    } catch (e) {
      out.asyncInstantiate = String(e && e.message);
    }
    try {
      out.memory64MB = new WebAssembly.Memory({ initial: 1024 }).buffer.byteLength;
    } catch (e) {
      out.memory64MB = String(e && e.message);
    }
    return out;
  },

  async sha256({ n = 8 }) {
    if (!(globalThis.crypto && crypto.subtle)) return { available: false };
    const data = bytesOf(n * 1024 * 1024);
    const t0 = await tick();
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const t1 = await tick();
    return { available: true, mb: n, ms: t1 - t0, hex: Array.from(d.slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('') };
  },

  /* Pure-JS base64 cost (chunk transfer). Fails with "CPU timer exceeded" when n is too large. */
  async base64({ n = 1 }) {
    const data = bytesOf(n * 1024 * 1024);
    const t0 = await tick();
    const s = b64encode(data);
    const t1 = await tick();
    const back = b64decode(s);
    const t2 = await tick();
    return { mb: n, encodeMs: t1 - t0, decodeMs: t2 - t1, ok: back.length === data.length && back[back.length - 1] === data[data.length - 1] };
  },

  /* CPU ladder: n = 10^8 iterations units. */
  async cpu({ n = 1 }) {
    let x = 0;
    for (let i = 0; i < n * 1e8; i++) x = (x + i) | 0;
    return { units: n, x };
  },

  /* Largest blob a statement accepts as a bound parameter (upload_chunks.data). */
  async dbBlobParam({ n = 1 }) {
    const data = bytesOf(n * 1024 * 1024);
    const t0 = await tick();
    const r = await db.get(sql`SELECT length(${data}) AS len, typeof(${data}) AS t`);
    return { mb: n, row: r, ms: (await tick()) - t0 };
  },

  /* Largest value a query can return (reassembling chunks reads them back). */
  async dbBlobResult({ n = 1 }) {
    const t0 = await tick();
    const r = await db.get(sql`SELECT randomblob(${n * 1024 * 1024}) AS b`);
    const b = r && r.b;
    return { mb: n, type: b && b.constructor && b.constructor.name, len: b && (b.length ?? b.byteLength), ms: (await tick()) - t0 };
  },

  async dbTextParam({ n = 1 }) {
    const s = 'x'.repeat(n * 1024 * 1024);
    const r = await db.get(sql`SELECT length(${s}) AS len`);
    return { mb: n, row: r };
  },

  /* Output size of a `tgcloud run` result (not the HTTP endpoint limit: see the Mini App spike). */
  async output({ n = 1 }) {
    return { mb: n, s: 'y'.repeat(n * 1024 * 1024).length };
  },

  async me() {
    const me = await api.getMe();
    return { id: me.id, username: me.username, first_name: me.first_name, can_join_groups: me.can_join_groups, supports_inline_queries: me.supports_inline_queries, has_main_web_app: me.has_main_web_app };
  },

  /* getChat + the bot's own member record in a channel (gate / storage / publish channel checks). */
  async chat({ chat = '@wangerBots' }) {
    const c = await api.getChat({ chat_id: chat });
    const me = await api.getMe();
    let member;
    try {
      const m = await api.getChatMember({ chat_id: c.id, user_id: me.id });
      member = { status: m.status, can_post_messages: m.can_post_messages, can_edit_messages: m.can_edit_messages, can_delete_messages: m.can_delete_messages, can_invite_users: m.can_invite_users };
    } catch (e) {
      member = { error: e && e.code, description: e && e.description };
    }
    return { id: c.id, type: c.type, title: c.title, username: c.username, member };
  },

  /* Download speed of a file the bot can see (pass a file_id). */
  async stream({ file_id }) {
    if (!file_id) return { skipped: 'pass file_id' };
    const t0 = await tick();
    const s = await api.getFileStream(file_id);
    let bytes = 0;
    for await (const chunk of s.body) bytes += chunk.length;
    return { bytes, ms: (await tick()) - t0, file_size: s.file.file_size };
  },

  /* Wall clock: n chained 9-second HTTP waits. */
  async wall({ n = 2 }) {
    const t0 = Date.now();
    for (let i = 0; i < n; i++) await fetch('https://httpbin.org/delay/9');
    return { n, ms: Date.now() - t0 };
  },
};

export default async function (input) {
  const name = input && input.test;
  const fn = TESTS[name];
  if (!fn) return { error: 'unknown test', tests: Object.keys(TESTS) };
  return fn(input);
}
