// Admin › Broadcast (BROADCAST). Staff send any message (text, photo, video, file…) → a draft →
// start → batches (lib/broadcast.js). One broadcast runs at a time.
import { ACTIVE_KEY, progressScreen, runBatch } from '../broadcast.js';
import * as broadcasts from '../db/broadcasts.js';
import * as system from '../db/system.js';
import { t, tp } from '../i18n/index.js';
import * as ui from '../ui.js';

export async function menuScreen(user, notice = null) {
  const lang = user.lang;
  const list = await broadcasts.latest(3);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'bc.title'), '');
  if (!list.length) lines.push(t(lang, 'bc.none'));
  const kb = [];
  for (const b of list) {
    lines.push(t(lang, 'bc.progress', { id: b.id, status: tp(lang, 'bc.status.' + b.status), sent: b.sent, failed: b.failed, blocked: b.blocked }));
    if (b.status === 'running') kb.push([ui.button(tp(lang, 'bc.btn.next'), 'A:bg:' + b.id), ui.button(tp(lang, 'bc.btn.cancel'), 'A:bx:' + b.id)]);
    if (b.status === 'draft') kb.push([ui.button(tp(lang, 'bc.btn.start'), 'A:bs:' + b.id), ui.button(tp(lang, 'bc.btn.cancel'), 'A:bx:' + b.id)]);
  }
  if (!list.some((b) => b.status === 'running' || b.status === 'draft')) kb.push([ui.button(tp(lang, 'bc.btn.new'), 'A:bn')]);
  kb.push(ui.navRow(lang, 'A'));
  return { view: 'admin_broadcast', screen: { text: lines.join('\n'), reply_markup: ui.markup(kb) } };
}

export function newPrompt(user) {
  return { view: 'admin_broadcast', input: { k: 'bn' }, screen: { text: t(user.lang, 'bc.prompt'), reply_markup: ui.markup([[ui.button(tp(user.lang, 'adm.btn.cancel'), 'A:i')]]) } };
}

/** The staff member's message becomes a draft (copied later with copyMessage, so any type works). */
export async function onInput(ctx, user, msg) {
  const list = await broadcasts.latest(3);
  if (list.some((b) => b.status === 'running' || b.status === 'draft')) return { error: t(user.lang, 'bc.busy'), done: true };
  const id = await broadcasts.create(user.id, msg.chat.id, msg.message_id, ctx.now);
  await system.audit(ctx.now, user.id, 'broadcast.draft', String(id), null);
  const v = await system.counterValues([['users', ''], ['users_blocked', '']]);
  const reach = Math.max(0, (v['users|'] || 0) - (v['users_blocked|'] || 0));
  return {
    view: 'admin_broadcast',
    screen: {
      text: t(user.lang, 'bc.draft', { id, reach }),
      reply_markup: ui.markup([[ui.button(tp(user.lang, 'bc.btn.start'), 'A:bs:' + id), ui.button(tp(user.lang, 'bc.btn.cancel'), 'A:bx:' + id)]]),
    },
  };
}

/** draft → running, then the first batch at once. `message` = the panel message that shows progress. */
export async function start(ctx, user, id, message) {
  if (!(await broadcasts.start(id, message.chat.id, message.message_id, ctx.now))) return menuScreen(user);
  await system.setSetting(ACTIVE_KEY, { id }, user.id, ctx.now);
  await system.audit(ctx.now, user.id, 'broadcast.start', String(id), null);
  ctx.broadcastRan = true;
  await runBatch(ctx, id, { max: 25, budgetMs: 8000 });
  return { view: 'admin_broadcast', screen: progressScreen(user.lang, await broadcasts.get(id)) };
}

export async function nextBatch(ctx, user, id) {
  ctx.broadcastRan = true;
  const r = await runBatch(ctx, id, { max: 25, budgetMs: 8000 });
  const b = await broadcasts.get(id);
  const toast = !r.claimed ? t(user.lang, b && b.resume_at > ctx.now ? 'bc.waiting' : 'bc.busy_batch', { s: b ? Math.max(0, b.resume_at - ctx.now) : 0 }) : null;
  return { view: 'admin_broadcast', screen: progressScreen(user.lang, b), toast };
}

export async function cancel(ctx, user, id) {
  if (await broadcasts.cancel(id, ctx.now)) {
    const s = await system.loadSettings([ACTIVE_KEY]);
    if (s[ACTIVE_KEY] && s[ACTIVE_KEY].value && s[ACTIVE_KEY].value.id === id) await system.deleteSetting(ACTIVE_KEY);
    await system.audit(ctx.now, user.id, 'broadcast.cancel', String(id), null);
  }
  return menuScreen(user, t(user.lang, 'bc.cancelled'));
}
