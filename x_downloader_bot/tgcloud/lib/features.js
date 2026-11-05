// What users do: send links (one or up to MAX_LINKS per message), pick a quality for one post,
// get photos as original files, resend from history, change settings, see their profile.
// Every download job claims the user first (cooldown + one job at a time) and checks the daily
// quota before each post; the owner has no quota and no cooldown.
import { BUSY_SEC, COOLDOWN_SEC, DAILY_LIMIT, HISTORY_SIZE, MAX_LINKS, OWNER_ID, TZ_OFFSET_MIN, UPLOAD_MAX } from './config.js';
import { KIND_NAMES, deliverPost, getPost, kindOf, resultLine } from './deliver.js';
import { ensureSize, qualityLabel } from './media.js';
import { answer, btn, describeError, edit, remove, send, show, urlBtn } from './tg.js';
import { ago, esc, fa, short, sizeShort, today } from './text.js';
import { QUALITY_NAMES, failureText, helpText, mainMenu, menuBtn, welcomeText } from './ui.js';
import * as store from './store.js';

const isOwner = (id) => id === OWNER_ID;

export function showMenu(ctx, user, notice) {
  const text = notice ? `${notice}\n\n${welcomeText(user.firstName)}` : welcomeText(user.firstName);
  return show(ctx, 'menu', text, mainMenu(isOwner(user.id)));
}

export function showHelp(ctx, user) {
  return show(ctx, 'help', helpText(isOwner(user.id)), [[menuBtn()]]);
}

export function linkHint(ctx) {
  return send(ctx, 'hint',
    '🔗 لینک یک پست X (توییتر) را بفرستید تا رسانه‌اش را برایتان بفرستم.\nمثال: <code>https://x.com/NASA/status/2118034216503955710</code>',
    [[btn('❓ راهنما', 'h'), menuBtn()]]);
}

// ---------- quota & job lock ----------

function hoursToReset() {
  // Quotas reset at midnight Iran time.
  const msPerDay = 86400000;
  const offset = TZ_OFFSET_MIN * 60000;
  const local = Date.now() + offset;
  const left = msPerDay - (local % msPerDay);
  return Math.max(1, Math.ceil(left / 3600000));
}

function quotaText() {
  return `🚫 <b>سهمیه‌ی امروز شما تمام شد.</b>\n\nهر کاربر روزی ${fa(DAILY_LIMIT)} پست می‌تواند دریافت کند. `
    + `سهمیه حدود ${fa(hoursToReset())} ساعت دیگر (نیمه‌شب به وقت ایران) دوباره پر می‌شود.\n\n`
    + 'تا آن موقع، دانلودهای قبلی در 📜 تاریخچه هستند.';
}

const left = (user) => store.quotaLeft(user, DAILY_LIMIT, isOwner(user.id));

/** Claims the user for a job; on refusal tells them why (in a message or the button's answer). */
async function claim(ctx, user) {
  const r = await store.acquireJob(user.id, { cooldown: isOwner(user.id) ? 0 : COOLDOWN_SEC, busy: BUSY_SEC });
  if (r.ok) return true;
  const text = r.why === 'busy'
    ? '⏳ هنوز در حال ارسال درخواست قبلی شما هستم؛ کمی صبر کنید.'
    : `⏳ لطفاً ${fa(r.wait)} ثانیه صبر کنید و دوباره بفرستید.`;
  if (ctx.callbackId) await answer(ctx, text, true);
  else await send(ctx, r.why === 'busy' ? 'busy' : 'cooldown', text);
  return false;
}

/** Counts a delivered post for the user and the stats; updates `user` in place. */
async function countDownload(user, post, res) {
  const count = await store.recordDownload(user.id, {
    postId: post.id,
    author: post.author,
    kind: kindOf(res.kinds),
    snippet: short(post.text, 60),
    fromCache: res.fromCache,
  });
  user.day = today();
  user.dayCount = count;
  user.total += 1;
}

// ---------- links ----------

/** Fetches and sends one linked post. Returns { ok, reason?, res? }. */
async function processLink(ctx, user, link) {
  const got = await getPost(ctx, link);
  if (!got.ok) return { ok: false, reason: got.reason };
  let res = await deliverPost(ctx, user, got.post);
  // A post stored long ago may point at media twimg no longer serves: re-read it once.
  if (!res.sent && !res.tooBig && !res.chatError && !got.fresh) {
    const again = await getPost(ctx, link, { refresh: true });
    if (again.ok) res = await deliverPost(ctx, user, again.post);
  }
  if (res.sent) {
    await countDownload(user, got.post, res);
    return { ok: true, res, post: got.post };
  }
  if (res.tooBig) return { ok: false, reason: 'too_big', res };
  return { ok: false, reason: res.chatError ? 'chat_error' : 'send_failed', res };
}

