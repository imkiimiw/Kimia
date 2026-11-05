// 📊 Statistics (perm stats.view: the owner and admins). Period numbers come from stats_daily
// (refreshed on open), live numbers straight from the tables; see lib/stats/service.js.
import { t, tp, raw, digits, ago } from '../i18n/index.js';
import { esc } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton } from './panel.js';
import { PERIODS } from '../stats/service.js';
import { toJalali, truncate } from '../core/util.js';

const PERM = 'stats.view';
const MAX_ROWS = 10;

/** 1234567 → ۱٬۲۳۴٬۵۶۷ / 1,234,567 (a string: t() won't touch it again). */
export const num = (n, lang) => digits(String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'en' ? ',' : '٬'), lang);
/** Rounded percentage, or a dash when there is nothing to divide by. */
export const pct = (part, whole, lang) => (whole > 0 ? `${num(Math.round((100 * part) / whole), lang)}${lang === 'en' ? '%' : '٪'}` : '—');
/** 'YYYY-MM-DD' → Jalali for Persian. */
export function dateLabel(date, lang) {
  if (lang === 'en') return date;
  const [y, m, d] = date.split('-').map(Number);
  const [jy, jm, jd] = toJalali(y, m, d);
  return digits(`${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`, 'fa');
}
const name = (x) => esc(truncate(x.title || (x.username ? `@${x.username}` : String(x.id)), 40));
const trackLine = (lang, i, tr) => `${num(i + 1, lang)}. ${esc(truncate(tr.title || tp(lang, 'trk.untitled'), 48))} — ${esc(truncate(tr.artist || '?', 32))} · ▶️ ${num(tr.plays, lang)}${tr.status === 'active' ? '' : ' ⏸'}`;

const periodRow = (lang, current, action) => PERIODS.map((d) => btn(`${d === current ? '• ' : ''}${tp(lang, `sts.period.${d}`)}`, 'sts', action, d));

/** @param {string} lang @param {any} d stats.dashboard() */
export function dashboardView(lang, d) {
  const n = (v) => num(v, lang);
  const L = [t(lang, 'sts.title', { period: tp(lang, `sts.period_long.${d.days}`) })];
  L.push(t(lang, 'sts.range', { from: dateLabel(d.from, lang), to: dateLabel(d.to, lang), tz: d.tz }), '');
  L.push(t(lang, 'sts.users', { total: n(d.users.total), new: n(d.users.new), active: n(d.users.active), today: n(d.users.activeToday), blocked: n(d.users.blocked) }));
  L.push(t(lang, 'sts.search', { inline: n(d.search.inline), inline_empty: n(d.search.inlineEmpty), private: n(d.search.private), private_empty: n(d.search.privateEmpty) }));
  L.push(t(lang, 'sts.plays', { inline: n(d.plays.inline), private: n(d.plays.private), total: n(d.plays.inline + d.plays.private) }));
  L.push(t(lang, 'sts.fj', { gated: n(d.fj.gated), converted: n(d.fj.converted), rate: pct(d.fj.converted, d.fj.gated, lang) }));
  L.push(t(lang, 'sts.tracks', { active: n(d.tracks.active), activated: n(d.tracks.activated) }));
  L.push('', t(lang, 'sts.top_title'));
  if (d.top.length) d.top.slice(0, 5).forEach((tr, i) => L.push(trackLine(lang, i, tr)));
  else L.push(t(lang, 'sts.top_none'));
  L.push('', t(lang, 'sts.pub_title'));
  if (d.channels.length) {
    for (const c of d.channels.slice(0, MAX_ROWS)) {
      L.push(t(lang, 'sts.pub_line', { state: c.enabled ? (c.auto ? '✅' : '⏸') : '⛔️', name: raw(name(c)), published: n(c.published), all: n(c.publishedAll), waiting: n(c.waiting), queued: n(c.queued), failed: n(c.failed), uncertain: n(c.uncertain) }));
    }
    if (d.channels.length > MAX_ROWS) L.push(t(lang, 'sts.more', { n: n(d.channels.length - MAX_ROWS) }));
  } else L.push(t(lang, 'sts.pub_none'));
  L.push('', t(lang, 'sts.src_title'));
  if (d.sources.length) {
    const sorted = [...d.sources].sort((a, b) => b.posts - a.posts || b.importedAll - a.importedAll);
    for (const s of sorted.slice(0, MAX_ROWS)) {
      L.push(t(lang, 'sts.src_line', { state: s.enabled && s.mode !== 'off' ? '✅' : '⏸', name: raw(name(s)), posts: n(s.posts), imported: n(s.imported), duplicates: n(s.duplicates), all: n(s.importedAll), last: raw(s.lastPostAt ? ago(d.now - s.lastPostAt, lang) : t(lang, 'common.never')) }));
    }
    if (sorted.length > MAX_ROWS) L.push(t(lang, 'sts.more', { n: n(sorted.length - MAX_ROWS) }));
  } else L.push(t(lang, 'sts.src_none'));
  L.push('', t(lang, 'sts.note'));
  return {
    text: L.join('\n'),
    keyboard: markup([
      periodRow(lang, d.days, 'home'),
      [btn(tp(lang, 'sts.btn_daily'), 'sts', 'days'), btn(tp(lang, 'sts.btn_top'), 'sts', 'top', d.days)],
      [btn(tp(lang, 'sts.btn_refresh'), 'sts', 'home', d.days), homeButton(lang)],
    ]),
  };
}

