import { describe, expect, it } from 'vitest';
import { GROUP_COMMANDS, PRIVATE_COMMANDS, profileCalls } from '../../tgcloud/lib/botprofile.js';
import { OWNER_ID } from '../../tgcloud/lib/config.js';
import { COMMAND_TARGETS } from '../../tgcloud/lib/menu.js';

describe('bot profile', () => {
  const calls = profileCalls();

  it('command menus for private chats and groups in fa, en (default) and ru, plus /admin for the owner', () => {
    const cmds = calls.filter(([m]) => m === 'setMyCommands');
    const key = ([, p]) => `${p.scope.type}:${p.language_code || 'default'}`;
    expect(cmds.map(key)).toEqual([
      'all_private_chats:fa', 'all_group_chats:fa', 'all_private_chats:default', 'all_group_chats:default',
      'all_private_chats:ru', 'all_group_chats:ru', 'chat:default', 'chat:fa',
    ]);
    for (const [, p] of cmds) {
      for (const c of p.commands) {
        expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
        expect(c.description.length).toBeGreaterThan(2);
        expect(c.description.length).toBeLessThanOrEqual(256);
      }
    }
    expect(cmds.find(([, p]) => p.scope.type === 'chat')[1].scope.chat_id).toBe(OWNER_ID);
    expect(cmds.find(([, p]) => p.scope.type === 'chat')[1].commands.map((c) => c.command)).toContain('admin');
  });

  it('every listed private command is handled', () => {
    for (const c of PRIVATE_COMMANDS) expect(['start', 'language'].includes(c) || c in COMMAND_TARGETS, c).toBe(true);
    expect(GROUP_COMMANDS).toEqual(['settings', 'status', 'platforms', 'help']);
  });

  it('descriptions fit Telegram’s limits (512 and 120 characters) in every language', () => {
    for (const [m, p] of calls) {
      if (m === 'setMyDescription') expect(p.description.length).toBeLessThanOrEqual(512);
      if (m === 'setMyShortDescription') expect(p.short_description.length).toBeLessThanOrEqual(120);
    }
    expect(calls.filter(([m]) => m === 'setMyDescription')).toHaveLength(3);
  });
});
