// Phase 8 end to end: the owner's external service — configuration (owner only, the key never shown
// and its message deleted), the large-file relay, and the method 'external' (resolve). Real handlers,
// the local SDK, a fake Telegram and a fake web (the service is faked too).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MB } from '../../tgcloud/lib/config.js';
import { ALICE, BORIS, OWNER, setup } from '../helpers/harness.js';
import { createWeb, fixture } from '../helpers/web.js';

const SVC = 'https://dl.example-owner.net';
const KEY = 'k3y-For-The-Service-0123456789';
const DC = 'https://cdn.discordapp.com/attachments/1100000000000000000/1200000000000000000';
const BIG = `${DC}/long.mp4?ex=6a&is=6b&hm=abc123`;
const SMALL = `${DC}/short.mp4?ex=6a&is=6b&hm=abc124`;
const REDDIT = 'https://www.reddit.com/r/videos/comments/abc123/a_video/';

let h;
let web;
let svc; // the fake service's behaviour
beforeEach(async () => {
  h = setup();
  svc = { relay: { status: 202, json: { ok: true, queued: true } }, resolve: { status: 200, json: { ok: false, code: 'UNSUPPORTED' } } };
  web = createWeb({
    [SVC + '/v1/health']: ({ headers }) => (headers.Authorization === 'Bearer ' + KEY ? { json: { ok: true, version: '1.0.0', relay: { max_bytes: 2000 * MB }, resolve: false } } : { status: 401, json: { ok: false } }),
    [SVC + '/v1/relay']: () => svc.relay,
    [SVC + '/v1/resolve']: () => svc.resolve,
    [SVC + '/files/*']: { size: 3 * MB, type: 'video/mp4' },
    [BIG]: { size: 300 * MB, type: 'video/mp4' },
    [SMALL]: { size: 4 * MB, type: 'video/mp4' },
    'https://evil.example.org/*': { size: 1000, type: 'video/mp4' },
  });
  await h.onboard(OWNER, 'en');
  await h.onboard(ALICE, 'en');
  await h.onboard(BORIS, 'en');
  h.row('INSERT INTO roles (user_id, role) VALUES (?, ?) RETURNING user_id', BORIS.id, 'super_admin');
  h.resetCalls();
  web.reset();
});
afterEach(() => { vi.useRealTimers(); });

const enable = (platform, methods) => h.row(
  `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`,
  'platform:' + platform, JSON.stringify({ methods: Object.fromEntries(methods.map((m) => [m, true])) }),
);
const configure = (extra = {}) => h.row(
  `INSERT INTO settings (key, value, updated_at) VALUES ('external', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value RETURNING key`,
  JSON.stringify({ url: SVC, key: KEY, relay: true, ...extra }),
);
const screen = (u) => h.lastScreen(u.id);
const allBotText = () => h.tg.state.calls.map((c) => JSON.stringify(c.params)).join('\n');
const statusText = () => { const e = h.tg.calls('editMessageText').filter((c) => Number(c.params.chat_id) === ALICE.id); return e.length ? e.at(-1).params.text : null; };

describe('configuring the external service', () => {
  it('only the owner: address, key (message deleted, never shown or logged), relay, test, removal', async () => {
    expect((await h.press(BORIS, 'A:z')).ignored).toBe('not_allowed'); // a super admin isn't the owner
    await h.press(OWNER, 'A:p');
    expect(JSON.stringify(screen(OWNER).reply_markup)).toContain('"A:z"');
    await h.press(BORIS, 'A:p');
    expect(JSON.stringify(screen(BORIS).reply_markup)).not.toContain('"A:z"');

    await h.press(OWNER, 'A:z');
    expect(screen(OWNER).text).toContain('External service');
    await h.press(OWNER, 'A:zr');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toContain('address and key first');

    await h.press(OWNER, 'A:zu');
    await h.send(OWNER, 'http://10.0.0.1/x');
    expect(screen(OWNER).text).toContain('isn’t an https:// address');
    await h.send(OWNER, SVC + '/');
    expect(screen(OWNER).text).toContain('Address: ' + SVC);

    await h.press(OWNER, 'A:zk');
    const keyMsg = await h.send(OWNER, KEY);
    const deleted = h.tg.calls('deleteMessage').filter((c) => c.params.chat_id === OWNER.id);
    expect(deleted.length).toBeGreaterThan(0);
    expect(keyMsg).toBeTruthy();
    expect(screen(OWNER).text).toContain('Key: saved ✅');
    expect(allBotText()).not.toContain(KEY);
    expect(JSON.stringify(h.rows('SELECT * FROM audit_log'))).not.toContain(KEY);

    h.advance(2); // past the double-tap guard (same button, same message)
    await h.press(OWNER, 'A:zr');
    expect(JSON.parse(h.row("SELECT value FROM settings WHERE key = 'external'").value)).toMatchObject({ url: SVC, relay: true });
    await h.press(OWNER, 'A:zt');
    expect(screen(OWNER).text).toContain('The service answered: version 1.0.0, relay 2000 MB, resolve off');
    expect(web.log.filter((l) => l.auth).every((l) => l.url.startsWith(SVC + '/'))).toBe(true); // the key goes only to the service

    await h.press(OWNER, 'A:zx');
    expect(h.row("SELECT key FROM settings WHERE key = 'external'")).toBeUndefined();
    expect(h.rows("SELECT action FROM audit_log WHERE action LIKE 'external.%' ORDER BY id").map((r) => r.action)).toEqual(['external.url', 'external.key', 'external.relay', 'external.test', 'external.clear']);
  });

  it('the method "external" can’t be switched on before the service is set up', async () => {
    await h.press(OWNER, 'M:reddit:external:1');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toContain('address and key first');
    expect(h.row("SELECT key FROM settings WHERE key = 'platform:reddit'")).toBeUndefined();
    configure();
    h.advance(2); // past the double-tap guard
    await h.press(OWNER, 'M:reddit:external:1');
    expect(screen(OWNER).text).toContain('Your own server fetches the media'); // its risk note first
    await h.press(OWNER, 'P:spotify');
    expect(JSON.stringify(screen(OWNER).reply_markup)).not.toContain('external'); // never for DRM-protected Spotify
  });
});

