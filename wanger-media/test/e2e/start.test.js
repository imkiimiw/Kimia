import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../helpers/telegram.js';
import { ALICE, BORIS, buttonsOf, OWNER, SARA, setup } from '../helpers/harness.js';

let h;
beforeEach(() => { h = setup(); });
afterEach(() => { vi.useRealTimers(); });

const datas = (screen) => buttonsOf(screen).map((b) => b.callback_data).filter(Boolean);
const urls = (screen) => buttonsOf(screen).map((b) => b.url).filter(Boolean);

describe('/start and language', () => {
  it('first /start shows the language picker with Telegram’s language preselected', async () => {
    const r = await h.send(ALICE, '/start');
    expect(r.ok).toBe(true);
    expect(r.view).toBe('language');
    const screen = h.lastScreen(ALICE.id);
    expect(datas(screen)).toEqual(['L:fa', 'L:en', 'L:ru']);
    expect(buttonsOf(screen).find((b) => b.callback_data === 'L:en').text.startsWith('✓')).toBe(true);
    expect(buttonsOf(screen).find((b) => b.callback_data === 'L:fa').text.startsWith('✓')).toBe(false);
    // prompt in all three languages on first run
    expect(screen.text).toContain('Please choose your language');
    expect(screen.text).toContain('Выберите язык');
    expect(screen.text).toContain('زبان را انتخاب کنید');
  });

  it('preselects Persian and Russian from Telegram too', async () => {
    await h.send(SARA, '/start');
    expect(buttonsOf(h.lastScreen(SARA.id)).find((b) => b.text.startsWith('✓')).callback_data).toBe('L:fa');
    await h.send(BORIS, 'hello');
    expect(buttonsOf(h.lastScreen(BORIS.id)).find((b) => b.text.startsWith('✓')).callback_data).toBe('L:ru');
  });

  it('picking a language saves it, then the forced-join gate lists only the missing channels', async () => {
    await h.send(ALICE, '/start');
    h.tg.setMember(ALICE.id, 'member', [CHANNELS[0].id]);
    const r = await h.press(ALICE, 'L:ru');
    expect(r.view).toBe('join');
    expect(r.join).toMatchObject({ pass: false, missing: 2, unknown: 0 });
    expect(h.row('SELECT lang FROM users WHERE id = ?', ALICE.id).lang).toBe('ru');
    const screen = h.lastScreen(ALICE.id);
    expect(screen.text).toContain('подпишитесь');
    expect(urls(screen)).toEqual(['https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
    expect(datas(screen)).toEqual(['j']);
    const toast = h.tg.calls('answerCallbackQuery').at(-1).params;
    expect(toast.text).toContain('Русский');
  });

  it('“check again” after joining → disclaimer (first use) → home menu; the pass is cached', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en');
    h.tg.setMember(ALICE.id, 'member');
    const r = await h.press(ALICE, 'j', { messageId: 901 });
    expect(r.view).toBe('disclaimer');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toBe('✅ Membership confirmed. Thank you!');
    expect(datas(h.lastScreen(ALICE.id))).toEqual(['a']);
    expect((await h.press(ALICE, 'a', { messageId: 901 })).view).toBe('home');
    expect(h.lastScreen(ALICE.id).text).toContain('Welcome to <b>Wanger Media</b>');
    expect(h.lastScreen(ALICE.id).text).toContain('isn’t available yet');
    expect(datas(h.lastScreen(ALICE.id))).toEqual(['H:0', 's', 'i', 'o']); // no Download button before Phase 3

    h.resetCalls();
    const again = await h.send(ALICE, '/start');
    expect(again.view).toBe('home');
    expect(again.join.cached).toBe(true);
    expect(h.tg.calls('getChatMember')).toHaveLength(0);

    h.advance(301); // pass expires → asks Telegram again
    const later = await h.send(ALICE, 'hi');
    expect(later.join.cached).toBe(false);
    expect(h.tg.calls('getChatMember')).toHaveLength(3);
  });

  it('a second /start never shows the language picker again; /language does', async () => {
    await h.onboard(ALICE, 'en');
    expect((await h.send(ALICE, '/start')).view).toBe('home');
    const r = await h.send(ALICE, '/language');
    expect(r.view).toBe('language');
    expect(datas(h.lastScreen(ALICE.id))).toEqual(['L:fa', 'L:en', 'L:ru', 'h', 'h']);
    expect(h.lastScreen(ALICE.id).text).toBe('🌐 Please choose your language:');
  });

  it('the owner and staff skip the forced-join gate', async () => {
    await h.send(OWNER, '/start');
    const r = await h.press(OWNER, 'L:fa');
    expect(r.view).toBe('home');
    expect(r.join.skipped).toBe(true);
    expect(h.tg.calls('getChatMember').filter((c) => c.params.user_id === OWNER.id)).toHaveLength(0);
    expect(h.lastScreen(OWNER.id).text).toContain('خوش آمدید');

    h.row("INSERT INTO roles (user_id, role) VALUES (?, 'support') RETURNING user_id", BORIS.id);
    await h.send(BORIS, '/start');
    const staff = await h.press(BORIS, 'L:ru');
    expect(staff.join.skipped).toBe(true);
    expect(staff.view).toBe('disclaimer'); // staff accept the disclaimer like users; only the owner doesn't
  });

  it('a banned user is told so (permanent and timed); the owner can never be banned', async () => {
    h.tg.setMember(ALICE.id);
    await h.send(ALICE, '/start');
    h.row('INSERT INTO bans (user_id, until, created_at) VALUES (?, 0, 1) RETURNING user_id', ALICE.id);
    expect((await h.send(ALICE, '/start')).view).toBe('banned');
    expect(h.lastScreen(ALICE.id).text).toContain('not allowed');

    const until = Math.floor(Date.now() / 1000) + 3600;
    h.row('UPDATE bans SET until = ? WHERE user_id = ? RETURNING user_id', until, ALICE.id);
    expect((await h.send(ALICE, 'x')).view).toBe('banned');
    h.advance(3601);
    expect((await h.send(ALICE, 'x')).view).toBe('language'); // ban over, no language chosen yet

    h.row('INSERT INTO bans (user_id, until, created_at) VALUES (?, 0, 1) RETURNING user_id', OWNER.id);
    expect((await h.send(OWNER, '/start')).view).toBe('language');
  });

  it('maintenance mode stops users but not the owner', async () => {
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('switch.maintenance', 'true', 1) RETURNING key`);
    expect((await h.send(ALICE, '/start')).view).toBe('maintenance');
    expect((await h.send(OWNER, '/start')).view).toBe('language');
  });

  it('an unknown or expired button shows a toast and a fresh screen', async () => {
    await h.onboard(ALICE, 'en');
    const r = await h.press(ALICE, 'old:menu:42', { messageId: 777 });
    expect(r.expired).toBe(true);
    expect(r.view).toBe('home');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toBe('This menu has expired.');
  });

  it('a message that can no longer be edited gets a new message instead', async () => {
    h.tg.setMember(ALICE.id);
    await h.send(ALICE, '/start');
    h.tg.failNext('editMessageText', h.tg.err(400, 'Bad Request: message to edit not found'));
    const r = await h.press(ALICE, 'L:en');
    expect(r.view).toBe('disclaimer');
    expect(h.tg.calls('sendMessage').at(-1).params.text).toContain('Before you start');
  });

  it('counts new and active users once per day (running counters, Tehran days)', async () => {
    await h.send(ALICE, '/start');
    await h.send(ALICE, 'again');
    await h.send(BORIS, '/start');
    expect(h.counter('users')).toBe(2);
    expect(h.counter('users_new', '2026-11-05')).toBe(2);
    expect(h.counter('users_active', '2026-11-05')).toBe(2);
    h.advance(24 * 3600);
    await h.send(ALICE, 'next day');
    expect(h.counter('users')).toBe(2);
    expect(h.counter('users_active', '2026-11-06')).toBe(1);
    expect(h.counter('users_new', '2026-11-06')).toBe(0);
  });

  it('group messages are ignored without any database write (groups come in Phase 5)', async () => {
    const msg = { message_id: 1, from: ALICE, chat: { id: -100777, type: 'supergroup', title: 'G' }, date: 0, text: '/start' };
    const { default: message } = await import('../../tgcloud/handlers/message.js');
    h.resetCalls();
    const r = await message(msg, { update: { update_id: 5, message: msg } });
    expect(r.ignored).toBe('not_private');
    expect(h.stats.queries).toBe(0);
    expect(h.tg.state.calls).toHaveLength(0);
  });
});

describe('forced join', () => {
  it('a getChatMember error is "unknown", never "member": the user is held and the owner told once', async () => {
    await h.send(ALICE, '/start');
    h.tg.setMember(ALICE.id, 'member', [CHANNELS[0].id, CHANNELS[1].id]);
    h.tg.setBotStatus(CHANNELS[2].id, 'member'); // bot lost admin in the third channel
    const r = await h.press(ALICE, 'L:en');
    expect(r.view).toBe('join');
    expect(r.join).toMatchObject({ pass: false, missing: 0, unknown: 1 });
    expect(h.lastScreen(ALICE.id).text).toContain('couldn’t check 1 channel');
    expect(urls(h.lastScreen(ALICE.id))).toEqual(['https://t.me/wangerBots']);
    const ch = h.row('SELECT bot_status FROM forced_channels WHERE lower(username) = ?', 'wangerbots');
    expect(ch.bot_status).toBe('error');
    const alerts = h.tg.calls('sendMessage').filter((c) => c.params.chat_id === OWNER.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].params.text).toContain('@wangerBots');

    // another user hits the same problem: no second alert within 3 hours
    await h.send(BORIS, '/start');
    await h.press(BORIS, 'L:ru');
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === OWNER.id)).toHaveLength(1);
    expect(h.row('SELECT join_ok_until FROM users WHERE id = ?', ALICE.id).join_ok_until).toBe(0);
  });

  it('a 403 from Telegram marks the channel not_admin; a 429 or network error says nothing about it', async () => {
    await h.send(ALICE, '/start');
    h.tg.setMember(ALICE.id);
    h.tg.state.members.set(`${CHANNELS[0].id}|${ALICE.id}`, h.tg.err(403, 'Forbidden: bot is not a member of the channel chat'));
    h.tg.state.members.set(`${CHANNELS[1].id}|${ALICE.id}`, h.tg.err(429, 'Too Many Requests: retry after 3', { retry_after: 3 }));
    const r = await h.press(ALICE, 'L:en');
    expect(r.join).toMatchObject({ pass: false, missing: 0, unknown: 2 });
    const st = Object.fromEntries(h.rows('SELECT username, bot_status FROM forced_channels').map((x) => [x.username, x.bot_status]));
    expect(st).toEqual({ HIDE_i_SEEK: 'not_admin', Nepenthw_ir: 'ok', wangerBots: 'ok' });
    expect(h.tg.calls('answerCallbackQuery').length).toBeGreaterThan(0);
  });

  it('“member not found” (never joined) means not a member, and the toast says so', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en');
    const r = await h.press(ALICE, 'j', { messageId: 902 });
    expect(r.join).toMatchObject({ pass: false, missing: 3, unknown: 0 });
    const toast = h.tg.calls('answerCallbackQuery').at(-1).params;
    expect(toast.text).toBe('You haven’t joined every channel yet.');
    expect(toast.show_alert).toBe(true);
  });

  it('left and kicked are not members; restricted-but-member is', async () => {
    await h.send(ALICE, '/start');
    h.tg.setMember(ALICE.id, 'left', [CHANNELS[0].id]);
    h.tg.setMember(ALICE.id, 'kicked', [CHANNELS[1].id]);
    h.tg.setMember(ALICE.id, 'restricted_member', [CHANNELS[2].id]);
    expect((await h.press(ALICE, 'L:en')).join).toMatchObject({ missing: 2, unknown: 0 });
  });

  it('turning the forced-join switch off lets everyone through', async () => {
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('switch.forced_join', 'false', 1) RETURNING key`);
    await h.send(ALICE, '/start');
    const r = await h.press(ALICE, 'L:en');
    expect(r.view).toBe('disclaimer');
    expect(r.join.skipped).toBe(true);
    expect(h.tg.calls('getChatMember').filter((c) => c.params.user_id === ALICE.id)).toHaveLength(0);
  });
});

