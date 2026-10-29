// The bot's private chat: welcome, help, forced-join screen, history, whisper details (with the
// snoopers list for the sender), settings and the block list. Everything here except reading a
// whisper (deep link) needs forced-join membership; the owner panel lives in admin.js.
import {
  DEFAULT_EXPIRY_CHOICES, HISTORY_LIMIT, HISTORY_PAGE, MAX_BLOCKS,
} from './config.js';
import { botInfo } from './bot.js';
import { channelUrl, checkJoin } from './join.js';
import {
  addBlock, clearState, getRcpts, getUser, getUserByUsername, getWhisper, listBlocks, listSnoops, rcptsFor,
  receivedHistory, removeBlock, sentHistory, setDefExpiry, setReceipts, setState,
} from './store.js';
import { MAIN_HINT, helpText, welcomeText } from './texts.js';
import {
  answer, btn, inlineBtn, send, show, urlBtn,
} from './tg.js';
import { rcptHtml, roleOf } from './whisper.js';
import {
  esc, fa, faAgo, faDuration, isId, nowSec, toAsciiDigits, truncate,
} from './util.js';

const back = (data = 'm') => [btn('🔙 بازگشت', data)];

export function mainMenu() {
  return [
    [inlineBtn('✍️ ارسال نجوا')],
    [btn('📤 ارسالی‌ها', 'h:s:0'), btn('📥 دریافتی‌ها', 'h:r:0')],
    [btn('⚙️ تنظیمات', 'st'), btn('🚫 لیست بلاک', 'bl')],
    [btn('❓ راهنما', 'hp')],
  ];
}

// ---------- forced join ----------

/** The lock screen: one link button per missing channel and a re-check button. */
export async function showJoin(ctx, missing) {
  const kb = missing.map((ch) => [urlBtn(`📢 ${truncate(ch.title || ch.username, 40)}`, channelUrl(ch))]);
  kb.push([btn('✅ عضو شدم', 'j')]);
  const list = missing.map((ch) => `• @${esc(ch.username)}`).join('\n');
  return show(ctx, 'join',
    '🔒 <b>برای استفاده از ربات اول عضو این کانال‌ها شو:</b>\n\n'
    + `${list}\n\n`
    + 'بعد از عضویت دکمه‌ی «✅ عضو شدم» را بزن. (برای خواندن نجواهایی که برایت فرستاده‌اند عضویت لازم نیست.)', kb);
}

/** Runs the join check for a PM feature; shows the lock screen and returns false if not joined. */
export async function requireJoin(ctx, user, kv, opts = {}) {
  const j = await checkJoin(ctx, user, kv, opts);
  if (j.ok) return true;
  await showJoin(ctx, j.missing);
  return false;
}

/** "✅ عضو شدم": a fresh check. */
export async function recheckJoin(ctx, user, kv) {
  const j = await checkJoin(ctx, user, kv, { fresh: true });
  if (!j.ok) {
    await answer(ctx, '❌ هنوز عضو همه‌ی کانال‌ها نیستی.', { alert: true });
    return showJoin(ctx, j.missing);
  }
  await answer(ctx, '✅ عضویت تأیید شد!');
  return showWelcome(ctx, user, kv, true);
}

// ---------- welcome / help ----------

export async function showWelcome(ctx, user, kv, joinedNow = false) {
  const bot = await botInfo(ctx, kv);
  const head = joinedNow ? '✅ عضویتت تأیید شد؛ حالا می‌توانی نجوا بفرستی.\n\n' : '';
  return show(ctx, 'welcome', head + welcomeText(user.firstName, bot.username), mainMenu());
}

export async function showHelp(ctx, kv) {
  const bot = await botInfo(ctx, kv);
  return show(ctx, 'help', helpText(bot.username), [back()]);
}

export async function showHint(ctx) {
  return send(ctx, 'hint', `🤫 ${MAIN_HINT}`, mainMenu());
}

// ---------- history ----------

function statusOf(w, now) {
  if (w.state === 1) return '🔥 سوزانده شد';
  if (w.state === 2 || (w.expiresAt && now >= w.expiresAt)) return '⌛️ منقضی شد';
  return '';
}

function flagsOf(w) {
  const f = [];
  if (w.once) f.push('🔥');
  if (w.expiresAt) f.push('⏳');
  return f.join('');
}