const SUMMARY = {
  too_big: '📦 خیلی حجیم (لینک مستقیم فرستاده شد)',
  quota: '🚫 سهمیه‌ی امروز تمام شد',
};

/** A message with post links: up to MAX_LINKS, one after another, with a progress message. */
export async function handleLinks(ctx, user, links) {
  const extra = Math.max(0, links.length - MAX_LINKS);
  const todo = links.slice(0, MAX_LINKS);
  if (left(user) <= 0) return send(ctx, 'quota', quotaText(), [[btn('📜 تاریخچه', 'hi'), btn('👤 پروفایل من', 'pf')]]);
  if (!(await claim(ctx, user))) return null;

  const results = [];
  let progress = null;
  try {
    const many = todo.length > 1;
    progress = await send(ctx, 'progress', many
      ? `⏳ ${fa(todo.length)} لینک دریافت شد. در حال پردازش لینک ۱ از ${fa(todo.length)}…`
      : '⏳ در حال دریافت پست…');
    for (const [i, link] of todo.entries()) {
      if (left(user) <= 0) {
        results.push({ link, ok: false, reason: 'quota' });
        continue;
      }
      if (many && i > 0 && progress) {
        await edit(ctx, 'progress', ctx.chatId, progress.message_id,
          `⏳ در حال پردازش لینک ${fa(i + 1)} از ${fa(todo.length)}…\n✅ تا اینجا: ${fa(results.filter((r) => r.ok).length)}`);
      }
      let r;
      try {
        r = await processLink(ctx, user, link);
      } catch (err) {
        console.error(`link ${link.id} failed:`, err);
        r = { ok: false, reason: 'error', detail: describeError(err) };
      }
      results.push({ link, ...r });
      if (r.reason === 'chat_error') break; // the chat is unreachable: stop
    }
  } finally {
    await store.releaseJob(user.id);
  }

  const single = todo.length === 1 && !extra;
  if (single) {
    const r = results[0];
    if (r.ok || r.reason === 'too_big') {
      if (progress) await remove(ctx, ctx.chatId, progress.message_id);
      return { results };
    }
    const text = r.reason === 'quota' ? quotaText() : failureText(r.reason);
    if (progress && (await edit(ctx, 'download_failed', ctx.chatId, progress.message_id, text, [[menuBtn()]]))) return { results };
    await send(ctx, 'download_failed', text, [[menuBtn()]]);
    return { results };
  }

  if (progress) await remove(ctx, ctx.chatId, progress.message_id);
  const lines = results.map((r, i) => {
    const who = r.post && r.post.author ? ` (@${esc(r.post.author)})` : r.link.username ? ` (@${esc(r.link.username)})` : '';
    const what = r.ok ? `✅ ${resultLine(r.res)}` : SUMMARY[r.reason] || failureText(r.reason);
    return `${fa(i + 1)}. ${what}${who}`;
  });
  const ok = results.filter((r) => r.ok).length;
  let text = `📋 <b>نتیجه‌ی ${fa(results.length)} لینک:</b> ${fa(ok)} موفق\n\n${lines.join('\n')}`;
  if (extra) text += `\n\n⚠️ در هر پیام حداکثر ${fa(MAX_LINKS)} لینک پردازش می‌شود؛ ${fa(extra)} لینک دیگر نادیده گرفته شد.`;
  if (!isOwner(user.id)) text += `\n\n📊 سهمیه‌ی باقی‌مانده‌ی امروز: ${fa(left(user))} از ${fa(DAILY_LIMIT)}`;
  await send(ctx, 'links_summary', text, [[btn('📜 تاریخچه', 'hi'), menuBtn()]]);
  return { results };
}

// ---------- one post, again ----------

/** Loads a post by id for a button press (from the posts table, or the APIs if it isn't there). */
async function postForButton(ctx, postId) {
  if (!/^\d{1,20}$/.test(postId || '')) return null;
  const got = await getPost(ctx, { id: postId, username: null });
  if (!got.ok) {
    await answer(ctx, failureText(got.reason).slice(0, 190), true);
    return null;
  }
  return got.post;
}

