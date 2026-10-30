/*
 * Step punishments: a ladder on a member's active warning count, e.g.
 *     3 mute 1d
 *     5 ban
 * One step per line: "<warnings> <action> [duration]"; actions mute, restrict, kick, ban — in any
 * of our languages (سکوت، محدود، اخراج، بن …). Pure: no platform calls.
 */
import { MAX_STEPS } from '../config.js';
import { asciiDigits, parseDuration } from '../core/duration.js';

export const STEP_ACTIONS = ['mute', 'restrict', 'kick', 'ban'];
const WORDS = new Map([
  ...['mute', 'سکوت', 'мут', 'заглушить', '禁言', 'muet', 'silence'].map((w) => [w, 'mute']),
  ...['restrict', 'محدود', 'ограничить', '限制', 'restreindre'].map((w) => [w, 'restrict']),
  ...['kick', 'اخراج', 'кик', 'выгнать', '踢出', 'expulser'].map((w) => [w, 'kick']),
  ...['ban', 'بن', 'бан', 'забанить', '封禁', 'bannir'].map((w) => [w, 'ban']),
]);

export const DEFAULT_STEPS = [{ n: 3, a: 'mute', d: 86400 }, { n: 5, a: 'ban', d: 0 }];

/* { steps } or { error: 'empty' | 'format' | 'action' | 'count' | 'order' | 'duration' | 'too_many', line } */
export function parseSteps(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: 'empty', line: 0 };
  if (lines.length > MAX_STEPS) return { error: 'too_many', line: MAX_STEPS + 1 };
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const tokens = lines[i].split(/\s+/);
    if (tokens.length < 2) return { error: 'format', line: i + 1 };
    const n = Number(asciiDigits(tokens[0]));
    if (!Number.isInteger(n) || n < 1 || n > 50) return { error: 'count', line: i + 1 };
    const a = WORDS.get(tokens[1].toLowerCase());
    if (!a) return { error: 'action', line: i + 1 };
    let d = 0;
    const rest = tokens.slice(2);
    if (rest.length && a !== 'kick') {
      const r = parseDuration(rest);
      if (!r || r.invalid || r.used !== rest.length) return { error: 'duration', line: i + 1 };
      d = r.sec;
    } else if (rest.length) return { error: 'format', line: i + 1 };
    if (steps.length && n <= steps[steps.length - 1].n) return { error: 'order', line: i + 1 };
    steps.push({ n, a, d });
  }
  return { steps };
}

export function validSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return false;
  let prev = 0;
  for (const s of steps) {
    if (!Number.isInteger(s.n) || s.n <= prev || s.n > 50 || !STEP_ACTIONS.includes(s.a) || !Number.isInteger(s.d) || s.d < 0) return false;
    prev = s.n;
  }
  return true;
}

/* The step for exactly `count` warnings, or null. */
export const stepAt = (steps, count) => steps.find((s) => s.n === count) || null;
export const lastStep = (steps) => steps[steps.length - 1];
