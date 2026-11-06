import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCLAIMER_VERSION_AT } from '../../tgcloud/lib/config.js';
import { ALICE, BORIS, buttonsOf, OWNER, setup } from '../helpers/harness.js';

let h;
beforeEach(() => { h = setup(); });
afterEach(() => { vi.useRealTimers(); });

const datas = (screen) => buttonsOf(screen).map((b) => b.callback_data).filter(Boolean);
const screen = () => h.lastScreen(ALICE.id);

function addDownloads(userId, n, { platform = 'x', status = 'ok', startAt = 1793900000 } = {}) {
  for (let i = 0; i < n; i++) {
    h.row(`INSERT INTO downloads (user_id, chat_id, platform, url, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      userId, userId, platform, `https://x.com/u/status/${userId}${String(i).padStart(4, '0')}`, status, startAt + i * 60);
  }
}

describe('disclaimer', () => {
  it('is asked once, after the forced-join gate, and stored', async () => {
    const r = await h.onboard(ALICE, 'en');
    expect(r.view).toBe('home');
    expect(h.row('SELECT disclaimer_at FROM users WHERE id = ?', ALICE.id).disclaimer_at).toBeGreaterThanOrEqual(DISCLAIMER_VERSION_AT);
    expect((await h.send(ALICE, '/start')).view).toBe('home');
    expect((await h.send(ALICE, 'anything')).view).toBe('home');
  });

  it('comes before every menu screen until accepted', async () => {
    h.tg.setMember(ALICE.id);
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en');
    for (const cmd of ['/settings', '/help', '/downloads', '/about']) expect((await h.send(ALICE, cmd)).view, cmd).toBe('disclaimer');
    for (const data of ['s', 'H:0', 'i', 'o', 'q', 'Q:best']) expect((await h.press(ALICE, data, { messageId: 10 + data.length })).view, data).toBe('disclaimer');
    expect(h.row('SELECT quality FROM user_settings WHERE user_id = ?', ALICE.id)).toBeUndefined();
  });

  it('is asked again when its version date is raised', async () => {
    await h.onboard(ALICE, 'en');
    h.row('UPDATE users SET disclaimer_at = ? WHERE id = ? RETURNING id', DISCLAIMER_VERSION_AT - 1, ALICE.id);
    expect((await h.send(ALICE, '/start')).view).toBe('disclaimer');
  });

  it('the owner is never asked', async () => {
    await h.send(OWNER, '/start');
    expect((await h.press(OWNER, 'L:fa')).view).toBe('home');
  });

  it('accepting twice is harmless', async () => {
    await h.onboard(ALICE, 'en');
    const at = h.row('SELECT disclaimer_at FROM users WHERE id = ?', ALICE.id).disclaimer_at;
    h.advance(100);
    expect((await h.press(ALICE, 'a', { messageId: 3 })).view).toBe('home');
    expect(h.row('SELECT disclaimer_at FROM users WHERE id = ?', ALICE.id).disclaimer_at).toBe(at);
  });
});

describe('main menu and navigation', () => {
  it('home offers exactly the built features; every other screen has Back and Home to the right parent', async () => {
    await h.onboard(ALICE, 'en');
    expect(datas(screen())).toEqual(['d', 'H:0', 's', 'i', 'o']);
    const expectNav = (back) => {
      const d = datas(screen());
      expect(d.slice(-2), JSON.stringify(d)).toEqual([back, 'h']);
      const labels = buttonsOf(screen()).slice(-2).map((b) => b.text);
      expect(labels).toEqual(['⬅️ Back', '🏠 Home']);
    };
    await h.press(ALICE, 'd', { messageId: 19 }); expectNav('h');
    await h.press(ALICE, 'H:0', { messageId: 20 }); expectNav('h');
    await h.press(ALICE, 's', { messageId: 21 }); expectNav('h');
    await h.press(ALICE, 'q', { messageId: 22 }); expectNav('s');
    await h.press(ALICE, 'l:s', { messageId: 23 }); expectNav('s');
    await h.press(ALICE, 'i', { messageId: 24 }); expectNav('h');
    await h.press(ALICE, 'o', { messageId: 25 }); expectNav('h');
    expect((await h.press(ALICE, 'h', { messageId: 26 })).view).toBe('home');
  });

  it('commands open their screens', async () => {
    await h.onboard(ALICE, 'en');
    expect((await h.send(ALICE, '/help')).view).toBe('help');
    expect((await h.send(ALICE, '/about')).view).toBe('about');
    expect(screen().text).toContain('version 0.3.0');
    expect(screen().text).not.toContain('Serverless');
    expect(screen().text).toContain('\n@wangerBots');
    expect((await h.send(ALICE, '/settings')).view).toBe('settings');
    expect((await h.send(ALICE, '/downloads')).view).toBe('downloads');
    expect((await h.send(ALICE, '/history')).view).toBe('downloads');
    expect((await h.send(ALICE, '/unknown')).view).toBe('home');
  });

  it('help and the Download screen list only the platforms switched on', async () => {
    await h.onboard(ALICE, 'ru');
    await h.send(ALICE, '/help');
    expect(screen().text).toContain('— пока ни одной —');
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('platform:x', '{"methods":{"public":true}}', 1) RETURNING key`);
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('platform:snapchat', '{"methods":{"public":true},"paused":true}', 1) RETURNING key`);
    await h.send(ALICE, '/help');
    expect(screen().text).toContain('X (Twitter): фото, видео, GIF');
    expect(screen().text).not.toContain('Snapchat'); // paused
    expect(screen().text).not.toContain('Pinterest'); // off
    await h.press(ALICE, 'd', { messageId: 9 });
    expect(screen().text).toContain('X (Twitter)');
    h.row(`INSERT INTO settings (key, value, updated_at) VALUES ('switch.downloads', 'false', 1) RETURNING key`);
    await h.press(ALICE, 'd', { messageId: 10 });
    expect(screen().text).toContain('Скачивание сейчас выключено');
  });

  it('navigation still runs the gates: a user who left a channel gets the gate, a banned user the ban', async () => {
    await h.onboard(ALICE, 'en');
    h.advance(301); // the forced-join pass has expired
    h.tg.setMember(ALICE.id, 'left');
    expect((await h.press(ALICE, 's', { messageId: 30 })).view).toBe('join');
    h.tg.setMember(ALICE.id, 'member');
    expect((await h.press(ALICE, 's', { messageId: 31 })).view).toBe('settings');
    h.row('INSERT INTO bans (user_id, until, created_at) VALUES (?, 0, 1) RETURNING user_id', ALICE.id);
    expect((await h.press(ALICE, 'H:0', { messageId: 32 })).view).toBe('banned');
  });
});

