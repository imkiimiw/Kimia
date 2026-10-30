// The Mini App's side of the shared strings (tgcloud/lib/i18n): the current language, RTL, digits.
import { isRtl, num, pickLang, t as translate } from '../tgcloud/lib/i18n/index.js';

let current = 'en';

export function setLang(lang: string) {
  current = pickLang(lang);
  const root = document.documentElement;
  root.lang = current;
  root.dir = isRtl(current) ? 'rtl' : 'ltr';
}

export const lang = () => current;
export const t = (key: string, vars?: Record<string, string | number>) => translate(current, key, vars);
export const n = (x: number | string) => num(current, x);
export const rtl = () => isRtl(current);
export { pickLang };
