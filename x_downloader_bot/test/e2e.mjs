// End-to-end scenarios against the local emulation: the real handlers, an in-memory SQLite created
// from tgcloud/schema.js, a mock Bot API (test/mock-telegram.mjs) and a mock X/twimg built from
// real captured responses (test/mock-x.mjs).
//   node --import ./test/sdk/register.mjs test/e2e.mjs
import { setupDatabase, db } from './sdk/db.mjs';
import { createMockTelegram } from './mock-telegram.mjs';
import { createMockX, FAKE, POSTS } from './mock-x.mjs';
import * as schema from '../tgcloud/schema.js';

const BOT_ID = 7000000001;
const OWNER = 5557901897;
const U1 = 990000001; // member of every channel
const U2 = 990000002; // member of none
const U3 = 990000003; // restricted but still a member
const BCAST = [990000011, 990000012, 990000013, 990000014, 990000015]; // broadcast audience
const BLOCKER = 990000013; // blocked the bot -> 403

const tg = createMockTelegram({ botId: BOT_ID });
const x = createMockX();
process.env.TG_MOCK_URL = `http://127.0.0.1:${await tg.listen()}`;
process.env.X_MOCK_URL = `http://127.0.0.1:${await x.listen()}`;
setupDatabase(schema);

const { default: onMessage } = await import('../tgcloud/handlers/message.js');
const { default: onCallback } = await import('../tgcloud/handlers/callback_query.js');

for (const [name, title] of [['HIDE_i_SEEK', 'HIDE'], ['Nepenthw_ir', 'Nepenthe'], ['wangerBots', 'Wanger Bots']]) tg.addChat(name, { title });
tg.addChat('extra_chan', { title: 'Extra' });
tg.addChat('noadmin_chan', { title: 'No admin', admin: false });
for (const u of [OWNER, U1, U2, U3, ...BCAST]) tg.state.users.add(u);
for (const ch of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) {
  tg.setMember(ch, U1, { status: 'member' });
  tg.setMember(ch, U3, { status: 'restricted', is_member: true });
  for (const u of BCAST) tg.setMember(ch, u, { status: 'member' });
}

// ---------- payloads ----------

let seq = 1;
const now = () => Math.floor(Date.now() / 1000);
const person = (id) => ({ id, is_bot: false, first_name: id === OWNER ? 'Owner' : `Tester${id % 100}`, username: `t${id % 1000}`, language_code: 'fa' });
const chat = (id) => ({ id, first_name: person(id).first_name, type: 'private' });

async function text(uid, body, ctx = {}) {
  const message = { message_id: 100000 + seq, from: person(uid), chat: chat(uid), date: now(), text: body };
  const cmd = /^\/[A-Za-z0-9_]+/.exec(body);
  if (cmd) message.entities = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  seq += 1;
  return wrap(await onMessage(message, { update: { update_id: seq, message }, ...ctx }));
}

async function photoMessage(uid, caption) {
  const message = { message_id: 100000 + seq, from: person(uid), chat: chat(uid), date: now(), photo: [{ file_id: 'OWNERPHOTO', file_unique_id: 'u', width: 800, height: 600 }], caption };
  seq += 1;
  return wrap(await onMessage(message, { update: { update_id: seq, message } }));
}

async function press(uid, data, { media = false, ctx = {}, messageId } = {}) {
  const msg = { message_id: messageId || 200000 + seq, from: { id: BOT_ID, is_bot: true, first_name: 'Bot' }, chat: chat(uid), date: now() - 30 };
  if (media) Object.assign(msg, { video: { file_id: 'V', file_unique_id: 'v', width: 720, height: 1280, duration: 41 }, caption: '…' });
  else msg.text = '…';
  const cq = { id: `${4000000000000 + seq}`, from: person(uid), message: msg, chat_instance: '-517', data };
  seq += 1;
  return wrap(await onCallback(cq, { update: { update_id: seq, callback_query: cq }, ...ctx }));
}

