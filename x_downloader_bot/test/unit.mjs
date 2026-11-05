// Unit tests: link parsing, both API parsers on real captured responses, captions, quality choice.
//   node --import ./test/sdk/register.mjs --test test/unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractLinks } from '../tgcloud/lib/links.js';
import { isAllowedMediaUrl, originalPhotoUrl, parseFx, parseVx } from '../tgcloud/lib/x_api.js';
import { chooseVariant, qualityLabel } from '../tgcloud/lib/media.js';
import { buildCaption } from '../tgcloud/lib/deliver.js';
import { parseChannelInput } from '../tgcloud/lib/admin.js';
import { guardUploadText } from '../tgcloud/lib/tg.js';
import { InputFile } from 'sdk';
import { clip, fa, size } from '../tgcloud/lib/text.js';
import { parseCommand } from '../tgcloud/lib/router.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

test('links: every accepted host and path form, query strings ignored', () => {
  const id = '2118034216503955710';
  const forms = [
    `https://x.com/NASA/status/${id}`,
    `https://twitter.com/NASA/status/${id}?s=20&t=abcDEF`,
    `https://mobile.twitter.com/NASA/status/${id}`,
    `https://www.twitter.com/NASA/status/${id}/`,
    `https://fxtwitter.com/NASA/status/${id}`,
    `https://fixupx.com/NASA/status/${id}/video/1`,
    `https://vxtwitter.com/NASA/status/${id}?lang=fa`,
    `https://fixvx.com/NASA/status/${id}#m`,
    `https://d.fxtwitter.com/NASA/status/${id}`,
    `x.com/NASA/status/${id}`,
    `https://x.com/i/status/${id}`,
    `https://x.com/i/web/status/${id}`,
    `https://twitter.com/NASA/statuses/${id}`,
    `https://X.COM/NASA/status/${id}?utm_source=share&ref_src=twsrc`,
  ];
  for (const f of forms) {
    const links = extractLinks(`look: ${f} nice`);
    assert.equal(links.length, 1, f);
    assert.equal(links[0].id, id, f);
  }
  assert.equal(extractLinks(`https://x.com/NASA/status/${id}`)[0].username, 'NASA');
  assert.equal(extractLinks(`https://x.com/i/status/${id}`)[0].username, null);
});

test('links: rejects look-alikes, keeps order, dedupes, reads hidden links', () => {
  assert.equal(extractLinks('https://notx.com/a/status/123').length, 0);
  assert.equal(extractLinks('https://x.co/a/status/123').length, 0);
  assert.equal(extractLinks('https://x.com/NASA').length, 0);
  assert.equal(extractLinks('https://x.com/a/status/123456789012345678901').length, 0, '21 digits is no status id');
  const many = extractLinks('https://x.com/a/status/3 https://x.com/b/status/1 https://twitter.com/a/status/3 x.com/c/status/2');
  assert.deepEqual(many.map((l) => l.id), ['3', '1', '2']);
  const hidden = extractLinks('click here', [{ type: 'text_link', offset: 0, length: 10, url: 'https://twitter.com/jack/status/20' }]);
  assert.deepEqual(hidden.map((l) => l.id), ['20']);
  assert.equal(typeof many[0].id, 'string');
});

test('parseFx: real video post -> mp4 variants best first, no HLS', () => {
  const r = parseFx(200, fixture('fx_video.json'));
  assert.equal(r.kind, 'ok');
  const v = r.post.media[0];
  assert.equal(v.type, 'video');
  assert.equal(r.post.id, '2118034216503955710');
  assert.equal(r.post.author, 'NASA');
  assert.deepEqual(v.variants.map((x) => x.key), ['1080x1920', '720x1280', '480x852', '320x568']);
  assert.ok(v.variants.every((x) => x.url.includes('.mp4')));
  assert.equal(qualityLabel(v.variants[1]), '720p');
  assert.equal(v.duration, 41);
});

