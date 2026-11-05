/* A channel's new post: archive, approval, footer and buttons, backup copy. See lib/ui/channel.js. */
import { onChannelPost } from '../lib/router.js';

export default async function (message, ctx) {
  return onChannelPost(message, ctx);
}
