// Groups end to end (Phase 5): link pick-up, silence for everything else, cooldowns, admin-only
// settings, privacy-mode diagnostics, forced join in groups, intro.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, BORIS, buttonsOf, OWNER, SARA, setup } from '../helpers/harness.js';
import { CHANNELS } from '../helpers/telegram.js';
import { createWeb, fixture } from '../helpers/web.js';

const G = { id: -100500600, title: 'Test group' };
const PHOTOS = 'https://x.com/SpaceX/status/2112592291147747809';
const GIF = 'https://x.com/GIPHY/status/2090559778699489429';
const VIDEO = 'https://x.com/SpaceX/status/2115476295169814978';

let h;
let web;
beforeEach(async () => {
  h = setup();
  web = createWeb({
    'https://cdn.syndication.twimg.com/tweet-result?id=2112592291147747809*': { json: fixture('syn_photos.json') },
    'https://cdn.syndication.twimg.com/tweet-result?id=2090559778699489429*': { json: fixture('syn_gif.json') },
    'https://cdn.syndication.twimg.com/tweet-result?id=2115476295169814978*': { json: fixture('syn_video.json') },
    'https://video.twimg.com/*': { size: 5 * 1048576, type: 'video/mp4' },
    'https://pbs.twimg.com/*': { size: 200000, type: 'image/jpeg' },
  });
  await h.onboard(OWNER, 'en');
  h.tg.state.groupRoles.set(G.id, { [SARA.id]: 'creator', [BORIS.id]: 'administrator' });
  await h.chatMember({ chat: { ...G, type: 'supergroup' }, from: SARA, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: 9080356648 } } });
  h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('platform:x', '{"methods":{"public":true}}', 1) RETURNING key`);
  h.row("UPDATE group_settings SET lang = 'en' WHERE chat_id = ? RETURNING chat_id", G.id); // SARA (fa) added it
  h.resetCalls();
  web.reset();
});
afterEach(() => { vi.useRealTimers(); });

const inGroup = (method) => h.tg.calls(method).filter((c) => Number(c.params.chat_id) === G.id);
const lastGroupText = () => { const c = [...inGroup('sendMessage'), ...inGroup('editMessageText')]; return c.length ? c.at(-1).params.text : null; };
const gs = () => h.row('SELECT * FROM group_settings WHERE chat_id = ?', G.id);
const later = (s = 31) => h.advance(s);

describe('joining a group', () => {
  it('introduces itself in the adder’s language and says honestly what it can see', async () => {
    const g2 = { id: -100700800, title: 'Other', type: 'group' };
    await h.chatMember({ chat: g2, from: SARA, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: 9080356648 } } });
    const intro = h.tg.calls('sendMessage').filter((c) => c.params.chat_id === g2.id).at(-1).params.text;
    expect(intro).toContain('Wanger Media');
    expect(intro).toContain('فقط دستورها، ریپلای به پیام'); // privacy mode on, not an admin
    expect(h.row('SELECT lang FROM group_settings WHERE chat_id = ?', g2.id).lang).toBe('fa'); // SARA's Telegram language
    const g4 = { id: -100700810, title: 'English', type: 'group' };
    await h.chatMember({ chat: g4, from: ALICE, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member', user: { id: 9080356648 } } });
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === g4.id).at(-1).params.text).toContain('I can only see commands, replies to my messages and messages that mention me');
    const g3 = { id: -100700900, title: 'Admin group', type: 'supergroup' };
    await h.chatMember({ chat: g3, from: SARA, date: 0, old_chat_member: { status: 'left' }, new_chat_member: { status: 'administrator', user: { id: 9080356648 } } });
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === g3.id).at(-1).params.text).toContain('ادمینم'); // "I'm an admin here"
  });
});

describe('links in a group', () => {
  it('a supported link → media as a reply, status removed, recorded per group', async () => {
    const r = await h.sendGroup(ALICE, G, `look ${PHOTOS} nice`);
    expect(r.downloads).toEqual([{ status: 'ok', reason: null, platform: 'x' }]);
    const album = inGroup('sendMediaGroup');
    expect(album).toHaveLength(1);
    expect(album[0].params.reply_parameters).toMatchObject({ allow_sending_without_reply: true });
    expect(album[0].params.media[0].caption).toContain('https://x.com/SpaceX/status/2112592291147747809');
    expect(inGroup('deleteMessage')).toHaveLength(1);
    expect(h.row('SELECT user_id, chat_id, status FROM downloads')).toEqual({ user_id: ALICE.id, chat_id: G.id, status: 'ok' });
    expect(h.counter(`g_ok:${G.id}`, '2026-11-05')).toBe(1);
  });

  it('everything else is ignored silently: unknown sites, unbuilt or switched-off platforms, plain chat', async () => {
    for (const text of ['https://example.org/a', 'https://www.tiktok.com/@a/video/1', 'https://www.pinterest.com/pin/424605071146269969/', 'https://t.me/x/1', 'just chatting']) {
      const r = await h.sendGroup(ALICE, G, text);
      expect(r.ignored, text).toBeTruthy();
    }
    expect(h.tg.state.calls).toHaveLength(0);
    expect(web.log).toHaveLength(0);
    expect(h.rows('SELECT id FROM downloads')).toHaveLength(0);
  });

  it('cooldowns per member and per group are silent', async () => {
    await h.sendGroup(ALICE, G, PHOTOS);
    h.advance(6);
    expect((await h.sendGroup(ALICE, G, GIF)).ignored).toBe('member_cooldown'); // 30 s per member
    expect((await h.sendGroup(BORIS, G, GIF)).downloads[0].status).toBe('ok'); // another member, group cooldown 5 s passed
    expect((await h.sendGroup(SARA, G, PHOTOS)).ignored).toBe('group_cooldown');
    expect(lastGroupText()).not.toMatch(/wait/);
  });

  it('at most max_links links per message (default 3)', async () => {
    const r = await h.sendGroup(ALICE, G, `${PHOTOS} ${GIF} ${VIDEO} https://x.com/a/status/1`);
    expect(r.downloads).toHaveLength(3);
  });

  it('admins-only mode; banned users are ignored; silent mode hides status and errors', async () => {
    h.row('UPDATE group_settings SET admin_only = 1 WHERE chat_id = ? RETURNING chat_id', G.id);
    expect((await h.sendGroup(ALICE, G, PHOTOS)).ignored).toBe('admin_only');
    expect((await h.sendGroup(BORIS, G, PHOTOS)).downloads[0].status).toBe('ok');
    h.row('UPDATE group_settings SET admin_only = 0, silent = 1 WHERE chat_id = ? RETURNING chat_id', G.id);
    h.row('INSERT INTO bans (user_id, until, created_at) VALUES (?, 0, 1) RETURNING user_id', ALICE.id);
    later();
    expect((await h.sendGroup(ALICE, G, PHOTOS)).ignored).toBe('banned');
    h.resetCalls();
    web.routes['https://cdn.syndication.twimg.com/tweet-result?id=2090559778699489429*'] = { status: 503, body: 'x' };
    const r = await h.sendGroup(SARA, G, GIF);
    expect(r.downloads[0]).toMatchObject({ status: 'failed', reason: 'unavailable' });
    expect(h.tg.state.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')).toHaveLength(0);
  });

  it('automatic forwards from a linked channel and posts as a channel are never picked up', async () => {
    expect((await h.sendGroup(ALICE, G, PHOTOS, { extra: { is_automatic_forward: true } })).ignored).toBe('group_chatter');
    expect((await h.sendGroup(ALICE, G, PHOTOS, { extra: { sender_chat: { id: -1001, type: 'channel' } } })).ignored).toBe('group_chatter');
  });

  it('forced join in groups is off by default; when the owner switches it on, a non-member gets one prompt', async () => {
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('switch.group_join', 'true', 1) RETURNING key`);
    const r = await h.sendGroup(ALICE, G, PHOTOS);
    expect(r.view).toBe('group_join_prompt');
    expect(lastGroupText()).toContain('Alice, to use me in this group');
    expect(buttonsOf(inGroup('sendMessage').at(-1).params).map((b) => b.url)).toEqual(CHANNELS.map((c) => `https://t.me/${c.username}`));
    later();
    expect((await h.sendGroup(ALICE, G, PHOTOS)).ignored).toBe('join_prompted');
    h.tg.setMember(ALICE.id);
    later();
    expect((await h.sendGroup(ALICE, G, PHOTOS)).downloads[0].status).toBe('ok');
  });
});

