// Phase 5 acceptance: Wanger Points (awards with caps and idempotency, referrals, spending), the
// public gallery (likes, reports, auto-hide, moderation by owner / reviewers), Pro with Telegram
// Stars (invoice, pre-checkout, payment once, refund) and the local AiProvider suggestions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, PUB_CHANNEL } from './helpers/harness.mjs';
import aiSuggest from '../tgcloud/endpoints/ai_suggest.js';

const U = 780001; // creator
const V = 780002;
const W = 780003;
const X = 780004;
const R = 780005; // reviewer
const ctx = (id) => ({ initData: { user: { id, first_name: `User${id}`, language_code: 'fa' } } });
const points = (h, id) => h.one('SELECT points FROM users WHERE tg_id = ?', id).points;
const put = (h, k, v) => h.db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, 0, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

async function packWith(h, id, n = 3, title = 'گربه‌ها') {
  await h.sendSticker(id, h.tg.sticker());
  await h.tap(id, 'st:new');
  await h.send(id, title);
  const pack = h.one('SELECT * FROM packs WHERE tg_id = ? ORDER BY id DESC LIMIT 1', id);
  for (let i = 1; i < n; i++) {
    await h.sendSticker(id, h.tg.sticker());
    await h.tap(id, `st:add:${pack.id}`);
  }
  return h.one('SELECT * FROM packs WHERE id = ?', pack.id);
}

/** Owner sets the channel, adds R as reviewer, U publishes a pack, the owner approves. */
async function published(h) {
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  h.tg.addChannel({ id: PUB_CHANNEL, username: 'WangerMotion', title: 'Wanger Motion' });
  await h.press(OWNER, 'a:pub');
  await h.tap(OWNER, 'a:pcset');
  await h.send(OWNER, '@WangerMotion');
  await h.press(OWNER, 'a:rv');
  await h.tap(OWNER, 'a:rvadd');
  await h.ready(R);
  await h.send(OWNER, String(R));
  await h.ready(U);
  const pack = await packWith(h, U);
  await h.press(U, `pk:open:${pack.id}`);
  await h.tap(U, `pb:ask:${pack.id}`);
  await h.tap(U, `pb:send:${pack.id}:0`);
  const post = h.one('SELECT * FROM pack_posts');
  await h.tap(OWNER, `pr:ok:${post.id}`);
  return { pack: h.one('SELECT * FROM packs WHERE id = ?', pack.id), post };
}

test('points: a pack +2 (daily cap 6), referral once on the first pack, never paid twice', async () => {
  const h = setup();
  await h.ready(U);
  for (let i = 0; i < 4; i++) await packWith(h, U, 1, `P${i}`);
  assert.equal(points(h, U), 6, 'four packs, capped at 6 a day');
  assert.equal(h.one("SELECT count(*) AS n FROM points_ledger WHERE tg_id = ? AND reason = 'pack_created'", U).n, 3);
  // V arrives with U's invite link, makes a pack → U +10; a second pack doesn't pay again
  h.join(V);
  await h.send(V, `/start ref_${U}`);
  await h.tap(V, 'l:set:fa');
  assert.equal(h.one('SELECT referrer_id FROM users WHERE tg_id = ?', V).referrer_id, U);
  await packWith(h, V, 1, 'A');
  await packWith(h, V, 1, 'B');
  assert.equal(points(h, U), 16);
  assert.equal(points(h, V), 4);
  // a self-referral is ignored; a user who joined more than a day ago can't be referred
  await h.send(U, `/start ref_${U}`);
  assert.equal(h.one('SELECT referrer_id FROM users WHERE tg_id = ?', U).referrer_id, null);
  h.db.prepare('UPDATE users SET joined_at = joined_at - 2 * 86400 WHERE tg_id = ?').run(U);
  await h.send(U, `/start ref_${V}`);
  assert.equal(h.one('SELECT referrer_id FROM users WHERE tg_id = ?', U).referrer_id, null);
  // the account screen shows the points and the points screen explains how to earn
  await h.send(U, '/menu');
  await h.tap(U, 'm:acct');
  await h.tap(U, 'pt:menu');
  assert.match(h.lastText(U), /۱۶/);
  assert.match(h.lastText(U), /ساخت پک/);
});

