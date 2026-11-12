// Owner panel (brief §7): one message edited in place; every route declares a permission that the
// router checks on every press, and every action re-checks the owner here (assertOwner).
// Reviewers see only the publication queue. Sections in their own modules: channels_ui (forced
// join), broadcast_ui, publish_ui (publish channel, reviewers, queue).
import { btn, markup } from '../core/codec.js';
import { esc, code, displayName } from '../core/html.js';
import { UserError, PermissionError, parseIntInRange, dayKey, dayStart, truncate } from '../core/util.js';
import { users } from '../db/users.js';
import { packs as pdb, posts as postDb } from '../db/packs.js';
import { system } from '../db/system.js';
import { dateText } from '../i18n/index.js';
import { utf8 } from '../core/bytes.js';
import { OWNER_ID, FEATURES, SETTING_RANGES, QUOTA_FEATURES, T, APP_URL } from '../config.js';

export const assertOwner = (app) => {
  if (app.user.tg_id !== OWNER_ID) throw new PermissionError('admin');
};
const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message ? cq.message.message_id : null, view, name);
const back = (app, action = 'home', ...args) => btn(app.tp('common.back'), 'a', action, ...args);

const NUM_KEYS = Object.keys(SETTING_RANGES);
const TEXT_KEYS = ['text.start.fa', 'text.start.en', 'text.help.fa', 'text.help.en', 'maintenance.text'];
const NOTIFY_KEYS = ['notify.gate', 'notify.errors', 'notify.daily'];

export async function homeView(app) {
  if (app.role !== 'owner') {
    return { text: app.t('adm.home_reviewer'), keyboard: markup([[btn(app.tp('adm.queue'), 'a', 'q')], [btn(app.tp('common.menu'), 'm', 'home')]]) };
  }
  const maint = app.settings.get('maintenance.on');
  return {
    text: app.t('adm.home', { maint: app.tp(maint ? 'common.on' : 'common.off') }),
    keyboard: markup([
      [btn(app.tp('adm.stats'), 'a', 'st'), btn(app.tp('adm.broadcast'), 'a', 'bc')],
      [btn(app.tp('adm.channels'), 'a', 'ch'), btn(app.tp('adm.users'), 'a', 'us')],
      [btn(app.tp('adm.publish'), 'a', 'pub'), btn(app.tp('adm.queue'), 'a', 'q')],
      [btn(app.tp('adm.settings'), 'a', 'set'), btn(app.tp('adm.notify'), 'a', 'nt')],
      [btn(app.tp('adm.errors'), 'a', 'err'), btn(app.tp('adm.secrets'), 'a', 'sec')],
      [btn(app.tp('adm.backup'), 'a', 'bk'), { text: app.tp('adm.spike'), web_app: { url: `${APP_URL}?spike=1` } }],
      [btn(app.tp('common.menu'), 'm', 'home')],
    ]),
  };
}

export const openPanel = async (app, cq) => show(app, cq, await homeView(app), 'admin_home');

async function statsView(app) {
  const now = app.clock.now();
  const u = await users.stats(now, dayStart(now));
  const p = (await pdb.totals()) || {};
  const sinceDay = dayKey(now - 30 * 86400);
  const m = Object.fromEntries((await system.statsSince(sinceDay)).map((r) => [r.metric, Number(r.n) || 0]));
  const sum = (prefix) => Object.entries(m).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
  const postCounts = Object.fromEntries((await postDb.counts()).map((r) => [r.status, r.n]));
  const top = Object.entries(m).filter(([k]) => /^(pack\.|sticker\.added|op\.|pub\.requested)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v]) => `• ${esc(k)}: ${v}`).join('\n') || '—';
  return {
    text: app.t('adm.stats_text', {
      total: u.total, new_today: u.new_today, new_7: u.new_7, new_30: u.new_30,
      act_today: u.active_today, act_7: u.active_7, act_30: u.active_30,
      blocked: u.blocked, banned: u.banned, fa: u.lang_fa, en: u.lang_en, pro: u.pro,
      packs: Number(p.packs) || 0, stickers: Number(p.stickers) || 0, public: Number(p.public) || 0,
      added30: sum('sticker.added.'), created30: m['pack.created'] || 0,
      pub_pending: postCounts.pending || 0, pub_published: postCounts.published || 0, pub_rejected: postCounts.rejected || 0,
      gate_blocked: m['gate.blocked'] || 0, gate_pass: m['gate.pass'] || 0,
      top: { __html: top },
    }),
    keyboard: markup([[btn(app.tp('common.refresh'), 'a', 'st')], [back(app)]]),
  };
}

