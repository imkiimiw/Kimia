// Publishing a pack to the community channel (Kimi 2026-11-12): a new channel set in the panel,
// manual approval by the owner or reviewers she adds, name / @username only when the creator
// turns them on, withdraw / remove (48 h deletion rule), one post per approval, no re-sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, PUB_CHANNEL, advance } from './helpers/harness.mjs';

const U = 720001; // creator
const R = 720002; // reviewer
const X = 720003; // someone else

async function owner(h) {
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
}

async function setChannel(h) {
  h.tg.addChannel({ id: PUB_CHANNEL, username: 'WangerStickerHub', title: 'Wanger Sticker Hub' });
  await h.press(OWNER, 'a:pub');
  await h.tap(OWNER, 'a:pcset');
  await h.send(OWNER, '@WangerStickerHub');
}

async function packWith(h, id, n) {
  await h.sendSticker(id, h.tg.sticker());
  await h.tap(id, 'st:new');
  await h.send(id, 'گربه‌ها');
  const pack = h.one('SELECT * FROM packs WHERE tg_id = ? ORDER BY id DESC LIMIT 1', id);
  for (let i = 1; i < n; i++) {
    await h.sendSticker(id, h.tg.sticker());
    await h.tap(id, `st:add:${pack.id}`);
  }
  return h.one('SELECT * FROM packs WHERE id = ?', pack.id);
}

async function base() {
  const h = setup();
  await owner(h);
  await setChannel(h);
  await h.ready(U);
  await h.ready(R);
  await h.ready(X);
  // the owner adds R as a reviewer (by numeric id)
  await h.press(OWNER, 'a:rv');
  await h.tap(OWNER, 'a:rvadd');
  await h.send(OWNER, String(R));
  return h;
}

test('the owner sets the publish channel; the bot must be an admin that can post', async () => {
  const h = setup();
  await owner(h);
  h.tg.addChannel({ id: PUB_CHANNEL, username: 'NoRights', title: 'No rights', botAdmin: false });
  await h.press(OWNER, 'a:pub');
  await h.tap(OWNER, 'a:pcset');
  const r = await h.send(OWNER, '@NoRights');
  assert.equal(r.result, 'step_error:a_pcset');
  assert.equal(h.one("SELECT count(*) AS n FROM settings WHERE key = 'publish.chat' AND value != 'null'").n, 0);
  h.tg.addChannel({ id: PUB_CHANNEL - 1, username: 'WangerStickerHub', title: 'Hub' });
  await h.send(OWNER, '@WangerStickerHub');
  const v = JSON.parse(h.one("SELECT value FROM settings WHERE key = 'publish.chat'").value);
  assert.equal(v.chat_id, PUB_CHANNEL - 1);
  assert.equal(v.can_delete, true);
});

test('request → cards to owner and reviewer → reviewer approves → one channel post with the chosen credit', async () => {
  const h = await base();
  const pack = await packWith(h, U, 3);
  await h.press(U, `pk:open:${pack.id}`);
  await h.tap(U, `pb:ask:${pack.id}`);
  assert.ok(h.lastText(U).includes('Wanger Sticker Hub'));
  // credits are off by default; turn on the name only
  await h.tap(U, `pb:opt:${pack.id}:1`);
  await h.tap(U, `pb:send:${pack.id}:1`);
  const post = h.one('SELECT * FROM pack_posts');
  assert.equal(post.status, 'pending');
  assert.equal(post.show_name, 1);
  assert.equal(post.show_username, 0);
  const cards = (id) => h.tg.callsOf('sendMessage', id).filter((c) => /درخواست انتشار #/.test(c.params.text));
  assert.equal(cards(OWNER).length, 1);
  assert.equal(cards(R).length, 1);
  assert.equal(cards(X).length, 0);
  assert.equal(JSON.parse(h.one('SELECT review_msgs FROM pack_posts').review_msgs).length, 2);

  // the reviewer approves from the card
  await h.tap(R, `pr:ok:${post.id}`);
  const posted = h.tg.callsOf('sendSticker', PUB_CHANNEL);
  assert.equal(posted.length, 1);
  const kb = posted[0].params.reply_markup.inline_keyboard.flat();
  assert.equal(kb[0].url, `https://t.me/addstickers/${pack.tg_name}`);
  assert.ok(kb.some((b) => b.text.includes(`User${U}`)), 'name shown');
  assert.ok(!kb.some((b) => b.text.includes(`@user${U}`)), 'username not shown');
  assert.ok(kb.some((b) => b.url === `https://t.me/Wanger_Motionbot?start=pub_${post.id}`));
  const after = h.one('SELECT * FROM pack_posts');
  assert.equal(after.status, 'published');
  assert.equal(after.decided_by, R);
  assert.ok(after.message_id);
  // the creator is told, with the post link
  assert.ok(h.texts(U).some((t) => t.includes(`https://t.me/WangerStickerHub/${after.message_id}`)));
  // the owner's card was updated; a second approval does nothing
  const r2 = await h.press(OWNER, `pr:ok:${post.id}`);
  assert.equal(r2.result, 'refused:pub.err.decided');
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 1);
});