/** @param {string} lang @param {any[]} days stats.daily() */
export function dailyView(lang, days) {
  const n = (v) => num(v || 0, lang);
  const L = [t(lang, 'sts.daily_title', { n: days.length }), t(lang, 'sts.daily_head'), ''];
  for (const d of days) {
    L.push(t(lang, 'sts.daily_line', {
      date: dateLabel(d.date, lang), total: n(d['users.total']), new: n(d['users.new']), active: n(d['users.active']),
      search: n((d['search.inline'] || 0) + (d['search.private'] || 0)), plays: n((d['play.inline'] || 0) + (d['play.private'] || 0)), published: n(d['pub.published']),
    }));
  }
  return { text: L.join('\n'), keyboard: markup([[btn(tp(lang, 'common.back'), 'sts', 'home', 7), homeButton(lang)]]) };
}

/** @param {string} lang @param {{days: number, period: any[], allTime: any[]}} top stats.top() */
export function topView(lang, top) {
  const L = [t(lang, 'sts.top_period', { period: tp(lang, `sts.period_long.${top.days}`) })];
  if (top.period.length) top.period.forEach((tr, i) => L.push(trackLine(lang, i, tr)));
  else L.push(t(lang, 'sts.top_none'));
  L.push('', t(lang, 'sts.top_all'));
  if (top.allTime.length) top.allTime.forEach((tr, i) => L.push(trackLine(lang, i, tr)));
  else L.push(t(lang, 'sts.top_none'));
  return { text: L.join('\n'), keyboard: markup([periodRow(lang, top.days, 'top'), [btn(tp(lang, 'common.back'), 'sts', 'home', top.days), homeButton(lang)]]) };
}

const period = (v) => (PERIODS.includes(Number(v)) ? Number(v) : 7);

export const routes = [
  {
    ns: 'sts', action: 'home', args: ['uint'], perm: PERM,
    async run(app, user, [days], cq) {
      await screen(app, user, cq, dashboardView(app.lang, await app.stats.dashboard(period(days))), 'stats');
      return {};
    },
  },
  {
    ns: 'sts', action: 'days', args: [], perm: PERM,
    async run(app, user, _a, cq) {
      await screen(app, user, cq, dailyView(app.lang, await app.stats.daily(14)), 'stats_daily');
      return {};
    },
  },
  {
    ns: 'sts', action: 'top', args: ['uint'], perm: PERM,
    async run(app, user, [days], cq) {
      await screen(app, user, cq, topView(app.lang, await app.stats.top(period(days))), 'stats_top');
      return {};
    },
  },
];