/* ---------------- users ---------------- */

async function userView(app, id) {
  const t = await users.get(id);
  if (!t) throw new UserError('adm.err.no_user');
  const usage = (await users.usageAll(id, dayKey(app.clock.now()))).map((r) => `${r.feature}: ${r.count}`).join('، ') || '—';
  const pro = t.plan === 'pro' && t.plan_until > app.clock.now();
  const packCount = await pdb.countByUser(id);
  const rows = [
    [t.banned ? btn(app.tp('adm.u_unban'), 'a', 'uunb', id) : btn(app.tp('adm.u_ban'), 'a', 'uban', id, 0), t.banned ? null : btn(app.tp('adm.u_ban_eco'), 'a', 'uban', id, 1)],
    [pro ? btn(app.tp('adm.u_unpro'), 'a', 'unopro', id) : btn(app.tp('adm.u_pro'), 'a', 'upro', id), btn(app.tp('adm.u_points'), 'a', 'upts', id)],
    [btn(app.tp('adm.u_reset_quota'), 'a', 'urq', id), btn(app.tp('adm.u_message'), 'a', 'umsg', id)],
    [btn(app.tp(t.publish_banned ? 'adm.u_pub_unban' : 'adm.u_pub_ban'), 'a', 'upub', id)],
    [btn(app.tp('adm.u_search'), 'a', 'us'), back(app)],
  ];
  return {
    text: app.t('adm.user', {
      name: displayName(t), id: { __html: code(t.tg_id) }, username: t.username ? '@' + t.username : '—',
      lang: t.lang || '—', joined: dateText(t.joined_at, app.lang), active: dateText(t.last_active_at, app.lang),
      plan: pro ? app.t('adm.u_plan_pro', { until: dateText(t.plan_until, app.lang, false) }) : app.tp('acct.plan_free'),
      points: t.points, packs: packCount, usage,
      banned: t.banned ? app.t('adm.u_banned_line', { reason: t.ban_reason || '—', scope: t.ban_scope || 'bot' }) : app.tp('common.no'),
      blocked: app.tp(t.blocked_bot ? 'common.yes' : 'common.no'),
      pubban: app.tp(t.publish_banned ? 'common.yes' : 'common.no'),
    }),
    keyboard: markup(rows),
  };
}

/* ---------------- settings ---------------- */

function settingsView(app) {
  const rows = NUM_KEYS.map((k, i) => [btn(app.tp('adm.set_item', { name: app.tp(`set.${k}`), value: String(app.settings.get(k)) }), 'a', 'setv', i)]);
  rows.push([btn(app.tp('adm.flags'), 'a', 'flags'), btn(app.tp('adm.texts'), 'a', 'texts')]);
  rows.push([btn(app.tp(app.settings.get('maintenance.on') ? 'adm.maint_off' : 'adm.maint_on'), 'a', 'maint')]);
  rows.push([btn(app.tp('adm.storage'), 'a', 'stor')]);
  rows.push([back(app)]);
  return { text: app.t('adm.settings_text', { quotas: QUOTA_FEATURES.map((f) => `${app.tp(`feature.${f}`)}: ${app.settings.get(`quota.${f}`)}`).join('، ') }), keyboard: markup(rows) };
}

function flagsView(app) {
  const rows = FEATURES.map((f, i) => [btn(`${app.flag(f) ? '✅' : '⬜\ufe0f'} ${app.tp(`flag.${f}`)}`, 'a', 'flag', i)]);
  rows.push([back(app, 'set')]);
  return { text: app.t('adm.flags_text'), keyboard: markup(rows) };
}

function textsView(app) {
  const rows = TEXT_KEYS.map((k, i) => [btn(app.tp('adm.text_item', { name: app.tp(`set.${k}`), state: app.tp(String(app.settings.get(k) || '').trim() ? 'adm.text_custom' : 'adm.text_default') }), 'a', 'text', i)]);
  rows.push([back(app, 'set')]);
  return { text: app.t('adm.texts_text'), keyboard: markup(rows) };
}

