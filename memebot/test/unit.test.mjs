// Unit tests: Persian normalisation, search words, and the locale files (same keys, same
// placeholders, valid HTML in every language).
import assert from 'node:assert/strict';
import test from 'node:test';
import { aliasMap, cleanKeywords, firstWord, indexWords, normalize, parseQuery, queryWords, tags } from '../tgcloud/lib/normalize.js';
import { KINDS } from '../tgcloud/lib/config.js';
import { LOCALES, DEFAULT_LANG } from '../tgcloud/lib/locales/index.js';
import { ago, langOf, num, t } from '../tgcloud/lib/i18n.js';
import { parseHtml } from './mock-telegram.mjs';
import { parseCommand } from '../tgcloud/lib/router.js';
import { toResult } from '../tgcloud/lib/inline.js';

const ZWNJ = '‌';

test('Arabic yeh / kaf and other letter forms become Persian', () => {
  assert.equal(normalize('يك'), 'یک'); // يك → یک
  assert.equal(normalize('على'), 'علی'); // alef maksura
  assert.equal(normalize('مدرسة'), 'مدرسه');
  assert.equal(normalize('خانۀ'), 'خانه');
  assert.equal(normalize('آب أمير إمام'), 'اب امیر امام');
  assert.equal(normalize('مسئول'), 'مسیول');
});

test('Persian, Arabic-Indic and Latin digits are unified', () => {
  assert.equal(normalize('۱۲۳ ٤٥٦ 789'), '123 456 789');
  assert.deepEqual(queryWords('میم ۲'), queryWords('ميم 2'));
});

test('diacritics, tatweel, zero-width and bidi characters are removed', () => {
  assert.equal(normalize('سَلامٌ'), 'سلام');
  assert.equal(normalize('ســـلام'), 'سلام');
  assert.equal(normalize('‏سلام​⁧x⁩﻿'), 'سلامx');
});

test('ZWNJ: joined word plus its parts are indexed; all spellings find it', () => {
  assert.deepEqual(indexWords(`می${ZWNJ}خوام برم`), ['میخوام', 'برم', 'می', 'خوام']);
  assert.deepEqual(queryWords(`می${ZWNJ}خوام`), ['میخوام']);
  assert.deepEqual(queryWords('میخوام'), ['میخوام']);
  assert.deepEqual(queryWords('می خوام'), ['می', 'خوام']);
  // a ZWNJ next to a space, doubled, or at the edges means nothing
  assert.equal(normalize(`می${ZWNJ} خوام ${ZWNJ}${ZWNJ}x`), 'می خوام x');
  assert.equal(normalize(`الف${ZWNJ}${ZWNJ}ب`), `الف${ZWNJ}ب`);
});

test('punctuation and runs of spaces separate words; apostrophes join', () => {
  assert.equal(normalize('  سلام،   دنیا!؟ «خوب» hello-world  '), 'سلام دنیا خوب hello world');
  assert.equal(normalize("Don't STOP"), 'dont stop');
  assert.equal(normalize('a\tb\nc d'), 'a b c d');
  assert.equal(normalize('#football @x'), 'football x');
});

test('each emoji is its own word, skin tones and variation selectors dropped', () => {
  assert.deepEqual(queryWords('😂😂 lol👍🏽'), ['😂', 'lol', '👍']);
  assert.deepEqual(queryWords('❤️'), ['❤']);
});

