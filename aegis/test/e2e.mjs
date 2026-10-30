// End-to-end tests of Phase 1: the real handlers and the Mini App endpoint (tgcloud/) against a local
// emulation of the platform's sdk (test/sdk/: SQLite via node:sqlite) and a strict mock Bot API
// (test/mock-telegram.mjs). Web/Node globals the isolate lacks are removed first, the clock is fake.
// Every Persian message is checked for right-to-left marks; every button press must be answered once.
// Run: npm run test:e2e
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { BC_BATCH, BC_CHUNK, JOIN_CACHE_SEC, MAX_JOIN_CHANNELS, OWNER_ID } from '../tgcloud/lib/config.js';

const BOT_ID = 7200000001;
const RLM = '‏';
const mock = createMockTelegram({ botId: BOT_ID });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema);

// The three default forced-join channels: the bot is admin in two; @wangerBots is not (yet).
mock.addChat({ id: -1001, type: 'channel', username: 'HIDE_i_SEEK', title: 'Hide i Seek' });
mock.addChat({ id: -1002, type: 'channel', username: 'Nepenthw_ir', title: 'Nepenthe' });
mock.addChat({ id: -1003, type: 'channel', username: 'wangerBots', title: 'Wanger Bots', botAdmin: false });

for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'FormData', 'Headers', 'Request', 'Response', 'fetch',
  'setTimeout', 'setInterval', 'setImmediate', 'structuredClone', 'atob', 'btoa', 'crypto', 'Buffer', 'Intl']) delete globalThis[name];

const H = {};
for (const h of ['message', 'callback_query', 'my_chat_member', 'chat_member']) H[h] = (await import(`../tgcloud/handlers/${h}.js`)).default;
const bcLive = (await import('../tgcloud/endpoints/bcLive.js')).default;

const errors = [];
console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
console.warn = () => {};
let clock = Date.UTC(2026, 9, 30, 9, 0);
Date.now = () => clock;
const tick = (sec) => { clock += sec * 1000; };

const person = (id, first_name, language_code = 'en') => ({ id, is_bot: false, first_name, language_code });
const U = {
  owner: person(OWNER_ID, 'Kimia', 'fa'),
  ali: person(800000001, 'علی', 'fa'),
  bea: person(800000002, 'Béa', 'fr'),
  ivan: person(800000003, 'Иван', 'ru'),
  li: person(800000004, '李', 'zh-hans'),
  dan: person(800000005, 'Dan <b>', 'en'),
};
const faUsers = new Set([OWNER_ID, U.ali.id]);
const join = (u, ...chans) => { for (const c of chans) mock.state.chats.get(c).members.add(u.id); };

let seq = 1;
let msgId = 1;
function checkRtl(calls) {
  for (const c of calls) {
    if (!['sendMessage', 'editMessageText'].includes(c.method) || !c.result.ok) continue;
    const cid = Number(c.params.chat_id);
    const faChat = cid < 0 && (rawDatabase().prepare('SELECT lang FROM aegis_chats WHERE chat_id = ?').get(cid) || {}).lang === 'fa';
    if (!faUsers.has(cid) && !faChat) continue;
    if (/🌐 Choose your language/.test(c.params.text)) continue; // the picker shows every language
    for (const line of c.params.text.split('\n')) if (line) assert.equal(line[0], RLM, `Persian line without RLM: ${JSON.stringify(line)}`);
  }
}
async function run(handler, payload, { updateId = seq++, expectError = false } = {}) {
  const start = mock.state.calls.length;
  const r = await handler(payload, { update: { update_id: updateId } });
  assert.ok(r && Array.isArray(r.trace), 'no trace');
  if (!expectError) assert.equal(r.error, undefined, `handler error: ${r.error}`);
  const calls = mock.state.calls.slice(start);
  assert.deepEqual(r.trace.map((e) => e.m), calls.map((c) => c.method), 'trace differs from calls');
  checkRtl(calls);
  return Object.assign(calls, { result: r });
}
async function dm(u, text, extra = {}, opts = {}) {
  mock.state.started.add(u.id);
  const id = msgId++;
  mock.userMessage(u.id, id, { text, plain: text, kind: extra.photo ? 'photo' : 'text' });
  return run(H.message, { message_id: id, from: u, chat: { id: u.id, type: 'private' }, date: 0, ...(text !== null ? { text } : {}), ...extra }, opts);
}
async function press(u, data, msg) {
  const calls = await run(H.callback_query, { id: `cb${seq++}`, from: u, chat_instance: 'x', data, message: mock.messageObject(u.id, msg) });
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.length, 1, `answered ${answers.length} times: ${data}`);
  return { calls, toast: answers[0].params.text || '', alert: !!answers[0].params.show_alert };
}
async function member(chat, from, oldStatus, newStatus) {
  return run(H.my_chat_member, { chat, from, date: 0, old_chat_member: { status: oldStatus, user: mock.bot }, new_chat_member: { status: newStatus, user: mock.bot } });
}
async function endpoint(u, input) {
  try {
    return { result: await bcLive(input, { initData: { user: u, auth_date: 1 } }) };
  } catch (e) {
    if (e && e.parameters) return { code: e.parameters.code };
    throw e;
  }
}
const sent = (calls, m = 'sendMessage') => calls.filter((c) => c.method === m);
const edits = (calls) => calls.filter((c) => c.method === 'editMessageText');
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const rows = (q, ...p) => rawDatabase().prepare(q).all(...p);
const lastBotMessage = (chatId) => [...mock.state.messages.values()].filter((m) => m.chat === chatId && m.from.id === BOT_ID).pop();
const kb = (m) => (m.markup && m.markup.inline_keyboard ? m.markup.inline_keyboard.flat() : []);
const dataOf = (m) => kb(m).map((b) => b.callback_data || b.url || (b.web_app && 'webapp'));
const midOf = (call) => call.result.result.message_id;
function findButton(m, re) {
  const b = kb(m).find((x) => re.test(x.text) || re.test(x.callback_data || ''));
  assert.ok(b, `no button ${re} in ${JSON.stringify(kb(m).map((x) => x.text))}`);
  return b.callback_data;
}

