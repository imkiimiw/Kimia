// The smoke fixtures (tests/fixtures/updates/) run through the real handlers locally, so a fixture
// that would fail on the staging bot fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, OWNER } from '../helpers/harness.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/updates');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('every fixture is valid JSON(5), names a real module, and runs without an error row', async () => {
  const h = setup();
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json5')).sort();
  assert.ok(files.length >= 5);
  const order = ['start_nonmember.json5', 'fj_check.json5', 'forged_admin_callback.json5', 'admin_open.json5', 'blocked_bot.json5', 'channel_post_unregistered.json5', 'ops_tick.json5'];
  assert.deepEqual([...files].sort(), [...order].sort());
  for (const f of order) {
    const fx = load(f);
    const mod = (await import(`../../tgcloud/${fx.module}.js`)).default;
    const r = await mod(fx.payload, fx.ctx || {});
    assert.equal(r.ok, true, f);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM error_log').n, 0);
  assert.equal(h.one('SELECT is_blocked AS b FROM users WHERE telegram_id = 1000001').b, 1);
  assert.match(h.lastText(OWNER), /پنل مدیریت/);
  assert.equal(h.one('SELECT count(*) AS n FROM tracks').n, 0, 'the unregistered channel post imported nothing');
});
