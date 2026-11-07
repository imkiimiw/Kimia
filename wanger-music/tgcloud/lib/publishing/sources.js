// SourcesService (spec §10.1): Telegram channels — and, since the owner asked, groups — where the bot
// is admin, whose NEW audio posts run the ingestion pipeline (normalize → dedupe → classify → draft
// or active track). It never publishes. Posts from unregistered chats are ignored. Bots can't read
// history, so only posts made after the bot became an admin arrive (in a group, being admin is also
// what makes Telegram deliver every message, not only commands).
import { LIMITS } from '../config/static.js';
import { assertCan, SYSTEM_ACTOR } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { parseChatRef } from '../telegram/chatref.js';
import { originOf } from '../music/ingest.js';
import { t } from '../i18n/index.js';
import { NOOP_STATS } from '../stats/service.js';

const PERM = 'sources.manage';
export const MODES = Object.freeze(['off', 'draft', 'active']);
export const SOURCE_LANGUAGES = Object.freeze([null, 'fa', 'en', 'other']);
/** Chat kinds a source can be. */
export const SOURCE_CHAT_TYPES = Object.freeze(['channel', 'supergroup', 'group']);
export const isGroupChat = (chat) => !!chat && (chat.type === 'group' || chat.type === 'supergroup');

/** Did this my_chat_member make the bot an admin of a channel or group it wasn't admin of? (pure) */
export function botBecameAdmin(upd) {
  if (!upd || !upd.chat || !SOURCE_CHAT_TYPES.includes(upd.chat.type)) return false;
  const was = upd.old_chat_member && upd.old_chat_member.status;
  const now = upd.new_chat_member && upd.new_chat_member.status;
  return (now === 'administrator' || now === 'creator') && was !== 'administrator' && was !== 'creator';
}

/**
 * @param {{repo: any, tg: any, ingest: any, catalog: any, alerts: any, audit: any, clock: any, log: any, stats?: any, askLanguage?: (src: any) => Promise<boolean>}} deps
 */
