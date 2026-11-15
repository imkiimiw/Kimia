// App-wide context: the signed-in user, navigation and language switching.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { GAMES as CONFIG_GAMES, GAME_SEATS, ROOM_GAMES as CONFIG_ROOM_GAMES } from '../tgcloud/lib/config.js';

export type Me = { id: number; name: string; lang: string; owner: boolean };
export type Tab = 'home' | 'ranks' | 'profile' | 'settings';
export type Route =
  | { name: 'tabs'; tab: Tab }
  | { name: 'room'; game: string; room: string }
  | { name: 'codeword' }
  | { name: 'fusion' }
  | { name: 'broadcast' };

export type Ctx = {
  me: Me;
  go: (r: Route) => void;
  back: () => void;
  setTab: (t: Tab) => void;
  setLanguage: (lang: string) => Promise<void>;
};

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export const GAMES: string[] = CONFIG_GAMES;
export const ROOM_GAMES: string[] = CONFIG_ROOM_GAMES;
export const SOLO_GAMES: string[] = CONFIG_GAMES.filter((g: string) => !CONFIG_ROOM_GAMES.includes(g));
/* Games that can end in a draw (their stats show a "draws" column). */
export const DRAW_GAMES = ['ttt', 'reversi', 'chess'];

/* "2 players" / "2–4 players" for a room game. */
export function seatsText(game: string, t: (k: string, v?: Record<string, string | number>) => string) {
  const [min, max] = (GAME_SEATS as Record<string, number[]>)[game];
  return min === max ? t('players_n', { n: max }) : t('players_range', { a: min, b: max });
}

/* A seat's display name: bots are "Bot 1", "Bot 2" in the user's language. */
export function seatName(seat: { name: string; bot?: boolean } | null | undefined, t: (k: string) => string, n: (x: number | string) => string) {
  if (!seat) return '';
  if (!seat.bot) return seat.name;
  /* a bot that took over from a player who left keeps that player's name */
  return /^\d+$/.test(seat.name) ? `${t('lobby_bot')} ${n(seat.name)}` : `🤖 ${seat.name}`;
}
