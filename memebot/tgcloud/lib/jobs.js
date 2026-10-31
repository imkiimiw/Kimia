/*
 * Work done on the side of ordinary updates, because Telegram Serverless has no scheduler: the next
 * broadcast batch and the meme of the day. Run after messages, button presses and sent memes
 * (chosen_inline_result) — never after inline queries, which must answer fast. Never throws.
 */
import { sideStep } from './broadcast.js';
import { maybePostMotd } from './motd.js';

export async function sideTasks(ctx, nowSec) {
  await sideStep(ctx, nowSec);
  try {
    await maybePostMotd(ctx, nowSec);
  } catch (err) {
    console.warn(`meme of the day failed: ${String((err && err.message) || err)}`);
  }
}