const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push(true);
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push(false);
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 8).join('\n   ')}`);
  }
}

// ---------- first contact, language, forced join ----------

await scenario('first /start: data migration seeds the 3 channels, command menus are set, the 5-language picker comes first', async () => {
  const calls = await dm(U.ali, '/start');
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'data_version'").value, '2');
  assert.deepEqual(rows('SELECT username FROM aegis_join_channels ORDER BY position').map((r) => r.username), ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']);
  assert.equal(sent(calls, 'setMyCommands').length, 6, 'default + one per language');
  assert.equal(sent(calls, 'setMyDefaultAdministratorRights').length, 2, 'suggested admin rights for groups and channels');
  assert.equal(mock.state.defaultRights.group.can_promote_members, true);
  assert.ok(mock.state.commands.some((c) => c.language_code === 'fa' && c.commands.some((x) => x.description === 'تغییر زبان')));
  assert.equal(sent(calls, 'getChatMember').length, 0, 'no membership check before a language is chosen');
  const [pick] = sent(calls);
  for (const s of ['زبان خود را انتخاب کنید', 'Choose your language', 'Выберите язык', '请选择语言', 'Choisissez votre langue']) assert.ok(pick.params.text.includes(s), s);
  assert.deepEqual(pick.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['lg:fa', 'lg:en', 'lg:ru', 'lg:zh', 'lg:fr']);
  assert.equal(row('SELECT started FROM aegis_users WHERE user_id = ?', U.ali.id).started, 1);
  assert.equal(sent(await dm(U.ali, 'hello'), 'setMyCommands').length, 0, 'menus are set once');
});

await scenario('choosing Persian → the join screen in Persian lists only the checkable channels (the broken one is skipped)', async () => {
  const pick = lastBotMessage(U.ali.id);
  const r = await press(U.ali, 'lg:fa', pick.message_id);
  assert.equal(r.toast, `${RLM}✅ زبان: فارسی`);
  const screen = mock.get(U.ali.id, pick.message_id);
  assert.match(screen.plain, /اول عضو کانال‌های ما شوید/);
  assert.deepEqual(dataOf(screen), ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'jc', 'lg']);
  assert.equal(row('SELECT lang, lang_set FROM aegis_users WHERE user_id = ?', U.ali.id).lang_set, 1);
  assert.equal(row("SELECT bot_admin FROM aegis_join_channels WHERE username = 'wangerBots'").bot_admin, 0);
  assert.equal(sent(r.calls).filter((c) => c.params.chat_id === OWNER_ID).length, 0, 'the owner has not started the bot yet');
});

await scenario('the owner: picker, then the welcome with the owner panel button — exempt from forced join; warned about the broken channel once', async () => {
  const c1 = await dm(U.owner, '/start');
  assert.match(sent(c1)[0].params.text, /Choose your language/);
  const r = await press(U.owner, 'lg:fa', midOf(sent(c1)[0]));
  assert.equal(sent(r.calls, 'getChatMember').length, 0, 'the owner is never checked');
  const welcome = mock.get(OWNER_ID, midOf(sent(c1)[0]));
  assert.match(welcome.plain, /Aegis رباتِ مدیریت و امنیتِ/);
  assert.ok(dataOf(welcome).includes('op'));
  assert.ok(mock.state.commands.some((c) => c.scope.type === 'chat' && c.scope.chat_id === OWNER_ID && c.commands.some((x) => x.command === 'panel')));
  const again = await dm(U.ali, '/start');
  const warn = sent(again).filter((c) => c.params.chat_id === OWNER_ID);
  assert.equal(warn.length, 1);
  assert.match(warn[0].params.text, /Wanger Bots|wangerBots/);
  assert.equal(sent(await dm(U.ali, '/start')).filter((c) => c.params.chat_id === OWNER_ID).length, 0, 'once per interval');
});

await scenario('"✅ I joined": missing → alert with the count; joined → thanks + Persian welcome; the pass is cached briefly', async () => {
  const s = sent(await dm(U.ali, '/start'))[0];
  const r1 = await press(U.ali, 'jc', midOf(s));
  assert.ok(r1.alert);
  assert.match(r1.toast, /۲ کانال/);
  join(U.ali, -1001, -1002);
  const r2 = await press(U.ali, 'jc', midOf(s));
  assert.match(r2.toast, /ممنون/);
  const welcome = mock.get(U.ali.id, midOf(s));
  assert.match(welcome.plain, /سلام ⁨علی⁩!/);
  const d = dataOf(welcome);
  assert.deepEqual([d[0], d[3], d[4]], ['cl', 'lg', 'hp']);
  assert.match(d[1], /^https:\/\/t\.me\/aegis_test_bot\?startgroup=aegis&admin=.*promote_members/);
  assert.match(d[2], /^https:\/\/t\.me\/aegis_test_bot\?startchannel&admin=.*post_messages/);
  const cached = await dm(U.ali, '/help');
  assert.equal(sent(cached, 'getChatMember').length, 0, 'cached pass');
  assert.match(sent(cached)[0].params.text, /راهنما/);
  tick(JOIN_CACHE_SEC + 1);
  assert.equal(sent(await dm(U.ali, '/help'), 'getChatMember').length, 3, 'checked again after the cache expires');
});

await scenario('until they join, nothing else works in private — except the language picker; the French user sees French', async () => {
  const c = await dm(U.bea, '/start');
  await press(U.bea, 'lg:fr', midOf(sent(c)[0]));
  assert.match(mock.get(U.bea.id, midOf(sent(c)[0])).plain, /Rejoignez d’abord nos canaux/);
  assert.match(sent(await dm(U.bea, '/help'))[0].params.text, /Rejoignez/, '/help is gated');
  assert.match(sent(await dm(U.bea, 'aide'))[0].params.text, /Rejoignez/, 'so is its alias');
  const gated = await press(U.bea, 'hp', midOf(sent(c)[0]));
  assert.ok(gated.alert);
  assert.match(gated.toast, /pas encore rejoint/);
  for (const word of ['/language', 'زبان', 'language', 'langue']) {
    const p = sent(await dm(U.bea, word))[0];
    assert.match(p.params.text, /Choisissez votre langue/, word);
    assert.match(p.params.text, /Actuelle : <b>Français<\/b>/);
    assert.ok(p.params.reply_markup.inline_keyboard.flat().some((b) => b.text.startsWith('✓ ') && b.callback_data === 'lg:fr'));
  }
});

await scenario('Persian and English aliases both work (help / راهنما, start / شروع), with Arabic-keyboard letters too', async () => {
  for (const w of ['راهنما', 'help', 'HELP']) assert.match(sent(await dm(U.ali, w))[0].params.text, /❓ <b>راهنما<\/b>/, w);
  for (const w of ['شروع', 'start', 'منو']) assert.match(sent(await dm(U.ali, w))[0].params.text, /سلام/, w);
  assert.match(sent(await dm(U.ali, 'زبان'))[0].params.text, /Choose your language/);
  assert.equal(sent(await dm(U.ali, 'پنل'))[0].params.text.includes('پنل مالک'), false, 'not the owner: just the main menu');
});

await scenario('the owner panel is the owner\'s only: others get the main menu or a silent answer', async () => {
  const c = await dm(U.ali, '/panel');
  assert.match(sent(c)[0].params.text, /سلام/);
  const m = midOf(sent(c)[0]);
  for (const data of ['op', 'os', 'oj', 'oj:t', 'ob', 'ob:n', 'bc:go:1', 'ox']) {
    const r = await press(U.ali, data, m);
    assert.equal(r.toast, '');
    assert.equal(r.calls.filter((x) => x.method !== 'answerCallbackQuery').length, 0, `${data} did something for a non-owner`);
  }
  for (const w of ['/panel', 'پنل', 'panel', 'پنل مدیریت']) assert.match(sent(await dm(U.owner, w))[0].params.text, /پنل مالک/, w);
});

// ---------- users and chats ----------

await scenario('blocking / unblocking the bot in private is tracked; adding the bot to groups and channels records them', async () => {
  await dm(U.ivan, '/start');
  await member({ id: U.ivan.id, type: 'private', first_name: 'Иван' }, U.ivan, 'member', 'kicked');
  assert.equal(row('SELECT blocked FROM aegis_users WHERE user_id = ?', U.ivan.id).blocked, 1);
  mock.state.started.add(U.li.id);
  await member({ id: U.li.id, type: 'private' }, U.li, 'kicked', 'member');
  assert.equal(row('SELECT started, blocked FROM aegis_users WHERE user_id = ?', U.li.id).started, 1);
  mock.addChat({ id: -2001, type: 'supergroup', title: 'Group One', count: 150 });
  mock.addChat({ id: -4001, type: 'group', title: 'Small Group', count: 12 });
  mock.addChat({ id: -3001, type: 'channel', title: 'Channel One', username: 'chan_one', count: 1000 });
  const g = await member({ id: -2001, type: 'supergroup', title: 'Group One' }, U.ali, 'left', 'member');
  assert.equal(sent(g, 'getChatMemberCount').length, 1);
  assert.equal(sent(g).filter((c) => c.params.chat_id === -2001).length, 1, 'phase 2: the warning in the group');
  assert.equal(sent(g).filter((c) => c.params.chat_id === U.ali.id).length, 1, 'phase 2: and in the adding admin\'s private chat');
  await member({ id: -4001, type: 'group', title: 'Small Group' }, U.ali, 'left', 'administrator');
  await member({ id: -3001, type: 'channel', title: 'Channel One', username: 'chan_one' }, U.dan, 'left', 'administrator');
  const g1 = row('SELECT * FROM aegis_chats WHERE chat_id = -2001');
  assert.equal(g1.active, 1);
  assert.equal(g1.member_count, 150);
  assert.equal(g1.lang, 'fa', 'the language of the admin who added it');
  assert.equal(g1.added_by, U.ali.id);
  assert.equal(row('SELECT lang FROM aegis_chats WHERE chat_id = -3001').lang, 'en');
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'chat.added' AND chat_id = -3001"));
  mock.addChat({ id: -2003, type: 'supergroup', title: 'Leaving', count: 5 });
  await member({ id: -2003, type: 'supergroup', title: 'Leaving' }, U.dan, 'left', 'member');
  await member({ id: -2003, type: 'supergroup', title: 'Leaving' }, U.dan, 'member', 'left');
  assert.equal(row('SELECT active FROM aegis_chats WHERE chat_id = -2003').active, 0);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'chat.removed' AND chat_id = -2003"));
});

await scenario('owner stats: started / active / blocked / new today & 7 days, groups, channels, total members', async () => {
  rawDatabase().prepare('UPDATE aegis_users SET started_at = ? WHERE user_id = ?').run(Math.floor(clock / 1000) - 3 * 86400, U.bea.id);
  const c = await dm(U.owner, '/panel');
  const panel = sent(c)[0];
  assert.match(panel.params.text, /گروه‌ها: <b>۲<\/b> · 📢 کانال‌ها: <b>۱<\/b>/);
  const r = await press(U.owner, 'os', midOf(panel));
  const s = mock.get(OWNER_ID, midOf(panel)).plain;
  // started: ali, owner, bea, ivan, li = 5; blocked: ivan; active: 4; new today: 4 (bea is 3 days old); 7 days: 5
  assert.match(s, /استارت کرده‌اند: ۵/);
  assert.match(s, /فعال \(پیام دریافت می‌کنند\): ۴/);
  assert.match(s, /بلاک کرده‌اند: ۱/);
  assert.match(s, /امروز ۴ · ۷ روز اخیر ۵/);
  assert.match(s, /گروه‌ها: ۲ · 📢 کانال‌ها: ۱/);
  assert.match(s, /مجموع اعضای این چت‌ها: ۱۱۶۲/);
  assert.equal(sent(r.calls, 'getChatMemberCount').length, 0, 'counts are fresh');
  tick(3601);
  mock.state.chats.get(-2001).count = 200;
  const r2 = await press(U.owner, 'os', midOf(panel));
  assert.equal(sent(r2.calls, 'getChatMemberCount').length, 3, 'stale counts are refreshed');
  assert.match(mock.get(OWNER_ID, midOf(panel)).plain, /اعضای این چت‌ها: ۱۲۱۲/);
});

// ---------- forced-join management ----------

let joinPanel = null;
await scenario('forced-join screen: ✅ / ⚠️ per channel, a warning when the bot is not an admin, reorder / remove / add / on-off buttons', async () => {
  const c = await dm(U.owner, '/panel');
  joinPanel = midOf(sent(c)[0]);
  const r = await press(U.owner, 'oj', joinPanel);
  assert.ok(sent(r.calls, 'getChat').length >= 3, 'admin rights refreshed');
  const m = mock.get(OWNER_ID, joinPanel);
  assert.match(m.plain, /عضویت اجباری — روشن/);
  assert.match(m.plain, /کانال‌ها: ۳\/۱۰/);
  assert.match(m.plain, /Aegis در ۱ کانالِ علامت‌خورده با ⚠️ ادمین نیست/);
  assert.match(m.plain, /۳\. ⚠️ ⁨Wanger Bots⁩ — @wangerBots \(ربات ادمین نیست\)/);
  assert.match(m.plain, /۱\. ✅ ⁨Hide i Seek⁩/);
  const d = dataOf(m);
  for (const x of ['oj:a', 'oj:t', 'oj:c', 'op']) assert.ok(d.includes(x), x);
  assert.equal(d.filter((x) => /^oj:[udr]:/.test(x)).length, 9);
});

await scenario('adding channels: @username, forwarded post, private with invite link, not-admin warning, bad input, duplicates, the 10 limit', async () => {
  mock.addChat({ id: -1004, type: 'channel', username: 'newchan', title: 'New Chan' });
  mock.addChat({ id: -1005, type: 'channel', title: 'Private One' });
  mock.addChat({ id: -1006, type: 'channel', username: 'noadmin', title: 'No Admin', botAdmin: false });
  mock.addChat({ id: -1007, type: 'channel', title: 'Private No Link', botAdmin: false });
  const add = async (input) => {
    await press(U.owner, 'oj:a', joinPanel);
    assert.match(mock.get(OWNER_ID, joinPanel).plain, /افزودن کانال/);
    return dm(U.owner, input.text || null, input.extra || {});
  };
  let c = await add({ text: '@newchan' });
  assert.match(sent(c)[0].params.text, /⁨New Chan⁩ اضافه شد/);
  c = await add({ text: null, extra: { forward_origin: { type: 'channel', chat: { id: -1005, type: 'channel', title: 'Private One' }, message_id: 7, date: 0 } } });
  assert.equal(sent(c, 'exportChatInviteLink').length, 1);
  assert.equal(row('SELECT invite_link FROM aegis_join_channels WHERE chat_id = -1005').invite_link, 'https://t.me/+inv1005');
  c = await add({ text: 'https://t.me/noadmin' });
  assert.match(sent(c)[0].params.text, /Aegis آن‌جا ادمین نیست/);
  c = await add({ text: 'hello' });
  assert.match(sent(c)[0].params.text, /این یک کانال نیست/);
  c = await dm(U.owner, '-1009999999');
  assert.match(sent(c)[0].params.text, /تلگرام این چت را پیدا نمی‌کند/, 'unknown id');
  c = await dm(U.owner, '-1007');
  assert.match(sent(c)[0].params.text, /این یک کانال نیست/, 'a short id is not a channel id');
  rawDatabase().prepare('DELETE FROM aegis_states').run();
  mock.state.chats.set(-1001234567, { ...mock.state.chats.get(-1007), id: -1001234567 });
  c = await add({ text: '1234567' });
  assert.match(sent(c)[0].params.text, /خصوصی است و لینک دعوتی/);
  rawDatabase().prepare('DELETE FROM aegis_states').run();
  c = await add({ text: '@HIDE_i_SEEK' });
  assert.match(sent(c)[0].params.text, /از قبل در فهرست است/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_join_channels').n, 6);
  for (let i = 0; i < 4; i += 1) {
    mock.addChat({ id: -1100 - i, type: 'channel', username: `extra_${i}x`, title: `Extra ${i}` });
    await add({ text: `@extra_${i}x` });
  }
  assert.equal(row('SELECT count(*) AS n FROM aegis_join_channels').n, MAX_JOIN_CHANNELS);
  const m = mock.get(OWNER_ID, joinPanel);
  await press(U.owner, 'oj', joinPanel);
  assert.ok(!dataOf(mock.get(OWNER_ID, joinPanel)).includes('oj:a'), 'no add button at the limit');
  const r = await press(U.owner, 'oj:a', joinPanel);
  assert.ok(r.alert);
  assert.match(r.toast, /حداکثر ۱۰ کانال/);
  assert.ok(m);
  assert.equal(rows("SELECT * FROM aegis_audit WHERE action = 'join.add'").length, 7);
});

await scenario('a new channel invalidates cached passes; users see channels in the owner\'s order; remove asks first; on/off', async () => {
  join(U.ali, -1004, -1005, -1100, -1101, -1102, -1103);
  let c = await dm(U.ali, '/start');
  assert.match(sent(c).find((x) => x.params.chat_id === U.ali.id).params.text, /سلام/, 'ali joined everything checkable');
  assert.match(sent(c).find((x) => x.params.chat_id === OWNER_ID).params.text, /No Admin/, 'the owner is warned about the new non-admin channel');
  const newId = row("SELECT id FROM aegis_join_channels WHERE username = 'newchan'").id;
  mock.state.chats.get(-1004).members.delete(U.ali.id);
  rawDatabase().prepare('UPDATE aegis_users SET join_ok_at = ? WHERE user_id = ?').run(Math.floor(clock / 1000), U.ali.id);
  const up = await press(U.owner, `oj:u:${newId}`, joinPanel);
  assert.equal(up.toast, '');
  c = await dm(U.ali, '/start');
  assert.match(sent(c)[0].params.text, /سلام/, 'reordering keeps cached passes');
  const removeId = row("SELECT id FROM aegis_join_channels WHERE username = 'extra_0x'").id;
  await press(U.owner, `oj:r:${removeId}`, joinPanel);
  assert.match(mock.get(OWNER_ID, joinPanel).plain, /از عضویت اجباری حذف شود؟/);
  assert.deepEqual(dataOf(mock.get(OWNER_ID, joinPanel)), [`oj:y:${removeId}`, 'oj']);
  await press(U.owner, `oj:y:${removeId}`, joinPanel);
  assert.match(mock.get(OWNER_ID, joinPanel).plain, /حذف شد/);
  c = await dm(U.ali, '/start');
  const screen = sent(c)[0];
  assert.match(screen.params.text, /New Chan/, 'the removal bumped the revision: ali is checked again');
  const order = rows('SELECT username FROM aegis_join_channels ORDER BY position').map((r) => r.username);
  assert.equal(order.indexOf('newchan'), 2, 'moved up one place');
  await press(U.owner, 'oj:t', joinPanel);
  assert.match(mock.get(OWNER_ID, joinPanel).plain, /خاموش/);
  c = await dm(U.ali, '/start');
  assert.equal(sent(c, 'getChatMember').length, 0);
  assert.match(sent(c)[0].params.text, /سلام/);
  await press(U.owner, 'oj:t', joinPanel);
  for (const name of ['extra_1x', 'extra_2x', 'extra_3x', 'noadmin']) {
    const id = row('SELECT id FROM aegis_join_channels WHERE username = ?', name).id;
    await press(U.owner, `oj:y:${id}`, joinPanel);
  }
  join(U.ali, -1004);
  assert.match(sent(await dm(U.ali, '/start'))[0].params.text, /سلام/);
  assert.ok(rows("SELECT * FROM aegis_audit WHERE action IN ('join.remove', 'join.move', 'join.toggle')").length >= 7);
});

// ---------- broadcasts ----------

const bulk = [];
await scenario('setup: 40 more users start the bot', async () => {
  for (let i = 1; i <= 40; i += 1) {
    const u = person(810000000 + i, `User ${i}`, i % 2 ? 'en' : 'fa');
    bulk.push(u);
    await dm(u, '/start');
  }
  assert.equal(row('SELECT count(*) AS n FROM aegis_users WHERE started = 1 AND blocked = 0').n, 44);
});

let bcPanel = null;
let bcId = null;
let photoMsg = null;
await scenario('broadcast to users, copy mode: audience → mode → photo → exact preview + confirm; link buttons with validation', async () => {
  const c = await dm(U.owner, '/panel');
  bcPanel = midOf(sent(c)[0]);
  await press(U.owner, 'ob', bcPanel);
  assert.match(mock.get(OWNER_ID, bcPanel).plain, /الان چیزی در حال ارسال نیست/);
  await press(U.owner, 'ob:n', bcPanel);
  const aud = mock.get(OWNER_ID, bcPanel);
  assert.deepEqual(kb(aud).map((b) => b.text), [`${RLM}👤 کاربران ربات (۴۳)`, `${RLM}👥 همه‌ی گروه‌ها (۲)`, `${RLM}📢 همه‌ی کانال‌ها (۱)`, `${RLM}⬅️ بازگشت`]);
  await press(U.owner, 'ob:a:u', bcPanel);
  assert.match(mock.get(OWNER_ID, bcPanel).plain, /کپی — به‌عنوان پیام خود Aegis/);
  await press(U.owner, 'ob:m:u:c', bcPanel);
  assert.match(mock.get(OWNER_ID, bcPanel).plain, /پیامی را که باید برای کاربران ربات \(کپی\)/);
  const album = await dm(U.owner, null, { photo: [{ file_id: 'p0' }], media_group_id: 'g1' });
  assert.match(sent(album)[0].params.text, /آلبوم/);
  const p = await dm(U.owner, null, { photo: [{ file_id: 'p1' }], caption: 'Hello all' });
  photoMsg = msgId - 1;
  const preview = sent(p, 'copyMessage');
  assert.equal(preview.length, 1);
  assert.equal(preview[0].params.chat_id, OWNER_ID);
  const card = sent(p)[0];
  bcId = Number(/#([۰-۹]+)/.exec(card.params.text)[1].replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  assert.match(card.params.text, /کاربران ربات<\/b> — ۴۳ دریافت‌کننده/);
  assert.match(card.params.text, /محتوا: عکس/);
  assert.deepEqual(card.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), [`bc:go:${bcId}`, `bc:bt:${bcId}`, `bc:no:${bcId}`]);
  await press(U.owner, `bc:bt:${bcId}`, midOf(card));
  const bad = await dm(U.owner, 'Site https://example.com');
  assert.match(sent(bad)[0].params.text, /خط ۱ به شکل/);
  const good = await dm(U.owner, 'Site - https://example.com | کانال - t.me/HIDE_i_SEEK');
  assert.deepEqual(sent(good, 'copyMessage')[0].params.reply_markup.inline_keyboard, [[{ text: 'Site', url: 'https://example.com' }, { text: 'کانال', url: 'https://t.me/HIDE_i_SEEK' }]]);
  assert.match(sent(good)[0].params.text, /دکمه‌های لینک: ۲/);
  assert.ok(dataOf(lastBotMessage(OWNER_ID)).includes(`bc:rb:${bcId}`));
  bcPanel = lastBotMessage(OWNER_ID).message_id;
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'bc.create'"));
});

await scenario('sending: first batch at once; a 429 pauses for retry_after and resumes from the same user; 403s are marked blocked', async () => {
  for (const u of bulk.slice(0, 3)) mock.state.blocked.add(u.id);
  mock.state.sendsToOthers = 0;
  mock.state.floodAfter = 10;
  mock.state.floodRetry = 3;
  const r = await press(U.owner, `bc:go:${bcId}`, bcPanel);
  assert.match(r.toast, /در حال ارسال/);
  const copies = sent(r.calls, 'copyMessage');
  assert.equal(copies.filter((x) => x.result.ok).length, 10, '10 delivered');
  assert.equal(copies.filter((x) => x.result.error_code === 403).length, 3, 'three blocked the bot');
  assert.equal(copies[copies.length - 1].result.error_code, 429, 'then a 429 stops the batch');
  assert.ok(copies.every((x) => x.params.chat_id !== OWNER_ID), 'the owner is not a recipient');
  const b = row('SELECT * FROM aegis_broadcasts WHERE id = ?', bcId);
  assert.equal(b.status, 'running');
  assert.equal(b.sent, 10);
  assert.equal(b.blocked, 3);
  assert.equal(b.wait_sec, 3);
  assert.equal(row('SELECT blocked FROM aegis_users WHERE user_id = ?', bulk[0].id).blocked, 1, 'marked inactive');
  const panel = mock.get(OWNER_ID, bcPanel).plain;
  assert.match(panel, /محدودیت سرعت تلگرام: ۳ ثانیه صبر/);
  assert.match(panel, /ارسال‌شده: ۱۰ · ❌ ناموفق: ۰ · ⛔️ بلاک‌کرده: ۳/);
  assert.ok(dataOf(mock.get(OWNER_ID, bcPanel)).includes('webapp'), 'live sending button');
  const early = await press(U.owner, `bc:nx:${bcId}`, bcPanel);
  assert.match(early.toast, /صبر کنید/);
  assert.equal(sent(early.calls, 'copyMessage').length, 0);
  const retried = copies[copies.length - 1].params.chat_id;
  tick(4);
  const r2 = await press(U.owner, `bc:nx:${bcId}`, bcPanel);
  const c2 = sent(r2.calls, 'copyMessage');
  assert.equal(c2[0].params.chat_id, retried, 'the throttled user is retried first');
  assert.equal(c2.length, BC_BATCH);
  assert.match(r2.toast, /دسته فرستاده شد: ۲۵ پیام/);
});

await scenario('other updates move a running broadcast forward a little; it finishes with one report; nobody gets it twice', async () => {
  tick(2);
  const side = await dm(U.ali, '/help');
  assert.equal(sent(side, 'copyMessage').length, BC_CHUNK, 'a chunk on the side of an ordinary update');
  for (let i = 0; i < 5; i += 1) {
    tick(2);
    const b = row('SELECT status FROM aegis_broadcasts WHERE id = ?', bcId);
    if (b.status !== 'running') break;
    await press(U.owner, `bc:nx:${bcId}`, bcPanel);
  }
  const b = row('SELECT * FROM aegis_broadcasts WHERE id = ?', bcId);
  assert.equal(b.status, 'done');
  assert.equal(b.total, 43);
  assert.equal(b.sent, 40);
  assert.equal(b.blocked, 3);
  assert.equal(b.failed, 0);
  const reports = mock.state.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === OWNER_ID && /پیام همگانی #۱ تمام شد/.test(c.params.text));
  assert.equal(reports.length, 1);
  assert.match(reports[0].params.text, /ارسال‌شده: <b>۴۰<\/b>/);
  assert.match(reports[0].params.text, /بلاک یا حذف کرده‌اند: <b>۳<\/b>/);
  const per = new Map();
  for (const c of mock.state.calls.filter((x) => x.method === 'copyMessage' && x.params.message_id === photoMsg && x.result.ok)) per.set(c.params.chat_id, (per.get(c.params.chat_id) || 0) + 1);
  assert.equal(per.get(OWNER_ID), 2, 'the owner only got the two previews');
  per.delete(OWNER_ID);
  assert.equal(per.size, 40);
  assert.ok([...per.values()].every((n) => n === 1), 'exactly one copy each');
  const one = [...mock.state.messages.values()].find((m) => m.chat === U.ali.id && m.copyOf);
  assert.deepEqual(one.markup.inline_keyboard[0].map((x) => x.text), ['Site', 'کانال']);
  assert.match(mock.get(OWNER_ID, bcPanel).plain, /تمام شد/);
  assert.equal(rows("SELECT * FROM aegis_audit WHERE action = 'bc.done'").length, 1);
});

async function newBroadcast(aud, mode, text) {
  const c = await dm(U.owner, '/panel');
  const panel = midOf(sent(c)[0]);
  await press(U.owner, `ob:m:${aud}:${mode}`, panel);
  const m = await dm(U.owner, text);
  const card = sent(m).pop();
  const id = Number(card.params.reply_markup.inline_keyboard[0][0].callback_data.split(':')[2]);
  return { id, card: midOf(card), src: msgId - 1, calls: m };
}

await scenario('forward mode to all groups, queued behind a running broadcast; migration and removal handled', async () => {
  mock.state.chats.get(-4001).migrateTo = -1004001;
  mock.addChat({ id: -1004001, type: 'supergroup', title: 'Small Group' });
  mock.addChat({ id: -2002, type: 'supergroup', title: 'Kicked Group' });
  await member({ id: -2002, type: 'supergroup', title: 'Kicked Group' }, U.dan, 'left', 'member');
  mock.state.chats.get(-2002).kicked = true;
  const a = await newBroadcast('u', 'c', 'Update A');
  const fwd = await newBroadcast('g', 'f', 'Update B');
  assert.equal(sent(fwd.calls, 'forwardMessage').length, 1, 'forward preview');
  assert.ok(!dataOf(mock.get(OWNER_ID, fwd.card)).some((d) => /^bc:bt:/.test(d)), 'no buttons for forwards');
  assert.match(mock.get(OWNER_ID, fwd.card).plain, /به پیام فورواردی نمی‌شود دکمه اضافه کرد/);
  await press(U.owner, `bc:go:${a.id}`, a.card);
  const q = await press(U.owner, `bc:go:${fwd.id}`, fwd.card);
  assert.match(q.toast, /در صف/);
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', fwd.id).status, 'queued');
  const since = mock.state.calls.length;
  for (let i = 0; i < 4 && row('SELECT status FROM aegis_broadcasts WHERE id = ?', a.id).status === 'running'; i += 1) {
    tick(2);
    await press(U.owner, `bc:nx:${a.id}`, a.card);
  }
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', a.id).status, 'done');
  assert.notEqual(row('SELECT status FROM aegis_broadcasts WHERE id = ?', fwd.id).status, 'queued', 'the queued one started by itself');
  for (let i = 0; i < 3 && row('SELECT status FROM aegis_broadcasts WHERE id = ?', fwd.id).status === 'running'; i += 1) {
    tick(2);
    await press(U.owner, `bc:nx:${fwd.id}`, fwd.card);
  }
  const f = mock.state.calls.slice(since).filter((x) => x.method === 'forwardMessage' && x.params.message_id === fwd.src);
  assert.deepEqual(f.map((x) => x.params.chat_id).sort(), [-1004001, -4001, -2002, -2001].sort());
  const b = row('SELECT * FROM aegis_broadcasts WHERE id = ?', fwd.id);
  assert.equal(b.status, 'done');
  assert.equal(b.sent, 2);
  assert.equal(b.blocked, 1);
  assert.equal(row('SELECT type FROM aegis_chats WHERE chat_id = -1004001').type, 'supergroup', 'the row moved to the new id');
  assert.equal(row('SELECT count(*) AS n FROM aegis_chats WHERE chat_id = -4001').n, 0);
  assert.equal(row('SELECT active FROM aegis_chats WHERE chat_id = -2002').active, 0, 'a chat that removed the bot is marked inactive');
});

await scenario('pause, resume, cancel with confirmation → a "cancelled" report; nothing sent while paused', async () => {
  const c = await newBroadcast('u', 'c', 'Update C');
  await press(U.owner, `bc:go:${c.id}`, c.card);
  await press(U.owner, `bc:ps:${c.id}`, c.card);
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', c.id).status, 'paused');
  assert.ok(dataOf(mock.get(OWNER_ID, c.card)).includes(`bc:rs:${c.id}`));
  tick(5);
  const idle = await dm(U.ali, '/help');
  assert.equal(sent(idle, 'copyMessage').length, 0, 'paused: no side chunks');
  const nx = await press(U.owner, `bc:nx:${c.id}`, c.card);
  assert.match(nx.toast, /در حال ارسال نیست/);
  await press(U.owner, `bc:rs:${c.id}`, c.card);
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', c.id).status, 'running');
  await press(U.owner, `bc:x:${c.id}`, c.card);
  assert.match(mock.get(OWNER_ID, c.card).plain, /لغو شود؟/);
  assert.deepEqual(dataOf(mock.get(OWNER_ID, c.card)), [`bc:xy:${c.id}`, `bc:v:${c.id}`]);
  const r = await press(U.owner, `bc:xy:${c.id}`, c.card);
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', c.id).status, 'cancelled');
  assert.match(sent(r.calls).find((x) => /لغو شد<\/b>/.test(x.params.text)).params.text, /ارسال‌شده: <b>/);
  const again = await press(U.owner, `bc:xy:${c.id}`, c.card);
  assert.equal(sent(again.calls).length, 0, 'the report is sent once');
});

await scenario('the source message deleted mid-broadcast: paused with an explanation, not burned through', async () => {
  const d = await newBroadcast('u', 'c', 'Update D');
  mock.deleteMessage(OWNER_ID, d.src);
  const r = await press(U.owner, `bc:go:${d.id}`, d.card);
  const b = row('SELECT * FROM aegis_broadcasts WHERE id = ?', d.id);
  assert.equal(b.status, 'paused');
  assert.equal(b.last_error, 'source_gone');
  assert.equal(b.sent + b.failed, 0);
  assert.ok(sent(r.calls).some((x) => /پیام اصلی از این چت پاک شده/.test(x.params.text)));
  await press(U.owner, `bc:xy:${d.id}`, d.card);
});

await scenario('resumable: a batch left locked by a dead invocation is picked up from the cursor after the lock expires', async () => {
  const e = await newBroadcast('u', 'c', 'Update E');
  await press(U.owner, `bc:go:${e.id}`, e.card);
  const before = row('SELECT * FROM aegis_broadcasts WHERE id = ?', e.id);
  rawDatabase().prepare('UPDATE aegis_broadcasts SET lock_until_ms = ? WHERE id = ?').run(clock + 30000, e.id);
  tick(2);
  const locked = await press(U.owner, `bc:nx:${e.id}`, e.card);
  assert.match(locked.toast, /یک دسته در حال ارسال است/);
  tick(31);
  const r = await press(U.owner, `bc:nx:${e.id}`, e.card);
  const first = sent(r.calls, 'copyMessage')[0].params.chat_id;
  assert.ok(first > before.cursor, 'continues after the saved cursor');
  const per = new Map();
  for (const c of mock.state.calls.filter((x) => x.method === 'copyMessage' && x.params.message_id === e.src && x.result.ok)) per.set(c.params.chat_id, (per.get(c.params.chat_id) || 0) + 1);
  assert.ok([...per.values()].every((n) => n === 1));
  await press(U.owner, `bc:xy:${e.id}`, e.card);
});

await scenario('Mini App live page: owner only; ticks send batches; labels and numbers in the owner\'s language; cancel works', async () => {
  assert.equal((await endpoint(U.ali, { action: 'status' })).code, 'OWNER_ONLY');
  const idle = (await endpoint(U.owner, { action: 'status' })).result;
  assert.equal(idle.rtl, true);
  assert.equal(idle.labels.title, 'پیام همگانی');
  assert.ok(!idle.labels.hint.includes(RLM), 'plain text for the page');
  const f = await newBroadcast('u', 'f', 'Update F');
  await press(U.owner, `bc:go:${f.id}`, f.card);
  const firstBatch = row('SELECT sent + failed + blocked AS n FROM aegis_broadcasts WHERE id = ?', f.id).n;
  assert.ok(firstBatch > 0 && firstBatch <= BC_BATCH);
  const paced = (await endpoint(U.owner, { action: 'tick' })).result;
  assert.equal(paced.sent, 0, 'paced: at most one batch per second');
  const paused = (await endpoint(U.owner, { action: 'pause' })).result;
  assert.equal(paused.bc.status, 'paused');
  assert.equal(paused.bc.statusLabel, 'متوقف');
  tick(2);
  assert.equal((await endpoint(U.owner, { action: 'tick' })).result.sent, 0, 'nothing while paused');
  assert.equal((await endpoint(U.owner, { action: 'resume' })).result.bc.status, 'running');
  const start = mock.state.calls.length;
  const t1 = (await endpoint(U.owner, { action: 'tick' })).result;
  assert.ok(t1.sent > 0);
  assert.equal(mock.state.calls.slice(start).filter((c) => c.method === 'forwardMessage').length, t1.sent);
  assert.match(t1.bc.f.sent, /^[۰-۹]+$/);
  assert.equal(t1.bc.status, 'done');
  assert.equal(t1.bc.statusLabel, 'تمام شد');
  assert.ok(mock.state.calls.slice(start).some((c) => c.method === 'sendMessage' && /پیام همگانی #[۰-۹]+ تمام شد/.test(c.params.text)), 'final report');
  const g = await newBroadcast('u', 'c', 'Update G');
  await press(U.owner, `bc:go:${g.id}`, g.card);
  const before = mock.state.calls.length;
  const x = (await endpoint(U.owner, { action: 'cancel' })).result;
  assert.equal(x.bc.status, 'cancelled');
  assert.ok(mock.state.calls.slice(before).some((c) => c.method === 'sendMessage' && /لغو شد<\/b>/.test(c.params.text)));
});

// ---------- robustness ----------

await scenario('/cancel drops a pending input; while one is pending, plain words are content but slash commands interrupt', async () => {
  const c = await dm(U.owner, '/panel');
  const panel = midOf(sent(c)[0]);
  await press(U.owner, 'ob:m:u:c', panel);
  const cancelled = await dm(U.owner, '/cancel');
  assert.match(sent(cancelled)[0].params.text, /لغو شد/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_states').n, 0);
  await press(U.owner, 'ob:m:u:c', panel);
  const word = await dm(U.owner, 'help');
  assert.equal(sent(word, 'copyMessage').length, 1, '"help" became the broadcast content');
  const id = Number(sent(word).pop().params.reply_markup.inline_keyboard[0][0].callback_data.split(':')[2]);
  await press(U.owner, `bc:no:${id}`, lastBotMessage(OWNER_ID).message_id);
  assert.equal(row('SELECT status FROM aegis_broadcasts WHERE id = ?', id).status, 'cancelled');
  await press(U.owner, 'oj:a', panel);
  const slash = await dm(U.owner, '/help');
  assert.match(sent(slash)[0].params.text, /راهنما/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_states').n, 0, 'the slash command ended the input');
});

await scenario('idempotent updates: a redelivered update_id does nothing; one stuck "in progress" is retried after a minute', async () => {
  const payload = { message_id: msgId++, from: U.ali, chat: { id: U.ali.id, type: 'private' }, date: 0, text: '/help' };
  const first = await run(H.message, payload, { updateId: 999001 });
  assert.ok(sent(first).length >= 1);
  const dup = await run(H.message, payload, { updateId: 999001 });
  assert.equal(dup.length, 0);
  assert.equal(dup.result.duplicate, true);
  rawDatabase().prepare('UPDATE aegis_updates SET status = 0 WHERE update_id = 999001').run();
  assert.equal((await run(H.message, payload, { updateId: 999001 })).length, 0, 'in progress elsewhere');
  tick(61);
  assert.ok(sent(await run(H.message, payload, { updateId: 999001 })).length >= 1, 'retried after a crash');
});

await scenario('a failing update is recorded (aegis_errors + JSON log) and the owner is told at most every 30 minutes', async () => {
  errors.length = 0;
  const bad = { message_id: msgId++, from: { id: 'not-a-number', first_name: 'X' }, chat: { id: 5, type: 'private' }, date: 0, text: 'hi' };
  const r1 = await run(H.message, bad, { expectError: true });
  assert.ok(r1.result.error);
  assert.equal(sent(r1).filter((c) => c.params.chat_id === OWNER_ID).length, 1);
  assert.match(sent(r1)[0].params.text, /خطای Aegis/);
  const r2 = await run(H.message, bad, { expectError: true });
  assert.equal(sent(r2).filter((c) => c.params.chat_id === OWNER_ID).length, 0);
  assert.equal(row('SELECT count(*) AS n FROM aegis_errors').n, 2);
  assert.equal(row('SELECT source FROM aegis_errors ORDER BY id DESC LIMIT 1').source, 'message');
  assert.ok(errors.some((e) => /"level":"error"/.test(e)));
  rawDatabase().prepare('DELETE FROM aegis_errors').run();
  errors.length = 0;
});

await scenario('group messages: Phase 1 only records a group → supergroup migration', async () => {
  mock.addChat({ id: -5001, type: 'group', title: 'Old' });
  await member({ id: -5001, type: 'group', title: 'Old' }, U.ali, 'left', 'member');
  const c = await run(H.message, { message_id: 1, from: U.ali, chat: { id: -5001, type: 'group', title: 'Old' }, date: 0, migrate_to_chat_id: -1005001 });
  assert.equal(c.filter((x) => !['getChatMemberCount'].includes(x.method)).length, 0);
  assert.equal(row('SELECT type FROM aegis_chats WHERE chat_id = -1005001').type, 'supergroup');
  const g = await run(H.message, { message_id: 2, from: U.ali, chat: { id: -1005001, type: 'supergroup' }, date: 0, text: '/start' });
  assert.equal(sent(g).length, 0);
});

await scenario('housekeeping runs on the side of updates: old update ids and expired inputs are swept', async () => {
  rawDatabase().prepare('INSERT INTO aegis_states (user_id, kind, data, expires_at) VALUES (1, ?, ?, 1)').run('x', '{}');
  tick(3 * 86400);
  const c = await dm(U.ali, '/help');
  assert.ok(c.result.gc, 'housekeeping ran');
  assert.ok(c.result.gc.updates > 0);
  assert.equal(c.result.gc.states, 1);
  assert.equal(row('SELECT count(*) AS n FROM aegis_updates WHERE update_id = 999001').n, 0);
  assert.equal((await dm(U.ali, '/help')).result.gc, undefined, 'at most once per interval');
});

// ---------- phase 2: adding the bot, configuration & access control ----------

const FSI = '\u2068';
const PDI = '\u2069';
const n = (s) => `${FSI}${s}${PDI}`; /* a name as Aegis isolates it */
const P = {
  carol: { id: 800000010, is_bot: false, first_name: 'Carol', language_code: 'en', username: 'carol_c' },
  dave: { id: 800000011, is_bot: false, first_name: 'Dave', language_code: 'en' },
  erin: { id: 800000012, is_bot: false, first_name: 'Erin', language_code: 'en' },
  frank: { id: 800000013, is_bot: false, first_name: 'Frank', language_code: 'en', username: 'frank_u' },
  gina: { id: 800000014, is_bot: false, first_name: 'Gina', language_code: 'en' },
  hank: { id: 800000015, is_bot: false, first_name: 'Hank', language_code: 'en' },
};
const ALPHA = -1009001;
const NEWS = -1009100;
const alphaChat = { id: ALPHA, type: 'supergroup', title: 'Alpha' };
const newsChat = { id: NEWS, type: 'channel', title: 'News', username: 'news_ch' };
let alpha = null;
let news = null;
let carolPanel = null;
let davePanel = null;
let frankPanel = null;

async function onboard(u, lang) {
  const c = await dm(u, '/start');
  await press(u, `lg:${lang}`, midOf(sent(c).find((x) => x.params.chat_id === u.id)));
  join(u, -1001, -1002, -1004, -1005);
}
async function botChange(chat, from, oldStatus, newStatus, rights = {}) {
  const neu = { status: newStatus, user: mock.bot };
  if (newStatus === 'administrator') Object.assign(neu, { can_be_edited: false }, rights);
  return run(H.my_chat_member, { chat, from, date: 0, old_chat_member: { status: oldStatus, user: mock.bot }, new_chat_member: neu });
}
async function gmsg(chat, from, text, extra = {}) {
  return run(H.message, { message_id: msgId++, from, chat, date: 0, ...(text !== null ? { text } : {}), ...extra });
}
async function adminChange(chat, from, user, before, after) {
  return run(H.chat_member, { chat, from, date: 0, old_chat_member: { user, ...before }, new_chat_member: { user, ...after } });
}
const toChat = (calls, id) => sent(calls).filter((c) => c.params.chat_id === id);
const screenOf = (u, mid) => mock.get(u.id, mid);
const labelsOf = (u, mid) => kb(screenOf(u, mid)).map((b) => b.text);

await scenario('phase 2 — added as an admin with rights missing: warning in the group (its language) and the adder\'s private chat; chat registered, admins read', async () => {
  await onboard(P.carol, 'en');
  alpha = mock.addChat({ id: ALPHA, type: 'supergroup', title: 'Alpha', count: 40,
    botRights: { can_manage_chat: true, can_change_info: true, can_delete_messages: true, can_restrict_members: true, can_invite_users: true } });
  alpha.admins.set(P.carol.id, { status: 'creator', user: P.carol });
  alpha.admins.set(P.dave.id, { status: 'administrator', user: P.dave, rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }, promotedBy: P.carol.id });
  for (const u of [P.erin, P.frank, P.gina, P.hank]) {
    alpha.members.add(u.id);
    alpha.people.set(u.id, u);
  }
  const c = await botChange(alphaChat, P.carol, 'left', 'administrator', alpha.botRights);
  const [w] = toChat(c, ALPHA);
  assert.ok(w, 'warning in the group');
  assert.match(w.params.text, new RegExp(`Aegis has been added to ${n('Alpha')}`));
  assert.match(w.params.text, /only the admins it appointed itself/);
  assert.match(w.params.text, /<b>through Aegis's panel<\/b>/);
  for (const ok of ['Delete messages', 'Restrict members', 'Ban members', 'Invite users via link']) assert.match(w.params.text, new RegExp(`✅ ${ok}`));
  assert.match(w.params.text, /❌ Pin messages/);
  assert.match(w.params.text, /❌ Add new admins/);
  assert.match(w.params.text, /Missing: 2/);
  assert.match(w.params.text, /Admins not appointed through Aegis \(1\)/);
  assert.match(w.params.text, new RegExp(`• ${n('Dave')}`));
  const urls = w.params.reply_markup.inline_keyboard.flat().map((b) => b.url);
  assert.equal(urls[0], `https://t.me/aegis_test_bot?start=c_${ALPHA}`);
  assert.match(urls[1], /\?startgroup=aegis&admin=.*pin_messages\+promote_members$/);
  const [pm] = toChat(c, P.carol.id);
  assert.ok(pm, 'warning in the adder\'s private chat');
  assert.equal(pm.params.reply_markup.inline_keyboard[0][0].callback_data, `g:${ALPHA}`);
  const ch = row('SELECT * FROM aegis_chats WHERE chat_id = ?', ALPHA);
  assert.equal(ch.registered, 1);
  assert.equal(ch.missing, '["pin","promote"]');
  assert.equal(ch.lang, 'en');
  assert.equal(ch.added_by, P.carol.id);
  const cached = rows('SELECT user_id, status, via_aegis FROM aegis_chat_admins WHERE chat_id = ? ORDER BY user_id', ALPHA);
  assert.deepEqual(cached.map((r) => [r.user_id, r.status, r.via_aegis]), [[P.carol.id, 'creator', 0], [P.dave.id, 'administrator', 0], [BOT_ID, 'administrator', 0]]);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'chat.registered' AND chat_id = ?", ALPHA));
});

