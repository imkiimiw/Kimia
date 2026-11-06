import { describe, expect, it } from 'vitest';
import { decode, MAX_CALLBACK_BYTES, utf8Length } from '../../tgcloud/lib/codec.js';
import { LANGS, QUALITIES } from '../../tgcloud/lib/config.js';
import * as ui from '../../tgcloud/lib/ui.js';

const buttons = (s) => (s.reply_markup ? s.reply_markup.inline_keyboard.flat() : []);
const item = (i) => ({ id: i, platform: 'x', url: 'https://x.com/a/status/' + i, status: 'ok', created_at: 1793900000 + i });

function screens(lang) {
  return {
    home: ui.home(lang, 'Ann'),
    disclaimer: ui.disclaimer(lang),
    pickerFirstRun: ui.languagePicker({ current: null, preselected: lang }),
    picker: ui.languagePicker({ current: lang, preselected: lang }),
    pickerFromSettings: ui.languagePicker({ current: lang, preselected: lang, from: 's' }),
    gate: ui.joinGate(lang, { missing: [{ id: 1, username: 'a', title: 'A' }], unknown: [{ id: 2, username: 'b', title: null }] }),
    historyEmpty: ui.history(lang, { items: [], page: 0, pages: 1, total: 0 }),
    historyMiddle: ui.history(lang, { items: [1, 2, 3].map(item), page: 1, pages: 3, total: 20 }),
    settings: ui.settings(lang, 'auto'),
    quality: ui.qualityPicker(lang, 'best'),
    help: ui.help(lang),
    about: ui.about(lang),
  };
}

describe('screens', () => {
  it('every callback button decodes and fits in 64 bytes, in every language', () => {
    for (const lang of LANGS) {
      for (const [name, s] of Object.entries(screens(lang))) {
        for (const b of buttons(s).filter((x) => x.callback_data)) {
          expect(utf8Length(b.callback_data), `${lang} ${name}`).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
          expect(decode(b.callback_data), `${lang} ${name}: ${b.callback_data}`).not.toBeNull();
        }
      }
    }
  });

  it('every screen a user navigates to has Back and Home (except home and the first-run steps)', () => {
    const exempt = ['home', 'disclaimer', 'pickerFirstRun', 'gate'];
    for (const lang of LANGS) {
      for (const [name, s] of Object.entries(screens(lang))) {
        if (exempt.includes(name)) continue;
        const last = buttons(s).slice(-2).map((b) => b.callback_data);
        expect(last[1], `${lang} ${name}`).toBe('h');
        expect(['h', 's']).toContain(last[0]);
      }
    }
  });

  it('every button label and screen text is non-empty and within Telegram limits', () => {
    for (const lang of LANGS) {
      for (const [name, s] of Object.entries(screens(lang))) {
        expect(s.text.length, `${lang} ${name}`).toBeGreaterThan(0);
        expect(s.text.length, `${lang} ${name}`).toBeLessThanOrEqual(4096);
        for (const b of buttons(s)) expect(b.text.trim().length, `${lang} ${name}`).toBeGreaterThan(0);
      }
    }
  });

  it('the quality picker marks the current choice and offers every quality', () => {
    const q = ui.qualityPicker('en', 'best');
    expect(buttons(q).filter((b) => b.callback_data.startsWith('Q:')).map((b) => b.callback_data)).toEqual(QUALITIES.map((x) => 'Q:' + x));
    expect(buttons(q).find((b) => b.callback_data === 'Q:best').text.startsWith('✓')).toBe(true);
  });

  it('a full history page caps long URLs', () => {
    const s = ui.history('en', { items: [{ ...item(1), url: 'https://x.com/' + 'a'.repeat(300) }], page: 0, pages: 1, total: 1 });
    expect(s.text).toContain('…');
    expect(s.text.length).toBeLessThan(400);
  });
});
