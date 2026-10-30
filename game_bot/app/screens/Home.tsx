// Home: profile header, today's Codeword, multiplayer games (Invite creates a room and opens its
// lobby), solo games.
import { useEffect, useState } from 'preact/hooks';
import { ROOM_GAMES, SOLO_GAMES, useApp } from '../ctx';
import { n, t } from '../i18n';
import { call } from '../tg';
import { errorText } from '../useRoom';
import { Avatar, Button, GameArt, Icon, toast } from '../ui';

const SEATS: Record<string, number> = { ttt: 2, bg: 2, hokm: 4 };

export function Home() {
  const { me, go } = useApp();
  const [games, setGames] = useState<Record<string, { score: number; played: number }>>({});
  const [busy, setBusy] = useState('');

  useEffect(() => {
    call('profile').then((p) => setGames(p.games || {})).catch(() => {});
  }, []);

  const points = Object.entries(games).filter(([g]) => g !== 'fusion').reduce((s, [, v]) => s + v.score, 0);

  async function invite(game: string) {
    setBusy(game);
    try {
      const r = await call('createRoom', { game });
      go({ name: 'room', game, room: r.id });
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy('');
    }
  }

  return (
    <div class="screen-in">
      <header class="home-head">
        <Avatar name={me.name} seed={me.id} />
        <div class="ellipsis">
          <div class="hint">{t('app_name')}</div>
          <h2 class="ellipsis">{t('hello', { name: me.name })}</h2>
        </div>
        <div class="spacer" />
        <span class="chip gold">⭐ {t('points_short', { n: points })}</span>
      </header>

      <button class="hero" onClick={() => go({ name: 'codeword' })}>
        <div class="hero-text">
          <span class="chip hero-chip">{t('daily_badge')}</span>
          <h1>{t('game_codeword')}</h1>
          <p>{t('desc_codeword')}</p>
          <span class="hero-cta">{t('play')} <Icon name="play" size={14} fill /></span>
        </div>
        <GameArt game="codeword" size={104} />
      </button>

      <div class="section-title">{t('section_friends')}</div>
      <div class="stack">
        {ROOM_GAMES.map((g) => (
          <div key={g} class="card game-row">
            <GameArt game={g} size={64} />
            <div class="game-row-text">
              <div class="row">
                <h2>{t(`game_${g}`)}</h2>
                <span class="chip">{t('players_n', { n: SEATS[g] })}</span>
              </div>
              <p class="hint">{t(`desc_${g}`)}</p>
            </div>
            <Button small onClick={() => invite(g)} disabled={!!busy}>
              <Icon name="share" size={16} />
              {t('invite')}
            </Button>
          </div>
        ))}
      </div>

      <div class="section-title">{t('section_solo')}</div>
      <div class="solo-grid">
        {SOLO_GAMES.map((g) => (
          <button key={g} class="card solo-card" onClick={() => go({ name: g } as { name: 'codeword' | 'fusion' })}>
            <GameArt game={g} size={84} />
            <h2>{t(`game_${g}`)}</h2>
            <p class="hint">{t(`desc_${g}`)}</p>
            {games[g] && games[g].score > 0 && (
              <span class="chip brand">{g === 'fusion' ? `${t('fu_best')} ${n(games[g].score)}` : t('points_short', { n: games[g].score })}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
