// The panel, part 1: home, the bots (catalog editing, token, status, access mode, hub sync), health and
// statistics. Part 2 (lib/admin2.js): tickets, incidents, users and abuse, forced join, broadcasts,
// news, club, settings. Team members (role 1) get tickets, incidents, moderation, status/mode, health
// and stats; everything else is the owner's (numeric id in lib/config.js).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { MAX_BOTS, OWNER_ID } from './config.js';
import { MODES, STATUSES, setMode, setStatus } from './access.js';
import { botHistory, dailyFor } from './activity.js';
import {
  CATEGORIES, STATUS, botTitle, categoryOf, countBots, createBot, deleteBot, effectiveStatus, formatLines, getBot,
  isBotKey, listBots, parseLines, updateBot,
} from './catalog.js';
import { TOKEN_RE, checkToken, maskToken } from './children.js';
import { checkBot, inspect, lastErrors } from './health.js';
import { fullSync, hubChat } from './hubout.js';
import { listIncidents, openIncidentOf } from './incidents.js';
import { abuseQueueSize } from './moderation.js';
import { subscriberCount } from './news.js';
import { logChat } from './notify.js';
import { countTickets } from './reports.js';
import {
  clearState, isOwner, kvGet, setState,
} from './store.js';
import {
  answer, btn, del, grid, send, show,
} from './tg.js';
import {
  ago, esc, fa, formatDate, localDay, nowSec, parseDuration, toAsciiDigits, truncate,
} from './util.js';

export const HEALTH_ICON = {
  ok: '🟢', warn: '🟡', bad: '🔴', unknown: '⚪️',
};
const panelBtn = () => btn('🏠 پنل', 'a');
const ownerOnly = async (ctx, user) => {
  if (isOwner(user.user_id)) return true;
  await answer(ctx, '⛔️ فقط مالک ربات.', { alert: true });
  return false;
};

