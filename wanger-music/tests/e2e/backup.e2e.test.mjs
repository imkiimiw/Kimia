// Phase 8: backup export and restore. Done when (locally; tests/STAGING in docs): a restore from an
// export reproduces every row of every backed-up table, the search works again after the rebuild,
// and nothing but the owner can export or restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, setClock, OWNER, SEED } from '../helpers/harness.mjs';
import { createApp } from '../../tgcloud/lib/core/context.js';
import { BACKUP_TABLES } from '../../tgcloud/lib/repositories/backup.js';
import { base64 } from '../../tgcloud/lib/backup/service.js';
import { db as sdkDb } from '../sdk/db.mjs';

const U = 111;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };
const owner = { telegram_id: OWNER, role: 'user' };
let seq = 0;

async function addActive(h, title, performer) {
  seq += 1;
  advance(61);
  await h.send(OWNER, null, { audio: { file_id: `F${seq}`, file_unique_id: `U${seq}`, duration: 200 + seq, title, performer, file_name: 'x.mp3', mime_type: 'audio/mpeg', file_size: 1000 } });
  const row = h.one('SELECT * FROM tracks ORDER BY id DESC LIMIT 1');
  await h.press(OWNER, `trk:act:${row.id}`, 1);
  return h.one('SELECT * FROM tracks WHERE id = ?', row.id);
}

/** Some of everything: users, tracks (Persian text, quotes, emoji), aliases, a source, a channel, publications, stats, audit. */
async function populate(h) {
  join(h, U);
  join(h, 112);
  await h.send(U, '/start');
  await h.send(112, '/start');
  await h.inline(113, 'abc');
  const a = await addActive(h, 'دلم تنگه', 'شادمهر عقیلی');
  const b = await addActive(h, 'It\'s "Quoted" 🎵', 'O\'Brien & Co');
  await addActive(h, 'نامه', 'داریوش');
  await h.press(OWNER, `art:byt:${a.id}`, 1);
  const artistId = h.one('SELECT id FROM artists ORDER BY id LIMIT 1').id;
  await h.press(OWNER, `art:addal:${artistId}`, 1);
  await h.send(OWNER, 'Shadmehr');
  await h.chosen(U, a.public_id);
  await h.chosen(U, b.public_id);
  h.tg.addChannel({ id: -1004391543350, username: 'WangerFlow', title: 'WangerFlow' });
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'dst:home');
  await h.tap(OWNER, 'dst:sug:-1004391543350');
  for (let i = 0; i < 2; i++) { advance(700); await h.opsTick(OWNER); }
}

/** Every row of every backed-up table, in key order (what must survive a restore). */
function snapshot(h, { skipSettings = [] } = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(BACKUP_TABLES)) {
    let rows = h.q(`SELECT ${spec.columns.map((c) => `"${c}"`).join(', ')} FROM ${name} ORDER BY ${spec.key.map((k) => `"${k}"`).join(', ')}`);
    if (name === 'settings') rows = rows.filter((r) => !skipSettings.includes(r.key));
    if (name === 'audit_log') rows = rows.filter((r) => !String(r.action).startsWith('backup.'));
    out[name] = rows.map((r) => ({ ...r }));
  }
  return out;
}
const VOLATILE = ['backup.last', 'stats.aggregated_at', 'catalog.version', 'search.reindex_cursor', 'tick.last', 'tick.last_at'];

/** What scripts/backup.mjs does with a document: chunks of ≤ `size` rows per table, then finish. */
async function restore(app, doc, { replace = false, size = 2 } = {}) {
  const results = {};
  for (const [name, { columns, rows }] of Object.entries(doc.tables)) {
    let written = 0;
    const parts = [];
    for (let i = 0; i < rows.length; i += size) parts.push(rows.slice(i, i + size));
    if (!parts.length) parts.push([]);
    for (let i = 0; i < parts.length; i++) written += (await app.backup.restoreChunk(owner, { table: name, columns, rows: parts[i], replace: replace && i === 0 })).written;
    results[name] = written;
  }
  return { written: results, ...(await app.backup.finishRestore(owner, { replace })) };
}