/** Runs one delivery for a button (quota, lock, count). */
async function buttonDelivery(ctx, user, post, options) {
  if (left(user) <= 0) {
    await answer(ctx, '🚫 سهمیه‌ی امروز شما تمام شده است.', true);
    return send(ctx, 'quota', quotaText());
  }
  if (!(await claim(ctx, user))) return null;
  try {
    await answer(ctx, '⏳ در حال ارسال…');
    const res = await deliverPost(ctx, user, post, options);
    if (res.missing) return send(ctx, 'quality_gone', '⚠️ این کیفیت دیگر در دسترس نیست. دوباره «🎚 کیفیت‌های دیگر» را بزنید.');
    if (res.sent) await countDownload(user, post, res);
    else if (!res.tooBig) await send(ctx, 'download_failed', failureText('send_failed'));
    return res;
  } finally {
    await store.releaseJob(user.id);
  }
}

/** 🎚 The qualities of every video in a post, with sizes; too-big ones become direct links. */
export async function showQualities(ctx, user, postId) {
  const post = await postForButton(ctx, postId);
  if (!post) return null;
  const videos = post.media.map((m, i) => ({ m, i })).filter(({ m }) => m.type === 'video' && m.variants.length);
  if (!videos.length) {
    await answer(ctx, 'این پست ویدیوی چندکیفیتی ندارد.', true);
    return null;
  }
  const changed = { dirty: false };
  for (const { m } of videos) for (const v of m.variants) await ensureSize(v, changed);
  if (changed.dirty && !post.unsaved) await store.updatePostMedia(post.id, post.media);

  const kb = [];
  const lines = [];
  for (const [n, { m, i }] of videos.entries()) {
    const prefix = videos.length > 1 ? `${n + 1}) ` : '';
    lines.push(`🎬 ${videos.length > 1 ? `ویدیوی ${fa(n + 1)}` : 'ویدیو'}${m.duration ? ` — ${fa(m.duration)} ثانیه` : ''}`);
    let row = [];
    for (const v of m.variants) {
      const label = `${prefix}${qualityLabel(v)}${v.size ? ` · ${sizeShort(v.size)}` : ''}`;
      row.push(v.size && v.size > UPLOAD_MAX ? urlBtn(`🔗 ${label}`, v.url) : btn(label, `qv:${post.id}:${i}:${v.key}`));
      if (row.length === 2) {
        kb.push(row);
        row = [];
      }
    }
    if (row.length) kb.push(row);
  }
  kb.push([menuBtn()]);
  await answer(ctx);
  return show(ctx, 'qualities',
    `🎚 <b>انتخاب کیفیت</b>${post.author ? ` — @${esc(post.author)}` : ''}\n\n${lines.join('\n')}\n\n`
    + 'یک کیفیت را بزنید تا همان فرستاده شود. 🔗 یعنی بیشتر از ۵۰ مگابایت است و فقط لینک مستقیمش را می‌دهم.'
    + (post.source === 'vx' ? '\n\n<i>(این پست از سرویس جایگزین آمده و فقط یک کیفیت دارد.)</i>' : ''),
    kb);
}

export async function sendQuality(ctx, user, postId, item, key) {
  const post = await postForButton(ctx, postId);
  if (!post) return null;
  if (!Number.isInteger(item) || !post.media[item] || !/^[A-Za-z0-9]{1,16}$/.test(key || '')) {
    await answer(ctx, '⚠️ این دکمه دیگر معتبر نیست.', true);
    return null;
  }
  return buttonDelivery(ctx, user, post, { only: { item, key } });
}

/** 🖼 The post's photos as files: original size, no Telegram recompression. */
export async function sendOriginals(ctx, user, postId) {
  const post = await postForButton(ctx, postId);
  if (!post) return null;
  if (!post.media.some((m) => m.type === 'photo')) {
    await answer(ctx, 'این پست عکس ندارد.', true);
    return null;
  }
  return buttonDelivery(ctx, user, post, { asDocuments: true });
}

// ---------- history ----------

export async function showHistory(ctx, user) {
  const rows = await store.listDownloads(user.id, HISTORY_SIZE);
  if (!rows.length) {
    return show(ctx, 'history', '📜 <b>تاریخچه</b>\n\nهنوز چیزی دانلود نکرده‌اید. لینک یک پست X را بفرستید.', [[menuBtn()]]);
  }
  const lines = rows.map((r, i) => `${fa(i + 1)}. ${KIND_NAMES[r.kind] || KIND_NAMES.media}${r.author ? ` @${esc(r.author)}` : ''} — ${ago(r.createdAt)}`
    + (r.snippet ? `\n     <i>${esc(short(r.snippet, 45))}</i>` : ''));
  const kb = [];
  for (let i = 0; i < rows.length; i += 4) {
    kb.push(rows.slice(i, i + 4).map((r, j) => btn(`🔁 ${fa(i + j + 1)}`, `r:${r.id}`)));
  }
  kb.push([menuBtn()]);
  return show(ctx, 'history',
    `📜 <b>${fa(rows.length)} دانلود آخر شما</b>\n\n${lines.join('\n')}\n\nبرای دریافت دوباره (فوری، از کش)، شماره‌اش را بزنید.`,
    kb);
}

