// Phase 5 rules, without Telegram: the security signals, risk scoring and learning from feedback,
// captchas, module settings and the security commands.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adHits, adjust, buttonUrls, dangerousFile, deobfuscate, fingerprint, invisible, makeCaptcha, mixedScriptWords, nameSignals, RISK_LEVELS, scamHits, score,
  skeleton, stripInvisible, WEIGHTS,
} from '../../tgcloud/lib/core/signals.js';
import { hostsOf, linksOf, scan } from '../../tgcloud/lib/core/msgscan.js';
import * as guards from '../../tgcloud/lib/engines/guards.js';
import { parseCommand } from '../../tgcloud/lib/ui/security.js';

test('invisible characters: zero-width, bidi overrides, Hangul filler count; ZWNJ (Persian) and ZWJ (emoji) never do', () => {
  assert.equal(invisible('abc').suspicious, false);
  assert.equal(invisible('می\u200Cخواهم').suspicious, false, 'ZWNJ is normal Persian');
  assert.equal(invisible('👨\u200D👩').suspicious, false, 'ZWJ joins emoji');
  assert.equal(invisible('pay\u200Bpal').suspicious, true);
  assert.equal(invisible('file\u202Etxt.exe').suspicious, true);
  assert.equal(invisible('\u3164').suspicious, true, 'an "empty" name');
  assert.equal(invisible('a\u200Fb\u200Fc').suspicious, false, 'a few direction marks are fine');
  assert.equal(invisible('\u200F\u200F\u200F\u200Fx').suspicious, true);
  assert.equal(stripInvisible('a\u200Bb\u2066c'), 'abc');
});

test('look-alike letters and impersonation', () => {
  assert.equal(mixedScriptWords('Visit раypal now'), 1, 'Cyrillic р and а inside a Latin word');
  assert.equal(mixedScriptWords('Привет, как дела? Hello'), 0, 'separate words in two scripts are fine');
  assert.equal(skeleton('Аdmіn'), 'admin');
  assert.ok(nameSignals({ first_name: 'Telegram', last_name: 'Support' }).includes('impersonation'));
  assert.ok(nameSignals({ first_name: 'Аli', username: 'x_y' }, ['Ali']).includes('impersonation'), 'same as an admin, with a Cyrillic А');
  assert.deepEqual(nameSignals({ first_name: 'Sara', username: 'sara' }, ['Ali']), []);
  assert.ok(nameSignals({ first_name: 'Join t.me/spamchan' }).includes('name_link'));
  assert.ok(nameSignals({ first_name: '\u3164' }).includes('name_invisible'));
  assert.ok(nameSignals({ first_name: 'Bob' }).includes('no_username'));
});

