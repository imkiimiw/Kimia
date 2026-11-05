// ForceJoinService with fakes: membership outcomes, failure modes, retries, alerts, cache, invalidation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForceJoinService } from '../../tgcloud/lib/forcejoin/service.js';
import { inlineGateAnswer, joinView } from '../../tgcloud/lib/forcejoin/gate.js';
import { OWNER_ID } from '../../tgcloud/lib/config/static.js';
import { fakeClock, fakeSettings, fakeAlerts, fakeAudit, fakeForceJoinRepo, apiError, noLog } from '../helpers/fakes.mjs';

const A = -1001, B = -1002, C = -1003;

/** members: { [chatId]: status | Error | (() => result) } */
function make({ members = {}, settings = {}, channels = [{ chat_id: A, username: 'chA' }, { chat_id: B, username: 'chB' }, { chat_id: C, username: 'chC' }] } = {}) {
  const clock = fakeClock();
  const repo = fakeForceJoinRepo(channels);
  const calls = [];
  const passes = [];
  let cleared = 0;
  const tg = {
    async getChatMember(chatId, userId) {
      calls.push([chatId, userId]);
      const m = members[chatId];
      if (m instanceof Error) throw m;
      if (typeof m === 'function') return m();
      if (typeof m === 'object' && m) return m;
      return { status: m || 'left' };
    },
  };
  const gated = [];
  const counted = [];
  const users = {
    setPass: async (tid, until) => passes.push([tid, until]),
    clearAllPasses: async () => { cleared += 1; return 1; },
    markGated: async (tid) => { gated.push(tid); return true; },
    convertPass: async (tid, until) => { passes.push([tid, until]); return true; },
  };
  const stats = { count: (m) => counted.push(m), dayStart: async () => 0 };
  const s = fakeSettings(settings);
  const alerts = fakeAlerts(clock);
  const audit = fakeAudit();
  const svc = createForceJoinService({ repo, users, tg, settings: s, alerts, audit, clock, log: noLog, stats });
  return { svc, clock, repo, calls, passes, gated, counted, alerts, audit, settings: s, cleared: () => cleared, members };
}
const user = (extra = {}) => ({ telegram_id: 42, role: 'user', force_join_ok_until: 0, ...extra });

test('joined all: passes, checks channels in parallel, stores a pass with the TTL', async () => {
  const f = make({ members: { [A]: 'member', [B]: 'administrator', [C]: 'creator' } });
  const u = user();
  const v = await f.svc.check(u);
  assert.equal(v.passed, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.passes, [[42, f.clock.now() + 600]]);
  assert.equal(u.force_join_ok_until, f.clock.now() + 600);
});

test('missing one / missing several, in list order; failures are never cached', async () => {
  let f = make({ members: { [A]: 'member', [B]: 'left', [C]: 'member' } });
  let v = await f.svc.check(user());
  assert.equal(v.passed, false);
  assert.deepEqual(v.missing.map((c) => c.chat_id), [B]);
  assert.deepEqual(f.passes, []);
  f = make({ members: { [A]: 'kicked', [B]: 'left', [C]: 'member' } });
  v = await f.svc.check(user());
  assert.deepEqual(v.missing.map((c) => c.chat_id), [A, B]);
  assert.deepEqual(f.passes, []);
});

test('restricted counts only with is_member: true', async () => {
  let f = make({ members: { [A]: { status: 'restricted', is_member: true }, [B]: 'member', [C]: 'member' } });
  assert.equal((await f.svc.check(user())).passed, true);
  f = make({ members: { [A]: { status: 'restricted', is_member: false }, [B]: 'member', [C]: 'member' } });
  assert.deepEqual((await f.svc.check(user())).missing.map((c) => c.chat_id), [A]);
});

