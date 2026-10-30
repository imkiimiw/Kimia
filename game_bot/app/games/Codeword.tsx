// Codeword: type a 5-letter word; each guess reveals only how many letters are in the right place
// (🎯) and how many are in the word elsewhere (🔄). Mark letters on the keyboard (or on past tiles)
// to keep track of your deductions — marks are kept on this device. The answer stays on the server.
import { useEffect, useRef, useState } from 'preact/hooks';
import * as cw from '../../tgcloud/lib/games/codeword.js';
import { lang, n, t } from '../i18n';
import { ApiError, call, haptic } from '../tg';
import { Icon, Segmented, Spinner, toast } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const KEYBOARDS = cw.KEYBOARDS as Record<string, string[]>;
type Game = { mode: string; lang: string; day: number; status: string; guesses: { w: string; exact: number; near: number }[]; max: number; answer: string | null; points: number };

function loadMarks(key: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}');
  } catch {
    return {};
  }
}

export default function Codeword() {
  const L = lang();
  const [mode, setMode] = useState<'daily' | 'free'>('daily');
  const [game, setGame] = useState<Game | null>(null);
  const [input, setInput] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [shake, setShake] = useState(0);
  const [reveal, setReveal] = useState(-1);
  const [busy, setBusy] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  const markKey = game ? `cw:${game.lang}:${game.mode}:${game.mode === 'daily' ? game.day : 'free'}` : '';

  async function load(m: 'daily' | 'free', action = 'state') {
    setGame(null);
    try {
      const g = await call<Game>('codeword', { action, mode: m, lang: L });
      setGame(g);
      setInput([]);
      setReveal(-1);
      if (action === 'new') {
        try { localStorage.removeItem(`cw:${g.lang}:free:free`); } catch { /* storage blocked */ }
      }
    } catch {
      toast(t('error_generic'), 'bad');
    }
  }

  useEffect(() => { load(mode); }, [mode]);
  useEffect(() => { if (markKey) setMarks(loadMarks(markKey)); }, [markKey]);
  useEffect(() => {
    if (!markKey) return;
    try { localStorage.setItem(markKey, JSON.stringify(marks)); } catch { /* storage blocked */ }
  }, [marks]);
  useEffect(() => {
    rowsRef.current?.querySelector('.cw-row.current, .cw-row:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [game?.guesses.length]);

  const playing = game?.status === 'play';

  function cycle(letter: string) {
    haptic.select();
    setMarks((m) => ({ ...m, [letter]: ((m[letter] || 0) + 1) % 3 }));
  }

  function type(letter: string) {
    if (!playing || busy) return;
    if (marking) {
      cycle(letter);
      return;
    }
    if (input.length >= cw.LENGTH) return;
    haptic.tap();
    setInput((i) => i.concat([letter]));
  }

  function erase() {
    if (!playing) return;
    haptic.tap();
    setInput((i) => i.slice(0, -1));
  }

  async function enter() {
    if (!game || !playing || busy) return;
    if (input.length < cw.LENGTH) {
      setShake((s) => s + 1);
      toast(t('cw_short'), 'bad');
      return;
    }
    setBusy(true);
    try {
      const g = await call<Game>('codeword', { action: 'guess', mode: game.mode, lang: game.lang, word: input.join('') });
      setGame(g);
      setInput([]);
      setReveal(g.guesses.length - 1);
      const last = g.guesses[g.guesses.length - 1];
      if (g.status === 'won') haptic.success();
      else if (last.exact || last.near) haptic.soft();
      else haptic.tap();
    } catch (e) {
      setShake((s) => s + 1);
      const code = e instanceof ApiError ? e.code : '';
      toast(code === 'NOT_A_WORD' ? t('cw_not_word') : code === 'BAD_WORD' ? t('cw_short') : t('error_generic'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') enter();
      else if (ev.key === 'Backspace') erase();
      else if (game) {
        const k = cw.normalize(game.lang, ev.key);
        if (k.length === 1 && KEYBOARDS[game.lang].join('').includes(k)) type(k);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const left = game ? game.max - game.guesses.length : 0;
  const rows = game ? Array.from({ length: game.max }, (_, i) => i) : [];

  return (
    <div class="cw screen-in">
      <div class="cw-top">
        <Segmented value={mode} options={[{ value: 'daily', label: `📅 ${t('cw_daily')}` }, { value: 'free', label: `♾️ ${t('cw_free')}` }]} onChange={(m) => setMode(m)} />
        <p class="hint center">{t('cw_legend')}</p>
      </div>
      {!game && <div class="center-pad"><Spinner /></div>}
      {game && (
        <>
          <div class={`cw-rows lang-${game.lang}`} ref={rowsRef}>
            {rows.map((i) => {
              const g = game.guesses[i];
              const current = !g && i === game.guesses.length && playing;
              const letters = g ? Array.from(g.w) : current ? input : [];
              return (
                <div key={current ? `now-${shake}` : i} class={`cw-row${current ? ' current' : ''}${g ? ' done' : ''}${current && shake ? ' shaking' : ''}`}>
                  <div class="cw-tiles">
                    {Array.from({ length: cw.LENGTH }, (_, j) => {
                      const ch = letters[j] || '';
                      const m = g ? marks[ch] || 0 : 0;
                      return (
                        <button key={j} class={`cw-tile${ch ? ' filled' : ''}${g ? ' flip' : ''}${m === 1 ? ' in' : m === 2 ? ' out' : ''}`}
                          style={g && reveal === i ? { animationDelay: `${j * 90}ms` } : g ? { animation: 'none' } : undefined}
                          onClick={() => g && ch && cycle(ch)}>
                          {ch}
                        </button>
                      );
                    })}
                  </div>
                  <div class="cw-score">
                    {g ? (
                      <>
                        <span class={`cw-badge exact${g.exact ? ' on' : ''}`} style={reveal === i ? { animationDelay: '520ms' } : undefined}>🎯 {n(g.exact)}</span>
                        <span class={`cw-badge near${g.near ? ' on' : ''}`} style={reveal === i ? { animationDelay: '600ms' } : undefined}>🔄 {n(g.near)}</span>
                      </>
                    ) : <span class="cw-badge ghost">{current ? '•••' : ''}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {game.status === 'won' && (
            <div class="card pad cw-end good">
              <div class="result-emoji">🎉</div>
              <h2>{t('cw_won', { n: game.guesses.length, p: game.points })}</h2>
              {game.mode === 'daily' ? <p class="hint">{t('cw_tomorrow')}</p> : <button class="btn primary block" onClick={() => load('free', 'new')}>{t('cw_new')}</button>}
            </div>
          )}
          {game.status === 'lost' && (
            <div class="card pad cw-end">
              <h2>{t('cw_lost', { word: (game.answer || '').toUpperCase() })}</h2>
              {game.mode === 'daily' ? <p class="hint">{t('cw_tomorrow')}</p> : <button class="btn primary block" onClick={() => load('free', 'new')}>{t('cw_new')}</button>}
            </div>
          )}

          {playing && (
            <>
              <div class="cw-tools">
                <span class="hint">{marking ? t('cw_marking') : t('cw_guesses_left', { n: left })}</span>
                <div class="spacer" />
                {game.mode === 'free' && <button class="chip" onClick={() => load('free', 'new')}><Icon name="refresh" size={14} /> {t('cw_new')}</button>}
                <button class={`chip${marking ? ' brand' : ''}`} onClick={() => { haptic.select(); setMarking(!marking); }}><Icon name="pencil" size={14} /> {t('cw_mark')}</button>
              </div>
              <div class={`kb${marking ? ' marking' : ''} lang-${game.lang}`}>
                {KEYBOARDS[game.lang].map((row: string, r: number) => (
                  <div key={r} class="kb-row">
                    {r === 2 && <button class="key wide enter" onClick={enter} disabled={busy}>{t('cw_enter')}</button>}
                    {Array.from(row).map((ch) => (
                      <button key={ch} class={`key${marks[ch] === 1 ? ' in' : marks[ch] === 2 ? ' out' : ''}`} onClick={() => type(ch)}>{ch}</button>
                    ))}
                    {r === 2 && <button class="key wide" onClick={erase} aria-label="backspace"><Icon name="backspace" size={20} /></button>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
