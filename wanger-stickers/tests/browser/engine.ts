// Browser checks of the Phase 3 engine (driven by scripts/engine-local.mjs through Playwright;
// served by Vite's dev server, never part of the build).
import { openSource } from '../../src/engine/anim/source';
import { defaultClip, clampClip, planFrames } from '../../src/engine/anim/timeline';
import { newAnimDoc, makeRenderer, outputSize, renderAll, squareCrop, planTimes, type AnimDoc } from '../../src/engine/anim/compose';
import { toTelegramVideo } from '../../src/engine/anim/vp9';
import { toMp4 } from '../../src/engine/anim/mp4';
import { toGif, gifPlanFps } from '../../src/engine/anim/gif';
import { toWhatsAppAnimated } from '../../src/engine/anim/awebp';
import { framesZip, frameCanvas } from '../../src/engine/anim/files';
import { trayIcon, waCanvas } from '../../src/engine/export';
import { TELEGRAM, WHATSAPP, OUTPUT } from '../../src/engine/limits';
import { toBase64 } from '../../tgcloud/lib/core/bytes.js';

const files = () => Array.from((document.getElementById('f') as HTMLInputElement).files || []);
const ms = (t0: number) => Math.round(performance.now() - t0);

async function videoSticker(name: string, o: { startMs?: number; round?: boolean; text?: string } = {}) {
  const f = files().find((x) => x.name === name)!;
  const t0 = performance.now();
  const src = await openSource(f);
  const openMs = ms(t0);
  const clip = clampClip({ ...defaultClip(src.durationMs, TELEGRAM.video.maxDurationMs), startMs: o.startMs || 0, endMs: (o.startMs || 0) + 3000 }, src.durationMs, TELEGRAM.video.maxDurationMs);
  const doc: AnimDoc = newAnimDoc(clip, !!o.round);
  if (o.round) doc.crop = squareCrop(src);
  if (o.text) doc.texts = [{ id: 't', text: o.text, font: 'vazirmatn', size: 64, color: '#ffffff', stroke: '#000000', strokeWidth: 4, shadow: true, x: 0.5, y: 0.85, rotation: 0 }];
  const plan = planFrames(clip, 30, TELEGRAM.video.maxDurationMs);
  const r = makeRenderer(src, doc, 'telegram', outputSize(doc, src, 'telegram'));
  const t1 = performance.now();
  await src.prepare?.(planTimes(plan));
  const prepareMs = ms(t1);
  const frames = await renderAll(r, plan);
  const renderMs = ms(t1);
  const t2 = performance.now();
  const out = await toTelegramVideo(frames, 30);
  const encodeMs = ms(t2);
  src.close();
  return { b64: toBase64(out.bytes), info: { ...out, bytes: out.bytes.length }, source: { w: src.width, h: src.height, durationMs: src.durationMs }, openMs, prepareMs, renderMs, encodeMs, frames: frames.length };
}

async function toAnimation(name: string) {
  const f = files().find((x) => x.name === name)!;
  const src = await openSource(f);
  const clip = clampClip(defaultClip(src.durationMs, OUTPUT.animation.maxDurationMs), src.durationMs, OUTPUT.animation.maxDurationMs);
  const doc = newAnimDoc(clip);
  const plan = planFrames(clip, Math.min(30, src.fps || 30));
  const r = makeRenderer(src, doc, 'mp4', outputSize(doc, src, 'mp4', 480), '#ffffff');
  const t0 = performance.now();
  const out = await toMp4(r, plan);
  src.close();
  return { b64: toBase64(out.bytes), info: { ...out, bytes: out.bytes.length }, encodeMs: ms(t0) };
}

async function toGifFile(name: string, o: { seconds?: number; fps?: number } = {}) {
  const f = files().find((x) => x.name === name)!;
  const src = await openSource(f);
  const clip = clampClip({ ...defaultClip(src.durationMs, OUTPUT.gif.maxDurationMs), endMs: o.seconds ? o.seconds * 1000 : src.durationMs }, src.durationMs, OUTPUT.gif.maxDurationMs);
  const doc = newAnimDoc(clip);
  const plan = planFrames(clip, gifPlanFps(o.fps || 15));
  const r = makeRenderer(src, doc, 'gif', outputSize(doc, src, 'gif', 360));
  const t0 = performance.now();
  await src.prepare?.(planTimes(plan));
  const out = await toGif(r, plan, false);
  src.close();
  return { b64: toBase64(out.bytes), info: { ...out, bytes: out.bytes.length }, encodeMs: ms(t0) };
}

