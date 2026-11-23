// Invitations: a personal link (t.me/<bot>?start=ref_<id>). A new user who starts with it is linked
// to the inviter once; when they finish onboarding (forced join passed, disclaimer accepted) the
// inviter gets REF_BONUS more downloads a day, up to REF_CAP — one credit per invited user, decided by
// a conditional update. The owner can switch it off ('switch.referrals', on by default).
import { BOT_USERNAME, REF_BONUS, REF_CAP } from './config.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { normLang, t, tp } from './i18n/index.js';
import * as tg from './tg.js';
import * as ui from './ui.js';
import { tehranDay } from './util.js';

export const SWITCH = 'switch.referrals';
export const enabled = (settings) => !(settings && settings[SWITCH] && settings[SWITCH].value === false);
export const linkOf = (id) => `https://t.me/${BOT_USERNAME}?start=ref_${id}`;

/** "/start ref_123" → 123, else null. */
export function inviterFrom(text) {
  const m = /^\/start(?:@[A-Za-z0-9_]+)?\s+ref_(\d{1,15})\s*$/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** On a new user's first /start: remember the inviter (never oneself, only a known user). */
export async function remember(ctx, user, text) {
  if (!user.isNew || !enabled(ctx.settings)) return false;
  const inviter = inviterFrom(text);
  if (!inviter || inviter === user.id) return false;
  const ok = await users.setReferrer(user.id, inviter);
  if (ok && user.row) user.row.referred_by = inviter;
  return ok;
}

/** After the invited user accepted the disclaimer: credit the inviter once and tell them. */
export async function credit(ctx, user) {
  if (!enabled(ctx.settings) || !user.row || !user.row.referred_by || user.row.ref_credited) return null;
  const r = await users.creditReferral(user.id, REF_BONUS, REF_CAP);
  if (!r) return null;
  await system.count([['ref_credited', tehranDay(ctx.now), 1]]);
  const lang = normLang(await users.langOf(r.inviter)) || 'en';
  try {
    await tg.send(ctx, 'ref_credit', r.inviter, { text: t(lang, 'ref.credited', { bonus: REF_BONUS, total: r.bonus, cap: REF_CAP }) });
  } catch { /* the inviter may have blocked the bot */ }
  return r;
}

/** The "Invite friends" screen. */
export function screen(lang, user) {
  const link = linkOf(user.id);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(tp(lang, 'ref.share_text'))}`;
  return {
    text: t(lang, 'ref.text', { link, count: Number(user.row.ref_count) || 0, bonus: Number(user.row.ref_bonus) || 0, per: REF_BONUS, cap: REF_CAP }),
    reply_markup: ui.markup([[ui.urlButton(tp(lang, 'ref.btn_share'), share)], ui.navRow(lang)]),
  };
}
