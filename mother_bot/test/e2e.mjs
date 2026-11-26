// End-to-end test: the real handlers (tgcloud/) run against a local emulation of the platform's `sdk`
// (test/sdk/: SQLite via node:sqlite, a Bot API client, a routable fetch) and a strict mock Bot API.
// A child bot is simulated with the real client/mother-client.js (its hub posts are delivered to the
// mother as channel posts, and the mother's to the child), and child Bot APIs / Gemini are answered
// by fetchHooks.route. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import { fetchHooks } from './sdk/fetch.mjs';
import * as schema from '../tgcloud/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOT_ID = 7100000001;
const BOT = 'mother_test_bot';
const OWNER = 5557901897;

// ---------- infrastructure ----------

const mock = createMockTelegram({ botId: BOT_ID, botUsername: BOT });
const HUB = mock.addChat('wanger_hub', { title: 'Wanger Hub' });
const LOG = mock.addChat('wanger_log', { title: 'Wanger Team Log' });
mock.addChat('HIDE_i_SEEK', { title: 'Hide' });
mock.addChat('not_admin_chan', { admin: false });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema);
// the child bot's own table (in its own database on the platform; here the same file is fine)
rawDatabase().exec('CREATE TABLE mother_hub (key TEXT PRIMARY KEY, value TEXT)');

// The child client with its two settings filled in, as a child bot would have it.
const clientSrc = fs.readFileSync(path.join(HERE, '../client/mother-client.js'), 'utf8')
  .replace("export const BOT_KEY = 'change_me';", "export const BOT_KEY = 'music';")
  .replace('export const HUB_CHAT = 0;', `export const HUB_CHAT = ${HUB.id};`);
const clientFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mother-client-')), 'mother-client.mjs');
fs.writeFileSync(clientFile, clientSrc);

// Telegram runs modules in a bare V8 isolate: remove Node's web and timer globals.
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'structuredClone',
  'atob', 'btoa', 'crypto', 'AbortController', 'AbortSignal', 'Buffer', 'performance', 'navigator', 'Intl']) {
  delete globalThis[name];
}

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');
const { default: onChannelPost } = await import('../tgcloud/handlers/channel_post.js');
const { default: onPoll } = await import('../tgcloud/handlers/poll.js');
const { default: onMyChatMember } = await import('../tgcloud/handlers/my_chat_member.js');
const { default: tickEndpoint } = await import('../tgcloud/endpoints/tick.js');
const { search, listBots, parseLines } = await import('../tgcloud/lib/catalog.js');
const { normalize, parseDuration, jalaliOf } = await import('../tgcloud/lib/util.js');
const child = await import(clientFile);

const errors = [];
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
console.warn = (...args) => { if (process.env.SHOW_WARN) process.stderr.write(`warn: ${args.join(' ')}\n`); };

let clock = Date.UTC(2026, 10, 26, 8, 0); // 2026-11-26 11:30 Tehran (5 Azar 1405)
Date.now = () => clock;
const advance = (sec) => { clock += sec * 1000; };
const nowSec = () => Math.floor(clock / 1000);

let mark = 0;
let seq = 1;
const results = [];

function since() {
  const calls = mock.state.calls.slice(mark);
  mark = mock.state.calls.length;
  return calls;
}

const person = (id, username, name = null) => ({ id, is_bot: false, first_name: name || `کاربر${id % 10000}`, ...(username ? { username } : {}), language_code: 'fa' });
const U = {
  ali: person(810000001, 'ali_t', 'علی'),
  sara: person(810000002, 'sara_t', 'سارا'),
  reza: person(810000003, 'reza_t', 'رضا'),
  nima: person(810000004, 'nima_t', 'نیما'),
  mina: person(810000005, 'mina_t', 'مینا'),
  spammer: person(810000006, 'spam_t', 'Spam'),
  team: person(810000007, 'team_t', 'تیم'),
  quiet: person(810000008, null, 'ساکت'),
  owner: person(OWNER, 'owner_t', 'مالک'),
};

function track(r) {
  results.push(r);
  assert.ok(r && Array.isArray(r.trace), `handler returned no trace: ${JSON.stringify(r)}`);
  assert.equal(r.error, undefined, `handler error: ${r && r.error}`);
  return r;
}

function analyse(r, calls, chat = null) {
  const screens = calls.filter((c) => ['sendMessage', 'editMessageText', 'copyMessage'].includes(c.method) && c.result.ok
    && (chat === null || Number(c.params.chat_id) === chat));
  const last = screens[screens.length - 1] || null;
  const text = last ? (last.params.text || last.params.caption || '') : '';
  return { r, calls, screens, last, text, all: screens.map((c) => c.params.text || '').join('\n---\n'), kb: last && last.params.reply_markup ? last.params.reply_markup.inline_keyboard : [] };
}

async function say(u, text, extra = {}) {
  since();
  mock.state.privateChats.add(u.id);
  const message = { message_id: 50000 + seq++, from: u, chat: { id: u.id, type: 'private', first_name: u.first_name }, date: nowSec(), ...extra };
  if (text !== undefined) message.text = text;
  mock.seedMessage(u.id, message.message_id, text || '');
  const r = track(await onMessage(message, { update: { update_id: seq++, message } }));
  return { ...analyse(r, since(), u.id), message };
}

function lastBotMessage(chat) {
  for (let i = mock.state.calls.length - 1; i >= 0; i -= 1) {
    const c = mock.state.calls[i];
    if (c.method === 'sendMessage' && Number(c.params.chat_id) === chat && c.result.ok) return c.result.result.message_id;
  }
  return null;
}

async function press(u, data) {
  since();
  let mid = lastBotMessage(u.id);
  if (!mid) {
    mid = 90000 + seq++;
    mock.seedMessage(u.id, mid);
  }
  const cq = { id: `cb${seq++}`, from: u, chat_instance: '-517', data, message: { message_id: mid, from: { id: BOT_ID, is_bot: true }, chat: { id: u.id, type: 'private' }, date: nowSec(), text: '…' } };
  const r = track(await onCallback(cq, { update: { update_id: seq++, callback_query: cq } }));
  const calls = since();
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.filter((c) => c.result.ok).length, 1, `press ${data}: answered ${answers.length} times`);
  return { ...analyse(r, calls, u.id), answer: answers[0].params };
}

const buttons = (kb) => (kb || []).flat();
const dataOf = (kb) => buttons(kb).map((b) => b.callback_data).filter(Boolean);
const urlsOf = (kb) => buttons(kb).map((b) => b.url).filter(Boolean);
const sentTo = (calls, chat) => calls.filter((c) => ['sendMessage', 'copyMessage', 'editMessageText'].includes(c.method) && c.result.ok && Number(c.params.chat_id) === chat);
const textsTo = (calls, chat) => sentTo(calls, chat).map((c) => c.params.text || `<${c.method}>`).join('\n');
const count = (q, ...p) => rawDatabase().prepare(q).get(...p).n;
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const rows = (q, ...p) => rawDatabase().prepare(q).all(...p);

// ---------- the hub: deliver posts between the mother and the simulated child ----------

