// Phase 7 end to end: information cards (METADATA_ONLY platforms), Instagram and Discord media,
// in private chats and groups. Real handlers, the local SDK, a fake Telegram and a fake web serving
// the responses recorded from Serverless (test/fixtures). Tests never call real platforms.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, BORIS, OWNER, SARA, setup } from '../helpers/harness.js';
import { createWeb, fixture } from '../helpers/web.js';

const YT = 'https://youtu.be/dQw4w9WgXcQ';
const REDDIT = 'https://www.reddit.com/r/pics/comments/92dd8/test_post_please_ignore/';
const TRACK = 'https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl';
const TRACK2 = 'https://open.spotify.com/track/0000000000000000000002';
const TIKTOK_SHORT = 'https://vm.tiktok.com/ZMd5x6v9C/';
const TIKTOK = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
const IG = 'https://www.instagram.com/p/fA9uwTtkSN/';
const IG_SIDE = 'https://www.instagram.com/p/BQ0eAlwhDrw/';
const IG_REEL = 'https://www.instagram.com/reel/Chunk8-jurw/';
const IG_MISSING = 'https://www.instagram.com/p/AAAAAAAAAAA/';
const DC = 'https://cdn.discordapp.com/attachments/1100000000000000000/1200000000000000000';
const DC_PNG = `${DC}/cat.png?ex=6a&is=6b&hm=abc123`;
const DC_FAKE = `${DC}/fake.png?ex=6a&is=6b&hm=abc124`;
const DC_OLD = `${DC}/old.png?ex=1&is=2&hm=3`;
const DC_ZIP = `${DC}/tool.zip?ex=6a&is=6b&hm=abc125`;
const G = { id: -100500601, title: 'Cards group' };

const embed = (code) => `https://www.instagram.com/p/${code}/embed/captioned/`;
const routes = () => ({
  'https://www.youtube.com/oembed?*': { json: fixture('yt_oembed.json') },
  'https://i.ytimg.com/*': { size: 21011, type: 'image/jpeg' },
  'https://www.reddit.com/oembed?*': { json: fixture('reddit_oembed.json') },
  [TRACK]: { html: fixture('spotify_track.html') },
  [TRACK2]: { html: '<meta property="og:title" content="Other"><meta property="og:image" content="https://i.scdn.co/image/evil">' },
  'https://i.scdn.co/image/evil': { redirect: 'https://evil.example.net/x.jpg' },
  'https://i.scdn.co/*': { size: 46954, type: 'image/jpeg' },
  [TIKTOK_SHORT]: { redirect: TIKTOK + '?_r=1&_t=abc' },
  [TIKTOK]: { html: fixture('tiktok_page.html') },
  'https://p16-common-sign.tiktokcdn-eu.com/*': { size: 80130, type: 'image/jpeg' },
  [embed('fA9uwTtkSN')]: { html: fixture('ig_embed.html') },
  [embed('BQ0eAlwhDrw')]: { html: fixture('ig_sidecar.html') },
  [embed('Chunk8-jurw')]: { html: fixture('ig_reel.html') },
  [embed('AAAAAAAAAAA')]: { html: fixture('ig_missing.html') },
  'https://scontent-ams2-1.cdninstagram.com/*': ({ url }) => (/\.mp4\?/.test(url) ? { size: 2 * 1048576, type: 'video/mp4' } : { size: 150000, type: 'image/jpeg' }),
  [DC_PNG]: { size: 500000, type: 'image/png' },
  [DC_FAKE]: { size: 500000, type: 'text/html' },
});

let h;
let web;
beforeEach(async () => {
  h = setup();
  web = createWeb(routes());
  await h.onboard(ALICE, 'en');
  await h.onboard(OWNER, 'en');
  h.resetCalls();
  web.reset();
});
afterEach(() => { vi.useRealTimers(); });