test('points: spend on a quota boost or a week of Pro; a short balance is refused; a repeat press costs once', async () => {
  const h = setup({ settings: { 'quota.sticker_add': 2 } });
  await h.ready(U);
  h.db.prepare('UPDATE users SET points = 200 WHERE tg_id = ?').run(U);
  await h.send(U, '/menu');
  await h.tap(U, 'm:acct');
  await h.tap(U, 'pt:menu');
  const r = await h.tap(U, 'pt:boost');
  assert.equal(r.result, 'ok');
  assert.equal(points(h, U), 180);
  const b = await (await import('../tgcloud/endpoints/studio_boot.js')).default({}, ctx(U));
  assert.equal(b.quota.sticker_add, 52, 'base 2 + boost 50');
  await h.tap(U, 'pt:pro');
  assert.equal(points(h, U), 30);
  const u = h.one('SELECT plan, plan_until FROM users WHERE tg_id = ?', U);
  assert.equal(u.plan, 'pro');
  assert.ok(u.plan_until > Math.floor(Date.now() / 1000) + 6 * 86400);
  const short = await h.tap(U, 'pt:pro');
  assert.equal(short.result, 'refused:pt.err.short');
  assert.equal(points(h, U), 30, 'nothing taken');
  assert.equal(h.one("SELECT count(*) AS n FROM points_ledger WHERE tg_id = ? AND reason = 'pro_week'", U).n, 1, 'the failed spend left no ledger row');
});

test('gallery: a published pack enters it; likes once (+1 point to the creator); withdrawal takes it out', async () => {
  const h = setup();
  const { pack, post } = await published(h);
  assert.ok(h.one('SELECT gallery_at FROM packs WHERE id = ?', pack.id).gallery_at);
  assert.equal(points(h, U), 2 + 5, 'pack +2, publication +5');
  await h.ready(V);
  await h.send(V, '/menu');
  await h.tap(V, 'g:list:new:0');
  assert.match(h.lastText(V), /گالری/);
  await h.tap(V, `g:open:${pack.id}`);
  const shown = h.tg.callsOf('sendSticker', V).at(-1).params;
  assert.ok(shown.reply_markup.inline_keyboard.flat().some((x) => x.url === `https://t.me/addstickers/${pack.tg_name}`));
  await h.tap(V, `g:like:${pack.id}`);
  assert.equal(h.one('SELECT likes FROM packs WHERE id = ?', pack.id).likes, 1);
  assert.equal(points(h, U), 8);
  await h.tap(V, `g:like:${pack.id}`); // unlike
  await h.tap(V, `g:like:${pack.id}`); // like again: no second point
  assert.equal(h.one('SELECT likes FROM packs WHERE id = ?', pack.id).likes, 1);
  assert.equal(points(h, U), 8);
  // the creator's own like earns nothing
  await h.press(U, `g:like:${pack.id}`);
  assert.equal(points(h, U), 8);
  // most liked first
  await h.tap(V, 'g:list:top:0');
  // the creator withdraws → out of the gallery
  await h.press(U, `pb:back:${post.id}`);
  const yes = h.findData(U, 'pb:backok:');
  if (yes) await h.tap(U, yes);
  assert.equal(h.one('SELECT gallery_at FROM packs WHERE id = ?', pack.id).gallery_at, null);
  assert.equal((await h.press(V, `g:open:${pack.id}`)).result, 'refused:gl.err.gone');
});

test('gallery: three reports hide a pack and alert the owner and reviewers; reviewers restore, only the owner bans', async () => {
  const h = setup();
  const { pack } = await published(h);
  for (const who of [V, W, X]) {
    await h.ready(who);
    await h.press(who, `g:open:${pack.id}`);
    await h.press(who, `g:rr:${pack.id}:1`);
  }
  assert.equal((await h.press(V, `g:rr:${pack.id}:0`)).result, 'ok', 'a second report by V is ignored');
  const row = h.one('SELECT reports, gallery_hidden FROM packs WHERE id = ?', pack.id);
  assert.deepEqual([row.reports, row.gallery_hidden], [3, 1]);
  const cards = (id) => h.tg.callsOf('sendMessage', id).filter((c) => /گزارش گالری/.test(c.params.text));
  assert.equal(cards(OWNER).length, 1);
  assert.equal(cards(R).length, 1);
  assert.equal(cards(V).length, 0);
  // the creator can't report their own pack
  assert.equal((await h.press(U, `g:rr:${pack.id}:0`)).result, 'refused:gl.err.own');
  // a normal user can't moderate; a reviewer restores; a reviewer can't ban
  let mark = h.mark();
  await h.press(V, `g:mok:${pack.id}`);
  assert.ok(h.tg.answers(mark).at(-1).show_alert, 'a normal user is refused');
  assert.equal(h.one('SELECT gallery_hidden FROM packs WHERE id = ?', pack.id).gallery_hidden, 1);
  await h.press(R, `g:mok:${pack.id}`);
  assert.deepEqual(Object.values(h.one('SELECT gallery_hidden, reports FROM packs WHERE id = ?', pack.id)), [0, 0]);
  mark = h.mark();
  await h.press(R, `g:mban:${pack.id}`);
  assert.ok(h.tg.answers(mark).at(-1).show_alert, 'a reviewer can\'t ban');
  assert.equal(h.one('SELECT publish_banned FROM users WHERE tg_id = ?', U).publish_banned, 0);
  await h.press(OWNER, `g:mban:${pack.id}`);
  assert.equal(h.one('SELECT publish_banned FROM users WHERE tg_id = ?', U).publish_banned, 1);
  assert.equal(h.one('SELECT gallery_at FROM packs WHERE id = ?', pack.id).gallery_at, null);
  // the panel lists open reports for moderators
  await h.press(OWNER, 'a:mod');
});

