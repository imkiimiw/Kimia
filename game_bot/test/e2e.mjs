// End-to-end tests of the server side: the real handlers and endpoints (tgcloud/) run against a local
// emulation of the platform's sdk (test/sdk/: SQLite via node:sqlite) and a strict mock Bot API
// (test/mock-telegram.mjs). Endpoints are called the way the platform calls them: (input, { initData }).
// Run: npm run test:e2e
import assert from 'node:assert/strict';
import { createMockTelegram } from './mock-telegram.mjs';
import { rawDatabase, setupDatabase } from './sdk/db.mjs';
import * as schema from '../tgcloud/schema.js';
import { APP_URL } from '../tgcloud/lib/config.js';
import * as bgRules from '../tgcloud/lib/games/backgammon.js';
import * as hokmRules from '../tgcloud/lib/games/hokm.js';
import * as fusionRules from '../tgcloud/lib/games/fusion.js';

const BOT_ID = 7100000001;
const OWNER = 5557901897;

const mock = createMockTelegram({ botId: BOT_ID });
process.env.TG_MOCK_URL = `http://127.0.0.1:${await mock.listen()}`;
setupDatabase(schema);

// The three default channels: the bot is admin in two; @wangerBots is "broken" until fixed below.
mock.addChannel({ id: -1001, username: 'HIDE_i_SEEK', title: 'Hide' });
mock.addChannel({ id: -1002, username: 'Nepenthw_ir', title: 'Nepenthe' });
mock.addChannel({ id: -1003, username: 'wangerBots', title: 'Wanger', botAdmin: false });

let seed = 99;
Math.random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (const name of ['TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'Blob', 'FormData', 'Headers', 'Request', 'Response', 'fetch',
  'setTimeout', 'setInterval', 'setImmediate', 'structuredClone', 'atob', 'btoa', 'crypto', 'Buffer', 'Intl']) delete globalThis[name];

const H = {};
for (const h of ['message', 'callback_query', 'inline_query', 'chosen_inline_result', 'my_chat_member']) H[h] = (await import(`../tgcloud/handlers/${h}.js`)).default;
const E = {};
for (const e of ['boot', 'setLanguage', 'checkJoin', 'createRoom', 'joinRoom', 'getState', 'move', 'roomAction', 'leaderboard', 'profile', 'codeword', 'fusion', 'broadcastTick']) {
  E[e] = (await import(`../tgcloud/endpoints/${e}.js`)).default;
}

const errors = [];
console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
console.warn = () => {};
let clock = Date.UTC(2026, 9, 30, 9, 0);
Date.now = () => clock;
const tick = (sec) => { clock += sec * 1000; };

const person = (id, first_name, language_code = 'en') => ({ id, is_bot: false, first_name, language_code });
const U = {
  owner: person(OWNER, 'Owner'),
  ali: person(800000001, 'علی', 'fa'),
  bea: person(800000002, 'Béa', 'fr'),
  ivan: person(800000003, 'Иван', 'ru'),
  dan: person(800000004, 'Dan <b>'),
  eve: person(800000005, 'Eve'),
};
const join = (u, ...chans) => { for (const c of chans) mock.state.channels.get(c).members.add(u.id); };

