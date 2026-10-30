/*
 * What a group message contains, for the locks (lib/engines/locks.js). Pure: no platform calls.
 *
 * scan(message) → { kinds, text, entities, types, urls, hidden, service, forward, ... }
 * Language: scripts(text) counts letters and words per script (Arabic/Persian, Latin, Cyrillic,
 * CJK), ignoring links, @usernames, #tags, commands, e-mails, phone numbers and code, so a link or
 * a username never makes a message "English". langHit() then needs the script to be the clear
 * majority of the letters AND at least two words of it (or the whole message): one foreign word
 * in a mixed-language message never counts.
 */

const SERVICE = ['new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'pinned_message',
  'video_chat_started', 'video_chat_ended', 'video_chat_scheduled', 'video_chat_participants_invited', 'message_auto_delete_timer_changed',
  'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden',
  'general_forum_topic_unhidden', 'boost_added', 'chat_background_set', 'proximity_alert_triggered', 'write_access_allowed',
  'users_shared', 'chat_shared', 'giveaway_created', 'giveaway_completed'];
const FORMAT = new Set(['bold', 'italic', 'underline', 'strikethrough', 'code', 'pre', 'blockquote', 'expandable_blockquote']);
const NOT_WORDS = new Set(['url', 'text_link', 'mention', 'text_mention', 'hashtag', 'cashtag', 'bot_command', 'email', 'phone_number', 'code', 'pre',
  'custom_emoji']);
const TLDS = 'com|net|org|ir|me|io|co|info|xyz|ru|tk|ly|gg|app|dev|link|site|online|shop|top|club|biz|tv|cc|in|us|uk|de|fr|cn';

const sub = (text, e) => text.slice(e.offset, e.offset + e.length);

/* The host of a URL as typed ("https://www.Ex.com/a" → "ex.com"), or null. */
export function hostOf(url) {
  const s = String(url || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '');
  const host = s.split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/* A host and its parent domains: a.b.example.com → [a.b.example.com, b.example.com, example.com]. */
export function domainsOf(host) {
  const parts = String(host || '').split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i += 1) out.push(parts.slice(i).join('.'));
  return out;
}

export const isInvite = (url) => /(?:^|\/\/|\b)(?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/)/i.test(String(url)) || /^tg:\/\/join\?invite=/i.test(String(url));

export function scan(m) {
  const text = typeof m.text === 'string' ? m.text : (typeof m.caption === 'string' ? m.caption : '');
  const entities = Array.isArray(m.entities) ? m.entities : (Array.isArray(m.caption_entities) ? m.caption_entities : []);
  const kinds = new Set();
  if (m.photo) kinds.add('photo');
  if (m.video) kinds.add('video');
  if (m.animation) kinds.add('gif');
  else if (m.document) kinds.add('file');
  if (m.sticker) kinds.add(m.sticker.is_animated || m.sticker.is_video ? 'anim_sticker' : 'sticker');
  if (m.audio) kinds.add('music');
  if (m.voice) kinds.add('voice');
  if (m.video_note) kinds.add('round');
  if (m.contact) kinds.add('contact');
  if (m.location || m.venue) kinds.add('location');
  if (m.poll) kinds.add('poll');
  if (m.dice) kinds.add('dice');
  if (m.story) kinds.add('story');
  if (typeof m.text === 'string' && m.text.trim()) kinds.add('text');
  const types = new Set(entities.map((e) => e.type));
  if (m.has_media_spoiler) types.add('spoiler');
  const urls = [];
  const hidden = [];
  const commands = [];
  for (const e of entities) {
    if (e.type === 'url') urls.push(sub(text, e));
    else if (e.type === 'text_link' && e.url) {
      urls.push(e.url);
      hidden.push({ url: e.url, shown: sub(text, e) });
    } else if (e.type === 'bot_command') commands.push(sub(text, e));
  }
  return {
    text,
    entities,
    kinds,
    types,
    urls,
    hidden,
    commands,
    format: entities.some((e) => FORMAT.has(e.type)),
    service: SERVICE.filter((k) => m[k] !== undefined && m[k] !== null),
    forward: m.forward_origin || null,
    viaBot: m.via_bot || null,
    senderChat: m.sender_chat || null,
    automatic: !!m.is_automatic_forward,
    newMembers: Array.isArray(m.new_chat_members) ? m.new_chat_members : [],
  };
}

/*
 * Links in the message, at a sensitivity: low — clickable links only (Telegram's url/text_link
 * entities); medium — also typed URLs with a scheme, www. or t.me/; high — also disguised domains
 * ("example . com", "example[.]com", "example(dot)com").
 */
export function linksOf(f, sens = 'medium') {
  const out = [...f.urls];
  if (sens === 'medium' || sens === 'high') {
    for (const m of f.text.matchAll(/(?:https?:\/\/|www\.)[^\s]+|\b(?:t\.me|telegram\.me|telegram\.dog)\/[^\s]+/gi)) out.push(m[0]);
  }
  if (sens === 'high') {
    const re = new RegExp(`\\b([a-z0-9-]{2,})\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\)|\\s+dot\\s+|\\s+\\.\\s*|\\.\\s+)\\s*(${TLDS})\\b`, 'gi');
    for (const m of f.text.matchAll(re)) out.push(`${m[1]}.${m[2]}`);
    for (const m of f.text.matchAll(/\bt\s*[.]?\s*me\s*\/\s*([A-Za-z0-9_+]{4,})/gi)) out.push(`t.me/${m[1]}`);
  }
  return [...new Set(out)];
}

