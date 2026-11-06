// The admin panel end to end (Phase 4): permissions on every button and input, users, channels,
// switches, texts, broadcast, audit log, staff, blocklist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, BORIS, buttonsOf, OWNER, SARA, setup } from '../helpers/harness.js';
import { CHANNELS } from '../helpers/telegram.js';
import { createWeb, fixture } from '../helpers/web.js';

let h;
beforeEach(async () => {
  h = setup();
  await h.onboard(OWNER, 'en');
  await h.onboard(ALICE, 'en');
  await h.onboard(BORIS, 'en');
  await h.onboard(SARA, 'en');
  h.resetCalls();
});
afterEach(() => { vi.useRealTimers(); });

const role = (user, r) => h.row('INSERT INTO roles (user_id, role) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role RETURNING user_id', user.id, r);
const screenOf = (user) => h.lastScreen(user.id);
const datas = (user) => buttonsOf(screenOf(user)).map((b) => b.callback_data).filter(Boolean);
const toast = () => h.tg.calls('answerCallbackQuery').at(-1).params;
let mid = 300;
const press = (user, data) => h.press(user, data, { messageId: ++mid });
const snapshot = () => JSON.stringify({
  settings: h.rows("SELECT key, value FROM settings WHERE key NOT IN ('hk') AND key NOT LIKE 'alert:%' ORDER BY key"),
  bans: h.rows('SELECT * FROM bans'), roles: h.rows('SELECT * FROM roles'), channels: h.rows('SELECT id, enabled FROM forced_channels'),
  block: h.rows('SELECT * FROM blocklist'), bc: h.rows('SELECT * FROM broadcasts'), users: h.rows('SELECT id, note, quota_override FROM users'),
});

describe('access', () => {
  const EVERY = ['A', 'A:o', 'A:u', `A:u:${ALICE.id}`, `A:ub:${ALICE.id}:7`, `A:uu:${ALICE.id}`, `A:uq:${ALICE.id}`, `A:un:${ALICE.id}`, `A:uh:${ALICE.id}:0`,
    'A:c', 'A:ca', 'A:c:1', 'A:ct:1', 'A:cr:1', 'A:cd:1', 'A:cD:1', 'A:p', 'A:pb', 'A:pba:url', 'A:pbd:1', 'A:pc', 'A:pe:x',
    'A:s', 'A:sm', 'A:sd', 'A:sf', 'A:sl:q', 'A:t', 'A:te:welcome:en', 'A:tr:welcome:en', 'A:b', 'A:bn', 'A:bs:1', 'A:bg:1', 'A:bx:1',
    'A:a:0', 'A:x', 'A:xa', `A:xr:${ALICE.id}:admin`, `A:xf:${ALICE.id}:0`, 'P:x', 'M:x:public:1', 'C:x:public', 'E:x:1', 'T:x'];

  it('an ordinary user gets nothing: /admin is the home menu, every panel button is silently ignored, nothing changes', async () => {
    expect((await h.send(ALICE, '/admin')).view).toBe('home');
    expect(datas(ALICE)).not.toContain('A');
    const before = snapshot();
    for (const data of EVERY) {
      const r = await press(ALICE, data);
      expect(r.ignored, data).toBe('not_allowed');
      expect(toast().text, data).toBeUndefined();
    }
    expect(snapshot()).toBe(before);
    expect(h.tg.calls('editMessageText').filter((c) => c.params.chat_id === ALICE.id)).toHaveLength(0);
  });

  it('each role sees only its sections; staff get the 🛠 button in the main menu', async () => {
    const sections = async (user) => { await h.send(user, '/admin'); return datas(user); };
    expect(await sections(OWNER)).toEqual(['A:o', 'A:u', 'A:c', 'A:p', 'A:s', 'A:t', 'A:b', 'A:a:0', 'A:x', 'h']);
    role(ALICE, 'support');
    expect(await sections(ALICE)).toEqual(['A:o', 'A:u', 'h']);
    role(ALICE, 'moderator');
    expect(await sections(ALICE)).toEqual(['A:o', 'A:u', 'h']);
    role(ALICE, 'admin');
    expect(await sections(ALICE)).toEqual(['A:o', 'A:u', 'A:p', 'A:b', 'A:a:0', 'h']);
    role(ALICE, 'super_admin');
    expect(await sections(ALICE)).toEqual(['A:o', 'A:u', 'A:p', 'A:s', 'A:t', 'A:b', 'A:a:0', 'A:x', 'h']);
    await h.send(ALICE, '/start');
    expect(datas(ALICE)).toContain('A');
    await h.send(BORIS, '/start');
    expect(datas(BORIS)).not.toContain('A');
  });

  it('a section the role lacks is refused even when its button is pressed directly', async () => {
    role(ALICE, 'support');
    for (const data of ['A:c', 'A:s', 'A:sm', 'A:b', 'A:x', 'A:p', 'M:x:public:1']) {
      expect((await press(ALICE, data)).ignored, data).toBe('not_allowed');
    }
    // support may look at users but not ban them: the users section refuses with a toast
    await press(ALICE, `A:ub:${BORIS.id}:7`);
    expect(toast()).toMatchObject({ text: '⛔ You don’t have permission for that.', show_alert: true });
    expect(h.rows('SELECT * FROM bans')).toHaveLength(0);
  });
});

