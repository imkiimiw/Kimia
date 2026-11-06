// Phase 6 pure parts: the central error → action mapping, channel readiness, local days and hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishAction } from '../../tgcloud/lib/telegram/errors.js';
import { channelReady, dayStart, localHour } from '../../tgcloud/lib/publishing/rules.js';
import { captionLanguage } from '../../tgcloud/lib/publishing/worker.js';

const err = (code, description, parameters) => ({ code, description, parameters });

test('error → action (spec 10.6)', () => {
  assert.deepEqual([publishAction(err(429, 'Too Many Requests', { retry_after: 9 }), 1).action, publishAction(err(429, 'x', { retry_after: 9 }), 1).retryAfter], ['retry_after', 9]);
  assert.equal(publishAction(err(502, 'Bad Gateway'), 1).action, 'backoff');
  assert.equal(publishAction(new Error('socket hang up'), 5).action, 'backoff');
  assert.equal(publishAction(err(500, 'Internal'), 6).action, 'fail', 'after 6 attempts');
  assert.equal(publishAction(err(400, 'Bad Request: chat not found'), 1).action, 'fail_channel');
  assert.equal(publishAction(err(403, 'Forbidden: bot is not a member of the channel chat'), 1).action, 'fail_channel');
  assert.equal(publishAction(err(400, 'Bad Request: not enough rights to send audios to the chat'), 1).action, 'fail_channel');
  assert.equal(publishAction(err(400, 'Bad Request: wrong file identifier/HTTP URL specified'), 1).action, 'fail_file');
  assert.equal(publishAction(err(400, "Bad Request: can't parse entities: unexpected end tag"), 1).action, 'fail_caption');
  assert.equal(publishAction(err(400, 'Bad Request: message caption is too long'), 1).action, 'fail_caption');
  assert.equal(publishAction(err(400, 'Bad Request: something odd'), 1).action, 'fail');
});

test('channel readiness: enabled + auto + rights, interval, active hours in its zone, daily limit', () => {
  const now = Date.UTC(2026, 10, 5, 12, 0, 0) / 1000; // 15:30 in Tehran
  const ch = { enabled: 1, auto_publish: 1, bot_rights_ok: 1, removed_at: null, last_published_at: null, min_interval_seconds: 600, active_hours: null, daily_limit: 3, time_zone: 'Asia/Tehran' };
  assert.equal(channelReady(ch, now, 0).ready, true);
  for (const off of [{ enabled: 0 }, { auto_publish: 0 }, { bot_rights_ok: 0 }, { removed_at: 1 }]) assert.equal(channelReady({ ...ch, ...off }, now, 0).reason, 'off');
  assert.deepEqual(channelReady({ ...ch, last_published_at: now - 100 }, now, 0), { ready: false, reason: 'interval', nextAt: now + 500 });
  assert.equal(channelReady({ ...ch, last_published_at: now - 600 }, now, 0).ready, true);
  assert.equal(channelReady({ ...ch, active_hours: '{"from":9,"to":15}' }, now, 0).reason, 'hours', '15:30 Tehran is outside 9–15');
  assert.equal(channelReady({ ...ch, active_hours: '{"from":9,"to":16}' }, now, 0).ready, true);
  assert.equal(channelReady({ ...ch, active_hours: '{"from":9,"to":16}', time_zone: 'UTC' }, now, 0).ready, true, '12:00 UTC');
  assert.equal(channelReady(ch, now, 3).reason, 'daily_limit');
  assert.equal(channelReady({ ...ch, daily_limit: 0 }, now, 99).ready, true, '0 = no limit');
});

test('local midnight and hour in a time zone', () => {
  const now = Date.UTC(2026, 10, 5, 22, 0, 0) / 1000; // 01:30 next day in Tehran
  assert.equal(localHour(now, 'Asia/Tehran'), 1);
  assert.equal(dayStart(now, 'Asia/Tehran'), Date.UTC(2026, 10, 5, 20, 30, 0) / 1000, 'Tehran midnight = 20:30 UTC');
  assert.equal(dayStart(now, 'UTC'), Date.UTC(2026, 10, 5, 0, 0, 0) / 1000);
  assert.equal(captionLanguage({ rules: '{"languages":["en"]}' }), 'en');
  assert.equal(captionLanguage({ rules: '{"languages":["fa","en"]}' }), 'fa');
});

test('channel signature: the last line, kept whole within 1024; {channel} in a template replaces it; private channels and the switch', async () => {
  const { renderCaption, channelSignature, channelHandle, CAPTION_MAX } = await import('../../tgcloud/lib/publishing/captions.js');
  const ch = { username: 'WangerFlow', signature: 1 };
  const values = { title: 'T'.repeat(2000), artist: 'A', album: '', duration: '3:00', channel: channelHandle(ch) };
  const out = renderCaption('🎵 {title}\n👤 {artist}', values, CAPTION_MAX, channelSignature(ch));
  assert.ok(out.length <= CAPTION_MAX, `${out.length}`);
  assert.ok(out.endsWith('\n\n🆔 @WangerFlow'), 'the signature survives the cut');
  assert.equal(renderCaption('🎵 {title}\n📢 {channel}', { ...values, title: 'Song' }, CAPTION_MAX, channelSignature(ch)), '🎵 Song\n📢 @WangerFlow', 'placed by the template: no second line');
  assert.equal(channelSignature({ username: null, signature: 1 }), '', 'a private channel has no public link');
  assert.equal(channelSignature({ username: 'X', signature: 0 }), '', 'switched off');
  assert.equal(renderCaption('🎵 {title}', { title: '<b>' }, CAPTION_MAX, '🆔 @a_b'), '🎵 &lt;b&gt;\n\n🆔 @a_b');
});
