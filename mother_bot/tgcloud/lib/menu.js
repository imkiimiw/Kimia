// Screens for users: the main menu, the catalog (categories, newest, a bot's page, its features and
// FAQ), the status board, news subscriptions, the club, the profile with activity history, and the
// user's tickets. Each view returns { text, kb }; the router shows it (lib/tg.js show).
import { LEVELS } from './config.js';
import { userBotsOf } from './activity.js';
import {
  CATEGORIES, STATUS, botLink, botTitle, categoryOf, effectiveStatus, getBot, listBots, newestBots,
} from './catalog.js';
import {
  botsLabel, campaignsFor, levelLabel, levelOf, myCodes,
} from './club.js';
import { MODES } from './access.js';
import { openIncidentOf } from './incidents.js';
import { KINDS, isSubscribed, subButton, subsOf } from './news.js';
import { TICKET_STATUS, ticketMessages, userTickets } from './reports.js';
import { isTeam, kvGet } from './store.js';
import { btn, grid, urlBtn } from './tg.js';
import {
  ago, esc, fa, formatDate, nowSec, truncate,
} from './util.js';

const home = () => [btn('🏠 منوی اصلی', 'm')];

export async function mainMenu(user) {
  const name = esc(truncate(user.first_name || 'دوست', 30));
  const text = [
    `👋 سلام ${name}!`,
    '',
    'من <b>ربات مادر Wanger</b> هستم و همه‌ی ربات‌های Wanger را می‌شناسم.',
    '',
    '💬 هر سؤالی درباره‌ی ربات‌ها داری <b>همین‌جا بنویس</b>؛ مثلاً «دانلودر کدوم رباته؟»، «چطور نجوا بفرستم؟» یا اسم یک ربات.',
    '🛠 اگر رباتی درست کار نکرد، گزارش بده تا بررسی کنیم.',
  ].join('\n');
  const kb = [
    [btn('🤖 ربات‌ها', 'b'), btn('💬 سؤال بپرس', 'ask')],
    [btn('🛠 گزارش خطا', 'r'), btn('📶 وضعیت ربات‌ها', 'st')],
    [btn('🔔 اطلاع‌رسانی‌ها', 'n'), btn('🎁 باشگاه مشتریان', 'c')],
    [btn('👤 پروفایل من', 'p'), btn('🚨 گزارش کاربر مزاحم', 'ua')],
  ];
  if (isTeam(user)) kb.push([btn('⚙️ پنل مدیریت', 'a')]);
  return { text, kb };
}

export function askPrompt() {
  return {
    text: '💬 سؤالت را بنویس.\n\nمثلاً:\n• «با کدوم ربات از اینستاگرام دانلود کنم؟»\n• «توی ربات موزیک چطور خواننده رو دنبال کنم؟»\n• «ربات نجوا جواب نمیده»\n• «آخرین ربات‌ها کدوم‌ان؟»',
    kb: [home()],
  };
}

export async function helpView() {
  const ai = !!(await kvGet('secret:gemini')) && (await kvGet('ai_on')) !== '0';
  const lines = [
    '❓ <b>راهنمای ربات مادر</b>',
    '',
    '• <b>سؤال:</b> هر چیزی درباره‌ی ربات‌های Wanger بنویس؛ ربات مناسب، قابلیت و طرز استفاده‌اش را می‌گویم.',
    '• <b>/bots</b> فهرست ربات‌ها، تازه‌ترین‌ها و دسته‌ها',
    '• <b>/status</b> وضعیت ربات‌ها (فعال، اختلال، تعمیر)',
    '• <b>/report</b> گزارش خطای یک ربات؛ بررسی می‌کنم مشکل از ربات است یا راه‌حلش دست خودت است',
    '• <b>/news</b> اطلاع‌رسانی اختیاری: خبرهای ربات‌هایی که می‌خواهی',
    '• <b>/club</b> باشگاه مشتریان: امتیاز و کد تخفیف اشتراک',
    '• <b>/profile</b> ربات‌هایی که بیشتر استفاده کرده‌ای',
  ];
  if (ai) lines.push('', '🤖 جواب سؤال‌ها با کمک هوش مصنوعی (Gemini گوگل) نوشته می‌شود؛ فقط متن سؤال فرستاده می‌شود، نه نام یا آیدی شما.');
  return { text: lines.join('\n'), kb: [home()] };
}

// ---------- catalog ----------

