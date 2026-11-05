// Commands: parsing (pure) and the scoped command menus (setMyCommands).
import { BOT_USERNAME, OWNER_ID, LIMITS, COMMANDS_VERSION } from '../config/static.js';
import { tp } from '../i18n/index.js';
import { classify } from '../telegram/errors.js';

/**
 * "/cmd@Bot args" → { name, args }. A command addressed to another bot → null.
 * @param {string|undefined} text @returns {{name: string, args: string} | null}
 */
export function parseCommand(text) {
  if (typeof text !== 'string' || !text.startsWith('/')) return null;
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: (m[3] || '').trim().slice(0, LIMITS.commandArgsMax) };
}

/**
 * /start payloads: join, search, t_<publicId>. Anything else is a plain start (untrusted input).
 * @param {string} args @returns {{kind: 'none'|'join'|'search'|'track', publicId?: string}}
 */
export function parseStartPayload(args) {
  const p = String(args || '').trim();
  if (!p || p.length > LIMITS.startPayloadMax) return { kind: 'none' };
  if (p === 'join') return { kind: 'join' };
  if (p === 'search') return { kind: 'search' };
  const m = /^t_([A-Za-z0-9]{8,10})$/.exec(p);
  return m ? { kind: 'track', publicId: m[1] } : { kind: 'none' };
}

const USER_COMMANDS = ['start', 'search', 'help', 'lang', 'cancel'];
const STAFF_COMMANDS = ['start', 'search', 'help', 'lang', 'cancel', 'admin'];

/** @param {string[]} names @param {string} lang */
const commandList = (names, lang) => names.map((c) => ({ command: c, description: tp(lang, `cmd.${c}`) }));

/**
 * Default scope for users (Persian, plus English for English clients); chat scope for the owner
 * and each admin (with /admin). @param {{tg: any, users: any, log: any}} app
 * @param {{only?: number[], removed?: number[]}} [opts] limit to some chats; `removed` drops their chat menu
 * @returns {Promise<{ok: number, failed: number}>}
 */
export async function syncCommandMenus(app, opts = {}) {
  const res = { ok: 0, failed: 0 };
  const run = async (fn) => {
    try {
      await fn();
      res.ok += 1;
    } catch (e) {
      res.failed += 1;
      app.log.warn('set_commands_failed', { error_code: classify(e).code, error: classify(e).kind });
    }
  };
  if (!opts.only && !opts.removed) {
    await run(() => app.tg.setMyCommands({ commands: commandList(USER_COMMANDS, 'fa') }));
    await run(() => app.tg.setMyCommands({ commands: commandList(USER_COMMANDS, 'en'), language_code: 'en' }));
  }
  const staff = opts.only || (opts.removed ? [] : [OWNER_ID, ...(await app.users.adminIds())]);
  for (const id of staff) {
    const u = await app.users.get(id);
    const lang = await app.users.languageOf(u);
    await run(() => app.tg.setMyCommands({ commands: commandList(STAFF_COMMANDS, lang), scope: { type: 'chat', chat_id: id } }));
  }
  for (const id of opts.removed || []) await run(() => app.tg.deleteMyCommands({ scope: { type: 'chat', chat_id: id } }));
  return res;
}

/** Sets up the command menus once (and again after COMMANDS_VERSION changes). Best effort. */
export async function ensureCommandMenus(app) {
  if (Number(await app.settings.get('commands.version')) >= COMMANDS_VERSION) return null;
  const r = await syncCommandMenus(app);
  if (!r.failed) await app.settings.setInternal('commands.version', COMMANDS_VERSION);
  return r;
}
