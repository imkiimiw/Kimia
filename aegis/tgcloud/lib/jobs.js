/*
 * Work done on the side of ordinary updates, because the platform has no scheduler or timers:
 * - a running broadcast advances by a small chunk (BC_CHUNK messages, BC_CHUNK_BUDGET_MS), and its
 *   progress card is refreshed at most every BC_PROGRESS_EVERY_SEC (always when it finishes);
 *   a queued broadcast starts when nothing else is running;
 * - housekeeping at most once per GC_INTERVAL_SEC: old update ids, expired pending inputs, a few
 *   stale member counts, admin actions older than BETRAY_KEEP_SEC (anti-betrayal only counts recent ones),
 *   lock hits older than LOCK_HITS_KEEP_SEC, old security memory (flood rows, media/ad fingerprints, risk alerts);
 * - at most once a minute: expired captchas and finished lockdowns of every chat (ui/security.js),
 *   self-destructing messages, the night lock and scheduled cleanup (ui/advanced.js), scheduled
 *   channel posts and a step of copying a channel's older posts to its backup chat (ui/channel.js),
 *   contests whose time is up and polls past their end (ui/social.js);
 * - after every update: Aegis's own group messages are noted for cleanup / self-destructing notices.
 * While the owner has shut Aegis down, broadcasts don't advance (housekeeping still runs).
 * Never throws: failures are recorded (lib/core/errors.js) and the update's own result stands.
 */
import { BC_CHUNK, BC_CHUNK_BUDGET_MS, BC_PROGRESS_EVERY_SEC, BETRAY_KEEP_SEC, GC_INTERVAL_SEC, LOCK_HITS_KEEP_SEC, UPDATE_KEEP_SEC } from './config.js';
import * as dedupe from './core/dedupe.js';
import * as errors from './core/errors.js';
import * as kv from './core/kv.js';
import * as state from './core/state.js';
import { nowSec } from './core/util.js';
import { adminActions } from './engines/betrayal.js';
import * as bc from './engines/broadcast.js';
import * as channels from './engines/channels.js';
import * as chats from './engines/chats.js';
import * as groupdata from './engines/groupdata.js';
import * as guards from './engines/guards.js';
import * as locks from './engines/locks.js';
import * as msglog from './engines/msglog.js';
import * as posts from './engines/posts.js';
import { stats } from './engines/social.js';
import { afterBatch, refreshPanel } from './ui/owner_bc.js';
import * as advanced from './ui/advanced.js';
import * as channel from './ui/channel.js';
import * as security from './ui/security.js';
import * as social from './ui/social.js';

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
    security: await guards.sweep(now),
    msgLog: await msglog.sweep(now),
    anonCmds: await groupdata.sweep(now),
    joinRequests: await channels.sweep(now),
    posts: await posts.sweep(now),
    statsDays: await stats.sweep(now),
  };
}

/* Expired captchas and finished lockdowns of every chat, at most once a minute (no scheduler). */
async function securitySweep(ctx) {
  if (ctx.shutdown) return;
  if (!(await kv.claim('sec_sweep_at', nowSec(), 60))) return;
  await security.sweep(ctx, null);
  await advanced.sweep(ctx);
  await channel.sweep(ctx);
  await social.sweep(ctx);
}

export async function afterUpdate(ctx) {
  try {
    if (!ctx.shutdown) await broadcastChunk(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.broadcast' });
  }
  try {
    await advanced.afterUpdate(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.msglog' });
  }
  try {
    await securitySweep(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.security' });
  }
  try {
    await housekeeping(ctx);
  } catch (err) {
    await errors.record(ctx, err, { source: 'jobs.housekeeping' });
  }
}
