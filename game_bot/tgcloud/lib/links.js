/*
 * Links and buttons that open the Mini App with a payload (payload.js: a room, or a solo game).
 *
 * In a chat the bot doesn't own (inline invitations) only URL buttons are allowed, and what a URL
 * can open depends on how the bot is set up in BotFather — which the bot checks for itself (getMe,
 * cached in settings for INFO_TTL) instead of trusting config:
 *   - a Main Mini App exists (has_main_web_app)  → https://t.me/<bot>?startapp=<payload>, one tap;
 *   - APP_SHORT_NAME names a /newapp app         → https://t.me/<bot>/<short>?startapp=<payload>;
 *   - neither (works with no setup at all)       → https://t.me/<bot>?start=<payload>: the bot's chat
 *     opens, START sends "/start <payload>", and the bot answers with a button that opens the game.
 * In the bot's own chat, buttons are web_app buttons to APP_URL?sp=<payload> and need no setup.
 */
import { APP_SHORT_NAME, APP_URL } from './config.js';
import * as store from './store.js';
import { call } from './tg.js';

const INFO_TTL = 600; /* seconds before getMe is asked again (so a change in BotFather is picked up) */
let cached = null;

/* { username, mainApp }: the bot's username and whether it has a Main Mini App. */
export async function botInfo(ctx) {
  const now = store.nowSec();
  if (cached && now - cached.at < INFO_TTL) return cached;
  const s = await store.getSettings();
  const saved = s.bot_username ? { username: s.bot_username, mainApp: s.main_app === '1', at: Number(s.bot_info_at || 0) } : null;
  if (saved && now - saved.at < INFO_TTL) {
    cached = saved;
    return cached;
  }
  try {
    const me = await call(ctx, 'getMe', {}, 'me');
    cached = { username: me.username, mainApp: me.has_main_web_app === true, at: now };
    await store.setSettings({ bot_username: cached.username, main_app: cached.mainApp ? '1' : '0', bot_info_at: now });
  } catch (err) {
    if (!saved) throw err;
    cached = saved; /* Telegram didn't answer: keep what we knew */
  }
  return cached;
}

export async function botUsername(ctx) {
  return (await botInfo(ctx)).username;
}

/* A link that works from any chat and leads to the game `payload`. */
export function gameLink(info, payload) {
  if (APP_SHORT_NAME) return `https://t.me/${info.username}/${APP_SHORT_NAME}?startapp=${payload}`;
  if (info.mainApp) return `https://t.me/${info.username}?startapp=${payload}`;
  return `https://t.me/${info.username}?start=${payload}`;
}

/* The Mini App's own address for a payload: for web_app buttons in the bot's chat. */
export const appUrl = (payload) => (payload ? `${APP_URL}?sp=${payload}` : APP_URL);

/* A button for a message in the bot's own chat that opens the game `payload` (or the home screen). */
export function openButton(info, text, payload = '') {
  if (APP_URL) return { text, web_app: { url: appUrl(payload) } };
  return { text, url: payload ? gameLink(info, payload) : `https://t.me/${info.username}` };
}

export { parsePayload, payloadFor } from './payload.js';
