/*
 * Media tools at work (Phase 9), all computed here without paid services:
 *   photo → sticker (a PNG added to the member's own Aegis pack, then sent) · sticker → photo / file
 *   · image tools (gray, sepia, invert, blur, pixelate, circle, rotate, mirror, flip, square, smaller,
 *   as a file) · GIF maker (photos → an animated GIF; a video → a GIF, Telegram's kind: MP4 without
 *   sound) · QR codes (make; read in the image here, or in the Mini App) · text in images (OCR, in the
 *   Mini App with Tesseract.js on the member's device) · PDF check.
 * Private chat: send a photo, sticker, video, GIF or PDF and pick a tool. Groups: reply with a
 * command (/sticker /tophoto /gif /qr /readqr /ocr /pdf /tools), when media_on; media_who and a daily
 * limit per member (media_daily) apply. Security (ui/security.js) uses qrText() and pdfReport()
 * for the suspicious-content checks.
 *
 * callback_data: md:<job>:<op>   (only the member who asked)  · Panel: g:c:md[:s:<key>]
 * /start payload: md_<job> (a group's tools, opened in private)
 */
import { InputFile } from 'sdk';
import { APP_URL } from '../config.js';
import { tzOf } from '../core/clock.js';
import { checkPdf } from '../core/files.js';
import * as img from '../core/image.js';
import { answer, appBtn, btn, call, me, screen, send, tryCall, urlBtn } from '../core/tg.js';
import { esc, iso, nowSec, toInt } from '../core/util.js';
import * as chats from '../engines/chats.js';
import * as fun from '../engines/fun.js';
import * as settings from '../engines/settings.js';
import * as users from '../engines/users.js';
import { num, pickLang, t, wordCommand } from '../i18n/index.js';
import { isAdmin } from './enforce.js';
import { back } from './guard.js';
import { settingBtn, toggle } from './panel_channel.js';

const flag = settings.flag;
const MAX_PHOTO = 1280;
const PACK_MAX = 120;
const STICKER_BYTES = 512 * 1024;
const SPEEDS = [50, 100, 200];
const OPS = ['g', 'sp', 'iv', 'bl', 'px', 'ci', 'r9', 'mi', 'fl', 'sq', 'hf', 'fi'];
const SLASH = { sticker: 'st', tophoto: 'ph', gif: 'gv', qr: 'qr', readqr: 'rq', ocr: 'oc', pdf: 'pd', tools: 'tl' };
const reply = (message) => ({ reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });

/* ---------- what a message holds ---------- */

/* The best PhotoSize for work: the smallest whose longer side is at least `want` (else the largest). */
export function photoSize(sizes, want = 800) {
  const list = [...(sizes || [])].sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  return list.find((p) => Math.max(p.width, p.height) >= want && Math.max(p.width, p.height) <= MAX_PHOTO) || list.filter((p) => Math.max(p.width, p.height) <= MAX_PHOTO).pop()
    || list[0] || null;
}

const isPdf = (d) => !!d && (d.mime_type === 'application/pdf' || /\.pdf$/i.test(d.file_name || ''));
const isImageDoc = (d) => !!d && /^image\/(jpeg|png)$/.test(d.mime_type || '') && Number(d.file_size || 0) <= 8 * 1024 * 1024;

/* The job a message's media becomes: { kind, fileId, data } or null. */
function mediaOf(m) {
  if (!m) return null;
  if (m.photo && m.photo.length) {
    const p = photoSize(m.photo, 800);
    const big = photoSize(m.photo, MAX_PHOTO);
    return { kind: 'photo', fileId: p.file_id, data: { big: big.file_id, sizes: m.photo.map((x) => [x.file_id, x.width, x.height]) } };
  }
  if (m.sticker) {
    const s = m.sticker;
    return { kind: 'sticker', fileId: s.file_id, data: { animated: !!s.is_animated, video: !!s.is_video } };
  }
  if (m.animation) return { kind: 'animation', fileId: m.animation.file_id, data: { size: Number(m.animation.file_size || 0), w: m.animation.width, h: m.animation.height } };
  if (m.video) return { kind: 'video', fileId: m.video.file_id, data: { size: Number(m.video.file_size || 0), w: m.video.width, h: m.video.height, d: m.video.duration } };
  if (m.document && isPdf(m.document)) return { kind: 'pdf', fileId: m.document.file_id, data: { size: Number(m.document.file_size || 0), name: m.document.file_name || '' } };
  if (m.document && isImageDoc(m.document)) return { kind: 'photo', fileId: m.document.file_id, data: { big: m.document.file_id, doc: true } };
  return null;
}

