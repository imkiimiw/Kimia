// Broadcast end to end: compose → preview → confirm → batches → progress → final report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, advance, OWNER, SEED } from '../helpers/harness.mjs';

const TEST = 222;
const GONE = 333;
const join = (h, id) => { for (const c of SEED) h.tg.setMember(c, id, 'member'); };

async function withUsers(h) {
  for (const id of [TEST, GONE]) {
    join(h, id);
    await h.send(id, '/start');
  }
  h.tg.blocked.add(GONE); // blocked the bot after starting it
}

async function compose(h, extra = { text: 'سلام به همه 🎵' }) {
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'bc:home');
  await h.tap(OWNER, 'bc:new');
  await h.send(OWNER, extra.text ?? null, extra.text ? {} : extra);
  return h.one('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
}

test('a test broadcast to the owner and a test account: preview, progress, a blocked user, final report', async () => {
  const h = setup();
  await withUsers(h);
  const draft = await compose(h);
  assert.equal(draft.status, 'draft');
  const preview = h.tg.callsOf('copyMessage', OWNER).at(-1);
  assert.equal(preview.params.from_chat_id, OWNER, 'preview = a copy to the owner');
  assert.match(h.lastText(OWNER), /برای ۳ کاربر ارسال بشه؟/);

  await h.tap(OWNER, `bc:go:${draft.id}`);
  const b = h.one('SELECT * FROM broadcasts WHERE id = ?', draft.id);
  assert.deepEqual([b.status, b.total, b.sent, b.blocked, b.failed], ['done', 3, 2, 1, 0]);
  assert.deepEqual(h.tg.callsOf('copyMessage').slice(1).map((c) => c.params.chat_id).sort(), [OWNER, TEST, GONE].sort());
  assert.equal(h.one('SELECT is_blocked AS b FROM users WHERE telegram_id = ?', GONE).b, 1, '403 marked the user blocked');
  const progress = h.tg.message(OWNER, b.progress_message_id);
  assert.match(progress.text, /پیام همگانی #۱<\/b> — ✅ تمام شد/);
  assert.match(progress.text, /ارسال‌شده: ۲/);
  assert.match(progress.text, /ربات رو بلاک کرده‌اند: ۱/);
  assert.match(h.lastText(OWNER), /پیام همگانی #۱ تمام شد/, 'final report');
  assert.deepEqual(h.q('SELECT action FROM audit_log ORDER BY id').map((r) => r.action), ['broadcast.start']);
});

test('batches: the tick and «▶️ ادامه» move it forward; pause, resume and cancel work', async () => {
  const h = setup();
  for (let i = 0; i < 6; i++) { join(h, 500 + i); await h.send(500 + i, '/start'); }
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'set:home');
  await h.tap(OWNER, 'set:e:broadcast.batch_size');
  await h.send(OWNER, '2');
  const draft = await compose(h);
  await h.tap(OWNER, `bc:go:${draft.id}`);
  const row = () => h.one('SELECT * FROM broadcasts WHERE id = ?', draft.id);
  assert.deepEqual([row().status, row().sent], ['running', 2], 'first batch on confirm');
  assert.match(h.tg.message(OWNER, row().progress_message_id).text, /مونده: ۵ از ۷/);

  await h.tap(OWNER, `bc:next:${draft.id}`);
  assert.equal(row().sent, 4, '«▶️ ادامه» runs the next batch now');

  await h.tap(OWNER, `bc:pause:${draft.id}`);
  assert.equal(row().status, 'paused');
  advance(61);
  await h.send(500, '/help'); // piggyback tick
  assert.equal(row().sent, 4, 'paused: the tick sends nothing');

  await h.tap(OWNER, `bc:resume:${draft.id}`);
  advance(61);
  await h.send(500, '/help');
  assert.equal(row().sent, 6, 'the piggyback tick sent a batch');

  await h.tap(OWNER, `bc:stop:${draft.id}`);
  assert.match(h.lastText(OWNER), /لغو بشه؟/);
  await h.tap(OWNER, `bc:stopok:${draft.id}`);
  assert.equal(row().status, 'cancelled');
  const sentBefore = h.tg.callsOf('copyMessage').length;
  advance(61);
  await h.send(500, '/help');
  assert.equal(h.tg.callsOf('copyMessage').length, sentBefore, 'cancelled: nothing more');
});

test('429 during a batch: cooldown honoured, nobody skipped or sent twice', async () => {
  const h = setup();
  await withUsers(h);
  const draft = await compose(h);
  h.tg.failNext('copyMessage', 429, 'Too Many Requests: retry after 40', { parameters: { retry_after: 40 }, match: (p) => p.chat_id === TEST });
  await h.tap(OWNER, `bc:go:${draft.id}`);
  const row = () => h.one('SELECT * FROM broadcasts WHERE id = ?', draft.id);
  assert.equal(row().status, 'running');
  const mark = h.mark();
  await h.tap(OWNER, `bc:next:${draft.id}`);
  assert.equal(h.tg.callsOf('copyMessage', undefined, mark).length, 0, 'still cooling down');
  assert.match(h.tg.answers(mark).at(-1).text, /محدودیت سرعت/);
  advance(41);
  await h.tap(OWNER, `bc:next:${draft.id}`);
  assert.equal(row().status, 'done');
  const copiesToTest = h.tg.callsOf('copyMessage', TEST).filter((c) => c.result);
  assert.equal(copiesToTest.length, 1, 'delivered exactly once');
});

test('albums are refused; long texts are accepted; a draft can be discarded', async () => {
  const h = setup();
  await withUsers(h);
  await h.send(OWNER, '/admin');
  await h.tap(OWNER, 'bc:home');
  await h.tap(OWNER, 'bc:new');
  await h.send(OWNER, null, { photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }], media_group_id: 'g1' });
  assert.match(h.lastText(OWNER), /آلبوم/);
  await h.send(OWNER, 'a long message '.repeat(100));
  const d = h.one('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  assert.equal(d.status, 'draft', 'long texts are accepted (copied, not parsed)');
  await h.tap(OWNER, `bc:drop:${d.id}`);
  assert.equal(h.one('SELECT count(*) AS n FROM broadcasts').n, 0);
});
