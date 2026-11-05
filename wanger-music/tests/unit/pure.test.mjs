// Pure modules: codec, HTML, i18n, time, ids, permissions, error classification, limiter,
// chat references, commands, settings validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, parseArgs } from '../../tgcloud/lib/bot/codec.js';
import { esc } from '../../tgcloud/lib/telegram/html.js';
import { t, tp, digits, ago, dateTime, DICTS, raw } from '../../tgcloud/lib/i18n/index.js';
import { toJalali, randomId, utf8Length, truncate, parseIntInRange, tzOffsetSeconds } from '../../tgcloud/lib/core/util.js';
import { can, isOwner, isStaff, PERMISSIONS, assertCan, PermissionError } from '../../tgcloud/lib/permissions/policy.js';
import { classify } from '../../tgcloud/lib/telegram/errors.js';
import { backoffSeconds, bulkPaceAllows, cooldownAfter429, cooldownActive, chatGapAllows } from '../../tgcloud/lib/telegram/limiter.js';
import { parseChatRef, isValidInviteLink } from '../../tgcloud/lib/telegram/chatref.js';
import { parseCommand, parseStartPayload } from '../../tgcloud/lib/bot/commands.js';
import { validateSetting, cycleValue, EDITABLE_KEYS } from '../../tgcloud/lib/settings/service.js';
import { createLogger } from '../../tgcloud/lib/core/logger.js';
import { OWNER_ID } from '../../tgcloud/lib/config/static.js';

const err = (code, description, parameters) => ({ code, description, parameters });

test('codec: round trip, 64-byte limit, strict decoding', () => {
  assert.equal(encode('fjm', 'view', 12), 'fjm:view:12');
  assert.deepEqual(decode('fjm:view:12'), { ns: 'fjm', action: 'view', args: ['12'] });
  assert.deepEqual(decode('set:e:forcejoin.failure_mode'), { ns: 'set', action: 'e', args: ['forcejoin.failure_mode'] });
  assert.throws(() => encode('x', 'y', 'a'.repeat(40), 'b'.repeat(40)), /64 bytes|bad callback arg/);
  assert.throws(() => encode('BAD', 'y'));
  for (const bad of ['', 'x', 'fjm', 'FJM:view', 'fjm:view:<b>', 'fjm:view:1:' + 'x'.repeat(70), 'a:b:c d', null, 42, 'fjm:vi ew']) assert.equal(decode(bad), null, String(bad));
  assert.deepEqual(parseArgs(['12'], ['uint']), [12]);
  assert.equal(parseArgs(['-12'], ['uint']), null);
  assert.deepEqual(parseArgs(['-12'], ['int']), [-12]);
  assert.equal(parseArgs(['12', '3'], ['uint']), null, 'wrong arity');
  assert.equal(parseArgs([], ['uint']), null);
  assert.deepEqual(parseArgs(['en'], ['lang']), ['en']);
  assert.equal(parseArgs(['de'], ['lang']), null);
  assert.equal(parseArgs(['99999999999999999'], ['uint']), null, 'unsafe integer');
});

test('html: escapes &, <, > and quotes', () => {
  assert.equal(esc('<b>A & "B"</b>'), '&lt;b&gt;A &amp; &quot;B&quot;&lt;/b&gt;');
  assert.equal(esc(null), '');
});

