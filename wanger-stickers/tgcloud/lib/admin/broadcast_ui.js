// Owner panel → broadcast (brief §7): the owner sends or forwards any message → preview →
// audience → mode (copy / forward) → confirm → live progress with pause / resume / cancel and
// «ادامه» (sends the next slice now); slices also go out piggybacked on other updates.
import { btn, markup } from '../core/codec.js';
import { UserError } from '../core/util.js';
import { assertOwner } from './panel.js';
import { AUDIENCES, MODES } from '../wanger/broadcast.js';
import { T, OWNER_ID } from '../config.js';
import { t, tp, normLang } from '../i18n/index.js';
import { users } from '../db/users.js';

const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message ? cq.message.message_id : null, view, name);

async function homeView(app) {
  const active = await app.broadcast.active();
  const recent = await app.broadcast.recent(3);
  const lines = recent.map((b) => app.t('bc.recent_line', { id: b.id, status: app.tp(`bc.status.${b.status}`), sent: b.sent, total: b.total })).join('\n') || '—';
  const rows = [];
  if (active) rows.push([btn(app.tp('bc.btn_open_active'), 'a', 'bcv', active.id)]);
  else rows.push([btn(app.tp('bc.btn_new'), 'a', 'bcnew')]);
  rows.push([btn(app.tp('common.back'), 'a', 'home')]);
  return { text: app.t('bc.home', { lines: { __html: lines } }), keyboard: markup(rows) };
}

async function draftView(app, b) {
  const n = await app.broadcast.countRecipients(b.audience);
  const aud = AUDIENCES.map((a) => btn(`${a === b.audience ? '● ' : ''}${app.tp(`bc.aud.${a}`)}`, 'a', 'bcaud', b.id, AUDIENCES.indexOf(a)));
  const mode = MODES.map((m) => btn(`${m === b.mode ? '● ' : ''}${app.tp(`bc.mode.${m}`)}`, 'a', 'bcmode', b.id, MODES.indexOf(m)));
  return {
    text: app.t('bc.draft', { n, audience: app.tp(`bc.aud.${b.audience}`), mode: app.tp(`bc.mode.${b.mode}`) }),
    keyboard: markup([aud.slice(0, 3), aud.slice(3), mode, [btn(app.tp('bc.btn_start', { n }), 'a', 'bcgo', b.id)], [btn(app.tp('bc.btn_discard'), 'a', 'bcdel', b.id)]]),
  };
}

/** Progress view (also used when a piggybacked slice edits the owner's progress message). */
export function progressView(lang, b) {
  const done = b.status === 'done' || b.status === 'cancelled';
  const rows = [];
  if (b.status === 'running') rows.push([btn(tp(lang, 'bc.btn_next'), 'a', 'bcnext', b.id), btn(tp(lang, 'bc.btn_pause'), 'a', 'bcpause', b.id)]);
  if (b.status === 'paused') rows.push([btn(tp(lang, 'bc.btn_resume'), 'a', 'bcres', b.id)]);
  if (!done) rows.push([btn(tp(lang, 'bc.btn_cancel'), 'a', 'bccan', b.id)]);
  rows.push([btn(tp(lang, 'common.back'), 'a', 'bc')]);
  return {
    text: t(lang, done ? 'bc.report' : 'bc.progress', { id: b.id, status: tp(lang, `bc.status.${b.status}`), sent: b.sent, failed: b.failed, blocked: b.blocked, uncertain: b.uncertain || 0, total: b.total, left: Math.max(0, b.total - b.sent - b.failed - b.blocked - (b.uncertain || 0)) }),
    keyboard: markup(rows),
  };
}

/** Hook for the engine: edits the owner's progress message after each slice. */
export async function notifyBroadcast(app, b) {
  if (!b.progress_chat_id || !b.progress_message_id) return;
  const owner = await users.get(OWNER_ID);
  await app.tg.edit(b.progress_chat_id, b.progress_message_id, progressView(normLang(owner && owner.lang), b), 'broadcast_progress');
}

