// Phase 2 pure modules: the normalization table (spec §8.2, §12), language classification,
// duplicate rules, ingest helpers, the catalog provider and the channel rate window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { display, key, compact, normalizeTrack, parseFileName, extractVersion, splitArtists, stripNoise } from '../../tgcloud/lib/music/normalize.js';
import { classifyLanguage, heuristicLanguage, scriptClassifier } from '../../tgcloud/lib/music/classify.js';
import { dupKey, isHardDuplicate, isSoftDuplicate, needsReview } from '../../tgcloud/lib/music/duplicates.js';
import { mediaRefusal, originOf } from '../../tgcloud/lib/music/ingest.js';
import { createCatalogProvider } from '../../tgcloud/lib/music/providers/catalog.js';
import { windowAllows } from '../../tgcloud/lib/telegram/limiter.js';
import { archiveCaption } from '../../tgcloud/lib/music/catalog.js';

const ZWNJ = '‌';
const dk = (title, performer) => { const n = normalizeTrack({ title, performer }); return dupKey(n.normalizedArtist, n.normalizedTitle, n.versionKey); };

test('normalization: Persian/Arabic letters (display keeps real spelling, keys unify)', () => {
  assert.equal(display('علي كريمي'), 'علی کریمی', 'ي → ی and ك → ک in display');
  assert.equal(display('موسيقى'), 'موسیقی', 'ى → ی');
  const pairs = [['ة', 'ه'], ['ۀ', 'ه'], ['ؤ', 'و'], ['ئ', 'ی'], ['أ', 'ا'], ['إ', 'ا'], ['آ', 'ا'], ['ي', 'ی'], ['ك', 'ک']];
  for (const [from, to] of pairs) assert.equal(key(`ب${from}ب`), `ب${to}ب`, `${from} → ${to}`);
  assert.equal(key('مؤمن'), 'مومن');
  assert.equal(key('خانهٔ'), 'خانه');
});

test('normalization: ZWNJ, ZWJ and bidi marks; the space-free variant', () => {
  assert.equal(key(`می${ZWNJ}خوام`), 'می خوام');
  assert.equal(compact(`می${ZWNJ}خوام`), compact('میخوام'));
  assert.equal(compact('میخوام'), compact('می خوام'));
  assert.equal(key('سلام‍دنیا‏'), 'سلام دنیا');
  assert.equal(display(`‫می${ZWNJ}خوام‬`), `می${ZWNJ}خوام`, 'display keeps the ZWNJ, drops bidi marks');
});

test('normalization: digits, diacritics, tatweel', () => {
  assert.equal(key('۲'), '2');
  assert.equal(key('٢'), '2');
  assert.equal(key('آهنگ ۱۴۰۵'), 'اهنگ 1405');
  assert.equal(key('بِسْمِ اللَّه'), 'بسم الله');
  assert.equal(key('سلامــــت'), 'سلامت');
  assert.equal(display('سلامــــت'), 'سلامت');
});

test('normalization: Latin (NFKC, lowercase, accents, &)', () => {
  assert.equal(key('Beyoncé'), 'beyonce');
  assert.equal(key('Simon & Garfunkel'), 'simon and garfunkel');
  assert.equal(key('ＡＢＣ'), 'abc', 'full-width');
  assert.equal(key('ﬁre'), 'fire', 'ligature');
  assert.equal(key("Don't Stop!"), 'don t stop');
});

test('normalization: noise (mentions, URLs, emojis, official tags, bitrate, Persian phrases)', () => {
  assert.equal(display('Song @mychannel'), 'Song');
  assert.equal(display('Song https://t.me/abc'), 'Song');
  assert.equal(display('🎵 Song 🔥'), 'Song');
  assert.equal(display('Song (Official Audio)'), 'Song');
  assert.equal(display('Song [Official Music Video]'), 'Song');
  assert.equal(display('Song (Lyrics)'), 'Song');
  assert.equal(display('Song 320kbps'), 'Song');
  assert.equal(display('Song [320]'), 'Song');
  assert.equal(display('Song - HQ'), 'Song');
  assert.equal(display('دانلود آهنگ دلم تنگه'), 'دلم تنگه');
  assert.equal(display('دلم تنگه با کیفیت 320'), 'دلم تنگه');
  assert.equal(display('دلم تنگه کانال موزیک'), 'دلم تنگه');
  assert.equal(display('Lyrics of Life'), 'Lyrics of Life', 'unbracketed words stay');
  assert.equal(stripNoise('320 Days').trim(), '320 Days', 'a bare number stays');
});

