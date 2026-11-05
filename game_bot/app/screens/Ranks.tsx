// Leaderboards: per game, global or this chat (when the app was opened from a chat).
import { useEffect, useState } from 'preact/hooks';
import { n, t } from '../i18n';
import { call } from '../tg';
import { Avatar, Segmented, Spinner } from '../ui';

const GAMES = ['ttt', 'bg', 'hokm', 'codeword', 'fusion'];
const MEDALS = ['🥇', '🥈', '🥉'];

type Board = { scope: string; hasChat: boolean; rank: number; me: number; top: { name: string; score: number; me: boolean }[] };

export function Ranks() {
  const [game, setGame] = useState('ttt');
  const [scope, setScope] = useState<'global' | 'chat'>('global');
  const [data, setData] = useState<Board | null>(null);

  useEffect(() => {
    setData(null);
    call<Board>('leaderboard', { game, scope }).then(setData).catch(() => setData({ scope, hasChat: false, rank: 0, me: 0, top: [] }));
  }, [game, scope]);

  return (
    <div class="screen-in">
      <h1 class="page-title">{t('lb_title')}</h1>
      <div class="scroller">
        {GAMES.map((g) => (
          <button key={g} class={`chip${g === game ? ' on' : ''}`} onClick={() => setGame(g)}>{t(`game_${g}`)}</button>
        ))}
      </div>
      {data?.hasChat && (
        <div style={{ margin: '8px 0 4px' }}>
          <Segmented value={scope} options={[{ value: 'global', label: t('lb_global') }, { value: 'chat', label: t('lb_chat') }]} onChange={setScope} />
        </div>
      )}
      <div class="card list" style={{ marginTop: '12px' }}>
        {!data && <div class="center-pad"><Spinner /></div>}
        {data && !data.top.length && <div class="center-pad hint">{t('lb_empty')}</div>}
        {data?.top.map((r, i) => (
          <div key={i} class={`list-item${r.me ? ' me' : ''}`}>
            <div class="rank">{MEDALS[i] || n(i + 1)}</div>
            <Avatar name={r.name} size="sm" seed={r.name + i} />
            <div class="spacer ellipsis">{r.name}</div>
            <b>{n(r.score)}</b>
          </div>
        ))}
      </div>
      {data && data.rank > 0 && <p class="hint center">{t('lb_you', { rank: data.rank })} · {n(data.me)}</p>}
    </div>
  );
}
