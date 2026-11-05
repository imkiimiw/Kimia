// Backgammon board (SVG). Each checker keeps an identity, so moves glide from point to point: the
// opponent's turn is replayed one move at a time, and your own turn is built locally (legal targets
// come from the shared rules in tgcloud/lib/games/backgammon.js), then sent as one move.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as bg from '../../tgcloud/lib/games/backgammon.js';
import { seatName } from '../ctx';
import { n, t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { Button, Icon, toast } from '../ui';
import { myTurn } from '../useRoom';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Loc = number | 'bar' | 'off';
type Move = { f: number | 'bar'; t: number | 'off'; d: number };
type Checker = { id: number; c: number; loc: Loc };

const W = 130 / 6;
const R = 9.6;

function fromState(st: any): Checker[] {
  const out: Checker[] = [];
  for (let c = 0; c < 2; c += 1) {
    let id = c * 15;
    for (let p = 1; p <= 24; p += 1) {
      const v = st.pts[p - 1];
      const count = c === 0 ? Math.max(v, 0) : Math.max(-v, 0);
      for (let k = 0; k < count; k += 1) out.push({ id: id++, c, loc: p });
    }
    for (let k = 0; k < st.bar[c]; k += 1) out.push({ id: id++, c, loc: 'bar' });
    for (let k = 0; k < st.off[c]; k += 1) out.push({ id: id++, c, loc: 'off' });
  }
  return out;
}

/* Moves one checker of colour `c` (the last one that arrived at the source), hitting a blot. */
function step(layout: Checker[], c: number, mv: Move): Checker[] {
  const from: Loc = mv.f;
  let idx = -1;
  for (let i = layout.length - 1; i >= 0; i -= 1) if (layout[i].c === c && layout[i].loc === from) { idx = i; break; }
  if (idx < 0) return layout;
  let out = layout.slice();
  if (typeof mv.t === 'number') {
    const there = out.filter((k) => k.loc === mv.t && k.c !== c);
    if (there.length === 1) {
      out = out.filter((k) => k !== there[0]).concat([{ ...there[0], loc: 'bar' }]);
      idx = out.findIndex((k) => k.id === layout[idx].id);
    }
  }
  const moved = { ...out[idx], loc: mv.t as Loc };
  return out.filter((_, i) => i !== idx).concat([moved]);
}

function sameAs(layout: Checker[], st: any) {
  const key = (l: Checker[]) => l.map((k) => `${k.c}${k.loc}`).sort().join(',');
  return key(layout) === key(fromState(st));
}

/* Screen position of a point (1..24, as seen by the viewer). */
function pointX(q: number) {
  const col = q >= 13 ? q - 13 : 12 - q;
  return col < 6 ? 12 + W * (col + 0.5) : 166 + W * (col - 6 + 0.5);
}

function positions(layout: Checker[], viewer: number) {
  const disp = (p: number) => (viewer === 0 ? p : 25 - p);
  const groups = new Map<string, Checker[]>();
  for (const k of layout) {
    const key = `${k.loc}:${k.loc === 'bar' || k.loc === 'off' ? k.c : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(k);
  }
  const pos = new Map<number, { x: number; y: number; slab: boolean }>();
  for (const [key, list] of groups) {
    const loc = key.split(':')[0];
    if (loc === 'bar') {
      list.forEach((k, i) => {
        const own = k.c === viewer;
        pos.set(k.id, { x: 154, y: own ? 160 + R + i * (R * 1.2) : 104 - R - i * (R * 1.2), slab: false });
      });
    } else if (loc === 'off') {
      list.forEach((k, i) => {
        const own = k.c === viewer;
        pos.set(k.id, { x: 309, y: own ? 248 - i * 6.6 : 16 + i * 6.6, slab: true });
      });
    } else {
      const q = disp(Number(loc));
      const top = q >= 13;
      const sp = list.length <= 5 ? 2 * R : (104 - 2 * R) / (list.length - 1);
      list.forEach((k, i) => pos.set(k.id, { x: pointX(q), y: top ? 12 + R + i * sp : 252 - R - i * sp, slab: false }));
    }
  }
  return pos;
}

function Die({ v, used, rolling }: { v: number; used: boolean; rolling: boolean }) {
  const PIPS: Record<number, number[][]> = {
    1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]],
    5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]], 6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
  };
  return (
    <div class={`die${used ? ' used' : ''}${rolling ? ' rolling' : ''}`}>
      {PIPS[v]?.map(([x, y], i) => <i key={i} style={{ left: `${25 + x * 25}%`, top: `${25 + y * 25}%` }} />)}
    </div>
  );
}

export default function Backgammon({ room, busy, move }: BoardProps) {
  const st = room.state;
  const viewer = room.you === 1 ? 1 : 0;
  const mine = myTurn(room);
  const [base, setBase] = useState<Checker[]>(() => fromState(st));
  const [pending, setPending] = useState<Move[]>([]);
  const [sel, setSel] = useState<Loc | null>(null);
  const [rollKey, setRollKey] = useState(0);
  const seen = useRef<number>(st.seq);
  const timers = useRef<number[]>([]);

  /* Replay new events: moves glide one by one; a new game or any mismatch resyncs the board. */
  useEffect(() => {
    const events = (st.log as any[]).filter((e) => e.n > seen.current);
    seen.current = st.seq;
    setPending([]);
    setSel(null);
    timers.current.forEach((x) => window.clearTimeout(x));
    timers.current = [];
    if (!events.length) {
      setBase((b) => (sameAs(b, st) ? b : fromState(st)));
      return;
    }
    let delay = 0;
    for (const e of events) {
      if (e.type === 'roll' || e.type === 'opening') {
        timers.current.push(window.setTimeout(() => { setRollKey((k) => k + 1); haptic.soft(); }, delay));
        delay += 450;
      }
      if (e.type === 'nomove' && e.seat === room.you) toast(t('bg_no_moves'));
      if (e.type === 'game') toast(t('bg_game_won', { name: seatName(room.seats[e.seat], t, n), g: e.game, p: e.points }), 'good');
      if (e.type === 'opening' && e.game > 1) {
        timers.current.push(window.setTimeout(() => setBase(fromState(st)), delay));
      }
      if (e.type === 'move') {
        for (const mv of e.moves as Move[]) {
          const own = e.seat === room.you;
          timers.current.push(window.setTimeout(() => {
            setBase((b) => step(b, e.seat, mv));
            if (!own) haptic.soft();
          }, own ? 0 : delay));
          if (!own) delay += 320;
        }
      }
    }
    timers.current.push(window.setTimeout(() => setBase((b) => (sameAs(b, st) ? b : fromState(st))), delay + 60));
  }, [room.ver]);

  useEffect(() => () => timers.current.forEach((x) => window.clearTimeout(x)), []);

  const layout = useMemo(() => pending.reduce((l, mv) => step(l, st.turn, mv), base), [base, pending]);
  const pos = useMemo(() => positions(layout, viewer), [layout, viewer]);
  const legal: Move[] = mine && st.phase === 'move' ? (bg.nextMoves(st, pending) || []) : [];
  const required = mine && st.phase === 'move' ? bg.movesRequired(st) : 0;
  const sources = Array.from(new Set(legal.map((m) => m.f)));
  const active = sel ?? (sources.length === 1 ? sources[0] : null);
  const targets = legal.filter((m) => m.f === active);
  const usedDice = pending.map((m) => m.d);
  const disp = (p: number) => (viewer === 0 ? p : 25 - p);

  function choose(mv: Move) {
    haptic.tap();
    setPending((p) => p.concat([mv]));
    setSel(null);
  }

  function tapPoint(p: Loc) {
    if (!mine || busy) return;
    const hit = targets.filter((m) => m.t === p).sort((a, b) => a.d - b.d)[0];
    if (hit) {
      choose(hit);
      return;
    }
    if (sources.includes(p as any)) {
      haptic.select();
      setSel(p);
    } else setSel(null);
  }

  async function submit() {
    const ok = await move({ type: 'move', moves: pending });
    if (!ok) setPending([]);
  }

  const dice: number[] = st.rolled || [];
  const remaining = [...(st.dice as number[])];
  for (const d of usedDice) {
    const i = remaining.indexOf(d);
    if (i >= 0) remaining.splice(i, 1);
  }
  const doubles = dice.length === 2 && dice[0] === dice[1];

  return (
    <div class="bg">
      <svg class="bg-board" viewBox="0 0 324 264">
        <defs>
          <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--wood-2)" /><stop offset="1" stop-color="var(--wood)" /></linearGradient>
          <radialGradient id="ckw" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff" /><stop offset="1" stop-color="var(--white-checker)" /></radialGradient>
          <radialGradient id="ckb" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#5a5a66" /><stop offset="1" stop-color="var(--black-checker)" /></radialGradient>
        </defs>
        <rect x="0" y="0" width="324" height="264" rx="16" fill="url(#wood)" />
        <rect x="8" y="8" width="138" height="248" rx="6" fill="var(--felt)" />
        <rect x="162" y="8" width="138" height="248" rx="6" fill="var(--felt)" />
        <rect x="302" y="8" width="16" height="248" rx="5" fill="rgba(0,0,0,.25)" class={targets.some((m) => m.t === 'off') ? 'tray hot' : 'tray'} onClick={() => tapPoint('off')} />
        {Array.from({ length: 24 }, (_, i) => {
          const p = i + 1;
          const q = disp(p);
          const x = pointX(q);
          const top = q >= 13;
          const d = top ? `M${x - W / 2 + 1} 10 L${x} 114 L${x + W / 2 - 1} 10 Z` : `M${x - W / 2 + 1} 254 L${x} 150 L${x + W / 2 - 1} 254 Z`;
          const isTarget = targets.some((m) => m.t === p);
          const isSource = sources.includes(p) && mine;
          return (
            <g key={p} onClick={() => tapPoint(p)} class="pt">
              <path d={d} fill={q % 2 ? 'var(--point-a)' : 'var(--point-b)'} opacity=".92" />
              {isTarget && <path d={d} class="pt-target" />}
              {active === p && <path d={d} class="pt-sel" />}
              {isSource && active !== p && <circle cx={x} cy={top ? 6 : 258} r="2.2" class="pt-dot" />}
              <rect x={x - W / 2} y={top ? 8 : 132} width={W} height="124" fill="transparent" />
            </g>
          );
        })}
        <rect x="146" y="8" width="16" height="248" fill="url(#wood)" onClick={() => tapPoint('bar')} />
        {layout.map((k) => {
          const p = pos.get(k.id);
          if (!p) return null;
          const lifted = active !== null && k.c === st.turn && mine && k.loc === active;
          return (
            <g key={k.id} class={`ck${lifted ? ' lifted' : ''}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }} onClick={() => tapPoint(k.loc)}>
              {p.slab
                ? <rect x="-7" y="-2.6" width="14" height="5.2" rx="2" fill={k.c === 0 ? 'url(#ckw)' : 'url(#ckb)'} />
                : (
                  <g>
                    <circle r={R} fill={k.c === 0 ? 'url(#ckw)' : 'url(#ckb)'} stroke={k.c === 0 ? '#c9bfa8' : '#000'} stroke-width=".8" />
                    <circle r={R * 0.62} fill="none" stroke={k.c === 0 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.1)'} stroke-width="1.2" />
                  </g>
                )}
            </g>
          );
        })}
      </svg>

      <div class="bg-controls">
        <div class="dice" key={rollKey}>
          {dice.map((v, i) => <Die key={i} v={v} rolling={rollKey > 0} used={st.phase !== 'move' || (doubles ? !remaining.length : !remaining.includes(v))} />)}
          {doubles && st.phase === 'move' && <span class="chip">×{n(remaining.length)}</span>}
        </div>
        <div class="spacer" />
        {mine && st.phase === 'roll' && <Button onClick={() => move({ type: 'roll' })} disabled={busy}>🎲 {t('bg_roll')}</Button>}
        {mine && st.phase === 'move' && (
          <div class="row">
            <Button kind="secondary" small disabled={!pending.length || busy} onClick={() => { haptic.tap(); setPending((p) => p.slice(0, -1)); }}><Icon name="undo" size={16} /></Button>
            <Button small disabled={pending.length !== required || busy} onClick={submit}><Icon name="check" size={16} />{t('bg_done')}</Button>
          </div>
        )}
      </div>
      <div class="bg-info hint">
        <span>⚪ {t('bg_pips', { n: bg.pips(st, 0) })}</span>
        <span>{t('bg_score', { a: st.score[0], b: st.score[1], target: st.target })}</span>
        <span>⚫ {t('bg_pips', { n: bg.pips(st, 1) })}</span>
      </div>
    </div>
  );
}