describe('overview', () => {
  it('shows the running counters, nothing else', async () => {
    const put = (n, d, v) => h.row('INSERT INTO counters (name, day, value) VALUES (?, ?, ?) ON CONFLICT(name, day) DO UPDATE SET value = excluded.value RETURNING name', n, d, v);
    put('users', '', 120); put('users_blocked', '', 7); put('groups_active', '', 3); put('users_active', '2026-11-05', 40);
    put('users_new', '2026-11-05', 5); put('users_new', '2026-11-01', 6); put('users_new', '2026-10-20', 99);
    put('dl_ok', '2026-11-05', 30); put('dl_ok:x', '2026-11-05', 20); put('dl_ok:x', '', 500); put('dl_failed:pinterest', '', 4);
    await press(OWNER, 'A:o');
    const text = screenOf(OWNER).text;
    expect(text).toContain('Users: 120');
    expect(text).toContain('Active today: 40');
    expect(text).toContain('New today: 5 · last 7 days: 11'); // 99 from October is outside the week
    expect(text).toContain('Blocked the bot: 7');
    expect(text).toContain('Groups: 3');
    expect(text).toContain('✅ 30');
    expect(text).toContain('X (Twitter): today ✅ 20 ❌ 0 · all time ✅ 500 ❌ 0');
    expect(text).toContain('Pinterest: today ✅ 0 ❌ 0 · all time ✅ 0 ❌ 4');
  });
});