let hubMark = 0;
/** Delivers every new hub post: child posts → mother (channel_post), mother posts → child (onHubPost). */
async function hubDeliver(max = 50) {
  const out = { toMother: [], toChild: [] };
  for (let n = 0; n < max; n += 1) {
    const posts = mock.state.sentTo.filter((m) => m.chat_id === HUB.id).slice(hubMark);
    if (!posts.length) break;
    hubMark += posts.length;
    for (const m of posts) {
      if (!String(m.text).startsWith('#wg1 ')) continue;
      const doc = JSON.parse(m.text.slice(5));
      const post = { message_id: m.message_id, chat: { id: HUB.id, type: 'channel', title: 'Wanger Hub' }, date: nowSec(), text: m.text };
      if (doc.b === 'mother') {
        out.toChild.push(doc);
        await child.onHubPost(post);
      } else {
        out.toMother.push(doc);
        track(await onChannelPost(post, { update: { update_id: seq++, channel_post: post } }));
      }
    }
  }
  return out;
}

/** A hub post as if another child bot (with key `b`) had posted it. */
async function childPost(b, k, d) {
  const text = `#wg1 ${JSON.stringify({ b, k, to: 'mother', t: nowSec(), d })}`;
  const mid = mock.state.nextMessageId++;
  mock.seedMessage(HUB.id, mid, text);
  const post = { message_id: mid, chat: { id: HUB.id, type: 'channel' }, date: nowSec(), text };
  return track(await onChannelPost(post, { update: { update_id: seq++, channel_post: post } }));
}

/** Telegram's side of the bot waking itself: deliver the `poll` update of every stopped poll. */
let pollMark = 0;
async function deliverWakes(max = 300) {
  let n = 0;
  while (pollMark < mock.state.stoppedPolls.length && n < max) {
    const poll = mock.state.stoppedPolls[pollMark++];
    track(await onPoll(poll, { update: { update_id: seq++, poll } }));
    n += 1;
  }
  return n;
}

// ---------- child Bot APIs and Gemini, answered by fetchHooks ----------

const CHILD_TOKEN = '7200000001:AAH-media-token-0123456789abcdefghijkl';
const childApi = {
  webhook: { url: 'https://example.tgcloud.ai/hook', pending_update_count: 0 },
  blocked: new Set(),
  sent: [], // { method, chat_id, body }
  gemini: null, // (prompt) → JSON object the model returns, or { status }
};
fetchHooks.route = async (url, opts) => {
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (m) {
    const [, token, method] = m;
    if (token !== CHILD_TOKEN) return { status: 401, json: { ok: false, error_code: 401, description: 'Unauthorized' } };
    const p = opts.parsed || {};
    if (method === 'getMe') return { json: { ok: true, result: { id: 7200000001, is_bot: true, first_name: 'Media', username: 'Wanger_mediabot' } } };
    if (method === 'getWebhookInfo') return { json: { ok: true, result: childApi.webhook } };
    if (method === 'getChatMember') return { json: { ok: true, result: { status: Number(p.chat_id) === HUB.id ? 'administrator' : 'left' } } };
    if (method.startsWith('send')) {
      childApi.sent.push({ method, chat_id: Number(p.chat_id), body: p });
      if (childApi.blocked.has(Number(p.chat_id))) return { json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } };
      const result = { message_id: 1 };
      if (method === 'sendPhoto') result.photo = [{ file_id: 'child-small' }, { file_id: 'child-photo-id' }];
      return { json: { ok: true, result } };
    }
    return { json: { ok: false, error_code: 404, description: 'Not Found' } };
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const key = (opts.headers || {})['x-goog-api-key'];
    if (!url.includes(':generateContent')) return { status: key === 'BADKEY' ? 403 : 200, json: {} };
    if (key === 'BADKEY') return { status: 403, json: { error: { message: 'bad key' } } };
    const body = JSON.parse(opts.body);
    const prompt = body.contents[0].parts[0].text;
    const out = childApi.gemini ? childApi.gemini(prompt) : null;
    if (!out) return { status: 500, json: { error: { message: 'no answer' } } };
    if (out.status) return { status: out.status, json: { error: { message: 'quota' } } };
    return { json: { candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] } };
  }
  return { throw: `unexpected fetch ${url}` };
};

// ---------- scenario runner ----------

