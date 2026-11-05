// Phase 9 without Telegram: zlib against Node's own, every JPEG and PNG kind against the original
// picture, the encoders read back, QR codes made and read (also after JPEG and rotation), the PDF
// check on crafted PDFs, the fun features' rules, and the words that work as commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { toJalali } from '../../tgcloud/lib/core/clock.js';
import { adler32, base64, checkPdf, crc32, deflate, inflate } from '../../tgcloud/lib/core/files.js';
import * as img from '../../tgcloud/lib/core/image.js';
import * as fun from '../../tgcloud/lib/engines/fun.js';
import { parseCommand as funCommand } from '../../tgcloud/lib/ui/fun.js';
import { applyOp, parseCommand as mediaCommand, photoSize, stickerPng } from '../../tgcloud/lib/ui/media.js';

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(FX, f)));
const psnr = (a, b) => {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c += 1) {
    se += (a.data[i + c] - b.data[i + c]) ** 2;
    n += 1;
  }
  return se ? 10 * Math.log10((255 * 255) / (se / n)) : Infinity;
};

test('zlib: our deflate is read by Node, Node\'s by our inflate; checksums and base64', () => {
  const rnd = (n, k) => {
    const a = new Uint8Array(n);
    let x = 7;
    for (let i = 0; i < n; i += 1) {
      x = (x * 1103515245 + 12345) >>> 0;
      a[i] = (x >>> 24) % k;
    }
    return a;
  };
  for (const data of [new Uint8Array(0), new Uint8Array([1]), rnd(5000, 3), rnd(70000, 200), new TextEncoder().encode('aegis '.repeat(3000))]) {
    const ours = deflate(data);
    assert.deepEqual(new Uint8Array(zlib.inflateSync(Buffer.from(ours))), data);
    assert.deepEqual(inflate(new Uint8Array(zlib.deflateSync(Buffer.from(data)))), data);
    assert.deepEqual(inflate(ours), data);
  }
  assert.ok(deflate(new Uint8Array(100000)).length < 300, 'zeros compress');
  assert.throws(() => inflate(new Uint8Array(zlib.deflateSync(Buffer.alloc(10000))), { max: 1000 }), { message: /too large/ }, 'a zip bomb stops at the limit');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11E60398);
  assert.equal(base64(new TextEncoder().encode('Ma')), 'TWE=');
});

test('images: every JPEG kind (baseline, progressive, gray, CMYK, restarts) and PNG kind decodes close to the original', () => {
  const ref = img.decodeImage(read('ref.png'));
  assert.equal(ref.w, 96);
  assert.equal(ref.h, 72);
  for (const f of ['base420.jpg', 'prog.jpg', 'restart.jpg', 'cmyk.jpg']) assert.ok(psnr(img.decodeImage(read(f)), ref) > 30, f);
  const gray = img.decodeImage(read('gray.jpg'));
  assert.ok(gray.data[0] === gray.data[1] && gray.data[1] === gray.data[2]);
  assert.equal(psnr(img.decodeImage(read('interlaced.png')), ref), Infinity);
  assert.equal(psnr(img.decodeImage(read('rgb16.png')), ref), Infinity);
  assert.ok(psnr(img.decodeImage(read('pal16.png')), ref) > 20);
  const alpha = img.decodeImage(read('alpha.png'));
  assert.ok(alpha.data[3] < 10 && alpha.data[alpha.data.length - 1] > 245, 'transparency kept');
  assert.throws(() => img.decodeImage(new Uint8Array([1, 2, 3])), /unsupported/);
  assert.throws(() => img.decodeImage(read('base420.jpg'), { maxPixels: 100 }), /too large/);
});