async function countUsers() {
  const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM users WHERE started = 1 LIMIT 1000000)`);
  return Number((r && r.n) || 0);
}

export async function panelHome(ctx, user) {
  const bots = await listBots({ team: true });
  const now = nowSec();
  const withToken = bots.filter((b) => b.token).length;
  const onHub = bots.filter((b) => Number(b.last_event_at) > now - 86400).length;
  const hub = await hubChat();
  const log = await logChat();
  const lines = [
    '⚙️ <b>پنل مدیریت ربات مادر</b>',
    '',
    `🤖 ربات‌ها: ${fa(bots.length)} · 🔑 با توکن: ${fa(withToken)} · 📡 فعال در هاب (۲۴ ساعت): ${fa(onHub)}`,
    `👥 کاربران ربات مادر: ${fa(await countUsers())}`,
    `🎫 تیکت باز: ${fa(await countTickets('open'))} · 🚨 صف سوءاستفاده: ${fa(await abuseQueueSize())} · 🟡 اختلال باز: ${fa((await listIncidents('open', 50)).length)}`,
    `📡 کانال هاب: ${hub ? '✅' : '⚠️ تنظیم نشده (⚙️ تنظیمات)'} · 📋 لاگ: ${log ? '✅ کانال/گروه' : 'پی‌وی تیم'}`,
  ];
  const owner = isOwner(user.user_id);
  const kb = [
    [btn('🤖 ربات‌ها', 'ab'), btn('📊 آمار', 'as')],
    [btn('🎫 تیکت‌ها', 'at'), btn('🟡 اختلال‌ها', 'ai')],
    [btn('🩺 سلامت', 'ah'), btn('👤 کاربران', 'au')],
    [btn('🗂 صف سوءاستفاده', 'aq'), btn('📰 خبر و اطلاعیه', 'an')],
  ];
  if (owner) {
    kb.push([btn('📢 عضویت اجباری', 'aj'), btn('📣 پیام همگانی', 'abc')]);
    kb.push([btn('🎁 باشگاه', 'ac'), btn('⚙️ تنظیمات', 'ax')]);
  }
  kb.push([btn('🏠 منوی کاربر', 'm')]);
  await clearState(user.user_id);
  return show(ctx, 'panel', lines.join('\n'), kb);
}

// ---------- bots ----------

export async function botsList(ctx, user) {
  const bots = await listBots({ team: true });
  const now = nowSec();
  const lines = ['🤖 <b>ربات‌ها</b>', '', 'وضعیت · سلامت · 🔑 توکن · 📡 هاب', ''];
  for (const b of bots) {
    const s = effectiveStatus(b, await openIncidentOf(b.key));
    const hubOk = Number(b.last_event_at) > now - 86400;
    lines.push(`${STATUS[s].emoji}${HEALTH_ICON[b.health] || '⚪️'}${b.token ? '🔑' : '▫️'}${hubOk ? '📡' : '▫️'} ${esc(b.name)} <code>${esc(b.key)}</code>${b.hidden ? ' (مخفی)' : ''}`);
  }
  const kb = grid(bots.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `ab:${b.key}`)), 2);
  if (isOwner(user.user_id)) kb.push([btn('➕ ربات جدید', 'abn')]);
  kb.push([panelBtn()]);
  return show(ctx, 'adm_bots', lines.join('\n'), kb);
}

export async function botAdminCard(ctx, user, key) {
  const b = await getBot(key);
  if (!b) return answer(ctx, 'این ربات دیگر نیست.', { alert: true });
  const inc = await openIncidentOf(b.key);
  const s = effectiveStatus(b, inc);
  const lines = [
    `${botTitle(b)} <code>${esc(b.key)}</code>${b.username ? ` @${esc(b.username)}` : ''}${b.hidden ? ' — 🙈 مخفی' : ''}`,
    `${categoryOf(b.category).emoji} ${categoryOf(b.category).name} · ترتیب ${fa(b.sort)}`,
    '',
    `نمایش برای کاربران: ${STATUS[s].emoji} ${STATUS[s].name}`,
    `وضعیت تیم: ${STATUS[b.status] ? STATUS[b.status].name : b.status}${b.status_note ? ` — ${esc(b.status_note)}` : ''}${Number(b.status_until) ? ` (تا ${formatDate(b.status_until, true)})` : ''}`,
    `دسترسی: ${MODES[b.mode].emoji} ${MODES[b.mode].name}${b.mode === 'slow' ? ` (هر ${fa(b.slow_sec)} ثانیه)` : ''}${Number(b.mode_until) ? ` تا ${formatDate(b.mode_until, true)}` : ''}`,
    `سلامت: ${HEALTH_ICON[b.health]} ${esc(b.health_note || b.health)}${Number(b.health_at) ? ` · بررسی ${ago(b.health_at)}` : ''}`,
    inc ? `🟡 اختلال باز #${fa(inc.id)}: ${esc(truncate(inc.title || '', 80))} (${fa(inc.reports)} گزارش)` : '',
    '',
    `🔑 توکن: ${b.token ? `<code>${esc(maskToken(b.token))}</code>` : 'ندارد (بدون توکن: بررسی وبهوک و ارسال از طرف ربات ممکن نیست)'}`,
    `📡 آخرین گزارش هاب: ${ago(b.last_event_at)}${b.version ? ` · نسخه ${esc(b.version)}` : ''} · پیکربندی v${fa(b.cfg_ver)} (تأیید ربات: v${fa(b.cfg_ack)})`,
    `🔇 هشدار سکوت: ${Number(b.silence_min) ? `بعد از ${fa(b.silence_min)} دقیقه بی‌خبری` : 'خاموش'}`,
    `👥 کاربران شناخته‌شده: ${fa(Number(b.users_known))}${Number(b.users_reported) ? ` (گزارش خود ربات: ${fa(Number(b.users_reported))})` : ''} · ⛔️ بلاک: ${fa(Number(b.blocked_known))}`,
    `👀 بازدید صفحه: ${fa(Number(b.views))} · 🔔 مشترک خبر: ${fa(await subscriberCount(b.key))}`,
  ].filter((x) => x !== '');
  const owner = isOwner(user.user_id);
  const kb = [
    [btn('📶 وضعیت', `abs:${b.key}`), btn('🎛 دسترسی (تعمیر/محدود)', `abm:${b.key}`)],
    [btn('🩺 سلامت', `ah:${b.key}`), btn('📈 آمار ۷ روز', `abst:${b.key}`)],
  ];
  if (owner) {
    kb.push([btn('✏️ ویرایش اطلاعات', `abe:${b.key}`), btn('🔑 توکن', `abt:${b.key}`)]);
    kb.push([btn('🔄 همگام‌سازی هاب', `abz:${b.key}`), btn('🆕 اعلام ربات جدید', `annb:${b.key}`)]);
    kb.push([btn('🗑 حذف', `abd:${b.key}`)]);
  }
  kb.push([btn('⬅️ ربات‌ها', 'ab'), panelBtn()]);
  return show(ctx, 'adm_bot', lines.join('\n'), kb);
}

