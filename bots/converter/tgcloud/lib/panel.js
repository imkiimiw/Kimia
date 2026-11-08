// /panel (owner and admins, spec §10). Until the Wanger Mother Bot exists it also holds the local
// ecosystem controls: forced-join channels, bans, maintenance, admins, broadcast (owner decisions in
// docs/DECISIONS.md C1). Every button and input re-checks the permission here.
//   admin: overview, failed/active jobs (+ retry), channels (read-only), bans
//   owner: everything, plus channel changes, forced-join and maintenance switches, admins, broadcast, keys
import { MAX_CHANNELS, OWNER_ID, VERSION, INPUT_TTL_S } from './config.js';
import * as bcdb from './db/broadcasts.js';
import * as chdb from './db/channels.js';
import * as jobsdb from './db/files.js';
import * as state from './db/state.js';
import * as sys from './db/system.js';
import * as users from './db/users.js';
import { runBatch } from './broadcast.js';
import { botStanding, channelLabel, resolveChannel } from './gate.js';
import { t, tp } from './i18n/index.js';
import { jobInputs, runJob } from './jobs.js';
import { opExists } from './ops.js';
import { listScreen as secretsScreen } from './secrets.js';
import { btn } from './codec.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { asciiDigits, esc, pacificDay } from './util.js';
import { MODELS } from './gemini.js';

/** Owner-only actions: maintenance, keys, admins (adm*), broadcast (bc*), channel changes (ch* but the list). */
export const ownerOnly = (a) => a === 'mt' || a === 'sec' || a.startsWith('adm') || a.startsWith('bc') || (a.startsWith('ch') && a !== 'ch') || (a.startsWith('gm') && a !== 'gm');

export const canUse = (ctx, action) => ctx.actor === 'owner' || (ctx.actor === 'admin' && !ownerOnly(action));

const L = (ctx, k, v) => t(ctx.lang, k, v);
const P = (ctx, k, v) => tp(ctx.lang, k, v);
const back = (ctx, ...to) => ui.backBtn(ctx, ...(to.length ? to : ['p']));

async function overview(ctx) {
  const [all, today, chans, secretRows, active] = await Promise.all([
    sys.counters('all'), sys.counters(ctx.day), chdb.list(), sys.secretNames(), jobsdb.activeJobs(50),
  ]);
  const secretSet = new Set(secretRows.map((r) => r.name));
  const n = (v) => ui.num(ctx, v || 0);
  const lines = [
    L(ctx, 'panel.head', { version: VERSION }),
    L(ctx, 'panel.users', { total: n(all.users), new: n(today.users_new), active: n(today.users_active) }),
    L(ctx, 'panel.jobs', { done: n(today.jobs_done), failed: n(today.jobs_failed), files: n(today.intake) }),
    L(ctx, 'panel.active', { n: n(active.length) }),
    L(ctx, secretSet.has('WORKER_URL') ? 'panel.worker_set' : 'panel.worker_none'),
    L(ctx, secretSet.has('GEMINI_API_KEY') ? 'panel.gemini_set' : 'panel.gemini_none'),
    L(ctx, 'panel.gate', { join: P(ctx, ctx.flags.forcedJoin ? 'set.on' : 'set.off'), n: n(chans.filter((c) => c.enabled).length), mt: P(ctx, ctx.flags.maintenance ? 'set.on' : 'set.off') }),
    L(ctx, 'panel.limits', { mb: n(ctx.limits.MAX_INPUT_MB), hour: n(ctx.limits.RATE_JOBS_PER_HOUR), min: n(ctx.limits.RATE_BURST_PER_MIN) }),
  ];
  const owner = ctx.actor === 'owner';
  return ui.plain(lines.join('\n'),
    [btn(P(ctx, 'panel.btn_failed'), 'p', 'fail'), btn(P(ctx, 'panel.btn_active'), 'p', 'act')],
    [btn(P(ctx, 'panel.btn_channels'), 'p', 'ch'), btn(P(ctx, 'panel.btn_bans'), 'p', 'ban')],
    owner ? [btn(P(ctx, 'panel.btn_mt', { v: P(ctx, ctx.flags.maintenance ? 'set.on' : 'set.off') }), 'p', 'mt'), btn(P(ctx, 'panel.btn_admins'), 'p', 'adm')] : null,
    owner ? [btn(P(ctx, 'panel.btn_broadcast'), 'p', 'bc'), btn(P(ctx, 'panel.btn_keys'), 'p', 'sec')] : null,
    [btn(P(ctx, 'panel.btn_gemini'), 'p', 'gm')],
    [btn(P(ctx, 'panel.btn_refresh'), 'p', 'r'), ui.homeBtn(ctx)]);
}

