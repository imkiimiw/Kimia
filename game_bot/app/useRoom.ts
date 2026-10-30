// A multiplayer room as seen by this player: joins on open, then polls getState(room, since) —
// about every 1.1 s while someone else is to move, slower on your own turn, in the lobby or after
// the game, slower still when nothing has happened for a while, and not at all while the Mini App
// is hidden. Moves and lobby actions go to the server, which answers with the new state.
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';
import { ApiError, call, haptic, onActiveChange } from './tg';
import { toast } from './ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RoomView = any;

const ERRORS: Record<string, string> = {
  NO_ROOM: 'error_room',
  BAD_ROOM: 'error_room',
  MUST_FOLLOW_SUIT: 'hokm_follow',
};

export function errorText(e: unknown) {
  const code = e instanceof ApiError ? e.code : '';
  return t(ERRORS[code] || (code === 'NETWORK' ? 'error_network' : 'error_generic'));
}

export function myTurn(room: RoomView) {
  return !!room && room.status === 'playing' && room.state && room.you >= 0 && room.state.turn === room.you;
}

function interval(room: RoomView, idleMs: number) {
  if (!room) return 1500;
  let ms = 2000;
  if (room.status === 'waiting') ms = 1500;
  else if (room.status === 'playing') ms = myTurn(room) ? 2500 : 1100;
  else if (room.status === 'finished') ms = 2000;
  else ms = 6000;
  if (idleMs > 90000) ms = Math.max(ms, 4000);
  return ms;
}

export function useRoom(game: string, roomId: string) {
  const [room, setRoom] = useState<RoomView>(null);
  const [fatal, setFatal] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef({ room: null as RoomView, timer: 0, active: true, failures: 0, changedAt: Date.now(), alive: true, busy: false });

  const apply = useCallback((v: RoomView) => {
    const s = ref.current;
    if (!v || v.same) return;
    if (!s.room || v.ver !== s.room.ver) s.changedAt = Date.now();
    s.room = v;
    setRoom(v);
  }, []);

  const schedule = useCallback((ms?: number) => {
    const s = ref.current;
    window.clearTimeout(s.timer);
    if (!s.alive) return;
    const wait = ms ?? interval(s.room, Date.now() - s.changedAt) * Math.min(8, 2 ** s.failures);
    s.timer = window.setTimeout(poll, wait);
  }, []);

  const poll = useCallback(async () => {
    const s = ref.current;
    if (!s.alive) return;
    if (!s.active || s.busy) {
      schedule(1000);
      return;
    }
    try {
      const v = await call('getState', { room: roomId, since: s.room ? s.room.ver : -1 });
      s.failures = 0;
      apply(v);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'NO_ROOM' || e.code === 'BAD_ROOM')) {
        setFatal(errorText(e));
        return;
      }
      s.failures += 1;
      if (s.failures === 2) toast(t('error_network'), 'bad');
    }
    schedule();
  }, [roomId]);

  useEffect(() => {
    const s = ref.current;
    s.alive = true;
    call('joinRoom', { room: roomId, game })
      .then((v) => {
        apply(v);
        schedule();
      })
      .catch((e) => setFatal(errorText(e)));
    const off = onActiveChange((active) => {
      s.active = active;
      if (active) schedule(0);
    });
    return () => {
      s.alive = false;
      window.clearTimeout(s.timer);
      off();
    };
  }, [roomId]);

  /* Sends a move; false if the server refused it (the error is shown). */
  const move = useCallback(async (action: Record<string, unknown>) => {
    const s = ref.current;
    if (s.busy) return false;
    s.busy = true;
    setBusy(true);
    try {
      apply(await call('move', { room: roomId, ver: s.room?.ver, action }));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE' && e.params.room) apply(e.params.room);
      else if (e instanceof ApiError && e.code === 'STALE') schedule(0);
      else toast(errorText(e), 'bad');
      haptic.error();
      return false;
    } finally {
      s.busy = false;
      setBusy(false);
      schedule();
    }
  }, [roomId]);

  const action = useCallback(async (input: Record<string, unknown>) => {
    const s = ref.current;
    s.busy = true;
    setBusy(true);
    try {
      apply(await call('roomAction', { room: roomId, ...input }));
      return true;
    } catch (e) {
      toast(errorText(e), 'bad');
      return false;
    } finally {
      s.busy = false;
      setBusy(false);
      schedule();
    }
  }, [roomId]);

  return { room, fatal, busy, move, action };
}