const lastDocument = (h) => {
  const call = h.tg.calls.filter((c) => c.method === 'sendDocument').at(-1);
  return { call, doc: JSON.parse(new TextDecoder().decode(call.params.document.bytes)) };
};

test('the backup lists every column of the schema; excluded tables are only derived or short-lived ones', () => {
  const h = setup();
  const tables = h.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'").map((r) => r.name).sort();
  const excluded = ['alerts', 'error_log', 'import_sessions', 'processed_updates', 'track_terms', 'user_flows'];
  assert.deepEqual(tables.filter((t) => !BACKUP_TABLES[t]).sort(), excluded);
  for (const [name, spec] of Object.entries(BACKUP_TABLES)) {
    const info = h.q(`PRAGMA table_info(${name})`);
    assert.deepEqual(spec.columns, info.map((c) => c.name), `${name}: columns`);
    assert.deepEqual(spec.key, info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name), `${name}: key`);
  }
});

test('export: the owner taps «💾» in System Status → a JSON document with every row, sent to the owner only', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  await populate(h);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'sys:home');
  const before = Object.fromEntries(Object.keys(BACKUP_TABLES).map((name) => [name, h.one(`SELECT count(*) AS n FROM ${name}`).n]));
  await h.tap(OWNER, 'sys:bak');
  const sends = h.tg.calls.filter((c) => c.method === 'sendDocument');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.chat_id, OWNER);
  assert.match(sends[0].params.document.name, /^wanger-music-backup-2026-11-05-\d+\.json$/);
  assert.equal(sends[0].params.document.type, 'application/json');
  const { doc } = lastDocument(h);
  assert.deepEqual([doc.format, doc.version, doc.bot_id], ['wanger-music-backup', 1, 9280424458]);
  for (const [name, spec] of Object.entries(BACKUP_TABLES)) {
    assert.deepEqual(doc.tables[name].columns, spec.columns);
    assert.equal(doc.tables[name].rows.length, before[name], `${name} row count`);
    assert.equal(doc.counts[name], doc.tables[name].rows.length);
  }
  const quoted = h.one("SELECT title, artist FROM tracks WHERE title LIKE '%Quoted%'");
  assert.ok(doc.tables.tracks.rows.some((r) => r.includes(quoted.title) && r.includes(quoted.artist)), `text survives JSON: ${quoted.title} / ${quoted.artist}`);
  const last = JSON.parse(h.one("SELECT value FROM settings WHERE key = 'backup.last'").value);
  assert.equal(last.file_id, sends[0].result.document.file_id);
  assert.match(h.lastText(OWNER), /💾 آخرین بکاپ: /);
  assert.ok(h.q('SELECT action FROM audit_log').some((r) => r.action === 'backup.export'));
});

test('restore --replace into a fresh database reproduces every row; search works again after the rebuild', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  await populate(h);
  const before = snapshot(h, { skipSettings: VOLATILE });
  const a1 = await createApp({ kind: 'test' });
  await a1.backup.exportToOwner(owner);
  const { doc } = lastDocument(h);

  // a brand-new, empty database (what a broken or new bot has after `tgcloud migrate`)
  const h2 = setup();
  setClock('2026-11-05T12:00:00Z');
  const a2 = await createApp({ kind: 'test' });
  const r = await restore(a2, doc, { replace: true, size: 2 });
  for (const name of Object.keys(BACKUP_TABLES)) assert.equal(r.counts[name], doc.counts[name] + (name === 'audit_log' ? 1 : 0), `${name}: counts after restore (+ the restore's own audit row)`);
  assert.deepEqual(snapshot(h2, { skipSettings: VOLATILE }), before, 'every row of every table is back');

  // the search index is derived: rebuilt by the tick
  assert.equal(h2.one('SELECT count(*) AS n FROM track_terms').n, 0);
  join(h2, U);
  await h2.opsTick(OWNER);
  assert.ok(h2.one('SELECT count(*) AS n FROM track_terms').n > 0);
  const res = await h2.inline(U, 'شادمهر');
  assert.equal(res.answer.results.length, 1, 'inline search finds the restored track');
  const alias = await h2.inline(U, 'shadmehr');
  assert.equal(alias.answer.results.length, 1, 'aliases came back too');
});

