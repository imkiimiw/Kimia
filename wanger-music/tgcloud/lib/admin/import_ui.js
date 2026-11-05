// Import of audio sent or forwarded by an admin (no command needed, outside other flows).
// One audio → the import card. A run of forwards (≤ 60 s apart) → the first gets a card, the rest
// are counted in ONE summary message (setting import.bulk_summary), so 50 forwards don't flood the chat.
import { t, tp } from '../i18n/index.js';
import { btn, markup } from '../bot/keyboards.js';
import { can } from '../permissions/policy.js';
import { mediaRefusal } from '../music/ingest.js';
import { trackView } from './music_ui.js';
import { truncate } from '../core/util.js';

const PERM = 'catalog.manage';

function summaryView(lang, s) {
  return {
    text: t(lang, 'imp.summary', { total: s.total, created: s.created, duplicates: s.duplicates, review: s.review }),
    keyboard: markup([[btn(tp(lang, 'imp.btn_review'), 'mus', 'ls', 'draft', 0), btn(tp(lang, 'imp.btn_refresh'), 'imp', 'ref')]]),
  };
}

function duplicateView(lang, tr) {
  return {
    text: t(lang, 'imp.duplicate', { title: truncate(tr.title || tp(lang, 'trk.untitled'), 60), artist: truncate(tr.artist || '?', 60), status: tp(lang, `trk.status.${tr.status}`) }),
    keyboard: markup([[btn(tp(lang, 'imp.btn_open'), 'trk', 'v', tr.id)]]),
  };
}

/**
 * Handles an audio / voice / document message from staff. @returns {Promise<boolean>} handled
 */
export async function handleMedia(app, user, message) {
  if (!can(user, PERM)) return false;
  const chat = user.telegram_id;
  const lang = app.lang;
  const refusal = mediaRefusal(message);
  if (refusal) {
    await app.tg.send(chat, { text: t(lang, refusal) }, 'import_refused');
    return true;
  }
  const result = await app.ingest.importAudio(user, message);
  const session = await app.ingest.recordSession(chat, result);
  const bulk = (await app.settings.get('import.bulk_summary')) && session && session.total > 1;
  if (!bulk) {
    if (result.kind === 'created') await app.tg.send(chat, await trackView(app, user, result.track, { header: t(lang, 'imp.header') }), 'import_card');
    else await app.tg.send(chat, duplicateView(lang, result.existing), 'import_duplicate');
    return true;
  }
  if (session.message_id > 0) {
    await app.tg.edit(chat, session.message_id, summaryView(lang, session), 'import_summary');
  } else if (session.message_id === null && (await app.ingest.claimSummary(chat, session.started_at))) {
    const m = await app.tg.send(chat, summaryView(lang, session), 'import_summary');
    if (m && m.message_id) await app.ingest.setSummaryMessage(chat, session.started_at, m.message_id);
  }
  return true;
}

export const routes = [
  {
    ns: 'imp', action: 'ref', args: [], perm: PERM,
    async run(app, user, _a, cq) {
      const s = await app.ingest.getSession(user.telegram_id);
      if (s && cq.message) await app.tg.edit(user.telegram_id, cq.message.message_id, summaryView(app.lang, s), 'import_summary');
      return {};
    },
  },
];
