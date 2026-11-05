// DestinationsService (spec §10.2): channels tracks will be published to in Phase 6. Adding checks
// the bot is an admin with "Post messages" (edit/delete recommended for takedowns). New channels
// start disabled, auto-publish off, approval on. NOTHING is posted in Phase 5.
import { LIMITS, TIME_ZONES, GENRES } from '../config/static.js';
import { assertCan } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { parseChatRef } from '../telegram/chatref.js';
import { normalizeRules, toggleIn, RULE_LANGUAGES, DEFAULT_RULES } from './rules.js';
import { unknownVariables } from './captions.js';
import { CONFIDENCE_ORDER } from '../config/static.js';
import { t } from '../i18n/index.js';

const PERM = 'destinations.manage';

/** The bot's rights from getChatMember (pure). */
export function rightsOf(member, chat, now, error = null) {
  const admin = !!member && (member.status === 'administrator' || member.status === 'creator');
  const creator = !!member && member.status === 'creator';
  return {
    admin,
    post: creator || (admin && member.can_post_messages === true),
    edit: creator || (admin && member.can_edit_messages === true),
    delete: creator || (admin && member.can_delete_messages === true),
    checked_at: now,
    error,
    type: chat ? chat.type : null,
  };
}

/** Parsed bot_rights JSON. */
export function storedRights(d) {
  try {
    return d && d.bot_rights ? JSON.parse(d.bot_rights) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{repo: any, tg: any, settings: any, alerts: any, audit: any, clock: any, log: any, onRemoved?: (id: number) => Promise<any>}} deps
 */
export function createDestinationsService({ repo, tg, settings, alerts, audit, clock, log, onRemoved = async () => {} }) {
  async function mustGet(id) {
    const d = await repo.get(id);
    if (!d) throw new UserError('dst.err.gone');
    return d;
  }

  async function change(actor, id, patch, action, details = patch) {
    assertCan(actor, PERM);
    const d = await mustGet(id);
    const now = clock.now();
    await repo.update(id, patch, now);
    const row = await repo.syncPublishingSince(id, now); // set when enabled + auto-publish turn on
    await audit.record(actor, action, 'destination', d.chat_id, details);
    return row;
  }

  /** getChat + the bot's own member record. */
  async function inspect(ref) {
    const info = await tg.inspectChannel(ref);
    if (!info.ok) return { ok: false, error: info.error };
    return { ok: true, chat: info.chat, rights: rightsOf(info.member, info.chat, clock.now()) };
  }

  const svc = {
    list: () => repo.list(),
    get: (id) => repo.get(id),
    getByChatId: (chatId) => repo.getByChatId(chatId),

    /**
     * Adds (or brings back) a channel. @param {{language?: string|null}} [opts] a first rules language
     */
    async add(actor, text, message, opts = {}) {
      assertCan(actor, PERM);
      const ref = parseChatRef(text, message);
      if (!ref) throw new UserError('fjm.err.ref');
      if (ref.kind === 'invite') throw new UserError('fjm.err.invite');
      const info = await inspect(ref.kind === 'username' ? '@' + ref.value : ref.value);
      if (!info.ok) throw new UserError({ not_channel: 'dst.err.not_channel', transient: 'fjm.err.transient' }[info.error] || 'fjm.err.not_found');
      if (info.chat.type !== 'channel') throw new UserError('dst.err.not_channel');
      if (!info.rights.admin || !info.rights.post) throw new UserError('dst.err.rights', { title: info.chat.title || '' });
      const now = clock.now();
      const base = { username: info.chat.username || null, title: String(info.chat.title || '').slice(0, 128), bot_rights_ok: 1, bot_rights: info.rights, now };
      const existing = await repo.getByChatId(info.chat.id);
      let row;
      if (existing && existing.removed_at === null) throw new UserError('dst.err.duplicate');
      if (existing) row = await repo.revive(existing.id, base);
      else {
        if ((await repo.count()) >= LIMITS.destinationsMax) throw new UserError('dst.err.max', { max: LIMITS.destinationsMax });
        const rules = { ...DEFAULT_RULES, languages: RULE_LANGUAGES.includes(opts.language) ? [opts.language] : [] };
        row = await repo.insert({ ...base, chat_id: info.chat.id, rules, time_zone: await settings.get('time_zone') });
      }
      if (!row) throw new UserError('dst.err.duplicate');
      await audit.record(actor, existing ? 'destination.restore' : 'destination.add', 'destination', row.chat_id, { title: row.title });
      return row;
    },

    toggleEnabled: async (actor, id) => change(actor, id, { enabled: (await mustGet(id)).enabled ? 0 : 1 }, 'destination.enabled'),
    toggleAuto: async (actor, id) => change(actor, id, { auto_publish: (await mustGet(id)).auto_publish ? 0 : 1 }, 'destination.auto_publish'),
    toggleApproval: async (actor, id) => change(actor, id, { approval_required: (await mustGet(id)).approval_required ? 0 : 1 }, 'destination.approval'),
    async cycleFormat(actor, id) {
      const d = await mustGet(id);
      return change(actor, id, { post_format: d.post_format === 'audio' ? 'cover_then_audio' : 'audio' }, 'destination.format');
    },
    async cycleTimeZone(actor, id) {
      const zones = Object.keys(TIME_ZONES);
      const d = await mustGet(id);
      return change(actor, id, { time_zone: zones[(zones.indexOf(d.time_zone) + 1) % zones.length] }, 'destination.time_zone');
    },
    async cycleConfidence(actor, id) {
      const d = await mustGet(id);
      const r = normalizeRules(d.rules);
      const next = CONFIDENCE_ORDER[(CONFIDENCE_ORDER.indexOf(r.min_language_confidence) + 1) % CONFIDENCE_ORDER.length];
      return change(actor, id, { rules: { ...r, min_language_confidence: next } }, 'destination.rules', { min_language_confidence: next });
    },
    async toggleLanguage(actor, id, language) {
      if (!RULE_LANGUAGES.includes(language)) throw new UserError('dst.err.gone');
      const d = await mustGet(id);
      return change(actor, id, { rules: toggleIn(d.rules, 'languages', language) }, 'destination.rules', { language });
    },
    /** @param {'inc'|'exc'} mode */
    async toggleGenre(actor, id, mode, genre) {
      if (!GENRES.includes(genre)) throw new UserError('dst.err.gone');
      const d = await mustGet(id);
      return change(actor, id, { rules: toggleIn(d.rules, mode === 'exc' ? 'exclude_genres' : 'genres', genre) }, 'destination.rules', { mode, genre });
    },
    /** null → the default template. The UI validates by a preview before calling this. */
    async setTemplate(actor, id, template) {
      if (template !== null && (template.length > LIMITS.captionTemplateMax || unknownVariables(template).length)) throw new UserError('dst.err.template');
      return change(actor, id, { caption_template: template }, 'destination.caption', { set: template !== null });
    },
    setMinInterval: (actor, id, seconds) => change(actor, id, { min_interval_seconds: seconds }, 'destination.interval'),
    setDailyLimit: (actor, id, n) => change(actor, id, { daily_limit: n }, 'destination.daily_limit'),
    setHours: (actor, id, hours) => change(actor, id, { active_hours: hours }, 'destination.hours', { hours }),

    /** Re-reads title and the bot's rights; a channel without post rights is disabled. */
    async checkRights(actor, id) {
      assertCan(actor, PERM);
      const d = await mustGet(id);
      const info = await inspect(d.chat_id);
      const now = clock.now();
      const rights = info.ok ? info.rights : rightsOf(null, null, now, info.error);
      const ok = !!(info.ok && rights.admin && rights.post);
      const patch = { bot_rights_ok: ok ? 1 : 0, bot_rights: rights, ...(info.ok ? { title: String(info.chat.title || d.title || '').slice(0, 128), username: info.chat.username || null } : {}), ...(ok ? {} : { enabled: 0 }) };
      await repo.update(id, patch, now);
      return repo.syncPublishingSince(id, now);
    },

    /** Soft removal: hidden, disabled; its row (and later its publication history) is kept. */
    async remove(actor, id) {
      assertCan(actor, PERM);
      const d = await mustGet(id);
      await repo.softRemove(id, clock.now());
      await repo.syncPublishingSince(id, clock.now());
      await onRemoved(id); // waiting publications are cancelled
      await audit.record(actor, 'destination.remove', 'destination', d.chat_id, { title: d.title });
      return d;
    },

    /** my_chat_member in a destination channel: rights refresh; losing post rights disables it and alerts. */
    async onBotStatusChange(chat, member) {
      const d = await repo.getByChatId(chat.id);
      if (!d || d.removed_at !== null) return false;
      const now = clock.now();
      const rights = rightsOf(member, chat, now);
      const ok = rights.admin && rights.post;
      await repo.update(d.id, { bot_rights_ok: ok ? 1 : 0, bot_rights: rights, ...(ok ? {} : { enabled: 0 }), ...(chat.title ? { title: String(chat.title).slice(0, 128) } : {}) }, now);
      await repo.syncPublishingSince(d.id, now);
      if (!ok) {
        log.warn('destination_unhealthy', { channel_id: chat.id, status: member && member.status });
        await alerts.owner(`dst:${d.id}`, (lang) => t(lang, 'alert.dst_unhealthy', { title: d.title || String(d.chat_id) }), LIMITS.alertDestinationEverySeconds);
      }
      return true;
    },
  };
  return svc;
}