function jobList(ctx, rows, headKey, withRetry) {
  const lines = [L(ctx, headKey)];
  if (!rows.length) lines.push(L(ctx, 'panel.none'));
  for (const j of rows) lines.push(`• <code>${esc(j.code)}</code> · ${esc(ui.opLabel(ctx, j.operation))} · ${esc(j.error_code || ui.statusLabel(ctx, j.status))} · ${esc(ui.dateTime(ctx, j.created_at))}`);
  const retry = withRetry ? rows.filter((j) => j.input_file_id).slice(0, 6).map((j) => [btn(P(ctx, 'panel.retry', { code: j.code }), 'p', 'rt', j.id)]) : [];
  return ui.plain(lines.join('\n'), ...retry, [back(ctx)]);
}

async function channelsScreen(ctx) {
  const list = await chdb.list();
  const lines = [L(ctx, 'panel.ch_head', { join: P(ctx, ctx.flags.forcedJoin ? 'set.on' : 'set.off') })];
  if (!list.length) lines.push(L(ctx, 'panel.none'));
  for (const c of list) lines.push(L(ctx, `panel.ch_${c.bot_status === 'ok' ? 'ok' : 'bad'}`, { ch: channelLabel(c), title: c.title || '' }));
  const owner = ctx.actor === 'owner';
  return ui.plain(lines.join('\n'),
    ...(owner ? list.map((c) => [btn(P(ctx, 'panel.ch_del', { ch: channelLabel(c) }), 'p', 'chd', c.id)]) : []),
    owner ? [btn(P(ctx, 'panel.ch_add'), 'p', 'cha'), btn(P(ctx, 'panel.ch_recheck'), 'p', 'chr')] : null,
    owner ? [btn(P(ctx, 'panel.ch_toggle', { v: P(ctx, ctx.flags.forcedJoin ? 'set.on' : 'set.off') }), 'p', 'cht')] : null,
    [back(ctx)]);
}

async function geminiScreen(ctx) {
  const L2 = ctx.limits;
  const [key, s, usedDay] = await Promise.all([sys.hasSecret('GEMINI_API_KEY'), sys.getSettings(['gemini.model', 'gemini.paid', 'gemini.exhausted']), state.used(0, `gd:${pacificDay(ctx.now)}`)]);
  const model = s['gemini.model'] || MODELS[0];
  const exhausted = (s['gemini.exhausted'] || 0) > ctx.now;
  const lines = [
    L(ctx, 'panel.gm_head'),
    L(ctx, key ? 'panel.gm_key' : 'panel.gm_nokey'),
    L(ctx, 'panel.gm_model', { model }),
    L(ctx, 'panel.gm_used', { used: ui.num(ctx, usedDay), budget: ui.num(ctx, L2.GEMINI_DAILY_BUDGET), rpm: ui.num(ctx, L2.GEMINI_RPM), user: ui.num(ctx, L2.GEMINI_USER_DAILY) }),
    L(ctx, s['gemini.paid'] ? 'panel.gm_paid' : 'panel.gm_free'),
  ];
  if (exhausted) lines.push(L(ctx, 'panel.gm_exhausted'));
  const owner = ctx.actor === 'owner';
  return ui.plain(lines.join('\n'),
    ...(owner ? MODELS.map((m, i) => [btn(`${m === model ? '✓ ' : ''}${m}`, 'p', 'gmm', i)]) : []),
    owner ? [btn(P(ctx, s['gemini.paid'] ? 'panel.gm_set_free' : 'panel.gm_set_paid'), 'p', 'gmp'), exhausted ? btn(P(ctx, 'panel.gm_reset'), 'p', 'gmr') : null] : null,
    [back(ctx)]);
}