test('encoders: JPEG, PNG (truecolor and indexed) and GIF read back', () => {
  const ref = img.decodeImage(read('ref.png'));
  assert.ok(psnr(img.decodeImage(img.encodeJpeg(ref, 90)), ref) > 30);
  assert.equal(psnr(img.decodeImage(img.encodePng(ref)), ref), Infinity);
  const q = img.quantize(ref, 64, { dither: true });
  assert.ok(q.palette.length <= 64);
  assert.ok(psnr(img.decodeImage(img.encodePng(ref, q)), ref) > 25);
  const gif = img.encodeGif([{ img: ref, delay: 50 }, { img: img.invert(ref), delay: 50 }]);
  assert.equal(String.fromCharCode(...gif.subarray(0, 6)), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3B);
  assert.equal(gif.filter((b, i) => b === 0x2C && gif[i - 1] === 0).length >= 2, true, 'two image descriptors');
});

test('image tools keep sizes right; a sticker is 512 px on its longer side and under 512 KB', () => {
  const ref = img.decodeImage(read('ref.png'));
  const r = applyOp('r9', ref);
  assert.deepEqual([r.w, r.h], [72, 96]);
  assert.deepEqual([applyOp('hf', ref).w, applyOp('sq', ref).h], [48, 96]);
  const c = applyOp('ci', ref);
  assert.equal(c.w, c.h);
  assert.equal(c.data[3], 0, 'the corner is transparent');
  for (const op of ['g', 'sp', 'iv', 'bl', 'px', 'mi', 'fl']) assert.deepEqual([applyOp(op, ref).w, applyOp(op, ref).h], [96, 72], op);
  const st = stickerPng(ref);
  const back = img.decodeImage(st);
  assert.equal(Math.max(back.w, back.h), 512);
  assert.ok(st.length <= 512 * 1024);
  assert.equal(photoSize([{ file_id: 'a', width: 90, height: 60 }, { file_id: 'b', width: 320, height: 213 }, { file_id: 'c', width: 1280, height: 853 },
    { file_id: 'd', width: 2560, height: 1706 }], 800).file_id, 'c', 'the smallest size big enough, never above 1280');
});

