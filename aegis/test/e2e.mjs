// End-to-end tests of Phases 1-6: the real handlers and the Mini App endpoint (tgcloud/) against a local
// emulation of the platform's sdk (test/sdk/: SQLite via node:sqlite) and a strict mock Bot API
// (test/mock-telegram.mjs). Web/Node globals the isolate lacks are removed first, the clock is fake.
// Every Persian message is checked for right-to-left marks; every button press must be answered once.
// Run: npm run test:e2e
import assert from 'node:assert/strict';
import { createMockTelegram, parseHtml } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { BC_BATCH, BC_CHUNK, JOIN_CACHE_SEC, MAX_JOIN_CHANNELS, OWNER_ID, PHASE, VERSION } from '../tgcloud/lib/config.js';
import { LATEST } from '../tgcloud/lib/core/migrations.js';
import { num } from '../tgcloud/lib/i18n/index.js';
import { fmtTime, localMinutes, TZ_OFFSETS } from '../tgcloud/lib/core/clock.js';

const BOT_ID = 7200000001;
const RLM = '\u200F';
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
for (const h of ['message', 'edited_message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request']) H[h] = (await import(`../tgcloud/handlers/${h}.js`)).default;
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
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'data_version'").value, String(LATEST));
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
  assert.match(screen.plain, /اول عضو کانال\u200Cهای ما شوید/);
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
  assert.match(welcome.plain, /سلام \u2068علی\u2069!/);
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
  assert.match(panel.params.text, /گروه\u200Cها: <b>۲<\/b> · 📢 کانال\u200Cها: <b>۱<\/b>/);
  const r = await press(U.owner, 'os', midOf(panel));
  const s = mock.get(OWNER_ID, midOf(panel)).plain;
  // started: ali, owner, bea, ivan, li = 5; blocked: ivan; active: 4; new today: 4 (bea is 3 days old); 7 days: 5
  assert.match(s, /استارت کرده\u200Cاند: ۵/);
  assert.match(s, /فعال \(پیام دریافت می\u200Cکنند\): ۴/);
  assert.match(s, /بلاک کرده\u200Cاند: ۱/);
  assert.match(s, /امروز ۴ · ۷ روز اخیر ۵/);
  assert.match(s, /گروه\u200Cها: ۲ · 📢 کانال\u200Cها: ۱/);
  assert.match(s, /مجموع اعضای این چت\u200Cها: ۱۱۶۲/);
  assert.equal(sent(r.calls, 'getChatMemberCount').length, 0, 'counts are fresh');
  tick(3601);
  mock.state.chats.get(-2001).count = 200;
  const r2 = await press(U.owner, 'os', midOf(panel));
  assert.equal(sent(r2.calls, 'getChatMemberCount').length, 3, 'stale counts are refreshed');
  assert.match(mock.get(OWNER_ID, midOf(panel)).plain, /اعضای این چت\u200Cها: ۱۲۱۲/);
});

// ---------- forced-join management ----------

let joinPanel = null;
await scenario('forced-join screen: ✅ / ⚠\uFE0F per channel, a warning when the bot is not an admin, reorder / remove / add / on-off buttons', async () => {
  const c = await dm(U.owner, '/panel');
  joinPanel = midOf(sent(c)[0]);
  const r = await press(U.owner, 'oj', joinPanel);
  assert.ok(sent(r.calls, 'getChat').length >= 3, 'admin rights refreshed');
  const m = mock.get(OWNER_ID, joinPanel);
  assert.match(m.plain, /عضویت اجباری — روشن/);
  assert.match(m.plain, /کانال\u200Cها: ۳\/۱۰/);
  assert.match(m.plain, /Aegis در ۱ کانالِ علامت\u200Cخورده با ⚠\uFE0F ادمین نیست/);
  assert.match(m.plain, /۳\. ⚠\uFE0F \u2068Wanger Bots\u2069 — @wangerBots \(ربات ادمین نیست\)/);
  assert.match(m.plain, /۱\. ✅ \u2068Hide i Seek\u2069/);
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
  assert.match(sent(c)[0].params.text, /\u2068New Chan\u2069 اضافه شد/);
  c = await add({ text: null, extra: { forward_origin: { type: 'channel', chat: { id: -1005, type: 'channel', title: 'Private One' }, message_id: 7, date: 0 } } });
  assert.equal(sent(c, 'exportChatInviteLink').length, 1);
  assert.equal(row('SELECT invite_link FROM aegis_join_channels WHERE chat_id = -1005').invite_link, 'https://t.me/+inv1005');
  c = await add({ text: 'https://t.me/noadmin' });
  assert.match(sent(c)[0].params.text, /Aegis آن\u200Cجا ادمین نیست/);
  c = await add({ text: 'hello' });
  assert.match(sent(c)[0].params.text, /این یک کانال نیست/);
  c = await dm(U.owner, '-1009999999');
  assert.match(sent(c)[0].params.text, /تلگرام این چت را پیدا نمی\u200Cکند/, 'unknown id');
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
  assert.deepEqual(kb(aud).map((b) => b.text), [`${RLM}👤 کاربران ربات (۴۳)`, `${RLM}👥 همه\u200Cی گروه\u200Cها (۲)`, `${RLM}📢 همه\u200Cی کانال\u200Cها (۱)`, `${RLM}⬅\uFE0F بازگشت`]);
  await press(U.owner, 'ob:a:u', bcPanel);
  assert.match(mock.get(OWNER_ID, bcPanel).plain, /کپی — به\u200Cعنوان پیام خود Aegis/);
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
  assert.match(card.params.text, /کاربران ربات<\/b> — ۴۳ دریافت\u200Cکننده/);
  assert.match(card.params.text, /محتوا: عکس/);
  assert.deepEqual(card.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), [`bc:go:${bcId}`, `bc:bt:${bcId}`, `bc:no:${bcId}`]);
  await press(U.owner, `bc:bt:${bcId}`, midOf(card));
  const bad = await dm(U.owner, 'Site https://example.com');
  assert.match(sent(bad)[0].params.text, /خط ۱ به شکل/);
  const good = await dm(U.owner, 'Site - https://example.com | کانال - t.me/HIDE_i_SEEK');
  assert.deepEqual(sent(good, 'copyMessage')[0].params.reply_markup.inline_keyboard, [[{ text: 'Site', url: 'https://example.com' }, { text: 'کانال', url: 'https://t.me/HIDE_i_SEEK' }]]);
  assert.match(sent(good)[0].params.text, /دکمه\u200Cهای لینک: ۲/);
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
  assert.match(panel, /ارسال\u200Cشده: ۱۰ · ❌ ناموفق: ۰ · ⛔\uFE0F بلاک\u200Cکرده: ۳/);
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
  assert.match(reports[0].params.text, /ارسال\u200Cشده: <b>۴۰<\/b>/);
  assert.match(reports[0].params.text, /بلاک یا حذف کرده\u200Cاند: <b>۳<\/b>/);
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
  assert.match(mock.get(OWNER_ID, fwd.card).plain, /به پیام فورواردی نمی\u200Cشود دکمه اضافه کرد/);
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
  assert.match(sent(r.calls).find((x) => /لغو شد<\/b>/.test(x.params.text)).params.text, /ارسال\u200Cشده: <b>/);
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
  const id = msgId++;
  mock.userMessage(chat.id, id, { text, plain: text, from: from || extra.sender_chat || { id: 0 } });
  return run(H.message, { message_id: id, from, chat, date: 0, ...(text !== null ? { text } : {}), ...extra });
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
  assert.match(panel, new RegExp(`⚙\uFE0F ${n('Alpha')} · group`));
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
  assert.deepEqual(dataOf(root), [s('K'), s('S'), s('L'), s('P'), s('W'), s('B'), s('F'), s('U'), s('V'), s('T'), s('O'), s('p'), s('a'), s('l'), s('g'), s('r'), s('h'), s('x'), 'cl']);
  await press(P.carol, s('p'), carolPanel);
  const perms = screenOf(P.carol, carolPanel).plain;
  assert.equal((perms.match(/✅/g) || []).length, 7);
  assert.match(perms, /Nothing is missing/);
});

await scenario('phase 2 — appointing an admin through Aegis: pick (shared user), rights editor, locked rights, confirm, promoteChatMember, logged', async () => {
  await press(P.carol, `g:${ALPHA}:a`, carolPanel);
  const list = screenOf(P.carol, carolPanel);
  assert.match(list.plain, new RegExp(`👑 ${n('Carol')} — owner`));
  assert.match(list.plain, new RegExp(`⚠\uFE0F ${n('Dave')} — not through Aegis · View`));
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
  assert.deepEqual(labelsOf(P.carol, ed).slice(0, 7), ['▫\uFE0F Change info', '✅ Delete messages', '✅ Ban and restrict users', '✅ Invite users', '✅ Pin messages',
    '🔒 Manage video chats', '▫\uFE0F Add new admins']);
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
  assert.equal(labels[0], '▫\uFE0F Change info');
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
  assert.match(screenOf(P.carol, carolPanel).plain, new RegExp(`⚙\uFE0F ${n('News')} · channel`));
  await press(P.carol, `g:${NEWS}:a:n`, carolPanel);
  const sel = await dm(P.carol, String(P.hank.id));
  const ed = midOf(sent(sel)[1]);
  assert.deepEqual(labelsOf(P.carol, ed).slice(0, 8), ['▫\uFE0F Change info', '✅ Post messages', '✅ Edit others\' messages', '✅ Delete messages', '✅ Invite users',
    '▫\uFE0F Ban and restrict users', '🔒 Manage video chats', '▫\uFE0F Add new admins']);
  assert.match(sent(await dm(P.carol, '/cancel'))[0].params.text, /Cancelled/);
  const c = await dm(U.ali, '/config');
  const aliPanel = midOf(sent(c)[0]);
  assert.ok(kb(screenOf(U.ali, aliPanel)).some((b) => b.callback_data === 'g:-4002'));
  await press(U.ali, 'g:-4002:a', aliPanel);
  const basicAdmins = screenOf(U.ali, aliPanel);
  assert.ok(!dataOf(basicAdmins).includes('g:-4002:a:n'), 'no appoint button in a basic group');
  assert.match(basicAdmins.plain, /تلگرام اجازه نمی\u200Cدهد ربات ادمین منصوب کند/);
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
  assert.ok(s.includes(`نسخه\u200Cی ${VERSION} · فاز ${num('fa', PHASE)} · داده ${num('fa', LATEST)}`), s);
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
  const on = await dm(U.owner, 'فعال\u200Cسازی');
  assert.match(sent(on)[0].params.text, /Aegis دوباره فعال است/);
  assert.equal(row("SELECT value FROM aegis_kv WHERE key = 'shutdown'").value, '0');
  assert.ok(sent(await dm(U.ali, '/start')).length >= 1, 'answering again');
  assert.match(sent(await dm(U.owner, '/activate'))[0].params.text, /از قبل فعال است/);
});

// ---------- phase 3: lists, punishments, warnings, anti-betrayal, Audit Mode, logs ----------

const Q = {};
for (const [i, name] of ['Olga', 'Abe', 'Ben', 'Mia', 'Max', 'Noa', 'Zed', 'Rex', 'Kai', 'Tom', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6'].entries()) {
  Q[name.toLowerCase()] = { id: 800000020 + i, is_bot: false, first_name: name, language_code: 'en', username: `${name.toLowerCase()}_q` };
}
const BETA = -1009200;
const LOGS = -1009300;
const OTHER = -1009301;
const betaChat = { id: BETA, type: 'supergroup', title: 'Beta' };
let beta = null;
let olgaPanel = null;
const nowS = () => Math.floor(clock / 1000);
const reply = (u, text = 'hi') => ({ reply_to_message: { message_id: 1, from: u, chat: betaChat, date: 0, text } });
const lastPun = () => row('SELECT * FROM aegis_punishments ORDER BY id DESC LIMIT 1');
async function gpress(u, chatId, data, mid) {
  const calls = await run(H.callback_query, { id: `cb${seq++}`, from: u, chat_instance: 'x', data, message: mock.messageObject(chatId, mid) });
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.length, 1, `answered ${answers.length} times: ${data}`);
  return { calls, toast: answers[0].params.text || '', alert: !!answers[0].params.show_alert };
}
const B = (x) => `g:${BETA}:${x}`;
const olgaScreen = () => screenOf(Q.olga, olgaPanel);
async function olga(data) {
  return press(Q.olga, data, olgaPanel);
}
async function olgaSays(text, extra = {}) {
  return dm(Q.olga, text, extra);
}

await scenario('phase 3 — /ban as a reply, with a duration and a reason: banned in Telegram, notice with undo, banned list, executor and reason recorded', async () => {
  tick(120);
  await onboard(Q.olga, 'en');
  await onboard(Q.abe, 'en');
  beta = mock.addChat({ id: BETA, type: 'supergroup', title: 'Beta', count: 30, botRights: { can_manage_chat: true, can_change_info: true, can_delete_messages: true,
    can_restrict_members: true, can_invite_users: true, can_pin_messages: true, can_promote_members: true } });
  beta.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  beta.admins.set(Q.abe.id, { status: 'administrator', user: Q.abe, rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }, promotedBy: Q.olga.id });
  beta.admins.set(Q.ben.id, { status: 'administrator', user: Q.ben, rights: { can_manage_chat: true, can_delete_messages: true }, promotedBy: Q.olga.id });
  beta.admins.set(Q.tom.id, { status: 'administrator', user: Q.tom, rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }, promotedBy: BOT_ID });
  for (const u of ['mia', 'max', 'noa', 'zed', 'rex', 'kai', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6']) {
    beta.members.add(Q[u].id);
    beta.people.set(Q[u].id, Q[u]);
  }
  await botChange(betaChat, Q.olga, 'left', 'administrator', beta.botRights);
  rawDatabase().prepare('UPDATE aegis_chats SET reminder = 0 WHERE chat_id = ?').run(BETA);
  const c = await gmsg(betaChat, Q.abe, '/ban 1d spam links', reply(Q.mia, 'buy now'));
  const ban = sent(c, 'banChatMember')[0];
  assert.ok(ban, 'banned in Telegram');
  assert.deepEqual([ban.params.user_id, ban.params.until_date], [Q.mia.id, nowS() + 86400]);
  const [notice] = toChat(c, BETA);
  assert.match(notice.params.text, new RegExp(`⛔\uFE0F <b>Ban</b>: ${n('Mia')}`));
  assert.match(notice.params.text, new RegExp(`👮 By: ${n('Abe')}`));
  assert.match(notice.params.text, /⏱ Duration: 1 d/);
  assert.match(notice.params.text, /📝 Reason: \u2068spam links\u2069/);
  const p = lastPun();
  assert.deepEqual([p.kind, p.user_id, p.actor_id, p.source, p.status, p.reason, p.notice_msg], ['ban', Q.mia.id, Q.abe.id, 'command', 'active', 'spam links', midOf(notice)]);
  assert.equal(notice.params.reply_markup.inline_keyboard[0][0].callback_data, `pu:${p.id}`);
  assert.equal(row("SELECT value FROM aegis_list_entries WHERE chat_id = ? AND list = 'ban' AND ekey = ?", BETA, String(Q.mia.id)).value, 'Mia');
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'punish.ban' AND actor_id = ? AND target = ?", Q.abe.id, String(Q.mia.id)));
  assert.equal(row('SELECT count(*) AS n FROM aegis_admin_actions WHERE actor_id = ?', Q.abe.id).n, 1, 'counted for anti-betrayal, for the person');

  const denied = await gpress(Q.max, BETA, `pu:${p.id}`, midOf(notice));
  assert.equal(denied.alert, true);
  assert.match(denied.toast, /Only the creator and admins/);
  assert.equal(sent(denied.calls, 'unbanChatMember').length, 0);
  const undo = await gpress(Q.abe, BETA, `pu:${p.id}`, midOf(notice));
  assert.equal(undo.toast, '↩\uFE0F Undone.');
  assert.equal(sent(undo.calls, 'unbanChatMember')[0].params.user_id, Q.mia.id);
  assert.equal(sent(undo.calls, 'editMessageReplyMarkup').length, 1, 'the undo button goes away');
  assert.match(toChat(undo.calls, BETA)[0].params.text, new RegExp(`↩\uFE0F Ban of ${n('Mia')} undone by ${n('Abe')}`));
  assert.equal(row('SELECT status FROM aegis_punishments WHERE id = ?', p.id).status, 'undone');
  assert.equal(row("SELECT count(*) AS n FROM aegis_list_entries WHERE chat_id = ? AND list = 'ban'", BETA).n, 0);
  const again = await gpress(Q.abe, BETA, `pu:${p.id}`, midOf(notice));
  assert.match(again.toast, /Already lifted/);
});