test('bot not admin: failure mode open skips the channel, closed locks; owner alerted once an hour', async () => {
  const notAdmin = apiError(400, 'Bad Request: member list is inaccessible');
  let f = make({ members: { [A]: 'member', [B]: notAdmin, [C]: 'member' } });
  let v = await f.svc.check(user());
  assert.equal(v.passed, true, 'open: skipped');
  assert.deepEqual(v.broken.map((c) => c.chat_id), [B]);
  assert.equal(f.repo.rows.find((r) => r.chat_id === B).last_check_status, 'bot_not_admin');
  assert.equal(f.alerts.sent.length, 1);
  assert.match(f.alerts.sent[0].text, /ربات ادمین نیست/);
  await f.svc.check(user({ telegram_id: 43 }));
  assert.equal(f.alerts.sent.length, 1, 'throttled within the hour');
  f.clock.advance(3601);
  await f.svc.check(user({ telegram_id: 44 }));
  assert.equal(f.alerts.sent.length, 2, 'again after an hour');

  f = make({ members: { [A]: 'member', [B]: notAdmin, [C]: 'member' }, settings: { 'forcejoin.failure_mode': 'closed' } });
  v = await f.svc.check(user());
  assert.equal(v.passed, false, 'closed: locked');
  assert.deepEqual(v.missing.map((c) => c.chat_id), [B]);
});

test('400 "member not found" (Telegram\'s answer for a non-member) counts as not joined, even in open mode', async () => {
  const f = make({ members: { [A]: apiError(400, 'Bad Request: member not found'), [B]: 'member', [C]: 'member' } });
  const v = await f.svc.check(user());
  assert.equal(v.passed, false);
  assert.deepEqual(v.missing.map((c) => c.chat_id), [A]);
  assert.deepEqual(v.broken, []);
  assert.equal(f.repo.rows.find((r) => r.chat_id === A).last_check_status, 'ok', 'the channel is healthy');
  assert.equal(f.alerts.sent.length, 0, 'no alert');
  assert.equal(f.calls.filter((c) => c[0] === A).length, 1, 'not retried');
});

test('chat not found → not_found health and an alert', async () => {
  const f = make({ members: { [A]: apiError(400, 'Bad Request: chat not found'), [B]: 'member', [C]: 'member' } });
  assert.equal((await f.svc.check(user())).passed, true);
  assert.equal(f.repo.rows.find((r) => r.chat_id === A).last_check_status, 'not_found');
  assert.equal(f.alerts.sent.length, 1);
});

test('transient errors: one quick retry, then the failure mode', async () => {
  let n = 0;
  const flaky = () => { n += 1; if (n === 1) throw apiError(502, 'Bad Gateway'); return { status: 'member' }; };
  let f = make({ members: { [A]: flaky, [B]: 'member', [C]: 'member' } });
  assert.equal((await f.svc.check(user())).passed, true);
  assert.equal(f.calls.filter((c) => c[0] === A).length, 2, 'retried once');

  f = make({ members: { [A]: apiError(429, 'Too Many Requests', { retry_after: 3 }), [B]: 'member', [C]: 'member' }, settings: { 'forcejoin.failure_mode': 'closed' } });
  const v = await f.svc.check(user());
  assert.equal(f.calls.filter((c) => c[0] === A).length, 2);
  assert.equal(v.passed, false);
  assert.equal(f.repo.rows.find((r) => r.chat_id === A).last_check_status, 'error');
  assert.equal(f.alerts.sent.length, 0, 'transient errors do not alert');
});

test('cache: a pass is used until the TTL ends; useCache:false always re-checks', async () => {
  const f = make({ members: { [A]: 'member', [B]: 'member', [C]: 'member' } });
  const u = user();
  await f.svc.check(u);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.svc.check(u)).cached, true);
  assert.equal(f.calls.length, 3, 'no API calls while cached');
  await f.svc.check(u, { useCache: false });
  assert.equal(f.calls.length, 6);
  f.clock.advance(601);
  f.members[B] = 'left';
  const v = await f.svc.check(u);
  assert.equal(v.passed, false, 'after the TTL the user is checked again');
});