// status
export async function statusMenu(ctx, key) {
  const b = await getBot(key);
  if (!b) return null;
  const kb = STATUSES.map((s) => [btn(`${b.status === s ? '● ' : ''}${STATUS[s].emoji} ${STATUS[s].name}`, `abss:${key}:${s}`)]);
  kb.push([btn('⬅️ برگشت', `ab:${key}`)]);
  return show(ctx, 'adm_status', `📶 <b>وضعیت ${esc(b.name)}</b> روی تابلوی وضعیت\n\n«فعال» یعنی وضعیت خودکار (اختلال‌ها و سلامت) نشان داده شود.\nبا تغییر به اختلال/تعمیر/قطع، مشترکان خبر «اختلال و تعمیرات» آن ربات خبردار می‌شوند و با برگشت به «فعال»، کسانی که خواسته بودند.`, kb);
}

// access mode
export async function modeMenu(ctx, key) {
  const b = await getBot(key);
  if (!b) return null;
  const kb = Object.entries(MODES).map(([m, x]) => [btn(`${b.mode === m ? '● ' : ''}${x.emoji} ${x.name}`, `abmm:${key}:${m}`)]);
  kb.push([btn('⬅️ برگشت', `ab:${key}`)]);
  const text = [
    `🎛 <b>دسترسی کاربران به ${esc(b.name)}</b>`,
    '',
    '🔧 <b>بسته (تعمیر):</b> ربات به همه (جز ادمین‌ها) پیام تعمیر می‌دهد و درخواستی انجام نمی‌دهد.',
    '⏳ <b>محدود:</b> هر کاربر هر چند ثانیه فقط یک درخواست.',
    '✅ <b>آزاد:</b> عادی.',
    '',
    'تغییر از طریق کانال هاب به ربات می‌رسد (ربات باید client/mother-client.js را داشته باشد).',
  ].join('\n');
  return show(ctx, 'adm_mode', text, kb);
}

/** Parses "note / duration / seconds" lines of a status or mode message. */
export function parseControlText(text) {
  const out = { note: null, dur: 0, slow: null };
  const notes = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line === '-') continue;
    const d = parseDuration(line);
    if (d) {
      out.dur = d;
      continue;
    }
    const s = /^(\d{1,4})\s*(s|sec|ثانیه)$/i.exec(toAsciiDigits(line));
    if (s) {
      out.slow = Math.max(5, Math.min(3600, Number(s[1])));
      continue;
    }
    notes.push(line);
  }
  if (notes.length) out.note = truncate(notes.join('\n'), 400);
  return out;
}

// edit
const FIELDS = {
  name: 'نام', username: 'یوزرنیم (بدون @)', emoji: 'ایموجی', short: 'معرفی یک‌خطی', description: 'توضیح کامل',
  features: 'قابلیت‌ها و راهنما', faq: 'سؤالات رایج', fixes: 'رفع مشکل (سمت کاربر)', keywords: 'کلمات جستجو', langs: 'زبان‌ها',
  sort: 'ترتیب نمایش (عدد)', silence: 'هشدار سکوت (دقیقه، ۰ = خاموش)',
};
const LIST_FIELDS = new Set(['features', 'faq', 'fixes']);

export async function editMenu(ctx, key) {
  const b = await getBot(key);
  if (!b) return null;
  const kb = grid(Object.entries(FIELDS).map(([f, name]) => btn(name, `abf:${key}:${f}`)), 2);
  kb.push([btn(`📂 دسته: ${categoryOf(b.category).name}`, `abcats:${key}`), btn(b.hidden ? '👁 نمایش برای همه' : '🙈 مخفی کن', `abhid:${key}`)]);
  kb.push([btn('⬅️ برگشت', `ab:${key}`)]);
  return show(ctx, 'adm_edit', `✏️ <b>ویرایش ${esc(b.name)}</b>\n\nدستیار و صفحه‌ی ربات از همین اطلاعات جواب می‌دهند؛ هرچه کامل‌تر، جواب‌ها بهتر.`, kb);
}

