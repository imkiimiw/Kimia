/*
 * A post's content, independent of the message that carried it: { t: text or caption, e: its
 * entities, f: the file_id } and a kind (text, photo, video, animation, document, audio, voice,
 * video_note, sticker; anything else is "other" and can only be archived, not published again).
 * Used for the post archive and its versions, posts held for approval, scheduled posts and
 * cross-posting: they are published again by file_id, so no source message has to survive.
 */
import { call } from './tg.js';
import { BC_MAX_BUTTON_ROWS, BC_MAX_BUTTON_TEXT, BC_MAX_BUTTONS_PER_ROW } from '../config.js';

export const PUBLISHABLE = ['text', 'photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker'];
const CAPTIONED = new Set(['photo', 'video', 'animation', 'document', 'audio', 'voice']);
const METHOD = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation', document: 'sendDocument', audio: 'sendAudio', voice: 'sendVoice',
  video_note: 'sendVideoNote', sticker: 'sendSticker' };
const TEXT_MAX = 4096;
const CAPTION_MAX = 1024;

/* { kind, c } of a message. */
export function contentOf(m) {
  if (!m) return { kind: 'other', c: { t: '' } };
  if (typeof m.text === 'string') return { kind: 'text', c: { t: m.text, e: m.entities || [] } };
  const cap = { t: m.caption || '', e: m.caption_entities || [] };
  if (Array.isArray(m.photo) && m.photo.length) return { kind: 'photo', c: { ...cap, f: m.photo[m.photo.length - 1].file_id } };
  for (const k of ['video', 'animation', 'document', 'audio', 'voice']) if (m[k] && m[k].file_id) return { kind: k, c: { ...cap, f: m[k].file_id } };
  if (m.video_note) return { kind: 'video_note', c: { t: '', f: m.video_note.file_id } };
  if (m.sticker) return { kind: 'sticker', c: { t: '', f: m.sticker.file_id } };
  return { kind: 'other', c: { t: m.caption || '' } };
}

export const canPublish = (kind) => PUBLISHABLE.includes(kind);
export const hasCaption = (kind) => kind === 'text' || CAPTIONED.has(kind);

export function same(a, b) {
  return (a.t || '') === (b.t || '') && (a.f || '') === (b.f || '') && JSON.stringify(a.e || []) === JSON.stringify(b.e || []);
}

/* The text with a footer added, if it still fits (entities keep their offsets: the footer comes after). */
export function withFooter(kind, text, footer) {
  if (!footer || !hasCaption(kind)) return text || '';
  const next = text ? `${text}\n\n${footer}` : footer;
  return next.length <= (kind === 'text' ? TEXT_MAX : CAPTION_MAX) ? next : (text || '');
}

/* Publishes content in a chat. opts: rows (inline buttons), silent, protect, footer. Gives the Message. */
export async function publish(ctx, chatId, kind, c, opts = {}, view = 'publish') {
  if (!canPublish(kind)) throw new Error(`can't publish ${kind}`);
  const common = { chat_id: chatId };
  if (opts.rows && opts.rows.length) common.reply_markup = { inline_keyboard: opts.rows };
  if (opts.silent) common.disable_notification = true;
  if (opts.protect) common.protect_content = true;
  if (kind === 'text') {
    return call(ctx, 'sendMessage', { ...common, text: withFooter(kind, c.t, opts.footer), entities: c.e && c.e.length ? c.e : undefined }, view);
  }
  const params = { ...common, [kind]: c.f };
  if (CAPTIONED.has(kind)) {
    const caption = withFooter(kind, c.t, opts.footer);
    if (caption) params.caption = caption;
    if (c.e && c.e.length) params.caption_entities = c.e;
  }
  return call(ctx, METHOD[kind], params, view);
}

/* Puts a published message back to `c` (text, caption, or the media itself). */
export async function editTo(ctx, chatId, msgId, kind, cur, c, view = 'post-edit') {
  if (kind === 'text') {
    return call(ctx, 'editMessageText', { chat_id: chatId, message_id: msgId, text: c.t, entities: c.e && c.e.length ? c.e : undefined }, view);
  }
  if (!CAPTIONED.has(kind)) throw new Error(`can't edit ${kind}`);
  if ((cur.f || '') !== (c.f || '') && c.f) {
    const media = { type: kind, media: c.f };
    if (c.t) media.caption = c.t;
    if (c.e && c.e.length) media.caption_entities = c.e;
    return call(ctx, 'editMessageMedia', { chat_id: chatId, message_id: msgId, media }, view);
  }
  return call(ctx, 'editMessageCaption', { chat_id: chatId, message_id: msgId, caption: c.t || '', caption_entities: c.e && c.e.length ? c.e : undefined }, view);
}

/* ========== merged from engines/buttons.js ========== */
/*
 * Inline URL buttons typed by the owner for a broadcast (copy mode). One keyboard row per line;
 * buttons in a row are separated by "|"; each button is "Text - URL":
 *     Rules - https://t.me/somechannel/5 | Site - https://example.com
 *     Join - t.me/somechannel
 * A URL may be https://, http://, tg:// or t.me/… (https:// is added). Limits come from config.
 * Gives { rows } or { error, line } (error is a locale key suffix, line is 1-based).
 */
function parseUrl(raw) {
  let u = String(raw || '').trim();
  if (/^(t\.me|telegram\.me)\//i.test(u)) u = `https://${u}`;
  if (!/^(https?:\/\/[^\s/$.?#][^\s]*|tg:\/\/[^\s]+)$/i.test(u)) return null;
  if (u.length > 512) return null;
  return u;
}

export function parseButtons(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'empty', line: 0 };
  if (lines.length > BC_MAX_BUTTON_ROWS) return { error: 'too_many_rows', line: BC_MAX_BUTTON_ROWS + 1 };
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length > BC_MAX_BUTTONS_PER_ROW) return { error: 'too_many_in_row', line: i + 1 };
    const row = [];
    for (const p of parts) {
      const m = /^(.+?)\s+[-–—]\s+(\S+)$/.exec(p);
      if (!m) return { error: 'format', line: i + 1 };
      const label = m[1].trim();
      const url = parseUrl(m[2]);
      if (!label || label.length > BC_MAX_BUTTON_TEXT) return { error: 'text', line: i + 1 };
      if (!url) return { error: 'url', line: i + 1 };
      row.push({ text: label, url });
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? { rows } : { error: 'empty', line: 0 };
}

export const countButtons = (rows) => (rows || []).reduce((n, r) => n + r.length, 0);
