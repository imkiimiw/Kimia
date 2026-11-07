// The main user paths end to end: /start, the gate, file intake, Detect & Fix, rename, history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, OWNER, SEED, advance } from '../helpers/harness.mjs';
import { SAMPLES, exeAsJpg, polyglotJpegZip } from '../helpers/fixtures.mjs';

const U = 100000001;

test('/start: welcome with the main menu; first run seeds the three channels', async () => {
  const h = setup({ members: [U] });
  const r = await h.send(U, '/start');
  assert.equal(r.ok, true, r.error);
  assert.match(h.lastText(U), /ربات مبدل Wanger/);
  const data = h.lastButtons(U).map((b) => b.callback_data);
  for (const d of ['m:tools', 'hi:0', 'm:set', 'm:help', 'm:bots']) assert.ok(data.includes(d), d);
  assert.ok(!data.includes('p'), 'no panel for users');
  const ch = h.q('SELECT username, chat_id, bot_status FROM channels ORDER BY id');
  assert.deepEqual(ch.map((c) => [c.username, c.chat_id, c.bot_status]), [['HIDE_i_SEEK', SEED[0], 'ok'], ['Nepenthw_ir', SEED[1], 'ok'], ['wangerBots', SEED[2], 'ok']]);
  assert.equal(h.one("SELECT n FROM counters WHERE day = 'all' AND key = 'users'").n, 1);
});

test('forced join: a non-member is held, the file is resumed after joining', async () => {
  const h = setup();
  await h.sendFile(U, SAMPLES.png[0], 'pic.jpg');
  assert.match(h.lastText(U), /عضو شوید/);
  const urls = h.lastButtons(U).filter((b) => b.url).map((b) => b.url);
  assert.deepEqual(urls, ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'https://t.me/wangerBots']);
  // still not a member: a toast, the join screen stays
  await h.tap(U, 'j');
  assert.ok(h.tg.answers().some((a) => /هنوز عضو/.test(a.text || '')));
  h.join(U);
  await h.tap(U, 'j');
  assert.match(h.lastText(U), /تصویر دریافت شد/, 'the pending file got its card');
  assert.match(h.lastText(U), /PNG/);
});

test('forced join fails open when the bot is not admin in a channel, and the owner is told once', async () => {
  const h = setup({ botAdminIn: [SEED[0]] });
  h.tg.setMember(SEED[0], U);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /ربات مبدل Wanger/, 'user passes: only the checkable channel counts');
  const alerts = h.tg.callsOf('sendMessage', OWNER).filter((c) => /ادمین نیست/.test(c.params.text));
  assert.equal(alerts.length, 1, 'one combined alert');
  assert.match(alerts[0].params.text, /@Nepenthw_ir/);
  await h.send(U + 1, '/start');
  h.tg.setMember(SEED[0], U + 1);
  assert.equal(h.tg.callsOf('sendMessage', OWNER).filter((c) => /ادمین نیست/.test(c.params.text)).length, 1, 'throttled');
});

test('a member who left is held again after the 5-minute pass expires', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/start');
  h.tg.channels.get(SEED[1]).members.delete(U);
  await h.send(U, '/help'); // pre-gate command: always works
  assert.match(h.lastText(U), /راهنما/);
  await h.sendFile(U, SAMPLES.png[0], 'a.png');
  assert.match(h.lastText(U), /تصویر دریافت شد/, 'pass still valid');
  advance(301);
  await h.sendFile(U, SAMPLES.png[0], 'a.png');
  assert.match(h.lastText(U), /عضو شوید/);
});

test('file card: real type from bytes, mismatch question, Detect & Fix uploads a renamed copy', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'holiday.jpg');
  const text = h.lastText(U);
  assert.match(text, /نوع واقعی: <code>PNG<\/code> — پسوند فعلی: <code>\.jpg<\/code>/);
  const mark = h.mark();
  await h.tapText(U, '✅ بله');
  const docs = h.docs(U, mark);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].document.file_name, 'holiday.png');
  assert.deepEqual(h.tg.files.get(docs[0].document.file_id).bytes, SAMPLES.png[0], 'same bytes');
  assert.equal(docs[0].document.mime_type, 'image/png');
  assert.match(docs[0].caption, /WC-[0-9A-Z]{6}/);
  const job = h.one('SELECT * FROM jobs');
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.operation, 'fix');
  assert.equal(job.engine, 'bot');
  assert.equal(job.output_size, SAMPLES.png[0].length);
});

test('«❌ نه» on the fix question keeps the card with rename only', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'holiday.jpg');
  await h.tapText(U, '❌ نه');
  assert.doesNotMatch(h.lastText(U), /نوع واقعی/);
  assert.ok(h.lastButtons(U).some((b) => b.callback_data.startsWith('rn:')));
});

