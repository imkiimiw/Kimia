// C0 platform probe (no vendored libraries). TEMPORARY: scripts/spike.mjs copies this file to
// tgcloud/endpoints/zz_core.js for one `tgcloud run` and deletes it afterwards. Never pushed.
// Read-only towards the database (only `SELECT 1`); the Bot API cases are listed in spikes/README.md.
import { db, api, fetch, InputFile } from 'sdk';
import { sql } from 'sdk/db';

const OWNER_ID = 5557901897;
const CHANNELS = ['@HIDE_i_SEEK', '@Nepenthw_ir', '@wangerBots'];
const MB = 1024 * 1024;

// Date.now() only advances across I/O on this platform, so a clock read does a tiny query first.
async function now() { await db.get(sql`SELECT 1 AS x`); return Date.now(); }

function spin(iters) {
  let x = 1;
  for (let i = 0; i < iters; i++) x = (Math.imul(x, 1103515245) + 12345) | 0;
  return x;
}

let CRC_TABLE = null;
function crcUpdate(c, d) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      CRC_TABLE[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 255] ^ (c >>> 8);
  return c;
}
const crc32 = (d) => (crcUpdate(-1, d) ^ -1) >>> 0;

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const errInfo = (e) => ({ name: e?.name, code: e?.code, message: String(e?.description || e?.message || e).slice(0, 200) });

