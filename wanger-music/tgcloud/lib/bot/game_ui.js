// 🎮 Guess the song (owner's idea, 2026-11-23): in a group where the bot is a member (/guess) or in
// a listener's private chat (🎮 in the menu), the bot sends 15 seconds of a popular song with its
// name hidden; the first right answer — a reply to the clip in groups, the next message in private,
// Finglish too — wins a point. Group players get no user rows: only their first name, for the
// chat's own table. One open round per chat; a round older than 10 minutes can be replaced.
import { BOT_ID, BOT_USERNAME } from '../config/static.js';
import { t, tp, digits } from '../i18n/index.js';
import { btn, markup } from './keyboards.js';
import { truncate } from '../core/util.js';
import { parseCommand } from './commands.js';
import { tokensOf, skeletonTerm } from '../search/terms.js';
import { mp3Clip } from '../music/artwork.js';
import { classify } from '../telegram/errors.js';

const STALE = 10 * 60;
const MAX_FILE = 20 * 1024 * 1024;

/** At most one letter added, removed or changed ("boys" for "boyz"). */
function nearlySame(a, b) {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x, y) => x.slice(y);
  return rest(a, i + 1) === rest(b, i + 1) || rest(a, i + 1) === rest(b, i) || rest(a, i) === rest(b, i + 1);
}

/**
 * Is a guess right (pure)? Every word of the title must be in it — as written, as its Finglish
 * skeleton, or with one letter off — or the whole title's skeleton must be inside the guess's
 * ("bi to" for «بی تو»). The artist alone is not enough.
 */
export function guessMatches(guess, title) {
  const want = tokensOf(title);
  const got = tokensOf(guess);
  if (!want.length || !got.length) return false;
  const set = new Set([...got, ...got.map(skeletonTerm).filter(Boolean)]);
  const ok = (w) => set.has(w) || (Boolean(skeletonTerm(w)) && set.has(skeletonTerm(w))) || got.some((g) => nearlySame(g, w));
  if (want.every(ok)) return true;
  const whole = skeletonTerm(want.join(''));
  const mine = skeletonTerm(got.join(''));
  return Boolean(whole && mine && mine.includes(whole.slice(1)));
}

const firstName = (from) => truncate(String((from && (from.first_name || from.username)) || '?'), 32);
const deepLink = (tr) => `https://t.me/${BOT_USERNAME}?start=t_${tr.public_id}`;
const afterRound = (lang, tr) => markup([
  [{ text: tp(lang, 'game.btn_full'), url: deepLink(tr) }],
  [btn(tp(lang, 'game.btn_next'), 'g', 'new'), btn(tp(lang, 'game.btn_top'), 'g', 'top')],
]);

/**
 * A new round in a chat: 15 s of a random popular MP3, its name hidden.
 * @returns {Promise<'started'|'busy'|'no_songs'>}
 */
export async function startRound(app, chatId, { isPrivate = false, lang = app.lang } = {}) {
  const now = app.clock.now();
  const open = await app.listeners.round(chatId);
  if (open && open.status === 'open' && open.started_at >= now - STALE) {
    await app.tg.send(chatId, { text: t(lang, 'game.busy'), keyboard: markup([[btn(tp(lang, 'game.btn_reveal'), 'g', 'rev')]]) }, 'game_busy');
    return 'busy';
  }
  const candidates = (await app.listeners.gameCandidates(50)).filter((tr) => tr.title && tr.mime_type === 'audio/mpeg' && (!tr.file_size || tr.file_size <= MAX_FILE));
  for (let tries = 0; tries < 3 && candidates.length; tries++) {
    const tr = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
    let clip = null;
    try {
      clip = mp3Clip(await app.tg.fileContent(tr.audio_file_id));
    } catch (e) {
      app.log.warn('game_clip_failed', { track_id: tr.id, error: classify(e).kind });
    }
    if (!clip) continue;
    const m = await app.tg.sendAudioFile(chatId, clip, 'guess.mp3', {
      title: '❓', performer: '❓', caption: t(lang, isPrivate ? 'game.round_private' : 'game.round'), parse_mode: 'HTML',
      reply_markup: markup([[btn(tp(lang, 'game.btn_reveal'), 'g', 'rev'), btn(tp(lang, 'game.btn_top'), 'g', 'top')]]),
    }, null, 'game_round');
    if (await app.listeners.openRound(chatId, tr.id, m.message_id, now, now - STALE)) return 'started';
    await app.tg.call('deleteMessage', { chat_id: chatId, message_id: m.message_id }, 'game_round_undo').catch(() => {}); // someone else started one
    return 'busy';
  }
  await app.tg.send(chatId, { text: t(lang, 'game.no_songs') }, 'game_no_songs');
  return 'no_songs';
}