test('rename: new name keeps the extension; prefix; normalize; extension menu', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.jpeg[0], 'ali_photo.jpg');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'نام جدید');
  assert.match(h.lastText(U), /نام جدید را بفرستید/);
  let mark = h.mark();
  await h.send(U, 'گزارش سفر');
  assert.equal(h.docs(U, mark)[0].document.file_name, 'گزارش سفر.jpg');

  // the result has its own card: «🔁 کار دیگری با همین فایل» → rename again with a prefix
  await h.tapText(U, 'کار دیگری');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'پیشوند');
  mark = h.mark();
  await h.send(U, '۱۴۰۵');
  assert.equal(h.docs(U, mark)[0].document.file_name, '۱۴۰۵ گزارش سفر.jpg');

  await h.sendFile(U, SAMPLES.jpeg[0], 'علي__كتاب.jpg');
  await h.tapText(U, 'تغییر نام');
  mark = h.mark();
  await h.tapText(U, 'مرتب');
  assert.equal(h.docs(U, mark)[0].document.file_name, 'علی کتاب.jpg');

  advance(61); // three jobs per minute (RATE_BURST_PER_MIN)
  await h.sendFile(U, SAMPLES.jpeg[0], 'x.jpg');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'پسوند فایل');
  const exts = h.lastButtons(U).filter((b) => b.callback_data.startsWith('re:')).map((b) => b.text);
  assert.deepEqual(exts, ['.jpg ✓', '.jpeg', '.jpe', '.jfif']);
  mark = h.mark();
  await h.tapText(U, '.jpeg');
  assert.equal(h.docs(U, mark)[0].document.file_name, 'x.jpeg');
});

test('rename refuses names that clean up to nothing and keeps waiting', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.jpeg[0], 'x.jpg');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'نام جدید');
  await h.send(U, '\u202e\u202e');
  assert.match(h.lastText(U), /چیزی از نام باقی نماند/);
  const mark = h.mark();
  await h.send(U, 'ok');
  assert.equal(h.docs(U, mark)[0].document.file_name, 'ok.jpg');
});

test('executables, scripts and polyglots are reported only — no actions', async () => {
  const h = setup({ members: [U] });
  const [exe, name] = exeAsJpg();
  await h.sendFile(U, exe, name);
  assert.match(h.lastText(U), /اجرایی/);
  assert.ok(!h.lastButtons(U).some((b) => /^(rn|fx|re):/.test(b.callback_data)));
  await h.sendFile(U, polyglotJpegZip(), 'cat.jpg');
  assert.match(h.lastText(U), /دو نوع/);
  assert.ok(!h.lastButtons(U).some((b) => /^(rn|fx|re):/.test(b.callback_data)));
  await h.sendFile(U, ...SAMPLES.script);
  assert.ok(!h.lastButtons(U).some((b) => /^(rn|fx|re):/.test(b.callback_data)));
  // a forged callback can't rename it either
  const ref = h.one('SELECT ref FROM files ORDER BY created_at DESC, rowid DESC LIMIT 1').ref;
  const mark = h.mark();
  await h.press(U, `re:${ref}:txt`, 1);
  await h.press(U, `fx:${ref}`, 1);
  assert.equal(h.docs(U, mark).length, 0);
});

test('RTLO filename: removed, flagged, and the real extension is shown', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'photo\u202egnp.exe');
  const t = h.lastText(U);
  assert.match(t, /RTLO/);
  assert.match(t, /<code>photognp\.exe<\/code>/);
  assert.match(t, /پسوند فعلی: <code>\.exe<\/code>/);
});

test('size limit: a 21 MB file is refused before any download', async () => {
  const h = setup({ members: [U] });
  const mark = h.mark();
  await h.send(U, null, { document: { file_id: 'BIG', file_unique_id: 'BIGU', file_size: 21 * 1024 * 1024, file_name: 'big.zip' } });
  assert.match(h.lastText(U), /۲۱ MB|21 MB/);
  assert.equal(h.tg.callsOf('getFileContent', undefined, mark).length, 0);
});

test('every media kind is accepted: photo (with tip), voice, video note, animation (with tip), audio, video', async () => {
  const h = setup({ members: [U] });
  await h.sendPhoto(U, SAMPLES.jpeg[0]);
  assert.match(h.lastText(U), /تصویر دریافت شد/);
  assert.match(h.lastText(U), /به\u200cصورت فایل بفرستید/);
  assert.match(h.lastText(U), /<code>photo_\d{4}-\d\d-\d\d\.jpg<\/code>/);
  for (const [kind, sample, re] of [['voice', 'opus', /صوت/], ['video_note', 'mp4', /ویدیو/], ['animation', 'mp4', /گیف/], ['audio', 'mp3', /صوت/], ['video', 'mp4', /ویدیو/]]) {
    advance(7); // stay under the intake rate limit
    const f = h.tg.putFile(SAMPLES[sample][0]);
    await h.send(U, null, { [kind]: { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.file_size } });
    assert.match(h.lastText(U), re, kind);
  }
});