const cases = {
  // read-only: the tables and indexes the migration created
  async schema() {
    const rows = await db.all(sql`SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, type, name`);
    return { tables: rows.filter((r) => r.type === 'table').map((r) => r.name), indexes: rows.filter((r) => r.type === 'index').map((r) => r.name) };
  },

  // read-only: what the deployed bot has done (no user data beyond counts)
  async health() {
    const one = async (q) => (await db.get(q)) || {};
    return {
      users: (await one(sql`SELECT count(*) AS n FROM users`)).n,
      jobs: await db.all(sql`SELECT status, count(*) AS n FROM jobs GROUP BY status`),
      channels: await db.all(sql`SELECT username, chat_id, enabled, bot_status FROM channels ORDER BY id`),
      counters: await db.all(sql`SELECT day, key, n FROM counters ORDER BY day DESC, key LIMIT 40`),
      errors: await db.all(sql`SELECT at, source, code, detail, job_code FROM errors ORDER BY id DESC LIMIT 10`),
      settings: await db.all(sql`SELECT key, value FROM settings WHERE key NOT LIKE 'alert:%' ORDER BY key`),
      updates: (await one(sql`SELECT count(*) AS n FROM processed_updates`)).n,
    };
  },

  // read-only: SQLite features C2 relies on
  async sqlfeat() {
    const out = {};
    try { out.json_insert = (await db.get(sql`SELECT json_insert('{"files":[1]}', '$.files[#]', json('{"a":2}')) AS v`)).v; } catch (e) { out.json_insert = errInfo(e); }
    try { out.json_len = (await db.get(sql`SELECT json_array_length('{"files":[1,2]}', '$.files') AS v`)).v; } catch (e) { out.json_len = errInfo(e); }
    return out;
  },

  // C2: a document album (sendMediaGroup with InputFile) to the owner, silently, then deleted
  async album() {
    const media = ['c2-a.txt', 'c2-b.txt'].map((name) => ({ type: 'document', media: new InputFile(new TextEncoder().encode(`C2 spike ${name}`), name, { type: 'text/plain' }) }));
    const t = await now();
    const msgs = await api.sendMediaGroup({ chat_id: OWNER_ID, media, disable_notification: true });
    const out = { ms: (await now()) - t, names: msgs.map((m) => m.document && m.document.file_name) };
    for (const m of msgs) { try { await api.deleteMessage({ chat_id: OWNER_ID, message_id: m.message_id }); } catch { /* reported by names */ } }
    out.deleted = msgs.length;
    return out;
  },

  async clock() {
    const t0 = Date.now();
    spin(2e8);
    const t1 = Date.now();
    await db.get(sql`SELECT 1 AS x`);
    const t2 = Date.now();
    const a = await now(); const b = await now(); const c = await now();
    return { during_sync_ms: t1 - t0, after_io_ms: t2 - t0, io_tick_ms: [b - a, c - b] };
  },

  async globals() {
    const names = ['setTimeout', 'setInterval', 'queueMicrotask', 'URL', 'URLSearchParams', 'atob', 'btoa',
      'TextEncoder', 'TextDecoder', 'CompressionStream', 'DecompressionStream', 'Blob', 'Response',
      'ReadableStream', 'AbortController', 'structuredClone', 'performance', 'Buffer', 'process',
      'WebAssembly', 'crypto', 'Intl', 'SharedArrayBuffer', 'Atomics', 'OffscreenCanvas', 'ImageDecoder',
      'createImageBitmap', 'FormData', 'WeakRef', 'FinalizationRegistry'];
    const present = {}; for (const n of names) present[n] = typeof globalThis[n] !== 'undefined';
    const extra = {};
    try { extra.segmenter = typeof Intl.Segmenter === 'function' && [...new Intl.Segmenter('fa', { granularity: 'grapheme' }).segment('سلام')].length; } catch (e) { extra.segmenter = errInfo(e); }
    try { extra.nfc = 'كٔ'.normalize('NFC').length; } catch (e) { extra.nfc = errInfo(e); }
    try { extra.utf16le = new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0])); } catch (e) { extra.utf16le = errInfo(e); }
    try { extra.latin1 = new TextDecoder('latin1').decode(new Uint8Array([0xe9])); } catch (e) { extra.latin1 = errInfo(e); }
    try { extra.tehran = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', hour: '2-digit', hourCycle: 'h23' }).format(new Date(0)); } catch (e) { extra.tehran = errInfo(e); }
    try { extra.faDigits = (1234567).toLocaleString('fa-IR'); } catch (e) { extra.faDigits = errInfo(e); }
    try { extra.subtle = typeof crypto.subtle?.sign === 'function'; extra.sha256 = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))).slice(0, 16); } catch (e) { extra.subtle = errInfo(e); }
    try { extra.evalWorks = eval('1+1') === 2; } catch (e) { extra.evalWorks = errInfo(e); }
    try { extra.newFunction = new Function('return 2')() === 2; } catch (e) { extra.newFunction = errInfo(e); }
    try { await import('sdk'); extra.dynamicImport = true; } catch (e) { extra.dynamicImport = errInfo(e); }
    return { present, extra };
  },

  // CPU: spin in slices of `slice` iterations, reading the clock between slices; logs progress so a
  // run that is killed still shows how far it got. sync=true spins `iters` in one go, no awaits.
  async cpu({ iters = 1e9, slice = 5e7, sync = false }) {
    const t0 = await now();
    if (sync) { spin(iters); const t1 = await now(); return { sync: true, iters, elapsed_ms: t1 - t0 }; }
    let done = 0, t = t0;
    while (done < iters) {
      spin(slice); done += slice; t = await now();
      console.log(JSON.stringify({ done, elapsed_ms: t - t0 }));
    }
    return { sync: false, iters: done, elapsed_ms: t - t0 };
  },

  async mem({ mb = 512, chunk = 64 }) {
    const keep = []; let total = 0;
    try {
      while (total < mb) {
        const a = new Uint8Array(chunk * MB);
        for (let i = 0; i < a.length; i += 4096) a[i] = i & 255; // touch every page
        keep.push(a); total += chunk;
        if (total % 256 === 0) console.log(JSON.stringify({ allocated_mb: total }));
      }
      return { ok: true, allocated_mb: total };
    } catch (e) { return { ok: false, allocated_mb: total, error: errInfo(e) }; }
  },

  async wasm({ only }) {
    const out = { typeof: typeof WebAssembly };
    const run = (k) => !only || only === k;
    // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0,
      7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);
    if (run('validate')) try { out.validate = WebAssembly.validate(bytes); } catch (e) { out.validate = errInfo(e); }
    if (run('sync')) try { const m = new WebAssembly.Module(bytes); out.syncCompile = new WebAssembly.Instance(m).exports.add(2, 3); } catch (e) { out.syncCompile = errInfo(e); }
    if (run('async')) try { const { instance } = await WebAssembly.instantiate(bytes); out.asyncInstantiate = instance.exports.add(20, 22); } catch (e) { out.asyncInstantiate = errInfo(e); }
    if (run('compile')) try { const m = await WebAssembly.compile(bytes); out.asyncCompile = new WebAssembly.Instance(m).exports.add(1, 1); } catch (e) { out.asyncCompile = errInfo(e); }
    if (run('instmod')) try { const inst = await WebAssembly.instantiate(new WebAssembly.Module(bytes)); out.instantiateModule = inst.exports.add(3, 4); } catch (e) { out.instantiateModule = errInfo(e); }
    if (run('mem64')) try { const mem = new WebAssembly.Memory({ initial: 256, maximum: 16384 }); mem.grow(768); out.memory_mb = mem.buffer.byteLength / MB; } catch (e) { out.memory = errInfo(e); }
    if (run('mem1g')) try { const mem = new WebAssembly.Memory({ initial: 256, maximum: 65536 }); mem.grow(16384 - 256); out.memory_1gb = mem.buffer.byteLength / MB; } catch (e) { out.memory_1gb = errInfo(e); }
    return out;
  },

  // A generated module with `fns` functions (~10 bytes each) to test sync compilation of a big module.
  async wasm_big({ fns = 100000 }) {
    const leb = (n) => { const o = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; o.push(b); } while (n); return o; };
    const sec = (id, body) => [id, ...leb(body.length), ...body];
    const type = sec(1, [1, 0x60, 0, 1, 0x7f]);
    const func = sec(3, [...leb(fns), ...new Array(fns).fill(0)]);
    const exp = sec(7, [1, 4, 108, 97, 115, 116, 0, ...leb(fns - 1)]);
    const bodies = [];
    for (let i = 0; i < fns; i++) { const c = [0, 0x41, ...leb(i & 0x3fff), 0x0b]; bodies.push(c.length, ...c); }
    const code = sec(10, [...leb(fns), ...bodies]);
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...type, ...func, ...exp, ...code]);
    const t = await now();
    const m = new WebAssembly.Module(bytes);
    const r = new WebAssembly.Instance(m).exports.last();
    return { bytes: bytes.length, result: r, compile_ms: (await now()) - t };
  },

  async net({ base = 'https://httpbin.org' }) {
    const out = {};
    let t = await now();
    try { const r = await fetch(`${base}/get`); out.get = { status: r.status, ms: (await now()) - t }; await r.text(); } catch (e) { out.get = errInfo(e); }
    // A signed JSON POST, shaped like the planned bot → worker / hub calls (HMAC-SHA256).
    const secret = 'c0-spike-not-a-secret';
    const body = JSON.stringify({ job_id: '01JC0SPIKE', op: 'img.rs', chat_id: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`)));
      t = await now();
      const r = await fetch(`${base}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wanger-Timestamp': ts, 'X-Wanger-Signature': sig, 'Idempotency-Key': '01JC0SPIKE' }, body });
      const j = await r.json();
      const h = Object.fromEntries(Object.entries(j.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      out.post = { status: r.status, ms: (await now()) - t, body_echoed: j.data === body, sig_echoed: h['x-wanger-signature'] === sig, ua: h['user-agent'] };
    } catch (e) { out.post = errInfo(e); }
    t = await now();
    try { await fetch('https://wanger-hub.invalid/v1/gate'); out.bad_host = 'resolved?!'; } catch (e) { out.bad_host = { ...errInfo(e), ms: (await now()) - t }; }
    return out;
  },

  async wall({ seconds = 30, base = 'https://httpbin.org' }) {
    const t0 = await now(); let waited = 0;
    while (waited < seconds) {
      const d = Math.min(10, seconds - waited);
      const r = await fetch(`${base}/delay/${d}`); await r.text();
      waited += d;
      console.log(JSON.stringify({ waited_s: waited, elapsed_ms: Date.now() - t0, status: r.status }));
    }
    return { waited_s: waited, elapsed_ms: (await now()) - t0 };
  },

  async bot() {
    const me = await api.getMe();
    const out = { me: { id: me.id, username: me.username, can_join_groups: me.can_join_groups, can_read_all_group_messages: me.can_read_all_group_messages, supports_inline_queries: me.supports_inline_queries, has_main_web_app: me.has_main_web_app }, channels: {} };
    for (const ch of CHANNELS) {
      try {
        const chat = await api.getChat({ chat_id: ch });
        const m = await api.getChatMember({ chat_id: ch, user_id: me.id });
        out.channels[ch] = { id: chat.id, type: chat.type, bot_status: m.status };
      } catch (e) { out.channels[ch] = errInfo(e); }
    }
    try { const c = await api.getChat({ chat_id: OWNER_ID }); out.owner_chat = { reachable: true, type: c.type }; } catch (e) { out.owner_chat = { reachable: false, ...errInfo(e) }; }
    try { await api.getWebhookInfo(); out.getWebhookInfo = 'allowed'; } catch (e) { out.getWebhookInfo = errInfo(e); }
    return out;
  },

  // 19 MB round trip, step 1: generate + upload as InputFile to the owner's private chat (silent).
  async file_up({ mb = 19 }) {
    const n = Math.floor(mb * MB);
    let t = await now();
    const bytes = randomBytes(n); const crc = crc32(bytes);
    const gen_ms = (await now()) - t;
    t = await now();
    const msg = await api.sendDocument({ chat_id: OWNER_ID, disable_notification: true,
      caption: 'C0 spike: test file (random bytes), deleted automatically.',
      document: new InputFile(bytes, 'c0-spike.bin', { type: 'application/octet-stream' }) });
    return { bytes: n, crc, gen_ms, upload_ms: (await now()) - t, message_id: msg.message_id, file_id: msg.document.file_id, file_size: msg.document.file_size };
  },

  // Step 2: getFileStream → checksum while streaming → re-upload the same bytes as a new InputFile.
  async file_rt({ file_id, crc }) {
    let t0 = await now();
    const s = await api.getFileStream(file_id);
    const first_ms = (await now()) - t0;
    const chunks = []; let n = 0, c = -1, count = 0, maxChunk = 0;
    for await (const ch of s.body) { chunks.push(ch); n += ch.length; c = crcUpdate(c, ch); count++; if (ch.length > maxChunk) maxChunk = ch.length; }
    const download_ms = (await now()) - t0;
    const all = new Uint8Array(n); let o = 0; for (const ch of chunks) { all.set(ch, o); o += ch.length; }
    let t = await now();
    const msg = await api.sendDocument({ chat_id: OWNER_ID, disable_notification: true,
      caption: 'C0 spike: re-upload of the downloaded bytes, deleted automatically.',
      document: new InputFile(all, 'c0-spike-copy.bin', { type: 'application/octet-stream' }) });
    return { file_info: { file_size: s.file.file_size, has_unique_id: !!s.file.file_unique_id, has_file_path: 'file_path' in s.file },
      bytes: n, chunks: count, max_chunk: maxChunk, crc_ok: ((c ^ -1) >>> 0) === crc, first_byte_ms: first_ms, download_ms,
      reupload_ms: (await now()) - t, total_ms: (await now()) - t0, copy_message_id: msg.message_id, copy_size: msg.document.file_size };
  },

  async file_content({ file_id, crc }) {
    const t = await now();
    const b = await api.getFileContent(file_id);
    const ms = (await now()) - t;
    return { bytes: b.length, ms, crc_ok: crc32(b) === crc };
  },

  async file_cleanup({ message_ids = [] }) {
    const out = {};
    for (const id of message_ids) {
      try { out[`m${id}`] = await api.deleteMessage({ chat_id: OWNER_ID, message_id: id }); } catch (e) { out[`m${id}`] = errInfo(e); }
    }
    return out;
  },

  // 20 MB getFile ceiling: a file just above it must be refused by getFileStream.
  async file_over({ file_id }) {
    try { const s = await api.getFileStream(file_id); return { unexpected: true, size: s.file.file_size }; } catch (e) { return errInfo(e); }
  },

  // Detection reads only the leading bytes: is breaking out of the stream early cheaper than a
  // full download? Uploads a 19 MB file, reads the head, deletes the message.
  async file_head({ mb = 19, head = 65536 }) {
    const msg = await api.sendDocument({ chat_id: OWNER_ID, disable_notification: true,
      caption: 'C0 spike: test file, deleted automatically.',
      document: new InputFile(randomBytes(Math.floor(mb * MB)), 'c0-head.bin', { type: 'application/octet-stream' }) });
    const out = {};
    try {
      const t = await now();
      const s = await api.getFileStream(msg.document.file_id);
      let got = 0;
      for await (const ch of s.body) { got += ch.length; if (got >= head) break; }
      out.head = { bytes: got, ms: (await now()) - t, bodyUsed: s.bodyUsed };
      const t2 = await now();
      const s2 = await api.getFileStream(msg.document.file_id);
      const b = await s2.bytes();
      out.full_bytes = { bytes: b.length, ms: (await now()) - t2 };
    } finally {
      await api.deleteMessage({ chat_id: OWNER_ID, message_id: msg.message_id });
    }
    return out;
  },

  // Batches: one album of `n` documents (one sendMediaGroup), then the first half downloaded one after
  // another and the second half in parallel (every file is cold, i.e. read for the first time).
  async file_parallel({ n = 8, mb = 3 }) {
    const media = [];
    for (let i = 0; i < n; i++) media.push({ type: 'document', media: new InputFile(randomBytes(Math.floor(mb * MB)), `c0-batch-${i}.bin`, { type: 'application/octet-stream' }) });
    let t = await now();
    const msgs = await api.sendMediaGroup({ chat_id: OWNER_ID, disable_notification: true, media });
    const out = { album_upload_ms: (await now()) - t, files: msgs.length };
    try {
      const ids = msgs.map((m) => m.document.file_id);
      const half = Math.floor(ids.length / 2);
      t = await now();
      for (const id of ids.slice(0, half)) await api.getFileContent(id);
      out.sequential = { files: half, ms: (await now()) - t };
      t = await now();
      const got = await Promise.all(ids.slice(half).map((id) => api.getFileContent(id)));
      out.parallel = { files: got.length, ms: (await now()) - t, bytes: got.reduce((s, b) => s + b.length, 0) };
    } finally {
      for (const m of msgs) { try { await api.deleteMessage({ chat_id: OWNER_ID, message_id: m.message_id }); } catch { /* reported below */ } }
      out.deleted = msgs.length;
    }
    return out;
  },

  // Rename re-uploads the bytes under a new name: do Persian / RTL / long names survive the upload?
  async file_names({ set = 'basic' }) {
    const names = set === 'long'
      ? ['b'.repeat(63) + '.txt', 'c'.repeat(64) + '.txt', 'd'.repeat(65) + '.txt', 'ف'.repeat(40) + '.txt', 'ق'.repeat(70) + '.txt', 'e'.repeat(70), 'x'.repeat(30) + '.' + 'y'.repeat(40)]
      : ['گزارش نهایی ۱۴۰۵.pdf', 'سلام Hello ۱۲۳ (نسخه ۲).txt', 'a'.repeat(110) + '.txt', 'emoji-🙂.txt'];
    const out = [];
    for (const name of names) {
      const msg = await api.sendDocument({ chat_id: OWNER_ID, disable_notification: true,
        document: new InputFile(new TextEncoder().encode('C0 spike'), name, { type: 'text/plain' }) });
      out.push({ sent: name, got: msg.document.file_name, same: msg.document.file_name === name, mime: msg.document.mime_type });
      await api.deleteMessage({ chat_id: OWNER_ID, message_id: msg.message_id });
    }
    return out;
  },
};

export default async function (input) {
  const fn = cases[input?.case];
  if (!fn) return { error: `unknown case; one of: ${Object.keys(cases).join(', ')}` };
  return fn(input);
}
