// The download scenarios against the REAL FxTwitter / vxTwitter / twimg (only Telegram is mocked),
// to check the parsers and Range downloads on live data before anything runs in the cloud.
//   NODE_USE_ENV_PROXY=1 node --import ./test/sdk/register.mjs test/live.mjs
import { setupDatabase, db } from './sdk/db.mjs';
import { createMockTelegram } from './mock-telegram.mjs';
import { POSTS } from './mock-x.mjs';
import * as schema from '../tgcloud/schema.js';

const OWNER = 5557901897;
const tg = createMockTelegram({ botId: 7000000001 });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await tg.listen()}`;
delete process.env.X_MOCK_URL;
setupDatabase(schema);
tg.state.users.add(OWNER);
const { default: onMessage } = await import('../tgcloud/handlers/message.js');

let seq = 1;
async function send(body, ctx = {}) {
  await db.run('UPDATE users SET last_req = 0, busy_until = 0 WHERE id = :id', { ':id': OWNER });
  const message = { message_id: seq, from: { id: OWNER, is_bot: false, first_name: 'Owner' }, chat: { id: OWNER, type: 'private' }, date: Math.floor(Date.now() / 1000), text: body };
  seq += 1;
  const started = Date.now();
  const out = await onMessage(message, { update: { update_id: seq, message }, ...ctx });
  return { out, ms: Date.now() - started, media: out.trace.filter((t) => /^send(Video|Photo|Animation|Document|MediaGroup)$/.test(t.m)) };
}
const link = (p) => `https://x.com/${p.user}/status/${p.id}`;
const api = (r) => r.out.api.map((a) => `${a.api}#${a.attempt}:${a.http || ''}${a.result}`).join(' ');
const med = (r) => r.media.map((m) => `${m.m}(${m.src || m.media?.join('+') || ''} ${m.q || ''}${m.bytes ? ` ${(m.bytes / 1048576).toFixed(1)}MB` : ''})${m.ok ? '' : ` ✘ ${m.err}`}`).join(', ');

let failures = 0;
async function check(name, fn) {
  try {
    const line = await fn();
    console.log(`✔ ${name}\n    ${line}`);
  } catch (err) {
    failures += 1;
    console.log(`✘ ${name}\n    ${err.message}`);
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};

await check('video (NASA)', async () => {
  const r = await send(link(POSTS.video));
  expect(r.media.length === 1 && r.media[0].m === 'sendVideo' && r.media[0].ok && r.media[0].src === 'download+upload', med(r));
  return `${api(r)} → ${med(r)} · ${r.ms}ms`;
});
await check('same video again (cache)', async () => {
  const r = await send(link(POSTS.video));
  expect(r.media[0].src === 'file_id' && r.out.api.length === 0, med(r));
  return `${med(r)} · ${r.ms}ms`;
});
await check('3 photos (SpaceX)', async () => {
  const r = await send(link(POSTS.photos));
  expect(r.media[0].m === 'sendMediaGroup' && r.media[0].media.length === 3 && r.media[0].ok, med(r));
  return `${api(r)} → ${med(r)} · ${r.ms}ms`;
});
await check('GIF (GIPHY)', async () => {
  const r = await send(link(POSTS.gif));
  expect(r.media[0].m === 'sendAnimation' && r.media[0].ok, med(r));
  return `${api(r)} → ${med(r)} · ${r.ms}ms`;
});
await check('text only (jack/20)', async () => {
  const r = await send(link(POSTS.text));
  const msg = r.out.trace.find((t) => t.view === 'download_failed');
  expect(msg && msg.text.includes('فقط متن'), JSON.stringify(r.out.trace.slice(-2)));
  return `${api(r)} → "${msg.text}"`;
});
await check('missing post', async () => {
  const r = await send(link(POSTS.missing));
  const msg = r.out.trace.find((t) => t.view === 'download_failed');
  expect(msg && msg.text.includes('پیدا نشد'), JSON.stringify(r.out.trace.slice(-2)));
  return `${api(r)} → "${msg.text}"`;
});
await check('two videos, best quality (41 MB in Range chunks)', async () => {
  await db.run("UPDATE users SET quality = 'best' WHERE id = :id", { ':id': OWNER });
  const r = await send(link(POSTS.twovid));
  await db.run("UPDATE users SET quality = 'auto' WHERE id = :id", { ':id': OWNER });
  expect(r.media.length === 2 && r.media.every((m) => m.ok) && r.media[0].bytes === 40967148, med(r));
  return `${api(r)} → ${med(r)} · ${r.ms}ms`;
});
await check('FxTwitter outage simulated -> vxTwitter (two videos, stored post kept)', async () => {
  const r = await send(link(POSTS.twovid), { simulate: { fx: 'down' } });
  expect(r.out.api.some((a) => a.api === 'vx' && a.result === 'ok'), api(r));
  return `${api(r)} → ${med(r)} ${r.out.trace.some((t) => t.view === 'too_big') ? '+ too_big links' : ''} · ${r.ms}ms`;
});
await check('5 links in one message', async () => {
  const r = await send([POSTS.video, POSTS.photos, POSTS.gif, POSTS.text, POSTS.missing].map(link).join(' '));
  expect(r.out.results.length === 5 && r.out.results.filter((x) => x.ok).length === 3, JSON.stringify(r.out.results));
  return `${JSON.stringify(r.out.results)} · ${r.ms}ms`;
});

await tg.close();
console.log(failures ? `\n${failures} live check(s) failed` : '\nall live checks passed');
process.exit(failures ? 1 : 0);
