/*
 * The panel's 🔰 Security section: the eight modules and their settings, emergency lock,
 * read-only mode and the risk alerts with the weights learned from the admins' feedback.
 * Viewing needs View; changing a module needs Settings (a punishment stronger than a warning
 * also needs Telegram's "ban users"); the emergency lock and read-only mode need "ban users"
 * (or being the creator) — the same as /lockdown and /readonly in the group — and ask first.
 *
 * callback_data (chat id c, module m, field f):
 *   g:c:S                  modules and the chat's state     g:c:S:m:m        one module
 *   g:c:S:m:m:f            change field f (cycles through the allowed values)
 *   g:c:S:e | g:c:S:r      emergency lock / read-only        …:o:i → …:y:i    start for preset i (asks first)
 *   …:off                  end it now
 *   g:c:S:k                recent risk alerts and learned weights   g:c:S:k:wr   forget the learned weights
 */
import { LOCK_DURATIONS } from '../config.js';
import { RISK_LEVELS, WEIGHTS } from '../core/signals.js';
import { answer, btn, screen } from '../core/tg.js';
import { iso, nowSec, parseJson } from '../core/util.js';
import * as admins from '../engines/admins.js';
import * as guards from '../engines/guards.js';
import * as users from '../engines/users.js';
import { dur, num, t } from '../i18n/index.js';
import { rightsProblem } from './enforce.js';
import { back, needLevel, pairs } from './guard.js';
import { announceLock, lockChat, unlockChat } from './security.js';

const { L } = admins;
const PRESETS = [600, 3600, 6 * 3600, 0];
const title = (g) => iso(g.chat.title || '', 48);
const onOff = (lang, on) => t(lang, on ? 'common.on' : 'common.off');
const canRestrict = (g) => g.acc.level === L.creator || (!!g.acc.member && g.acc.member.can_restrict_members === true);
const SECONDS = new Set(['d', 'dur', 'to', 'win', 't']);
const BITS = new Set(['on', 'del', 'btn', 'xg', 'jr', 'inv', 'homo', 'dec', 'file', 'dupm', 'qr', 'pdf']);

/* A field's value as text. */
function show(lang, code, field, v) {
  if (BITS.has(field)) return onOff(lang, v);
  if (field === 'a') return t(lang, `locks.a_${v}`);
  if (field === 'd') return v ? dur(lang, v) : t(lang, 'pun.forever');
  if (SECONDS.has(field)) return dur(lang, v);
  if (field === 'dup') return v ? num(lang, v) : t(lang, 'common.off');
  if (field === 'n') return num(lang, v);
  if (field === 'lv') return t(lang, 'sec.lv_value', { level: t(lang, `locks.sens_${v}`), alert: RISK_LEVELS[v][0], act: RISK_LEVELS[v][1] });
  return t(lang, `sec.v_${field}_${v}`);
}

const fieldsOf = (code) => Object.keys(guards.MODULES[code]).filter((f) => f !== 'w' && f !== 'on');

