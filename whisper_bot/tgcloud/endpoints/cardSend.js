// The Mini App sends back the finished card (a base64 JPEG/PNG); the bot posts it to the caller's
// own chat, ready to save for Instagram or share in Telegram (lib/card.js).
import { EndpointError } from 'sdk';
import { cardSend } from '../lib/card.js';

export default async function (input, ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (!user || !user.id) throw new EndpointError('Open this from the bot', { code: 'NO_USER' });
  const r = await cardSend(Number(user.id), input || {});
  if (r.error) throw new EndpointError('Card not sent', { code: r.error });
  return r;
}