describe('large-file relay', () => {
  beforeEach(() => enable('discord', ['public']));

  it('a file over 50 MB is handed to the service with the CDN allowlist; the user is told it is on its way', async () => {
    configure();
    const r = await h.send(ALICE, BIG);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'discord', method: 'relay' });
    const call = web.log.find((l) => l.url === SVC + '/v1/relay');
    const job = JSON.parse(call.body);
    expect(job).toMatchObject({ url: BIG, allow_hosts: ['cdn.discordapp.com', 'media.discordapp.net'], bytes: 300 * MB, type: 'video', chat_id: ALICE.id });
    expect(job.caption).toContain('Discord');
    expect(job.fail_text).toContain('couldn’t be sent');
    expect(call.auth).toBe('Bearer ' + KEY);
    expect(h.tg.calls('sendVideo')).toHaveLength(0); // the service sends it
    expect(statusText()).toContain('being sent through the bot’s file server');
  });

  it('relay off, the service refusing, or a small file → the bot’s own limits as before', async () => {
    configure({ relay: false });
    expect((await h.send(ALICE, BIG)).download).toMatchObject({ status: 'failed', reason: 'too_big' });
    expect(web.log.some((l) => l.url.startsWith(SVC))).toBe(false);
    h.advance(20);
    configure();
    svc.relay = { status: 500, json: { ok: false, code: 'ERROR' } };
    expect((await h.send(ALICE, BIG)).download).toMatchObject({ status: 'failed', reason: 'too_big' });
    h.advance(20);
    web.reset();
    expect((await h.send(ALICE, SMALL)).download).toMatchObject({ status: 'ok', method: 'public' });
    expect(web.log.some((l) => l.url.startsWith(SVC))).toBe(false);
  });

  it('never in groups (the group’s own size limit applies)', async () => {
    configure();
    const G = { id: -100900100, title: 'G' };
    h.tg.state.groupRoles.set(G.id, { [OWNER.id]: 'creator' });
    await h.chatMember({ chat: { ...G, type: 'supergroup' }, from: OWNER, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: 9080356648 } } });
    h.row("UPDATE group_settings SET lang = 'en' WHERE chat_id = ? RETURNING chat_id", G.id);
    web.reset();
    const r = await h.sendGroup(ALICE, G, BIG);
    expect(r.downloads[0]).toMatchObject({ status: 'failed', reason: 'too_big' });
    expect(web.log.some((l) => l.url.startsWith(SVC))).toBe(false);
  });
});

describe('the method "external" (resolve)', () => {
  beforeEach(() => {
    configure();
    enable('reddit', ['external']);
  });

  it('files only from the service’s own host, every policy check still applied', async () => {
    svc.resolve = { status: 200, json: { ok: true, title: 'A video', author: 'u/someone', items: [
      { type: 'video', url: SVC + '/files/abc/video.mp4', bytes: 3 * MB, mime: 'video/mp4', width: 1280, height: 720, duration: 30 },
      { type: 'video', url: 'https://evil.example.org/x.mp4', bytes: 1000 },
      { type: 'document', url: SVC + '/files/abc/x.exe', bytes: 1000 },
    ] } };
    const r = await h.send(ALICE, REDDIT);
    expect(r.download).toMatchObject({ status: 'ok', platform: 'reddit', method: 'external' });
    const body = JSON.parse(web.log.find((l) => l.url === SVC + '/v1/resolve').body);
    expect(body).toMatchObject({ url: 'https://www.reddit.com/r/videos/comments/abc123/', platform: 'reddit', max_bytes: 50 * MB });
    const v = h.tg.calls('sendVideo').at(-1).params;
    expect(v.video).toBe(SVC + '/files/abc/video.mp4');
    expect(v.caption).toContain('A video');
    expect(web.log.some((l) => l.url.includes('evil.example.org'))).toBe(false);
    expect(h.tg.calls('sendMediaGroup')).toHaveLength(0); // the other two items were dropped
  });

  it('the service’s refusals become the usual answers (DRM, not found)', async () => {
    svc.resolve = { status: 200, json: { ok: false, code: 'DRM' } };
    expect((await h.send(ALICE, REDDIT)).download).toMatchObject({ status: 'failed', reason: 'drm' });
    expect(statusText()).toContain('DRM-protected');
    h.advance(20);
    svc.resolve = { status: 200, json: { ok: false, code: 'NOT_FOUND' } };
    expect((await h.send(ALICE, REDDIT)).download).toMatchObject({ status: 'failed', reason: 'not_found' });
  });
});

describe('fixtures stay usable', () => {
  it('the recorded Reddit answer is still valid JSON', () => {
    expect(JSON.parse(fixture('reddit_oembed.json')).title).toBe('test post please ignore');
  });
});
