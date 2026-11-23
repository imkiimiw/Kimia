// A new post in a channel the bot is in. In the wake channel it ticks the outside clock (lib/wake.js);
// elsewhere (the forced-join channels) it only carries the usual side work.
import { onChannelPost } from '../lib/router.js';

export default async function (post) {
  try {
    return await onChannelPost(post);
  } catch (err) {
    console.error('channel_post handler failed:', err);
    return { error: true };
  }
}
