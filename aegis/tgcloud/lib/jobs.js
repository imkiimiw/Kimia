/*
 * Work done on the side of ordinary updates, because the platform has no scheduler or timers:
 * - a running broadcast advances by a small chunk (BC_CHUNK messages, BC_CHUNK_BUDGET_MS), and its
 *   progress card is refreshed at most every BC_PROGRESS_EVERY_SEC (always when it finishes);
 *   a queued broadcast starts when nothing else is running;
 * - housekeeping at most once per GC_INTERVAL_SEC: old update ids, expired pending inputs, a few
 *   stale member counts, admin actions older than BETRAY_KEEP_SEC (anti-betrayal only counts recent ones),
 *   lock hits older than LOCK_HITS_KEEP_SEC.
 * While the owner has shut Aegis down, broadcasts don't advance (housekeeping still runs).
 * Never throws: failures are recorded (lib/core/errors.js) and the update's own result stands.
 */
import { BC_CHUNK, BC_CHUNK_BUDGET_MS, BC_PROGRESS_EVERY_SEC, BETRAY_KEEP_SEC, GC_INTERVAL_SEC, LOCK_HITS_KEEP_SEC, UPDATE_KEEP_SEC } from './config.js';
import * as dedupe from './core/dedupe.js';
import * as errors from './core/errors.js';
import * as kv from './core/kv.js';
import * as state from './core/state.js';
import { nowSec } from './core/util.js';
import * as adminActions from './engines/admin_actions.js';
import * as bc from './engines/broadcast.js';
import * as chats from './engines/chats.js';
import * as locks from './engines/locks.js';
import { afterBatch, refreshPanel } from './ui/owner_bc.js';

async function broadcastChunk(ctx) {
  let cur = await bc.active();
  if (!cur) {
    const id = await bc.promoteNext();
    if (!id) return;
    cur = await bc.get(id);
  }
  if (cur.status !== 'running') return;
  const r = await bc.runBatch(ctx, Number(cur.id), { limit: BC_CHUNK, budgetMs: BC_CHUNK_BUDGET_MS });
  if (!r.ran) return;
  if (r.finished || r.sourceGone) await afterBatch(ctx, r);
  else if (nowSec() - Number(r.row.progress_at) >= BC_PROGRESS_EVERY_SEC) await refreshPanel(ctx, r.row);
}

async function housekeeping(ctx) {
  const now = nowSec();
  const s = await kv.all(ctx);
  if (now - Number(s.gc_at || 0) < GC_INTERVAL_SEC) return;
  if (!(await kv.claim('gc_at', now, GC_INTERVAL_SEC))) return;
  ctx.gc = {
    updates: await dedupe.sweep(now, UPDATE_KEEP_SEC),
    states: await state.sweep(now),
    staleCounts: await chats.refreshStaleCounts(ctx, 3, 1500),
    adminActions: await adminActions.sweep(now, BETRAY_KEEP_SEC),
    lockHits: await locks.sweepHits(now, LOCK_HITS_KEEP_SEC),
  };
}

export async function afterUpdate(ctx) {
  try {
    if (!ctx.shutdown) await broadcastChunk(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.broadcast' });
  }
  try {
    await housekeeping(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.housekeeping' });
  }
}
