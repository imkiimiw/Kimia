// BroadcastService with fakes: batches, caps, 403/429/transient handling, state transitions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastService, broadcastRefusal } from '../../tgcloud/lib/broadcast/service.js';
import { createTelegramClient } from '../../tgcloud/lib/telegram/client.js';
import { OWNER_ID } from '../../tgcloud/lib/config/static.js';
import { fakeClock, fakeSettings, fakeAudit, apiError, noLog } from '../helpers/fakes.mjs';

function fakeRepo() {
  const rows = new Map();
  let id = 0;
  return {
    rows,
    create: async (b) => { const r = { id: ++id, status: 'draft', cursor_user_id: 0, total: 0, sent: 0, failed: 0, blocked: 0, lock_until: null, ...b, source_chat_id: b.source_chat_id }; rows.set(r.id, r); return { ...r }; },
    get: async (i) => (rows.has(i) ? { ...rows.get(i) } : null),
    recent: async () => [...rows.values()],
    active: async () => [...rows.values()].find((r) => r.status === 'running' || r.status === 'paused') || null,
    nextRunnable: async (now) => [...rows.values()].find((r) => r.status === 'running' && (!r.lock_until || r.lock_until < now)) || null,
    start: async (i, total, now, c, m) => { const r = rows.get(i); if (!r || r.status !== 'draft' || [...rows.values()].some((x) => x.status === 'running' || x.status === 'paused')) return null; Object.assign(r, { status: 'running', total, started_at: now, progress_chat_id: c, progress_message_id: m }); return { ...r }; },
    transition: async (i, from, to) => { const r = rows.get(i); if (!r || !from.includes(r.status)) return null; r.status = to; if (to === 'done' || to === 'cancelled') r.lock_until = null; return { ...r }; },
    claim: async (i, now, until) => { const r = rows.get(i); if (!r || r.status !== 'running' || (r.lock_until && r.lock_until >= now)) return null; r.lock_until = until; return { ...r }; },
    release: async (i) => { rows.get(i).lock_until = null; },
    recordOne: async (i, uid, outcome) => { const r = rows.get(i); if (r.cursor_user_id >= uid) return null; r.cursor_user_id = uid; r[outcome] += 1; return r.status; },
    deleteDraft: async (i) => (rows.get(i) && rows.get(i).status === 'draft' ? (rows.delete(i), 1) : 0),
  };
}

function make({ recipients = 5, batch = 25, blocked = [], failWith = {} } = {}) {
  const clock = fakeClock();
  const repo = fakeRepo();
  const list = Array.from({ length: recipients }, (_, i) => ({ id: i + 1, telegram_id: 100 + i + 1 }));
  const users = { countRecipients: async () => list.length, recipientsAfter: async (cursor, limit) => list.filter((r) => r.id > cursor).slice(0, limit) };
  const copies = [];
  const tg = {
    async copy(chatId) {
      copies.push(chatId);
      if (failWith[chatId]) {
        const f = failWith[chatId];
        if (typeof f === 'function') return f();
        throw f;
      }
      if (blocked.includes(chatId)) throw apiError(403, 'Forbidden: bot was blocked by the user');
      return { message_id: 1 };
    },
  };
  const settings = fakeSettings({ 'broadcast.batch_size': batch });
  const notified = [];
  const svc = createBroadcastService({ repo, users, tg, settings, audit: fakeAudit(), clock, log: noLog, notify: async (b, info) => notified.push([b.status, info.done]) });
  return { svc, repo, copies, clock, settings, notified };
}
const owner = { telegram_id: OWNER_ID, role: 'user' };
const ownerMessage = { chat: { id: OWNER_ID }, message_id: 9, text: 'hello all' };

async function running(f) {
  const d = await f.svc.createDraft(owner, ownerMessage);
  await f.svc.start(owner, d.id, OWNER_ID, 1);
  return d.id;
}

test('batches respect the batch size; the last batch finishes the broadcast', async () => {
  const f = make({ recipients: 5, batch: 2 });
  const id = await running(f);
  let r = await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  assert.deepEqual([r.sent, r.done], [2, false]);
  r = await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  assert.deepEqual([r.sent, r.done], [2, false]);
  r = await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  assert.deepEqual([r.sent, r.done], [1, true]);
  assert.deepEqual(f.copies, [101, 102, 103, 104, 105]);
  const b = await f.repo.get(id);
  assert.deepEqual([b.status, b.sent, b.lock_until], ['done', 5, null]);
  assert.deepEqual(f.notified.at(-1), ['done', true]);
  assert.deepEqual(await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 }), { skipped: 'none' });
});

test('403 counts as blocked; other 4xx as failed; transient retried once', async () => {
  let n = 0;
  const flaky = () => { n += 1; if (n === 1) throw apiError(500, 'Internal'); return { message_id: 2 }; };
  const f = make({ recipients: 4, blocked: [102], failWith: { 103: apiError(400, 'Bad Request: chat not found'), 104: flaky } });
  const id = await running(f);
  await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  const b = await f.repo.get(id);
  assert.deepEqual([b.sent, b.blocked, b.failed, b.status], [2, 1, 1, 'done']);
  assert.equal(f.copies.filter((c) => c === 104).length, 2);
});

