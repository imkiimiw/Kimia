// The improvements after Phase 8: delivery settings (files, GIF preference, quality question),
// several links per message, health checks and the daily report, invitations, VIP with Telegram
// Stars, inline mode. Real handlers, the local SDK, a fake Telegram, a fake web with recorded answers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import inlineQuery from '../../tgcloud/handlers/inline_query.js';
import message from '../../tgcloud/handlers/message.js';
import preCheckout from '../../tgcloud/handlers/pre_checkout_query.js';
import { MB } from '../../tgcloud/lib/config.js';
import { ALICE, BORIS, buttonsOf, OWNER, SARA, setup } from '../helpers/harness.js';
import { createWeb, fixture } from '../helpers/web.js';

const VIDEO_POST = 'https://x.com/SpaceX/status/2115476295169814978';
const PHOTO_POST = 'https://x.com/SpaceX/status/2112592291147747809';
const GIF_POST = 'https://x.com/GIPHY/status/2090559778699489429';
const TEXT_POST = 'https://x.com/jack/status/20';
const DAY = '2026-11-05';

function xVideoSize(url) {
  const m = /\/(\d+)x(\d+)\//.exec(url);
  const px = m ? Number(m[1]) * Number(m[2]) : 0;
  if (px >= 3000000) return 140 * MB;
  if (px >= 1800000) return 41 * MB;
  if (px >= 800000) return 19 * MB;
  if (px >= 200000) return 6 * MB;
  return 2 * MB;
}
const syn = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}*`;
const singleVideo = () => { const j = JSON.parse(fixture('syn_video.json')); j.mediaDetails = j.mediaDetails.slice(0, 1); return j; };

let h;
let web;
let failHealth;
let updateId = 90000;
beforeEach(async () => {
  h = setup();
  failHealth = false;
  web = createWeb({
    [syn('2115476295169814978')]: () => (failHealth ? { status: 500, body: 'down' } : { json: singleVideo() }),
    [syn('2112592291147747809')]: () => (failHealth ? { status: 500, body: 'down' } : { json: fixture('syn_photos.json') }),
    [syn('2090559778699489429')]: { json: fixture('syn_gif.json') },
    [syn('20')]: { json: fixture('syn_text.json') },
    'https://api.fxtwitter.com/*': () => (failHealth ? { status: 500, body: 'down' } : { status: 404, json: { code: 404 } }),
    'https://video.twimg.com/*': ({ url }) => ({ size: xVideoSize(url), type: 'video/mp4' }),
    'https://pbs.twimg.com/*': { size: 300000, type: 'image/jpeg' },
  });
  await h.onboard(OWNER, 'en');
  await h.onboard(ALICE, 'en');
  h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('platform:x', '{"methods":{"public":true}}', 1) RETURNING key`);
  h.resetCalls();
  web.reset();
});
afterEach(() => { vi.useRealTimers(); });

