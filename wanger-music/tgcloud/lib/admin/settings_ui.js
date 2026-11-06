// ⚙️ Settings (owner only): every editable key with its value; enums/booleans/time zones cycle on a
// tap, numbers and the archive channel are typed in a flow. Plus "sync bot commands".
import { SETTINGS, CURRENT_PHASE, COMMANDS_VERSION } from '../config/static.js';
import { t, tp, digits } from '../i18n/index.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton, promptView } from './panel.js';
import { EDITABLE_KEYS, cycleValue, validateSetting } from '../settings/service.js';
import { syncCommandMenus } from '../bot/commands.js';
import { parseChatRef } from '../telegram/chatref.js';
import { UserError, parseIntInRange, truncate } from '../core/util.js';
import { unknownVariables, renderCaption, captionValues, CAPTION_VARS } from '../publishing/captions.js';
import { BOT_USERNAME } from '../config/static.js';
import { classify } from '../telegram/errors.js';

const PERM = 'settings.manage';

/** Display text of a setting value (plain). */
function valueText(lang, key, v) {
  const d = SETTINGS[key];
  if (d.type === 'bool') return tp(lang, v ? 'common.on' : 'common.off');
  if (key === 'ui.default_language') return v === 'en' ? 'English' : 'فارسی';
  if (key === 'forcejoin.failure_mode') return tp(lang, `fjm.mode.${v}`);
  if (key === 'music.language_auto') return tp(lang, `lauto.${v}`);
  if (d.type === 'int') return digits(v, lang);
  if (d.type === 'chat') return v ? String(v) : tp(lang, 'common.empty');
  if (d.type === 'text') return v ? truncate(String(v).replace(/\s+/g, ' '), 24) : tp(lang, 'common.empty');
  return String(v);
}

const label = (lang, key) => tp(lang, `set.key.${key}`);

async function listView(app) {
  const lang = app.lang;
  const rows = [];
  for (const key of EDITABLE_KEYS) {
    const d = SETTINGS[key];
    const later = d.phase && d.phase > CURRENT_PHASE ? ' ' + tp(lang, 'set.phase', { phase: d.phase }) : '';
    rows.push([btn(`${label(lang, key)}: ${valueText(lang, key, await app.settings.get(key))}${later}`.slice(0, 64), 'set', 'e', key)]);
  }
  rows.push([btn(tp(lang, 'set.btn_sync'), 'set', 'sync')]);
  rows.push([homeButton(lang)]);
  return { text: t(lang, 'set.title'), keyboard: markup(rows) };
}

const showList = async (app, user, cq) => screen(app, user, cq, await listView(app), 'settings');

export const routes = [
  { ns: 'set', action: 'home', args: [], perm: PERM, run: async (app, user, _a, cq) => { await showList(app, user, cq); return {}; } },
  {
    ns: 'set', action: 'e', args: ['key'], perm: PERM,
    async run(app, user, [key], cq) {
      const d = SETTINGS[key];
      if (!d || d.internal) return { toast: tp(app.lang, 'common.expired'), alert: true };
      const lang = app.lang;
      if (d.type === 'int') {
        await app.flows.start(user.telegram_id, 'set_int', { key });
        await app.tg.send(user.telegram_id, promptView(lang, t(lang, 'set.int_prompt', { label: label(lang, key), min: d.min, max: d.max, value: await app.settings.get(key) })), 'setting_prompt');
        return {};
      }
      if (d.type === 'text') {
        await app.flows.start(user.telegram_id, 'set_text', { key });
        await app.tg.send(user.telegram_id, promptView(lang, t(lang, 'set.text_prompt', { label: label(lang, key), vars: CAPTION_VARS.map((v) => `{${v}}`).join(' '), max: d.max || 512 })), 'setting_prompt');
        return {};
      }
      if (d.type === 'chat') {
        await app.flows.start(user.telegram_id, 'set_chat', { key });
        await app.tg.send(user.telegram_id, promptView(lang, t(lang, 'set.chat_prompt')), 'setting_prompt');
        return {};
      }
      const next = cycleValue(key, await app.settings.get(key));
      if (key === 'forcejoin.failure_mode') await app.forcejoin.setFailureMode(user, next);
      else await app.settings.set(user, key, next);
      if (key === 'ui.default_language' && !user.ui_language) app.lang = next;
      await showList(app, user, cq);
      return { toast: tp(lang, 'set.changed', { label: label(lang, key), value: valueText(lang, key, next) }) };
    },
  },
  {
    ns: 'set', action: 'sync', args: [], perm: PERM,
    async run(app) {
      const r = await syncCommandMenus(app);
      if (!r.failed) await app.settings.setInternal('commands.version', COMMANDS_VERSION);
      return { toast: tp(app.lang, 'set.synced', { ok: r.ok, failed: r.failed }), alert: true };
    },
  },
];

