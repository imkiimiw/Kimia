// The heartbeat: asks Aegis to run its timed work now (expiries, night locks, cleanups, scheduled
// posts, broadcast batches), so they happen on time even when no chat is busy. Telegram Serverless
// has no scheduler; any free scheduler that can run Node (GitHub Actions: ops/heartbeat.yml) runs
// this every few minutes.
//
// It calls the owner-only endpoint bcLive ({ action: 'beat' }) the way the Mini App does
// (Authorization: TMA <base64 init data>), with init data it signs itself with the BOT token —
// Telegram's Mini App algorithm: secret = HMAC-SHA256("WebAppData", bot token), hash =
// HMAC-SHA256(secret, the sorted "key=value" lines). The endpoint refuses init data older than 5
// minutes, so a copied request can't be replayed.
//
//   AEGIS_BOT_TOKEN=<token from @BotFather> node scripts/heartbeat.mjs
//   optional: AEGIS_OWNER_ID (default 5557901897), AEGIS_APP_URL (default the deployed Mini App)
// The token is read from the environment only; it is never printed.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_APP_URL = 'https://app8940801714.tgcloud.ai/';
export const DEFAULT_OWNER_ID = 5557901897;

/** Mini App init data for `user`, signed with the bot token (a query string, like Telegram.WebApp.initData). */
export function signInitData(botToken, user, authDate = Math.floor(Date.now() / 1000)) {
  const fields = { auth_date: String(authDate), query_id: `aegis-heartbeat-${authDate}`, user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/** One beat: POST /api/bcLive { action: 'beat' }. Gives the endpoint's result or throws. */
export async function beat({ token, ownerId = DEFAULT_OWNER_ID, appUrl = DEFAULT_APP_URL, fetchFn = fetch } = {}) {
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(String(token || ''))) throw new Error('AEGIS_BOT_TOKEN is missing or is not a bot token');
  const init = signInitData(token, { id: Number(ownerId), first_name: 'Aegis heartbeat' });
  const res = await fetchFn(new URL('api/bcLive', appUrl).toString(), {
    method: 'POST',
    headers: { Authorization: `TMA ${Buffer.from(init).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'beat' }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!data || data.ok !== true) throw new Error(`HTTP ${res.status}: ${data ? data.description || JSON.stringify(data) : text.slice(0, 200)}`);
  return data.result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = await beat({ token: process.env.AEGIS_BOT_TOKEN, ownerId: process.env.AEGIS_OWNER_ID || DEFAULT_OWNER_ID, appUrl: process.env.AEGIS_APP_URL || DEFAULT_APP_URL });
    console.log(`💓 beat ok at ${new Date(r.at * 1000).toISOString()} — ${r.calls} Bot API call(s)`);
  } catch (err) {
    console.error(`✘ heartbeat failed: ${err.message}`);
    process.exit(1);
  }
}
