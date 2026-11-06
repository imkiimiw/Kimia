import { describe, expect, it } from 'vitest';
import { command } from '../../tgcloud/lib/router.js';
import { formatTime } from '../../tgcloud/lib/ui.js';
import { chunk, clip, esc, tehranDay } from '../../tgcloud/lib/util.js';

describe('util', () => {
  it('Tehran days switch at 00:00 UTC+03:30', () => {
    expect(tehranDay(Date.UTC(2026, 10, 5, 20, 29, 59) / 1000)).toBe('2026-11-05');
    expect(tehranDay(Date.UTC(2026, 10, 5, 20, 30, 0) / 1000)).toBe('2026-11-06');
    expect(formatTime(Date.UTC(2026, 10, 5, 20, 30, 0) / 1000)).toBe('2026-11-06 00:00');
  });

  it('escapes HTML and clips by code points', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
    expect(clip('😀😀😀', 2)).toBe('😀…');
    expect(clip('abc', 5)).toBe('abc');
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('recognises commands, including ones addressed to this bot only', () => {
    expect(command('/start')).toBe('start');
    expect(command('/start payload')).toBe('start');
    expect(command('/Language@Wanger_mediabot')).toBe('language');
    expect(command('/start@OtherBot')).toBeNull();
    expect(command('hello /start')).toBeNull();
    expect(command(undefined)).toBeNull();
  });
});