await scenario('phase 2 — a basic group added as a plain member by a Persian admin; a channel: private message only', async () => {
  const basic = mock.addChat({ id: -4002, type: 'group', title: 'Basic', botAdmin: false });
  basic.admins.set(U.ali.id, { status: 'creator', user: U.ali });
  const c = await botChange({ id: -4002, type: 'group', title: 'Basic' }, U.ali, 'left', 'member');
  const [w] = toChat(c, -4002);
  assert.match(w.params.text, new RegExp(`Aegis به ${n('Basic')} اضافه شد`));
  assert.equal((w.params.text.match(/❌/g) || []).length, 6, 'every required right is missing');
  assert.match(w.params.text, /گروه ساده/);
  assert.match(toChat(c, U.ali.id)[0].params.text, /گروه ساده/);
  news = mock.addChat({ id: NEWS, type: 'channel', title: 'News', username: 'news_ch', botRights: { can_manage_chat: true, can_change_info: true, can_post_messages: true,
    can_edit_messages: true, can_delete_messages: true, can_invite_users: true, can_restrict_members: true, can_promote_members: true } });
  news.admins.set(P.carol.id, { status: 'creator', user: P.carol });
  const ch = await botChange(newsChat, P.carol, 'left', 'administrator', news.botRights);
  assert.equal(toChat(ch, NEWS).length, 0, 'nothing is posted in a channel');
  assert.equal(toChat(ch, P.carol.id).length, 1);
  assert.match(toChat(ch, P.carol.id)[0].params.text, /All required permissions are granted/);
});

