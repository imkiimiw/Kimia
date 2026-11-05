// Checks the card Mini App (webapp/) in headless Chromium: Telegram's script is replaced by a stub
// whose Serverless.call answers cardData like the bot does and records cardSend. For a Persian link
// card, a Russian message card with an answer and an English question card it checks that the
// canvas is drawn, that "send" posts a real JPEG of a sensible size, and saves screenshots.
//   node test/webapp.mjs [output dir]
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base64ToBytes } from '../tgcloud/lib/util.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBAPP = path.join(ROOT, 'webapp');
const OUT = process.argv[2] || path.join(ROOT, 'test/cloud/output');
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const p = path.join(WEBAPP, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(WEBAPP) || !fs.existsSync(p)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const labels = (lang) => ({
  fa: { story: 'استوری ۹:۱۶', post: 'پست ۴:۵', square: 'مربع', theme: 'رنگ', send: '📩 بفرست به چت', sending: '…', sent: '✅ فرستاده شد', failed: '❌', answer: 'جواب تو', title: 'ساخت کارت' },
  ru: { story: 'Сторис 9:16', post: 'Пост 4:5', square: 'Квадрат', theme: 'Цвет', send: '📩 Отправить в чат', sending: '…', sent: '✅ Отправлено', failed: '❌', answer: 'Ваш ответ', title: 'Создать карточку' },
  en: { story: 'Story 9:16', post: 'Post 4:5', square: 'Square', theme: 'Color', send: '📩 Send to chat', sending: '…', sent: '✅ Sent', failed: '❌', answer: 'Your answer', title: 'Make a card' },
}[lang]);

const CASES = [
  {
    name: 'fa-link-story', query: '?k=link&l=fa', size: 'story', answer: '',
    data: { lang: 'fa', kind: 'link', name: 'کیمیا', rating: '⭐️ امتیاز: ۴٫۶ از ۵ (۲۳ رأی)', brand: '@Wanger_Shadowbot', head: 'به من پیام ناشناس بده 💬', text: 'همیشه دلت می‌خواست چه سؤالی از من بپرسی؟', link: 'https://t.me/Wanger_Shadowbot?start=a_AbCdEfGhIj', foot: 'لینک را بزن یا کد را اسکن کن' },
  },
  {
    name: 'ru-msg-post', query: '?k=msg&id=AbCdEfGhIj&l=ru', size: 'post', answer: 'Спасибо! Это очень приятно 😊',
    data: { lang: 'ru', kind: 'msg', name: 'Кира', rating: '', brand: '@Wanger_Shadowbot', head: 'Анонимное сообщение 💬', text: 'Ты самый добрый человек, которого я знаю. Никогда не меняйся!', q: 'Что ты во мне ценишь?', foot: 'анонимное сообщение' },
  },
  {
    name: 'en-q-square', query: '?k=q&l=en', size: 'square', answer: '',
    data: { lang: 'en', kind: 'q', name: 'Kim', rating: '⭐️ Rating: 4.6 / 5 (23 ratings)', brand: '@Wanger_Shadowbot', head: 'Question of the day 🌟', text: 'What would your perfect day look like?', link: 'https://t.me/Wanger_Shadowbot?start=a_AbCdEfGhIj', foot: 'Tap the link or scan the code' },
  },
];

const browser = await chromium.launch();
let failures = 0;
for (const c of CASES) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const data = { ...c.data, labels: labels(c.data.lang) };
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.__calls = [];
      window.Telegram = { WebApp: { ready() {}, expand() {}, HapticFeedback: { notificationOccurred() {} },
        Serverless: { call(name, input, cb) { window.__calls.push({ name, input });
          setTimeout(() => cb(null, name === 'cardData' ? ${JSON.stringify(data)} : { ok: true }), 10); } } } };`,
  }));
  await page.goto(base + c.query);
  await page.waitForFunction(() => window.__card && window.__card.state.data);
  if (c.size !== 'story') await page.click(`#sizes button:nth-child(${c.size === 'post' ? 2 : 3})`);
  if (c.answer) await page.fill('#answer', c.answer);
  await page.waitForTimeout(300);
  const dims = await page.evaluate(() => [document.getElementById('card').width, document.getElementById('card').height]);
  await page.locator('#card').screenshot({ path: path.join(OUT, `card-${c.name}.png`) });
  await page.click('#send');
  await page.waitForFunction(() => window.__calls.some((x) => x.name === 'cardSend'));
  const sent = await page.evaluate(() => window.__calls.find((x) => x.name === 'cardSend').input);
  const status = await page.textContent('#status');
  const bytes = base64ToBytes(sent.image);
  const checks = [
    [errors.length === 0, `page errors: ${errors.join('; ')}`],
    [JSON.stringify(dims) === JSON.stringify({ story: [1080, 1920], post: [1080, 1350], square: [1080, 1080] }[c.size]), `canvas ${dims}`],
    [bytes && bytes[0] === 0xff && bytes[1] === 0xd8, 'a JPEG was sent'],
    [bytes && bytes.length > 30000 && bytes.length < 1500000, `size ${bytes && bytes.length}`],
    [sent.k === c.data.kind && (c.data.kind !== 'msg' || sent.id === 'AbCdEfGhIj'), `input ${JSON.stringify({ k: sent.k, id: sent.id })}`],
    [/✅/.test(status), `status "${status}"`],
  ];
  const bad = checks.filter(([ok]) => !ok).map(([, m]) => m);
  if (bad.length) failures += 1;
  console.log(`${bad.length ? '✘' : '✔'} card ${c.name}: ${dims.join('×')}, JPEG ${bytes ? Math.round(bytes.length / 1024) : '?'} KB${bad.length ? ` — ${bad.join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