await scenario('phase 3 — who may moderate: ordinary members ignored, plain words need a target, «ban users» right, admins and VIPs protected, Persian words', async () => {
  const quiet = await gmsg(betaChat, Q.max, '/ban', reply(Q.mia));
  assert.equal(sent(quiet).length, 0, 'an ordinary member is never answered');
  const chat = await gmsg(betaChat, Q.abe, 'بن');
  assert.equal(chat.length, 0, 'a plain word without a target is ordinary chat: not even a status check');
  const usage = await gmsg(betaChat, Q.abe, '/mute');
  assert.match(toChat(usage, BETA)[0].params.text, /Usage: reply to the member's message with \/mute/);
  const noRight = await gmsg(betaChat, Q.ben, '/mute 1h', reply(Q.mia));
  assert.match(toChat(noRight, BETA)[0].params.text, /You need Telegram's «Ban users» right/);
  assert.equal(sent(noRight, 'restrictChatMember').length, 0);
  const benWarn = await gmsg(betaChat, Q.ben, '/warn rude', reply(Q.mia));
  assert.match(toChat(benWarn, BETA)[0].params.text, /⚠\uFE0F <b>Warning<\/b>/, 'any admin may warn');
  const admin = await gmsg(betaChat, Q.abe, '/ban', reply(Q.ben));
  assert.match(toChat(admin, BETA)[0].params.text, new RegExp(`${n('Ben')} is an admin`));
  const self = await gmsg(betaChat, Q.abe, '/mute', reply(Q.abe));
  assert.match(toChat(self, BETA)[0].params.text, /not on yourself|can't use this on yourself/);
  const bot = await gmsg(betaChat, Q.abe, '/ban', reply(mock.bot));
  assert.match(toChat(bot, BETA)[0].params.text, /I won't punish myself/);
  const unknown = await gmsg(betaChat, Q.abe, '/ban @nobody_here');
  assert.match(toChat(unknown, BETA)[0].params.text, /I don't know/);
  const badDur = await gmsg(betaChat, Q.abe, '/mute 900d', reply(Q.mia));
  assert.match(toChat(badDur, BETA)[0].params.text, /That duration isn't valid/);
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, user_id, added_by, added_at, updated_by, updated_at) VALUES (?, 'vip', ?, 'Noa', ?, ?, ?, ?, ?)")
    .run(BETA, String(Q.noa.id), Q.noa.id, Q.olga.id, nowS(), Q.olga.id, nowS());
  const vip = await gmsg(betaChat, Q.abe, '/ban', reply(Q.noa));
  assert.match(toChat(vip, BETA)[0].params.text, new RegExp(`⭐ ${n('Noa')} is on the VIP list`));
  assert.equal(sent(vip, 'banChatMember').length, 0);
  const fa = await gmsg(betaChat, Q.abe, 'سکوت ۲ ساعت فلود', reply(Q.mia));
  const r = sent(fa, 'restrictChatMember')[0];
  assert.equal(r.params.until_date, nowS() + 7200);
  assert.equal(r.params.permissions.can_send_messages, false);
  assert.match(toChat(fa, BETA)[0].params.text, /🔇 <b>Mute<\/b>/);
  assert.match(toChat(fa, BETA)[0].params.text, /Reason: \u2068فلود\u2069/);
  const byName = await gmsg(betaChat, Q.abe, `/unmute @${Q.mia.username}`);
  assert.equal(toChat(byName, BETA).length, 1);
  await dm(Q.mia, '/start');
  const byUsername = await gmsg(betaChat, Q.abe, `رفع سکوت @${Q.mia.username}`);
  assert.equal(sent(byUsername, 'restrictChatMember')[0].params.permissions.can_send_messages, true, 'lifted by a known @username');
  assert.match(toChat(byUsername, BETA)[0].params.text, new RegExp(`🔊 ${n('Mia')} can talk again`));
  const tm = await gmsg(betaChat, Q.abe, '/kick Max flooding', { entities: [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'text_mention', offset: 6, length: 3, user: Q.max }] });
  assert.deepEqual(sent(tm, 'banChatMember').map((x) => x.params.user_id), [Q.max.id]);
  assert.deepEqual(sent(tm, 'unbanChatMember').map((x) => x.params.only_if_banned), [true], 'a kick is a ban and an unban');
  assert.equal(lastPun().reason, 'flooding');
  assert.equal(lastPun().status, 'done');
  assert.equal(toChat(tm, BETA)[0].params.reply_markup, undefined, 'a kick has no undo');
  beta.members.add(Q.max.id);
  const anon = await gmsg(betaChat, undefined, '/ban', { ...reply(Q.mia), sender_chat: betaChat });
  assert.match(toChat(anon, BETA)[0].params.text, /posting anonymously/);
  const basic = mock.addChat({ id: -4100, type: 'group', title: 'Basic2', botRights: { can_restrict_members: true, can_delete_messages: true } });
  basic.admins.set(Q.abe.id, { status: 'creator', user: Q.abe });
  basic.members.add(Q.mia.id);
  const basicChat = { id: -4100, type: 'group', title: 'Basic2' };
  await botChange(basicChat, Q.abe, 'left', 'administrator', basic.botRights);
  const bm = await gmsg(basicChat, Q.abe, '/mute', { reply_to_message: { message_id: 1, from: Q.mia, chat: basicChat, date: 0 } });
  assert.match(toChat(bm, -4100)[0].params.text, /only in supergroups/);
  tick(120);
});

await scenario('phase 3 — warnings and steps: 3 → mute 1 d, /unwarn, 5 → ban and the warnings are cleared; /warns; undo buttons for both', async () => {
  const warn = (text = '/warn') => gmsg(betaChat, Q.abe, text, reply(Q.zed));
  await warn('/warn one');
  const two = await warn('اخطار دو');
  assert.match(toChat(two, BETA)[0].params.text, /⚠\uFE0F Warnings: 2 of 5/);
  const three = await warn('/warn three');
  const [nt] = toChat(three, BETA);
  assert.match(nt.params.text, /⚠\uFE0F Warnings: 3 of 5/);
  assert.match(nt.params.text, /🪜 Step reached: 🔇 Mute \(1 d\)/);
  const r = sent(three, 'restrictChatMember')[0];
  assert.equal(r.params.until_date, nowS() + 86400);
  const step = lastPun();
  assert.deepEqual([step.kind, step.source, step.actor_id], ['mute', 'step', 0]);
  assert.deepEqual(nt.params.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`pu:${step.id - 1}`, `pu:${step.id}`]);
  const un = await gmsg(betaChat, Q.abe, '/unwarn', reply(Q.zed));
  assert.match(toChat(un, BETA)[0].params.text, /Warnings now: 2/);
  await warn();
  await warn();
  const five = await warn('/warn five');
  assert.ok(sent(five, 'banChatMember').some((x) => x.params.user_id === Q.zed.id), 'the last step bans');
  assert.match(toChat(five, BETA)[0].params.text, /Step reached: ⛔\uFE0F Ban \(until lifted\)/);
  assert.equal(row("SELECT count(*) AS n FROM aegis_punishments WHERE chat_id = ? AND user_id = ? AND kind = 'warn' AND status = 'active'", BETA, Q.zed.id).n, 0,
    'cleared after the last step');
  const ws = await gmsg(betaChat, Q.abe, '/warns', reply(Q.zed));
  assert.match(toChat(ws, BETA)[0].params.text, new RegExp(`${n('Zed')}: 0 of 5 warnings`));
  assert.equal(row('SELECT count(*) AS n FROM aegis_admin_actions WHERE actor_id = 0').n, 0, 'automatic steps are not counted against anyone');
  tick(120);
});

await scenario('phase 3 — the panel: 18 lists; add, search, details, note, edit, remove (asks first), history, CSV export; levels', async () => {
  const c = await olgaSays('/config');
  olgaPanel = midOf(sent(c)[0]);
  await olga(`g:${BETA}`);
  assert.deepEqual(dataOf(olgaScreen()).slice(0, 11), [B('K'), B('S'), B('L'), B('P'), B('W'), B('B'), B('F'), B('U'), B('V'), B('T'), B('O')]);
  await olga(B('L'));
  assert.equal(dataOf(olgaScreen()).filter((d) => /:L:[a-z]{3}$/.test(d)).length, 18);
  assert.match(olgaScreen().plain, /Each list belongs to this chat only/);
  assert.ok(labelsOf(Q.olga, olgaPanel).includes('⭐ VIP · 1'));
  await olga(B('L:bwd'));
  assert.match(olgaScreen().plain, /The list is empty/);
  assert.match(olgaScreen().plain, /takes effect with the locks and filters of a later phase/);
  const ask = await olga(B('L:bwd:a'));
  assert.match(sent(ask.calls)[0].params.text, /Send the words for «Banned words»/);
  const added = await olgaSays('spam\nscam\nكلمه\nکلمه\n');
  assert.match(sent(added)[0].params.text, /Added: 3 · updated: 0 · failed: 0/);
  const page = sent(added)[1];
  assert.match(page.params.text, /Entries: 3/);
  assert.equal(row("SELECT count(*) AS n FROM aegis_list_history WHERE chat_id = ? AND list = 'bwd' AND action = 'add'", BETA).n, 3);
  olgaPanel = midOf(page);
  await olga(B('L:bwd:s'));
  const found = await olgaSays('sca');
  assert.match(sent(found)[0].params.text, /«\u2068sca\u2069»: 1 found/);
  olgaPanel = midOf(sent(found)[0]);
  const scam = row("SELECT id FROM aegis_list_entries WHERE chat_id = ? AND list = 'bwd' AND ekey = 'scam'", BETA).id;
  await olga(B(`L:bwd:d:${scam}`));
  assert.match(olgaScreen().plain, /Value: \u2068scam\u2069/);
  assert.match(olgaScreen().plain, new RegExp(`Added by ${n('Olga')}`));
  await olga(B(`L:bwd:n:${scam}`));
  const note = await olgaSays('phishing wave');
  assert.match(sent(note)[0].params.text, /📝 Note saved/);
  olgaPanel = midOf(sent(note)[0]);
  await olga(B(`L:bwd:v:${scam}`));
  const val = await olgaSays('scams');
  assert.match(sent(val)[0].params.text, /✏\uFE0F Saved/);
  assert.match(sent(val)[0].params.text, /🕘 History:/);
  olgaPanel = midOf(sent(val)[0]);
  const exists = (await olga(B(`L:bwd:v:${scam}`)), await olgaSays('spam'));
  assert.match(sent(exists)[0].params.text, /already on the list/);
  await olgaSays('/cancel');
  await olga(B(`L:bwd:r:${scam}`));
  assert.match(olgaScreen().plain, /Remove \u2068scams\u2069 from «Banned words»\?/);
  await olga(B(`L:bwd:ry:${scam}`));
  assert.match(olgaScreen().plain, /🗑 \u2068scams\u2069 removed/);
  assert.match(olgaScreen().plain, /Entries: 2/);
  await olga(B('L:bwd:h'));
  assert.match(olgaScreen().plain, /removed \u2068scams\u2069/);
  assert.match(olgaScreen().plain, /changed \u2068scams\u2069/);
  const ex = await olga(B('L:bwd:x'));
  const doc = sent(ex.calls, 'sendDocument')[0];
  assert.ok(doc && doc.result.ok, 'exported');
  const file = mock.get(Q.olga.id, doc.result.result.message_id).document;
  assert.equal(file.file_name, `aegis-bwd-m${-BETA}.csv`);
  const text = file.bytes.toString('utf8');
  assert.ok(text.startsWith('\uFEFFvalue,key,user_id'), text.slice(0, 40));
  assert.match(text, /\r\nspam,spam,/);
  assert.match(text, /\r\nكلمه,کلمه,/, 'the value as typed; the key normalized');
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'lists.export' AND chat_id = ?", BETA));

  await onboard(Q.ben, 'en');
  const bc = await dm(Q.ben, '/config');
  const benPanel = midOf(sent(bc)[0]);
  await press(Q.ben, `g:${BETA}`, benPanel);
  await press(Q.ben, B('L:bwd'), benPanel);
  const deny = await press(Q.ben, B('L:bwd:a'), benPanel);
  assert.equal(deny.alert, true);
  assert.match(deny.toast, /needs access level «Settings»/);
  const benSearch = await press(Q.ben, B('L:bwd:s'), benPanel);
  assert.match(sent(benSearch.calls)[0].params.text, /What should I look for/, 'view level may search');
  await dm(Q.ben, '/cancel');
});

await scenario('phase 3 — member lists: muting from the list (id, duration, reason), removing lifts it; moderators may mute but not ban; bad lines reported', async () => {
  await olga(B('L:mut'));
  const ask = await olga(B('L:mut:a'));
  const kbd = sent(ask.calls)[0].params.reply_markup.keyboard;
  assert.deepEqual(kbd[0][0].request_users, { request_id: 11, max_quantity: 10 });
  const add = await olgaSays(`${Q.mia.id} 2h flooding\nhello\n@${Q.olga.username}`);
  const rc = sent(add, 'restrictChatMember')[0];
  assert.deepEqual([rc.params.user_id, rc.params.until_date], [Q.mia.id, nowS() + 7200]);
  const res = sent(add)[0].params.text;
  assert.match(res, /Added: 1 · updated: 0 · failed: 2/);
  assert.match(res, /Lines not understood: 2/);
  assert.match(res, new RegExp(`${n('Olga')} is an admin`));
  assert.deepEqual(sent(add)[0].params.reply_markup, { remove_keyboard: true });
  const e = row("SELECT * FROM aegis_list_entries WHERE chat_id = ? AND list = 'mut' AND ekey = ?", BETA, String(Q.mia.id));
  assert.deepEqual([e.note, e.expires_at, e.added_by], ['flooding', nowS() + 7200, Q.olga.id]);
  assert.equal(lastPun().source, 'list');
  olgaPanel = midOf(sent(add)[1]);
  assert.match(olgaScreen().plain, /⏳ 2 h left/);
  await olga(B(`L:mut:r:${e.id}`));
  assert.match(olgaScreen().plain, /also lets them talk again in Telegram/);
  const rm = await olga(B(`L:mut:ry:${e.id}`));
  assert.equal(sent(rm.calls, 'restrictChatMember')[0].params.permissions.can_send_messages, true);
  assert.equal(row('SELECT status FROM aegis_punishments WHERE id = ?', lastPun().id).status, 'undone');

  await olga(B('L:mod'));
  await olga(B('L:mod:a'));
  const shared = await olgaSays(null, { users_shared: { request_id: 11, users: [{ user_id: Q.kai.id, first_name: 'Kai' }] } });
  assert.match(sent(shared)[0].params.text, /Added: 1/);
  const kmute = await gmsg(betaChat, Q.kai, '/mute 30m', reply(Q.max));
  assert.equal(sent(kmute, 'restrictChatMember')[0].params.user_id, Q.max.id, 'a moderator may mute');
  const kban = await gmsg(betaChat, Q.kai, '/ban', reply(Q.max));
  assert.match(toChat(kban, BETA)[0].params.text, /Moderators \(the «mod» list\) can warn, unwarn and mute/);
  await olga(B('L:mod'));
  const kaiEntry = row("SELECT id FROM aegis_list_entries WHERE chat_id = ? AND list = 'mod'", BETA).id;
  await olga(B(`L:mod:ry:${kaiEntry}`));
  const after = await gmsg(betaChat, Q.kai, '/mute 30m', reply(Q.max));
  assert.equal(sent(after).length, 0, 'no longer a moderator: ignored');
  tick(120);
});

await scenario('phase 3 — punishments panel: history with executor, source and status; undo from the panel; CSV export', async () => {
  await olga(B('P'));
  const s = olgaScreen().plain;
  assert.match(s, /⚖\uFE0F Punishments in \u2068Beta\u2069/);
  assert.match(s, /🔇 Mute · \u2068Max\u2069 · active/);
  assert.match(s, /👮 \u2068Kai\u2069 · command/);
  assert.match(s, /Total: 15 \(newest first\)/);
  assert.ok(dataOf(olgaScreen()).includes(B('P:p:1')), 'paged');
  await olga(B('P:p:1'));
  const older = olgaScreen().plain;
  assert.match(older, /⛔\uFE0F Ban · \u2068Mia\u2069 · undone/);
  assert.match(older, /👢 Kick · \u2068Max\u2069 · done/);
  assert.match(older, /📝 \u2068spam links\u2069/);
  const kaiMute = row("SELECT id FROM aegis_punishments WHERE chat_id = ? AND actor_id = ? AND kind = 'mute' AND status = 'active'", BETA, Q.kai.id).id;
  const u = await olga(B(`P:u:${kaiMute}:0`));
  assert.equal(sent(u.calls, 'restrictChatMember')[0].params.user_id, Q.max.id);
  assert.match(olgaScreen().plain, new RegExp(`↩\uFE0F #${num('en', kaiMute)}: Mute of ${n('Max')} undone`));
  const ex = await olga(B('P:x'));
  const d = sent(ex.calls, 'sendDocument')[0];
  const text = mock.get(Q.olga.id, d.result.result.message_id).document.bytes.toString('utf8');
  assert.ok(text.startsWith('\uFEFFid,kind,user_id,actor_id,source,status,reason'));
  assert.match(text, /,ban,800000023,800000021,command,undone,spam links,/);
});

await scenario('phase 3 — warnings panel: expiry, reset, notices (off → the result goes privately), steps edited in Persian with errors, member warnings removed/cleared', async () => {
  await olga(B('W'));
  assert.match(olgaScreen().plain, /• 3 ⚠\uFE0F → 🔇 Mute · 1 d/);
  assert.match(olgaScreen().plain, /• 5 ⚠\uFE0F → ⛔\uFE0F Ban · until lifted/);
  await olga(B('W:t'));
  assert.match(olgaScreen().plain, /Warnings expire after: 1 d/);
  await olga(B('W:r'));
  assert.match(olgaScreen().plain, /after the last step: OFF/);
  await olga(B('W:n'));
  assert.match(olgaScreen().plain, /Notices in the group: OFF/);
  const quiet = await gmsg(betaChat, Q.abe, '/warn quiet please', reply(Q.max));
  assert.equal(toChat(quiet, BETA).length, 0, 'no notice in the group');
  assert.match(toChat(quiet, Q.abe.id)[0].params.text, /Group notices are off in \u2068Beta\u2069/);
  await olga(B('W:n'));
  const ask = await olga(B('W:s'));
  assert.match(sent(ask.calls)[0].params.text, /Send the steps, one per line/);
  const bad = await olgaSays('3 explode');
  assert.match(sent(bad)[0].params.text, /Line 1: the action must be mute, restrict, kick or ban/);
  const good = await olgaSays('۲ سکوت ۱ ساعت\n۴ بن');
  assert.match(sent(good)[0].params.text, /🪜 Steps saved/);
  assert.match(sent(good)[0].params.text, /• 2 ⚠\uFE0F → 🔇 Mute · 1 h/);
  olgaPanel = midOf(sent(good)[0]);
  assert.equal(row("SELECT value FROM aegis_chat_settings WHERE chat_id = ? AND key = 'steps'", BETA).value, '[{"n":2,"a":"mute","d":3600},{"n":4,"a":"ban","d":0}]');
  const second = await gmsg(betaChat, Q.abe, '/warn', reply(Q.max));
  assert.match(toChat(second, BETA)[0].params.text, /Warnings: 2 of 4/);
  assert.match(toChat(second, BETA)[0].params.text, /Step reached: 🔇 Mute \(1 h\)/);
  await olga(B(`W:u:${Q.max.id}`));
  assert.match(olgaScreen().plain, new RegExp(`${n('Max')}: 2 of 4 warnings`));
  await olga(B(`W:m:${Q.max.id}`));
  assert.match(olgaScreen().plain, /1 of 4 warnings/);
  await olga(B(`W:c:${Q.max.id}`));
  assert.match(olgaScreen().plain, /Clear all warnings of/);
  await olga(B(`W:cy:${Q.max.id}`));
  assert.match(olgaScreen().plain, /🧹 1 warnings of \u2068Max\u2069 cleared/);
  await gmsg(betaChat, Q.abe, '/warn old', reply(Q.noa.id === 0 ? Q.max : Q.rex));
  tick(2 * 86400);
  const ws = await gmsg(betaChat, Q.abe, '/warns', reply(Q.rex));
  assert.match(toChat(ws, BETA)[0].params.text, /0 of 4 warnings/, 'expired after a day');
  await olga(B('W:sd'));
  await olga(B('W:t'));
  await olga(B('W:t'));
  await olga(B('W:t'));
  await olga(B('W:r'));
  assert.match(olgaScreen().plain, /Warnings expire after: never/);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'settings.set' AND chat_id = ? AND target = 'steps'", BETA));
});

await scenario('phase 3 — Audit Mode: steps are only reported (nothing done in Telegram), commands still work; the panel explains it', async () => {
  await olga(B('U'));
  assert.match(olgaScreen().plain, /records and reports the punishments it would decide on its own/);
  await olga(B('U:y'));
  assert.match(olgaScreen().plain, /State: ON/);
  for (const i of [1, 2]) await gmsg(betaChat, Q.abe, `/warn ${i}`, reply(Q.v6));
  const three = await gmsg(betaChat, Q.abe, '/warn 3', reply(Q.v6));
  assert.equal(sent(three, 'restrictChatMember').length, 0, 'not done in Telegram');
  assert.match(toChat(three, BETA)[0].params.text, /Audit Mode, not done: 🔇 Mute/);
  assert.deepEqual([lastPun().kind, lastPun().status], ['mute', 'audit']);
  const manual = await gmsg(betaChat, Q.abe, '/mute 1h', reply(Q.v6));
  assert.equal(sent(manual, 'restrictChatMember').length, 1, 'a command is a human decision: done');
  await olga(`g:${BETA}`);
  assert.match(olgaScreen().plain, /Audit Mode is ON/);
  await olga(B('U:y'));
  assert.match(olgaScreen().plain, /State: OFF/);
  tick(120);
});

await scenario('phase 3 — bans in Telegram itself are recorded (and their unban too); the blacklist bans again on join', async () => {
  const tb = await adminChange(betaChat, Q.abe, Q.rex, { status: 'member' }, { status: 'kicked', until_date: 0 });
  assert.equal(sent(tb).length, 0);
  const p = lastPun();
  assert.deepEqual([p.kind, p.source, p.actor_id, p.user_id, p.status], ['ban', 'telegram', Q.abe.id, Q.rex.id, 'active']);
  assert.ok(row("SELECT id FROM aegis_list_entries WHERE chat_id = ? AND list = 'ban' AND ekey = ?", BETA, String(Q.rex.id)));
  await adminChange(betaChat, Q.abe, Q.rex, { status: 'kicked' }, { status: 'left' });
  assert.equal(row('SELECT status FROM aegis_punishments WHERE id = ?', p.id).status, 'undone');
  assert.equal(row("SELECT count(*) AS n FROM aegis_list_entries WHERE chat_id = ? AND list = 'ban' AND ekey = ?", BETA, String(Q.rex.id)).n, 0);
  await olga(B('L:blk'));
  await olga(B('L:blk:a'));
  const add = await olgaSays(`${Q.rex.id} raid`);
  assert.equal(sent(add, 'banChatMember')[0].params.user_id, Q.rex.id);
  beta.banned.delete(Q.rex.id);
  await adminChange(betaChat, Q.abe, Q.rex, { status: 'kicked' }, { status: 'left' });
  assert.ok(row("SELECT id FROM aegis_list_entries WHERE chat_id = ? AND list = 'blk' AND ekey = ?", BETA, String(Q.rex.id)), 'the blacklist stays');
  const back = await adminChange(betaChat, Q.rex, Q.rex, { status: 'left' }, { status: 'member' });
  assert.equal(sent(back, 'banChatMember')[0].params.user_id, Q.rex.id, 'banned again on join');
  assert.match(toChat(back, BETA)[0].params.text, new RegExp(`🏴 <b>Blacklist ban</b>: ${n('Rex')}`));
  assert.match(toChat(back, BETA)[0].params.text, /Reason: \u2068On the blacklist\u2069/);
  assert.deepEqual([lastPun().source, lastPun().actor_id], ['blacklist', 0]);
  assert.equal(row("SELECT note FROM aegis_list_entries WHERE chat_id = ? AND list = 'blk' AND ekey = ?", BETA, String(Q.rex.id)).note, 'raid', 'the admin\'s note is kept');
  const member = await adminChange(betaChat, Q.v1, Q.v1, { status: 'left' }, { status: 'member' });
  assert.equal(sent(member, 'banChatMember').length, 0, 'others join freely');
  tick(120);
});

await scenario('phase 3 — anti-betrayal: an Aegis admin removing 5 members in a minute is demoted; unban the victims and restore the admin from the alert', async () => {
  await olga(B('B'));
  assert.match(olgaScreen().plain, /Rule: 5 removals or demotions within 1 min/);
  await olga(B('B:n'));
  assert.match(olgaScreen().plain, /Rule: 10 removals/);
  for (let i = 0; i < 3; i += 1) await olga(B('B:n'));
  assert.match(olgaScreen().plain, /Rule: 5 removals/);
  let last = null;
  for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) last = await adminChange(betaChat, Q.tom, Q[v], { status: 'member' }, { status: 'kicked', until_date: 0 });
  const demote = sent(last, 'promoteChatMember')[0];
  assert.ok(demote, 'demoted');
  assert.equal(demote.params.user_id, Q.tom.id);
  assert.equal(demote.params.can_restrict_members, false);
  assert.ok(!beta.admins.has(Q.tom.id));
  const [alert] = toChat(last, BETA);
  assert.match(alert.params.text, /🚨 <b>Anti-betrayal — \u2068Beta\u2069<\/b>/);
  assert.match(alert.params.text, new RegExp(`${n('Tom')} removed or demoted 5 members within 1 min`));
  assert.match(alert.params.text, /⬇\uFE0F Aegis demoted them/);
  const inc = row('SELECT * FROM aegis_incidents ORDER BY id DESC LIMIT 1');
  assert.deepEqual(alert.params.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`bt:${inc.id}:v`, `bt:${inc.id}:r`]);
  assert.equal(toChat(last, Q.olga.id).length, 1, 'the creator hears about it privately');
  const extra = await adminChange(betaChat, Q.tom, Q.v6, { status: 'member' }, { status: 'kicked', until_date: 0 });
  assert.equal(toChat(extra, BETA).length, 0, 'one incident per burst');
  const notAllowed = await gpress(Q.abe, BETA, `bt:${inc.id}:v`, midOf(alert));
  assert.match(notAllowed.toast, /Only the creator and Full-access admins/);
  const free = await gpress(Q.olga, BETA, `bt:${inc.id}:v`, midOf(alert));
  assert.match(free.toast, /Unbanned: 5 · failed: 0/);
  assert.equal(sent(free.calls, 'unbanChatMember').length, 5);
  const restore = await gpress(Q.olga, BETA, `bt:${inc.id}:r`, midOf(alert));
  assert.match(restore.toast, /Admin restored/);
  const re = sent(restore.calls, 'promoteChatMember')[0];
  assert.deepEqual([re.params.can_delete_messages, re.params.can_restrict_members, re.params.can_promote_members], [true, true, false]);
  assert.ok(beta.admins.has(Q.tom.id));
  assert.equal(kb(mock.get(BETA, midOf(alert))).length, 0, 'both buttons used');
  tick(120);
  let outside = null;
  for (const v of ['v1', 'v2', 'v3', 'v4', 'v5']) outside = await adminChange(betaChat, Q.abe, Q[v], { status: 'left' }, { status: 'kicked', until_date: 0 });
  assert.equal(sent(outside, 'promoteChatMember').length, 0, 'an admin appointed elsewhere can only be reported');
  assert.match(toChat(outside, BETA)[0].params.text, /appointed outside Aegis/);
  await olga(B('B'));
  assert.match(olgaScreen().plain, /Recent incidents:/);
  assert.match(olgaScreen().plain, new RegExp(`${n('Tom')}: 5 → demoted`));
  await olga(B('B:o'));
  assert.match(olgaScreen().plain, /State: OFF/);
  await olga(B('B:o'));
  tick(120);
});

await scenario('phase 3 — log channel: picked with the chat button, checked (bot can post, you are admin there), receives punishments; categories, test, removal', async () => {
  mock.addChat({ id: LOGS, type: 'channel', title: 'Beta logs', botRights: { can_post_messages: true } }).admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  mock.addChat({ id: OTHER, type: 'channel', title: 'Not mine', botRights: { can_post_messages: true } });
  await olga(B('O'));
  assert.match(olgaScreen().plain, /Log chat: not set/);
  const ask = await olga(B('O:s'));
  assert.deepEqual(sent(ask.calls)[0].params.reply_markup.keyboard[0][0].request_chat, { request_id: 21, chat_is_channel: true, bot_is_member: true });
  const same = await olgaSays(null, { chat_shared: { request_id: 22, chat_id: BETA } });
  assert.match(sent(same)[0].params.text, /must be a different chat/);
  const notMine = await olgaSays(null, { chat_shared: { request_id: 21, chat_id: OTHER } });
  assert.match(sent(notMine)[0].params.text, /You must be an admin of that chat/);
  const ok = await olgaSays(null, { chat_shared: { request_id: 21, chat_id: LOGS } });
  assert.match(toChat(ok, LOGS)[0].params.text, /This chat now receives Aegis's logs for \u2068Beta\u2069/);
  assert.match(toChat(ok, Q.olga.id)[0].params.text, /Logs now go to \u2068Beta logs\u2069/);
  olgaPanel = midOf(toChat(ok, Q.olga.id)[1]);
  const m = await gmsg(betaChat, Q.abe, '/mute 10m noise', reply(Q.noa.id ? Q.v6 : Q.v6));
  const [log] = toChat(m, LOGS);
  assert.match(log.params.text, /🛡 <b>Aegis<\/b> · \u2068Beta\u2069\n⚖\uFE0F Punishment\n🔇 Mute · \u2068V6\u2069 · by \u2068Abe\u2069 · 10 min · \u2068noise\u2069/);
  await olga(B('O:c:punish'));
  const m2 = await gmsg(betaChat, Q.abe, '/unmute', reply(Q.v6));
  assert.equal(toChat(m2, LOGS).length, 0, 'category off');
  await olga(B('O:c:punish'));
  const t1 = await olga(B('O:t'));
  assert.equal(t1.toast, 'Sent.');
  assert.match(toChat(t1.calls, LOGS)[0].params.text, /Test message from Aegis/);
  await olga(B('O:d'));
  assert.match(olgaScreen().plain, /Log chat removed/);
  assert.equal(row("SELECT value FROM aegis_chat_settings WHERE chat_id = ? AND key = 'log_chat'", BETA).value, '0');
});

await scenario('phase 3 — a Persian group: commands and notices in Persian, right-to-left on every line; a migration carries lists, settings and punishments', async () => {
  const GAMMA = -1009400;
  const g = mock.addChat({ id: GAMMA, type: 'supergroup', title: 'گاما', botRights: { can_restrict_members: true, can_delete_messages: true, can_promote_members: true } });
  g.admins.set(U.ali.id, { status: 'creator', user: U.ali });
  g.members.add(U.bea.id);
  g.people.set(U.bea.id, U.bea);
  const gammaChat = { id: GAMMA, type: 'supergroup', title: 'گاما' };
  await botChange(gammaChat, U.ali, 'left', 'administrator', g.botRights);
  assert.equal(row('SELECT lang FROM aegis_chats WHERE chat_id = ?', GAMMA).lang, 'fa');
  const c = await gmsg(gammaChat, U.ali, 'سکوت ۲ ساعت اسپم', { reply_to_message: { message_id: 1, from: U.bea, chat: gammaChat, date: 0 } });
  const [nt] = toChat(c, GAMMA);
  assert.match(nt.params.text, /🔇 <b>سکوت<\/b>/);
  assert.match(nt.params.text, /⏱ مدت: ۲ ساعت/);
  assert.equal(nt.params.reply_markup.inline_keyboard[0][0].text, '\u200F↩\uFE0F برگرداندن');
  const w = await gmsg(gammaChat, U.ali, 'اخطار', { reply_to_message: { message_id: 1, from: U.bea, chat: gammaChat, date: 0 } });
  assert.match(toChat(w, GAMMA)[0].params.text, /اخطارها: ۱ از ۵/);

  const OLD = -4200;
  const NEWID = -1009500;
  const old = mock.addChat({ id: OLD, type: 'group', title: 'Old', botRights: { can_restrict_members: true } });
  old.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  const oldChat = { id: OLD, type: 'group', title: 'Old' };
  await botChange(oldChat, Q.olga, 'left', 'administrator', old.botRights);
  await gmsg(oldChat, Q.olga, '/warn first', { reply_to_message: { message_id: 1, from: Q.mia, chat: oldChat, date: 0 } });
  rawDatabase().prepare("INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (?, 'audit', '1', 0, 0)").run(OLD);
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, added_by, added_at, updated_by, updated_at) VALUES (?, 'bwd', 'x', 'x', 0, 0, 0, 0)").run(OLD);
  mock.addChat({ id: NEWID, type: 'supergroup', title: 'Old', botRights: { can_restrict_members: true } });
  await gmsg(oldChat, Q.olga, null, { migrate_to_chat_id: NEWID });
  for (const t of ['aegis_punishments', 'aegis_chat_settings', 'aegis_list_entries']) {
    assert.equal(row(`SELECT count(*) AS n FROM ${t} WHERE chat_id = ?`, OLD).n, 0, t);
    assert.equal(row(`SELECT count(*) AS n FROM ${t} WHERE chat_id = ?`, NEWID).n, 1, t);
  }
});

// ---------- phase 4: group locks ----------

const P4 = {};
for (const [i, nm] of ['Lia', 'Sam', 'Ada', 'Newbie', 'Nora'].entries()) {
  P4[nm.toLowerCase()] = { id: 800000060 + i, is_bot: false, first_name: nm, language_code: 'en', username: `${nm.toLowerCase()}_p4` };
}
const K = (x) => B(`K:${x}`);
const ids = (calls) => sent(calls, 'deleteMessage').map((c) => c.params.message_id);
const photoOf = (u) => gmsg(betaChat, u, null, { photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] });
async function lockOn(code, ...more) {
  await olga(K(`l:${code}`));
  if (!/🔒/.test(olgaScreen().plain.split('\n')[0])) await olga(K(`l:${code}:o`));
  for (const m of more) await olga(K(`l:${code}:${m}`));
}
async function lockOff(code) {
  await olga(K(`l:${code}`));
  if (/🔒/.test(olgaScreen().plain.split('\n')[0])) await olga(K(`l:${code}:o`));
}

