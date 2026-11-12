// Phase 1 acceptance: "a non-member is blocked on every entry point and passes right after
// joining, with the pending action resumed". Plus the order maintenance → ban → gate, owner
// bypass, broken channels skipped with an owner alert, and the pass cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, SEED, advance } from './helpers/harness.mjs';

const U = 700001;
const gateShown = (h, id, from) => h.tg.calls.slice(from).some((c) => c.method === 'sendMessage' && Number(c.params.chat_id) === id && /fj:check/.test(JSON.stringify(c.params.reply_markup || {})));

async function pickedLanguage(h, id) {
  await h.send(id, '/start');
  await h.tap(id, 'l:set:fa');
}

test('start → language → gate → join → «عضو شدم» → menu', async () => {
  const h = setup();
  let r = await h.send(U, '/start');
  assert.equal(r.result, 'lang_first');
  r = await h.tap(U, 'l:set:fa');
  assert.ok(r.ok);
  assert.ok(h.lastButtons(U).some((b) => b.url === 'https://t.me/HIDE_i_SEEK'));
  assert.deepEqual(h.lastButtons(U).filter((b) => b.url).map((b) => b.text.replace('➕ ', '')), ['HIDE & SEEK', 'Nepenthe', 'Wanger bots']);
  h.join(U);
  await h.tap(U, 'fj:check');
  assert.ok(h.texts(U).some((t) => /Wanger Stickers/.test(t)));
});

test('a non-member is blocked on every entry point', async () => {
  const h = setup();
  await pickedLanguage(h, U);
  const entries = [
    () => h.send(U, 'hello'),
    () => h.send(U, '/menu'),
    () => h.send(U, '/packs'),
    () => h.send(U, '/help'),
    () => h.send(U, '/deletemydata'),
    () => h.send(U, '/start'),
    () => h.sendSticker(U, h.tg.sticker()),
    () => h.send(U, null, { photo: [{ file_id: 'P1', file_unique_id: 'PU1', width: 10, height: 10 }] }),
    () => h.press(U, 'm:packs:0'),
    () => h.press(U, 'm:acct'),
    () => h.press(U, 'pk:new'),
    () => h.press(U, 'pk:imp'),
    () => h.press(U, 'pk:open:1'),
    () => h.press(U, 'pb:ask:1'),
    () => h.press(U, 'dm:yes'),
  ];
  for (const [i, run] of entries.entries()) {
    const mark = h.mark();
    const r = await run();
    assert.ok(r.ok, `entry ${i}: ${JSON.stringify(r)}`);
    assert.ok(gateShown(h, U, mark), `entry ${i} did not show the gate: ${r.result}`);
    // nothing else happened: no sticker-set call, no pack screen
    const other = h.tg.calls.slice(mark).filter((c) => /Sticker|sendDocument/.test(c.method));
    assert.equal(other.length, 0, `entry ${i} did work while gated`);
  }
  assert.equal(h.one('SELECT count(*) AS n FROM packs').n, 0);
});

test('the pending action is resumed right after joining (a sticker sent while gated)', async () => {
  const h = setup();
  await pickedLanguage(h, U);
  const s = h.tg.sticker();
  await h.sendSticker(U, s);
  assert.ok(h.one('SELECT action FROM pending_actions WHERE tg_id = ?', U));
  h.join(U);
  const mark = h.mark();
  await h.tap(U, 'fj:check');
  const texts = h.texts(U, mark);
  assert.ok(texts.some((t) => /کدام پک/.test(t)), texts.join('\n---\n'));
  assert.ok(h.findData(U, 'st:new'));
  assert.equal(h.one('SELECT count(*) AS n FROM pending_actions').n, 0);
});

test('a pending button press is resumed too', async () => {
  const h = setup();
  await pickedLanguage(h, U);
  await h.press(U, 'm:acct');
  h.join(U);
  const mark = h.mark();
  await h.tap(U, 'fj:check');
  assert.ok(h.texts(U, mark).some((t) => /حساب Wanger من/.test(t)));
});

test('a /start payload kept through the language choice and the gate', async () => {
  const h = setup();
  await h.send(U, '/start pub_12');
  const p = JSON.parse(h.one('SELECT action FROM pending_actions WHERE tg_id = ?', U).action);
  assert.deepEqual(p, { kind: 'start', payload: 'pub_12' });
});

