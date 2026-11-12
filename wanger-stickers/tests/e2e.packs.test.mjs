// Phase 1 acceptance: "packs can be created, edited and shared" — Telegram pack management by
// file_id, checked against a fake Bot API that enforces the sticker-set rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER } from './helpers/harness.mjs';

const U = 710001;
const V = 710002;

async function newPack(h, id, title = 'گربه‌های من') {
  await h.sendSticker(id, h.tg.sticker());
  await h.tap(id, 'st:new');
  await h.send(id, title);
  return h.one('SELECT * FROM packs WHERE tg_id = ? ORDER BY id DESC LIMIT 1', id);
}

test('a sticker → a new pack: valid name, title, link; the mirror matches Telegram', async () => {
  const h = setup();
  await h.ready(U);
  const pack = await newPack(h, U);
  assert.ok(pack, 'pack row');
  assert.match(pack.tg_name, /^ws_[0-9a-z]+_1_by_Wanger_Motionbot$/);
  assert.equal(pack.title, 'گربه‌های من');
  assert.equal(pack.sticker_count, 1);
  const set = h.tg.sets.get(pack.tg_name.toLowerCase());
  assert.equal(set.owner, U);
  assert.ok(h.texts(U).some((t) => t.includes(`https://t.me/addstickers/${pack.tg_name}`)));
  assert.equal(h.one('SELECT count(*) AS n FROM pack_items WHERE pack_id = ?', pack.id).n, 1);
  assert.equal(h.one('SELECT count FROM usage_daily WHERE tg_id = ? AND feature = ?', U, 'pack_create').count, 1);
});

test('add stickers, browse, emojis, keywords, reorder, delete, rename, thumbnail, export, share', async () => {
  const h = setup();
  await h.ready(U);
  const pack = await newPack(h, U, 'Pack A');
  for (let i = 0; i < 3; i++) {
    await h.sendSticker(U, h.tg.sticker({ emoji: '🎉' }));
    await h.tap(U, `st:add:${pack.id}`);
  }
  const set = () => h.tg.sets.get(pack.tg_name.toLowerCase());
  assert.equal(set().stickers.length, 4);
  assert.equal(h.one('SELECT sticker_count FROM packs WHERE id = ?', pack.id).sticker_count, 4);

  // browse: the first sticker is sent with its buttons
  await h.press(U, `pk:open:${pack.id}`);
  await h.tap(U, `pk:it:${pack.id}:0`);
  const shown = h.tg.callsOf('sendSticker', U).at(-1);
  assert.equal(shown.params.sticker, set().stickers[0].file_id);
  const second = set().stickers[1];

  // emojis
  await h.press(U, `pk:emo:${pack.id}:${second.file_unique_id}`);
  await h.send(U, '😺 😹 hello');
  assert.deepEqual(set().stickers[1].emoji_list, ['😺', '😹']);
  // keywords (0–20, ≤ 64 chars total)
  await h.press(U, `pk:kw:${pack.id}:${second.file_unique_id}`);
  await h.send(U, 'گربه, cat');
  assert.deepEqual(set().stickers[1].keywords, ['گربه', 'cat']);
  await h.press(U, `pk:kw:${pack.id}:${second.file_unique_id}`);
  const mark = h.mark();
  await h.send(U, 'x'.repeat(70));
  assert.equal(h.tg.callsOf('setStickerKeywords', undefined, mark).length, 0, 'over 64 characters must be refused locally');
  await h.send(U, '/cancel');

  // reorder: move the second sticker up
  await h.press(U, `pk:up:${pack.id}:${second.file_unique_id}`);
  assert.equal(set().stickers[0].file_unique_id, second.file_unique_id);
  // delete a sticker (with confirmation)
  const last = set().stickers[3];
  await h.press(U, `pk:del:${pack.id}:${last.file_unique_id}`);
  await h.tap(U, `pk:delok:${pack.id}:${last.file_unique_id}`);
  assert.equal(set().stickers.length, 3);
  assert.equal(h.one('SELECT count(*) AS n FROM pack_items WHERE pack_id = ?', pack.id).n, 3);

  // rename
  await h.press(U, `pk:ren:${pack.id}`);
  await h.send(U, 'Pack B ✨');
  assert.equal(set().title, 'Pack B ✨');
  assert.equal(h.one('SELECT title FROM packs WHERE id = ?', pack.id).title, 'Pack B ✨');

  // thumbnail: reset to the first sticker; a 100×100 PNG file is checked by reading its header
  await h.press(U, `pk:thumb:${pack.id}`);
  await h.tap(U, `pk:thrst:${pack.id}`);
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 100, 0, 0, 0, 100, 8, 6]);
  await h.press(U, `pk:thumb:${pack.id}`);
  await h.send(U, null, { document: h.tg.document(png) });
  assert.ok(set().thumb, 'thumbnail set from the PNG');
  const bad = png.slice();
  bad[19] = 120;
  await h.press(U, `pk:thumb:${pack.id}`);
  const m2 = h.mark();
  await h.send(U, null, { document: h.tg.document(bad) });
  assert.equal(h.tg.callsOf('setStickerSetThumbnail', undefined, m2).length, 0, '120×100 refused');
  await h.send(U, '/cancel');

  // export: a JSON document with the stickers
  await h.press(U, `pk:exp:${pack.id}`);
  const doc = h.tg.callsOf('sendDocument', U).at(-1);
  const data = JSON.parse(new TextDecoder().decode(doc.params.document.bytes));
  assert.equal(data.stickers.length, 3);
  assert.equal(data.link, `https://t.me/addstickers/${pack.tg_name}`);

  // share: the pack screen has the addstickers link and a share URL
  await h.press(U, `pk:open:${pack.id}`);
  const urls = h.lastButtons(U).filter((b) => b.url).map((b) => b.url);
  assert.ok(urls.includes(`https://t.me/addstickers/${pack.tg_name}`));
  assert.ok(urls.some((u) => u.startsWith('https://t.me/share/url?url=')));
});

