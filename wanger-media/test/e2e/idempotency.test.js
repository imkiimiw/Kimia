import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALICE, setup } from '../helpers/harness.js';

let h;
beforeEach(() => { h = setup(); h.tg.setMember(ALICE.id); });
afterEach(() => { vi.useRealTimers(); });

describe('duplicate updates and double taps', () => {
  it('the same update_id twice is handled once', async () => {
    const first = await h.send(ALICE, '/start', { id: 777 });
    expect(first.view).toBe('language');
    const sent = h.tg.calls('sendMessage').length;
    const again = await h.send(ALICE, '/start', { id: 777 });
    expect(again).toMatchObject({ ok: true, dup: true });
    expect(h.tg.calls('sendMessage')).toHaveLength(sent);
    expect(h.counter('users')).toBe(1);
  });

  it('a redelivered button press is skipped too', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en', { id: 900 });
    const before = h.tg.state.calls.length;
    expect((await h.press(ALICE, 'L:en', { id: 900 })).dup).toBe(true);
    expect(h.tg.state.calls.length).toBe(before);
  });

  it('a double tap on the same button is answered silently and does nothing', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en', { messageId: 50 });
    const edits = h.tg.calls('editMessageText').length;
    const r = await h.press(ALICE, 'L:en', { messageId: 50 });
    expect(r.doubleTap).toBe(true);
    expect(h.tg.calls('editMessageText')).toHaveLength(edits);
    expect(h.tg.calls('answerCallbackQuery').at(-1).params.text).toBeUndefined();
  });

  it('parallel double taps: exactly one is processed', async () => {
    await h.send(ALICE, '/start');
    const [a, b] = await Promise.all([h.press(ALICE, 'L:fa', { messageId: 60 }), h.press(ALICE, 'L:fa', { messageId: 60 })]);
    expect([a.doubleTap, b.doubleTap].filter(Boolean)).toHaveLength(1);
  });

  it('the same button pressed again after the window, or a different button, works', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:en', { messageId: 70 });
    expect((await h.press(ALICE, 'l', { messageId: 70 })).view).toBe('language');
    h.advance(2);
    expect((await h.press(ALICE, 'l', { messageId: 70 })).doubleTap).toBeUndefined();
  });

  it('setting the same language twice is harmless', async () => {
    await h.send(ALICE, '/start');
    await h.press(ALICE, 'L:ru', { messageId: 80 });
    await h.press(ALICE, 'L:ru', { messageId: 81 });
    expect(h.row('SELECT lang FROM users WHERE id = ?', ALICE.id).lang).toBe('ru');
  });
});

describe('housekeeping', () => {
  it('deletes processed update ids older than two days, at most every 10 minutes', async () => {
    await h.send(ALICE, '/start', { id: 1 });
    expect(h.rows('SELECT update_id FROM processed_updates')).toHaveLength(1);
    h.advance(3 * 86400);
    const r = await h.send(ALICE, 'later', { id: 2 });
    expect(r.housekeeping).toEqual({ updates: 1, errors: 0 });
    expect(h.rows('SELECT update_id FROM processed_updates').map((x) => x.update_id)).toEqual([2]);
    const soon = await h.send(ALICE, 'soon', { id: 3 });
    expect(soon.housekeeping).toBeUndefined();
  });
});

describe('error boundary', () => {
  it('an unexpected failure is logged, the owner alerted, the user told — and the handler returns', async () => {
    await h.send(ALICE, '/start');
    h.tg.failNext('editMessageText', h.tg.err(500, 'Internal Server Error'));
    const r = await h.press(ALICE, 'L:en');
    expect(r.ok).toBe(false);
    expect(h.rows('SELECT source, message FROM error_log')).toEqual([{ source: 'callback_query', message: '[500] Internal Server Error' }]);
    expect(h.tg.calls('sendMessage').some((c) => c.params.chat_id === 5557901897)).toBe(true);
    expect(h.tg.calls('sendMessage').at(-1).params.text).toBe('⚠️ Something went wrong. Please try again.');
  });

  it('a user who blocked the bot is marked blocked, not reported as an error', async () => {
    await h.send(ALICE, '/start');
    h.tg.unreachable(ALICE.id);
    const r = await h.send(ALICE, '/language');
    expect(r.ok).toBe(true);
    expect(h.row('SELECT blocked FROM users WHERE id = ?', ALICE.id).blocked).toBe(1);
    expect(h.rows('SELECT id FROM error_log')).toHaveLength(0);
  });

  it('a chat that can no longer be reached (blocked, deleted, a fake id) is not reported as an error', async () => {
    await h.send(ALICE, '/start');
    h.tg.failNext('editMessageText', h.tg.err(400, 'Bad Request: chat not found'));
    const r = await h.press(ALICE, 'L:en');
    expect(r.ok).toBe(true);
    expect(h.rows('SELECT id FROM error_log')).toHaveLength(0);
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === 5557901897)).toHaveLength(0);
  });

  it('an unknown user id ("user not found") never marks a channel broken or alerts the owner', async () => {
    await h.send(ALICE, '/start');
    for (const ch of h.tg.state.channels) h.tg.state.members.set(`${ch.id}|${ALICE.id}`, h.tg.err(400, 'Bad Request: user not found'));
    const r = await h.press(ALICE, 'L:en');
    expect(r.join).toMatchObject({ pass: false, unknown: 3 });
    expect(h.rows("SELECT id FROM forced_channels WHERE bot_status != 'ok'")).toHaveLength(0);
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === 5557901897)).toHaveLength(0);
  });
});
