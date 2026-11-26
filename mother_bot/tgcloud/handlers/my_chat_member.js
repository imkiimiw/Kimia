// The mother was blocked / unblocked by a user (private chat): broadcasts skip blocked users.
import { onMyChatMember } from '../lib/router.js';

export default async function (update) {
  try {
    return await onMyChatMember(update);
  } catch (err) {
    console.error('my_chat_member handler failed:', err);
    return { error: true };
  }
}
