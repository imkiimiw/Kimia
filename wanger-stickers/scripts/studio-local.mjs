// Runs the built Studio in a local headless Chromium with a mock of telegram-web-app.js
// (Serverless.call answered in the page), and drives the full static-sticker flow:
// chat job → download → automatic background removal → text (Persian + English) → export →
// the uploaded file is checked with the server's own validator. Also: quick mode and the gate.
//
//   npm run build && npm run studio:local -- <photo.jpg> [clip.mp4 anim.gif sheet.png]
//     → docs/spike-results/studio-local.json (+ screenshots)
// With the clip, GIF and sticker sheet it also drives Phase 3: quick video sticker from a chat
// video, round video, GIF file + Telegram GIF, a WhatsApp pack from the Studio, screenshot to pack.
// Every uploaded file is checked with the server's own validators. A baseline in a container's
// Chromium, not a phone.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './tg.mjs';
import { validateTelegramStatic, validateTelegramVideo, validateGif, validateMp4Animation, validateWhatsAppStatic, validateWhatsAppTray, validateCustomEmojiStatic, validateCustomEmojiVideo, sniffImage } from '../tgcloud/lib/core/validate.js';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'x.js'))('playwright');
}
const DIST = path.join(ROOT, 'dist');
const OUTDIR = path.join(ROOT, 'docs/spike-results');
const [photoPath, clipPath, gifPath, sheetPath, ...morePhotos] = process.argv.slice(2);
if (!photoPath || !fs.existsSync(photoPath)) {
  console.error('usage: npm run studio:local -- <photo.jpg> [clip.mp4 anim.gif sheet.png]');
  process.exit(1);
}
const photo = fs.readFileSync(photoPath);
const MEDIA = { J1: { b: photo, kind: 'photo', mime: 'image/jpeg' } };
if (clipPath) {
  const clip = fs.readFileSync(clipPath);
  MEDIA.V1 = { b: clip, kind: 'video', mime: 'video/mp4' };
  MEDIA.N1 = { b: clip, kind: 'video_note', mime: 'video/mp4' };
}
if (gifPath) MEDIA.G1 = { b: fs.readFileSync(gifPath), kind: 'gif', mime: 'image/gif' };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.onnx': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  let file = path.join(DIST, decodeURIComponent((req.url || '/').split('?')[0]));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** The mock Telegram bridge: init data, back button, and the Studio's endpoints. */
const BOOT = {
  user: { id: 1, first_name: 'Test', username: 'tester', lang: 'fa' },
  role: 'user',
  packs: [{ id: 7, title: 'گربه‌ها', count: 3, name: 'ws_1_1_by_Wanger_Motionbot', kind: 'sticker' }],
  wa: [],
  flags: { studio: true, video: true, gif_studio: true, convert: true, whatsapp: true, emoji: true, anim_bg: true },
  quota: { pack_create: 10, sticker_add: 300, media_send: 100, wa_export: 20 },
  limits: {
    static: { side: 512, maxBytes: 524288 }, video: { maxBytes: 262144, maxDurationMs: 3000, maxFps: 30 },
    set: { maxStickersRegular: 120, maxStickersEmoji: 200, titleMaxChars: 64 },
    customEmoji: { width: 100, height: 100 },
    whatsapp: { pack: { minStickers: 3, maxStickers: 30, emojiPerStickerMax: 3, nameMaxChars: 128, publisherMaxChars: 128 } },
    chunkBytes: 256 * 1024,
  },
  bot: 'Wanger_Motionbot',
};
const mock = (opts) => `
window.__commits = [];
const CHUNK = 256 * 1024;
const MEDIA = ${JSON.stringify(Object.fromEntries(Object.entries(MEDIA).map(([k, m]) => [k, { b64: m.b.toString('base64'), kind: m.kind, mime: m.mime }])))};
const dec = (s) => { const raw = atob(s); const u = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i); return u; };
const b64 = (u) => { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
const files = Object.fromEntries(Object.entries(MEDIA).map(([k, m]) => [k, dec(m.b64)]));
const uploads = {};
let waCount = 0;
const handlers = {
  studio_boot: () => ${opts.gate ? `({ error: { message: 'Join first', type: 'ENDPOINT_ERROR', parameters: { code: 'JOIN_REQUIRED', channels: [{ title: 'HIDE & SEEK', url: 'https://t.me/HIDE_i_SEEK' }] } } })` : `({ result: ${JSON.stringify(BOOT)} })`},
  studio_job: (i) => ({ result: { job: i.job, kind: MEDIA[i.job].kind, mime: MEDIA[i.job].mime, size: files[i.job].length } }),
  studio_media: (i) => { const bytes = files[i.job]; const total = Math.ceil(bytes.length / CHUNK); return { result: { idx: i.idx, total, size: bytes.length, b64: b64(bytes.subarray(i.idx * CHUNK, (i.idx + 1) * CHUNK)) } }; },
  upload_begin: (i) => { const id = 'U' + (Object.keys(uploads).length + 1); uploads[id] = { meta: i, chunks: [] }; return { result: { uploadId: id, chunkBytes: CHUNK, chunks: Math.ceil(i.size / CHUNK) } }; },
  upload_chunk: (i) => { uploads[i.uploadId].chunks[i.idx] = dec(i.b64); return { result: { received: i.idx } }; },
  upload_commit: (i) => {
    let c = i;
    if (i.uploadId) {
      const u = uploads[i.uploadId];
      const n = u.chunks.reduce((s, x) => s + x.length, 0);
      const all = new Uint8Array(n); let o = 0; for (const x of u.chunks) { all.set(x, o); o += x.length; }
      c = { ...i, ...u.meta, inline: b64(all), chunked: true };
    }
    window.__commits.push(c);
    const kind = c.kind || 'telegram_static';
    if (kind.startsWith('whatsapp_') && kind !== 'whatsapp_tray') { waCount++; return { result: { action: c.action, packId: 21, count: waCount, needTray: waCount === 1, left: Math.max(0, 3 - waCount) } }; }
    if (kind === 'whatsapp_tray') return { result: { action: 'wa_tray', packId: 21 } };
    return { result: { action: c.action, packId: 9, name: 'ws_1_2_by_Wanger_Motionbot', count: 4 } };
  },
  wa_export: () => ({ result: { sent: true, count: waCount, bytes: 1000 } }),
};
window.Telegram = { WebApp: {
  initData: 'query_id=x&user=%7B%22id%22%3A1%7D', initDataUnsafe: { user: { id: 1, first_name: 'Test', language_code: 'fa' } },
  platform: 'web', version: '9.1', ready() {}, expand() {}, close() {}, openTelegramLink(u) { window.__opened = u; },
  BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
  HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
  Serverless: { call(name, input, cb) { setTimeout(() => { const r = handlers[name] ? handlers[name](input) : { error: { message: 'no ' + name } }; r.error ? cb(r.error) : cb(null, r.result); }, 5); } },
} };`;

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await playwright.chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
async function page(opts = {}) {
  const p = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
  await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: mock(opts) }));
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  if (process.env.ONLY) p.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text().slice(0, 300)));
  return p;
}
const report = { at: new Date().toISOString(), photo: path.basename(photoPath), photoBytes: photo.length };