export async function fieldPrompt(ctx, user, key, field) {
  const b = await getBot(key);
  if (!b || !FIELDS[field]) return null;
  await setState(user.user_id, 'adm_field', { key, field });
  let current;
  if (LIST_FIELDS.has(field)) current = formatLines(b[field], field);
  else if (field === 'silence') current = String(b.silence_min || 0);
  else current = String(b[field] == null ? '' : b[field]);
  const help = LIST_FIELDS.has(field)
    ? `\n\nهر مورد در یک خط با این قالب (کل فهرست جایگزین می‌شود):\n<code>${field === 'features' ? 'عنوان | طرز استفاده | کلمات کلیدی' : field === 'faq' ? 'سؤال | جواب | کلمات کلیدی' : 'مشکل | راه‌حل | کلمات کلیدی'}</code>`
    : '';
  return show(ctx, 'adm_field', `✏️ <b>${FIELDS[field]}</b> — ${esc(b.name)}${help}\n\nمقدار فعلی:\n<code>${esc(truncate(current || '—', 3000))}</code>\n\nمقدار جدید را بفرست («-» = خالی).`, [[btn('✖️ انصراف', `abe:${key}`)]]);
}

export async function saveField(ctx, user, st, text) {
  const { key, field } = st.data;
  const b = await getBot(key);
  if (!b || !FIELDS[field]) return clearState(user.user_id);
  const raw = String(text || '').trim();
  const empty = raw === '-' || raw === '';
  let value;
  let col = field;
  if (LIST_FIELDS.has(field)) {
    value = empty ? [] : parseLines(raw, field);
    if (!empty && !value.length) return send(ctx, 'adm_field_bad', '⚠️ هیچ خط درستی پیدا نشد. هر مورد: <code>عنوان | توضیح | کلمات</code>');
  } else if (field === 'sort' || field === 'silence') {
    value = Math.max(0, Math.min(100000, Number(toAsciiDigits(raw)) || 0));
    if (field === 'silence') col = 'silence_min';
  } else if (field === 'username') {
    value = empty ? null : raw.replace(/^@|^https?:\/\/t\.me\//, '').trim();
    if (value && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)) return send(ctx, 'adm_field_bad', '⚠️ یوزرنیم درست نیست.');
  } else {
    if (field === 'name' && empty) return send(ctx, 'adm_field_bad', '⚠️ نام نمی‌تواند خالی باشد.');
    value = empty ? null : truncate(raw, field === 'description' ? 1500 : field === 'keywords' ? 600 : 200);
  }
  await updateBot(key, { [col]: value });
  await clearState(user.user_id);
  await send(ctx, 'adm_field_saved', `✅ ${FIELDS[field]} ذخیره شد.`);
  ctx.messageId = null;
  return editMenu(ctx, key);
}

export async function categoryPick(ctx, key) {
  const kb = grid(CATEGORIES.map((c) => btn(`${c.emoji} ${c.name}`, `abcat:${key}:${c.id}`)), 2);
  kb.push([btn('⬅️ برگشت', `abe:${key}`)]);
  return show(ctx, 'adm_cat', '📂 دسته‌ی ربات:', kb);
}

// token
export async function tokenScreen(ctx, user, key) {
  const b = await getBot(key);
  if (!b) return null;
  await setState(user.user_id, 'adm_token', { key });
  const lines = [
    `🔑 <b>توکن ${esc(b.name)}</b>`,
    '',
    `فعلی: ${b.token ? `<code>${esc(maskToken(b.token))}</code>` : 'ندارد'}`,
    '',
    'با توکن، ربات مادر می‌تواند سلامت وبهوک را بررسی کند، از طرف این ربات به کاربرانش پیام همگانی و اخطار بفرستد، و ادمین بودنش در کانال‌های عضویت اجباری را چک کند.',
    '',
    'توکن را از @BotFather بگیر و همین‌جا بفرست؛ پیامت فوراً پاک می‌شود و توکن دیگر نمایش داده نمی‌شود.',
    '⚠️ هر کس به ربات مادر دسترسی مالک داشته باشد به این توکن‌ها هم دسترسی دارد.',
  ];
  const kb = [];
  if (b.token) kb.push([btn('🗑 حذف توکن', `abtd:${key}`)]);
  kb.push([btn('⬅️ برگشت', `ab:${key}`)]);
  return show(ctx, 'adm_token', lines.join('\n'), kb);
}

