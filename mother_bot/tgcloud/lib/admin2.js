// The panel, part 2: tickets, incidents, users and abuse, central forced join, broadcasts, news, the
// club and settings. (Part 1 is lib/admin.js.)
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { LEVELS, MAX_CHANNELS_PER_SCOPE, OWNER_ID } from './config.js';
import { ready as aiReady, checkKey, setKey } from './ai.js';
import {
  broadcastStep, createBroadcast, getBroadcast, processBatch, progressKb, progressText, setProgressMessage, stopBroadcast,
} from './broadcast.js';
import {
  botLink, botTitle, getBot, isBotKey, listBots,
} from './catalog.js';
import { childCall } from './children.js';
import {
  announceCampaign, botsLabel, createCampaign, getCampaign, levelLabel, listCampaigns, stopCampaign,
} from './club.js';
import { hubChat, pushAllConfigs, pushConfig } from './hubout.js';
import {
  getIncident, listIncidents, openIncident, resolveIncident, sourceName,
} from './incidents.js';
import {
  abuseQueue, ban, banScopeName, dismissFlag, markReviewed, unban, userDossier, warnUser,
} from './moderation.js';
import { KINDS, announce, kindOf, subscriberCount } from './news.js';
import { logChat } from './notify.js';
import {
  TICKET_STATUS, VERDICTS, closeTicket, confirmBug, countTickets, getTicket, listTickets, teamKb, teamReply, ticketMessages,
} from './reports.js';
import {
  clearState, getUser, getUserByUsername, isOwner, kvGet, setKv, setState, setUserField, teamIds,
} from './store.js';
import {
  answer, btn, call, del, describeError, grid, send, show,
} from './tg.js';
import {
  ago, esc, fa, formatDate, nowSec, toAsciiDigits, truncate,
} from './util.js';
import { wakeSoon, wakeStatus } from './wake.js';

const panelBtn = () => btn('🏠 پنل', 'a');
const ownerOnly = async (ctx, user) => {
  if (isOwner(user.user_id)) return true;
  await answer(ctx, '⛔️ فقط مالک ربات.', { alert: true });
  return false;
};

/** A user id from a message: a forward from them, a numeric id, or a @username the mother knows. */
export async function userIdFrom(msg) {
  const o = msg.forward_origin;
  if (o && o.type === 'user' && o.sender_user) return Number(o.sender_user.id);
  if (msg.forward_from) return Number(msg.forward_from.id);
  const text = toAsciiDigits(String(msg.text || '').trim());
  if (/^\d{5,15}$/.test(text)) return Number(text);
  if (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text)) {
    const u = await getUserByUsername(text);
    return u ? Number(u.user_id) : null;
  }
  return null;
}

/** A channel/group from a message: a forwarded post, @username, t.me link or -100 id. */
function chatRefFrom(msg) {
  const o = msg.forward_origin;
  if (o && (o.type === 'channel' || o.type === 'chat') && (o.chat || o.sender_chat)) return (o.chat || o.sender_chat).id;
  if (msg.forward_from_chat) return msg.forward_from_chat.id;
  const text = toAsciiDigits(String(msg.text || '').trim());
  if (/^-100\d{5,15}$/.test(text)) return Number(text);
  const m = /^(?:(?:https?:\/\/)?t\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(text);
  return m ? `@${m[1]}` : null;
}

async function myId(ctx) {
  const cached = await kvGet('bot_id');
  if (cached) return Number(cached);
  const me = await call(ctx, 'getMe', {}, 'getMe');
  await setKv('bot_id', me.id);
  await setKv('bot_username', me.username);
  return me.id;
}

// ---------- tickets ----------

async function ticketsHome(ctx) {
  const tabs = ['open', 'answered', 'user_side', 'resolved'];
  const counts = {};
  for (const s of tabs) counts[s] = await countTickets(s);
  const kb = tabs.map((s) => [btn(`${TICKET_STATUS[s]} (${fa(counts[s])})`, `at:${s}:0`)]);
  kb.push([panelBtn()]);
  return show(ctx, 'adm_tickets', '🎫 <b>تیکت‌ها</b>\n\n🟠 باز: منتظر تیم · 💬 پاسخ داده شد: منتظر کاربر · 💡 راهنمایی شد: کاربر هنوز نگفته حل شد یا نه', kb);
}

async function ticketsList(ctx, status, offset) {
  const rows = await listTickets(status, offset, 8);
  const lines = [`🎫 <b>${TICKET_STATUS[status] || status}</b>`, ''];
  for (const t of rows) lines.push(`#${fa(t.id)} ${t.bot_key ? `[${esc(t.bot_key)}] ` : ''}${{ report: '🛠', question: '❓', abuse: '🚨' }[t.kind] || ''} ${esc(truncate(t.body || '(فایل)', 50))} · ${ago(t.created_at)}`);
  if (!rows.length) lines.push('خالی است.');
  const kb = grid(rows.map((t) => btn(`#${fa(t.id)}`, `ati:${t.id}`)), 4);
  const nav = [];
  if (offset > 0) nav.push(btn('⬅️ قبلی', `at:${status}:${Math.max(0, offset - 8)}`));
  if (rows.length === 8) nav.push(btn('بعدی ➡️', `at:${status}:${offset + 8}`));
  if (nav.length) kb.push(nav);
  kb.push([btn('🎫 تیکت‌ها', 'at'), panelBtn()]);
  return show(ctx, 'adm_ticket_list', lines.join('\n'), kb);
}

async function ticketDetail(ctx, id) {
  const t = await getTicket(id);
  if (!t) return answer(ctx, 'تیکت پیدا نشد.', { alert: true });
  const bot = t.bot_key ? await getBot(t.bot_key) : null;
  const u = await getUser(t.user_id);
  const lines = [
    `🎫 <b>تیکت #${fa(t.id)}</b> — ${TICKET_STATUS[t.status] || t.status}`,
    bot ? `ربات: ${botTitle(bot)}` : '',
    `از: ${u ? esc(u.first_name || '') : ''}${u && u.username ? ` @${esc(u.username)}` : ''} <code>${t.user_id}</code>`,
    t.verdict ? `تشخیص: ${VERDICTS[t.verdict] || t.verdict}` : '',
    t.incident_id ? `اختلال: #${fa(t.incident_id)}` : '',
    `ثبت: ${formatDate(t.created_at, true)}`,
    '',
    esc(truncate(t.body || '(فایل)', 1500)),
  ].filter((x) => x !== '');
  for (const m of await ticketMessages(t.id)) lines.push('', `${m.from_team ? '💬 تیم' : '👤 کاربر'} (${ago(m.at)}):`, esc(truncate(m.body || '', 500)));
  return show(ctx, 'adm_ticket', truncate(lines.join('\n'), 3900), [...teamKb(t), [btn('🎫 تیکت‌ها', 'at'), panelBtn()]]);
}

// ---------- incidents ----------

async function incidentsView(ctx) {
  const open = await listIncidents('open', 10);
  const done = await listIncidents('resolved', 5);
  const lines = ['🟡 <b>اختلال‌ها</b>', ''];
  for (const i of open) lines.push(`🟠 #${fa(i.id)} [${esc(i.bot_key)}] ${esc(truncate(i.title || '', 60))} · ${fa(i.reports)} گزارش · ${ago(i.started_at)}`);
  if (!open.length) lines.push('اختلال بازی نیست ✅');
  if (done.length) {
    lines.push('', '<b>اخیراً حل‌شده:</b>');
    for (const i of done) lines.push(`✅ #${fa(i.id)} [${esc(i.bot_key)}] ${esc(truncate(i.title || '', 50))} · ${ago(i.resolved_at)}`);
  }
  const kb = open.map((i) => [btn(`#${fa(i.id)} ${i.bot_key}`, `aii:${i.id}`), btn('✅ حل شد', `aix:${i.id}`)]);
  kb.push([btn('➕ ثبت اختلال', 'ain')], [panelBtn()]);
  return show(ctx, 'adm_incidents', lines.join('\n'), kb);
}

async function incidentDetail(ctx, id) {
  const i = await getIncident(id);
  if (!i) return answer(ctx, 'پیدا نشد.', { alert: true });
  const bot = await getBot(i.bot_key);
  const w = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM watchers WHERE kind = 'inc' AND ref = ${String(i.id)} LIMIT 100000)`);
  const lines = [
    `🟡 <b>اختلال #${fa(i.id)}</b> — ${i.status === 'open' ? '🟠 باز' : '✅ حل‌شده'}`,
    `ربات: ${bot ? botTitle(bot) : esc(i.bot_key)}`,
    `منبع: ${esc(sourceName(i.source))} · شروع: ${formatDate(i.started_at, true)}`,
    i.resolved_at ? `حل: ${formatDate(i.resolved_at, true)}` : '',
    `گزارش‌ها: ${fa(i.reports)} · منتظر خبر: ${fa(Number((w && w.n) || 0))}`,
    '',
    esc(i.title || ''),
  ].filter((x) => x !== '');
  const kb = [];
  if (i.status === 'open') kb.push([btn('✅ حل شد (به همه خبر بده)', `aix:${i.id}`)]);
  kb.push([btn('🟡 اختلال‌ها', 'ai'), panelBtn()]);
  return show(ctx, 'adm_incident', lines.join('\n'), kb);
}

