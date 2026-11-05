// A multiplayer room: the lobby while seats fill (invite, seats, options, bots), then the game's
// board (loaded on demand), the players' header with turn timers, and the result sheet (rematch).
import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { seatName, useApp } from '../ctx';
import { n, t } from '../i18n';
import { haptic, shareInline } from '../tg';
import { Avatar, Button, GameArt, Icon, Overlay, Segmented, Spinner, TimerRing } from '../ui';
import { myTurn, type RoomView, useRoom } from '../useRoom';

export type BoardProps = { room: RoomView; busy: boolean; move: (a: Record<string, unknown>) => Promise<boolean> };

const BOARDS: Record<string, () => Promise<{ default: ComponentType<BoardProps> }>> = {
  ttt: () => import('../games/TicTacToe'),
  bg: () => import('../games/Backgammon'),
  hokm: () => import('../games/Hokm'),
};

function useBoard(game: string) {
  const [Board, setBoard] = useState<ComponentType<BoardProps> | null>(null);
  useEffect(() => {
    BOARDS[game]().then((m) => setBoard(() => m.default));
  }, [game]);
  return Board;
}

function Seat({ seat, i, room, onSit }: { seat: RoomView; i: number; room: RoomView; onSit: (i: number) => void }) {
  if (!seat) {
    const canSit = room.you >= 0 && room.status === 'waiting';
    return (
      <div class="seat empty">
        <div class="avatar seat-empty">+</div>
        <span class="hint">{t('lobby_empty_seat')}</span>
        {canSit && room.game === 'hokm' && <button class="chip brand" onClick={() => onSit(i)}>{t('lobby_sit')}</button>}
      </div>
    );
  }
  return (
    <div class={`seat${seat.me ? ' me' : ''}`}>
      <Avatar name={seat.name} bot={seat.bot} seed={seat.name + i} />
      <span class="ellipsis">{seat.me ? t('lobby_you') : seatName(seat, t, n)}</span>
    </div>
  );
}

