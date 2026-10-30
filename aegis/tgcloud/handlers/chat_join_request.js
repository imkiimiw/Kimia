/* Join requests: the captcha in the requester's private chat. See lib/router.js and lib/ui/security.js. */
import { onJoinRequest } from '../lib/router.js';

export default async function (request, ctx) {
  return onJoinRequest(request, ctx);
}