test('429: stops the batch, sets the global cooldown, does not advance past that user', async () => {
  const f = make({ recipients: 3, failWith: { 102: apiError(429, 'Too Many Requests', { retry_after: 30 }) } });
  const id = await running(f);
  const r = await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  assert.equal(r.stopped, 'rate_limit');
  assert.equal(f.settings.m.get('telegram.cooldown_until'), f.clock.now() + 30);
  assert.equal((await f.repo.get(id)).cursor_user_id, 1);
  assert.deepEqual(await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 }), { skipped: 'cooldown', until: f.clock.now() + 30 });
  f.clock.advance(31);
  const r2 = await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 });
  assert.equal(r2.stopped, 'rate_limit', 'the fake still fails 102: retried, never skipped');
});

test('time budget stops the batch without losing anyone', async () => {
  const f = make({ recipients: 5 });
  const id = await running(f);
  const r = await f.svc.runBatch({ deadlineMs: f.clock.ms() });
  assert.equal(r.stopped, 'budget');
  assert.equal((await f.repo.get(id)).cursor_user_id, 0);
  assert.equal((await f.repo.get(id)).lock_until, null, 'lease released');
});

test('pause, resume and cancel are conditional transitions', async () => {
  const f = make({ recipients: 3, batch: 1 });
  const id = await running(f);
  await f.svc.control(owner, id, 'pause');
  assert.deepEqual(await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 }), { skipped: 'none' });
  await assert.rejects(f.svc.control(owner, id, 'pause'), /bc\.err\.state/);
  await f.svc.control(owner, id, 'resume');
  assert.equal((await f.svc.runBatch({ deadlineMs: f.clock.ms() + 10_000 })).sent, 1);
  await f.svc.control(owner, id, 'cancel');
  assert.equal((await f.repo.get(id)).status, 'cancelled');
  await assert.rejects(f.svc.control(owner, id, 'resume'), /bc\.err\.state/);
  assert.deepEqual(await f.svc.runBatch({ id, deadlineMs: f.clock.ms() + 10_000 }), { skipped: 'none' });
});

test('one broadcast at a time; drafts can be discarded; empty audience refused', async () => {
  const f = make();
  await running(f);
  const d2 = await f.svc.createDraft(owner, { ...ownerMessage, message_id: 10 });
  await assert.rejects(f.svc.start(owner, d2.id, OWNER_ID, 2), /bc\.err\.busy/);
  assert.equal(await f.svc.discard(owner, d2.id), true);
  const e = make({ recipients: 0 });
  const d = await e.svc.createDraft(owner, ownerMessage);
  await assert.rejects(e.svc.start(owner, d.id, OWNER_ID, 1), /bc\.err\.empty/);
});

test('owner-only even when called directly; albums and service messages refused', async () => {
  const f = make();
  await assert.rejects(f.svc.createDraft({ telegram_id: 5, role: 'admin' }, ownerMessage), /permission denied/);
  assert.equal(broadcastRefusal({ media_group_id: '1', photo: [] }), 'bc.err.album');
  assert.equal(broadcastRefusal({ new_chat_title: 'x' }), 'bc.err.unsupported');
  assert.equal(broadcastRefusal({ text: 'hi' }), null);
});

test('telegram client: 403 marks the user blocked; not-modified edits succeed; gone messages are re-sent; answers never throw', async () => {
  const blockedIds = [];
  const calls = [];
  const api = new Proxy({}, {
    get: (_, method) => async (p) => {
      calls.push(method);
      if (method === 'sendMessage' && p.chat_id === 7) throw apiError(403, 'Forbidden: bot was blocked by the user');
      if (method === 'editMessageText' && p.message_id === 1) throw apiError(400, 'Bad Request: message is not modified');
      if (method === 'editMessageText' && p.message_id === 2) throw apiError(400, 'Bad Request: message to edit not found');
      if (method === 'answerCallbackQuery') throw apiError(400, 'Bad Request: query is too old');
      return { message_id: 99 };
    },
  });
  const tg = createTelegramClient({ log: noLog, onBlocked: async (id) => blockedIds.push(id), api });
  await assert.rejects(tg.send(7, { text: 'x' }));
  assert.deepEqual(blockedIds, [7]);
  assert.equal(await tg.edit(8, 1, { text: 'x' }), true);
  assert.deepEqual(await tg.edit(8, 2, { text: 'x' }), { message_id: 99 });
  assert.equal(calls.at(-1), 'sendMessage');
  assert.equal(await tg.answer('cq', { text: 'hi' }), false);
  assert.equal(tg.trace.length, 5);
  assert.deepEqual(tg.trace[0], { method: 'sendMessage', view: undefined, chat_id: 7, ok: false, code: 403, kind: 'blocked' });
});
