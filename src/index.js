import { handleUpdate } from './bot.js';
import { ownerId, secret, WEBHOOK_SECRET_RE } from './config.js';
import { runCron } from './cron.js';
import { ensureSchema, getSetting, listChannels } from './db.js';
import { createApi } from './telegram.js';
import { fa, setTzOffset } from './time.js';
import { esc } from './ui.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const USER_COMMANDS = [
  { command: 'start', description: 'شروع و منوی اصلی' },
  { command: 'list', description: 'کارهای در جریان' },
  { command: 'today', description: 'کارهای امروز و عقب‌افتاده' },
  { command: 'add', description: 'افزودن کار جدید' },
  { command: 'search', description: 'جستجو در کارها' },
  { command: 'categories', description: 'دسته‌بندی‌ها' },
  { command: 'stats', description: 'آمار و پیشرفت' },
  { command: 'settings', description: 'تنظیمات، خلاصه روزانه و خروجی' },
  { command: 'help', description: 'راهنما' },
  { command: 'cancel', description: 'لغو عملیات جاری' },
];

const OWNER_COMMANDS = [
  ...USER_COMMANDS,
  { command: 'admin', description: 'پنل مدیریت' },
  { command: 'channels', description: 'کانال‌های جوین اجباری' },
  { command: 'addchannel', description: 'افزودن کانال جوین اجباری' },
  { command: 'delchannel', description: 'حذف کانال جوین اجباری' },
];

async function setup(request, env) {
  const url = new URL(request.url);
  const webhookSecret = secret(env, 'WEBHOOK_SECRET');
  if (!secret(env, 'BOT_TOKEN') || !webhookSecret) {
    return json({ ok: false, error: 'BOT_TOKEN و WEBHOOK_SECRET را اول به‌صورت Secret تعریف کنید. / Set the BOT_TOKEN and WEBHOOK_SECRET secrets first.' }, 500);
  }
  if (!WEBHOOK_SECRET_RE.test(webhookSecret)) {
    return json({ ok: false, error: 'WEBHOOK_SECRET فقط می‌تواند حروف انگلیسی، عدد، _ و - داشته باشد. / WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ -' }, 500);
  }
  if ((url.searchParams.get('secret') || '').trim() !== webhookSecret) return json({ ok: false, error: 'wrong secret' }, 403);
  const api = createApi(env);
  const webhook = await api.call('setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 40,
  });
  const commands = await api.call('setMyCommands', { commands: USER_COMMANDS });
  const ownerCommands = await api.call('setMyCommands', { commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: ownerId(env) } });
  const me = await api.call('getMe');
  return json({
    ok: webhook.ok,
    webhook,
    commands,
    ownerCommands: ownerCommands.ok ? ownerCommands : `${ownerCommands.description} (the owner must /start the bot first, then open /setup again)`,
    bot: me.result,
  });
}

