// Phase 3 engine checks in a local headless Chromium (Vite dev server + tests/browser/engine.ts):
// the brief's "Done when" for Phase 3 plus the other outputs, each checked with the SERVER's own
// validators (and ffprobe when it is installed).
//
//   npm run engine:local -- <clip.mp4> [anim.gif]   → docs/spike-results/engine-local.json
// The clip should be a 10 s 1080p MP4 with sound (e.g. ffmpeg testsrc2 + sine).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { ROOT } from './tg.mjs';
import { validateTelegramVideo, validateMp4Animation, validateGif, validateWhatsAppAnimated, validateWhatsAppTray, sniffImage } from '../tgcloud/lib/core/validate.js';
import { readZip } from '../tgcloud/lib/core/zip.js';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = createRequire(path.join(process.env.NODE_PATH || '/usr/local/lib/node_modules', 'x.js'))('playwright');
}
const [clipPath, gifPath] = process.argv.slice(2);
if (!clipPath || !fs.existsSync(clipPath)) {
  console.error('usage: npm run engine:local -- <clip.mp4> [anim.gif]');
  process.exit(1);
}
const OUT = path.join(ROOT, 'docs/spike-results');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-engine-'));
const save = (name, b64) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.from(b64, 'base64'));
  return p;
};
const ffprobe = (p) => {
  try {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', p]).toString());
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
};

const server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
const results = { at: new Date().toISOString(), browser: browser.version(), checks: {} };
const ok = (name, pass, detail) => {
  results.checks[name] = { pass, ...detail };
  console.log(`${pass ? '✅' : '❌'} ${name}`, JSON.stringify(detail).slice(0, 400));
};
try {
  await page.goto(`${base}tests/browser/engine.html`);
  await page.waitForFunction(() => window.engineReady === true, null, { timeout: 60000 });
  const inputs = [clipPath, ...(gifPath ? [gifPath] : [])];
  await page.setInputFiles('#f', inputs);
  const clipName = path.basename(clipPath);
  const run = (fn, ...args) => page.evaluate(([f, a]) => window.engine[f](...a), [fn, args]);

  // 1. Done when: a 10 s 1080p MP4 → a valid VP9 video sticker
  const t0 = Date.now();
  const v = await run('videoSticker', clipName, { startMs: 4000, text: 'سلام Wanger' });
  const wall = Date.now() - t0;
  const vPath = save('sticker.webm', v.b64);
  const vCheck = validateTelegramVideo(Buffer.from(v.b64, 'base64'));
  const probe = ffprobe(vPath);
  const vStream = probe.streams && probe.streams[0];
  ok('mp4_1080p_10s_to_vp9_sticker', vCheck.ok && !!vStream && vStream.codec_name === 'vp9' && probe.streams.length === 1, {
    source: v.source, violations: vCheck.violations, kb: Math.round(v.info.bytes / 102.4) / 10, fps: v.info.fps, frames: v.info.frames, durationMs: v.info.durationMs,
    side: `${v.info.width}x${v.info.height}`, bitrate: v.info.bitrate, encodes: v.info.encodes, alpha: v.info.alpha, timings: { openMs: v.openMs, prepareMs: v.prepareMs, renderMs: v.renderMs, encodeMs: v.encodeMs, wallMs: wall }, ffprobe: probe,
  });
  // 1b. round video → circle with transparent corners (alpha plane)
  const r = await run('videoSticker', clipName, { round: true });
  const rCheck = validateTelegramVideo(Buffer.from(r.b64, 'base64'));
  ok('round_video_sticker_with_alpha', rCheck.ok && r.info.alpha === true && r.info.width === 512 && r.info.height === 512, { violations: rCheck.violations, kb: Math.round(r.info.bytes / 1024), alphaTrack: rCheck.info.tracks[0].alphaMode === 1 });
  save('round.webm', r.b64);

  // 2. Done when: MP4 → GIF and GIF → MP4
  const g = await run('toGifFile', clipName, { seconds: 4, fps: 15 });
  const gBytes = Buffer.from(g.b64, 'base64');
  const gCheck = validateGif(gBytes);
  const gPath = save('from_mp4.gif', g.b64);
  ok('mp4_to_gif', gCheck.ok && sniffImage(gBytes) === 'gif', { violations: gCheck.violations, kb: Math.round(gBytes.length / 1024), frames: gCheck.info.frames, durationMs: gCheck.info.durationMs, size: `${gCheck.info.width}x${gCheck.info.height}`, encodeMs: g.encodeMs, ffprobe: ffprobe(gPath) });
  await page.setInputFiles('#f', [...inputs, gPath]);
  const m = await run('toAnimation', 'from_mp4.gif');
  const mBytes = Buffer.from(m.b64, 'base64');
  const mCheck = validateMp4Animation(mBytes);
  const mPath = save('from_gif.mp4', m.b64);
  const mProbe = ffprobe(mPath);
  ok('gif_to_mp4', mCheck.ok && mProbe.streams && mProbe.streams.length === 1 && mProbe.streams[0].codec_name === 'h264', { violations: mCheck.violations, kb: Math.round(mBytes.length / 1024), encodeMs: m.encodeMs, ffprobe: mProbe });
  if (gifPath) {
    const m2 = await run('toAnimation', path.basename(gifPath));
    const c2 = validateMp4Animation(Buffer.from(m2.b64, 'base64'));
    ok('ffmpeg_gif_to_mp4', c2.ok, { violations: c2.violations, kb: Math.round(m2.info.bytes / 1024) });
  }

  // 3. WhatsApp animated + tray
  const w = await run('waAnimated', clipName, 3);
  const wBytes = Buffer.from(w.b64, 'base64');
  const wCheck = validateWhatsAppAnimated(wBytes);
  const tCheck = validateWhatsAppTray(Buffer.from(w.tray, 'base64'));
  ok('whatsapp_animated_3s', wCheck.ok && tCheck.ok, { violations: wCheck.violations, trayViolations: tCheck.violations, kb: Math.round(wBytes.length / 1024), fps: w.info.fps, quality: w.info.quality, encodes: w.info.encodes, frames: wCheck.info.frames, durationMs: wCheck.info.durationMs, encodeMs: w.encodeMs });
  save('wa.webp', w.b64);

  // 4. frames → ZIP of PNGs
  const z = await run('zipFrames', clipName);
  const zip = readZip(Buffer.from(z.b64, 'base64'));
  ok('frames_zip', !zip.error && zip.entries.length === z.frames && zip.entries.every((e) => sniffImage(e.data) === 'png'), { entries: zip.entries.length, error: zip.error || null });

  // 5. TGS (Lottie) → video sticker
  const t = await run('tgsSticker');
  const tc = validateTelegramVideo(Buffer.from(t.b64, 'base64'));
  ok('tgs_to_video_sticker', tc.ok && t.alphaDiff > 0 && t.corner === 0 && t.opaque[0] > 1000 && t.opaque[2] > t.opaque[0], { violations: tc.violations, kb: Math.round(t.info.bytes / 1024), sourceMs: t.durationMs, sourceFps: t.fps, alpha: t.info.alpha, alphaDiff: t.alphaDiff, corner: t.corner, opaque: t.opaque, centre: t.centre, size: t.size });
  const s = await run('waStaticFromCanvas');
  ok('whatsapp_canvas_512', s.w === 512 && s.h === 512, s);
} catch (e) {
  ok('run', false, { error: String(e && e.stack).slice(0, 2000) });
} finally {
  results.logs = logs.slice(-40);
  results.files = tmp;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'engine-local.json'), JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
const failed = Object.entries(results.checks).filter(([, c]) => !c.pass);
console.log(failed.length ? `\n${failed.length} failed` : '\nall passed', `(files in ${tmp})`);
process.exit(failed.length ? 1 : 0);
