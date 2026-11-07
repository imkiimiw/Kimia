// Short notices to the owner, throttled per key (ALERT_EVERY_S). Never throws: an alert must not
// break the update that triggered it.
import { ALERT_EVERY_S, OWNER_ID } from './config.js';
import { claimAlert } from './db/system.js';
import { t } from './i18n/index.js';
import * as tg from './tg.js';

export async function alertOwner(ctx, key, textKey, vars = {}, everyS = ALERT_EVERY_S) {
  try {
    if (!(await claimAlert(key, ctx.now, everyS))) return false;
    await tg.send(ctx, 'alert', OWNER_ID, { text: t('fa', textKey, vars) });
    return true;
  } catch {
    return false;
  }
}