/* ---------- the tools ---------- */

const download = (ctx, fileId, view) => call(ctx, 'getFileContent', { file_id: fileId }, view);

async function decodePhoto(ctx, fileId, max = MAX_PHOTO) {
  const bytes = await download(ctx, fileId, 'media-get');
  return img.fit(img.decodeImage(bytes), max);
}

/* A sticker PNG: the longer side exactly 512 px, ≤ 256 colors (Telegram's limit is 512 KB). */
export function stickerPng(image) {
  const fitted = img.fit(image, 512, true);
  for (const colors of [256, 128, 64]) {
    const png = img.encodePng(fitted, img.quantize(fitted, colors, { dither: true }), 9);
    if (png.length <= STICKER_BYTES) return png;
  }
  return null;
}

/* Adds a PNG sticker to the member's pack (made the first time) and gives the new sticker's file_id. */
async function addToPack(ctx, userId, png, lang) {
  const bot = String((await me(ctx)).username || '');
  const row = await fun.pack(userId);
  const name = row ? row.name : `a${userId}_by_${bot}`.slice(0, 64);
  const input = { sticker: new InputFile(png, 'sticker.png', { type: 'image/png' }), format: 'static', emoji_list: ['🖼'] };
  let set = null;
  if (row) {
    set = await tryCall(ctx, 'getStickerSet', { name }, 'pack-get');
    if (set && set.stickers.length >= PACK_MAX) await tryCall(ctx, 'deleteStickerFromSet', { sticker: set.stickers[0].file_id }, 'pack-trim');
    await call(ctx, 'addStickerToSet', { user_id: userId, name, sticker: input }, 'pack-add');
  } else {
    await call(ctx, 'createNewStickerSet', { user_id: userId, name, title: t(lang, 'media.pack_title').replace(/[\u200F]/g, '').slice(0, 64), stickers: [input] },
      'pack-new');
  }
  set = await call(ctx, 'getStickerSet', { name }, 'pack-get');
  await fun.savePack(userId, name, set.stickers.length);
  const last = set.stickers[set.stickers.length - 1];
  return { fileId: last.file_id, name };
}

/* Fits an image into w × h on black (GIF frames of other sizes). */
function letterbox(image, w, h) {
  const k = Math.min(w / image.w, h / image.h);
  const scaled = img.resize(image, Math.max(1, Math.round(image.w * k)), Math.max(1, Math.round(image.h * k)));
  const out = img.newImage(w, h);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  const ox = Math.floor((w - scaled.w) / 2);
  const oy = Math.floor((h - scaled.h) / 2);
  for (let y = 0; y < scaled.h; y += 1) out.data.set(scaled.data.subarray(y * scaled.w * 4, (y + 1) * scaled.w * 4), ((y + oy) * w + ox) * 4);
  return out;
}

export function applyOp(op, image) {
  switch (op) {
    case 'g': return img.gray(image);
    case 'sp': return img.sepia(image);
    case 'iv': return img.invert(image);
    case 'bl': return img.blur(image);
    case 'px': return img.pixelate(image);
    case 'ci': return img.circle(image);
    case 'r9': return img.rotate(image, 90);
    case 'mi': return img.flip(image, true);
    case 'fl': return img.flip(image, false);
    case 'sq': return img.square(image);
    case 'hf': return img.resize(image, image.w / 2, image.h / 2);
    default: return image;
  }
}

