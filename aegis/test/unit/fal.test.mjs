// Fortune telling and fonts without Telegram: every Hafez ghazal read back from the compressed data
// module against data/hafez.json, the tarot deck, zodiac dates and sign input in every language,
// the daily horoscope picks, name numbers, coffee symbols, the font styles, the command words, and
// the size of every message these readings can make.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toJalali } from '../../tgcloud/lib/core/clock.js';
import { esc } from '../../tgcloud/lib/core/util.js';
import * as fun from '../../tgcloud/lib/engines/fun.js';
import { LANGS, t } from '../../tgcloud/lib/i18n/index.js';
import { parseCommand, signFrom } from '../../tgcloud/lib/ui/fun.js';
import { stubFetch } from '../sdk/fetch.mjs';

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

test('fonts: every page — Telegram styles, Unicode fonts, look-alikes, marks, Persian styles, combinations and frames', () => {
  const r = fonts.render('Hello 2026');
  assert.deepEqual(Object.keys(r.pages), ['tg', 'uni', 'look', 'mark', 'combo', 'frame', 'extra'], 'no Persian page for Latin text');
  const by = Object.fromEntries(r.pages.uni);
  assert.equal(by.bold, '𝐇𝐞𝐥𝐥𝐨 𝟐𝟎𝟐𝟔');
  assert.equal(by.italic, '𝐻𝑒𝑙𝑙𝑜 2026');
  assert.equal(by.script, 'ℋℯ𝓁𝓁ℴ 2026');
  assert.equal(by.double, 'ℍ𝕖𝕝𝕝𝕠 𝟚𝟘𝟚𝟞');
  assert.equal(by.fraktur, 'ℌ𝔢𝔩𝔩𝔬 2026');
  assert.equal(by.mono, '𝙷𝚎𝚕𝚕𝚘 𝟸𝟶𝟸𝟼');
  assert.equal(by.circled, 'Ⓗⓔⓛⓛⓞ ②⓪②⑥');
  assert.equal(by.smallcaps, 'ʜᴇʟʟᴏ 2026');
  assert.equal(by.sub, 'ₕₑₗₗₒ ₂₀₂₆');
  assert.equal(by.upside, '9ᄅ0ᄅ ollǝH', 'upside down, read backwards');
  assert.equal(by.mirror, '6202 ollɘH');
  assert.equal(by.flags, '🇭 🇪 🇱 🇱 🇴   2 0 2 6');
  assert.deepEqual(r.pages.uni.map(([c]) => c), fonts.LATIN);
  const look = Object.fromEntries(r.pages.look);
  assert.equal(look.asian, '卄乇ㄥㄥㄖ 2026');
  assert.equal(look.currency, 'ⱧɆⱠⱠØ 2026');
  assert.deepEqual(r.pages.look.map(([c]) => c), fonts.LOOK);
  for (const [c, x] of r.pages.look) assert.ok(![...x].some((ch) => /[֐-ࣿיִ-﻿]/.test(ch)), `${c}: no right-to-left letters that would turn the word around`);
  const mark = Object.fromEntries(r.pages.mark);
  assert.equal(mark.strike, 'H̶e̶l̶l̶o̶ 2̶0̶2̶6̶');
  assert.equal(mark.circle, 'H⃝e⃝l⃝l⃝o⃝ 2⃝0⃝2⃝6⃝');
  assert.equal(mark.s_hearts, 'H♥e♥l♥l♥o 2♥0♥2♥6');
  assert.deepEqual(r.pages.mark.map(([c]) => c), fonts.MARKS);
  assert.equal(r.pages.combo.length, fonts.COMBOS);
  assert.equal(r.pages.combo[0], '꧁༺ 𝓗𝓮𝓵𝓵𝓸 2026 ༻꧂');
  assert.ok(r.pages.combo.includes('➶ 𝐇̲𝐞̲𝐥̲𝐥̲𝐨̲ 𝟐̲𝟎̲𝟐̲𝟔̲'), 'bold with an underline');
  assert.equal(new Set(r.pages.combo).size, r.pages.combo.length, 'every combination is different');
  assert.equal(r.pages.frame.length, fonts.FRAMES);
  assert.equal(r.pages.tg.length, fonts.TELEGRAM.length + 6, "Telegram's styles, then over fonts");
  assert.ok(r.pages.tg.every(([, open, close]) => open.startsWith('<') && close.startsWith('</')));
  const fa = fonts.render('سلام دوست من');
  assert.deepEqual(Object.keys(fa.pages), ['tg', 'fa', 'combo', 'frame', 'extra'], 'no Unicode fonts for Persian letters');
  const p = Object.fromEntries(fa.pages.fa);
  assert.deepEqual(fa.pages.fa.map(([c]) => c), fonts.PERSIAN);
  assert.equal(p.kashida, 'سـلـام دوسـت مـن');
  assert.equal(p.apart, 'س‌ل‌ا‌م د‌و‌س‌ت م‌ن');
  assert.equal(p.harakat, 'سَِلَِاَِمَِ دَِوَِسَِتَِ مَِنَِ');
  assert.equal(p.kheart, 'سـ♡ـلـ♡ـام دوسـ♡ـت مـ♡ـن');
  assert.equal(p.kmarks, 'سـَِـلـَِـام دوسـَِـت مـَِـن');
  assert.equal(fa.pages.combo.length, fonts.PERSIAN_COMBOS);
  assert.equal(fa.pages.combo[0], '꧁ سـَِـلـَِـام دوسـَِـت مـَِـن ꧂');
  assert.equal(fa.pages.tg.length, fonts.TELEGRAM.length + 4);
  assert.equal(fonts.kashida('دار', 1), 'دار', 'no stretch after a letter that does not join forward');
  assert.equal(fonts.kashida('لا', 1), 'لـا', 'lam joins forward');
  const mixed = fonts.render('Hi سلام');
  assert.ok(!mixed.pages.uni.some(([c]) => c === 'upside' || c === 'mirror'), 'no turned text when Persian is mixed in');
  assert.equal(Object.fromEntries(mixed.pages.uni).bold, '𝐇𝐢 سلام', 'fonts leave Persian letters alone');
  assert.equal(mixed.pages.combo.length, fonts.PERSIAN_COMBOS + fonts.COMBOS);
  const ru = fonts.render('Привет');
  assert.deepEqual(Object.keys(ru.pages), ['tg', 'mark', 'combo', 'frame', 'extra'], 'Cyrillic: marks, combinations of frames and signs');
  assert.ok(ru.pages.combo.length >= 10);
  for (const lang of LANGS) {
    for (const code of [...fonts.TELEGRAM, ...fonts.TG_COMBOS]) assert.ok(!/[<>&]/.test(t(lang, fonts.TELEGRAM.includes(code) ? `fal.t_${code}` : `fal.tc_${code}`)), `${lang} ${code} label is plain`);
    for (const page of fonts.PAGES) assert.ok(t(lang, `fal.fp_${page}`).length <= 24 && !/[<>&]/.test(t(lang, `fal.fp_${page}`)), `${lang} fal.fp_${page} is a short plain button`);
    for (const k of ['btn_hafez', 'btn_tarot1', 'btn_tarot3', 'btn_horo', 'btn_abjad', 'btn_coffee', 'btn_fortune', 'btn_hafez_again', 'btn_ganjoor', 'btn_signs']) {
      assert.ok(!/[<>&]/.test(t(lang, `fal.${k}`)) && t(lang, `fal.${k}`).length <= 40, `${lang} fal.${k} is a plain, short button`);
    }
  }
});