function wrap(out) {
  const trace = (out && out.trace) || [];
  const screens = trace.filter((t) => ['sendMessage', 'editMessageText'].includes(t.m) && t.view !== 'owner_warning' && t.view !== 'bc_progress');
  const last = screens[screens.length - 1] || null;
  const kbData = last && last.kb ? last.kb.flat().map((b) => (b.match(/\[([^\]]+)\]$/) || [])[1]).filter(Boolean) : [];
  return {
    out,
    trace,
    view: last && last.view,
    text: (last && last.text) || '',
    kbData,
    kbUrls: last && last.kb ? last.kb.flat().filter((b) => b.includes(' -> ')) : [],
    media: trace.filter((t) => /^send(Video|Photo|Animation|Document|MediaGroup)$/.test(t.m)),
    answers: trace.filter((t) => t.m === 'answerCallbackQuery'),
    error: !out || out.error || trace.some((t) => t.view === 'error'),
  };
}

// ---------- tiny runner ----------

const results = [];
class Fail extends Error {}
const expect = (cond, msg) => {
  if (!cond) throw new Fail(msg);
};
async function scenario(name, fn) {
  let status = 'PASS';
  let detail = '';
  try {
    detail = (await fn()) || '';
  } catch (err) {
    status = 'FAIL';
    detail = err instanceof Fail ? err.message : String(err.stack || err);
  }
  results.push({ name, status });
  console.log(`${status === 'PASS' ? '✔' : '✘'} ${status}  ${name}${detail ? `\n         ${String(detail).split('\n').join('\n         ')}` : ''}`);
}
const okScreen = (r, view) => {
  expect(!r.error, `handler error: ${JSON.stringify(r.trace.slice(-3))}`);
  if (view) expect(r.view === view, `expected view ${view}, got ${r.view}: ${r.text.slice(0, 160)}`);
  return r;
};
const answeredOnce = (r) => expect(r.answers.length === 1, `answerCallbackQuery called ${r.answers.length} times`);
const cool = (uid) => db.run('UPDATE users SET last_req = 0, busy_until = 0 WHERE id = :id', { ':id': uid });
const link = (p, extra = '') => `https://x.com/${p.user}/status/${p.id}${extra}`;
const row = (q, p) => db.get(q, p);

// ---------- scenarios ----------

await scenario('/start as a non-member -> join screen (channels seeded, link buttons + ✅ عضو شدم)', async () => {
  const r = okScreen(await text(U2, '/start'), 'join');
  expect(r.kbUrls.length === 3, `expected 3 channel buttons, got ${r.kbUrls.join(' | ')}`);
  expect(r.kbUrls.every((u) => /https:\/\/t\.me\/(HIDE_i_SEEK|Nepenthw_ir|wangerBots)$/.test(u.split(' -> ')[1])), 'link buttons point at t.me/<channel>');
  expect(r.kbData.includes('j'), 'has the ✅ عضو شدم button');
  const n = (await row('SELECT count(*) AS n FROM channels')).n;
  expect(n === 3, `channels seeded: ${n}`);
  const u = await row('SELECT first_seen, active FROM users WHERE id = :id', { ':id': U2 });
  expect(u && u.first_seen > 0 && u.active === 1, 'user recorded on /start');
  return `buttons: ${r.kbUrls.map((b) => b.split(' -> ')[1]).join(', ')}`;
});

await scenario('/start as the owner -> menu with the admin button, no membership check', async () => {
  const r = okScreen(await text(OWNER, '/start'), 'menu');
  expect(!r.trace.some((t) => t.m === 'getChatMember'), 'owner is never checked');
  expect(r.kbData.includes('a'), 'owner sees 👑 پنل مدیریت');
});

await scenario('member / restricted+is_member pass; "✅ عضو شدم" re-check after joining', async () => {
  okScreen(await text(U1, '/start'), 'menu');
  okScreen(await text(U3, '/start'), 'menu');
  const still = await press(U2, 'j');
  answeredOnce(still);
  expect(still.view === 'join' && still.answers[0].text.includes('هنوز'), 'still not a member');
  for (const ch of ['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']) tg.setMember(ch, U2, { status: 'member' });
  tg.setMember('wangerBots', U2, { status: 'kicked' });
  const partial = await press(U2, 'j');
  expect(partial.view === 'join' && partial.kbUrls.length === 1, 'kicked counts as not joined (1 channel left)');
  tg.setMember('wangerBots', U2, { status: 'member' });
  const done = await press(U2, 'j');
  answeredOnce(done);
  expect(done.view === 'menu', `menu after joining, got ${done.view}`);
});