/* The text of a QR code in a photo message, or null (for the security check too). */
export async function qrText(ctx, message) {
  const p = photoSize(message.photo, 800);
  if (!p) return null;
  try {
    return img.qr.decode(await decodePhoto(ctx, p.file_id, 1000));
  } catch (err) {
    console.warn(`qr check failed: ${err.message}`);
    return null;
  }
}

/* checkPdf() of a document (≤ 20 MB, Telegram's download limit for bots), or null. */
export async function pdfReport(ctx, doc) {
  if (!isPdf(doc) || Number(doc.file_size || 0) > 20 * 1024 * 1024) return null;
  try {
    return checkPdf(await download(ctx, doc.file_id, 'pdf-get'));
  } catch (err) {
    console.warn(`pdf check failed: ${err.message}`);
    return null;
  }
}

function pdfText(lang, r) {
  if (!r || !r.pdf) return t(lang, 'media.pdf_not');
  const lines = [t(lang, `media.pdf_${r.verdict}`)];
  if (r.pages) lines.push(t(lang, 'media.pdf_pages', { n: num(lang, r.pages) }));
  for (const reason of r.reasons) lines.push(`• ${t(lang, `media.pdf_r_${reason}`)}`);
  if (r.uris.length) lines.push(t(lang, 'media.pdf_links', { list: r.uris.slice(0, 5).map((u) => `<code>${esc(u.slice(0, 80))}</code>`).join('\n') }));
  if (r.verdict === 'clean') lines.push(t(lang, 'media.pdf_note'));
  return lines.join('\n');
}

/* ---------- keyboards ---------- */

function toolRows(lang, j, priv) {
  const p = `md:${j.id}`;
  if (j.kind === 'photo') {
    const rows = [[btn(t(lang, 'media.btn_sticker'), `${p}:st`), ...(priv ? [btn(t(lang, 'media.btn_gif_add'), `${p}:gf`)] : [])]];
    const ops = OPS.map((op) => btn(t(lang, `media.op_${op}`), `${p}:${op}`));
    for (let i = 0; i < ops.length; i += 3) rows.push(ops.slice(i, i + 3));
    const last = [btn(t(lang, 'media.btn_readqr'), `${p}:rq`)];
    if (priv) last.push(appBtn(t(lang, 'media.btn_ocr'), `${APP_URL}media?j=${j.id}`));
    rows.push(last);
    return rows;
  }
  if (j.kind === 'sticker') {
    const d = fun.jobData(j);
    return [[...(d.animated || d.video ? [] : [btn(t(lang, 'media.btn_tophoto'), `${p}:ph`)]), btn(t(lang, 'media.op_fi'), `${p}:fi`)]];
  }
  if (j.kind === 'video') return [[btn(t(lang, 'media.btn_togif'), `${p}:gv`)]];
  if (j.kind === 'animation') return [[btn(t(lang, 'media.btn_tovideo'), `${p}:av`)]];
  if (j.kind === 'pdf') return [[btn(t(lang, 'media.btn_pdf'), `${p}:pd`)]];
  return null;
}

function framesRows(lang, j) {
  const d = fun.jobData(j);
  const n = (d.frames || []).length;
  return [[btn(t(lang, 'media.btn_gif_make', { n: num(lang, n) }), `md:${j.id}:mk`)],
    [btn(t(lang, 'media.btn_gif_speed', { s: num(lang, (d.delay || 100) / 100) }), `md:${j.id}:sd`), btn(t(lang, 'media.btn_gif_clear'), `md:${j.id}:cl`)]];
}

/* ---------- private chat ---------- */

/* A photo, sticker, video, GIF or PDF sent to Aegis in private: the tools for it. Gives true when handled. */
export async function privateMessage(ctx, user, message) {
  const found = mediaOf(message);
  if (!found) return false;
  const lang = user.lang;
  const id = await fun.addJob(user.user_id, 0, found.kind, found.fileId, found.data);
  const j = await fun.job(id);
  if (found.kind === 'pdf') return runOp(ctx, user.user_id, lang, j, 'pd', null, null);
  await send(ctx, user.user_id, t(lang, `media.pick_${found.kind}`), toolRows(lang, j, true), 'media-tools', reply(message));
  return true;
}

