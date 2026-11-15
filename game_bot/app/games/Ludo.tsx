// Ludo board (SVG, 15×15 cells). The server's event log is replayed with timing — the die rolls,
// the piece moves, a captured piece goes back to its base — so the other players' turns (and the
// bots') read as moves. The board is turned so that your own base is at the bottom left.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as rules from '../../tgcloud/lib/games/ludo.js';
import { seatName } from '../ctx';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { Avatar, Button, Die, TimerRing, toast } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6'];
const RING: number[][] = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0], [8, 0],
  [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7], [14, 8],
  [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14], [6, 14],
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7], [0, 6],
];
const HOME_COL: number[][][] = [
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
];
const HOME_SPOT = [[6.05, 7], [7, 6.05], [7.95, 7], [7, 7.95]];
const BASE = [[0, 0], [9, 0], [9, 9], [0, 9]];
const SPOTS = [[1.5, 1.5], [3.5, 1.5], [1.5, 3.5], [3.5, 3.5]];
const TRIANGLES = ['60,60 60,90 75,75', '60,60 90,60 75,75', '90,60 90,90 75,75', '60,90 90,90 75,75'];
const TURN_DEG = [-90, 180, 90, 0];

/* The centre of where a piece stands, in board units (a cell is 10). */
function place(seat: number, piece: number, steps: number): number[] {
  let c: number[];
  if (steps < 0) c = [BASE[seat][0] + SPOTS[piece][0], BASE[seat][1] + SPOTS[piece][1]];
  else if (steps <= 50) c = RING[rules.absCell(seat, steps)];
  else if (steps < rules.HOME) c = HOME_COL[seat][steps - 51];
  else c = HOME_SPOT[seat];
  return [c[0] * 10 + 5, c[1] * 10 + 5];
}

type Pos = (number[] | null)[];
const copy = (p: Pos): Pos => p.map((x) => (x ? x.slice() : null));