let seq = 1;
let msgId = 1;
async function run(handler, payload) {
  const start = mock.state.calls.length;
  const r = await handler(payload, { update: { update_id: seq++ } });
  assert.ok(r && Array.isArray(r.trace), 'no trace');
  assert.equal(r.error, undefined, `handler error: ${r.error}`);
  const calls = mock.state.calls.slice(start);
  assert.deepEqual(r.trace.map((e) => e.m), calls.map((c) => c.method), 'trace differs from calls');
  return calls;
}
async function dm(u, text, extra = {}) {
  mock.state.started.add(u.id);
  const id = msgId++;
  mock.userMessage(u.id, id, { text, plain: text });
  return run(H.message, { message_id: id, from: u, chat: { id: u.id, type: 'private' }, date: 0, text, ...extra });
}
async function press(u, data, msg) {
  const calls = await run(H.callback_query, { id: `cb${seq++}`, from: u, chat_instance: 'x', data, message: mock.messageObject(u.id, msg) });
  const answers = calls.filter((c) => c.method === 'answerCallbackQuery');
  assert.equal(answers.length, 1, `answered ${answers.length} times: ${data}`);
  return { calls, toast: answers[0].params.text || '' };
}
/** Calls an endpoint as user `u` (optionally from chat `chat`). { result } or { code, params }. */
async function api(name, u, input = {}, chat) {
  try {
    return { result: await E[name](input, { initData: { user: u, ...(chat ? { chat_instance: chat, chat_type: 'group' } : {}), auth_date: 1 } }) };
  } catch (e) {
    if (e && e.parameters) return { code: e.parameters.code, params: e.parameters };
    throw e;
  }
}
const ok = (r) => {
  assert.equal(r.code, undefined, `endpoint refused: ${r.code}`);
  return r.result;
};
const sent = (calls, m = 'sendMessage') => calls.filter((c) => c.method === m);
const row = (q, ...p) => rawDatabase().prepare(q).get(...p);
const stat = (u, g) => row('SELECT * FROM stats WHERE user_id = ? AND game = ?', u.id, g);