async function home(ctx, user, g, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cfg = await guards.all(ctx, c);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sec.home_title', { title: title(g) }), t(lang, 'sec.home_intro'), '');
  for (const code of guards.CODES) lines.push(t(lang, 'sec.home_line', { mark: cfg[code].on ? '🟢' : '⚪️', name: t(lang, `sec.m_${code}`) }));
  const active = await guards.lockdowns(c);
  for (const ld of active) {
    lines.push('', t(lang, `sec.state_${ld.kind}`, { time: Number(ld.until) ? dur(lang, Number(ld.until) - nowSec()) : t(lang, 'sec.until_ended') }));
  }
  if (g.chat.type !== 'supergroup') lines.push('', t(lang, 'sec.basic_group'));
  const problem = rightsProblem(g.chat);
  if (problem) lines.push('', t(lang, problem));
  const kb = pairs(guards.CODES.map((code) => btn(`${cfg[code].on ? '🟢' : '⚪️'} ${t(lang, `sec.m_${code}`)}`, `g:${c}:S:m:${code}`)));
  kb.push([btn(t(lang, 'sec.btn_emergency'), `g:${c}:S:e`), btn(t(lang, 'sec.btn_readonly'), `g:${c}:S:r`)]);
  kb.push([btn(t(lang, 'sec.btn_risk_log'), `g:${c}:S:k`)]);
  kb.push(back(lang, `g:${c}`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'panel-security');
}

async function moduleScreen(ctx, user, g, code, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const cfg = (await guards.all(ctx, c))[code];
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, cfg.on ? 'sec.m_title_on' : 'sec.m_title_off', { name: t(lang, `sec.m_${code}`) }), t(lang, `sec.d_${code}`), '');
  for (const f of fieldsOf(code)) lines.push(t(lang, 'sec.field_line', { field: t(lang, `sec.f_${f}`), value: show(lang, code, f, cfg[f]) }));
  if (code === 'risk') {
    const learned = Object.entries(cfg.w || {});
    lines.push('', learned.length ? t(lang, 'sec.weights_learned', { n: learned.length }) : t(lang, 'sec.weights_default'));
  }
  if (['captcha', 'quarantine', 'raid'].includes(code) && g.chat.type !== 'supergroup') lines.push('', t(lang, 'sec.basic_group'));
  if (code === 'captcha' && cfg.jr && parseJson(g.chat.bot_rights, {}).can_invite_users !== true) lines.push('', t(lang, 'sec.bot_cant_invite'));
  const kb = [[btn(t(lang, cfg.on ? 'locks.btn_turn_off' : 'locks.btn_turn_on'), `g:${c}:S:m:${code}:on`)]];
  kb.push(...pairs(fieldsOf(code).map((f) => btn(t(lang, 'sec.field_btn', { field: t(lang, `sec.f_${f}`), value: show(lang, code, f, cfg[f]) }),
    `g:${c}:S:m:${code}:${f}`))));
  if (code === 'risk') kb.push([btn(t(lang, 'sec.btn_risk_log'), `g:${c}:S:k`)]);
  kb.push(back(lang, `g:${c}:S`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `security-${code}`);
}

async function moduleAction(ctx, user, g, code, field, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  if (!(await needLevel(ctx, user, g, L.settings))) return null;
  const cfg = (await guards.all(ctx, c))[code];
  if (field !== 'on' && !fieldsOf(code).includes(field)) return moduleScreen(ctx, user, g, code, place);
  let list = guards.choices(code, field);
  if (field === 'a' && !canRestrict(g)) {
    list = ['none', 'warn'];
    await answer(ctx, t(lang, 'locks.need_restrict'));
  }
  if (field === 'd') list = LOCK_DURATIONS;
  const next = list[(list.indexOf(cfg[field]) + 1) % list.length];
  await guards.update(ctx, c, code, { [field]: next }, user.user_id);
  return moduleScreen(ctx, user, g, code, place);
}

async function lockScreen(ctx, user, g, kind, place, notice = '') {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const ld = await guards.lockdown(c, kind);
  const p = kind === 'emergency' ? 'e' : 'r';
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, `sec.${kind}_title`, { title: title(g) }), t(lang, `sec.${kind}_intro`), '');
  const kb = [];
  if (ld) {
    lines.push(t(lang, `sec.state_${kind}`, { time: Number(ld.until) ? dur(lang, Number(ld.until) - nowSec()) : t(lang, 'sec.until_ended') }));
    if (ld.reason) lines.push(t(lang, 'pun.notice_reason', { reason: iso(ld.reason, 200) }));
    kb.push([btn(t(lang, 'sec.btn_end'), `g:${c}:S:${p}:off`)]);
  } else {
    lines.push(t(lang, 'sec.state_off'));
    kb.push(...pairs(PRESETS.map((sec, i) => btn(sec ? t(lang, 'sec.btn_for', { time: dur(lang, sec) }) : t(lang, 'sec.btn_until_ended'), `g:${c}:S:${p}:o:${i}`))));
  }
  if (g.chat.type !== 'supergroup') lines.push('', t(lang, 'sec.basic_group'));
  kb.push(back(lang, `g:${c}:S`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, `security-${kind}`);
}

