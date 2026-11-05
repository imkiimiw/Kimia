// Profile: the player's stats per game.
import { useEffect, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { n, t } from '../i18n';
import { call } from '../tg';
import { Avatar, GameArt, Spinner } from '../ui';

type Stat = { played: number; wins: number; losses: number; draws: number; score: number };
const GAMES = ['ttt', 'bg', 'hokm', 'codeword', 'fusion'];

export function Profile() {
  const { me } = useApp();
  const [games, setGames] = useState<Record<string, Stat> | null>(null);
  useEffect(() => {
    call('profile').then((p) => setGames(p.games || {})).catch(() => setGames({}));
  }, []);
  const empty: Stat = { played: 0, wins: 0, losses: 0, draws: 0, score: 0 };
  const total = games ? Object.entries(games).filter(([g]) => g !== 'fusion').reduce((s, [, v]) => s + v.score, 0) : 0;
  const played = games ? Object.values(games).reduce((s, v) => s + v.played, 0) : 0;

  return (
    <div class="screen-in">
      <div class="profile-head card">
        <Avatar name={me.name} size="lg" seed={me.id} />
        <h1>{me.name}</h1>
        <div class="row" style={{ justifyContent: 'center' }}>
          <span class="chip gold">⭐ {t('points_short', { n: total })}</span>
          <span class="chip">🎮 {n(played)}</span>
        </div>
      </div>
      {!games && <div class="center-pad"><Spinner /></div>}
      <div class="stack" style={{ marginTop: '14px' }}>
        {games && GAMES.map((g) => {
          const s = games[g] || empty;
          const cells = g === 'fusion'
            ? [['pr_played', s.played], ['pr_best', s.score]]
            : g === 'codeword'
              ? [['pr_played', s.played], ['pr_wins', s.wins], ['pr_points', s.score]]
              : [['pr_played', s.played], ['pr_wins', s.wins], ['pr_losses', s.losses], ...(g === 'ttt' ? [['pr_draws', s.draws]] : []), ['pr_points', s.score]];
          return (
            <div key={g} class="card stat-card">
              <div class="row">
                <GameArt game={g} size={40} />
                <h2>{t(`game_${g}`)}</h2>
              </div>
              <div class="stat-grid">
                {cells.map(([k, v]) => (
                  <div key={k as string}><b>{n(v as number)}</b><span>{t(k as string)}</span></div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