test('anonymous by default; username shown only when turned on', async () => {
  const h = await base();
  const pack = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${pack.id}`);
  await h.tap(U, `pb:send:${pack.id}:0`);
  const post = h.one('SELECT * FROM pack_posts');
  await h.press(OWNER, `pr:ok:${post.id}`);
  const kb = h.tg.callsOf('sendSticker', PUB_CHANNEL)[0].params.reply_markup.inline_keyboard.flat();
  assert.equal(kb.filter((b) => b.text.startsWith('👤')).length, 0);
});

test('only the owner and reviewers can decide; reviewers cannot ban', async () => {
  const h = await base();
  const pack = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${pack.id}`);
  await h.tap(U, `pb:opt:${pack.id}:2`);
  await h.tap(U, `pb:send:${pack.id}:2`);
  const post = h.one('SELECT * FROM pack_posts');
  assert.equal(post.show_username, 1);
  for (const data of [`pr:ok:${post.id}`, `pr:no:${post.id}`, `pr:ban:${post.id}`, `pr:nor:${post.id}`, `pr:rm:${post.id}`]) {
    const r = await h.press(X, data);
    assert.ok(r.ok);
    assert.equal(h.one('SELECT status FROM pack_posts').status, 'pending', `${data} by a stranger`);
  }
  await h.press(R, `pr:ban:${post.id}`);
  assert.equal(h.one('SELECT status FROM pack_posts').status, 'pending', 'reviewer cannot ban');
  assert.equal(h.one('SELECT publish_banned FROM users WHERE tg_id = ?', U).publish_banned, 0);
  // the creator cannot approve their own request
  await h.press(U, `pr:ok:${post.id}`);
  assert.equal(h.one('SELECT status FROM pack_posts').status, 'pending');
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 0);
});

test('reject with a reason → the creator sees it; ban → no more publishing', async () => {
  const h = await base();
  const pack = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${pack.id}`);
  await h.tap(U, `pb:send:${pack.id}:0`);
  let post = h.one('SELECT * FROM pack_posts');
  await h.tap(R, `pr:no:${post.id}`);
  await h.send(R, 'کیفیت پایین است');
  assert.equal(h.one('SELECT status, reason FROM pack_posts').status, 'rejected');
  assert.ok(h.texts(U).some((t) => t.includes('کیفیت پایین است')));
  // ask again (rejected is not live) → the owner bans
  await h.press(U, `pb:ask:${pack.id}`);
  await h.tap(U, `pb:send:${pack.id}:0`);
  post = h.one("SELECT * FROM pack_posts WHERE status = 'pending'");
  await h.press(OWNER, `pr:ban:${post.id}`);
  assert.equal(h.one('SELECT publish_banned FROM users WHERE tg_id = ?', U).publish_banned, 1);
  const r = await h.press(U, `pb:ask:${pack.id}`);
  assert.equal(r.result, 'refused:pub.err.banned');
});

test('rules: minimum stickers, one live post per pack, daily limit', async () => {
  const h = await base();
  const small = await packWith(h, U, 2);
  let r = await h.press(U, `pb:ask:${small.id}`);
  assert.equal(r.result, 'refused:pub.err.min');
  const big = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${big.id}`);
  await h.tap(U, `pb:send:${big.id}:0`);
  r = await h.press(U, `pb:send:${big.id}:0`);
  assert.equal(r.result, 'refused:pub.err.live');
  const other = await packWith(h, U, 3);
  await h.press(U, `pb:send:${other.id}:0`);
  const third = await packWith(h, U, 3);
  r = await h.press(U, `pb:send:${third.id}:0`);
  assert.equal(r.result, 'refused:pub.err.daily');
});

