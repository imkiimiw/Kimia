// Security tests (Phase 10): who may press what, tampered and random callback data, hostile text and
// names, the Mini App endpoints' checks of the caller. Run: npm run test:security
//  1. the authorization matrix — owner-only buttons, the team panel's levels (none / viewer / support /
//     manager / owner), a chat's panel for someone who isn't its admin, moderation from a member;
//  2. callback fuzzing — random and malformed callback_data on every known head, in private and in a group,
//     from a stranger: nothing throws, every press is answered once, nothing privileged happens;
//  3. message fuzzing — commands with odd arguments, HTML, bidi controls, 4096-character texts;
//  4. escaping — HTML in names and titles is shown escaped (the strict mock rejects bad HTML anyway);
//  5. endpoints — the Mini App endpoints act only for the user Telegram's init data names.
import assert from 'node:assert/strict';
import { OWNER_ID } from '../tgcloud/lib/config.js';
import { createHarness, report, rng, section } from './harness.mjs';

const h = await createHarness();
const outcome = [];
const R = rng(20261031);
const PRIVILEGED = new Set(['banChatMember', 'unbanChatMember', 'promoteChatMember', 'leaveChat', 'setChatPermissions', 'setChatTitle', 'restrictChatMember',
  'deleteMessages', 'revokeChatInviteLink', 'declineChatJoinRequest', 'approveChatJoinRequest', 'createNewStickerSet']);
