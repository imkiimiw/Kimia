// Phase 6 rules, without Telegram: times of day in a chat's time zone (night lock, scheduled
// cleanup), the 26 advanced settings and their choices, and the member commands in every language.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultTz, fmtTime, inWindow, localMinutes, nextTime, parseTimes, TZ_OFFSETS, tzLabel, tzOf } from '../../tgcloud/lib/core/clock.js';
import * as settings from '../../tgcloud/lib/engines/settings.js';
import { GROUPS } from '../../tgcloud/lib/ui/panel_adv.js';
import { parseCommand } from '../../tgcloud/lib/ui/advanced.js';

/* 2026-01-01 00:00:00 UTC */
const MIDNIGHT = 1767225600;

test('time zones: a fixed offset per chat, or the chat language\'s default', () => {
  assert.equal(defaultTz('fa'), 210);
  assert.equal(defaultTz('en'), 0);
  assert.equal(defaultTz('xx'), 0);
  assert.equal(tzOf('auto', 'fa'), 210);
  assert.equal(tzOf('-300', 'fa'), -300);
  assert.equal(tzLabel(210), 'UTC+03:30');
  assert.equal(tzLabel(-300), 'UTC−05:00');
  assert.equal(tzLabel(0), 'UTC+00:00');
  assert.ok(TZ_OFFSETS.includes(210) && TZ_OFFSETS.includes(330) && TZ_OFFSETS.includes(345));
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(23 * 60 + 5), '23:05');
});

test('local minutes after midnight, on both sides of UTC', () => {
  assert.equal(localMinutes(MIDNIGHT, 0), 0);
  assert.equal(localMinutes(MIDNIGHT, 210), 210);
  assert.equal(localMinutes(MIDNIGHT, -300), 19 * 60);
  assert.equal(localMinutes(MIDNIGHT + 90 * 60, 0), 90);
});

test('times of day typed by admins: Persian digits, separators, sorted and unique, with errors', () => {
  assert.deepEqual(parseTimes('15:30, 3:00'), { times: [180, 930] });
  assert.deepEqual(parseTimes('۳:۰۰ و ۱۵'), { times: [180, 900] });
  assert.deepEqual(parseTimes('03.00 03:00'), { times: [180] });
  assert.deepEqual(parseTimes(''), { error: 'empty' });
  assert.deepEqual(parseTimes('25:00'), { error: 'format' });
  assert.deepEqual(parseTimes('12:60'), { error: 'format' });
  assert.deepEqual(parseTimes('noon'), { error: 'format' });
  assert.deepEqual(parseTimes('1 2 3 4 5 6'), { error: 'too_many' });
  assert.deepEqual(parseTimes('1 2 3 4 5'), { times: [60, 120, 180, 240, 300] });
});

test('the next run is the first chosen time after now, in the chat\'s time zone', () => {
  assert.equal(nextTime([180], MIDNIGHT, 0), MIDNIGHT + 3 * 3600);
  assert.equal(nextTime([180], MIDNIGHT + 3 * 3600, 0), MIDNIGHT + 27 * 3600, 'exactly now means tomorrow');
  assert.equal(nextTime([180, 900], MIDNIGHT + 4 * 3600, 0), MIDNIGHT + 15 * 3600);
  /* 03:00 in UTC+03:30 is 23:30 UTC the day before */
  assert.equal(nextTime([180], MIDNIGHT, 210), MIDNIGHT + 23.5 * 3600);
  assert.equal(nextTime([180], MIDNIGHT - 3600, 210), MIDNIGHT - 1800);
  assert.equal(nextTime([], MIDNIGHT, 0), 0);
});

test('night windows may cross midnight; an empty window never locks', () => {
  assert.ok(inWindow(23 * 60, 7 * 60, 23 * 60));
  assert.ok(inWindow(23 * 60, 7 * 60, 2 * 60));
  assert.ok(!inWindow(23 * 60, 7 * 60, 7 * 60));
  assert.ok(!inWindow(23 * 60, 7 * 60, 12 * 60));
  assert.ok(inWindow(60, 300, 120));
  assert.ok(!inWindow(60, 300, 300));
  assert.ok(!inWindow(300, 300, 300));
});

test('26 advanced settings in four groups, every one with a default; off by default except the safe ones', () => {
  const keys = Object.values(GROUPS).flat();
  assert.equal(keys.length, 26);
  assert.equal(new Set(keys).size, 26);
  for (const k of keys) assert.ok(k in settings.DEFAULTS, k);
  for (const k of keys) {
    if (settings.isFlag(k)) assert.ok(['0', '1'].includes(settings.DEFAULTS[k]), k);
    else if (settings.CHOICES[k]) assert.ok(settings.CHOICES[k].map(String).includes(settings.DEFAULTS[k]), k);
  }
  const onByDefault = keys.filter((k) => settings.isFlag(k) && settings.DEFAULTS[k] === '1');
  assert.ok(!onByDefault.some((k) => ['del_bots', 'caps', 'junk', 'bot_kick', 'title_lock', 'anon_cmds', 'reply_private'].includes(k)), onByDefault.join(','));
  assert.equal(settings.DEFAULTS.jr_mode, 'manual');
  assert.equal(settings.DEFAULTS.tz, 'auto');
  assert.equal(settings.DEFAULTS.linked, 'keep');
  assert.equal(settings.DEFAULTS.welcome_on, '0', 'a group is not greeted until an admin wants it');
  for (const k of ['welcome_on', 'goodbye_on', 'night_on', 'clean_on', 'reports', 'ev_join']) assert.ok(settings.isFlag(k), k);
});

test('member commands: slash and words, in the member\'s language or English; others are not ours', () => {
  assert.deepEqual(parseCommand('/rules'), { cmd: 'rules', args: [], mention: null });
  assert.deepEqual(parseCommand('/report@Aegis_bot spam link'), { cmd: 'report', args: ['spam', 'link'], mention: 'aegis_bot' });
  assert.equal(parseCommand('قوانین').cmd, 'rules');
  assert.equal(parseCommand('گزارش تبلیغ').cmd, 'report');
  assert.deepEqual(parseCommand('گزارش تبلیغ').args, ['تبلیغ']);
  assert.equal(parseCommand('اخطارهای من').cmd, 'mywarns');
  assert.equal(parseCommand('правила').cmd, 'rules');
  assert.equal(parseCommand('群规').cmd, 'rules');
  assert.equal(parseCommand('signaler').cmd, 'report');
  assert.equal(parseCommand('admins').cmd, 'admins');
  assert.equal(parseCommand('/ban'), null);
  assert.equal(parseCommand('hello rules'), null);
  assert.equal(parseCommand(''), null);
});