// ---------- users ----------

async function userCard(ctx, viewer, uid) {
  const d = await userDossier(uid);
  const u = d.user;
  const lines = [`👤 <b>کاربر</b> <code>${uid}</code>`];
  if (u) {
    lines.push(`${esc(u.first_name || '')}${u.username ? ` @${esc(u.username)}` : ''}`);
    lines.push(`ربات مادر: ${u.started ? (u.blocked ? '⛔️ بلاک کرده' : '✅ استارت کرده') : '— استارت نکرده'} · اولین/آخرین: ${formatDate(u.first_seen)} / ${ago(u.last_seen)}`);
    if (Number(u.role)) lines.push('👥 عضو تیم');
    if (Number(u.club)) lines.push(`🎁 باشگاه: ${fa(Number(u.points))} امتیاز`);
    if (Number(u.warns)) lines.push(`⚠️ اخطارها: ${fa(Number(u.warns))}`);
    if (u.note) lines.push(`📝 یادداشت: ${esc(u.note)}`);
  } else {
    lines.push('(این کاربر هنوز با ربات مادر یا ربات‌های وصل‌شده دیده نشده)');
  }
  lines.push('', `🚨 گزارش سوءاستفاده: ${fa(d.flagCount)} · گزارش کاربران علیه او: ${fa(d.reportsAgainst)} · تیکت‌های خودش: ${fa(d.tickets)}`);
  if (d.bans.length) {
    lines.push('', '<b>بن‌های فعال:</b>');
    for (const b of d.bans) lines.push(`⛔️ ${esc(await banScopeName(b.scope))} — ${Number(b.until) ? `تا ${formatDate(b.until, true)}` : 'دائم'}${b.reason ? ` (${esc(b.reason)})` : ''}`);
  }
  if (d.bots.length) {
    lines.push('', '<b>ربات‌ها:</b>');
    for (const b of d.bots) lines.push(`${b.emoji || '🤖'} ${esc(b.name || b.bot_key)}: ${fa(b.uses)} بار · ${ago(b.last_at)}${b.blocked ? ' · بلاک کرده' : ''}`);
  }
  if (d.flags.length) {
    lines.push('', '<b>آخرین گزارش‌ها:</b>');
    for (const f of d.flags) lines.push(`• ${ago(f.at)} [${esc(f.bot_key || 'mother')}] ${esc(truncate(f.reason || '', 40))} ${f.detail ? `— ${esc(truncate(f.detail, 80))}` : ''}`);
  }
  const kb = [
    [btn('⚠️ اخطار', `auw:${uid}`), btn('📝 یادداشت', `aun:${uid}`)],
    [btn('⛔️ ۱ ساعت', `aub:${uid}:*:3600`), btn('⛔️ ۱ روز', `aub:${uid}:*:86400`), btn('⛔️ ۷ روز', `aub:${uid}:*:604800`)],
    [btn('🚫 بن دائم (همه‌ی ربات‌ها)', `aub:${uid}:*:0`), btn('🎯 بن در یک ربات', `aubs:${uid}`)],
    [btn('✅ رفع همه‌ی بن‌ها', `auu:${uid}`), btn('✔️ بررسی شد', `aur:${uid}`)],
  ];
  if (isOwner(viewer.user_id) && u && uid !== OWNER_ID) kb.push([btn(Number(u.role) ? '👥 حذف از تیم' : '👥 عضو تیم شود', `aut:${uid}`)]);
  kb.push([btn('🔎 کاربر دیگر', 'au'), panelBtn()]);
  return show(ctx, 'adm_user', truncate(lines.join('\n'), 3900), kb);
}

async function abuseView(ctx) {
  const rows = await abuseQueue(8);
  const lines = ['🗂 <b>صف گزارش‌های سوءاستفاده</b>', ''];
  for (const f of rows) lines.push(`#${fa(f.id)} <code>${f.user_id}</code> [${esc(f.bot_key || 'mother')}] ${{ bot: '🤖', user: '👤', team: '👥' }[f.source] || ''} ${esc(truncate(f.reason || '', 40))} · ${ago(f.at)}${f.detail ? `\n   ${esc(truncate(f.detail, 100))}` : ''}`);
  if (!rows.length) lines.push('صف خالی است ✅');
  const kb = rows.map((f) => [btn(`👤 ${f.user_id}`, `au:${f.user_id}`), btn('✖️ رد', `aqd:${f.id}`)]);
  kb.push([panelBtn()]);
  return show(ctx, 'adm_abuse', truncate(lines.join('\n'), 3900), kb);
}

// ---------- forced join ----------