describe('group commands', () => {
  it('/settings: admins only; anonymous admins count', async () => {
    expect((await h.sendGroup(ALICE, G, '/settings')).view).toBe('group_only_admins');
    expect((await h.sendGroup(BORIS, G, '/settings@Wanger_mediabot')).view).toBe('group_settings');
    expect((await h.sendGroup({ id: 1087968824, is_bot: true, first_name: 'Group' }, G, '/settings', { extra: { sender_chat: { id: G.id, type: 'supergroup' } } })).view).toBe('group_settings');
    expect((await h.sendGroup(ALICE, G, '/settings@OtherBot')).ignored).toBeTruthy();
  });

  it('settings buttons: re-checked with Telegram on every press; changes apply and are audit-logged', async () => {
    const r = await h.pressGroup(ALICE, G, 'G:a');
    expect(r.ignored).toBe('not_group_admin');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params).toMatchObject({ text: '⛔ Only group admins can change the settings.', show_alert: true });
    expect(gs().auto_download).toBe(1);
    await h.pressGroup(BORIS, G, 'G:a', { messageId: 951 });
    expect(gs().auto_download).toBe(0);
    expect((await h.sendGroup(ALICE, G, PHOTOS)).ignored).toBe('auto_off');
    await h.pressGroup(BORIS, G, 'G:a', { messageId: 952 });
    await h.pressGroup(BORIS, G, 'G:p:x', { messageId: 953 });
    expect(JSON.parse(gs().platforms)).toEqual(['pinterest', 'snapchat']);
    expect((await h.sendGroup(ALICE, G, PHOTOS)).ignored).toBe('no_usable_link');
    await h.pressGroup(BORIS, G, 'G:l:1', { messageId: 954 });
    await h.pressGroup(BORIS, G, 'G:L:ru', { messageId: 955 });
    expect(gs()).toMatchObject({ max_links: 1, lang: 'ru' });
    expect(h.tg.calls('editMessageText').at(-1).params.text).toContain('Настройки группы');
    expect(h.rows("SELECT actor_id FROM audit_log WHERE action = 'group.setting'").every((r) => r.actor_id === BORIS.id)).toBe(true);
    h.tg.state.groupRoles.get(G.id)[BORIS.id] = 'member'; // demoted in the group
    await h.pressGroup(BORIS, G, 'G:l:3', { messageId: 956 });
    expect(gs().max_links).toBe(1);
  });

  it('a double tap on a settings button toggles only once', async () => {
    await h.pressGroup(BORIS, G, 'G:s', { messageId: 960 });
    const second = await h.pressGroup(BORIS, G, 'G:s', { messageId: 960 });
    expect(second.doubleTap).toBe(true);
    expect(gs().silent).toBe(1);
  });

  it('/status shows the settings, today’s usage and an honest privacy diagnosis', async () => {
    await h.sendGroup(ALICE, G, PHOTOS);
    await h.sendGroup(ALICE, G, '/status');
    let text = lastGroupText();
    expect(text).toContain('Today in this group: ✅ 1');
    expect(text).toContain('privacy mode is on and I’m not an admin');
    h.tg.state.readAll = true;
    await h.sendGroup(ALICE, G, '/status');
    expect(lastGroupText()).toContain('My privacy mode is off');
    await h.chatMember({ chat: { ...G, type: 'supergroup' }, from: SARA, date: 0, old_chat_member: { status: 'member' }, new_chat_member: { status: 'administrator', user: { id: 9080356648 } } });
    h.tg.state.readAll = false;
    await h.sendGroup(ALICE, G, '/status');
    text = lastGroupText();
    expect(text).toContain('I’m an admin here');
  });

  it('/help and /platforms list only what is switched on', async () => {
    await h.sendGroup(ALICE, G, '/platforms');
    expect(lastGroupText()).toContain('X (Twitter): photos, videos, GIFs');
    expect(lastGroupText()).not.toContain('Pinterest');
  });
});
