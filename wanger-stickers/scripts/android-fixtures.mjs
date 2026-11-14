// Writes the Android app's test fixtures: WhatsApp packs exported by the bot's own code.
//
//   node --import ./tests/sdk/register.mjs scripts/android-fixtures.mjs
//
// Chromium draws real stickers (decodable WebP with alpha, a real PNG tray); the animated ones are
// muxed by the Studio's own muxer. They go through the real endpoints (upload_commit → wa_export)
// on the SDK emulation, and the ZIP / .wastickers the fake Bot API receives are written to
// android/app/src/test/resources/fixtures/. tests/android.test.mjs checks they still match what the
// bot exports today; rerun this script when the export format changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { setup } from '../tests/helpers/harness.mjs';
import commit from '../tgcloud/endpoints/upload_commit.js';
import waExport from '../tgcloud/endpoints/wa_export.js';
import { muxAnimatedWebP } from '../src/engine/webp/animmux.ts';

// Playwright is pre-installed globally in this environment (not a project dependency).
function chromium() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright').chromium;
  } catch {
    return createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'x.js'))('playwright').chromium;
  }
}

const OUT = path.resolve(import.meta.dirname, '../android/app/src/test/resources/fixtures');
const U = 770001;
const ctx = { initData: { user: { id: U, first_name: 'Kimi', username: 'kimi_test', language_code: 'fa' } } };
const b64 = (b) => Buffer.from(b).toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const inline = (bytes, kind, format, extra) => ({ inline: b64(bytes), kind, format, size: bytes.length, sha256: sha(bytes), ...extra });

/** Real images from Chromium's encoders: n stickers × frames each (512×512 WebP) and a 96×96 PNG tray. */
async function draw(n, frames) {
  const browser = await chromium().launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async ({ n, frames }) => {
    const blob = (c, type, q) => new Promise((r) => c.toBlob((b) => b.arrayBuffer().then((a) => r(Array.from(new Uint8Array(a)))), type, q));
    const colors = ['#6F42F5', '#F5426C', '#1B873F', '#F5A742'];
    const stickers = [];
    for (let i = 0; i < n; i++) {
      const list = [];
      for (let f = 0; f < frames; f++) {
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        const g = c.getContext('2d');
        g.translate(256, 256);
        g.rotate((f / frames) * Math.PI * 2);
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(0, 0, 220, 0, Math.PI * 2); g.fill();
        g.fillStyle = colors[i % colors.length];
        g.beginPath(); g.arc(0, 0, 200, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.font = 'bold 180px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i + 1), 0, 10);
        list.push(await blob(c, 'image/webp', 0.7));
      }
      stickers.push(list);
    }
    const t = document.createElement('canvas');
    t.width = t.height = 96;
    const g = t.getContext('2d');
    g.fillStyle = '#6F42F5';
    g.beginPath(); g.arc(48, 48, 44, 0, Math.PI * 2); g.fill();
    return { stickers, tray: await blob(t, 'image/png') };
  }, { n, frames });
  await browser.close();
  return { stickers: out.stickers.map((l) => l.map((a) => new Uint8Array(a))), tray: new Uint8Array(out.tray) };
}

/** Builds one pack through the bot and returns the documents it sent (name → bytes). */
async function exportPack(h, title, publisher, kind, items, tray) {
  const emojis = ['😂🔥', '😀', '🥲', '🎉'];
  const uk = kind === 'static' ? 'whatsapp_static' : 'whatsapp_animated';
  let r = await commit(inline(items[0], uk, 'webp', { action: 'wa_new', title, publisher, emojis: emojis[0] }), ctx);
  await commit(inline(tray, 'whatsapp_tray', 'png', { action: 'wa_tray', packId: r.packId }), ctx);
  for (let i = 1; i < items.length; i++) r = await commit(inline(items[i], uk, 'webp', { action: 'wa_add', packId: r.packId, emojis: emojis[i % emojis.length] }), ctx);
  const before = h.tg.callsOf('sendDocument', U).length;
  await waExport({ packId: r.packId }, ctx);
  return Object.fromEntries(h.tg.callsOf('sendDocument', U).slice(before).map((c) => [c.params.document.name, c.params.document.bytes]));
}

/** Both fixture packs, exported by the current bot code (used by this script and tests/android.test.mjs). */
export async function buildFixtures(images) {
  const h = setup({ settings: { 'flags.wastickers': true } });
  await h.ready(U);
  const still = await exportPack(h, 'پک تست Wanger', 'کیمی', 'static', images.stickers.map((l) => l[0]), images.tray);
  const moving = await exportPack(h, 'Moving test', 'Kimi', 'animated', images.stickers.map((l) => muxAnimatedWebP(l.map((webp) => ({ webp, durationMs: 120 })), 512, 512, 0)), images.tray);
  const pick = (docs, ext) => Object.entries(docs).find(([n]) => n.endsWith(ext))[1];
  return {
    'static.zip': pick(still, '.zip'),
    'animated.zip': pick(moving, '.zip'),
    'animated.wastickers': pick(moving, '.wastickers'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const images = await draw(3, 4);
  const files = await buildFixtures(images);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), bytes);
    fs.writeSync(1, `${name}: ${bytes.length} bytes\n`);
  }
  process.exit(0);
}
