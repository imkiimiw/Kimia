import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LANGS } from '../../tgcloud/lib/config.js';
import { detectLang, LOCALES, t, tp } from '../../tgcloud/lib/i18n/index.js';

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('fa, en and ru have identical key sets', () => {
    const en = Object.keys(LOCALES.en).sort();
    for (const l of LANGS) expect(Object.keys(LOCALES[l]).sort(), l).toEqual(en);
  });

  it('every key uses the same placeholders in every language', () => {
    for (const key of Object.keys(LOCALES.en)) {
      for (const l of LANGS) expect(placeholders(LOCALES[l][key]), `${l} ${key}`).toEqual(placeholders(LOCALES.en[key]));
    }
  });

  it('no text is empty', () => {
    for (const l of LANGS) for (const [k, v] of Object.entries(LOCALES[l])) expect(v.trim().length, `${l} ${k}`).toBeGreaterThan(0);
  });

  it('no source file under tgcloud/ contains a literal invisible character (write \\u200c etc.)', () => {
    const invisible = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
    const root = new URL('../../tgcloud/', import.meta.url);
    const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.js'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(invisible.test(readFileSync(new URL(String(f), root), 'utf8')), String(f)).toBe(false);
  });

  it('only Telegram-safe HTML tags appear in templates', () => {
    for (const l of LANGS) {
      for (const [k, v] of Object.entries(LOCALES[l])) {
        for (const tag of v.match(/<\/?([a-z]+)[^>]*>/g) || []) expect(['<b>', '</b>', '<i>', '</i>', '<code>', '</code>'], `${l} ${k}`).toContain(tag);
      }
    }
  });

  it('a key missing in a language falls back to English, an unknown language too', () => {
    LOCALES.fa.__test_only = undefined;
    delete LOCALES.fa.__test_only;
    LOCALES.en.__test_only = 'English only';
    expect(t('fa', '__test_only')).toBe('English only');
    expect(t('xx', 'btn.home')).toBe(LOCALES.en['btn.home']);
    delete LOCALES.en.__test_only;
  });

  it('t() escapes variables, tp() leaves them as they are', () => {
    expect(t('en', 'welcome.text', { name: '<b>x</b> & y' })).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(tp('en', 'join.button', { title: 'A & B' })).toBe('📢 A & B');
  });

  it('detects fa and ru from Telegram language codes, everything else is English', () => {
    expect(detectLang('fa')).toBe('fa');
    expect(detectLang('fa-IR')).toBe('fa');
    expect(detectLang('ru')).toBe('ru');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang('de')).toBe('en');
    expect(detectLang(undefined)).toBe('en');
  });

  it('Persian texts keep @usernames on their own line', () => {
    for (const [k, v] of Object.entries(LOCALES.fa)) {
      if (v.includes('{channel}')) expect(v, k).toMatch(/\n\{channel\}\n/);
    }
  });
});
