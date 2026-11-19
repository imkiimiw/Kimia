// Fortune telling and fonts without Telegram: every Hafez ghazal read back from the compressed data
// module against data/hafez.json, the tarot deck, zodiac dates and sign input in every language,
// the daily horoscope picks, name numbers, coffee symbols, the font styles, the command words, and
// the size of every message these readings can make.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { esc } from '../../tgcloud/lib/core/util.js';
import * as fun from '../../tgcloud/lib/engines/fun.js';
import { LANGS, t } from '../../tgcloud/lib/i18n/index.js';
import { parseCommand, signFrom } from '../../tgcloud/lib/ui/fun.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const list = (lang, key) => t(lang, `fallist.${key}`).split('\n').map((x) => x.replace(/[‏‎]/g, '').trim()).filter(Boolean);
const { fal, fonts } = fun;

test('Hafez: all 495 ghazals decode from lib/data/fal.js exactly as in data/hafez.json, and fit one message', () => {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/hafez.json'), 'utf8')).ghazals;
  assert.equal(fal.HAFEZ_COUNT, 495);
  assert.equal(src.length, 495);
  for (const g of src) {
    const got = fal.ghazal(g.n);
    assert.equal(got.n, g.n);
    assert.deepEqual(got.v, g.v, `ghazal ${g.n} text`);
    assert.equal(got.f, g.f, `ghazal ${g.n} interpretation`);
    assert.ok(got.v.length >= 5 && got.v.every((b) => b.length === 2 && b[0] && b[1]), `ghazal ${g.n} has whole couplets`);
    assert.ok(got.f.length >= 60, `ghazal ${g.n} has an interpretation`);
    /* the message: title + blockquote + interpretation + note, with a mark per line */
    const body = got.v.map(([a, b]) => `‏${esc(a)}\n‏${esc(b)}`).join('\n\n');
    const size = body.length + got.f.length + 600;
    assert.ok(size < 4096, `ghazal ${g.n}: ${size} characters`);
  }
  assert.equal(fal.ghazal(0).n, 1, 'clamped');
  assert.equal(fal.ghazal(9999).n, 495, 'clamped');
});

test('tarot: 78 cards with images, draws without repeats, yes/no/maybe, names and meanings in every language', () => {
  assert.equal(fal.CARDS, 78);
  for (let c = 0; c < 78; c += 1) assert.match(fal.image(c), /^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/.+\/500px-[^/]+\.jpg$/);
  assert.equal(fal.suitOf(0), 'major');
  assert.equal(fal.suitOf(21), 'major');
  assert.equal(fal.suitOf(22), 'wands');
  assert.equal(fal.suitOf(77), 'pentacles');
  for (let i = 0; i < 200; i += 1) {
    const d = fal.draw(3);
    assert.equal(new Set(d.map((x) => x.card)).size, 3);
    assert.ok(d.every((x) => x.card >= 0 && x.card < 78 && typeof x.reversed === 'boolean'));
  }
  assert.equal(fal.answer({ card: 17, reversed: false }), 'yes');
  assert.equal(fal.answer({ card: 17, reversed: true }), 'no');
  assert.equal(fal.answer({ card: 18, reversed: false }), 'maybe');
  for (const lang of LANGS) {
    const names = list(lang, 'tarot_names');
    const up = list(lang, 'tarot_up');
    const rev = list(lang, 'tarot_rev');
    assert.equal(names.length, 78, `${lang} names`);
    assert.equal(up.length, 78, `${lang} upright`);
    assert.equal(rev.length, 78, `${lang} reversed`);
    assert.equal(new Set(names).size, 78, `${lang} names are distinct`);
    /* the photo caption: title with a question, the card, its meaning, the note — under Telegram's 1024 */
    for (let c = 0; c < 78; c += 1) {
      const longest = Math.max(up[c].length, rev[c].length);
      const caption = [t(lang, 'fal.tarot_q', { user: 'x'.repeat(34), q: 'q'.repeat(122) }), '', t(lang, 'fal.tarot_card', { card: t(lang, 'fal.card_rev', { name: names[c] }) }),
        'm'.repeat(longest), '', t(lang, 'fal.yn_maybe'), '', t(lang, 'fal.tarot_note')].join('\n');
      assert.ok(caption.length <= 1024, `${lang} card ${c}: caption ${caption.length}`);
    }
  }
});

