import { handleUpdate } from './bot.js';
import { ownerId } from './config.js';
import { runCron } from './cron.js';
import { createApi } from './telegram.js';
import { setTzOffset } from './time.js';

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
  if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return json({ ok: false, error: 'BOT_TOKEN and WEBHOOK_SECRET secrets must be set first.' }, 500);
  if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'wrong secret' }, 403);
  const api = createApi(env);
  const webhook = await api.call('setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 40,
  });
  const commands = await api.call('setMyCommands', { commands: USER_COMMANDS });
  const ownerCommands = await api.call('setMyCommands', { commands: OWNER_COMMANDS, scope: { type: 'chat', chat_id: ownerId(env) } });
  const me = await api.call('getMe');
  return json({ ok: webhook.ok, webhook, commands, ownerCommands: ownerCommands.ok ? ownerCommands : `${ownerCommands.description} (the owner must /start the bot first)`, bot: me.result });
}

export default {
  async fetch(request, env) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    const url = new URL(request.url);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
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
    if (url.pathname === '/') return new Response('✅ Todo bot is running.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    setTzOffset(env.TZ_OFFSET_MINUTES);
    ctx.waitUntil(runCron(env, event.scheduledTime));
  },
};