async function joinHome(ctx) {
  const on = (await kvGet('join_on')) !== '0';
  const globalRows = await db.all(sql`SELECT * FROM channels WHERE scope = '*' ORDER BY id LIMIT ${MAX_CHANNELS_PER_SCOPE}`);
  const lines = [
    '📢 <b>عضویت اجباری مرکزی</b>',
    '',
    'کانال‌هایی که این‌جا تعریف می‌کنی از طریق هاب به همه‌ی ربات‌های وصل‌شده می‌رسد و آن‌ها اعمالش می‌کنند. هر ربات می‌تواند کانال‌های اختصاصی خودش را هم داشته باشد.',
    'ربات فرزند باید در کانال ادمین باشد (بدون آن تلگرام اجازه‌ی بررسی عضویت نمی‌دهد).',
    'خود ربات مادر کسی را قفل نمی‌کند تا همه بتوانند سؤال بپرسند و خطا گزارش بدهند.',
    '',
    `کانال‌های سراسری: ${on ? '✅ روشن' : '⏸ خاموش'}`,
  ];
  for (const c of globalRows) lines.push(`• ${esc(c.title || '')} ${c.username ? `@${esc(c.username)}` : `<code>${c.chat_id}</code>`}`);
  if (!globalRows.length) lines.push('• (هیچ)');
  const bots = await listBots({ team: true });
  const kb = [
    [btn('🌐 کانال‌های سراسری', 'aj:*'), btn(on ? '⏸ خاموش کردن سراسری' : '▶️ روشن کردن سراسری', 'ajt')],
    ...grid(bots.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `aj:${b.key}`)), 2),
    [panelBtn()],
  ];
  return show(ctx, 'adm_join', lines.join('\n'), kb);
}

async function joinScope(ctx, scope) {
  const bot = scope === '*' ? null : await getBot(scope);
  if (scope !== '*' && !bot) return null;
  const rows = await db.all(sql`SELECT * FROM channels WHERE scope = ${scope} ORDER BY id LIMIT ${MAX_CHANNELS_PER_SCOPE}`);
  const lines = [`📢 <b>${scope === '*' ? 'کانال‌های سراسری (همه‌ی ربات‌ها)' : `کانال‌های اختصاصی ${esc(bot.name)}`}</b>`, ''];
  let bots = scope === '*' ? (await listBots({ team: true })).filter((b) => b.token) : bot && bot.token ? [bot] : [];
  if (rows.length * bots.length > 24) {
    lines.push('(ربات‌های توکن‌دار زیادند؛ ادمین بودن را در صفحه‌ی کانال‌های هر ربات ببین)');
    bots = [];
  }
  for (const c of rows) {
    let adminInfo = '';
    if (bots.length) {
      const missing = [];
      for (const b of bots) {
        try {
          const m = await childCall(b, 'getChatMember', { chat_id: c.chat_id, user_id: b.tg_id }, ctx, 'join_check');
          if (!['administrator', 'creator'].includes(m.status)) missing.push(b.name);
        } catch {
          missing.push(b.name);
        }
      }
      adminInfo = missing.length ? `\n   ⚠️ ادمین نیست در: ${esc(missing.join('، '))}` : '\n   ✅ همه‌ی ربات‌های توکن‌دار ادمین‌اند';
    }
    lines.push(`• ${esc(c.title || '')} ${c.username ? `@${esc(c.username)}` : `<code>${c.chat_id}</code>`}${adminInfo}`);
  }
  if (!rows.length) lines.push('هیچ کانالی نیست.');
  const kb = rows.map((c) => [btn(`🗑 ${truncate(c.title || c.username || String(c.chat_id), 30)}`, `ajd:${c.id}`)]);
  if (rows.length < MAX_CHANNELS_PER_SCOPE) kb.push([btn('➕ افزودن کانال', `aja:${scope}`)]);
  kb.push([btn('⬅️ عضویت اجباری', 'aj'), panelBtn()]);
  return show(ctx, 'adm_join_scope', truncate(lines.join('\n'), 3900), kb);
}

async function addChannel(ctx, user, scope, msg) {
  const ref = chatRefFrom(msg);
  if (!ref) return send(ctx, 'adm_join_bad', '⚠️ یوزرنیم کانال (@name)، لینک t.me، آیدی -100… یا یک پست فورواردشده از کانال را بفرست.');
  let chat;
  try {
    chat = await call(ctx, 'getChat', { chat_id: ref }, 'join_getchat');
  } catch (err) {
    return send(ctx, 'adm_join_bad', `⚠️ کانال پیدا نشد (${esc(describeError(err))}). برای کانال خصوصی، ربات مادر را هم عضو/ادمین کن یا یک پست از آن فوروارد کن.`);
  }
  const dup = await db.get(sql`SELECT id FROM channels WHERE scope = ${scope} AND chat_id = ${chat.id}`);
  if (dup) return send(ctx, 'adm_join_bad', 'این کانال قبلاً اضافه شده.');
  let invite = chat.invite_link || null;
  if (!chat.username && !invite) {
    try {
      invite = await call(ctx, 'exportChatInviteLink', { chat_id: chat.id }, 'join_invite');
    } catch {
      invite = null;
    }
  }
  await db.run(sql`INSERT INTO channels (scope, chat_id, username, title, invite, added_at) VALUES (${scope}, ${chat.id}, ${chat.username || null}, ${truncate(chat.title || '', 64)}, ${invite}, ${nowSec()})`);
  await clearState(user.user_id);
  const n = scope === '*' ? await pushAllConfigs(ctx) : (await pushConfig(ctx, scope)) ? 1 : 0;
  await send(ctx, 'adm_join_ok', `✅ ${esc(chat.title || '')} اضافه شد.${await hubChat() ? ` (به ${fa(n)} ربات خبر داده شد)` : '\n⚠️ کانال هاب تنظیم نیست؛ ربات‌ها هنوز خبردار نشده‌اند.'}${!chat.username && !invite ? '\n⚠️ کانال خصوصی است و لینک دعوت نگرفتم؛ ربات مادر را در آن ادمین کن.' : ''}`);
  ctx.messageId = null;
  return joinScope(ctx, scope);
}

// ---------- broadcast ----------

/** The parts of a team message that child bots can re-send. */
function rawOf(msg) {
  const text = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || null;
  if (msg.text) return { kind: 'text', text, entities };
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const p = msg.photo[msg.photo.length - 1];
    return { kind: 'photo', text, entities, fileId: p.file_id, size: p.file_size || 0, fileName: 'photo.jpg', mime: 'image/jpeg' };
  }
  for (const kind of ['video', 'animation', 'document', 'audio', 'voice']) {
    if (msg[kind]) {
      const f = msg[kind];
      return {
        kind, text, entities, fileId: f.file_id, size: f.file_size || 0, fileName: f.file_name || `${kind}.bin`, mime: f.mime_type || null,
      };
    }
  }
  return null;
}

async function bcTargets(ctx, st) {
  const bots = await listBots({ team: true });
  const sel = new Set(st.data.targets || []);
  const lines = ['📣 <b>پیام همگانی — مخاطب‌ها</b>', '', 'به کاربران چه ربات‌هایی برسد؟ از طرف هر ربات (با توکنش) فرستاده می‌شود. کسی که کاربر چند ربات انتخاب‌شده است فقط یک بار می‌گیرد.'];
  if (!st.data.raw) lines.push('⚠️ این نوع پیام فقط از طریق خود ربات مادر قابل ارسال است.');
  const kb = [[btn(`${sel.has('m') ? '✅' : '▫️'} 👥 کاربران ربات مادر`, 'abct:m')]];
  kb.push(...grid(bots.map((b) => btn(`${sel.has(`c:${b.key}`) ? '✅' : '▫️'} ${b.token ? '' : '🔒'}${b.name}`, `abct:c:${b.key}`)), 2));
  kb.push([btn('✅ ادامه', 'abcg'), btn('✖️ انصراف', 'a')]);
  return show(ctx, 'adm_bc_targets', lines.join('\n'), kb);
}

