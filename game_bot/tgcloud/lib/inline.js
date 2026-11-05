/*
 * Inline mode, the main way in: typing @bot in any chat lists the five games in the user's
 * language. Each result posts a message with a URL button to the Direct Link Mini App
 * (web_app buttons aren't allowed in inline messages): t.me/<bot>/<short>?startapp=<payload>.
 * Room games get a fresh random room id per result; the room row is created when the result is
 * chosen (chosen_inline_result, which also carries inline_message_id so the message can be edited
 * with the result) or, if inline feedback is off, by the first player who opens it.
 * "room <id>" (from the Mini App's invite button) lists just that room.
 * Users who haven't joined the forced-join channels get no games, only a button to the bot's chat.
 */
import { APP_URL, ROOM_GAMES } from './config.js';
import { GAME_ICONS, t } from './i18n/index.js';
import { joinStatus } from './join.js';
import { appLink, botUsername, payloadFor } from './links.js';
import { ensureRoom, loadRoom, newRoomId } from './rooms.js';
import * as store from './store.js';
import { call, createCtx, esc, short } from './tg.js';

const ORDER = ['ttt', 'bg', 'hokm', 'codeword', 'fusion'];
const SEATS = { ttt: 2, bg: 2, hokm: 4 };

function article(lang, username, game, roomId, from) {
  const room = ROOM_GAMES.includes(game);
  const name = esc(short(from.first_name || 'A friend'));
  const vars = { icon: GAME_ICONS[game], game: t(lang, `game_${game}`), name };
  const desc = room ? `${t(lang, 'players_n', { n: SEATS[game] })} · ${t(lang, `desc_${game}`)}` : `${t(lang, 'solo')} · ${t(lang, `desc_${game}`)}`;
  const r = {
    type: 'article',
    id: room ? `${game}.${roomId}` : game,
    title: `${GAME_ICONS[game]} ${t(lang, `game_${game}`)}`,
    description: desc,
    input_message_content: { message_text: t(lang, room ? 'inline_invite' : 'inline_solo', vars), parse_mode: 'HTML' },
    reply_markup: { inline_keyboard: [[{ text: t(lang, 'inline_play'), url: appLink(username, payloadFor(game, roomId)) }]] },
  };
  if (APP_URL) {
    r.thumbnail_url = `${APP_URL}thumbs/${game}.png`;
    r.thumbnail_width = 256;
    r.thumbnail_height = 256;
  }
  return r;
}

export async function onInlineQuery(iq) {
  const ctx = createCtx();
  try {
    const user = await store.touchUser(iq.from);
    const lang = user.lang;
    const join = await joinStatus(ctx, iq.from.id);
    if (!join.ok) {
      await call(ctx, 'answerInlineQuery', {
        inline_query_id: iq.id, results: [], cache_time: 0, is_personal: true,
        button: { text: t(lang, 'inline_join'), start_parameter: 'join' },
      }, 'inline-join');
      return { trace: ctx.trace };
    }
    const username = await botUsername(ctx);
    const m = /^room\s+([A-Za-z0-9]{12})$/.exec(String(iq.query || '').trim());
    let results;
    if (m) {
      const room = await loadRoom(m[1]);
      results = room && room.status !== 'expired' ? [article(lang, username, room.game, room.id, iq.from)] : [];
      if (results.length) results[0].title = `${GAME_ICONS[room.game]} ${t(lang, 'inline_room_title', { game: t(lang, `game_${room.game}`) })}`;
    } else {
      results = ORDER.map((g) => article(lang, username, g, ROOM_GAMES.includes(g) ? newRoomId() : null, iq.from));
    }
    await call(ctx, 'answerInlineQuery', { inline_query_id: iq.id, results, cache_time: 0, is_personal: true }, 'inline');
  } catch (err) {
    ctx.error = String((err && err.stack) || err);
    console.error(err);
  }
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  return out;
}

/* A result was sent: create its room (or remember the message on an existing one). */
export async function onChosenInlineResult(chosen) {
  const ctx = createCtx();
  try {
    const [game, roomId] = String(chosen.result_id || '').split('.');
    if (ROOM_GAMES.includes(game) && roomId) {
      const user = await store.touchUser(chosen.from);
      await ensureRoom({ id: roomId, game, creator: chosen.from.id, inlineId: chosen.inline_message_id || null, lang: user.lang });
    }
  } catch (err) {
    ctx.error = String((err && err.stack) || err);
    console.error(err);
  }
  const out = { trace: ctx.trace };
  if (ctx.error) out.error = ctx.error;
  return out;
}
