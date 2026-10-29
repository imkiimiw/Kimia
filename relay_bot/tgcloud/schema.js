// Database tables. In BotFather: Serverless → Database → paste this file → Save → Start Migration.
// With the CLI: `npx tgcloud push`, then `npx tgcloud migrate --safe`.
// No foreign keys (the platform forbids them). Every query the bot runs looks a row up by its
// primary key, so no update reads a whole table. Times are unix seconds; flags are 0/1 integers.
import { table, integer, text } from 'sdk/db';

// Everyone who has written to the bot (the owner too: their row only holds last_album).
export const users = table('users', {
  userId: integer('user_id').primaryKey(), // Telegram user id
  firstName: text('first_name'),
  lastName: text('last_name'),
  username: text('username'), // without @
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen: integer('last_seen').notNull().default(0),
  messages: integer('messages').notNull().default(0), // messages relayed to the owner
  blocked: integer('blocked').notNull().default(0), // 1 = blocked by the owner: their messages are dropped
  lastAlbum: text('last_album'), // media_group_id of their last album, so an album gets one "sent" notice
});

// Every message the bot puts in the owner's chat for a user's message (the forward, the copy, and
// the notice sent when a copy fails), keyed by its id there. A reply to any of them is sent back to
// user_id, as a reply to user_msg_id.
export const links = table('links', {
  ownerMsgId: integer('owner_msg_id').primaryKey(),
  userId: integer('user_id').notNull(),
  userMsgId: integer('user_msg_id').notNull(),
  createdAt: integer('created_at').notNull(),
});