test('Pro with Stars: hidden until priced; invoice; pre-checkout checks; payment once; owner refund', async () => {
  const h = setup();
  await h.ready(U);
  await h.send(U, '/menu');
  await h.tap(U, 'm:acct');
  assert.ok(!h.lastButtons(U).some((x) => x.callback_data === 'pay:pro'), 'not for sale yet');
  put(h, 'flags.payments', true);
  put(h, 'pro.price_stars', 75);
  await h.tap(U, 'm:acct');
  await h.tap(U, 'pay:pro');
  const inv = h.tg.callsOf('createInvoiceLink').at(-1).params;
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.subscription_period, 2592000);
  assert.equal(inv.prices[0].amount, 75);
  assert.equal(inv.payload, `pro1:${U}`);
  assert.ok(h.lastButtons(U).some((x) => /^https:\/\/t\.me\/\$invoice/.test(x.url)));
  // pre-checkout: right → ok; wrong price, someone else's payload, flag off → refused with a message
  assert.equal((await h.preCheckout(U, `pro1:${U}`, 75)).result, 'ok');
  assert.equal(h.tg.callsOf('answerPreCheckoutQuery').at(-1).params.ok, true);
  assert.equal((await h.preCheckout(U, `pro1:${U}`, 10)).result, 'refused:pay.err.price');
  assert.equal((await h.preCheckout(V, `pro1:${U}`, 75)).result, 'refused:pay.err.payload');
  put(h, 'flags.payments', false);
  assert.equal((await h.preCheckout(U, `pro1:${U}`, 75)).result, 'refused:pay.err.off');
  assert.equal(h.tg.callsOf('answerPreCheckoutQuery').at(-1).params.ok, false);
  put(h, 'flags.payments', true);
  // the payment (also during maintenance) → Pro until the subscription's expiry, recorded once
  put(h, 'maintenance.on', true);
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400 + 100;
  const sp = { currency: 'XTR', total_amount: 75, invoice_payload: `pro1:${U}`, telegram_payment_charge_id: 'stxCHARGE1', provider_payment_charge_id: '', subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true };
  const r1 = await h.send(U, null, { successful_payment: sp });
  assert.equal(r1.result, 'payment:paid');
  assert.equal((await h.send(U, null, { successful_payment: sp })).result, 'payment:duplicate');
  put(h, 'maintenance.on', false);
  const u = h.one('SELECT plan, plan_until FROM users WHERE tg_id = ?', U);
  assert.deepEqual([u.plan, u.plan_until], ['pro', exp]);
  assert.equal(h.one('SELECT count(*) AS n FROM payments').n, 1);
  assert.ok(h.texts(U).some((t) => /Pro تو فعال شد/.test(t)));
  // the owner refunds from the user's screen
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  await h.press(OWNER, `a:uv:${U}`);
  await h.tap(OWNER, `a:urf:${U}`);
  const ref = h.tg.callsOf('refundStarPayment').at(-1).params;
  assert.deepEqual([ref.user_id, ref.telegram_payment_charge_id], [U, 'stxCHARGE1']);
  assert.equal(h.tg.callsOf('editUserStarSubscription').at(-1).params.is_canceled, true);
  assert.equal(h.one('SELECT refunded FROM payments').refunded, 1);
  assert.equal(h.one('SELECT plan FROM users WHERE tg_id = ?', U).plan, 'free');
  // the panel's payments view
  await h.press(OWNER, 'a:pay');
  assert.match(h.lastText(OWNER), /۷۵/);
});

test('AiProvider (local): emoji suggestions from Persian / English text, caption ideas, bad input refused', async () => {
  const h = setup();
  await h.ready(U);
  const e = await aiSuggest({ kind: 'emojis', text: 'تولدت مبارک عزیزم' }, ctx(U));
  assert.equal(e.provider, 'local');
  assert.ok(e.emojis.includes('🎉'));
  const c = await aiSuggest({ kind: 'captions', mood: 'love' }, ctx(U));
  assert.equal(c.captions.length, 4);
  await assert.rejects(aiSuggest({ kind: 'image' }, ctx(U)));
  await assert.rejects(aiSuggest({ kind: 'emojis', extra: 1 }, ctx(U)));
});