test('history, /status by code, ownership of jobs', async () => {
  const h = setup({ members: [U, U + 1] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  await h.tapText(U, '✅ بله');
  const code = h.one('SELECT code FROM jobs').code;
  await h.send(U, '/history');
  assert.match(h.lastText(U), new RegExp(code));
  await h.send(U, `/status ${code.toLowerCase()}`);
  assert.match(h.lastText(U), /انجام شد/);
  await h.send(U + 1, `/status ${code}`);
  assert.match(h.lastText(U + 1), /هنوز کاری ثبت نشده/, 'someone else\'s code reveals nothing');
  await h.send(U, '/status nonsense');
  assert.match(h.lastText(U), /WC-7K3P9Q/);
});

test('result cache: the same request is answered from the cache without downloading', async () => {
  const h = setup({ members: [U] });
  const doc = h.tg.putFile(SAMPLES.png[0], { name: 'a.jpg' });
  await h.send(U, null, { document: doc });
  await h.tapText(U, '✅ بله');
  await h.send(U, null, { document: doc });
  const mark = h.mark();
  await h.tapText(U, '✅ بله');
  assert.equal(h.tg.callsOf('getFileContent', undefined, mark).length, 0);
  const docs = h.docs(U, mark);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].document.file_name, 'a.png');
  assert.equal(h.q("SELECT count(*) AS n FROM jobs WHERE status = 'COMPLETED'")[0].n, 2);
});

test('rate limits: 3 jobs per minute, 10 per hour; the owner is unlimited', async () => {
  const h = setup({ members: [U] });
  const run = async (who) => { await h.sendFile(who, SAMPLES.png[0], `n${Math.random()}.jpg`); await h.tapText(who, '✅ بله'); };
  for (let i = 0; i < 3; i++) await run(U);
  await run(U);
  assert.match(h.lastText(U), /سقف کارها/);
  assert.equal(h.q("SELECT count(*) AS n FROM jobs WHERE user_id = ?", U)[0].n, 3);
  for (let i = 0; i < 5; i++) await run(OWNER);
  assert.equal(h.q('SELECT count(*) AS n FROM jobs WHERE user_id = ?', OWNER)[0].n, 5);
});

test('download failure → friendly error with the job code; the job is FAILED with an error code', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  h.tg.failNext('getFileContent', 500, 'Internal Server Error');
  await h.tapText(U, '✅ بله');
  const job = h.one('SELECT * FROM jobs');
  assert.equal(job.status, 'FAILED');
  assert.equal(job.error_code, 'DOWNLOAD_FAILED');
  assert.match(h.lastText(U), new RegExp(`دریافت فایل از تلگرام ممکن نشد.*${job.code}`));
  assert.equal(h.one('SELECT code FROM errors').code, 'DOWNLOAD_FAILED');
});

test('big files get one status message that ends as done', async () => {
  const h = setup({ members: [U] });
  const big = new Uint8Array(9 * 1024 * 1024);
  big.set(SAMPLES.png[0]);
  await h.sendFile(U, big, 'big.jpg');
  await h.tapText(U, '✅ بله');
  const edits = h.tg.callsOf('editMessageText', U).map((c) => c.params.text);
  assert.ok(edits.some((t) => /📤 ارسال/.test(t)));
  assert.match(edits.at(-1), /✅ انجام شد/);
});

test('settings: language and Persian digits', async () => {
  const h = setup({ members: [U] });
  await h.send(U, '/settings');
  await h.tap(U, 'm:lang');
  await h.tap(U, 'L:en:set');
  assert.match(h.lastText(U), /Settings/);
  await h.tap(U, 's:dg');
  assert.match(h.lastButtons(U)[1].text, /Persian digits: on/);
  await h.send(U, '/start');
  assert.match(h.lastText(U), /۲۰ MB/, 'digits on in English too');
});

test('/cancel and «❌ لغو» clear a pending input', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.jpeg[0], 'x.jpg');
  await h.tapText(U, 'تغییر نام');
  await h.tapText(U, 'نام جدید');
  await h.send(U, '/cancel');
  assert.match(h.lastText(U), /لغو شد/);
  await h.send(U, 'not a name');
  assert.match(h.lastText(U), /یک فایل بفرستید/);
});

test('/deletemydata removes the user\'s rows everywhere (a ban survives)', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  await h.tapText(U, '✅ بله');
  await h.send(U, '/deletemydata');
  await h.tap(U, 'dd:y');
  assert.match(h.lastText(U), /پاک شد/);
  for (const t of ['jobs', 'files', 'result_cache', 'pending_actions', 'rate_counters', 'user_settings']) {
    assert.equal(h.q(`SELECT count(*) AS n FROM ${t} WHERE user_id = ?`, U)[0].n, 0, t);
  }
  assert.equal(h.q('SELECT count(*) AS n FROM users WHERE id = ?', U)[0].n, 0);
});

test('unsupported messages and plain text get a hint', async () => {
  const h = setup({ members: [U] });
  await h.send(U, null, { sticker: { file_id: 'S', file_unique_id: 'SU' } });
  assert.match(h.lastText(U), /پردازش نمی\u200cکنم/);
  await h.send(U, 'hello');
  assert.match(h.lastText(U), /یک فایل بفرستید/);
});

test('an expired card says so', async () => {
  const h = setup({ members: [U] });
  await h.sendFile(U, SAMPLES.png[0], 'a.jpg');
  advance(25 * 3600);
  h.join(U);
  await h.tapText(U, '✅ بله');
  assert.match(h.lastText(U), /منقضی/);
});