/* /start md_<job>: a group's job opened in private (OCR needs the Mini App, which only works here). */
export async function openJob(ctx, user, jobId) {
  const j = await fun.job(jobId);
  if (!j || Number(j.user_id) !== user.user_id) return send(ctx, user.user_id, t(user.lang, 'media.gone'), null, 'media-gone');
  return send(ctx, user.user_id, t(user.lang, `media.pick_${j.kind}`), toolRows(user.lang, j, true), 'media-tools');
}

/* /qr <text> in private (and groups): a QR code image. */
async function makeQr(ctx, chatId, lang, text, extra) {
  const code = img.qr.encode(text, 'M');
  const scale = Math.max(4, Math.min(16, Math.floor(640 / (code.size + 8))));
  const picture = img.qr.render(code, scale, 4);
  const png = img.encodePng(picture, img.quantize(picture, 2), 9);
  return tryCall(ctx, 'sendPhoto', { chat_id: chatId, photo: new InputFile(png, 'qr.png', { type: 'image/png' }), caption: t(lang, 'media.qr_made').slice(0, 1000),
    parse_mode: 'HTML', ...extra }, 'media-qr');
}

/* ---------- running a tool ---------- */

/* op on job j for userId, answering in chatId (private: the user). place: the tools message. */
async function runOp(ctx, chatId, lang, j, op, place, extra) {
  const ex = extra || {};
  const say = (key, vars = {}) => send(ctx, chatId, t(lang, key, vars), null, `media-${op}`, ex);
  const d = fun.jobData(j);
  try {
    if (op === 'st') {
      const image = await decodePhoto(ctx, j.file_id, 800);
      const png = stickerPng(image);
      if (!png) return say('media.too_big');
      let res;
      try {
        res = await addToPack(ctx, Number(j.user_id), png, lang);
      } catch (err) {
        const bot = (await me(ctx)).username;
        return send(ctx, chatId, t(lang, 'media.pack_failed'), [[urlBtn(t(lang, 'media.btn_start'), `https://t.me/${bot}?start=hi`)]], 'media-pack-failed', ex);
      }
      await call(ctx, 'sendSticker', { chat_id: chatId, sticker: res.fileId, ...ex }, 'media-sticker');
      return send(ctx, chatId, t(lang, 'media.pack_added'), [[urlBtn(t(lang, 'media.btn_pack'), `https://t.me/addstickers/${res.name}`)]], 'media-pack');
    }
    if (op === 'ph' || (op === 'fi' && j.kind === 'sticker')) {
      const bytes = await download(ctx, j.file_id, 'media-get');
      const kind = img.sniff(bytes);
      const ext = d.video ? 'webm' : d.animated ? 'tgs' : (kind === 'png' ? 'png' : 'webp');
      if (op === 'ph' && (ext === 'webp' || ext === 'png')) {
        const sent = await tryCall(ctx, 'sendPhoto', { chat_id: chatId, photo: new InputFile(bytes, `sticker.${ext}`, { type: `image/${ext}` }), ...ex }, 'media-photo');
        if (sent) return sent;
      }
      return call(ctx, 'sendDocument', { chat_id: chatId, document: new InputFile(bytes, `sticker.${ext}`), ...ex }, 'media-file');
    }
    if (op === 'fi') {
      const bytes = await download(ctx, d.big || j.file_id, 'media-get');
      return call(ctx, 'sendDocument', { chat_id: chatId, document: new InputFile(bytes, img.sniff(bytes) === 'png' ? 'aegis.png' : 'aegis.jpg'), ...ex }, 'media-file');
    }
    if (OPS.includes(op)) {
      const image = applyOp(op, await decodePhoto(ctx, j.file_id, 1024));
      if (op === 'ci') {
        return call(ctx, 'sendDocument', { chat_id: chatId, document: new InputFile(img.encodePng(image), 'circle.png', { type: 'image/png' }), ...ex }, 'media-circle');
      }
      return call(ctx, 'sendPhoto', { chat_id: chatId, photo: new InputFile(img.encodeJpeg(image, 88), `aegis-${op}.jpg`, { type: 'image/jpeg' }), ...ex }, `media-${op}`);
    }
    if (op === 'rq') {
      const image = await decodePhoto(ctx, j.file_id, 1000);
      const text = img.qr.decode(image);
      if (text === null) {
        const bot = (await me(ctx)).username;
        const rows = chatId > 0 ? [[appBtn(t(lang, 'media.btn_ocr'), `${APP_URL}media?j=${j.id}`)]] : [[urlBtn(t(lang, 'media.btn_open_private'), `https://t.me/${bot}?start=md_${j.id}`)]];
        return send(ctx, chatId, t(lang, 'media.qr_none'), rows, 'media-qr-none', ex);
      }
      return say('media.qr_read', { text: `<code>${esc(text.slice(0, 3000))}</code>` });
    }
    if (op === 'gv' || op === 'av') {
      const size = Number(d.size || 0);
      if (size > 20 * 1024 * 1024) return say('media.too_big');
      const bytes = await download(ctx, j.file_id, 'media-get');
      if (op === 'gv') {
        return call(ctx, 'sendAnimation', { chat_id: chatId, animation: new InputFile(bytes, 'aegis.mp4', { type: 'video/mp4' }), width: d.w, height: d.h, ...ex }, 'media-gif');
      }
      return call(ctx, 'sendVideo', { chat_id: chatId, video: new InputFile(bytes, 'aegis.mp4', { type: 'video/mp4' }), width: d.w, height: d.h, ...ex }, 'media-video');
    }
    if (op === 'pd') {
      if (Number(d.size || 0) > 20 * 1024 * 1024) return say('media.too_big');
      const r = checkPdf(await download(ctx, j.file_id, 'pdf-get'));
      return send(ctx, chatId, pdfText(lang, r), null, 'media-pdf', ex);
    }
    if (op === 'gf') {
      let fj = await fun.framesJob(Number(j.user_id), nowSec() - 3600);
      if (!fj) fj = await fun.job(await fun.addJob(Number(j.user_id), Number(j.chat_id), 'frames', null, { frames: [], delay: 100 }));
      const fd = fun.jobData(fj);
      const frames = fd.frames || [];
      if (frames.length >= 10) return say('media.gif_full');
      const small = d.sizes ? photoSize(d.sizes.map(([fileId, width, height]) => ({ file_id: fileId, width, height })), 320).file_id : j.file_id;
      if (!frames.includes(small)) frames.push(small);
      await fun.setJobData(fj.id, { ...fd, frames });
      return screen(ctx, chatId, null, t(lang, 'media.gif_added', { n: num(lang, frames.length) }), framesRows(lang, await fun.job(fj.id)), 'media-frames');
    }
    if (op === 'sd' || op === 'cl') {
      if (op === 'cl') {
        await fun.setJobData(j.id, { frames: [], delay: d.delay || 100 });
        return screen(ctx, chatId, place, t(lang, 'media.gif_cleared'), null, 'media-frames');
      }
      const delay = SPEEDS[(SPEEDS.indexOf(d.delay || 100) + 1) % SPEEDS.length];
      await fun.setJobData(j.id, { ...d, delay });
      return screen(ctx, chatId, place, t(lang, 'media.gif_added', { n: num(lang, (d.frames || []).length) }), framesRows(lang, await fun.job(j.id)), 'media-frames');
    }
    if (op === 'mk') {
      const frames = d.frames || [];
      if (frames.length < 2) return say('media.gif_need');
      const pics = [];
      for (const f of frames) pics.push(await decodePhoto(ctx, f, 360));
      const w = pics[0].w;
      const h = pics[0].h;
      const gif = img.encodeGif(pics.map((p) => ({ img: p.w === w && p.h === h ? p : letterbox(p, w, h), delay: d.delay || 100 })));
      await fun.setJobData(j.id, { frames: [], delay: d.delay || 100 });
      return call(ctx, 'sendAnimation', { chat_id: chatId, animation: new InputFile(gif, 'aegis.gif', { type: 'image/gif' }), width: w, height: h, ...ex }, 'media-gif-made');
    }
  } catch (err) {
    console.warn(`media ${op} failed: ${err.message}`);
    return say(/too large/.test(String(err.message)) ? 'media.too_big' : 'media.failed');
  }
  return null;
}