const outcome = [];
async function scenario(name, fn) {
  try {
    await fn();
    outcome.push({ ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    outcome.push({ ok: false });
    console.log(`✘ ${name}\n   ${String(err.stack || err).split('\n').slice(0, 7).join('\n   ')}`);
  }
}

// ---------- forced join, languages ----------

await scenario('first /start: language from language_code; the join screen lists the missing channels; the owner is warned about the broken one', async () => {
  const calls = await dm(U.bea, '/start');
  const [msg] = sent(calls);
  assert.match(msg.params.text, /Rejoignez nos chaînes/);
  const urls = msg.params.reply_markup.inline_keyboard.flat().map((b) => b.url || b.callback_data);
  assert.deepEqual(urls, ['https://t.me/HIDE_i_SEEK', 'https://t.me/Nepenthw_ir', 'jc']); // the broken channel is skipped
  assert.equal(row('SELECT lang FROM users WHERE user_id = ?', U.bea.id).lang, 'fr');
  assert.equal(sent(calls).filter((c) => c.params.chat_id === OWNER).length, 0, 'the owner has not started the bot yet');
  await dm(U.owner, '/start'); // owner: exempt, gets the welcome
  rawDatabase().prepare('UPDATE channels SET warned_at = 0').run();
  const again = await dm(U.bea, '/start');
  const warn = sent(again).filter((c) => c.params.chat_id === OWNER);
  assert.equal(warn.length, 1);
  assert.match(warn[0].params.text, /Wanger|wangerBots/);
  assert.equal(sent(await dm(U.bea, '/start')).filter((c) => c.params.chat_id === OWNER).length, 0, 'warned once per interval');
});

await scenario('"I\'ve joined": still missing → alert; joined → welcome with Play, friends and language buttons; cached afterwards', async () => {
  const s = sent(await dm(U.bea, '/start'))[0];
  const m1 = await press(U.bea, 'jc', s.result.result.message_id);
  assert.match(m1.toast, /pas encore/);
  join(U.bea, -1001, -1002);
  const m2 = await press(U.bea, 'jc', s.result.result.message_id);
  assert.match(m2.toast, /Merci/);
  const welcome = mock.get(U.bea.id, s.result.result.message_id);
  assert.match(welcome.plain, /Bienvenue/);
  const kb = welcome.markup.inline_keyboard.flat();
  assert.ok(APP_URL ? kb.some((b) => b.web_app && b.web_app.url === APP_URL) : kb.some((b) => b.url === 'https://t.me/game_test_bot/play'), 'Play opens the Mini App');
  assert.ok(kb.some((b) => b.switch_inline_query === ''));
  const checks = (await dm(U.bea, '/start')).filter((c) => c.method === 'getChatMember');
  assert.equal(checks.length, 0, 'membership is cached');
  tick(9 * 60);
  assert.ok((await dm(U.bea, '/start')).some((c) => c.method === 'getChatMember'), 'checked again after the cache expires');
});

await scenario('/language: switching to Persian changes the bot text', async () => {
  join(U.ivan, -1001, -1002);
  const s = sent(await dm(U.ivan, '/language'))[0];
  assert.equal(s.params.reply_markup.inline_keyboard.flat().length, 4);
  const p = await press(U.ivan, 'lg:fa', s.result.result.message_id);
  assert.match(p.toast, /فارسی/);
  assert.match(mock.get(U.ivan.id, s.result.result.message_id).plain, /خوش آمدی/);
  assert.equal(row('SELECT lang, lang_set FROM users WHERE user_id = ?', U.ivan.id).lang_set, 1);
  const b = ok(await api('setLanguage', U.ivan, { lang: 'ru' }));
  assert.equal(b.lang, 'ru');
  assert.equal((await api('setLanguage', U.ivan, { lang: 'de' })).code, 'BAD_LANG');
});

await scenario('endpoints refuse users who haven\'t joined (with the channels to join); boot reports it', async () => {
  const r = await api('profile', U.eve);
  assert.equal(r.code, 'NOT_JOINED');
  assert.equal(r.params.channels.length, 2);
  const b = ok(await api('boot', U.eve));
  assert.equal(b.join.ok, false);
  assert.equal(b.me.lang, 'en');
  join(U.eve, -1001, -1002);
  assert.equal(ok(await api('checkJoin', U.eve)).ok, true);
  assert.ok(ok(await api('profile', U.eve)).games);
});

// ---------- inline mode ----------

let inlineTtt;
let tttRoom;
await scenario('inline: not joined → no games, a button to the bot; joined → five games with valid Direct Link buttons', async () => {
  const no = await run(H.inline_query, { id: 'q1', from: U.dan, query: '', offset: '' });
  const a = no.find((c) => c.method === 'answerInlineQuery');
  assert.deepEqual(a.params.results, []);
  assert.equal(a.params.button.start_parameter, 'join');
  join(U.dan, -1001, -1002);
  join(U.ali, -1001, -1002);
  const yes = (await run(H.inline_query, { id: 'q2', from: U.ali, query: '', offset: '' })).find((c) => c.method === 'answerInlineQuery');
  assert.ok(yes.result.ok, JSON.stringify(yes.result));
  assert.deepEqual(yes.params.results.map((r) => r.id.split('.')[0]), ['ttt', 'bg', 'hokm', 'codeword', 'fusion']);
  assert.match(yes.params.results[0].title, /دوز/);
  if (APP_URL) assert.equal(yes.params.results[1].thumbnail_url, `${APP_URL}thumbs/bg.png`);
  const url = yes.params.results[0].reply_markup.inline_keyboard[0][0].url;
  const m = /^https:\/\/t\.me\/game_test_bot\/play\?startapp=t_([A-Za-z0-9]{12})$/.exec(url);
  assert.ok(m, url);
  tttRoom = m[1];
  assert.equal(yes.params.results[3].reply_markup.inline_keyboard[0][0].url, 'https://t.me/game_test_bot/play?startapp=c');
  inlineTtt = mock.chooseInline('q2', `ttt.${tttRoom}`);
  await run(H.chosen_inline_result, { result_id: `ttt.${tttRoom}`, from: U.ali, query: '', inline_message_id: inlineTtt });
  const r = row('SELECT * FROM rooms WHERE id = ?', tttRoom);
  assert.equal(r.inline_id, inlineTtt);
  assert.equal(r.creator, U.ali.id);
  assert.equal(r.lang, 'fa');
});

// ---------- tic-tac-toe ----------

await scenario('tic-tac-toe: two players join from the link, turns are enforced, the win is recorded and the inline message shows it', async () => {
  const a = ok(await api('joinRoom', U.ali, { room: tttRoom, game: 'ttt' }, 'chatA'));
  assert.equal(a.status, 'waiting');
  assert.equal(a.you, 0);
  const b = ok(await api('joinRoom', U.dan, { room: tttRoom, game: 'ttt' }, 'chatA'));
  assert.equal(b.status, 'playing');
  assert.equal(b.you, 1);
  assert.match(mock.getInline(inlineTtt).plain, /در حال بازی/);
  const c = ok(await api('joinRoom', U.eve, { room: tttRoom, game: 'ttt' }, 'chatA'));
  assert.equal(c.you, -1, 'a third person watches');
  assert.deepEqual(await api('getState', U.ali, { room: tttRoom, since: b.ver }), { result: { same: true, ver: b.ver } });
  assert.equal((await api('move', U.dan, { room: tttRoom, ver: b.ver, action: { type: 'mark', cell: 0 } })).code, 'NOT_YOUR_TURN');
  let v = b.ver;
  for (const [u, cell] of [[U.ali, 0], [U.dan, 3], [U.ali, 1], [U.dan, 4]]) v = ok(await api('move', u, { room: tttRoom, ver: v, action: { type: 'mark', cell } })).ver;
  assert.equal((await api('move', U.ali, { room: tttRoom, ver: v - 1, action: { type: 'mark', cell: 2 } })).code, 'STALE');
  const end = ok(await api('move', U.ali, { room: tttRoom, ver: v, action: { type: 'mark', cell: 2 } }));
  assert.equal(end.status, 'finished');
  assert.deepEqual(end.result.winners, [0]);
  assert.deepEqual([stat(U.ali, 'ttt').wins, stat(U.ali, 'ttt').score, stat(U.dan, 'ttt').losses], [1, 3, 1]);
  assert.equal(row('SELECT score FROM chat_stats WHERE chat = ? AND user_id = ?', 'chatA', U.ali.id).score, 3);
  const inline = mock.getInline(inlineTtt);
  assert.match(inline.plain, /علی برد/);
  assert.match(inline.markup.inline_keyboard[0][0].url, new RegExp(`startapp=t_${tttRoom}$`));
  const r1 = ok(await api('roomAction', U.dan, { room: tttRoom, action: 'rematch' }));
  assert.equal(r1.status, 'finished');
  assert.deepEqual([r1.rematch.votes, r1.rematch.needed], [1, 2]);
  const r2 = ok(await api('roomAction', U.ali, { room: tttRoom, action: 'rematch' }));
  assert.equal(r2.status, 'playing');
  assert.equal(r2.state.turn, 1, 'the rematch is opened by the other player');
  assert.deepEqual(r2.state.score, [1, 0, 0]);
});

await scenario('turn timers: a timeout plays for the player; three in a row forfeit the game', async () => {
  let s = ok(await api('getState', U.ali, { room: tttRoom }));
  assert.ok(s.left > 40);
  assert.equal(s.state.turn, 1, "Dan's turn, and Dan has gone quiet");
  for (let round = 1; round <= 3 && s.status === 'playing'; round += 1) {
    tick(48);
    s = ok(await api('getState', U.ali, { room: tttRoom }));
    if (round < 3 && s.status === 'playing') {
      assert.equal(s.state.b.replace(/\./g, '').length, 2 * round - 1, 'one mark was made for the late player');
      s = ok(await api('move', U.ali, { room: tttRoom, ver: s.ver, action: { type: 'mark', cell: s.state.b.indexOf('.') } }));
    }
  }
  assert.equal(s.status, 'finished');
  if (s.result.forfeit !== undefined) {
    assert.equal(s.result.forfeit, 1);
    assert.deepEqual(s.result.winners, [0]);
  }
  assert.equal(JSON.parse(row('SELECT meta FROM rooms WHERE id = ?', tttRoom).meta).timeouts[0], 0, 'Ali, who played in time, has no timeouts');
});

// ---------- backgammon ----------

await scenario('backgammon: match length chosen by the creator, server dice, legal turns only, illegal ones refused', async () => {
  const a = ok(await api('createRoom', U.bea, { game: 'bg' }, 'chatB'));
  assert.equal(a.status, 'waiting');
  assert.equal((await api('roomAction', U.ivan, { room: a.id, action: 'opts', target: 5 })).code, 'NOT_CREATOR');
  ok(await api('roomAction', U.bea, { room: a.id, action: 'opts', target: 5 }));
  assert.equal((await api('roomAction', U.bea, { room: a.id, action: 'opts', target: 7 })).code, 'BAD_OPTS');
  let s = ok(await api('joinRoom', U.ivan, { room: a.id, game: 'bg' }, 'chatB'));
  assert.equal(s.status, 'playing');
  assert.equal(s.state.target, 5);
  assert.equal(s.state.phase, 'move');
  const players = [U.bea, U.ivan];
  for (let turn = 0; turn < 12; turn += 1) {
    const u = players[s.state.turn];
    if (s.state.phase === 'roll') {
      assert.equal((await api('move', players[1 - s.state.turn], { room: a.id, ver: s.ver, action: { type: 'roll' } })).code, 'NOT_YOUR_TURN');
      s = ok(await api('move', u, { room: a.id, ver: s.ver, action: { type: 'roll' } }));
      continue;
    }
    const need = bgRules.movesRequired(s.state);
    if (turn === 0) {
      assert.equal((await api('move', u, { room: a.id, ver: s.ver, action: { type: 'move', moves: [{ f: 1, t: 'off', d: 6 }] } })).code, 'ILLEGAL_MOVE');
    }
    const moves = [];
    let st = s.state;
    for (let i = 0; i < need; i += 1) {
      const opts = bgRules.nextMoves(st, []);
      moves.push(opts[0]);
      st = bgRules.applyMove(st, opts[0]);
    }
    s = ok(await api('move', u, { room: a.id, ver: s.ver, action: { type: 'move', moves } }));
    assert.equal(s.state.dice.length, 0);
  }
  assert.ok(s.state.log.some((e) => e.type === 'roll'));
});

// ---------- hokm ----------

await scenario('hokm: bots only after the wait, by the creator; hands are hidden; follow suit is enforced; a full match is recorded', async () => {
  const a = ok(await api('createRoom', U.ali, { game: 'hokm' }));
  ok(await api('joinRoom', U.dan, { room: a.id, game: 'hokm' }));
  assert.equal((await api('roomAction', U.ali, { room: a.id, action: 'bots' })).code, 'TOO_EARLY');
  assert.ok(ok(await api('getState', U.ali, { room: a.id })).botsIn > 0);
  ok(await api('roomAction', U.dan, { room: a.id, action: 'seat', seat: 2 })); // Dan moves to be Ali's partner
  tick(61);
  assert.equal((await api('roomAction', U.dan, { room: a.id, action: 'bots' })).code, 'NOT_CREATOR');
  let s = ok(await api('roomAction', U.ali, { room: a.id, action: 'bots' }));
  assert.equal(s.status, 'playing');
  assert.deepEqual(s.seats.map((x) => !!(x && x.bot)), [false, true, false, true]);
  const spect = ok(await api('getState', U.eve, { room: a.id }));
  assert.ok(spect.state.hands.every((h) => h.length === 0), 'a spectator sees no hand');
  assert.equal(s.state.hands.filter((h) => h.length).length, 1, 'only your own hand');
  const users = { 0: U.ali, 2: U.dan };
  let followChecked = false;
  for (let i = 0; i < 2000 && s.status === 'playing'; i += 1) {
    const seat = s.state.turn;
    const u = users[seat];
    const mine = ok(await api('getState', u, { room: a.id }));
    if (mine.status !== 'playing') { s = mine; break; }
    const full = JSON.parse(row('SELECT state FROM rooms WHERE id = ?', a.id).state);
    if (!followChecked && full.phase === 'play' && full.trick.length) {
      const led = full.trick[0].card[0];
      const hand = full.hands[seat];
      const off = hand.find((c) => c[0] !== led);
      if (off && hand.some((c) => c[0] === led)) {
        assert.equal((await api('move', u, { room: a.id, ver: mine.ver, action: { type: 'play', card: off } })).code, 'MUST_FOLLOW_SUIT');
        followChecked = true;
      }
    }
    s = ok(await api('move', u, { room: a.id, ver: mine.ver, action: hokmRules.auto(full, seat) }));
  }
  assert.equal(s.status, 'finished');
  assert.ok(followChecked, 'a follow-suit refusal was exercised');
  const winners = s.result.winners;
  assert.equal(stat(U.ali, 'hokm').played, 1);
  assert.equal(stat(U.ali, 'hokm').wins, winners.includes(0) ? 1 : 0);
  assert.equal(stat(U.dan, 'hokm').wins, winners.includes(2) ? 1 : 0);
});

// ---------- codeword ----------

await scenario('codeword: daily word per language; non-words and short words refused; solving scores; free play gives new words', async () => {
  const st = ok(await api('codeword', U.bea, { action: 'state', mode: 'daily', lang: 'fr' }));
  assert.equal(st.answer, null);
  assert.equal(st.status, 'play');
  assert.equal((await api('codeword', U.bea, { action: 'guess', mode: 'daily', lang: 'fr', word: 'abc' })).code, 'BAD_WORD');
  assert.equal((await api('codeword', U.bea, { action: 'guess', mode: 'daily', lang: 'fr', word: 'zzzzz' })).code, 'NOT_A_WORD');
  const answer = row("SELECT answer FROM codeword WHERE user_id = ? AND mode = 'daily'", U.bea.id).answer;
  const other = ok(await api('codeword', U.ivan, { action: 'state', mode: 'daily', lang: 'fr' }));
  assert.equal(row("SELECT answer FROM codeword WHERE user_id = ? AND mode = 'daily' AND lang = 'fr'", U.ivan.id).answer, answer, 'same daily word');
  assert.equal(other.guesses.length, 0);
  const g1 = ok(await api('codeword', U.bea, { action: 'guess', mode: 'daily', lang: 'fr', word: 'MONDE' }));
  assert.equal(g1.guesses.length, 1);
  assert.ok('exact' in g1.guesses[0] && 'near' in g1.guesses[0]);
  const won = ok(await api('codeword', U.bea, { action: 'guess', mode: 'daily', lang: 'fr', word: answer }));
  assert.equal(won.status, 'won');
  assert.equal(won.answer, answer);
  assert.equal(stat(U.bea, 'codeword').score, 9);
  assert.equal((await api('codeword', U.bea, { action: 'guess', mode: 'daily', lang: 'fr', word: answer })).code, 'GAME_OVER');
  const f1 = ok(await api('codeword', U.bea, { action: 'state', mode: 'free', lang: 'en' }));
  assert.equal(f1.mode, 'free');
  const before = row("SELECT answer FROM codeword WHERE user_id = ? AND mode = 'free'", U.bea.id).answer;
  ok(await api('codeword', U.bea, { action: 'new', mode: 'free', lang: 'en' }));
  const after = row("SELECT answer FROM codeword WHERE user_id = ? AND mode = 'free'", U.bea.id).answer;
  assert.notEqual(before, after);
  const fa = ok(await api('codeword', U.ali, { action: 'state', mode: 'daily', lang: 'fa' }));
  assert.equal(fa.lang, 'fa');
});

// ---------- fusion ----------

await scenario('fusion: the server replays the moves; too fast, tampered or reused runs are refused; the best score is kept', async () => {
  const { run: runId, seed: s } = ok(await api('fusion', U.dan, { action: 'start' }));
  const g = fusionRules.start(s);
  const moves = [];
  while (!g.over) {
    const free = g.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const cell = free[moves.length % free.length];
    fusionRules.place(g, cell);
    moves.push(cell);
  }
  assert.equal((await api('fusion', U.dan, { action: 'submit', run: runId, moves })).code, 'TOO_FAST');
  tick(moves.length);
  assert.equal((await api('fusion', U.dan, { action: 'submit', run: runId, moves: moves.concat([0]) })).code, 'ILLEGAL_MOVE');
  const r = ok(await api('fusion', U.dan, { action: 'submit', run: runId, moves }));
  assert.equal(r.score, g.score);
  assert.equal(r.best, g.score);
  assert.equal((await api('fusion', U.dan, { action: 'submit', run: runId, moves })).code, 'NO_RUN');
  assert.equal((await api('fusion', U.ali, { action: 'submit', run: runId, moves })).code, 'NO_RUN', "someone else's run");
  const second = ok(await api('fusion', U.dan, { action: 'start' }));
  tick(10);
  ok(await api('fusion', U.dan, { action: 'submit', run: second.run, moves: [12] }));
  assert.equal(stat(U.dan, 'fusion').score, g.score, 'a lower score keeps the best');
});

// ---------- leaderboards, profile ----------

await scenario('leaderboards: global and per chat, with the caller\'s rank; profile stats', async () => {
  const g = ok(await api('leaderboard', U.ali, { game: 'ttt', scope: 'global' }));
  assert.equal(g.top[0].name, 'علی');
  assert.ok(g.top[0].me);
  assert.equal(g.rank, 1);
  const c = ok(await api('leaderboard', U.dan, { game: 'ttt', scope: 'chat' }, 'chatA'));
  assert.equal(c.scope, 'chat');
  assert.ok(c.top.length >= 1);
  const none = ok(await api('leaderboard', U.dan, { game: 'ttt', scope: 'chat' }));
  assert.equal(none.scope, 'global', 'no chat context → global');
  const p = ok(await api('profile', U.ali));
  assert.ok(p.games.ttt.played >= 1);
});

// ---------- owner panel ----------

await scenario('/admin: silence for everyone else; the owner gets the panel and the stats', async () => {
  assert.equal((await dm(U.dan, '/admin')).filter((c) => c.method === 'sendMessage').length, 0);
  const p = sent(await dm(U.owner, '/admin'))[0];
  assert.match(p.params.text, /Owner panel/);
  const st = await press(U.owner, 'ad:st', p.result.result.message_id);
  assert.ok(st.calls.some((c) => c.method === 'editMessageText' && /Users: \d+/.test(c.params.text)));
  const forged = await press(U.dan, 'ad:st', sent(await dm(U.dan, '/start'))[0].result.result.message_id);
  assert.equal(forged.calls.filter((c) => c.method === 'editMessageText').length, 0);
});

await scenario('channels: add by @username (bot must be admin), by forward; refuse an 11th; remove; turn forced join off', async () => {
  const p = sent(await dm(U.owner, '/admin'))[0].result.result.message_id;
  await press(U.owner, 'ad:ca', p);
  mock.addChannel({ id: -1004, username: 'newchan', title: 'New', botAdmin: false });
  assert.match(sent(await dm(U.owner, '@newchan'))[0].params.text, /isn't an admin/);
  mock.state.channels.get(-1004).botAdmin = true;
  assert.match(sent(await dm(U.owner, 'https://t.me/newchan'))[0].params.text, /Added New/);
  await press(U.owner, 'ad:ca', p);
  mock.addChannel({ id: -1005, title: 'Private one' });
  const fwd = sent(await dm(U.owner, 'post', { forward_origin: { type: 'channel', chat: { id: -1005, type: 'channel', title: 'Private one' }, message_id: 1, date: 0 } }))[0];
  assert.match(fwd.params.text, /Added Private one/);
  assert.equal(row('SELECT link FROM channels WHERE chat_id = -1005').link, 'https://t.me/+invite1005');
  for (let i = 6; i <= 10; i += 1) {
    mock.addChannel({ id: -1000 - i, username: `c${i}chan`, title: `C${i}` });
    await press(U.owner, 'ad:ca', p);
    await dm(U.owner, `@c${i}chan`);
  }
  assert.equal(row('SELECT count(*) AS n FROM channels').n, 10);
  const full = await press(U.owner, 'ad:ca', p);
  assert.ok(full.calls.some((c) => c.method === 'editMessageText' && /limit is 10/.test(c.params.text)));
  const id = row("SELECT id FROM channels WHERE username = 'c10chan'").id;
  await press(U.owner, `ad:cr:${id}`, p);
  await press(U.owner, `ad:cy:${id}`, p);
  assert.equal(row('SELECT count(*) AS n FROM channels').n, 9);
  assert.equal((await api('profile', U.eve)).code, 'NOT_JOINED', 'new channels apply at once (the cache is per channel list)');
  await press(U.owner, 'ad:ct', p);
  assert.ok(ok(await api('profile', U.eve)).games, 'forced join off');
  await press(U.owner, 'ad:ct', p);
});

await scenario('broadcast: preview, confirm, batches of 25 with a 429 pause and resume, blocked users marked, final report, owner-only tick', async () => {
  rawDatabase().prepare("UPDATE settings SET value = '0' WHERE key = 'join'").run();
  for (let i = 0; i < 60; i += 1) {
    const id = 810000000 + i;
    rawDatabase().prepare('INSERT INTO users (user_id, first_name, started, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)').run(id, `u${i}`);
    if (i % 10 !== 3) mock.state.started.add(id);
    if (i === 7) mock.state.blocked.add(id);
  }
  const p = sent(await dm(U.owner, '/admin'))[0].result.result.message_id;
  await press(U.owner, 'ad:bc', p);
  const input = await dm(U.owner, 'Big news!', { reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.org' }]] } });
  const preview = input.find((c) => c.method === 'copyMessage');
  assert.equal(preview.params.reply_markup.inline_keyboard[0][0].url, 'https://example.org');
  const confirm = sent(input)[0];
  const total = Number(/\d+/.exec(confirm.params.text)[0]);
  mock.state.copies = 0;
  mock.state.floodAfter = 30; // Telegram says "too many requests" after 30 more copies
  const bcId = /bc:ok:(\d+)/.exec(JSON.stringify(confirm.params.reply_markup))[1];
  const first = await press(U.owner, `bc:ok:${bcId}`, confirm.result.result.message_id);
  assert.equal(first.calls.filter((c) => c.method === 'copyMessage').length, 25);
  assert.equal((await api('broadcastTick', U.dan, { action: 'tick' })).code, 'OWNER_ONLY');
  tick(1);
  let r = ok(await api('broadcastTick', U.owner, { action: 'tick' }));
  assert.ok(r.sent > 0 && r.sent < 25, `stopped at the 429 (${r.sent})`);
  assert.ok(mock.state.calls.some((c) => c.method === 'copyMessage' && c.result.error_code === 429));
  tick(1);
  assert.equal(ok(await api('broadcastTick', U.owner, { action: 'tick' })).sent, 0, 'paused for retry_after');
  for (let i = 0; i < 10 && r.broadcast.status === 'running'; i += 1) {
    tick(4);
    r = ok(await api('broadcastTick', U.owner, { action: 'tick' }));
  }
  assert.equal(r.broadcast.status, 'done');
  assert.equal(r.broadcast.done, total);
  assert.equal(r.broadcast.blocked, 7, '1 blocked + 6 who never started the bot');
  const ids = mock.state.calls.filter((c) => c.method === 'copyMessage' && c.result.ok && c.params.chat_id !== OWNER).map((c) => c.params.chat_id);
  assert.equal(new Set(ids).size, ids.length, 'nobody got it twice');
  assert.equal(row('SELECT blocked FROM users WHERE user_id = 810000007').blocked, 1);
  assert.ok(mock.state.calls.some((c) => c.method === 'sendMessage' && /Broadcast finished/.test(c.params.text || '')));
  rawDatabase().prepare("UPDATE settings SET value = '1' WHERE key = 'join'").run();
});

await scenario('my_chat_member: blocking the bot is recorded, unblocking clears it', async () => {
  await run(H.my_chat_member, { chat: { id: U.eve.id, type: 'private' }, from: U.eve, date: 0, old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } });
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.eve.id).blocked, 1);
  await run(H.my_chat_member, { chat: { id: U.eve.id, type: 'private' }, from: U.eve, date: 0, old_chat_member: { status: 'kicked' }, new_chat_member: { status: 'member' } });
  assert.equal(row('SELECT blocked FROM users WHERE user_id = ?', U.eve.id).blocked, 0);
});

await scenario('every refused Bot API call was an expected one; no unexpected console.error', async () => {
  const refused = mock.state.calls.filter((c) => !c.result.ok).map((c) => `${c.method}: ${c.result.description}`);
  const expected = [/editMessageText: Bad Request: message is not modified/, /getChatMember: Bad Request: member list is inaccessible/, /copyMessage: Forbidden/, /copyMessage: Too Many Requests/, /sendMessage: Forbidden: bot can't initiate/];
  assert.deepEqual(refused.filter((r) => !expected.some((re) => re.test(r))), []);
  assert.deepEqual(errors, []);
});

await mock.close();
const failed = outcome.filter((o) => !o.ok).length;
console.log(`\n${outcome.length - failed}/${outcome.length} scenarios passed; ${mock.state.calls.length} Bot API calls`);
process.exit(failed ? 1 : 0);