test('zodiac: Gregorian dates, Persian months, and sign input in every language', () => {
  const g = (m, d) => fal.signOf('g', m, d);
  assert.deepEqual([g(3, 20), g(3, 21), g(4, 19), g(4, 20), g(12, 21), g(12, 22), g(1, 19), g(1, 20), g(2, 18), g(2, 19)], [11, 0, 0, 1, 8, 9, 9, 10, 10, 11]);
  for (let m = 1; m <= 12; m += 1) assert.equal(fal.signOf('j', m, 15), m - 1, 'Farvardin is Aries, … Esfand is Pisces');
  for (let i = 0; i < 12; i += 1) {
    const r = fal.range(i);
    assert.equal(g(...r.from), i);
    assert.equal(g(...r.to), i);
  }
  const cases = [['اسد', 4], ['Leo', 4], ['leo', 4], ['مهر', 6], ['متولد مهر', 6], ['1370/7/15', 6], ['۱۳۷۰/۷/۱۵', 6], ['21.03', 0], ['03-21', 0],
    ['1990-10-08', 6], ['08.10.1990', 6], ['♌', 4], ['Овен', 0], ['白羊座', 0], ['Bélier', 0], ['Poissons', 11], ['October', 6], ['حوت', 11]];
  for (const [text, sign] of cases) assert.equal(signFrom(text, 'en', null), sign, text);
  assert.equal(signFrom('7/15', 'fa', null), 6, 'm/d without a year: the Persian calendar for a Persian chat');
  assert.equal(signFrom('7/15', 'en', null), 3, 'm/d without a year: Gregorian otherwise (15 July = Cancer)');
  for (const bad of ['xyz', '13/40', 'hello world', '']) assert.equal(signFrom(bad, 'en', null), null, bad);
  for (const lang of LANGS) {
    const signs = list(lang, 'signs');
    assert.equal(signs.length, 12, `${lang} signs`);
    for (let i = 0; i < 12; i += 1) assert.equal(signFrom(signs[i].split('|')[0], lang, null), i, `${lang} ${signs[i]}`);
  }
});

test('horoscope: the same reading all day for a sign, and every pick inside its pool', () => {
  const sizes = { love: 20, work: 20, health: 12, advice: 20, color: 12 };
  const a = fal.horoscope(4, 20400, sizes);
  assert.deepEqual(a, fal.horoscope(4, 20400, sizes), 'stable for the day');
  let changed = 0;
  for (let day = 20400; day < 20430; day += 1) {
    for (let sign = 0; sign < 12; sign += 1) {
      const h = fal.horoscope(sign, day, sizes);
      for (const k of Object.keys(sizes)) assert.ok(h[k] >= 0 && h[k] < sizes[k]);
      assert.ok(h.number >= 1 && h.number <= 99);
      assert.ok(Object.values(h.stars).every((n) => n >= 1 && n <= 5));
    }
    if (JSON.stringify(fal.horoscope(4, day, sizes)) !== JSON.stringify(a)) changed += 1;
  }
  assert.ok(changed >= 25, 'other days read differently');
  for (const lang of LANGS) {
    for (const [k, n] of Object.entries({ horo_love: 20, horo_work: 20, horo_health: 12, horo_advice: 20, colors: 12 })) assert.equal(list(lang, k).length, n, `${lang} ${k}`);
  }
});

test('name numbers: abjad, Pythagorean and Cyrillic values, master numbers, and meanings in every language', () => {
  assert.deepEqual(fal.numerology('علی'), { system: 'abjad', total: 110, number: 2, letters: 3 });
  assert.deepEqual(fal.numerology('محمد'), { system: 'abjad', total: 92, number: 11, letters: 4 });
  assert.equal(fal.numerology('مُحَمَّد').total, 92, 'diacritics do not count');
  assert.equal(fal.numerology('کیمیا').total, 20 + 10 + 40 + 10 + 1);
  assert.deepEqual(fal.numerology('Kimia'), { system: 'latin', total: 25, number: 7, letters: 5 });
  assert.deepEqual(fal.numerology('Иван'), { system: 'cyrillic', total: 11, number: 11, letters: 4 });
  assert.equal(fal.numerology('李'), null);
  assert.equal(fal.numerology('123'), null);
  assert.deepEqual([fal.reduce(29), fal.reduce(38), fal.reduce(49), fal.reduce(22), fal.reduce(9), fal.reduce(1000)], [11, 11, 4, 22, 9, 1]);
  for (const lang of LANGS) {
    const n = list(lang, 'numbers');
    assert.equal(n.length, 11, `${lang} numbers`);
    assert.ok(n.every((x) => x.split('|').length === 2 && x.split('|').every((y) => y.trim())), `${lang} title|meaning`);
    const c = list(lang, 'coffee');
    assert.equal(c.length, 30, `${lang} coffee`);
    assert.ok(c.every((x) => x.split('|').length === 3 && x.split('|').every((y) => y.trim())), `${lang} emoji|name|meaning`);
  }
  for (let i = 0; i < 100; i += 1) {
    const s = fal.symbols(30, 3);
    assert.equal(new Set(s).size, 3);
    assert.ok(s.every((x) => x >= 0 && x < 30));
  }
});