describe('my downloads', () => {
  it('shows an honest empty state', async () => {
    await h.onboard(ALICE, 'en');
    await h.press(ALICE, 'H:0', { messageId: 40 });
    expect(screen().text).toContain('You haven’t downloaded anything yet.');
    expect(datas(screen())).toEqual(['h', 'h']);
  });

  it('pages the user’s own history, newest first, 8 per page', async () => {
    await h.onboard(ALICE, 'en');
    addDownloads(ALICE.id, 20);
    addDownloads(BORIS.id, 5, { platform: 'pinterest' });
    await h.press(ALICE, 'H:0', { messageId: 41 });
    let s = screen();
    expect(s.text).toContain('Page 1 of 3');
    expect(s.text).toContain(`${ALICE.id}0019`); // newest
    expect(s.text).not.toContain(`${ALICE.id}0011`);
    expect(s.text).not.toContain(String(BORIS.id) + '000');
    expect((s.text.match(/✅/g) || []).length).toBe(8);
    expect(datas(s)).toEqual(['H:1', 'h', 'h']);
    await h.press(ALICE, 'H:1', { messageId: 41 });
    expect(datas(screen())).toEqual(['H:0', 'H:2', 'h', 'h']);
    await h.press(ALICE, 'H:2', { messageId: 41 });
    s = screen();
    expect(s.text).toContain('Page 3 of 3');
    expect((s.text.match(/✅/g) || []).length).toBe(4);
    expect(datas(s)).toEqual(['H:1', 'h', 'h']);
  });

  it('keeps to the latest 100 and clamps a page beyond the end', async () => {
    await h.onboard(ALICE, 'en');
    addDownloads(ALICE.id, 120, { status: 'failed' });
    await h.press(ALICE, 'H:12', { messageId: 42 });
    expect(screen().text).toContain('Page 13 of 13');
    expect((screen().text.match(/❌/g) || []).length).toBe(4);
    expect(screen().text).not.toContain(`${ALICE.id}0019`); // the 20 oldest are beyond the latest 100
    h.row('DELETE FROM downloads WHERE user_id = ? AND id > (SELECT min(id) + 2 FROM downloads WHERE user_id = ?) RETURNING id', ALICE.id, ALICE.id);
    await h.press(ALICE, 'H:12', { messageId: 43 });
    expect(screen().text).toContain('Page 1 of 1');
  });

  it('an out-of-range page code is treated as an expired menu', async () => {
    await h.onboard(ALICE, 'en');
    const r = await h.press(ALICE, 'H:13', { messageId: 44 });
    expect(r.expired).toBe(true);
  });

  it('escapes what it shows', async () => {
    await h.onboard(ALICE, 'en');
    h.row(`INSERT INTO downloads (user_id, chat_id, platform, url, status, created_at) VALUES (?, ?, 'x', '<b>https://evil</b>', 'denied', 1) RETURNING id`, ALICE.id, ALICE.id);
    await h.press(ALICE, 'H:0', { messageId: 45 });
    expect(screen().text).toContain('&lt;b&gt;https://evil&lt;/b&gt;');
    expect(screen().text).toContain('⛔');
  });
});