export const hostsOf = (links) => [...new Set(links.map(hostOf).filter(Boolean))];

/* A hidden link whose visible text names a different site than where it really goes. */
export function deceptive(h) {
  const shown = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(String(h.shown || ''));
  if (!shown) return false;
  const a = hostOf(shown[1]);
  const b = hostOf(h.url);
  return !!a && !!b && a !== b && !b.endsWith(`.${a}`);
}

/* The bot a command is addressed to ("/start@other_bot" → "other_bot"), or null. */
export const commandTarget = (cmd) => {
  const m = /^\/[^@\s]+@([A-Za-z0-9_]+)/.exec(String(cmd));
  return m ? m[1].toLowerCase() : null;
};

/* ---------- language ---------- */

const SCRIPTS = {
  fa: /\p{Script=Arabic}/u,
  latin: /\p{Script=Latin}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  cjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
};
const LETTER = /\p{L}/u;

/* The text with links, usernames, tags, commands, e-mails, phones and code blanked out. */
export function wordsText(f) {
  let t = f.text;
  const spans = f.entities.filter((e) => NOT_WORDS.has(e.type)).sort((a, b) => b.offset - a.offset);
  for (const e of spans) t = `${t.slice(0, e.offset)}${' '.repeat(e.length)}${t.slice(e.offset + e.length)}`;
  return t.replace(/(?:https?:\/\/|www\.)\S+/gi, ' ');
}

/* { letters: { fa, latin, cyrillic, cjk }, total, words: { … } } */
export function scripts(text) {
  const letters = { fa: 0, latin: 0, cyrillic: 0, cjk: 0 };
  const words = { fa: 0, latin: 0, cyrillic: 0, cjk: 0 };
  let total = 0;
  for (const word of String(text).split(/[\s.,;:!?()[\]{}"'«»،؛؟…\-—/\\|]+/)) {
    const per = { fa: 0, latin: 0, cyrillic: 0, cjk: 0 };
    let n = 0;
    for (const ch of word) {
      if (!LETTER.test(ch)) continue;
      n += 1;
      for (const k of Object.keys(SCRIPTS)) if (SCRIPTS[k].test(ch)) per[k] += 1;
    }
    if (!n) continue;
    total += n;
    let best = null;
    for (const k of Object.keys(per)) {
      letters[k] += per[k];
      if (per[k] && (!best || per[k] > per[best])) best = k;
    }
    /* Chinese/Japanese have no spaces: every 2 characters count as a word. */
    if (best === 'cjk') words.cjk += Math.max(1, Math.ceil(per.cjk / 2));
    else if (best) words[best] += 1;
  }
  return { letters, total, words };
}

export const LANG_SHARES = { low: 0.7, medium: 0.5, high: 0.3 };

/* Is the message (mostly) in `script`? Never because of a single word in a mixed message. */
export function langHit(stats, script, sens = 'medium') {
  if (!stats.total) return false;
  const share = stats.letters[script] / stats.total;
  return share >= LANG_SHARES[sens] && (stats.words[script] >= 2 || share >= 0.9);
}

/* ---------- emoji, length, repetition ---------- */

const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;

export function emojiCount(f) {
  return (f.text.match(EMOJI) || []).length + f.entities.filter((e) => e.type === 'custom_emoji').length;
}

export const charCount = (text) => [...String(text)].length;

/* The longest run of one character (letters and punctuation; digits and spaces don't count). */
export function longestRun(text) {
  let best = 0;
  let run = 0;
  let prev = '';
  for (const ch of String(text)) {
    if (/[\s\d]/u.test(ch)) {
      run = 0;
      prev = '';
      continue;
    }
    run = ch === prev ? run + 1 : 1;
    prev = ch;
    if (run > best) best = run;
  }
  return best;
}

/* The most times one word is repeated in a row ("buy buy buy buy" → 4). */
export function repeatedWords(text) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const w of String(text).toLowerCase().split(/\s+/).filter(Boolean)) {
    run = w === prev ? run + 1 : 1;
    prev = w;
    if (run > best) best = run;
  }
  return best;
}

export const EMOJI_MAX = { low: 10, medium: 6, high: 3 };
export const LONG_MAX = { low: 2000, medium: 1000, high: 500 };
export const RUN_MAX = { low: 15, medium: 10, high: 6 };
export const WORD_RUN_MAX = { low: 6, medium: 4, high: 3 };

/* ---------- banned words ---------- */

/* Words of a text for the word filter: normalized; medium and high also collapse "spaaam" → "spam". */
export function filterWords(text, normalize, sens = 'medium') {
  let t = normalize(text);
  if (sens !== 'low') t = t.replace(/(\p{L})\1{2,}/gu, '$1');
  return t.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/*
 * The first banned key the text contains, or null. banned/allowed: normalized keys. low/medium:
 * whole words (and whole phrases of several words); high: anywhere, even inside other words. Allowed
 * words are never matched.
 */
export function bannedHit(text, banned, allowed, normalize, sens = 'medium') {
  const allow = new Set(allowed);
  const words = filterWords(text, normalize, sens).filter((w) => !allow.has(w));
  const joined = ` ${words.join(' ')} `;
  const glued = words.join('');
  for (const key of banned) {
    const k = filterWords(key, normalize, sens).join(' ');
    if (!k) continue;
    if (sens === 'high' ? glued.includes(k.replace(/ /g, '')) : joined.includes(` ${k} `)) return key;
  }
  return null;
}