await scenario('a channel the bot is not admin in is skipped; the owner is warned once', async () => {
  tg.state.botAdmin.delete('@wangerbots');
  const r1 = await text(U1, '/help');
  const r2 = await text(U1, '/help');
  tg.state.botAdmin.add('@wangerbots');
  okScreen(r1, 'help');
  okScreen(r2, 'help');
  const warn1 = r1.trace.filter((t) => t.view === 'owner_warning' && t.chat === OWNER);
  const warn2 = r2.trace.filter((t) => t.view === 'owner_warning');
  expect(warn1.length === 1 && warn2.length === 0, `warnings: ${warn1.length} then ${warn2.length}`);
});

await scenario('video post -> downloaded from twimg and uploaded with sendVideo; caption; file_id cached', async () => {
  x.reset();
  const r = okScreen(await text(U1, link(POSTS.video)));
  const v = r.media.find((m) => m.m === 'sendVideo');
  expect(v && v.ok && v.src === 'download+upload', `sendVideo: ${JSON.stringify(v)}`);
  expect(v.q === '720x1280', `auto quality = 720p, got ${v.q}`);
  expect(v.caption.includes('@NASA') && v.caption.includes('https://x.com/NASA/status/2118034216503955710') && v.caption.includes('spacewalk'), 'caption has text, author, link');
  expect(v.kb && v.kb.flat().some((b) => b.includes('[qp:2118034216503955710]')), 'video has 🎚 کیفیت‌های دیگر');
  expect(x.downloads().length === 1, `one download, got ${x.downloads().length}`);
  const c = await row("SELECT file_id FROM file_cache WHERE post_id = '2118034216503955710' AND q = '720x1280'");
  expect(c && c.file_id, 'file_id cached');
  expect(r.trace.some((t) => t.m === 'deleteMessage'), 'progress message removed');
  return `api: ${r.out.api.map((a) => `${a.api}#${a.attempt}=${a.result}`).join(', ')} · bytes=${v.bytes}`;
});

await scenario('same link again -> resent from cache: no API call, no download', async () => {
  await cool(U1);
  x.reset();
  const r = okScreen(await text(U1, link(POSTS.video, '?s=20')));
  const v = r.media.find((m) => m.m === 'sendVideo');
  expect(v && v.ok && v.src === 'file_id', `expected file_id resend, got ${JSON.stringify(v)}`);
  expect(x.apiCalls('fx').length === 0 && x.apiCalls('vx').length === 0, 'no API call');
  expect(x.state.requests.length === 0, `no twimg request at all, got ${x.state.requests.length}`);
  const d = await row("SELECT cache_hits FROM daily ORDER BY day DESC LIMIT 1");
  expect(d.cache_hits >= 1, 'counted as a cache hit');
});

await scenario('multi-photo post -> one album (sendMediaGroup, original size) + 🖼 original files button', async () => {
  await cool(U1);
  const r = okScreen(await text(U1, link(POSTS.photos)));
  const album = r.media.find((m) => m.m === 'sendMediaGroup');
  expect(album && album.ok && album.media.length === 3 && album.media.every((m) => m.startsWith('photo:upload')), `album: ${JSON.stringify(album)}`);
  const getUrls = x.downloads().map((d) => d.path);
  expect(getUrls.every((p) => p.includes('name=orig')), `orig sizes: ${getUrls.join(', ')}`);
  const actions = r.trace.find((t) => t.view === 'post_actions');
  expect(actions && actions.kb.flat().some((b) => b.includes('[pd:2112592291147747809]')), 'actions message with pd button');
  await cool(U1);
  const docs = await press(U1, 'pd:2112592291147747809');
  answeredOnce(docs);
  const da = docs.media.find((m) => m.m === 'sendMediaGroup');
  expect(da && da.ok && da.media.every((m) => m.startsWith('document:upload')), `photos as documents: ${JSON.stringify(da)}`);
});

await scenario('GIF post -> sendAnimation (not a plain video)', async () => {
  await cool(U1);
  const r = okScreen(await text(U1, link(POSTS.gif)));
  const a = r.media.find((m) => m.m === 'sendAnimation');
  expect(a && a.ok && a.q === 'gif', `sendAnimation: ${JSON.stringify(r.media)}`);
  expect(!r.media.some((m) => m.m === 'sendVideo'), 'no sendVideo');
});