test('i18n: same keys in fa and en, escaping, Persian digits, plain variant', () => {
  assert.deepEqual(Object.keys(DICTS.en).sort(), Object.keys(DICTS.fa).sort());
  for (const [k, v] of Object.entries(DICTS.fa)) assert.equal(/[‌‍‎‏⁦-⁩]/.test(k), false, k);
  assert.equal(t('fa', 'fjm.added', { title: '<x>' }), '✅ کانال «&lt;x&gt;» اضافه شد.');
  assert.equal(tp('fa', 'fj.btn_join', { title: 'A & B' }), '📢 A & B');
  assert.equal(t('fa', 'common.page', { page: 2, pages: 10 }), 'صفحه ۲ از ۱۰');
  assert.equal(t('en', 'common.page', { page: 2, pages: 10 }), 'Page 2 of 10');
  assert.equal(digits(1405, 'fa'), '۱۴۰۵');
  assert.equal(t('xx', 'common.back'), DICTS.fa['common.back'], 'unknown language → Persian');
  assert.equal(t('fa', 'no.such.key'), 'no.such.key');
  assert.equal(t('fa', 'bc.title', { count: 1, recent: raw('<b>x</b>') }).includes('<b>x</b>'), true);
  assert.equal(ago(30, 'en'), '30s ago');
  assert.equal(ago(7200, 'fa'), '۲ ساعت پیش');
});

test('spec texts: the join prompt and the expired-menu text are the ones in the spec', () => {
  assert.ok(DICTS.fa['fj.prompt'].startsWith('برای استفاده از ربات، اول عضو این کانال‌ها شو 👇'));
  assert.equal(DICTS.fa['fj.btn_joined'], '✅ عضو شدم');
  assert.equal(DICTS.fa['common.expired'], 'این منو منقضی شده؛ دوباره /admin را بزن.');
  assert.equal(DICTS.fa['fj.inline_button'], '🔒 اول عضو کانال‌ها شو');
  assert.ok(DICTS.fa['common.phase_placeholder'].includes('در فاز {phase} اضافه می‌شود'));
});

test('time: Jalali dates, Tehran offset, formatting', () => {
  assert.deepEqual(toJalali(2026, 11, 5), [1405, 8, 14]);
  assert.deepEqual(toJalali(2026, 3, 21), [1405, 1, 1]);
  assert.deepEqual(toJalali(2026, 3, 20), [1404, 12, 29]);
  assert.deepEqual(toJalali(2024, 3, 20), [1403, 1, 1]);
  assert.deepEqual(toJalali(2026, 9, 23), [1405, 7, 1]);
  const ts = Date.UTC(2026, 10, 5, 12, 0, 0) / 1000;
  assert.equal(tzOffsetSeconds('Asia/Tehran', ts), 12600);
  assert.equal(tzOffsetSeconds('UTC', ts), 0);
  assert.equal(dateTime(ts, 'Asia/Tehran', 'fa'), '۱۴۰۵/۰۸/۱۴ ۱۵:۳۰');
  assert.equal(dateTime(ts, 'Asia/Tehran', 'en'), '2026-11-05 15:30');
  assert.equal(dateTime(0, 'UTC', 'en'), 'never');
});

test('time: Jalali conversion matches Intl (persian calendar) for every day 2020–2032', () => {
  const f = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  for (let ts = Date.UTC(2020, 0, 1); ts < Date.UTC(2033, 0, 1); ts += 86400000) {
    const d = new Date(ts);
    const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    const want = [Number(parts.year), Number(parts.month), Number(parts.day)];
    assert.deepEqual(toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), want, d.toISOString().slice(0, 10));
  }
});

test('time: fixed-offset fallback when Intl is missing', () => {
  const saved = globalThis.Intl;
  try {
    // @ts-ignore
    globalThis.Intl = undefined;
    assert.equal(tzOffsetSeconds('Asia/Tehran', 1e9), 12600);
  } finally {
    globalThis.Intl = saved;
  }
});

test('util: ids, byte length, truncation, integer parsing', () => {
  const ids = new Set(Array.from({ length: 200 }, () => randomId(9)));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]{9}$/);
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('سلام'), 8);
  assert.equal(utf8Length('🎵'), 4);
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(parseIntInRange('۱۲۰', 60, 600), 120);
  assert.equal(parseIntInRange('12a', 0, 100), null);
  assert.equal(parseIntInRange('5', 10, 100), null);
});

