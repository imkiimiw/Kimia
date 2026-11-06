// The user dashboard (Phase 2): builds the screen for a menu target. Gates (ban, maintenance,
// language, forced join, disclaimer) are applied by lib/router.js before anything here runs.
import { HISTORY_MAX, HISTORY_PAGE } from './config.js';
import * as downloads from './db/downloads.js';
import * as users from './db/users.js';
import * as ui from './ui.js';

/** → { view, screen } for target 'home' | 'downloads' | 'settings' | 'quality' | 'help' | 'about'. */
export async function build(user, target, arg = 0) {
  const lang = user.lang;
  switch (target) {
    case 'downloads': {
      const total = await downloads.countRecent(user.id, HISTORY_MAX);
      const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
      const page = Math.min(Math.max(0, Number(arg) || 0), pages - 1);
      const offset = page * HISTORY_PAGE;
      const limit = Math.min(HISTORY_PAGE, total - offset); // never past the latest HISTORY_MAX
      const items = limit > 0 ? await downloads.page(user.id, offset, limit) : [];
      return { view: 'downloads', screen: ui.history(lang, { items, page, pages, total }) };
    }
    case 'settings':
      return { view: 'settings', screen: ui.settings(lang, await users.getQuality(user.id)) };
    case 'quality':
      return { view: 'quality', screen: ui.qualityPicker(lang, await users.getQuality(user.id)) };
    case 'help':
      return { view: 'help', screen: ui.help(lang) };
    case 'about':
      return { view: 'about', screen: ui.about(lang) };
    default:
      return { view: 'home', screen: ui.home(lang, user.name) };
  }
}

/** Private-chat commands → menu targets (anything else opens home). */
export const COMMAND_TARGETS = { help: 'help', about: 'about', settings: 'settings', downloads: 'downloads', history: 'downloads' };