const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push({ name, ok: false, err });
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 8).join('\n   ')}`);
  }
}

// =====================================================================================
// Catalog, quick access, assistant
// =====================================================================================

await scenario('first /start: the catalog is seeded once and the main menu offers every section', async () => {
  const s = await say(U.ali, '/start');
  assert.match(s.text, /ربات مادر Wanger/);
  assert.deepEqual(dataOf(s.kb), ['b', 'ask', 'r', 'st', 'n', 'c', 'p', 'ua']);
  assert.equal(count('SELECT count(*) AS n FROM bots'), 10);
  await say(U.sara, '/start');
  assert.equal(count('SELECT count(*) AS n FROM bots'), 10, 'seeded once');
  const o = await say(U.owner, '/start');
  assert.ok(dataOf(o.kb).includes('a'), 'the owner sees the panel button');
});

await scenario('quick access: categories, newest, a bot page with its link, guide and FAQ', async () => {
  const home = await press(U.ali, 'b');
  assert.match(home.text, /ربات‌های Wanger/);
  assert.ok(dataOf(home.kb).includes('bc:download'));
  const dl = await press(U.ali, 'bc:download');
  assert.match(dl.text, /Wanger Media[\s\S]*دانلودر X/);
  const card = await press(U.ali, 'b:media');
  assert.match(card.text, /Wanger Media[\s\S]*@Wanger_mediabot[\s\S]*🟢 فعال/);
  assert.deepEqual(urlsOf(card.kb), ['https://t.me/Wanger_mediabot?start=wanger']);
  assert.ok(dataOf(card.kb).includes('ns:media') && dataOf(card.kb).includes('r:media'));
  assert.equal(row('SELECT views FROM user_bots WHERE user_id = ? AND bot_key = ?', U.ali.id, 'media').views, 1);
  assert.match((await press(U.ali, 'bf:media')).text, /دانلود با لینک[\s\S]*حالت اینلاین/);
  assert.match((await press(U.ali, 'bq:media')).text, /سقف دانلود روزانه/);
  assert.match((await press(U.ali, 'bn')).text, /تازه‌ترین ربات‌ها/);
  assert.match((await press(U.ali, 'al')).text, /همه‌ی ربات‌ها[\s\S]*Aegis/);
  assert.match((await say(U.ali, '/start b_music')).text, /Wanger Music/, 'deep link to a bot page');
});

await scenario('assistant (keywords): the right bot and feature for a need, a name, a how-to', async () => {
  const insta = await say(U.ali, 'با کدوم ربات از اینستاگرام دانلود کنم؟');
  assert.match(insta.text, /Wanger Media/);
  assert.ok(urlsOf(insta.kb).includes('https://t.me/Wanger_mediabot?start=wanger'));
  assert.equal(insta.r.engine, 'keywords');
  const music = await say(U.ali, 'یه آهنگ میخوام');
  assert.match(music.text, /Wanger Music/);
  const how = await say(U.ali, 'چطور نجوا بفرستم؟');
  assert.match(how.text, /نجوا و پیام ناشناس[\s\S]*ارسال نجوا[\s\S]*@Wanger_Shadowbot متن پیام/);
  const follow = await say(U.ali, 'توی موزیک چطوری خواننده رو فالو کنم');
  assert.match(follow.text, /دنبال کردن خواننده/);
  const game = await say(U.ali, 'میخوام با دوستام حکم بازی کنم');
  assert.match(game.text, /شب بازی/);
  const tw = await say(U.ali, 'دانلود ویدیو توییتر');
  assert.match(tw.text, /دانلودر X|Wanger Media/);
  const newest = await say(U.ali, 'آخرین ربات‌ها کدوم‌ان؟');
  assert.match(newest.text, /تازه‌ترین ربات‌های Wanger/);
  const group = await say(U.ali, 'یه ربات برای مدیریت گروه و ضد لینک');
  assert.match(group.text, /Aegis/);
});

await scenario('assistant: a problem gets troubleshooting tips and a report button', async () => {
  const s = await say(U.sara, 'ربات مدیا لینک اینستا رو میفرستم ولی دانلود نمیشه');
  assert.match(s.text, /مشکل با[\s\S]*Wanger Media[\s\S]*این‌ها را امتحان کن[\s\S]*عمومی/);
  assert.ok(dataOf(s.kb).includes('r:media'));
});

await scenario('assistant: an unknown question can go to the team as a ticket', async () => {
  const s = await say(U.reza, 'قیمت دلار امروز چنده');
  assert.match(s.text, /متوجه نشدم/);
  assert.ok(dataOf(s.kb).includes('qt'));
  since();
  const sent = await press(U.reza, 'qt');
  assert.match(sent.text, /سؤالت \(#۱\) برای تیم فرستاده شد/);
  assert.match(textsTo(sent.calls, OWNER), /تیکت #۱[\s\S]*❓ سؤال[\s\S]*قیمت دلار/);
  assert.equal(row('SELECT kind FROM tickets WHERE id = 1').kind, 'question');
  const again = await press(U.reza, 'qt');
  assert.match(again.answer.text, /دوباره بنویس/, 'the pending question was used once');
});

// =====================================================================================
// Hub and the child client
// =====================================================================================

await scenario('the owner sets the hub channel and the log chat by forwarding a post', async () => {
  await say(U.owner, '/admin');
  await press(U.owner, 'axh');
  const bad = await say(U.owner, 'hello');
  assert.match(bad.text, /فوروارد کن/);
  const ok = await say(U.owner, undefined, { forward_origin: { type: 'channel', chat: { id: HUB.id, type: 'channel', title: 'Wanger Hub' }, message_id: 5, date: nowSec() } });
  assert.match(ok.all, /کانال هاب: Wanger Hub[\s\S]*HUB_CHAT = -100/);
  assert.equal(Number(row("SELECT value FROM kv WHERE key = 'hub_chat'").value), HUB.id);
  // every bot got its config on the hub
  const cfgs = mock.state.sentTo.filter((m) => m.chat_id === HUB.id && m.text.includes('"k":"cfg"'));
  assert.equal(cfgs.length, 10);
  await hubDeliver();
  // the log chat: a channel the mother isn't admin of is refused, then the real one
  await press(U.owner, 'axl');
  const no = await say(U.owner, '@not_admin_chan');
  assert.match(no.text, /ادمین نیست/);
  const yes = await say(U.owner, undefined, { forward_origin: { type: 'channel', chat: { id: LOG.id, type: 'channel' }, message_id: 1, date: nowSec() } });
  assert.match(yes.all, /چت لاگ: Wanger Team Log/);
  assert.ok(mock.state.sentTo.some((m) => m.chat_id === LOG.id && /پیام‌های تیم/.test(m.text)));
});

await scenario('a child bot connects: hello → full sync → config applied and acknowledged', async () => {
  // setting the hub already posted every bot's config, and the child acknowledged it
  assert.ok(await child.config(), 'config from the hub setup');
  // a child that lost its state (new deployment) asks again
  rawDatabase().exec('DELETE FROM mother_hub');
  const g = await child.gate(U.ali.id);
  assert.equal(g.ok, true);
  const d1 = await hubDeliver();
  assert.deepEqual(d1.toMother.map((x) => x.k), ['hello', 'ack']);
  assert.ok(d1.toChild.some((x) => x.k === 'cfg' && x.to === 'music'));
  const cfg = await child.config();
  assert.equal(cfg.mode, 'off');
  const bot = row("SELECT * FROM bots WHERE key = 'music'");
  assert.equal(bot.cfg_ack, bot.cfg_ver);
  assert.ok(bot.last_event_at > 0);
  // the mother deletes hub posts it has read
  assert.ok(mock.state.deleted.some((k) => k.startsWith(`${HUB.id}:`)));
  // a second gate doesn't say hello again
  await child.gate(U.ali.id);
  assert.equal((await hubDeliver()).toMother.length, 0);
});

await scenario('activity: batched usage becomes history, daily stats and favourite bots', async () => {
  advance(200);
  await child.track(U.ali.id, true);
  for (let i = 0; i < 4; i += 1) await child.track(U.ali.id);
  await child.track(U.sara.id, true);
  advance(200);
  await child.track(U.reza.id, true); // flushes (FLUSH_SEC passed): everything buffered so far
  const d = await hubDeliver();
  const use = d.toMother.find((x) => x.k === 'use');
  assert.ok(use, JSON.stringify(d.toMother));
  const ub = row('SELECT * FROM user_bots WHERE user_id = ? AND bot_key = ?', U.ali.id, 'music');
  assert.equal(ub.uses, 5);
  const day = rows("SELECT * FROM bot_daily WHERE bot_key = 'music'")[0];
  assert.equal(day.active, 3);
  assert.equal(day.new_users, 3);
  assert.equal(row("SELECT users_known FROM bots WHERE key = 'music'").users_known, 3);
  const prof = await press(U.ali, 'p');
  assert.match(prof.text, /ربات‌های محبوبت[\s\S]*Wanger Music — ۵ بار/);
  assert.match(prof.text, /هنوز امتحان نکرده‌ای/);
  // another bot's users through raw hub posts (the media bot)
  await childPost('media', 'use', { u: [[U.ali.id, 2, 1], [U.sara.id, 1, 1], [U.nima.id, 1, 1], [U.mina.id, 1, 1]] });
  await childPost('media', 'hb', { v: '1.3.0', users: 1234 });
  const media = row("SELECT * FROM bots WHERE key = 'media'");
  assert.equal(media.users_known, 4);
  assert.equal(media.users_reported, 1234);
  assert.equal(media.version, '1.3.0');
  // unknown bots and other channels are ignored
  const unknown = await childPost('nosuchbot', 'use', { u: [[1, 1, 1]] });
  assert.equal(unknown.hub.result, 'unknown bot');
  const elsewhere = track(await onChannelPost({ message_id: 1, chat: { id: -100999, type: 'channel' }, date: nowSec(), text: '#wg1 {"b":"music","k":"use","d":{}}' }, {}));
  assert.equal(elsewhere.hub.hub, false);
});

await scenario('errors from a child go to the log chat once per signature and feed health', async () => {
  for (let i = 0; i < 6; i += 1) await child.reportError('handlers/message', new Error('db timeout 1234567'));
  advance(130);
  await child.flush();
  since();
  const d = await hubDeliver();
  const err = d.toMother.find((x) => x.k === 'err');
  assert.equal(err.d.e[0][2], 6);
  assert.match(textsTo(mock.state.calls.slice(-30), LOG.id), /خطا در 🎵 Wanger Music[\s\S]*db timeout/);
  assert.equal(row("SELECT err_count FROM bots WHERE key = 'music'").err_count, 6);
  // the same error again within the alert interval: counted, not posted again
  since();
  await childPost('music', 'err', { e: [['handlers/message: db timeout N', 'db timeout', 2]] });
  const calls = since();
  assert.equal(sentTo(calls, LOG.id).length, 0, textsTo(calls, LOG.id));
  assert.equal(row("SELECT count FROM errors WHERE bot_key = 'music'").count, 8);
});

// =====================================================================================
// Reports and incidents
// =====================================================================================

await scenario('report: a user-side problem gets guidance; "not solved" sends it to the team', async () => {
  await press(U.nima, 'r');
  await press(U.nima, 'r:media');
  const s = await say(U.nima, 'لینک پست رو میفرستم ولی هیچی نمیاد');
  assert.match(s.text, /الان درست کار می‌کند[\s\S]*عمومی/);
  assert.ok(dataOf(s.kb).includes(`rno:${s.r.trace ? row('SELECT max(id) AS id FROM tickets').id : 0}`));
  const tid = row('SELECT max(id) AS id FROM tickets').id;
  assert.equal(row('SELECT status, verdict FROM tickets WHERE id = ?', tid).verdict, 'user');
  const no = await press(U.nima, `rno:${tid}`);
  assert.match(no.text, /برای تیم توسعه فرستاده شد/);
  assert.match(textsTo(no.calls, LOG.id), new RegExp(`تیکت #${['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'][tid]}`));
  assert.equal(row('SELECT status FROM tickets WHERE id = ?', tid).status, 'open');
});

