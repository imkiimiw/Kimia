// Minimal typing for the parts of telegram-web-app.js the spike uses.
export interface ServerlessErr {
  message: string;
  type?: string;
  parameters?: Record<string, unknown>;
}
interface TgWebApp {
  platform?: string;
  version?: string;
  colorScheme?: string;
  initData?: string;
  initDataUnsafe?: { user?: { id: number } };
  ready?: () => void;
  expand?: () => void;
  isVersionAtLeast?: (v: string) => boolean;
  Serverless?: { call: (name: string, input: object, cb: (err: ServerlessErr | null, result?: unknown) => void) => void };
}
declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg = (): TgWebApp | undefined => window.Telegram?.WebApp;
export const insideTelegram = (): boolean => !!tg()?.initData;

export function call<T = unknown>(name: string, input: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = tg()?.Serverless;
    if (!s) return reject(new Error('Telegram.WebApp.Serverless is not available (open the page inside Telegram)'));
    s.call(name, input, (err, result) => (err ? reject(Object.assign(new Error(err.message), err)) : resolve(result as T)));
  });
}