const sent = (method, chatId = ALICE.id) => h.tg.calls(method).filter((c) => Number(c.params.chat_id) === chatId);
const later = (s = 20) => h.advance(s);
const setLimits = (l) => h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('limits', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`, JSON.stringify(l));
const lastEditWithButtons = () => h.tg.calls('editMessageText').filter((c) => Number(c.params.chat_id) === ALICE.id && c.params.reply_markup).at(-1);
const ownerTexts = () => sent('sendMessage', OWNER.id).map((c) => c.params.text);
const asUpdate = (key, payload) => ({ update: { update_id: ++updateId, [key]: payload } });

describe('delivery settings', () => {
  it('⚙️ shows and saves the GIF preference and “send as files”', async () => {
    await h.press(ALICE, 's');
    const kb = buttonsOf(h.lastScreen(ALICE.id)).map((b) => b.callback_data);
    expect(kb).toEqual(expect.arrayContaining(['g:gif', 'f:file']));
    await h.press(ALICE, 'g:gif');
    await h.press(ALICE, 'f:file', { messageId: 901 });
    expect(h.row('SELECT gif, delivery FROM user_settings WHERE user_id = ?', ALICE.id)).toEqual({ gif: 'gif', delivery: 'file' });
    expect(h.lastScreen(ALICE.id).text).toContain('GIFs: always as a GIF');
    expect(h.lastScreen(ALICE.id).text).toContain('as files (original quality)');
  });

  it('a GIF preference skips the question', async () => {
    await h.press(ALICE, 'g:video');
    expect((await h.send(ALICE, GIF_POST)).download.status).toBe('ok');
    expect(sent('sendVideo')).toHaveLength(1);
    expect(sent('sendAnimation')).toHaveLength(0);
  });

  it('“send as files”: photos go as an album of documents, uploaded (no compression), cached apart', async () => {
    await h.press(ALICE, 'f:file');
    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok');
    const album = sent('sendMediaGroup').at(-1).params.media;
    expect(album.map((m) => m.type)).toEqual(['document', 'document', 'document']);
    expect(album.every((m) => typeof m.media !== 'string')).toBe(true); // uploaded: sendDocument by URL only takes GIF/PDF/ZIP
    expect(h.rows('SELECT variant FROM file_cache').map((r) => r.variant)).toEqual(['auto:file']);
  });

  it('“ask every time”: a video in several qualities offers them with sizes; the pick is sent', async () => {
    await h.press(ALICE, 'Q:ask');
    expect((await h.send(ALICE, VIDEO_POST)).download.status).toBe('asked');
    const ask = lastEditWithButtons();
    expect(ask.params.text).toContain('several qualities');
    const buttons = buttonsOf(ask.params);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.map((b) => b.text).join(' ')).toMatch(/\d+p · [\d.]+ MB/);
    const pick = buttons.find((b) => b.text.includes('6.0 MB') || b.text.includes(' 6 MB')) || buttons.at(-1);
    expect((await h.press(ALICE, pick.callback_data, { messageId: ask.params.message_id })).download.status).toBe('ok');
    expect(sent('sendVideo').at(-1).params.video).toMatch(/^https:\/\/video\.twimg\.com\//);
  });
});

describe('several links in one message', () => {
  it('each link is handled; one cooldown for the message', async () => {
    const r = await h.send(ALICE, `${PHOTO_POST} and ${TEXT_POST}`);
    expect(r.downloads.map((d) => [d.status, d.reason])).toEqual([['ok', null], ['failed', 'no_media']]);
    expect(sent('sendMediaGroup')).toHaveLength(1);
  });
});

describe('monitoring', () => {
  it('health checks run on the side of updates; two failures in a row alert the owner, recovery too', async () => {
    later(1300);
    await h.send(ALICE, '/help');
    expect(JSON.parse(h.row("SELECT value FROM settings WHERE key = 'health:x'").value)).toMatchObject({ ok: true, fails: 0 });
    failHealth = true;
    later(1300);
    await h.send(ALICE, '/help');
    expect(ownerTexts().some((t) => t.includes('stopped working'))).toBe(false); // one failure: no alert yet
    later(1300);
    await h.send(ALICE, '/help');
    expect(ownerTexts().filter((t) => t.includes('X (Twitter) stopped working'))).toHaveLength(1);
    await h.press(OWNER, 'P:x');
    expect(h.lastScreen(OWNER.id).text).toContain('Last automatic check: ❌');
    failHealth = false;
    later(1300);
    await h.send(ALICE, '/help');
    expect(ownerTexts().filter((t) => t.includes('X (Twitter) works again'))).toHaveLength(1);
  });

  it('the first update of a day sends the owner yesterday’s report (once); it can be switched off', async () => {
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('report.day', '"2026-11-04"', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`);
    await h.send(ALICE, '/help');
    await h.send(ALICE, '/about');
    const reports = ownerTexts().filter((t) => t.includes('Daily report'));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('2026-11-04');
    await h.press(OWNER, 'A:s');
    await h.press(OWNER, 'A:sr');
    expect(h.row("SELECT value FROM settings WHERE key = 'switch.daily_report'").value).toBe('false');
    h.row(`UPDATE settings SET value = '"2026-11-04"' WHERE key = 'report.day' RETURNING key`);
    await h.send(ALICE, '/help');
    expect(ownerTexts().filter((t) => t.includes('Daily report'))).toHaveLength(1);
  });
});

