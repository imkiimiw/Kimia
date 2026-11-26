// A poll the mother stopped: the bot waking itself up between steps of long work (lib/wake.js).
import { onPoll } from '../lib/router.js';

export default async function (poll) {
  try {
    return await onPoll(poll);
  } catch (err) {
    console.error('poll handler failed:', err);
    return { error: true };
  }
}