await scenario('text-only post -> clear Persian "no media" message (FxTwitter, then vxTwitter checked)', async () => {
  await cool(U1);
  const r = okScreen(await text(U1, link(POSTS.text)), 'download_failed');
  expect(r.text.includes('فقط متن'), r.text);
  expect(r.out.api.some((a) => a.api === 'vx'), 'vxTwitter consulted for "no media"');
});

await scenario('deleted / missing post -> "پیدا نشد"', async () => {
  await cool(U1);
  const r = okScreen(await text(U1, link(POSTS.missing)), 'download_failed');
  expect(r.text.includes('پیدا نشد'), r.text);
});

await scenario('private account (FxTwitter 401) -> "حساب خصوصی"', async () => {
  await cool(U1);
  const r = okScreen(await text(U1, `https://x.com/someone/status/${FAKE.private}`), 'download_failed');
  expect(r.text.includes('خصوصی'), r.text);
});

await scenario('API returns a non-twimg media URL -> refused, never requested (SSRF guard)', async () => {
  await cool(U1);
  x.reset();
  const r = okScreen(await text(U1, `https://x.com/someone/status/${FAKE.evil}`), 'download_failed');
  expect(r.text.includes('twimg'), r.text);
  expect(r.media.length === 0, 'nothing sent');
});

await scenario('every link format resolves to the same post', async () => {
  const id = POSTS.video.id;
  const forms = [`https://twitter.com/NASA/status/${id}?s=46&t=xyz`, `https://mobile.twitter.com/NASA/status/${id}`,
    `https://fxtwitter.com/NASA/status/${id}`, `https://fixupx.com/NASA/status/${id}/video/1`, `https://vxtwitter.com/NASA/status/${id}`,
    `https://fixvx.com/NASA/status/${id}`, `https://x.com/i/web/status/${id}`];
  for (const f of forms) {
    await cool(OWNER);
    const r = okScreen(await text(OWNER, f));
    expect(r.out.results && r.out.results[0].id === id && r.out.results[0].ok, `${f}: ${JSON.stringify(r.out.results)}`);
  }
  return `${forms.length} formats OK`;
});

await scenario('FxTwitter down -> one retry, then vxTwitter answers (fallback), counted in stats', async () => {
  await cool(U1);
  x.state.fxDown = true;
  const r = okScreen(await text(U1, link(POSTS.gif).replace(POSTS.gif.id, POSTS.gif.id)));
  x.state.fxDown = false;
  // gif is already stored, so use the ctx simulation too: it bypasses the stored post.
  await cool(U1);
  const s = okScreen(await text(U1, link(POSTS.photos), { simulate: { fx: 'down' } }));
  const fxTries = s.out.api.filter((a) => a.api === 'fx');
  const vxTries = s.out.api.filter((a) => a.api === 'vx');
  expect(fxTries.length === 2 && fxTries.every((a) => a.result === 'network_error'), `fx attempts: ${JSON.stringify(fxTries)}`);
  expect(vxTries.length === 1 && vxTries[0].result === 'ok', `vx: ${JSON.stringify(vxTries)}`);
  expect(s.media.some((m) => m.m === 'sendMediaGroup' && m.ok), 'album still delivered');
  const d = await row('SELECT fx_fail, fallback FROM daily ORDER BY day DESC LIMIT 1');
  expect(d.fx_fail >= 1 && d.fallback >= 1, `stats: ${JSON.stringify(d)}`);
  return `stored post served while fx was down: ${r.media.map((m) => m.m).join(',')}; simulated: ${s.out.api.map((a) => `${a.api}#${a.attempt}=${a.result}`).join(', ')}`;
});

await scenario('5 links + 1 extra in one message -> progress, one by one, summary, extra ignored', async () => {
  await cool(U1);
  const body = [link(POSTS.video), link(POSTS.gif), link(POSTS.text), link(POSTS.photos), link(POSTS.missing), 'https://x.com/a/status/123'].join('\n');
  const r = okScreen(await text(U1, body), 'links_summary');
  const progress = r.trace.filter((t) => t.view === 'progress');
  expect(progress.length >= 5, `progress updates: ${progress.length}`);
  expect(r.out.results.length === 5, `processed ${r.out.results.length}`);
  expect(r.text.includes('نادیده'), 'mentions the ignored link');
  expect(r.out.results.filter((x2) => x2.ok).length === 3, `3 ok: ${JSON.stringify(r.out.results)}`);
});