export async function botsHome(user) {
  const bots = await listBots({ team: isTeam(user) });
  const counts = new Map();
  for (const b of bots) counts.set(b.category, (counts.get(b.category) || 0) + 1);
  const cats = CATEGORIES.filter((c) => counts.get(c.id));
  const text = `🤖 <b>ربات‌های Wanger</b> (${fa(bots.length)} ربات)\n\nیک دسته را انتخاب کن، یا اسم کاری که می‌خواهی را بنویس.`;
  const kb = [[btn('🆕 تازه‌ترین‌ها', 'bn'), btn('📋 همه', 'al')]];
  kb.push(...grid(cats.map((c) => btn(`${c.emoji} ${c.name} (${fa(counts.get(c.id))})`, `bc:${c.id}`)), 2));
  kb.push(home());
  return { text, kb };
}

function botRows(bots) {
  return bots.map((b) => [btn(`${b.emoji || '🤖'} ${b.name}${b.hidden ? ' (مخفی)' : ''}`, `b:${b.key}`)]);
}

export async function categoryView(user, catId) {
  const cat = categoryOf(catId);
  const bots = (await listBots({ team: isTeam(user) })).filter((b) => (b.category || 'other') === cat.id || (cat.id === 'other' && !CATEGORIES.some((c) => c.id === b.category)));
  const lines = [`${cat.emoji} <b>${cat.name}</b>`, ''];
  for (const b of bots) lines.push(`${b.emoji || '🤖'} <b>${esc(b.name)}</b> — ${esc(b.short || '')}`);
  return { text: lines.join('\n'), kb: [...botRows(bots), [btn('⬅️ دسته‌ها', 'b')], home()] };
}

export async function allBotsView(user) {
  const bots = await listBots({ team: isTeam(user) });
  const lines = ['📋 <b>همه‌ی ربات‌ها</b>', ''];
  for (const b of bots) lines.push(`${b.emoji || '🤖'} <b>${esc(b.name)}</b>${b.username ? ` @${esc(b.username)}` : ''}\n${esc(b.short || '')}`);
  return { text: truncate(lines.join('\n'), 3900), kb: [...grid(bots.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `b:${b.key}`)), 2), [btn('⬅️ دسته‌ها', 'b')], home()] };
}

export async function newestView() {
  const bots = await newestBots(5);
  const lines = ['🆕 <b>تازه‌ترین ربات‌ها</b>', ''];
  for (const b of bots) lines.push(`${b.emoji || '🤖'} <b>${esc(b.name)}</b> — اضافه‌شده ${formatDate(b.added_at)}\n${esc(b.short || '')}`, '');
  return { text: lines.join('\n').trim(), kb: [...botRows(bots), [btn('⬅️ دسته‌ها', 'b')], home()] };
}

export async function botCard(user, key) {
  const bot = await getBot(key);
  if (!bot || (bot.hidden && !isTeam(user))) return null;
  const inc = await openIncidentOf(bot.key);
  const s = effectiveStatus(bot, inc);
  const lines = [
    `${botTitle(bot)}${bot.username ? `\n@${esc(bot.username)}` : ''}`,
    `${STATUS[s].emoji} ${STATUS[s].name}${s !== 'ok' && bot.status_note ? ` — ${esc(bot.status_note)}` : ''}${s === 'maint' && bot.mode_msg ? ` — ${esc(bot.mode_msg)}` : ''}`,
    '',
    esc(bot.description || bot.short || ''),
  ];
  if (bot.langs) lines.push('', `🌐 زبان‌ها: ${esc(bot.langs)}`);
  if (bot.features.length) {
    lines.push('', '<b>قابلیت‌ها:</b>');
    for (const f of bot.features.slice(0, 8)) lines.push(`• ${esc(f.t)}`);
  }
  if (!bot.username) lines.push('', '⏳ لینک عمومی این ربات هنوز اعلام نشده.');
  const kb = [];
  const link = botLink(bot);
  if (link) kb.push([urlBtn(`🚀 باز کردن ${bot.name}`, link)]);
  const row = [btn('📖 راهنمای قابلیت‌ها', `bf:${bot.key}`)];
  if (bot.faq.length) row.push(btn('❓ سؤالات رایج', `bq:${bot.key}`));
  kb.push(row);
  kb.push([subButton(await isSubscribed(user.user_id, bot.key), bot.key)]);
  if (s !== 'ok') kb.push([btn('🔔 وقتی درست شد خبرم کن', `stw:${bot.key}`)]);
  kb.push([btn('🛠 گزارش خطا', `r:${bot.key}`)]);
  kb.push([btn('⬅️ ربات‌ها', 'b'), btn('🏠 منو', 'm')]);
  return { text: lines.join('\n'), kb, bot };
}

