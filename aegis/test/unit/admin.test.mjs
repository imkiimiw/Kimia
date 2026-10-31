// Unit tests for Phase 10's pure parts: SHA-256 (the audit seals), the seal hash over audit rows, the
// global backup's file check, and the team's access levels.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { sha256 } from '../../tgcloud/lib/core/files.js';
import { utf8Bytes } from '../../tgcloud/lib/core/util.js';
import { globalBackup, globals, seals, staff } from '../../tgcloud/lib/engines/system.js';

test('SHA-256: the FIPS 180-4 test vectors, padding edges, and random inputs match node:crypto', () => {
  assert.equal(sha256(utf8Bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(utf8Bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(utf8Bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256(new Uint8Array(1000000).fill(0x61)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
    const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 255);
    assert.equal(sha256(b), crypto.createHash('sha256').update(b).digest('hex'), `length ${n}`);
  }
  assert.equal(sha256(utf8Bytes('سلام 🙂')), crypto.createHash('sha256').update('سلام 🙂').digest('hex'));
});

test('seal hash: chained through the previous seal; any change to any field of any row changes it', () => {
  const rows = [
    { id: 1, at: 100, actor_id: 5557901897, chat_id: 0, action: 'system.migrate', target: '1', details: '{"name":"x"}' },
    { id: 2, at: 101, actor_id: 0, chat_id: -100123, action: 'chat.added', target: null, details: null },
  ];
  const h = seals.hashOf(seals.ZERO, rows);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(seals.hashOf(seals.ZERO, rows.map((r) => ({ ...r }))), h, 'deterministic');
  assert.equal(seals.hashOf(seals.ZERO, rows.map((r) => ({ ...r, id: String(r.id), at: String(r.at) }))), h, 'numbers as text read the same');
  assert.notEqual(seals.hashOf('1'.repeat(64), rows), h, 'the previous seal is part of it');
  for (const k of ['id', 'at', 'actor_id', 'chat_id', 'action', 'target', 'details']) {
    const changed = rows.map((r, i) => (i === 1 ? { ...r, [k]: k === 'action' || k === 'target' || k === 'details' ? 'x' : Number(r[k] || 0) + 1 } : r));
    assert.notEqual(seals.hashOf(seals.ZERO, changed), h, k);
  }
  assert.notEqual(seals.hashOf(seals.ZERO, rows.slice(0, 1)), h, 'a deleted row');
  assert.notEqual(seals.hashOf(seals.ZERO, [rows[1], rows[0]]), h, 'the order');
  assert.notEqual(seals.hashOf(seals.ZERO, [{ ...rows[0], target: 'a|b' }]), seals.hashOf(seals.ZERO, [{ ...rows[0], target: 'a', details: 'b' }]), 'fields cannot run into each other');
});

test('global backup check: only Aegis global backups of this version; values filtered; size limit', () => {
  assert.deepEqual(globalBackup.check('nope'), { error: 'not_backup' });
  assert.deepEqual(globalBackup.check('{"aegis":"backup","v":1}'), { error: 'not_backup' });
  assert.deepEqual(globalBackup.check('{"aegis":"global-backup","v":2,"part":"globals"}'), { error: 'version' });
  assert.deepEqual(globalBackup.check('{"aegis":"global-backup","v":1,"part":"globals","settings":{"evil":"1","g_fun":"maybe"}}'), { error: 'empty' });
  assert.deepEqual(globalBackup.check(`{"aegis":"global-backup","v":1,"part":"globals","pad":"${'x'.repeat(1024 * 1024)}"}`), { error: 'too_big' });
  const ok = globalBackup.check(JSON.stringify({
    aegis: 'global-backup', v: 1, part: 'globals',
    settings: { g_fun: '0', g_media: '1', join_enabled: '1', shutdown: '1', g_jobs: 'x' },
    join: [{ username: 'chan', chat_id: 0 }, { evil: true }, 'str'],
    staff: [{ user_id: 42, level: 'manager' }, { user_id: 43, level: 'owner' }, { user_id: '44', level: 'viewer' }],
  }));
  assert.equal(ok.part, 'globals');
  assert.deepEqual(ok.data.settings, [['g_fun', '0'], ['g_media', '1'], ['join_enabled', '1']], 'shutdown and bad values are never restored');
  assert.deepEqual(ok.counts, { settings: 3, join: 1, staff: 1 }, 'nobody becomes owner from a file');
  const chats = globalBackup.check(JSON.stringify({ aegis: 'global-backup', v: 1, part: 'chats', chats: [{ aegis: 'backup', chat: -1001 }, { chat: 'x' }] }));
  assert.deepEqual(chats.counts, { chats: 1 });
});

test('access levels: viewer < support < manager < owner; unknown levels and actions allow nothing; suspended chats parse safely', () => {
  assert.deepEqual(staff.LEVELS, ['viewer', 'support', 'manager']);
  const all = ['viewer', 'support', 'manager', 'owner'];
  for (const [i, have] of all.entries()) for (const [j, need] of all.entries()) assert.equal(staff.can(have, need), i >= j, `${have} → ${need}`);
  assert.equal(staff.can(null, 'viewer'), false);
  assert.equal(staff.can('admin', 'viewer'), false);
  assert.equal(staff.can('owner', 'nonsense'), false);
  assert.deepEqual([...globals.suspendedSet({ g_suspended: '{"-1001":[1,2]}' })], [-1001]);
  assert.deepEqual([...globals.suspendedSet({ g_suspended: '[1,2]' })], []);
  assert.deepEqual([...globals.suspendedSet({ g_suspended: 'garbage' })], []);
  assert.equal(globals.on({}, 'g_fun'), true);
  assert.equal(globals.on({ g_fun: '0' }, 'g_fun'), false);
});
