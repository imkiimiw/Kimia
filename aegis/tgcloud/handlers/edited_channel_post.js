/* A channel post was edited: a new version, the edit lock, the edit alert. See lib/ui/channel.js. */
import { onEditedChannelPost } from '../lib/router.js';

export default async function (message, ctx) {
  return onEditedChannelPost(message, ctx);
}
