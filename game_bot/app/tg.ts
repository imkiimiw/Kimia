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
    /* ?sp=: the bot's own "open the game" buttons (web_app buttons carry no start_param) */
    const q = new URLSearchParams(location.search);
    return q.get('tgWebAppStartParam') || q.get('sp') || '';
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

/*
 * Telegram's share dialog for a message the bot prepared with savePreparedInlineMessage (Bot API
 * 8.0+). Resolves with { sent, error }: error is the client's reason when it wasn't sent
 * (USER_DECLINED when the user closed the dialog; UNSUPPORTED, MESSAGE_EXPIRED, … otherwise).
 * Rejects where the method isn't available at all.
 */
export function shareMessage(id: string): Promise<{ sent: boolean; error: string }> {
  return new Promise((resolve, reject) => {
    if (!W || !supports('8.0')) {
      reject(new Error('unsupported'));
      return;
    }
    let error = '';
    const onFail = (e: any) => {
      error = String(e?.error || 'UNKNOWN_ERROR');
    };
    W.onEvent('shareMessageFailed', onFail);
    try {
      /* the callback runs just before the shareMessageFailed event: read the error a moment later */
      W.shareMessage(id, (sent: boolean) => window.setTimeout(() => {
        W.offEvent('shareMessageFailed', onFail);
        resolve({ sent: !!sent, error });
      }, 0));
    } catch (e) {
      W.offEvent('shareMessageFailed', onFail);
      reject(e);
    }
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* not allowed in this webview: the old way below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/*
 * The chat picker with "@bot <query>" typed in (the inline results are the invitations). Throws
 * where it isn't available: old clients, or a launch without inline mode. Chat types may only be
 * users, bots, groups and channels — anything else makes telegram-web-app.js throw.
 */
export function switchInline(query: string) {
  if (!W || !supports('6.7')) throw new Error('unsupported');
  W.switchInlineQuery(query, ['users', 'groups']);
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

/*
 * Reports a launch or a client-side failure to the server (the client_log table, shown in the owner
 * panel): the only way to see what really happens inside Telegram's webviews. At most 25 a session.
 */
let logged = 0;
export function logEvent(kind: string, data: Record<string, unknown> = {}) {
  if (!W?.Serverless?.call || logged >= 25) return;
  logged += 1;
  try {
    W.Serverless.call('clientLog', { kind, data: { ...data, p: W.platform, v: W.version } }, () => {});
  } catch {
    /* nothing to do */
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
      /* the platform's own failures (not a game's refusals): unreachable, unauthorized, crashed */
      if (err.type !== 'ENDPOINT_ERROR') logEvent('api-error', { name, type: String(err.type || ''), status: e.status, msg: String(err.message || '').slice(0, 120) });
      reject(e);
    });
  });
}