test('disguised links: full-width letters, look-alike dots, "dot" words, buttons', () => {
  const host = (s) => hostsOf(linksOf(scan({ text: deobfuscate(s) }), 'high'));
  assert.deepEqual(host('visit ｓｐａｍ．ｃｏｍ'), ['spam.com']);
  assert.deepEqual(host('go to spam。net today'), ['spam.net']);
  assert.deepEqual(host('example(dot)org'), ['example.org']);
  assert.deepEqual(host('سایت نقطه com'), [], 'a Persian word on its own is not a domain');
  assert.deepEqual(host('spam\u200B.io'), ['spam.io'], 'zero-width inside a link');
  assert.deepEqual(host('t . me / promo_chan'), ['t.me']);
  assert.deepEqual(buttonUrls({ reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://x.io' }, { text: 'cb', callback_data: 'x' }]] } }), ['https://x.io']);
});

test('dangerous files: executables, installers, double extensions, reversed names, mime types', () => {
  assert.equal(dangerousFile({ file_name: 'app.apk' }), 'ext');
  assert.equal(dangerousFile({ file_name: 'invoice.pdf.exe' }), 'double');
  assert.equal(dangerousFile({ file_name: 'photo\u202Egpj.exe' }), 'rlo');
  assert.equal(dangerousFile({ file_name: 'macro.docm' }), 'ext');
  assert.equal(dangerousFile({ file_name: 'x.bin', mime_type: 'application/vnd.android.package-archive' }), 'mime');
  assert.equal(dangerousFile({ file_name: 'report.pdf' }), null);
  assert.equal(dangerousFile({ file_name: 'archive.zip' }), null);
  assert.equal(dangerousFile(undefined), null);
});

test('ad and scam phrases in five languages; fingerprints ignore case, spacing and invisible characters', () => {
  assert.ok(adHits('Join our channel, free crypto airdrop!') >= 3);
  assert.ok(adHits('عضو شوید، ممبر رایگان و تبلیغات') >= 3);
  assert.ok(adHits('Подписывайтесь, заработок без вложений') >= 2);
  assert.ok(adHits('加群免费赚钱') >= 3);
  assert.ok(adHits('Rejoignez-nous, gratuit') >= 2);
  assert.equal(adHits('hello everyone, how was your day'), 0);
  assert.equal(adHits('joining the meeting'), 0, 'whole words for Latin phrases');
  assert.equal(scamHits('Telegram Support: verify your account now'), 2);
  assert.equal(fingerprint('Buy  NOW\u200B'), fingerprint('buy now'));
  assert.notEqual(fingerprint('buy now'), fingerprint('buy later'));
});

test('risk score: weighted, explained (strongest first); feedback moves weights within 0.3–2×', () => {
  const r = score(['new_link', 'xgroup', 'no_username', 'unknown_signal', 'xgroup']);
  assert.deepEqual(r, { score: 85, reasons: [['xgroup', 45], ['new_link', 30], ['no_username', 10]] });
  assert.equal(score(['xgroup'], { xgroup: 0.5 }).score, 23);
  let w = {};
  w = adjust(w, ['xgroup', 'flood'], false);
  assert.deepEqual(w, { xgroup: 0.8, flood: 0.8 });
  for (let i = 0; i < 20; i += 1) w = adjust(w, ['xgroup'], false);
  assert.equal(w.xgroup, 0.3, 'never below 0.3×');
  for (let i = 0; i < 30; i += 1) w = adjust(w, ['flood'], true);
  assert.equal(w.flood, 2, 'never above 2×');
  assert.deepEqual(RISK_LEVELS.medium, [40, 70]);
  assert.ok(Object.keys(WEIGHTS).length >= 18);
});

test('captchas: the answer is among the options; sums are small and right', () => {
  let n = 0;
  const rnd = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 50; i += 1) {
    const b = makeCaptcha('button', rnd);
    assert.equal(b.options.length, 6);
    assert.equal(b.options[b.answer], b.target);
    assert.equal(new Set(b.options).size, 6);
    const m = makeCaptcha('math', rnd);
    const [x, y] = m.target.split(' + ').map(Number);
    assert.equal(Number(m.options[m.answer]), x + y);
    assert.equal(new Set(m.options).size, 4);
  }
});

test('module settings: eight modules, defaults off, invalid values fall back, learned weights kept within bounds', () => {
  assert.deepEqual(guards.CODES, ['antilink', 'antiads', 'flood', 'raid', 'captcha', 'quarantine', 'suspicious', 'risk']);
  for (const c of guards.CODES) assert.equal(guards.normalize(c, null).on, 0, c);
  const f = guards.normalize('flood', { on: 1, n: 7, t: 5, dup: 9, a: 'ban', d: 86400 });
  assert.deepEqual([f.on, f.n, f.t, f.dup, f.a, f.d], [1, 5, 5, 3, 'ban', 86400]);
  assert.deepEqual(guards.choices('raid', 'n'), [5, 10, 20, 50]);
  assert.deepEqual(guards.choices('flood', 'n'), [3, 5, 8, 12]);
  assert.deepEqual(guards.normalize('risk', { w: { xgroup: 0.5, flood: 9, bad: 'x' } }).w, { xgroup: 0.5 });
});

test('security commands: /lockdown, /readonly, /fban, /unfban and their words', () => {
  assert.deepEqual(parseCommand('/lockdown 10m spam wave'), { cmd: 'lockdown', args: ['10m', 'spam', 'wave'], mention: null });
  assert.deepEqual(parseCommand('/readonly@Aegis_Bot off'), { cmd: 'readonly', args: ['off'], mention: 'aegis_bot' });
  assert.equal(parseCommand('قفل اضطراری ۱ ساعت').cmd, 'lockdown');
  assert.equal(parseCommand('فقط خواندنی').cmd, 'readonly');
  assert.equal(parseCommand('فدبن @x').cmd, 'fban');
  assert.equal(parseCommand('رفع فدبن').cmd, 'unfban');
  assert.equal(parseCommand('/ban'), null, 'moderation commands are not security commands');
  assert.equal(parseCommand('hello'), null);
});