test('permissions: owner, admin defaults, user, banned, unknown permission', () => {
  const owner = { telegram_id: OWNER_ID, role: 'user' };
  const admin = { telegram_id: 2, role: 'admin' };
  const user = { telegram_id: 3, role: 'user' };
  for (const p of PERMISSIONS) assert.equal(can(owner, p), true, p);
  assert.deepEqual(PERMISSIONS.filter((p) => can(admin, p)).sort(), ['approvals.review', 'catalog.manage', 'panel.open', 'stats.view']);
  assert.deepEqual(PERMISSIONS.filter((p) => can(user, p)), []);
  assert.equal(can({ ...admin, is_banned: 1 }, 'panel.open'), false);
  assert.equal(can(owner, 'no.such.perm'), false);
  assert.equal(can(null, 'panel.open'), false);
  assert.equal(isOwner(owner) && isStaff(admin) && !isStaff(user), true);
  for (const p of ['admins.manage', 'forcejoin.manage', 'destinations.manage', 'sources.manage', 'broadcast.send', 'settings.manage', 'users.ban']) {
    assert.equal(can(admin, p), false, `${p} is owner-only`);
  }
  assert.throws(() => assertCan(user, 'broadcast.send'), PermissionError);
});

test('error classification', () => {
  const k = (e) => classify(e).kind;
  assert.equal(k(err(429, 'Too Many Requests: retry after 7', { retry_after: 7 })), 'rate_limit');
  assert.equal(classify(err(429, 'x', { retry_after: 7 })).retryAfter, 7);
  assert.equal(k(err(502, 'Bad Gateway')), 'transient');
  assert.equal(k(new Error('network down')), 'transient');
  assert.equal(k(err(403, 'Forbidden: bot was blocked by the user')), 'blocked');
  assert.equal(k(err(403, 'Forbidden: user is deactivated')), 'blocked');
  assert.equal(k(err(403, 'Forbidden: bot is not a member of the channel chat')), 'no_rights');
  assert.equal(k(err(400, 'Bad Request: chat not found')), 'chat_gone');
  assert.equal(k(err(400, 'Bad Request: member list is inaccessible')), 'no_rights');
  assert.equal(k(err(400, 'Bad Request: message is not modified: specified new message content…')), 'not_modified');
  assert.equal(k(err(400, 'Bad Request: message to edit not found')), 'message_gone');
  assert.equal(k(err(400, 'Bad Request: wrong file identifier/HTTP URL specified')), 'bad_file');
  assert.equal(k(err(400, "Bad Request: can't parse entities: unexpected end tag")), 'bad_caption');
  assert.equal(k(err(400, 'Bad Request: user not found')), 'user_not_found');
  assert.equal(k(err(400, 'Bad Request: query is too old and response timeout expired')), 'query_expired');
  assert.equal(k(err(400, 'Bad Request: something else')), 'bad_request');
});

test('limiter: backoff 1,2,4,8,16… min capped at 60, 429 cooldown, bulk pace', () => {
  const mid = () => 0.5; // jitter factor 1.0
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((a) => backoffSeconds(a, mid)), [60, 120, 240, 480, 960, 1920, 3600, 3600]);
  assert.ok(backoffSeconds(1, () => 0) >= 48 && backoffSeconds(1, () => 0.999) <= 72);
  assert.equal(cooldownAfter429(1000, 7), 1007);
  assert.equal(cooldownAfter429(1000, 0), 1001, 'never sooner than 1 s');
  assert.equal(cooldownActive(1000, 1001), true);
  assert.equal(cooldownActive(1001, 1001), false);
  assert.equal(bulkPaceAllows(24, 0), true);
  assert.equal(bulkPaceAllows(25, 0), false);
  assert.equal(bulkPaceAllows(25, 1000), true);
  assert.equal(chatGapAllows(1000, 1000), false);
  assert.equal(chatGapAllows(1000, 1001), true);
});