await scenario('cooldown: a second request right after the first is refused', async () => {
  await cool(U3);
  okScreen(await text(U3, link(POSTS.gif)));
  const r = okScreen(await text(U3, link(POSTS.gif)), 'cooldown');
  expect(r.text.includes('ثانیه صبر'), r.text);
});

await scenario('daily quota: 30 used -> refused; the owner is unlimited', async () => {
  await db.run('UPDATE users SET day = :d, day_count = 30, last_req = 0 WHERE id = :id', { ':d': new Date(Date.now() + 210 * 60000).toISOString().slice(0, 10), ':id': U3 });
  const r = okScreen(await text(U3, link(POSTS.video)), 'quota');
  expect(r.text.includes('سهمیه') && r.media.length === 0, r.text);
  await db.run("UPDATE users SET day_count = 500 WHERE id = :id", { ':id': OWNER });
  await cool(OWNER);
  const o = okScreen(await text(OWNER, link(POSTS.video)));
  expect(o.media.some((m) => m.ok), 'owner still downloads');
  await db.run('UPDATE users SET day_count = 0 WHERE id = :id', { ':id': U3 });
});

await scenario('quality setting: low / best change the chosen variant; picker sends one quality', async () => {
  const sl = await press(U1, 'sq:low');
  answeredOnce(sl);
  okScreen(sl, 'settings');
  await cool(U1);
  const low = okScreen(await text(U1, link(POSTS.video)));
  expect(low.media[0].q === '320x568', `low -> ${low.media[0].q}`);
  okScreen(await press(U1, 'sq:best'), 'settings');
  await cool(U1);
  const best = okScreen(await text(U1, link(POSTS.video)));
  expect(best.media[0].q === '1080x1920', `best -> ${best.media[0].q}`);
  const picker = await press(U1, 'qp:2118034216503955710', { media: true });
  answeredOnce(picker);
  okScreen(picker, 'qualities');
  expect(picker.trace.some((t) => t.m === 'sendMessage' && t.view === 'qualities'), 'picker is a new message under the video');
  expect(picker.kbData.includes('qv:2118034216503955710:0:480x852'), `picker buttons: ${picker.kbData.join(' ')}`);
  await cool(U1);
  const one = await press(U1, 'qv:2118034216503955710:0:480x852');
  answeredOnce(one);
  const v = one.media.find((m) => m.m === 'sendVideo');
  expect(v && v.ok && v.q === '480x852' && v.caption.includes('480p'), `picked: ${JSON.stringify(v)}`);
  await press(U1, 'sq:auto');
});

await scenario('two videos, "best": 41 MB 1080p downloaded in Range chunks (> 30 MB fetch cap); too big for one album -> sent separately', async () => {
  await press(OWNER, 'sq:best');
  await cool(OWNER);
  x.reset();
  const r = okScreen(await text(OWNER, link(POSTS.twovid)));
  const vids = r.media.filter((m) => m.m === 'sendVideo');
  expect(vids.length === 2 && vids.every((v) => v.ok), `two sendVideo: ${JSON.stringify(r.media)}`);
  expect(vids[0].q === '1920x1080' && vids[0].bytes === 40967148, `first: ${vids[0].q} ${vids[0].bytes}`);
  const ranges = x.downloads().filter((d) => d.range);
  expect(ranges.length === 3, `range chunks: ${ranges.map((d) => d.range).join(' ')}`);
  await press(OWNER, 'sq:auto');
  await cool(OWNER);
  const a = okScreen(await text(OWNER, link(POSTS.twovid)));
  const album = a.media.find((m) => m.m === 'sendMediaGroup');
  expect(album && album.ok && album.q === '1280x720,1280x720', `auto -> album of two 720p: ${JSON.stringify(a.media)}`);
  return `ranges: ${ranges.map((d) => d.range).join(', ')}`;
});