export async function saveToken(ctx, user, st, msg) {
  const { key } = st.data;
  const text = String(msg.text || '').trim();
  await del(ctx, msg.chat.id, msg.message_id, 'delete_token');
  if (!TOKEN_RE.test(text)) return send(ctx, 'adm_token_bad', '⚠️ این شبیه توکن ربات نیست (قالب: <code>123456:ABC…</code>). دوباره بفرست یا انصراف بزن.', [[btn('✖️ انصراف', `ab:${key}`)]]);
  const check = await checkToken(text);
  if (!check.ok) {
    return send(ctx, 'adm_token_bad', check.why === 'rejected' ? '⛔️ تلگرام این توکن را قبول نکرد.' : '⚠️ الان نشد توکن را بررسی کنم؛ کمی بعد دوباره بفرست.', [[btn('✖️ انصراف', `ab:${key}`)]]);
  }
  const b = await getBot(key);
  const dup = await db.get(sql`SELECT key FROM bots WHERE tg_id = ${check.me.id} AND key <> ${key} LIMIT 1`);
  if (dup) return send(ctx, 'adm_token_bad', `⚠️ این توکن مال ربات دیگری در فهرست است (<code>${esc(dup.key)}</code>).`);
  const fields = { token: text, tg_id: check.me.id, health_at: 0 };
  if (!b.username && check.me.username) fields.username = check.me.username;
  await updateBot(key, fields);
  await clearState(user.user_id);
  await send(ctx, 'adm_token_saved', `✅ توکن @${esc(check.me.username || '')} ذخیره شد. پیامت پاک شد.`);
  const fresh = await getBot(key);
  const h = await checkBot(ctx, fresh);
  await send(ctx, 'adm_token_health', `🩺 اولین بررسی سلامت: ${HEALTH_ICON[h.state]} ${esc(h.note || h.state)}`, [[btn('⬅️ ربات', `ab:${key}`)]]);
  return null;
}

// health
export async function healthOverview(ctx) {
  const bots = await listBots({ team: true });
  const today = new Map((await dailyFor(localDay())).map((r) => [r.bot_key, r]));
  const lines = ['🩺 <b>سلامت ربات‌ها</b>', ''];
  for (const b of bots) {
    const d = today.get(b.key);
    lines.push(`${HEALTH_ICON[b.health] || '⚪️'} <b>${esc(b.name)}</b>${b.health_note ? ` — ${esc(truncate(b.health_note, 100))}` : ''}\n   📡 ${ago(b.last_event_at)}${d && d.errors ? ` · ⚠️ ${fa(d.errors)} خطا امروز` : ''}${d && d.reports ? ` · 🎫 ${fa(d.reports)} گزارش` : ''}`);
  }
  lines.push('', '🟢 سالم · 🟡 هشدار · 🔴 مشکل · ⚪️ نامعلوم (توکن یا هشدار سکوت ندارد)');
  const kb = [[btn('🔄 بررسی همه الان', 'ahx')], ...grid(bots.map((b) => btn(`${HEALTH_ICON[b.health] || '⚪️'} ${b.name}`, `ah:${b.key}`)), 2), [panelBtn()]];
  return show(ctx, 'adm_health', truncate(lines.join('\n'), 3900), kb);
}

