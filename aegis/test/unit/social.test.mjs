// Phase 8 rules, without Telegram: levels and automatic badges, what counts as a «thanks», a
// channel's health score, raffle draws, and the words that work as commands (only as the whole
// message, so ordinary chat is never taken for a command).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_CODES, earned, healthScore, isThanks, levelOf, pointsFor } from '../../tgcloud/lib/core/levels.js';
import { contests as contestsEngine } from '../../tgcloud/lib/engines/social.js';
import { parseCommand as socCommand, qa as qaUi } from '../../tgcloud/lib/ui/social.js';

const { draw } = contestsEngine;
const qaCommand = qaUi.parseCommand;
const DAY = 86400;

test('levels: 10, 30, 60, 100 … points; level 0 below 10', () => {
  assert.deepEqual([1, 2, 3, 4, 10].map(pointsFor), [10, 30, 60, 100, 550]);
  assert.equal(levelOf(0), 0);
  assert.equal(levelOf(9), 0);
  assert.equal(levelOf(10), 1);
  assert.equal(levelOf(29), 1);
  assert.equal(levelOf(30), 2);
  assert.equal(levelOf(550), 10);
  assert.equal(levelOf('100'), 4, 'database values may be strings');
  assert.equal(levelOf(1e12), 100, 'capped');
});

test('automatic badges come from the member\'s numbers', () => {
  const now = 1767225600;
  assert.deepEqual(earned({ messages: 0, thanks_got: 0, streak: 0, points: 0, first_at: 0 }, now), []);
  assert.deepEqual(earned({ messages: 1, thanks_got: 0, streak: 1, points: 1, first_at: now }, now), ['first']);
  const all = earned({ messages: 10000, thanks_got: 100, streak: 30, points: 550, first_at: now - 366 * DAY }, now);
  assert.deepEqual(all, AUTO_CODES);
  assert.ok(!earned({ messages: 5, thanks_got: 0, streak: 0, points: 0, first_at: now - 364 * DAY }, now).includes('veteran'));
});

test('a «thanks» is a short message that only thanks, in any of our languages', () => {
  for (const s of ['thanks', 'Thank you!', 'ممنون', 'مرسی!!', 'سپاس', 'спасибо', '谢谢', 'merci beaucoup', '+1', '👍', '🙏🙏', '❤️', 'thanks 👍']) assert.ok(isThanks(s), s);
  for (const s of ['', 'thanks for nothing, you broke it', 'no thanks', 'ok', 'merci de ne pas spammer', 'a'.repeat(40)]) assert.ok(!isThanks(s), s);
});

test('health score: four parts that add up, and grades', () => {
  const best = healthScore({ members: 1000, net7: 30, posts14: 14, reactions14: 300, comments14: 50, postDays14: 14, rightsOk: true, outside: false, crisis: false, protected: true });
  assert.equal(best.score, 100);
  assert.equal(best.grade, 'A');
  assert.deepEqual(best.parts.map((p) => p.key), ['growth', 'engagement', 'activity', 'safety']);
  assert.equal(best.parts.reduce((n, p) => n + p.max, 0), 100);
  assert.equal(best.perPost, 25);
  const quiet = healthScore({ members: 1000, net7: 0, posts14: 0, reactions14: 0, comments14: 0, postDays14: 0, rightsOk: true, outside: false, crisis: false, protected: false });
  assert.deepEqual(quiet.parts.map((p) => p.got), [15, 0, 0, 20]);
  assert.equal(quiet.grade, 'E');
  const bad = healthScore({ members: 1000, net7: -50, posts14: 7, reactions14: 70, comments14: 0, postDays14: 5, rightsOk: false, outside: true, crisis: true, protected: false });
  assert.equal(bad.parts[0].got, 0, 'shrinking by 5% a week');
  assert.equal(bad.parts[1].got, 15, '10 per post per 1000 is half');
  assert.equal(bad.parts[2].got, 10);
  assert.equal(bad.parts[3].got, 0);
  assert.equal(bad.grade, 'E');
  assert.equal(healthScore({ members: 0, posts14: 3, postDays14: 3 }).perPost, 0, 'no subscribers: no division by zero');
});

test('raffle draw: distinct winners, never more than the entries', () => {
  const seq = [0.99, 0, 0.5];
  let i = 0;
  assert.deepEqual(draw([1, 2, 3, 4], 3, () => seq[i++]), [4, 1, 3]);
  assert.deepEqual(draw([7], 3), [7]);
  assert.deepEqual(draw([], 2), []);
  const w = draw([1, 2, 3, 4, 5, 6], 6);
  assert.equal(new Set(w).size, 6);
});

test('points commands: slash forms, and words only as the whole message (give/take with a number)', () => {
  assert.deepEqual(socCommand('/me'), { cmd: 'me', args: [], mention: null });
  assert.deepEqual(socCommand('/top@AegisBot'), { cmd: 'top', args: [], mention: 'aegisbot' });
  assert.deepEqual(socCommand('/give 10'), { cmd: 'give', args: ['10'], mention: null });
  assert.equal(socCommand('/warn'), null);
  assert.equal(socCommand('my points').cmd, 'me');
  assert.equal(socCommand('امتیاز من').cmd, 'me');
  assert.equal(socCommand('برترین‌ها').cmd, 'top');
  assert.equal(socCommand('LEADERBOARD').cmd, 'top');
  assert.deepEqual(socCommand('امتیاز بده ۱۰'), { cmd: 'give', args: ['10'], mention: null });
  assert.deepEqual(socCommand('take points 5'), { cmd: 'take', args: ['5'], mention: null });
  assert.equal(socCommand('my points are low today'), null, 'a sentence that starts like a command is chat');
  assert.equal(socCommand('leaderboard 5'), null, 'only give/take take a number');
  assert.equal(socCommand('give points to everyone'), null);
  assert.equal(socCommand('top'), null, 'common words alone are not commands');
});

test('question commands: /ask /anon and their words, only as the whole message', () => {
  assert.deepEqual(qaCommand('/ask'), { cmd: 'ask', mention: null });
  assert.deepEqual(qaCommand('/anon@AegisBot'), { cmd: 'anon', mention: 'aegisbot' });
  assert.equal(qaCommand('سوال ناشناس').cmd, 'anon');
  assert.equal(qaCommand('پرسش از مدیران').cmd, 'ask');
  assert.equal(qaCommand('ask the admins').cmd, 'ask');
  assert.equal(qaCommand('ask'), null);
  assert.equal(qaCommand('ask the admins why the group is quiet'), null);
});
