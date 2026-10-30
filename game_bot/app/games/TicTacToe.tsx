// Tic-tac-toe board: marks draw themselves in, the winning line sweeps across.
import { useState } from 'preact/hooks';
import { t } from '../i18n';
import type { BoardProps } from '../screens/Room';
import { haptic } from '../tg';
import { myTurn } from '../useRoom';

const CENTER = (i: number) => [50 + (i % 3) * 100, 50 + Math.floor(i / 3) * 100];

function Mark({ m }: { m: string }) {
  if (m === 'X') {
    return (
      <svg viewBox="0 0 100 100" class="mark x">
        <path d="M28 28L72 72" />
        <path d="M72 28L28 72" class="second" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 100 100" class="mark o">
      <circle cx="50" cy="50" r="24" />
    </svg>
  );
}

export default function TicTacToe({ room, busy, move }: BoardProps) {
  const s = room.state;
  const mine = myTurn(room);
  const [pending, setPending] = useState(-1);
  const board = pending >= 0 && s.b[pending] === '.' ? s.b.slice(0, pending) + (room.you === 0 ? 'X' : 'O') + s.b.slice(pending + 1) : s.b;

  async function tap(i: number) {
    if (!mine || busy || s.b[i] !== '.') {
      if (!mine && room.status === 'playing') haptic.warning();
      return;
    }
    haptic.tap();
    setPending(i);
    await move({ type: 'mark', cell: i });
    setPending(-1);
  }

  const line = s.line as number[] | null;
  const [x1, y1] = line ? CENTER(line[0]) : [0, 0];
  const [x2, y2] = line ? CENTER(line[2]) : [0, 0];

  return (
    <div class="ttt">
      <div class={`ttt-board${mine ? ' live' : ''}`}>
        {Array.from(board as string).map((m, i) => (
          <button key={`${s.round}-${i}`} class={`ttt-cell${m === '.' && mine ? ' open' : ''}`} onClick={() => tap(i)} aria-label={`cell ${i + 1}`}>
            {m !== '.' && <Mark m={m} />}
          </button>
        ))}
        {line && (
          <svg class="ttt-line" viewBox="0 0 300 300">
            <line x1={x1} y1={y1} x2={x2} y2={y2} class={s.w === 0 ? 'x' : 'o'} />
          </svg>
        )}
      </div>
      <div class="ttt-score">{t('ttt_score', { a: s.score[0], d: s.score[2], b: s.score[1] })}</div>
    </div>
  );
}