test('staff bypass (setting) and a list with no enabled channel', async () => {
  let f = make();
  assert.equal((await f.svc.check(user({ telegram_id: OWNER_ID }))).bypass, true);
  assert.equal((await f.svc.check(user({ role: 'admin' }))).bypass, true);
  assert.equal(f.calls.length, 0);
  f = make({ settings: { 'forcejoin.bypass_staff': false } });
  assert.equal((await f.svc.check(user({ role: 'admin' }))).passed, false);
  f = make({ channels: [] });
  assert.equal((await f.svc.check(user())).passed, true);
});

test('any list change invalidates every pass (version bump + one clear)', async () => {
  const f = make({ members: { [A]: 'member', [B]: 'member', [C]: 'member' } });
  const owner = { telegram_id: OWNER_ID, role: 'user' };
  await f.svc.setEnabled(owner, 2, false);
  assert.equal(f.settings.m.get('forcejoin.version'), 2);
  await f.svc.move(owner, 1, 1);
  await f.svc.remove(owner, 3);
  await f.svc.setInviteLink(owner, 1, 'https://t.me/+AbCdEfGh123');
  await f.svc.setFailureMode(owner, 'closed');
  assert.equal(f.cleared(), 5);
  assert.equal(f.settings.m.get('forcejoin.version'), 6);
  assert.deepEqual(f.audit.rows.map((r) => r[1]), ['forcejoin.disable', 'forcejoin.reorder', 'forcejoin.remove', 'forcejoin.link']);
  assert.deepEqual((await f.repo.list()).map((r) => r.id), [2, 1], 'reordered');
});

test('management is owner-only even when called directly (second check)', async () => {
  const f = make();
  const admin = { telegram_id: 7, role: 'admin' };
  await assert.rejects(f.svc.remove(admin, 1), /permission denied/);
  await assert.rejects(f.svc.add(admin, '@x'), /permission denied/);
  assert.equal(f.repo.rows.length, 3);
});

test('seed: only into an empty table, only once', async () => {
  let f = make({ channels: [] });
  assert.equal(await f.svc.seedIfNeeded(), 3);
  assert.equal(await f.svc.seedIfNeeded(), 0, 'seeded flag set');
  f = make({ channels: [{ chat_id: -5 }] });
  assert.equal(await f.svc.seedIfNeeded(), 0, 'table not empty');
});

test('gate views: join buttons per missing channel, invite links, and the inline gate', () => {
  const v = joinView([{ username: 'chA', title: 'A & B' }, { username: null, invite_link: 'https://t.me/+xyzXYZ123', title: 'Private' }, { username: null, title: 'No link' }], 'fa');
  const rows = v.keyboard.inline_keyboard;
  assert.deepEqual(rows.map((r) => r[0].url || r[0].callback_data), ['https://t.me/chA', 'https://t.me/+xyzXYZ123', 'fj:check']);
  assert.equal(rows[0][0].text, '📢 A & B');
  assert.equal(rows[2][0].text, '✅ عضو شدم');
  const g = inlineGateAnswer('q1', 'fa');
  assert.deepEqual(g, { inline_query_id: 'q1', results: [], is_personal: true, cache_time: 0, button: { text: '🔒 اول عضو کانال‌ها شو', start_parameter: 'join' } });
  assert.match(g.button.start_parameter, /^[A-Za-z0-9_-]{1,64}$/);
});

test('conversions: a failed check marks the user gated once; a later pass counts one conversion', async () => {
  const f = make({ members: { [A]: 'member', [B]: 'left', [C]: 'member' } });
  const u = user();
  assert.equal((await f.svc.check(u)).passed, false);
  assert.equal(u.force_join_ok_until, -1);
  assert.equal((await f.svc.check(u)).passed, false); // still gated: not counted again
  assert.deepEqual(f.gated, [42]);
  f.members[B] = 'member';
  assert.equal((await f.svc.check(u, { useCache: false })).passed, true);
  assert.ok(u.force_join_ok_until > 0);
  assert.deepEqual(f.counted, ['fj.gated', 'fj.converted']);
  assert.equal((await f.svc.check(u, { useCache: false })).passed, true); // a normal re-check is no conversion
  assert.deepEqual(f.counted, ['fj.gated', 'fj.converted']);
});
