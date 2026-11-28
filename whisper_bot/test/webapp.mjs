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
  await page.waitForFunction(() => document.getElementById('status').textContent !== '…', null, { timeout: 5000 }).catch(() => {});
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
// ---------- the inbox page (webapp/inbox.html) ----------
{
  const labels = {
    title: '📥 صندوق پیام ناشناس', inbox: '📥 صندوق', archive: '🗄 بایگانی', filtered: '🛡 فیلترشده', all: 'همه', search: 'جست‌وجو…', more: 'بیشتر',
    empty: 'پیامی اینجا نیست.', reply_ph: 'جوابت را بنویس…', send: '↩️ ارسال جواب', sent: '✅ جوابت فرستاده شد.', to_archive: '🗄 بایگانی',
    to_inbox: '📥 به صندوق', delete: '🗑 حذف', delete_confirm: 'پاک شود؟', block: '🚫 بلاک فرستنده', unblock: '🔓 آنبلاک', report: '🚩 گزارش',
    report_confirm: 'گزارش شود؟', reported: '🚩 گزارش شد.', open_chat: '💬 در چت باز کن', opened_chat: '✅ در چت ربات فرستاده شد.', cat: '🏷 دسته',
    back: 'بازگشت', failed: '⚠️ نشد', filtered_note: '🛡 فیلترشده', media_note: 'رسانه', question: '❓ در جواب: «{q}»', unread: 'خوانده‌نشده',
    deleted: '🗑 پاک شد.', blocked: '🚫 بلاک شد', unblocked: '🔓 آنبلاک شد', no_reply: '—',
  };
  const evil = '<img src=x onerror="window.__xss=1">';
  const items = [
    { id: 'AAAAAAAAA1', cat: 'q', kind: 'text', media: false, unread: true, folder: 0, ago: '۲ دقیقه پیش', from: '❓ سؤال', preview: 'سلام! این یک پیام ناشناس است', q: '', reaction: '' },
    { id: 'AAAAAAAAA2', cat: 'g', kind: 'text', media: false, unread: false, folder: 0, ago: 'دیروز', from: '📝 عمومی', preview: evil, q: 'بزرگ‌ترین آرزوت چیه؟', reaction: '❤' },
  ];
  const listData = {
    lang: 'fa', labels, folder: 0, cat: '-', page: 0, more: false, unread: 1,
    cats: [{ key: 'q', label: '❓ سؤال' }, { key: 'g', label: '📝 عمومی' }], pickable: [{ key: 'q', label: '❓ سؤال' }, { key: 'g', label: '📝 عمومی' }],
    reactions: ['❤', '🔥', '🤣', '😱', '😢'], items,
  };
  const full = { ...items[0], unread: false, body: 'سلام! این یک پیام ناشناس است\nخط دوم', blocked: false };
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.__calls = [];
      const LIST = ${JSON.stringify(listData)};
      const FULL = ${JSON.stringify(full)};
      window.Telegram = { WebApp: { ready() {}, expand() {}, HapticFeedback: { notificationOccurred() {} },
        BackButton: { show() {}, hide() {}, onClick() {} }, showConfirm(text, cb) { cb(true); },
        Serverless: { call(name, input, cb) { window.__calls.push({ name, input });
          const r = input.op === 'list' ? LIST : input.op === 'get' ? FULL
            : input.op === 'reply' ? { ok: true }
            : input.act === 'react' ? Object.assign({}, FULL, { reaction: LIST.reactions[input.arg] })
            : input.act === 'archive' ? Object.assign({}, FULL, { folder: 1 }) : { ok: true };
          setTimeout(() => cb(null, r), 10); } } } };`,
  }));
  await page.goto(`${base}/inbox.html?l=fa`);
  await page.waitForSelector('#list li');
  const rows = await page.$$eval('#list li', (lis) => lis.map((li) => li.textContent));
  const injected = await page.evaluate(() => [!!document.querySelector('#list img'), window.__xss === 1]);
  const moreShown = await page.isVisible('#more');
  await page.screenshot({ path: path.join(OUT, 'inbox-list.png') });
  await page.click('#list li:first-child button');
  await page.waitForSelector('#view:not([hidden])');
  const body = await page.textContent('#vbody');
  await page.click('#vreact button:nth-child(2)');
  await page.waitForFunction(() => window.__calls.some((c) => c.input.act === 'react'));
  await page.fill('#rtext', 'مرسی از پیامت 🌸');
  await page.click('#rsend');
  await page.waitForFunction(() => window.__calls.some((c) => c.input.op === 'reply'));
  await page.waitForFunction(() => /فرستاده شد/.test(document.getElementById('vstatus').textContent));
  await page.screenshot({ path: path.join(OUT, 'inbox-message.png') });
  await page.click('#vactions button:first-child'); // archive
  await page.waitForFunction(() => window.__calls.some((c) => c.input.act === 'archive'));
  await page.click('#back');
  const calls = await page.evaluate(() => window.__calls);
  const listAfter = await page.$$eval('#list li', (lis) => lis.length);
  const checks = [
    [errors.length === 0, `page errors: ${errors.join('; ')}`],
    [rows.length === 2 && rows[0].includes('سلام!') && rows[1].includes(evil), `rows ${JSON.stringify(rows)}`],
    [!injected[0] && !injected[1], 'a message\'s HTML stays text'],
    [!moreShown, 'no "more" button when there is no more'],
    [body.includes('خط دوم'), `body "${body}"`],
    [calls.some((c) => c.input.op === 'get' && c.input.id === 'AAAAAAAAA1'), 'get the message'],
    [calls.some((c) => c.input.op === 'act' && c.input.act === 'react' && c.input.arg === 1), 'react 🔥'],
    [calls.some((c) => c.input.op === 'reply' && c.input.text === 'مرسی از پیامت 🌸' && c.input.id === 'AAAAAAAAA1'), 'reply'],
    [listAfter === 1, `archived out of the inbox list (${listAfter} left)`],
    [calls.every((c) => c.name === 'inbox'), 'one endpoint'],
  ];
  const bad = checks.filter(([ok]) => !ok).map(([, m]) => m);
  if (bad.length) failures += 1;
  console.log(`${bad.length ? '✘' : '✔'} inbox page: list, message, react, reply, archive${bad.length ? ` — ${bad.join(' | ')}` : ''}`);
  await page.close();
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);