/** Sent (kind 's') or received ('r') whispers, newest first, 10 per page, at most the last 20. */
export async function showHistory(ctx, user, kind, page) {
  const now = nowSec();
  const p = Math.max(0, Math.min(Number(page) || 0, Math.ceil(HISTORY_LIMIT / HISTORY_PAGE) - 1));
  const lines = [];
  const pick = [];
  let total = 0;
  if (kind === 's') {
    const all = await sentHistory(user.id, HISTORY_LIMIT);
    total = all.length;
    const items = all.slice(p * HISTORY_PAGE, (p + 1) * HISTORY_PAGE);
    const rc = await rcptsFor(items.map((w) => w.id));
    items.forEach((w, i) => {
      const n = p * HISTORY_PAGE + i + 1;
      const rcpts = rc.get(w.id) || [];
      const seen = rcpts.filter((r) => r.seenAt).length;
      const status = statusOf(w, now);
      const body = w.body != null && w.state === 0 ? esc(w.body) : `<i>${status || 'متن پاک شده'}</i>`;
      const meta = [`👁 ${fa(seen)}/${fa(rcpts.length)}`];
      if (w.snoops) meta.push(`👀 ${fa(w.snoops)}`);
      if (status && w.body != null) meta.push(status);
      lines.push(`<b>${fa(n)}.</b> ${flagsOf(w)} به ${rcpts.map(rcptHtml).join('، ')} — ${faAgo(w.createdAt, now)}\n${body}\n<i>${meta.join(' • ')}</i>`);
      pick.push(btn(fa(n), `d:${w.id}`));
    });
  } else {
    const all = await receivedHistory(user, HISTORY_LIMIT);
    total = all.length;
    all.slice(p * HISTORY_PAGE, (p + 1) * HISTORY_PAGE).forEach(({ whisper: w, sender }, i) => {
      const n = p * HISTORY_PAGE + i + 1;
      const status = statusOf(w, now);
      let body;
      if (status) body = `<i>${status}</i>`;
      else if (w.once) body = '<i>🔥 یک‌بار مصرف — فقط با دکمه‌ی خود نجوا باز می‌شود</i>';
      else body = esc(w.body || '');
      const from = sender ? (sender.username ? `@${esc(sender.username)}` : esc(sender.firstName || sender.id)) : esc(w.senderId);
      lines.push(`<b>${fa(n)}.</b> ${flagsOf(w)} از ${from} — ${faAgo(w.createdAt, now)}\n${body}`);
      pick.push(btn(fa(n), `d:${w.id}`));
    });
  }
  const title = kind === 's' ? '📤 <b>نجواهای ارسالی</b>' : '📥 <b>نجواهای دریافتی</b>';
  if (!lines.length) {
    const empty = kind === 's' ? 'هنوز نجوایی نفرستاده‌ای.' : 'هنوز نجوایی برایت نیامده.';
    return show(ctx, kind === 's' ? 'history_sent' : 'history_received', `${title}\n\n${empty}`, [back()], { meta: { total: 0 } });
  }
  const kb = [];
  for (let i = 0; i < pick.length; i += 5) kb.push(pick.slice(i, i + 5));
  const nav = [];
  if (p > 0) nav.push(btn('◀️ قبلی', `h:${kind}:${p - 1}`));
  if ((p + 1) * HISTORY_PAGE < total) nav.push(btn('بعدی ▶️', `h:${kind}:${p + 1}`));
  if (nav.length) kb.push(nav);
  kb.push([btn(kind === 's' ? '📥 دریافتی‌ها' : '📤 ارسالی‌ها', `h:${kind === 's' ? 'r' : 's'}:0`), ...back()]);
  // At most 10 items of ≤256 characters: well under Telegram's 4096 visible characters. Never cut
  // HTML here — a cut tag or &amp; would make Telegram reject the whole message.
  const text = `${title} (${fa(total)} مورد آخر)\nبرای جزئیات، شماره را بزن.\n\n${lines.join('\n\n')}`;
  const meta = { total, page: p, shown: pick.length, ids: pick.map((b) => b.callback_data.slice(2)) };
  return show(ctx, kind === 's' ? 'history_sent' : 'history_received', text, kb, { secret: true, meta });
}

// ---------- details & snoopers ----------

