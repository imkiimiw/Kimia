// Work done on the side of other updates, because the platform has no scheduler:
// - lazy cleanup: at most once per GC_INTERVAL_SEC, a small batch of old drafts and stale states;
// - a running broadcast moves forward by one small chunk.
import { DRAFT_TTL_SEC, GC_INTERVAL_SEC } from './config.js';
import { broadcastTick } from './broadcast.js';
import { claimTurn, gcBatch, getKv } from './store.js';
import { describeError } from './tg.js';
import { nowSec } from './util.js';

export async function afterUpdate(ctx, kv, { gc = true } = {}) {
  try {
    const values = kv || (await getKv());
    const due = nowSec() - Number(values.gc_at || 0) >= GC_INTERVAL_SEC; // read first: no write on most updates
    if (gc && due && (await claimTurn('gc_at', GC_INTERVAL_SEC))) ctx.gc = await gcBatch(DRAFT_TTL_SEC);
    if (values.bc) await broadcastTick(ctx, Number(values.bc));
  } catch (err) {
    console.warn(`after-update work failed: ${describeError(err)}`);
  }
}
