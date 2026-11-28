// Work done on the side of other updates, because the platform has no scheduler:
// - lazy cleanup: at most once per GC_INTERVAL_SEC, a small batch of old drafts and stale states;
// - a running broadcast moves forward: a small chunk on the side of a user's update, a full batch
//   when the bot was woken for it (lib/wake.js) or the outside clock ticked;
// - the daily question goes out to those who asked for it, the same way (lib/daily.js).
import {
  BC_BATCH, DRAFT_TTL_SEC, FILTERED_TTL_SEC, GC_BATCH, GC_INTERVAL_SEC,
} from './config.js';
import { broadcastTick } from './broadcast.js';
import { dailyTick } from './daily.js';
import { purgeOldQuestions } from './qstore.js';
import { claimTurn, gcBatch, getKv } from './store.js';
import { describeError } from './tg.js';
import { nowSec } from './util.js';

export async function afterUpdate(ctx, kv, { gc = true, woken = false } = {}) {
  try {
    const values = kv || (await getKv());
    const due = nowSec() - Number(values.gc_at || 0) >= GC_INTERVAL_SEC; // read first: no write on most updates
    if (gc && due && (await claimTurn('gc_at', GC_INTERVAL_SEC))) {
      ctx.gc = await gcBatch(DRAFT_TTL_SEC);
      ctx.gc.questions = await purgeOldQuestions(nowSec() - FILTERED_TTL_SEC, GC_BATCH); // filtered / deleted ones
    }
    if (values.bc) await broadcastTick(ctx, Number(values.bc), woken ? BC_BATCH : undefined);
    if (gc || woken) await dailyTick(ctx, values, { woken }); // not on inline keystrokes
  } catch (err) {
    console.warn(`after-update work failed: ${describeError(err)}`);
  }
}
