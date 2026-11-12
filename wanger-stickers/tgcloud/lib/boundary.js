// The error boundary around every handler: build the app → de-duplicate the update → run → the
// piggyback tick (after the reply) → flush stats. On any error: structured log → errors row →
// throttled owner alert → a normal return (never rethrows; platform redelivery after a throw is
// undocumented). Handlers return { ok, result, trace } so `tgcloud run` shows every Bot API call.
// (Adapted from wanger-music lib/core/boundary.js.)
import { createApp } from './app.js';
import { createAccount } from './wanger/account.js';
import { createGate } from './wanger/gate.js';
import { createBroadcast } from './wanger/broadcast.js';
import { createPacks } from './packs/service.js';
import { createOps } from './packs/ops.js';
import { createPublish } from './packs/publish.js';
import { createTransfer } from './studio/transfer.js';
import { runTick } from './jobs.js';
import { system } from './db/system.js';
import { users } from './db/users.js';
import { classify } from './core/errors.js';
import { truncate } from './core/util.js';
import { t } from './i18n/index.js';
import { T } from './config.js';
import { notifyBroadcast } from './admin/broadcast_ui.js';
import { notifyOp } from './bot/packs_ui.js';

/** Builds the app with every service wired in. */
export async function buildApp(kind, updateId = null) {
  const app = await createApp({ kind, updateId });
  app.account = createAccount(app);
  app.gate = createGate(app);
  app.packs = createPacks(app, app.account);
  app.ops = createOps(app, app.packs);
  app.publish = createPublish(app);
  app.transfer = createTransfer(app);
  app.broadcast = createBroadcast(app, { notify: (b, info) => notifyBroadcast(app, b, info) });
  app.opsNotify = (op, stopped) => notifyOp(app, op, stopped);
  return app;
}

/** The reply to the sender failed because they can't be reached: nothing is wrong with the bot. */
function senderUnreachable(app, userId, err) {
  if (!app || !userId) return null;
  const kind = classify(err).kind;
  if (!['blocked', 'chat_gone', 'rate_limit'].includes(kind)) return null;
  const last = [...app.tg.trace].reverse().find((c) => !c.ok);
  return last && Number(last.chat_id) === userId ? kind : null;
}

async function report(app, scope, userId, err) {
  if (senderUnreachable(app, userId, err)) {
    if (classify(err).kind !== 'rate_limit') await users.markBlocked(userId, true).catch(() => null);
    return;
  }
  if (!app) {
    console.error(JSON.stringify({ level: 'error', event: 'boot_failed', handler: scope, error: String(err && err.message).slice(0, 300) }));
    return;
  }
  app.log.error('handler_failed', { handler: scope, user_id: userId, error_code: String((err && (err.code || err.name)) || 'Error'), error: String((err && (err.description || err.message)) || err) });
  await app.alerts.recordError(scope, userId, err);
  if (app.settings.get('notify.errors')) {
    await app.alerts.owner(`err:${scope}`, (lang) => t(lang, 'alert.error', { scope, code: String((err && (err.code || err.name)) || 'Error'), message: truncate(String((err && (err.description || err.message)) || err), 200) }), T.alertErrorEverySec);
  }
}

/**
 * @param {string} kind @param {any} payload @param {any} ctx @param {(app: any) => Promise<any>} fn
 * @param {{dedupe?: boolean, tick?: boolean}} [opts]
 */
export async function runHandler(kind, payload, ctx, fn, { dedupe = true, tick = true } = {}) {
  const updateId = ctx && ctx.update && Number.isSafeInteger(ctx.update.update_id) ? ctx.update.update_id : null;
  const userId = payload && payload.from ? payload.from.id : null;
  let app = null;
  try {
    app = await buildApp(kind, updateId);
    if (dedupe && updateId !== null && !(await system.claimUpdate(updateId, app.clock.now()))) return { ok: true, duplicate: true };
    const result = await fn(app);
    let tickOut = null;
    if (tick) {
      try {
        tickOut = await runTick(app, { budgetMs: T.piggybackBudgetMs });
      } catch (e) {
        await report(app, `tick:${kind}`, userId, e);
      }
    }
    await app.stats.flush();
    return { ok: true, result, tick: tickOut, trace: app.tg.trace };
  } catch (e) {
    await report(app, kind, userId, e);
    if (app) await app.stats.flush();
    return { ok: false, trace: app ? app.tg.trace : [] };
  }
}
