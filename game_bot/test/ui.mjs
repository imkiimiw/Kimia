// UI test: the built Mini App (dist/) in headless Chromium, with a stand-in Telegram.WebApp whose
// Serverless.call runs the real endpoints (tgcloud/endpoints/*) on the local sdk emulation. Several
// browser pages are several Telegram accounts, so multiplayer is played for real, through the UI.
// Screenshots go to test/output/. Run: npm run test:ui (builds first).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockTelegram } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'output');
fs.mkdirSync(OUT, { recursive: true });

// ---------- server side: endpoints on the sdk emulation ----------

const mock = createMockTelegram({ botId: 7200000001 });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema);
for (const [id, username, title] of [[-1001, 'HIDE_i_SEEK', 'Hide & Seek'], [-1002, 'Nepenthw_ir', 'Nepenthe'], [-1003, 'wangerBots', 'Wanger Bots']]) {
  mock.addChannel({ id, username, title });
}
let offset = 0; // server clock offset (seconds), to skip waits like the Hokm bot timer
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + offset * 1000;
const E = {};
for (const f of fs.readdirSync(path.join(ROOT, 'tgcloud', 'endpoints'))) E[f.replace('.js', '')] = (await import(`../tgcloud/endpoints/${f}`)).default;
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };
console.warn = () => {};

const users = {
  ali: { id: 900000001, first_name: 'علی', language_code: 'fa' },
  sam: { id: 900000002, first_name: 'Sam', language_code: 'en' },
  nina: { id: 900000003, first_name: 'Nina', language_code: 'fr' },
  newbie: { id: 900000004, first_name: 'Newbie', language_code: 'ru' },
};
for (const u of [users.ali, users.sam, users.nina]) for (const ch of mock.state.channels.values()) ch.members.add(u.id);