function notifyView(app) {
  const rows = NOTIFY_KEYS.map((k, i) => [btn(`${app.settings.get(k) ? '✅' : '⬜\ufe0f'} ${app.tp(`set.${k}`)}`, 'a', 'ntog', i)]);
  rows.push([back(app)]);
  return { text: app.t('adm.notify_text'), keyboard: markup(rows) };
}

/* ---------------- errors, secrets, backup ---------------- */

async function errorsView(app) {
  const groups = await system.errorGroups(T.recentErrors);
  const recent = await system.recentErrors(5);
  const g = groups.map((r) => `• <b>${esc(r.scope)}</b> ${code(r.code)} ×${r.n}`).join('\n') || app.t('adm.no_errors');
  const last = recent.map((r) => `${dateText(r.at, app.lang)} · ${esc(r.scope)} · ${esc(truncate(r.message || '', 90))}`).join('\n');
  return { text: app.t('adm.errors_text', { groups: { __html: g }, last: { __html: last || '—' } }), keyboard: markup([[btn(app.tp('adm.err_clear'), 'a', 'errclr'), btn(app.tp('common.refresh'), 'a', 'err')], [back(app)]]) };
}

async function secretsView(app) {
  const list = await system.secretNames();
  const rows = list.map((s, i) => [btn(app.tp('adm.sec_del', { key: s.key }), 'a', 'secdel', i)]);
  rows.push([btn(app.tp('adm.sec_set'), 'a', 'secset')]);
  rows.push([back(app)]);
  const lines = list.map((s) => `• ${code(s.key)} = ${'•'.repeat(Math.min(12, s.len))} (${s.len}) · ${dateText(s.updated_at, app.lang, false)}`).join('\n') || '—';
  return { text: app.t('adm.secrets_text', { list: { __html: lines } }), keyboard: markup(rows) };
}

async function backup(app) {
  const now = app.clock.now();
  const send = (name, rows) => app.tg.sendDocument(OWNER_ID, utf8(JSON.stringify({ exported_at: now, table: name, rows }, null, 1)), `wanger-stickers-${name}-${dayKey(now)}.json`, { type: 'application/json' }, 'backup');
  await send('users', await users.page(0, T.backupRows));
  await send('packs', await pdb.page(0, T.backupRows));
  await send('pack_posts', await postDb.page(0, T.backupRows));
  await send('settings', await system.allSettings());
  await app.audit(app.user.tg_id, 'backup');
}

/* ---------------- routes ---------------- */

const owner = (fn) => async (app, args, cq) => {
  assertOwner(app);
  return fn(app, args, cq);
};

