// The bridge to Telegram: the WebApp object, theme, haptics, BackButton, swipes, links, sharing,
// and Serverless.call as a promise. Everything degrades gracefully on older clients.

/* eslint-disable @typescript-eslint/no-explicit-any */
const W: any = (window as any).Telegram?.WebApp;

export const webApp = W;
export const inTelegram = !!(W && W.initData);

const supports = (v: string) => !!(W && typeof W.isVersionAtLeast === 'function' && W.isVersionAtLeast(v));

function applyTheme() {
  const root = document.documentElement;
  root.dataset.scheme = W?.colorScheme === 'dark' ? 'dark' : 'light';
  try {
    if (supports('6.1')) {
      W.setHeaderColor('secondary_bg_color');
      W.setBackgroundColor('secondary_bg_color');
    }
    if (supports('7.10')) W.setBottomBarColor('secondary_bg_color');
  } catch {
    /* older client */
  }
}

export function initTelegram() {
  if (!W) return;
  W.ready();
  W.expand();
  applyTheme();
  W.onEvent('themeChanged', applyTheme);
}

/* ---------- haptics (switchable in Settings; remembered on this device) ---------- */

let hapticsOn = true;
try {
  hapticsOn = localStorage.getItem('haptics') !== '0';
} catch {
  /* storage blocked */
}

export function setHaptics(on: boolean) {
  hapticsOn = on;
  try {
    localStorage.setItem('haptics', on ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}
export const hapticsEnabled = () => hapticsOn;

function hf(fn: (h: any) => void) {
  if (!hapticsOn || !W?.HapticFeedback || !supports('6.1')) return;
  try {
    fn(W.HapticFeedback);
  } catch {
    /* not available */
  }
}

export const haptic = {
  tap: () => hf((h) => h.impactOccurred('light')),
  soft: () => hf((h) => h.impactOccurred('soft')),
  medium: () => hf((h) => h.impactOccurred('medium')),
  heavy: () => hf((h) => h.impactOccurred('heavy')),
  select: () => hf((h) => h.selectionChanged()),
  success: () => hf((h) => h.notificationOccurred('success')),
  warning: () => hf((h) => h.notificationOccurred('warning')),
  error: () => hf((h) => h.notificationOccurred('error')),
};

/* ---------- BackButton and swipe-to-close ---------- */

let backHandler: (() => void) | null = null;
function onBack() {
  if (backHandler) backHandler();
}
if (W?.BackButton) W.BackButton.onClick(onBack);

export function setBack(handler: (() => void) | null) {
  backHandler = handler;
  if (!W?.BackButton || !supports('6.1')) return;
  if (handler) W.BackButton.show();
  else W.BackButton.hide();
}

export function setSwipes(enabled: boolean) {
  if (!supports('7.7')) return;
  try {
    if (enabled) W.enableVerticalSwipes();
    else W.disableVerticalSwipes();
  } catch {
    /* not available */
  }
}

/* ---------- launch info, links, sharing ---------- */

export function startParam(): string {
  const p = W?.initDataUnsafe?.start_param;
  if (p) return String(p);
  try {
    return new URLSearchParams(location.search).get('tgWebAppStartParam') || '';
  } catch {
    return '';
  }
}

export const launchLang = (): string => String(W?.initDataUnsafe?.user?.language_code || navigator.language || 'en');

export function openLink(url: string) {
  if (!W) {
    window.open(url, '_blank');
    return;
  }
  if (/^https:\/\/t\.me\//.test(url)) W.openTelegramLink(url);
  else W.openLink(url);
}

/* Opens the chat picker with "@bot <query>" typed in: the inline results are the invitations. */
export function shareInline(query: string) {
  if (!W || !supports('6.7')) return false;
  try {
    W.switchInlineQuery(query, ['users', 'groups', 'supergroups']);
    return true;
  } catch {
    return false;
  }
}

export function onActiveChange(cb: (active: boolean) => void) {
  const vis = () => cb(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', vis);
  const act = () => cb(true);
  const deact = () => cb(false);
  if (W?.onEvent) {
    W.onEvent('activated', act);
    W.onEvent('deactivated', deact);
  }
  return () => {
    document.removeEventListener('visibilitychange', vis);
    if (W?.offEvent) {
      W.offEvent('activated', act);
      W.offEvent('deactivated', deact);
    }
  };
}

/* ---------- endpoints ---------- */

export class ApiError extends Error {
  code: string;
  params: any;
  status: number;
  constructor(err: any) {
    super(err?.message || 'error');
    this.params = err?.parameters || {};
    this.code = err?.type === 'ENDPOINT_ERROR' ? String(this.params.code || err.message) : String(err?.type || 'NETWORK');
    this.status = Number(err?.status || 0);
  }
}

/* Called when any endpoint says the user must join the channels first (the App shows the gate). */
let notJoined: (channels: any[]) => void = () => {};
export const onNotJoined = (cb: (channels: any[]) => void) => {
  notJoined = cb;
};

export function call<T = any>(name: string, input: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!W?.Serverless?.call) {
      reject(new ApiError({ type: 'NO_TELEGRAM', message: 'Open this app from Telegram' }));
      return;
    }
    W.Serverless.call(name, input, (err: any, result: T) => {
      if (!err) {
        resolve(result);
        return;
      }
      const e = new ApiError(err);
      if (e.code === 'NOT_JOINED') notJoined(e.params.channels || []);
      reject(e);
    });
  });
}