test('restore without --replace merges: same ids are overwritten, other rows stay, unique clashes are skipped', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  await populate(h);
  const app = await createApp({ kind: 'test' });
  await app.backup.exportToOwner(owner);
  const { doc } = lastDocument(h);
  // after the backup: a title edited, a new user, and a user re-created under a new id (same telegram_id)
  const tr = h.one('SELECT id, title FROM tracks ORDER BY id LIMIT 1');
  h.db().prepare('UPDATE tracks SET title = ? WHERE id = ?').run('changed', tr.id);
  await h.send(150, '/start');
  h.db().prepare('DELETE FROM users WHERE telegram_id = 112').run();
  await h.send(112, '/start'); // new row id, same telegram_id
  const r = await restore(app, doc);
  assert.equal(h.one('SELECT title FROM tracks WHERE id = ?', tr.id).title, tr.title, 'the backup value is back');
  assert.ok(h.one('SELECT id FROM users WHERE telegram_id = 150'), 'rows added after the backup stay');
  assert.equal(r.written.users, doc.counts.users - 1, 'the old row of 112 clashes on telegram_id and is skipped');
  assert.equal(h.one('SELECT count(*) AS n FROM users WHERE telegram_id = 112').n, 1);
});

test('only the owner can export or restore; bad chunks are refused before anything is written', async () => {
  const h = setup();
  await populate(h);
  const app = await createApp({ kind: 'test' });
  const admin = { telegram_id: 222, role: 'admin' };
  await assert.rejects(app.backup.exportToOwner(admin), /backup\.manage|denied|Permission/i);
  await assert.rejects(app.backup.restoreChunk(admin, { table: 'users', columns: ['id'], rows: [] }), /backup\.manage|denied|Permission/i);
  const bad = async (input, key) => assert.rejects(app.backup.restoreChunk(owner, input), (e) => e.key === key, key);
  await bad({ table: 'track_terms', columns: ['term'], rows: [] }, 'bak.err.table');
  await bad({ table: 'sqlite_master', columns: ['name'], rows: [] }, 'bak.err.table');
  await bad({ table: 'users', columns: ['telegram_id'], rows: [] }, 'bak.err.columns'); // no key
  await bad({ table: 'users', columns: ['id', 'id'], rows: [] }, 'bak.err.columns');
  await bad({ table: 'users', columns: ['id', 'nope"; DROP TABLE users; --'], rows: [] }, 'bak.err.columns');
  await bad({ table: 'users', columns: ['id', 'username'], rows: [[1]] }, 'bak.err.row');
  await bad({ table: 'users', columns: ['id', 'username'], rows: [[1, { x: 1 }]] }, 'bak.err.row');
  await bad({ table: 'users', columns: ['id', 'username'], rows: [[1, true]] }, 'bak.err.row');
  await bad({ table: 'users', columns: ['id'], rows: Array.from({ length: 2001 }, (_, i) => [i]) }, 'bak.err.chunk');
  await bad({ table: 'users', columns: ['id', 'username'], rows: [[1, 'x']], replace: true, junk: 1, ...{ table: 'nope' } }, 'bak.err.table');
  assert.ok(h.one('SELECT count(*) AS n FROM users').n >= 3, 'nothing was cleared by a refused chunk');
  // the System Status button is owner-only (backup.manage is in no role)
  await h.send(222, '/start');
  const res = await h.press(222, 'sys:bak', 1);
  assert.equal(res.ok, true);
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendDocument').length, 0);
});

test('the last backup can be downloaded through the bot in base64 slices (scripts/backup.mjs fetch)', async () => {
  const h = setup();
  await populate(h);
  const app = await createApp({ kind: 'test' });
  await app.backup.exportToOwner(owner);
  const { call } = lastDocument(h);
  const original = call.params.document.bytes;
  const parts = [];
  for (let off = 0; off < original.length; off += 500) {
    const s = await app.backup.lastFileSlice(owner, off, 500);
    assert.equal(s.size, original.length);
    parts.push(Buffer.from(s.b64, 'base64'));
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(parts)), original);
});