export async function healthDetail(ctx, key) {
  const b = await getBot(key);
  if (!b) return null;
  const live = await inspect(b, ctx);
  const lines = [`🩺 <b>سلامت ${esc(b.name)}</b>`, '', `الان: ${HEALTH_ICON[live.state]} ${esc(live.note || live.state)}`];
  if (live.webhook) {
    const w = live.webhook;
    let host = '—';
    const m = /^https?:\/\/([^/]+)/.exec(w.url || '');
    if (m) host = m[1];
    lines.push(`وبهوک: ${w.url ? esc(host) : 'تنظیم نشده (ربات polling یا خاموش)'} · صف: ${fa(Number(w.pending_update_count || 0))}`);
    if (w.last_error_date) lines.push(`آخرین خطای تحویل: ${ago(w.last_error_date)} — ${esc(truncate(w.last_error_message || '', 150))}`);
  }
  lines.push(`📡 آخرین گزارش هاب: ${ago(b.last_event_at)}`);
  const errs = await lastErrors(b.key, 5);
  if (errs.length) {
    lines.push('', '<b>آخرین خطاهای گزارش‌شده:</b>');
    for (const e of errs) lines.push(`• ${ago(e.last_at)} ×${fa(e.count)} <code>${esc(truncate(e.sig, 60))}</code>\n  ${esc(truncate(e.body || '', 150))}`);
  }
  return show(ctx, 'adm_health_bot', truncate(lines.join('\n'), 3900), [[btn('🔄 دوباره', `ah:${key}`), btn('⬅️ ربات', `ab:${key}`)], [btn('🩺 همه', 'ah'), panelBtn()]]);
}

// stats
export async function statsView(ctx) {
  const day = localDay();
  const rows = await dailyFor(day);
  const bots = new Map((await listBots({ team: true })).map((b) => [b.key, b]));
  const club = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM users WHERE club = 1 LIMIT 1000000)`);
  const fresh = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM users WHERE first_seen >= ${nowSec() - 86400} LIMIT 100000)`);
  const lines = [
    '📊 <b>آمار امروز</b>',
    '',
    `ربات مادر: 👥 ${fa(await countUsers())} کاربر · 🆕 ${fa(Number((fresh && fresh.n) || 0))} در ۲۴ ساعت · 🎁 ${fa(Number((club && club.n) || 0))} عضو باشگاه`,
    '',
    '<b>ربات‌ها</b> (فعال · جدید · استفاده · خطا · بلاک):',
  ];
  let total = { active: 0, new_users: 0, uses: 0 };
  for (const r of rows) {
    const b = bots.get(r.bot_key);
    lines.push(`${b ? b.emoji || '🤖' : '❔'} ${esc(b ? b.name : r.bot_key)}: ${fa(r.active)} · ${fa(r.new_users)} · ${fa(r.uses)} · ${fa(r.errors)} · ${fa(r.blocked)}`);
    total = { active: total.active + r.active, new_users: total.new_users + r.new_users, uses: total.uses + r.uses };
  }
  if (!rows.length) lines.push('هنوز امروز گزارشی از ربات‌ها نرسیده (ربات‌ها باید از طریق هاب وصل باشند).');
  else lines.push('', `جمع: ${fa(total.active)} فعال · ${fa(total.new_users)} جدید · ${fa(total.uses)} استفاده`);
  lines.push('', '<b>کل کاربران شناخته‌شده:</b>');
  for (const b of bots.values()) if (Number(b.users_known) || Number(b.users_reported)) lines.push(`${b.emoji || '🤖'} ${esc(b.name)}: ${fa(Math.max(Number(b.users_known), Number(b.users_reported)))} (بلاک: ${fa(Number(b.blocked_known))})`);
  return show(ctx, 'adm_stats', truncate(lines.join('\n'), 3900), [[btn('🔄', 'as'), panelBtn()]]);
}

export async function botStats(ctx, key) {
  const b = await getBot(key);
  if (!b) return null;
  const rows = await botHistory(key, 7);
  const lines = [`📈 <b>${esc(b.name)}</b> — ۷ روز اخیر`, '', 'روز: فعال · جدید · استفاده · خطا · گزارش'];
  for (const r of rows) {
    const d = String(r.day);
    lines.push(`${fa(`${d.slice(4, 6)}/${d.slice(6)}`)}: ${fa(r.active)} · ${fa(r.new_users)} · ${fa(r.uses)} · ${fa(r.errors)} · ${fa(r.reports)}`);
  }
  if (!rows.length) lines.push('داده‌ای نیست.');
  return show(ctx, 'adm_bot_stats', lines.join('\n'), [[btn('⬅️ ربات', `ab:${key}`), panelBtn()]]);
}

// ---------- callbacks of part 1 ----------