describe('users', () => {
  it('search by @username or id → profile; ban 7 days → the user is stopped; unban; all audit-logged', async () => {
    await press(OWNER, 'A:u');
    expect(screenOf(OWNER).text).toContain('numeric id or @username');
    expect((await h.send(OWNER, '@Alice')).view).toBe('admin_user');
    expect(screenOf(OWNER).text).toContain(`<code>${ALICE.id}</code>`);
    expect(datas(OWNER)).toEqual(expect.arrayContaining([`A:ub:${ALICE.id}:7`, `A:uq:${ALICE.id}`, `A:un:${ALICE.id}`]));

    await press(OWNER, `A:ub:${ALICE.id}:7`);
    expect(toast().text).toBe('⛔ Banned.');
    const ban = h.row('SELECT until, by_id FROM bans WHERE user_id = ?', ALICE.id);
    expect(ban.by_id).toBe(OWNER.id);
    expect(ban.until - Math.floor(Date.now() / 1000)).toBe(7 * 86400);
    expect((await h.send(ALICE, '/start')).view).toBe('banned');
    await press(OWNER, `A:uu:${ALICE.id}`);
    expect((await h.send(ALICE, '/start')).view).toBe('home');
    expect(h.rows("SELECT action, target FROM audit_log WHERE action LIKE 'user.%' ORDER BY id")).toEqual([
      { action: 'user.ban', target: String(ALICE.id) }, { action: 'user.unban', target: String(ALICE.id) },
    ]);

    await press(OWNER, 'A:u');
    expect((await h.send(OWNER, String(BORIS.id))).view).toBe('admin_user');
    await press(OWNER, 'A:u');
    expect((await h.send(OWNER, '@nobody_here')).view).toBe('admin_input_error');
  });

  it('ranks: a moderator can ban a user but not an admin; nobody can ban the owner', async () => {
    role(ALICE, 'moderator');
    role(SARA, 'admin');
    await press(ALICE, `A:ub:${BORIS.id}:1`);
    expect(h.row('SELECT user_id FROM bans WHERE user_id = ?', BORIS.id)).toBeTruthy();
    await press(ALICE, `A:ub:${SARA.id}:1`);
    expect(toast()).toMatchObject({ text: '⛔ You don’t have permission for that.', show_alert: true });
    expect(h.row('SELECT user_id FROM bans WHERE user_id = ?', SARA.id)).toBeUndefined();
    role(SARA, 'super_admin');
    await press(SARA, `A:ub:${OWNER.id}:0`);
    expect(h.row('SELECT user_id FROM bans WHERE user_id = ?', OWNER.id)).toBeUndefined();
    await press(SARA, `A:u:${OWNER.id}`);
    expect(datas(SARA).some((d) => d.startsWith('A:ub:'))).toBe(false); // no ban buttons on the owner
  });

  it('a personal quota and a note (the note text is not copied into the audit log)', async () => {
    await press(OWNER, `A:uq:${ALICE.id}`);
    expect((await h.send(OWNER, 'abc')).view).toBe('admin_input_error'); // asks again
    await h.send(OWNER, '1');
    expect(h.row('SELECT quota_override FROM users WHERE id = ?', ALICE.id).quota_override).toBe(1);
    expect(screenOf(OWNER).text).toContain('of 1 downloads (personal quota)');
    await press(OWNER, `A:un:${ALICE.id}`);
    await h.send(OWNER, 'Asked for <help> twice');
    expect(screenOf(OWNER).text).toContain('Note: Asked for &lt;help&gt; twice');
    expect(h.row("SELECT details FROM audit_log WHERE action = 'user.note'").details).toBe('{"length":22}');
    await press(OWNER, `A:un:${ALICE.id}`);
    await h.send(OWNER, '-');
    expect(h.row('SELECT note FROM users WHERE id = ?', ALICE.id).note).toBeNull();

    // the personal quota is what the download policy uses
    createWeb({ 'https://cdn.syndication.twimg.com/tweet-result?id=2112592291147747809*': { json: fixture('syn_photos.json') }, 'https://pbs.twimg.com/*': { size: 1000, type: 'image/jpeg' } });
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('platform:x', '{"methods":{"public":true}}', 1) RETURNING key`);
    expect((await h.send(ALICE, 'https://x.com/SpaceX/status/2112592291147747809')).download.status).toBe('ok');
    h.advance(20);
    expect((await h.send(ALICE, 'https://x.com/SpaceX/status/2112592291147747809')).download).toMatchObject({ status: 'denied', reason: 'quota' });
  });

  it('a pending input expires after 10 minutes; /cancel ends it', async () => {
    await press(OWNER, 'A:u');
    h.advance(601);
    expect((await h.send(OWNER, '@alice')).view).toBe('home');
    await press(OWNER, 'A:u');
    expect((await h.send(OWNER, '/cancel')).view).toBe('admin');
    expect((await h.send(OWNER, '@alice')).view).toBe('home');
  });
});

describe('forced-join channels (owner only)', () => {
  it('add by @username (the bot must be admin), duplicates refused, toggle, re-check, remove', async () => {
    h.tg.state.channels.push({ id: -1009999, username: 'newchan', title: 'New channel' }, { id: -1008888, username: 'noadmin', title: 'No admin' });
    h.tg.setBotStatus(-1008888, 'member');
    await press(OWNER, 'A:c');
    expect(screenOf(OWNER).text).toContain('(3/10)');
    await press(OWNER, 'A:ca');
    expect((await h.send(OWNER, '@noadmin')).view).toBe('admin_input_error');
    expect(h.lastScreen(OWNER.id).text).toContain('isn’t an admin there');
    expect((await h.send(OWNER, 'https://t.me/newchan')).view).toBe('admin_channel');
    const row = h.row("SELECT id, chat_id, enabled, bot_status FROM forced_channels WHERE username = 'newchan'");
    expect(row).toMatchObject({ chat_id: -1009999, enabled: 1, bot_status: 'ok' });
    await press(OWNER, 'A:ca');
    await h.send(OWNER, '@newchan');
    expect(h.lastScreen(OWNER.id).text).toContain('already in the list');

    await press(OWNER, `A:ct:${row.id}`);
    expect(h.row('SELECT enabled FROM forced_channels WHERE id = ?', row.id).enabled).toBe(0);
    await press(OWNER, `A:cr:${row.id}`);
    expect(screenOf(OWNER).text).toContain('The bot is an admin there');
    await press(OWNER, `A:cd:${row.id}`);
    expect(datas(OWNER)).toEqual([`A:cD:${row.id}`, `A:c:${row.id}`]);
    await press(OWNER, `A:cD:${row.id}`);
    expect(h.row('SELECT id FROM forced_channels WHERE id = ?', row.id)).toBeUndefined();
    expect(h.rows("SELECT action FROM audit_log WHERE action LIKE 'channel.%' ORDER BY id").map((r) => r.action)).toEqual(['channel.add', 'channel.disable', 'channel.remove']);
  });

  it('a forwarded post adds its channel; the list stops at 10', async () => {
    h.tg.state.channels.push({ id: -1007777, username: null, title: 'Private one' });
    await press(OWNER, 'A:ca');
    const fwd = { message_id: 99, from: OWNER, chat: { id: OWNER.id, type: 'private' }, date: 0, text: 'hello', forward_origin: { type: 'channel', chat: { id: -1007777, type: 'channel', title: 'Private one' }, message_id: 5 } };
    const { default: message } = await import('../../tgcloud/handlers/message.js');
    expect((await message(fwd, { update: { update_id: 5555, message: fwd } })).view).toBe('admin_channel');
    expect(h.row('SELECT title FROM forced_channels WHERE chat_id = -1007777').title).toBe('Private one');
    for (let i = 0; i < 6; i++) h.row('INSERT INTO forced_channels (username, added_at) VALUES (?, 1) RETURNING id', 'filler' + i);
    await press(OWNER, 'A:c');
    expect(datas(OWNER)).not.toContain('A:ca');
  });

  it('a super admin cannot touch channels, nor switch forced join off', async () => {
    role(SARA, 'super_admin');
    expect((await press(SARA, 'A:c')).ignored).toBe('not_allowed');
    await press(SARA, 'A:s');
    expect(datas(SARA)).not.toContain('A:sf');
    await press(SARA, 'A:sf');
    expect(toast().text).toBe('⛔ You don’t have permission for that.');
    expect(h.row("SELECT value FROM settings WHERE key = 'switch.forced_join'")).toBeUndefined();
  });
});

describe('switches, limits and texts', () => {
  it('maintenance and downloads switches; limits by input with bounds', async () => {
    role(SARA, 'super_admin');
    await press(SARA, 'A:sm');
    expect((await h.send(ALICE, '/start')).view).toBe('maintenance');
    expect((await h.send(SARA, '/start')).view).toBe('home'); // staff are exempt
    await press(SARA, 'A:sm');
    expect((await h.send(ALICE, '/start')).view).toBe('home');
    await press(SARA, 'A:sl:c');
    expect((await h.send(SARA, '9999')).view).toBe('admin_input_error');
    await h.send(SARA, '60');
    expect(JSON.parse(h.row("SELECT value FROM settings WHERE key = 'limits'").value)).toEqual({ quota_per_day: 30, cooldown_s: 60, max_mb: 50 });
    expect(screenOf(SARA).text).toContain('Cooldown between downloads: 60 s');
    await press(OWNER, 'A:sf');
    expect(h.row("SELECT value FROM settings WHERE key = 'switch.forced_join'").value).toBe('false');
  });

  it('custom welcome and join texts per language, escaped, with {name}; reset to default', async () => {
    await press(OWNER, 'A:te:welcome:en');
    await h.send(OWNER, 'Salut {name} <b>!</b>');
    await h.send(ALICE, '/start');
    expect(screenOf(ALICE).text).toBe('Salut Alice &lt;b&gt;!&lt;/b&gt;');
    await h.send(SARA, '/start'); // fa user? SARA chose en at onboarding
    expect(screenOf(SARA).text).toContain('Salut');
    await press(OWNER, 'A:te:join:en');
    await h.send(OWNER, 'Join our channels please');
    h.advance(301);
    h.tg.setMember(ALICE.id, 'left', [CHANNELS[0].id]);
    await h.send(ALICE, '/start');
    expect(screenOf(ALICE).text.startsWith('Join our channels please')).toBe(true);
    await press(OWNER, 'A:tr:welcome:en');
    h.tg.setMember(ALICE.id, 'member');
    h.advance(301);
    await h.send(ALICE, '/start');
    expect(screenOf(ALICE).text).toContain('Welcome to <b>Wanger Media</b>');
  });
});

describe('broadcast', () => {
  it('draft → start → batches of copies; blocked users are marked and counted; done', async () => {
    for (let i = 0; i < 30; i++) h.row('INSERT INTO users (id, created_at, last_seen_at) VALUES (?, 1, 1) RETURNING id', 2000 + i);
    h.tg.unreachable(2005);
    await press(OWNER, 'A:b');
    await press(OWNER, 'A:bn');
    expect((await h.send(OWNER, 'Big news!')).view).toBe('admin_broadcast');
    const b = h.row('SELECT id, status, source_chat FROM broadcasts');
    expect(b).toMatchObject({ status: 'draft', source_chat: OWNER.id });
    expect(screenOf(OWNER).text).toContain(`Draft #${b.id}`);

    const r = await h.press(OWNER, `A:bs:${b.id}`, { messageId: 777 });
    expect(r.view).toBe('admin_broadcast');
    expect(h.tg.calls('copyMessage')).toHaveLength(25); // 25 users; the blocked one answers 403
    let row = h.row('SELECT status, sent, blocked, cursor FROM broadcasts');
    expect(row).toMatchObject({ status: 'running', sent: 24, blocked: 1 });
    expect(h.row('SELECT blocked FROM users WHERE id = 2005').blocked).toBe(1);
    expect(h.counter('users_blocked')).toBe(1);
    expect(h.row("SELECT value FROM settings WHERE key = 'broadcast.active'").value).toBe(JSON.stringify({ id: b.id }));

    await h.press(OWNER, `A:bg:${b.id}`, { messageId: 777 });
    row = h.row('SELECT status, sent, blocked FROM broadcasts');
    expect(row).toMatchObject({ status: 'done', sent: 33, blocked: 1 }); // 4 onboarded + 30 − 1 blocked
    expect(h.row("SELECT value FROM settings WHERE key = 'broadcast.active'")).toBeUndefined();
    const calls = h.tg.calls('copyMessage').map((c) => c.params.chat_id);
    expect(calls).toHaveLength(34); // 33 delivered + 1 blocked, each tried once
    expect(new Set(calls).size).toBe(34); // nobody twice
    expect(h.rows("SELECT action FROM audit_log WHERE action LIKE 'broadcast.%' ORDER BY id").map((x) => x.action)).toEqual(['broadcast.draft', 'broadcast.start', 'broadcast.done']);
  });

  it('a 429 pauses the broadcast until retry_after; the next batch then runs piggybacked on any update', async () => {
    await press(OWNER, 'A:bn');
    await h.send(OWNER, 'Hello all');
    const id = h.row('SELECT id FROM broadcasts').id;
    h.tg.state.rateLimitAt = 2;
    await h.press(OWNER, `A:bs:${id}`, { messageId: 778 });
    expect(h.row('SELECT sent, status, resume_at FROM broadcasts')).toMatchObject({ sent: 1, status: 'running' });
    await h.press(OWNER, `A:bg:${id}`, { messageId: 778 });
    expect(toast().text).toMatch(/try again in \d+ s/);
    h.advance(10);
    const r = await h.send(ALICE, '/start'); // any update carries a small batch
    expect(r.broadcast).toMatchObject({ claimed: true, done: true });
    expect(h.row('SELECT status, sent FROM broadcasts')).toMatchObject({ status: 'done', sent: 4 });
  });

  it('a draft can be cancelled; one broadcast at a time', async () => {
    await press(OWNER, 'A:bn');
    await h.send(OWNER, 'First');
    await press(OWNER, 'A:bn');
    expect((await h.send(OWNER, 'Second')).view).toBe('admin_input_error');
    const id = h.row('SELECT id FROM broadcasts').id;
    await press(OWNER, `A:bx:${id}`);
    expect(h.row('SELECT status FROM broadcasts').status).toBe('cancelled');
    expect(h.tg.calls('copyMessage')).toHaveLength(0);
  });
});

