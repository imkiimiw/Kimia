// Reversi board: tap a marked cell to play; captured discs flip over. The legal cells come from the
// shared rules (tgcloud/lib/games/reversi.js); the server decides.
import { useEffect, useRef } from 'preact/hooks';
import * as rules from '../../tgcloud/lib/games/reversi.js';
import { seatName } from '../ctx';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { toast } from '../ui';
import { myTurn } from '../useRoom';

export default function Reversi({ room, busy, move }: BoardProps) {
  const s = room.state;
  const mine = myTurn(room);
  const legal: number[] = mine ? rules.legalMoves(s.b, room.you) : [];
  const seen = useRef<number>(s.seq);

  useEffect(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (const e of (s.log as any[]).filter((x) => x.n > seen.current)) {
      if (e.type === 'pass') toast(t('reversi_pass', { name: e.seat === room.you ? t('lobby_you') : seatName(room.seats[e.seat], t, n) }));
      if (e.type === 'place' && e.seat !== room.you) haptic.soft();
    }
    seen.current = s.seq;
  }, [room.ver]);

  async function tap(i: number) {
    if (!mine || busy) return;
    if (!legal.includes(i)) {
      haptic.warning();
      return;
    }
    haptic.tap();
    await move({ type: 'place', cell: i });
  }

  return (
    <div class="rv">
      <div class="rv-count">
        <span class={`rv-chip${s.turn === 0 ? ' on' : ''}`}><i class="disc B" /> {n(s.count[0])}</span>
        <span class={`rv-chip${s.turn === 1 ? ' on' : ''}`}>{n(s.count[1])} <i class="disc W" /></span>
      </div>
      <div class={`rv-board${mine ? ' live' : ''}`}>
        {Array.from(s.b as string).map((c, i) => (
          <button key={i} class={`rv-cell${legal.includes(i) ? ' hint' : ''}${s.last === i ? ' last' : ''}`} onClick={() => tap(i)} aria-label={`cell ${i + 1}`}>
            {c !== '.' && <i key={`${s.round}-${c}`} class={`disc ${c}`} />}
          </button>
        ))}
      </div>
    </div>
  );
}
