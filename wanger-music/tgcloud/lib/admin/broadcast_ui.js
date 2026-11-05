// 📣 Broadcast (owner only): compose → preview → confirm → one progress message with
// Pause / Resume / Cancel / «▶️ ادامه». Batches are sent by the tick or by «▶️ ادامه».
import { t, tp, raw, dateTime } from '../i18n/index.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';
import { UserError } from '../core/util.js';

const PERM = 'broadcast.send';

/** @param {string} lang @param {any} b broadcasts row @param {{batch: number, cooldownLeft: number}} ctx */
export function progressView(lang, b, { batch, cooldownLeft }) {
  const left = Math.max(0, b.total - b.sent - b.failed - b.blocked);
  let note = '';
  if (b.status === 'running') note = cooldownLeft > 0 ? t(lang, 'bc.note.cooldown', { left: tp(lang, 'common.in_s', { n: cooldownLeft }) }) : t(lang, 'bc.note.running', { batch });
  const rows = [];
  if (b.status === 'running') rows.push([btn(tp(lang, 'bc.btn_continue'), 'bc', 'next', b.id), btn(tp(lang, 'bc.btn_pause'), 'bc', 'pause', b.id)]);
  if (b.status === 'paused') rows.push([btn(tp(lang, 'bc.btn_resume'), 'bc', 'resume', b.id)]);
  if (b.status === 'running' || b.status === 'paused') rows.push([btn(tp(lang, 'bc.btn_cancel'), 'bc', 'stop', b.id), btn(tp(lang, 'bc.btn_refresh'), 'bc', 'view', b.id)]);
  rows.push([btn(tp(lang, 'common.back'), 'bc', 'home')]);
  return {
    text: t(lang, 'bc.progress', { id: b.id, status: tp(lang, `bc.status.${b.status}`), sent: b.sent, blocked: b.blocked, failed: b.failed, left, total: b.total, note: note ? raw(note) : '' }),
    keyboard: markup(rows),
  };
}

async function progressCtx(app) {
  const now = app.clock.now();
  return { batch: Number(await app.settings.get('broadcast.batch_size')), cooldownLeft: Math.max(0, Number(await app.settings.get('telegram.cooldown_until')) - now) };
}

async function homeView(app) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  const [count, recent, active] = await Promise.all([app.users.countRecipients(), app.broadcasts.recent(5), app.broadcasts.active()]);
  const lines = recent.map((b) => t(lang, 'bc.recent_item', { id: b.id, status: tp(lang, `bc.status.${b.status}`), sent: b.sent, blocked: b.blocked, failed: b.failed, when: dateTime(b.started_at || b.created_at, tz, lang) }));
  const rows = [];
  if (active) rows.push([btn(tp(lang, 'bc.btn_open', { id: active.id, status: tp(lang, `bc.status.${active.status}`) }), 'bc', 'view', active.id)]);
  else rows.push([btn(tp(lang, 'bc.btn_new'), 'bc', 'new')]);
  rows.push([homeButton(lang)]);
  return { text: t(lang, 'bc.title', { count, recent: raw(lines.length ? lines.join('\n') : t(lang, 'bc.recent_empty')) }), keyboard: markup(rows) };
}

async function showProgress(app, user, cq, id) {
  const b = await app.broadcasts.get(id);
  if (!b || b.status === 'draft') {
    await screen(app, user, cq, await homeView(app), 'broadcast_home');
    return {};
  }
  await screen(app, user, cq, progressView(app.lang, b, await progressCtx(app)), 'broadcast_progress');
  return {};
}

/** Called by the broadcast service after every batch: edits the progress message; sends the final report. */
export async function notifyProgress(app, b, { done }) {
  const owner = await app.users.get(b.created_by);
  const lang = await app.users.languageOf(owner);
  if (b.progress_chat_id && b.progress_message_id) {
    await app.tg.edit(b.progress_chat_id, b.progress_message_id, progressView(lang, b, await progressCtx(app)), 'broadcast_progress');
  }
  if (done) await app.tg.send(b.created_by, { text: t(lang, 'bc.final', { id: b.id, sent: b.sent, blocked: b.blocked, failed: b.failed }) }, 'broadcast_final');
}