/** Handles part-1 buttons; returns true if `data` was one of them. */
export async function adminCallback1(ctx, user, data) {
  const [cmd, a, b2] = data.split(':');
  const owner = isOwner(user.user_id);
  switch (cmd) {
    case 'a':
      await panelHome(ctx, user);
      return true;
    case 'ab':
      if (a) await botAdminCard(ctx, user, a);
      else await botsList(ctx, user);
      return true;
    case 'abn':
      if (!(await ownerOnly(ctx, user))) return true;
      if ((await countBots()) >= MAX_BOTS) {
        await answer(ctx, 'سقف تعداد ربات‌ها پر است.', { alert: true });
        return true;
      }
      await setState(user.user_id, 'adm_newbot');
      await show(ctx, 'adm_newbot', '➕ <b>ربات جدید</b>\n\nدر یک پیام بفرست: <code>کلید نام</code>\nکلید: حروف کوچک انگلیسی، عدد و _ (۲ تا ۱۶ حرف)؛ همین کلید در تنظیمات client ربات فرزند (BOT_KEY) می‌آید.\nمثال: <code>shop فروشگاه Wanger</code>\n\nربات اول مخفی ساخته می‌شود؛ بعد از کامل کردن اطلاعات، نمایشش بده.', [[btn('✖️ انصراف', 'ab')]]);
      return true;
    case 'abs':
      await statusMenu(ctx, a);
      return true;
    case 'abss': {
      if (b2 === 'ok') {
        await setStatus(ctx, a, 'ok');
        await answer(ctx, '✅ فعال شد.');
        await botAdminCard(ctx, user, a);
      } else {
        await setState(user.user_id, 'adm_status', { key: a, status: b2 });
        await show(ctx, 'adm_status_note', `${STATUS[b2] ? STATUS[b2].emoji : ''} توضیحی که کاربران روی تابلوی وضعیت می‌بینند را بفرست.\nدر یک خط جدا می‌توانی مدت هم بنویسی (مثلاً <code>2h</code> یا <code>1d</code>) تا خودش به «فعال» برگردد.\n«-» = بدون توضیح.`, [[btn('✖️ انصراف', `ab:${a}`)]]);
      }
      return true;
    }
    case 'abm':
      await modeMenu(ctx, a);
      return true;
    case 'abmm':
      if (b2 === 'off') {
        await setMode(ctx, a, 'off', 0, { byId: user.user_id });
        await answer(ctx, '✅ آزاد شد.');
        await botAdminCard(ctx, user, a);
      } else {
        await setState(user.user_id, 'adm_mode', { key: a, mode: b2 });
        await show(ctx, 'adm_mode_msg', `${MODES[b2].emoji} <b>${MODES[b2].name}</b>\n\nدر یک پیام (هر مورد در یک خط، همه اختیاری):\n• پیامی که کاربران ببینند\n• مدت، مثلاً <code>3h</code> (بعدش خودش آزاد می‌شود)${b2 === 'slow' ? '\n• فاصله‌ی هر درخواست، مثلاً <code>30s</code>' : ''}\n\n«-» = پیش‌فرض‌ها.`, [[btn('✖️ انصراف', `ab:${a}`)]]);
      }
      return true;
    case 'abe':
      if (!(await ownerOnly(ctx, user))) return true;
      await clearState(user.user_id);
      await editMenu(ctx, a);
      return true;
    case 'abf':
      if (!(await ownerOnly(ctx, user))) return true;
      await fieldPrompt(ctx, user, a, b2);
      return true;
    case 'abcats':
      if (!(await ownerOnly(ctx, user))) return true;
      await categoryPick(ctx, a);
      return true;
    case 'abcat':
      if (!(await ownerOnly(ctx, user))) return true;
      if (CATEGORIES.some((c) => c.id === b2)) await updateBot(a, { category: b2 });
      await editMenu(ctx, a);
      return true;
    case 'abhid': {
      if (!(await ownerOnly(ctx, user))) return true;
      const bot = await getBot(a);
      if (bot) await updateBot(a, { hidden: bot.hidden ? 0 : 1 });
      await answer(ctx, bot && bot.hidden ? '👁 برای همه نمایش داده می‌شود.' : '🙈 مخفی شد.');
      await editMenu(ctx, a);
      return true;
    }
    case 'abt':
      if (!(await ownerOnly(ctx, user))) return true;
      await tokenScreen(ctx, user, a);
      return true;
    case 'abtd':
      if (!(await ownerOnly(ctx, user))) return true;
      await updateBot(a, { token: null, tg_id: 0, health: 'unknown', health_note: null });
      await clearState(user.user_id);
      await answer(ctx, '🗑 توکن حذف شد.');
      await botAdminCard(ctx, user, a);
      return true;
    case 'abz':
      if (!(await ownerOnly(ctx, user))) return true;
      if (!(await hubChat())) {
        await answer(ctx, 'اول کانال هاب را در ⚙️ تنظیمات مشخص کن.', { alert: true });
        return true;
      }
      await fullSync(ctx, a);
      await answer(ctx, '🔄 پیکربندی، بن‌ها و کدهای تخفیف در هاب فرستاده شد.');
      await botAdminCard(ctx, user, a);
      return true;
    case 'abd': {
      if (!(await ownerOnly(ctx, user))) return true;
      const bot = await getBot(a);
      if (!bot) return true;
      await show(ctx, 'adm_delete', `🗑 ${botTitle(bot)} از فهرست حذف شود؟\nتاریخچه‌ی استفاده‌ی کاربران می‌ماند ولی ربات دیگر نمایش داده نمی‌شود و رویدادهای هابش پذیرفته نمی‌شود.`, [[btn('✅ بله، حذف', `abdy:${a}`), btn('✖️ نه', `ab:${a}`)]]);
      return true;
    }
    case 'abdy':
      if (!(await ownerOnly(ctx, user))) return true;
      await deleteBot(a);
      await answer(ctx, '🗑 حذف شد.');
      await botsList(ctx, user);
      return true;
    case 'abst':
      await botStats(ctx, a);
      return true;
    case 'ah':
      if (a) await healthDetail(ctx, a);
      else await healthOverview(ctx);
      return true;
    case 'ahx': {
      const bots = await listBots({ team: true });
      for (const bot of bots) if (bot.token || Number(bot.silence_min)) await checkBot(ctx, bot);
      await answer(ctx, '🔄 بررسی شد.');
      await healthOverview(ctx);
      return true;
    }
    case 'as':
      await statsView(ctx);
      return true;
    default:
      return false;
  }
}