const enable = (platform, methods) => h.row(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`,
  'platform:' + platform, JSON.stringify({ methods: Object.fromEntries(methods.map((m) => [m, true])) }),
);
const sent = (method, chatId = ALICE.id) => h.tg.calls(method).filter((c) => Number(c.params.chat_id) === chatId);
const statusText = () => { const e = sent('editMessageText'); return e.length ? e.at(-1).params.text : null; };
const later = () => h.advance(20);
const hosts = () => [...new Set(web.log.map((l) => l.url.split('/')[2]))].sort();
const DAY = '2026-11-05';

describe('information cards (METADATA_ONLY)', () => {
  it('YouTube: cover by URL with title, channel, link and why there is no file; the quota is given back; then from cache', async () => {
    enable('youtube', ['official']);
    const r = await h.send(ALICE, YT);
    expect(r.download).toMatchObject({ status: 'meta', platform: 'youtube', method: 'official' });
    const photo = sent('sendPhoto').at(-1).params;
    expect(photo.photo).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    for (const s of ['Rick Astley - Never Gonna Give You Up', '👤 Rick Astley', 'YouTube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'No video: YouTube allows downloads only in its own apps.']) {
      expect(photo.caption).toContain(s);
    }
    expect(h.tg.calls('deleteMessage')).toHaveLength(1); // the "processing…" status
    expect(hosts()).toEqual(['i.ytimg.com', 'www.youtube.com']);
    expect(h.row('SELECT dl_count FROM users WHERE id = ?', ALICE.id).dl_count).toBe(0); // a card doesn't use the quota
    expect(h.counter('dl_meta', DAY)).toBe(1);
    expect(h.counter('dl_meta:youtube')).toBe(1);
    expect(h.counter('dl_ok', DAY)).toBe(0);
    expect(h.row('SELECT status, platform FROM downloads WHERE user_id = ?', ALICE.id)).toEqual({ status: 'meta', platform: 'youtube' });

    expect((await h.send(ALICE, YT)).download.reason).toBe('cooldown'); // the cooldown still applies
    later();
    web.reset();
    const again = await h.send(ALICE, YT);
    expect(again.download).toMatchObject({ status: 'meta', cached: true });
    expect(web.log).toHaveLength(0);
    expect(sent('sendPhoto').at(-1).params.caption).toContain('No video: YouTube');

    await h.press(ALICE, 'H:0');
    expect(h.lastScreen(ALICE.id).text).toContain('ℹ️');
  });

  it('Reddit: no image in its oEmbed → a text card', async () => {
    enable('reddit', ['official']);
    const r = await h.send(ALICE, REDDIT);
    expect(r.download).toMatchObject({ status: 'meta', platform: 'reddit' });
    expect(sent('sendPhoto')).toHaveLength(0);
    const card = sent('sendMessage').map((c) => c.params.text).find((t) => t.includes('test post please ignore'));
    expect(card).toContain('u/qgyh2');
    expect(card).toContain('r/pics');
    expect(card).toContain('Reddit blocks automated access');
  });

  it('Spotify: details and cover; a cover Telegram can’t fetch, or one redirecting off the allowlist, gives a text card', async () => {
    enable('spotify', ['public']);
    expect((await h.send(ALICE, TRACK)).download.status).toBe('meta');
    expect(sent('sendPhoto').at(-1).params.caption).toContain('Carly Rae Jepsen · Cut To The Feeling · Song · 2017');
    expect(sent('sendPhoto').at(-1).params.caption).toContain('DRM');
    expect(web.log.some((l) => /p\.scdn\.co|mp3-preview/.test(l.url))).toBe(false); // never the audio preview

    later();
    h.tg.state.refuseUrls = true;
    h.row("DELETE FROM file_cache RETURNING url_key");
    expect((await h.send(ALICE, TRACK)).download.status).toBe('meta');
    expect(sent('sendMessage').at(-1).params.text).toContain('Carly Rae Jepsen · Cut To The Feeling');
    h.tg.state.refuseUrls = false;

    later();
    web.reset();
    const before = sent('sendPhoto').length;
    expect((await h.send(ALICE, TRACK2)).download.status).toBe('meta');
    expect(sent('sendPhoto')).toHaveLength(before);
    expect(sent('sendMessage').at(-1).params.text).toContain('Other');
    expect(hosts()).not.toContain('evil.example.net');
  });

  it('TikTok: a short link is followed to the video page; only the page and the cover are fetched', async () => {
    enable('tiktok', ['public']);
    const r = await h.send(ALICE, TIKTOK_SHORT);
    expect(r.download).toMatchObject({ status: 'meta', platform: 'tiktok' });
    expect(h.row('SELECT url FROM downloads WHERE user_id = ?', ALICE.id).url).toBe(TIKTOK); // recorded as the expanded link
    expect(hosts()).toEqual(['p16-common-sign.tiktokcdn-eu.com', 'vm.tiktok.com', 'www.tiktok.com']);
    const cap = sent('sendPhoto').at(-1).params.caption;
    expect(cap).toContain('👤 @scout2015');
    expect(cap).toContain('TikTok gives its video files only to visitors with its cookies');
  });

  it('metadata platforms switched off are refused like any other', async () => {
    expect((await h.send(ALICE, YT)).download).toMatchObject({ status: 'denied', reason: 'platform_off', platform: 'youtube' });
    expect(web.log).toHaveLength(0);
  });

  it('the overview counts information cards', async () => {
    enable('youtube', ['official']);
    await h.send(ALICE, YT);
    await h.press(OWNER, 'A:o');
    const text = h.lastScreen(OWNER.id).text;
    expect(text).toContain('ℹ️ cards 1');
    expect(text).toMatch(/YouTube.*1/);
  });
});

describe('Instagram (public embed)', () => {
  beforeEach(() => enable('instagram', ['public']));

  it('a video post → the MP4 by URL with caption and author', async () => {
    const r = await h.send(ALICE, IG);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'instagram', method: 'public' });
    const v = sent('sendVideo').at(-1).params;
    expect(v.video).toMatch(/^https:\/\/scontent-ams2-1\.cdninstagram\.com\/o1\/v\/.+\.mp4\?/);
    expect(v.caption).toContain('Wii Gato (Lipe Sleep)');
    expect(v.caption).toContain('👤 @diegoquinteiro');
    expect(web.log.filter((l) => l.method === 'HEAD')).toHaveLength(0); // its CDN is probed with Range only
  });

  it('a carousel → an album; a copyright-blocked reel → its cover with a note; a missing post → not found', async () => {
    await h.send(ALICE, IG_SIDE);
    expect(sent('sendMediaGroup').at(-1).params.media.map((m) => m.type)).toEqual(['video', 'video', 'video']);
    later();
    await h.send(ALICE, IG_REEL);
    const p = sent('sendPhoto').at(-1).params;
    expect(p.caption).toContain('Only the cover image is available publicly.');
    expect(sent('sendVideo')).toHaveLength(0);
    later();
    expect((await h.send(ALICE, IG_MISSING)).download).toMatchObject({ status: 'failed', reason: 'not_found' });
    expect(statusText()).toContain('couldn’t find this post');
  });
});

describe('Discord (direct attachment links)', () => {
  beforeEach(() => enable('discord', ['public']));

  it('an image link → sent by its signed URL, checked with one HEAD', async () => {
    const r = await h.send(ALICE, DC_PNG);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'discord' });
    expect(sent('sendPhoto').at(-1).params.photo).toBe(DC_PNG);
    expect(web.log.map((l) => l.method)).toEqual(['HEAD']);
  });

  it('expired links, other file types and mislabelled files are refused with the reason', async () => {
    expect((await h.send(ALICE, DC_OLD)).download).toMatchObject({ status: 'failed', reason: 'not_found' });
    expect(statusText()).toContain('Send a direct file link');
    later();
    web.reset();
    expect((await h.send(ALICE, DC_ZIP)).download).toMatchObject({ status: 'failed', reason: 'file_type' });
    expect(web.log).toHaveLength(0); // refused by its name, nothing fetched
    expect(statusText()).toContain('I only send images, GIFs and MP4 videos');
    later();
    expect((await h.send(ALICE, DC_FAKE)).download).toMatchObject({ status: 'failed', reason: 'file_type' }); // .png served as HTML
    expect(sent('sendPhoto')).toHaveLength(0);
    expect(h.row('SELECT dl_count FROM users WHERE id = ?', ALICE.id).dl_count).toBe(0); // failures give the quota back
  });
});

describe('information cards in groups', () => {
  beforeEach(async () => {
    h.tg.state.groupRoles.set(G.id, { [SARA.id]: 'creator', [BORIS.id]: 'administrator' });
    await h.chatMember({ chat: { ...G, type: 'supergroup' }, from: SARA, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: 9080356648 } } });
    h.row("UPDATE group_settings SET lang = 'en' WHERE chat_id = ? RETURNING chat_id", G.id);
    enable('youtube', ['official']);
    h.resetCalls();
    web.reset();
  });

  it('are off in a group until its admins switch the platform on', async () => {
    expect((await h.sendGroup(ALICE, G, YT)).ignored).toBeTruthy();
    expect(web.log).toHaveLength(0);
    await h.pressGroup(BORIS, G, 'G:p:youtube', { messageId: 953 });
    expect(JSON.parse(h.row('SELECT platforms FROM group_settings WHERE chat_id = ?', G.id).platforms)).toContain('youtube');
    const r = await h.sendGroup(ALICE, G, YT);
    expect(r.downloads).toEqual([{ status: 'meta', reason: null, platform: 'youtube' }]);
    expect(sent('sendPhoto', G.id).at(-1).params.caption).toContain('Rick Astley');
    expect(h.counter(`g_meta:${G.id}`, DAY)).toBe(1);
  });
});