export const routes = {
  'a:home': { args: [], perm: 'panel.open', run: async (app, _a, cq) => openPanel(app, cq) },
  'a:st': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await statsView(app), 'admin_stats')) },

  'a:us': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_us', {}); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_user') }, 'ask_user'); }) },
  'a:uv': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => show(app, cq, await userView(app, id), 'admin_user')) },
  'a:uban': {
    args: ['uint', 'uint'], perm: 'admin',
    run: owner(async (app, [id, eco]) => {
      if (id === OWNER_ID) throw new UserError('adm.err.self');
      await app.state.set(app.user.tg_id, 'a_uban', { id, eco });
      await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_ban_reason') }, 'ask_reason');
    }),
  },
  'a:uunb': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.account.setBan(id, false, null); await app.audit(app.user.tg_id, 'user.unban', id); await show(app, cq, await userView(app, id), 'admin_user'); }) },
  'a:upro': { args: ['uint'], perm: 'admin', run: owner(async (app, [id]) => { await app.state.set(app.user.tg_id, 'a_upro', { id }); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_pro_days') }, 'ask_days'); }) },
  'a:unopro': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await users.setPlan(id, 'free', 0); await app.audit(app.user.tg_id, 'user.pro_off', id); await show(app, cq, await userView(app, id), 'admin_user'); }) },
  'a:upts': { args: ['uint'], perm: 'admin', run: owner(async (app, [id]) => { await app.state.set(app.user.tg_id, 'a_upts', { id }); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_points') }, 'ask_points'); }) },
  'a:urq': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await users.resetUsage(id, dayKey(app.clock.now())); await app.audit(app.user.tg_id, 'user.quota_reset', id); await show(app, cq, await userView(app, id), 'admin_user'); return { toast: app.tp('adm.done') }; }) },
  'a:umsg': { args: ['uint'], perm: 'admin', run: owner(async (app, [id]) => { await app.state.set(app.user.tg_id, 'a_umsg', { id }); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_user_message') }, 'ask_message'); }) },
  'a:upub': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [id], cq) => {
      const t = await users.get(id);
      if (!t) throw new UserError('adm.err.no_user');
      await users.setPublishBanned(id, !t.publish_banned);
      await app.audit(app.user.tg_id, t.publish_banned ? 'user.publish_unban' : 'user.publish_ban', id);
      await show(app, cq, await userView(app, id), 'admin_user');
    }),
  },

  'a:set': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, settingsView(app), 'admin_settings')) },
  'a:setv': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [i]) => {
      const key = NUM_KEYS[i];
      if (!key) throw new UserError('common.expired');
      const [min, max] = SETTING_RANGES[key];
      await app.state.set(app.user.tg_id, 'a_setv', { i });
      await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_value', { name: app.tp(`set.${key}`), min, max, value: String(app.settings.get(key)) }) }, 'ask_value');
    }),
  },
  'a:flags': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, flagsView(app), 'admin_flags')) },
  'a:flag': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [i], cq) => {
      const f = FEATURES[i];
      if (!f) throw new UserError('common.expired');
      // features not built yet can't be turned on (brief §1 rule 7)
      if (!app.flag(f) && !BUILT.has(f)) throw new UserError('adm.err.not_built');
      await app.settings.set(app.user.tg_id, `flags.${f}`, !app.flag(f));
      await show(app, cq, flagsView(app), 'admin_flags');
    }),
  },
  'a:texts': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, textsView(app), 'admin_texts')) },
  'a:text': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [i]) => {
      const key = TEXT_KEYS[i];
      if (!key) throw new UserError('common.expired');
      await app.state.set(app.user.tg_id, 'a_text', { i });
      await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_text', { name: app.tp(`set.${key}`) }) }, 'ask_text');
    }),
  },
  'a:maint': {
    args: [], perm: 'admin',
    run: owner(async (app, _a, cq) => {
      await app.settings.set(app.user.tg_id, 'maintenance.on', !app.settings.get('maintenance.on'));
      await show(app, cq, settingsView(app), 'admin_settings');
      return { toast: app.tp(app.settings.get('maintenance.on') ? 'adm.maint_is_on' : 'adm.maint_is_off'), alert: true };
    }),
  },
  'a:stor': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_storage', {}); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_storage', { value: String(app.settings.get('storage.chat_id') || '—') }) }, 'ask_storage'); }) },

  'a:nt': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, notifyView(app), 'admin_notify')) },
  'a:ntog': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [i], cq) => {
      const k = NOTIFY_KEYS[i];
      if (!k) throw new UserError('common.expired');
      await app.settings.set(app.user.tg_id, k, !app.settings.get(k));
      await show(app, cq, notifyView(app), 'admin_notify');
    }),
  },

  'a:err': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await errorsView(app), 'admin_errors')) },
  'a:errclr': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => { await system.clearErrors(); await app.audit(app.user.tg_id, 'errors.clear'); await show(app, cq, await errorsView(app), 'admin_errors'); }) },

  'a:sec': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await secretsView(app), 'admin_secrets')) },
  'a:secset': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_secset', {}); await app.tg.send(app.user.tg_id, { text: app.t('adm.ask_secret') }, 'ask_secret'); }) },
  'a:secdel': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [i], cq) => {
      const s = (await system.secretNames())[i];
      if (!s) throw new UserError('common.expired');
      await system.deleteSecret(s.key);
      await app.audit(app.user.tg_id, 'secret.delete', s.key);
      await show(app, cq, await secretsView(app), 'admin_secrets');
    }),
  },

  'a:bk': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, { text: app.t('adm.backup_text'), keyboard: markup([[btn(app.tp('adm.backup_go'), 'a', 'bkgo')], [back(app)]]) }, 'admin_backup')) },
  'a:bkgo': { args: [], perm: 'admin', run: owner(async (app) => { await backup(app); return { toast: app.tp('adm.backup_sent') }; }) },
};

/** Features whose code exists (a flag can be turned on). */
const BUILT = new Set(['packs', 'pack_import', 'pack_publish', 'studio']);