await scenario('phase 2 — the bot\'s rights change: a notice in the group and to whoever changed them; the same rights again say nothing', async () => {
  alpha.botRights = { ...alpha.botRights, can_pin_messages: true, can_promote_members: true };
  const c = await botChange(alphaChat, P.carol, 'administrator', 'administrator', alpha.botRights);
  assert.match(toChat(c, ALPHA)[0].params.text, /everything required is granted/);
  assert.equal(toChat(c, P.carol.id).length, 1);
  assert.equal(row('SELECT missing FROM aegis_chats WHERE chat_id = ?', ALPHA).missing, '[]');
  assert.equal(sent(await botChange(alphaChat, P.carol, 'administrator', 'administrator', alpha.botRights)).length, 0);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'chat.rights' AND chat_id = ?", ALPHA));
});

await scenario('phase 2 — «پیکربندی» / config in the group: admins get a link to the private panel, members are never answered', async () => {
  assert.equal(sent(await gmsg(alphaChat, P.frank, 'پیکربندی')).length, 0, 'ordinary members get no answer');
  const d = await gmsg(alphaChat, P.dave, 'config');
  const [r] = sent(d);
  assert.match(r.params.text, new RegExp(`${n('Dave')}, Aegis's settings for this chat open in a private chat`));
  assert.equal(r.params.reply_markup.inline_keyboard[0][0].url, `https://t.me/aegis_test_bot?start=c_${ALPHA}`);
  assert.ok(r.params.reply_parameters, 'a reply to the command');
  assert.equal(sent(await gmsg(alphaChat, P.carol, '/config@other_bot')).length, 0, 'another bot\'s command');
  assert.equal(sent(await gmsg(alphaChat, P.carol, '/config@aegis_test_bot')).length, 1);
  assert.equal(sent(await gmsg(alphaChat, P.carol, 'تنظیمات')).length, 1, 'the other Persian alias');
  const anon = await gmsg(alphaChat, { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' }, 'config',
    { sender_chat: { id: ALPHA, type: 'supergroup', title: 'Alpha' } });
  assert.match(sent(anon)[0].params.text, /posting anonymously/);
  assert.equal(sent(await gmsg(alphaChat, P.frank, 'hello everyone')).length, 0, 'ordinary chat: nothing');
});

await scenario('phase 2 — «پیکربندی» in private: the chats where the user is an allowed admin', async () => {
  const c = await dm(P.carol, 'پیکربندی');
  const m = sent(c)[0];
  assert.match(m.params.text, /Your chats/);
  const btns = m.params.reply_markup.inline_keyboard.flat();
  assert.ok(btns.some((b) => b.callback_data === `g:${ALPHA}` && /👥 Alpha · Owner/.test(b.text)));
  assert.ok(btns.some((b) => b.callback_data === `g:${NEWS}` && /📢 News · Owner/.test(b.text)));
  await onboard(P.frank, 'en');
  assert.match(sent(await dm(P.frank, '/config'))[0].params.text, /No chats yet/);
});

await scenario('phase 2 — the group\'s «open panel» link survives the language picker and the join screen (configuration flow is gated by forced join)', async () => {
  const c = await dm(P.dave, `/start c_${ALPHA}`);
  assert.match(sent(c)[0].params.text, /Choose your language/);
  assert.equal(row('SELECT kind FROM aegis_states WHERE user_id = ?', P.dave.id).kind, 'resume');
  davePanel = midOf(sent(c)[0]);
  await press(P.dave, 'lg:en', davePanel);
  assert.match(screenOf(P.dave, davePanel).plain, /Join our channels first/);
  join(P.dave, -1001, -1002, -1004, -1005);
  await press(P.dave, 'jc', davePanel);
  const panel = screenOf(P.dave, davePanel).plain;
  assert.match(panel, new RegExp(`⚙️ ${n('Alpha')} · group`));
  assert.match(panel, /Your access: View/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_states WHERE user_id = ?', P.dave.id).n, 0);
});

await scenario('phase 2 — the panel: level, rights, outside admins, sections; permissions screen', async () => {
  const c = await dm(P.carol, '/config');
  carolPanel = midOf(sent(c)[0]);
  await press(P.carol, `g:${ALPHA}`, carolPanel);
  const root = screenOf(P.carol, carolPanel);
  assert.match(root.plain, /Your access: Owner/);
  assert.match(root.plain, /Aegis has every permission it needs/);
  assert.match(root.plain, /Admins not appointed through Aegis: 1/);
  const s = (x) => `g:${ALPHA}:${x}`;
  assert.deepEqual(dataOf(root), [s('p'), s('a'), s('l'), s('g'), s('r'), s('h'), s('x'), 'cl']);
  await press(P.carol, s('p'), carolPanel);
  const perms = screenOf(P.carol, carolPanel).plain;
  assert.equal((perms.match(/✅/g) || []).length, 7);
  assert.match(perms, /Nothing is missing/);
});

await scenario('phase 2 — appointing an admin through Aegis: pick (shared user), rights editor, locked rights, confirm, promoteChatMember, logged', async () => {
  await press(P.carol, `g:${ALPHA}:a`, carolPanel);
  const list = screenOf(P.carol, carolPanel);
  assert.match(list.plain, new RegExp(`👑 ${n('Carol')} — owner`));
  assert.match(list.plain, new RegExp(`⚠️ ${n('Dave')} — not through Aegis · View`));
  assert.deepEqual(dataOf(list), [`g:${ALPHA}:a:i:${P.dave.id}`, `g:${ALPHA}:a:n`, `g:${ALPHA}`]);
  const ask = await press(P.carol, `g:${ALPHA}:a:n`, carolPanel);
  assert.deepEqual(sent(ask.calls)[0].params.reply_markup.keyboard[0][0].request_users, { request_id: 1, max_quantity: 1 });
  assert.equal(row('SELECT kind FROM aegis_states WHERE user_id = ?', P.carol.id).kind, 'adm_pick');
  const sel = await dm(P.carol, null, { users_shared: { request_id: 1, users: [{ user_id: P.erin.id }] } });
  const [picked, editorMsg] = sent(sel);
  assert.match(picked.params.text, new RegExp(`Selected: ${n('Erin')}`));
  assert.deepEqual(picked.params.reply_markup, { remove_keyboard: true });
  const ed = midOf(editorMsg);
  const t = (i) => `g:${ALPHA}:a:t:${P.erin.id}:${i}`;
  assert.deepEqual(labelsOf(P.carol, ed).slice(0, 7), ['▫️ Change info', '✅ Delete messages', '✅ Ban and restrict users', '✅ Invite users', '✅ Pin messages',
    '🔒 Manage video chats', '▫️ Add new admins']);
  await press(P.carol, t(6), ed);
  assert.equal(labelsOf(P.carol, ed)[6], '✅ Add new admins');
  assert.match(screenOf(P.carol, ed).plain, /lets them appoint admins themselves/);
  await press(P.carol, t(6), ed);
  const locked = await press(P.carol, t(5), ed);
  assert.ok(locked.alert);
  assert.match(locked.toast, /can't be given/);
  await press(P.carol, `g:${ALPHA}:a:s:${P.erin.id}`, ed);
  const confirm = screenOf(P.carol, ed).plain;
  assert.match(confirm, new RegExp(`Appoint ${n('Erin')} as an admin of ${n('Alpha')} with these rights\\?`));
  assert.match(confirm, /• Delete messages\n• Ban and restrict users\n• Invite users\n• Pin messages/);
  const done = await press(P.carol, `g:${ALPHA}:a:y:${P.erin.id}`, ed);
  const [promo] = sent(done.calls, 'promoteChatMember');
  assert.deepEqual(promo.params, { chat_id: ALPHA, user_id: P.erin.id, is_anonymous: false, can_change_info: false, can_delete_messages: true, can_restrict_members: true,
    can_invite_users: true, can_pin_messages: true, can_manage_video_chats: false, can_promote_members: false, can_manage_chat: true });
  assert.equal(alpha.admins.get(P.erin.id).promotedBy, BOT_ID);
  const after = screenOf(P.carol, ed).plain;
  assert.match(after, new RegExp(`${n('Erin')} is now an admin — appointed through Aegis`));
  assert.match(after, new RegExp(`✅ ${n('Erin')} — appointed through Aegis · View`));
  assert.equal(row('SELECT kind, actor_id FROM aegis_promotions WHERE chat_id = ? AND user_id = ?', ALPHA, P.erin.id).actor_id, P.carol.id);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'admin.promote' AND target = ?", String(P.erin.id)));
  assert.equal(row('SELECT via_aegis FROM aegis_chat_admins WHERE chat_id = ? AND user_id = ?', ALPHA, P.erin.id).via_aegis, 1);
  assert.equal(row('SELECT count(*) AS n FROM aegis_states WHERE user_id = ?', P.carol.id).n, 0);
});

await scenario('phase 2 — picking the member: bad input, unknown @username, hidden forward, non-member, outside admin; @username, numeric id', async () => {
  await press(P.carol, `g:${ALPHA}:a:n`, carolPanel);
  assert.match(sent(await dm(P.carol, 'hello'))[0].params.text, /Choose a user with the button/);
  assert.match(sent(await dm(P.carol, '@nobody_here'))[0].params.text, /look people up by @username/);
  assert.match(sent(await dm(P.carol, null, { forward_origin: { type: 'hidden_user', sender_user_name: 'Ghost', date: 0 } }))[0].params.text, /privacy settings hide/);
  assert.match(sent(await dm(P.carol, '800000099'))[0].params.text, /isn't a member of this chat/);
  assert.match(sent(await dm(P.carol, null, { forward_origin: { type: 'user', sender_user: P.dave, date: 0 } }))[0].params.text, /appointed outside Aegis/);
  const appoint = async (input, toggles) => {
    const m = await dm(P.carol, input);
    const [, editorMsg] = sent(m);
    assert.ok(editorMsg, `no editor for ${input}`);
    const ed = midOf(editorMsg);
    const target = Number(/:a:t:(\d+):/.exec(kb(screenOf(P.carol, ed))[0].callback_data)[1]);
    for (const i of toggles) await press(P.carol, `g:${ALPHA}:a:t:${target}:${i}`, ed);
    await press(P.carol, `g:${ALPHA}:a:s:${target}`, ed);
    await press(P.carol, `g:${ALPHA}:a:y:${target}`, ed);
    return target;
  };
  assert.equal(await appoint('@frank_u', [0, 1, 2, 3, 4, 6]), P.frank.id, 'a known @username');
  assert.deepEqual(alpha.admins.get(P.frank.id).rights, { can_manage_chat: true, can_change_info: true, can_promote_members: true });
  await press(P.carol, `g:${ALPHA}:a:n`, carolPanel);
  assert.equal(await appoint(String(P.gina.id), [2, 3, 4, 6]), P.gina.id, 'a numeric id');
  assert.deepEqual(alpha.admins.get(P.gina.id).rights, { can_manage_chat: true, can_delete_messages: true, can_promote_members: true });
});

await scenario('phase 2 — anti-escalation: locked rights are kept, equal/higher admins and the owner are out of reach, outside admins can\'t be edited', async () => {
  const fc = await dm(P.frank, '/config');
  frankPanel = midOf(sent(fc)[0]);
  assert.ok(kb(screenOf(P.frank, frankPanel)).some((b) => b.callback_data === `g:${ALPHA}` && /Full/.test(b.text)));
  await press(P.frank, `g:${ALPHA}:a`, frankPanel);
  assert.ok(dataOf(screenOf(P.frank, frankPanel)).includes(`g:${ALPHA}:a:n`), 'Full with «Add new admins» may appoint');
  await press(P.frank, `g:${ALPHA}:a:e:${P.erin.id}`, frankPanel);
  const labels = labelsOf(P.frank, frankPanel);
  assert.equal(labels[0], '▫️ Change info');
  assert.equal(labels[1], '🔒✅ Delete messages', 'Frank lacks it; Erin keeps it');
  assert.equal(labels[4], '🔒✅ Pin messages');
  assert.ok((await press(P.frank, `g:${ALPHA}:a:t:${P.erin.id}:4`, frankPanel)).alert);
  await press(P.frank, `g:${ALPHA}:a:t:${P.erin.id}:0`, frankPanel);
  await press(P.frank, `g:${ALPHA}:a:s:${P.erin.id}`, frankPanel);
  const r = await press(P.frank, `g:${ALPHA}:a:y:${P.erin.id}`, frankPanel);
  const [edit] = sent(r.calls, 'promoteChatMember');
  assert.equal(edit.params.can_change_info, true, 'given');
  assert.equal(edit.params.can_delete_messages, true, 'kept, not stripped');
  assert.equal(edit.params.can_pin_messages, true, 'kept, not stripped');
  assert.equal(edit.params.can_promote_members, false);
  assert.equal(row("SELECT kind FROM aegis_promotions WHERE user_id = ? ORDER BY id DESC LIMIT 1", P.erin.id).kind, 'edit');
  const higher = await press(P.frank, `g:${ALPHA}:a:e:${P.gina.id}`, frankPanel);
  assert.ok(higher.alert);
  assert.match(higher.toast, /equal to or higher than yours/);
  assert.match((await press(P.frank, `g:${ALPHA}:a:d:${P.carol.id}`, frankPanel)).toast, /owner can't be changed/);
  assert.match((await press(P.frank, `g:${ALPHA}:a:t:${P.gina.id}:0`, frankPanel)).toast, /expired/);
  const dn = await press(P.dave, `g:${ALPHA}:a:n`, davePanel);
  assert.ok(dn.alert);
  assert.match(dn.toast, /You need full access/);
  assert.match((await press(P.dave, `g:${ALPHA}:a:e:${P.erin.id}`, davePanel)).toast, /needs access level «Full»/);
  assert.match((await press(P.carol, `g:${ALPHA}:a:e:${P.dave.id}`, carolPanel)).toast, /appointed outside Aegis/);
  await press(P.carol, `g:${ALPHA}:a:i:${P.dave.id}`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, /To fix it:/);
});

await scenario('phase 2 — removing an Aegis admin (asks first): demoted in Telegram, cache and manual level gone, logged', async () => {
  rawDatabase().prepare('INSERT INTO aegis_access (chat_id, user_id, level, set_by, set_at) VALUES (?, ?, 2, ?, 0)').run(ALPHA, P.erin.id, P.carol.id);
  await press(P.carol, `g:${ALPHA}:a:e:${P.erin.id}`, carolPanel);
  assert.ok(dataOf(screenOf(P.carol, carolPanel)).includes(`g:${ALPHA}:a:d:${P.erin.id}`));
  await press(P.carol, `g:${ALPHA}:a:d:${P.erin.id}`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`Remove ${n('Erin')} as an admin of ${n('Alpha')}\\?`));
  assert.ok(alpha.admins.has(P.erin.id), 'nothing happens before the confirmation');
  const r = await press(P.carol, `g:${ALPHA}:a:dy:${P.erin.id}`, carolPanel);
  const [p] = sent(r.calls, 'promoteChatMember');
  assert.equal(p.params.can_manage_chat, false);
  assert.equal(p.params.can_delete_messages, false);
  assert.equal(alpha.admins.has(P.erin.id), false);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`${n('Erin')} is no longer an admin`));
  assert.equal(row('SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = ? AND user_id = ?', ALPHA, P.erin.id).n, 0);
  assert.equal(row('SELECT count(*) AS n FROM aegis_access WHERE chat_id = ? AND user_id = ?', ALPHA, P.erin.id).n, 0);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'admin.demote' AND target = ?", String(P.erin.id)));
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'access.revoked' AND target = ?", String(P.erin.id)));
});

await scenario('phase 2 — access levels: none locks out, settings may change settings only, full needs confirming, default; Full admins only below themselves', async () => {
  await press(P.carol, `g:${ALPHA}:l`, carolPanel);
  const al = screenOf(P.carol, carolPanel);
  assert.match(al.plain, new RegExp(`👑 ${n('Carol')} — Owner`));
  assert.match(al.plain, new RegExp(`• ${n('Dave')} — View \\(from Telegram rights\\)`));
  assert.match(al.plain, new RegExp(`• ${n('Frank')} — Full`));
  assert.deepEqual(dataOf(al).filter((d) => /:l:\d/.test(d)).sort(), [P.dave.id, P.frank.id, P.gina.id].map((id) => `g:${ALPHA}:l:${id}`).sort());
  const L = (id, v) => `g:${ALPHA}:l:${id}${v === undefined ? '' : `:${v}`}`;
  await press(P.carol, L(P.dave.id), carolPanel);
  assert.deepEqual(dataOf(screenOf(P.carol, carolPanel)).slice(0, 4), [L(P.dave.id, 3), L(P.dave.id, 2), L(P.dave.id, 1), L(P.dave.id, 0)]);
  await press(P.carol, L(P.dave.id, 0), carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`✅ ${n('Dave')}: None`));
  assert.match(sent(await gmsg(alphaChat, P.dave, 'config'))[0].params.text, /set to None/);
  await press(P.dave, `g:${ALPHA}`, davePanel);
  assert.match(screenOf(P.dave, davePanel).plain, /set to None/);
  await press(P.carol, L(P.dave.id, 2), carolPanel);
  await press(P.dave, `g:${ALPHA}`, davePanel);
  assert.match(screenOf(P.dave, davePanel).plain, /Your access: Settings/);
  assert.match((await press(P.dave, L(P.frank.id), davePanel)).toast, /needs access level «Full»/);
  await press(P.dave, `g:${ALPHA}:g:fa`, davePanel);
  assert.equal(row('SELECT lang FROM aegis_chats WHERE chat_id = ?', ALPHA).lang, 'fa');
  assert.match(sent(await gmsg(alphaChat, P.carol, 'config'))[0].params.text, /تنظیمات Aegis برای این چت/, 'the group now hears Persian');
  await press(P.carol, `g:${ALPHA}:g:en`, carolPanel);
  await press(P.carol, L(P.dave.id, 3), carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`Give ${n('Dave')} Full access\\?`));
  assert.equal(row('SELECT level FROM aegis_access WHERE chat_id = ? AND user_id = ?', ALPHA, P.dave.id).level, 2, 'not before confirming');
  await press(P.carol, L(P.dave.id, '3y'), carolPanel);
  assert.equal(row('SELECT level FROM aegis_access WHERE chat_id = ? AND user_id = ?', ALPHA, P.dave.id).level, 3);
  await press(P.carol, L(P.dave.id, 'd'), carolPanel);
  assert.equal(row('SELECT count(*) AS n FROM aegis_access WHERE chat_id = ? AND user_id = ?', ALPHA, P.dave.id).n, 0);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`✅ ${n('Dave')}: View`));
  await press(P.frank, `g:${ALPHA}:l`, frankPanel);
  assert.deepEqual(dataOf(screenOf(P.frank, frankPanel)).filter((d) => /:l:\d/.test(d)), [L(P.dave.id)]);
  await press(P.frank, L(P.dave.id), frankPanel);
  assert.deepEqual(dataOf(screenOf(P.frank, frankPanel)).filter((d) => /:l:\d+:/.test(d)), [L(P.dave.id, 2), L(P.dave.id, 1), L(P.dave.id, 0)]);
  assert.match((await press(P.frank, L(P.dave.id, 3), frankPanel)).toast, /only the owner can give Full/);
  assert.match((await press(P.frank, L(P.gina.id, 1), frankPanel)).toast, /equal to or higher than yours/);
  assert.ok(rows("SELECT * FROM aegis_audit WHERE action = 'access.set' AND chat_id = ?", ALPHA).length >= 4);
});