test('limits: query words, indexed words, word length', () => {
  assert.equal(queryWords('a b c d e f g').length, 5);
  assert.equal(indexWords(Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ')).length, 30);
  assert.equal(Array.from(indexWords('ب'.repeat(100))[0]).length, 32);
  assert.deepEqual(queryWords('!!! ،،'), []);
});

test('display keywords keep the text but unify yeh/kaf and collapse whitespace', () => {
  assert.equal(cleanKeywords(`  گربه${ZWNJ}ي   عصباني\nكیک ‏ `), `گربه${ZWNJ}ی عصبانی کیک`);
  assert.equal(cleanKeywords('آب'), 'آب');
  assert.equal(firstWord('«سلام»، دنیا'), 'سلام');
});

test('every locale has exactly the default locale\'s keys and placeholders, and valid HTML', () => {
  const base = LOCALES[DEFAULT_LANG];
  const forms = (v) => (typeof v === 'object' ? Object.values(v) : [v]);
  const holes = (v) => [...new Set(forms(v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort().join(',');
  for (const [code, loc] of Object.entries(LOCALES)) {
    assert.ok(typeof loc._name === 'string' && loc._name, `${code}: _name`);
    const keys = Object.keys(loc).filter((k) => !k.startsWith('_'));
    const baseKeys = Object.keys(base).filter((k) => !k.startsWith('_'));
    assert.deepEqual(keys.filter((k) => !baseKeys.includes(k)), [], `${code}: keys not in ${DEFAULT_LANG}`);
    assert.deepEqual(baseKeys.filter((k) => !keys.includes(k)), [], `${code}: missing keys`);
    for (const k of baseKeys) {
      assert.equal(holes(loc[k]), holes(base[k]), `${code}.${k}: placeholders differ`);
      for (const s of forms(loc[k])) {
        assert.equal(typeof s, 'string', `${code}.${k}`);
        assert.equal(parseHtml(s.replace(/\{\w+\}/g, 'x')).error, undefined, `${code}.${k}: HTML`);
      }
      if (typeof loc[k] === 'object') assert.ok(loc[k].other, `${code}.${k}: plural needs "other"`);
    }
  }
});

test('t(): digits, plural forms, fallback; langOf()', () => {
  assert.equal(num('fa', 120), '۱۲۰');
  assert.equal(num('en', 120), '120');
  assert.equal(t('en', 'ago.m', { n: 1 }), '1 minute ago');
  assert.equal(t('en', 'ago.m', { n: 5 }), '5 minutes ago');
  assert.equal(t('fa', 'ago.m', { n: 5 }), '۵ دقیقه پیش');
  assert.equal(t('xx', 'cancel.done'), t('fa', 'cancel.done'));
  assert.equal(ago('en', 0, 7200), '2 hours ago');
  assert.equal(langOf({ lang: 'en' }, { language_code: 'fa' }), 'en');
  assert.equal(langOf(null, { language_code: 'en-US' }), 'en');
  assert.equal(langOf(null, { language_code: 'de' }), 'fa');
});

test('parseCommand', () => {
  assert.deepEqual(parseCommand('/start upload'), { name: 'start', arg: 'upload' });
  assert.deepEqual(parseCommand('/My@meme_bot'), { name: 'my', arg: '' });
  assert.equal(parseCommand('hello /start'), null);
});

test('inline results: video and voice get a title, stickers none', () => {
  const m = (kind) => toResult({ id: 7, kind, file_id: 'F', keywords: 'k'.repeat(100) });
  assert.deepEqual(m('photo'), { type: 'photo', id: 'm7', photo_file_id: 'F', title: 'k'.repeat(63) + '…' });
  assert.equal(m('animation').type, 'gif');
  assert.ok(m('video').title && m('voice').title);
  assert.deepEqual(m('sticker'), { type: 'sticker', id: 'm7', sticker_file_id: 'F' });
});

test('hashtags: extracted anywhere, normalised, parts joined with _; indexed first, their words too', () => {
  assert.deepEqual(tags('گل زیبا #جام_جهانی، #فوتبالي! #World_Cup x#no #'), ['#جام_جهانی', '#فوتبالی', '#world_cup']);
  assert.deepEqual(indexWords('گل #فوتبال'), ['#فوتبال', 'گل', 'فوتبال']);
  assert.deepEqual(queryWords('#فوتبال'), ['#فوتبال'], 'a #tag query matches tags only');
  assert.deepEqual(queryWords('#فوت گل'), ['#فوت', 'گل']);
});

test('query modifiers come from every locale\'s _words: fav and a type, in any order, once each', () => {
  const A = aliasMap(LOCALES);
  for (const loc of Object.values(LOCALES)) {
    assert.ok(loc._words, `${loc._name}: _words`);
    for (const k of Object.keys(loc._words)) assert.ok(k === 'fav' || KINDS.includes(k), `${loc._name}: _words.${k}`);
  }
  assert.deepEqual(parseQuery('gif خنده', A), { fav: false, kind: 'animation', words: ['خنده'] });
  assert.deepEqual(parseQuery('گیف', A), { fav: false, kind: 'animation', words: [] });
  assert.deepEqual(parseQuery('fav', A), { fav: true, kind: null, words: [] });
  assert.deepEqual(parseQuery(`علاقه${ZWNJ}مندی${ZWNJ}ها استیکر سلام`, A), { fav: true, kind: 'sticker', words: ['سلام'] });
  assert.deepEqual(parseQuery('⭐️ ویدیو', A), { fav: true, kind: 'video', words: [] });
  assert.deepEqual(parseQuery('fav fav', A), { fav: true, kind: null, words: [] }, 'repeated words count once');
  assert.deepEqual(parseQuery('gif sticker', A), { fav: false, kind: 'animation', words: ['sticker'] }, 'one type: the second is a word');
  assert.deepEqual(parseQuery('#فوتبال گیف', A), { fav: false, kind: 'animation', words: ['#فوتبال'] });
  assert.deepEqual(parseQuery('خنده gif', A), { fav: false, kind: null, words: ['خنده', 'gif'] }, 'modifiers lead');
  assert.deepEqual(parseQuery('عکس', A).kind, 'photo');
});