/** Owner text steps of this module. @returns {Promise<string|null>} */
export async function onAdminStep(app, step, payload, message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const me = app.user.tg_id;
  const done = async (view) => {
    await app.state.clear(me);
    await app.tg.send(me, view, step);
    return step;
  };
  switch (step) {
    case 'a_us': {
      assertOwner(app);
      const fo = message.forward_origin;
      let target = null;
      if (fo && fo.type === 'user' && fo.sender_user) target = await users.get(fo.sender_user.id);
      else if (/^\d{4,15}$/.test(text)) target = await users.get(Number(text));
      else if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) target = await users.getByUsername(text.replace(/^@/, ''));
      if (!target) throw new UserError('adm.err.no_user');
      return done(await userView(app, target.tg_id));
    }
    case 'a_uban': {
      assertOwner(app);
      if (payload.id === OWNER_ID) throw new UserError('adm.err.self');
      await app.account.setBan(payload.id, true, text.slice(0, 200) || '—', payload.eco ? 'ecosystem' : 'bot');
      await app.audit(me, 'user.ban', payload.id, payload.eco ? 'ecosystem' : 'bot');
      return done(await userView(app, payload.id));
    }
    case 'a_upro': {
      assertOwner(app);
      const days = parseIntInRange(text, 1, 3650);
      if (days === null) throw new UserError('adm.err.number', { min: 1, max: 3650 });
      await users.setPlan(payload.id, 'pro', app.clock.now() + days * 86400);
      await app.audit(me, 'user.pro', payload.id, String(days));
      return done(await userView(app, payload.id));
    }
    case 'a_upts': {
      assertOwner(app);
      const delta = parseIntInRange(text, -1000000, 1000000);
      if (delta === null || delta === 0) throw new UserError('adm.err.number', { min: -1000000, max: 1000000 });
      await app.account.addPoints(payload.id, delta, 'admin', null);
      await app.audit(me, 'user.points', payload.id, String(delta));
      return done(await userView(app, payload.id));
    }
    case 'a_umsg': {
      assertOwner(app);
      try {
        await app.tg.copy(payload.id, message.chat.id, message.message_id, 'admin_message');
      } catch {
        throw new UserError('adm.err.unreachable');
      }
      await app.audit(me, 'user.message', payload.id);
      return done({ text: app.t('adm.message_sent') });
    }
    case 'a_setv': {
      assertOwner(app);
      const key = NUM_KEYS[payload.i];
      const [min, max] = SETTING_RANGES[key];
      const v = parseIntInRange(text, min, max);
      if (v === null) throw new UserError('adm.err.number', { min, max });
      await app.settings.set(me, key, v);
      if (key === 'gate.cache_sec') await app.gate.invalidate();
      return done(settingsView(app));
    }
    case 'a_text': {
      assertOwner(app);
      const key = TEXT_KEYS[payload.i];
      if (text.length > 3000) throw new UserError('adm.err.too_long', { max: 3000 });
      await app.settings.set(me, key, text === '-' ? '' : text);
      return done(textsView(app));
    }
    case 'a_storage': {
      assertOwner(app);
      if (text === '-') {
        await app.settings.set(me, 'storage.chat_id', 0);
        return done(settingsView(app));
      }
      const info = await app.tg.inspectChannel(/^-?\d+$/.test(text) ? Number(text) : text);
      if (!info.ok || !info.isAdmin || !info.canPost) throw new UserError('adm.err.storage');
      await app.settings.set(me, 'storage.chat_id', info.chat.id);
      return done(settingsView(app));
    }
    case 'a_secset': {
      assertOwner(app);
      const m = /^([A-Z][A-Z0-9_]{1,40})\s+(\S[\s\S]{0,2000})$/.exec(text);
      // the owner's message holds the key: delete it right away (brief §7)
      await app.tg.remove(me, message.message_id);
      if (!m) throw new UserError('adm.err.secret');
      await system.setSecret(m[1], m[2].trim(), app.clock.now());
      await app.audit(me, 'secret.set', m[1]);
      return done(await secretsView(app));
    }
    default:
      return null;
  }
}

export const ADMIN_STEPS = Object.freeze(['a_us', 'a_uban', 'a_upro', 'a_upts', 'a_umsg', 'a_setv', 'a_text', 'a_storage', 'a_secset']);