await scenario('only vxTwitter (one 143 MB 4K variant) -> explained + direct link', async () => {
  await cool(OWNER);
  const r = okScreen(await text(OWNER, link(POSTS.twovid), { simulate: { fx: 'down' } }));
  const big = r.trace.find((t) => t.view === 'too_big');
  expect(big && big.text.includes('حجیم') && big.kb.flat()[0].includes('https://video.twimg.com/'), `too_big: ${JSON.stringify(big)}`);
  return big.kb.flat()[0];
});

await scenario('a stored vxTwitter-only post is re-read from FxTwitter after 30 minutes', async () => {
  await db.run("UPDATE posts SET source = 'vx', fetched_at = :t WHERE id = :id", { ':t': now() - 31 * 60, ':id': POSTS.twovid.id });
  await cool(OWNER);
  x.reset();
  const r = okScreen(await text(OWNER, link(POSTS.twovid)));
  expect(r.out.api.some((a) => a.api === 'fx' && a.result === 'ok'), `fx asked again: ${JSON.stringify(r.out.api)}`);
  const p = await row('SELECT source FROM posts WHERE id = :id', { ':id': POSTS.twovid.id });
  expect(p.source === 'fx', `replaced by FxTwitter's answer: ${p.source}`);
  await db.run("UPDATE posts SET source = 'vx', fetched_at = :t WHERE id = :id", { ':t': now() - 60, ':id': POSTS.twovid.id });
  await cool(OWNER);
  const fresh = okScreen(await text(OWNER, link(POSTS.twovid)));
  expect(fresh.out.api.length === 0, 'a recent vxTwitter answer is used as is');
  await db.run("UPDATE posts SET source = 'fx' WHERE id = :id", { ':id': POSTS.twovid.id });
});

await scenario('caption options: text off, author off, link on', async () => {
  for (const w of ['t', 'a']) {
    const p = await press(U1, `sc:${w}`);
    answeredOnce(p);
    okScreen(p, 'settings');
  }
  await cool(U1);
  const r = okScreen(await text(U1, link(POSTS.video)));
  const cap = r.media[0].caption;
  expect(!cap.includes('spacewalk') && !cap.includes('👤') && cap.includes('🔗 https://x.com/NASA/status/'), `caption: ${cap}`);
  await press(U1, 'sc:t');
  await press(U1, 'sc:a');
});

await scenario('history (last 20, resend buttons) and resend from cache', async () => {
  const h = await press(U1, 'hi');
  answeredOnce(h);
  okScreen(h, 'history');
  const rs = h.kbData.filter((d) => d.startsWith('r:'));
  expect(rs.length >= 5 && rs.length <= 20, `resend buttons: ${rs.length}`);
  await cool(U1);
  x.reset();
  const again = await press(U1, rs[0]);
  answeredOnce(again);
  expect(again.media.length && again.media.every((m) => m.ok), `resent: ${JSON.stringify(again.media)}`);
  expect(x.downloads().length === 0, 'from cache, no download');
  const other = await press(U2, rs[0]);
  expect(other.answers[0].text.includes('تاریخچه‌ی شما نیست'), 'someone else\'s history id is refused');
});

await scenario('profile: today / total / remaining quota', async () => {
  const r = okScreen(await text(U1, '/profile'), 'profile');
  expect(r.text.includes('باقی‌مانده') && r.text.includes('کل دانلودها'), r.text);
});

await scenario('/admin: owner gets the panel, a normal user is refused; admin buttons refused too', async () => {
  okScreen(await text(OWNER, '/admin'), 'admin_panel');
  const u = okScreen(await text(U1, '/admin'), 'admin_refused');
  expect(u.text.includes('فقط برای مدیر'), u.text);
  const cb = await press(U1, 'al');
  answeredOnce(cb);
  expect(cb.answers[0].text.includes('دسترسی ندارید') && !cb.trace.some((t) => t.view === 'admin_channels'), 'callback refused');
  const st = await press(U1, 'as');
  expect(!st.trace.some((t) => t.view === 'admin_stats'), 'stats refused');
});

