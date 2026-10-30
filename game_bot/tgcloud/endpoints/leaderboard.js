/* { game, scope: global | chat }: the top 20 and the caller's rank. "chat" needs a direct-link launch from a chat. */
import { GAMES } from '../lib/config.js';
import { endpoint, fail } from '../lib/endpoint.js';
import { leaderboard } from '../lib/store.js';

export default endpoint(async (input, env) => {
  if (!GAMES.includes(input.game)) throw fail('BAD_GAME');
  const chat = input.scope === 'chat' ? env.chat : null;
  const b = await leaderboard(input.game, env.user.user_id, chat);
  return {
    game: input.game, scope: chat ? 'chat' : 'global', hasChat: !!env.chat, me: b.me, rank: b.rank,
    top: b.top.map((r) => ({ name: r.first_name || '—', score: Number(r.score), me: Number(r.user_id) === env.user.user_id })),
  };
});