test('normalization: version markers are kept as data', () => {
  const v = (title) => extractVersion(display(title));
  assert.deepEqual(v('Song (Remix)'), { title: 'Song', version: 'Remix' });
  assert.deepEqual(v('Song [Live]'), { title: 'Song', version: 'Live' });
  assert.deepEqual(v('Song - Acoustic'), { title: 'Song', version: 'Acoustic' });
  assert.deepEqual(v('Song (Unplugged)'), { title: 'Song', version: 'Unplugged' });
  assert.deepEqual(v('Song (Instrumental)'), { title: 'Song', version: 'Instrumental' });
  assert.deepEqual(v('Song (Cover)'), { title: 'Song', version: 'Cover' });
  assert.deepEqual(v('Song (Slowed + Reverb)'), { title: 'Song', version: 'Slowed + Reverb' });
  assert.deepEqual(v('Song (Sped Up)'), { title: 'Song', version: 'Sped Up' });
  assert.deepEqual(v('Song (Remastered 2011)'), { title: 'Song', version: 'Remastered 2011' });
  assert.deepEqual(v('Song (Kygo Remix) [Live]'), { title: 'Song', version: 'Kygo Remix Live' });
  assert.deepEqual(v('عاشقانه ریمیکس'), { title: 'عاشقانه', version: 'ریمیکس' });
  assert.deepEqual(v('عاشقانه (لایو)'), { title: 'عاشقانه', version: 'لایو' });
  assert.deepEqual(v(`عاشقانه بی${ZWNJ}کلام`), { title: 'عاشقانه', version: `بی${ZWNJ}کلام` });
  assert.deepEqual(v('Live Your Life'), { title: 'Live Your Life', version: null }, 'words inside the title stay');
  assert.deepEqual(v('Song (Love)'), { title: 'Song (Love)', version: null }, 'brackets without a marker stay');
});

test('normalization: featured artists (feat., ft., featuring, x, &, و)', () => {
  const f = (title, performer) => { const n = normalizeTrack({ title, performer }); return [n.artist, n.featured, n.title]; };
  assert.deepEqual(f('Song', 'A feat. B'), ['A', 'B', 'Song']);
  assert.deepEqual(f('Song', 'A ft. B'), ['A', 'B', 'Song']);
  assert.deepEqual(f('Song', 'A featuring B & C'), ['A', 'B, C', 'Song']);
  assert.deepEqual(f('Song', 'A x B'), ['A', 'B', 'Song']);
  assert.deepEqual(f('Song', 'A & B'), ['A', 'B', 'Song']);
  assert.deepEqual(f('دلم', 'شادمهر و ابی'), ['شادمهر', 'ابی', 'دلم']);
  assert.deepEqual(f('Song (feat. B)', 'A'), ['A', 'B', 'Song']);
  assert.deepEqual(f('Song ft. B', 'A'), ['A', 'B', 'Song']);
  assert.deepEqual(splitArtists('Max'), ['Max'], 'an x inside a word is not a separator');
  assert.equal(normalizeTrack({ title: 'Song', performer: 'A feat. B' }).normalizedArtist, 'a', 'normalized_artist is the primary artist');
});

