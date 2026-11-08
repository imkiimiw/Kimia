/* { room }: the invitation card prepared for Telegram's share dialog, and the room's link. See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { prepareInvite } from '../lib/play.js';

export default endpoint(prepareInvite);
