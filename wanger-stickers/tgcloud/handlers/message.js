// handlers/message — private-chat messages. Thin: the boundary and the router do the work.
import { runHandler } from '../lib/boundary.js';
import { onMessage } from '../lib/bot/router.js';

export default function (message, ctx) {
  return runHandler('message', message, ctx, (app) => onMessage(app, message));
}