/** Setup checklist at "/", so a dashboard deployment can be verified step by step. */
async function status(request, env) {
  const origin = new URL(request.url).origin;
  const rows = [];
  const check = (ok, label, hint = '') => {
    rows.push({ ok, label, hint });
    return ok;
  };

  let dbOk = false;
  let dbError = '';
  if (env.DB && typeof env.DB.prepare === 'function') {
    try {
      await ensureSchema(env.DB);
      dbOk = true;
    } catch (err) {
      dbError = String(err?.message || err);
    }
  }
  check(dbOk, 'دیتابیس D1 با نام متغیر <code>DB</code>', dbError ? esc(dbError) : 'یک دیتابیس D1 بسازید و در Bindings با Variable name دقیقاً <code>DB</code> به ورکر وصل کنید.');

  const token = secret(env, 'BOT_TOKEN');
  const api = createApi(env);
  const me = token ? await api.call('getMe') : null;
  check(
    !!me?.ok,
    `توکن ربات <code>BOT_TOKEN</code>${me?.ok ? ` — @${esc(me.result.username)}` : ''}`,
    token ? `تلگرام توکن را قبول نکرد (${esc(me?.description || '')}). توکن را دوباره از BotFather کپی کنید.` : 'یک Secret با نام <code>BOT_TOKEN</code> و مقدار توکن BotFather بسازید.',
  );

  const webhookSecret = secret(env, 'WEBHOOK_SECRET');
  check(
    WEBHOOK_SECRET_RE.test(webhookSecret),
    'رمز وبهوک <code>WEBHOOK_SECRET</code>',
    webhookSecret ? 'فقط حروف انگلیسی، عدد، _ و - مجاز است (بدون فاصله).' : 'یک Secret با نام <code>WEBHOOK_SECRET</code> بسازید (مثلاً <code>MyBot_2026_secret</code>).',
  );

  if (me?.ok) {
    const info = await api.call('getWebhookInfo');
    const hookOk = info.ok && info.result.url === `${origin}/webhook`;
    check(hookOk, 'اتصال وبهوک تلگرام', `یک بار این آدرس را باز کنید: <code>${esc(origin)}/setup?secret=رمز_وبهوک</code>`);
    if (hookOk && info.result.last_error_message) {
      rows.push({ warn: true, label: `آخرین خطای تلگرام: ${esc(info.result.last_error_message)}`, hint: 'اگر قدیمی است نگران نباشید.' });
    }
  }

  if (dbOk) {
    const last = Number(await getSetting(env.DB, 'last_cron')) || 0;
    const minutes = Math.floor((Date.now() - last) / 60_000);
    check(
      last > 0 && minutes < 3,
      `کرون یادآورها${last ? ` — آخرین اجرا ${minutes < 1 ? 'کمتر از ۱ دقیقه' : `${fa(minutes)} دقیقه`} پیش` : ''}`,
      'در Settings ← Trigger events یک Cron Trigger با عبارت <code>* * * * *</code> اضافه کنید. شروع به کار کرون جدید ممکن است تا ۱۵ دقیقه طول بکشد.',
    );
    const channels = await listChannels(env.DB);
    rows.push({ info: true, label: `کانال‌های جوین اجباری: ${fa(channels.length)} — مالک: <code>${ownerId(env)}</code>` });
  }

  const allOk = rows.every((r) => r.ok !== false);
  const items = rows
    .map((r) => {
      const icon = r.info ? 'ℹ️' : r.warn ? '⚠️' : r.ok ? '✅' : '❌';
      const hint = r.ok === false || r.warn ? `<div class="hint">${r.hint}</div>` : '';
      return `<li><span>${icon}</span><div>${r.label}${hint}</div></li>`;
    })
    .join('');
  const html = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>وضعیت ربات</title>
<style>body{font-family:Vazirmatn,Tahoma,system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.9;background:#f7f7f8;color:#1d1d1f}
ul{list-style:none;padding:0}li{display:flex;gap:10px;background:#fff;border-radius:12px;padding:12px 14px;margin:8px 0;box-shadow:0 1px 2px #0001}
.hint{font-size:.9em;color:#a33}code{direction:ltr;unicode-bidi:embed;background:#eee;padding:0 4px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}li{background:#1c1c1e}.hint{color:#f88}code{background:#333}}</style></head>
<body><h2>🤖 وضعیت ربات تودو لیست</h2><p>${allOk ? '🎉 همه‌چیز آماده است. ربات را در تلگرام /start کنید.' : 'موارد ❌ را طبق توضیح هرکدام درست کنید و این صفحه را دوباره باز کنید.'}</p><ul>${items}</ul></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const webhookSecret = secret(env, 'WEBHOOK_SECRET');
      if (!webhookSecret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret) {
        return new Response('forbidden', { status: 403 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      try {
        await handleUpdate(env, update);
      } catch (err) {
        // Always 200, otherwise Telegram keeps redelivering the same broken update.
        console.error('update failed:', err?.stack || err);
      }
      return new Response('ok');
    }

    if (url.pathname === '/setup') return setup(request, env);
    if (url.pathname === '/') return status(request, env);
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    ctx.waitUntil(runCron(env, event.scheduledTime));
  },
};
