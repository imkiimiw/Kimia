import { describe, expect, it } from 'vitest';
import { classifyMember, channelProblem } from '../../tgcloud/lib/join.js';
import { classify } from '../../tgcloud/lib/tg.js';
import { BotApiError } from '../sdk/api.js';

const e = (code, d, p) => new BotApiError(code, d, 'getChatMember', p);

describe('forced join: classifying getChatMember', () => {
  it('member, administrator, creator and restricted-but-member are members', () => {
    for (const s of ['member', 'administrator', 'creator']) expect(classifyMember({ status: s }).state).toBe('member');
    expect(classifyMember({ status: 'restricted', is_member: true }).state).toBe('member');
  });

  it('left, kicked, restricted-not-member and "member not found" are not members', () => {
    for (const s of ['left', 'kicked']) expect(classifyMember({ status: s }).state).toBe('not_member');
    expect(classifyMember({ status: 'restricted', is_member: false }).state).toBe('not_member');
    expect(classifyMember(null, e(400, 'Bad Request: member not found')).state).toBe('not_member');
  });

  it('every other API error is unknown — never "member"', () => {
    const errors = [
      e(400, 'Bad Request: chat not found'),
      e(403, 'Forbidden: bot is not a member of the channel chat'),
      e(400, 'Bad Request: member list is inaccessible'),
      e(429, 'Too Many Requests: retry after 5', { retry_after: 5 }),
      e(500, 'Internal Server Error'),
      new Error('fetch failed'),
    ];
    for (const err of errors) expect(classifyMember(null, err).state, err.message).toBe('unknown');
    expect(classifyMember({ status: 'weird' }).state).toBe('unknown');
    expect(classifyMember(undefined).state).toBe('unknown');
  });

  it('only setup errors blame the channel; rate limits and outages do not', () => {
    expect(channelProblem('forbidden')).toBe('not_admin');
    expect(channelProblem('chat_not_found')).toBe('error');
    expect(channelProblem('bad_request')).toBe('error');
    for (const k of ['rate', 'network', 'server', 'user_not_found']) expect(channelProblem(k)).toBeNull();
  });
});

describe('Bot API error classification', () => {
  it('maps the errors the bot handles', () => {
    expect(classify(e(403, 'Forbidden: bot was blocked by the user')).kind).toBe('blocked');
    expect(classify(e(403, 'Forbidden: user is deactivated')).kind).toBe('blocked');
    expect(classify(e(403, 'Forbidden: bot is not a member of the channel chat')).kind).toBe('forbidden');
    expect(classify(e(429, 'Too Many Requests', { retry_after: 7 }))).toEqual({ kind: 'rate', retryAfter: 7 });
    expect(classify(e(400, 'Bad Request: message is not modified: specified new message content…')).kind).toBe('not_modified');
    expect(classify(e(400, 'Bad Request: message to edit not found')).kind).toBe('gone');
    expect(classify(e(400, 'Bad Request: query is too old and response timeout expired')).kind).toBe('gone');
    expect(classify(e(400, 'Bad Request: chat not found')).kind).toBe('chat_not_found');
    expect(classify(e(502, 'Bad Gateway')).kind).toBe('server');
    expect(classify(new Error('fetch: request failed')).kind).toBe('network');
  });
});