await scenario('phase 4 — 🔐 locks: 42 in four groups; a member\'s photo is deleted with a notice (one at a time, the old one replaced); admins and VIPs are never caught', async () => {
  tick(120);
  for (const u of Object.values(P4)) {
    beta.members.add(u.id);
    beta.people.set(u.id, u);
  }
  const c = await olgaSays('/config');
  olgaPanel = midOf(sent(c)[0]);
  await olga(`g:${BETA}`);
  await olga(B('K'));
  const home = olgaScreen().plain;
  assert.match(home, /🔐 Locks of \u2068Beta\u2069/);
  for (const [nm, total] of [['🖼 Media', 14], ['🔤 Text and links', 13], ['🧹 Content', 9], ['🚦 Behaviour', 6]]) assert.ok(home.includes(`• ${nm}: 0 of ${total} on`), nm);
  assert.match(home, /«New members» means joined in the last 1 d/);
  await olga(K('c:media'));
  assert.equal(dataOf(olgaScreen()).filter((d) => d.includes(':K:l:')).length, 14);
  assert.ok(labelsOf(Q.olga, olgaPanel).includes('🔓 🖼 Photos'));
  await olga(K('l:photo'));
  assert.match(olgaScreen().plain, /🔓 🖼 Photos — off/);
  await olga(K('l:photo:o'));
  assert.match(olgaScreen().plain, /🔒 🖼 Photos — on/);
  assert.match(olgaScreen().plain, /🗑 The message is deleted/);
  assert.ok(row("SELECT id FROM aegis_audit WHERE action = 'lock.set' AND chat_id = ? AND target = 'photo'", BETA), 'logged');
  const first = msgId;
  const r = await photoOf(P4.lia);
  assert.deepEqual(ids(r), [first]);
  assert.ok(!mock.get(BETA, first), 'gone from the chat');
  assert.match(toChat(r, BETA)[0].params.text, /⛔\uFE0F \u2068Lia\u2069: «Photos» is locked here\./);
  assert.equal(row("SELECT action FROM aegis_lock_hits WHERE chat_id = ? AND code = 'photo' ORDER BY id DESC LIMIT 1", BETA).action, 'deleted');
  const quick = await photoOf(P4.lia);
  assert.equal(ids(quick).length, 1, 'deleted again');
  assert.equal(toChat(quick, BETA).length, 0, 'no second notice within 5 s');
  tick(10);
  const later = await photoOf(P4.sam);
  assert.equal(ids(later).length, 2, 'the message and the previous notice');
  assert.equal(toChat(later, BETA).length, 1);
  assert.equal(ids(await photoOf(Q.abe)).length, 0, 'admins are exempt');
  assert.equal(ids(await photoOf(Q.noa)).length, 0, 'VIPs are exempt');
  assert.equal(ids(await gmsg(betaChat, P4.lia, 'just text')).length, 0, 'other content is fine');
});