async function estimate(audiences) {
  let n = 0;
  for (const a of audiences) {
    if (a === 'm') {
      const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM users WHERE started = 1 AND blocked = 0 LIMIT 1000000)`);
      n += Number((r && r.n) || 0);
    } else if (a.startsWith('c:')) {
      const r = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM user_bots WHERE bot_key = ${a.slice(2)} AND blocked = 0 AND uses > 0 LIMIT 1000000)`);
      n += Number((r && r.n) || 0);
    } else if (a.startsWith('s:')) {
      n += await subscriberCount(a.split(':')[1]);
    }
  }
  return n;
}

/** Starts a broadcast with a progress message and sends the first batch at once. */
async function launch(ctx, user, opts) {
  const id = await createBroadcast({ ...opts, createdBy: user.user_id });
  const b = await getBroadcast(id);
  const m = await send(ctx, 'bc_progress', progressText(b), progressKb(b));
  if (m) await setProgressMessage(id, ctx.chatId, m.message_id);
  await broadcastStep(ctx, id, 25);
  return id;
}

// ---------- news ----------

async function newsPick(ctx) {
  const bots = await listBots({ team: true });
  const kb = [[btn('🌐 اخبار کلی Wanger (مشترکان «ربات‌های جدید و اخبار کلی»)', 'an:*')]];
  kb.push(...grid(bots.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `an:${b.key}`)), 2));
  kb.push([panelBtn()]);
  return show(ctx, 'adm_news', '📰 <b>خبر و اطلاعیه</b>\n\nفقط به کاربرانی می‌رسد که خبر آن ربات را روشن کرده‌اند و آن نوع خبر را می‌خواهند. خبر مربوط به کدام ربات است؟', kb);
}

// ---------- club ----------

const CAMPAIGN_TEMPLATE = `عنوان: تخفیف یلدا
درصد: 20
مدت: 7
نوع: شخصی
ربات‌ها: همه
سطح: 0`;

function parseCampaign(text) {
  const f = { personal: true, bots: '*', days: 7, minLevel: 0, maxUses: 0 };
  for (const raw of String(text || '').split('\n')) {
    const [k, ...rest] = raw.split(':');
    const v = toAsciiDigits(rest.join(':').trim());
    const key = k.trim();
    if (!v) continue;
    if (/عنوان|title/i.test(key)) f.title = v.slice(0, 80);
    else if (/درصد|percent|pct/i.test(key)) f.pct = Number(v.replace(/[٪%]/g, ''));
    else if (/مدت|روز|days/i.test(key)) f.days = Number(v.replace(/\D/g, ''));
    else if (/نوع|type/i.test(key)) {
      if (/شخصی|personal/i.test(v)) f.personal = true;
      else {
        f.personal = false;
        const m = /([A-Za-z0-9]{4,20})(?:\s+(\d+))?/.exec(v.replace(/مشترک|shared|کد/gi, ' '));
        if (m) {
          f.code = m[1].toUpperCase();
          if (m[2]) f.maxUses = Number(m[2]);
        }
      }
    } else if (/ربات|bots/i.test(key)) {
      if (/همه|all|\*/i.test(v)) f.bots = '*';
      else f.bots = v.split(/[,،\s]+/).map((s) => s.trim().toLowerCase()).filter(isBotKey);
    } else if (/سطح|level/i.test(key)) f.minLevel = Math.max(0, Math.min(LEVELS.length - 1, Number(v) || 0));
  }
  if (!f.title || !(f.pct >= 1 && f.pct <= 95) || !(f.days >= 1 && f.days <= 365)) return null;
  if (Array.isArray(f.bots) && !f.bots.length) f.bots = '*';
  return f;
}

async function clubAdmin(ctx) {
  const rows = await listCampaigns(8);
  const pct = Number(await kvGet('club_monthly_pct')) || 0;
  const members = await db.get(sql`SELECT count(*) AS n FROM (SELECT 1 FROM users WHERE club = 1 LIMIT 1000000)`);
  const lines = ['🎁 <b>باشگاه مشتریان</b>', '', `👥 اعضا: ${fa(Number((members && members.n) || 0))} · 📅 هدیه‌ی ماهانه: ${pct ? `${fa(pct)}٪` : 'خاموش'}`, '', '<b>کمپین‌ها:</b>'];
  for (const c of rows) lines.push(`${c.status === 'active' && (!c.ends_at || c.ends_at > nowSec()) ? '🟢' : '⚪️'} #${fa(c.id)} ${esc(c.title)} — ${fa(c.pct)}٪ · ${c.personal ? `${fa(c.claims)} کد گرفته شد` : `کد ${esc(c.code)}`} · ${fa(c.uses)} استفاده`);
  if (!rows.length) lines.push('هنوز کمپینی نیست.');
  const kb = rows.map((c) => [btn(`#${fa(c.id)} ${truncate(c.title, 30)}`, `aci:${c.id}`)]);
  kb.push([btn('➕ کمپین جدید', 'acn'), btn('📅 هدیه‌ی ماهانه', 'acm')], [panelBtn()]);
  return show(ctx, 'adm_club', lines.join('\n'), kb);
}

async function campaignDetail(ctx, id) {
  const c = await getCampaign(id);
  if (!c) return null;
  const lines = [
    `🎟 <b>${esc(c.title)}</b> (#${fa(c.id)})`,
    `${fa(c.pct)}٪ · ${c.personal ? 'کد شخصی برای هر عضو' : `کد مشترک <code>${esc(c.code)}</code>${c.max_uses ? ` (سقف ${fa(c.max_uses)})` : ''}`}`,
    `ربات‌ها: ${esc(await botsLabel(c))} · حداقل سطح: ${levelLabel(Number(c.min_level))}`,
    `از ${formatDate(c.starts_at)} تا ${formatDate(c.ends_at)} · ${c.status === 'active' ? '🟢 فعال' : '⛔️ متوقف'}`,
    `کد گرفته‌شده: ${fa(c.claims)} · استفاده: ${fa(c.uses)}`,
  ];
  const kb = [];
  if (c.status === 'active') kb.push([btn('📣 اعلام به اعضا', `aca:${c.id}`), btn('⛔️ توقف', `acs:${c.id}`)]);
  kb.push([btn('⬅️ باشگاه', 'ac'), panelBtn()]);
  return show(ctx, 'adm_campaign', lines.join('\n'), kb);
}

// ---------- settings ----------

async function settingsView(ctx) {
  const hub = await hubChat();
  const log = await logChat();
  const team = await teamIds();
  const ai = await kvGet('secret:gemini');
  const w = await wakeStatus();
  const lines = [
    '⚙️ <b>تنظیمات</b>',
    '',
    `📡 کانال هاب: ${hub ? `<code>${hub}</code> ${esc((await kvGet('hub_title')) || '')}` : '⚠️ تنظیم نشده'}`,
    `📋 چت لاگ تیم: ${log ? `<code>${log}</code>` : 'پی‌وی اعضای تیم'}`,
    `👥 تیم: ${fa(team.length)} نفر (مالک + ${fa(team.length - 1)})`,
    `🤖 هوش مصنوعی: ${ai ? ((await kvGet('ai_on')) === '0' ? '⏸ خاموش' : '✅ روشن') : 'کلید ندارد (/aikey KEY)'}`,
    `📰 خبر خودکار وضعیت (اختلال/تعمیر/رفع): ${(await kvGet('auto_news')) === '0' ? '⏸ خاموش' : '✅ روشن'}`,
    `🧹 پاک کردن پیام‌های هاب بعد از خواندن: ${(await kvGet('hub_keep')) === '1' ? '⏸ خاموش' : '✅ روشن'}`,
    `⏱ بیدار شدن خودکار: ${fa(w.thisHour)} بار در این ساعت · آخرین ${ago(w.lastWake)}`,
  ];
  const kb = [
    [btn('📡 تنظیم کانال هاب', 'axh'), btn('📋 تنظیم چت لاگ', 'axl')],
    [btn('👥 تیم', 'axt'), btn('🤖 هوش مصنوعی', 'axai')],
    [btn('📰 خبر خودکار', 'axn'), btn('🧹 پاک کردن هاب', 'axk')],
    [panelBtn()],
  ];
  return show(ctx, 'adm_settings', lines.join('\n'), kb);
}

