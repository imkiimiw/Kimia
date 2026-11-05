// Publishing worker (spec 10.6), run by the tick: per channel that is ready (enabled, auto-publish,
// interval, active hours in its time zone, daily limit) it claims ONE due publication with a lease,
// posts it (cover first for cover_then_audio), and records the result. Error handling comes from
// telegram/errors.js#publishAction. At most once: an expired lease becomes "uncertain".
import { BOT_USERNAME, LIMITS } from '../config/static.js';
import { SYSTEM_ACTOR } from '../permissions/policy.js';
import { channelReady, dayStart, normalizeRules } from './rules.js';
import { renderCaption, captionValues, DEFAULT_TEMPLATE } from './captions.js';
import { publishAction, classify } from '../telegram/errors.js';
import { backoffSeconds, cooldownAfter429, cooldownActive } from '../telegram/limiter.js';
import { t, tp } from '../i18n/index.js';

export const LEASE_SECONDS = 60;
export const MAX_ATTEMPTS = 6;

/** Captions use the channel's first language for names (Persian unless it is an English channel). */
export const captionLanguage = (ch) => (normalizeRules(ch.rules).languages[0] === 'en' ? 'en' : 'fa');

/** The caption a track gets in a channel. */
export async function captionFor(track, ch, sources) {
  const lang = captionLanguage(ch);
  const src = track.source_id && sources ? await sources.get(track.source_id) : null;
  return renderCaption(ch.caption_template || DEFAULT_TEMPLATE, captionValues(track, {
    botUsername: BOT_USERNAME,
    languageName: (l) => tp(lang, `tlang.${l}`),
    genreName: (g) => tp(lang, `genre.${g}`),
    sourceName: src ? src.title || '' : '',
  }));
}

/**
 * @param {{pubs: any, channels: any, catalog: any, sources: any, settings: any, tg: any, alerts: any, clock: any, log: any}} deps
 */
export function createWorker({ pubs, channels, catalog, sources, settings, tg, alerts, clock, log }) {
  /** Disables a channel the bot can't post in (and stops routing to it). */
  async function disableChannel(ch, description) {
    const now = clock.now();
    await channels.update(ch.id, { enabled: 0, bot_rights_ok: 0 }, now);
    await channels.syncPublishingSince(ch.id, now);
    await alerts.owner(`dst:${ch.id}`, (lang) => t(lang, 'alert.pub_channel', { title: ch.title || String(ch.chat_id), reason: description }), LIMITS.alertDestinationEverySeconds);
  }

  /** @returns {Promise<'sent'|'retry'|'rate_limited'|'failed'|'cancelled'>} */
  async function sendOne(pub, ch) {
    const track = await catalog.get(pub.track_id);
    if (!track || track.status !== 'active') {
      await pubs.transition(pub.id, ['sending'], 'cancelled', 0, clock.now(), { error: 'track no longer active' });
      return 'cancelled';
    }
    const caption = await captionFor(track, ch, sources);
    let coverId = null;
    try {
      if (ch.post_format === 'cover_then_audio' && track.cover_file_id) {
        coverId = (await tg.call('sendPhoto', { chat_id: ch.chat_id, photo: track.cover_file_id }, 'publish_cover')).message_id;
      }
      const m = await tg.call('sendAudio', { chat_id: ch.chat_id, audio: track.audio_file_id, caption, parse_mode: 'HTML' }, 'publish');
      const now = clock.now();
      await pubs.markPublished(pub.id, m.message_id, coverId, now);
      await channels.setLastPublished(ch.id, now);
      log.info('published', { publication_id: pub.id, track_id: track.id, channel_id: ch.chat_id });
      return 'sent';
    } catch (e) {
      if (coverId) {
        try {
          await tg.call('deleteMessage', { chat_id: ch.chat_id, message_id: coverId }, 'publish_cover_undo');
        } catch {
          // the lone cover stays; the publication is retried or failed below
        }
      }
      const now = clock.now();
      const a = publishAction(e, pub.attempt_count, MAX_ATTEMPTS);
      log.warn('publish_failed', { publication_id: pub.id, channel_id: ch.chat_id, error_code: classify(e).code, error: a.kind, status: a.action });
      switch (a.action) {
        case 'retry_after':
          await pubs.requeue(pub.id, now + Math.max(1, a.retryAfter), a.description, false, now);
          await settings.setInternal('telegram.cooldown_until', cooldownAfter429(now, a.retryAfter));
          return 'rate_limited';
        case 'backoff':
          await pubs.requeue(pub.id, now + backoffSeconds(pub.attempt_count), a.description, true, now);
          return 'retry';
        case 'fail_channel':
          await pubs.fail(pub.id, a.description, now);
          await disableChannel(ch, a.description);
          return 'failed';
        case 'fail_file':
          await pubs.fail(pub.id, a.description, now);
          try {
            await catalog.hide(SYSTEM_ACTOR, track.id); // a broken file leaves search and routing
          } catch {
            // already hidden or removed
          }
          await alerts.owner(`file:${track.id}`, (lang) => t(lang, 'alert.pub_file', { title: track.title || track.public_id }), LIMITS.alertDestinationEverySeconds);
          return 'failed';
        case 'fail_caption':
          await pubs.fail(pub.id, a.description, now);
          await alerts.owner(`caption:${ch.id}`, (lang) => t(lang, 'alert.pub_caption', { title: ch.title || String(ch.chat_id), reason: a.description }), LIMITS.alertDestinationEverySeconds);
          return 'failed';
        default:
          await pubs.fail(pub.id, a.description, now);
          await alerts.owner(`pub_failed:${ch.id}`, (lang) => t(lang, 'alert.pub_failed', { title: ch.title || String(ch.chat_id), reason: a.description }), LIMITS.alertDestinationEverySeconds);
          return 'failed';
      }
    }
  }

  return {
    sendOne,
    /** Tick processor. */
    async run({ deadlineMs }) {
      if (await settings.get('publishing.paused')) return { skipped: 'paused' };
      const now = clock.now();
      const uncertain = await pubs.expireLeases(now);
      if (uncertain) await alerts.owner('pub_uncertain', (lang) => t(lang, 'alert.pub_uncertain', { n: uncertain }), LIMITS.alertDestinationEverySeconds);
      if (cooldownActive(now, Number(await settings.get('telegram.cooldown_until')))) return { skipped: 'cooldown', uncertain };
      const cap = Number(await settings.get('publishing.per_tick'));
      const res = { sent: 0, retry: 0, rate_limited: 0, failed: 0, cancelled: 0, uncertain };
      for (const ch of await channels.routable()) {
        if (res.sent + res.failed + res.retry >= cap || clock.ms() >= deadlineMs) break;
        const today = await pubs.publishedSince(ch.id, dayStart(now, ch.time_zone));
        if (!channelReady(ch, now, today).ready) continue;
        const pub = await pubs.claimNext(ch.id, now, now + LEASE_SECONDS);
        if (!pub) continue;
        res[await sendOne(pub, ch)] += 1;
        if (res.rate_limited) break; // global cooldown: stop everything until it ends
      }
      return res;
    },
  };
}
