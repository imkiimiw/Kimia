// endpoints/miniApi — the 📱 Mini App's server side (POST /api/miniApi). ctx.initData.user is the caller,
// verified by the platform (invalid init data never reaches here). Logic: bot/listener_ui.js#miniApi.
import { EndpointError } from 'sdk';
import { runEndpoint } from '../lib/core/boundary.js';
import { miniApi } from '../lib/bot/listener_ui.js';

export default async function (input, ctx) {
  const from = ctx && ctx.initData && ctx.initData.user;
  if (!from || !Number.isSafeInteger(from.id)) throw new EndpointError('No user', { code: 'NO_USER' });
  const res = await runEndpoint('miniApi', (app) => miniApi(app, from, input && typeof input === 'object' ? input : {}));
  if (!res.ok) throw new EndpointError('Try again', { code: 'FAILED' });
  return res.result;
}
