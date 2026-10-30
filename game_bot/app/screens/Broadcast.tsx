// The owner's broadcast page (opened from /admin → "Send automatically"): while it is open it asks
// the server to send the next batch about once a second, and shows the progress.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp } from '../ctx';
import { n, t } from '../i18n';
import { call, haptic } from '../tg';
import { Button } from '../ui';

type Progress = { status: string; sent: number; failed: number; blocked: number; done: number; total: number } | null;

export function Broadcast() {
  const { me } = useApp();
  const [bc, setBc] = useState<Progress>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer = 0;
    const step = async () => {
      try {
        const r = await call('broadcastTick', { action: 'tick' });
        setBc(r.broadcast);
        if (r.broadcast && r.broadcast.status === 'done') haptic.success();
        if (!r.broadcast || r.broadcast.status !== 'running') return;
      } catch {
        /* try again */
      }
      if (alive.current) timer = window.setTimeout(step, 1100);
    };
    if (me.owner) step();
    return () => {
      alive.current = false;
      window.clearTimeout(timer);
    };
  }, []);

  if (!me.owner) return <div class="center-screen hint">{t('owner_only')}</div>;
  const pct = bc && bc.total ? Math.round((100 * bc.done) / bc.total) : 0;
  return (
    <div class="screen-in">
      <h1 class="page-title">📢 {t('bc_title')}</h1>
      {!bc && <p class="hint">{t('bc_idle')}</p>}
      {bc && (
        <div class="card pad stack">
          <div class="progress"><i style={{ width: `${pct}%` }} /></div>
          <div class="stat-grid">
            <div><b>{n(bc.sent)}</b><span>✅</span></div>
            <div><b>{n(bc.failed)}</b><span>⚠️</span></div>
            <div><b>{n(bc.blocked)}</b><span>⛔️</span></div>
            <div><b>{n(bc.done)}/{n(bc.total)}</b><span>📦</span></div>
          </div>
          {bc.status === 'running' && <p class="hint">{t('bc_keep_open')}</p>}
          {bc.status === 'running' && (
            <Button kind="danger" block onClick={async () => setBc((await call('broadcastTick', { action: 'cancel' })).broadcast)}>⏹</Button>
          )}
        </div>
      )}
    </div>
  );
}
