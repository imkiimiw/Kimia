// App-wide context: the signed-in user, navigation and language switching.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

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

export const ROOM_GAMES = ['ttt', 'bg', 'hokm'];
export const SOLO_GAMES = ['codeword', 'fusion'];

/* A seat's display name: bots are "Bot 1", "Bot 2" in the user's language. */
export function seatName(seat: { name: string; bot?: boolean } | null | undefined, t: (k: string) => string, n: (x: number | string) => string) {
  if (!seat) return '';
  return seat.bot ? `${t('lobby_bot')} ${n(seat.name)}` : seat.name;
}