/** A guess for the chat's open round. @returns {Promise<'won'|'wrong'|'no_round'>} */
export async function guess(app, chatId, from, text, { replyTo = null, lang = app.lang } = {}) {
  const round = await app.listeners.round(chatId);
  if (!round || round.status !== 'open' || (replyTo !== null && replyTo !== round.message_id)) return 'no_round';
  const tr = await app.listeners.activeById(round.track_id);
  if (!tr) return 'no_round';
  if (!guessMatches(text, tr.title)) return 'wrong';
  if (!(await app.listeners.closeRound(chatId, round.message_id, 'won', from.id, app.clock.now()))) return 'no_round';
  const points = await app.listeners.addPoint(chatId, from.id, firstName(from), app.clock.now());
  await app.tg.send(chatId, { text: t(lang, 'game.won', { name: firstName(from), title: tr.title, artist: tr.artist || '?', points: digits(points, lang) }), keyboard: afterRound(lang, tr) }, 'game_won');
  return 'won';
}

async function reveal(app, chatId, messageId, lang) {
  const round = await app.listeners.round(chatId);
  if (!round || round.status !== 'open' || (messageId && messageId !== round.message_id)) return false;
  if (!(await app.listeners.closeRound(chatId, round.message_id, 'revealed', null, app.clock.now()))) return false;
  const tr = await app.listeners.activeById(round.track_id);
  if (tr) await app.tg.send(chatId, { text: t(lang, 'game.revealed', { title: tr.title, artist: tr.artist || '?' }), keyboard: afterRound(lang, tr) }, 'game_revealed');
  return true;
}

async function leaderboard(app, chatId, lang) {
  const rows = await app.listeners.topScores(chatId, 10);
  const lines = rows.map((r, i) => t(lang, 'game.top_line', { i: digits(i + 1, lang), name: r.name, n: digits(r.points, lang) }));
  await app.tg.send(chatId, { text: [t(lang, 'game.top_title'), '', ...(lines.length ? lines : [t(lang, 'game.top_empty')])].join('\n'), keyboard: markup([[btn(tp(lang, 'game.btn_next'), 'g', 'new')]]) }, 'game_top');
}

/**
 * A group message: /guess, /top, or a reply to the bot (a guess). null → not for the game (the
 * source-group path takes it). No user rows, no force-join (a group game).
 */
export async function onGroupGame(app, message) {
  const text = typeof message.text === 'string' ? message.text : '';
  const cmd = parseCommand(text);
  const chatId = message.chat.id;
  if (cmd && (cmd.name === 'guess' || cmd.name === 'game')) return `game:${await startRound(app, chatId)}`;
  if (cmd && (cmd.name === 'top' || cmd.name === 'scores')) {
    await leaderboard(app, chatId, app.lang);
    return 'game:top';
  }
  const reply = message.reply_to_message;
  if (text && !cmd && message.from && !message.from.is_bot && reply && reply.from && reply.from.id === BOT_ID) {
    return `game:${await guess(app, chatId, message.from, text, { replyTo: reply.message_id })}`;
  }
  return null;
}

/** A game button pressed in a group (no user rows). */
export async function onGroupGameCallback(app, cq, answer) {
  const chatId = cq.message.chat.id;
  const action = String(cq.data || '').split(':')[1];
  if (action === 'new') {
    await answer();
    await startRound(app, chatId);
  } else if (action === 'rev') {
    const ok = await reveal(app, chatId, cq.message.message_id, app.lang);
    await answer(ok ? {} : { text: tp(app.lang, 'game.no_round') });
  } else if (action === 'top') {
    await answer();
    await leaderboard(app, chatId, app.lang);
  } else await answer();
  return `game_cb:${action}`;
}

/** @type {any[]} the same buttons in a listener's private chat */
export const routes = [
  {
    ns: 'g', action: 'new', args: [], perm: null,
    async run(app, user) {
      const r = await startRound(app, user.telegram_id, { isPrivate: true });
      if (r === 'started') await app.flows.start(user.telegram_id, 'game', {});
      return {};
    },
  },
  {
    ns: 'g', action: 'rev', args: [], perm: null,
    async run(app, user) {
      await app.flows.clear(user.telegram_id);
      return (await reveal(app, user.telegram_id, null, app.lang)) ? {} : { toast: tp(app.lang, 'game.no_round') };
    },
  },
  { ns: 'g', action: 'top', args: [], perm: null, run: async (app, user) => { await leaderboard(app, user.telegram_id, app.lang); return {}; } },
];

export const flows = {
  // in private, the next messages are guesses while the round is open
  game: {
    perm: null,
    maxInput: 100,
    async run(app, user, message) {
      const r = await guess(app, user.telegram_id, message.from || { id: user.telegram_id, first_name: user.first_name }, String(message.text || ''));
      if (r === 'wrong') await app.tg.send(user.telegram_id, { text: t(app.lang, 'game.wrong'), keyboard: markup([[btn(tp(app.lang, 'game.btn_reveal'), 'g', 'rev')]]) }, 'game_wrong');
      else await app.flows.clear(user.telegram_id);
    },
  },
};