export async function callback(ctx, cq, parts) {
  const from = cq.from;
  const u = await users.get(from.id);
  const lang = u && Number(u.lang_set) ? u.lang : pickLang(from.language_code);
  const j = await fun.job(toInt(parts[1]));
  if (!j) return answer(ctx, t(lang, 'media.gone'), true);
  if (Number(j.user_id) !== from.id) return answer(ctx, t(lang, 'media.not_yours'), true);
  const op = parts[2];
  const msg = cq.message;
  const chatId = msg ? msg.chat.id : from.id;
  if (chatId < 0) {
    const s = await settings.all(ctx, chatId);
    const left = await allowed(ctx, chatId, s, from.id);
    if (left !== 'ok') return answer(ctx, left, true);
  } else if (!(await usePrivate(from.id))) return answer(ctx, t(lang, 'media.limit'), true);
  await answer(ctx, t(lang, 'media.working'));
  const place = msg ? { chat_id: chatId, message_id: msg.message_id } : null;
  const groupLang = chatId < 0 ? ((await chats.get(chatId)) || {}).lang || lang : lang;
  return runOp(ctx, chatId, groupLang, j, op, place, chatId < 0 && msg ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : null);
}

async function usePrivate(userId) {
  const day = Math.floor(nowSec() / 86400);
  return (await fun.claimUse(0, userId, 'media', { cd: 2, daily: 50 }, day)) === 'ok';
}

