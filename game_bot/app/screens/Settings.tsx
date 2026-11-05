// Settings: language (saved on the server, used by the bot too) and vibration (this device).
import { useState } from 'preact/hooks';
import { LANGS, t as tr } from '../../tgcloud/lib/i18n/index.js';
import { useApp } from '../ctx';
import { lang, t } from '../i18n';
import { haptic, hapticsEnabled, setHaptics } from '../tg';
import { Icon, toast } from '../ui';
import { errorText } from '../useRoom';

const FLAGS: Record<string, string> = { en: '🇬🇧', fr: '🇫🇷', ru: '🇷🇺', fa: '🇮🇷' };

export function Settings() {
  const { setLanguage } = useApp();
  const [vib, setVib] = useState(hapticsEnabled());
  const [busy, setBusy] = useState(false);

  async function pick(l: string) {
    if (l === lang() || busy) return;
    haptic.select();
    setBusy(true);
    try {
      await setLanguage(l);
    } catch (e) {
      toast(errorText(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="screen-in">
      <h1 class="page-title">{t('tab_settings')}</h1>
      <div class="section-title">{t('st_language')}</div>
      <div class="card list">
        {LANGS.map((l: string) => (
          <button key={l} class="list-item option" onClick={() => pick(l)}>
            <span class="flag">{FLAGS[l]}</span>
            <span class="spacer">{tr(l, 'lang_name')}</span>
            {l === lang() && <span class="check"><Icon name="check" size={18} /></span>}
          </button>
        ))}
      </div>
      <div class="section-title">{t('st_haptics')}</div>
      <div class="card list">
        <button
          class="list-item option"
          onClick={() => {
            setHaptics(!vib);
            setVib(!vib);
            haptic.medium();
          }}
        >
          <span class="flag">📳</span>
          <span class="spacer">{t('st_haptics')}</span>
          <span class={`switch${vib ? ' on' : ''}`}><i /></span>
        </button>
      </div>
      <p class="hint center" style={{ marginTop: '22px' }}>{t('app_name')} · {t('st_about')}</p>
    </div>
  );
}
