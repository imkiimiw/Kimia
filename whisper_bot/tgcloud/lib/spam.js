// Anti-spam for anonymous senders. Checked before a message is stored or delivered:
//   restricted — STRIKES_TO_RESTRICT different recipients blocked/reported this sender within a week
//                (lib/astore.js addStrike), or the bot's owner restricted them from a report;
//   flood      — less than ANON_MIN_GAP_SEC since their previous message;
//   hour       — more than ANON_PER_HOUR messages in the last hour, to anyone;
//   target     — more than ANON_PER_TARGET_10MIN messages to the same person in 10 minutes;
//   duplicate  — the same text to the same person within DUPLICATE_WINDOW_SEC.
import {
  ANON_MIN_GAP_SEC, ANON_PER_HOUR, ANON_PER_TARGET_10MIN, DUPLICATE_WINDOW_SEC,
} from './config.js';
import { countSent, isDuplicate } from './astore.js';
import { nowSec } from './util.js';

/** null if `sender` may send to `toId` now, else { code, until? }. */
export async function spamCheck(sender, toId, hash) {
  const now = nowSec();
  if (sender.restrictedUntil > now) return { code: 'restricted', until: sender.restrictedUntil };
  if (now - sender.lastAnonAt < ANON_MIN_GAP_SEC) return { code: 'flood' };
  if ((await countSent(sender.id, now - 3600, ANON_PER_HOUR)) >= ANON_PER_HOUR) return { code: 'hour' };
  if ((await countSent(sender.id, now - 600, ANON_PER_TARGET_10MIN, toId)) >= ANON_PER_TARGET_10MIN) return { code: 'target' };
  if (hash && (await isDuplicate(sender.id, toId, hash, now - DUPLICATE_WINDOW_SEC))) return { code: 'duplicate' };
  return null;
}
