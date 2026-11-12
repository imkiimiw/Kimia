// Base direction of a text layer from its first strong character (Persian → rtl, Latin → ltr),
// so mixed Persian / English keeps the order a reader expects (SPIKE_REPORT §4.3 #5).
const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

export function baseDirection(text: string): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (STRONG_LTR.test(ch)) return 'ltr';
  }
  return 'rtl';
}
