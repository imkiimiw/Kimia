// 📡 Sources (owner only): list, add (forward / @username / id; the bot must be an admin), enable,
// import mode (off / draft / active), default language, remove. Plus the prompt sent to the owner
// when the bot is made an admin of a new channel: Source · Destination · Force-join · Ignore.
import { LIMITS, BOT_USERNAME, OWNER_ID } from '../config/static.js';
import { t, tp, raw, digits, dateTime } from '../i18n/index.js';
import { esc, displayName } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';

const PERM = 'sources.manage';

const title = (s) => s.title || (s.username ? '@' + s.username : String(s.chat_id));
const langName = (lang, l) => (l ? tp(lang, `tlang.${l}`) : tp(lang, 'src.lang.none'));

async function listView(app) {
  const lang = app.lang;
  const rows = await app.sources.list();
  const lines = rows.map((s, i) => `${digits(i + 1, lang)}. ${s.enabled ? '✅' : '⏸'} ${tp(lang, `src.type.${s.chat_type || 'channel'}`)} ${esc(title(s))} · ${esc(tp(lang, `src.mode.${s.auto_import}`))} · ${esc(langName(lang, s.default_language))}`);
  const buttons = rows.map((s, i) => [btn(`⚙️ ${digits(i + 1, lang)}. ${tp(lang, `src.type.${s.chat_type || 'channel'}`)} ${title(s)}`.slice(0, 60), 'src', 'v', s.id)]);
  if (rows.length < LIMITS.sourcesMax) buttons.push([btn(tp(lang, 'src.btn_add'), 'src', 'add')]);
  buttons.push([homeButton(lang)]);
  return { text: t(lang, 'src.title', { count: rows.length, list: raw(lines.length ? lines.join('\n') : t(lang, 'src.empty')) }), keyboard: markup(buttons) };
}

async function cardView(app, s) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  return {
    text: t(lang, 'src.view', {
      title: title(s), handle: s.username ? '@' + s.username : '', chat_id: String(s.chat_id),
      state: tp(lang, s.enabled ? 'fjm.state.on' : 'fjm.state.off'), mode: tp(lang, `src.mode.${s.auto_import}`),
      lang: langName(lang, s.default_language), imported: s.imported_count, last: dateTime(s.last_post_at || 0, tz, lang),
    }) + '\n' + t(lang, 'src.view_type', { type: tp(lang, `src.type_name.${s.chat_type || 'channel'}`) }) + '\n\n' + t(lang, 'src.mode_help'),
    keyboard: markup([
      [btn(tp(lang, s.enabled ? 'fjm.btn_disable' : 'fjm.btn_enable'), 'src', 'tog', s.id)],
      [btn(tp(lang, 'src.btn_mode', { mode: tp(lang, `src.mode.${s.auto_import}`) }), 'src', 'mode', s.id)],
      [btn(tp(lang, 'src.btn_lang', { lang: langName(lang, s.default_language) }), 'src', 'lang', s.id)],
      [btn(tp(lang, 'fjm.btn_delete'), 'src', 'del', s.id), btn(tp(lang, 'common.back'), 'src', 'home')],
    ]),
  };
}

async function showCard(app, user, cq, id, toast = null) {
  const s = await app.sources.get(id);
  if (!s) {
    await screen(app, user, cq, await listView(app), 'sources');
    return { toast: tp(app.lang, 'src.err.gone') };
  }
  await screen(app, user, cq, await cardView(app, s), 'source_card');
  return toast ? { toast } : {};
}

const cardAction = (action, fn) => ({
  ns: 'src', action, args: ['uint'], perm: PERM,
  async run(app, user, [id], cq) {
    await fn(app, user, id);
    return showCard(app, user, cq, id, tp(app.lang, 'trk.saved'));
  },
});

/**
 * Asks the owner what a channel or group the bot was just made admin of is for (at most once an hour
 * per chat). Nothing is registered until the owner picks.
 */