export async function featuresView(user, key) {
  const bot = await getBot(key);
  if (!bot || (bot.hidden && !isTeam(user))) return null;
  const lines = [`📖 <b>راهنمای ${esc(bot.name)}</b>`, ''];
  if (!bot.features.length) lines.push('هنوز راهنمایی ثبت نشده. سؤالت را بنویس تا برای تیم بفرستم.');
  for (const f of bot.features) lines.push(`📌 <b>${esc(f.t)}</b>`, esc(f.h), '');
  const kb = [];
  const link = botLink(bot);
  if (link) kb.push([urlBtn(`🚀 باز کردن ${bot.name}`, link)]);
  kb.push([btn('⬅️ معرفی ربات', `b:${bot.key}`), btn('🏠 منو', 'm')]);
  return { text: truncate(lines.join('\n').trim(), 3900), kb };
}

export async function faqView(user, key) {
  const bot = await getBot(key);
  if (!bot || (bot.hidden && !isTeam(user))) return null;
  const lines = [`❓ <b>سؤالات رایج ${esc(bot.name)}</b>`, ''];
  for (const f of bot.faq) lines.push(`<b>${esc(f.q)}</b>`, esc(f.a), '');
  return { text: truncate(lines.join('\n').trim(), 3900), kb: [[btn('⬅️ معرفی ربات', `b:${bot.key}`), btn('🏠 منو', 'm')]] };
}

// ---------- status board ----------

export async function statusBoard(user) {
  const bots = await listBots({ team: isTeam(user) });
  const lines = ['📶 <b>وضعیت ربات‌های Wanger</b>', ''];
  const notOk = [];
  for (const b of bots) {
    const s = effectiveStatus(b, await openIncidentOf(b.key));
    let line = `${STATUS[s].emoji} ${esc(b.name)} — ${STATUS[s].name}`;
    if (s !== 'ok') {
      const note = b.mode === 'closed' ? b.mode_msg : b.status_note;
      if (note) line += `\n   ${esc(truncate(note, 120))}`;
      const until = b.mode === 'closed' ? b.mode_until : b.status_until;
      if (Number(until) > nowSec()) line += `\n   ⏳ تا ${formatDate(until, true)}`;
      if (s !== 'slow') notOk.push(b);
    }
    lines.push(line);
  }
  lines.push('', '🟢 فعال · 🟡 اختلال · 🔧 تعمیر · 🔴 قطع · ⏳ محدود');
  const kb = notOk.slice(0, 6).map((b) => [btn(`🔔 خبرم کن وقتی ${b.name} درست شد`, `stw:${b.key}`)]);
  kb.push([btn('🔄 تازه‌سازی', 'st'), btn('🛠 گزارش خطا', 'r')]);
  kb.push(home());
  return { text: lines.join('\n'), kb };
}

// ---------- news ----------

export async function newsView(user) {
  const subs = await subsOf(user.user_id);
  const bots = await listBots({ team: false });
  const kinds = KINDS.filter((k) => Number(user.news_kinds) & k.bit).map((k) => k.emoji).join(' ') || '—';
  const text = [
    '🔔 <b>اطلاع‌رسانی‌ها</b> (اختیاری)',
    '',
    'فقط خبر ربات‌هایی را می‌فرستم که خودت روشن کنی: آپدیت‌ها، قابلیت‌ها و زبان‌های تازه، اختلال و تعمیرات، و اطلاعیه‌های مهم.',
    '',
    `نوع خبرهایی که می‌گیری: ${kinds}`,
  ].join('\n');
  const kb = [[btn(`${subs.has('*') ? '✅' : '▫️'} 🆕 ربات‌های جدید و اخبار کلی Wanger`, 'nn:*')]];
  kb.push(...grid(bots.map((b) => btn(`${subs.has(b.key) ? '✅' : '▫️'} ${b.emoji || ''} ${b.name}`, `nn:${b.key}`)), 2));
  kb.push([btn('⚙️ نوع خبرها', 'nk')]);
  kb.push(home());
  return { text, kb };
}

export function kindsView(user) {
  const kb = KINDS.map((k) => [btn(`${Number(user.news_kinds) & k.bit ? '✅' : '▫️'} ${k.emoji} ${k.name}`, `nkt:${k.bit}`)]);
  kb.push([btn('⬅️ اطلاع‌رسانی‌ها', 'n'), btn('🏠 منو', 'm')]);
  return { text: '⚙️ <b>کدام نوع خبرها را بفرستم؟</b>\n(برای همه‌ی ربات‌هایی که روشن کرده‌ای)', kb };
}

