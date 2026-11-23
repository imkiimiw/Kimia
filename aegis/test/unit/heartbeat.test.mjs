// The heartbeat script: init data signed the way Telegram signs a Mini App's (checked by an
// independent verifier), the request it sends, and its refusals.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { beat, signInitData } from '../../scripts/heartbeat.mjs';

const TOKEN = '123456789:AAEhBP0av28X2Kr3Ff-test-token-not-real';

/* Telegram's documented check, written separately from the script */
function verify(initData, token) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  return crypto.createHmac('sha256', secret).update(check).digest('hex') === hash;
}

test('signed init data verifies with the bot token, and only with it', () => {
  const init = signInitData(TOKEN, { id: 5557901897, first_name: 'Aegis heartbeat' }, 1795400000);
  assert.ok(verify(init, TOKEN));
  assert.ok(!verify(init, `${TOKEN}x`), 'another token');
  const p = new URLSearchParams(init);
  assert.equal(p.get('auth_date'), '1795400000');
  assert.equal(JSON.parse(p.get('user')).id, 5557901897);
  p.set('user', JSON.stringify({ id: 1, first_name: 'Mallory' }));
  assert.ok(!verify(p.toString(), TOKEN), 'a changed user breaks the hash');
});

test('a beat posts { action: "beat" } to /api/bcLive with Authorization: TMA <base64 init data>', async () => {
  let seen = null;
  const fetchFn = async (url, opts) => {
    seen = { url, opts };
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: { ok: true, at: 1, calls: 0 } }) };
  };
  const r = await beat({ token: TOKEN, fetchFn, appUrl: 'https://app1.tgcloud.ai/' });
  assert.deepEqual(r, { ok: true, at: 1, calls: 0 });
  assert.equal(seen.url, 'https://app1.tgcloud.ai/api/bcLive');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(JSON.parse(seen.opts.body), { action: 'beat' });
  const auth = seen.opts.headers.Authorization;
  assert.match(auth, /^TMA [A-Za-z0-9+/=]+$/);
  assert.ok(verify(Buffer.from(auth.slice(4), 'base64').toString(), TOKEN));
});

test('refusals: no or malformed token, an endpoint error, a non-JSON answer — the token is never in the message', async () => {
  await assert.rejects(() => beat({ token: '' }), /missing or is not a bot token/);
  await assert.rejects(() => beat({ token: 'tgcloud_abc' }), /missing or is not a bot token/);
  const answer = (status, body) => async () => ({ status, text: async () => body });
  await assert.rejects(() => beat({ token: TOKEN, fetchFn: answer(400, JSON.stringify({ ok: false, description: 'Stale init data' })) }), (e) => /HTTP 400: Stale init data/.test(e.message) && !e.message.includes(TOKEN));
  await assert.rejects(() => beat({ token: TOKEN, fetchFn: answer(401, 'Unauthorized') }), /HTTP 401: Unauthorized/);
});
