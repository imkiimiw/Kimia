/*
 * The owner's global switch and status (private chat, OWNER_ID only — router.js checks):
 * /status, /shutdown (asks first), /activate — also as plain words (the alias locale namespace).
 * callback_data: sy:st (status) · sy:off (shut down?) · sy:offy (shut down!) · sy:on (activate).
 */
import { OWNER_ID } from '../config.js';
import { btn, screen } from '../core/tg.js';
import { esc, nowSec, short } from '../core/util.js';
import * as system from '../engines/system.js';
import { dur, t } from '../i18n/index.js';

export async function status(ctx, lang, place = null, notice = '') {
  const s = await system.status(ctx);
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sys.status_title'), '');
  if (s.shutdown) lines.push(t(lang, 'sys.state_off', { ago: dur(lang, now - s.since) }));
  else lines.push(t(lang, s.since ? 'sys.state_on_since' : 'sys.state_on', { ago: dur(lang, now - s.since) }));
  lines.push(t(lang, 'sys.version', { version: s.version, phase: s.phase, data: s.dataVersion }));
  lines.push(t(lang, 'sys.counts', { users: s.users, groups: s.groups, channels: s.channels, registered: s.registered }));
  lines.push(s.broadcast ? t(lang, 'sys.broadcast', { id: s.broadcast.id, status: t(lang, `bc.st_${s.broadcast.status}`) }) : t(lang, 'sys.broadcast_none'));
  lines.push(t(lang, 'sys.errors', { n: s.errors24h }));
  if (s.lastError) lines.push(t(lang, 'sys.last_error', { ago: dur(lang, now - s.lastError.at), source: esc(s.lastError.source), message: esc(short(s.lastError.message, 160)) }));
  if (s.webhook) {
    lines.push(t(lang, 'sys.webhook', { pending: s.webhook.pending }));
    if (s.webhook.lastError) lines.push(t(lang, 'sys.webhook_error', { ago: dur(lang, now - s.webhook.lastErrorAt), message: esc(short(s.webhook.lastError, 160)) }));
  } else lines.push(t(lang, 'sys.webhook_unknown'));
  const rows = [[btn(t(lang, 'common.refresh'), 'sy:st')]];
  rows.push([s.shutdown ? btn(t(lang, 'sys.btn_activate'), 'sy:on') : btn(t(lang, 'sys.btn_shutdown'), 'sy:off')]);
  rows.push([btn(t(lang, 'owner.title_short'), 'op')]);
  return screen(ctx, OWNER_ID, place, lines.join('\n'), rows, 'sys-status');
}

export async function askShutdown(ctx, lang, place = null) {
  const s = await system.status(ctx);
  if (s.shutdown) return status(ctx, lang, place, t(lang, 'sys.already_off'));
  const rows = [[btn(t(lang, 'sys.btn_shutdown_yes'), 'sy:offy'), btn(t(lang, 'common.cancel'), 'sy:st')]];
  return screen(ctx, OWNER_ID, place, t(lang, 'sys.shutdown_q'), rows, 'sys-shutdown?');
}

export async function shutdown(ctx, lang, place = null) {
  const done = await system.shutdown(ctx, OWNER_ID);
  return status(ctx, lang, place, t(lang, done ? 'sys.shutdown_done' : 'sys.already_off'));
}

export async function activate(ctx, lang, place = null) {
  const done = await system.activate(ctx, OWNER_ID);
  return status(ctx, lang, place, t(lang, done ? 'sys.activate_done' : 'sys.already_on'));
}

export async function callback(ctx, lang, parts, place) {
  const action = parts[1];
  if (action === 'off') return askShutdown(ctx, lang, place);
  if (action === 'offy') return shutdown(ctx, lang, place);
  if (action === 'on') return activate(ctx, lang, place);
  return status(ctx, lang, place);
}
