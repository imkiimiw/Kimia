/*
 * Inline URL buttons typed by the owner for a broadcast (copy mode). One keyboard row per line;
 * buttons in a row are separated by "|"; each button is "Text - URL":
 *     Rules - https://t.me/somechannel/5 | Site - https://example.com
 *     Join - t.me/somechannel
 * A URL may be https://, http://, tg:// or t.me/… (https:// is added). Limits come from config.
 * Gives { rows } or { error, line } (error is a locale key suffix, line is 1-based).
 */
import { BC_MAX_BUTTON_ROWS, BC_MAX_BUTTON_TEXT, BC_MAX_BUTTONS_PER_ROW } from '../config.js';

function parseUrl(raw) {
  let u = String(raw || '').trim();
  if (/^(t\.me|telegram\.me)\//i.test(u)) u = `https://${u}`;
  if (!/^(https?:\/\/[^\s/$.?#][^\s]*|tg:\/\/[^\s]+)$/i.test(u)) return null;
  if (u.length > 512) return null;
  return u;
}

export function parseButtons(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'empty', line: 0 };
  if (lines.length > BC_MAX_BUTTON_ROWS) return { error: 'too_many_rows', line: BC_MAX_BUTTON_ROWS + 1 };
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length > BC_MAX_BUTTONS_PER_ROW) return { error: 'too_many_in_row', line: i + 1 };
    const row = [];
    for (const p of parts) {
      const m = /^(.+?)\s+[-–—]\s+(\S+)$/.exec(p);
      if (!m) return { error: 'format', line: i + 1 };
      const label = m[1].trim();
      const url = parseUrl(m[2]);
      if (!label || label.length > BC_MAX_BUTTON_TEXT) return { error: 'text', line: i + 1 };
      if (!url) return { error: 'url', line: i + 1 };
      row.push({ text: label, url });
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? { rows } : { error: 'empty', line: 0 };
}

export const countButtons = (rows) => (rows || []).reduce((n, r) => n + r.length, 0);
