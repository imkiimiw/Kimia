/*
 * The global switch (owner only: /shutdown, /activate) and the numbers behind /status.
 * State lives in aegis_kv (shutdown '1'/'0', shutdown_at, shutdown_by), so it survives deploys.
 * While shut down, Aegis answers nobody but the owner, posts nothing in groups, and background work
 * (broadcast chunks) stops; membership changes are still recorded quietly (lib/router.js).
 */
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { OWNER_ID, PHASE, VERSION } from '../config.js';
import * as audit from '../core/audit.js';
import * as kv from '../core/kv.js';
import { tryCall } from '../core/tg.js';
import { nowSec } from '../core/util.js';
import * as bc from './broadcast.js';
import * as chats from './chats.js';
import * as users from './users.js';

export const isShutdown = (s) => s.shutdown === '1';

export async function shutdown(ctx, actorId) {
  const s = await kv.all(ctx);
  if (isShutdown(s)) return false;
  await kv.set(ctx, 'shutdown', '1');
  await kv.set(ctx, 'shutdown_at', nowSec());
  await kv.set(ctx, 'shutdown_by', actorId);
  await audit.log(actorId, 'system.shutdown');
  return true;
}

export async function activate(ctx, actorId) {
  const s = await kv.all(ctx);
  if (!isShutdown(s)) return false;
  await kv.set(ctx, 'shutdown', '0');
  await kv.set(ctx, 'activated_at', nowSec());
  await audit.log(actorId, 'system.activate', { details: { downSec: nowSec() - Number(s.shutdown_at || nowSec()) } });
  return true;
}

export async function status(ctx) {
  const s = await kv.all(ctx);
  const now = nowSec();
  const c = await chats.counts();
  const lastErr = await db.get(sql`SELECT at, source, message FROM aegis_errors ORDER BY id DESC LIMIT 1`);
  const errs = Number((await db.get(sql`SELECT count(*) AS n FROM aegis_errors WHERE at >= ${now - 86400}`)).n);
  const hook = await tryCall(ctx, 'getWebhookInfo', {}, 'webhook-info');
  const active = await bc.active();
  return {
    shutdown: isShutdown(s),
    since: Number(isShutdown(s) ? s.shutdown_at : s.activated_at) || 0,
    by: Number(s.shutdown_by || OWNER_ID),
    version: VERSION,
    phase: PHASE,
    dataVersion: Number(s.data_version || 0),
    users: await users.countReachable(),
    groups: c.groups,
    channels: c.channels,
    registered: await chats.countRegistered(),
    broadcast: active ? { id: Number(active.id), status: active.status } : null,
    errors24h: errs,
    lastError: lastErr ? { at: Number(lastErr.at), source: lastErr.source, message: lastErr.message } : null,
    webhook: hook ? { pending: Number(hook.pending_update_count || 0), lastError: hook.last_error_message || null, lastErrorAt: Number(hook.last_error_date || 0) } : null,
  };
}
