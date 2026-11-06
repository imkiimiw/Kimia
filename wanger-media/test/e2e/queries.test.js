// The platform fails any query that reads ≈ 50 000 rows (docs/PLATFORMS.md §1). This runs every
// Phase 1 flow, then asks SQLite for the plan of every distinct statement the bot executed: none may
// scan a table that grows with users or traffic. Tables that are small by construction are allowed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rawDatabase, stats } from '../sdk/db.js';
import { CHANNELS } from '../helpers/telegram.js';
import { ALICE, BORIS, OWNER, setup } from '../helpers/harness.js';
import { createWeb, fixture } from '../helpers/web.js';

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
    // Phase 2: disclaimer, dashboard, history, settings
    await h.chatMember({ chat: { id: ALICE.id, type: 'private' }, from: ALICE, date: 0, new_chat_member: { status: 'member' }, old_chat_member: { status: 'kicked' } }); capture();
    await h.press(ALICE, 'a', { messageId: 4 }); capture();
    for (let i = 0; i < 30; i++) h.row(`INSERT INTO downloads (user_id, chat_id, platform, url, status, created_at) VALUES (?, ?, 'x', 'u', 'ok', ?) RETURNING id`, ALICE.id, ALICE.id, i);
    stats.log = [];
    for (const data of ['H:0', 'H:2', 's', 'q', 'Q:best', 'l:s', 'L:ru:s', 'i', 'o', 'h']) { await h.press(ALICE, data, { messageId: 5 }); capture(); }
    await h.send(ALICE, '/downloads'); capture();
    // Phase 3: owner panel, the download pipeline (miss, cache hit, blocklist, quota), history
    createWeb({
      'https://cdn.syndication.twimg.com/tweet-result?id=2112592291147747809*': { json: fixture('syn_photos.json') },
      'https://pbs.twimg.com/*': { size: 300000, type: 'image/jpeg' },
    });
    await h.send(OWNER, '/start'); capture();
    await h.press(OWNER, 'L:en', { messageId: 90 }); capture();
    for (const data of ['A', 'P:x', 'M:x:public:1', 'C:x:public', 'E:x:1', 'E:x:0']) { await h.press(OWNER, data, { messageId: 91 }); capture(); }
    await h.send(OWNER, '/admin'); capture();
    h.row("INSERT INTO blocklist (kind, value, created_at) VALUES ('account', 'x:nobody', 1) RETURNING id");
    await h.send(ALICE, 'https://x.com/SpaceX/status/2112592291147747809'); capture();
    h.advance(20);
    await h.send(ALICE, 'https://x.com/SpaceX/status/2112592291147747809'); capture(); // cache hit
    await h.send(ALICE, 'https://x.com/SpaceX/status/2112592291147747809'); capture(); // cooldown
    await h.send(ALICE, 'https://www.tiktok.com/@a/video/1'); capture();
    await h.press(ALICE, 'd', { messageId: 6 }); capture();
    h.advance(3 * 86400);
    await h.send(ALICE, 'housekeeping'); capture();

    const seen = new Map();
    for (const q of log) if (!seen.has(q.text)) seen.set(q.text, q.params);
    expect(seen.size).toBeGreaterThan(35);
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
