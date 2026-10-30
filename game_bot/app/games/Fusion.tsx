// Fusion: place the current tile on an empty cell; 3+ equal tiles touching fuse into the next value
// on the placed cell (and may chain). The game runs here with the server's seed; at the end the
// moves are submitted and the server replays them to check the score. An unfinished game is kept
// on this device and resumed next time.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as fu from '../../tgcloud/lib/games/fusion.js';
import { n, t } from '../i18n';
import { ApiError, call, haptic } from '../tg';
import { Button, Overlay, Spinner, toast } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SAVE = 'fusion:run';
type Saved = { run: number; seed: number; moves: number[] };
type Anim = { cells: number[]; at: number } | null;

function save(s: Saved | null) {
  try {
    if (s) localStorage.setItem(SAVE, JSON.stringify(s));
    else localStorage.removeItem(SAVE);
  } catch {
    /* storage blocked */
  }
}

function restore(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) || 'null');
    return s && Number.isInteger(s.run) && Array.isArray(s.moves) ? s : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export default function Fusion() {
  const game = useRef<any>(null);
  const saved = useRef<Saved | null>(null);
  const [board, setBoard] = useState<number[]>(new Array(fu.CELLS).fill(0));
  const [queue, setQueue] = useState<number[]>([1, 1]);
  const [score, setScore] = useState(0);
  const [anim, setAnim] = useState<Anim>(null);
  const [pop, setPop] = useState<{ at: number; key: number; combo: number } | null>(null);
  const [locked, setLocked] = useState(true);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<{ score: number; best: number; rank: number } | null>(null);
  const [loading, setLoading] = useState(true);

  function sync() {
    const g = game.current;
    setBoard(g.board.slice());
    setQueue(g.queue.slice());
    setScore(g.score);
    setOver(g.over);
  }

  async function newGame() {
    setLoading(true);
    setResult(null);
    try {
      const r = await call<{ run: number; seed: number }>('fusion', { action: 'start' });
      game.current = fu.start(r.seed);
      saved.current = { run: r.run, seed: r.seed, moves: [] };
      save(saved.current);
      sync();
      setLocked(false);
    } catch {
      toast(t('error_generic'), 'bad');
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    const s = saved.current;
    if (!s) return;
    try {
      const r = await call<{ score: number; best: number; rank: number }>('fusion', { action: 'submit', run: s.run, moves: s.moves });
      setResult(r);
      haptic.success();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code !== 'NO_RUN') toast(t('error_generic'), 'bad');
      setResult({ score: game.current.score, best: 0, rank: 0 });
    } finally {
      save(null);
      saved.current = null;
    }
  }

  useEffect(() => {
    const s = restore();
    if (s) {
      const g = fu.start(s.seed);
      let ok = true;
      for (const m of s.moves) if (fu.place(g, m) === null) ok = false;
      if (ok) {
        game.current = g;
        saved.current = s;
        sync();
        setLoading(false);
        setLocked(false);
        if (g.over) {
          setLocked(true);
          submit();
        }
        return;
      }
    }
    newGame();
  }, []);

  async function tap(cell: number) {
    const g = game.current;
    if (locked || !g || g.over || g.board[cell] !== 0) {
      if (g && g.board[cell] !== 0) haptic.warning();
      return;
    }
    setLocked(true);
    const before = g.board.slice();
    const value = g.queue[0];
    const fusions = fu.place(g, cell) || [];
    saved.current!.moves.push(cell);
    save(saved.current);
    haptic.tap();
    let b = before.slice();
    b[cell] = value;
    setBoard(b);
    setQueue(g.queue.slice());
    let running = score;
    for (const f of fusions) {
      await sleep(140);
      setAnim({ cells: f.cells.filter((c: number) => c !== f.at), at: f.at });
      await sleep(230);
      b = b.slice();
      for (const c of f.cells) b[c] = 0;
      b[f.at] = f.into;
      setAnim(null);
      setBoard(b);
      running += f.gain;
      setScore(running);
      setPop({ at: f.at, key: Date.now(), combo: f.combo });
      if (f.combo > 1) haptic.heavy(); else haptic.medium();
    }
    sync();
    if (g.over) {
      haptic.warning();
      await sleep(500);
      submit();
      return;
    }
    setLocked(false);
  }

  if (loading) return <div class="center-screen"><Spinner /></div>;
  const xy = (i: number) => [i % fu.SIZE, Math.floor(i / fu.SIZE)];

  return (
    <div class="fu screen-in">
      <div class="fu-head">
        <div class="fu-stat"><span>{t('fu_score')}</span><b key={score} class="count">{n(score)}</b></div>
        <div class="fu-queue">
          <div class={`tile v${queue[0]} big`}>{n(queue[0])}</div>
          <div class="fu-next"><span>{t('fu_next')}</span><div class={`tile v${queue[1]}`}>{n(queue[1])}</div></div>
        </div>
      </div>
      <div class="fu-board">
        {board.map((v, i) => {
          const merging = anim && anim.cells.includes(i);
          const [x, y] = xy(i);
          const [ax, ay] = anim ? xy(anim.at) : [0, 0];
          return (
            <button key={i} class={`fu-cell${v ? '' : ' empty'}`} onClick={() => tap(i)}>
              {v > 0 && (
                <div
                  key={pop && pop.at === i ? pop.key : `t${i}-${v}`}
                  class={`tile v${v}${merging ? ' merging' : ''}${pop && pop.at === i ? ' pop' : ''}`}
                  style={merging ? { '--dx': ax - x, '--dy': ay - y } as Record<string, number> : undefined}
                >
                  {v >= fu.TOP ? '★' : n(v)}
                  {pop && pop.at === i && pop.combo > 1 && <span class="combo">×{n(pop.combo)}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <p class="hint center">{t('fu_how')}</p>
      {over && (
        <Overlay>
          <div class="result-emoji">🧩</div>
          <h1>{t('fu_over')}</h1>
          <div class="fu-final"><b>{n(result ? result.score : score)}</b><span>{t('fu_score')}</span></div>
          {!result && <p class="hint">{t('fu_saving')}</p>}
          {result && result.best > 0 && <p class="hint">{t('fu_saved')} · {t('fu_best')} {n(result.best)}{result.rank ? ` · #${n(result.rank)}` : ''}</p>}
          <div class="stack" style={{ marginTop: '16px' }}>
            <Button block disabled={!result} onClick={newGame}>{t('fu_new')}</Button>
          </div>
        </Overlay>
      )}
    </div>
  );
}