await scenario('phase 4 — a lock\'s own settings: punishment and duration, custom notice (escaped), log channel, allowed links; undo; keep instead of delete', async () => {
  tick(10);
  rawDatabase().prepare("INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (?, 'log_chat', ?, 0, 0) ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value")
    .run(BETA, String(LOGS));
  await lockOn('link', 'a', 'a', 'd', 'd');
  assert.match(olgaScreen().plain, /⚖\uFE0F Punishment: mute · 1 h/);
  assert.match(olgaScreen().plain, /Exceptions: the «Allowed links» list/);
  const ask = await olga(K('l:link:t'));
  assert.match(sent(ask.calls)[0].params.text, /Use \{user\} for the member and \{lock\} for the lock's name/);
  const saved = await olgaSays('No links here, {user}! <b>');
  assert.match(sent(saved)[0].params.text, /Notice saved: «No links here, \{user\}! &lt;b&gt;»/);
  olgaPanel = midOf(sent(saved)[0]);
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, added_by, added_at, updated_by, updated_at) VALUES (?, 'aln', 'example.org', 'example.org', 0, 0, 0, 0)").run(BETA);
  const fine = await gmsg(betaChat, P4.lia, 'docs at https://docs.example.org/a', { entities: [{ type: 'url', offset: 8, length: 26 }] });
  assert.equal(ids(fine).length, 0, 'an allowed domain (and its subdomains)');
  const id = msgId;
  const bad = await gmsg(betaChat, P4.lia, 'buy at spam.io now', { entities: [{ type: 'url', offset: 7, length: 7 }] });
  assert.ok(ids(bad).includes(id));
  const mute = sent(bad, 'restrictChatMember')[0];
  assert.deepEqual([mute.params.user_id, mute.params.until_date], [P4.lia.id, nowS() + 3600]);
  const [nt] = toChat(bad, BETA);
  assert.match(nt.params.text, /No links here, \u2068Lia\u2069! &lt;b&gt;/);
  assert.match(nt.params.text, /🔇 Mute · 1 h/);
  const p = lastPun();
  assert.deepEqual([p.source, p.reason, p.actor_id, p.kind], ['lock', 'Lock: Links', 0, 'mute']);
  assert.equal(nt.params.reply_markup.inline_keyboard[0][0].callback_data, `pu:${p.id}`);
  const logged = toChat(bad, LOGS).map((x) => x.params.text).join('\n');
  assert.match(logged, /🔐 Deleted a message of \u2068Lia\u2069 — Links/);
  assert.match(logged, /⚖\uFE0F Punishment\n🔇 Mute · \u2068Lia\u2069 · by Aegis · 1 h/, 'the punishment is logged too');
  const undo = await gpress(Q.abe, BETA, `pu:${p.id}`, midOf(nt));
  assert.equal(undo.toast, '↩\uFE0F Undone.');
  await olga(K('l:link:x'));
  assert.match(olgaScreen().plain, /The message is kept/);
  tick(10);
  const keptId = msgId;
  const kept = await gmsg(betaChat, P4.sam, 'see spam.io', { entities: [{ type: 'url', offset: 4, length: 7 }] });
  assert.ok(!ids(kept).includes(keptId), 'kept');
  assert.equal(sent(kept, 'restrictChatMember').length, 1, 'still punished');
  assert.match(toChat(kept, LOGS).map((x) => x.params.text).join('\n'), /Caught a message of \u2068Sam\u2069 \(kept\)/);
  await olga(K('l:link:x'));
  await olga(K('l:link:a'));
  await olga(K('l:link:a'));
  await olga(K('l:link:a'));
  await olga(K('l:link:a'));
  assert.match(olgaScreen().plain, /⚖\uFE0F Punishment: none/);
  tick(10);
});

await scenario('phase 4 — language locks never delete a mixed message for one foreign word, at any sensitivity; a mostly-English message is caught', async () => {
  await lockOff('link');
  await lockOn('lang_latin');
  assert.match(olgaScreen().plain, /Sensitivity: medium — at least half of the letters/);
  const mixed = 'سلام دوستان Hello امروز خوبید؟';
  assert.equal(ids(await gmsg(betaChat, P4.lia, mixed)).length, 0);
  await olga(K('l:lang_latin:s'));
  assert.match(olgaScreen().plain, /Sensitivity: high/);
  assert.equal(ids(await gmsg(betaChat, P4.lia, mixed)).length, 0, 'not even at high sensitivity');
  assert.equal(ids(await gmsg(betaChat, P4.lia, 'سلام، لینکش اینه example.com', { entities: [{ type: 'url', offset: 17, length: 11 }] })).length, 0,
    'links are not words');
  const id = msgId;
  assert.ok(ids(await gmsg(betaChat, P4.lia, 'Hello everyone, buy my course today')).includes(id));
  await lockOff('lang_latin');
  await lockOn('lang_fa');
  const fa = msgId;
  assert.ok(ids(await gmsg(betaChat, P4.sam, 'سلام به همه دوستان')).includes(fa));
  assert.equal(ids(await gmsg(betaChat, P4.sam, 'Good morning all, merci ممنون')).length, 0, 'one Persian word in an English message');
  await lockOff('lang_fa');
  tick(10);
});

await scenario('phase 4 — exceptions: trusted list (switchable), members exempted by hand; «new members only» uses the join time', async () => {
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, user_id, added_by, added_at, updated_by, updated_at) VALUES (?, 'tru', ?, 'Sam', ?, 0, 0, 0, 0)")
    .run(BETA, String(P4.sam.id), P4.sam.id);
  assert.equal(ids(await photoOf(P4.sam)).length, 0, 'trusted members are exempt by default');
  await olga(K('l:photo:et'));
  assert.match(olgaScreen().plain, /trusted list: OFF/);
  assert.ok(ids(await photoOf(P4.sam)).length >= 1, 'not any more');
  await olga(K('l:photo:et'));
  await olga(K('l:photo:e'));
  assert.match(olgaScreen().plain, /Exempt from «Photos»: 0 of 20/);
  const ask = await olga(K('l:photo:ea'));
  assert.deepEqual(sent(ask.calls)[0].params.reply_markup.keyboard[0][0].request_users, { request_id: 31, max_quantity: 10 });
  const add = await olgaSays(null, { users_shared: { request_id: 31, users: [{ user_id: P4.ada.id, first_name: 'Ada' }] } });
  assert.match(sent(add)[0].params.text, /🙋 1 added/);
  olgaPanel = midOf(sent(add)[1]);
  assert.match(olgaScreen().plain, new RegExp(`• ${n('Ada')} — ${P4.ada.id}`));
  assert.equal(ids(await photoOf(P4.ada)).length, 0, 'exempt by hand');
  await olga(K(`l:photo:er:${P4.ada.id}`));
  assert.match(olgaScreen().plain, /is no longer exempt/);
  tick(10);
  await lockOn('sticker', 'w');
  assert.match(olgaScreen().plain, /Applies to: new members only \(joined in the last 1 d\)/);
  await adminChange(betaChat, P4.newbie, P4.newbie, { status: 'left' }, { status: 'member' });
  assert.ok(row('SELECT joined_at FROM aegis_members WHERE chat_id = ? AND user_id = ?', BETA, P4.newbie.id));
  const sticker = (u) => gmsg(betaChat, u, null, { sticker: { file_id: 's', file_unique_id: 's', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false } });
  assert.equal(ids(await sticker(P4.newbie)).length >= 1, true, 'a new member is caught');
  assert.equal(ids(await sticker(P4.lia)).length, 0, 'an older member is not');
  tick(25 * 3600);
  assert.equal(ids(await sticker(P4.newbie)).length, 0, 'no longer new after a day');
  await olga(K('w'));
  assert.match(olgaScreen().plain, /joined in the last 3 d/);
  assert.ok(ids(await sticker(P4.newbie)).length >= 1, 'the window is a setting');
  await olga(K('w'));
  await olga(K('w'));
  await olga(K('w'));
  await lockOff('sticker');
  tick(10);
});

await scenario('phase 4 — banned words with a warning (the step ladder applies), stretched words, sensitivity «high» and allowed words', async () => {
  await lockOn('badword', 'a');
  assert.match(olgaScreen().plain, /⚖\uFE0F Punishment: warning · —/);
  const id = msgId;
  const w = await gmsg(betaChat, P4.nora, 'this is spaaaam');
  assert.ok(ids(w).includes(id), 'stretched word, medium sensitivity');
  assert.match(toChat(w, BETA)[0].params.text, /⚠\uFE0F Warnings: 1 of 5/);
  assert.equal(lastPun().kind, 'warn');
  tick(10);
  assert.equal(ids(await gmsg(betaChat, P4.nora, 'antispam tools')).length, 0);
  await olga(K('l:badword:s'));
  assert.ok(ids(await gmsg(betaChat, P4.nora, 'antispam tools')).length >= 1, 'high: inside other words');
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, added_by, added_at, updated_by, updated_at) VALUES (?, 'gwd', 'antispam', 'antispam', 0, 0, 0, 0)").run(BETA);
  tick(10);
  assert.equal(ids(await gmsg(betaChat, P4.nora, 'antispam tools')).length, 0, 'an allowed word');
  await lockOff('badword');
  tick(10);
});

await scenario('phase 4 — behaviour locks: service messages, bots added by members (allowed bots stay), edits, commands for other bots, forwards, posting as a channel', async () => {
  await lockOn('service');
  const join = msgId;
  const s = await gmsg(betaChat, P4.lia, null, { new_chat_members: [P4.nora] });
  assert.deepEqual(ids(s), [join], 'the join notice is deleted');
  await lockOn('bots');
  assert.match(olgaScreen().plain, /Exceptions: the «Allowed bots» list/);
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, added_by, added_at, updated_by, updated_at) VALUES (?, 'bot', 'helper_bot', '@helper_bot', 0, 0, 0, 0)").run(BETA);
  const spam = { id: 7300000001, is_bot: true, first_name: 'Promo', username: 'spam_promo_bot' };
  const helper = { id: 7300000002, is_bot: true, first_name: 'Helper', username: 'helper_bot' };
  tick(10);
  const b = await gmsg(betaChat, P4.lia, null, { new_chat_members: [spam, helper] });
  assert.deepEqual(sent(b, 'banChatMember').map((x) => x.params.user_id), [spam.id], 'only the unwanted bot');
  assert.equal(sent(b, 'unbanChatMember')[0].params.user_id, spam.id);
  assert.match(toChat(b, BETA)[0].params.text, /\u2068Lia\u2069 added \u2068@spam_promo_bot\u2069: bots can be added only by admins/);
  const byAdmin = await gmsg(betaChat, Q.abe, null, { new_chat_members: [spam] });
  assert.equal(sent(byAdmin, 'banChatMember').length, 0, 'admins may add bots');
  await lockOff('service');
  await lockOff('bots');
  tick(10);
  await lockOn('edit');
  const e = msgId;
  await gmsg(betaChat, P4.lia, 'original');
  const ed = await run(H.edited_message, { message_id: e, from: P4.lia, chat: betaChat, date: 0, edit_date: 1, text: 'changed' });
  assert.equal(ids(ed)[0], e, 'the edited message (then the previous lock notice)');
  await lockOff('edit');
  await lockOn('invite');
  const e2 = msgId;
  await gmsg(betaChat, P4.lia, 'hello');
  tick(10);
  const ed2 = await run(H.edited_message, { message_id: e2, from: P4.lia, chat: betaChat, date: 0, edit_date: 2, text: 'join t.me/+AbCdEfGh',
    entities: [{ type: 'url', offset: 5, length: 14 }] });
  assert.deepEqual(ids(ed2).slice(0, 1), [e2], 'an edit that adds a forbidden link is caught by that lock');
  await lockOff('invite');
  tick(10);
  await lockOn('command');
  const cm = msgId;
  assert.ok(ids(await gmsg(betaChat, P4.lia, '/start@other_bot', { entities: [{ type: 'bot_command', offset: 0, length: 16 }] })).includes(cm));
  assert.equal(ids(await gmsg(betaChat, P4.lia, '/config', { entities: [{ type: 'bot_command', offset: 0, length: 7 }] })).length, 0, 'Aegis\'s own command');
  await lockOff('command');
  await lockOn('forward');
  tick(10);
  const fw = msgId;
  assert.ok(ids(await gmsg(betaChat, P4.lia, 'promo', { forward_origin: { type: 'channel', chat: { id: -1007777, type: 'channel', title: 'Promo' }, message_id: 1, date: 0 } }))
    .includes(fw));
  assert.equal(ids(await gmsg(betaChat, P4.lia, 'fwd', { forward_origin: { type: 'user', sender_user: P4.sam, date: 0 } })).length, 0, 'medium: a person\'s message is fine');
  await lockOff('forward');
  await lockOn('as_channel');
  tick(10);
  const ch = msgId;
  const asCh = await gmsg(betaChat, { id: 136817688, is_bot: true, first_name: 'Channel' }, 'buy', { sender_chat: { id: -1008888, type: 'channel', title: 'Promo' } });
  assert.ok(ids(asCh).includes(ch));
  assert.equal(sent(asCh, 'restrictChatMember').length + sent(asCh, 'banChatMember').length, 0, 'the person is hidden: nobody punished');
  assert.match(toChat(asCh, BETA)[0].params.text, /⛔\uFE0F \u2068Promo\u2069: «Posting as a channel» is locked here/);
  const anon = await gmsg(betaChat, { id: 1087968824, is_bot: true, first_name: 'Group' }, 'admin speaking', { sender_chat: betaChat });
  assert.equal(ids(anon).length, 0, 'the anonymous admin is never caught');
  await lockOff('as_channel');
  tick(10);
});

