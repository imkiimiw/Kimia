// The app shell: boots (who am I, joined?), routes the startapp payload (a room, a solo game, or
// the owner's broadcast page), keeps a navigation stack wired to Telegram's BackButton, and turns
// vertical swipe-to-close off while a game is open.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { parsePayload } from '../tgcloud/lib/payload.js';
import { AppCtx, type Ctx, type Me, type Route, type Tab } from './ctx';
import { setLang, t } from './i18n';
import { Broadcast } from './screens/Broadcast';
import { Home } from './screens/Home';
import { JoinGate } from './screens/JoinGate';
import { Profile } from './screens/Profile';
import { Ranks } from './screens/Ranks';
import { Room } from './screens/Room';
import { Settings } from './screens/Settings';
import { Solo } from './screens/Solo';
import { call, inTelegram, launchLang, onNotJoined, setBack, setSwipes, startParam } from './tg';
import { Icon, Spinner, Toasts } from './ui';

type Boot = { me: Me; join: { ok: boolean; missing?: { title: string; url: string | null }[] } };

function firstRoute(me: Me): Route[] {
  const base: Route[] = [{ name: 'tabs', tab: 'home' }];
  if (me.owner && location.hash === '#broadcast') return base.concat([{ name: 'broadcast' }]);
  const p = parsePayload(startParam());
  if (!p) return base;
  if (p.room) return base.concat([{ name: 'room', game: p.game, room: p.room }]);
  if (p.game === 'codeword' || p.game === 'fusion') return base.concat([{ name: p.game }]);
  return base;
}

const TABS: { tab: Tab; icon: string; label: string }[] = [
  { tab: 'home', icon: 'home', label: 'tab_home' },
  { tab: 'ranks', icon: 'trophy', label: 'tab_ranks' },
  { tab: 'profile', icon: 'user', label: 'tab_profile' },
  { tab: 'settings', icon: 'settings', label: 'tab_settings' },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState('');
  const [missing, setMissing] = useState<{ title: string; url: string | null }[] | null>(null);
  const [stack, setStack] = useState<Route[]>([{ name: 'tabs', tab: 'home' }]);
  const [langKey, setLangKey] = useState('en');

  useEffect(() => {
    setLang(launchLang());
    setLangKey(launchLang());
    onNotJoined((channels) => setMissing(channels));
    if (!inTelegram && !(window as unknown as { __TEST__?: boolean }).__TEST__) {
      setFailed('outside');
      return;
    }
    call<Boot>('boot')
      .then((b) => {
        setLang(b.me.lang);
        setLangKey(b.me.lang);
        setMe(b.me);
        if (!b.join.ok) setMissing(b.join.missing || []);
        setStack(firstRoute(b.me));
      })
      .catch(() => setFailed('error'));
  }, []);

  const top = stack[stack.length - 1];

  const ctx = useMemo<Ctx | null>(() => {
    if (!me) return null;
    return {
      me,
      go: (r) => setStack((s) => s.concat([r])),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      setTab: (tab) => setStack([{ name: 'tabs', tab }]),
      setLanguage: async (lang) => {
        await call('setLanguage', { lang });
        setLang(lang);
        setMe((m) => (m ? { ...m, lang } : m));
        setLangKey(lang);
      },
    };
  }, [me]);

  useEffect(() => {
    if (!ctx) return;
    setBack(stack.length > 1 && !missing ? ctx.back : null);
    setSwipes(top.name === 'tabs' || !!missing);
  }, [stack, ctx, missing]);

  if (failed) {
    return (
      <div class="app no-tabs">
        <div class="center-screen">
          <div class="stack" style={{ alignItems: 'center' }}>
            <div style={{ fontSize: '44px' }}>🎮</div>
            <h2>{t('app_name')}</h2>
            <p class="hint">{failed === 'outside' ? 'Open this app from Telegram.' : t('error_generic')}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!ctx) {
    return (
      <div class="app no-tabs">
        <div class="center-screen"><Spinner /></div>
      </div>
    );
  }

  let body;
  if (missing) {
    body = <JoinGate channels={missing} onDone={() => setMissing(null)} />;
  } else if (top.name === 'tabs') {
    body = top.tab === 'home' ? <Home /> : top.tab === 'ranks' ? <Ranks /> : top.tab === 'profile' ? <Profile /> : <Settings />;
  } else if (top.name === 'room') {
    body = <Room key={top.room} game={top.game} roomId={top.room} />;
  } else if (top.name === 'broadcast') {
    body = <Broadcast />;
  } else {
    body = <Solo key={top.name} game={top.name} />;
  }
  const tabs = top.name === 'tabs' && !missing;

  return (
    <AppCtx.Provider value={ctx}>
      <div key={langKey} class={`app${tabs ? '' : ' no-tabs'}`}>
        <div class="glow" />
        <Toasts />
        {body}
        {tabs && (
          <nav class="tabbar">
            {TABS.map((x) => (
              <button key={x.tab} class={top.tab === x.tab ? 'on' : ''} onClick={() => ctx.setTab(x.tab)}>
                <Icon name={x.icon} />
                {t(x.label)}
              </button>
            ))}
          </nav>
        )}
      </div>
    </AppCtx.Provider>
  );
}