test('fonts: the 🎨 Special page — folding quote, code with a language, accented, Braille, more look-alikes, glitch, marks, combinations', () => {
  const r = fonts.render('Hello 2026');
  const x = r.pages.extra;
  const of = (type, code) => (x.find((e) => e[0] === type && e[1] === code) || [])[2];
  assert.deepEqual(x.filter((e) => e[0] === 'h').map((e) => e[1]), ['tg', 'fonts', 'combo', 'marks']);
  assert.deepEqual(x.filter((e) => e[0] === 'tg').map((e) => [e[1], e[3], e[4]]), [['expand', '<blockquote expandable>', '</blockquote>'],
    ['codelang', '<pre><code class="language-python">', '</code></pre>']]);
  assert.equal(of('u', 'accented'), 'Ḧéĺĺő 2026');
  assert.equal(of('u', 'braille'), '⠓⠑⠇⠇⠕ ⠼⠃⠚⠃⠋', 'English Braille, digits after the number sign');
  assert.equal(fonts.styled('a1b22', 'braille'), '⠁⠼⠁⠃⠼⠃⠃');
  assert.equal(of('u', 'ethiopic'), 'ዘቿረረዐ 2026');
  assert.equal(of('u', 'canadian'), 'ᕼEᒪᒪO 2026');
  for (const code of fonts.XLATIN) assert.ok(![...of('u', code)].some((ch) => /[֐-ࣿיִ-﻿]/.test(ch)), `${code}: left to right only`);
  assert.equal(of('m', 'keycap'), 'H⃣e⃣l⃣l⃣o⃣ 2⃣0⃣2⃣6⃣');
  assert.equal(of('m', 'zalgo1'), fonts.zalgo('Hello 2026', 1), 'glitch is the same every time for the same text');
  assert.equal([...of('m', 'zalgo2')].length, 'Hello2026'.length * 8 + 1, 'full glitch: 3 above, 1 through, 3 below each letter');
  assert.equal(x.filter((e) => e[0] === 'n').length, fonts.XCOMBOS);
  assert.equal(new Set([...r.pages.combo, ...x.filter((e) => e[0] === 'n').map((e) => e[2])]).size, fonts.COMBOS + fonts.XCOMBOS, 'new combinations, none repeated');
  const fa = fonts.render('سلام دوست').pages.extra;
  assert.deepEqual(fa.filter((e) => e[0] === 'h').map((e) => e[1]), ['tg', 'fa', 'facombo']);
  const pf = Object.fromEntries(fa.filter((e) => e[0] === 'p').map((e) => [e[1], e[2]]));
  assert.deepEqual(Object.keys(pf), fonts.PERSIAN_EXTRA);
  assert.equal(pf.kdiamond, 'سـ◈ـلـ◈ـام دوسـ◈ـت');
  assert.equal(pf.apartmarks, 'سَ‌لَ‌اَ‌مَ دَ‌وَ‌سَ‌تَ');
  assert.equal(fa.filter((e) => e[0] === 'n').length, fonts.PERSIAN_XCOMBOS);
  const all = fonts.TELEGRAM.length + fonts.TG_COMBOS.length + fonts.TG_EXTRA.length + fonts.LATIN.length + fonts.LOOK.length + fonts.XLATIN.length
    + fonts.MARKS.length + fonts.XMARKS.length + fonts.PERSIAN.length + fonts.PERSIAN_EXTRA.length + fonts.COMBOS + fonts.XCOMBOS + fonts.PERSIAN_COMBOS
    + fonts.PERSIAN_XCOMBOS + fonts.FRAMES;
  assert.ok(all > 220, `${all} styles: the feature's description says 220+`);
});