await scenario('channels: add with validation, limit 10 (11th refused), remove then re-add', async () => {
  const list = okScreen(await press(OWNER, 'al'), 'admin_channels');
  expect(list.text.includes('HIDE_i_SEEK'), list.text);
  okScreen(await press(OWNER, 'aa'), 'admin_add_prompt');
  const notAdmin = okScreen(await text(OWNER, '@noadmin_chan'), 'admin_add_not_admin');
  expect(notAdmin.text.includes('ادمین نیست'), notAdmin.text);
  const missing = okScreen(await text(OWNER, 'https://t.me/doesnotexist1'), 'admin_add_not_found');
  expect(missing.text.includes('پیدا نشد'), missing.text);
  const added = okScreen(await text(OWNER, 'https://t.me/extra_chan'), 'admin_channels');
  expect(added.text.includes('اضافه شد') && (await row('SELECT count(*) AS n FROM channels')).n === 4, added.text);
  for (let i = 5; i <= 10; i += 1) {
    await db.run('INSERT INTO channels (uname, username, warned_at, created_at) VALUES (:u, :u, :t, :t)', { ':u': `zz_fake_${i}`, ':t': now() });
  }
  const full = await press(OWNER, 'aa');
  answeredOnce(full);
  expect(full.view === 'admin_channel_limit' && full.answers[0].text.includes('سقف'), `11th: ${full.view}`);
  await db.run("DELETE FROM channels WHERE uname LIKE 'zz_fake_%'");
  const id = (await row("SELECT id FROM channels WHERE uname = 'wangerbots'")).id;
  okScreen(await press(OWNER, `ar:${id}`), 'admin_remove_confirm');
  const removed = okScreen(await press(OWNER, `ary:${id}`), 'admin_channels');
  expect(!removed.text.includes('@wangerBots') || removed.text.includes('حذف شد'), removed.text);
  expect(!(await row("SELECT id FROM channels WHERE uname = 'wangerbots'")), 'removed from db');
  okScreen(await press(OWNER, 'aa'), 'admin_add_prompt');
  const back = okScreen(await text(OWNER, '@wangerBots'), 'admin_channels');
  expect(back.text.includes('اضافه شد'), back.text);
  const ex = await row("SELECT id FROM channels WHERE uname = 'extra_chan'");
  await press(OWNER, `ary:${ex.id}`);
});

await scenario('forced join on/off switch', async () => {
  const off = okScreen(await press(OWNER, 'at'), 'admin_panel');
  expect(off.text.includes('خاموش'), off.text);
  okScreen(await text(990000099, '/start'), 'menu');
  const on = okScreen(await press(OWNER, 'at'), 'admin_panel');
  expect(on.text.includes('روشن'), on.text);
  okScreen(await text(990000099, '/start'), 'join');
});

await scenario('ban / unban by numeric id (also an id that never used the bot)', async () => {
  okScreen(await press(OWNER, 'bb'), 'admin_ban_prompt');
  okScreen(await text(OWNER, 'tester'), 'admin_ban_invalid');
  const b = okScreen(await text(OWNER, String(U1)), 'admin_panel');
  expect(b.text.includes('مسدود شد'), b.text);
  const blocked = okScreen(await text(U1, link(POSTS.video)), 'banned');
  expect(blocked.media.length === 0, 'banned user gets nothing');
  const cb = await press(U1, 'hi');
  answeredOnce(cb);
  expect(cb.answers[0].text.includes('مسدود'), 'banned on buttons too');
  okScreen(await press(OWNER, 'bu'), 'admin_unban_prompt');
  okScreen(await text(OWNER, String(U1)), 'admin_panel');
  okScreen(await text(U1, '/start'), 'menu');
  const ghost = 990000077;
  const before = (await row("SELECT value FROM counters WHERE key = 'users_total'")).value;
  await press(OWNER, 'bb');
  const g = okScreen(await text(OWNER, String(ghost)), 'admin_panel');
  expect(g.text.includes('هنوز از ربات استفاده نکرده'), g.text);
  expect((await row("SELECT value FROM counters WHERE key = 'users_total'")).value === before, 'a ban alone is not a user');
  tg.state.users.add(ghost);
  okScreen(await text(ghost, '/start'), 'banned');
  await press(OWNER, 'bu');
  await text(OWNER, String(ghost));
  expect((await row("SELECT value FROM counters WHERE key = 'users_total'")).value === before + 1, 'counted once they wrote');
});