describe('invitations', () => {
  it('a friend who starts with the link and finishes onboarding gives the inviter +5 a day, once', async () => {
    h.tg.setMember(BORIS.id);
    await h.send(BORIS, `/start ref_${ALICE.id}`);
    expect(h.row('SELECT referred_by FROM users WHERE id = ?', BORIS.id).referred_by).toBe(ALICE.id);
    await h.press(BORIS, 'L:en', { messageId: 1 });
    await h.press(BORIS, 'a', { messageId: 2 });
    expect(h.row('SELECT ref_count, ref_bonus FROM users WHERE id = ?', ALICE.id)).toEqual({ ref_count: 1, ref_bonus: 5 });
    expect(sent('sendMessage').some((c) => c.params.text.includes('A friend joined with your link'))).toBe(true);
    await h.press(BORIS, 'a', { messageId: 3 });
    expect(h.row('SELECT ref_count FROM users WHERE id = ?', ALICE.id).ref_count).toBe(1);
    expect(h.counter('ref_credited', DAY)).toBe(1);
    await h.press(ALICE, 'r');
    expect(h.lastScreen(ALICE.id).text).toContain(`https://t.me/Wanger_mediabot?start=ref_${ALICE.id}`);
    expect(h.lastScreen(ALICE.id).text).toContain('Invited: 1');
  });

  it('never oneself or an unknown inviter, and only for new users', async () => {
    h.tg.setMember(SARA.id);
    await h.send(SARA, `/start ref_${SARA.id}`);
    expect(h.row('SELECT referred_by FROM users WHERE id = ?', SARA.id).referred_by).toBeNull();
    await h.send(ALICE, `/start ref_${OWNER.id}`); // ALICE isn't new
    expect(h.row('SELECT referred_by FROM users WHERE id = ?', ALICE.id).referred_by).toBeNull();
  });

  it('the bonus raises the daily quota', async () => {
    setLimits({ quota_per_day: 1, cooldown_s: 0, max_mb: 50 });
    h.row('UPDATE users SET ref_bonus = 5 WHERE id = ? RETURNING id', ALICE.id);
    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok');
    expect((await h.send(ALICE, GIF_POST)).download.status).toBe('asked');
  });
});

