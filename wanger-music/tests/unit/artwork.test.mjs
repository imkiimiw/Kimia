// music/artwork.js: the full cover picture inside an audio file (Telegram keeps only a ≤ 320 px
// thumbnail; production files carried 622–3000 px covers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCover, readCover, imageInfo, READ_CAP } from '../../tgcloud/lib/music/artwork.js';
import { jpeg, png, mp3WithCover, mp3Audio, flacWithCover, m4aWithCover, chunked } from '../helpers/audio-files.mjs';

const read = (bytes, size) => readCover(chunked(bytes, size).body);

test('image size: JPEG frame header, PNG IHDR; anything else is not an image', () => {
  assert.deepEqual(imageInfo(jpeg(1000, 800)), { mime: 'image/jpeg', width: 1000, height: 800 });
  assert.deepEqual(imageInfo(png(622, 616)), { mime: 'image/png', width: 622, height: 616 });
  assert.equal(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(imageInfo(new Uint8Array(100)), null);
});

test('MP3 / ID3v2.3: the front cover (type 3) wins over another picture; the bytes are exactly the picture', async () => {
  const front = jpeg(1000, 1000, 5000);
  const file = mp3WithCover([{ type: 0, bytes: jpeg(600, 600) }, { type: 3, bytes: front, desc: 'front' }]);
  const pic = await read(file);
  assert.equal(pic.mime, 'image/jpeg');
  assert.deepEqual([pic.width, pic.height], [1000, 1000]);
  assert.deepEqual(pic.bytes, front);
});

test('MP3 / ID3v2.4 (syncsafe frame sizes, UTF-16 description) and ID3v2.2 (PIC)', async () => {
  const big = png(3000, 3000, 9000);
  assert.deepEqual((await read(mp3WithCover([{ bytes: big, utf16: true }], { version: 4 }))).bytes, big);
  const v22 = jpeg(700, 700);
  assert.deepEqual((await read(mp3WithCover([{ bytes: v22 }], { version: 2 }))).bytes, v22);
});

test('only the tag is read, not the audio after it', async () => {
  const file = mp3WithCover([{ bytes: jpeg(1000, 1000, 3000) }], { audio: 2_000_000 });
  const s = chunked(file, 4096);
  assert.ok(await readCover(s.body));
  assert.ok(s.stats.read < 10_000, `read ${s.stats.read} bytes of ${file.length}`);
});

test('nothing worth using: no picture, a picture no bigger than the thumbnail, not an image, no tag, a tag past the cap', async () => {
  assert.equal(await read(mp3WithCover([])), null);
  assert.equal(await read(mp3WithCover([{ bytes: jpeg(320, 320) }])), null, 'Telegram\'s thumbnail is already 320 px');
  assert.equal(await read(mp3WithCover([{ bytes: new Uint8Array(3000).fill(7) }])), null);
  assert.equal(await read(mp3Audio(50000)), null);
  const huge = mp3WithCover([{ bytes: jpeg(1000, 1000) }], { padding: 200_000, audio: 10 });
  assert.equal(await readCover(chunked(huge).body, 100_000), null, 'never reads past the cap');
  assert.ok(READ_CAP >= 10 * 1024 * 1024);
});

test('FLAC PICTURE block; M4A covr with moov first; M4A with the audio first is not read through', async () => {
  const cover = jpeg(1200, 1200);
  assert.deepEqual((await read(flacWithCover(cover))).bytes, cover);
  assert.deepEqual((await read(m4aWithCover(cover))).bytes, cover);
  assert.equal(await read(m4aWithCover(cover, { moovFirst: false })), null);
});

test('scanCover asks for more bytes until it can decide', () => {
  const file = mp3WithCover([{ bytes: jpeg(1000, 1000) }]);
  assert.deepEqual(scanCover(file.subarray(0, 5)), { need: 12 });
  const r = scanCover(file.subarray(0, 20));
  assert.ok('need' in r && r.need > 20 && r.need < file.length);
  assert.ok('picture' in scanCover(file.subarray(0, r.need)));
});