/* In a group: media tools on, the member allowed, the daily limit. Gives 'ok' or the refusal text. */
async function allowed(ctx, chatId, s, userId) {
  const chat = await chats.get(chatId);
  const lang = chat ? chat.lang : 'en';
  if (!flag(s, 'media_on')) return t(lang, 'media.off');
  if (s.media_who === 'd' && !(await isAdmin(chatId, userId))) return t(lang, 'media.admins_only');
  const day = Math.floor((nowSec() + tzOf(s.tz, lang) * 60) / 86400);
  const r = await fun.claimUse(chatId, userId, 'media', { cd: 5, daily: Number(s.media_daily) || 10 }, day);
  if (r === 'daily') return t(lang, 'media.limit');
  if (r !== 'ok') return t(lang, 'media.wait');
  return 'ok';
}

/* ---------- group commands ---------- */

export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 1000) return null;
  const tokens = s.split(/\s+/);
  const m = /^\/([A-Za-z_]{2,20})(?:@([A-Za-z0-9_]+))?$/.exec(tokens[0]);
  if (m) {
    const op = SLASH[m[1].toLowerCase()];
    return op ? { op, args: s.slice(tokens[0].length).trim(), slash: true, mention: m[2] ? m[2].toLowerCase() : null } : null;
  }
  for (let n = Math.min(3, tokens.length); n >= 1; n -= 1) {
    const key = wordCommand('mediacmd', tokens.slice(0, n).join(' '));
    if (!key) continue;
    const rest = tokens.slice(n).join(' ');
    if (rest && key !== 'qr') continue;
    return { op: SLASH[key] || key, args: rest, slash: false, mention: null };
  }
  return null;
}