// 1. the full flow
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${base}/?job=J1`);
  await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
  report.openMs = Date.now() - t0;
  const t1 = Date.now();
  await p.getByRole('button', { name: /حذف خودکار/ }).click();
  await p.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 120000 });
  report.autoRemoveMs = Date.now() - t1;
  await p.screenshot({ path: path.join(OUTDIR, 'studio-bg.png') });
  await p.getByRole('button', { name: 'متن' }).click();
  await p.getByRole('button', { name: /متن تازه/ }).click();
  await p.locator('textarea').fill('سلام Wanger ۱۲۳');
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUTDIR, 'studio-text.png') });
  const t2 = Date.now();
  await p.getByRole('button', { name: /ذخیره‌ی استیکر|ذخیره‌ی استیکر/ }).click();
  await p.locator('.export img').waitFor({ timeout: 60000 });
  report.exportMs = Date.now() - t2;
  report.exportLine = await p.locator('.export .hint').first().innerText();
  await p.screenshot({ path: path.join(OUTDIR, 'studio-export.png'), fullPage: true });
  await p.getByLabel(/پک جدید/).check();
  await p.locator('.export input[placeholder]').fill('استودیوی من');
  await p.getByRole('button', { name: /✅ ذخیره/ }).click();
  await p.getByText(/ساخته شد/).waitFor({ timeout: 30000 });
  report.totalMs = Date.now() - t0;
  const commits = await p.evaluate(() => window.__commits);
  const c = commits[0];
  const file = Buffer.from(c.inline, 'base64');
  const v = validateTelegramStatic(new Uint8Array(file), sniffImage(new Uint8Array(file)));
  report.upload = { action: c.action, title: c.title, emojis: c.emojis, format: c.format, bytes: file.length, sha256ok: crypto.createHash('sha256').update(file).digest('hex') === c.sha256, valid: v.ok, violations: v.violations, width: v.info.width, height: v.info.height };
  fs.writeFileSync(path.join(OUTDIR, 'studio-sticker.' + c.format), file);
  await p.close();
}
// 2. quick mode goes straight to the export sheet
{
  const p = await page();
  const t0 = Date.now();
  await p.goto(`${base}/?job=J1&quick=1`);
  await p.locator('.export img').waitFor({ timeout: 120000 });
  report.quickToExportMs = Date.now() - t0;
  await p.close();
}
// 3. a non-member sees the gate screen with the channel buttons
{
  const p = await page({ gate: true });
  await p.goto(`${base}/?job=J1`);
  await p.getByRole('button', { name: /HIDE & SEEK/ }).waitFor({ timeout: 20000 });
  await p.getByRole('button', { name: /HIDE & SEEK/ }).click();
  report.gate = { opened: await p.evaluate(() => window.__opened) };
  await p.close();
}
const fileOf = (c) => new Uint8Array(Buffer.from(c.inline, 'base64'));
const commitsOf = (p) => p.evaluate(() => window.__commits);
const timed = async (name, fn) => {
  if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
  const t0 = Date.now();
  try {
    report.phase3[name] = { ...(await fn()), ms: Date.now() - t0 };
  } catch (e) {
    report.phase3[name] = { error: String(e && e.message).slice(0, 500), ms: Date.now() - t0 };
  }
  console.log(name, JSON.stringify(report.phase3[name]).slice(0, 300));
};
if (clipPath) {
  report.phase3 = {};
  // 4. the home screen lists every mode
  await timed('home', async () => {
    const p = await page();
    await p.goto(`${base}/`);
    await p.locator('.tile').first().waitFor({ timeout: 30000 });
    const tiles = await p.locator('.tile').allInnerTexts();
    await p.screenshot({ path: path.join(OUTDIR, 'studio-home.png') });
    await p.close();
    return { tiles };
  });
  // 5. chat video → «⚡️ quick video sticker» → straight to saving → a valid VP9 sticker uploaded
  await timed('quick_video_sticker', async () => {
    const p = await page();
    await p.goto(`${base}/?job=V1&mode=video&quick=1`);
    await p.locator('.export video').waitFor({ timeout: 180000 });
    const line = await p.locator('.export .hint').first().innerText();
    await p.screenshot({ path: path.join(OUTDIR, 'studio-video-export.png'), fullPage: true });
    await p.getByLabel(/پک جدید/).check();
    await p.locator('.export input[placeholder]').fill('ویدیویی');
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/ساخته شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const f = fileOf(c);
    const v = validateTelegramVideo(f);
    fs.writeFileSync(path.join(OUTDIR, 'studio-video-sticker.webm'), f);
    await p.close();
    return { line, kind: c.kind, action: c.action, kb: Math.round(f.length / 1024), valid: v.ok, violations: v.violations, durationMs: v.info.durationMs, fps: v.info.fps, size: `${v.info.tracks[0].width}x${v.info.tracks[0].height}` };
  });
  // 6. round video → the editor (circle by default) → make → existing pack
  await timed('round_video', async () => {
    const p = await page();
    await p.goto(`${base}/?job=N1`);
    await p.getByRole('button', { name: 'ساختن' }).waitFor({ timeout: 60000 });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(OUTDIR, 'studio-anim-editor.png'), fullPage: true });
    await p.getByRole('button', { name: 'ساختن' }).click();
    await p.locator('.export video').waitFor({ timeout: 180000 });
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/اضافه شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const v = validateTelegramVideo(fileOf(c));
    await p.close();
    return { action: c.action, packId: c.packId, valid: v.ok, violations: v.violations, alpha: v.info.tracks[0].alphaMode === 1, size: `${v.info.tracks[0].width}x${v.info.tracks[0].height}` };
  });
  // 7. GIF from the chat → GIF tab → .gif file and «send as Telegram GIF» (MP4)
  if (gifPath) {
    await timed('gif_file_and_mp4', async () => {
      const p = await page();
      await p.goto(`${base}/?job=G1&mode=gif`);
      await p.getByRole('button', { name: 'ساختن' }).waitFor({ timeout: 60000 });
      await p.getByRole('button', { name: 'ساختن' }).click();
      await p.getByRole('button', { name: /فایل \.gif/ }).click();
      await p.getByText(/در چت فرستاده شد/).waitFor({ timeout: 120000 });
      await p.getByRole('button', { name: /GIF تلگرام/ }).click();
      await p.waitForFunction(() => window.__commits.length >= 2, null, { timeout: 120000 });
      const [g, m] = await commitsOf(p);
      const gv = validateGif(fileOf(g));
      const mv = validateMp4Animation(fileOf(m));
      await p.close();
      return { gif: { kind: g.kind, action: g.action, kb: Math.round(fileOf(g).length / 1024), valid: gv.ok, violations: gv.violations, frames: gv.info.frames }, mp4: { kind: m.kind, action: m.action, kb: Math.round(fileOf(m).length / 1024), valid: mv.ok, violations: mv.violations, chunked: !!m.chunked } };
    });
  }
  // 8. WhatsApp from the Studio: a photo → editor → WhatsApp → new pack (sticker + tray)
  await timed('whatsapp_static_pack', async () => {
    const p = await page();
    await p.goto(`${base}/?mode=wa`);
    await p.locator('input[type=file]').setInputFiles(photoPath);
    await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
    await p.getByRole('button', { name: /ذخیره‌ی استیکر/ }).click();
    await p.locator('.export img').waitFor({ timeout: 60000 });
    const line = await p.locator('.export .hint').first().innerText();
    const inputs = p.locator('.export input[placeholder]');
    await inputs.nth(0).fill('پک واتس‌اپ');
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/اضافه شد/).waitFor({ timeout: 30000 });
    await p.screenshot({ path: path.join(OUTDIR, 'studio-wa-saved.png') });
    const [s, t] = await commitsOf(p);
    const sv = validateWhatsAppStatic(fileOf(s));
    const tv = validateWhatsAppTray(fileOf(t));
    await p.close();
    return { line, sticker: { kind: s.kind, action: s.action, title: s.title, publisher: s.publisher, kb: Math.round(fileOf(s).length / 1024), valid: sv.ok, violations: sv.violations }, tray: { kind: t.kind, action: t.action, packId: t.packId, valid: tv.ok, violations: tv.violations } };
  });
  // 9. screenshot to pack: a sticker sheet → boxes → 3 stickers into an existing pack
  if (sheetPath) {
    await timed('screenshot_to_pack', async () => {
      const p = await page();
      await p.goto(`${base}/?mode=split`);
      await p.locator('input[type=file]').setInputFiles(sheetPath);
      await p.locator('.split canvas').waitFor({ timeout: 30000 });
      const found = await p.locator('.studio .hint').first().innerText();
      await p.screenshot({ path: path.join(OUTDIR, 'studio-split.png'), fullPage: true });
      await p.getByRole('button', { name: /ساختن/ }).click();
      await p.getByText(/ذخیره شد/).waitFor({ timeout: 120000 });
      const cs = await commitsOf(p);
      const checks = cs.map((c) => validateTelegramStatic(fileOf(c), sniffImage(fileOf(c))).ok);
      await p.close();
      return { found, uploads: cs.length, actions: cs.map((c) => c.action), quiet: cs.map((c) => !!c.quiet), allValid: checks.every(Boolean) };
    });
  }
}
if (clipPath) {
  report.phase4 = {};
  const t4 = async (name, fn) => {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(name)) return;
    const t0 = Date.now();
    try {
      report.phase4[name] = { ...(await fn()), ms: Date.now() - t0 };
    } catch (e) {
      report.phase4[name] = { error: String(e && e.message).slice(0, 500), ms: Date.now() - t0 };
    }
    console.log(name, JSON.stringify(report.phase4[name]).slice(0, 300));
  };
  const editorFromPick = async (p, mode) => {
    await p.goto(`${base}/?mode=${mode}`);
    await p.locator('input[type=file]').setInputFiles(photoPath);
    await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
  };
  // 10. custom emoji from a photo (static, 100×100) → a new emoji pack
  await t4('emoji_static', async () => {
    const p = await page();
    await editorFromPick(p, 'emoji');
    await p.getByRole('button', { name: /ذخیره‌ی استیکر/ }).click();
    await p.locator('.export img').waitFor({ timeout: 60000 });
    await p.screenshot({ path: path.join(OUTDIR, 'studio-emoji-export.png'), fullPage: true });
    await p.getByLabel(/پک جدید/).check();
    await p.locator('.export input[placeholder]').fill('ایموجی من');
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/ساخته شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const v = validateCustomEmojiStatic(fileOf(c), c.format);
    await p.close();
    return { kind: c.kind, action: c.action, format: c.format, valid: v.ok, violations: v.violations, size: `${v.info.width}x${v.info.height}` };
  });
  // 11. meme maker: the photo keeps its background, two captions, → existing pack
  await t4('meme', async () => {
    const p = await page();
    await p.goto(`${base}/?mode=meme`);
    await p.locator('input[type=file]').setInputFiles(photoPath);
    await p.locator('textarea').first().waitFor({ timeout: 30000 });
    await p.locator('textarea').first().fill('وقتی کد بدون خطا اجرا شد');
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUTDIR, 'studio-meme.png'), fullPage: true });
    await p.getByRole('button', { name: /ذخیره‌ی استیکر/ }).click();
    await p.locator('.export img').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/اضافه شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const f = fileOf(c);
    const v = validateTelegramStatic(f, sniffImage(f));
    await p.close();
    return { kind: c.kind, action: c.action, packId: c.packId, valid: v.ok, size: `${v.info.width}x${v.info.height}` };
  });
  // 12. a still sticker + «🎬 متحرکش کن» (bounce) → video sticker; with a template
  await t4('animate_still_with_template', async () => {
    const p = await page();
    await editorFromPick(p, 'sticker');
    await p.getByRole('button', { name: 'قالب' }).click();
    await p.getByRole('button', { name: /حباب/ }).click();
    await p.locator('textarea').first().fill('سلام!');
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(OUTDIR, 'studio-template.png'), fullPage: true });
    await p.getByRole('button', { name: /ذخیره‌ی استیکر/ }).click();
    await p.locator('.export img').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: /متحرکش کن/ }).click();
    await p.getByRole('button', { name: 'ساختن' }).waitFor({ timeout: 60000 });
    await p.screenshot({ path: path.join(OUTDIR, 'studio-effects.png'), fullPage: true });
    await p.getByRole('button', { name: 'ساختن' }).click();
    await p.locator('.export video').waitFor({ timeout: 120000 });
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/اضافه شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const v = validateTelegramVideo(fileOf(c));
    await p.close();
    return { kind: c.kind, valid: v.ok, violations: v.violations, size: `${v.info.tracks[0].width}x${v.info.tracks[0].height}`, kb: Math.round(fileOf(c).length / 1024) };
  });
  // 13. animated text on a blank sticker → video sticker
  await t4('text_animation', async () => {
    const p = await page();
    await p.goto(`${base}/?mode=text`);
    await p.getByRole('button', { name: 'ساختن' }).waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'ساختن' }).click();
    await p.locator('.export video').waitFor({ timeout: 120000 });
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/اضافه شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const v = validateTelegramVideo(fileOf(c));
    await p.close();
    return { kind: c.kind, valid: v.ok, violations: v.violations, alpha: v.info.tracks[0].alphaMode === 1 };
  });
  // 14. slideshow of photos → .gif file
  if (morePhotos.length >= 2) {
    await t4('slideshow_gif', async () => {
      const p = await page();
      await p.goto(`${base}/?mode=slideshow`);
      await p.locator('input[type=file]').setInputFiles([photoPath, ...morePhotos]);
      await p.waitForTimeout(4000);
      if (process.env.ONLY) console.log('slideshow page:', (await p.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));
      await p.getByRole('button', { name: 'ساختن' }).waitFor({ timeout: 60000 });
      await p.getByRole('button', { name: 'ساختن' }).click();
      await p.getByRole('button', { name: /فایل \.gif/ }).click();
      await p.getByText(/در چت فرستاده شد/).waitFor({ timeout: 120000 });
      const c = (await commitsOf(p))[0];
      const v = validateGif(fileOf(c));
      await p.close();
      return { kind: c.kind, valid: v.ok, frames: v.info.frames, durationMs: v.info.durationMs };
    });
  }
  // 15. a draft survives closing the Studio
  await t4('draft_resume', async () => {
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const p = await ctxB.newPage();
    await p.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: mock({}) }));
    await p.goto(`${base}/?mode=sticker`);
    await p.locator('input[type=file]').setInputFiles(photoPath);
    await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
    await p.getByRole('button', { name: 'متن' }).click();
    await p.getByRole('button', { name: '🔥' }).click();
    await p.waitForTimeout(2000);
    await p.goto(`${base}/`);
    await p.getByRole('button', { name: /ادامه‌ی پیش‌نویس/ }).click();
    await p.getByRole('button', { name: /حذف خودکار/ }).waitFor({ timeout: 30000 });
    await p.getByRole('button', { name: 'متن' }).click();
    const resumed = await p.locator('textarea').first().inputValue({ timeout: 5000 }).catch(() => '');
    await ctxB.close();
    return { resumed: resumed === '🔥' };
  });
  // 16. a chat video → a video custom emoji (100×100) → a new emoji pack
  await t4('emoji_video', async () => {
    const p = await page();
    await p.goto(`${base}/?job=V1&mode=emoji&quick=1`);
    await p.locator('.export video').waitFor({ timeout: 180000 });
    await p.getByLabel(/پک جدید/).check();
    await p.locator('.export input[placeholder]').fill('ایموجی ویدیویی');
    await p.getByRole('button', { name: /✅ ذخیره/ }).click();
    await p.getByText(/ساخته شد/).waitFor({ timeout: 30000 });
    const c = (await commitsOf(p))[0];
    const v = validateCustomEmojiVideo(fileOf(c));
    await p.close();
    return { kind: c.kind, action: c.action, valid: v.ok, violations: v.violations, size: `${v.info.tracks[0].width}x${v.info.tracks[0].height}`, kb: Math.round(fileOf(c).length / 1024) };
  });
}
await browser.close();
server.close();
report.browser = 'headless Chromium (container) — not a phone';
fs.writeFileSync(path.join(OUTDIR, 'studio-local.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
