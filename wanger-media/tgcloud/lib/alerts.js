// Throttled notices to the owner (misconfigured channels, errors). At most one per key per period;
// if the owner hasn't started the bot (or blocked it) the notice is dropped silently.
import { ALERT_EVERY_S, FALLBACK_LANG, OWNER_ID } from './config.js';
import * as system from './db/system.js';
import * as users from './db/users.js';
import { normLang, t } from './i18n/index.js';
import * as tg from './tg.js';

export async function alertOwner(ctx, key, textKey, vars, every = ALERT_EVERY_S) {
  if (!(await system.claimThrottle('alert:' + key, ctx.now, every))) return false;
  const lang = normLang(await users.langOf(OWNER_ID)) || FALLBACK_LANG;
  try {
    await tg.send(ctx, 'owner_alert', OWNER_ID, { text: t(lang, textKey, vars) });
  } catch {
    // The owner can't be reached right now; the alert is in the trace and the throttle stands.
  }
  return true;
}
