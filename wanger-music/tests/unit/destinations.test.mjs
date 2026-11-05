// Phase 5 pure parts: destination rules, active hours, the bot's rights.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRules, toggleIn, matches, parseHours, withinHours, hoursOf, confidenceAtLeast } from '../../tgcloud/lib/publishing/rules.js';
import { rightsOf } from '../../tgcloud/lib/publishing/destinations.js';

const track = (extra = {}) => ({ status: 'active', language: 'fa', language_confidence: 'medium', genre: 'pop', ...extra });
const channel = (rules, extra = {}) => ({ rules: JSON.stringify(rules), approval_required: 0, ...extra });

test('rules: stored JSON is cleaned; genre and excluded genre lists exclude each other', () => {
  assert.deepEqual(normalizeRules('not json'), { languages: [], genres: [], exclude_genres: [], min_language_confidence: 'medium' });
  assert.deepEqual(normalizeRules({ languages: ['fa', 'xx', 'fa'], genres: ['pop', 'nope'], min_language_confidence: 'huge' }), { languages: ['fa'], genres: ['pop'], exclude_genres: [], min_language_confidence: 'medium' });
  let r = toggleIn({}, 'languages', 'en');
  assert.deepEqual(r.languages, ['en']);
  r = toggleIn(r, 'languages', 'en');
  assert.deepEqual(r.languages, []);
  r = toggleIn({ genres: ['rock'] }, 'exclude_genres', 'rock');
  assert.deepEqual([r.genres, r.exclude_genres], [[], ['rock']]);
  assert.equal(confidenceAtLeast('high', 'medium'), true);
  assert.equal(confidenceAtLeast('low', 'medium'), false);
});

test('matching: language list, genres, excluded genres, confidence → approval', () => {
  const fa = channel({ languages: ['fa'], min_language_confidence: 'medium' });
  assert.deepEqual(matches(track(), fa), { match: true, needsApproval: false, reason: null });
  assert.equal(matches(track({ language: 'en' }), fa).match, false, 'wrong language never matches');
  assert.equal(matches(track({ language: 'unknown' }), fa).match, false);
  assert.equal(matches(track(), channel({ languages: [] })).match, false, 'no language selected = nothing');
  assert.equal(matches(track({ status: 'draft' }), fa).match, false);
  assert.equal(matches(track({ genre: 'rock' }), channel({ languages: ['fa'], genres: ['pop'] })).match, false);
  assert.equal(matches(track({ genre: null }), channel({ languages: ['fa'], genres: ['pop'] })).match, false, 'a genre list needs a genre');
  assert.equal(matches(track({ genre: 'rap' }), channel({ languages: ['fa'], exclude_genres: ['rap'] })).match, false);
  assert.deepEqual(matches(track({ language_confidence: 'low' }), fa), { match: true, needsApproval: true, reason: 'low_confidence' });
  assert.equal(matches(track(), channel({ languages: ['fa'] }, { approval_required: 1 })).needsApproval, true);
});

test('active hours: parsing (Persian digits too), wrap past midnight, storage', () => {
  assert.deepEqual(parseHours('9-23'), { from: 9, to: 23 });
  assert.deepEqual(parseHours('۹-۲۳'), { from: 9, to: 23 });
  assert.deepEqual(parseHours('9 تا 23'), { from: 9, to: 23 });
  assert.deepEqual(parseHours('22-2'), { from: 22, to: 2 });
  assert.equal(parseHours('all'), null);
  assert.equal(parseHours('همه'), null);
  for (const bad of ['25-3', '9-9', 'abc', '9', '']) assert.equal(parseHours(bad), undefined, bad);
  assert.equal(withinHours({ from: 9, to: 23 }, 9), true);
  assert.equal(withinHours({ from: 9, to: 23 }, 23), false);
  assert.equal(withinHours({ from: 22, to: 2 }, 1), true);
  assert.equal(withinHours({ from: 22, to: 2 }, 12), false);
  assert.equal(withinHours(null, 3), true);
  assert.deepEqual(hoursOf('{"from":9,"to":23}'), { from: 9, to: 23 });
  assert.equal(hoursOf('garbage'), null);
});

test('the bot’s rights from getChatMember', () => {
  assert.deepEqual(rightsOf({ status: 'administrator', can_post_messages: true, can_edit_messages: false, can_delete_messages: true }, { type: 'channel' }, 5),
    { admin: true, post: true, edit: false, delete: true, checked_at: 5, error: null, type: 'channel' });
  assert.equal(rightsOf({ status: 'creator' }, null, 1).post, true);
  assert.equal(rightsOf({ status: 'left' }, null, 1).post, false);
  assert.equal(rightsOf(null, null, 1, 'not_found').error, 'not_found');
});
