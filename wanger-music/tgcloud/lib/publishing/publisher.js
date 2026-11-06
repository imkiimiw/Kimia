// Publisher (spec 10.3–10.4): routing of newly activated tracks to matching channels (idempotent,
// no backfill), approvals (conditional decisions), cancellations, an explicit owner backfill with a
// preview, owner actions on uncertain / failed rows, deleting a track's channel posts, the digest.
import { LIMITS, OWNER_ID } from '../config/static.js';
import { assertCan } from '../permissions/policy.js';
import { UserError } from '../core/util.js';
import { matches } from './rules.js';
import { classify } from '../telegram/errors.js';
import { t, tp } from '../i18n/index.js';

const BACKFILL_SCAN = 500;
const BACKFILL_MAX = 200;

/**
 * @param {{repo: any, channels: any, tg: any, users: any, settings: any, alerts: any, audit: any, clock: any, log: any}} deps
 *   repo: publications repository; channels: destination_channels repository
 */
export function createPublisher({ repo, channels, tg, users, settings, alerts, audit, clock, log }) {
  /** The row a track would get in a channel, or null (pure decision through rules.matches). */
  function routeRow(track, ch) {
    const m = matches(track, ch);
    return m.match ? { track_id: track.id, channel_id: ch.id, status: m.needsApproval ? 'pending_approval' : 'queued' } : null;
  }

  const svc = {
    /**
     * A track just became active: one publication per matching channel that was publishing when the
     * track was activated (tracks activated earlier are never queued automatically: no backfill).
     */
    async routeTrack(track) {
      const rows = [];
      for (const ch of await channels.routable()) {
        if (!ch.publishing_since || !track.activated_at || track.activated_at < ch.publishing_since) continue;
        const row = routeRow(track, ch);
        if (row) rows.push(row);
      }
      const n = rows.length ? await repo.insertMany(rows, clock.now()) : 0;
      if (n) log.info('track_routed', { track_id: track.id, count: n });
      return n;
    },

    /**
     * The language or genre of an active track was corrected: its waiting publications (approval or
     * queue) for channels it no longer matches are cancelled, and channels it now matches get theirs
     * (same no-backfill rule as routeTrack). Published posts are not touched.
     */
    async reroute(track) {
      let cancelled = 0;
      for (const p of await repo.forTrack(track.id)) {
        if (p.status !== 'pending_approval' && p.status !== 'queued') continue;
        const ch = await channels.get(p.channel_id);
        if (ch && matches(track, ch).match) continue;
        if (await repo.transition(p.id, ['pending_approval', 'queued'], 'cancelled', 0, clock.now(), { error: 'track no longer matches the channel' })) cancelled += 1;
      }
      const routed = await svc.routeTrack(track);
      if (cancelled || routed) log.info('track_rerouted', { track_id: track.id, count: routed, status: `cancelled ${cancelled}` });
      return { cancelled, routed };
    },

    cancelForTrack: (trackId) => repo.cancelForTrack(trackId, clock.now()),
    cancelForChannel: (channelId) => repo.cancelForChannel(channelId, clock.now()),

    get: (id) => repo.getFull(id),
    counts: () => repo.counts(),
    countPending: () => repo.countPending(),
    nextPending: (afterId) => repo.nextPending(afterId),
    byStatus: (status) => repo.byStatus(status, 20),
    forTrack: (trackId) => repo.forTrack(trackId),
    forChannel: (channelId, page, size) => repo.forChannel(channelId, size, page * size),

    /** Approve or reject (one reviewer wins). @returns {Promise<{ok: boolean, row: any}>} */
    async decide(actor, id, approve) {
      assertCan(actor, 'approvals.review');
      const row = await repo.decide(id, approve ? 'queued' : 'rejected', actor.telegram_id, clock.now());
      if (!row) return { ok: false, row: await repo.getFull(id) };
      await audit.record(actor, approve ? 'publication.approve' : 'publication.reject', 'publication', id);
      return { ok: true, row };
    },

    /** Owner: an uncertain post was in fact published. */
    async markPublished(actor, id) {
      assertCan(actor, 'destinations.manage');
      const row = await repo.transition(id, ['uncertain'], 'published', actor.telegram_id, clock.now());
      if (!row) throw new UserError('pub.err.state');
      await audit.record(actor, 'publication.mark_published', 'publication', id);
      return row;
    },
    /** Owner: send an uncertain or failed publication again. */
    async resend(actor, id) {
      assertCan(actor, 'destinations.manage');
      const row = await repo.transition(id, ['uncertain', 'failed'], 'queued', actor.telegram_id, clock.now());
      if (!row) throw new UserError('pub.err.state');
      await audit.record(actor, 'publication.resend', 'publication', id);
      return row;
    },
    async cancel(actor, id) {
      assertCan(actor, 'destinations.manage');
      const row = await repo.transition(id, ['uncertain', 'failed', 'queued', 'pending_approval'], 'cancelled', actor.telegram_id, clock.now());
      if (!row) throw new UserError('pub.err.state');
      await audit.record(actor, 'publication.cancel', 'publication', id);
      return row;
    },

    /** Owner backfill, step 1: what would be queued (count + a few titles). Nothing is written. */
    async backfillPreview(actor, channelId) {
      assertCan(actor, 'destinations.manage');
      const ch = await channels.get(channelId);
      if (!ch) throw new UserError('dst.err.gone');
      const rows = [];
      const sample = [];
      for (const tr of await repo.unroutedActive(channelId, BACKFILL_SCAN)) {
        const row = routeRow(tr, ch);
        if (!row) continue;
        if (rows.length < BACKFILL_MAX) rows.push(row);
        if (sample.length < 5) sample.push(tr);
      }
      return { channel: ch, rows, sample };
    },
    /** Owner backfill, step 2 (explicit confirmation). */
    async backfill(actor, channelId) {
      const { channel, rows } = await svc.backfillPreview(actor, channelId);
      const n = rows.length ? await repo.insertMany(rows, clock.now()) : 0;
      await audit.record(actor, 'publication.backfill', 'destination', channel.chat_id, { count: n });
      return n;
    },

    /** Deletes a track's posts from the channels (Telegram may refuse old posts; failures are counted). */
    async deletePosts(actor, trackId) {
      assertCan(actor, 'destinations.manage');
      let ok = 0;
      let failed = 0;
      for (const p of await repo.forTrack(trackId)) {
        if (p.status !== 'published' || p.deleted_at || !p.telegram_message_id) continue;
        const ch = await channels.getAny(p.channel_id); // removed channels too: the post is still there
        if (!ch) {
          failed += 1;
          continue;
        }
        const chatId = ch.chat_id;
        try {
          for (const mid of [p.cover_message_id, p.telegram_message_id].filter(Boolean)) await tg.call('deleteMessage', { chat_id: chatId, message_id: mid }, 'publication_delete');
          await repo.markDeleted(p.id, clock.now());
          ok += 1;
        } catch (e) {
          failed += 1;
          log.warn('publication_delete_failed', { publication_id: p.id, error_code: classify(e).code, error: classify(e).kind });
        }
      }
      await audit.record(actor, 'publication.delete_posts', 'track', trackId, { ok, failed });
      return { ok, failed };
    },

    /** Tick processor: one digest to every reviewer while approvals wait (at most once per interval). */
    async runDigest() {
      const pending = await repo.countPending();
      if (!pending) return { skipped: 'none' };
      if (!(await alerts.claim('digest', Number(await settings.get('digest.interval_seconds'))))) return { skipped: 'throttled', pending };
      const reviewers = [OWNER_ID, ...(await users.adminIds())];
      let sent = 0;
      for (const id of reviewers) {
        const lang = await users.languageOf(await users.get(id));
        try {
          await tg.send(id, {
            text: t(lang, 'apr.digest', { n: pending }),
            keyboard: { inline_keyboard: [[{ text: tp(lang, 'apr.btn_review'), callback_data: 'apr:next:0' }]] },
          }, 'approval_digest');
          sent += 1;
        } catch (e) {
          log.warn('digest_failed', { user_id: id, error: classify(e).kind });
        }
      }
      return { pending, sent };
    },

    /** Maintenance: rows whose track was purged (no foreign keys). */
    sweepOrphans: () => repo.sweepOrphans(LIMITS.maintenanceDeleteCap),
    /** Purge: children first (no foreign keys). */
    deleteForTrack: (trackId) => repo.deleteForTrack(trackId),
  };
  return svc;
}
