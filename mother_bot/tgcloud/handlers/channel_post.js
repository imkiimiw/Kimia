// A post in a channel the mother is in: the hub, where the child bots report (lib/hub.js).
import { onChannelPost } from '../lib/router.js';

export default async function (post) {
  try {
    return await onChannelPost(post);
  } catch (err) {
    console.error('channel_post handler failed:', err);
    return { error: true };
  }
}
