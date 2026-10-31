/*
 * Points, levels and automatic badges (Phase 8). Pure.
 * Level n needs 5·n·(n+1) points: 10, 30, 60, 100, 150 … (level 100 at most).
 * A «thanks» is a short reply that only thanks (in any of our languages, or 👍 🙏 ❤\uFE0F +1).
 */


export const LEVEL_MAX = 100;
export const pointsFor = (n) => 5 * n * (n + 1);

export function levelOf(points) {
  let n = 0;
  while (n < LEVEL_MAX && pointsFor(n + 1) <= Number(points)) n += 1;
  return n;
}

const DAY = 86400;
/* Automatic badges, in the order they are shown. m: an aegis_member_stats row. */
export const AUTO_BADGES = [
  { code: 'first', emoji: '🌱', test: (m) => Number(m.messages) >= 1 },
  { code: 'msg100', emoji: '💬', test: (m) => Number(m.messages) >= 100 },
  { code: 'msg1000', emoji: '🗣', test: (m) => Number(m.messages) >= 1000 },
  { code: 'msg10000', emoji: '🏛', test: (m) => Number(m.messages) >= 10000 },
  { code: 'helpful', emoji: '🤝', test: (m) => Number(m.thanks_got) >= 10 },
  { code: 'loved', emoji: '💖', test: (m) => Number(m.thanks_got) >= 100 },
  { code: 'streak7', emoji: '🔥', test: (m) => Number(m.streak) >= 7 },
  { code: 'streak30', emoji: '☄\uFE0F', test: (m) => Number(m.streak) >= 30 },
  { code: 'level10', emoji: '⭐', test: (m) => levelOf(m.points) >= 10 },
  { code: 'veteran', emoji: '🎖', test: (m, now) => Number(m.first_at) > 0 && now - Number(m.first_at) >= 365 * DAY },
];
export const AUTO_CODES = AUTO_BADGES.map((b) => b.code);
export const autoEmoji = (code) => (AUTO_BADGES.find((b) => b.code === code) || {}).emoji || '🏅';

export const earned = (m, now) => AUTO_BADGES.filter((b) => b.test(m, now)).map((b) => b.code);

const THANKS = ['+1', 'thanks', 'thank you', 'thanks a lot', 'thx', 'ty', 'tnx', 'ممنون', 'مرسی', 'سپاس', 'تشکر', 'ممنونم', 'سپاسگزارم', 'دمت گرم', 'спасибо', 'спс',
  'благодарю', '谢谢', '多谢', '感谢', 'merci', 'merci beaucoup'];
const THANKS_EMOJI = /^(?:👍|🙏|❤\uFE0F|❤|💯)+$/u;

export function isThanks(text) {
  const s = String(text || '').trim().toLowerCase().replace(/[!.,،؛;:~\s]+$/u, '').replace(/\s+/g, ' ');
  if (!s || s.length > 30) return false;
  if (THANKS_EMOJI.test(s.replace(/\s|\uFE0F/g, ''))) return true;
  const words = s.replace(/[👍🙏❤\uFE0F💯\uFE0F]/gu, '').trim();
  return THANKS.includes(words);
}

/* ========== merged from core/health.js ========== */
/*
 * A channel's health score, 0–100, with the reasons (Phase 8). Pure.
 *   growth     25  net subscribers in 7 days as a share of subscribers: ≥ +2% → 25, 0 → 15, ≤ −2% → 0
 *   engagement 30  (reactions + comments) per post per 1000 subscribers over 14 days: ≥ 20 → 30
 *   activity   20  days with a post in the last 14: ≥ 10 → 20
 *   safety     25  Aegis has its rights 10, no admin appointed outside Aegis 5, no crisis 5,
 *                  a protection on (captcha, look-alike watch, approval or edit lock) 5
 * Grades: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, else E.
 */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function healthScore(x) {
  const members = Math.max(0, Number(x.members) || 0);
  const net = Number(x.net7) || 0;
  const share = members ? (net / members) * 100 : 0;
  const growth = share >= 0 ? 15 + Math.min(10, (share / 2) * 10) : Math.max(0, 15 + (share / 2) * 15);
  const posts = Number(x.posts14) || 0;
  const per = posts && members ? ((Number(x.reactions14) || 0) + (Number(x.comments14) || 0)) / posts / (members / 1000) : 0;
  const engagement = posts ? clamp((per / 20) * 30, 0, 30) : 0;
  const activity = clamp(((Number(x.postDays14) || 0) / 10) * 20, 0, 20);
  const safety = (x.rightsOk ? 10 : 0) + (x.outside ? 0 : 5) + (x.crisis ? 0 : 5) + (x.protected ? 5 : 0);
  const parts = [
    { key: 'growth', got: Math.round(growth), max: 25 },
    { key: 'engagement', got: Math.round(engagement), max: 30 },
    { key: 'activity', got: Math.round(activity), max: 20 },
    { key: 'safety', got: safety, max: 25 },
  ];
  const score = clamp(parts.reduce((n, p) => n + p.got, 0), 0, 100);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'E';
  return { score, grade, parts, perPost: Math.round(per * 10) / 10 };
}
