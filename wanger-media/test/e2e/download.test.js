// The download core end to end: real handlers, the local SDK, a fake Telegram, and a fake web
// that serves the responses recorded from Serverless (test/fixtures). Tests never call real platforms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MB } from '../../tgcloud/lib/config.js';
import { ALICE, BORIS, buttonsOf, OWNER, setup } from '../helpers/harness.js';
import { createWeb, fixture } from '../helpers/web.js';

const VIDEO_POST = 'https://x.com/SpaceX/status/2115476295169814978';
const PHOTO_POST = 'https://x.com/SpaceX/status/2112592291147747809';
const GIF_POST = 'https://x.com/GIPHY/status/2090559778699489429';
const TEXT_POST = 'https://x.com/jack/status/20';
const MISSING_POST = 'https://x.com/i/status/1999999999999999999';
const PIN = 'https://www.pinterest.com/pin/424605071146271645/';
const SPOT_ID = 'W7_EDlXWTBiXAEEniNoMPwAAYYm1kc21qZXdyAaGq_FkdAaGq_Af0AAAAAA';
const SPOT = `https://www.snapchat.com/spotlight/${SPOT_ID}`;

/** Sizes by resolution, like the real X variants (4K ≈ 140 MB … 360p ≈ 2 MB). */
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
const routes = () => ({
  [syn('2115476295169814978')]: { json: fixture('syn_video.json') },
  [syn('2112592291147747809')]: { json: fixture('syn_photos.json') },
  [syn('2090559778699489429')]: { json: fixture('syn_gif.json') },
  [syn('20')]: { json: fixture('syn_text.json') },
  [syn('1999999999999999999')]: { status: 404, html: fixture('syn_missing.html') },
  'https://api.fxtwitter.com/SpaceX/status/2115476295169814978': { json: fixture('fx_video.json') },
  'https://video.twimg.com/*': ({ url }) => ({ size: xVideoSize(url), type: 'video/mp4' }),
  'https://pbs.twimg.com/*': { size: 300000, type: 'image/jpeg' },
  'https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=424605071146271645': { json: fixture('pin_info.json') },
  'https://i.pinimg.com/*': { size: 37141, type: 'image/jpeg' },
  'https://pin.it/4X1y2Zq': { redirect: 'https://api.pinterest.com/url_shortener/4X1y2Zq/redirect/' },
  'https://api.pinterest.com/url_shortener/4X1y2Zq/redirect/': { redirect: 'https://www.pinterest.com/pin/424605071146271645/sent/?invite_code=abc' },
  [SPOT]: { html: fixture('snap_spotlight.html') },
  'https://cf-st.sc-cdn.net/*': { size: 1558733, type: 'video/mp4' },
});

let h;
let web;
beforeEach(async () => {
  h = setup();
  web = createWeb(routes());
  await h.onboard(ALICE, 'en');
  await h.send(OWNER, '/start');
  await h.press(OWNER, 'L:en');
  h.resetCalls();
});
afterEach(() => { vi.useRealTimers(); });

const enable = (platform, methods, extra = {}) => h.row(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`,
  'platform:' + platform, JSON.stringify({ methods: Object.fromEntries(methods.map((m) => [m, true])), ...extra }),
);
const setLimits = (l) => h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('limits', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`, JSON.stringify(l));
const statusText = (userId = ALICE.id) => {
  const edits = h.tg.calls('editMessageText').filter((c) => Number(c.params.chat_id) === userId);
  return edits.length ? edits.at(-1).params.text : null;
};
const sent = (method) => h.tg.calls(method).filter((c) => Number(c.params.chat_id) === ALICE.id);
const later = () => h.advance(20); // past the 15 s cooldown

