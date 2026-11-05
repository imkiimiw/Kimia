// BroadcastService: owner → everyone, with copyMessage, in batches run by the tick.
// States: draft → running ⇄ paused → done | cancelled. Every transition is a conditional UPDATE.
// A batch holds a lease (lock_until) so two invocations never send the same batch; each recipient's
// outcome is stored right after its send, so a crash repeats at most one message.
import { assertCan } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { classify } from '../telegram/errors.js';
import { bulkPaceAllows, cooldownActive, cooldownAfter429 } from '../telegram/limiter.js';

const LEASE_SECONDS = 120;

/** Can this message be copied as a broadcast? (pure) @returns {string|null} an i18n error key */
export function broadcastRefusal(message) {
  if (!message) return 'bc.err.unsupported';
  if (message.media_group_id) return 'bc.err.album';
  const copyable = ['text', 'photo', 'video', 'animation', 'audio', 'document', 'voice', 'video_note', 'sticker', 'poll', 'location', 'venue', 'contact', 'dice'];
  return copyable.some((k) => message[k] !== undefined) ? null : 'bc.err.unsupported';
}

/**
 * @param {{repo: any, users: any, tg: any, settings: any, audit: any, clock: any, log: any, notify?: (b: any, info: {done: boolean}) => Promise<any>}} deps
 */
export function createBroadcastService({ repo, users, tg, settings, audit, clock, log, notify }) {
  /** One copy with one quick retry on a transient error. @returns {Promise<'sent'|'blocked'|'failed'|{rateLimit: number}>} */
  async function deliver(b, telegramId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await tg.copy(telegramId, b.source_chat_id, b.source_message_id, 'broadcast');
        return 'sent';
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'rate_limit') return { rateLimit: c.retryAfter };
        if (c.kind === 'blocked') return 'blocked'; // the client's hook already marked the user
        if (c.kind !== 'transient' || attempt === 1) return 'failed';
      }
    }
    return 'failed';
  }

  const svc = {
    get: (id) => repo.get(id),
    recent: (n = 5) => repo.recent(n),
    active: () => repo.active(),

    /** Stores the owner's message as a draft. */
    async createDraft(actor, message) {
      assertCan(actor, 'broadcast.send');
      const refusal = broadcastRefusal(message);
      if (refusal) throw new UserError(refusal);
      return repo.create({ created_by: actor.telegram_id, source_chat_id: message.chat.id, source_message_id: message.message_id, now: clock.now() });
    },

    async discard(actor, id) {
      assertCan(actor, 'broadcast.send');
      return (await repo.deleteDraft(id)) > 0;
    },

    /** draft → running (one broadcast at a time). The progress message is the one the owner tapped. */
    async start(actor, id, progressChatId, progressMessageId) {
      assertCan(actor, 'broadcast.send');
      const total = await users.countRecipients();
      if (!total) throw new UserError('bc.err.empty');
      const row = await repo.start(id, total, clock.now(), progressChatId, progressMessageId);
      if (!row) throw new UserError((await repo.active()) ? 'bc.err.busy' : 'bc.err.state');
      await audit.record(actor, 'broadcast.start', 'broadcast', id, { total });
      return row;
    },

    /** @param {'pause'|'resume'|'cancel'} action */
    async control(actor, id, action) {
      assertCan(actor, 'broadcast.send');
      const map = { pause: [['running'], 'paused'], resume: [['paused'], 'running'], cancel: [['running', 'paused'], 'cancelled'] };
      const [from, to] = map[action];
      const row = await repo.transition(id, from, to, clock.now());
      if (!row) throw new UserError('bc.err.state');
      await audit.record(actor, `broadcast.${action}`, 'broadcast', id);
      return row;
    },

    /**
     * Sends the next batch of one running broadcast (the given id, or the oldest runnable one).
     * Stops at the batch size, the time budget, the pace limit, a 429, or a status change.
     * @param {{deadlineMs: number, id?: number}} opts
     */
    async runBatch({ deadlineMs, id }) {
      const now = clock.now();
      const cooldownUntil = Number(await settings.get('telegram.cooldown_until'));
      if (cooldownActive(now, cooldownUntil)) return { skipped: 'cooldown', until: cooldownUntil };
      const candidate = id ? await repo.get(id) : await repo.nextRunnable(now);
      if (!candidate || candidate.status !== 'running') return { skipped: 'none' };
      const b = await repo.claim(candidate.id, now, now + LEASE_SECONDS);
      if (!b) return { skipped: 'locked' };

      const batchSize = Number(await settings.get('broadcast.batch_size'));
      const recipients = await users.recipientsAfter(b.cursor_user_id, batchSize);
      const counts = { sent: 0, failed: 0, blocked: 0 };
      let stopped = null;
      const startMs = clock.ms();
      for (const r of recipients) {
        if (clock.ms() >= deadlineMs) { stopped = 'budget'; break; }
        if (!bulkPaceAllows(counts.sent + counts.failed + counts.blocked, clock.ms() - startMs)) { stopped = 'pace'; break; }
        const outcome = await deliver(b, r.telegram_id);
        if (typeof outcome === 'object') {
          await settings.setInternal('telegram.cooldown_until', cooldownAfter429(clock.now(), outcome.rateLimit));
          stopped = 'rate_limit';
          break;
        }
        counts[outcome] += 1;
        const status = await repo.recordOne(b.id, r.id, outcome);
        if (status !== 'running') { stopped = status ? 'status' : 'cursor'; break; }
      }

      let done = false;
      if (!stopped && recipients.length < batchSize) done = !!(await repo.transition(b.id, ['running'], 'done', clock.now()));
      if (!done) await repo.release(b.id);
      const after = await repo.get(b.id);
      log.info('broadcast_batch', { broadcast_id: b.id, count: recipients.length, status: after && after.status, error: stopped });
      if (notify && after) {
        try {
          await notify(after, { done });
        } catch (e) {
          log.warn('broadcast_notify_failed', { broadcast_id: b.id, error: String(e && e.message).slice(0, 200) });
        }
      }
      return { id: b.id, ...counts, stopped, done };
    },
  };
  return svc;
}
