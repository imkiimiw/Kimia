// handlers/channel_post — new posts in channels where the bot is admin; only registered sources count.
import { runHandler } from '../lib/core/boundary.js';
import { onChannelPost } from '../lib/bot/router.js';

export default function (post, ctx) {
  return runHandler('channel_post', post, ctx, (app) => onChannelPost(app, post));
}
