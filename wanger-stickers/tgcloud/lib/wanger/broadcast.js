// Broadcast engine (brief §7; adapted from wanger-music lib/broadcast/service.js).
// draft → running ⇄ paused → done | cancelled; every transition is a conditional UPDATE.
// A batch holds a lease, so two invocations never send the same batch. Before each send the
// recipient is marked "in flight"; the cursor moves only after Telegram confirmed the send. If an
// invocation dies mid-send, the recipient stays in flight and the next batch skips it as
// "uncertain" — nobody ever gets the message twice.
import { broadcasts as bdb } from '../db/broadcasts.js';
import { users } from '../db/users.js';
import { UserError, PermissionError } from '../core/util.js';
import { classify } from '../core/errors.js';
import { bulkPaceAllows, cooldownActive, cooldownAfter429 } from '../core/limiter.js';
import { OWNER_ID, T } from '../config.js';

export const AUDIENCES = Object.freeze(['all', 'fa', 'en', 'active30', 'pro']);
export const MODES = Object.freeze(['copy', 'forward']);

/** Can this message be broadcast? (pure) @returns {string|null} an i18n error key */
export function broadcastRefusal(message) {
  if (!message) return 'bc.err.unsupported';
  if (message.media_group_id) return 'bc.err.album';
  const ok = ['text', 'photo', 'video', 'animation', 'audio', 'document', 'voice', 'video_note', 'sticker', 'poll', 'location', 'venue', 'contact', 'dice'];
  return ok.some((k) => message[k] !== undefined) ? null : 'bc.err.unsupported';
}