async function waAnimated(name: string, seconds = 3) {
  const f = files().find((x) => x.name === name)!;
  const src = await openSource(f);
  const clip = clampClip({ ...defaultClip(src.durationMs, WHATSAPP.animated.maxDurationMs), endMs: seconds * 1000 }, src.durationMs, WHATSAPP.animated.maxDurationMs);
  const doc = newAnimDoc(clip, true);
  doc.crop = squareCrop(src);
  const plan = planFrames(clip, 15, WHATSAPP.animated.maxDurationMs);
  const r = makeRenderer(src, doc, 'whatsapp', outputSize(doc, src, 'whatsapp'));
  await src.prepare?.(planTimes(plan));
  const frames = await renderAll(r, plan);
  const t0 = performance.now();
  const out = await toWhatsAppAnimated(frames, 15);
  const tray = await trayIcon(await frameCanvas(r, plan.frames[0]));
  src.close();
  return { b64: toBase64(out.bytes), tray: toBase64(tray.bytes), trayViolations: tray.violations, info: { ...out, bytes: out.bytes.length }, encodeMs: ms(t0) };
}

async function zipFrames(name: string) {
  const f = files().find((x) => x.name === name)!;
  const src = await openSource(f);
  const clip = clampClip({ ...defaultClip(src.durationMs, 1000) }, src.durationMs, 1000);
  const doc = newAnimDoc(clip);
  const plan = planFrames(clip, 10);
  const r = makeRenderer(src, doc, 'webp', outputSize(doc, src, 'webp', 256));
  const zip = await framesZip(r, plan);
  src.close();
  return { b64: toBase64(zip), frames: plan.frames.length };
}

/** A tiny Lottie (a square sliding across, 60 fps, 1 s) gzipped like a TGS. */
async function tgsSticker() {
  const lottie = {
    v: '5.7.4', fr: 60, ip: 0, op: 60, w: 512, h: 512, nm: 't', ddd: 0, assets: [],
    layers: [{
      ddd: 0, ind: 1, ty: 4, nm: 'sq', sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
      ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 1, k: [{ t: 0, s: [40, 40, 100], i: { x: [0.5, 0.5, 0.5], y: [0.5, 0.5, 0.5] }, o: { x: [0.5, 0.5, 0.5], y: [0.5, 0.5, 0.5] } }, { t: 60, s: [150, 150, 100] }] } },
      shapes: [{ ty: 'gr', nm: 'g', it: [
        { ty: 'rc', d: 1, s: { a: 0, k: [200, 200] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 20 }, nm: 'r' },
        { ty: 'fl', c: { a: 0, k: [1, 0.3, 0.2, 1] }, o: { a: 0, k: 100 }, r: 1, nm: 'f' },
        { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 }, nm: 't' },
      ] }],
    }],
  };
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(lottie)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const src = await openSource(new Blob([gz]));
  const clip = clampClip(defaultClip(src.durationMs, 3000), src.durationMs, 3000);
  const doc = newAnimDoc(clip);
  const plan = planFrames(clip, 30, 3000);
  const r = makeRenderer(src, doc, 'telegram', outputSize(doc, src, 'telegram'));
  const frames = await renderAll(r, plan);
  const mid = frames[15].data;
  // the square has moved: frame 0 and frame 15 differ, and a corner is transparent
  let diff = 0;
  for (let i = 0; i < mid.length; i += 4) diff += Math.abs(mid[i + 3] - frames[0].data[i + 3]);
  const out = await toTelegramVideo(frames, 30);
  return { b64: toBase64(out.bytes), info: { ...out, bytes: out.bytes.length }, durationMs: src.durationMs, fps: src.fps, alphaDiff: diff, corner: frames[0].data[3], opaque: [0, 15, 29].map((k) => { let n = 0; for (let i = 3; i < frames[k].data.length; i += 4) if (frames[k].data[i] > 128) n++; return n; }), centre: Array.from(frames[0].data.slice((256 * 512 + 256) * 4, (256 * 512 + 256) * 4 + 4)), size: [frames[0].width, frames[0].height] };
}

async function waStaticFromCanvas() {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 300;
  const x = c.getContext('2d')!;
  x.fillStyle = '#e33';
  x.beginPath();
  x.arc(200, 150, 140, 0, Math.PI * 2);
  x.fill();
  const out = waCanvas(c);
  return { w: out.width, h: out.height };
}

(window as unknown as { engine: unknown }).engine = { videoSticker, toAnimation, toGifFile, waAnimated, zipFrames, tgsSticker, waStaticFromCanvas };
(window as unknown as { engineReady: boolean }).engineReady = true;

