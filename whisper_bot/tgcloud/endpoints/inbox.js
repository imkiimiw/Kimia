// The inbox inside the Mini App (webapp/inbox.html): list, read, act on and reply to the caller's own
// anonymous messages (lib/miniinbox.js). The caller is the platform-verified initData user.
import { EndpointError } from 'sdk';
import { inboxCall } from '../lib/miniinbox.js';

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) throw new EndpointError('Open this from the bot', { code: 'NO_USER' });
  const r = await inboxCall(Number(user.id), input || {});
  if (r.error) throw new EndpointError(r.message || 'Not available', { code: r.error });
  return r;
}