describe('first-run seeding of the forced-join channels', () => {
  it('inserts the three channels once, resolves ids and titles, and audit-logs it', async () => {
    await h.send(ALICE, '/start');
    const rows = h.rows('SELECT username, chat_id, title, bot_status, enabled FROM forced_channels ORDER BY position');
    expect(rows.map((r) => r.username)).toEqual(['HIDE_i_SEEK', 'Nepenthw_ir', 'wangerBots']);
    expect(rows.map((r) => Number(r.chat_id))).toEqual(CHANNELS.map((c) => c.id));
    expect(rows.every((r) => r.bot_status === 'ok' && r.enabled === 1)).toBe(true);
    expect(h.rows("SELECT action FROM audit_log WHERE action = 'channels.seed'")).toHaveLength(1);

    h.resetCalls();
    await h.send(BORIS, '/start');
    expect(h.tg.calls('getChat')).toHaveLength(0);
    expect(h.rows('SELECT id FROM forced_channels')).toHaveLength(3);
  });

  it('is safe when two first updates run at the same time', async () => {
    await Promise.all([h.send(ALICE, '/start'), h.send(BORIS, '/start'), h.send(SARA, '/start')]);
    expect(h.rows('SELECT id FROM forced_channels')).toHaveLength(3);
    expect(h.tg.calls('getChat')).toHaveLength(3);
    expect(h.counter('users')).toBe(3);
  });

  it('never re-seeds after the flag is set, even if the table was emptied', async () => {
    await h.send(ALICE, '/start');
    h.row('DELETE FROM forced_channels RETURNING id');
    await h.send(BORIS, '/start');
    expect(h.rows('SELECT id FROM forced_channels')).toHaveLength(0);
  });

  it('a seed channel where the bot is not admin is stored as such and the owner is alerted', async () => {
    h.tg.setBotStatus(CHANNELS[1].id, 'member');
    await h.send(ALICE, '/start');
    const st = h.row("SELECT bot_status FROM forced_channels WHERE username = 'Nepenthw_ir'");
    expect(st.bot_status).toBe('not_admin');
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === OWNER.id)).toHaveLength(1);
  });
});
