/* The caller's stats for every game. */
import { endpoint } from '../lib/endpoint.js';
import { userStats } from '../lib/store.js';

export default endpoint(async (input, env) => {
  const rows = await userStats(env.user.user_id);
  const games = {};
  for (const r of rows) games[r.game] = { played: Number(r.played), wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws), score: Number(r.score) };
  return { games };
});
