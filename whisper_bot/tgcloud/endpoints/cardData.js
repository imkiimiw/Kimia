// The Mini App asks what to draw on a card. The caller is the platform-verified initData user, and
// only their own link, question or received messages are returned (lib/card.js).
import { EndpointError } from 'sdk';
import { cardData } from '../lib/card.js';

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) throw new EndpointError('Open this from the bot', { code: 'NO_USER' });
  const r = await cardData(Number(user.id), input || {});
  if (r.error) throw new EndpointError('Not available', { code: r.error });
  return r;
}