async function teamView(ctx) {
  const ids = await teamIds();
  const lines = ['👥 <b>تیم</b>', '', 'اعضای تیم تیکت‌ها، اختلال‌ها، کاربران و وضعیت ربات‌ها را مدیریت می‌کنند. مالک: همه‌چیز.', ''];
  const kb = [];
  for (const id of ids) {
    const u = await getUser(id);
    lines.push(`${id === OWNER_ID ? '👑' : '👤'} ${esc((u && u.first_name) || '')} <code>${id}</code>`);
    if (id !== OWNER_ID) kb.push([btn(`🗑 ${truncate((u && u.first_name) || String(id), 20)}`, `axtd:${id}`)]);
  }
  kb.push([btn('➕ افزودن', 'axta'), btn('⬅️ تنظیمات', 'ax')]);
  return show(ctx, 'adm_team', lines.join('\n'), kb);
}

// ---------- callbacks of part 2 ----------

export async function adminCallback2(ctx, user, data, st) {
  const parts = data.split(':');
  const [cmd, a, b2, c3] = parts;
  switch (cmd) {
    // tickets
    case 'at':
      if (a) await ticketsList(ctx, a, Number(b2) || 0);
      else await ticketsHome(ctx);
      return true;
    case 'ati':
      await ticketDetail(ctx, a);
      return true;
    case 'atr': {
      const t = await getTicket(a);
      if (!t) return true;
      await setState(user.user_id, 'adm_reply', { tid: t.id });
      await send(ctx, 'adm_reply_prompt', `✉️ جواب تیکت #${fa(t.id)} را بفرست (متن). برای کاربر فرستاده می‌شود.`, [[btn('✖️ انصراف', `ati:${t.id}`)]]);
      await answer(ctx);
      return true;
    }
    case 'atx':
      await answer(ctx, (await closeTicket(ctx, a, { byTeam: true })) ? '✅ بسته شد و به کاربر خبر داده شد.' : 'قبلاً بسته شده.');
      await ticketDetail(ctx, a);
      return true;
    case 'atb': {
      const inc = await confirmBug(ctx, a);
      await answer(ctx, inc ? `🚨 به اختلال #${inc.id} وصل شد.` : 'نشد.');
      await ticketDetail(ctx, a);
      return true;
    }
    // incidents
    case 'ai':
      await incidentsView(ctx);
      return true;
    case 'aii':
      await incidentDetail(ctx, a);
      return true;
    case 'aix':
      await answer(ctx, (await resolveIncident(ctx, a)) ? '✅ حل شد؛ به منتظران خبر داده می‌شود.' : 'قبلاً حل شده.');
      await incidentsView(ctx);
      return true;
    case 'ain':
      if (a) {
        await setState(user.user_id, 'adm_incident', { key: a });
        await show(ctx, 'adm_incident_new', '🟡 شرح کوتاه اختلال را بفرست (کاربرانی که گزارش بدهند می‌بینند که مشکل شناخته‌شده است).', [[btn('✖️ انصراف', 'ai')]]);
      } else {
        const bots = await listBots({ team: true });
        await show(ctx, 'adm_incident_pick', '🟡 اختلال در کدام ربات؟', [...grid(bots.map((b) => btn(b.name, `ain:${b.key}`)), 2), [btn('⬅️', 'ai')]]);
      }
      return true;
    // users
    case 'au':
      if (a) {
        await userCard(ctx, user, Number(a));
      } else {
        await setState(user.user_id, 'adm_lookup');
        await show(ctx, 'adm_lookup', '🔎 آیدی عددی، @یوزرنیم یا یک پیام فورواردشده از کاربر را بفرست.', [[panelBtn()]]);
      }
      return true;
    case 'auw':
      await setState(user.user_id, 'adm_warn', { uid: Number(a) });
      await send(ctx, 'adm_warn_prompt', `⚠️ متن اخطار برای <code>${esc(a)}</code> را بفرست.`, [[btn('✖️ انصراف', `au:${a}`)]]);
      await answer(ctx);
      return true;
    case 'aun':
      await setState(user.user_id, 'adm_note', { uid: Number(a) });
      await send(ctx, 'adm_note_prompt', `📝 یادداشت درباره‌ی <code>${esc(a)}</code> را بفرست («-» = پاک کردن).`, [[btn('✖️ انصراف', `au:${a}`)]]);
      await answer(ctx);
      return true;
    case 'aub': {
      const uid = Number(a);
      if (uid === OWNER_ID || (await teamIds()).includes(uid)) {
        await answer(ctx, 'عضو تیم را نمی‌شود بن کرد.', { alert: true });
        return true;
      }
      const r = await ban(ctx, uid, b2, Number(c3) || 0, 'تیم', user.user_id);
      await answer(ctx, `⛔️ بن شد${r.until ? ` تا ${formatDate(r.until, true)}` : ' (دائم)'}${r.pushed || b2 === 'mother' ? '' : ' — ⚠️ هاب تنظیم نیست'}`, { alert: true });
      await userCard(ctx, user, uid);
      return true;
    }
    case 'aubs': {
      const bots = await listBots({ team: true });
      await show(ctx, 'adm_ban_scope', `🎯 بن <code>${esc(a)}</code> در کدام ربات؟ (۷ روز؛ برای دائم «🚫» را بزن)`, [
        [btn('🤖 فقط ربات مادر (۷ روز)', `aub:${a}:mother:604800`)],
        ...bots.map((b) => [btn(`${b.name} — ۷ روز`, `aub:${a}:${b.key}:604800`), btn('🚫 دائم', `aub:${a}:${b.key}:0`)]),
        [btn('⬅️', `au:${a}`)],
      ]);
      return true;
    }
    case 'auu': {
      const scopes = await unban(ctx, Number(a));
      await answer(ctx, scopes.length ? '✅ بن‌ها برداشته شد.' : 'بنی نداشت.');
      await userCard(ctx, user, Number(a));
      return true;
    }
    case 'aur':
      await markReviewed(Number(a));
      await answer(ctx, '✔️ از صف برداشته شد.');
      await userCard(ctx, user, Number(a));
      return true;
    case 'aut': {
      if (!(await ownerOnly(ctx, user))) return true;
      const u = await getUser(Number(a));
      if (u) await setUserField(u.user_id, 'role', Number(u.role) ? 0 : 1);
      await userCard(ctx, user, Number(a));
      return true;
    }
    case 'aq':
      await abuseView(ctx);
      return true;
    case 'aqd':
      await dismissFlag(a);
      await answer(ctx, 'رد شد.');
      await abuseView(ctx);
      return true;
    default:
      break;
  }
  if (!isOwner(user.user_id) && !['an', 'ank', 'any', 'annb'].includes(cmd)) {
    if (/^(aj|abc|ac|ax)/.test(cmd)) {
      await answer(ctx, '⛔️ فقط مالک ربات.', { alert: true });
      return true;
    }
    return false;
  }
  switch (cmd) {
    // forced join
    case 'aj':
      if (a) await joinScope(ctx, a);
      else await joinHome(ctx);
      return true;
    case 'ajt': {
      const on = (await kvGet('join_on')) !== '0';
      await setKv('join_on', on ? '0' : '1');
      await pushAllConfigs(ctx);
      await joinHome(ctx);
      return true;
    }
    case 'aja':
      await setState(user.user_id, 'adm_join', { scope: a });
      await show(ctx, 'adm_join_add', '➕ یوزرنیم کانال (@name)، لینک t.me، آیدی -100… یا یک پست فورواردشده از کانال را بفرست.', [[btn('✖️ انصراف', `aj:${a}`)]]);
      return true;
    case 'ajd': {
      const row = await db.get(sql`SELECT * FROM channels WHERE id = ${Number(a)}`);
      if (row) {
        await db.run(sql`DELETE FROM channels WHERE id = ${row.id}`);
        if (row.scope === '*') await pushAllConfigs(ctx);
        else await pushConfig(ctx, row.scope);
      }
      await answer(ctx, '🗑 حذف شد.');
      await joinScope(ctx, row ? row.scope : '*');
      return true;
    }
    // broadcast
    case 'abc':
      await setState(user.user_id, 'adm_bc');
      await show(ctx, 'adm_bc', '📣 <b>پیام همگانی</b>\n\nپیام را بفرست (متن، عکس، ویدیو، فایل، گیف، ویس یا آهنگ؛ آلبوم نه). بعد مخاطب‌ها را انتخاب می‌کنی.', [[btn('✖️ انصراف', 'a')]]);
      return true;
    case 'abct': {
      if (!st || st.name !== 'adm_bc_targets') return true;
      const target = parts.slice(1).join(':');
      if (target.startsWith('c:')) {
        const bot = await getBot(target.slice(2));
        if (!bot || !bot.token) {
          await answer(ctx, '🔒 این ربات توکن ندارد؛ اول توکنش را در صفحه‌ی ربات ثبت کن.', { alert: true });
          return true;
        }
        if (!st.data.raw) {
          await answer(ctx, 'این نوع پیام را فقط ربات مادر می‌تواند بفرستد.', { alert: true });
          return true;
        }
      }
      const sel = new Set(st.data.targets || []);
      if (sel.has(target)) sel.delete(target);
      else sel.add(target);
      st.data.targets = [...sel];
      await setState(user.user_id, 'adm_bc_targets', st.data);
      await bcTargets(ctx, st);
      return true;
    }
    case 'abcg': {
      if (!st || st.name !== 'adm_bc_targets' || !(st.data.targets || []).length) {
        await answer(ctx, 'حداقل یک مخاطب انتخاب کن.', { alert: true });
        return true;
      }
      const n = await estimate(st.data.targets);
      await show(ctx, 'adm_bc_confirm', `📣 پیام برای حدود <b>${fa(n)}</b> نفر فرستاده شود؟\n(پیام بالا پیش‌نمایش است.)`, [[btn('✅ بله، بفرست', 'abcy'), btn('✖️ انصراف', 'a')]]);
      return true;
    }
    case 'abcy': {
      if (!st || st.name !== 'adm_bc_targets') return true;
      const content = { copy: st.data.copy, raw: st.data.raw || null };
      await clearState(user.user_id);
      await answer(ctx, '🚀 شروع شد.');
      await launch(ctx, user, { kind: 'broadcast', title: 'پیام همگانی', content, audiences: st.data.targets });
      return true;
    }
    case 'abcc': {
      const r = await processBatch(ctx, Number(a), 25);
      await answer(ctx, r.ran ? '▶️ یک دسته فرستاده شد.' : 'الان در حال ارسال است یا منتظر محدودیت تلگرام.');
      if (r.ran && !r.done) await wakeSoon(ctx, 'broadcast');
      if (r.b) await show(ctx, 'bc_progress', progressText(r.b), progressKb(r.b));
      return true;
    }
    case 'abcs':
      await stopBroadcast(Number(a));
      await answer(ctx, '⛔️ متوقف شد.');
      await show(ctx, 'bc_progress', progressText(await getBroadcast(Number(a))), [[panelBtn()]]);
      return true;
    // club
    case 'ac':
      await clubAdmin(ctx);
      return true;
    case 'aci':
      await campaignDetail(ctx, a);
      return true;
    case 'acn':
      await setState(user.user_id, 'adm_camp');
      await show(ctx, 'adm_camp', `➕ <b>کمپین تخفیف</b>\n\nاین قالب را کپی، ویرایش و ارسال کن:\n<code>${esc(CAMPAIGN_TEMPLATE)}</code>\n\n• نوع: «شخصی» (هر عضو کد خودش را می‌گیرد، یک‌بار مصرف) یا «مشترک YALDA 100» (یک کد برای همه، با سقف اختیاری)\n• ربات‌ها: «همه» یا کلیدها با کاما، مثلاً <code>media, music</code>\n• سطح: ${LEVELS.map((l, i) => `${fa(i)}=${l.name}`).join('، ')}`, [[btn('✖️ انصراف', 'ac')]]);
      return true;
    case 'aca': {
      const c = await getCampaign(a);
      if (c) {
        const id = await announceCampaign(c, user.user_id);
        await answer(ctx, `📣 در صف ارسال (#${id}).`);
      }
      await campaignDetail(ctx, a);
      return true;
    }
    case 'acs':
      await answer(ctx, (await stopCampaign(ctx, a)) ? '⛔️ متوقف شد؛ کدها از ربات‌ها برداشته شد.' : 'قبلاً متوقف شده.');
      await campaignDetail(ctx, a);
      return true;
    case 'acm':
      await show(ctx, 'adm_club_monthly', '📅 <b>هدیه‌ی ماهانه</b>\n\nاول هر ماه شمسی، خودکار یک کمپین کد شخصی (۱۰ روزه، همه‌ی ربات‌ها) برای همه‌ی اعضای باشگاه ساخته و به آن‌ها خبر داده می‌شود. درصد:', [
        [0, 5, 10, 15, 20, 30].map((p) => btn(p ? `${fa(p)}٪` : 'خاموش', `acmp:${p}`)),
        [btn('⬅️ باشگاه', 'ac')],
      ]);
      return true;
    case 'acmp':
      await setKv('club_monthly_pct', Number(a) || 0);
      await answer(ctx, Number(a) ? `✅ ${a}٪` : '⏸ خاموش');
      await clubAdmin(ctx);
      return true;
    // news (team too)
    case 'an':
      if (a) {
        const target = a === '*' ? null : await getBot(a);
        if (a !== '*' && !target) return true;
        await show(ctx, 'adm_news_kind', `📰 نوع خبر (${a === '*' ? 'اخبار کلی' : esc(target.name)}):`, [
          ...KINDS.map((k) => [btn(`${k.emoji} ${k.name}`, `ank:${a}:${k.bit}`)]),
          [btn('⬅️', 'an')],
        ]);
      } else {
        await newsPick(ctx);
      }
      return true;
    case 'ank':
      await setState(user.user_id, 'adm_news', { key: a, bit: Number(b2) });
      await show(ctx, 'adm_news_content', `${kindOf(b2).emoji} متن یا پیام خبر را بفرست (متن، عکس با کپشن، ویدیو…). بعد تعداد مشترکان را می‌بینی و تأیید می‌کنی.`, [[btn('✖️ انصراف', 'an')]]);
      return true;
    case 'any': {
      if (!st || st.name !== 'adm_news_ready') return true;
      await clearState(user.user_id);
      await answer(ctx, '🚀 در صف ارسال.');
      const bot = st.data.key === '*' ? null : await getBot(st.data.key);
      const kb = bot && botLink(bot) ? [[{ text: `🚀 ${bot.name}`, url: botLink(bot) }]] : null;
      await launch(ctx, user, {
        kind: 'news', title: `${kindOf(st.data.bit).name}${bot ? ` — ${bot.name}` : ''}`, content: { copy: st.data.copy, kb }, audiences: [`s:${st.data.key}:${st.data.bit}`],
      });
      return true;
    }
    case 'annb': {
      if (!(await ownerOnly(ctx, user))) return true;
      const bot = await getBot(a);
      if (!bot) return true;
      const html = `🆕 <b>ربات جدید Wanger: ${esc(bot.name)}</b>${bot.username ? ` — @${esc(bot.username)}` : ''}\n\n${esc(bot.description || bot.short || '')}`;
      const kb = [[btn('ℹ️ معرفی و راهنما', `b:${bot.key}`)]];
      if (botLink(bot)) kb.unshift([{ text: `🚀 باز کردن ${bot.name}`, url: botLink(bot) }]);
      const id = await announce({ botKey: '*', kind: 1, content: { html, kb }, title: `ربات جدید: ${bot.name}`, createdBy: user.user_id });
      await answer(ctx, `🆕 برای مشترکان «ربات‌های جدید» در صف ارسال (#${id}). ${await subscriberCount('*')} مشترک.`, { alert: true });
      return true;
    }
    // settings
    case 'ax':
      await clearState(user.user_id);
      await settingsView(ctx);
      return true;
    case 'axh':
      await setState(user.user_id, 'adm_hub');
      await show(ctx, 'adm_hub', [
        '📡 <b>کانال هاب</b>',
        '',
        '۱. یک کانال <b>خصوصی</b> بساز (مثلاً «Wanger Hub»).',
        '۲. ربات مادر را ادمین کن (ارسال و حذف پیام).',
        '۳. هر ربات فرزند را هم ادمین کن (ارسال پیام).',
        '۴. یک پست از آن کانال این‌جا فوروارد کن (یا آیدی -100… را بفرست).',
        '',
        'هر کس بتواند در هاب پست بگذارد می‌تواند از طرف ربات‌ها حرف بزند؛ پس فقط خودت و ربات‌ها ادمین باشید.',
      ].join('\n'), [[btn('✖️ انصراف', 'ax')]]);
      return true;
    case 'axl':
      await setState(user.user_id, 'adm_log');
      await show(ctx, 'adm_log', '📋 <b>چت لاگ تیم</b>\n\nهشدارها، خطاها، تیکت‌ها و گزارش‌های سوءاستفاده آن‌جا می‌آیند.\n• کانال خصوصی: ربات مادر را ادمین کن و یک پست از آن فوروارد کن.\n• گروه تیم: ربات مادر را عضو کن و در گروه بنویس /setlog\n• «-» = برگشت به پی‌وی اعضای تیم', [[btn('✖️ انصراف', 'ax')]]);
      return true;
    case 'axt':
      await teamView(ctx);
      return true;
    case 'axta':
      await setState(user.user_id, 'adm_team');
      await show(ctx, 'adm_team_add', '👥 آیدی عددی، @یوزرنیم (کسی که ربات مادر را استارت کرده) یا پیام فورواردشده از عضو جدید را بفرست.', [[btn('✖️ انصراف', 'axt')]]);
      return true;
    case 'axtd':
      if (Number(a) !== OWNER_ID) await setUserField(Number(a), 'role', 0);
      await teamView(ctx);
      return true;
    case 'axai': {
      const has = !!(await kvGet('secret:gemini'));
      const on = (await kvGet('ai_on')) !== '0';
      if (has && b2 === 't') await setKv('ai_on', on ? '0' : '1');
      const now = has && (b2 === 't' ? !on : on);
      await show(ctx, 'adm_ai', `🤖 <b>هوش مصنوعی (Gemini)</b>\n\n${has ? `کلید: ✅ · ${now ? 'روشن' : 'خاموش'}${(await aiReady(null)) ? '' : ' (الان در دسترس نیست: سقف روزانه یا مکث بعد از 429)'}` : 'کلید ندارد.'}\n\nتنظیم: <code>/aikey KEY</code> (پیامت فوراً پاک می‌شود) · حذف: <code>/aikey off</code>\nکلید رایگان: aistudio.google.com\n\nبدون کلید هم دستیار با جستجوی کلمات از روی اطلاعات ربات‌ها جواب می‌دهد.`, [
        ...(has ? [[btn(now ? '⏸ خاموش کن' : '▶️ روشن کن', 'axai:x:t')]] : []),
        [btn('⬅️ تنظیمات', 'ax')],
      ]);
      return true;
    }
    case 'axn':
      await setKv('auto_news', (await kvGet('auto_news')) === '0' ? '1' : '0');
      await settingsView(ctx);
      return true;
    case 'axk':
      await setKv('hub_keep', (await kvGet('hub_keep')) === '1' ? '0' : '1');
      await settingsView(ctx);
      return true;
    default:
      return false;
  }
}