describe('settings', () => {
  it('shows the language and quality; changing the quality saves it and returns to settings', async () => {
    await h.onboard(ALICE, 'en');
    await h.press(ALICE, 's', { messageId: 50 });
    expect(screen().text).toContain('Language: 🇬🇧 English');
    expect(screen().text).toContain('Preferred quality: Auto (recommended)');
    await h.press(ALICE, 'q', { messageId: 50 });
    expect(buttonsOf(screen()).find((b) => b.callback_data === 'Q:auto').text.startsWith('✓')).toBe(true);
    const r = await h.press(ALICE, 'Q:small', { messageId: 50 });
    expect(r.view).toBe('settings');
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toBe('✅ Quality: Data saver');
    expect(screen().text).toContain('Preferred quality: Data saver');
    expect(h.row('SELECT quality FROM user_settings WHERE user_id = ?', ALICE.id).quality).toBe('small');
    await h.send(ALICE, '/settings');
    expect(screen().text).toContain('Data saver');
  });

  it('changing the language from settings returns to settings, in the new language', async () => {
    await h.onboard(ALICE, 'en');
    await h.press(ALICE, 'l:s', { messageId: 51 });
    expect(datas(screen())).toEqual(['L:fa:s', 'L:en:s', 'L:ru:s', 's', 'h']);
    const r = await h.press(ALICE, 'L:fa:s', { messageId: 51 });
    expect(r.view).toBe('settings');
    expect(screen().text).toContain('تنظیمات');
    expect(screen().text).toContain('فارسی');
  });

  it('an invalid quality code is an expired menu, nothing is saved', async () => {
    await h.onboard(ALICE, 'en');
    expect((await h.press(ALICE, 'Q:ultra', { messageId: 52 })).expired).toBe(true);
    expect(h.row('SELECT quality FROM user_settings WHERE user_id = ?', ALICE.id)).toBeUndefined();
  });

  it('a user who left a channel cannot change the quality until they rejoin', async () => {
    await h.onboard(ALICE, 'en');
    h.advance(301);
    h.tg.setMember(ALICE.id, 'left');
    expect((await h.press(ALICE, 'Q:best', { messageId: 53 })).view).toBe('join');
    expect(h.row('SELECT quality FROM user_settings WHERE user_id = ?', ALICE.id)).toBeUndefined();
  });
});