export default function Ludo({ room, busy, move }: BoardProps) {
  const st = room.state;
  const [shown, setShown] = useState<Pos>(() => copy(st.pos));
  const [die, setDie] = useState<number>(st.die);
  const [rollKey, setRollKey] = useState(0);
  const [pending, setPending] = useState(0);
  const seen = useRef<number>(st.seq);
  const freeAt = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const events = (st.log as any[]).filter((e) => e.n > seen.current);
    seen.current = st.seq;
    const final = copy(st.pos);
    if (!events.length) {
      if (!pending) setShown(final);
      return;
    }
    setPending((p) => p + 1);
    let d = Math.max(0, freeAt.current - Date.now());
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    for (const e of events) {
      if (e.type === 'roll') {
        at(d, () => {
          setDie(e.die);
          setRollKey((k) => k + 1);
          haptic.soft();
        });
        d += e.seat === room.you ? 520 : 700;
      } else if (e.type === 'move') {
        at(d, () => {
          setShown((prev) => {
            const next = copy(prev);
            if (next[e.seat]) next[e.seat]![e.piece] = e.to;
            return next;
          });
          if (e.to === rules.HOME) haptic.success();
          else haptic.tap();
        });
        if (e.captured.length) {
          d += 330;
          at(d, () => {
            setShown((prev) => {
              const next = copy(prev);
              for (const c of e.captured) if (next[c.seat]) next[c.seat]![c.piece] = -1;
              return next;
            });
            haptic.heavy();
          });
        }
        d += 460;
      } else if (e.type === 'pass') {
        at(d, () => {
          if (e.seat === room.you) toast(t('ludo_no_move'));
        });
        d += 380;
      }
    }
    at(d, () => {
      setShown(final);
      setPending((p) => p - 1);
    });
    freeAt.current = Date.now() + d;
  }, [room.ver]);
  useEffect(() => () => timers.current.forEach((x) => window.clearTimeout(x)), []);

  const animating = pending > 0;
  const you = room.you;
  const myMove = !animating && room.status === 'playing' && you >= 0 && st.turn === you;
  const movable: number[] = myMove && st.phase === 'move' ? rules.legalMoves(st, you, st.die).map((m: any) => m.piece) : [];

  /* pieces that share a spot are spread a little */
  const spots = new Map<string, number>();
  const counts = new Map<string, number>();
  const pieces: { seat: number; piece: number; x: number; y: number; key: string }[] = [];
  for (const seat of st.active as number[]) {
    (shown[seat] || []).forEach((steps, piece) => {
      const [x, y] = place(seat, piece, steps);
      const key = `${x},${y}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      pieces.push({ seat, piece, x, y, key });
    });
  }
  const order = (st.active as number[]).slice().sort((a, b) => ((a - Math.max(you, 0) + 4) % 4) - ((b - Math.max(you, 0) + 4) % 4));

  return (
    <div class="ludo">
      <div class="ludo-players">
        {order.map((seat) => {
          const s = room.seats[seat];
          const on = st.turn === seat && room.status === 'playing';
          const home = (st.pos[seat] as number[]).filter((p) => p === rules.HOME).length;
          return (
            <div key={seat} class={`ludo-player${on ? ' on' : ''}`} style={{ '--c': COLORS[seat] } as Record<string, string>}>
              <Avatar name={s?.name || '?'} size="sm" bot={s?.bot} seed={(s?.name || '') + seat} />
              <div class="player-name">
                <b class="ellipsis">{s?.me ? t('lobby_you') : seatName(s, t, n)}</b>
                <span>{t('ludo_home', { n: home })}</span>
              </div>
              {on && !animating && <TimerRing key={room.ver} left={room.left} total={room.turnSec} size={28} />}
            </div>
          );
        })}
      </div>

      <svg class="ludo-board" viewBox="0 0 150 150" style={{ transform: `rotate(${you >= 0 ? TURN_DEG[you] : 0}deg)` }}>
        <rect width="150" height="150" rx="9" class="lb-bg" />
        {BASE.map(([ox, oy], seat) => (
          <g key={`base${seat}`} opacity={(st.active as number[]).includes(seat) ? 1 : 0.35}>
            <rect x={ox * 10} y={oy * 10} width="60" height="60" rx="8" fill={COLORS[seat]} />
            <rect x={ox * 10 + 9} y={oy * 10 + 9} width="42" height="42" rx="9" class="lb-yard" />
            {SPOTS.map(([sx, sy], k) => <circle key={k} cx={(ox + sx) * 10 + 5} cy={(oy + sy) * 10 + 5} r="4.6" fill={COLORS[seat]} opacity=".28" />)}
          </g>
        ))}
        {RING.map(([c, r], i) => {
          const start = rules.START.indexOf(i);
          const star = start < 0 && rules.SAFE.includes(i);
          return (
            <g key={`r${i}`}>
              <rect x={c * 10 + 0.4} y={r * 10 + 0.4} width="9.2" height="9.2" rx="1.6" class="lb-cell" fill={start >= 0 ? COLORS[start] : star ? '#e8ecf5' : '#ffffff'} />
              {star && <path class="lb-star" transform={`translate(${c * 10 + 5} ${r * 10 + 5})`} d="M0-3.2 0.9-1 3.1-1 1.3 0.4 2 2.7 0 1.3-2 2.7-1.3 0.4-3.1-1-0.9-1z" />}
            </g>
          );
        })}
        {HOME_COL.map((col, seat) => col.map(([c, r], k) => (
          <rect key={`h${seat}${k}`} x={c * 10 + 0.4} y={r * 10 + 0.4} width="9.2" height="9.2" rx="1.6" fill={COLORS[seat]} opacity=".85" />
        )))}
        {TRIANGLES.map((pts, seat) => <polygon key={`t${seat}`} points={pts} fill={COLORS[seat]} />)}
        {pieces.map((p) => {
          const k = spots.get(p.key) || 0;
          spots.set(p.key, k + 1);
          const total = counts.get(p.key) || 1;
          const a = (2 * Math.PI * k) / total;
          const off = total > 1 ? 2.3 : 0;
          const can = p.seat === you && movable.includes(p.piece);
          return (
            <g key={`${p.seat}-${p.piece}`} class={`lp${can ? ' can' : ''}`} style={{ transform: `translate(${p.x + Math.cos(a) * off}px, ${p.y + Math.sin(a) * off}px)` }}
              onClick={() => { if (can && !busy) { haptic.tap(); move({ type: 'move', piece: p.piece }); } }}>
              {can && <circle r="6.4" class="lp-ring" />}
              <circle r="3.9" fill={COLORS[p.seat]} class="lp-body" />
              <circle r="1.5" class="lp-dot" />
              <circle r="7" fill="transparent" />
            </g>
          );
        })}
      </svg>

      <div class="ludo-controls">
        <div class="dice" key={rollKey}>{die > 0 && <Die v={die} rolling={rollKey > 0} />}</div>
        <div class="spacer" />
        {myMove && st.phase === 'roll' && <Button disabled={busy} onClick={() => move({ type: 'roll' })}>🎲 {t('ludo_roll')}</Button>}
        {myMove && st.phase === 'move' && <span class="ludo-hint">{t('ludo_pick')}</span>}
        {!myMove && room.status === 'playing' && st.turn >= 0 && st.turn !== you && (
          <span class="hint">{t('turn_other', { name: seatName(room.seats[st.turn], t, n) })}</span>
        )}
      </div>
    </div>
  );
}