test('fonts: every Unicode style, upside down, combining marks, Persian stretching, frames, and Telegram styles', () => {
  const r = fonts.render('Hello 2026');
  const by = Object.fromEntries(r.latin);
  assert.equal(by.bold, '𝐇𝐞𝐥𝐥𝐨 𝟐𝟎𝟐𝟔');
  assert.equal(by.italic, '𝐻𝑒𝑙𝑙𝑜 2026');
  assert.equal(by.script, 'ℋℯ𝓁𝓁ℴ 2026');
  assert.equal(by.double, 'ℍ𝕖𝕝𝕝𝕠 𝟚𝟘𝟚𝟞');
  assert.equal(by.fraktur, 'ℌ𝔢𝔩𝔩𝔬 2026');
  assert.equal(by.mono, '𝙷𝚎𝚕𝚕𝚘 𝟸𝟶𝟸𝟼');
  assert.equal(by.circled, 'Ⓗⓔⓛⓛⓞ ②⓪②⑥');
  assert.equal(by.smallcaps, 'ʜᴇʟʟᴏ 2026');
  assert.equal(by.upside, '9ᄅ0ᄅ ollǝH', 'upside down, read backwards');
  assert.equal(by.strike, 'H̶e̶l̶l̶o̶ 2̶0̶2̶6̶');
  assert.deepEqual(r.latin.map(([c]) => c), [...fonts.LATIN, 'upside', ...fonts.COMBINING]);
  assert.equal(r.telegram.length, fonts.TELEGRAM.length);
  assert.ok(r.telegram.every(([, open, close]) => open.startsWith('<') && close.startsWith('</')));
  const fa = fonts.render('سلام دوست من');
  assert.equal(fa.hasLatin, false);
  assert.equal(fa.hasArabic, true);
  assert.equal(fa.latin.length, 0, 'no Unicode fonts for Persian letters');
  assert.equal(Object.fromEntries(fa.deco).kashida, 'سـلـام دوسـت مـن');
  assert.equal(fonts.kashida('دار', 1), 'دار', 'no stretch after a letter that does not join forward');
  assert.equal(fonts.kashida('لا', 1), 'لـا', 'lam joins forward');
  assert.equal(fa.deco.filter(([c]) => c.startsWith('frame')).length, fonts.FRAMES);
  const mixed = fonts.render('Hi سلام');
  assert.ok(!mixed.latin.some(([c]) => c === 'upside'), 'no upside-down text when Persian is mixed in');
  assert.equal(Object.fromEntries(mixed.latin).bold, '𝐇𝐢 سلام');
  /* the longest input in the widest styles stays well inside one message per part */
  const long = fonts.render('W'.repeat(40));
  const uni = long.latin.map(([, s]) => s.length + 40).reduce((a, b) => a + b, 0);
  assert.ok(uni < 3800, `unicode part: ${uni}`);
  for (const lang of LANGS) {
    for (const code of fonts.TELEGRAM) assert.ok(!/[<>&]/.test(t(lang, `fal.t_${code}`)), `${lang} fal.t_${code} is plain`);
    for (const code of [...fonts.LATIN, 'upside', ...fonts.COMBINING]) assert.ok(!/[<>&]/.test(t(lang, `fal.u_${code}`)), `${lang} fal.u_${code} is plain`);
    for (const k of ['btn_hafez', 'btn_tarot1', 'btn_tarot3', 'btn_horo', 'btn_abjad', 'btn_coffee', 'btn_fortune', 'btn_hafez_again', 'btn_ganjoor', 'btn_signs']) {
      assert.ok(!/[<>&]/.test(t(lang, `fal.${k}`)) && t(lang, `fal.${k}`).length <= 40, `${lang} fal.${k} is a plain, short button`);
    }
  }
});

test('fortune words: «فال» opens the menu, longer words win, arguments only where they make sense', () => {
  const p = (s) => {
    const r = parseCommand(s);
    return r && [r.code, r.args.join(' ')];
  };
  assert.deepEqual(p('فال'), ['fal', '']);
  assert.deepEqual(p('/fal'), ['fal', '']);
  assert.deepEqual(p('فال حافظ'), ['hafez', '']);
  assert.deepEqual(p('فال حافظ ۱۲'), ['hafez', '۱۲']);
  assert.deepEqual(p('فال کلوچه'), ['fortune', '']);
  assert.deepEqual(p('تاروت'), ['tarot', '']);
  assert.deepEqual(p('فال تاروت 3'), ['tarot', '3']);
  assert.deepEqual(p('طالع مهر'), ['horo', 'مهر']);
  assert.deepEqual(p('فال ماه تولد اسد'), ['horo', 'اسد']);
  assert.deepEqual(p('فال قهوه'), ['coffee', '']);
  assert.deepEqual(p('فال اسم علی'), ['abjad', 'علی']);
  assert.deepEqual(p('فونت سلام دنیا'), ['font', 'سلام دنیا']);
  assert.deepEqual(p('/tarot 3'), ['tarot', '3']);
  assert.deepEqual(p('/horoscope Leo'), ['horo', 'Leo']);
  assert.deepEqual(p('/horo 21.03'), ['horo', '21.03']);
  assert.deepEqual(p('/numerology Kimia'), ['abjad', 'Kimia']);
  assert.deepEqual(p('/fonts Hello'), ['font', 'Hello']);
  assert.deepEqual(p('horoscope'), ['horo', '']);
  assert.deepEqual(p('гороскоп'), ['horo', '']);
  assert.deepEqual(p('塔罗牌'), ['tarot', '']);
  assert.equal(p('فال بده دیگه لطفا'), null, '«فال» with other words is just chat');
  assert.equal(p('فال قهوه بگیر'), null, 'coffee takes no arguments');
});