function Lobby({ room, act, busy }: { room: RoomView; act: (i: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const { back } = useApp();
  const filled = room.seats.filter(Boolean).length;
  const [botsIn, setBotsIn] = useState(room.botsIn ?? 0);
  const at = useRef(Date.now());
  useEffect(() => {
    at.current = Date.now();
    setBotsIn(room.botsIn ?? 0);
    if (!room.botsIn) return undefined;
    const id = window.setInterval(() => setBotsIn(Math.max(0, (room.botsIn as number) - Math.floor((Date.now() - at.current) / 1000))), 500);
    return () => window.clearInterval(id);
  }, [room.ver, room.botsIn]);

  const invite = () => {
    haptic.medium();
    shareInline(`room ${room.id}`);
  };
  const sit = (i: number) => act({ action: 'seat', seat: i });

  return (
    <div class="lobby screen-in">
      <div class="lobby-head">
        <GameArt game={room.game} size={88} />
        <h1>{t(`game_${room.game}`)}</h1>
        <p class="hint waiting">{t('lobby_waiting', { n: filled, m: room.seats.length })}<span class="dots"><i /><i /><i /></span></p>
      </div>

      {room.game === 'hokm' ? (
        <div class="teams">
          {[0, 1].map((team) => (
            <div key={team} class={`card team team-${team}`}>
              <div class="team-label">{t('lobby_team', { n: team + 1 })}</div>
              {[team, team + 2].map((i) => <Seat key={i} seat={room.seats[i]} i={i} room={room} onSit={sit} />)}
            </div>
          ))}
        </div>
      ) : (
        <div class="duel">
          <Seat seat={room.seats[0]} i={0} room={room} onSit={sit} />
          <div class="vs">VS</div>
          <Seat seat={room.seats[1]} i={1} room={room} onSit={sit} />
        </div>
      )}

      {room.you < 0 && <p class="hint center">{t('lobby_spectating')}</p>}

      {room.game === 'bg' && (
        <div class="card pad lobby-opt">
          <span class="hint">{t('lobby_match_to')}</span>
          {room.creator ? (
            <Segmented value={room.opts.target || 3} options={[3, 5].map((v) => ({ value: v, label: t('lobby_points', { n: v }) }))} onChange={(v) => act({ action: 'opts', target: v })} />
          ) : (
            <b>{t('lobby_points', { n: room.opts.target || 3 })}</b>
          )}
        </div>
      )}

      <div class="stack lobby-actions">
        {room.you >= 0 && (
          <Button block onClick={invite}><Icon name="share" size={18} />{t('lobby_invite')}</Button>
        )}
        {room.game === 'hokm' && room.creator && room.you >= 0 && (
          <Button kind="secondary" block disabled={busy || botsIn > 0} onClick={() => act({ action: 'bots' })}>
            <Icon name="bot" size={18} />
            {botsIn > 0 ? t('lobby_fill_in', { s: botsIn }) : t('lobby_fill_bots')}
          </Button>
        )}
        {room.you >= 0 && (
          <Button kind="ghost" block onClick={async () => { if (await act({ action: 'leave' })) back(); }}>{t('lobby_leave')}</Button>
        )}
      </div>
    </div>
  );
}

/* The players across the top, with the turn highlighted and its timer. */
function Players({ room }: { room: RoomView }) {
  if (room.game === 'hokm') return null;
  const turn = room.status === 'playing' ? room.state.turn : -1;
  const marks = room.game === 'ttt' ? ['❌', '⭕'] : ['⚪', '⚫'];
  return (
    <div class="players">
      {room.seats.map((s: RoomView, i: number) => (
        <div key={i} class={`player${turn === i ? ' active' : ''}${i === 1 ? ' end' : ''}`}>
          <Avatar name={s?.name || '?'} size="sm" bot={s?.bot} seed={(s?.name || '') + i} />
          <div class="player-name">
            <b class="ellipsis">{s?.me ? t('lobby_you') : seatName(s, t, n)}</b>
            <span>{marks[i]}</span>
          </div>
          {turn === i && <TimerRing key={`${room.ver}`} left={room.left} total={room.turnSec} size={30} />}
        </div>
      ))}
    </div>
  );
}

function Result({ room, act, busy }: { room: RoomView; act: (i: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const { back } = useApp();
  const res = room.result;
  const mine = room.you >= 0;
  const won = mine && res.winners.includes(room.you);
  useEffect(() => {
    if (!mine) return;
    if (won) haptic.success();
    else if (!res.draw) haptic.warning();
  }, [room.ver]);
  const names = res.winners.map((i: number) => seatName(room.seats[i], t, n)).filter(Boolean).join(' & ');
  let title = res.draw ? t('result_draw') : won ? t('result_win') : mine ? t('result_lose') : t('result_team_won', { names });
  if (!mine && !res.draw) title = t('result_team_won', { names });
  const emoji = res.draw ? '🤝' : won ? '🏆' : mine ? '😔' : '🏁';
  return (
    <Overlay>
      {won && <div class="confetti">{Array.from({ length: 28 }, (_, i) => <i key={i} style={{ '--i': i, '--x': `${(i * 37) % 100}%`, '--d': `${((i * 53) % 11) * 70}ms`, '--t': `${1.5 + (i % 5) * 0.28}s` } as Record<string, string | number>} />)}</div>}
      <div class="result-emoji">{emoji}</div>
      <h1>{title}</h1>
      {res.forfeit !== undefined && <p class="hint">{t('result_forfeit', { name: seatName(room.seats[res.forfeit], t, n) || '?' })}</p>}
      {room.game === 'ttt' && <p class="hint">{t('ttt_score', { a: room.state.score[0], d: room.state.score[2], b: room.state.score[1] })}</p>}
      {room.game === 'bg' && <p class="hint">{t('bg_score', { a: room.state.score[0], b: room.state.score[1], target: room.state.target })}</p>}
      {room.game === 'hokm' && <p class="hint">{t('hokm_hands', { a: room.state.score[0], b: room.state.score[1], target: room.state.target })}</p>}
      <div class="stack" style={{ marginTop: '18px' }}>
        {mine && (
          <Button block disabled={busy || room.rematch.mine} onClick={() => act({ action: 'rematch' })}>
            <Icon name="refresh" size={18} />
            {room.rematch.votes ? t('rematch_votes', { n: room.rematch.votes, m: room.rematch.needed }) : t('rematch')}
          </Button>
        )}
        <Button kind="secondary" block onClick={back}>{t('back_home')}</Button>
      </div>
    </Overlay>
  );
}

export function Room({ game, roomId }: { game: string; roomId: string }) {
  const { room, fatal, busy, move, action } = useRoom(game, roomId);
  const Board = useBoard(game);
  const turnRef = useRef(false);
  const mine = myTurn(room);
  useEffect(() => {
    if (mine && !turnRef.current) haptic.medium();
    turnRef.current = mine;
  }, [mine]);

  if (fatal) return <div class="center-screen"><div class="stack"><div style={{ fontSize: '40px' }}>⌛</div><p>{fatal}</p></div></div>;
  if (!room || !Board) return <div class="center-screen"><Spinner /></div>;
  if (room.status === 'waiting') return <Lobby room={room} act={action} busy={busy} />;
  if (room.status === 'expired') return <div class="center-screen"><div class="stack"><div style={{ fontSize: '40px' }}>⌛</div><p>{t('error_room')}</p></div></div>;
  return (
    <div class={`room room-${room.game} screen-in`}>
      <Players room={room} />
      {room.status === 'playing' && room.game !== 'hokm' && (
        <div class={`turn-banner${mine ? ' mine' : ''}`}>
          {mine ? t('turn_you') : t('turn_other', { name: seatName(room.seats[room.state.turn], t, n) })}
        </div>
      )}
      <Board room={room} busy={busy} move={move} />
      {room.status === 'finished' && room.result && <Result room={room} act={action} busy={busy} />}
    </div>
  );
}
