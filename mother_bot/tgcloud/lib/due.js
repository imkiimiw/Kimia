// Work done on the side of other updates, because the platform has no scheduler. Each piece runs at
// most as often as its own claim allows, so most updates only read a few kv values:
//   - access modes / statuses whose time is up end (lib/access.js expireDue), the child is told;
//   - health checks of the child bots (lib/health.js healthDue);
//   - the monthly club campaign (lib/club.js monthlyDue), once per Jalali month;
//   - queued broadcasts move on (lib/broadcast.js); woken runs send a full batch;
//   - cleanup: finished broadcasts' bookkeeping, old watcher rows.
// endpoints/tick (the optional GitHub Actions schedule) runs all of it with bigger limits.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { GC_EVERY_SEC } from './config.js';
import { expireDue } from './access.js';
import { broadcastTick } from './broadcast.js';
import { monthlyDue } from './club.js';
import { healthDue } from './health.js';
import { claimTurn, getKv } from './store.js';
import { describeError } from './tg.js';
import { localDay, nowSec } from './util.js';

async function gc() {
  const now = nowSec();
  // watchers moved to a finished broadcast, and very old ones
  await db.run(sql`
    DELETE FROM watchers WHERE rowid IN (
      SELECT w.rowid FROM watchers w JOIN broadcasts b ON w.kind = 'bc' AND b.id = CAST(w.ref AS INTEGER)
      WHERE b.status IN ('done', 'stopped') LIMIT 500)`);
  await db.run(sql`DELETE FROM watchers WHERE rowid IN (SELECT rowid FROM watchers WHERE at < ${now - 30 * 86400} LIMIT 500)`);
  await db.run(sql`DELETE FROM bc_sent WHERE rowid IN (
    SELECT s.rowid FROM bc_sent s JOIN broadcasts b ON b.id = s.bc_id WHERE b.status IN ('done', 'stopped') LIMIT 1000)`);
  await db.run(sql`DELETE FROM bot_daily WHERE rowid IN (SELECT rowid FROM bot_daily WHERE day < ${localDay(now - 120 * 86400)} LIMIT 500)`);
}

export async function afterUpdate(ctx, { woken = false, tick = false } = {}) {
  const done = {};
  try {
    const kv = await getKv(['bc_on', 'due_at', 'gc_at']);
    const now = nowSec();
    if (tick || now - Number(kv.due_at || 0) >= 60) {
      if (tick || (await claimTurn('due_at', 60))) {
        done.expired = await expireDue(ctx);
        done.health = await healthDue(ctx, tick ? 20 : undefined);
        const c = await monthlyDue(ctx);
        if (c) done.monthly = c.id;
      }
    }
    if (kv.bc_on || tick) await broadcastTick(ctx, { woken: woken || tick });
    if (now - Number(kv.gc_at || 0) >= GC_EVERY_SEC && (await claimTurn('gc_at', GC_EVERY_SEC))) {
      await gc();
      done.gc = true;
    }
  } catch (err) {
    console.warn(`after-update work failed: ${describeError(err)}`);
  }
  ctx.due = done;
  return done;
}