const owner = (fn) => async (app, args, cq) => {
  assertOwner(app);
  return fn(app, args, cq);
};

async function mustGet(app, id) {
  const b = await app.broadcast.get(id);
  if (!b) throw new UserError('bc.err.state');
  return b;
}

export const routes = {
  'a:bc': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await homeView(app), 'broadcast_home')) },
  'a:bcnew': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_bc', {}); await app.tg.send(app.user.tg_id, { text: app.t('bc.ask_message') }, 'ask_broadcast'); }) },
  'a:bcv': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { const b = await mustGet(app, id); await show(app, cq, b.status === 'draft' ? await draftView(app, b) : progressView(app.lang, b), 'broadcast'); }) },
  'a:bcaud': {
    args: ['uint', 'uint'], perm: 'admin',
    run: owner(async (app, [id, i], cq) => {
      const b = await mustGet(app, id);
      const row = await app.broadcast.setOptions(app.user.tg_id, id, b.mode, AUDIENCES[i] || 'all');
      await show(app, cq, await draftView(app, row), 'broadcast_draft');
    }),
  },
  'a:bcmode': {
    args: ['uint', 'uint'], perm: 'admin',
    run: owner(async (app, [id, i], cq) => {
      const b = await mustGet(app, id);
      const row = await app.broadcast.setOptions(app.user.tg_id, id, MODES[i] || 'copy', b.audience);
      await show(app, cq, await draftView(app, row), 'broadcast_draft');
    }),
  },
  'a:bcgo': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [id], cq) => {
      const msgId = cq && cq.message ? cq.message.message_id : null;
      let b = await app.broadcast.start(app.user.tg_id, id, app.user.tg_id, msgId);
      await show(app, cq, progressView(app.lang, b), 'broadcast_progress');
      await app.broadcast.runBatch({ deadlineMs: app.clock.ms() + T.buttonBudgetMs, id: b.id });
      b = await mustGet(app, id);
      return { toast: app.tp('bc.started') };
    }),
  },
  'a:bcnext': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [id], cq) => {
      const r = await app.broadcast.runBatch({ deadlineMs: app.clock.ms() + T.buttonBudgetMs, id });
      if (r.skipped === 'cooldown') return { toast: app.tp('bc.cooldown'), alert: true };
      if (r.skipped === 'locked') return { toast: app.tp('bc.locked') };
      await show(app, cq, progressView(app.lang, await mustGet(app, id)), 'broadcast_progress');
      return { toast: app.tp('bc.slice_sent', { n: (r.sent || 0) + (r.failed || 0) + (r.blocked || 0) }) };
    }),
  },
  'a:bcpause': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => show(app, cq, progressView(app.lang, await app.broadcast.control(app.user.tg_id, id, 'pause')), 'broadcast_progress')) },
  'a:bcres': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => show(app, cq, progressView(app.lang, await app.broadcast.control(app.user.tg_id, id, 'resume')), 'broadcast_progress')) },
  'a:bccan': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => show(app, cq, progressView(app.lang, await app.broadcast.control(app.user.tg_id, id, 'cancel')), 'broadcast_progress')) },
  'a:bcdel': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.broadcast.discard(app.user.tg_id, id); await show(app, cq, await homeView(app), 'broadcast_home'); }) },
};

/** a_bc step: the owner sent the message to broadcast → a draft with its preview. */
export async function onBroadcastStep(app, step, payload, message) {
  if (step !== 'a_bc') return null;
  assertOwner(app);
  const b = await app.broadcast.createDraft(app.user.tg_id, message);
  await app.state.clear(app.user.tg_id);
  await app.tg.send(app.user.tg_id, { text: app.t('bc.preview_above') }, 'broadcast_preview_note');
  await app.tg.copy(app.user.tg_id, message.chat.id, message.message_id, 'broadcast_preview');
  await app.tg.send(app.user.tg_id, await draftView(app, b), 'broadcast_draft');
  return step;
}