/** Part-2 text steps. */
export async function adminText2(ctx, user, st, msg) {
  const text = String(msg.text || '').trim();
  switch (st.name) {
    case 'adm_reply': {
      if (!text) return send(ctx, 'adm_reply_bad', 'فقط متن.');
      const ok = await teamReply(ctx, user, st.data.tid, text);
      await clearState(user.user_id);
      await send(ctx, 'adm_reply_ok', ok ? `✅ جواب برای کاربر فرستاده شد (تیکت #${fa(st.data.tid)}).` : '⚠️ کاربر پیام را دریافت نکرد (ربات را بلاک کرده یا استارت نکرده).', [[btn('🎫 تیکت', `ati:${st.data.tid}`), panelBtn()]]);
      return true;
    }
    case 'adm_incident': {
      const { incident, created } = await openIncident(ctx, st.data.key, truncate(text, 200), 'manual', { quiet: true });
      await clearState(user.user_id);
      await send(ctx, 'adm_incident_ok', created ? `🟡 اختلال #${fa(incident.id)} ثبت شد.` : `این ربات اختلال باز دارد (#${fa(incident.id)}).`, [[btn('👁', `aii:${incident.id}`), panelBtn()]]);
      return true;
    }
    case 'adm_lookup': {
      const uid = await userIdFrom(msg);
      if (!uid) return send(ctx, 'adm_lookup_bad', '⚠️ پیدا نشد. آیدی عددی یا پیام فورواردشده بفرست (یوزرنیم فقط برای کسانی که ربات مادر را استارت کرده‌اند).');
      await clearState(user.user_id);
      ctx.messageId = null;
      await userCard(ctx, user, uid);
      return true;
    }
    case 'adm_warn': {
      if (!text) return send(ctx, 'adm_warn_bad', 'فقط متن.');
      const via = await warnUser(ctx, st.data.uid, truncate(text, 1000));
      await clearState(user.user_id);
      await send(ctx, 'adm_warn_ok', via ? `✅ اخطار فرستاده شد (از طریق ${via === 'mother' ? 'ربات مادر' : esc(via)}).` : '⚠️ نشد اخطار را برسانم (کاربر ربات مادر را استارت نکرده و ربات توکن‌داری هم به او دسترسی ندارد). اخطار ثبت شد.', [[btn('👤', `au:${st.data.uid}`)]]);
      return true;
    }
    case 'adm_note':
      await setUserField(st.data.uid, 'note', text === '-' ? null : truncate(text, 300));
      await clearState(user.user_id);
      ctx.messageId = null;
      await userCard(ctx, user, st.data.uid);
      return true;
    default:
      break;
  }
  if (!isOwner(user.user_id) && !['adm_news'].includes(st.name)) return false;
  switch (st.name) {
    case 'adm_join':
      await addChannel(ctx, user, st.data.scope, msg);
      return true;
    case 'adm_bc': {
      if (msg.media_group_id) return send(ctx, 'adm_bc_bad', 'آلبوم پشتیبانی نمی‌شود؛ یک پیام تکی بفرست.');
      const data = { copy: { chat: msg.chat.id, mid: msg.message_id }, raw: rawOf(msg), targets: ['m'] };
      await setState(user.user_id, 'adm_bc_targets', data);
      ctx.messageId = null;
      await bcTargets(ctx, { name: 'adm_bc_targets', data });
      return true;
    }
    case 'adm_news': {
      const data = { ...st.data, copy: { chat: msg.chat.id, mid: msg.message_id } };
      await setState(user.user_id, 'adm_news_ready', data);
      const n = await subscriberCount(st.data.key);
      await send(ctx, 'adm_news_confirm', `📰 برای مشترکان این بخش (${fa(n)} نفر، با فیلتر نوع خبر) فرستاده شود؟`, [[btn('✅ بفرست', 'any'), btn('✖️ انصراف', 'an')]]);
      return true;
    }
    case 'adm_camp': {
      const f = parseCampaign(text);
      if (!f) return send(ctx, 'adm_camp_bad', '⚠️ عنوان، درصد (۱ تا ۹۵) و مدت (روز) لازم است. قالب را دوباره ببین.');
      const c = await createCampaign(ctx, f);
      if (!c) return send(ctx, 'adm_camp_bad', '⚠️ این کد قبلاً استفاده شده؛ کد دیگری بنویس.');
      await clearState(user.user_id);
      await send(ctx, 'adm_camp_ok', `✅ کمپین #${fa(c.id)} ساخته شد.`, [[btn('📣 اعلام به اعضا', `aca:${c.id}`), btn('👁', `aci:${c.id}`)]]);
      return true;
    }
    case 'adm_hub':
    case 'adm_log': {
      const isLog = st.name === 'adm_log';
      if (isLog && text === '-') {
        await setKv('log_chat', null);
        await clearState(user.user_id);
        return send(ctx, 'adm_log_ok', '✅ پیام‌های تیم به پی‌وی اعضای تیم می‌رود.', [[btn('⬅️ تنظیمات', 'ax')]]);
      }
      const ref = chatRefFrom(msg);
      if (!ref) return send(ctx, 'adm_chat_bad', '⚠️ یک پست از کانال فوروارد کن یا آیدی -100… را بفرست.');
      let chat;
      let me;
      try {
        chat = await call(ctx, 'getChat', { chat_id: ref }, 'hub_getchat');
        me = await call(ctx, 'getChatMember', { chat_id: chat.id, user_id: await myId(ctx) }, 'hub_me');
      } catch (err) {
        return send(ctx, 'adm_chat_bad', `⚠️ به این کانال دسترسی ندارم (${esc(describeError(err))}). اول ربات مادر را ادمین کن.`);
      }
      if (!['administrator', 'creator'].includes(me.status)) return send(ctx, 'adm_chat_bad', '⚠️ ربات مادر در این کانال ادمین نیست.');
      await setKv(isLog ? 'log_chat' : 'hub_chat', chat.id);
      if (!isLog) await setKv('hub_title', truncate(chat.title || '', 64));
      await clearState(user.user_id);
      if (!isLog) {
        await send(ctx, 'adm_hub_ok', `✅ کانال هاب: ${esc(chat.title || '')}\n\nحالا هر ربات فرزند را در این کانال ادمین کن و فایل <code>client/mother-client.js</code> را با <code>HUB_CHAT = ${chat.id}</code> در آن قرار بده (راهنما: mother_bot/client/README.md). برای هر ربات «🔄 همگام‌سازی هاب» را بزن.`, [[btn('⬅️ تنظیمات', 'ax')]]);
        await pushAllConfigs(ctx);
      } else {
        await send(ctx, 'adm_log_ok', `✅ چت لاگ: ${esc(chat.title || '')}`, [[btn('⬅️ تنظیمات', 'ax')]]);
        await send(ctx, 'log_hello', '📋 از این به بعد پیام‌های تیم ربات مادر این‌جا می‌آید.', null, chat.id);
      }
      return true;
    }
    case 'adm_team': {
      const uid = await userIdFrom(msg);
      const u = uid ? await getUser(uid) : null;
      if (!u) return send(ctx, 'adm_team_bad', '⚠️ این کاربر را نمی‌شناسم؛ اول باید ربات مادر را استارت کند.');
      await setUserField(uid, 'role', 1);
      await clearState(user.user_id);
      await send(ctx, 'adm_team_ok', `✅ ${esc(u.first_name || '')} به تیم اضافه شد.`);
      await send(ctx, 'team_hello', '👥 به تیم Wanger اضافه شدی. /admin پنل را باز می‌کند.', null, uid);
      ctx.messageId = null;
      await teamView(ctx);
      return true;
    }
    default:
      return false;
  }
}

/** /aikey KEY | off (owner): the message is deleted at once. */
export async function aiKeyCommand(ctx, msg, arg) {
  await del(ctx, msg.chat.id, msg.message_id, 'delete_key');
  if (!arg) return send(ctx, 'aikey_usage', `🤖 کلید Gemini: ${(await kvGet('secret:gemini')) ? '✅ دارد' : 'ندارد'}\nتنظیم: <code>/aikey KEY</code> · حذف: <code>/aikey off</code>`);
  if (arg === 'off') {
    await setKey(null);
    return send(ctx, 'aikey_off', '🗑 کلید پاک شد؛ دستیار با جستجوی کلمات جواب می‌دهد.');
  }
  const state = await checkKey(arg);
  if (state === 'rejected') return send(ctx, 'aikey_bad', '⛔️ گوگل این کلید را قبول نکرد.');
  await setKey(arg);
  await setKv('ai_on', '1');
  return send(ctx, 'aikey_ok', `✅ کلید ذخیره شد${state === 'ok' ? ' و کار می‌کند' : ' (بررسی نشد؛ شبکه)'}. پیامت پاک شد.`);
}