async function lockAction(ctx, user, g, kind, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  const p = kind === 'emergency' ? 'e' : 'r';
  const action = parts[4];
  if (!action) return lockScreen(ctx, user, g, kind, place);
  if (!canRestrict(g)) {
    await answer(ctx, t(lang, 'sec.need_restrict'), true);
    return null;
  }
  if (g.chat.type !== 'supergroup') {
    await answer(ctx, t(lang, 'mod.basic_group'), true);
    return null;
  }
  if (action === 'off') {
    const ld = await guards.lockdown(c, kind);
    if (ld) await unlockChat(ctx, g.chat, ld, user.user_id);
    return lockScreen(ctx, user, g, kind, place, t(lang, 'sec.ld_ended'));
  }
  const i = Number(parts[5]);
  if (!(i >= 0 && i < PRESETS.length)) return lockScreen(ctx, user, g, kind, place);
  const sec = PRESETS[i];
  if (action === 'o') {
    const kb = [[btn(t(lang, 'sec.btn_confirm_lock'), `g:${c}:S:${p}:y:${i}`), btn(t(lang, 'common.back'), `g:${c}:S:${p}`)]];
    return screen(ctx, user.user_id, place, t(lang, `sec.${kind}_q`, { title: title(g), time: sec ? dur(lang, sec) : t(lang, 'sec.until_ended') }), kb, 'security-lock?');
  }
  const until = sec ? nowSec() + sec : 0;
  const r = await lockChat(ctx, g.chat, kind, { byId: user.user_id, until });
  if (!r.ok) return lockScreen(ctx, user, g, kind, place, t(lang, 'chat.tg_error', { error: r.error }));
  if (!r.already) await announceLock(ctx, g.chat, kind, until, null, { id: user.user_id, first_name: await users.displayName(user.user_id) });
  return lockScreen(ctx, user, g, kind, place, t(lang, `sec.${kind}_done`));
}

async function riskLog(ctx, user, g, parts, place) {
  const lang = user.lang;
  const c = g.chat.chat_id;
  let notice = '';
  if (parts[4] === 'wr') {
    if (!(await needLevel(ctx, user, g, L.settings))) return null;
    await guards.update(ctx, c, 'risk', { w: {} }, user.user_id);
    notice = t(lang, 'sec.weights_reset');
  }
  const cfg = (await guards.all(ctx, c)).risk;
  const rows = await guards.recentRisk(c, 8);
  const now = nowSec();
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(t(lang, 'sec.risk_title', { title: title(g) }), '');
  if (!rows.length) lines.push(t(lang, 'sec.risk_none'));
  for (const r of rows) {
    lines.push(t(lang, 'sec.risk_line', { ago: dur(lang, now - Number(r.at)), user: iso(await users.displayName(Number(r.user_id))),
      score: Number(r.score), action: t(lang, `sec.ra_${r.action}`), feedback: r.feedback ? t(lang, `sec.fb_${r.feedback}`) : '—' }));
  }
  lines.push('', t(lang, 'sec.weights_title'));
  for (const [s, m] of Object.entries(cfg.w || {})) lines.push(t(lang, 'sec.weight_line', { signal: t(lang, `sec.sig_${s}`), from: WEIGHTS[s], to: Math.round(WEIGHTS[s] * m) }));
  if (!Object.keys(cfg.w || {}).length) lines.push(t(lang, 'sec.weights_default'));
  const kb = [];
  if (Object.keys(cfg.w || {}).length) kb.push([btn(t(lang, 'sec.btn_weights_reset'), `g:${c}:S:k:wr`)]);
  kb.push(back(lang, `g:${c}:S`));
  return screen(ctx, user.user_id, place, lines.join('\n'), kb, 'security-risk');
}

export async function callback(ctx, user, g, parts, place) {
  const sub = parts[3];
  if (sub === 'm' && guards.MODULES[parts[4]]) {
    return parts[5] ? moduleAction(ctx, user, g, parts[4], parts[5], place) : moduleScreen(ctx, user, g, parts[4], place);
  }
  if (sub === 'e') return lockAction(ctx, user, g, 'emergency', parts, place);
  if (sub === 'r') return lockAction(ctx, user, g, 'readonly', parts, place);
  if (sub === 'k') return riskLog(ctx, user, g, parts, place);
  return home(ctx, user, g, place);
}