await scenario('phase 2 — former admins lose access at once: a chat_member demotion, and a silent one caught by the live re-check', async () => {
  rawDatabase().prepare('INSERT INTO aegis_access (chat_id, user_id, level, set_by, set_at) VALUES (?, ?, 2, ?, 0)').run(ALPHA, P.dave.id, P.carol.id);
  alpha.admins.delete(P.dave.id);
  alpha.members.add(P.dave.id);
  const c = await adminChange(alphaChat, P.carol, P.dave, { status: 'administrator', can_be_edited: false, can_delete_messages: true }, { status: 'member' });
  assert.equal(sent(c).length, 0);
  assert.equal(row('SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = ? AND user_id = ?', ALPHA, P.dave.id).n, 0);
  assert.equal(row('SELECT count(*) AS n FROM aegis_access WHERE chat_id = ? AND user_id = ?', ALPHA, P.dave.id).n, 0);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'access.revoked' AND target = ?", String(P.dave.id)));
  assert.equal(row("SELECT actor_id FROM aegis_audit WHERE action = 'admin.outside' AND target = ?", String(P.dave.id)).actor_id, P.carol.id);
  await press(P.dave, `g:${ALPHA}`, davePanel);
  assert.match(screenOf(P.dave, davePanel).plain, new RegExp(`not an admin of ${n('Alpha')}`));
  assert.equal(sent(await gmsg(alphaChat, P.dave, 'config')).length, 0, 'no longer answered in the group either');
  alpha.admins.delete(P.frank.id);
  alpha.members.add(P.frank.id);
  await press(P.frank, `g:${ALPHA}`, frankPanel);
  assert.match(screenOf(P.frank, frankPanel).plain, /not an admin/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = ? AND user_id = ?', ALPHA, P.frank.id).n, 0);
  assert.match(sent(await dm(P.frank, '/config'))[0].params.text, /No chats yet/);
});

await scenario('phase 2 — reminders about admins appointed outside Aegis: right after one appears (gap 10 min), daily on activity, switchable', async () => {
  tick(601);
  alpha.admins.set(P.hank.id, { status: 'administrator', user: P.hank, rights: { can_delete_messages: true }, promotedBy: P.carol.id });
  const c = await adminChange(alphaChat, P.carol, P.hank, { status: 'member' }, { status: 'administrator', can_be_edited: false, can_delete_messages: true });
  const [rem] = toChat(c, ALPHA);
  assert.ok(rem, 'a reminder right away');
  assert.match(rem.params.text, /Admins not appointed through Aegis \(1\)/);
  assert.match(rem.params.text, new RegExp(n('Hank')));
  assert.equal(rem.params.reply_markup.inline_keyboard[0][0].url, `https://t.me/aegis_test_bot?start=c_${ALPHA}`);
  alpha.admins.set(P.erin.id, { status: 'administrator', user: P.erin, rights: { can_delete_messages: true }, promotedBy: P.carol.id });
  const c2 = await adminChange(alphaChat, P.carol, P.erin, { status: 'member' }, { status: 'administrator', can_be_edited: false, can_delete_messages: true });
  assert.equal(toChat(c2, ALPHA).length, 0, 'not again within 10 minutes');
  await press(P.carol, `g:${ALPHA}:r`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, /Reminders are off/);
  tick(25 * 3600);
  assert.equal(toChat(await gmsg(alphaChat, P.gina, 'hi'), ALPHA).length, 0, 'off: nothing');
  await press(P.carol, `g:${ALPHA}:r`, carolPanel);
  const act = await gmsg(alphaChat, P.gina, 'hi again');
  assert.equal(toChat(act, ALPHA).length, 1, 'the daily reminder rides on activity');
  assert.match(toChat(act, ALPHA)[0].params.text, /Admins not appointed through Aegis \(2\)/);
  assert.equal(toChat(await gmsg(alphaChat, P.gina, 'and again'), ALPHA).length, 0, 'once a day');
  await press(P.carol, `g:${ALPHA}`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, /Admins not appointed through Aegis: 2/, 'the panel always shows them');
});

await scenario('phase 2 — change log of the chat; re-check finds a right the bot lost', async () => {
  await press(P.carol, `g:${ALPHA}:h`, carolPanel);
  const log = screenOf(P.carol, carolPanel).plain;
  assert.match(log, new RegExp(`Change log of ${n('Alpha')}`));
  assert.match(log, new RegExp(`${n('Carol')}: turned reminders ON`));
  assert.match(log, new RegExp(`${n('Carol')}: changed ${n('Hank')}'s admin status outside Aegis`));
  assert.match(log, new RegExp(`Aegis: ${n('Frank')} lost access \\(no longer an admin\\)`));
  assert.ok(log.split('\n').filter((l) => l.startsWith('• ')).length <= 12);
  delete alpha.botRights.can_pin_messages;
  await press(P.carol, `g:${ALPHA}:x`, carolPanel);
  const root = screenOf(P.carol, carolPanel).plain;
  assert.match(root, /Admins and permissions re-checked/);
  assert.match(root, /Aegis is missing: Pin messages/);
  alpha.botRights.can_pin_messages = true;
  await press(P.carol, `g:${ALPHA}:p:r`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, /Nothing is missing/);
});

await scenario('phase 2 — a channel\'s panel offers channel rights; a basic group can\'t appoint; a migration carries admins and levels', async () => {
  news.members.add(P.hank.id);
  news.people.set(P.hank.id, P.hank);
  await press(P.carol, `g:${NEWS}`, carolPanel);
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`⚙️ ${n('News')} · channel`));
  await press(P.carol, `g:${NEWS}:a:n`, carolPanel);
  const sel = await dm(P.carol, String(P.hank.id));
  const ed = midOf(sent(sel)[1]);
  assert.deepEqual(labelsOf(P.carol, ed).slice(0, 8), ['▫️ Change info', '✅ Post messages', '✅ Edit others\' messages', '✅ Delete messages', '✅ Invite users',
    '▫️ Ban and restrict users', '🔒 Manage video chats', '▫️ Add new admins']);
  assert.match(sent(await dm(P.carol, '/cancel'))[0].params.text, /Cancelled/);
  const c = await dm(U.ali, '/config');
  const aliPanel = midOf(sent(c)[0]);
  assert.ok(kb(screenOf(U.ali, aliPanel)).some((b) => b.callback_data === 'g:-4002'));
  await press(U.ali, 'g:-4002:a', aliPanel);
  const basicAdmins = screenOf(U.ali, aliPanel);
  assert.ok(!dataOf(basicAdmins).includes('g:-4002:a:n'), 'no appoint button in a basic group');
  assert.match(basicAdmins.plain, /تلگرام اجازه نمی‌دهد ربات ادمین منصوب کند/);
  const nb = await press(U.ali, 'g:-4002:a:n', aliPanel);
  assert.ok(nb.alert);
  rawDatabase().prepare("INSERT INTO aegis_chat_admins (chat_id, user_id, status, via_aegis, is_bot, rights, updated_at) VALUES (-4002, 800000020, 'administrator', 0, 0, '{}', 0)").run();
  rawDatabase().prepare('INSERT INTO aegis_access (chat_id, user_id, level, set_by, set_at) VALUES (-4002, 800000020, 2, 0, 0)').run();
  await gmsg({ id: -4002, type: 'group', title: 'Basic' }, U.ali, null, { migrate_to_chat_id: -1004002 });
  assert.equal(row('SELECT type FROM aegis_chats WHERE chat_id = -1004002').type, 'supergroup');
  assert.equal(row('SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = -1004002').n, 2);
  assert.equal(row('SELECT level FROM aegis_access WHERE chat_id = -1004002 AND user_id = 800000020').level, 2);
  assert.equal(row('SELECT count(*) AS n FROM aegis_chat_admins WHERE chat_id = -4002').n, 0);
});