async function bansScreen(ctx) {
  const list = await users.listBanned(20);
  const lines = [L(ctx, 'panel.ban_head')];
  if (!list.length) lines.push(L(ctx, 'panel.none'));
  for (const u of list) lines.push(`• <code>${u.id}</code>${u.username ? ` @${esc(u.username)}` : ''}`);
  return ui.plain(lines.join('\n'), ...list.slice(0, 8).map((u) => [btn(P(ctx, 'panel.unban', { id: u.id }), 'p', 'ub', u.id)]), [btn(P(ctx, 'panel.ban_add'), 'p', 'bana')], [back(ctx)]);
}

async function adminsScreen(ctx) {
  const list = await sys.listStaff();
  const lines = [L(ctx, 'panel.adm_head', { owner: OWNER_ID })];
  if (!list.length) lines.push(L(ctx, 'panel.none'));
  for (const s of list) lines.push(`• <code>${s.user_id}</code>`);
  return ui.plain(lines.join('\n'), ...list.map((s) => [btn(P(ctx, 'panel.adm_del', { id: s.user_id }), 'p', 'admd', s.user_id)]), [btn(P(ctx, 'panel.adm_add'), 'p', 'adma')], [back(ctx)]);
}

function broadcastScreen(ctx, row, extra = '') {
  const lines = [L(ctx, 'bc.progress', { sent: ui.num(ctx, row.sent), failed: ui.num(ctx, row.failed), blocked: ui.num(ctx, row.blocked_count) })];
  if (extra) lines.push(extra);
  if (row.status === 'done') { lines.push(L(ctx, 'bc.done')); return ui.plain(lines.join('\n'), [back(ctx)]); }
  return ui.plain(lines.join('\n'), [btn(P(ctx, 'bc.next'), 'p', 'bcn', row.id)], [btn(P(ctx, 'bc.stop'), 'p', 'bcx', row.id)]);
}

const ask = async (ctx, message, kind, textKey, backTo = ['p']) => {
  await state.setPending(ctx.user.id, 'input', kind, { mid: message.message_id }, ctx.now + INPUT_TTL_S);
  return tg.edit(ctx, 'panel_ask', message, ui.plain(L(ctx, textKey), [back(ctx, ...backTo), ui.cancelBtn(ctx)]));
};

