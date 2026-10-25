// Database tables. Deploy with `npx tgcloud push`, then create them with `npx tgcloud migrate`.
// No foreign keys (the platform forbids them): every user-owned row carries user_id, and
// lib/store.js filters every query by it. Times are unix seconds.
import { table, integer, text, index, uniqueIndex } from 'sdk/db';

export const users = table('users', {
  id: integer('id').primaryKey(), // Telegram user id
  firstName: text('first_name'),
  sort: text('sort').notNull().default('p'), // list order: p = priority, d = due date, n = newest
  lastSearch: text('last_search'), // the last /search query, for paging its results
  createdAt: integer('created_at').notNull(),
});

export const tasks = table('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  text: text('text').notNull(),
  done: integer('done').notNull().default(0), // 0 / 1
  priority: integer('priority').notNull().default(2), // 1 high, 2 medium, 3 low
  dueDate: text('due_date'), // Gregorian YYYY-MM-DD, compared as text
  categoryId: integer('category_id'), // categories.id of the same user, or null
  createdAt: integer('created_at').notNull(),
  doneAt: integer('done_at'),
}, (t) => ({
  byUser: index('idx_tasks_user').on(t.userId, t.done, t.priority),
  byCategory: index('idx_tasks_user_cat').on(t.userId, t.categoryId),
}));

export const categories = table('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  userName: uniqueIndex('uq_categories_user_name').on(t.userId, t.name),
}));

// Mandatory-join channels (at most 10, managed from the owner panel).
export const channels = table('channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  uname: text('uname').notNull().unique(), // lowercase username, for duplicate checks
  username: text('username').notNull(), // as Telegram spells it, without @
  chatId: integer('chat_id'), // numeric id, once known
  title: text('title'),
  warnedAt: integer('warned_at').notNull().default(0), // last "membership check failed" warning to the owner
  createdAt: integer('created_at').notNull(),
});

// Bot-wide key/value settings: join (1/0), seeded (1), users (count).
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// What the bot is waiting for from a user (task text, a date, a channel username, ...).
export const userState = table('user_state', {
  userId: integer('user_id').primaryKey(),
  state: text('state').notNull(),
  data: text('data'), // JSON
  updatedAt: integer('updated_at').notNull(),
});
