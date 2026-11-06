// The platform fails any query that reads ≈ 50 000 rows (docs/PLATFORMS.md §1). This runs every
// Phase 1 flow, then asks SQLite for the plan of every distinct statement the bot executed: none may
// scan a table that grows with users or traffic. Tables that are small by construction are allowed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawDatabase, stats } from '../sdk/db.js';
import { CHANNELS } from '../helpers/telegram.js';
import { ALICE, BORIS, OWNER, setup } from '../helpers/harness.js';

// forced_channels: ≤ 10 rows. error_log: the trim reads at most ERROR_LOG_KEEP + 1 rows by rowid.
const SMALL = new Set(['forced_channels', 'error_log']);

afterEach(() => { vi.useRealTimers(); });

describe('query plans', () => {
  it('no statement scans a growing table', async () => {
    const h = setup();
    const log = [];
    const capture = () => { log.push(...stats.log); stats.log = []; };
    await h.send(ALICE, '/start'); capture();
    h.tg.setMember(ALICE.id, 'member', [CHANNELS[0].id]);
    await h.press(ALICE, 'L:en'); capture();
    h.tg.setMember(ALICE.id);
    await h.press(ALICE, 'j', { messageId: 3 }); capture();
    await h.press(ALICE, 'j', { messageId: 3 }); capture(); // double tap
    await h.send(ALICE, '/language'); capture();
    await h.send(OWNER, '/start'); capture();
    await h.send(BORIS, 'hi'); capture();
    h.tg.failNext('editMessageText', h.tg.err(500, 'boom'));
    await h.press(BORIS, 'L:ru'); capture(); // error path
    await h.chatMember({ chat: { id: -1001, type: 'supergroup', title: 'G' }, from: ALICE, date: 0, new_chat_member: { status: 'member' }, old_chat_member: { status: 'left' } }); capture();
    await h.chatMember({ chat: { id: CHANNELS[0].id, type: 'channel', username: 'HIDE_i_SEEK' }, from: OWNER, date: 0, new_chat_member: { status: 'member' }, old_chat_member: { status: 'administrator' } }); capture();
    await h.chatMember({ chat: { id: ALICE.id, type: 'private' }, from: ALICE, date: 0, new_chat_member: { status: 'kicked' }, old_chat_member: { status: 'member' } }); capture();
    h.advance(3 * 86400);
    await h.send(ALICE, 'housekeeping'); capture();

    const seen = new Map();
    for (const q of log) if (!seen.has(q.text)) seen.set(q.text, q.params);
    expect(seen.size).toBeGreaterThan(20);
    const offenders = [];
    for (const [text, params] of seen) {
      const plan = rawDatabase().prepare('EXPLAIN QUERY PLAN ' + text).all(params);
      for (const step of plan) {
        const m = /^SCAN (?!\d+-ROW VALUES CLAUSE)(\w+)/.exec(step.detail);
        if (m && !SMALL.has(m[1]) && !/USING (COVERING )?INDEX/.test(step.detail)) offenders.push(`${step.detail} ← ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