test('«عضو شدم» re-checks without the cache and says what is missing', async () => {
  const h = setup();
  await pickedLanguage(h, U);
  h.join(U, [SEED[0], SEED[1]]); // still missing the third
  const mark = h.mark();
  await h.tap(U, 'fj:check');
  const gm = h.tg.calls.slice(mark).filter((c) => c.method === 'getChatMember' && c.params.user_id === U);
  assert.equal(gm.length, 3);
  const urls = h.lastButtons(U).filter((b) => b.url).map((b) => b.url);
  assert.deepEqual(urls, ['https://t.me/wangerBots']);
});

test('a pass is cached for 10 minutes; changing the channel list invalidates it', async () => {
  const h = setup();
  h.join(U);
  await pickedLanguage(h, U);
  let mark = h.mark();
  await h.send(U, '/menu');
  assert.equal(h.tg.callsOf('getChatMember', undefined, mark).filter((c) => c.params.user_id === U).length, 0);
  advance(601);
  mark = h.mark();
  await h.send(U, '/menu');
  assert.equal(h.tg.callsOf('getChatMember', undefined, mark).filter((c) => c.params.user_id === U).length, 3);
  // owner disables a channel → version bump → next message re-checks
  const ch = h.one('SELECT id FROM channels ORDER BY position LIMIT 1');
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  await h.press(OWNER, `a:chtog:${ch.id}`);
  mark = h.mark();
  await h.send(U, '/menu');
  assert.equal(h.tg.callsOf('getChatMember', undefined, mark).filter((c) => c.params.user_id === U).length, 2);
});

test('the owner is never gated', async () => {
  const h = setup();
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  const mark = h.mark();
  await h.send(OWNER, '/packs');
  assert.ok(!gateShown(h, OWNER, mark));
  assert.equal(h.tg.callsOf('getChatMember', undefined, mark).length, 0);
});

test('a channel the bot can no longer check is skipped, and the owner is alerted (once an hour)', async () => {
  const h = setup({ botAdminIn: [SEED[0], SEED[1]] });
  h.join(U, [SEED[0], SEED[1]]);
  await pickedLanguage(h, U);
  assert.ok(h.texts(U).some((t) => /Wanger Stickers/.test(t)), 'user passed although the third channel is broken');
  const alerts = h.tg.callsOf('sendMessage', OWNER).filter((c) => /بررسی نمی/.test(c.params.text));
  assert.equal(alerts.length, 1);
  const U2 = 700002;
  h.join(U2, [SEED[0], SEED[1]]);
  await pickedLanguage(h, U2);
  assert.equal(h.tg.callsOf('sendMessage', OWNER).filter((c) => /بررسی نمی/.test(c.params.text)).length, 1);
  assert.equal(h.one('SELECT health FROM channels WHERE chat_id = ?', SEED[2]).health, 'bot_not_admin');
});

test('maintenance comes before the ban, the ban before the gate', async () => {
  const h = setup();
  h.join(U);
  await pickedLanguage(h, U);
  h.db.prepare("UPDATE users SET banned = 1 WHERE tg_id = ?").run(U);
  let mark = h.mark();
  await h.send(U, '/start');
  assert.match(h.texts(U, mark).join(), /بسته شده/);
  assert.equal(h.tg.callsOf('getChatMember', undefined, mark).length, 0);
  h.db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('maintenance.on', 'true', 0, 0)").run();
  mark = h.mark();
  await h.send(U, '/start');
  assert.match(h.texts(U, mark).join(), /به‌روزرسانی|به‌روزرسانی/);
  // the owner is not affected
  await h.send(OWNER, '/start');
  assert.equal(h.one('SELECT lang FROM users WHERE tg_id = ?', OWNER).lang, null);
});

test('my_chat_member: the bot removed from a gate channel → immediate owner alert; blocked in private', async () => {
  const h = setup();
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  const mark = h.mark();
  const r = await h.myChatMember({ id: SEED[1], type: 'channel', title: 'Nepenthe' }, 1, 'left');
  assert.equal(r.result, 'gate_channel');
  assert.ok(h.tg.callsOf('sendMessage', OWNER, mark).some((c) => /Nepenthe/.test(c.params.text)));
  h.join(U);
  await pickedLanguage(h, U);
  await h.myChatMember({ id: U, type: 'private' }, U, 'kicked');
  assert.equal(h.one('SELECT blocked_bot FROM users WHERE tg_id = ?', U).blocked_bot, 1);
});
