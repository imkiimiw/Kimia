// Chess board: tap a piece to see where it may go (from the shared rules), tap a target to move.
// Black sees the board from Black's side. The pieces are drawn here as SVG (no font or image needed).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as rules from '../../tgcloud/lib/games/chess.js';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { myTurn } from '../useRoom';

/* eslint-disable @typescript-eslint/no-explicit-any */
const BASE = 'M10.5 40v-2.3c0-.9.8-1.7 1.7-1.7h20.6c.9 0 1.7.8 1.7 1.7V40z';
const FOOT = 'M14 36l1.6-5h13.8l1.6 5z';
const SHAPES: Record<string, string[]> = {
  p: ['M22.5 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z', 'M22.5 17c-4.2 0-7 4.4-7 8.6 0 2.2.9 4 2.3 5.4h9.4c1.4-1.4 2.3-3.2 2.3-5.4 0-4.2-2.8-8.6-7-8.6z'],
  r: ['M12 7h4.6v3.6h3.8V7h4.2v3.6h3.8V7H33v9l-3.6 3.2V31h-13.8V19.2L12 16z'],
  n: ['M14.2 31c.2-6.6 2.2-10.8 5.6-14l-3.9-.9 5-5.6.9-4 3.9 3.2c5.9 1.6 9.3 6.6 9.3 13.6V31z'],
  b: ['M22.5 5.5a2.9 2.9 0 0 0-1.9 5.1c-3.5 2.3-6 6.4-6 10.2 0 3.4 1.7 6 3.7 8.2h8.4c2-2.2 3.7-4.8 3.7-8.2 0-3.8-2.5-7.9-6-10.2a2.9 2.9 0 0 0-1.9-5.1z'],
  q: ['M8.5 13.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM15.5 9.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM22.5 8.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM29.5 9.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM36.5 13.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
    'M8.6 14.5l4.2 16.500h19.4l4.2-16.5-6.8 9.2-.6-12.9-6.5 11.7-6.5-11.7-.6 12.900z'],
  k: ['M21 2.500h3v3h3v3h-3v4h-3v-4h-3v-3h3z', 'M22.5 14c-6.4 0-11 3.4-11 8.4 0 3.2 1.5 6.2 3.3 8.600h15.400c1.8-2.4 3.3-5.4 3.3-8.6 0-5-4.6-8.4-11-8.400z'],
};

export function Piece({ p }: { p: string }) {
  const kind = p.toLowerCase();
  return (
    <svg viewBox="0 0 45 45" class={`cp ${p === kind ? 'black' : 'white'}`}>
      {SHAPES[kind].map((d, i) => <path key={i} d={d} />)}
      <path d={FOOT} />
      <path d={BASE} />
      {kind === 'n' && <circle cx="24.5" cy="14.5" r="1.3" class="cp-eye" />}
      {kind === 'b' && <path d="M20.3 16.5l4.4 4.4" class="cp-line" />}
    </svg>
  );
}

const START_COUNT: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/* The pieces of colour `white` that are no longer on the board, strongest first. */
function captured(b: string, white: boolean) {
  const out: string[] = [];
  for (const kind of ['q', 'r', 'b', 'n', 'p']) {
    const ch = white ? kind.toUpperCase() : kind;
    const missing = START_COUNT[kind] - (b.split(ch).length - 1);
    for (let i = 0; i < missing; i += 1) out.push(ch);
  }
  return out;
}

export default function Chess({ room, busy, move }: BoardProps) {
  const st = room.state;
  const mine = myTurn(room);
  const flipped = room.you === 1;
  const [sel, setSel] = useState(-1);
  const [promo, setPromo] = useState<{ from: number; to: number } | null>(null);
  const seen = useRef<number>(st.seq);
  const legal: any[] = useMemo(() => (mine ? rules.legalMoves(st) : []), [room.ver, mine]);
  const targets = legal.filter((m) => m.from === sel);

  useEffect(() => {
    setSel(-1);
    setPromo(null);
    for (const e of (st.log as any[]).filter((x) => x.n > seen.current)) {
      if (e.seat === room.you) continue;
      if (e.check) haptic.warning();
      else if (e.captured) haptic.medium();
      else haptic.soft();
    }
    seen.current = st.seq;
  }, [room.ver]);

  async function go(from: number, to: number, piece?: string) {
    haptic.tap();
    setSel(-1);
    setPromo(null);
    await move({ type: 'move', from, to, promo: piece });
  }

  function tap(sq: number) {
    if (!mine || busy || promo) return;
    const hit = targets.filter((m) => m.to === sq);
    if (hit.length) {
      if (hit[0].promo) setPromo({ from: sel, to: sq });
      else go(sel, sq);
      return;
    }
    if (legal.some((m) => m.from === sq)) {
      haptic.select();
      setSel(sq);
    } else setSel(-1);
  }

  const order = Array.from({ length: 64 }, (_, i) => (flipped ? 63 - i : i));
  const kingInCheck = st.check ? (st.b as string).indexOf(st.t === 'w' ? 'K' : 'k') : -1;
  const myWhite = room.you !== 1;
  const taken = (white: boolean) => <div class="ch-taken">{captured(st.b, white).map((p, i) => <Piece key={i} p={p} />)}</div>;

  return (
    <div class="ch">
      {taken(myWhite)}
      <div class={`ch-board${mine ? ' live' : ''}`}>
        {order.map((sq, k) => {
          const p = (st.b as string)[sq];
          const r = sq >> 3;
          const c = sq & 7;
          const target = targets.some((m) => m.to === sq);
          const last = st.last && (st.last.from === sq || st.last.to === sq);
          return (
            <button key={sq} class={`ch-sq ${(r + c) % 2 ? 'dark' : 'light'}${sel === sq ? ' sel' : ''}${last ? ' last' : ''}${kingInCheck === sq ? ' check' : ''}`} onClick={() => tap(sq)}>
              {k % 8 === 0 && <span class="ch-rank">{8 - r}</span>}
              {k >= 56 && <span class="ch-file">{'abcdefgh'[c]}</span>}
              {p !== '.' && <span key={`${p}${st.last && st.last.to === sq ? st.seq : ''}`} class={`ch-piece${st.last && st.last.to === sq ? ' moved' : ''}`}><Piece p={p} /></span>}
              {target && <i class={p !== '.' ? 'ch-ring' : 'ch-dot'} />}
            </button>
          );
        })}
        {promo && (
          <div class="ch-promo" onClick={() => setPromo(null)}>
            <div class="ch-promo-box" onClick={(e) => e.stopPropagation()}>
              <span class="hint">{t('chess_promote')}</span>
              <div class="row">
                {['q', 'r', 'b', 'n'].map((k) => (
                  <button key={k} class="ch-promo-btn" onClick={() => go(promo.from, promo.to, k)}><Piece p={myWhite ? k.toUpperCase() : k} /></button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {taken(!myWhite)}
      <div class="ch-status">
        {st.result ? <b>{t(`chess_${st.result}`)}</b> : st.check ? <b class="warn">{t('chess_check')}</b> : <span class="hint">{t(st.t === 'w' ? 'chess_white' : 'chess_black')} · {n(st.full)}</span>}
      </div>
    </div>
  );
}