await scenario('phase 2 — owner: /status; /shutdown asks, then only the owner is served (membership still recorded quietly); /activate', async () => {
  assert.ok(mock.state.commands.some((c) => c.scope.type === 'chat' && c.scope.chat_id === OWNER_ID && c.commands.some((x) => x.command === 'shutdown')));
  const st = await dm(U.owner, '/status');
  const s = sent(st)[0].params.text;
  assert.match(s, /وضعیت Aegis/);
  assert.match(s, /✅ فعال/);
  assert.match(s, /نسخه‌ی 0\.2\.0 · فاز ۲ · داده ۲/);
  assert.match(s, /وبهوک: ۰ آپدیت در انتظار/);
  assert.equal(sent(st, 'getWebhookInfo').length, 1);
  for (const w of ['/status', 'وضعیت', '/shutdown', 'خاموش', '/activate']) assert.doesNotMatch(sent(await dm(U.ali, w))[0].params.text, /وضعیت Aegis|خاموش شود/, w);
  const ask = await dm(U.owner, 'خاموش');
  const askMsg = sent(ask)[0];
  assert.match(askMsg.params.text, /Aegis خاموش شود؟/);
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'shutdown'").value, '0', 'not before confirming');
  await press(U.owner, 'sy:offy', midOf(askMsg));
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'shutdown'").value, '1');
  assert.match(screenOf(U.owner, midOf(askMsg)).plain, /Aegis خاموش شد/);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'system.shutdown'"));
  assert.equal(sent(await dm(U.ali, '/start')).length, 0, 'private messages: no answer');
  const cb = await press(U.ali, 'hp', lastBotMessage(U.ali.id).message_id);
  assert.ok(cb.alert);
  assert.match(cb.toast, /موقتاً متوقف/);
  assert.equal(sent(await gmsg(alphaChat, P.carol, 'config')).length, 0, 'groups: nothing');
  const quietRights = { can_manage_chat: true, can_delete_messages: true };
  mock.addChat({ id: -1009200, type: 'supergroup', title: 'Quiet', botRights: quietRights });
  const q = await botChange({ id: -1009200, type: 'supergroup', title: 'Quiet' }, P.carol, 'left', 'administrator', quietRights);
  assert.equal(sent(q).length, 0, 'added while shut down: recorded, nothing sent');
  assert.equal(row('SELECT registered FROM aegis_chats WHERE chat_id = -1009200').registered, 1);
  assert.match(sent(await dm(U.owner, '/panel'))[0].params.text, /Aegis خاموش است/);
  const on = await dm(U.owner, 'فعال‌سازی');
  assert.match(sent(on)[0].params.text, /Aegis دوباره فعال است/);
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'shutdown'").value, '0');
  assert.ok(sent(await dm(U.ali, '/start')).length >= 1, 'answering again');
  assert.match(sent(await dm(U.owner, '/activate'))[0].params.text, /از قبل فعال است/);
});