// ---------- club ----------

export async function clubView(user) {
  if (!Number(user.club)) {
    const text = [
      '🎁 <b>باشگاه مشتریان Wanger</b>',
      '',
      'عضو شو تا:',
      '• با استفاده از ربات‌های Wanger <b>امتیاز</b> بگیری (هر روز فعالیت، دعوت دوستان، خرید اشتراک)',
      '• هر ماه و در مناسبت‌ها <b>کد تخفیف</b> خرید اشتراک بگیری',
      `• با امتیاز بیشتر به سطح‌های بالاتر برسی: ${LEVELS.map((l) => `${l.emoji} ${l.name}`).join('، ')}`,
      '',
      'عضویت رایگان است و هر وقت خواستی می‌توانی خارج شوی.',
    ].join('\n');
    return { text, kb: [[btn('✅ عضو می‌شوم', 'cj')], home()] };
  }
  const lvl = levelOf(user.points);
  const next = LEVELS[lvl + 1];
  const lines = [
    '🎁 <b>باشگاه مشتریان Wanger</b>',
    '',
    `سطح: ${levelLabel(lvl)} · امتیاز: <b>${fa(Number(user.points))}</b>`,
  ];
  if (next) lines.push(`تا ${next.emoji} ${next.name}: ${fa(next.min - Number(user.points))} امتیاز`);
  lines.push(`👥 دوستان دعوت‌شده: ${fa(Number(user.ref_count))}`);
  const camps = await campaignsFor(user);
  const kb = [];
  if (camps.length) {
    lines.push('', '<b>تخفیف‌های فعال:</b>');
    for (const c of camps) {
      lines.push(`🎟 ${esc(c.title)} — ${fa(c.pct)}٪ (${esc(await botsLabel(c))}) تا ${formatDate(c.ends_at)}${c.personal ? '' : `\nکد: <code>${esc(c.code)}</code>`}`);
      if (c.personal) kb.push([btn(`🎟 دریافت کد: ${truncate(c.title, 30)}`, `cc:${c.id}`)]);
    }
  } else {
    lines.push('', 'الان تخفیف فعالی نیست؛ تخفیف بعدی همین‌جا می‌آید.');
  }
  kb.push([btn('🎟 کدهای من', 'cm'), btn('🔗 لینک دعوت', 'cr')]);
  kb.push([btn('🚪 خروج از باشگاه', 'cl'), btn('🏠 منو', 'm')]);
  return { text: lines.join('\n'), kb };
}

export async function myCodesView(user) {
  const rows = await myCodes(user.user_id);
  const now = nowSec();
  const lines = ['🎟 <b>کدهای تخفیف من</b>', ''];
  if (!rows.length) lines.push('هنوز کدی نگرفته‌ای.');
  for (const r of rows) {
    const state = r.used_at ? `✅ استفاده شد${r.used_bot ? ` (${esc(r.used_bot)})` : ''}` : r.status !== 'active' || (r.ends_at && r.ends_at <= now) ? '⌛️ منقضی' : '🟢 فعال';
    lines.push(`<code>${esc(r.code)}</code> — ${fa(r.pct)}٪ · ${state}\n${esc(r.title)} · تا ${formatDate(r.ends_at)}`);
  }
  lines.push('', 'کد را موقع خرید اشتراک در ربات مربوط وارد کن.');
  return { text: lines.join('\n'), kb: [[btn('⬅️ باشگاه', 'c'), btn('🏠 منو', 'm')]] };
}

// ---------- profile ----------