describe('policy before any fetch', () => {
  it('every platform starts off: a link is denied, recorded, and nothing is fetched', async () => {
    const r = await h.send(ALICE, VIDEO_POST);
    expect(r.download).toMatchObject({ status: 'denied', reason: 'platform_off', platform: 'x' });
    expect(statusText()).toBe('⏸ Downloads from X (Twitter) are switched off right now.');
    expect(web.log).toHaveLength(0);
    expect(h.row('SELECT status, reason, platform FROM downloads WHERE user_id = ?', ALICE.id)).toEqual({ status: 'denied', reason: 'platform_off', platform: 'x' });
    expect(h.counter('dl_denied', '2026-11-05')).toBe(1);
  });

  it('links to unknown sites, unbuilt platforms, Telegram and refused URLs get specific answers', async () => {
    const cases = [
      ['https://example.org/video', 'unknown_site', 'This website isn’t supported'],
      ['https://www.tiktok.com/@a/video/1', 'not_built', 'TikTok isn’t supported yet'],
      ['https://t.me/wangerBots/5', 'telegram_link', 'Telegram links aren’t supported'],
      ['http://127.0.0.1/a', 'invalid_link', 'doesn’t look like a link'],
      ['https://x.com/SpaceX', 'unsupported_kind', 'This kind of X (Twitter) link'],
      ['https://story.snapchat.com/s/abc', 'unsupported_kind', 'This kind of Snapchat link'],
    ];
    for (const [link, reason, text] of cases) {
      const r = await h.send(ALICE, link);
      expect(r.download.reason, link).toBe(reason);
      expect(statusText(), link).toContain(text);
    }
    expect(web.log).toHaveLength(0);
  });

  it('a paused platform and the global switch stop downloads', async () => {
    enable('x', ['public'], { paused: true });
    expect((await h.send(ALICE, VIDEO_POST)).download.reason).toBe('platform_paused');
    enable('x', ['public']);
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('switch.downloads', 'false', 1) RETURNING key`);
    later();
    expect((await h.send(ALICE, VIDEO_POST)).download.reason).toBe('downloads_off');
    expect(web.log).toHaveLength(0);
  });

  it('quota and cooldown (staff exempt); a failed request gives the quota back', async () => {
    enable('x', ['public']);
    setLimits({ quota_per_day: 2, cooldown_s: 15, max_mb: 50 });
    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok');
    const quick = await h.send(ALICE, GIF_POST);
    expect(quick.download.reason).toBe('cooldown');
    expect(statusText()).toMatch(/wait \d+ seconds/);
    later();
    expect((await h.send(ALICE, TEXT_POST)).download.reason).toBe('no_media'); // failed → refunded
    later();
    expect((await h.send(ALICE, GIF_POST)).download.status).toBe('ok');
    later();
    const over = await h.send(ALICE, VIDEO_POST);
    expect(over.download.reason).toBe('quota');
    expect(statusText()).toContain('today’s limit of 2 downloads');
    h.row("INSERT INTO roles (user_id, role) VALUES (?, 'support') RETURNING user_id", ALICE.id);
    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok'); // staff: no quota, no cooldown
  });

  it('the blocklist: by URL, by account and by domain', async () => {
    enable('x', ['public']);
    enable('pinterest', ['public']);
    const block = (kind, value) => h.row('INSERT INTO blocklist (kind, value, created_at) VALUES (?, ?, 1) RETURNING id', kind, value);
    block('url', 'x:2112592291147747809');
    expect((await h.send(ALICE, PHOTO_POST)).download.reason).toBe('blocked');
    block('account', 'x:giphy');
    later();
    expect((await h.send(ALICE, GIF_POST)).download.reason).toBe('blocked');
    block('domain', 'pinterest.com');
    later();
    expect((await h.send(ALICE, PIN)).download.reason).toBe('blocked');
    expect(statusText()).toBe('⛔ This link can’t be downloaded.');
    expect(web.log).toHaveLength(0);
  });
});

describe('X', () => {
  beforeEach(() => enable('x', ['public']));

  it('a post with two videos: an album by URL, the best variant Telegram can fetch, caption with the source; status removed', async () => {
    const r = await h.send(ALICE, VIDEO_POST);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'x', method: 'public' });
    const album = sent('sendMediaGroup');
    expect(album).toHaveLength(1);
    const media = album[0].params.media;
    expect(media.map((m) => m.type)).toEqual(['video', 'video']);
    for (const m of media) {
      expect(m.media).toMatch(/^https:\/\/video\.twimg\.com\/.*\/1280x720\//); // 19 MB: the best ≤ 20 MB
    }
    expect(media[0].caption).toContain('👤 @SpaceX');
    expect(media[0].caption).toContain('🔗 X (Twitter):\nhttps://x.com/SpaceX/status/2115476295169814978');
    expect(media[0].caption).toContain('📉 Sent in a smaller quality'); // the 4K original is 140 MB
    expect(media[0].caption.length).toBeLessThanOrEqual(1024);
    expect(album[0].params.reply_parameters).toMatchObject({ allow_sending_without_reply: true });
    expect(h.tg.calls('deleteMessage')).toHaveLength(1);
    expect(h.row('SELECT status, method, items FROM downloads WHERE user_id = ? ORDER BY id DESC', ALICE.id)).toEqual({ status: 'ok', method: 'public', items: 2 });
    expect(h.counter('dl_ok:x', '2026-11-05')).toBe(1);
    expect(h.counter('dl_ok:x')).toBe(1);
  });

  it('a repeated link is re-sent from the file_id cache without fetching anything', async () => {
    await h.send(ALICE, VIDEO_POST);
    const items = JSON.parse(h.row('SELECT items FROM file_cache WHERE url_key = ?', 'x:2115476295169814978').items);
    expect(items.map((i) => i.type)).toEqual(['video', 'video']);
    web.reset();
    later();
    const r = await h.send(ALICE, 'https://twitter.com/SpaceX/status/2115476295169814978?s=20');
    expect(r.download).toMatchObject({ status: 'ok', cached: true, method: 'cache' });
    expect(web.log).toHaveLength(0);
    expect(sent('sendMediaGroup').at(-1).params.media.map((m) => m.media)).toEqual(items.map((i) => i.file_id));
    expect(h.counter('dl_cached', '2026-11-05')).toBe(1);
  });

  it('a stale cached file_id is dropped and the media fetched again', async () => {
    await h.send(ALICE, PHOTO_POST);
    h.row(`UPDATE file_cache SET items = '[{"type":"photo","file_id":"stale_1"},{"type":"photo","file_id":"stale_2"},{"type":"photo","file_id":"stale_3"}]' RETURNING url_key`);
    later();
    const r = await h.send(ALICE, PHOTO_POST);
    expect(r.download).toMatchObject({ status: 'ok', method: 'public' });
    expect(JSON.parse(h.row('SELECT items FROM file_cache').items)[0].file_id).not.toMatch(/^stale_/);
  });

  it('photos go as an album of originals; a GIF as an animation', async () => {
    await h.send(ALICE, PHOTO_POST);
    expect(sent('sendMediaGroup').at(-1).params.media.map((m) => [m.type, m.media.endsWith('name=orig')])).toEqual([['photo', true], ['photo', true], ['photo', true]]);
    later();
    await h.send(ALICE, GIF_POST);
    expect(sent('sendAnimation')).toHaveLength(1);
    expect(sent('sendAnimation')[0].params.animation).toMatch(/^https:\/\/video\.twimg\.com\//);
  });

  it('no media, a deleted post and a sensitive post each get their own message', async () => {
    expect((await h.send(ALICE, TEXT_POST)).download.reason).toBe('no_media');
    expect(statusText()).toBe('🖼 This post has no media I can download.');
    later();
    expect((await h.send(ALICE, MISSING_POST)).download.reason).toBe('not_found');
    expect(statusText()).toBe('🔍 I couldn’t find this post. It may have been deleted.');
    web.routes[syn('2115476295169814978')] = { json: { ...JSON.parse(fixture('syn_video.json')), possibly_sensitive: true } };
    later();
    expect((await h.send(ALICE, VIDEO_POST)).download.reason).toBe('sensitive');
    expect(h.tg.calls('sendMediaGroup')).toHaveLength(0);
  });

  it('a temporary failure of the public method falls back to the free third-party service when it is on', async () => {
    web.routes[syn('2115476295169814978')] = { status: 503, body: 'busy' };
    expect((await h.send(ALICE, VIDEO_POST)).download).toMatchObject({ status: 'failed', reason: 'unavailable' });
    expect(statusText()).toBe('⚠️ X (Twitter) isn’t answering right now. Please try again later.');
    enable('x', ['public', 'thirdparty']);
    later();
    const r = await h.send(ALICE, VIDEO_POST);
    expect(r.download).toMatchObject({ status: 'ok', method: 'thirdparty' });
    expect(web.requests('api.fxtwitter.com')).toHaveLength(1);
  });

  it('quality "best": a 41 MB variant is downloaded in Range chunks and uploaded', async () => {
    h.row("INSERT INTO user_settings (user_id, quality) VALUES (?, 'best') RETURNING user_id", ALICE.id);
    const r = await h.send(ALICE, VIDEO_POST);
    expect(r.download.status).toBe('ok');
    const media = sent('sendMediaGroup')[0].params.media;
    expect(media[0].media).toMatchObject({ __file: expect.stringMatching(/\.mp4$/), size: 41 * MB });
    expect(web.log.filter((l) => l.range && l.range !== 'bytes=0-0').length).toBe(4); // 2 videos × 2 chunks
  });

  it('quality "small" sends the smallest variant', async () => {
    h.row("INSERT INTO user_settings (user_id, quality) VALUES (?, 'small') RETURNING user_id", ALICE.id);
    await h.send(ALICE, VIDEO_POST);
    for (const m of sent('sendMediaGroup')[0].params.media) expect(xVideoSize(m.media)).toBe(2 * MB);
  });

  it('too big for the owner’s limit → says so with the sizes', async () => {
    setLimits({ max_mb: 1 });
    const r = await h.send(ALICE, VIDEO_POST);
    expect(r.download.reason).toBe('too_big');
    expect(statusText()).toBe('📦 The file is too big (2.0 MB); the limit is 1 MB.');
  });

  it('a media URL redirecting off the allowlist is never sent or fetched', async () => {
    web.routes['https://pbs.twimg.com/*'] = { redirect: 'https://evil.example.org/x.jpg' };
    const r = await h.send(ALICE, PHOTO_POST);
    expect(r.download.reason).toBe('no_media');
    expect(web.requests('evil.example.org')).toHaveLength(0);
    expect(h.tg.calls('sendMediaGroup')).toHaveLength(0);
  });

  it('only allowlisted hosts are ever requested, always with the bot’s honest User-Agent and manual redirects', async () => {
    await h.send(ALICE, VIDEO_POST);
    expect(web.log.length).toBeGreaterThan(3);
    for (const l of web.log) {
      expect(l.url, l.url).toMatch(/^https:\/\/(cdn\.syndication\.twimg\.com|video\.twimg\.com|pbs\.twimg\.com)\//);
      expect(l.ua).toMatch(/^WangerMediaBot\//);
      expect(l.redirect).toBe('manual');
    }
  });
});

describe('Pinterest and Snapchat', () => {
  it('a pin → its original image by URL, crediting the pinner', async () => {
    enable('pinterest', ['public']);
    const r = await h.send(ALICE, PIN);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'pinterest' });
    const p = sent('sendPhoto')[0].params;
    expect(p.photo).toMatch(/^https:\/\/i\.pinimg\.com\/originals\//);
    expect(p.caption).toContain('👤 @pinterest');
    expect(p.caption).toContain('🔗 Pinterest:\nhttps://www.pinterest.com/pin/424605071146271645/');
  });

  it('a pin.it short link is expanded hop by hop without loading the pin page', async () => {
    enable('pinterest', ['public']);
    const r = await h.send(ALICE, 'https://pin.it/4X1y2Zq');
    expect(r.download.status).toBe('ok');
    expect(web.requests('pin.it')).toHaveLength(1);
    expect(web.requests('api.pinterest.com')).toHaveLength(1);
    expect(web.requests('www.pinterest.com/pin')).toHaveLength(0);
  });

  it('when Telegram can’t fetch a URL, the file is uploaded instead', async () => {
    enable('pinterest', ['public']);
    h.tg.state.refuseUrls = true;
    const r = await h.send(ALICE, PIN);
    expect(r.download.status).toBe('ok');
    const calls = sent('sendPhoto');
    expect(calls).toHaveLength(2); // the refused URL attempt, then the upload
    expect(calls[0].params.photo).toMatch(/^https:\/\/i\.pinimg\.com\//);
    expect(calls[1].params.photo).toMatchObject({ __file: expect.stringMatching(/\.jpg$/), size: 37141 });
  });

  it('a Spotlight link → the video by URL, crediting the creator', async () => {
    enable('snapchat', ['public']);
    const r = await h.send(ALICE, SPOT);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'snapchat' });
    const v = sent('sendVideo')[0].params;
    expect(v.video).toMatch(/^https:\/\/cf-st\.sc-cdn\.net\//);
    expect(v.supports_streaming).toBe(true);
    expect(v.caption).toContain('@emeriefjones2');
  });

  it('one platform failing doesn’t break the others', async () => {
    enable('x', ['public']);
    enable('pinterest', ['public']);
    web.routes[syn('2115476295169814978')] = new Error('fetch: request failed');
    expect((await h.send(ALICE, VIDEO_POST)).download.reason).toBe('unavailable');
    later();
    expect((await h.send(ALICE, PIN)).download.status).toBe('ok');
    expect(h.rows('SELECT id FROM error_log')).toHaveLength(0);
  });
});

describe('owner panel', () => {
  const ownerScreen = () => h.lastScreen(OWNER.id);
  const datas = () => buttonsOf(ownerScreen()).map((b) => b.callback_data);

  it('lists built platforms (all off), shows the risk note before switching a method on, and audit-logs changes', async () => {
    expect((await h.send(OWNER, '/admin')).view).toBe('admin');
    expect(ownerScreen().text).toContain('Not built yet: TikTok');
    expect(datas()).toEqual(['P:x', 'P:pinterest', 'P:snapchat', 'h']);
    expect(buttonsOf(ownerScreen())[0].text).toContain('⚪');

    await h.press(OWNER, 'P:x', { messageId: 70 });
    expect(ownerScreen().text).toContain('Capability: supported');
    expect(ownerScreen().text).toContain('Official API: requires approval');
    expect(datas()).toEqual(['M:x:public:1', 'M:x:thirdparty:1', 'E:x:1', 'T:x', 'A', 'h']);

    await h.press(OWNER, 'M:x:public:1', { messageId: 70 });
    expect(ownerScreen().text).toContain('forbid crawling or scraping');
    expect(datas()).toEqual(['C:x:public', 'P:x']);
    expect(h.row("SELECT value FROM settings WHERE key = 'platform:x'")).toBeUndefined(); // nothing yet

    await h.press(OWNER, 'C:x:public', { messageId: 70 });
    expect(JSON.parse(h.row("SELECT value FROM settings WHERE key = 'platform:x'").value)).toEqual({ paused: false, methods: { public: true } });
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toBe('✅ Public data is on for X (Twitter).');
    expect(h.rows("SELECT actor_id, action, target, details FROM audit_log WHERE action LIKE 'platform.%'")).toEqual([
      { actor_id: OWNER.id, action: 'platform.method_on', target: 'x', details: '{"method":"public"}' },
    ]);

    expect((await h.send(ALICE, PHOTO_POST)).download.status).toBe('ok');

    await h.press(OWNER, 'E:x:1', { messageId: 70 });
    later();
    expect((await h.send(ALICE, GIF_POST)).download.reason).toBe('platform_paused');
    await h.press(OWNER, 'E:x:0', { messageId: 70 });
    await h.press(OWNER, 'M:x:public:0', { messageId: 70 });
    later();
    expect((await h.send(ALICE, GIF_POST)).download.reason).toBe('platform_off');
    expect(h.rows("SELECT action FROM audit_log WHERE action LIKE 'platform.%' ORDER BY id").map((r) => r.action))
      .toEqual(['platform.method_on', 'platform.pause', 'platform.resume', 'platform.method_off']);
  });

  it('the health check runs against the platform and reports the result', async () => {
    await h.press(OWNER, 'T:pinterest', { messageId: 71 });
    expect(ownerScreen().text).toContain('🩺 Pinterest: working (1 image(s))');
    web.routes['https://widgets.pinterest.com/v3/pidgets/pins/info/?pin_ids=424605071146271645'] = { status: 500, body: 'x' };
    await h.press(OWNER, 'T:pinterest', { messageId: 72 });
    expect(ownerScreen().text).toContain('🩺 Pinterest: not working (unavailable)');
  });

  it('nobody but the owner can open it or press its buttons', async () => {
    expect((await h.send(ALICE, '/admin')).view).toBe('home');
    const r = await h.press(ALICE, 'C:x:public', { messageId: 73 });
    expect(r.ignored).toBe('not_owner');
    h.row("INSERT INTO roles (user_id, role) VALUES (?, 'super_admin') RETURNING user_id", BORIS.id);
    await h.onboard(BORIS, 'ru');
    expect((await h.press(BORIS, 'M:x:public:1', { messageId: 74 })).ignored).toBe('not_owner');
    expect(h.row("SELECT value FROM settings WHERE key = 'platform:x'")).toBeUndefined();
  });

  it('a method the adapter doesn’t offer can’t be switched on', async () => {
    await h.press(OWNER, 'C:x:official', { messageId: 75 });
    expect(h.row("SELECT value FROM settings WHERE key = 'platform:x'")).toBeUndefined();
  });
});

describe('history', () => {
  it('downloads appear in My downloads', async () => {
    enable('pinterest', ['public']);
    await h.send(ALICE, PIN);
    await h.press(ALICE, 'H:0', { messageId: 80 });
    const text = h.lastScreen(ALICE.id).text;
    expect(text).toContain('✅');
    expect(text).toContain('Pinterest');
    expect(text).toContain('https://www.pinterest.com/pin/424605071146271645/');
  });
});