/** Panel callbacks: data 'p' or 'p:<action>:<arg>'. `message` is the panel message (or null for /panel). */
export async function onCallback(ctx, args, message) {
  const [action = '', arg] = args;
  const show = (s, view = 'panel') => tg.show(ctx, view, ctx.chatId, s, message);
  if (!canUse(ctx, action)) return show(ui.plain(L(ctx, 'panel.denied'), [ui.homeBtn(ctx)]));
  switch (action) {
    case '': case 'r':
      return show(await overview(ctx));
    case 'fail': return show(jobList(ctx, await jobsdb.failedJobs(10), 'panel.fail_head', true));
    case 'act': return show(jobList(ctx, await jobsdb.activeJobs(10), 'panel.act_head', false));
    case 'rt': {
      const job = await jobsdb.jobById(arg);
      if (!job || job.status !== 'FAILED' || !job.input_file_id || !opExists(job.operation)) return show(ui.plain(L(ctx, 'panel.retry_no'), [back(ctx, 'p', 'fail')]));
      const { inputs, params } = jobInputs(job);
      // the result goes to the job's user, in their language
      const target = await users.get(job.user_id);
      const lang = (target && target.s_lang) || 'fa';
      const userCtx = { ...ctx, targetUserId: job.user_id, lang, digits: target && target.s_digits != null ? !!target.s_digits : lang === 'fa' };
      const r = await runJob(userCtx, { op: job.operation, inputs, params, chatId: job.user_id, retry: true });
      await sys.addError(ctx.now, 'panel.retry', r.ok ? 'RETRY_OK' : `RETRY_${r.code}`, null, job.code);
      return show(ui.plain(L(ctx, r.ok ? 'panel.retry_ok' : 'panel.retry_failed', { code: r.job.code, error: r.code || '' }), [back(ctx, 'p', 'fail')]));
    }
    case 'ch': return show(await channelsScreen(ctx));
    case 'cha': {
      if ((await chdb.count()) >= MAX_CHANNELS) return show(ui.plain(L(ctx, 'panel.ch_max', { n: MAX_CHANNELS }), [back(ctx, 'p', 'ch')]));
      return ask(ctx, message, 'channel_add', 'panel.ch_ask', ['p', 'ch']);
    }
    case 'chd': {
      const c = await chdb.byId(Number(arg));
      if (!c) return show(await channelsScreen(ctx));
      return show(ui.plain(L(ctx, 'panel.ch_del_confirm', { ch: channelLabel(c) }), [btn(P(ctx, 'btn.delete_yes'), 'p', 'chD', c.id), back(ctx, 'p', 'ch')]));
    }
    case 'chD':
      await chdb.remove(Number(arg));
      return show(await channelsScreen(ctx));
    case 'cht':
      ctx.flags.forcedJoin = !ctx.flags.forcedJoin;
      await sys.setSetting('forced_join', ctx.flags.forcedJoin, ctx.now, ctx.user.id);
      return show(await channelsScreen(ctx));
    case 'chr': {
      for (const c of await chdb.list()) {
        const s = await botStanding(ctx, c.chat_id || `@${c.username}`);
        await chdb.setInfo(c.id, { botStatus: s.status, botDetail: s.detail || null }, ctx.now);
      }
      return show(await channelsScreen(ctx));
    }
    case 'mt':
      ctx.flags.maintenance = !ctx.flags.maintenance;
      await sys.setSetting('maintenance', ctx.flags.maintenance, ctx.now, ctx.user.id);
      return show(await overview(ctx));
    case 'ban': return show(await bansScreen(ctx));
    case 'bana': return ask(ctx, message, 'ban', 'panel.ban_ask', ['p', 'ban']);
    case 'ub':
      await users.setBanned(Number(arg), false, ctx.now);
      return show(await bansScreen(ctx));
    case 'adm': return show(await adminsScreen(ctx));
    case 'adma': return ask(ctx, message, 'admin_add', 'panel.adm_ask', ['p', 'adm']);
    case 'admd':
      await sys.removeStaff(Number(arg));
      return show(await adminsScreen(ctx));
    case 'sec': return show(await secretsScreen(ctx));
    case 'gm': return show(await geminiScreen(ctx));
    case 'gmm': {
      const m = MODELS[Number(arg)];
      if (m) await sys.setSetting('gemini.model', m, ctx.now, ctx.user.id);
      return show(await geminiScreen(ctx));
    }
    case 'gmp': {
      const cur = await sys.getSetting('gemini.paid', false);
      await sys.setSetting('gemini.paid', !cur, ctx.now, ctx.user.id);
      return show(await geminiScreen(ctx));
    }
    case 'gmr':
      await sys.setSetting('gemini.exhausted', 0, ctx.now, ctx.user.id);
      return show(await geminiScreen(ctx));
    case 'bc': return ask(ctx, message, 'broadcast', 'bc.ask');
    case 'bcgo': {
      if (!(await bcdb.transition(Number(arg), 'draft', 'sending', ctx.now))) return show(ui.plain(L(ctx, 'bc.gone'), [back(ctx)]));
      return batch(ctx, Number(arg), show);
    }
    case 'bcn': return batch(ctx, Number(arg), show);
    case 'bcx':
      await bcdb.transition(Number(arg), 'sending', 'cancelled', ctx.now);
      await bcdb.transition(Number(arg), 'draft', 'cancelled', ctx.now);
      return show(ui.plain(L(ctx, 'bc.cancelled'), [back(ctx)]));
    default:
      return show(await overview(ctx));
  }
}