describe('staff', () => {
  it('the owner appoints a super admin by @username; a super admin appoints admins but never super admins', async () => {
    await press(OWNER, 'A:xa');
    expect((await h.send(OWNER, '@alice')).view).toBe('admin_staff_member');
    expect(datas(OWNER)).toEqual(expect.arrayContaining([`A:xr:${ALICE.id}:super_admin`, `A:xr:${ALICE.id}:admin`]));
    await press(OWNER, `A:xr:${ALICE.id}:super_admin`);
    expect(h.row('SELECT role FROM roles WHERE user_id = ?', ALICE.id).role).toBe('super_admin');

    await press(ALICE, `A:x:${BORIS.id}`);
    expect(datas(ALICE)).not.toContain(`A:xr:${BORIS.id}:super_admin`);
    await press(ALICE, `A:xr:${BORIS.id}:super_admin`);
    expect(h.row('SELECT role FROM roles WHERE user_id = ?', BORIS.id)).toBeUndefined();
    await press(ALICE, `A:xr:${BORIS.id}:admin`);
    expect(h.row('SELECT role FROM roles WHERE user_id = ?', BORIS.id).role).toBe('admin');
    await press(ALICE, `A:xr:${ALICE.id}:user`); // not on oneself
    expect(h.row('SELECT role FROM roles WHERE user_id = ?', ALICE.id).role).toBe('super_admin');
    expect(h.rows("SELECT details FROM audit_log WHERE action = 'staff.role' ORDER BY id").map((r) => JSON.parse(r.details))).toEqual([
      { from: 'user', to: 'super_admin' }, { from: 'user', to: 'admin' },
    ]);
  });

  it('flags only narrow a role: an admin without “broadcast” loses the section', async () => {
    role(BORIS, 'admin');
    await press(OWNER, `A:x:${BORIS.id}`);
    const bit = Object.keys((await import('../../tgcloud/lib/roles.js')).P).indexOf('BROADCAST');
    await press(OWNER, `A:xf:${BORIS.id}:${bit}`);
    await h.send(BORIS, '/admin');
    expect(datas(BORIS)).not.toContain('A:b');
    expect((await press(BORIS, 'A:bn')).ignored).toBe('not_allowed');
    await press(OWNER, `A:xf:${BORIS.id}:${bit}`);
    expect(h.row('SELECT perms FROM roles WHERE user_id = ?', BORIS.id).perms).toBeNull(); // back to the defaults
  });
});