test('weekly backup: off by default; when on, once a week from the tick (owner gets the document)', async () => {
  const h = setup();
  setClock('2026-11-05T10:00:00Z');
  await h.send(OWNER, '/admin');
  let r = await h.opsTick(OWNER);
  assert.equal(r.result.results.backup, 'off');
  h.db().prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('backup.weekly', 'true', 0, 0) ON CONFLICT (key) DO UPDATE SET value = 'true'").run();
  advance(60);
  r = await h.opsTick(OWNER);
  assert.equal(typeof r.result.results.backup, 'object');
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendDocument' && c.params.chat_id === OWNER).length, 1);
  advance(6 * 86400);
  assert.equal((await h.opsTick(OWNER)).result.results.backup, 'not_due');
  advance(86400 + 60);
  assert.equal(typeof (await h.opsTick(OWNER)).result.results.backup, 'object');
  assert.equal(h.tg.calls.filter((c) => c.method === 'sendDocument').length, 2);
});

test('base64 matches Node for every length and byte value', () => {
  for (let n = 0; n < 70; n++) {
    const b = new Uint8Array(n).map((_, i) => (i * 97 + n * 13) & 255);
    assert.equal(base64(b), Buffer.from(b).toString('base64'), `length ${n}`);
  }
  const all = new Uint8Array(256).map((_, i) => i);
  assert.equal(base64(all), Buffer.from(all).toString('base64'));
});

test('a large chunk is split under the platform limit of 4096 bound values per statement', async () => {
  const h = setup();
  const app = await createApp({ kind: 'test' });
  const cols = BACKUP_TABLES.users.columns;
  const rows = Array.from({ length: 2000 }, (_, i) => cols.map((c) => ({ id: i + 1, telegram_id: 9000000 + i, role: 'user', is_banned: 0, is_blocked: 0, force_join_ok_until: 0, created_at: 1, last_seen_at: 1, flood_at: 0, flood_n: 0 })[c] ?? null));
  const r = await app.backup.restoreChunk(owner, { table: 'users', columns: cols, rows });
  assert.equal(r.written, 2000);
  assert.equal(h.one('SELECT count(*) AS n FROM users').n, 2000);
});

test('mass writes stay under the platform cap of 10 000 rows per statement (batched)', async () => {
  const h = setup();
  const raw = h.db();
  const now = Math.floor(Date.now() / 1000);
  raw.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000)
    INSERT INTO users (telegram_id, role, is_banned, is_blocked, force_join_ok_until, created_at, last_seen_at) SELECT 9000000 + x, 'user', 0, 0, ${now + 600}, 1, 1 FROM c`);
  raw.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000)
    INSERT INTO track_terms (term, track_id) SELECT 'term' || (x % 7), x FROM c`);
  raw.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 12000)
    INSERT INTO stats_daily (date, metric, dimension, value) SELECT '2020-0' || (1 + x % 3) || '-01', 'track.play', CAST(x AS TEXT), 1 FROM c`);
  raw.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 14100)
    INSERT INTO error_log (created_at, handler, code, message) SELECT 1, 'h', 'c', 'm' FROM c`);
  const app = await createApp({ kind: 'test' });
  // a single statement over 10 000 rows is refused, like on the platform
  await assert.rejects(sdkDb.run('DELETE FROM track_terms'), /rows_written limit exceeded/);
  assert.equal(h.one('SELECT count(*) AS n FROM track_terms').n, 12000, 'the refused statement wrote nothing');
  assert.equal(await app.repos.users.clearAllPasses(now), 12000);
  assert.equal(await app.repos.backup.clearSearchIndex(), 12000);
  assert.equal(await app.repos.stats.pruneBefore('2021-01-01'), 12000);
  assert.equal(await app.repos.backup.clear('users'), 12000);
  let pruned = 0;
  for (let i = 0; i < 4; i++) pruned += await app.repos.system.pruneErrors(2000);
  assert.equal(pruned, 12100);
  assert.deepEqual([h.one('SELECT count(*) AS n FROM users').n, h.one('SELECT count(*) AS n FROM track_terms').n, h.one('SELECT count(*) AS n FROM stats_daily').n, h.one('SELECT count(*) AS n FROM error_log').n], [0, 0, 0, 2000]);
});