/** One whisper, for its sender (full details) or a recipient (what they may see). */
export async function showDetails(ctx, user, wid) {
  const w = isId(wid, 8, 9) ? await getWhisper(wid) : null;
  const rcpts = w ? await getRcpts(w.id) : [];
  const role = w ? roleOf(w, rcpts, { id: user.id, username: user.username }) : { kind: 'snooper' };
  if (!w || role.kind === 'snooper') {
    await answer(ctx, 'این نجوا مال تو نیست 😏', { alert: true });
    return null;
  }
  const now = nowSec();
  const status = statusOf(w, now);
  const lines = [];
  const kb = [];
  if (role.kind === 'sender') {
    lines.push(`📤 <b>نجوای شما</b> — ${faAgo(w.createdAt, now)}`);
    lines.push(w.body != null && w.state === 0 ? `\n${esc(w.body)}\n` : `\n<i>${status || 'متن پاک شده'}</i>\n`);
    lines.push('<b>گیرنده‌ها:</b>');
    for (const r of rcpts) lines.push(`• ${rcptHtml(r)} — ${r.seenAt ? `👁 دید (${faAgo(r.seenAt, now)})` : 'هنوز ندیده'}`);
    if (w.once) lines.push('🔥 یک‌بار مصرف');
    if (w.expiresAt) lines.push(w.state === 0 && now < w.expiresAt ? `⏳ تا ${faDuration(w.expiresAt - now)} دیگر باز می‌شود` : '⌛️ منقضی شد');
    lines.push(`👀 فضول‌ها: ${fa(w.snoops)}`);
    if (w.snoops) kb.push([btn(`👀 دیدن فضول‌ها (${fa(w.snoops)})`, `n:${w.id}`)]);
  } else {
    const sender = await getUser(w.senderId);
    const name = sender ? (sender.username ? `@${sender.username}` : sender.firstName || String(sender.id)) : String(w.senderId);
    lines.push(`📥 <b>نجوا از <a href="tg://user?id=${w.senderId}">${esc(name)}</a></b> — ${faAgo(w.createdAt, now)}`);
    if (status) lines.push(`\n<i>${status}</i>`);
    else if (w.once) lines.push('\n<i>🔥 یک‌بار مصرف — فقط با دکمه‌ی خود نجوا باز می‌شود.</i>');
    else lines.push(`\n${esc(w.body || '')}`);
    kb.push([btn('🚫 بلاک فرستنده', `bk:${w.senderId}`)]);
  }
  kb.push([btn('🔙 تاریخچه', role.kind === 'sender' ? 'h:s:0' : 'h:r:0')]);
  const meta = { id: w.id, role: role.kind, state: w.state, seen: rcpts.filter((r) => r.seenAt).length, rcpts: rcpts.length, snoops: w.snoops };
  return show(ctx, 'whisper_details', lines.join('\n'), kb, { secret: true, meta });
}

/** Who pressed the button although it wasn't for them — the sender only. */
export async function showSnoopers(ctx, user, wid) {
  const w = isId(wid, 8, 9) ? await getWhisper(wid) : null;
  if (!w || w.senderId !== user.id) {
    await answer(ctx, 'این نجوا مال تو نیست 😏', { alert: true });
    return null;
  }
  const list = await listSnoops(w.id, 30);
  const now = nowSec();
  const lines = list.map((s, i) => {
    const name = s.username ? `@${esc(s.username)}` : `<a href="tg://user?id=${s.id}">${esc(s.firstName || s.id)}</a>`;
    return `${fa(i + 1)}. ${name} — <code>${s.id}</code> — ${faAgo(s.at, now)}`;
  });
  const more = w.snoops > list.length ? `\n… و ${fa(w.snoops - list.length)} نفر دیگر` : '';
  const text = list.length
    ? `👀 <b>فضول‌های این نجوا (${fa(w.snoops)})</b>\nاین‌ها دکمه را زدند ولی گیرنده نبودند:\n\n${lines.join('\n')}${more}`
    : '👀 هنوز کسی فضولی نکرده.';
  return show(ctx, 'snoopers', text, [[btn('🔙 جزئیات', `d:${w.id}`)]]);
}

// ---------- settings ----------

const expiryLabel = (sec) => (sec ? faDuration(sec) : 'بدون انقضا');

export async function showSettings(ctx, user) {
  const kb = [
    [btn(`📬 رسید خواندن: ${user.receipts ? 'روشن ✅' : 'خاموش ❌'}`, 'st:r')],
    DEFAULT_EXPIRY_CHOICES.slice(0, 3).map((s) => btn(`${s === user.defExpiry ? '✅ ' : ''}${expiryLabel(s)}`, `st:e:${s}`)),
    DEFAULT_EXPIRY_CHOICES.slice(3).map((s) => btn(`${s === user.defExpiry ? '✅ ' : ''}${expiryLabel(s)}`, `st:e:${s}`)),
    back(),
  ];
  return show(ctx, 'settings',
    '⚙️ <b>تنظیمات</b>\n\n'
    + `📬 <b>رسید خواندن:</b> ${user.receipts ? 'روشن' : 'خاموش'}\n`
    + 'وقتی گیرنده نجوایت را باز کند در همین‌جا خبرت می‌کنم.\n\n'
    + `⏳ <b>انقضای پیش‌فرض:</b> ${expiryLabel(user.defExpiry)}\n`
    + 'برای نجواهایی که خودت زمان (مثل 30m) نمی‌نویسی.', kb);
}