/* Group and private commands: /qr <text> anywhere; the others as a reply to the media. */
export async function command(ctx, message, privUser = null) {
  const parsed = parseCommand(message.text);
  const from = message.from;
  if (!parsed || !from || from.is_bot || message.sender_chat) return false;
  const priv = message.chat.type === 'private';
  const chatId = message.chat.id;
  let lang;
  if (priv) {
    lang = privUser ? privUser.lang : pickLang(from.language_code);
    if (!(await usePrivate(from.id))) {
      await send(ctx, chatId, t(lang, 'media.limit'), null, 'media-limit');
      return true;
    }
  } else {
    const chat = await chats.get(chatId);
    if (!chat || !Number(chat.registered)) return false;
    if (parsed.mention && parsed.mention !== String((await me(ctx)).username).toLowerCase()) return false;
    const s = await settings.all(ctx, chatId);
    lang = chat.lang;
    if (!flag(s, 'media_on')) return parsed.slash;
    const ok = await allowed(ctx, chatId, s, from.id);
    if (ok !== 'ok') {
      if (parsed.slash) await send(ctx, chatId, ok, null, 'media-refused', reply(message));
      return true;
    }
  }
  const r = reply(message);
  const target = message.reply_to_message;
  if (parsed.op === 'qr' && parsed.args) {
    if ([...parsed.args].length > 900) {
      await send(ctx, chatId, t(lang, 'media.qr_long'), null, 'media-qr-long', r);
      return true;
    }
    await makeQr(ctx, chatId, lang, parsed.args, r);
    return true;
  }
  const found = mediaOf(target);
  const op = parsed.op === 'qr' ? 'rq' : parsed.op;
  if (!found || (['st', 'rq', 'oc', 'tl'].includes(op) && found.kind !== 'photo') || (op === 'ph' && found.kind !== 'sticker')
    || (op === 'gv' && found.kind !== 'video') || (op === 'pd' && found.kind !== 'pdf')) {
    if (parsed.slash) await send(ctx, chatId, t(lang, `media.usage_${op}`), null, 'media-usage', r);
    return parsed.slash;
  }
  const id = await fun.addJob(from.id, priv ? 0 : chatId, found.kind, found.fileId, found.data);
  const j = await fun.job(id);
  if (op === 'tl') {
    await send(ctx, chatId, t(lang, `media.pick_${found.kind}`), toolRows(lang, j, priv), 'media-tools', r);
    return true;
  }
  if (op === 'oc') {
    if (priv) await send(ctx, chatId, t(lang, 'media.ocr_open'), [[appBtn(t(lang, 'media.btn_ocr'), `${APP_URL}media?j=${id}`)]], 'media-ocr', r);
    else {
      const bot = (await me(ctx)).username;
      await send(ctx, chatId, t(lang, 'media.ocr_private'), [[urlBtn(t(lang, 'media.btn_open_private'), `https://t.me/${bot}?start=md_${id}`)]], 'media-ocr', r);
    }
    return true;
  }
  await runOp(ctx, chatId, lang, j, op, null, r);
  return true;
}

/* ========== panelMedia: the 🖼 Media section of a group's panel ========== */

export const panelMedia = (() => {
  async function show(ctx, user, g, place) {
    const lang = user.lang;
    const c = g.chat.chat_id;
    const s = await settings.all(ctx, c);
    const lines = [t(lang, 'media.panel_title', { title: iso(g.chat.title || '', 48) }), t(lang, 'media.panel_intro'), '', t(lang, 'media.panel_security')];
    const kb = [[settingBtn(lang, c, s, 'media_on', 'md')], [settingBtn(lang, c, s, 'media_who', 'md'), settingBtn(lang, c, s, 'media_daily', 'md')],
      [btn(t(lang, 'media.btn_security'), `g:${c}:S`)], back(lang, `g:${c}`)];
    return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-media');
  }
  async function callback(ctx, user, g, parts, place) {
    if (g.chat.type === 'channel') return null;
    if (parts[3] === 's') await toggle(ctx, user, g, parts[4]);
    return show(ctx, user, g, place);
  }
  return { callback };
})();

