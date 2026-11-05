// Hokm table: you at the bottom, your partner on top, opponents left and right (play goes to the
// right). The server's event log is replayed with timing — each card flies in from its player,
// a full trick is collected toward its winner, new hands are dealt in — so bot plays read like moves.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as hk from '../../tgcloud/lib/games/hokm.js';
import { seatName } from '../ctx';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { Avatar, Icon, TimerRing, toast } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SUIT: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const ORDER = ['S', 'H', 'C', 'D'];
const RED = (s: string) => s === 'H' || s === 'D';
const RANK = (r: number) => (r === 14 ? 'A' : r === 13 ? 'K' : r === 12 ? 'Q' : r === 11 ? 'J' : String(r));
const SPOT = ['bottom', 'right', 'top', 'left'];

export function Card({ card, cls = '', style, onClick }: { card: string; cls?: string; style?: Record<string, string | number>; onClick?: () => void }) {
  const s = card[0];
  const r = RANK(Number(card.slice(1)));
  return (
    <div class={`pcard${RED(s) ? ' red' : ''} ${cls}`} style={style} onClick={onClick}>
      <span class="pc-corner">{r}<br />{SUIT[s]}</span>
      <span class="pc-mid">{SUIT[s]}</span>
      <span class="pc-corner flip">{r}<br />{SUIT[s]}</span>
    </div>
  );
}

const sortHand = (hand: string[]) => hand.slice().sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || Number(b.slice(1)) - Number(a.slice(1)));

type Shown = { trick: { seat: number; card: string }[]; collectTo: number };

