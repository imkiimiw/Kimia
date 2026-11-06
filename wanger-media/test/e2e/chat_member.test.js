import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../helpers/telegram.js';
import { ALICE, OWNER, setup } from '../helpers/harness.js';

let h;
beforeEach(() => { h = setup(); });
afterEach(() => { vi.useRealTimers(); });

const upd = (chat, status, from = ALICE) => ({
  chat, from, date: 0,
  old_chat_member: { status: 'left', user: { id: 9080356648 } },
  new_chat_member: { status, user: { id: 9080356648 } },
});

describe('my_chat_member', () => {
  it('a user blocking and unblocking the bot updates their row', async () => {
    await h.send(ALICE, '/start');
    await h.chatMember(upd({ id: ALICE.id, type: 'private' }, 'kicked'));
    expect(h.row('SELECT blocked FROM users WHERE id = ?', ALICE.id).blocked).toBe(1);
    await h.chatMember(upd({ id: ALICE.id, type: 'private' }, 'member'));
    expect(h.row('SELECT blocked FROM users WHERE id = ?', ALICE.id).blocked).toBe(0);
  });

  it('groups are recorded with default settings and an exact active-groups counter', async () => {
    const g = { id: -100123, type: 'supergroup', title: 'Test group' };
    await h.chatMember(upd(g, 'member'));
    expect(h.row('SELECT active, bot_status, is_admin FROM groups WHERE chat_id = ?', g.id)).toEqual({ active: 1, bot_status: 'member', is_admin: 0 });
    expect(h.row('SELECT auto_download, max_links, force_join FROM group_settings WHERE chat_id = ?', g.id)).toEqual({ auto_download: 1, max_links: 3, force_join: 0 });
    expect(h.counter('groups_active')).toBe(1);

    await h.chatMember(upd(g, 'administrator')); // promoted: still one active group
    expect(h.counter('groups_active')).toBe(1);
    expect(h.row('SELECT is_admin FROM groups WHERE chat_id = ?', g.id).is_admin).toBe(1);

    await h.chatMember(upd(g, 'left'));
    expect(h.counter('groups_active')).toBe(0);
    await h.chatMember(upd(g, 'kicked'));
    expect(h.counter('groups_active')).toBe(0);
    await h.chatMember(upd(g, 'member'));
    expect(h.counter('groups_active')).toBe(1);
    expect(h.counter('groups_joined', '2026-11-05')).toBe(2);
    // Phase 5: an intro each time the bot is added (twice here), never on promotion or removal
    expect(h.tg.calls('sendMessage').filter((c) => c.params.chat_id === g.id)).toHaveLength(2);
  });

  it('a redelivered my_chat_member does not count a group twice', async () => {
    const g = { id: -100124, type: 'group', title: 'G2' };
    await h.chatMember(upd(g, 'member'), { id: 42 });
    await h.chatMember(upd(g, 'member'), { id: 42 });
    expect(h.counter('groups_active')).toBe(1);
  });

  it('the bot losing admin in a forced channel updates it and alerts the owner', async () => {
    await h.send(ALICE, '/start'); // seeds channels
    h.resetCalls();
    const ch = { id: CHANNELS[0].id, type: 'channel', title: 'Hide i Seek', username: 'HIDE_i_SEEK' };
    const r = await h.chatMember(upd(ch, 'member', OWNER));
    expect(r).toMatchObject({ forced: true, status: 'not_admin', changed: true });
    expect(h.row('SELECT bot_status FROM forced_channels WHERE chat_id = ?', ch.id).bot_status).toBe('not_admin');
    expect(h.tg.calls('sendMessage').map((c) => c.params.chat_id)).toEqual([OWNER.id]);

    const back = await h.chatMember(upd(ch, 'administrator', OWNER));
    expect(back.status).toBe('ok');
    expect(h.tg.calls('sendMessage')).toHaveLength(1);
  });

  it('other channels are ignored', async () => {
    const r = await h.chatMember(upd({ id: -100999, type: 'channel', title: 'Random' }, 'administrator'));
    expect(r.forced).toBe(false);
  });
});