test('parseFx: photos (orig), GIF, text-only, two videos, 404', () => {
  const photos = parseFx(200, fixture('fx_photos.json')).post;
  assert.equal(photos.media.length, 3);
  assert.ok(photos.media.every((m) => m.type === 'photo' && m.url.endsWith('?name=orig')));
  const gif = parseFx(200, fixture('fx_gif.json')).post;
  assert.equal(gif.media[0].type, 'gif');
  assert.equal(gif.media[0].variants.length, 1);
  const text = parseFx(200, fixture('fx_text.json'));
  assert.equal(text.kind, 'ok');
  assert.equal(text.post.media.length, 0);
  const two = parseFx(200, fixture('fx_twovid.json')).post;
  assert.equal(two.media.length, 2);
  assert.equal(two.media[0].variants[0].key, '3840x2160');
  assert.equal(parseFx(404, fixture('fx_missing.json')).kind, 'not_found');
  assert.equal(parseFx(200, '<!DOCTYPE html><html></html>').kind, 'temporary');
  assert.equal(parseFx(401, '{"code":401,"message":"PRIVATE_TWEET","tweet":null}').kind, 'private');
});

test('parseVx: real answers, HTML = could not read', () => {
  const v = parseVx(200, fixture('vx_video.body')).post;
  assert.equal(v.source, 'vx');
  assert.equal(v.media[0].variants.length, 1);
  assert.equal(v.media[0].variants[0].key, '1080x1920');
  const p = parseVx(200, fixture('vx_photos.body')).post;
  assert.ok(p.media.every((m) => m.type === 'photo' && m.url.endsWith('.jpg?name=orig')));
  assert.equal(parseVx(200, fixture('vx_gif.body')).post.media[0].type, 'gif');
  assert.equal(parseVx(200, fixture('vx_text.body')).post.media.length, 0);
  assert.equal(parseVx(200, fixture('vx_missing.body')).kind, 'not_found');
  assert.equal(parseVx(503, '<html>down</html>').kind, 'temporary');
});

test('SSRF guard: only https twimg hosts', () => {
  assert.ok(isAllowedMediaUrl('https://video.twimg.com/a.mp4'));
  assert.ok(isAllowedMediaUrl('https://pbs.twimg.com/media/x.jpg?name=orig'));
  for (const bad of ['http://video.twimg.com/a.mp4', 'https://video.twimg.com.evil.com/a.mp4', 'https://evil.com/video.twimg.com/a.mp4',
    'https://user@video.twimg.com/a.mp4', 'https://mosaic.fxtwitter.com/jpeg/1/a', 'https://127.0.0.1/a.mp4', 'https://twimg.com/a', 'javascript:alert(1)']) {
    assert.equal(isAllowedMediaUrl(bad), false, bad);
  }
  const evil = JSON.parse(fixture('fx_video.json'));
  for (const v of evil.tweet.media.all[0].variants) v.url = v.url.replace('video.twimg.com', 'evil.example.com');
  for (const v of evil.tweet.media.all[0].formats) v.url = v.url.replace('video.twimg.com', 'evil.example.com');
  evil.tweet.media.all[0].url = 'https://evil.example.com/x.mp4';
  const r = parseFx(200, JSON.stringify(evil));
  assert.equal(r.post.media.length, 0);
  assert.equal(r.post.blocked, 1);
});

test('originalPhotoUrl', () => {
  assert.equal(originalPhotoUrl('https://pbs.twimg.com/media/HVFva4RXsAEO1pW.jpg'), 'https://pbs.twimg.com/media/HVFva4RXsAEO1pW.jpg?name=orig');
  assert.equal(originalPhotoUrl('https://pbs.twimg.com/media/ABC?format=png&name=small'), 'https://pbs.twimg.com/media/ABC.png?name=orig');
  assert.equal(originalPhotoUrl('https://pbs.twimg.com/media/ABC.jpg?name=orig'), 'https://pbs.twimg.com/media/ABC.jpg?name=orig');
});

