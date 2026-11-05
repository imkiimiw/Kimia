// 🧪 System Status (owner only): live data from core/health.js and «▶️ اجرای تیک».
import { t, tp, raw, ago, digits } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton } from './panel.js';
import { healthReport } from '../core/health.js';
import { runTick } from '../jobs/tick.js';
import { truncate } from '../core/util.js';

const PERM = 'system.view';
const ICON = { ok: '🟢', bot_not_admin: '🔴', not_found: '⚫️', error: '🟠' };

/** @param {string} lang @param {any} h a healthReport() */
export function statusView(lang, h) {
  const lines = [t(lang, 'sys.title'), ''];
  const built = h.version.built_at ? new Date(h.version.built_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
  lines.push(t(lang, 'sys.version', { version: h.version.version, commit: h.version.commit, built }));
  lines.push(h.me ? t(lang, 'sys.bot', { username: h.me.username, id: String(h.me.id) }) : t(lang, 'sys.bot_error'));
  if (h.webhook.info) {
    const w = h.webhook.info;
    const error = w.last_error_message ? raw(t(lang, 'sys.webhook_error', { error: w.last_error_message, ago: ago(h.now - (w.last_error_date || h.now), lang) })) : '';
    lines.push(t(lang, 'sys.webhook', { pending: w.pending_update_count || 0, error }));
  } else lines.push(t(lang, 'sys.webhook_restricted'));
  lines.push(t(lang, 'sys.db', { ms: h.dbMs }));
  lines.push(t(lang, 'sys.counts', {
    users: h.stats.total, blocked: h.stats.blocked,
    tracks: `${digits(h.tracks.total, lang)} (✅ ${digits(h.tracks.active, lang)})`, pending: digits(h.publications.queued + h.publications.pending, lang), failed: digits(h.publications.failed + h.publications.uncertain, lang),
  }));
  lines.push(t(lang, 'sys.search', { terms: h.search.terms, state: tp(lang, h.search.cursor >= 0 ? 'sys.search_rebuilding' : 'sys.search_ready') }));
  const tick = h.tickLast;
  lines.push(tick && tick.at ? t(lang, 'sys.tick', { ago: ago(h.now - tick.at, lang), trigger: tp(lang, `sys.trigger.${tick.trigger}`), ms: tick.ms }) : t(lang, 'sys.tick_never'));
  if (h.cooldownUntil > h.now) lines.push(t(lang, 'sys.cooldown', { left: tp(lang, 'common.in_s', { n: h.cooldownUntil - h.now }) }));
  lines.push(h.channels.length
    ? t(lang, 'sys.fj', { list: raw(h.channels.map((c) => `${c.enabled ? ICON[c.last_check_status] || '🟠' : '⏸'} ${esc(c.title || c.username || c.chat_id)}`).join(' · ')) })
    : t(lang, 'sys.fj_none'));
  lines.push(h.destinations.length
    ? t(lang, 'sys.dest_list', { list: raw(h.destinations.map((d) => `${d.enabled ? '✅' : '⏸'}${d.bot_rights_ok ? '🟢' : '🔴'} ${esc(d.title || d.username || d.chat_id)}`).join(' · ')) })
    : t(lang, 'sys.dest_none'));
  lines.push('');
  if (h.errors.length) {
    lines.push(t(lang, 'sys.errors'));
    for (const e of h.errors) lines.push(`• ${esc(ago(h.now - e.created_at, lang))} · <code>${esc(e.handler)}</code> · ${esc(e.code)}: ${esc(truncate(e.message, 90))}`);
  } else lines.push(t(lang, 'sys.no_errors'));
  return {
    text: truncate(lines.join('\n'), 4000),
    keyboard: markup([[btn(tp(lang, 'sys.btn_tick'), 'sys', 'tick'), btn(tp(lang, 'sys.btn_refresh'), 'sys', 'home')], [homeButton(lang)]]),
  };
}

const show = async (app, user, cq) => screen(app, user, cq, statusView(app.lang, await healthReport(app)), 'system_status');

export const routes = [
  { ns: 'sys', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await show(app, user, cq); return {}; } },
  {
    ns: 'sys', action: 'tick', args: [], perm: PERM,
    async run(app, user, _a, cq) {
      const summary = await runTick(app, 'manual', Number(await app.settings.get('tick.budget_ms')));
      await show(app, user, cq);
      return { toast: tp(app.lang, 'sys.tick_done', { ms: summary.ms }) };
    },
  },
];