test('QR codes: made and read back at every level, after JPEG compression, rotated, and with the error correction at work', () => {
  for (const [text, lv] of [['https://t.me/aegis', 'L'], ['سلام — Aegis ✅', 'M'], ['x'.repeat(200), 'Q'], ['12345', 'H']]) {
    const code = img.qr.encode(text, lv);
    assert.equal(img.qr.decode(img.qr.render(code, 4, 4)), text, lv);
    const photo = img.decodeImage(img.encodeJpeg(img.rotate(img.qr.render(code, 5, 4), 90), 70));
    assert.equal(img.qr.decode(photo), text, `${lv} jpeg`);
  }
  const code = img.qr.encode('error correction', 'H');
  const damaged = img.qr.render(code, 4, 4);
  for (let y = 60; y < 80; y += 1) for (let x = 60; x < 80; x += 1) damaged.data.set([255, 255, 255, 255], (y * damaged.w + x) * 4);
  assert.equal(img.qr.decode(damaged), 'error correction', 'a white patch is corrected');
  assert.equal(img.qr.decode(img.decodeImage(read('ref.png'))), null, 'no code: null');
  const cw = Uint8Array.from([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17, 196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  const broken = cw.slice();
  broken[3] ^= 0x55;
  broken[20] ^= 0x01;
  assert.ok(img.qr.correct(broken, 10));
  assert.deepEqual(broken, cw);
});

test('the PDF check: JavaScript with an automatic action, hidden names, compressed object streams, embedded files, links', () => {
  const v = (f) => checkPdf(read(f));
  assert.equal(v('clean.pdf').verdict, 'clean');
  assert.equal(v('clean.pdf').pages, 1);
  assert.deepEqual(v('js.pdf').reasons.sort(), ['autoaction', 'javascript']);
  assert.equal(v('js.pdf').verdict, 'danger');
  assert.ok(v('hidden.pdf').reasons.includes('obfuscated') && v('hidden.pdf').reasons.includes('javascript'));
  assert.ok(v('objstm.pdf').reasons.includes('launch'), 'found inside a FlateDecode object stream');
  assert.equal(v('links.pdf').verdict, 'caution');
  assert.deepEqual(v('links.pdf').uris, ['https://evil.example/login']);
  assert.equal(checkPdf(read('ref.png')).pdf, false);
});

test('fun rules: settings, stable picks, sums, scrambles, the anti-paste marks, duels, birthdays, the Persian calendar', () => {
  assert.equal(fun.FEATURES.length, 30);
  assert.equal(new Set(fun.CODES).size, 30);
  assert.ok(fun.FEATURES.every((f) => fun.validConf(f.def)), 'every default is valid');
  assert.ok(!fun.validConf('1,a,7,20,0') && !fun.validConf('1,x,10,20,0') && !fun.validConf('1,a,10,20'));
  const c = fun.conf({ fx_dice: '0,d,60,5,2' }, 'dice');
  assert.deepEqual(c, { on: false, who: 'd', cd: 60, daily: 5, reward: 2 });
  assert.equal(fun.encodeConf(c), '0,d,60,5,2');
  assert.equal(fun.conf({}, 'guess').reward, 5, 'defaults when unset');
  assert.equal(fun.hash('a:b:1'), fun.hash('a:b:1'));
  assert.notEqual(fun.hash('a:b:1'), fun.hash('a:b:2'));
  let seed = 1;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 50; i += 1) {
    const q = fun.mathQuestion(rnd, 2);
    const expr = q.text.replace('×', '*').replace('÷', '/').replace('−', '-');
    assert.equal(Function(`return ${expr}`)(), q.answer, q.text);
  }
  for (const w of ['planet', 'ستاره', '一心一意']) {
    const s = fun.scramble(w, rnd);
    assert.notEqual(s, w);
    assert.deepEqual([...s].sort(), [...w].sort());
  }
  const m = fun.marked('The quick brown fox');
  assert.ok(fun.pasted(m));
  assert.ok(!fun.pasted('The quick brown fox'));
  assert.equal(m.replace(new RegExp(fun.PASTE_MARK, 'g'), ''), 'The quick brown fox');
  assert.equal(fun.rpsWinner('r', 's'), 1);
  assert.equal(fun.rpsWinner('r', 'p'), -1);
  assert.equal(fun.rpsWinner('s', 's'), 0);
  assert.equal(fun.tttWinner(['x', 'x', 'x', '', 'o', 'o', '', '', '']), 'x');
  assert.equal(fun.tttWinner(['o', 'x', '', 'x', 'o', '', '', '', 'o']), 'o');
  assert.equal(fun.tttWinner(['x', 'o', 'x', 'x', 'o', 'o', 'o', 'x', 'x']), 'draw');
  assert.equal(fun.tttWinner(['x', '', '', '', '', '', '', '', '']), null);
  assert.deepEqual(fun.parseBirthday('03-21', 'g'), { month: 3, day: 21 });
  assert.equal(fun.parseBirthday('02-30', 'g'), null);
  assert.deepEqual(fun.parseBirthday('12/30', 'j'), { month: 12, day: 30 });
  assert.equal(fun.parseBirthday('07-31', 'j'), null, 'the second half of the Persian year has 30-day months');
  assert.deepEqual(toJalali(2026, 3, 21), [1405, 1, 1]);
  assert.deepEqual(toJalali(2026, 10, 31), [1405, 8, 9]);
});

test('fun and media words work only as the whole message (or with valid arguments); slash commands always', () => {
  assert.equal(funCommand('/dice').code, 'dice');
  assert.equal(funCommand('/hug@AegisBot').sub, 'hug');
  assert.equal(funCommand('/hug@AegisBot').mention, 'aegisbot');
  assert.equal(funCommand('تاس').code, 'dice');
  assert.equal(funCommand('Trivia').code, 'trivia');
  assert.equal(funCommand('dice is fun'), null, 'a sentence is just chat');
  assert.deepEqual(funCommand('choose tea, coffee').args, ['tea,', 'coffee']);
  assert.equal(funCommand('تولد 03-21').code, 'bday');
  assert.equal(funCommand('/nope'), null);
  assert.equal(mediaCommand('/sticker').op, 'st');
  assert.equal(mediaCommand('/qr hello world').args, 'hello world');
  assert.equal(mediaCommand('کیوآر سلام').args, 'سلام');
  assert.equal(mediaCommand('make sticker please'), null);
});
