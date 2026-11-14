/**
 * Local suggestions (pure; Phase 5): emojis for a sticker from its text, and caption ideas. This is
 * the "local" AiProvider (lib/ai/provider.js) — it needs no key and no network, so it always works;
 * an external free-tier provider can replace it once the owner adds a key. Shared with the Studio.
 */

/** keyword (lower case; Persian or English) → emojis. Matched as whole words or word starts. */
const WORDS = [
  [['سلام', 'درود', 'hi', 'hello', 'hey'], ['👋', '😊']],
  [['خداحافظ', 'بای', 'bye', 'goodbye'], ['👋', '😢']],
  [['مرسی', 'ممنون', 'تشکر', 'thanks', 'thank'], ['🙏', '😊']],
  [['دوستت', 'عشق', 'عاشق', 'love', 'قلب', 'heart'], ['❤️', '😍', '🥰']],
  [['بوس', 'kiss'], ['😘', '💋']],
  [['خنده', 'خندیدم', 'لول', 'lol', 'haha', 'جوک', 'funny', 'هه'], ['😂', '🤣']],
  [['گریه', 'غمگین', 'ناراحت', 'sad', 'cry'], ['😢', '😭']],
  [['عصبانی', 'عصبی', 'angry', 'mad', 'حرص'], ['😡', '🤬']],
  [['تعجب', 'وای', 'wow', 'omg', 'عجب'], ['😮', '🤯']],
  [['خواب', 'خسته', 'sleep', 'tired'], ['😴', '🥱']],
  [['گرسنه', 'غذا', 'food', 'hungry', 'پیتزا', 'pizza'], ['🍕', '😋']],
  [['قهوه', 'چای', 'coffee', 'tea'], ['☕', '😌']],
  [['تولد', 'birthday', 'تبریک', 'congrats', 'جشن', 'party'], ['🎉', '🥳', '🎂']],
  [['آفرین', 'عالی', 'خوب', 'ok', 'اوکی', 'great', 'nice', 'good'], ['👍', '👌']],
  [['نه', 'نخیر', 'no', 'nope'], ['🙅', '👎']],
  [['آره', 'بله', 'yes', 'yeah'], ['👍', '✅']],
  [['فکر', 'think', 'hmm', 'هوم'], ['🤔']],
  [['ترس', 'ترسیدم', 'scared', 'fear'], ['😱', '😨']],
  [['کار', 'درس', 'امتحان', 'work', 'exam', 'study'], ['📚', '😩']],
  [['پول', 'money', 'حقوق', 'cash'], ['💸', '🤑']],
  [['گربه', 'cat', 'پیشی'], ['🐱', '😺']],
  [['سگ', 'dog', 'هاپو'], ['🐶']],
  [['آتش', 'داغ', 'fire', 'hot', 'lit'], ['🔥']],
  [['سرد', 'یخ', 'cold', 'ice'], ['🥶', '❄️']],
  [['باحال', 'cool', 'خفن'], ['😎', '🔥']],
  [['ببخشید', 'sorry', 'معذرت'], ['🙏', '😔']],
  [['منتظر', 'wait', 'صبر'], ['⏳', '🙄']],
  [['برنده', 'قهرمان', 'win', 'winner', 'champion'], ['🏆', '🥇']],
  [['فوتبال', 'football', 'soccer', 'گل'], ['⚽', '🥅']],
  [['موسیقی', 'آهنگ', 'music', 'song'], ['🎵', '🎧']],
  [['شب', 'night', 'شب\u200cبخیر'], ['🌙', '😴']],
  [['صبح', 'morning', 'صبح\u200cبخیر'], ['☀️', '🌅']],
  [['نوروز', 'عید', 'eid', 'nowruz'], ['🌸', '🎉']],
  [['خجالت', 'shy', 'blush'], ['😊', '🙈']],
  [['چشمک', 'wink'], ['😉']],
  [['دیوانه', 'crazy', 'خل'], ['🤪']],
  [['قوی', 'strong', 'زور'], ['💪']],
  [['ستاره', 'star'], ['⭐', '🌟']],
];

const norm = (s) => String(s || '').toLowerCase().replace(/[\u200c\u200d]/g, '').replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک');

/**
 * Up to `max` emojis for a text (in the order the words appear), else a friendly default.
 * @param {string} text @param {number} [max]
 */
export function suggestEmojis(text, max = 3) {
  const words = norm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = [];
  for (const w of words) {
    for (const [keys, emojis] of WORDS) {
      if (keys.some((k) => w === norm(k) || (k.length >= 3 && w.startsWith(norm(k))))) {
        for (const e of emojis) if (!out.includes(e) && out.length < max) out.push(e);
      }
    }
  }
  // the text's own emojis come first
  const own = String(text || '').match(/\p{Extended_Pictographic}(?:️)?/gu) || [];
  const all = [...new Set([...own, ...out])].slice(0, max);
  return all.length ? all : ['😀'];
}

const IDEAS = {
  fa: {
    funny: ['من بعد از دیدن قبض برق', 'وقتی می\u200cگن فقط یه سؤال کوچیک دارم', 'حالِ من دوشنبه صبح', 'باشه، قبول، تو بردی', 'اینجا چه خبره؟!', 'وقتی غذا دیر میاد', 'من: فقط پنج دقیقه دیگه', 'نگاه کن، ولی دست نزن'],
    love: ['دلم برات تنگ شده', 'تو بهترینی', 'یه بغل گنده', 'فقط تو', 'قلبم مال تو', 'بی\u200cتو هرگز'],
    greet: ['سلام سلام!', 'صبح بخیر ☀️', 'شب بخیر 🌙', 'چطوری رفیق؟', 'خوش اومدی', 'خداحافظ فعلاً'],
    reply: ['آره دقیقاً', 'نه خیر', 'باشه', 'حله', 'عالیه', 'دمت گرم', 'فکر کنم نه', 'برو بابا'],
  },
  en: {
    funny: ['Me after seeing the bill', 'When they say “just one quick question”', 'Monday morning mood', 'Fine. You win.', 'What is going on here?!', 'When the food is late', 'Me: five more minutes', 'Look but don’t touch'],
    love: ['Miss you', 'You’re the best', 'Big hug', 'Only you', 'My heart is yours', 'Never without you'],
    greet: ['Hello hello!', 'Good morning ☀️', 'Good night 🌙', 'How are you?', 'Welcome', 'Bye for now'],
    reply: ['Exactly', 'Nope', 'OK', 'Deal', 'Awesome', 'Thanks!', 'I don’t think so', 'Whatever'],
  },
};
export const IDEA_MOODS = Object.freeze(['funny', 'love', 'greet', 'reply']);

/** `n` caption ideas for a mood, picked with `seed` (0..1) so a caller can shuffle. */
export function captionIdeas(lang, mood, n = 4, seed = 0) {
  const list = (IDEAS[lang === 'en' ? 'en' : 'fa'][mood] || IDEAS.fa.funny).slice();
  const start = Math.floor(seed * list.length) % list.length;
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(start + i) % list.length]);
}
