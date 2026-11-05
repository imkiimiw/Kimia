// Phase 3 pure modules: index terms, query parsing, captions, the inline answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termsForTrack, parseQuery, artistKeys } from '../../tgcloud/lib/search/terms.js';
import { renderCaption, captionValues, unknownVariables, artistTag, DEFAULT_TEMPLATE } from '../../tgcloud/lib/publishing/captions.js';
import { inlineAnswer } from '../../tgcloud/lib/bot/search_ui.js';

const ZWNJ = '‌';

test('terms: tokens, neighbour pairs, the whole field without spaces, featured artists and aliases', () => {
  const terms = termsForTrack({ title: `من می${ZWNJ}خوام برم`, artist: 'شادمهر عقیلی', album: null, featured_artists: 'Ebi, Sasy' }, ['shadmehr']);
  for (const t of ['من', 'می', 'خوام', 'برم', 'میخوام', 'منمیخوامبرم', 'شادمهر', 'عقیلی', 'شادمهرعقیلی', 'ebi', 'sasy', 'shadmehr']) assert.ok(terms.includes(t), t);
  assert.ok(termsForTrack({ title: 'Blinding Lights', artist: 'The Weeknd' }).includes('weeknd'));
  assert.equal(new Set(terms).size, terms.length, 'no duplicates');
  assert.deepEqual(termsForTrack({ title: null, artist: null }), []);
  assert.deepEqual(artistKeys({ artist: 'A', featured_artists: 'B, a' }).map((x) => x.key), ['a', 'b']);
});

test('query: ≤ 64 characters, ≤ 5 tokens, normalized like the index', () => {
  assert.deepEqual(parseQuery('  The   WEEK  ').tokens, ['the', 'week']);
  assert.deepEqual(parseQuery(`مي${ZWNJ}خوام`).tokens, ['می', 'خوام']);
  assert.deepEqual(parseQuery('علي ۲').tokens, ['علی', '2']);
  assert.equal(parseQuery('x'.repeat(100)).text.length, 64);
  assert.deepEqual(parseQuery('a b c d e f g h').tokens, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(parseQuery('love love you').tokens, ['love', 'you'], 'repeated tokens once');
  assert.deepEqual(parseQuery('🎵!!').tokens, []);
});

test('captions: escaping, empty lines dropped, 1024 limit, variables', () => {
  const v = captionValues({ public_id: 'AbCdEfGh1', title: 'A <b> & B', artist: `شادمهر عقیلی`, album: null, duration: 187 }, { botUsername: 'Wange_Musicbot' });
  assert.equal(renderCaption(DEFAULT_TEMPLATE, v), '🎵 A &lt;b&gt; &amp; B\n👤 شادمهر عقیلی\n⏱ 3:07', 'album line dropped');
  assert.equal(renderCaption('{artist_tag} · <a href="{bot_link}">▶️</a>', v), '#شادمهر_عقیلی · <a href="https://t.me/Wange_Musicbot?start=t_AbCdEfGh1">▶️</a>');
  assert.equal(artistTag(`می${ZWNJ}خوام & co.`), '#میخوام_co', 'ZWNJ and punctuation removed');
  const long = renderCaption('{title}\n{album}', { ...v, title: 'T'.repeat(2000), album: 'A'.repeat(2000) });
  assert.ok(long.length <= 1024, `${long.length}`);
  assert.ok(long.includes('…'));
  assert.deepEqual(unknownVariables('{title} {nope} {x}'), ['nope', 'x']);
  assert.deepEqual(unknownVariables(DEFAULT_TEMPLATE), []);
});

test('inline answer: cached audio results, personal, pagination offset, the no-results button', () => {
  const tracks = Array.from({ length: 3 }, (_, i) => ({ public_id: `Pid0000${i}x`, audio_file_id: `F${i}`, title: 'T', artist: 'A' }));
  const q = { text: 'x', tokens: ['x'], full: 'x' };
  let a = inlineAnswer('q1', { q, tracks, more: true, offset: 20 }, { lang: 'fa', cacheTime: 60, caption: '' });
  assert.deepEqual(a.results[0], { type: 'audio', id: 'Pid00000x', audio_file_id: 'F0' });
  assert.deepEqual([a.is_personal, a.cache_time, a.next_offset, a.button], [true, 60, '23', undefined]);
  a = inlineAnswer('q1', { q, tracks: [], more: false, offset: 0 }, { lang: 'fa', cacheTime: 60, caption: '' });
  assert.deepEqual(a.button, { text: '🔎 جستجو در ربات', start_parameter: 'search' });
  assert.equal(a.next_offset, '');
  a = inlineAnswer('q1', { q: { text: '', tokens: [], full: '' }, tracks: [], more: false, offset: 0 }, { lang: 'fa', cacheTime: 60, caption: '' });
  assert.equal(a.button, undefined, 'an empty catalog with an empty query shows no button');
  a = inlineAnswer('q1', { q, tracks, more: false, offset: 0 }, { lang: 'en', cacheTime: 5, caption: '🎵 {title}\n💿 {album}' });
  assert.deepEqual([a.results[0].caption, a.results[0].parse_mode], ['🎵 T', 'HTML']);
});