export function createSourcesService({ repo, tg, ingest, catalog, alerts, audit, clock, log, stats = NOOP_STATS, askLanguage = async (_src) => false }) {
  async function mustGet(id) {
    const s = await repo.get(id);
    if (!s) throw new UserError('src.err.gone');
    return s;
  }

  async function change(actor, id, patch, action) {
    assertCan(actor, PERM);
    const s = await mustGet(id);
    const row = await repo.update(id, patch, clock.now());
    await audit.record(actor, action, 'source', s.chat_id, patch);
    return row;
  }

  return {
    list: () => repo.list(),
    get: (id) => repo.get(id),
    getByChatId: (chatId) => repo.getByChatId(chatId),

    /** Adds a channel or group from a forwarded post, @username, t.me link or numeric id. */
    async add(actor, text, message) {
      assertCan(actor, PERM);
      const ref = parseChatRef(text, message);
      if (!ref) throw new UserError('fjm.err.ref');
      if (ref.kind === 'invite') throw new UserError('fjm.err.invite');
      const info = await tg.inspectChannel(ref.kind === 'username' ? '@' + ref.value : ref.value, { allowGroups: true });
      if (!info.ok) throw new UserError({ not_channel: 'src.err.not_channel', transient: 'fjm.err.transient' }[info.error] || 'fjm.err.not_found');
      if (!SOURCE_CHAT_TYPES.includes(info.chat.type)) throw new UserError('src.err.not_channel');
      if (!info.isAdmin) throw new UserError('src.err.not_admin', { title: info.chat.title || '' });
      if (await repo.getByChatId(info.chat.id)) throw new UserError('src.err.duplicate');
      const row = await repo.insert({ chat_id: info.chat.id, username: info.chat.username || null, title: String(info.chat.title || '').slice(0, 128), chat_type: info.chat.type, max: LIMITS.sourcesMax, now: clock.now() });
      if (!row) throw new UserError((await repo.getByChatId(info.chat.id)) ? 'src.err.duplicate' : 'src.err.max', { max: LIMITS.sourcesMax });
      await audit.record(actor, 'source.add', 'source', row.chat_id, { title: row.title });
      return row;
    },

    toggle: async (actor, id) => change(actor, id, { enabled: (await mustGet(id)).enabled ? 0 : 1 }, 'source.toggle'),
    async cycleMode(actor, id) {
      const s = await mustGet(id);
      return change(actor, id, { auto_import: MODES[(MODES.indexOf(s.auto_import) + 1) % MODES.length] }, 'source.mode');
    },
    async cycleLanguage(actor, id) {
      const s = await mustGet(id);
      const next = SOURCE_LANGUAGES[(SOURCE_LANGUAGES.indexOf(s.default_language) + 1) % SOURCE_LANGUAGES.length];
      const row = await change(actor, id, { default_language: next }, 'source.language');
      if (next) await catalog.applySourceLanguage(actor, id, next, clock.ms() + 10000);
      return row;
    },
    /**
     * The owner's answer to "what language are this source's songs?": becomes the source's default and
     * is given to the tracks it already imported whose language nobody decided.
     * @returns {Promise<{source: any, updated: number, routed: number, more: boolean}>}
     */
    async setDefaultLanguage(actor, id, language) {
      if (!['fa', 'en', 'other'].includes(language)) throw new UserError('src.err.gone');
      const source = await change(actor, id, { default_language: language }, 'source.language');
      return { source, ...(await catalog.applySourceLanguage(actor, id, language, clock.ms() + 15000)) };
    },

    /** Removes the source; its tracks stay (they keep source_id and their origin post). */
    async remove(actor, id) {
      assertCan(actor, PERM);
      const s = await mustGet(id);
      await repo.remove(id);
      await audit.record(actor, 'source.remove', 'source', s.chat_id, { title: s.title });
      return s;
    },

    /**
     * channel_post, or a message in a group: imports an audio post of an enabled source.
     * @returns {Promise<string>} what happened (for the handler's result / logs)
     */
    async handlePost(post) {
      if (!post || !post.chat || !SOURCE_CHAT_TYPES.includes(post.chat.type)) return 'ignored';
      const src = await repo.getByChatId(post.chat.id);
      if (!src) return 'unregistered';
      if (post.migrate_to_chat_id && Number.isSafeInteger(post.migrate_to_chat_id)) {
        // a basic group became a supergroup: same source, new chat id
        await repo.moveChat(src.id, post.migrate_to_chat_id, 'supergroup', clock.now());
        log.info('source_migrated', { chat_id: post.migrate_to_chat_id });
        return 'migrated';
      }
      if (!src.enabled || src.auto_import === 'off') return 'off';
      if (!post.audio) return 'not_audio';
      const fwd = originOf(post);
      const origin = fwd.chatId ? fwd : { chatId: post.chat.id, messageId: post.message_id };
      const r = await ingest.importAudio(SYSTEM_ACTOR, post, { sourceType: 'telegram_channel', sourceId: src.id, sourceDefaultLanguage: src.default_language, origin });
      const now = clock.now();
      await repo.recordPost(src.id, now, r.kind === 'created');
      stats.count('source.post', src.id);
      if (r.kind === 'created') stats.count('source.import', src.id);
      else stats.count('source.duplicate', src.id);
      if ((post.chat.title && post.chat.title !== src.title) || (post.chat.username || null) !== src.username) {
        await repo.update(src.id, { title: String(post.chat.title || src.title || '').slice(0, 128), username: post.chat.username || null }, now);
      }
      if (r.kind !== 'created') return 'duplicate';
      // no default language and the script couldn't tell: ask the owner once for the whole source
      if (!src.default_language && r.track.language_source === 'heuristic' && (r.track.language === 'unknown' || r.track.language_confidence === 'low')) await askLanguage(src);
      if (src.auto_import === 'active') {
        try {
          await catalog.activate(SYSTEM_ACTOR, r.track.id);
          return 'active';
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          log.info('source_track_left_draft', { track_id: r.track.id, error: e.key });
        }
      }
      await alerts.owner(`src:${src.id}`, (lang) => t(lang, 'alert.src_drafts', { title: src.title || String(src.chat_id) }), LIMITS.alertSourceEverySeconds);
      return 'draft';
    },

    /** my_chat_member in a source channel or group: warns the owner when the bot is no longer an admin. */
    async onBotStatusChange(chat, member) {
      const src = await repo.getByChatId(chat.id);
      if (!src) return false;
      const ok = member && (member.status === 'administrator' || member.status === 'creator');
      if (!ok) await alerts.owner(`src_removed:${src.id}`, (lang) => t(lang, 'alert.src_removed', { title: src.title || String(src.chat_id) }), LIMITS.alertSourceEverySeconds);
      return true;
    },
  };
}
