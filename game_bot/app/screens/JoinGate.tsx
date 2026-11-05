// The forced-join screen: a button per missing channel, then "I've joined" (re-checked on the server).
import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { call, haptic, openLink } from '../tg';
import { Button, toast } from '../ui';

type Channel = { title: string; url: string | null };

export function JoinGate({ channels, onDone }: { channels: Channel[]; onDone: () => void }) {
  const [list, setList] = useState(channels);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      const r = await call('checkJoin');
      if (r.ok) {
        haptic.success();
        onDone();
      } else {
        setList(r.missing || []);
        toast(t('jg_missing'), 'bad');
      }
    } catch {
      toast(t('error_generic'), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="center-screen screen-in">
      <div class="stack join-gate">
        <div class="lock">🔒</div>
        <h1>{t('jg_title')}</h1>
        <p class="hint">{t('jg_text')}</p>
        <div class="stack">
          {list.filter((c) => c.url).map((c) => (
            <button key={c.url!} class="card channel" onClick={() => { haptic.tap(); openLink(c.url!); }}>
              <span class="channel-icon">📢</span>
              <span class="spacer ellipsis">{c.title}</span>
              <span class="chip brand">↗</span>
            </button>
          ))}
        </div>
        <Button block onClick={check} disabled={busy}>✅ {t('jg_check')}</Button>
      </div>
    </div>
  );
}
