/*
 * Work done on the side of ordinary updates, because Telegram Serverless has no scheduler: the next
 * broadcast batch, the meme of the day, and (once a day) pruning old stats. Run after messages,
 * button presses and sent memes (chosen_inline_result) — never after inline queries, which must
 * answer fast. Never throws.
 */
import { sideStep } from './broadcast.js';
import { maybePostMotd } from './motd.js';
import { pruneStats } from './statsstore.js';
import { claimEvery } from './store.js';

export async function sideTasks(ctx, nowSec) {
  await sideStep(ctx, nowSec);
  try {
    if (await claimEvery('prune:stats', nowSec, 86400)) await pruneStats(nowSec);
  } catch (err) {
    console.warn(`pruning stats failed: ${String((err && err.message) || err)}`);
  }
  try {
    await maybePostMotd(ctx, nowSec);
  } catch (err) {
    console.warn(`meme of the day failed: ${String((err && err.message) || err)}`);
  }
}
