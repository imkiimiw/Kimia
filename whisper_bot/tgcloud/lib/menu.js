// The private chat's shell: the language picker (first /start), the main menu with its two sections
// — 🤫 whispers and 💬 anonymous messages — help, the privacy page, the forced-join screen, and the
// bot's command menu and description in each language (set once per version, lazily).
import { LANGS } from './config.js';
import { botInfo } from './bot.js';
import { channelUrl, checkJoin } from './join.js';
import { t } from './i18n.js';
import { setKv, setLang } from './store.js';
import {
  answer, btn, call, describeError, inlineBtn, send, show, urlBtn,
} from './tg.js';
import { esc, truncate } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);

export const backBtn = (ctx, data = 'm') => btn(T(ctx, 'btn.back'), data);
export const homeBtn = (ctx) => btn(T(ctx, 'btn.home'), 'm');

// ---------- language ----------

export const langKeyboard = () => [[btn('🇮🇷 فارسی', 'L:fa'), btn('🇬🇧 English', 'L:en'), btn('🇷🇺 Русский', 'L:ru')]];

export async function showLangPicker(ctx) {
  return show(ctx, 'lang_picker',
    '🌐 <b>زبان ربات را انتخاب کنید</b>\n🌐 <b>Choose the bot\'s language</b>\n🌐 <b>Выберите язык бота</b>', langKeyboard());
}

/** "L:<lang>": saves the choice, then `next` (normally the main menu). */
export async function chooseLang(ctx, user, kv, lang, next) {
  if (!LANGS.includes(lang)) return answer(ctx);
  user.lang = lang;
  ctx.lang = lang;
  await setLang(user.id, lang);
  await answer(ctx, T(ctx, 'lang.saved'));
  return next(ctx, user, kv);
}

// ---------- main menu and the whisper section ----------

export function mainKeyboard(ctx) {
  return [
    [btn(T(ctx, 'main.btn_whisper'), 'ws'), btn(T(ctx, 'main.btn_anon'), 'an')],
    [btn(T(ctx, 'main.btn_lang'), 'lg'), btn(T(ctx, 'main.btn_help'), 'hp')],
    [btn(T(ctx, 'main.btn_privacy'), 'pv')],
  ];
}

export async function showMain(ctx, user, kv, note = '') {
  const bot = await botInfo(ctx, kv);
  const name = esc(user.pName || user.firstName || '');
  return show(ctx, 'main', `${note ? `${note}\n\n` : ''}${T(ctx, 'main.text', { name, bot: esc(bot.username || 'bot') })}`, mainKeyboard(ctx));
}

export async function showWhisperSection(ctx, kv) {
  const bot = await botInfo(ctx, kv);
  const kb = [
    [inlineBtn(T(ctx, 'ws.btn_send'))],
    [btn(T(ctx, 'ws.btn_sent'), 'h:s:0'), btn(T(ctx, 'ws.btn_received'), 'h:r:0')],
    [btn(T(ctx, 'ws.btn_settings'), 'st'), btn(T(ctx, 'ws.btn_blocks'), 'bl')],
    [btn(T(ctx, 'ws.btn_help'), 'hp:w'), backBtn(ctx)],
  ];
  return show(ctx, 'whisper_section', T(ctx, 'ws.text', { b: `@${esc(bot.username || 'bot')}` }), kb);
}

/** "hp" (index), "hp:w" (whispers), "hp:a" (anonymous messages). */
export async function showHelp(ctx, kv, topic = '') {
  const bot = await botInfo(ctx, kv);
  const b = `@${esc(bot.username || 'bot')}`;
  if (topic === 'w') return show(ctx, 'help_whisper', T(ctx, 'help.w', { b }), [[btn(T(ctx, 'help.btn_anon'), 'hp:a')], [backBtn(ctx, 'ws')]]);
  if (topic === 'a') return show(ctx, 'help_anon', T(ctx, 'help.a', { b }), [[btn(T(ctx, 'help.btn_whisper'), 'hp:w')], [backBtn(ctx, 'an')]]);
  return show(ctx, 'help', T(ctx, 'help.index', { b }),
    [[btn(T(ctx, 'help.btn_whisper'), 'hp:w'), btn(T(ctx, 'help.btn_anon'), 'hp:a')], [backBtn(ctx)]]);
}

export async function showPrivacy(ctx) {
  return show(ctx, 'privacy', T(ctx, 'privacy.text'), [[btn(T(ctx, 'privacy.btn_delete'), 'dd')], [backBtn(ctx)]]);
}

export async function showHint(ctx) {
  ctx.messageId = null;
  return send(ctx, 'hint', T(ctx, 'main.hint'), mainKeyboard(ctx));
}

// ---------- forced join ----------

/** The lock screen: one link button per missing channel and a re-check button. */
export async function showJoin(ctx, missing) {
  const kb = missing.map((ch) => [urlBtn(`📢 ${truncate(ch.title || ch.username, 40)}`, channelUrl(ch))]);
  kb.push([btn(T(ctx, 'join.btn_done'), 'j')]);
  const lines = missing.map((ch) => `• @${esc(ch.username)}`).join('\n');
  return show(ctx, 'join', T(ctx, 'join.text', { list: lines }), kb);
}

/** Runs the join check for a private-chat feature; shows the lock screen and returns false if not joined. */
export async function requireJoin(ctx, user, kv, opts = {}) {
  const j = await checkJoin(ctx, user, kv, opts);
  if (j.ok) return true;
  await showJoin(ctx, j.missing);
  return false;
}

/** "✅ عضو شدم": a fresh check; once joined, `next` continues. */
export async function recheckJoin(ctx, user, kv, next) {
  const j = await checkJoin(ctx, user, kv, { fresh: true });
  if (!j.ok) {
    await answer(ctx, T(ctx, 'join.not_yet'), { alert: true });
    return showJoin(ctx, j.missing);
  }
  await answer(ctx, T(ctx, 'join.ok'));
  return next(ctx, user, kv);
}

// ---------- the bot's command menu and description, per language ----------

const CMDS_VERSION = '2';

/** Once per version: localized /commands and "what can this bot do" texts. Never throws. */
export async function ensureBotTexts(ctx, kv) {
  if (kv.cmds === CMDS_VERSION) return;
  await setKv('cmds', CMDS_VERSION);
  kv.cmds = CMDS_VERSION;
  const names = ['start', 'whisper', 'anon', 'link', 'inbox', 'profile', 'lang', 'help', 'privacy'];
  for (const lang of [null, ...LANGS]) {
    const l = lang || 'en';
    const commands = names.map((c) => ({ command: c, description: t(l, `cmd.${c}`) }));
    const code = lang ? { language_code: lang } : {};
    try {
      await call(ctx, 'setMyCommands', { commands, ...code }, 'bot_commands');
      await call(ctx, 'setMyDescription', { description: t(l, 'bot.description'), ...code }, 'bot_description');
      await call(ctx, 'setMyShortDescription', { short_description: t(l, 'bot.short'), ...code }, 'bot_short');
    } catch (err) {
      console.warn(`bot texts (${l}) failed: ${describeError(err)}`);
    }
  }
}