/** @param {any} app @param {{notify?: (b: any, info: {done: boolean}) => Promise<any>}} [hooks] */
export function createBroadcast(app, hooks = {}) {
  const { clock, tg, settings, log } = app;
  const assertOwner = (actorId) => {
    if (actorId !== OWNER_ID) throw new PermissionError('broadcast');
  };

  async function deliver(b, tgId) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (b.mode === 'forward') await tg.forward(tgId, b.source_chat_id, b.source_message_id, 'broadcast');
        else await tg.copy(tgId, b.source_chat_id, b.source_message_id, 'broadcast');
        return 'sent';
      } catch (e) {
        const c = classify(e);
        if (c.kind === 'rate_limit') return { rateLimit: c.retryAfter };
        if (c.kind === 'blocked' || c.kind === 'chat_gone') {
          await users.markBlocked(tgId, true);
          return 'blocked';
        }
        if (c.kind !== 'transient' || attempt === 1) return 'failed';
      }
    }
    return 'failed';
  }

  return {
    get: (id) => bdb.get(id),
    active: () => bdb.active(),
    recent: (n = 5) => bdb.recent(n),
    countRecipients: (audience) => users.countRecipients(audience, clock.now()),

    async createDraft(actorId, message) {
      assertOwner(actorId);
      const refusal = broadcastRefusal(message);
      if (refusal) throw new UserError(refusal);
      return bdb.create({ created_by: actorId, source_chat_id: message.chat.id, source_message_id: message.message_id }, clock.now());
    },
    async setOptions(actorId, id, mode, audience) {
      assertOwner(actorId);
      if (!MODES.includes(mode) || !AUDIENCES.includes(audience)) throw new UserError('bc.err.state');
      const row = await bdb.setOptions(id, mode, audience);
      if (!row) throw new UserError('bc.err.state');
      return row;
    },
    async discard(actorId, id) {
      assertOwner(actorId);
      return (await bdb.deleteDraft(id)) > 0;
    },
    async start(actorId, id, chatId, messageId) {
      assertOwner(actorId);
      const draft = await bdb.get(id);
      if (!draft || draft.status !== 'draft') throw new UserError('bc.err.state');
      const total = await users.countRecipients(draft.audience, clock.now());
      if (!total) throw new UserError('bc.err.empty');
      const row = await bdb.start(id, total, clock.now(), chatId, messageId);
      if (!row) throw new UserError((await bdb.active()) ? 'bc.err.busy' : 'bc.err.state');
      await app.audit(actorId, 'broadcast.start', id, `${draft.mode}/${draft.audience}/${total}`);
      return row;
    },
    /** @param {'pause'|'resume'|'cancel'} action */
    async control(actorId, id, action) {
      assertOwner(actorId);
      const map = { pause: [['running'], 'paused'], resume: [['paused'], 'running'], cancel: [['running', 'paused'], 'cancelled'] };
      const [from, to] = map[action];
      const row = await bdb.transition(id, from, to, clock.now());
      if (!row) throw new UserError('bc.err.state');
      await app.audit(actorId, `broadcast.${action}`, id);
      return row;
    },

    /**
     * Sends the next slice of the running broadcast (the given id or the oldest runnable one).
     * Stops at the batch size, the time budget, the pace limit, a 429 or a status change.
     * @param {{deadlineMs: number, id?: number, max?: number}} opts
     */
    async runBatch({ deadlineMs, id, max }) {
      const now = clock.now();
      if (cooldownActive(now, Number(settings.get('telegram.cooldown_until') || 0))) return { skipped: 'cooldown' };
      const candidate = id ? await bdb.get(id) : await bdb.nextRunnable(now);
      if (!candidate || candidate.status !== 'running') return { skipped: 'none' };
      const b = await bdb.claim(candidate.id, now, now + T.broadcastLeaseSec);
      if (!b) return { skipped: 'locked' };
      // a recipient left in flight by an invocation that died mid-send: skip it, never re-send
      if (b.inflight_tg_id) {
        await bdb.skipInflight(b.id);
        log.warn('broadcast_uncertain', { broadcast_id: b.id, user_id: b.inflight_tg_id });
      }
      const fresh = await bdb.get(b.id);
      const size = Math.min(Number(settings.get('broadcast.batch')), max || Infinity);
      const recipients = await users.recipientsAfter(fresh.cursor_tg_id, fresh.audience, size, now);
      const counts = { sent: 0, failed: 0, blocked: 0 };
      let stopped = null;
      const startMs = clock.ms();
      for (const r of recipients) {
        if (clock.ms() >= deadlineMs) { stopped = 'budget'; break; }
        if (!bulkPaceAllows(counts.sent + counts.failed + counts.blocked, clock.ms() - startMs)) { stopped = 'pace'; break; }
        if (!(await bdb.markInflight(b.id, r.tg_id))) { stopped = 'cursor'; break; }
        const outcome = await deliver(fresh, r.tg_id);
        if (typeof outcome === 'object') {
          // not sent: clear the in-flight mark without moving the cursor, retry after the cooldown
          await bdb.skipInflightUnsent(b.id, r.tg_id);
          await settings.set(0, 'telegram.cooldown_until', cooldownAfter429(clock.now(), outcome.rateLimit));
          stopped = 'rate_limit';
          break;
        }
        counts[outcome] += 1;
        const status = await bdb.recordOne(b.id, r.tg_id, outcome);
        if (status !== 'running') { stopped = status ? 'status' : 'cursor'; break; }
      }
      let done = false;
      if (!stopped && recipients.length < size) done = !!(await bdb.transition(b.id, ['running'], 'done', clock.now()));
      if (!done) await bdb.release(b.id);
      const after = await bdb.get(b.id);
      log.info('broadcast_batch', { broadcast_id: b.id, count: recipients.length, status: after && after.status, error: stopped });
      if (hooks.notify && after) {
        try {
          await hooks.notify(after, { done });
        } catch (e) {
          log.warn('broadcast_notify_failed', { broadcast_id: b.id, error: String(e && e.message).slice(0, 200) });
        }
      }
      return { id: b.id, ...counts, stopped, done };
    },
  };
}