test('chooseVariant: auto / best / low with fallback, too big', async () => {
  const MB = 1024 * 1024;
  const item = () => ({
    variants: [
      { key: '3840x2160', w: 3840, h: 2160, size: 143 * MB },
      { key: '1920x1080', w: 1920, h: 1080, size: 41 * MB },
      { key: '1280x720', w: 1280, h: 720, size: 10 * MB },
      { key: '640x360', w: 640, h: 360, size: 3 * MB },
    ],
  });
  assert.equal((await chooseVariant(item(), 'best', 49 * MB)).variant.key, '1920x1080');
  assert.equal((await chooseVariant(item(), 'auto', 49 * MB)).variant.key, '1280x720');
  assert.equal((await chooseVariant(item(), 'low', 49 * MB)).variant.key, '640x360');
  assert.equal((await chooseVariant(item(), 'best', 5 * MB)).variant.key, '640x360');
  const big = await chooseVariant(item(), 'best', 2 * MB);
  assert.equal(big.tooBig, true);
  assert.equal(big.smallest.key, '640x360');
});

test('caption: options, 1024 limit, surrogate-safe cut', () => {
  const post = { id: '2118034216503955710', author: 'NASA', text: 'Hello <world> & more' };
  const all = { capText: true, capAuthor: true, capLink: true };
  assert.equal(buildCaption(all, post), 'Hello &lt;world&gt; &amp; more\n\n👤 @NASA\n🔗 https://x.com/NASA/status/2118034216503955710');
  assert.equal(buildCaption({ capText: false, capAuthor: true, capLink: false }, post), '👤 @NASA');
  assert.equal(buildCaption({ capText: false, capAuthor: false, capLink: false }, post), null);
  const long = { ...post, text: '😀'.repeat(2000) };
  const c = buildCaption(all, long);
  const visible = c.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.ok(visible.length <= 1024, `caption is ${visible.length} units`);
  assert.ok(visible.includes('🔗 https://x.com/NASA/status/'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(visible), 'no lone surrogate');
  assert.equal(clip('abcdef', 4), 'abc…');
});

test('channel input and commands', () => {
  assert.deepEqual(parseChannelInput('@HIDE_i_SEEK'), { username: 'HIDE_i_SEEK' });
  assert.deepEqual(parseChannelInput('https://t.me/Nepenthw_ir'), { username: 'Nepenthw_ir' });
  assert.deepEqual(parseChannelInput('t.me/s/wangerBots'), { username: 'wangerBots' });
  assert.deepEqual(parseChannelInput('https://t.me/+abcDEF'), { error: 'private' });
  assert.deepEqual(parseChannelInput('hello world'), { error: 'invalid' });
  assert.deepEqual(parseCommand('/start@x_bot payload'), { name: 'start', arg: 'payload' });
  assert.equal(parseCommand('hello'), null);
  assert.equal(fa(30), '۳۰');
  assert.equal(size(4977071), '۴٫۷ مگابایت');
});

test('upload text starting with "@" gets an invisible word joiner (platform crash otherwise)', () => {
  const file = new InputFile(new Uint8Array([1, 2, 3]), 'a.mp4');
  const out = guardUploadText({ chat_id: 1, animation: file, caption: '@GIPHY hi', parse_mode: 'HTML' });
  assert.equal(out.caption, '\u2060@GIPHY hi');
  assert.equal(out.animation, file);
  assert.equal(guardUploadText({ chat_id: 1, text: '@x' }).text, '@x', 'JSON requests are untouched');
  assert.equal(guardUploadText({ chat_id: 1, video: 'file_id', caption: '@x' }).caption, '@x', 'file_id sends are untouched');
  const album = guardUploadText({ chat_id: 1, media: [{ type: 'photo', media: file, caption: '@a' }] });
  assert.equal(album.media[0].caption, '\u2060@a');
});