describe('platform tools', () => {
  it('blocklist by account and domain, removable; cache purge by link; recent failures', async () => {
    await press(OWNER, 'A:pba:account');
    await h.send(OWNER, 'x:SpaceX');
    expect(h.row("SELECT value FROM blocklist WHERE kind = 'account'").value).toBe('x:spacex');
    await press(OWNER, 'A:pba:domain');
    await h.send(OWNER, 'https://www.example-bad.com/x');
    expect(h.row("SELECT value FROM blocklist WHERE kind = 'domain'").value).toBe('example-bad.com');
    await press(OWNER, 'A:pba:url');
    expect((await h.send(OWNER, 'https://example.org/not-a-post')).view).toBe('admin_input_error');
    await h.send(OWNER, 'https://twitter.com/SpaceX/status/123?s=1');
    expect(h.row("SELECT value FROM blocklist WHERE kind = 'url'").value).toBe('x:123');
    const id = h.row("SELECT id FROM blocklist WHERE kind = 'domain'").id;
    await press(OWNER, `A:pbd:${id}`);
    expect(h.row('SELECT id FROM blocklist WHERE id = ?', id)).toBeUndefined();

    h.row(`INSERT INTO file_cache (url_key, variant, items, created_at) VALUES ('x:123', 'auto', '[]', 1), ('x:123', 'best', '[]', 1) RETURNING url_key`);
    await press(OWNER, 'A:pc');
    await h.send(OWNER, 'https://x.com/a/status/123');
    expect(h.rows("SELECT url_key FROM file_cache WHERE url_key = 'x:123'")).toHaveLength(0);
    expect(screenOf(OWNER).text).toContain('Removed 2 cached variant(s) of x:123');

    h.row(`INSERT INTO downloads (user_id, chat_id, platform, url, status, reason, created_at) VALUES (?, ?, 'x', 'https://x.com/a/status/9', 'failed', 'unavailable', 1) RETURNING id`, ALICE.id, ALICE.id);
    await press(OWNER, 'A:pe:x');
    expect(screenOf(OWNER).text).toContain('unavailable');
    expect(h.rows("SELECT action FROM audit_log WHERE action IN ('block.add', 'block.remove', 'cache.purge') ORDER BY id").map((r) => r.action))
      .toEqual(['block.add', 'block.add', 'block.add', 'block.remove', 'cache.purge']);
  });
});

describe('audit log', () => {
  it('pages the latest entries for those who may see them', async () => {
    for (let i = 0; i < 15; i++) h.row('INSERT INTO audit_log (at, actor_id, action, target) VALUES (?, ?, ?, ?) RETURNING id', 1793900000 + i, OWNER.id, 'test.action', 't' + i);
    await press(OWNER, 'A:a:0');
    expect(screenOf(OWNER).text).toContain('t14');
    expect(screenOf(OWNER).text).not.toContain('t4 ');
    expect(datas(OWNER)).toEqual(['A:a:1', 'A', 'h']);
    await press(OWNER, 'A:a:1');
    expect(screenOf(OWNER).text).toContain('t0');
    role(ALICE, 'moderator');
    expect((await press(ALICE, 'A:a:0')).ignored).toBe('not_allowed');
  });
});