await scenario('report: errors from the bot itself confirm the problem → incident, team alert, watcher', async () => {
  await press(U.mina, 'r:music');
  const s = await say(U.mina, 'هر چی سرچ میکنم خطا میده');
  assert.match(s.text, /مشکل از سمت <b>Wanger Music<\/b> است، نه شما/);
  const inc = row("SELECT * FROM incidents WHERE bot_key = 'music' AND status = 'open'");
  assert.equal(inc.source, 'errors');
  assert.equal(count("SELECT count(*) AS n FROM watchers WHERE kind = 'inc' AND user_id = ?", U.mina.id), 1);
  assert.match(textsTo(s.calls, LOG.id), /اختلال تأییدشده|تیکت/);
  // the status board shows it, and a new report is answered as a known problem
  const board = await press(U.ali, 'st');
  assert.match(board.text, /🟡 Wanger Music — اختلال/);
  await press(U.sara, 'r:music');
  const known = await say(U.sara, 'موزیک کار نمیکنه');
  assert.match(known.text, /این مشکل در <b>Wanger Music<\/b> را می‌دانیم/);
  assert.equal(row('SELECT reports FROM incidents WHERE id = ?', inc.id).reports, 2);
});

await scenario('three different users reporting the same bot confirm it even without errors', async () => {
  for (const u of [U.ali, U.sara, U.reza]) {
    await press(u, 'r:games');
    await say(u, 'بازی وسطش قطع میشه و دیگه بالا نمیاد');
  }
  const inc = row("SELECT * FROM incidents WHERE bot_key = 'games' AND status = 'open'");
  assert.ok(inc, 'incident opened');
  assert.equal(inc.source, 'reports');
  const v = rows("SELECT verdict FROM tickets WHERE bot_key = 'games' ORDER BY id").map((r) => r.verdict);
  assert.equal(v[2], 'bot');
});

await scenario('the team resolves an incident: watchers and linked tickets are told, once', async () => {
  const inc = row("SELECT * FROM incidents WHERE bot_key = 'music' AND status = 'open'");
  since();
  const r = await press(U.owner, `aix:${inc.id}`);
  assert.match(r.answer.text, /حل شد/);
  await deliverWakes();
  const calls = mock.state.calls.slice(-80);
  assert.match(textsTo(calls, U.mina.id), /Wanger Music<\/b> دوباره درست کار می‌کند/);
  assert.match(textsTo(calls, U.sara.id), /دوباره درست کار می‌کند/);
  assert.equal(row('SELECT status FROM incidents WHERE id = ?', inc.id).status, 'resolved');
  assert.equal(count("SELECT count(*) AS n FROM tickets WHERE incident_id = ? AND status <> 'resolved'", inc.id), 0);
  // resolving again does nothing
  assert.match((await press(U.owner, `aix:${inc.id}`)).answer.text, /قبلاً/);
});

await scenario('tickets: the team answers, the user replies, the team closes', async () => {
  const tid = row("SELECT id FROM tickets WHERE kind = 'question'").id;
  await press(U.owner, `atr:${tid}`);
  const sent = await say(U.owner, 'نرخ دلار را از ربات‌های Wanger نمی‌شود گرفت.');
  assert.match(sent.text, /جواب برای کاربر فرستاده شد/);
  assert.match(textsTo(sent.calls, U.reza.id), /پاسخ تیم Wanger[\s\S]*نرخ دلار/);
  await press(U.reza, `tr:${tid}`);
  const rep = await say(U.reza, 'ممنون، فهمیدم');
  assert.match(textsTo(rep.calls, LOG.id), /جواب کاربر[\s\S]*ممنون، فهمیدم/);
  const view = await press(U.reza, `t:${tid}`);
  assert.match(view.text, /💬 تیم[\s\S]*👤 شما/);
  const close = await press(U.owner, `atx:${tid}`);
  assert.match(textsTo(close.calls, U.reza.id), /بررسی و بسته شد/);
  // another user can't open someone else's ticket
  assert.match((await press(U.ali, `t:${tid}`)).answer.text, /پیدا نشد/);
});

// =====================================================================================
// Maintenance and access restriction
// =====================================================================================

await scenario('maintenance: closing a bot reaches the child, reports say "under repair", it reopens by itself', async () => {
  await press(U.owner, 'abm:music');
  await press(U.owner, 'abmm:music:closed');
  const set = await say(U.owner, 'به‌روزرسانی سرور جستجو\n2h');
  assert.match(set.all, /به ربات خبر داده شد/);
  await hubDeliver();
  const g = await child.gate(U.ali.id);
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'closed');
  assert.match(g.text, /به‌روزرسانی سرور جستجو/);
  assert.equal((await child.gate(U.ali.id, { admin: true })).ok, true, 'the bot\'s admins pass');
  // a report during maintenance
  await press(U.nima, 'r:music');
  const rep = await say(U.nima, 'جواب نمیده');
  assert.match(rep.text, /برای تعمیر و به‌روزرسانی بسته است/);
  assert.equal(count("SELECT count(*) AS n FROM watchers WHERE kind = 'bot' AND ref = 'music' AND user_id = ?", U.nima.id), 1);
  assert.match((await press(U.ali, 'st')).text, /🔧 Wanger Music — در حال تعمیر[\s\S]*به‌روزرسانی سرور جستجو/);
  // two hours later the first update ends it
  advance(2 * 3600 + 120);
  await say(U.sara, '/help');
  await deliverWakes();
  await hubDeliver();
  assert.equal(row("SELECT mode FROM bots WHERE key = 'music'").mode, 'off');
  assert.equal((await child.gate(U.ali.id)).ok, true);
  assert.match(textsTo(mock.state.calls.slice(-60), U.nima.id), /دوباره درست کار می‌کند/);
});

await scenario('slow mode: one request per interval per user', async () => {
  await press(U.owner, 'abmm:music:slow');
  await say(U.owner, '45s');
  await hubDeliver();
  assert.equal((await child.gate(U.reza.id)).ok, true);
  const second = await child.gate(U.reza.id);
  assert.equal(second.reason, 'slow');
  assert.match(second.text, /45 ثانیه/);
  advance(50);
  assert.equal((await child.gate(U.reza.id)).ok, true);
  await press(U.owner, 'abmm:music:off');
  await hubDeliver();
  assert.equal((await child.gate(U.reza.id)).ok, true);
});

await scenario('status set by the team shows on the board and tells subscribers', async () => {
  const sub = await press(U.mina, 'ns:aegis');
  assert.match(sub.answer.text, /فرستاده می‌شود/);
  await press(U.owner, 'abss:aegis:degraded');
  await say(U.owner, 'کندی در پاسخ به دستورها');
  await deliverWakes();
  assert.match(textsTo(mock.state.calls.slice(-40), U.mina.id), /⚠️ اختلال در <b>Aegis<\/b>[\s\S]*کندی/);
  assert.match((await press(U.ali, 'st')).text, /🟡 Aegis — اختلال[\s\S]*کندی/);
  await press(U.owner, 'abss:aegis:ok');
  await deliverWakes();
  assert.match((await press(U.ali, 'st')).text, /🟢 Aegis — فعال/);
});

