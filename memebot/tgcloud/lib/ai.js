/*
 * Phase 6: AI with Google Gemini (free tier), one call per uploaded meme:
 *   - keyword suggestions (mostly Persian), offered on the keywords question;
 *   - OCR: the text inside the image, stored in memes.ocr and indexed for search;
 *   - a "may be inappropriate" flag (memes.ai_flag / ai_reason) shown to admins on the queue card;
 *     a flagged meme always waits for approval (except a staff upload).
 * The image is small: a photo size of at most AI_IMG_MAX px, or the thumbnail of a GIF, video or
 * animated sticker; static stickers are sent as they are (webp). Voice messages get no AI.
 * The API key lives in the database (kv secret:gemini, set with the owner's /aikey), never in code.
 * Quotas: at most AI_DAILY calls per day; a 429 pauses AI for AI_PAUSE seconds; any failure just
 * means "no AI" — an upload never waits on or fails because of it. Gemini answers in ~2–3 s.
 * Privacy: the image is sent to Google (on the free tier Google may use it to improve its products);
 * the help text says so.
 */
import { api, fetch } from 'sdk';
import {
  AI_DAILY, AI_IMG_MAX, AI_MAX_BYTES, AI_MODEL, AI_OCR_MAX, AI_PAUSE, AI_SUGGEST, AI_URL,
} from './config.js';
import { bumpDay, sumsSince } from './statsstore.js';
import * as store from './store.js';
import { LINK_RE, base64, cut, tehranDay } from './util.js';

const KEY = 'secret:gemini';

export const getKey = async () => {
  const r = await store.kvGet(KEY);
  return r && r.value ? r.value : null;
};
export const setKey = (key, t) => store.kvSet(KEY, key, t);

/* AI status for the settings screen: { key, paused, today }. */
export async function aiStatus(nowSec) {
  const pause = await store.kvGet('ai:pause');
  return { key: !!(await getKey()), paused: !!(pause && pause.n > nowSec), today: (await sumsSince(tehranDay(nowSec))).ai || 0 };
}

/* The image to show the AI for a message's meme: { fileId, mime } or null. */
export function pickImage(msg) {
  const small = (f) => f && f.file_id && !(f.file_size > AI_MAX_BYTES);
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const sizes = msg.photo.filter(small).sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
    const fit = sizes.filter((s) => Math.max(s.width, s.height) <= AI_IMG_MAX);
    const best = fit.length ? fit[fit.length - 1] : sizes[0];
    return best ? { fileId: best.file_id, mime: 'image/jpeg' } : null;
  }
  const thumb = (m) => m && (m.thumbnail || m.thumb);
  if (msg.sticker) {
    if (!msg.sticker.is_animated && !msg.sticker.is_video && small(msg.sticker)) return { fileId: msg.sticker.file_id, mime: 'image/webp' };
    return small(thumb(msg.sticker)) ? { fileId: thumb(msg.sticker).file_id, mime: 'image/webp' } : null;
  }
  for (const m of [msg.animation, msg.video]) if (m && small(thumb(m))) return { fileId: thumb(m).file_id, mime: 'image/jpeg' };
  return null;
}

/* Checks a key with a free metadata request: 'ok' | 'rejected' | 'unknown' (network trouble). */
export async function checkKey(key) {
  try {
    const res = await fetch(`${AI_URL}/${AI_MODEL}`, { headers: { 'x-goog-api-key': key } });
    if (res.ok) return 'ok';
    return [400, 401, 403].includes(res.status) ? 'rejected' : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

/* Is AI usable right now? Returns the key, or null. */
export async function ready(settings, nowSec) {
  if (!settings.ai) return null;
  const key = await getKey();
  if (!key) return null;
  const pause = await store.kvGet('ai:pause');
  if (pause && pause.n > nowSec) return null;
  if (((await sumsSince(tehranDay(nowSec))).ai || 0) >= AI_DAILY) return null;
  return key;
}

const PROMPT = 'You label memes for a Persian (Farsi) meme search bot. Look at the image and return JSON. '
  + `keywords: up to ${AI_SUGGEST} short search keywords people would type to find this meme — mostly Persian, `
  + 'plus names of well-known people, characters, films or games as they are usually written; no hashtags, no links. '
  + 'text: all readable text in the image exactly as written (any language), or "" if none. '
  + 'nsfw: true if the image may be inappropriate for a general audience (nudity or sexual content, graphic '
  + 'violence or gore, hate symbols). reason: if nsfw, a few English words why, else "".';

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
    text: { type: 'STRING' },
    nsfw: { type: 'BOOLEAN' },
    reason: { type: 'STRING' },
  },
  required: ['keywords', 'text', 'nsfw'],
};

function clean(raw) {
  const keywords = [];
  for (const k of Array.isArray(raw.keywords) ? raw.keywords : []) {
    const w = String(k || '').replace(/[#\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
    if (w && !LINK_RE.test(w) && Array.from(w).length <= 40 && !keywords.includes(w)) keywords.push(w);
    if (keywords.length >= AI_SUGGEST) break;
  }
  return {
    keywords,
    ocr: cut(String(raw.text || '').replace(/\s+/g, ' ').trim(), AI_OCR_MAX),
    nsfw: raw.nsfw === true,
    reason: cut(String(raw.reason || '').trim(), 80),
  };
}

/* Analyses one image. Returns { keywords, ocr, nsfw, reason } or null (no AI this time). */
export async function analyze(image, key, nowSec) {
  if (!image) return null;
  let bytes;
  try {
    bytes = await api.getFileContent(image.fileId);
  } catch (err) {
    console.warn(`AI: could not download the image: ${String((err && err.description) || err)}`);
    return null;
  }
  if (!bytes || bytes.length > AI_MAX_BYTES) return null;
  await bumpDay('ai', nowSec);
  let res;
  let body;
  try {
    res = await fetch(`${AI_URL}/${AI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: image.mime, data: base64(bytes) } }, { text: PROMPT }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
    });
    body = await res.json();
  } catch (err) {
    console.warn(`AI: request failed: ${String((err && err.message) || err)}`);
    return null;
  }
  if (res.status === 429) {
    await store.kvSet('ai:pause', 'quota', nowSec + AI_PAUSE);
    return null;
  }
  const blocked = (body.promptFeedback && body.promptFeedback.blockReason) || (body.candidates && body.candidates[0] && body.candidates[0].finishReason === 'SAFETY');
  if (res.ok && blocked) return { keywords: [], ocr: '', nsfw: true, reason: 'blocked by the safety filter' };
  if (!res.ok || !body.candidates || !body.candidates[0] || !body.candidates[0].content) {
    console.warn(`AI: ${res.status} ${body.error ? String(body.error.message).slice(0, 120) : 'no answer'}`);
    return null;
  }
  try {
    return clean(JSON.parse(body.candidates[0].content.parts.map((p) => p.text || '').join('')));
  } catch (err) {
    return null;
  }
}