await scenario('phase 4 — Audit Mode: a lock only records and logs (nothing deleted, nobody punished, nothing posted in the group)', async () => {
  await olga(B('U:y'));
  await olga(K('l:photo:a'));
  const r = await photoOf(P4.lia);
  assert.equal(ids(r).length, 0);
  assert.equal(toChat(r, BETA).length, 0);
  assert.equal(sent(r, 'restrictChatMember').length, 0);
  assert.equal(row("SELECT action FROM aegis_lock_hits WHERE chat_id = ? AND code = 'photo' ORDER BY id DESC LIMIT 1", BETA).action, 'audit');
  assert.deepEqual([lastPun().kind, lastPun().status], ['warn', 'audit']);
  assert.match(toChat(r, LOGS).map((x) => x.params.text).join('\n'), /Audit Mode — would have acted on a message of \u2068Lia\u2069: Photos/);
  await olga(K('l:photo'));
  assert.match(olgaScreen().plain, /Audit Mode is on: locks only record and report/);
  await olga(B('U:y'));
  await olga(K('l:photo:a'));
  await olga(K('l:photo:a'));
  await olga(K('l:photo:a'));
  await olga(K('l:photo:a'));
  await olga(K('l:photo:a'));
  assert.match(olgaScreen().plain, /Punishment: none/);
  tick(10);
});

await scenario('phase 4 — recent catches, levels (View can\'t change locks; stronger punishments need «Ban users»), all locks off with confirmation', async () => {
  await olga(K('l:photo:h'));
  assert.match(olgaScreen().plain, /Recent catches — 🖼 Photos/);
  assert.match(olgaScreen().plain, new RegExp(`${n('Lia')}: deleted`));
  assert.match(olgaScreen().plain, new RegExp(`${n('Lia')}: audit only · Warning`));
  const bc = await dm(Q.ben, '/config');
  const benPanel = midOf(sent(bc)[0]);
  await press(Q.ben, `g:${BETA}`, benPanel);
  await press(Q.ben, K('l:photo'), benPanel);
  const deny = await press(Q.ben, K('l:photo:o'), benPanel);
  assert.match(deny.toast, /needs access level «Settings»/);
  rawDatabase().prepare('INSERT INTO aegis_access (chat_id, user_id, level, set_by, set_at) VALUES (?, ?, 2, ?, 0) ON CONFLICT(chat_id, user_id) DO UPDATE SET level = 2')
    .run(BETA, Q.ben.id, Q.olga.id);
  await press(Q.ben, K('l:photo:a'), benPanel);
  const toMute = await press(Q.ben, K('l:photo:a'), benPanel);
  assert.match(toMute.toast, /need Telegram's «Ban users» right/);
  assert.match(screenOf(Q.ben, benPanel).plain, /Punishment: none/, 'none → warning → back to none: no mute without the right');
  await olga(B('K'));
  assert.match(olgaScreen().plain, /🖼 Media: 1 of 14 on/);
  await olga(K('z'));
  assert.match(olgaScreen().plain, /Turn every lock in \u2068Beta\u2069 off\?/);
  await olga(K('zy'));
  assert.match(olgaScreen().plain, /🔓 1 locks turned off/);
  assert.match(olgaScreen().plain, /🖼 Media: 0 of 14 on/);
  assert.equal(ids(await photoOf(P4.lia)).length, 0);
});

await scenario('phase 4 — a Persian group: the lock notice in Persian, right-to-left on every line', async () => {
  const GAMMA = -1009400;
  rawDatabase().prepare("INSERT INTO aegis_locks (chat_id, code, enabled, config, updated_by, updated_at) VALUES (?, 'photo', 1, ?, 0, 0)")
    .run(GAMMA, JSON.stringify({ on: 1 }));
  const gammaChat = { id: GAMMA, type: 'supergroup', title: 'گاما' };
  const r = await gmsg(gammaChat, U.bea, null, { photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] });
  assert.equal(ids(r).length, 1);
  assert.match(toChat(r, GAMMA)[0].params.text, /⛔\uFE0F \u2068Béa\u2069: «عکس» در اینجا قفل است\./);
});

// ---------- phase 5: group security and federations ----------

const P5 = {};
for (const [i, nm] of ['Ivy', 'Joe', 'Kim', 'Lou', 'Moe', 'Ned', 'Oli', 'Pat', 'Ann', 'Req', 'Rex2'].entries()) {
  P5[nm.toLowerCase()] = { id: 800000080 + i, is_bot: false, first_name: nm, language_code: 'en', ...(nm === 'Ann' ? {} : { username: `${nm.toLowerCase()}_p5` }) };
}
const DELTA = -1009600;
const EPS = -1009700;
const deltaChat = { id: DELTA, type: 'supergroup', title: 'Delta', username: 'delta_group' };
let delta = null;
const S = (x) => `g:${DELTA}:S${x ? `:${x}` : ''}`;
const D = (x) => `g:${DELTA}:${x}`;
const dmsg = (u, text, extra = {}) => gmsg(deltaChat, u, text, extra);
const joinDelta = (u) => adminChange(deltaChat, u, u, { status: 'left' }, { status: 'member' });
async function moduleOn(code) {
  await olga(S(`m:${code}`));
  if (!/🟢/.test(olgaScreen().plain.split('\n')[0])) await olga(S(`m:${code}:on`));
}
async function moduleOff(code) {
  await olga(S(`m:${code}`));
  if (/🟢/.test(olgaScreen().plain.split('\n')[0])) await olga(S(`m:${code}:on`));
}

await scenario('phase 5 — 🔰 security: eight modules; anti-flood (too many messages, the same message again) — deleted, muted once, notice', async () => {
  tick(600);
  delta = mock.addChat({ id: DELTA, type: 'supergroup', title: 'Delta', username: 'delta_group', botRights: { can_manage_chat: true, can_change_info: true,
    can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true, can_promote_members: true } });
  delta.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  delta.admins.set(Q.abe.id, { status: 'administrator', user: Q.abe, rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }, promotedBy: Q.olga.id });
  for (const u of Object.values(P5)) {
    delta.members.add(u.id);
    delta.people.set(u.id, u);
  }
  await botChange(deltaChat, Q.olga, 'left', 'administrator', delta.botRights);
  rawDatabase().prepare('UPDATE aegis_chats SET reminder = 0 WHERE chat_id = ?').run(DELTA);
  const c = await olgaSays('/config');
  olgaPanel = midOf(sent(c)[0]);
  await olga(`g:${DELTA}`);
  await olga(S());
  const home = olgaScreen().plain;
  assert.match(home, /🔰 Security of \u2068Delta\u2069/);
  assert.equal((home.match(/⚪\uFE0F/g) || []).length, 8);
  await moduleOn('flood');
  assert.match(olgaScreen().plain, /• Limit: 5/);
  assert.match(olgaScreen().plain, /• Within: 5 s/);
  assert.match(olgaScreen().plain, /• Punishment: mute/);
  for (let i = 0; i < 5; i += 1) assert.equal(ids(await dmsg(P5.ivy, `msg ${i}`)).length, 0, `message ${i + 1} is fine`);
  const sixth = msgId;
  const f6 = await dmsg(P5.ivy, 'msg 6');
  assert.ok(ids(f6).includes(sixth));
  const mute = sent(f6, 'restrictChatMember')[0];
  assert.deepEqual([mute.params.user_id, mute.params.until_date], [P5.ivy.id, nowS() + 600]);
  assert.match(toChat(f6, DELTA)[0].params.text, /🔰 \u2068Ivy\u2069, your message was stopped: Anti-flood\./);
  assert.equal(lastPun().source, 'security');
  const f7 = await dmsg(P5.ivy, 'msg 7');
  assert.equal(ids(f7).length, 1, 'still deleted');
  assert.equal(sent(f7, 'restrictChatMember').length, 0, 'punished once per window');
  tick(30);
  await dmsg(P5.joe, 'same text');
  await dmsg(P5.joe, 'same text');
  const third = msgId;
  assert.ok(ids(await dmsg(P5.joe, 'same text')).includes(third), 'the same message a third time');
  assert.equal(ids(await dmsg(Q.abe, 'admin chatting')).length, 0);
  tick(30);
  for (const uid of ['a', 'b', 'c']) {
    assert.equal(ids(await dmsg(P5.kim, null, { photo: [{ file_id: uid, file_unique_id: `album-${uid}`, width: 1, height: 1 }] })).length, 0, 'different photos are not «the same message»');
  }
  await moduleOff('flood');
  tick(30);
});