export async function toggleReceipts(ctx, user) {
  user.receipts = !user.receipts;
  await setReceipts(user.id, user.receipts);
  await answer(ctx, user.receipts ? '📬 رسید خواندن روشن شد' : '📭 رسید خواندن خاموش شد');
  return showSettings(ctx, user);
}

export async function setExpiry(ctx, user, sec) {
  const s = Number(sec);
  if (!DEFAULT_EXPIRY_CHOICES.includes(s)) return answer(ctx, '⚠️ گزینه‌ی نامعتبر');
  user.defExpiry = s;
  await setDefExpiry(user.id, s);
  await answer(ctx, `⏳ انقضای پیش‌فرض: ${expiryLabel(s)}`);
  return showSettings(ctx, user);
}

// ---------- block list ----------

export async function showBlocks(ctx, user, note = '') {
  const list = await listBlocks(user.id);
  const kb = list.map((b) => [btn(`🔓 آنبلاک ${b.username ? `@${b.username}` : b.firstName || b.id}`.slice(0, 60), `ub:${b.id}`)]);
  kb.push([btn('➕ بلاک با آیدی یا یوزرنیم', 'bl:add')]);
  kb.push(back());
  const lines = list.map((b, i) => `${fa(i + 1)}. ${b.username ? `@${esc(b.username)}` : esc(b.firstName || '—')} — <code>${b.id}</code>`);
  const body = list.length ? lines.join('\n') : 'لیست بلاک خالی است.';
  return show(ctx, 'blocks',
    `${note ? `${note}\n\n` : ''}🚫 <b>لیست بلاک</b> (${fa(list.length)} از ${fa(MAX_BLOCKS)})\n`
    + 'کسانی که اینجا هستند نمی‌توانند برایت نجوا بسازند.\n\n' + body, kb);
}

export async function blockUser(ctx, user, targetId) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === user.id) return answer(ctx, '⚠️ نامعتبر');
  const r = await addBlock(user.id, id);
  if (r === 'full') return answer(ctx, `⚠️ لیست بلاک پر است (حداکثر ${fa(MAX_BLOCKS)}).`, { alert: true });
  await answer(ctx, r === 'dup' ? 'قبلاً بلاک شده بود.' : '🚫 بلاک شد؛ دیگر نمی‌تواند برایت نجوا بسازد.', { alert: r !== 'dup' });
  return showBlocks(ctx, user);
}

export async function unblockUser(ctx, user, targetId) {
  await removeBlock(user.id, Number(targetId));
  await answer(ctx, '🔓 آنبلاک شد');
  return showBlocks(ctx, user);
}

export async function askBlock(ctx, user) {
  await setState(user.id, 'block_add');
  await answer(ctx);
  return show(ctx, 'block_ask',
    '🚫 آیدی عددی یا یوزرنیم (@username) کسی را که می‌خواهی بلاک کنی بفرست.\n'
    + 'یوزرنیم فقط وقتی کار می‌کند که آن شخص قبلاً با ربات کار کرده باشد.', [[btn('❌ انصراف', 'bl')]]);
}

/** The reply to "➕ بلاک با آیدی یا یوزرنیم". */
export async function onBlockInput(ctx, user, text) {
  const t = toAsciiDigits(String(text || '').trim());
  let target = null;
  if (/^[1-9][0-9]{4,15}$/.test(t)) target = Number(t);
  else {
    const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(t);
    if (m) {
      const u = await getUserByUsername(m[1].toLowerCase());
      if (!u) return send(ctx, 'block_unknown', '❓ این یوزرنیم را نمی‌شناسم. آیدی عددی‌اش را بفرست یا /cancel.');
      target = u.id;
    }
  }
  if (!target) return send(ctx, 'block_invalid', '⚠️ یک آیدی عددی یا @username بفرست، یا /cancel.');
  await clearState(user.id);
  if (target === user.id) return send(ctx, 'block_invalid', '🙃 خودت را نمی‌شود بلاک کرد.', [back('bl')]);
  const r = await addBlock(user.id, target);
  const note = r === 'ok' ? `🚫 <code>${target}</code> بلاک شد.` : r === 'dup' ? 'قبلاً بلاک شده بود.' : `⚠️ لیست بلاک پر است (حداکثر ${fa(MAX_BLOCKS)}).`;
  ctx.messageId = null;
  return showBlocks(ctx, user, note);
}
