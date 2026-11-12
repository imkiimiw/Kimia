// The boundary for Mini App endpoints (brief §6, §13): the caller is ctx.initData.user (verified
// by the platform; a client-sent id is never trusted) → maintenance → ban → rate limit → the gate
// (JOIN_REQUIRED with the channels to join) → strict input check (unknown fields refused) → run.
// UserError → EndpointError with a translated description and a machine code; anything else is
// logged and becomes the platform's generic 500.
import { EndpointError } from 'sdk';
import { buildApp } from './boundary.js';
import { system } from './db/system.js';
import { joinUrl } from './core/gate.js';
import { UserError, PermissionError } from './core/util.js';
import { OWNER_ID, T } from './config.js';

/** Type checks for endpoint input: { field: 'string'|'int'|'bool'|'string?'|… } */
function checkInput(input, shape) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EndpointError('Bad input', { code: 'BAD_INPUT' });
  for (const k of Object.keys(input)) if (!(k in shape)) throw new EndpointError(`Unknown field ${k}`, { code: 'BAD_INPUT', field: k });
  for (const [k, type] of Object.entries(shape)) {
    const optional = type.endsWith('?');
    const t = optional ? type.slice(0, -1) : type;
    const v = input[k];
    if (v === undefined || v === null) {
      if (!optional) throw new EndpointError(`Missing ${k}`, { code: 'BAD_INPUT', field: k });
      continue;
    }
    const ok = t === 'int' ? Number.isSafeInteger(v) : t === 'bool' ? typeof v === 'boolean' : t === 'string' ? typeof v === 'string' && v.length <= 1500000 : false;
    if (!ok) throw new EndpointError(`Bad ${k}`, { code: 'BAD_INPUT', field: k });
  }
}

async function allow(app) {
  if (app.user.tg_id === OWNER_ID) return true;
  const now = app.clock.now();
  const row = await system.getBucket(app.user.tg_id, 'api');
  const cap = T.floodBurst * 3; // a Studio session makes several calls per export
  const tokens = row ? Math.min(cap, row.tokens + (now - row.updated_at) * T.floodRefillPerSec * 3) : cap;
  if (tokens < 1) return false;
  await system.setBucket(app.user.tg_id, 'api', tokens - 1, now);
  return true;
}

/**
 * @param {string} name @param {any} input @param {any} ctx
 * @param {Record<string, string>} shape @param {(app: any, input: any) => Promise<any>} fn
 * @param {{gate?: boolean}} [opts]
 */
export async function runEndpoint(name, input, ctx, shape, fn, { gate = true } = {}) {
  const tgUser = ctx && ctx.initData && ctx.initData.user;
  if (!tgUser || !Number.isSafeInteger(tgUser.id)) throw new EndpointError('No user', { code: 'NO_USER' });
  checkInput(input, shape);
  let app = null;
  try {
    app = await buildApp(`endpoint:${name}`);
    const row = await app.account.ensureAccount(tgUser);
    await app.setUser(row);
    const isOwner = row.tg_id === OWNER_ID;
    if (app.settings.get('maintenance.on') && !isOwner) throw new EndpointError(app.tp('common.maintenance_short'), { code: 'MAINTENANCE' });
    if (row.banned && !isOwner) throw new EndpointError(app.tp('common.banned_short'), { code: 'BANNED' });
    if (!app.flag('studio') && !isOwner) throw new EndpointError(app.tp('common.feature_off'), { code: 'FEATURE_OFF' });
    if (!(await allow(app))) throw new EndpointError(app.tp('common.too_fast_short'), { code: 'TOO_FAST' });
    if (gate && !isOwner) {
      const verdict = await app.gate.check(app.user);
      if (!verdict.passed) {
        throw new EndpointError(app.tp('gate.still_missing'), {
          code: 'JOIN_REQUIRED',
          channels: verdict.missing.map((c) => ({ title: c.title || c.username || '', url: joinUrl(c) })).filter((c) => c.url),
        });
      }
    }
    const result = await fn(app, input);
    await app.stats.flush();
    return result;
  } catch (e) {
    if (e instanceof EndpointError) throw e;
    if (e instanceof UserError) throw new EndpointError(app ? app.tp(e.key, e.vars).replace(/<[^>]+>/g, '') : e.key, { code: e.key });
    if (e instanceof PermissionError) throw new EndpointError('Not allowed', { code: 'FORBIDDEN' });
    if (app) {
      app.log.error('endpoint_failed', { handler: name, user_id: tgUser.id, error: String((e && (e.description || e.message)) || e) });
      await app.alerts.recordError(`endpoint:${name}`, tgUser.id, e);
      await app.stats.flush();
    }
    throw e;
  }
}
