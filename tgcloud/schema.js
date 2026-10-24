// Database tables. Deploy with `npx tgcloud push`, then create/update the tables with `npx tgcloud migrate`.
// Queries are in lib/store.js and use these SQL column names. Times are unix milliseconds.
import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey(), // Telegram user id
  firstName: text('first_name'),
  username: text('username'),
  createdAt: integer('created_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
  taskSeq: integer('task_seq').notNull().default(0), // last per-user task number
  state: text('state'), // JSON: what the bot is waiting for (new task text, a date, ...)
  digestHour: integer('digest_hour'), // local hour of the daily digest, null = off
  digestNext: integer('digest_next'), // when the next digest is due
  blocked: integer('blocked').notNull().default(0), // 1 = the user blocked the bot
}, (t) => ({
  digest: index('idx_users_digest').on(t.digestNext).where(sql`digest_next IS NOT NULL`),
}));

export const tasks = table('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  num: integer('num').notNull(), // number shown to the user, unique per user
  text: text('text').notNull(),
  note: text('note'),
  priority: integer('priority').notNull().default(2), // 1 high, 2 medium, 3 low
  category: text('category'),
  dueAt: integer('due_at'),
  dueTime: integer('due_time').notNull().default(0), // 1 = the due date has a time of day
  remindAt: integer('remind_at'),
  repeat: text('repeat'), // d / w / m
  done: integer('done').notNull().default(0),
  doneAt: integer('done_at'),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  userNum: uniqueIndex('uq_tasks_user_num').on(t.userId, t.num),
  userDone: index('idx_tasks_user').on(t.userId, t.done),
  remind: index('idx_tasks_remind').on(t.remindAt).where(sql`remind_at IS NOT NULL`),
}));

export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  chat: text('chat').notNull().unique(), // @username or -100… id
  title: text('title'),
  link: text('link').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromChat: integer('from_chat').notNull(),
  messageId: integer('message_id').notNull(),
  cursor: integer('cursor').notNull().default(0), // last user id already handled
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  status: text('status').notNull().default('running'),
  createdAt: integer('created_at').notNull(),
});
