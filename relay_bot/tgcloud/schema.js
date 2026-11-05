/*
 * Database tables. With the CLI: `npx tgcloud push`, then `npx tgcloud migrate --safe`.
 * (BotFather: Serverless → Database → paste → Save → Start Migration.)
 * No foreign keys (the platform forbids them). Every query the bot runs looks a row up by its
 * primary key, so no update reads a whole table. Times are unix seconds; flags are 0/1 integers.
 * Only block comments in this project's modules: a paste that loses the line breaks still works.
 */
import { table, integer, text } from 'sdk/db';

/* Everyone who has written to the bot (the owner too: their row only holds last_album). */
export const users = table('users', {
  userId: integer('user_id').primaryKey(), /* Telegram user id */
  firstName: text('first_name'),
  lastName: text('last_name'),
  username: text('username'), /* without @ */
  firstSeen: integer('first_seen').notNull().default(0),
  lastSeen: integer('last_seen').notNull().default(0),
  blocked: integer('blocked').notNull().default(0), /* 1 = blocked by the owner: their messages are dropped */
  lastAlbum: text('last_album'), /* media_group_id of their last album: one card and one "sent" per album */
});

/*
 * Every message the bot puts in the owner's chat about a user's message (the "new message" card, the
 * forward, the copy, the "write your answer" prompt), keyed by its id there. A reply to any of them
 * goes back to user_id, as a reply to user_msg_id. `seen` is set on the card once the user was told
 * the owner saw their message.
 */
export const links = table('links', {
  ownerMsgId: integer('owner_msg_id').primaryKey(),
  userId: integer('user_id').notNull(),
  userMsgId: integer('user_msg_id').notNull(),
  createdAt: integer('created_at').notNull(),
  seen: integer('seen').notNull().default(0),
});