await scenario('broadcast: preview + confirm, copyMessage batches, 403 -> inactive, 429 -> retry_after, final report', async () => {
  for (const u of BCAST) await text(u, '/start');
  tg.state.blocked.add(BLOCKER);
  tg.state.rateLimitOnce.add(BCAST[3]);
  okScreen(await press(OWNER, 'ab'), 'bc_prompt');
  const draft = okScreen(await photoMessage(OWNER, '<b>سلام</b> به همه'), 'bc_confirm');
  expect(draft.trace.some((t) => t.m === 'copyMessage' && t.view === 'bc_preview' && t.chat === OWNER), 'preview copied to the owner');
  const bsData = draft.kbData.find((d) => d.startsWith('bs:'));
  expect(bsData && draft.kbData.some((d) => d.startsWith('bx:')), 'confirm + cancel');
  const confirmMsg = draft.trace.find((t) => t.view === 'bc_confirm').mid;
  const first = await press(OWNER, bsData, { messageId: confirmMsg });
  answeredOnce(first);
  const copies1 = first.trace.filter((t) => t.m === 'copyMessage');
  expect(copies1.some((t) => t.err && t.err.startsWith('429')), `batch stopped at 429: ${copies1.map((t) => `${t.chat}:${t.ok ? 'ok' : t.err}`).join(' ')}`);
  const bc = await row('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  expect(bc.status === 'running' && bc.retry_at > now(), `retry_at set: ${JSON.stringify(bc)}`);
  expect(bc.blocked === 1 && (await row('SELECT active FROM users WHERE id = :id', { ':id': BLOCKER })).active === 0, 'blocked user marked inactive');
  const early = await press(OWNER, `bn:${bc.id}`, { messageId: confirmMsg });
  expect(early.answers[0].text.includes('ثانیه'), `refused before retry_after: ${early.answers[0].text}`);
  await db.run('UPDATE broadcasts SET retry_at = 0 WHERE id = :id', { ':id': bc.id });
  // Another user's update moves the queue along by itself (opportunistic chunk).
  const other = await text(U3, '/help');
  const opportunistic = other.trace.filter((t) => t.m === 'copyMessage');
  expect(opportunistic.length >= 1, 'a chunk went out while handling someone else\'s update');
  let last = other;
  for (let i = 0; i < 5; i += 1) {
    const st = await row('SELECT status FROM broadcasts WHERE id = :id', { ':id': bc.id });
    if (st.status === 'done') break;
    last = await press(OWNER, `bn:${bc.id}`, { messageId: confirmMsg });
  }
  const fin = await row('SELECT * FROM broadcasts WHERE id = :id', { ':id': bc.id });
  expect(fin.status === 'done', `done: ${JSON.stringify(fin)}`);
  const report = [...other.trace, ...last.trace].find((t) => t.view === 'bc_report');
  expect(report && report.text.includes('تمام شد'), 'final report sent');
  const blockerCopies = tg.state.calls.filter((c) => c.method === 'copyMessage' && Number(c.params.chat_id) === BLOCKER);
  expect(blockerCopies.length === 1, `the 403 user was tried exactly once, got ${blockerCopies.length}`);
  const okTo = new Set(tg.state.calls.filter((c) => c.method === 'copyMessage' && c.result.ok && c.params.chat_id !== OWNER).map((c) => Number(c.params.chat_id)));
  expect(fin.sent === okTo.size, `sent ${fin.sent} = distinct recipients ${okTo.size}`);
  return `sent=${fin.sent} failed=${fin.failed} blocked=${fin.blocked}`;
});

await scenario('stats screen: users, active, downloads today/total, API failures today', async () => {
  const r = okScreen(await press(OWNER, 'as'), 'admin_stats');
  for (const s of ['کل کاربران', 'فعال', 'دانلود امروز', 'کل دانلودها', 'خطای API', 'FxTwitter']) expect(r.text.includes(s), `missing "${s}": ${r.text}`);
});

await scenario('unknown / stale buttons are answered, never crash', async () => {
  for (const d of ['zz', 'qv:abc:0:x', 'r:999999', 'qp:', 'sq:huge']) {
    const r = await press(U1, d);
    answeredOnce(r);
    expect(!r.error, `${d} errored`);
  }
});

const failed = results.filter((r) => r.status !== 'PASS');
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
await tg.close();
await x.close();
process.exit(failed.length ? 1 : 0);
