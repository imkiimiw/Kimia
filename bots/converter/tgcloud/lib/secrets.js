// /secret — the owner stores bot secrets in the database (spec §2; the platform documents no secret
// store). Values are never shown, logged or put in a trace; the owner's message is deleted.
//   /secret               list names (never values)
//   /secret set NAME value
//   /secret del NAME
import { SECRET_NAMES } from './config.js';
import { deleteSecret, secretNames, setSecret } from './db/system.js';
import { t } from './i18n/index.js';
import * as tg from './tg.js';
import * as ui from './ui.js';

/** Pure: validates a secret. → null (ok) or an error key. */
export function validate(name, value) {
  if (!SECRET_NAMES.includes(name)) return 'sec.err_name';
  if (!value || value.length > 500 || /\s/.test(value)) return 'sec.err_value';
  if (name === 'WORKER_URL' && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(value)) return 'sec.err_url';
  return null;
}

export async function listScreen(ctx) {
  const rows = await secretNames();
  const set = new Map(rows.map((r) => [r.name, r.updated_at]));
  const lines = [t(ctx.lang, 'sec.head')];
  for (const n of SECRET_NAMES) lines.push(set.has(n) ? t(ctx.lang, 'sec.set', { name: n, time: ui.dateTime(ctx, set.get(n)) }) : t(ctx.lang, 'sec.unset', { name: n }));
  lines.push(t(ctx.lang, 'sec.usage'));
  return ui.plain(lines.join('\n'), [ui.backBtn(ctx, 'p')]);
}

/** Handles the command (owner only — checked by the router). */
export async function command(ctx, message, args) {
  const chatId = message.chat.id;
  const [sub, name, ...rest] = args;
  if (!sub || sub === 'list') return tg.send(ctx, 'secret_list', chatId, await listScreen(ctx));
  if (sub === 'set') {
    const value = rest.join(' ').trim();
    // the message holds the value: delete it first, whatever happens next
    const deleted = await tg.remove(ctx, 'secret_delete', chatId, message.message_id);
    const err = validate(name, value);
    if (err) return tg.send(ctx, 'secret_error', chatId, { text: t(ctx.lang, err, { names: SECRET_NAMES.join(', ') }) });
    await setSecret(name, value, ctx.user.id, ctx.now);
    return tg.send(ctx, 'secret_saved', chatId, { text: t(ctx.lang, deleted ? 'sec.saved' : 'sec.saved_delete_yourself', { name }) });
  }
  if (sub === 'del') {
    if (!SECRET_NAMES.includes(name)) return tg.send(ctx, 'secret_error', chatId, { text: t(ctx.lang, 'sec.err_name', { names: SECRET_NAMES.join(', ') }) });
    await deleteSecret(name);
    return tg.send(ctx, 'secret_deleted', chatId, { text: t(ctx.lang, 'sec.deleted', { name }) });
  }
  return tg.send(ctx, 'secret_usage', chatId, { text: t(ctx.lang, 'sec.usage') });
}