export default function Hokm({ room, busy, move }: BoardProps) {
  const st = room.state;
  const me = room.you >= 0 ? room.you : 0;
  const rel = (seat: number) => (seat - me + 4) % 4;
  const [shown, setShown] = useState<Shown>({ trick: st.trick, collectTo: -1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [banner, setBanner] = useState('');
  const [dealKey, setDealKey] = useState(0);
  const [animating, setAnimating] = useState(false);
  const seen = useRef<number>(st.seq);
  const freeAt = useRef(0);

  useEffect(() => {
    const events = (st.log as any[]).filter((e) => e.n > seen.current);
    seen.current = st.seq;
    setSelected(null);
    const finalTrick = st.trick;
    const at = (ms: number, fn: () => void) => window.setTimeout(fn, Math.max(0, freeAt.current - Date.now()) + ms);
    let d = 0;
    if (events.length) setAnimating(true);
    const nameOf = (seat: number) => (seat === room.you ? t('lobby_you') : seatName(room.seats[seat], t, n));
    for (const e of events) {
      if (e.type === 'play') {
        at(d, () => {
          setShown((s) => ({ trick: s.collectTo >= 0 ? [{ seat: e.seat, card: e.card }] : s.trick.concat([{ seat: e.seat, card: e.card }]), collectTo: -1 }));
          haptic.soft();
        });
        d += e.seat === room.you ? 120 : 520;
      } else if (e.type === 'trick') {
        d += 650;
        at(d, () => setShown((s) => ({ ...s, collectTo: e.seat })));
        d += 520;
        at(d, () => setShown({ trick: [], collectTo: -1 }));
      } else if (e.type === 'trump') {
        at(d, () => setBanner(`${t('hokm_trump')}: ${SUIT[e.suit]}`));
        d += 1100;
        at(d, () => setBanner(''));
      } else if (e.type === 'hand') {
        const us = e.team === me % 2;
        at(d, () => {
          setBanner(`${t('hokm_hand_won', { team: us ? t('hokm_us') : t('hokm_them'), p: e.points })}${e.kot ? ` · ${t('hokm_kot')}` : ''}`);
          if (us) haptic.success(); else haptic.warning();
        });
        d += 1500;
        at(d, () => setBanner(''));
      } else if (e.type === 'deal') {
        at(d, () => setDealKey((k) => k + 1));
      } else if (e.type === 'hakem') {
        at(d, () => setBanner(`👑 ${t('hokm_hakem')}: ${nameOf(e.seat)}`));
        d += 1300;
        at(d, () => setBanner(''));
      }
    }
    at(d + 40, () => {
      setShown({ trick: finalTrick, collectTo: -1 });
      setAnimating(false);
    });
    freeAt.current = Math.max(freeAt.current, Date.now()) + d + 40;
  }, [room.ver]);

  const hand: string[] = sortHand(st.hands[me] || []);
  const mineTurn = room.you >= 0 && room.status === 'playing' && st.turn === room.you;
  const legal = mineTurn && st.phase === 'play' ? hk.legalCards(st.hands[me], st.trick) : [];
  const myTeam = me % 2;

  async function tap(card: string) {
    if (!mineTurn || st.phase !== 'play' || busy || animating) {
      haptic.warning();
      return;
    }
    if (!legal.includes(card)) {
      toast(t('hokm_follow'), 'bad');
      return;
    }
    if (selected !== card) {
      haptic.select();
      setSelected(card);
      return;
    }
    haptic.medium();
    setSelected(null);
    await move({ type: 'play', card });
  }

  const Opp = ({ seat }: { seat: number }) => {
    const s = room.seats[seat];
    const count = st.counts?.[seat] ?? 0;
    return (
      <div class={`opp opp-${SPOT[rel(seat)]}${st.turn === seat && room.status === 'playing' ? ' turn' : ''}`}>
        <div class="opp-avatar">
          <Avatar name={s?.name || '?'} size="sm" bot={s?.bot} seed={(s?.name || '') + seat} />
          {st.hakem === seat && <span class="crown"><Icon name="crown" size={13} fill /></span>}
          {st.turn === seat && room.status === 'playing' && !animating && <span class="opp-timer"><TimerRing key={room.ver} left={room.left} total={room.turnSec} size={26} /></span>}
        </div>
        <span class="opp-name ellipsis">{seatName(s, t, n)}</span>
        <div class="backs">{Array.from({ length: Math.min(count, 7) }, (_, i) => <i key={i} />)}<b>{n(count)}</b></div>
      </div>
    );
  };

  return (
    <div class="hokm">
      <div class="hokm-score">
        <div class={`team-score us`}><span>{t('hokm_us')}</span><b>{n(st.score[myTeam])}</b><em>{Array.from({ length: 7 }, (_, i) => <i key={i} class={i < st.tricks[myTeam] ? 'on' : ''} />)}</em></div>
        <div class="trump-badge">
          <span class="hint">{t('hokm_trump')}</span>
          <b class={st.trump && RED(st.trump) ? 'red' : ''}>{st.trump ? SUIT[st.trump] : '?'}</b>
        </div>
        <div class={`team-score them`}><span>{t('hokm_them')}</span><b>{n(st.score[1 - myTeam])}</b><em>{Array.from({ length: 7 }, (_, i) => <i key={i} class={i < st.tricks[1 - myTeam] ? 'on' : ''} />)}</em></div>
      </div>

      <div class="table">
        {[1, 2, 3].map((r) => <Opp key={r} seat={(me + r) % 4} />)}
        <div class={`trick${shown.collectTo >= 0 ? ` collect-${SPOT[rel(shown.collectTo)]}` : ''}`}>
          {shown.trick.map((p) => <Card key={p.card} card={p.card} cls={`played from-${SPOT[rel(p.seat)]}`} />)}
        </div>
        {banner && <div class="table-banner" key={banner}>{banner}</div>}
        {st.phase === 'trump' && st.turn !== room.you && room.status === 'playing' && !banner && (
          <div class="table-banner soft">{t('hokm_waiting_trump', { name: seatName(room.seats[st.turn], t, n) })}</div>
        )}
        {mineTurn && st.phase === 'play' && !animating && <div class="your-turn">{t('turn_you')}</div>}
      </div>

      {room.you >= 0 && (
        <div class={`hand${mineTurn && st.phase === 'play' ? ' live' : ''}`} key={dealKey} style={{ '--n': hand.length } as Record<string, number>}>
          {hand.map((c, i) => (
            <Card
              key={c}
              card={c}
              cls={`${selected === c ? 'sel' : ''}${legal.length && !legal.includes(c) ? ' dim' : ''}`}
              style={{ '--i': i }}
              onClick={() => tap(c)}
            />
          ))}
        </div>
      )}

      {mineTurn && st.phase === 'trump' && (
        <div class="overlay">
          <div class="sheet">
            <h2>{t('hokm_choose_trump')}</h2>
            <div class="trump-hand">{hand.map((c, i) => <Card key={c} card={c} style={{ '--i': i }} />)}</div>
            <div class="trump-pick">
              {hk.SUITS.map((s: string) => (
                <button key={s} class={`suit-btn${RED(s) ? ' red' : ''}`} disabled={busy} onClick={() => { haptic.medium(); move({ type: 'trump', suit: s }); }}>{SUIT[s]}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