export async function resend(ctx, user, downloadId) {
  const row = Number.isInteger(downloadId) && downloadId > 0 ? await store.getDownload(user.id, downloadId) : null;
  if (!row) {
    await answer(ctx, '⚠️ این مورد در تاریخچه‌ی شما نیست.', true);
    return showHistory(ctx, user);
  }
  const post = await postForButton(ctx, row.postId);
  if (!post) return null;
  return buttonDelivery(ctx, user, post, {});
}

// ---------- settings & profile ----------

const onOff = (v) => (v ? '✅' : '❌');

export function showSettings(ctx, user, notice) {
  const text = '⚙️ <b>تنظیمات</b>\n\n'
    + `🎚 <b>کیفیت پیش‌فرض ویدیو:</b> ${QUALITY_NAMES[user.quality]}\n`
    + '   ⚡️ خودکار: بهترین کیفیت تا ۷۲۰p (سریع و کم‌حجم)\n'
    + '   💎 بهترین: بالاترین کیفیتی که در ۵۰ مگابایت جا شود\n'
    + '   🪶 کم‌حجم: کمترین حجم\n'
    + '   اگر کیفیت انتخابی جا نشود، خودکار کیفیت پایین‌تر فرستاده می‌شود.\n\n'
    + '📝 <b>کپشن:</b>\n'
    + `   ${onOff(user.capText)} متن پست\n`
    + `   ${onOff(user.capAuthor)} نویسنده (@username)\n`
    + `   ${onOff(user.capLink)} لینک پست اصلی`;
  const mark = (q) => (user.quality === q ? '● ' : '');
  return show(ctx, 'settings', notice ? `${notice}\n\n${text}` : text, [
    [btn(`${mark('auto')}⚡️ خودکار`, 'sq:auto'), btn(`${mark('best')}💎 بهترین`, 'sq:best'), btn(`${mark('low')}🪶 کم‌حجم`, 'sq:low')],
    [btn(`${onOff(user.capText)} متن`, 'sc:t'), btn(`${onOff(user.capAuthor)} نویسنده`, 'sc:a'), btn(`${onOff(user.capLink)} لینک`, 'sc:l')],
    [menuBtn()],
  ]);
}

export async function setQuality(ctx, user, quality) {
  if (!['auto', 'best', 'low'].includes(quality)) return showSettings(ctx, user);
  await store.setQuality(user.id, quality);
  user.quality = quality;
  await answer(ctx, `کیفیت پیش‌فرض: ${QUALITY_NAMES[quality]}`);
  return showSettings(ctx, user);
}

export async function toggleCaption(ctx, user, which) {
  const v = await store.toggleCaption(user.id, which);
  if (v === null) return showSettings(ctx, user);
  if (which === 't') user.capText = v;
  if (which === 'a') user.capAuthor = v;
  if (which === 'l') user.capLink = v;
  await answer(ctx, v ? '✅ در کپشن می‌آید' : '❌ از کپشن حذف شد');
  return showSettings(ctx, user);
}

export function showProfile(ctx, user) {
  const owner = isOwner(user.id);
  const used = user.day === today() ? user.dayCount : 0;
  const text = '👤 <b>پروفایل من</b>\n\n'
    + `🆔 آیدی عددی: <code>${user.id}</code>\n`
    + `📅 اولین استفاده: ${user.firstSeen ? ago(user.firstSeen) : '—'}\n\n`
    + `📥 دانلود امروز: ${fa(used)}${owner ? ' (مدیر: بدون محدودیت)' : ` از ${fa(DAILY_LIMIT)}`}\n`
    + (owner ? '' : `⏳ باقی‌مانده‌ی امروز: ${fa(left(user))}\n`)
    + `📦 کل دانلودها: ${fa(user.total)}\n\n`
    + `🎚 کیفیت پیش‌فرض: ${QUALITY_NAMES[user.quality]}`;
  return show(ctx, 'profile', text, [[btn('📜 تاریخچه', 'hi'), btn('⚙️ تنظیمات', 'st')], [menuBtn()]]);
}