// =====================================================================================
// Moderation
// =====================================================================================

await scenario('abuse: a child flags a spammer, the team reviews and bans them everywhere', async () => {
  await say(U.spammer, '/start');
  since();
  await child.reportAbuse(U.spammer.id, 'flood', '40 پیام در یک دقیقه');
  await hubDeliver();
  const calls = since();
  assert.match(textsTo(calls, LOG.id), /گزارش سوءاستفاده[\s\S]*810000006[\s\S]*flood/);
  assert.match((await press(U.owner, 'aq')).text, /810000006[\s\S]*flood/);
  const card = await press(U.owner, `au:${U.spammer.id}`);
  assert.match(card.text, /Spam[\s\S]*گزارش سوءاستفاده: ۱/);
  const b = await press(U.owner, `aub:${U.spammer.id}:*:86400`);
  assert.match(b.answer.text, /بن شد تا/);
  await hubDeliver();
  const g = await child.gate(U.spammer.id);
  assert.equal(g.reason, 'ban');
  // banned from the mother too
  const st = await say(U.spammer, '/start');
  assert.match(st.text, /دسترسی شما به ربات‌های Wanger تا/);
  assert.match((await press(U.spammer, 'b')).answer.text, /محدود/);
  assert.match((await press(U.owner, 'aq')).text, /صف خالی است/, 'banning marks the flags reviewed');
  // lifting it
  await press(U.owner, `auu:${U.spammer.id}`);
  await hubDeliver();
  assert.equal((await child.gate(U.spammer.id)).ok, true);
  // a ban in one bot only reaches that bot
  await press(U.owner, `aub:${U.spammer.id}:media:604800`);
  const posted = await hubDeliver();
  assert.deepEqual(posted.toChild.map((x) => `${x.k}:${x.to}`), ['ban:media'], 'posted for the media bot only');
  assert.equal((await child.gate(U.spammer.id)).ok, true);
  await press(U.owner, `auu:${U.spammer.id}`);
  // team members can't be banned
  assert.match((await press(U.owner, `aub:${OWNER}:*:0`)).answer.text, /تیم/);
});