export async function profileView(user) {
  const rows = await userBotsOf(user.user_id, 10);
  const used = rows.filter((r) => Number(r.uses) > 0);
  const lines = ['👤 <b>پروفایل من</b>', '', `عضو از: ${formatDate(user.first_seen)}`];
  if (Number(user.club)) lines.push(`🎁 باشگاه: ${levelLabel(levelOf(user.points))} · ${fa(Number(user.points))} امتیاز`);
  if (used.length) {
    lines.push('', '⭐ <b>ربات‌های محبوبت:</b>');
    used.slice(0, 3).forEach((r, i) => lines.push(`${['🥇', '🥈', '🥉'][i]} ${r.emoji || '🤖'} ${esc(r.name)} — ${fa(Number(r.uses))} بار`));
    lines.push('', '🕘 <b>تاریخچه‌ی استفاده:</b>');
    for (const r of used) lines.push(`${r.emoji || '🤖'} ${esc(r.name)}: ${fa(Number(r.uses))} بار · آخرین بار ${ago(r.last_at)}`);
  } else {
    lines.push('', 'هنوز از ربات‌های وصل‌شده به ربات مادر استفاده‌ای ثبت نشده.');
  }
  const viewed = rows.filter((r) => !Number(r.uses) && Number(r.views) > 0);
  if (viewed.length) lines.push('', `👀 بررسی کرده‌ای: ${viewed.map((r) => esc(r.name)).join('، ')}`);
  const all = await listBots({ team: false });
  const usedKeys = new Set(used.map((r) => r.bot_key));
  const suggest = all.filter((b) => !usedKeys.has(b.key) && b.username).slice(0, 3);
  const kb = [];
  if (suggest.length) {
    lines.push('', '✨ <b>هنوز امتحان نکرده‌ای:</b>');
    for (const b of suggest) lines.push(`${b.emoji || '🤖'} ${esc(b.name)} — ${esc(b.short || '')}`);
    kb.push(suggest.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `b:${b.key}`)));
  }
  kb.push([btn('🎫 گزارش‌های من', 'tl'), btn('🎁 باشگاه', 'c')]);
  kb.push(home());
  return { text: truncate(lines.join('\n'), 3900), kb };
}

// ---------- tickets ----------

export async function ticketsView(user) {
  const rows = await userTickets(user.user_id, 8);
  const lines = ['🎫 <b>گزارش‌ها و سؤال‌های من</b>', ''];
  if (!rows.length) lines.push('هنوز گزارشی نفرستاده‌ای.');
  for (const t of rows) lines.push(`#${fa(t.id)} · ${TICKET_STATUS[t.status] || t.status} · ${esc(truncate(t.body || '(فایل)', 40))}`);
  const kb = rows.map((t) => [btn(`#${fa(t.id)} ${TICKET_STATUS[t.status] || ''}`, `t:${t.id}`)]);
  kb.push([btn('🛠 گزارش جدید', 'r'), btn('🏠 منو', 'm')]);
  return { text: lines.join('\n'), kb };
}

export async function ticketView(user, t) {
  const bot = t.bot_key ? await getBot(t.bot_key) : null;
  const lines = [`🎫 <b>گزارش #${fa(t.id)}</b>${bot ? ` — ${botTitle(bot)}` : ''}`, `وضعیت: ${TICKET_STATUS[t.status] || t.status}`, `ثبت: ${formatDate(t.created_at, true)}`, '', esc(truncate(t.body || '(فایل)', 800))];
  for (const m of await ticketMessages(t.id)) lines.push('', `${m.from_team ? '💬 تیم' : '👤 شما'} (${ago(m.at)}):`, esc(truncate(m.body || '', 600)));
  const kb = [];
  if (['open', 'answered'].includes(t.status)) kb.push([btn('✉️ پیام به تیم', `tr:${t.id}`), btn('✅ حل شد', `tk:${t.id}`)]);
  kb.push([btn('⬅️ گزارش‌ها', 'tl'), btn('🏠 منو', 'm')]);
  return { text: truncate(lines.join('\n'), 3900), kb };
}

// ---------- report start ----------

export async function reportPick(user) {
  const bots = await listBots({ team: isTeam(user) });
  return {
    text: '🛠 <b>گزارش خطا</b>\n\nمشکل در کدام ربات است؟',
    kb: [...grid(bots.map((b) => btn(`${b.emoji || '🤖'} ${b.name}`, `r:${b.key}`)), 2), [btn('❔ نمی‌دانم / ربات دیگر', 'r:_')], home()],
  };
}

export async function reportPrompt(bot) {
  const lines = [];
  if (bot) {
    const s = effectiveStatus(bot, await openIncidentOf(bot.key));
    lines.push(`🛠 گزارش خطای ${botTitle(bot)}`);
    if (s !== 'ok') lines.push(`${STATUS[s].emoji} الان: ${STATUS[s].name}${bot.status_note ? ` — ${esc(bot.status_note)}` : ''}${bot.mode === 'closed' ? ` (${MODES.closed.name})` : ''}`);
  } else {
    lines.push('🛠 گزارش خطا');
  }
  lines.push('', 'مشکل را در یک پیام توضیح بده: چه کاری کردی، چه انتظاری داشتی و چه شد. اگر اسکرین‌شات داری، با همین توضیح (به‌عنوان کپشن) بفرست.');
  return { text: lines.join('\n'), kb: [[btn('✖️ انصراف', 'm')]] };
}