test('withdraw within 48 h deletes the post; after 48 h only its buttons are removed', async () => {
  const h = await base();
  const a = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${a.id}`);
  await h.tap(U, `pb:send:${a.id}:0`);
  let post = h.one('SELECT * FROM pack_posts');
  await h.press(OWNER, `pr:ok:${post.id}`);
  post = h.one('SELECT * FROM pack_posts');
  await h.press(U, `pb:back:${post.id}`);
  await h.tap(U, `pb:backok:${post.id}`);
  assert.equal(h.one('SELECT status FROM pack_posts').status, 'withdrawn');
  assert.equal(h.tg.callsOf('deleteMessage', PUB_CHANNEL).length, 1);
  assert.equal(h.tg.message(PUB_CHANNEL, post.message_id), undefined);

  const b = await packWith(h, U, 3);
  advance(86400 + 10); // next day (daily limit)
  await h.press(U, `pb:ask:${b.id}`);
  await h.tap(U, `pb:send:${b.id}:0`);
  let p2 = h.one("SELECT * FROM pack_posts WHERE pack_id = ?", b.id);
  await h.press(OWNER, `pr:ok:${p2.id}`);
  p2 = h.one('SELECT * FROM pack_posts WHERE id = ?', p2.id);
  advance(49 * 3600);
  await h.press(OWNER, `pr:rm:${p2.id}`);
  assert.equal(h.one('SELECT status FROM pack_posts WHERE id = ?', p2.id).status, 'removed');
  const msg = h.tg.message(PUB_CHANNEL, p2.message_id);
  assert.ok(msg, 'the old post is still there');
  assert.equal(msg.reply_markup, null, 'but without buttons');
  assert.ok(h.texts(U).some((t) => /برداشته شد/.test(t)), 'creator told');
});

test('the channel gap queues approved posts; the tick posts them later, once', async () => {
  const h = await base();
  const a = await packWith(h, U, 3);
  const b = await packWith(h, X, 3);
  await h.press(U, `pb:ask:${a.id}`);
  await h.tap(U, `pb:send:${a.id}:0`);
  await h.press(X, `pb:ask:${b.id}`);
  await h.tap(X, `pb:send:${b.id}:0`);
  const [p1, p2] = h.q('SELECT * FROM pack_posts ORDER BY id');
  await h.press(OWNER, `pr:ok:${p1.id}`);
  await h.press(OWNER, `pr:ok:${p2.id}`);
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 1);
  assert.equal(h.one('SELECT status FROM pack_posts WHERE id = ?', p2.id).status, 'approved');
  advance(31);
  await h.send(X, '/menu'); // any update runs the piggyback tick
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 2);
  await h.send(X, '/menu');
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 2);
});

test('a post whose send was cut off is never re-sent automatically', async () => {
  const h = await base();
  const a = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${a.id}`);
  await h.tap(U, `pb:send:${a.id}:0`);
  const p = h.one('SELECT * FROM pack_posts');
  // simulate an invocation that died after claiming (status posting, no message id)
  h.db.prepare("UPDATE pack_posts SET status = 'posting', lease_until = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) + 5, p.id);
  advance(120);
  await h.send(X, '/menu');
  assert.equal(h.one('SELECT status, reason FROM pack_posts').status, 'failed');
  assert.equal(h.one('SELECT reason FROM pack_posts').reason, 'uncertain');
  assert.equal(h.tg.callsOf('sendSticker', PUB_CHANNEL).length, 0);
  assert.ok(h.texts(OWNER).some((t) => /معلوم نیست/.test(t)));
});

test('reviewers: the owner adds and removes them; a reviewer sees only the queue', async () => {
  const h = await base();
  assert.equal(h.one('SELECT role FROM staff WHERE tg_id = ?', R).role, 'reviewer');
  assert.ok(h.texts(R).some((t) => /بررسی‌کننده/.test(t)), 'reviewer notified');
  await h.send(R, '/admin');
  const kb = h.lastButtons(R).map((b) => b.callback_data);
  assert.deepEqual(kb, ['a:q', 'm:home']);
  const r = await h.press(R, 'a:st');
  assert.ok(r.ok);
  assert.ok(!h.texts(R).some((t) => /<b>کاربران<\/b>/.test(t)), 'no stats for reviewers');
  await h.press(OWNER, `a:rvdel:${R}`);
  assert.equal(h.one('SELECT count(*) AS n FROM staff').n, 0);
  const mark = h.mark();
  await h.send(R, '/admin');
  assert.ok(h.texts(R, mark).some((t) => /نمی‌شناسم/.test(t)));
});

test('deleting a published pack takes its post down', async () => {
  const h = await base();
  const a = await packWith(h, U, 3);
  await h.press(U, `pb:ask:${a.id}`);
  await h.tap(U, `pb:send:${a.id}:0`);
  const p = h.one('SELECT * FROM pack_posts');
  await h.press(OWNER, `pr:ok:${p.id}`);
  await h.press(U, `pk:drop:${a.id}`);
  await h.tap(U, `pk:dropok:${a.id}`);
  assert.notEqual(h.one('SELECT status FROM pack_posts').status, 'published');
  assert.equal(h.tg.callsOf('deleteMessage', PUB_CHANNEL).length, 1);
});
