// endpoints/tick — the optional scheduled tick (.github/workflows/mother-tick.yml). Owner only: called
// with `npx tgcloud run endpoints/tick '{}' --ctx '{ initData: { user: { id: 5557901897 } } }'`.
// Runs the due work with full limits: health checks of every bot, ends of maintenance, the monthly club
// campaign and queued broadcasts. A Mini App call needs the owner's verified init data.
import { EndpointError } from 'sdk';
import { OWNER_ID } from '../lib/config.js';
import { onTick } from '../lib/router.js';

export default async function (input, ctx) {
  const uid = ctx && ctx.initData && ctx.initData.user ? Number(ctx.initData.user.id) : null;
  if (uid !== OWNER_ID) throw new EndpointError('Forbidden', { code: 'FORBIDDEN' });
  return onTick();
}
