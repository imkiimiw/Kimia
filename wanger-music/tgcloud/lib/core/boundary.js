// The error boundary around every handler and endpoint: dedupe → run → piggyback tick → write the
// analytics counters buffered during the update (one statement), and on any
// error: structured log → error_log row → throttled owner alert → normal return (never rethrows,
// since platform redelivery after a throw is undocumented; see docs/PLATFORM_NOTES.md).
import { createApp } from './context.js';
import { maybePiggyback } from '../jobs/tick.js';
import { createLogger } from './logger.js';
import { LIMITS } from '../config/static.js';
import { t } from '../i18n/index.js';
import { truncate } from './util.js';

/** Logs, stores and (throttled) alerts an error. Never throws. */
async function report(app, handler, updateId, userId, err) {
  const log = app ? app.log : createLogger({ update_id: updateId, handler });
  log.error('handler_failed', { handler, user_id: userId, error_code: String((err && (err.code || err.name)) || 'Error'), error: String((err && (err.description || err.message)) || err) });
  if (!app) return;
  await app.alerts.recordError({ handler, updateId, userId, err, context: { kind: app.kind } });
  await app.alerts.owner(`err:${handler}`, (lang) => t(lang, 'alert.error', {
    handler,
    code: String((err && (err.code || err.name)) || 'Error'),
    message: truncate(String((err && (err.description || err.message)) || err), 200),
  }), LIMITS.alertErrorEverySeconds);
}

/**
 * @param {string} kind update type (handler name)
 * @param {any} payload the update payload
 * @param {any} ctx platform context (ctx.update.update_id)
 * @param {(app: any) => Promise<any>} fn
 * @param {{dedupe?: boolean, tick?: boolean}} [opts]
 */
export async function runHandler(kind, payload, ctx, fn, { dedupe = true, tick = true } = {}) {
  const updateId = ctx && ctx.update && Number.isSafeInteger(ctx.update.update_id) ? ctx.update.update_id : null;
  const userId = payload && payload.from ? payload.from.id : null;
  let app = null;
  const started = Date.now();
  try {
    app = await createApp({ kind, updateId });
    if (dedupe && updateId !== null && !(await app.repos.system.claimUpdate(updateId, app.clock.now()))) {
      app.log.info('duplicate_update', { user_id: userId });
      return { ok: true, duplicate: true };
    }
    const result = await fn(app);
    let tickSummary = null;
    if (tick) {
      try {
        tickSummary = await maybePiggyback(app);
      } catch (e) {
        await report(app, `tick:${kind}`, updateId, userId, e);
      }
    }
    await app.stats.flush();
    app.log.info('handled', { user_id: userId, status: typeof result === 'string' ? result : 'ok', duration_ms: Date.now() - started });
    return { ok: true, result, tick: tickSummary ? tickSummary.results : null, trace: app.tg.trace };
  } catch (e) {
    await report(app, kind, updateId, userId, e);
    if (app) await app.stats.flush(); // what happened before the error still counts (flush never throws)
    return { ok: false, trace: app ? app.tg.trace : [] };
  }
}

/** Same boundary for endpoints (no dedupe, no piggyback tick). */
export async function runEndpoint(name, fn) {
  let app = null;
  try {
    app = await createApp({ kind: `endpoint:${name}` });
    const result = await fn(app);
    await app.stats.flush();
    return { ok: true, result, trace: app.tg.trace };
  } catch (e) {
    await report(app, `endpoint:${name}`, null, null, e);
    return { ok: false };
  }
}