test('fonts: the longest input stays inside Telegram limits on every page', () => {
  for (const text of ['W'.repeat(40), 'ش'.repeat(40), `${'W'.repeat(20)}${'ش'.repeat(20)}`, 'Hello world, this is forty characters!!']) {
    const r = fonts.render(text);
    for (const [page, items] of Object.entries(r.pages)) {
      for (const it of items) {
        const x = Array.isArray(it) ? String(it[2] === undefined ? it[it.length - 1] : it[2]) : it;
        assert.ok(x.length <= 400, `${page}: one line of ${x.length}`);
      }
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
  assert.deepEqual(p('فال ماه تولد اسد'), ['birthmonth', 'اسد']);
  assert.deepEqual(p('متولد مهر'), ['birthmonth', 'مهر']);
  assert.deepEqual(p('طالع چینی ۱۳۷۰'), ['chinese', '۱۳۷۰']);
  assert.deepEqual(p('عدد سرنوشت 1370/7/15'), ['lifepath', '1370/7/15']);
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

test('symbolic hours: 24 mirror, 13 reversed and 13 triple times; times read from text; the next ones today', () => {
  const n = fun.numbers;
  assert.equal(n.MIRROR.length, 24);
  assert.deepEqual(n.REVERSED, ['01:10', '02:20', '03:30', '04:40', '05:50', '10:01', '12:21', '13:31', '14:41', '15:51', '20:02', '21:12', '23:32']);
  assert.deepEqual(n.TRIPLE, ['01:11', '02:22', '03:33', '04:44', '05:55', '10:00', '12:22', '13:33', '14:44', '15:55', '20:00', '21:11', '23:33']);
  assert.deepEqual([n.timeType(11, 11), n.timeType(12, 21), n.timeType(3, 33), n.timeType(14, 32)], ['mirror', 'reversed', 'triple', null]);
  assert.deepEqual(n.timeKey(22, 22), { type: 'mirror', i: 22, digit: 2 });
  assert.deepEqual(n.timeKey(15, 51), { type: 'reversed', i: 9, digit: 1 });
  assert.deepEqual([n.parseTime('11:11'), n.parseTime('9.05'), n.parseTime('2222'), n.parseTime('24:00'), n.parseTime('11:61'), n.parseTime('hi')],
    [{ h: 11, m: 11 }, { h: 9, m: 5 }, { h: 22, m: 22 }, null, null, null]);
  assert.deepEqual(n.next(14, 32), [{ time: '14:41', type: 'reversed' }, { time: '14:44', type: 'triple' }, { time: '15:15', type: 'mirror' }]);
  assert.deepEqual(n.next(23, 40), [], 'nothing after 23:33');
  for (const lang of LANGS) {
    for (const [k, len] of Object.entries({ mirror: 24, reversed: 13, angel3: 10, angelx: 4, seqx: 10, rep2: 10, rep4: 10, digits: 10 })) assert.equal(list(lang, k).length, len, `${lang} ${k}`);
  }
  assert.equal(list('fa', 'mirror')[11], 'بیداری معنوی، آرزو و هم‌زمانی', "the owner's own meaning of 11:11");
  assert.equal(list('fa', 'mirror')[0], 'شروع دوباره، پایان یک چرخه');
});

test('number meanings: repeated numbers 00–9999 have their own meaning; kinds; digits and the root of any other number', () => {
  const n = fun.numbers;
  const own = (d) => n.own(d);
  assert.deepEqual([own('00'), own('77'), own('000'), own('777'), own('0000'), own('9999')], [{ list: 'rep2', i: 0 }, { list: 'rep2', i: 7 }, { list: 'angel3', i: 0 },
    { list: 'angel3', i: 7 }, { list: 'rep4', i: 0 }, { list: 'rep4', i: 9 }]);
  assert.deepEqual([own('1212'), own('1234'), own('12321'), own('2468')], [{ list: 'angelx', i: 1 }, { list: 'seqx', i: 1 }, { list: 'seqx', i: 9 }, null]);
  assert.deepEqual(n.kinds('1111'), ['repeat']);
  assert.deepEqual(n.kinds('333'), ['repeat', 'angel']);
  assert.deepEqual(n.kinds('6789'), ['asc']);
  assert.deepEqual(n.kinds('54321'), ['desc']);
  assert.deepEqual(n.kinds('12321'), ['peak', 'palin']);
  assert.deepEqual(n.kinds('1001'), ['palin']);
  assert.deepEqual(n.kinds('3434'), ['pair']);
  assert.deepEqual(n.kinds('2468'), []);
  assert.deepEqual(n.digits('1223'), { order: [{ digit: 2, n: 2 }, { digit: 1, n: 1 }, { digit: 3, n: 1 }], sum: 8, root: 8 });
  assert.equal(n.digits('29').root, 11, 'master numbers kept');
  assert.deepEqual([n.parseNumber('0042'), n.parseNumber('1234567'), n.parseNumber('12a'), n.parseNumber('')], ['0042', null, null, null]);
});

test('birth readings: Persian dates to Gregorian, birth dates as typed, weekday, life path, the Chinese year and how it fares', () => {
  const b = fun.birth;
  assert.deepEqual([b.toGregorian(1370, 7, 15), b.toGregorian(1403, 1, 1), b.toGregorian(1357, 11, 22)], [[1991, 10, 7], [2024, 3, 20], [1979, 2, 11]]);
  for (let y = 1300; y < 1480; y += 7) for (let m = 1; m <= 12; m += 1) assert.deepEqual(toJalali(...b.toGregorian(y, m, 10)), [y, m, 10], `${y}/${m}/10`);
  assert.deepEqual(b.parseDate('1370/7/15'), { gy: 1991, gm: 10, gd: 7, cal: 'j', y: 1370, m: 7, d: 15 });
  assert.deepEqual(b.parseDate('15.10.1991'), { gy: 1991, gm: 10, gd: 15, cal: 'g', y: 1991, m: 10, d: 15 });
  assert.equal(b.parseDate('1991-02-30'), null);
  assert.equal(b.parseDate('1370/7/31'), null, 'the second half of the Persian year has 30 days');
  assert.equal(b.parseDate('99/1/1'), null);
  assert.equal(b.weekday(1991, 10, 7), 1, 'Monday');
  assert.deepEqual(b.lifePath(1991, 10, 7), { number: 1, steps: [28, 10, 1] });
  assert.deepEqual(b.lifePath(1990, 11, 8), { number: 11, steps: [29, 11] }, 'master numbers are kept');
  assert.deepEqual(b.chinese(2026, 5, 1), { year: 2026, animal: 6, element: 1, yang: true }, '2026: the fire horse');
  assert.equal(b.chinese(2026, 2, 3).year, 2025, 'before 4 February: the year before');
  assert.deepEqual(b.chinese(1991), { year: 1991, animal: 7, element: 3, yang: false }, '1991: the metal goat');
  assert.deepEqual([b.relation(6, 6), b.relation(0, 1), b.relation(0, 6), b.relation(2, 6), b.relation(1, 6)], ['same', 'best', 'clash', 'good', 'neutral']);
  assert.deepEqual(b.trio(6), [2, 10]);
  for (const lang of LANGS) {
    for (const [k, n] of Object.entries({ bm_traits: 12, bm_lucky: 12, cz_names: 12, cz_traits: 12, cz_elements: 5, lifepath: 12, weekdays: 7 })) assert.equal(list(lang, k).length, n, `${lang} ${k}`);
  }
});

test('drawn readings: different cards, runes that never reverse, the I Ching table and its changing lines, dice', () => {
  const d = fun.draw;
  const seen = new Set();
  for (let a = 0; a < 64; a += 1) seen.add(d.hexOf([...Array(6)].map((_, i) => (a >> i) & 1)));
  assert.equal(seen.size, 64, 'every line pattern is a different hexagram, 1–64');
  assert.deepEqual([d.hexOf([1, 1, 1, 1, 1, 1]), d.hexOf([0, 0, 0, 0, 0, 0]), d.hexOf([1, 1, 1, 0, 0, 0]), d.hexOf([0, 0, 0, 1, 1, 1]), d.hexOf([1, 0, 1, 0, 1, 0]),
    d.hexOf([0, 1, 0, 1, 0, 1]), d.hexOf([1, 0, 0, 0, 1, 0]), d.hexOf([0, 1, 0, 0, 0, 1])], [1, 2, 11, 12, 63, 64, 3, 4]);
  for (let k = 0; k < 300; k += 1) {
    const c = d.iching();
    assert.ok(c.throws.every((v) => v >= 6 && v <= 9));
    assert.deepEqual(c.lines, c.throws.map((v) => v % 2));
    assert.equal(c.hex, d.hexOf(c.lines));
    assert.equal(c.to ? 1 : 0, c.changing.length ? 1 : 0);
    if (c.to) assert.equal(c.to, d.hexOf(c.lines.map((l, i) => (c.changing.includes(i + 1) ? 1 - l : l))));
    const r = d.runes(3);
    assert.equal(new Set(r.map((x) => x.rune)).size, 3);
    assert.ok(r.every((x) => !(x.reversed && d.SAME_REVERSED.has(x.rune))), 'a rune that looks the same both ways is never reversed');
    assert.equal(new Set(d.picks(52, 3)).size, 3);
    assert.ok(d.dice().every((v) => v >= 1 && v <= 6));
  }
  assert.equal(d.hexGlyph(1), '䷀');
  assert.equal(d.hexGlyph(64), '䷿');
  assert.deepEqual([d.cardGlyph(0), d.cardGlyph(12), d.cardGlyph(51)], ['A♥️', 'K♥️', 'K♠️']);
  assert.equal(d.LENORMAND.length, 36);
  for (const lang of LANGS) {
    for (const [k, n] of Object.entries({ cd_ranks: 13, cd_suits: 4, cd_mean: 52, rune_names: 24, rune_up: 24, rune_rev: 24, iching: 64, tas: 16, lenormand: 36 })) {
      assert.equal(list(lang, k).length, n, `${lang} ${k}`);
    }
  }
});

test('religious readings: the first verse of a right-hand page, surah names, the translation fetched (or not), prayer beads, the prophets', async () => {
  const f = fun.faith;
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/quran.json'), 'utf8'));
  assert.equal(src.pages.length, 604);
  for (let p = 1; p <= 604; p += 1) assert.deepEqual(f.verse(p), { page: p, surah: src.pages[p - 1][0], ayah: src.pages[p - 1][1], text: src.pages[p - 1][2] });
  assert.deepEqual(f.verse(2), { page: 2, surah: 2, ayah: 1, text: 'الٓمٓ' }, 'the basmala the source added is gone');
  assert.equal(f.verse(1).text.startsWith('بِسْمِ'), true, 'al-Fatiha keeps its first verse');
  for (let i = 0; i < 200; i += 1) {
    const v = f.istikhara();
    assert.ok(v.page % 2 === 1 && v.page >= 1 && v.page <= 603, 'a right-hand page');
    const b = f.tasbih();
    assert.ok(b.beads >= 1 && b.beads <= 99 && b.good === (b.beads % 2 === 1));
  }
  assert.deepEqual([f.surahName(2, 'fa'), f.surahName(2, 'en'), f.surahName(114, 'fa')], ['بقره', 'Al-Baqara', 'ناس']);
  const asked = [];
  stubFetch(async (url) => {
    asked.push(String(url));
    return { ok: true, status: 200, json: async () => ({ code: 200, data: { text: 'Translated verse.' } }) };
  });
  assert.equal(await f.translation(2, 255, 'fa'), 'Translated verse.');
  assert.equal(asked[0], 'https://api.alquran.cloud/v1/ayah/2:255/fa.makarem');
  await f.translation(1, 1, 'zh');
  assert.equal(asked[1], 'https://api.alquran.cloud/v1/ayah/1:1/zh.jian');
  stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.equal(await f.translation(2, 255, 'en'), null, 'a failing service: no translation');
  stubFetch(async () => {
    throw new Error('offline');
  });
  assert.equal(await f.translation(2, 255, 'en'), null, 'no network: no translation');
  stubFetch(null);
  for (const lang of LANGS) assert.equal(list(lang, 'anbia').length, 24, `${lang} anbia`);
});