await scenario('after a deploy with new command menus, they are sent on the next private message (the retry throttle is per revision)', async () => {
  rawDatabase().prepare("UPDATE aegis_kv SET value = '1' WHERE key = 'cmd_rev'").run();
  rawDatabase().prepare("INSERT INTO aegis_kv (key, value) VALUES ('cmd_try_1', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Math.floor(clock / 1000)));
  rawDatabase().prepare("DELETE FROM aegis_kv WHERE key = 'cmd_try_2'").run();
  const c = await dm(U.ali, '/help');
  assert.equal(sent(c, 'setMyCommands').length, 6);
  assert.equal(sent(c, 'setMyDefaultAdministratorRights').length, 2);
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'cmd_rev'").value, '2');
  assert.equal(sent(await dm(U.ali, '/help'), 'setMyCommands').length, 0, 'once');
});

await scenario('every language renders the main screens; no unexpected console errors', async () => {
  for (const [u, lang, re] of [[U.dan, 'en', /Hello ⁨Dan &lt;b&gt;⁩!/], [U.li, 'zh', /你好/], [U.ivan, 'ru', /Здравствуйте/]]) {
    if (u === U.ivan) await member({ id: u.id, type: 'private' }, u, 'kicked', 'member');
    const c = await dm(u, '/start');
    await press(u, `lg:${lang}`, midOf(sent(c)[0]));
    join(u, -1001, -1002, -1004, -1005);
    const s = sent(await dm(u, '/start'))[0];
    assert.match(s.params.text, re, lang);
    assert.match(sent(await dm(u, '/help'))[0].params.text, /\/language/);
  }
  assert.deepEqual(errors, []);
});

await mock.close();
const passed = outcome.filter(Boolean).length;
console.log(`\n${passed}/${outcome.length} scenarios passed`);
if (passed !== outcome.length) process.exit(1);