test('the last sticker cannot be deleted; deleting the pack removes the set and our rows', async () => {
  const h = setup();
  await h.ready(U);
  const pack = await newPack(h, U);
  const only = h.tg.sets.get(pack.tg_name.toLowerCase()).stickers[0];
  const r = await h.press(U, `pk:delok:${pack.id}:${only.file_unique_id}`);
  assert.equal(r.result, 'refused:pk.err.last_sticker');
  await h.press(U, `pk:drop:${pack.id}`);
  await h.tap(U, `pk:dropok:${pack.id}`);
  assert.equal(h.tg.sets.has(pack.tg_name.toLowerCase()), false);
  assert.equal(h.one('SELECT count(*) AS n FROM packs').n, 0);
  assert.equal(h.one('SELECT count(*) AS n FROM pack_items').n, 0);
});

test("another user's pack id from callback_data is refused everywhere", async () => {
  const h = setup();
  await h.ready(U);
  await h.ready(V);
  const pack = await newPack(h, U);
  const fuid = h.tg.sets.get(pack.tg_name.toLowerCase()).stickers[0].file_unique_id;
  const before = JSON.stringify(h.tg.sets.get(pack.tg_name.toLowerCase()));
  for (const data of [`pk:open:${pack.id}`, `pk:it:${pack.id}:0`, `pk:ren:${pack.id}`, `pk:dropok:${pack.id}`, `pk:delok:${pack.id}:${fuid}`, `pk:up:${pack.id}:${fuid}`, `pk:exp:${pack.id}`, `pb:ask:${pack.id}`, `pk:copy:${pack.id}`, `pk:dup:${pack.id}`]) {
    const r = await h.press(V, data);
    assert.equal(r.result, 'refused:pk.err.gone', data);
  }
  assert.equal(JSON.stringify(h.tg.sets.get(pack.tg_name.toLowerCase())), before);
});

test('import a public pack by link: all, or picked by number', async () => {
  const h = setup();
  await h.ready(U);
  h.tg.addForeignSet('FunnyCats', 'Funny Cats', 12);
  await h.send(U, '/packs');
  await h.tap(U, 'pk:imp');
  await h.send(U, 'https://t.me/addstickers/FunnyCats');
  assert.ok(h.texts(U).some((t) => /Funny Cats/.test(t)));
  await h.tap(U, 'imp:to:0');
  await h.tap(U, 'imp:all');
  const pack = h.one('SELECT * FROM packs WHERE tg_id = ?', U);
  assert.equal(pack.sticker_count, 12);
  assert.equal(h.one("SELECT count(*) AS n FROM pack_items WHERE pack_id = ? AND origin = 'import'", pack.id).n, 12);
  assert.equal(h.one("SELECT status FROM pack_ops").status, 'done');
  // pick 1-3, 5 into the existing pack (already has the same stickers → Telegram ignores duplicates)
  h.tg.addForeignSet('Dogs', 'Dogs', 6);
  await h.press(U, 'pk:imp');
  await h.send(U, 'Dogs');
  await h.tap(U, `imp:to:${pack.id}`);
  await h.tap(U, 'imp:pick');
  await h.send(U, '۱-۳، 5');
  assert.equal(h.one('SELECT sticker_count FROM packs WHERE id = ?', pack.id).sticker_count, 16);
});