describe('VIP with Telegram Stars', () => {
  it('owner opens sales → invoice in Stars → pre-checkout checked → payment recorded once → VIP limits → refund', async () => {
    await h.press(ALICE, 'B');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toContain('isn’t on sale');
    expect((await h.press(ALICE, 'A:v')).ignored).toBe('not_allowed');
    await h.press(OWNER, 'A:v');
    await h.press(OWNER, 'A:vt');
    expect(JSON.parse(h.row("SELECT value FROM settings WHERE key = 'vip'").value)).toMatchObject({ on: true });

    await h.press(ALICE, 'v', { messageId: 905 });
    expect(h.lastScreen(ALICE.id).text).toContain('100 ⭐');
    await h.press(ALICE, 'B', { messageId: 906 });
    const inv = h.tg.calls('sendInvoice').at(-1).params;
    expect(inv).toMatchObject({ chat_id: ALICE.id, currency: 'XTR', payload: 'vip:30:100', prices: [{ amount: 100 }] });

    const q = { id: 'pc1', from: ALICE, currency: 'XTR', total_amount: 100, invoice_payload: 'vip:30:100' };
    await preCheckout(q, asUpdate('pre_checkout_query', q));
    expect(h.tg.calls('answerPreCheckoutQuery').at(-1).params).toEqual({ pre_checkout_query_id: 'pc1', ok: true });
    const bad = { ...q, id: 'pc2', total_amount: 1 };
    await preCheckout(bad, asUpdate('pre_checkout_query', bad));
    expect(h.tg.calls('answerPreCheckoutQuery').at(-1).params).toMatchObject({ pre_checkout_query_id: 'pc2', ok: false });

    const paid = { message_id: 777, from: ALICE, chat: { id: ALICE.id, type: 'private' }, date: 0, successful_payment: { currency: 'XTR', total_amount: 100, invoice_payload: 'vip:30:100', telegram_payment_charge_id: 'charge_1' } };
    await message(paid, asUpdate('message', paid));
    await message(paid, asUpdate('message', paid)); // the same charge again
    const now = Math.floor(Date.now() / 1000);
    expect(h.row('SELECT vip_until FROM users WHERE id = ?', ALICE.id).vip_until).toBe(now + 30 * 86400);
    expect(h.rows('SELECT stars, days FROM payments')).toEqual([{ stars: 100, days: 30 }]);
    expect(sent('sendMessage').some((c) => c.params.text.includes('VIP is active until'))).toBe(true);
    expect(h.counter('vip_stars')).toBe(100);

    setLimits({ quota_per_day: 1, cooldown_s: 60, max_mb: 50 });
    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok');
    later(4); // VIP cooldown 3 s, not 60
    expect((await h.send(ALICE, TEXT_POST)).download.reason).toBe('no_media'); // not "quota"

    const pid = h.row('SELECT id FROM payments').id;
    await h.press(OWNER, `A:vr:${pid}`, { messageId: 910 });
    expect(h.lastScreen(OWNER.id).text).toContain('Refund 100 Stars');
    await h.press(OWNER, `A:vR:${pid}`, { messageId: 911 });
    expect(h.tg.calls('refundStarPayment').at(-1).params).toEqual({ user_id: ALICE.id, telegram_payment_charge_id: 'charge_1' });
    expect(h.row('SELECT refunded FROM payments').refunded).toBe(1);
    expect(h.row('SELECT vip_until FROM users WHERE id = ?', ALICE.id).vip_until).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('/paysupport explains, and with a message forwards it to the owner', async () => {
    await h.send(ALICE, '/paysupport');
    expect(h.lastScreen(ALICE.id).text).toContain('/paysupport');
    await h.send(ALICE, '/paysupport I paid but nothing happened');
    expect(h.tg.calls('forwardMessage').at(-1).params).toMatchObject({ chat_id: OWNER.id, from_chat_id: ALICE.id });
  });
});

describe('inline mode', () => {
  const ask = async (from, query) => {
    const iq = { id: 'iq' + (++updateId), from, query, offset: '' };
    const r = await inlineQuery(iq, asUpdate('inline_query', iq));
    return { r, answer: h.tg.calls('answerInlineQuery').at(-1).params };
  };

  it('photos by URL with the source caption; a GIF as an MP4 GIF with its poster', async () => {
    const { answer } = await ask(ALICE, PHOTO_POST);
    expect(answer.results.map((x) => x.type)).toEqual(['photo', 'photo', 'photo']);
    expect(answer.results[0].photo_url).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    expect(answer.results[0].caption).toContain('X (Twitter)');
    expect(answer.is_personal).toBe(true);
    later(2);
    const g = (await ask(ALICE, GIF_POST)).answer;
    expect(g.results[0]).toMatchObject({ type: 'mpeg4_gif' });
    expect(g.results[0].thumbnail_url).toMatch(/^https:\/\/pbs\.twimg\.com\//);
    expect(sent('sendMessage')).toHaveLength(0); // nothing is sent until a result is picked
  });

  it('cached posts come back as file_ids; not onboarded users and empty queries get a button', async () => {
    await h.send(ALICE, PHOTO_POST);
    later(2);
    const { answer } = await ask(ALICE, PHOTO_POST);
    expect(answer.results.every((x) => x.photo_file_id)).toBe(true);
    const stranger = { id: 1099, is_bot: false, first_name: 'New', language_code: 'en' };
    expect((await ask(stranger, PHOTO_POST)).answer).toMatchObject({ results: [], button: { text: 'Start the bot first', start_parameter: 'inline' } });
    expect((await ask(ALICE, 'hello')).answer.button.text).toContain('Paste a link');
  });
});