export async function promptBotAdded(app, chat, from) {
  if (!(await app.alerts.claim(`added:${chat.id}`, LIMITS.alertBotAddedEverySeconds))) return false;
  const owner = await app.users.get(OWNER_ID);
  const lang = await app.users.languageOf(owner);
  const by = from ? `${displayName({ first_name: from.first_name, username: from.username, telegram_id: from.id })} (${from.id})` : '?';
  try {
    const vars = { title: chat.title || String(chat.id), handle: chat.username ? '@' + chat.username : '', chat_id: String(chat.id), by };
    // a group can only be a source (destinations and force-join are channels)
    const view = chat.type === 'channel'
      ? {
        text: t(lang, 'bnew.prompt', vars),
        keyboard: markup([
          [btn(tp(lang, 'bnew.btn_src'), 'bnew', 'src', chat.id), btn(tp(lang, 'bnew.btn_dst'), 'bnew', 'dst', chat.id)],
          [btn(tp(lang, 'bnew.btn_fj'), 'bnew', 'fj', chat.id), btn(tp(lang, 'bnew.btn_no'), 'bnew', 'no', chat.id)],
        ]),
      }
      : { text: t(lang, 'bnew.prompt_group', vars), keyboard: markup([[btn(tp(lang, 'bnew.btn_src'), 'bnew', 'src', chat.id), btn(tp(lang, 'bnew.btn_no'), 'bnew', 'no', chat.id)]]) };
    await app.tg.send(OWNER_ID, view, 'bot_added_prompt');
    return true;
  } catch (e) {
    app.log.warn('bot_added_prompt_failed', { chat_id: chat.id, error: String(e && (e.description || e.message)).slice(0, 120) });
    return false;
  }
}

/**
 * Asks the owner the language of a source whose tracks the script couldn't classify (Latin-letter
 * titles), at most every 12 h per source. One tap answers for the source's present and future tracks.
 * @param {{id: number, title?: string, username?: string, n?: number}} src
 */
export async function askSourceLanguage(app, src) {
  if (!(await app.alerts.claim(`srclang:${src.id}`, 12 * 3600))) return false;
  const owner = await app.users.get(OWNER_ID);
  const lang = await app.users.languageOf(owner);
  try {
    await app.tg.send(OWNER_ID, {
      text: t(lang, 'srclang.ask', { title: src.title || (src.username ? '@' + src.username : String(src.id)), count: src.n ? raw(t(lang, 'srclang.count', { n: src.n })) : '' }),
      keyboard: markup([
        [btn(tp(lang, 'srclang.fa'), 'src', 'dl', src.id, 'fa'), btn(tp(lang, 'srclang.en'), 'src', 'dl', src.id, 'en'), btn(tp(lang, 'srclang.other'), 'src', 'dl', src.id, 'other')],
        [btn(tp(lang, 'srclang.mix'), 'src', 'dl', src.id, 'mix')],
      ]),
    }, 'source_language_prompt');
    return true;
  } catch (e) {
    app.log.warn('source_language_prompt_failed', { error: String(e && (e.description || e.message)).slice(0, 120) });
    return false;
  }
}

/** Tick processor: sources without a default language whose tracks wait for one → ask (throttled). */
export async function askMissingLanguages(app) {
  let asked = 0;
  for (const src of await app.catalog.sourcesNeedingLanguage(5)) if (await askSourceLanguage(app, src)) asked += 1;
  return { asked };
}

/** Replaces the prompt with what happened. */
const resolvePrompt = (app, user, cq, text) => screen(app, user, cq, { text }, 'bot_added_done');