const budget = async (app) => app.clock.ms() + Number(await app.settings.get('tick.budget_ms'));

export const routes = [
  { ns: 'bc', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await screen(app, user, cq, await homeView(app), 'broadcast_home'); return {}; } },
  {
    ns: 'bc', action: 'new', args: [], perm: PERM,
    async run(app, user) {
      if (await app.broadcasts.active()) throw new UserError('bc.err.busy');
      await app.flows.start(user.telegram_id, 'bc_compose', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'bc.compose_prompt')), 'broadcast_prompt');
      return {};
    },
  },
  { ns: 'bc', action: 'view', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showProgress(app, user, cq, id) },
  {
    ns: 'bc', action: 'go', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const b = await app.broadcasts.start(user, id, user.telegram_id, cq.message ? cq.message.message_id : null);
      await screen(app, user, cq, progressView(app.lang, b, await progressCtx(app)), 'broadcast_progress');
      await app.broadcasts.runBatch({ id, deadlineMs: await budget(app) });
      return {};
    },
  },
  {
    ns: 'bc', action: 'drop', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      await app.broadcasts.discard(user, id);
      await screen(app, user, cq, { text: t(app.lang, 'bc.discarded'), keyboard: markup([[btn(tp(app.lang, 'common.back'), 'bc', 'home')]]) }, 'broadcast_discarded');
      return {};
    },
  },
  {
    ns: 'bc', action: 'next', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const r = await app.broadcasts.runBatch({ id, deadlineMs: await budget(app) });
      if (r.skipped) await showProgress(app, user, cq, id);
      const n = (r.sent || 0) + (r.failed || 0) + (r.blocked || 0);
      return { toast: r.skipped === 'cooldown' ? tp(app.lang, 'sys.cooldown', { left: tp(app.lang, 'common.in_s', { n: Math.max(0, r.until - app.clock.now()) }) }) : n ? tp(app.lang, 'bc.batch_done', { n }) : tp(app.lang, 'bc.batch_none') };
    },
  },
  { ns: 'bc', action: 'pause', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.broadcasts.control(user, id, 'pause'); await showProgress(app, user, cq, id); return { toast: tp(app.lang, 'bc.paused') }; } },
  { ns: 'bc', action: 'resume', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.broadcasts.control(user, id, 'resume'); await showProgress(app, user, cq, id); return { toast: tp(app.lang, 'bc.resumed') }; } },
  {
    ns: 'bc', action: 'stop', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      await screen(app, user, cq, {
        text: t(app.lang, 'bc.cancel_confirm', { id }),
        keyboard: markup([[btn(tp(app.lang, 'bc.btn_cancel_yes'), 'bc', 'stopok', id), btn(tp(app.lang, 'common.no'), 'bc', 'view', id)]]),
      }, 'broadcast_cancel_confirm');
      return {};
    },
  },
  { ns: 'bc', action: 'stopok', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.broadcasts.control(user, id, 'cancel'); await showProgress(app, user, cq, id); return { toast: tp(app.lang, 'bc.cancelled') }; } },
];

export const flows = {
  bc_compose: {
    perm: PERM,
    maxInput: 4096, // the message is copied as it is, never parsed
    async run(app, user, message) {
      const draft = await app.broadcasts.createDraft(user, message);
      await app.flows.clear(user.telegram_id);
      const count = await app.users.countRecipients();
      await app.tg.copy(user.telegram_id, message.chat.id, message.message_id, 'broadcast_preview');
      await app.tg.send(user.telegram_id, {
        text: t(app.lang, 'bc.confirm', { count }),
        keyboard: markup([[btn(tp(app.lang, 'bc.btn_send'), 'bc', 'go', draft.id), btn(tp(app.lang, 'bc.btn_discard'), 'bc', 'drop', draft.id)]]),
      }, 'broadcast_confirm');
    },
  },
};
