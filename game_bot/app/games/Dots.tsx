// Dots and boxes: tap the gap between two dots to draw a line; closing a box colours it and gives
// another move.
import { useEffect, useRef } from 'preact/hooks';
import * as rules from '../../tgcloud/lib/games/dots.js';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { toast } from '../ui';
import { myTurn } from '../useRoom';

const N: number = rules.N;
const STEP = 56;
const PAD = 22;
const SIZE = N * STEP + PAD * 2;
const at = (k: number) => PAD + k * STEP;

export default function Dots({ room, busy, move }: BoardProps) {
  const s = room.state;
  const mine = myTurn(room);
  const seen = useRef<number>(s.seq);

  useEffect(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const e of (s.log as any[]).filter((x) => x.n > seen.current)) {
      if (e.type !== 'line') continue;
      if (e.boxes.length) {
        if (e.seat === room.you) {
          haptic.success();
          if (s.turn === room.you) toast(t('dots_again'), 'good');
        } else haptic.warning();
      } else if (e.seat !== room.you) haptic.soft();
    }
    seen.current = s.seq;
  }, [room.ver]);

  async function draw(o: 'h' | 'v', i: number) {
    if (!mine || busy || s[o][i] !== '0') return;
    haptic.tap();
    await move({ type: 'line', o, i });
  }

  const lines = [];
  for (let i = 0; i < rules.H_LINES; i += 1) {
    const r = Math.floor(i / N);
    const c = i % N;
    lines.push({ o: 'h' as const, i, x1: at(c), y1: at(r), x2: at(c + 1), y2: at(r) });
  }
  for (let i = 0; i < rules.V_LINES; i += 1) {
    const r = Math.floor(i / (N + 1));
    const c = i % (N + 1);
    lines.push({ o: 'v' as const, i, x1: at(c), y1: at(r), x2: at(c), y2: at(r + 1) });
  }

  return (
    <div class="db">
      <div class="rv-count">
        <span class={`rv-chip${s.turn === 0 ? ' on' : ''}`}><i class="db-dot p0" /> {n(s.count[0])}</span>
        <span class={`rv-chip${s.turn === 1 ? ' on' : ''}`}>{n(s.count[1])} <i class="db-dot p1" /></span>
      </div>
      <svg class={`db-board${mine ? ' live' : ''}`} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {Array.from(s.own as string).map((o, k) => o !== '.' && (
          <rect key={`b${k}`} class={`db-box p${o}`} x={at(k % N) + 5} y={at(Math.floor(k / N)) + 5} width={STEP - 10} height={STEP - 10} rx="9" />
        ))}
        {lines.map((l) => {
          const drawn = s[l.o][l.i] === '1';
          const last = s.last && s.last.o === l.o && s.last.i === l.i;
          return (
            <g key={`${l.o}${l.i}`} onClick={() => draw(l.o, l.i)}>
              <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} class={`db-line${drawn ? ' drawn' : ''}${last ? ' last' : ''}`} />
              {!drawn && <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} class="db-hit" />}
            </g>
          );
        })}
        {Array.from({ length: (N + 1) * (N + 1) }, (_, k) => (
          <circle key={`d${k}`} class="db-point" cx={at(k % (N + 1))} cy={at(Math.floor(k / (N + 1)))} r="5.5" />
        ))}
      </svg>
    </div>
  );
}
