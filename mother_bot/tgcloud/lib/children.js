// The mother speaking AS a child bot: Bot API calls with the child's token (owner-entered, kept only in
// bots.token, never shown again, never in a trace or a log). Used for health checks (getMe,
// getWebhookInfo), broadcasts through the child, warnings and the forced-join admin check.
// Without a token a bot still has its catalog page, help, status and reports; just none of this.
import { fetch, FormData, InputFile, api } from 'sdk';
import { CHILD_FILE_MAX, TG_API } from './config.js';

export class ChildApiError extends Error {
  constructor(code, description, parameters) {
    super(description);
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

/** "123456:…wxyz" — what the panel shows instead of a token. */
export function maskToken(token) {
  if (!token) return '—';
  const [id, secret] = String(token).split(':');
  return `${id}:…${String(secret || '').slice(-4)}`;
}

/**
 * Calls a Bot API method with a child's token. Resolves to the unwrapped result; throws ChildApiError
 * (code/description/parameters, like BotApiError). A network failure is code 0.
 * `ctx` (optional) gets a trace entry with the method and the bot key only.
 */
export async function childCall(bot, method, params = {}, ctx = null, view = null) {
  if (!bot || !bot.token) throw new ChildApiError(0, 'no token');
  const entry = { m: `child:${bot.key}:${method}` };
  if (view) entry.view = view;
  if (params.chat_id !== undefined) entry.chat = params.chat_id;
  if (ctx) ctx.trace.push(entry);
  const hasFile = Object.values(params).some((v) => v instanceof InputFile);
  let body;
  if (hasFile) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (v instanceof InputFile) body.append(k, v);
      else body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  } else {
    body = fetch.body.json(params);
  }
  let data;
  try {
    const res = await fetch(`${TG_API}/bot${bot.token}/${method}`, { method: 'POST', body });
    data = await res.json();
  } catch (err) {
    entry.ok = false;
    entry.err = 'network';
    throw new ChildApiError(0, `network: ${String((err && err.message) || err).replace(bot.token, '<token>').slice(0, 120)}`);
  }
  if (!data || !data.ok) {
    entry.ok = false;
    entry.err = `${data && data.error_code} ${data && data.description}`;
    throw new ChildApiError(Number((data && data.error_code) || 0), String((data && data.description) || 'error'), data && data.parameters);
  }
  entry.ok = true;
  return data.result;
}

/** Checks a token: { ok, me } or { ok: false, why }. */
export async function checkToken(token) {
  try {
    const me = await childCall({ key: 'check', token }, 'getMe');
    if (!me || !me.is_bot) return { ok: false, why: 'not a bot' };
    return { ok: true, me };
  } catch (err) {
    return { ok: false, why: err.code === 401 || err.code === 404 ? 'rejected' : 'unreachable' };
  }
}

// Bot API method and file field for each media kind the mother can re-send.
export const MEDIA = {
  photo: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  animation: ['sendAnimation', 'animation'],
  document: ['sendDocument', 'document'],
  audio: ['sendAudio', 'audio'],
  voice: ['sendVoice', 'voice'],
};

/**
 * Sends a stored broadcast content through a child bot. `content` is lib/broadcast.js's
 * { kind: 'text'|<media>, text, entities, fileId, fileName, mime, size, childFiles }.
 * A file_id belongs to one bot, so the first send through a child uploads the bytes (downloaded by
 * the mother) and remembers the child's own file_id in content.childFiles[bot.key].
 * Returns { changed } — true when content.childFiles got a new entry (the caller saves it).
 */
export async function childSendContent(bot, chatId, content, ctx = null) {
  if (content.kind === 'text') {
    await childCall(bot, 'sendMessage', {
      chat_id: chatId, text: content.text, entities: content.entities || undefined, link_preview_options: { is_disabled: true },
    }, ctx, 'child_broadcast');
    return { changed: false };
  }
  const [method, field] = MEDIA[content.kind] || MEDIA.document;
  const params = { chat_id: chatId };
  if (content.text) {
    params.caption = content.text;
    if (content.entities) params.caption_entities = content.entities;
  }
  const known = content.childFiles && content.childFiles[bot.key];
  if (known) {
    params[field] = known;
    await childCall(bot, method, params, ctx, 'child_broadcast');
    return { changed: false };
  }
  if (Number(content.size || 0) > CHILD_FILE_MAX) throw new ChildApiError(0, 'file too big to re-upload');
  const bytes = await api.getFileContent(content.fileId);
  params[field] = new InputFile(bytes, content.fileName || `${content.kind}.bin`, content.mime ? { type: content.mime } : {});
  const msg = await childCall(bot, method, params, ctx, 'child_broadcast');
  const media = msg && (msg[content.kind === 'photo' ? 'photo' : content.kind]);
  const fileId = Array.isArray(media) ? media[media.length - 1].file_id : media && media.file_id;
  if (!fileId) return { changed: false };
  content.childFiles = { ...(content.childFiles || {}), [bot.key]: fileId };
  return { changed: true };
}