await scenario('phase 5 — advanced anti-link: full-width letters, look-alike dots, "dot", button links; links to the group itself and allowed sites pass', async () => {
  await moduleOn('antilink');
  for (const [text, why] of [['visit ｓｐａｍ．ｃｏｍ now', 'full-width'], ['go to spam。net today', 'ideographic dot'], ['see example(dot)biz', '"dot"'],
    ['spam\u200B.io is great', 'zero-width inside']]) {
    tick(10);
    const id = msgId;
    assert.ok(ids(await dmsg(P5.joe, text)).includes(id), why);
  }
  tick(10);
  assert.equal(ids(await dmsg(P5.joe, 'our group: t.me/delta_group')).length, 0, 'a link to this group');
  rawDatabase().prepare("INSERT INTO aegis_list_entries (chat_id, list, ekey, value, added_by, added_at, updated_by, updated_at) VALUES (?, 'aln', 'docs.org', 'docs.org', 0, 0, 0, 0)").run(DELTA);
  assert.equal(ids(await dmsg(P5.joe, 'read help.docs.org please')).length, 0, 'an allowed site');
  const id = msgId;
  const btnMsg = await dmsg(P5.joe, 'tap', { via_bot: { id: 5, is_bot: true, first_name: 'x' }, reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://promo.xyz' }]] } });
  assert.ok(ids(btnMsg).includes(id), 'a link on a button');
  await moduleOff('antilink');
  tick(30);
});

await scenario('phase 5 — anti-ads / tabchi: a new member\'s first ad; the same ad posted in another group too', async () => {
  await moduleOn('antiads');
  assert.match(olgaScreen().plain, /• Punishment: mute/);
  assert.match(olgaScreen().plain, /• Duration: 1 d/);
  await joinDelta(P5.kim);
  const id = msgId;
  const ad = await dmsg(P5.kim, 'join @promo_deals for free crypto', { entities: [{ type: 'mention', offset: 5, length: 12 }] });
  assert.ok(ids(ad).includes(id));
  assert.equal(sent(ad, 'restrictChatMember')[0].params.until_date, nowS() + 86400);
  assert.match(toChat(ad, DELTA)[0].params.text, /Anti-ads \/ tabchi/);
  tick(10);
  const eps = mock.addChat({ id: EPS, type: 'supergroup', title: 'Eps', botRights: delta.botRights });
  eps.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  eps.members.add(P5.lou.id);
  const epsChat = { id: EPS, type: 'supergroup', title: 'Eps' };
  await botChange(epsChat, Q.olga, 'left', 'administrator', eps.botRights);
  rawDatabase().prepare("INSERT INTO aegis_guards (chat_id, code, enabled, config) VALUES (?, 'antiads', 1, ?)").run(EPS, JSON.stringify({ on: 1, a: 'none', del: 1 }));
  const text = 'Best deals every day at @deal_hub';
  const ent = { entities: [{ type: 'mention', offset: 24, length: 9 }] };
  assert.equal(ids(await gmsg(epsChat, P5.lou, text, ent)).length, 0, 'once is not enough');
  tick(5);
  const xg = msgId;
  assert.ok(ids(await dmsg(P5.lou, text, ent)).includes(xg), 'the same ad in a second group');
  await moduleOff('antiads');
  tick(30);
});

await scenario('phase 5 — suspicious content: invisible characters, look-alike letters, scam text, dangerous files, the same media again', async () => {
  await moduleOn('suspicious');
  for (const [extra, why] of [[{ text: 'hello\u202Eworld' }, 'bidi override'], [{ text: 'Log in to your раypal account' }, 'look-alike letters'],
    [{ text: 'Telegram Support: verify your account here' }, 'scam text'], [{ document: { file_id: 'd', file_unique_id: 'd1', file_name: 'invoice.pdf.exe' } }, 'double extension']]) {
    tick(10);
    const id = msgId;
    assert.ok(ids(await dmsg(P5.lou, extra.text || null, extra)).includes(id), why);
  }
  tick(10);
  const photo = { photo: [{ file_id: 'p', file_unique_id: 'same-photo', width: 1, height: 1 }] };
  assert.equal(ids(await dmsg(P5.oli, null, photo)).length, 0);
  assert.equal(ids(await dmsg(P5.pat, null, photo)).length, 0);
  const third = msgId;
  assert.ok(ids(await dmsg(P5.oli, null, photo)).includes(third), 'the third time in a day');
  assert.equal(ids(await dmsg(P5.oli, 'a normal message, ممنون')).length, 0);
  await moduleOff('suspicious');
  tick(30);
});

await scenario('phase 5 — captcha: newcomers muted until they press the right emoji; wrong presses, others\' presses, admin approval, timeout → kicked', async () => {
  await moduleOn('captcha');
  const j = await joinDelta(P5.moe);
  const muted = sent(j, 'restrictChatMember')[0];
  assert.equal(muted.params.permissions.can_send_messages, false);
  assert.equal(muted.params.until_date, undefined, 'until solved');
  const [cm] = toChat(j, DELTA);
  assert.match(cm.params.text, new RegExp(`👋 <a href="tg://user\\?id=${P5.moe.id}">Moe</a>, welcome!`));
  assert.match(cm.params.text, /press (\S+)/);
  const cap = row("SELECT * FROM aegis_captchas WHERE chat_id = ? AND user_id = ? AND status = 'pending'", DELTA, P5.moe.id);
  const opts = JSON.parse(cap.options);
  const wrong = (Number(cap.answer) + 1) % opts.length;
  assert.equal(cm.params.reply_markup.inline_keyboard.flat().length, 8, 'six emoji + approve + remove');
  const other = await gpress(P5.joe, DELTA, `cp:${cap.id}:${cap.answer}`, midOf(cm));
  assert.match(other.toast, /for someone else/);
  const pending = msgId;
  assert.ok(ids(await dmsg(P5.moe, 'can I talk?')).includes(pending), 'nothing gets through before the captcha');
  const w = await gpress(P5.moe, DELTA, `cp:${cap.id}:${wrong}`, midOf(cm));
  assert.match(w.toast, /Not right/);
  const ok = await gpress(P5.moe, DELTA, `cp:${cap.id}:${cap.answer}`, midOf(cm));
  assert.match(ok.toast, /welcome/);
  assert.equal(sent(ok.calls, 'restrictChatMember')[0].params.permissions.can_send_messages, true);
  assert.ok(ids(ok.calls).includes(midOf(cm)), 'the captcha message goes away');
  assert.equal(row('SELECT status FROM aegis_captchas WHERE id = ?', cap.id).status, 'passed');
  const j2 = await joinDelta(P5.oli);
  const cap2 = row("SELECT * FROM aegis_captchas WHERE chat_id = ? AND user_id = ? AND status = 'pending'", DELTA, P5.oli.id);
  const notAdmin = await gpress(P5.joe, DELTA, `cp:${cap2.id}:ok`, midOf(toChat(j2, DELTA)[0]));
  assert.match(notAdmin.toast, /Only admins/);
  await gpress(Q.abe, DELTA, `cp:${cap2.id}:ok`, midOf(toChat(j2, DELTA)[0]));
  assert.equal(row('SELECT status FROM aegis_captchas WHERE id = ?', cap2.id).status, 'approved');
  await joinDelta(P5.ned);
  tick(200);
  const later = await dmsg(P5.joe, 'anyone here?');
  assert.deepEqual(sent(later, 'banChatMember').map((x) => x.params.user_id), [P5.ned.id], 'not solved in 3 min: kicked');
  assert.equal(sent(later, 'unbanChatMember')[0].params.user_id, P5.ned.id);
  assert.equal(row("SELECT status FROM aegis_captchas WHERE chat_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", DELTA, P5.ned.id).status, 'expired');
  await moduleOff('captcha');
  tick(30);
});

await scenario('phase 5 — join requests: the captcha in private decides the request (approve or decline)', async () => {
  await moduleOn('captcha');
  assert.match(olgaScreen().plain, /• Join requests: ON/);
  mock.joinRequest(DELTA, P5.req.id);
  const r = await run(H.chat_join_request, { chat: deltaChat, from: P5.req, user_chat_id: P5.req.id, date: 0 });
  const [pm] = toChat(r, P5.req.id);
  assert.match(pm.params.text, /You asked to join \u2068Delta\u2069/);
  const cap = row("SELECT * FROM aegis_captchas WHERE chat_id = ? AND user_id = ? AND kind = 'request'", DELTA, P5.req.id);
  const okc = await press(P5.req, `cp:${cap.id}:${cap.answer}`, midOf(pm));
  assert.equal(sent(okc.calls, 'approveChatJoinRequest')[0].params.user_id, P5.req.id);
  assert.match(edits(okc.calls)[0].params.text, /request to join \u2068Delta\u2069 was approved/);
  const j = await joinDelta(P5.req);
  assert.equal(sent(j, 'restrictChatMember').length, 0, 'no second captcha after joining');
  mock.joinRequest(DELTA, P5.rex2.id);
  const r2 = await run(H.chat_join_request, { chat: deltaChat, from: P5.rex2, user_chat_id: P5.rex2.id, date: 0 });
  const cap2 = row("SELECT * FROM aegis_captchas WHERE chat_id = ? AND user_id = ? AND kind = 'request'", DELTA, P5.rex2.id);
  const bad = (Number(cap2.answer) + 1) % JSON.parse(cap2.options).length;
  await press(P5.rex2, `cp:${cap2.id}:${bad}`, midOf(toChat(r2, P5.rex2.id)[0]));
  const no = await press(P5.rex2, `cp:${cap2.id}:${bad}`, midOf(toChat(r2, P5.rex2.id)[0]));
  assert.equal(sent(no.calls, 'declineChatJoinRequest')[0].params.user_id, P5.rex2.id);
  await moduleOff('captcha');
  tick(30);
});

await scenario('phase 5 — quarantine: newcomers send text only for an hour (Telegram lifts it)', async () => {
  await moduleOn('quarantine');
  const j = await joinDelta(P5.pat);
  const q = sent(j, 'restrictChatMember')[0];
  assert.equal(q.params.permissions.can_send_messages, true);
  assert.equal(q.params.permissions.can_send_photos, false);
  assert.equal(q.params.until_date, nowS() + 3600);
  await moduleOff('quarantine');
  tick(30);
});

await scenario('phase 5 — anti-raid: 10 joins in a minute → raid mode (captcha for newcomers), alert with «end»; emergency lock and read-only save and restore permissions', async () => {
  await moduleOn('raid');
  assert.match(olgaScreen().plain, /• During a raid: captcha/);
  tick(120);
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    const u = { id: 810000000 + i, is_bot: false, first_name: `R${i}` };
    delta.members.add(u.id);
    last = await joinDelta(u);
  }
  const [alert] = toChat(last, DELTA).filter((x) => /Raid detected/.test(x.params.text));
  assert.ok(alert, 'raid alert');
  assert.match(alert.params.text, /10 joins within 1 min/);
  assert.match(alert.params.text, /Newcomers must pass a captcha/);
  assert.equal(toChat(last, Q.olga.id).length, 1, 'the creator is told privately');
  assert.ok(sent(last, 'restrictChatMember').some((x) => x.params.permissions.can_send_messages === false), 'the raid\'s own joiner gets a captcha');
  const ld = row("SELECT * FROM aegis_lockdowns WHERE chat_id = ? AND kind = 'raid' AND active = 1", DELTA);
  const end = await gpress(Q.abe, DELTA, `ld:${ld.id}:end`, midOf(alert));
  assert.equal(end.toast, '🔓 Ended.');
  assert.match(toChat(end.calls, DELTA)[0].params.text, /Raid mode ended by \u2068Abe\u2069/);
  await moduleOff('raid');

  delta.permissions = { can_send_messages: true, can_send_photos: false, can_invite_users: true };
  const lock = await dmsg(Q.abe, '/lockdown 10m spam wave');
  const set = sent(lock, 'setChatPermissions')[0];
  assert.equal(set.params.permissions.can_send_messages, false);
  const [msg] = toChat(lock, DELTA);
  assert.match(msg.params.text, /🚨 <b>Emergency lock<\/b> by \u2068Abe\u2069/);
  assert.match(msg.params.text, /Ends in 10 min/);
  assert.match(msg.params.text, /Reason: \u2068spam wave\u2069/);
  assert.equal(toChat(lock, Q.olga.id).length, 1, 'the creator hears about an emergency');
  assert.equal(sent(await dmsg(P5.joe, '/lockdown'), 'setChatPermissions').length, 0, 'members can\'t');
  const off = await dmsg(Q.abe, '/lockdown off');
  assert.deepEqual(sent(off, 'setChatPermissions')[0].params.permissions, { can_send_messages: true, can_send_photos: false, can_invite_users: true },
    'exactly the permissions it had');
  await olga(S('r'));
  assert.match(olgaScreen().plain, /Read-only mode — \u2068Delta\u2069/);
  await olga(S('r:o:0'));
  assert.match(olgaScreen().plain, /Make \u2068Delta\u2069 read-only \(10 min\)\?/);
  const ro = await olga(S('r:y:0'));
  assert.equal(sent(ro.calls, 'setChatPermissions')[0].params.permissions.can_send_messages, false);
  assert.match(toChat(ro.calls, DELTA)[0].params.text, /Read-only mode<\/b> by \u2068Olga\u2069/);
  tick(601);
  const after = await dmsg(Q.abe, 'still there?');
  assert.deepEqual(sent(after, 'setChatPermissions')[0].params.permissions, { can_send_messages: true, can_send_photos: false, can_invite_users: true },
    'put back automatically when the time is up (on the next update)');
  assert.match(toChat(after, DELTA).map((x) => x.params.text).join('\n'), /Read-only mode is over/);
  tick(30);
});

await scenario('phase 5 — risk score: explained alert for a suspicious newcomer; action above the threshold; ❌ undoes and teaches the weights', async () => {
  await moduleOn('risk');
  assert.match(olgaScreen().plain, /• Sensitivity: medium \(alert 40, act 70\)/);
  const fake = { id: 820000001, is_bot: false, first_name: 'Telegram', last_name: 'Support' };
  delta.members.add(fake.id);
  delta.people.set(fake.id, fake);
  const j = await joinDelta(fake);
  const [pm] = toChat(j, Q.olga.id);
  assert.match(pm.params.text, /⚠\uFE0F <b>Risk 50<\/b> — \u2068Telegram Support\u2069 \(alert only\)/);
  assert.match(pm.params.text, /• name imitates an admin or Telegram: \+40/);
  assert.match(pm.params.text, /• no username: \+10/);
  tick(10);
  await joinDelta(P5.ann);
  const id = msgId;
  const m = await dmsg(P5.ann, 'join @cheap_crypto for free airdrop\u200B', { entities: [{ type: 'mention', offset: 5, length: 13 }] });
  assert.ok(ids(m).includes(id));
  assert.equal(sent(m, 'restrictChatMember')[0].params.until_date, nowS() + 86400);
  const [alert] = toChat(m, Q.olga.id);
  assert.match(alert.params.text, /🚫 <b>Risk \d+<\/b> — \u2068Ann\u2069: Aegis acted/);
  assert.match(alert.params.text, /new member posting a link or contact: \+30/);
  const ev = row('SELECT * FROM aegis_risk_events WHERE chat_id = ? ORDER BY id DESC LIMIT 1', DELTA);
  const wrong = await press(Q.olga, `rk:${ev.id}:n`, midOf(alert));
  assert.match(wrong.toast, /undone where possible/);
  assert.equal(sent(wrong.calls, 'restrictChatMember')[0].params.permissions.can_send_messages, true, 'the mute is lifted');
  const w = JSON.parse(row("SELECT config FROM aegis_guards WHERE chat_id = ? AND code = 'risk'", DELTA).config).w;
  assert.equal(w.new_link, 0.8);
  const again = await press(Q.olga, `rk:${ev.id}:y`, midOf(alert));
  assert.match(again.toast, /Already done/);
  await olga(S('k'));
  assert.match(olgaScreen().plain, new RegExp(`${n('Ann')}: \\d+ → acted · wrong`));
  assert.match(olgaScreen().plain, /• new member posting a link or contact: 30 → 24/);
  await olga(S('k:wr'));
  assert.match(olgaScreen().plain, /Back to the default weights/);
  await moduleOff('risk');
  tick(30);
});

await scenario('phase 5 — federation: create, join another group with the code, fed admin, /fban bans in every group (and again on join), /unfban, bans list, leave', async () => {
  await olga(D('F'));
  assert.match(olgaScreen().plain, /A federation is a set of groups sharing one ban list/);
  const ask = await olga(D('F:n'));
  assert.match(sent(ask.calls)[0].params.text, /Send a name for the federation/);
  const made = await olgaSays('Shield');
  assert.match(sent(made)[0].params.text, /Federation \u2068Shield\u2069 created/);
  const fed = row('SELECT * FROM aegis_feds ORDER BY id DESC LIMIT 1');
  assert.ok(sent(made)[0].params.text.includes(`<code>${fed.code}</code>`), 'the owner sees the join code');
  olgaPanel = midOf(sent(made)[0]);
  await olga(`g:${BETA}:F`);
  await olga(`g:${BETA}:F:j`);
  const bad = await olgaSays('NOPE');
  assert.match(sent(bad)[0].params.text, /No federation has that code/);
  const joined = await olgaSays(fed.code.toLowerCase());
  assert.match(sent(joined)[0].params.text, /This group joined \u2068Shield\u2069/);
  olgaPanel = midOf(sent(joined)[0]);
  await olga(D('F:a'));
  await olga(D('F:a:n'));
  const adm = await olgaSays(null, { users_shared: { request_id: 41, users: [{ user_id: Q.abe.id }] } });
  assert.match(sent(adm)[0].params.text, /\u2068Abe\u2069 is now a federation admin/);
  olgaPanel = midOf(sent(adm)[1]);
  assert.equal(sent(await dmsg(P5.joe, '/fban', reply(P5.pat))).length, 0, 'ordinary members: no answer');
  const fb = await gmsg(deltaChat, Q.abe, '/fban scammer', { reply_to_message: { message_id: 1, from: P5.pat, chat: deltaChat, date: 0 } });
  assert.deepEqual(sent(fb, 'banChatMember').map((x) => x.params.chat_id).sort(), [DELTA, BETA].sort());
  assert.match(toChat(fb, DELTA)[0].params.text, /🌐 \u2068Pat\u2069 banned in the federation \u2068Shield\u2069: banned in 2 of 2 groups\. Reason: \u2068scammer\u2069/);
  beta.members.delete(P5.pat.id);
  const back = await adminChange(betaChat, P5.pat, P5.pat, { status: 'left' }, { status: 'member' });
  assert.equal(sent(back, 'banChatMember')[0].params.user_id, P5.pat.id, 'banned again when joining a member group');
  const unf = await gmsg(deltaChat, Q.abe, `/unfban ${P5.pat.id}`);
  assert.equal(sent(unf, 'unbanChatMember').length, 2);
  assert.match(toChat(unf, DELTA)[0].params.text, /unbanned in \u2068Shield\u2069 \(2 of 2 groups\)/);
  await gmsg(deltaChat, Q.abe, '/fban spam bot', { reply_to_message: { message_id: 1, from: P5.ned, chat: deltaChat, date: 0 } });
  await olga(D('F:b'));
  assert.match(olgaScreen().plain, /Bans of \u2068Shield\u2069: 1/);
  assert.match(olgaScreen().plain, new RegExp(`${n('Ned')} — ${P5.ned.id} · \\u2068spam bot\\u2069 · by ${n('Abe')}`));
  const ex = await olga(D('F:x'));
  const doc = mock.get(Q.olga.id, sent(ex.calls, 'sendDocument')[0].result.result.message_id).document;
  assert.match(doc.bytes.toString('utf8'), new RegExp(`\\r\\n${P5.ned.id},Ned,spam bot,${Q.abe.id},`));
  await olga(D(`F:u:${P5.ned.id}`));
  assert.match(olgaScreen().plain, /unbanned in every group of the federation/);
  await olga(`g:${BETA}:F:l`);
  assert.match(olgaScreen().plain, /Take \u2068Beta\u2069 out of \u2068Shield\u2069\?/);
  await olga(`g:${BETA}:F:l:y`);
  assert.match(olgaScreen().plain, /This group left \u2068Shield\u2069/);
  assert.equal(row('SELECT count(*) AS n FROM aegis_fed_chats WHERE fed_id = ?', fed.id).n, 1);
});

await scenario('phase 5 — Audit Mode: security only records (no deletion, punishment, captcha or lock)', async () => {
  rawDatabase().prepare("INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (?, 'audit', '1', 0, 0) ON CONFLICT(chat_id, key) DO UPDATE SET value = '1'").run(DELTA);
  await moduleOn('suspicious');
  await moduleOn('captcha');
  tick(30);
  const r = await dmsg(P5.lou, 'Log in to your раypal account');
  assert.equal(ids(r).length, 0);
  assert.equal(toChat(r, DELTA).length, 0);
  const j = await joinDelta({ id: 830000001, is_bot: false, first_name: 'Quiet' });
  assert.equal(sent(j, 'restrictChatMember').length, 0, 'no captcha in Audit Mode');
  await moduleOff('suspicious');
  await moduleOff('captcha');
  rawDatabase().prepare("UPDATE aegis_chat_settings SET value = '0' WHERE chat_id = ? AND key = 'audit'").run(DELTA);
});

// ---------- phase 6: advanced group settings and forum topics ----------

const P6 = {};
for (const [i, nm] of ['Amy', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal', 'Ida', 'Jon'].entries()) {
  P6[nm.toLowerCase()] = { id: 800000100 + i, is_bot: false, first_name: nm, language_code: 'en', username: `${nm.toLowerCase()}_p6` };
}
const ZETA = -1009900;
const ZNEWS = -1009901;
const ZEV = -1009902;
const zetaChat = { id: ZETA, type: 'supergroup', title: 'Zeta', is_forum: true };
let zeta = null;
const Z = (x) => `g:${ZETA}:${x}`;
const V = (x) => Z(`V${x ? `:${x}` : ''}`);
const zmsg = (u, text, extra = {}) => gmsg(zetaChat, u, text, extra);
const joinZeta = (u, from = u) => {
  zeta.members.add(u.id);
  zeta.people.set(u.id, u);
  return adminChange(zetaChat, from, u, { status: 'left' }, { status: 'member' });
};
const leaveZeta = (u, from = u) => {
  zeta.members.delete(u.id);
  return adminChange(zetaChat, from, u, { status: 'member' }, { status: 'left' });
};
const bulkIds = (calls) => sent(calls, 'deleteMessages').flatMap((c) => c.params.message_ids);
const zset = (key) => (row('SELECT value FROM aegis_chat_settings WHERE chat_id = ? AND key = ?', ZETA, key) || {}).value;
const resetAdv = (...keys) => { for (const k of keys) rawDatabase().prepare('DELETE FROM aegis_chat_settings WHERE chat_id = ? AND key = ?').run(ZETA, k); };
async function adv(key) {
  return olga(V(`s:${key}`));
}
/* Olga answers a prompt of the advanced panel; the screen after it comes as a new message. */
async function olgaInput(button, text, extra = {}) {
  const p = await olga(V(`i:${button}`));
  const prompt = sent(p.calls).find((x) => x.params.chat_id === Q.olga.id);
  const r = await olgaSays(text, extra);
  return { prompt: prompt && prompt.params.text, calls: r, last: sent(r).filter((x) => x.params.chat_id === Q.olga.id).pop() };
}

await scenario('phase 6 — ⚙️ advanced settings: 26 settings in four groups; join / pin notices deleted, leave notices kept', async () => {
  tick(600);
  zeta = mock.addChat({ id: ZETA, type: 'supergroup', title: 'Zeta', isForum: true, count: 25, botRights: { can_manage_chat: true, can_change_info: true,
    can_delete_messages: true, can_restrict_members: true, can_invite_users: true, can_pin_messages: true, can_promote_members: true, can_manage_topics: true } });
  zeta.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  zeta.admins.set(Q.abe.id, { status: 'administrator', user: Q.abe, rights: { can_manage_chat: true, can_delete_messages: true, can_restrict_members: true }, promotedBy: Q.olga.id });
  for (const u of Object.values(P6)) {
    zeta.members.add(u.id);
    zeta.people.set(u.id, u);
  }
  await botChange(zetaChat, Q.olga, 'left', 'administrator', zeta.botRights);
  rawDatabase().prepare('UPDATE aegis_chats SET reminder = 0 WHERE chat_id = ?').run(ZETA);
  const c = await olgaSays('/config');
  olgaPanel = midOf(sent(c)[0]);
  await olga(`g:${ZETA}`);
  await olga(V());
  const home = olgaScreen().plain;
  assert.match(home, /Advanced settings — \u2068Zeta\u2069/);
  assert.match(home, /Cleanup: 0 of 8 on/);
  assert.match(home, /Messages: 0 of 7 on/);
  assert.match(home, /Commands: 3 of 6 on/);
  assert.match(home, /Join and identity: 1 of 5 on/);
  assert.match(home, /Time zone: UTC\+00:00/);
  assert.equal(dataOf(olgaScreen()).filter((d) => /:V:g:/.test(d)).length, 4);
  let total = 0;
  for (const grp of ['clean', 'msg', 'cmd', 'join']) {
    await olga(V(`g:${grp}`));
    total += dataOf(olgaScreen()).filter((d) => /:V:(s:|u$)/.test(d)).length;
  }
  assert.equal(total, 26, 'every advanced setting has its button');
  await olga(V('g:clean'));
  assert.match(olgaScreen().plain, /Delete join notices: OFF\n\s+«X joined» notices are deleted\./);
  await adv('del_join');
  await adv('del_pin');
  assert.match(olgaScreen().plain, /Delete join notices: ON/);
  assert.equal(zset('del_join'), '1');
  const sid = msgId;
  assert.ok(ids(await zmsg(P6.amy, null, { new_chat_members: [P6.amy] })).includes(sid), 'join notice deleted');
  const pid = msgId;
  assert.ok(ids(await zmsg(Q.olga, null, { pinned_message: { message_id: 1, chat: zetaChat, date: 0 } })).includes(pid), 'pin notice deleted');
  assert.equal(ids(await zmsg(P6.amy, null, { left_chat_member: P6.amy })).length, 0, 'leave notices are kept');
  assert.equal(row("SELECT count(*) AS n FROM aegis_audit WHERE action = 'settings.set' AND chat_id = ? AND target = 'del_join'", ZETA).n, 1, 'the change is logged');
});

await scenario('phase 6 — message rules: slow mode, lines, mentions, CAPITALS, junk, length; admins exempt; Audit Mode only records; notices vanish', async () => {
  await olga(V('g:msg'));
  await adv('slow');
  await adv('max_lines');
  await adv('max_mentions');
  await adv('caps');
  await adv('junk');
  assert.match(olgaScreen().plain, /Slow mode: 10 s/);
  assert.match(olgaScreen().plain, /Max lines: 10/);
  await olga(V('g:clean'));
  await adv('notice_ttl');
  assert.match(olgaScreen().plain, /Aegis notices vanish after: 1 min/);
  tick(30);
  assert.equal(ids(await zmsg(P6.bob, 'hello')).length, 0);
  const s2 = msgId;
  const sl = await zmsg(P6.bob, 'again');
  assert.ok(ids(sl).includes(s2), 'slow mode');
  assert.match(toChat(sl, ZETA)[0].params.text, /\u2068Bob\u2069, slow mode: one message every 10 s\./);
  tick(6);
  const soon = msgId;
  assert.ok(ids(await zmsg(P6.bob, 'still too soon')).includes(soon), 'a stopped message does not restart the wait');
  tick(5);
  assert.equal(ids(await zmsg(P6.bob, 'later')).length, 0, '10 s after the last message that went through');
  tick(11);
  const many = msgId;
  assert.ok(ids(await zmsg(P6.cid, Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n'))).includes(many), 'too many lines');
  tick(11);
  const men = msgId;
  assert.ok(ids(await zmsg(P6.cid, '@aa @bb @cc @dd', { entities: [0, 4, 8, 12].map((o) => ({ type: 'mention', offset: o, length: 3 })) })).includes(men), 'mentions');
  tick(11);
  const caps = msgId;
  const capsCalls = await zmsg(P6.dee, 'WHY IS NOBODY ANSWERING ME');
  assert.ok(ids(capsCalls).includes(caps), 'shouting');
  assert.match(toChat(capsCalls, ZETA)[0].params.text, /please don't shout/);
  const notice = midOf(toChat(capsCalls, ZETA)[0]);
  tick(11);
  const junk = msgId;
  assert.ok(ids(await zmsg(P6.dee, '.....!!!')).includes(junk), 'junk');
  tick(11);
  assert.equal(ids(await zmsg(P6.dee, '👍')).length, 0, 'an emoji is content');
  tick(11);
  assert.equal(ids(await zmsg(P6.dee, 'NASA is cool')).length, 0, 'a few capitals are fine');
  assert.equal(ids(await zmsg(Q.abe, 'ADMINS MAY SHOUT AND WRITE FAST')).length, 0, 'admins are exempt');
  assert.equal(ids(await zmsg(Q.abe, 'twice')).length, 0);
  await olga(V('l'));
  await adv('min_len');
  await adv('max_len');
  assert.deepEqual(labelsOf(Q.olga, olgaPanel).slice(0, 2), ['Min characters: 2', 'Max characters: 200']);
  tick(11);
  const short1 = msgId;
  assert.ok(ids(await zmsg(P6.eve, 'k')).includes(short1), 'too short');
  tick(11);
  const long1 = msgId;
  assert.ok(ids(await zmsg(P6.eve, 'x'.repeat(201))).includes(long1), 'too long');
  tick(11);
  rawDatabase().prepare("INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (?, 'audit', '1', 0, 0) ON CONFLICT(chat_id, key) DO UPDATE SET value = '1'").run(ZETA);
  assert.equal(ids(await zmsg(P6.eve, 'AUDIT MODE ONLY RECORDS THIS')).length, 0, 'Audit Mode: nothing deleted');
  resetAdv('audit');
  tick(61);
  const sweep = await olgaSays('/help');
  assert.ok(bulkIds(sweep).includes(notice) || !mock.get(ZETA, notice), 'the notice vanished after a minute');
  resetAdv('slow', 'max_lines', 'max_mentions', 'caps', 'junk', 'min_len', 'max_len', 'notice_ttl');
});

await scenario('phase 6 — late edits are removed (edit window)', async () => {
  await olga(V('g:msg'));
  await adv('edit_window');
  assert.match(olgaScreen().plain, /Edits allowed for: 1 min/);
  const id = msgId;
  await zmsg(P6.fay, 'original');
  const early = await run(H.edited_message, { message_id: id, from: P6.fay, chat: zetaChat, date: 1000, edit_date: 1030, text: 'fixed a typo' });
  assert.equal(ids(early).length, 0);
  const late = await run(H.edited_message, { message_id: id, from: P6.fay, chat: zetaChat, date: 1000, edit_date: 1200, text: 'now a scam link' });
  assert.ok(ids(late).includes(id));
  resetAdv('edit_window');
  tick(10);
});

await scenario('phase 6 — rules, welcome with placeholders and buttons (old one removed), goodbye, preview, /start r_ deep link', async () => {
  await olga(V('u'));
  assert.match(olgaScreen().plain, /No rules have been written yet\./);
  const r = await olgaInput('rules', '1. Be kind\n2. No <spam>');
  assert.match(r.prompt, /Send the group's rules/);
  assert.match(r.last.params.text, /1\. Be kind\n2\. No &lt;spam&gt;/);
  assert.equal(zset('rules'), '1. Be kind\n2. No <spam>');
  await olga(V('w'));
  await adv('welcome_on');
  await adv('goodbye_on');
  assert.match(olgaScreen().plain, /Welcome: ON · goodbye: ON/);
  const w = await olgaInput('welcome_text', 'Hi {name}, welcome to {group}! We are {count}.');
  assert.match(w.prompt, /\{name\}, \{mention\}, \{group\} and \{count\}/, 'the placeholders are shown as they are typed');
  const b = await olgaInput('welcome_btns', 'Site - https://example.org');
  assert.match(b.last.params.text, /Welcome buttons: 1/);
  const bad = await olgaInput('welcome_btns', 'just text');
  assert.ok(bad.last, 'asks again');
  await olgaSays('/cancel');
  await onboard(P6.eve, 'en');
  const j = await joinZeta(P6.eve);
  const greet = toChat(j, ZETA)[0];
  assert.equal(parseHtml(greet.params.text).plain, 'Hi Eve, welcome to Zeta! We are 25.');
  assert.deepEqual(greet.params.reply_markup.inline_keyboard.flat().map((x) => x.url), ['https://example.org', `https://t.me/aegis_test_bot?start=r_${ZETA}`]);
  const j2 = await joinZeta(P6.fay);
  assert.ok(ids(j2).includes(midOf(greet)), 'the previous welcome is removed');
  const bye = await leaveZeta(P6.eve);
  assert.match(toChat(bye, ZETA)[0].params.text, /Goodbye, \u2068Eve\u2069\./);
  const kicked = await leaveZeta(P6.fay, Q.olga);
  assert.equal(toChat(kicked, ZETA).length, 0, 'no goodbye for someone removed by an admin');
  const pv = await olga(V('wp'));
  assert.equal(pv.toast, 'Preview sent below.');
  assert.match(sent(pv.calls).find((x) => x.params.chat_id === Q.olga.id).params.text, /welcome to Zeta! We are 25\./);
  const deep = await dm(P6.eve, `/start r_${ZETA}`);
  assert.match(sent(deep)[0].params.text, /Rules of \u2068Zeta\u2069<\/b>\n\n1\. Be kind\n2\. No &lt;spam&gt;/);
  const g1 = await zmsg(P6.gus, '/rules');
  assert.match(toChat(g1, ZETA)[0].params.text, /Rules of \u2068Zeta\u2069/);
  assert.equal(toChat(g1, ZETA)[0].params.reply_parameters.message_id, msgId - 1);
  assert.match(toChat(await zmsg(P6.gus, 'قوانین'), ZETA)[0].params.text, /1\. Be kind/, 'the Persian word works too');
  for (const u of [P6.eve, P6.fay]) zeta.members.add(u.id);
  resetAdv('welcome_on', 'goodbye_on');
});

await scenario('phase 6 — member commands: /admins, /mywarns, answers in private, members\' commands off, commands deleted after', async () => {
  const a = await zmsg(P6.gus, '/admins');
  assert.match(toChat(a, ZETA)[0].params.text, /Admins of \u2068Zeta\u2069<\/b>\n👑 \u2068Olga\u2069\n• \u2068Abe\u2069/);
  assert.match(toChat(await zmsg(P6.gus, '/mywarns'), ZETA)[0].params.text, /Your warnings here: 0 of 5\./);
  await olga(V('g:cmd'));
  await adv('reply_private');
  const pm = await zmsg(P6.eve, '/rules');
  assert.equal(toChat(pm, ZETA).length, 0);
  assert.match(sent(pm).find((x) => x.params.chat_id === P6.eve.id).params.text, /Rules of \u2068Zeta\u2069/);
  assert.equal(toChat(await zmsg(P6.gus, '/rules'), ZETA).length, 1, 'someone who never started the bot is answered in the group');
  await adv('reply_private');
  await adv('member_cmds');
  assert.equal(toChat(await zmsg(P6.gus, '/rules'), ZETA).length, 0, 'members\' commands off');
  assert.equal(toChat(await zmsg(Q.abe, '/rules'), ZETA).length, 1, 'admins still can');
  await adv('member_cmds');
  await olga(V('g:clean'));
  await adv('del_cmds');
  const cmdId = msgId;
  assert.ok(ids(await zmsg(P6.gus, '/rules')).includes(cmdId), 'the command is deleted once answered');
  resetAdv('del_cmds');
});

await scenario('phase 6 — 🚨 reports: to the admins privately with buttons; mute from the report; handled once; limits; @admin calls', async () => {
  tick(30);
  const target = msgId;
  await zmsg(P6.gus, 'buy cheap followers here');
  const rp = await zmsg(P6.hal, '/report spam', { reply_to_message: { message_id: target, from: P6.gus, chat: zetaChat, date: 0, text: 'buy cheap followers here' } });
  assert.ok(ids(rp).includes(target + 1), 'the /report message itself goes');
  assert.match(toChat(rp, ZETA)[0].params.text, /\u2068Hal\u2069, thanks — the admins have been told\./);
  const toOlga = sent(rp).find((x) => x.params.chat_id === Q.olga.id);
  const toAbe = sent(rp).find((x) => x.params.chat_id === Q.abe.id);
  assert.ok(toOlga && toAbe, 'both admins are told');
  assert.match(toOlga.params.text, /Report in \u2068Zeta\u2069<\/b>\n\u2068Hal\u2069 reported \u2068Gus\u2069\n💬 \u2068buy cheap followers here\u2069\n📝 Reason: \u2068spam\u2069/);
  const rpData = toOlga.params.reply_markup.inline_keyboard.flat().map((x) => x.callback_data || x.url);
  assert.equal(rpData[0], `https://t.me/c/9900/${target}`, 'a link to the reported message');
  const id = row('SELECT id FROM aegis_reports ORDER BY id DESC LIMIT 1').id;
  assert.deepEqual(rpData.slice(1), [`rp:${id}:d`, `rp:${id}:m`, `rp:${id}:b`, `rp:${id}:x`]);
  const mute = await press(Q.olga, `rp:${id}:m`, midOf(toOlga));
  assert.equal(mute.toast, '🔇 Deleted and muted for a day.');
  assert.ok(ids(mute.calls).includes(target));
  assert.equal(sent(mute.calls, 'restrictChatMember')[0].params.user_id, P6.gus.id);
  assert.equal(row('SELECT status, handled_by FROM aegis_reports WHERE id = ?', id).status, 'muted');
  const again = await press(Q.abe, `rp:${id}:x`, midOf(toAbe));
  assert.equal(again.toast, 'Someone already handled this report.');
  tick(6);
  const self = await zmsg(P6.hal, '/report', { reply_to_message: { message_id: 1, from: Q.abe, chat: zetaChat, date: 0, text: 'admin text' } });
  assert.match(toChat(self, ZETA)[0].params.text, /that message can't be reported/);
  tick(6);
  const quick = await zmsg(P6.hal, '/report', { reply_to_message: { message_id: 2, from: P6.ida, chat: zetaChat, date: 0, text: 'x' } });
  assert.match(toChat(quick, ZETA)[0].params.text, /one report per minute/);
  tick(6);
  assert.match(toChat(await zmsg(P6.hal, '/report'), ZETA)[0].params.text, /reply to the message you want to report/);
  await olga(V('r'));
  assert.match(olgaScreen().plain, /Reports: ON · to admins privately/);
  assert.match(olgaScreen().plain, /\u2068Hal\u2069 reported \u2068Gus\u2069: muted/);
  tick(6);
  const call = await zmsg(P6.dee, '@admin someone is spamming');
  assert.match(sent(call).find((x) => x.params.chat_id === Q.olga.id).params.text, /\u2068Dee\u2069 is calling the admins in \u2068Zeta\u2069:\n\u2068@admin someone is spamming\u2069/);
  assert.match(toChat(call, ZETA)[0].params.text, /the admins have been called/);
  tick(60);
  assert.equal(sent(await zmsg(P6.dee, '@admin again')).length, 0, 'once every 5 minutes');
});

await scenario('phase 6 — 📢 forced join and forced add for members (Aegis checks the channel; «I joined» button)', async () => {
  const news = mock.addChat({ id: ZNEWS, type: 'channel', title: 'Zeta News', username: 'zeta_news' });
  news.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  await olga(V('j'));
  assert.match(olgaScreen().plain, /No channels yet\./);
  const r = await olgaInput('fj_add', null, { chat_shared: { request_id: 51, chat_id: ZNEWS } });
  assert.match(r.prompt, /Pick the channel or group members must join/);
  assert.equal(r.calls.find((x) => x.method === 'sendMessage' && /added/.test(x.params.text)).params.reply_markup.remove_keyboard, true);
  assert.deepEqual(JSON.parse(zset('fj_chats')), [{ id: ZNEWS, title: 'Zeta News', username: 'zeta_news', url: 'https://t.me/zeta_news' }]);
  tick(6);
  const id = msgId;
  const stopped = await zmsg(P6.ida, 'hello all');
  assert.ok(ids(stopped).includes(id));
  const note = toChat(stopped, ZETA)[0];
  assert.match(note.params.text, /\u2068Ida\u2069, join our channel first \(1 left\), then press «I joined»\./);
  assert.deepEqual(note.params.reply_markup.inline_keyboard.flat().map((x) => x.url || x.callback_data), ['https://t.me/zeta_news', `fj:${ZETA}`]);
  const still = await gpress(P6.ida, ZETA, `fj:${ZETA}`, midOf(note));
  assert.equal(still.toast, 'You haven\'t joined yet (1 left).');
  join(P6.ida, ZNEWS);
  const okNow = await gpress(P6.ida, ZETA, `fj:${ZETA}`, midOf(note));
  assert.equal(okNow.toast, '✅ Thanks — you can write now.');
  assert.equal(ids(await zmsg(P6.ida, 'hello again')).length, 0);
  assert.equal(ids(await zmsg(Q.abe, 'admins never have to join')).length, 0);
  await olga(V('jr:0'));
  assert.equal(zset('fj_chats'), '[]');
  await adv('fa_n');
  assert.match(olgaScreen().plain, /Forced add: 1/);
  tick(6);
  const jid = msgId;
  const fa = await zmsg(P6.jon, 'can I talk');
  assert.ok(ids(fa).includes(jid));
  assert.match(toChat(fa, ZETA)[0].params.text, /\u2068Jon\u2069, add 1 more members to write here \(needed: 1\)\./);
  await zmsg(P6.jon, null, { new_chat_members: [{ id: 830000600, is_bot: false, first_name: 'Friend' }] });
  assert.equal(ids(await zmsg(P6.jon, 'now I can')).length, 0);
  resetAdv('fa_n');
});

await scenario('phase 6 — 🌙 night lock in the chat\'s time zone: closes now, opens again by itself after the window', async () => {
  await olga(V('z'));
  assert.match(olgaScreen().plain, /Time zone: UTC\+00:00\nFixed offsets/);
  await olga(V(`z:${TZ_OFFSETS.indexOf(0)}`));
  assert.equal(zset('tz'), '0');
  const m = localMinutes(nowS(), 0);
  const from = (m + 1440 - 30) % 1440;
  const to = (m + 30) % 1440;
  const bad = await olgaInput('night_times', 'tonight');
  assert.match(bad.last.params.text, /Send the night hours/);
  const r = await olgaSays(`${fmtTime(from)} - ${fmtTime(to)}`);
  assert.match(sent(r).pop().params.text, new RegExp(`Night lock: OFF · from ${fmtTime(from)} to ${fmtTime(to)} \\(UTC\\+00:00\\)`));
  const on = await adv('night_on');
  const lock = sent(on.calls, 'setChatPermissions')[0];
  assert.equal(lock.params.chat_id, ZETA);
  assert.equal(lock.params.permissions.can_send_messages, false);
  assert.match(toChat(on.calls, ZETA)[0].params.text, new RegExp(`Good night! The group is closed for members until ${fmtTime(to)}\\.`));
  assert.ok(row("SELECT next_at FROM aegis_schedules WHERE chat_id = ? AND kind = 'night'", ZETA).next_at > nowS());
  tick(20 * 60);
  assert.equal(sent(await olgaSays('/help'), 'setChatPermissions').length, 0, 'still night');
  tick(11 * 60);
  const morning = await olgaSays('/help');
  const restore = sent(morning, 'setChatPermissions')[0];
  assert.ok(restore, 'the morning comes without a scheduler');
  assert.equal(restore.params.permissions.can_send_messages, true);
  assert.match(toChat(morning, ZETA)[0].params.text, /Good morning! The group is open again\./);
  const next = row("SELECT next_at FROM aegis_schedules WHERE chat_id = ? AND kind = 'night'", ZETA).next_at;
  assert.ok(next > nowS() && next <= nowS() + 86400, 'the next night is planned');
  await adv('night_on');
  assert.equal((row("SELECT next_at FROM aegis_schedules WHERE chat_id = ? AND kind = 'night'", ZETA) || { next_at: 0 }).next_at, 0, 'nothing planned');
});

await scenario('phase 6 — 🧹 scheduled cleanup and «clean now»; self-destructing media', async () => {
  await olga(V('c'));
  const tooMany = await olgaInput('clean_times', '1 2 3 4 5 6');
  assert.match(tooMany.last.params.text, /At most 5 times\./);
  const at = (localMinutes(nowS(), 0) + 5) % 1440;
  await olgaSays(fmtTime(at));
  assert.equal(zset('clean_times'), JSON.stringify([at]));
  await adv('clean_on');
  tick(10);
  const first = msgId;
  await zmsg(P6.amy, 'one');
  await zmsg(P6.bob, 'two');
  await zmsg(Q.abe, 'an admin message stays');
  tick(6 * 60);
  const run1 = await olgaSays('/help');
  assert.deepEqual(bulkIds(run1).filter((x) => x >= first && x < first + 3).sort(), [first, first + 1]);
  assert.ok(mock.get(ZETA, first + 2), 'admin message kept');
  tick(10);
  const x = msgId;
  await zmsg(P6.cid, 'three');
  await olga(V('cn'));
  assert.match(olgaScreen().plain, /Delete the messages Aegis saw in \u2068Zeta\u2069 in the last 48 hours/);
  const now = await olga(V('cny'));
  assert.ok(bulkIds(now.calls).includes(x));
  assert.match(olgaScreen().plain, /🧹 \d+ messages deleted\./);
  await adv('clean_on');
  await olga(V('g:msg'));
  await adv('media_ttl');
  assert.match(olgaScreen().plain, /Members' media vanish after: 1 h/);
  const ph = msgId;
  await zmsg(P6.dee, null, { photo: [{ file_id: 'z', file_unique_id: 'zeta-photo', width: 1, height: 1 }] });
  tick(1800);
  assert.ok(!bulkIds(await olgaSays('/help')).includes(ph));
  tick(1801);
  assert.ok(bulkIds(await olgaSays('/help')).includes(ph), 'the photo deleted itself after an hour');
  resetAdv('media_ttl', 'clean_on', 'clean_times');
});

await scenario('phase 6 — 📡 event channel (joins, leaves, admins, names), join requests, bots added by members, title lock, linked-channel posts', async () => {
  const ev = mock.addChat({ id: ZEV, type: 'channel', title: 'Zeta Events' });
  ev.admins.set(Q.olga.id, { status: 'creator', user: Q.olga });
  await olga(V('e'));
  assert.match(olgaScreen().plain, /Event channel: not set/);
  const r = await olgaInput('ev_set', null, { chat_shared: { request_id: 53, chat_id: ZEV } });
  assert.match(toChat(r.calls, ZEV)[0].params.text, /This chat now receives the member events of \u2068Zeta\u2069\./);
  assert.equal(zset('ev_chat'), String(ZEV));
  const newbie = { id: 830000700, is_bot: false, first_name: 'Newbie' };
  const j = await joinZeta(newbie);
  assert.match(toChat(j, ZEV)[0].params.text, /📡 \u2068Zeta\u2069\n➕ \u2068Newbie\u2069 joined \(<code>830000700<\/code>\)/);
  const l = await leaveZeta(newbie, Q.olga);
  assert.match(toChat(l, ZEV)[0].params.text, /🚪 \u2068Newbie\u2069 was removed by \u2068Olga\u2069/);
  await olga(V('g:join'));
  await adv('name_watch');
  await zmsg(P6.bob, 'my name is Bob');
  const renamed = await zmsg({ ...P6.bob, first_name: 'Bobby' }, 'now Bobby');
  assert.match(toChat(renamed, ZEV)[0].params.text, /Name change \(<code>800000101<\/code>\): \u2068Bob @bob_p6\u2069 → \u2068Bobby @bob_p6\u2069/);
  await adv('name_watch');
  await adv('jr_mode');
  assert.match(olgaScreen().plain, /Join requests: approve all/);
  mock.joinRequest(ZETA, 830000780);
  const jr = await run(H.chat_join_request, { chat: zetaChat, from: { id: 830000780, is_bot: false, first_name: 'Asker' }, user_chat_id: 830000780, date: 0 });
  assert.equal(sent(jr, 'approveChatJoinRequest')[0].params.user_id, 830000780);
  resetAdv('jr_mode');
  await adv('title_lock');
  assert.equal(zset('title_locked'), 'Zeta');
  zeta.title = 'Spam City';
  const tl = await zmsg(P6.cid, null, { new_chat_title: 'Spam City' });
  assert.equal(sent(tl, 'setChatTitle')[0].params.title, 'Zeta');
  assert.match(sent(tl).find((x) => x.params.chat_id === Q.olga.id).params.text, /\u2068Cid\u2069 changed the title to \u2068Spam City\u2069; Aegis put back \u2068Zeta\u2069\./);
  await adv('title_lock');
  const botUser = { id: 5550001, is_bot: true, first_name: 'Spammy', username: 'spammy_bot' };
  const added = await zmsg(P6.cid, null, { new_chat_members: [botUser] });
  assert.match(sent(added).find((x) => x.params.chat_id === Q.olga.id).params.text, /\u2068Cid\u2069 added \u2068@spammy_bot\u2069\./);
  assert.equal(sent(added, 'banChatMember').length, 0, 'only reported while «remove members\' bots» is off');
  await olga(V('g:join'));
  await adv('bot_kick');
  const kickBot = { id: 5550002, is_bot: true, first_name: 'Adder', username: 'adder_bot' };
  const kicked = await zmsg(P6.cid, null, { new_chat_members: [kickBot] });
  assert.equal(sent(kicked, 'banChatMember')[0].params.user_id, kickBot.id);
  assert.match(sent(kicked).find((x) => x.params.chat_id === Q.olga.id).params.text, /\u2068Cid\u2069 added \u2068@adder_bot\u2069; Aegis removed it/);
  assert.equal(sent(await zmsg(Q.abe, null, { new_chat_members: [{ id: 5550003, is_bot: true, first_name: 'Helper', username: 'helper_bot' }] }), 'banChatMember').length, 0,
    'admins may add bots');
  await adv('bot_kick');
  await olga(V('g:clean'));
  await adv('del_bots');
  tick(6);
  const bid = msgId;
  const bm = await zmsg(botUser, 'buy now');
  assert.ok(ids(bm).includes(bid));
  assert.match(toChat(bm, ZETA)[0].params.text, /Messages of other bots are removed here\./);
  resetAdv('del_bots');
  await olga(V('k'));
  await adv('linked');
  const linked = { id: -1009903, type: 'channel', title: 'Linked' };
  const post = msgId;
  assert.equal(sent(await zmsg(undefined, 'channel post', { sender_chat: linked, is_automatic_forward: true }), 'unpinChatMessage')[0].params.message_id, post);
  await adv('linked');
  const post2 = msgId;
  assert.ok(ids(await zmsg(undefined, 'another post', { sender_chat: linked, is_automatic_forward: true })).includes(post2));
  resetAdv('linked');
});

await scenario('phase 6 — commands of the anonymous admin run once a real admin confirms them', async () => {
  await olga(V('g:cmd'));
  await adv('anon_cmds');
  const anon = { id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' };
  const c = await zmsg(anon, '/ban', { sender_chat: { id: ZETA, type: 'supergroup', title: 'Zeta' }, reply_to_message: { message_id: 3, from: P6.hal, chat: zetaChat, date: 0, text: 'x' } });
  assert.equal(sent(c, 'banChatMember').length, 0, 'nothing runs yet');
  const ask = toChat(c, ZETA)[0];
  assert.match(ask.params.text, /An anonymous admin sent a command/);
  const data = ask.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(data, /^an:\d+$/);
  const no = await gpress(P6.dee, ZETA, data, midOf(ask));
  assert.equal(no.toast, 'Only admins can confirm this.');
  const yes = await gpress(Q.olga, ZETA, data, midOf(ask));
  assert.equal(sent(yes.calls, 'banChatMember')[0].params.user_id, P6.hal.id);
  assert.ok(ids(yes.calls).includes(midOf(ask)));
  const twice = await gpress(Q.olga, ZETA, data, midOf(ask));
  assert.equal(sent(twice.calls, 'banChatMember').length, 0, 'runs once');
  resetAdv('anon_cmds');
});

await scenario('phase 6 — 🗂 topics: create, read-only for members, rename, close, General hide; delete asks first; a group without topics says so', async () => {
  await olga(`g:${BETA}`);
  await olga(B('T'));
  assert.match(olgaScreen().plain, /This group doesn't use topics/);
  await olga(Z('T'));
  assert.match(olgaScreen().plain, /Topics — \u2068Zeta\u2069/);
  assert.match(olgaScreen().plain, /Telegram doesn't let bots list topics/);
  const p = await olga(Z('T:n'));
  assert.match(sent(p.calls).pop().params.text, /Send the topic's name \(up to 128 characters\)\./);
  const made = await olgaSays('Announcements');
  const create = sent(made, 'createForumTopic')[0];
  assert.equal(create.params.name, 'Announcements');
  const tid = create.result.result.message_thread_id;
  assert.match(sent(made).pop().params.text, /Topic \u2068Announcements\u2069 created\./);
  await olga(Z(`T:t:${tid}`));
  assert.match(olgaScreen().plain, /\u2068Announcements\u2069\n\n💬 Open\nMembers can write here\./);
  await olga(Z(`T:t:${tid}:ro`));
  assert.match(olgaScreen().plain, /Read-only: only admins can write here\./);
  tick(6);
  const mid = msgId;
  const ro = await zmsg(P6.amy, 'hello topic', { message_thread_id: tid, is_topic_message: true });
  assert.ok(ids(ro).includes(mid));
  assert.match(toChat(ro, ZETA)[0].params.text, /only admins write in \u2068Announcements\u2069/);
  assert.equal(ids(await zmsg(Q.abe, 'news', { message_thread_id: tid, is_topic_message: true })).length, 0);
  await olga(Z(`T:t:${tid}:c`));
  assert.equal(zeta.topics.get(tid).closed, true);
  assert.match(olgaScreen().plain, /🔒 Closed/);
  await olga(Z(`T:t:${tid}:r`));
  const rn = await olgaSays('News');
  assert.equal(sent(rn, 'editForumTopic')[0].params.name, 'News');
  assert.match(sent(rn).pop().params.text, /Renamed\./);
  await zmsg(Q.abe, null, { message_thread_id: 4242, is_topic_message: true, forum_topic_created: { name: 'Seen elsewhere', icon_color: 1 } });
  await olga(Z('T'));
  assert.match(olgaScreen().plain, /🔒 \u2068News\u2069/);
  assert.match(olgaScreen().plain, /💬 \u2068Seen elsewhere\u2069/);
  await olga(Z('T:g:h'));
  assert.match(olgaScreen().plain, /General hidden\./);
  await olga(Z('T:g:h'));
  assert.match(olgaScreen().plain, /TOPIC_NOT_MODIFIED/, 'Telegram\'s answer is shown');
  await olga(Z(`T:t:${tid}:d`));
  assert.match(olgaScreen().plain, /Delete the topic \u2068News\u2069 with all its messages\?/);
  await olga(Z(`T:t:${tid}:dy`));
  assert.match(olgaScreen().plain, /Topic \u2068News\u2069 deleted\./);
  assert.ok(!zeta.topics.has(tid));
  assert.equal(row('SELECT count(*) AS n FROM aegis_topics WHERE chat_id = ? AND thread_id = ?', ZETA, tid).n, 0);
});

await scenario('phase 6 — in a Persian group the new notices, rules and reports are right-to-left on every line', async () => {
  rawDatabase().prepare("UPDATE aegis_chats SET lang = 'fa' WHERE chat_id = ?").run(ZETA);
  rawDatabase().prepare("INSERT INTO aegis_chat_settings (chat_id, key, value, updated_by, updated_at) VALUES (?, 'caps', '1', 0, 0) ON CONFLICT(chat_id, key) DO UPDATE SET value = '1'").run(ZETA);
  tick(70);
  const caps = await zmsg(P6.amy, 'THIS IS VERY LOUD TEXT');
  assert.match(toChat(caps, ZETA)[0].params.text, /\u2068Amy\u2069/);
  const rules = await zmsg(P6.amy, 'قوانین');
  assert.match(toChat(rules, ZETA)[0].params.text, /قوانین \u2068Zeta\u2069/);
  tick(70);
  const usage = await zmsg(P6.amy, 'گزارش');
  assert.ok(toChat(usage, ZETA)[0], 'the Persian word «گزارش» is the report command');
  resetAdv('caps');
  rawDatabase().prepare("UPDATE aegis_chats SET lang = 'en' WHERE chat_id = ?").run(ZETA);
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
  for (const [u, lang, re] of [[U.dan, 'en', /Hello \u2068Dan &lt;b&gt;\u2069!/], [U.li, 'zh', /你好/], [U.ivan, 'ru', /Здравствуйте/]]) {
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
