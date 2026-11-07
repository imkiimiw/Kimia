// C0 spike: can a process OUTSIDE Serverless (the future Python worker) send and edit messages with
// the bot token while the platform manages the webhook?
//
//   Converter_BOT_TOKEN=<token from BotFather> node spikes/outside-send.mjs
//   npm run tg -- webhook        # afterwards: must still say "in sync"
//
// It calls ONLY getMe, sendMessage (silent, to the owner), editMessageText and deleteMessage, plus
// the read-only getWebhookInfo (prints whether a URL is set and its host, never the URL itself).
// It never calls setWebhook, deleteWebhook, getUpdates, logOut or close — those would break the
// platform's webhook. The token is read from the environment only and never printed.
const TOKEN = (process.env.Converter_BOT_TOKEN || '').trim();
const OWNER_ID = 5557901897;
if (!/^\d+:[\w-]{30,}$/.test(TOKEN)) {
  console.error('Set Converter_BOT_TOKEN to the bot token from BotFather (not the CLI token).');
  process.exit(2);
}
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  console.error('Behind a proxy: run with NODE_USE_ENV_PROXY=1.');
  process.exit(2);
}

async function call(method, params = {}) {
  const t = Date.now();
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await r.json();
  console.log(method, j.ok ? 'ok' : `FAILED ${j.error_code} ${j.description}`, `${Date.now() - t} ms`);
  if (!j.ok) throw new Error(`${method} failed`);
  return j.result;
}

const me = await call('getMe');
console.log('bot:', me.username, me.id);
const info = await call('getWebhookInfo');
console.log('webhook set:', Boolean(info.url), info.url ? `host ${new URL(info.url).host}` : '', 'pending:', info.pending_update_count);
const msg = await call('sendMessage', { chat_id: OWNER_ID, text: 'C0 spike: sent from outside Serverless (deleted in a moment).', disable_notification: true });
await call('editMessageText', { chat_id: OWNER_ID, message_id: msg.message_id, text: 'C0 spike: edited from outside Serverless.' });
await call('deleteMessage', { chat_id: OWNER_ID, message_id: msg.message_id });
console.log('OK: sending and editing from outside work. Now run `npm run tg -- webhook` and check it is still in sync.');
