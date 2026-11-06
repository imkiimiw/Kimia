import { describe, expect, it } from 'vitest';
import { CB, decode, encode, MAX_CALLBACK_BYTES, utf8Length } from '../../tgcloud/lib/codec.js';
import { LANGS } from '../../tgcloud/lib/config.js';

describe('callback_data codec', () => {
  it('every code the bot can produce round-trips and fits in 64 bytes', () => {
    const all = [
      encode(CB.HOME), encode(CB.LANG_MENU), encode(CB.LANG_MENU, 's'), encode(CB.JOIN_CHECK), encode(CB.ACCEPT),
      encode(CB.SETTINGS), encode(CB.QUALITY_MENU), encode(CB.HELP), encode(CB.ABOUT),
      ...LANGS.flatMap((l) => [encode(CB.LANG_SET, l), encode(CB.LANG_SET, l, 's')]),
      ...['auto', 'best', 'small'].map((q) => encode(CB.QUALITY_SET, q)),
      ...Array.from({ length: 13 }, (_, i) => encode(CB.HISTORY, i)),
    ];
    for (const d of all) {
      expect(utf8Length(d)).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
      expect(decode(d)).not.toBeNull();
    }
    expect(decode(encode(CB.LANG_SET, 'ru'))).toEqual({ code: 'L', args: ['ru'] });
  });

  it('refuses to encode invalid or oversized data', () => {
    expect(() => encode('zz')).toThrow();
    expect(() => encode(CB.LANG_SET, 'de')).toThrow();
    expect(() => encode(CB.HOME, 'x')).toThrow();
  });

  it('garbage, unknown codes, wrong arguments and oversized data decode to null', () => {
    for (const d of [undefined, null, '', 'x', 'L', 'L:de', 'L:fa:extra', 'L:fa:s:s', 'l:x', 'h:1', 'H', 'H:-1', 'H:13', 'H:1.5', 'H:007', 'Q:ultra', 'Q', 's:1',
      '__proto__', 'constructor', 'hasOwnProperty', 'a'.repeat(65), 'j'.repeat(1) + ':' + 'é'.repeat(40)]) {
      expect(decode(d), String(d)).toBeNull();
    }
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('ف')).toBe(2);
    expect(utf8Length('😀')).toBe(4);
  });
});