test('chat references: usernames, links, ids, forwards, invite links', () => {
  assert.deepEqual(parseChatRef('@HIDE_i_SEEK'), { kind: 'username', value: 'HIDE_i_SEEK' });
  assert.deepEqual(parseChatRef('https://t.me/wangerBots'), { kind: 'username', value: 'wangerBots' });
  assert.deepEqual(parseChatRef('t.me/wangerBots/123'), { kind: 'username', value: 'wangerBots' });
  assert.deepEqual(parseChatRef('-1001910797391'), { kind: 'id', value: -1001910797391 });
  assert.deepEqual(parseChatRef('https://t.me/+AbCdEfGh123'), { kind: 'invite' });
  assert.deepEqual(parseChatRef('', { forward_origin: { type: 'channel', chat: { id: -100123456789 }, message_id: 5 } }), { kind: 'id', value: -100123456789 });
  for (const bad of ['', 'hello world', '@ab', 'https://example.com/x', 'x'.repeat(200)]) assert.equal(parseChatRef(bad), null, bad);
  assert.equal(isValidInviteLink('https://t.me/+AbCdEfGh123'), true);
  assert.equal(isValidInviteLink('https://t.me/joinchat/AbCdEfGh123'), true);
  assert.equal(isValidInviteLink('http://t.me/+AbCdEfGh123'), false);
  assert.equal(isValidInviteLink('https://evil.example/+x'), false);
});

test('commands and /start payloads (untrusted input)', () => {
  assert.deepEqual(parseCommand('/start t_AbCdEfGh1'), { name: 'start', args: 't_AbCdEfGh1' });
  assert.deepEqual(parseCommand('/Admin@Wange_Musicbot'), { name: 'admin', args: '' });
  assert.equal(parseCommand('/admin@OtherBot'), null);
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseStartPayload('join').kind, 'join');
  assert.equal(parseStartPayload('search').kind, 'search');
  assert.deepEqual(parseStartPayload('t_AbCdEfGh1'), { kind: 'track', publicId: 'AbCdEfGh1' });
  for (const bad of ['t_<script>', 't_abc', 'x'.repeat(65), 't_AbCdEfGh1; DROP', 'JOIN']) assert.equal(parseStartPayload(bad).kind, 'none', bad);
});

test('settings: validation and cycling', () => {
  assert.deepEqual(validateSetting('forcejoin.failure_mode', 'closed'), { ok: true, value: 'closed' });
  assert.equal(validateSetting('forcejoin.failure_mode', 'maybe').ok, false);
  assert.deepEqual(validateSetting('forcejoin.ttl_seconds', '120'), { ok: true, value: 120 });
  assert.equal(validateSetting('forcejoin.ttl_seconds', 5).ok, false);
  assert.equal(validateSetting('forcejoin.bypass_staff', 'yes').ok, false);
  assert.equal(validateSetting('time_zone', 'Mars/Base').ok, false);
  assert.deepEqual(validateSetting('archive.chat_id', null), { ok: true, value: null });
  assert.equal(validateSetting('no.such', 1).ok, false);
  assert.equal(cycleValue('forcejoin.failure_mode', 'open'), 'closed');
  assert.equal(cycleValue('forcejoin.failure_mode', 'closed'), 'open');
  assert.equal(cycleValue('forcejoin.bypass_staff', true), false);
  assert.equal(EDITABLE_KEYS.includes('tick.last_at'), false, 'internal keys are hidden');
});

test('logger: one JSON line, only whitelisted fields', () => {
  const lines = [];
  const sink = { log: (s) => lines.push(s), warn: (s) => lines.push(s), error: (s) => lines.push(s) };
  createLogger({ update_id: 7 }, sink).info('handled', { user_id: 1, text: 'secret message text', token: 'app1:xyz', duration_ms: 5 });
  const o = JSON.parse(lines[0]);
  assert.equal(o.event, 'handled');
  assert.equal(o.update_id, 7);
  assert.equal(o.user_id, 1);
  assert.equal(o.duration_ms, 5);
  assert.equal('text' in o || 'token' in o, false);
});