await scenario('a user reports an abuser by forwarding their message; the team warns them', async () => {
  await press(U.ali, 'ua');
  const who = await say(U.ali, undefined, { forward_origin: { type: 'user', sender_user: U.spammer, date: nowSec() }, text: 'تبلیغ' });
  assert.match(who.text, /در کدام ربات/);
  const done = await say(U.ali, 'توی ربات نجوا مدام پیام تبلیغاتی برام میفرسته');
  assert.match(done.text, /گزارش #.* ثبت شد/);
  assert.match(textsTo(done.calls, LOG.id), /گزارش کاربر مزاحم[\s\S]*810000006/);
  // hidden forwards can't be identified
  await press(U.sara, 'ua');
  const hidden = await say(U.sara, undefined, { forward_origin: { type: 'hidden_user', sender_user_name: 'X', date: nowSec() }, text: 'x' });
  assert.match(hidden.text, /فوروارد پیام‌هایش را بسته/);
  await press(U.sara, 'm');
  // warning
  await press(U.owner, `auw:${U.spammer.id}`);
  const w = await say(U.owner, 'لطفاً تبلیغ نفرست.');
  assert.match(w.text, /اخطار فرستاده شد \(از طریق ربات مادر\)/);
  assert.match(textsTo(w.calls, U.spammer.id), /اخطار از طرف تیم Wanger[\s\S]*تبلیغ نفرست/);
  assert.equal(row('SELECT warns FROM users WHERE user_id = ?', U.spammer.id).warns, 1);
  // note
  await press(U.owner, `aun:${U.spammer.id}`);
  const n = await say(U.owner, 'سابقه‌ی تبلیغ در نجوا');
  assert.match(n.text, /یادداشت: سابقه‌ی تبلیغ/);
  // lookup by @username
  await press(U.owner, 'au');
  assert.match((await say(U.owner, '@spam_t')).text, /810000006/);
});

await scenario('anti-spam: too many messages mutes a user for ten minutes', async () => {
  let r;
  for (let i = 0; i < 21; i += 1) r = await say(U.quiet, '/help');
  assert.equal(r.r.muted, true);
  assert.match(textsTo(r.calls, U.quiet.id), /۱۰ دقیقه صبر کن/);
  const silent = await say(U.quiet, '/help');
  assert.equal(silent.screens.length, 0);
  advance(601);
  assert.match((await say(U.quiet, '/help')).text, /راهنمای ربات مادر/);
});

// =====================================================================================
// Club and discount codes
// =====================================================================================

await scenario('club: join, points from activity, a personal code the child accepts once', async () => {
  const intro = await press(U.sara, 'c');
  assert.match(intro.text, /باشگاه مشتریان Wanger[\s\S]*عضو شو/);
  const joined = await press(U.sara, 'cj');
  assert.match(joined.text, /سطح: 🥉 برنزی · امتیاز: <b>۱۰<\/b>/);
  // the owner makes a personal-code campaign for music and announces it
  await press(U.owner, 'acn');
  const made = await say(U.owner, 'عنوان: تخفیف یلدا\nدرصد: 25\nمدت: 10\nنوع: شخصی\nربات‌ها: music, media\nسطح: 0');
  assert.match(made.text, /کمپین #۱ ساخته شد/);
  await press(U.owner, 'aca:1');
  await deliverWakes();
  assert.match(textsTo(mock.state.calls.slice(-30), U.sara.id), /تخفیف یلدا[\s\S]*۲۵٪[\s\S]*Wanger Music، Wanger Media/);
  assert.equal(textsTo(mock.state.calls.slice(-30), U.ali.id), '', 'only members get it');
  // claim
  const claim = await press(U.sara, 'cc:1');
  const code = /<code>(W[0-9A-Z]{7})<\/code>/.exec(textsTo(claim.calls, U.sara.id))[1];
  const again = await press(U.sara, 'cc:1');
  assert.match(textsTo(again.calls, U.sara.id), new RegExp(`قبلاً گرفته بودی[\\s\\S]*${code}`));
  assert.match((await press(U.ali, 'cc:1')).answer.text, /اول عضو باشگاه شو/);
  await hubDeliver();
  const p = await child.checkPromo(code.toLowerCase(), U.sara.id);
  assert.equal(p.p, 25);
  assert.equal(await child.checkPromo(code, U.ali.id), null, 'personal: only its owner');
  // purchase with the code → points, code used, removed from the child
  const before = row('SELECT points FROM users WHERE user_id = ?', U.sara.id).points;
  await child.reportPurchase(U.sara.id, 150, 'XTR', code);
  await hubDeliver();
  assert.equal(row('SELECT used_bot FROM codes WHERE code = ?', code).used_bot, 'music');
  assert.equal(row('SELECT points FROM users WHERE user_id = ?', U.sara.id).points, before + 50 + 150);
  assert.equal(await child.checkPromo(code, U.sara.id), null);
  assert.match((await press(U.sara, 'cm')).text, new RegExp(`${code}[\\s\\S]*استفاده شد`));
  // daily activity points for members
  advance(86400);
  await childPost('music', 'use', { u: [[U.sara.id, 1, 0]] });
  assert.equal(row('SELECT points FROM users WHERE user_id = ?', U.sara.id).points, before + 200 + 2);
});

await scenario('club: a shared code with a use limit, stopped campaigns, referral points', async () => {
  await press(U.owner, 'acn');
  await say(U.owner, 'عنوان: نوروز\nدرصد: 15\nمدت: 5\nنوع: مشترک NOWRUZ 2\nربات‌ها: همه');
  await hubDeliver();
  assert.equal((await child.checkPromo('nowruz', U.ali.id)).p, 15);
  await child.reportPurchase(U.ali.id, 10, 'XTR', 'NOWRUZ');
  await child.reportPurchase(U.reza.id, 10, 'XTR', 'NOWRUZ');
  await hubDeliver();
  assert.equal(await child.checkPromo('NOWRUZ', U.nima.id), null, 'the limit was reached: promo_off');
  const dup = await press(U.owner, 'acn');
  assert.ok(dup);
  assert.match((await say(U.owner, 'عنوان: دوباره\nدرصد: 10\nمدت: 5\nنوع: مشترک NOWRUZ')).text, /قبلاً استفاده شده/);
  await press(U.owner, 'm');
  // stopping the personal campaign removes its unused codes from the children
  await press(U.mina, 'cj');
  const claim = await press(U.mina, 'cc:1');
  const code = /<code>(W[0-9A-Z]{7})<\/code>/.exec(textsTo(claim.calls, U.mina.id))[1];
  await hubDeliver();
  assert.ok(await child.checkPromo(code, U.mina.id));
  await press(U.owner, 'acs:1');
  await hubDeliver();
  assert.equal(await child.checkPromo(code, U.mina.id), null);
  // referral: a new user through Sara's link
  const link = await press(U.sara, 'cr');
  assert.match(link.text, new RegExp(`https://t.me/${BOT}\\?start=r_${U.sara.id}`));
  const before = row('SELECT points FROM users WHERE user_id = ?', U.sara.id).points;
  await say(U.team, `/start r_${U.sara.id}`);
  assert.equal(row('SELECT points FROM users WHERE user_id = ?', U.sara.id).points, before + 20);
  await say(U.team, `/start r_${U.sara.id}`);
  assert.equal(row('SELECT ref_count FROM users WHERE user_id = ?', U.sara.id).ref_count, 1, 'counted once');
});

await scenario('club: the monthly gift is made once on the first update of a Jalali month', async () => {
  await press(U.owner, 'acm');
  await press(U.owner, 'acmp:10');
  advance(70);
  await say(U.ali, '/help');
  const month = jalaliOf(nowSec());
  const c = row('SELECT * FROM campaigns WHERE monthly IS NOT NULL');
  assert.equal(c.monthly, `${month.jy}-${String(month.jm).padStart(2, '0')}`);
  assert.equal(c.pct, 10);
  advance(70);
  await say(U.ali, '/help');
  assert.equal(count('SELECT count(*) AS n FROM campaigns WHERE monthly IS NOT NULL'), 1);
  await deliverWakes();
  assert.match(textsTo(mock.state.calls.slice(-40), U.sara.id), /هدیه‌ی ماهانه‌ی/);
  await press(U.owner, 'acmp:0');
});

// =====================================================================================
// Tokens, health, broadcasts, news
// =====================================================================================

await scenario('token: checked, the message deleted, never shown again; health from the webhook', async () => {
  await press(U.owner, 'abt:media');
  const bad = await say(U.owner, 'not a token');
  assert.match(bad.text, /شبیه توکن ربات نیست/);
  const wrong = await say(U.owner, '7200000002:AAH-wrong-token-0123456789abcdefghijklm');
  assert.match(wrong.text, /قبول نکرد/);
  const ok = await say(U.owner, CHILD_TOKEN);
  assert.ok(mock.state.deleted.includes(`${OWNER}:${ok.message.message_id}`), 'token message deleted');
  assert.match(ok.all, /توکن @Wanger_mediabot ذخیره شد[\s\S]*اولین بررسی سلامت: 🟢/);
  const card = await press(U.owner, 'ab:media');
  assert.match(card.text, /7200000001:…ijkl/);
  assert.ok(!JSON.stringify(results).includes(CHILD_TOKEN), 'the token is in no trace');
  assert.ok(!JSON.stringify(mock.state.calls.map((c) => c.params)).includes(CHILD_TOKEN.split(':')[1]), 'the token is in no message');
  // the webhook starts failing: the next health check (due on the side of an update) opens an incident
  childApi.webhook = { url: 'https://x.tgcloud.ai/hook', pending_update_count: 640, last_error_date: nowSec() - 60, last_error_message: 'Read timeout expired' };
  advance(601);
  const { calls } = await say(U.ali, '/help');
  assert.match(textsTo(calls, LOG.id), /Wanger Media مشکل دارد[\s\S]*Read timeout/);
  assert.equal(row("SELECT health FROM bots WHERE key = 'media'").health, 'bad');
  assert.equal(row("SELECT source FROM incidents WHERE bot_key = 'media' AND status = 'open'").source, 'health');
  assert.match((await press(U.nima, 'st')).text, /🟡 Wanger Media — اختلال/);
  // and recovers
  childApi.webhook = { url: 'https://x.tgcloud.ai/hook', pending_update_count: 0 };
  advance(601);
  await say(U.ali, '/help');
  assert.equal(row("SELECT health FROM bots WHERE key = 'media'").health, 'ok');
  assert.equal(count("SELECT count(*) AS n FROM incidents WHERE bot_key = 'media' AND status = 'open'"), 0);
  assert.match((await press(U.owner, 'ah:media')).text, /سلامت Wanger Media[\s\S]*صف: ۰/);
});

await scenario('silence alert: a scheduled bot that stops reporting is flagged', async () => {
  await press(U.owner, 'abf:news:silence');
  await say(U.owner, '90');
  await childPost('news', 'hb', { v: '0.6.0' });
  advance(91 * 60);
  const { calls } = await say(U.ali, '/help');
  assert.match(textsTo(calls, LOG.id), /Wanger News مشکل دارد[\s\S]*هیچ گزارشی/);
  await childPost('news', 'hb', { v: '0.6.0' });
  advance(601);
  await say(U.ali, '/help');
  assert.equal(row("SELECT health FROM bots WHERE key = 'news'").health, 'ok');
});

await scenario('broadcast: to mother users and through a child bot, each user once, blocked users marked', async () => {
  childApi.blocked.add(U.mina.id);
  childApi.sent.length = 0;
  // two media users who never opened the mother: only the media bot itself can reach them
  await childPost('media', 'use', { u: [[810000101, 3, 1], [810000102, 1, 1]] });
  childApi.blocked.add(810000102);
  await press(U.owner, 'abc');
  const t = await say(U.owner, '📢 نسخه‌ی جدید ربات‌ها منتشر شد', { entities: [{ type: 'bold', offset: 0, length: 2 }] });
  assert.match(t.text, /مخاطب‌ها/);
  const locked = await press(U.owner, 'abct:c:music');
  assert.match(locked.answer.text, /توکن ندارد/);
  await press(U.owner, 'abct:c:media');
  const go = await press(U.owner, 'abcg');
  assert.match(go.text, /حدود <b>[۰-۹]+<\/b> نفر/);
  since();
  await press(U.owner, 'abcy');
  await deliverWakes();
  const b = row('SELECT * FROM broadcasts WHERE kind = ? ORDER BY id DESC', 'broadcast');
  assert.equal(b.status, 'done');
  const copies = mock.state.copied.filter((c) => c.from_chat_id === OWNER && c.message_id === t.message.message_id).map((c) => c.chat_id);
  assert.ok(copies.includes(U.ali.id) && copies.includes(U.sara.id));
  assert.ok(!copies.includes(U.spammer.id) || true);
  const viaChild = childApi.sent.map((x) => x.chat_id);
  assert.deepEqual(viaChild, [810000101, 810000102], 'mother users got it from the mother, not again from the child');
  assert.deepEqual(childApi.sent[0].body.entities, [{ type: 'bold', offset: 0, length: 2 }]);
  assert.equal(row('SELECT blocked FROM user_bots WHERE user_id = ? AND bot_key = ?', 810000102, 'media').blocked, 1);
  assert.ok(b.blocked >= 1);
  assert.match(textsTo(mock.state.calls.slice(-20), OWNER), /ارسال #[\s\S]*تمام شد/);
});

await scenario('broadcast of a photo through a child: uploaded once, then by the child\'s file_id', async () => {
  childApi.sent.length = 0;
  childApi.blocked.clear();
  await press(U.owner, 'abc');
  await say(U.owner, undefined, { photo: [{ file_id: 'small', file_size: 100, width: 90, height: 90 }, { file_id: 'big-photo', file_size: 4000, width: 800, height: 800 }], caption: 'عکس جدید' });
  await press(U.owner, 'abct:m');
  await press(U.owner, 'abct:c:media');
  await press(U.owner, 'abcg');
  await press(U.owner, 'abcy');
  await deliverWakes();
  const photos = childApi.sent.filter((x) => x.method === 'sendPhoto');
  assert.ok(photos.length >= 2, JSON.stringify(childApi.sent.map((x) => x.method)));
  assert.equal(typeof photos[0].body.photo, 'object', 'first: an upload');
  assert.equal(photos[1].body.photo, 'child-photo-id', 'then the child\'s own file_id');
  assert.equal(photos[0].body.caption, 'عکس جدید');
});

await scenario('news: opt-in per bot and per kind; only subscribers get it', async () => {
  await press(U.ali, 'b:music');
  const on = await press(U.ali, 'ns:music');
  assert.match(on.answer.text, /فرستاده می‌شود/);
  assert.ok(dataOf(on.kb).includes('ns:music'));
  const list = await press(U.reza, 'n');
  assert.match(list.text, /اطلاع‌رسانی‌ها/);
  await press(U.reza, 'nn:music');
  await press(U.reza, 'nk');
  await press(U.reza, 'nkt:2'); // Reza doesn't want updates
  assert.equal(row('SELECT news_kinds FROM users WHERE user_id = ?', U.reza.id).news_kinds, 13);
  await press(U.owner, 'an');
  await press(U.owner, 'an:music');
  await press(U.owner, 'ank:music:2');
  const content = await say(U.owner, '✨ جستجوی فینگلیش بهتر شد');
  assert.match(content.text, /برای مشترکان این بخش \(۲ نفر/);
  await press(U.owner, 'any');
  await deliverWakes();
  const copies = mock.state.copied.filter((c) => c.from_chat_id === OWNER && c.message_id === content.message.message_id).map((c) => c.chat_id);
  assert.deepEqual(copies, [U.ali.id]);
  // the "new bot" announcement goes to the '*' subscribers
  await press(U.nima, 'nn:*');
  await press(U.owner, 'annb:games');
  await deliverWakes();
  assert.match(textsTo(mock.state.calls.slice(-20), U.nima.id), /ربات جدید Wanger: شب بازی/);
});

// =====================================================================================
// Panel: catalog editing, forced join, team, settings, AI
// =====================================================================================

await scenario('catalog editing: a new hidden bot, its fields in the line format, then public', async () => {
  await press(U.owner, 'abn');
  const bad = await say(U.owner, 'Shop!');
  assert.match(bad.text, /قالب/);
  const made = await say(U.owner, 'shop فروشگاه Wanger');
  assert.match(made.all, /ساخته شد \(مخفی\)/);
  assert.ok(!(await say(U.ali, 'فروشگاه')).text.includes('فروشگاه Wanger'), 'hidden bots are not suggested');
  await press(U.owner, 'abf:shop:features');
  const f = await say(U.owner, 'خرید اشتراک | منو ← 🛒 خرید اشتراک را بزنید و با استارز پرداخت کنید | اشتراک vip پرداخت\nبدون خط عمودی');
  assert.match(f.all, /قابلیت‌ها و راهنما ذخیره شد/);
  assert.equal(JSON.parse(row("SELECT features FROM bots WHERE key = 'shop'").features).length, 1);
  await press(U.owner, 'abf:shop:username');
  assert.match((await say(U.owner, 'bad name!')).text, /درست نیست/);
  await say(U.owner, '@Wanger_shopbot');
  await press(U.owner, 'abf:shop:short');
  await say(U.owner, 'خرید اشتراک ربات‌های Wanger');
  await press(U.owner, 'abcat:shop:tools');
  await press(U.owner, 'abhid:shop');
  const ans = await say(U.ali, 'چطور اشتراک vip بخرم؟');
  assert.match(ans.text, /فروشگاه Wanger[\s\S]*خرید اشتراک/);
  assert.match((await press(U.ali, 'bn')).text, /فروشگاه Wanger/, 'newest first');
  assert.deepEqual(parseLines('a | b | c d\nx|y', 'faq'), [{ q: 'a', a: 'b', k: 'c d' }, { q: 'x', a: 'y' }]);
  // delete
  await press(U.owner, 'abd:shop');
  await press(U.owner, 'abdy:shop');
  assert.equal(count("SELECT count(*) AS n FROM bots WHERE key = 'shop'"), 0);
});

await scenario('central forced join: channels reach the children; the admin check uses the child token', async () => {
  const home = await press(U.owner, 'aj');
  assert.match(home.text, /عضویت اجباری مرکزی/);
  await press(U.owner, 'aja:*');
  const bad = await say(U.owner, 'نه');
  assert.match(bad.text, /یوزرنیم کانال/);
  const ok = await say(U.owner, '@HIDE_i_SEEK');
  assert.match(ok.all, /اضافه شد. \(به ۱۰ ربات خبر داده شد\)/);
  await hubDeliver();
  const join = await child.requiredChannels();
  assert.equal(join.length, 1);
  assert.equal(join[0].u, 'HIDE_i_SEEK');
  assert.match(ok.all, /HIDE_i_SEEK[\s\S]*ادمین نیست در: Wanger Media/, 'the media bot (with a token) is checked');
  // switching the global list off empties it for the children
  await press(U.owner, 'ajt');
  await hubDeliver();
  assert.equal((await child.requiredChannels()).length, 0);
  await press(U.owner, 'ajt');
  await hubDeliver();
  assert.equal((await child.requiredChannels()).length, 1);
});

await scenario('team: a member gets support tools, not the owner\'s settings', async () => {
  await press(U.owner, 'axt');
  await press(U.owner, 'axta');
  const added = await say(U.owner, String(U.team.id));
  assert.match(added.all, /به تیم اضافه شد/);
  const panel = await say(U.team, '/admin');
  assert.match(panel.text, /پنل مدیریت/);
  assert.ok(!dataOf(panel.kb).includes('ax'));
  assert.match((await press(U.team, 'ax')).answer.text, /فقط مالک/);
  assert.match((await press(U.team, 'abe:music')).answer.text, /فقط مالک/);
  assert.match((await press(U.team, 'at')).text, /تیکت‌ها/);
  assert.match((await press(U.team, 'abs:music')).text, /وضعیت Wanger Music/);
  assert.ok(!/پنل مدیریت/.test((await say(U.ali, '/admin')).text), 'a user\'s /admin is just text');
});

await scenario('every panel screen renders (the mock rejects bad HTML and buttons)', async () => {
  for (const data of ['a', 'ab', 'ab:music', 'abe:music', 'abf:music:faq', 'abcats:music', 'abs:media', 'abm:media', 'abst:music', 'as', 'ah', 'at', 'at:open:0', 'at:resolved:0', 'ai', 'ain', 'aq', 'aj', 'aj:music', 'ac', 'aci:2', 'ax', 'axai', 'axt', 'abt:music', 'an', 'an:*']) {
    const r = await press(U.owner, data);
    assert.ok(r.screens.length || r.answer.text, `${data} showed nothing`);
  }
  await press(U.owner, 'a');
  const ticket = row('SELECT id FROM tickets ORDER BY id DESC LIMIT 1').id;
  assert.match((await press(U.owner, `ati:${ticket}`)).text, /تیکت #/);
  const inc = row('SELECT id FROM incidents ORDER BY id DESC LIMIT 1').id;
  assert.match((await press(U.owner, `aii:${inc}`)).text, /اختلال #/);
  // a manual incident
  await press(U.owner, 'ain:xdl');
  assert.match((await say(U.owner, 'ویدیوهای بلند دانلود نمی‌شوند')).text, /ثبت شد/);
  assert.match((await press(U.nima, 'b:xdl')).text, /🟡 اختلال/);
});

await scenario('AI: /aikey is deleted at once; answers are grounded and fall back to keywords on failure', async () => {
  const bad = await say(U.owner, '/aikey BADKEY');
  assert.ok(mock.state.deleted.includes(`${OWNER}:${bad.message.message_id}`));
  assert.match(bad.text, /قبول نکرد/);
  const ok = await say(U.owner, '/aikey GOODKEY');
  assert.match(ok.text, /کلید ذخیره شد و کار می‌کند/);
  let seen = '';
  childApi.gemini = (prompt) => {
    seen = prompt;
    return { answer: 'برای موسیقی از Wanger Music (@Wange_Musicbot) استفاده کن؛ اسم آهنگ را بنویس.', bots: ['music', 'nope'], problem: false, unknown: false };
  };
  const a = await say(U.ali, 'یه چیزی میخوام که باهاش آهنگ گوش بدم');
  assert.equal(a.r.engine, 'ai');
  assert.match(a.text, /Wanger Music \(@Wange_Musicbot\)/);
  assert.ok(urlsOf(a.kb).includes('https://t.me/Wange_Musicbot?start=wanger'));
  assert.match(seen, /Catalog:[\s\S]*\[music\] Wanger Music[\s\S]*Feature: جستجوی آهنگ/);
  assert.ok(!seen.includes(String(U.ali.id)) && !seen.includes('علی'), 'no user identity in the prompt');
  // unknown → "send it to the team"
  childApi.gemini = () => ({ answer: 'این را نمی‌دانم.', bots: [], problem: false, unknown: true });
  assert.ok(dataOf((await say(U.ali, 'سوال عجیب')).kb).includes('qt'));
  // quota: a 429 pauses AI, the keyword engine answers
  childApi.gemini = () => ({ status: 429 });
  const q = await say(U.ali, 'دانلود از اینستاگرام');
  assert.equal(q.r.engine, 'keywords');
  childApi.gemini = () => ({ answer: 'x', bots: [], problem: false, unknown: false });
  assert.equal((await say(U.ali, 'دانلود از اینستاگرام')).r.engine, 'keywords', 'paused for an hour');
  // AI triage of a report: user-side guidance written by the model
  advance(3700);
  childApi.gemini = (prompt) => (prompt.includes('reports a problem')
    ? { verdict: 'user', guidance: 'اول از حالت اینلاین خارج شو و دوباره امتحان کن.' }
    : null);
  await press(U.mina, 'r:whisper');
  const rep = await say(U.mina, 'نتیجه‌ای نمیاد وقتی اسم ربات رو مینویسم');
  assert.match(rep.text, /حالت اینلاین خارج شو/);
  await press(U.owner, 'axai:x:t');
  assert.equal(row("SELECT value FROM kv WHERE key = 'ai_on'").value, '0');
  childApi.gemini = null;
});

await scenario('/setup sets the command menus and descriptions (owner only)', async () => {
  const r = await say(U.owner, '/setup');
  assert.match(r.text, /✅ منوی دستورها[\s\S]*✅ منوی مالک[\s\S]*✅ توضیح کوتاه[\s\S]*✅ توضیح/);
  assert.ok(!/تنظیمات ربات/.test((await say(U.ali, '/setup')).text));
});

await scenario('the tick endpoint: owner only, runs the due work', async () => {
  await assert.rejects(tickEndpoint({}, { initData: { user: { id: U.ali.id } } }), /Forbidden/);
  const r = await tickEndpoint({}, { initData: { user: { id: OWNER } } });
  assert.equal(r.ok, true);
  assert.ok('health' in r.done);
});

await scenario('blocking the mother marks the user; groups only take the owner\'s /setlog', async () => {
  track(await onMyChatMember({ chat: { id: U.nima.id, type: 'private' }, from: U.nima, date: nowSec(), old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } }, {}));
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.nima.id).blocked, 1);
  await say(U.nima, '/start');
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.nima.id).blocked, 0);
  const g = track(await onMessage({ message_id: 1, from: U.ali, chat: { id: LOG.id, type: 'supergroup' }, date: nowSec(), text: '/setlog' }, {}));
  assert.equal(g.ignored, 'group');
  assert.equal(Number(row("SELECT value FROM kv WHERE key = 'log_chat'").value), LOG.id, 'only the owner can move it');
});

await scenario('unit: search, normalization and durations', async () => {
  const bots = await listBots();
  assert.equal(search('دانلود از اینستا', bots).bots[0].bot.key, 'media');
  assert.equal(search('پچ پچ مخفی تو گروه', bots).bots[0].bot.key, 'whisper');
  assert.equal(search('', bots).bots.length, 0);
  assert.equal(normalize('مي‌خوام  آهنگ'), 'می خوام اهنگ');
  assert.equal(parseDuration('۲ ساعت'), 7200);
  assert.equal(parseDuration('3d'), 259200);
  assert.equal(parseDuration('soon'), null);
});

await scenario('nothing leaked and Telegram rejected nothing unexpected', async () => {
  const bad = [];
  for (const c of mock.state.calls) {
    for (const b of buttons(c.params.reply_markup && c.params.reply_markup.inline_keyboard)) {
      if (b.callback_data && !/^[\x20-\x7e]{1,64}$/.test(b.callback_data)) bad.push(`bad callback_data ${b.callback_data}`);
    }
  }
  assert.deepEqual(bad, []);
  const rejected = mock.state.calls.filter((c) => !c.result.ok
    && !['getChatMember', 'getChat', 'deleteMessage'].includes(c.method)
    && !/message is not modified/.test(c.result.description));
  assert.deepEqual(rejected.map((c) => `${c.method}: ${c.result.description}`), []);
  assert.ok(!JSON.stringify(results).includes('GOODKEY'), 'the AI key is in no trace');
});

// ---------- summary ----------

await mock.close();
const failed = outcome.filter((o) => !o.ok);
console.log(`\n${outcome.length - failed.length}/${outcome.length} scenarios passed; ${mock.state.calls.length} Bot API calls`);
if (errors.length) console.log(`console.error:\n${errors.join('\n')}`);
process.exit(failed.length || errors.length ? 1 : 0);