async function batch(ctx, id, show) {
  const r = await runBatch(ctx, id);
  if (!r.row) return show(ui.plain(L(ctx, 'bc.gone'), [back(ctx)]));
  if (r.row.status === 'cancelled') return show(ui.plain(L(ctx, 'bc.cancelled'), [back(ctx)]));
  const extra = r.busy ? L(ctx, 'bc.busy') : r.rate ? L(ctx, 'bc.rate') : '';
  return show(broadcastScreen(ctx, r.row, extra));
}

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

/** Pure: '@name', 'name', 't.me/name', 'https://t.me/name' → 'name' | null. */
export function parseChannelRef(text) {
  const s = String(text || '').trim();
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/?$/i.exec(s) || /^@?([A-Za-z0-9_]+)$/.exec(s);
  return m && USERNAME_RE.test(m[1]) ? m[1] : null;
}

/** Pure: a Telegram user id typed by staff → number | null. */
export function parseUserId(text) {
  const s = asciiDigits(String(text || '').trim());
  return /^\d{4,15}$/.test(s) ? Number(s) : null;
}

/** Typed answers for panel prompts (slot 'input'). */
export async function onInput(ctx, message, pending) {
  const chatId = message.chat.id;
  const reply = (key, vars, ...rows) => tg.send(ctx, 'panel_input', chatId, ui.plain(L(ctx, key, vars), ...(rows.length ? rows : [[back(ctx)]])));
  const kind = pending.kind;
  const action = { channel_add: 'cha', ban: 'bana', admin_add: 'adma', broadcast: 'bc' }[kind];
  if (!action || !canUse(ctx, action)) { await state.clearPending(ctx.user.id, 'input'); return reply('panel.denied'); }

  if (kind === 'broadcast') {
    await state.clearPending(ctx.user.id, 'input');
    if (message.media_group_id) return reply('bc.no_album');
    const id = await bcdb.create(chatId, message.message_id, ctx.user.id, ctx.now);
    return tg.send(ctx, 'bc_confirm', chatId, ui.plain(L(ctx, 'bc.confirm'), [btn(P(ctx, 'bc.go'), 'p', 'bcgo', id), btn(P(ctx, 'btn.cancel'), 'p', 'bcx', id)]));
  }
  if (kind === 'channel_add') {
    const name = parseChannelRef(message.text);
    if (!name) return reply('panel.ch_bad_ref', {}, [back(ctx, 'p', 'ch'), ui.cancelBtn(ctx)]);
    if (await chdb.find(null, name)) { await state.clearPending(ctx.user.id, 'input'); return reply('panel.ch_dup', { ch: `@${name}` }, [back(ctx, 'p', 'ch')]); }
    const r = await resolveChannel(ctx, `@${name}`);
    if (r.error) return reply(`panel.ch_${r.error}`, { ch: `@${name}` }, [back(ctx, 'p', 'ch'), ui.cancelBtn(ctx)]);
    if (r.standing.status !== 'ok') return reply('panel.ch_not_admin', { ch: `@${name}` }, [back(ctx, 'p', 'ch'), ui.cancelBtn(ctx)]);
    await chdb.add({ username: r.username || name, chatId: r.chatId, title: r.title, botStatus: 'ok', botDetail: null }, ctx.now);
    await state.clearPending(ctx.user.id, 'input');
    return tg.send(ctx, 'panel', chatId, await channelsScreen(ctx));
  }
  const id = parseUserId(message.text);
  if (!id) return reply('panel.bad_id', {}, [back(ctx), ui.cancelBtn(ctx)]);
  await state.clearPending(ctx.user.id, 'input');
  if (kind === 'ban') {
    if (id === OWNER_ID || (await sys.isStaff(id))) return reply('panel.ban_staff', {}, [back(ctx, 'p', 'ban')]);
    await users.setBanned(id, true, ctx.now);
    return tg.send(ctx, 'panel', chatId, await bansScreen(ctx));
  }
  // admin_add
  if (id === OWNER_ID) return reply('panel.adm_owner', {}, [back(ctx, 'p', 'adm')]);
  await sys.addStaff(id, ctx.user.id, ctx.now);
  await users.setBanned(id, false, ctx.now);
  return tg.send(ctx, 'panel', chatId, await adminsScreen(ctx));
}