export const flows = {
  set_int: {
    perm: PERM,
    async run(app, user, message, flow) {
      const key = String(flow.data && flow.data.key);
      const d = SETTINGS[key];
      if (!d || d.type !== 'int') return app.flows.clear(user.telegram_id);
      const n = parseIntInRange(message.text, /** @type {number} */ (d.min), /** @type {number} */ (d.max));
      if (n === null || !validateSetting(key, n).ok) throw new UserError('set.err.int', { min: d.min, max: d.max });
      await app.settings.set(user, key, n);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'set.changed', { label: label(app.lang, key), value: valueText(app.lang, key, n) }) }, 'setting_saved');
      await app.tg.send(user.telegram_id, await listView(app), 'settings');
    },
  },
  set_text: {
    perm: PERM,
    maxInput: 1024,
    async run(app, user, message, flow) {
      const key = String(flow.data && flow.data.key);
      const d = SETTINGS[key];
      if (!d || d.type !== 'text') return app.flows.clear(user.telegram_id);
      const raw = String(message.text || '').trim();
      const value = raw === '-' ? '' : raw;
      if (value.length > (d.max || 512)) throw new UserError('common.input_too_long', { max: d.max || 512 });
      const unknown = unknownVariables(value);
      if (unknown.length) throw new UserError('set.err.vars', { vars: unknown.map((v) => `{${v}}`).join(' ') });
      if (value) {
        // validation by preview: Telegram must accept the rendered HTML
        const sample = { public_id: 'AbCdEfGh1', title: 'Sample Song', artist: 'Sample Artist', album: 'Sample Album', duration: 187, language: 'fa', genre: 'pop' };
        const text = renderCaption(value, captionValues(sample, { botUsername: BOT_USERNAME, languageName: (l) => tp(app.lang, `tlang.${l}`), genreName: (g) => tp(app.lang, `genre.${g}`) }));
        try {
          await app.tg.call('sendMessage', { chat_id: user.telegram_id, text: `${t(app.lang, 'set.preview')}\n\n${text || '—'}`, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, 'template_preview');
        } catch (e) {
          if (classify(e).kind === 'bad_caption' || classify(e).kind === 'bad_request') throw new UserError('set.err.template', { reason: classify(e).description });
          throw e;
        }
      }
      await app.settings.set(user, key, value);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'set.changed', { label: label(app.lang, key), value: valueText(app.lang, key, value) }) }, 'setting_saved');
      await app.tg.send(user.telegram_id, await listView(app), 'settings');
    },
  },
  set_chat: {
    perm: PERM,
    async run(app, user, message, flow) {
      const key = String(flow.data && flow.data.key);
      if (!SETTINGS[key] || SETTINGS[key].type !== 'chat') return app.flows.clear(user.telegram_id);
      let value = null;
      if (String(message.text || '').trim() !== '-') {
        const ref = parseChatRef(message.text || message.caption, message);
        if (!ref) throw new UserError('fjm.err.ref');
        if (ref.kind === 'invite') throw new UserError('fjm.err.invite');
        const info = await app.tg.inspectChannel(ref.kind === 'username' ? '@' + ref.value : ref.value);
        if (!info.ok) throw new UserError(info.error === 'transient' ? 'fjm.err.transient' : info.error === 'not_channel' ? 'fjm.err.not_channel' : 'fjm.err.not_found');
        if (info.chat.type !== 'channel') throw new UserError('fjm.err.not_channel');
        if (!info.isAdmin || !info.canPost) throw new UserError('set.err.chat_rights');
        value = info.chat.id;
      }
      await app.settings.set(user, key, value);
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'set.changed', { label: label(app.lang, key), value: valueText(app.lang, key, value) }) }, 'setting_saved');
      await app.tg.send(user.telegram_id, await listView(app), 'settings');
    },
  },
};