test('normalization: file names, and "Artist - Title" in the title tag', () => {
  assert.deepEqual(parseFileName('Artist - Title.mp3'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseFileName('01. Artist - Title (320).mp3'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseFileName('03 - Artist - Title.m4a'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseFileName('21 Savage - a lot.mp3'), { artist: '21 Savage', title: 'a lot' }, 'a number that is part of the name stays');
  assert.deepEqual(parseFileName('Artist_-_Title.mp3'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseFileName('JustATitle.mp3'), { artist: null, title: 'JustATitle' });
  const n = normalizeTrack({ title: null, performer: null, fileName: '01. Shadmehr Aghili - Ghalbe Man @music.mp3' });
  assert.deepEqual([n.artist, n.title], ['Shadmehr Aghili', 'Ghalbe Man']);
  const m = normalizeTrack({ title: 'Jay-Z - Empire State', performer: null });
  assert.deepEqual([m.artist, m.title], ['Jay-Z', 'Empire State']);
});

test('duplicates: the spec examples', () => {
  assert.equal(dk('blinding lights', 'the weeknd'), dk('Blinding Lights', 'The Weeknd'));
  assert.notEqual(dk('Song (Remix)', 'A'), dk('Song', 'A'), '“Song (Remix)” is not “Song”');
  assert.equal(dk('Song (Official Audio)', 'A @chan'), dk('song', 'a'));
  assert.equal(dk('دلم تنگه', 'شادمهر عقيلي'), dk('دلم تنگه', 'شادمهر عقیلی'));
  const a = { dup_key: 'x|y|', duration: 200 };
  assert.equal(isSoftDuplicate(a, { dup_key: 'x|y|', duration: 203 }), true, 'within 3 s');
  assert.equal(isSoftDuplicate(a, { dup_key: 'x|y|', duration: 204 }), false, '4 s apart');
  assert.equal(isSoftDuplicate(a, { dup_key: 'x|y|remix', duration: 200 }), false);
  assert.equal(isSoftDuplicate(a, { dup_key: 'x|y|', duration: 0 }), true, 'unknown duration does not rule it out');
  const ex = { audio_file_unique_id: 'U1', origin_chat_id: -100, origin_message_id: 5 };
  assert.equal(isHardDuplicate(ex, { file_unique_id: 'U1' }), true);
  assert.equal(isHardDuplicate(ex, { file_unique_id: 'U2', origin_chat_id: -100, origin_message_id: 5 }), true);
  assert.equal(isHardDuplicate(ex, { file_unique_id: 'U2', origin_chat_id: -100, origin_message_id: 6 }), false);
  assert.equal(needsReview({ title: 'a', artist: 'b', language: 'fa', language_confidence: 'medium', duplicate_of: null }), false);
  assert.equal(needsReview({ title: null, artist: 'b', language: 'fa', language_confidence: 'medium' }), true);
  assert.equal(needsReview({ title: 'a', artist: 'b', language: 'en', language_confidence: 'low' }), true);
  assert.equal(needsReview({ title: 'a', artist: 'b', language: 'fa', language_confidence: 'high', duplicate_of: 3 }), true);
});

test('language: priority manual > source > artist > heuristic; the script heuristic', () => {
  assert.deepEqual(classifyLanguage({ manual: 'en', sourceDefault: 'fa', artistHint: 'fa', text: 'سلام' }), { language: 'en', confidence: 'high', source: 'manual' });
  assert.deepEqual(classifyLanguage({ sourceDefault: 'fa', artistHint: 'en', text: 'Hi' }), { language: 'fa', confidence: 'high', source: 'source' });
  assert.deepEqual(classifyLanguage({ artistHint: 'en', text: 'سلام' }), { language: 'en', confidence: 'high', source: 'artist' });
  assert.deepEqual(classifyLanguage({ text: 'دلم تنگه' }), { language: 'fa', confidence: 'medium', source: 'heuristic' });
  assert.deepEqual(heuristicLanguage('پرواز'), { language: 'fa', confidence: 'medium' }, 'Persian letters');
  assert.deepEqual(heuristicLanguage('قلبي'), { language: 'fa', confidence: 'medium' }, 'other Arabic script → fa');
  assert.deepEqual(heuristicLanguage('Blinding Lights'), { language: 'en', confidence: 'low' }, 'Latin only: low (could be Finglish)');
  assert.deepEqual(heuristicLanguage('Ghalbe Man'), { language: 'en', confidence: 'low' });
  assert.deepEqual(heuristicLanguage('دلم تنگه Shadmehr'), { language: 'unknown', confidence: 'low' }, 'mixed');
  assert.deepEqual(heuristicLanguage(''), { language: 'unknown', confidence: 'low' });
  assert.deepEqual(heuristicLanguage('۱۲۳ 456'), { language: 'unknown', confidence: 'low' }, 'digits only');
  assert.equal(scriptClassifier.classify({ text: 'x' }).source, 'heuristic');
});

test('ingest helpers: documents and voice are refused; channel forwards keep their origin', () => {
  assert.equal(mediaRefusal({ audio: {} }), null);
  assert.equal(mediaRefusal({ document: { mime_type: 'audio/mpeg' } }), 'music.err.document');
  assert.equal(mediaRefusal({ voice: {} }), 'music.err.voice');
  assert.equal(mediaRefusal({ video: {} }), 'music.err.not_audio');
  assert.deepEqual(originOf({ forward_origin: { type: 'channel', chat: { id: -1001 }, message_id: 7 } }), { chatId: -1001, messageId: 7 });
  assert.deepEqual(originOf({ forward_origin: { type: 'user', sender_user: { id: 1 } } }), { chatId: null, messageId: null });
  assert.deepEqual(originOf({}), { chatId: null, messageId: null });
});

test('catalog provider: only active tracks are visible; audio is a Telegram file', async () => {
  const rows = { A: { public_id: 'A', status: 'active', title: 'T', artist: 'R', album: null, duration: 5, genre: null, language: 'fa', cover_file_id: 'C' }, B: { public_id: 'B', status: 'removed' } };
  const p = createCatalogProvider({ repo: { getByPublicId: async (id) => rows[id] || null, searchPrefix: async (k, statuses) => (statuses.includes('active') ? [rows.A] : []) }, key });
  assert.deepEqual(p.capabilities, { search: true, metadata: true, cover: true, audio: 'telegram_file' });
  assert.equal((await p.getTrack('A')).public_id, 'A');
  assert.equal(await p.getTrack('B'), null, 'removed tracks are never offered');
  assert.equal(await p.getCover('A'), 'C');
  assert.deepEqual(await p.getMetadata('A'), { title: 'T', artist: 'R', album: null, duration: 5, genre: null, language: 'fa' });
  assert.deepEqual(await p.search('t'), [], 'one-letter queries return nothing');
  assert.equal((await p.search('tt')).length, 1);
});

test('rate window (archive channel ≤ 18 posts a minute) and the archive caption', () => {
  let s = null;
  let allowed = 0;
  for (let i = 0; i < 25; i++) {
    const r = windowAllows(s, 1000, 18, 60);
    s = r.state;
    if (r.allowed) allowed += 1;
  }
  assert.equal(allowed, 18);
  assert.equal(windowAllows(s, 1061, 18, 60).allowed, true, 'a new window');
  assert.equal(archiveCaption({ public_id: 'AbCdEfGh1', title: 'A<b>', artist: 'B&C', album: null }), '#tAbCdEfGh1\n🎵 A&lt;b&gt;\n👤 B&amp;C');
});