// ---------- static server for dist/ ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, 'dist', p === '/' ? 'index.html' : p);
  if (!file.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(file)) file = path.join(ROOT, 'dist', 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- browser ----------

const browser = await chromium.launch();
const pageErrors = [];

const THEMES = {
  light: { bg_color: '#ffffff', secondary_bg_color: '#f1f2f6', section_bg_color: '#ffffff', text_color: '#111322', hint_color: '#8c90a6', link_color: '#6b5cff', button_color: '#2ea6ff', button_text_color: '#ffffff' },
  dark: { bg_color: '#17212b', secondary_bg_color: '#0e1621', section_bg_color: '#17212b', text_color: '#f5f5f5', hint_color: '#708499', link_color: '#73b9f5', button_color: '#5288c1', button_text_color: '#ffffff' },
};

/** Opens the Mini App as `user` (optionally with a startapp payload and a chat). */
async function open(user, { start = '', chat = 'chat-1', scheme = 'light', hash = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.route('https://telegram.org/**', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${user.first_name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${user.first_name} console: ${m.text()}`); });
  const shared = [];
  await page.exposeFunction('__call', async (name, input) => {
    try {
      const result = await E[name](input || {}, { initData: { user, chat_instance: chat, chat_type: 'group', start_param: start, auth_date: 1 } });
      return { result: JSON.parse(JSON.stringify(result ?? null)) };
    } catch (e) {
      if (e && e.parameters) return { error: { type: 'ENDPOINT_ERROR', message: e.description || e.message, parameters: e.parameters, status: 400 } };
      origError(e);
      return { error: { type: 'INTERNAL', message: 'internal', status: 500 } };
    }
  });
  await page.exposeFunction('__shared', (q) => shared.push(q));
  const theme = THEMES[scheme];
  await page.addInitScript(({ user, start, theme, scheme }) => {
    window.__TEST__ = true;
    const paint = () => {
      const root = document.documentElement;
      for (const [k, v] of Object.entries(theme)) root.style.setProperty(`--tg-theme-${k.replace(/_/g, '-')}`, v);
      root.style.setProperty('--tg-viewport-stable-height', '844px');
    };
    if (document.documentElement) paint();
    else document.addEventListener('readystatechange', paint, { once: true });
    const noop = () => {};
    window.Telegram = {
      WebApp: {
        initData: 'test', initDataUnsafe: { user, start_param: start }, colorScheme: scheme, themeParams: theme, version: '9.1',
        ready: noop, expand: noop, isVersionAtLeast: () => true, onEvent: noop, offEvent: noop,
        setHeaderColor: noop, setBackgroundColor: noop, setBottomBarColor: noop, enableVerticalSwipes: noop, disableVerticalSwipes: noop,
        BackButton: { show: noop, hide: noop, onClick: noop }, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
        openTelegramLink: noop, openLink: noop, switchInlineQuery: (q) => window.__shared(q),
        Serverless: { call: (name, input, cb) => { window.__call(name, input).then((r) => (r.error ? cb(Object.assign(new Error(r.error.message), r.error), null) : cb(null, r.result))); } },
      },
    };
  }, { user, start, theme, scheme });
  await page.goto(BASE + (hash ? `#${hash}` : ''));
  page.shared = shared;
  return page;
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push(true);
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push(false);
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 6).join('\n   ')}`);
  }
}

// ---------- scenarios ----------

await scenario('home (light, English) and home (dark, Persian, RTL)', async () => {
  const sam = await open(users.sam);
  await sam.waitForSelector('.game-row');
  assert.equal(await sam.locator('.game-row').count(), 3);
  assert.equal(await sam.locator('.solo-card').count(), 2);
  await wait(400);
  await shot(sam, '01-home-en-light');
  const ali = await open(users.ali, { scheme: 'dark' });
  await ali.waitForSelector('.game-row');
  assert.equal(await ali.evaluate(() => document.documentElement.dir), 'rtl');
  assert.match(await ali.locator('h1').first().textContent(), /رمزواژه/);
  await wait(400);
  await shot(ali, '02-home-fa-dark');
  await sam.context().close();
  await ali.context().close();
});

await scenario('forced join: the gate lists the channels; joining lets the user in', async () => {
  const p = await open(users.newbie);
  await p.waitForSelector('.join-gate');
  assert.equal(await p.locator('.channel').count(), 3);
  await shot(p, '03-join-gate-ru');
  for (const ch of mock.state.channels.values()) ch.members.add(users.newbie.id);
  await p.click('.join-gate .btn.primary');
  await p.waitForSelector('.game-row');
  await p.context().close();
});

await scenario('tic-tac-toe: two accounts play through the UI; the winner sees the result', async () => {
  const id = 'TttRoomAAAA1';
  const a = await open(users.sam, { start: `t_${id}` });
  await a.waitForSelector('.lobby');
  await a.click('.lobby .btn.primary');
  assert.deepEqual(a.shared, [`room ${id}`], 'invite opens the inline chat picker with this room');
  await shot(a, '04-ttt-lobby');
  const b = await open(users.nina, { start: `t_${id}` });
  await b.waitForSelector('.ttt-board');
  await a.waitForSelector('.ttt-board', { timeout: 5000 });
  const cell = (p, i) => p.locator('.ttt-cell').nth(i).click();
  for (const [p, i] of [[a, 0], [b, 3], [a, 1], [b, 4]]) {
    await p.waitForSelector('.turn-banner.mine', { timeout: 6000 });
    await cell(p, i);
    await wait(250);
  }
  await a.waitForSelector('.turn-banner.mine', { timeout: 6000 });
  await shot(a, '05-ttt-playing');
  await cell(a, 2);
  await a.waitForSelector('.sheet .result-emoji');
  assert.match(await a.locator('.sheet h1').textContent(), /You won/);
  await b.waitForSelector('.sheet', { timeout: 6000 });
  assert.match(await b.locator('.sheet h1').textContent(), /Défaite/);
  await wait(500);
  await shot(a, '06-ttt-won');
  await a.click('.sheet .btn.primary');
  await b.click('.sheet .btn.primary');
  await a.waitForSelector('.ttt-cell >> nth=0', { timeout: 6000 });
  await b.waitForFunction(() => !document.querySelector('.sheet'), null, { timeout: 6000 });
  await a.context().close();
  await b.context().close();
});

await scenario('backgammon: the board, dice and a turn played through the UI', async () => {
  const id = 'BgRoomAAAAA1';
  const a = await open(users.ali, { start: `b_${id}`, scheme: 'dark' });
  await a.waitForSelector('.lobby');
  await a.click('.segmented button:nth-child(2)');
  await wait(300);
  const b = await open(users.sam, { start: `b_${id}` });
  await b.waitForSelector('.bg-board');
  await a.waitForSelector('.bg-board', { timeout: 6000 });
  const room = JSON.parse(rawDatabase().prepare('SELECT state FROM rooms WHERE id = ?').get(id).state);
  const p = room.turn === 0 ? a : b;
  const req = await p.evaluate(async () => document.querySelectorAll('.pt-dot, .pt-target').length);
  assert.ok(req > 0, 'movable checkers are marked');
  await wait(900);
  await shot(p, '07-bg-turn');
  // Play the turn by tapping: each time, the first highlighted target, after picking a source if needed.
  for (let k = 0; k < 4; k += 1) {
    const done = await p.locator('.bg-controls .btn.primary').isEnabled();
    if (done) break;
    if (!(await p.locator('.pt-target, .tray.hot').count())) {
      await p.locator('.pt:has(.pt-dot)').first().click({ force: true });
      await wait(150);
    }
    const target = p.locator('.pt:has(.pt-target)').first();
    if (await target.count()) await target.click({ force: true });
    else await p.locator('.tray.hot').click({ force: true });
    await wait(450);
  }
  await p.click('.bg-controls .btn.primary');
  const other = p === a ? b : a;
  await other.waitForSelector('.bg-controls .btn.primary', { timeout: 6000 });
  await wait(1600);
  await shot(other, '08-bg-opponent-moved');
  assert.match(await other.locator('.bg-controls .btn.primary').textContent(), /Roll|تاس/);
  await other.click('.bg-controls .btn.primary');
  await wait(900);
  await shot(other, '09-bg-rolled');
  await a.context().close();
  await b.context().close();
});

await scenario('hokm: a human and a friend with two bots; trump picked and cards played through the UI', async () => {
  const id = 'HokmRoomAAA1';
  const a = await open(users.sam, { start: `h_${id}` });
  await a.waitForSelector('.lobby');
  const b = await open(users.nina, { start: `h_${id}` });
  await b.waitForSelector('.lobby');
  await shot(a, '10-hokm-lobby');
  offset += 61;
  await a.waitForSelector('.lobby .btn.secondary:not([disabled])', { timeout: 8000 });
  await a.click('.lobby .btn.secondary');
  await a.waitForSelector('.table', { timeout: 6000 });
  const st = () => JSON.parse(rawDatabase().prepare('SELECT state FROM rooms WHERE id = ?').get(id).state);
  const seatOf = { [users.sam.id]: 0, [users.nina.id]: 1 };
  const pages = [a, b];
  if (st().phase === 'trump') {
    const hakemPage = pages[st().hakem];
    if (hakemPage) {
      await hakemPage.waitForSelector('.trump-pick', { timeout: 8000 });
      await wait(700);
      await shot(hakemPage, '11-hokm-trump');
      await hakemPage.locator('.suit-btn').nth(1).click();
    }
  }
  let plays = 0;
  for (let i = 0; i < 40 && plays < 3; i += 1) {
    const s = st();
    const p = pages[s.turn];
    if (s.phase === 'play' && p && s.turn === seatOf[p === a ? users.sam.id : users.nina.id]) {
      await p.waitForSelector('.your-turn', { timeout: 8000 });
      const legal = s.trick.length ? s.hands[s.turn].filter((c) => c[0] === s.trick[0].card[0]) : s.hands[s.turn];
      const card = (legal.length ? legal : s.hands[s.turn])[0];
      const el = p.locator('.hand .pcard').filter({ has: p.locator(`text="${card[0] === 'H' ? '♥' : card[0] === 'S' ? '♠' : card[0] === 'D' ? '♦' : '♣'}"`) });
      const idx = await p.evaluate((c) => {
        const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
        const r = Number(c.slice(1));
        const rank = r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r);
        return [...document.querySelectorAll('.hand .pcard')].findIndex((x) => x.querySelector('.pc-mid').textContent === SUIT[c[0]] && x.querySelector('.pc-corner').textContent.startsWith(rank));
      }, card);
      assert.ok(idx >= 0 && (await el.count()) >= 0);
      // tap the visible strip of the card (the next card overlaps its right side), twice: select, play
      await p.locator('.hand .pcard').nth(idx).click({ position: { x: 9, y: 40 } });
      await wait(350);
      await p.locator('.hand .pcard').nth(idx).click({ position: { x: 9, y: 30 } });
      plays += 1;
      await wait(1400);
      if (plays === 2) await shot(p, '12-hokm-table');
    } else {
      await wait(500);
    }
  }
  assert.ok(plays >= 2, `played ${plays} cards through the UI`);
  await a.context().close();
  await b.context().close();
});

await scenario('codeword: typing a guess on the on-screen keyboard; Persian keyboard is right-to-left', async () => {
  const p = await open(users.sam, { start: 'c' });
  await p.waitForSelector('.kb');
  for (const ch of 'world') await p.locator('.key', { hasText: new RegExp(`^${ch}$`, 'i') }).first().click();
  await p.locator('.key.enter').click();
  await p.waitForSelector('.cw-row.done');
  for (const ch of 'house') await p.locator('.key', { hasText: new RegExp(`^${ch}$`, 'i') }).first().click();
  await p.locator('.key.enter').click();
  await wait(1000);
  await p.click('.chip:has-text("Mark")');
  await p.locator('.key', { hasText: /^e$/i }).first().click();
  await p.locator('.key', { hasText: /^q$/i }).first().click();
  await p.locator('.key', { hasText: /^q$/i }).first().click();
  await wait(300);
  await shot(p, '13-codeword-en');
  const f = await open(users.ali, { start: 'c', scheme: 'dark' });
  await f.waitForSelector('.kb');
  const firstKeyX = await f.locator('.kb-row').first().locator('.key').first().evaluate((el) => el.getBoundingClientRect().x);
  const lastKeyX = await f.locator('.kb-row').first().locator('.key').last().evaluate((el) => el.getBoundingClientRect().x);
  assert.ok(firstKeyX > lastKeyX, 'ض is on the right');
  await wait(300);
  await shot(f, '14-codeword-fa');
  await p.context().close();
  await f.context().close();
});

await scenario('fusion: tiles placed and fused through the UI', async () => {
  const p = await open(users.nina, { start: 'f' });
  await p.waitForSelector('.fu-board');
  for (let i = 0; i < 9; i += 1) {
    await p.locator('.fu-cell.empty').first().click();
    await wait(650);
  }
  await shot(p, '15-fusion');
  assert.ok(await p.locator('.fu-cell .tile').count() > 0);
  await p.context().close();
});

await scenario('ranks, profile and settings (switching to Persian turns the app right-to-left)', async () => {
  const p = await open(users.sam);
  await p.waitForSelector('.tabbar');
  await p.click('.tabbar button:nth-child(2)');
  await p.waitForSelector('.list-item, .center-pad.hint');
  await wait(300);
  await shot(p, '16-ranks');
  await p.click('.tabbar button:nth-child(3)');
  await p.waitForSelector('.stat-card');
  await shot(p, '17-profile');
  await p.click('.tabbar button:nth-child(4)');
  await p.waitForSelector('.option');
  await p.locator('.option').nth(3).click();
  await p.waitForFunction(() => document.documentElement.dir === 'rtl');
  await wait(300);
  await shot(p, '18-settings-fa');
  assert.equal(rawDatabase().prepare('SELECT lang FROM users WHERE user_id = ?').get(users.sam.id).lang, 'fa');
  await p.context().close();
});

await scenario('no page errors, no server errors', async () => {
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(errors, []);
});

await browser.close();
server.close();
await mock.close();
const failed = outcome.filter((x) => !x).length;
console.log(`\n${outcome.length - failed}/${outcome.length} UI scenarios passed; screenshots in test/output/`);
process.exit(failed ? 1 : 0);
