// Rock, paper, scissors: both players choose in secret; when both have chosen, the hands are shown
// (the server's "reveal" event), the round is scored, and the next one starts. First to three.
import { useEffect, useRef, useState } from 'preact/hooks';
import { seatName } from '../ctx';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';

const HAND: Record<string, string> = { r: '✊', p: '✋', s: '✌️' };
type Reveal = { picks: string[]; winner: number; round: number } | null;

export default function Rps({ room, busy, move }: BoardProps) {
  const s = room.state;
  const me = room.you >= 0 ? room.you : 0;
  const other = 1 - me;
  const [reveal, setReveal] = useState<Reveal>(null);
  const seen = useRef<number>(s.seq);
  const timer = useRef(0);

  useEffect(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const events = (s.log as any[]).filter((x) => x.n > seen.current && x.type === 'reveal');
    seen.current = s.seq;
    if (!events.length) return;
    const e = events[events.length - 1];
    setReveal({ picks: e.picks, winner: e.winner, round: e.round });
    if (room.you >= 0) {
      if (e.winner === room.you) haptic.success();
      else if (e.winner === -1) haptic.soft();
      else haptic.warning();
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setReveal(null), 2300);
  }, [room.ver]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const canPick = room.you >= 0 && room.status === 'playing' && s.picks[me] === null && !reveal;
  const myHand = reveal ? HAND[reveal.picks[me]] : (s.picks[me] ? HAND[s.picks[me]] || '✅' : '❔');
  const otherHand = reveal ? HAND[reveal.picks[other]] : (s.picks[other] ? '✅' : '❔');
  const verdict = reveal ? (reveal.winner === -1 ? t('rps_tie') : reveal.winner === me ? t('result_win') : room.you >= 0 ? t('result_lose') : seatName(room.seats[reveal.winner], t, n)) : '';

  return (
    <div class="rps">
      <div class="rps-meta hint">{t('rps_round', { n: reveal ? reveal.round : s.round })} · {t('rps_first_to', { n: s.target })}</div>
      <div class={`rps-arena${reveal ? ' reveal' : ''}`} key={reveal ? `r${reveal.round}` : 'wait'}>
        <div class={`rps-hand theirs${reveal && reveal.winner === other ? ' win' : ''}`}>
          <span>{otherHand}</span>
          <b class="ellipsis">{seatName(room.seats[other], t, n)}</b>
        </div>
        <div class="rps-vs">{reveal ? verdict : 'VS'}</div>
        <div class={`rps-hand mine${reveal && reveal.winner === me ? ' win' : ''}`}>
          <span>{myHand}</span>
          <b class="ellipsis">{room.you >= 0 ? t('lobby_you') : seatName(room.seats[me], t, n)}</b>
        </div>
      </div>
      <div class="rps-pips">
        {[me, other].map((seat) => (
          <div key={seat} class="rps-pip-row">{Array.from({ length: s.target }, (_, i) => <i key={i} class={i < s.score[seat] ? 'on' : ''} />)}</div>
        ))}
      </div>
      {room.you >= 0 && room.status === 'playing' && (
        <div class="rps-picks">
          {(['r', 'p', 's'] as const).map((p) => (
            <button key={p} class={`rps-pick${s.picks[me] === p ? ' chosen' : ''}`} disabled={!canPick || busy} onClick={() => { haptic.medium(); move({ type: 'pick', pick: p }); }}>
              <span>{HAND[p]}</span>
              {t(`rps_${p}`)}
            </button>
          ))}
        </div>
      )}
      {room.you >= 0 && room.status === 'playing' && s.picks[me] !== null && !reveal && <p class="hint center">{t('rps_chosen')}</p>}
    </div>
  );
}
