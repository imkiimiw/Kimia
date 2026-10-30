/*
 * A post's content, independent of the message that carried it: { t: text or caption, e: its
 * entities, f: the file_id } and a kind (text, photo, video, animation, document, audio, voice,
 * video_note, sticker; anything else is "other" and can only be archived, not published again).
 * Used for the post archive and its versions, posts held for approval, scheduled posts and
 * cross-posting: they are published again by file_id, so no source message has to survive.
 */
import { call } from './tg.js';

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