export const routes = [
  { ns: 'src', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await screen(app, user, cq, await listView(app), 'sources'); return {}; } },
  { ns: 'src', action: 'v', args: ['uint'], perm: PERM, run: (app, user, [id], cq) => showCard(app, user, cq, id) },
  cardAction('tog', (app, user, id) => app.sources.toggle(user, id)),
  cardAction('mode', (app, user, id) => app.sources.cycleMode(user, id)),
  cardAction('lang', (app, user, id) => app.sources.cycleLanguage(user, id)),
  {
    // the owner's answer to «what language are this source's songs?»
    ns: 'src', action: 'dl', args: ['uint', 'word'], perm: PERM,
    async run(app, user, [id, choice], cq) {
      const lang = app.lang;
      const src = await app.sources.get(id);
      if (!src) return { toast: tp(lang, 'src.err.gone'), alert: true };
      const title = src.title || (src.username ? '@' + src.username : String(src.chat_id));
      if (choice === 'mix') {
        await screen(app, user, cq, { text: t(lang, 'srclang.mixed', { title }) }, 'source_language_done');
        return {};
      }
      if (!['fa', 'en', 'other'].includes(choice)) return { toast: tp(lang, 'common.expired'), alert: true };
      const r = await app.sources.setDefaultLanguage(user, id, choice);
      await screen(app, user, cq, {
        text: t(lang, 'srclang.done', { title, language: tp(lang, `tlang.${choice}`), updated: r.updated, routed: r.routed }) + (r.more ? '\n' + t(lang, 'srclang.more') : ''),
        keyboard: r.more ? markup([[btn(tp(lang, `srclang.${choice}`), 'src', 'dl', id, choice)]]) : undefined,
      }, 'source_language_done');
      return {};
    },
  },
  {
    ns: 'src', action: 'add', args: [], perm: PERM,
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'src_add', {});
      await app.tg.send(user.telegram_id, promptView(app.lang, t(app.lang, 'src.add_prompt', { bot: BOT_USERNAME })), 'source_add_prompt');
      return {};
    },
  },
  {
    ns: 'src', action: 'del', args: ['uint'], perm: PERM,
    async run(app, user, [id], cq) {
      const s = await app.sources.get(id);
      if (!s) return showCard(app, user, cq, id);
      await screen(app, user, cq, {
        text: t(app.lang, 'src.delete_confirm', { title: title(s) }),
        keyboard: markup([[btn(tp(app.lang, 'common.yes_delete'), 'src', 'delok', id), btn(tp(app.lang, 'common.no'), 'src', 'v', id)]]),
      }, 'source_delete_confirm');
      return {};
    },
  },
  { ns: 'src', action: 'delok', args: ['uint'], perm: PERM, run: async (app, user, [id], cq) => { await app.sources.remove(user, id); await screen(app, user, cq, await listView(app), 'sources'); return { toast: tp(app.lang, 'src.deleted') }; } },

  // the "bot added to a channel" prompt
  {
    ns: 'bnew', action: 'src', args: ['int'], perm: PERM,
    async run(app, user, [chatId], cq) {
      const s = await app.sources.add(user, String(chatId));
      await resolvePrompt(app, user, cq, t(app.lang, 'bnew.done_src', { title: title(s) }));
      return {};
    },
  },
  {
    ns: 'bnew', action: 'fj', args: ['int'], perm: 'forcejoin.manage',
    async run(app, user, [chatId], cq) {
      const row = await app.forcejoin.add(user, String(chatId));
      await resolvePrompt(app, user, cq, t(app.lang, 'bnew.done_fj', { title: row.title || String(row.chat_id) }));
      return {};
    },
  },
  {
    ns: 'bnew', action: 'dst', args: ['int'], perm: 'destinations.manage',
    async run(app, user, [chatId], cq) {
      const d = await app.destinations.add(user, String(chatId));
      await resolvePrompt(app, user, cq, t(app.lang, 'bnew.done_dst', { title: title(d) }));
      return {};
    },
  },
  { ns: 'bnew', action: 'no', args: ['int'], perm: PERM, run: async (app, user, _a, cq) => { await resolvePrompt(app, user, cq, t(app.lang, 'bnew.ignored')); return {}; } },
];

export const flows = {
  src_add: {
    perm: PERM,
    async run(app, user, message) {
      const s = await app.sources.add(user, message.text || message.caption || '', message);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'src.added', { title: title(s) }) }, 'source_added');
      await app.tg.send(user.telegram_id, await cardView(app, s), 'source_card');
    },
  },
};
