// Publishing worker (spec 10.6), run by the tick: per channel that is ready (enabled, auto-publish,
// interval, active hours in its time zone, daily limit) it claims ONE due publication with a lease,
// posts it (cover first for cover_then_audio — the full picture from the audio file), and records the result. Error handling comes from
// telegram/errors.js#publishAction. At most once: an expired lease becomes "uncertain".
import { BOT_USERNAME, LIMITS } from '../config/static.js';
import { SYSTEM_ACTOR } from '../permissions/policy.js';
import { channelReady, dayStart, normalizeRules } from './rules.js';
import { renderCaption, captionValues, DEFAULT_TEMPLATE, CAPTION_MAX, channelHandle, channelSignature } from './captions.js';
import { publishAction, classify } from '../telegram/errors.js';
import { backoffSeconds, cooldownAfter429, cooldownActive } from '../telegram/limiter.js';
import { t, tp } from '../i18n/index.js';
import { readCover } from '../music/artwork.js';

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
    channel: channelHandle(ch),
  }), CAPTION_MAX, channelSignature(ch));
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

  /** Errors that concern the channel or Telegram as a whole: the post's normal error handling decides. */
  const fatal = (e) => ['transient', 'rate_limit', 'no_rights', 'chat_gone', 'blocked'].includes(classify(e).kind);

  /** Keeps the photo Telegram made of an uploaded cover as the track's cover. */
  async function keepCover(track, m, source) {
    const best = m && m.photo && m.photo.length ? m.photo[m.photo.length - 1] : null;
    if (best) await catalog.replaceCover(track.id, best.file_id, source);
  }

  /**
   * The full cover picture inside the track's audio file (music/artwork.js reads only the file's
   * start), or null. A file without a bigger picture than the thumbnail, or one Telegram won't
   * hand out (> 20 MB), is marked so it isn't read again; a passing download problem just falls
   * back to the thumbnail this time (`settled` false: the file is read again next time).
   * @returns {Promise<{picture: import('../music/artwork.js').Picture|null, settled: boolean}>}
   */
  async function fullCover(track) {
    try {
      const picture = await readCover((await tg.fileStream(track.audio_file_id)).body);
      if (!picture) await catalog.replaceCover(track.id, null, 'thumb');
      return { picture, settled: true };
    } catch (e) {
      const c = classify(e);
      log.warn('cover_read_failed', { track_id: track.id, error: c.kind });
      if (c.code !== 400) return { picture: null, settled: false };
      await catalog.replaceCover(track.id, null, 'thumb');
      return { picture: null, settled: true };
    }
  }

  /**
   * Sends a track's cover photo to a chat (a cover_then_audio post, or the owner's preview).
   * Telegram keeps only a small thumbnail of a song's cover (2–6 KB in production: blurry as a
   * photo), so the first time the full picture inside the audio file is uploaded (up to 3000 px
   * seen) and that photo is kept as the cover. With no bigger picture, the thumbnail is used; its
   * bytes are uploaded once, as Telegram refuses a thumbnail as a photo by id ("can't use file of
   * type Thumbnail as Photo"). Problems other than the chat's or Telegram's skip the cover — the
   * audio is the post. @returns {Promise<number|null>} the cover's message id
   */
  async function sendCover(track, chatId, view = 'publish_cover') {
    try {
      let settled = Boolean(track.cover_source);
      if (!settled) {
        const { picture: pic, settled: s } = await fullCover(track);
        settled = s;
        if (pic) {
          try {
            const m = await tg.sendPhotoFile(chatId, pic.bytes, pic.mime === 'image/png' ? 'cover.png' : 'cover.jpg', view, pic.mime);
            await keepCover(track, m, 'file');
            return m.message_id;
          } catch (e) {
            if (fatal(e)) throw e;
            log.warn('cover_full_refused', { track_id: track.id, error: classify(e).kind });
            await catalog.replaceCover(track.id, null, 'thumb');
          }
        }
      }
      if (!track.cover_file_id) return null;
      try {
        return (await tg.call('sendPhoto', { chat_id: chatId, photo: track.cover_file_id }, view)).message_id;
      } catch (e) {
        if (fatal(e) || !/thumbnail/i.test(classify(e).description)) throw e;
        const m = await tg.sendPhotoFile(chatId, await tg.fileContent(track.cover_file_id), 'cover.jpg', view);
        await keepCover(track, m, settled ? 'thumb' : null);
        return m.message_id;
      }
    } catch (e) {
      if (fatal(e)) throw e;
      log.warn('cover_skipped', { track_id: track.id, chat_id: chatId, error: classify(e).kind });
      return null;
    }
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
      if (ch.post_format === 'cover_then_audio' && (track.cover_file_id || !track.cover_source)) coverId = await sendCover(track, ch.chat_id);
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
    sendCover,
    /**
     * The owner's «▶️ send the next post now»: the channel's oldest due queued post, without waiting
     * for the minimum interval or the active hours (an explicit choice). Pause, the 429 cooldown,
     * the daily limit and the channel's state still apply.
     * @returns {Promise<'sent'|'retry'|'rate_limited'|'failed'|'cancelled'|'empty'|'paused'|'cooldown'|'off'|'daily_limit'>}
     */
    async sendNow(channelId) {
      if (await settings.get('publishing.paused')) return 'paused';
      const now = clock.now();
      if (cooldownActive(now, Number(await settings.get('telegram.cooldown_until')))) return 'cooldown';
      const ch = await channels.get(channelId);
      if (!ch || !ch.enabled || !ch.bot_rights_ok) return 'off';
      if (ch.daily_limit && (await pubs.publishedSince(ch.id, dayStart(now, ch.time_zone))) >= ch.daily_limit) return 'daily_limit';
      const pub = await pubs.claimNext(ch.id, now, now + LEASE_SECONDS, true);
      if (!pub) return 'empty';
      return sendOne(pub, ch);
    },

    /** One specific queued post, now (pause, cooldown, channel state and daily limit apply). */
    async sendPublicationNow(pubId) {
      if (await settings.get('publishing.paused')) return 'paused';
      const now = clock.now();
      if (cooldownActive(now, Number(await settings.get('telegram.cooldown_until')))) return 'cooldown';
      const p = await pubs.get(pubId);
      const ch = p ? await channels.get(p.channel_id) : null;
      if (!ch || !ch.enabled || !ch.bot_rights_ok) return 'off';
      if (ch.daily_limit && (await pubs.publishedSince(ch.id, dayStart(now, ch.time_zone))) >= ch.daily_limit) return 'daily_limit';
      const pub = await pubs.claimById(pubId, now, now + LEASE_SECONDS);
      if (!pub) return 'empty';
      return sendOne(pub, ch);
    },

    /**
     * The owner's «📤 ارسال صف»: queued posts go out now, round-robin over the channels (or one
     * channel's queue), without waiting for the interval, the hours or a retry time. At most `max`
     * posts per press (Telegram allows ~20 messages a minute in a channel; a cover is a message
     * too), stopping at the deadline or a 429. Pause and each channel's daily limit still apply.
     * @returns {Promise<{sent: number, failed: number, retry: number, rate_limited: number, cancelled: number, limited: number, stopped: string|null}>}
     */
    async sendQueue({ channelId = null, max = 8, deadlineMs }) {
      const res = { sent: 0, failed: 0, retry: 0, rate_limited: 0, cancelled: 0, limited: 0, stopped: /** @type {string|null} */ (null) };
      if (await settings.get('publishing.paused')) return { ...res, stopped: 'paused' };
      await pubs.expireLeases(clock.now());
      if (cooldownActive(clock.now(), Number(await settings.get('telegram.cooldown_until')))) return { ...res, stopped: 'cooldown' };
      let open = (await channels.list()).filter((c) => c.enabled && c.bot_rights_ok && (!channelId || c.id === channelId));
      const done = () => res.sent + res.failed + res.retry + res.cancelled >= max || clock.ms() >= deadlineMs;
      while (open.length && !done()) {
        /** @type {Set<number>} */
        const finished = new Set();
        for (const ch of open) {
          if (done()) break;
          const now = clock.now();
          if (ch.daily_limit && (await pubs.publishedSince(ch.id, dayStart(now, ch.time_zone))) >= ch.daily_limit) {
            res.limited += 1;
            finished.add(ch.id);
            continue;
          }
          const pub = await pubs.claimNext(ch.id, now, now + LEASE_SECONDS, true);
          if (!pub) {
            finished.add(ch.id);
            continue;
          }
          const outcome = await sendOne(pub, ch);
          res[outcome] += 1;
          if (outcome === 'rate_limited') return { ...res, stopped: 'rate_limited' };
        }
        open = open.filter((c) => !finished.has(c.id));
      }
      return res;
    },
    /** Tick processor. */
    async run({ deadlineMs }) {
      if (await settings.get('publishing.paused')) return { skipped: 'paused' };
      const now = clock.now();
      const uncertain = await pubs.expireLeases(now);
      if (uncertain) await alerts.owner('pub_uncertain', (lang) => t(lang, 'alert.pub_uncertain', { n: uncertain }), LIMITS.alertDestinationEverySeconds);
      if (cooldownActive(now, Number(await settings.get('telegram.cooldown_until')))) return { skipped: 'cooldown', uncertain };
      if (!(await settings.get('publishing.auto_send'))) return { skipped: 'manual', uncertain }; // the owner sends with «📤»
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