test('a bulk op that runs out of budget continues with «ادامه» and never adds a sticker twice', async () => {
  const h = setup();
  await h.ready(U);
  h.tg.addForeignSet('Big', 'Big', 60); // > one slice (25)
  await h.press(U, 'pk:imp');
  await h.send(U, 'Big');
  await h.tap(U, 'imp:to:0');
  await h.tap(U, 'imp:all');
  let op = h.one('SELECT * FROM pack_ops');
  assert.equal(op.status, 'running');
  // the button runs one slice (25); the piggyback tick after the reply may run another
  assert.ok(op.cursor >= 25 && op.cursor < 60, String(op.cursor));
  while (h.one('SELECT status FROM pack_ops').status === 'running') await h.press(U, `op:go:${op.id}`);
  op = h.one('SELECT * FROM pack_ops');
  assert.equal(op.status, 'done');
  const pack = h.one('SELECT * FROM packs WHERE tg_id = ?', U);
  const set = h.tg.sets.get(pack.tg_name.toLowerCase());
  assert.equal(set.stickers.length, 60);
  assert.equal(new Set(set.stickers.map((s) => s.file_unique_id)).size, 60);
  assert.equal(h.tg.callsOf('addStickerToSet').length, 59);
});

test('copy, duplicate and merge between own packs', async () => {
  const h = setup();
  await h.ready(U);
  const a = await newPack(h, U, 'A');
  for (let i = 0; i < 2; i++) {
    await h.sendSticker(U, h.tg.sticker());
    await h.tap(U, `st:add:${a.id}`);
  }
  const b = await newPack(h, U, 'B');
  // copy all of A into B
  await h.press(U, `pk:copy:${a.id}`);
  await h.tap(U, `cp:to:${a.id}:${b.id}`);
  await h.tap(U, 'cp:all');
  assert.equal(h.one('SELECT sticker_count FROM packs WHERE id = ?', b.id).sticker_count, 4);
  // duplicate A
  await h.press(U, `pk:dup:${a.id}`);
  await h.send(U, 'A copy');
  const c = h.one("SELECT * FROM packs WHERE title = 'A copy'");
  assert.equal(c.sticker_count, 3);
  // merge A into C and delete A
  await h.press(U, `pk:merge:${c.id}`);
  await h.tap(U, `mg:from:${c.id}:${a.id}`);
  await h.tap(U, `mg:go:${c.id}:${a.id}:1`);
  assert.equal(h.one('SELECT count(*) AS n FROM packs WHERE id = ?', a.id).n, 0, 'source deleted');
  assert.equal(h.tg.sets.has(a.tg_name.toLowerCase()), false);
  assert.equal(h.one('SELECT sticker_count FROM packs WHERE id = ?', c.id).sticker_count, 3, 'same stickers → no duplicates');
});

test('quota: the daily pack limit is enforced; the owner has none', async () => {
  const h = setup({ settings: { 'quota.pack_create': 1 } });
  await h.ready(U);
  await newPack(h, U, 'one');
  await h.sendSticker(U, h.tg.sticker());
  await h.tap(U, 'st:new');
  const r = await h.send(U, 'two');
  assert.equal(r.result, 'step_error:pk_title');
  assert.equal(h.one('SELECT count(*) AS n FROM packs WHERE tg_id = ?', U).n, 1);
  await h.send(OWNER, '/start');
  await h.tap(OWNER, 'l:set:fa');
  await newPack(h, OWNER, 'o1');
  await newPack(h, OWNER, 'o2');
  assert.equal(h.one('SELECT count(*) AS n FROM packs WHERE tg_id = ?', OWNER).n, 2);
});

test('custom emoji / mask stickers are refused; a name collision tries the next number', async () => {
  const h = setup();
  await h.ready(U);
  await h.sendSticker(U, h.tg.sticker({ type: 'custom_emoji' }));
  assert.ok(h.texts(U).some((t) => /ایموجی سفارشی/.test(t)));
  h.tg.failNext('createNewStickerSet', 400, 'Bad Request: sticker set name is already occupied');
  const pack = await newPack(h, U);
  assert.match(pack.tg_name, /_2_by_/);
});

test('/deletemydata removes our records but keeps the Telegram set', async () => {
  const h = setup();
  await h.ready(U);
  const pack = await newPack(h, U);
  await h.send(U, '/deletemydata');
  await h.tap(U, 'dm:yes');
  assert.equal(h.one('SELECT count(*) AS n FROM packs').n, 0);
  assert.equal(h.one('SELECT count(*) AS n FROM usage_daily WHERE tg_id = ?', U).n, 0);
  assert.ok(h.tg.sets.has(pack.tg_name.toLowerCase()));
  assert.equal(h.one('SELECT first_name FROM users WHERE tg_id = ?', U).first_name, null);
});