const quiet = (calls) => calls.filter((c) => c.method !== 'answerCallbackQuery');
const answers = (calls) => calls.filter((c) => c.method === 'answerCallbackQuery');
const parseFailures = (calls) => calls.filter((c) => !c.result.ok && /parse entities|can't parse|BUTTON_DATA_INVALID|too long/i.test(c.result.description || ''));
const errorRows = () => h.row('SELECT count(*) AS n FROM aegis_errors').n;
const kv = (key) => (h.row('SELECT value FROM aegis_kv WHERE key = ?', key) || {}).value;

const owner = h.person(OWNER_ID, 'Owner', 'en');
const stranger = h.person(810000001, 'Stranger <b>&', 'en');
const viewer = h.person(810000002, 'Vera', 'en');
const support = h.person(810000003, 'Sam', 'en');
const manager = h.person(810000004, 'Mona', 'en');
const creator = h.person(810000005, 'Cleo', 'en');
const member = h.person(810000006, 'Milo <script>', 'en');
const G = await (async () => {
  for (const u of [owner, stranger, viewer, support, manager, creator, member]) await h.onboard(u);
  return h.addGroup(-1008100001, '<i>Evil</i> & co', creator, [member, stranger]);
})();
const G2 = await h.addGroup(-1008100002, 'Other', member, []);
for (const [u, level] of [[viewer, 'viewer'], [support, 'support'], [manager, 'manager']]) {
  h.db().prepare('INSERT INTO aegis_staff (user_id, level, name, added_by, added_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)').run(u.id, level, u.first_name, OWNER_ID);
}
const homeOf = async (u) => {
  const c = await h.dm(u, '/start');
  return c.calls.find((x) => x.method === 'sendMessage' && x.params.chat_id === u.id).result.result.message_id;
};
const MID = {};
for (const u of [owner, stranger, viewer, support, manager, creator, member]) MID[u.id] = await homeOf(u);
const groupMsg = (await h.gmsg(G, member, 'hello')).calls && h.msgId - 1;

await section(outcome, 'owner-only buttons do nothing for anyone else (stranger, every team level, a group\'s creator)', async () => {
  const data = ['op', 'os', 'oj', 'oj:a', 'oj:t', 'oj:c', 'oj:y:1', 'oj:u:1', 'ob', 'ob:n', 'bc:s:1', 'bc:x:1', 'ox', 'sy:st', 'sy:off', 'sy:offy', 'sy:on'];
  for (const u of [stranger, viewer, support, manager, creator]) {
    for (const d of data) {
      const x = await h.press(u, d, u.id, MID[u.id]);
      assert.equal(x.r.error, undefined, d);
      assert.equal(answers(x.calls).length, 1, `${d} answered once`);
      assert.equal(answers(x.calls)[0].params.text, undefined, `${d}: no hint to ${u.first_name}`);
      assert.deepEqual(quiet(x.calls), [], `${d} did something for ${u.first_name}`);
    }
  }
  assert.equal(kv('shutdown'), '0');
  assert.equal(kv('join_enabled'), '0');
});

await section(outcome, 'the team panel: each button needs a level; below it a member gets a refusal, outside the team nothing at all', async () => {
  const RANK = { none: 0, viewer: 1, support: 2, manager: 3, owner: 9 };
  const cases = [
    ['sa', 'viewer'], ['sa:c:f:a:0', 'viewer'], [`sa:c:i:${G.id}`, 'viewer'], ['sa:v', 'viewer'], ['sa:h', 'viewer'], ['sa:e', 'viewer'], ['sa:q', 'viewer'],
    [`sa:c:r:${G.id}`, 'support'], ['sa:l:a:0', 'support'], ['sa:k', 'support'], ['sa:k:v:1', 'support'], ['sa:e:i:1', 'support'],
    [`sa:c:s:${G.id}`, 'manager'], [`sa:c:l:${G.id}`, 'manager'], [`sa:c:b:${G.id}`, 'manager'], [`sa:c:m:${G.id}`, 'manager'], ['sa:k:n', 'manager'],
    ['sa:l:x', 'manager'], ['sa:q:u', 'manager'],
    ['sa:s', 'owner'], ['sa:s:a', 'owner'], [`sa:s:v:${viewer.id}:manager`, 'owner'], [`sa:s:ry:${support.id}`, 'owner'], ['sa:g', 'owner'],
    ['sa:g:t:g_fun', 'owner'], ['sa:g:lx', 'owner'], ['sa:b', 'owner'], ['sa:b:g', 'owner'], ['sa:b:c:0', 'owner'], ['sa:b:y', 'owner'], ['sa:zz', 'owner'],
  ];
  for (const [u, level] of [[stranger, 'none'], [creator, 'none'], [viewer, 'viewer'], [support, 'support'], [manager, 'manager'], [owner, 'owner']]) {
    if (level === 'owner') {
      assert.equal(h.row('SELECT level FROM aegis_staff WHERE user_id = ?', viewer.id).level, 'viewer', 'nobody but the owner changes levels');
      assert.ok(h.row('SELECT 1 AS x FROM aegis_staff WHERE user_id = ?', support.id), 'nobody but the owner removes members');
      assert.equal(kv('g_fun'), undefined, 'nobody but the owner changes system settings');
    }
    for (const [d, need] of cases) {
      const x = await h.press(u, d, u.id, MID[u.id]);
      assert.equal(x.r.error, undefined, `${d} by ${level}: ${x.r.error}`);
      assert.equal(answers(x.calls).length, 1, `${d} by ${level}: answered once`);
      const allowed = RANK[level] >= RANK[need];
      if (allowed) assert.ok(quiet(x.calls).length > 0 || answers(x.calls)[0].params.text, `${d} by ${level} should work`);
      else if (level === 'none') assert.deepEqual(quiet(x.calls), [], `${d} by ${level}`);
      else {
        assert.equal(answers(x.calls)[0].params.show_alert, true, `${d} by ${level}: refused with an alert`);
        assert.deepEqual(quiet(x.calls), [], `${d} by ${level}: refused, nothing done`);
      }
    }
  }
  assert.equal(h.row('SELECT level FROM aegis_staff WHERE user_id = ?', viewer.id).level, 'manager', 'the owner\'s own press changed it');
  assert.equal(kv('g_fun'), '0', 'the owner\'s own press changed it');
});

await section(outcome, 'a chat\'s panel and moderation: someone who is not an admin of that chat gets no panel and no action; ids in buttons are re-checked', async () => {
  for (const [u, chat] of [[stranger, G], [member, G], [creator, G2]]) {
    for (const d of [`g:${chat.id}`, `g:${chat.id}:mod`, `g:${chat.id}:lk`, `g:${chat.id}:sec`, `g:${chat.id}:adv`]) {
      const x = await h.press(u, d, u.id, MID[u.id]);
      assert.equal(x.r.error, undefined, d);
      const shown = quiet(x.calls).filter((c) => c.params.reply_markup && JSON.stringify(c.params.reply_markup).includes(`g:${chat.id}:`));
      assert.deepEqual(shown, [], `${u.first_name} saw the panel of ${chat.title} (${d})`);
    }
  }
  const ban = await h.gmsg(G, member, '/ban', { reply_to_message: { message_id: groupMsg, from: stranger, chat: G, date: 0, text: 'x' } });
  assert.equal(ban.calls.filter((c) => PRIVILEGED.has(c.method)).length, 0, 'a member cannot ban');
  const pu = await h.press(member, 'pu:1', G.id, groupMsg);
  assert.equal(pu.calls.filter((c) => PRIVILEGED.has(c.method)).length, 0, 'a member cannot undo a punishment');
});

await section(outcome, 'callback fuzzing: 1200 random and malformed callback_data on every known head, in private and in a group — nothing throws, every press is answered once, nothing privileged happens', async () => {
  const heads = ['lg', 'jc', 'mm', 'hp', 'cl', 'g', 'db', 'xp', 'op', 'os', 'oj', 'ob', 'bc', 'ox', 'sy', 'sa', 'pu', 'bt', 'cp', 'rk', 'ld', 'fj', 'rp', 'an', 'pq',
    'ct', 'qa', 'apl', 'apc', 'rv', 'fn', 'md', 'nop', '', 'x', '🙂', 'SA', 'g '];
  const atoms = () => R.pick(['', '0', '-1', '1', '99999999999999999999', String(G.id), String(G2.id), String(OWNER_ID), 'NaN', 'undefined', 'null', '__proto__',
    'constructor', "' OR 1=1 --", '<b>', '%00', '../../', 'a'.repeat(R.int(70)), '٣', 'y', 'n', 'ok', 'x', 'a', 'f', 's', 'i', 'v', 'manager', 'owner', '1e9', '-0', '0x10']);
  const before = errorRows();
  let n = 0;
  for (let i = 0; i < 600; i += 1) {
    const parts = [R.pick(heads)];
    for (let k = R.int(5); k > 0; k -= 1) parts.push(atoms());
    const data = parts.join(R.next() < 0.9 ? ':' : '::');
    for (const [chatId, mid] of [[stranger.id, MID[stranger.id]], [G.id, groupMsg]]) {
      const x = await h.press(stranger, data, chatId, mid);
      n += 1;
      assert.equal(x.r.error, undefined, `${JSON.stringify(data)} threw: ${x.r.error}`);
      assert.equal(answers(x.calls).length, 1, `${JSON.stringify(data)} answered ${answers(x.calls).length} times`);
      assert.deepEqual(x.calls.filter((c) => PRIVILEGED.has(c.method)).map((c) => c.method), [], JSON.stringify(data));
      assert.deepEqual(parseFailures(x.calls).map((c) => c.result.description), [], JSON.stringify(data));
      for (const c of quiet(x.calls)) {
        const to = Number(c.params.chat_id);
        assert.ok(!to || to === stranger.id || to === G.id, `${JSON.stringify(data)}: ${c.method} to ${to}`);
      }
    }
  }
  assert.equal(errorRows(), before, 'no failure was recorded');
  assert.equal(n, 1200);
});

await section(outcome, 'message fuzzing: odd commands, HTML, bidi controls, zero-width characters and 4096-character texts — in private and in a group, nothing throws or breaks HTML', async () => {
  const words = ['/start', '/start c_-100', '/start c_99999999999999999999', '/start md_0', '/start ap_-1', '/start q_1', '/help', '/config', '/language', '/staff',
    '/panel', '/status', '/shutdown', '/activate', '/cancel', '/appeal', '/ban', '/mute 99999d', '/warn @', '/rules', '/report', '/me', '/top', '/give -5', '/ask',
    '/dice', '/qr', 'پنل', 'ستاد', 'خاموش', 'staff', '<b>bold</b>', '&amp; &lt;', '<a href="javascript:x">x</a>', '‮txt.exe', 'a​b', '🙂'.repeat(50),
    'ـــ', '٠١٢', '\u0000', "'; DROP TABLE aegis_users; --", '{{7*7}}', '${process.exit()}'];
  const before = errorRows();
  for (let i = 0; i < 250; i += 1) {
    let text = R.pick(words);
    if (R.next() < 0.3) text += ` ${R.pick(words)}`;
    if (R.next() < 0.05) text = 'x'.repeat(4096);
    for (const send of [() => h.dm(stranger, text), () => h.gmsg(G, member, text)]) {
      const x = await send();
      assert.equal(x.r.error, undefined, `${JSON.stringify(text.slice(0, 40))} threw: ${x.r.error}`);
      assert.deepEqual(parseFailures(x.calls).map((c) => c.result.description), [], JSON.stringify(text.slice(0, 40)));
      assert.deepEqual(x.calls.filter((c) => ['banChatMember', 'promoteChatMember', 'leaveChat', 'setChatTitle'].includes(c.method)).map((c) => c.method), []);
    }
    h.tick(7);
  }
  assert.equal(kv('shutdown'), '0', 'a stranger\'s /shutdown does nothing');
  assert.equal(errorRows(), before, 'no failure was recorded');
});

await section(outcome, 'escaping: HTML in a group title and in names is shown escaped on the owner\'s screens', async () => {
  const c = await h.press(owner, 'sa:c:f:a:0', owner.id, MID[owner.id]);
  const screen = c.calls.find((x) => x.method === 'editMessageText');
  assert.match(screen.params.text, /&lt;i&gt;Evil&lt;\/i&gt; &amp; co/);
  const d = await h.press(owner, `sa:c:i:${G.id}`, owner.id, MID[owner.id]);
  assert.match(d.calls.find((x) => x.method === 'editMessageText').params.text, /&lt;i&gt;Evil/);
  const w = await h.dm(stranger, '/start');
  assert.match(w.calls.find((x) => x.method === 'sendMessage').params.text, /Stranger &lt;b&gt;&amp;/);
});

await section(outcome, 'Mini App endpoints act only for the user in Telegram\'s init data', async () => {
  const bcLive = (await import('../tgcloud/endpoints/bcLive.js')).default;
  const media = (await import('../tgcloud/endpoints/media.js')).default;
  const code = async (fn) => {
    try {
      await fn();
      return 'ok';
    } catch (e) {
      return (e && e.parameters && e.parameters.code) || String(e);
    }
  };
  assert.equal(await code(() => bcLive({ action: 'tick', id: 1 }, { initData: { user: stranger } })), 'OWNER_ONLY');
  assert.equal(await code(() => bcLive({ action: 'tick', id: 1 }, { initData: {} })), 'OWNER_ONLY');
  assert.equal(await code(() => media({ action: 'get', job: 1 }, { initData: {} })), 'NO_USER');
  h.db().prepare("INSERT INTO aegis_media_jobs (user_id, chat_id, kind, file_id, data, at) VALUES (?, 0, 'photo', 'f1', '{}', 0)").run(member.id);
  const job = h.row('SELECT max(id) AS id FROM aegis_media_jobs').id;
  assert.equal(await code(() => media({ action: 'send', job, text: 'hi' }, { initData: { user: stranger } })), 'GONE', 'someone else\'s job');
  assert.equal(await code(() => media({ action: 'send', job: `${job} OR 1=1`, text: 'hi' }, { initData: { user: member } })), 'GONE');
});

await h.close();
assert.deepEqual(h.consoleErrors.filter((e) => !/"level":"error"/.test(e)), [], 'unexpected console errors');
report(outcome);
