// endpoints/opsTick — the scheduled tick (spec 10.7, trigger 3). Owner only: called by the GitHub
// Actions schedule through `tgcloud run endpoints/opsTick '{}' --ctx '{ initData: { user: { id: OWNER } } }'`.
// A Mini App call needs the owner's verified init data; anyone else gets FORBIDDEN.
import { EndpointError } from 'sdk';
import { runEndpoint } from '../lib/core/boundary.js';
import { runTick } from '../lib/jobs/tick.js';
import { isOwnerId } from '../lib/permissions/policy.js';
import { recordWebhookCheck } from '../lib/core/health.js';

export default async function (input, ctx) {
  const uid = ctx && ctx.initData && ctx.initData.user ? ctx.initData.user.id : null;
  if (!isOwnerId(uid)) throw new EndpointError('Forbidden', { code: 'FORBIDDEN' });
  return runEndpoint('opsTick', async (app) => {
    // Phase 8: the GitHub Actions job passes what `tgcloud webhook` reported (scripts/webhook-state.mjs)
    if (input && typeof input === 'object' && input.webhook && typeof input.webhook === 'object') await recordWebhookCheck(app, input.webhook);
    await app.settings.setInternal('monitor.scheduled_at', app.clock.now());
    return runTick(app, 'scheduled', Number(await app.settings.get('tick.budget_ms')));
  });
}