/** Part-1 text steps; returns true if the state was one of them. */
export async function adminText1(ctx, user, st, msg) {
  const text = String(msg.text || '').trim();
  switch (st.name) {
    case 'adm_field':
      await saveField(ctx, user, st, text);
      return true;
    case 'adm_token':
      await saveToken(ctx, user, st, msg);
      return true;
    case 'adm_newbot': {
      const m = /^([a-z0-9_]{2,16})\s+(.{2,60})$/.exec(text);
      if (!m || !isBotKey(m[1])) {
        await send(ctx, 'adm_newbot_bad', '⚠️ قالب: <code>کلید نام</code> — مثال: <code>shop فروشگاه Wanger</code>');
        return true;
      }
      if (!(await createBot(m[1], m[2].trim()))) {
        await send(ctx, 'adm_newbot_bad', '⚠️ این کلید قبلاً هست.');
        return true;
      }
      await clearState(user.user_id);
      await send(ctx, 'adm_newbot_ok', `✅ ربات <code>${esc(m[1])}</code> ساخته شد (مخفی). اطلاعاتش را کامل کن.`);
      ctx.messageId = null;
      await editMenu(ctx, m[1]);
      return true;
    }
    case 'adm_status': {
      const p = parseControlText(text);
      await setStatus(ctx, st.data.key, st.data.status, p.note, p.dur);
      await clearState(user.user_id);
      await send(ctx, 'adm_status_ok', '✅ وضعیت ثبت شد.');
      ctx.messageId = null;
      await botAdminCard(ctx, user, st.data.key);
      return true;
    }
    case 'adm_mode': {
      const p = parseControlText(text);
      const posted = await setMode(ctx, st.data.key, st.data.mode, p.dur, { msg: p.note || '', slowSec: p.slow, byId: user.user_id });
      await clearState(user.user_id);
      await send(ctx, 'adm_mode_ok', posted ? '✅ ثبت شد و به ربات خبر داده شد.' : '✅ ثبت شد، ولی کانال هاب تنظیم نیست؛ ربات فرزند خبردار نشد (فقط تابلوی وضعیت عوض شد).');
      ctx.messageId = null;
      await botAdminCard(ctx, user, st.data.key);
      return true;
    }
    default:
      return false;
  }
}

export const OWNER = OWNER_ID;
