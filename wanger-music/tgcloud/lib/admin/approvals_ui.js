// 🗳 Approvals and publication management (spec 10.4, 10.6):
// - review queue (approvals.review: owner + admins): the audio by file_id with the channel's
//   rendered caption, the target channel and ✅ Approve · ❌ Reject · ⏭ Next; one reviewer wins;
// - owner: uncertain / failed lists with «ثبت به\u200cعنوان منتشرشده» / «ارسال دوباره» / cancel,
//   history per channel, backfill with a preview and a count, deleting a track's channel posts;
// - publications of a track (catalog.manage, read-only).
import { OWNER_ID } from '../config/static.js';
import { t, tp, raw, dateTime } from '../i18n/index.js';
import { esc, displayName } from '../telegram/html.js';
import { btn, markup } from '../bot/keyboards.js';
import { screen, homeButton } from './panel.js';
import { can } from '../permissions/policy.js';
import { truncate } from '../core/util.js';
import { captionFor } from '../publishing/worker.js';
import { matches } from '../publishing/rules.js';
import { classify } from '../telegram/errors.js';

const REVIEW = 'approvals.review';
const OWNER = 'destinations.manage';
const ICON = { pending_approval: '🗳', queued: '⏳', sending: '📤', published: '✅', failed: '❌', rejected: '🚫', uncertain: '⚠️', cancelled: '✖️' };

const trackLabel = (lang, p) => truncate(`${p.track_title || tp(lang, 'trk.untitled')} — ${p.track_artist || '?'}`, 50);
const channelLabel = (p) => p.channel_title || (p.channel_username ? '@' + p.channel_username : String(p.channel_id));

// ---------------------------------------------------------------- new songs from sources
// A message to the owner and every admin as soon as a source brings a song: what it is, where it
// stands, and the next action as buttons (language, activate, approve / reject, send now, play).
// Every button re-renders the same message. More than NEW_TRACK_BURST songs in NEW_TRACK_WINDOW
// seconds: one summary instead, so a source posting 50 songs doesn't flood anyone.
const NEW_TRACK_BURST = 5;
const NEW_TRACK_WINDOW = 15 * 60;
const UNDECIDED = (tr) => tr.language_source === 'heuristic' && (tr.language === 'unknown' || tr.language_confidence === 'low');
const chName = (p) => (p.channel_username ? '@' + p.channel_username : p.channel_title || '?');

/** The new-song message for one viewer (buttons only for what they may do). */
export async function newTrackView(app, viewer, tr, lang) {
  const src = tr.source_id ? await app.sources.get(tr.source_id) : null;
  const pubsOf = (await app.publisher.forTrack(tr.id)).filter((p) => ['pending_approval', 'queued', 'sending', 'published', 'failed', 'uncertain'].includes(p.status));
  const lines = [
    t(lang, 'nt.head', { source: src ? src.title || (src.username ? '@' + src.username : '') : '—' }),
    t(lang, 'nt.track', { title: tr.title || tp(lang, 'trk.untitled'), artist: tr.artist || '?' }),
    UNDECIDED(tr) ? t(lang, 'nt.lang_unknown') : t(lang, 'nt.lang', { language: tp(lang, `tlang.${tr.language}`) }),
    t(lang, 'nt.status', { status: tp(lang, `trk.status.${tr.status}`) }),
  ];
  for (const p of pubsOf) lines.push(t(lang, 'nt.pub', { channel: chName(p), state: tp(lang, `nt.pub_state.${p.status}`) }));
  if (tr.status === 'active' && !pubsOf.length && !UNDECIDED(tr)) lines.push(t(lang, 'nt.no_channel'));
  const rows = [];
  if (UNDECIDED(tr) && can(viewer, 'catalog.manage')) rows.push(['fa', 'en', 'other'].map((l) => btn(tp(lang, `srclang.${l}`), 'nt', 'lang', tr.id, l)));
  if (tr.status === 'draft' && can(viewer, 'catalog.manage')) rows.push([btn(tp(lang, 'nt.btn_activate'), 'nt', 'act', tr.id)]);
  for (const p of pubsOf) {
    if (p.status === 'pending_approval' && can(viewer, 'approvals.review')) rows.push([btn(tp(lang, 'nt.btn_ok', { channel: chName(p) }), 'nt', 'ok', p.id), btn(tp(lang, 'nt.btn_no'), 'nt', 'no', p.id)]);
    if (p.status === 'queued' && can(viewer, 'destinations.manage')) rows.push([btn(tp(lang, 'nt.btn_send', { channel: chName(p) }), 'nt', 'send', p.id)]);
  }
  if (can(viewer, 'catalog.manage')) rows.push([btn(tp(lang, 'trk.btn.play'), 'trk', 'play', tr.id), btn(tp(lang, 'nt.btn_card'), 'trk', 'v', tr.id)]);
  return { text: lines.join('\n'), keyboard: markup(rows) };
}

/** Sends the new-song message to the owner and the admins. @returns {Promise<number>} messages sent */
export async function notifyNewTrack(app, src, trackId) {
  if (!(await app.settings.get('notify.new_tracks'))) return 0;
  const now = app.clock.now();
  const w = /** @type {any} */ (await app.settings.get('notify.window')) || {};
  const win = w.start && now - w.start < NEW_TRACK_WINDOW ? { start: w.start, n: Number(w.n) || 0 } : { start: now, n: 0 };
  win.n += 1;
  await app.settings.setInternal('notify.window', win);
  const reviewers = [OWNER_ID, ...(await app.users.adminIds())];
  const tr = await app.catalog.get(trackId);
  if (!tr) return 0;
  let sent = 0;
  if (win.n > NEW_TRACK_BURST) {
    if (!(await app.alerts.claim('newtrk_more', NEW_TRACK_WINDOW))) return 0;
    for (const id of reviewers) {
      const u = await app.users.get(id);
      const lang = await app.users.languageOf(u);
      const viewer = u || { telegram_id: id, role: 'user' };
      const rows = [[btn(tp(lang, 'nt.btn_drafts'), 'mus', 'ls', 'draft', 0), btn(tp(lang, 'nt.btn_unknown'), 'mus', 'ls', 'unknown', 0)]];
      if (can(viewer, 'approvals.review')) rows.push([btn(tp(lang, 'nt.btn_review'), 'apr', 'home')]);
      if (can(viewer, 'destinations.manage')) rows.push([btn(tp(lang, 'nt.btn_sendq'), 'pub', 'sendq')]);
      try {
        await app.tg.send(id, { text: t(lang, 'nt.more', { source: src.title || '' }), keyboard: markup(rows) }, 'new_tracks_summary');
        sent += 1;
      } catch (e) {
        app.log.warn('new_track_notice_failed', { user_id: id, error: String(e && (e.description || e.message)).slice(0, 120) });
      }
    }
    return sent;
  }
  for (const id of reviewers) {
    const u = await app.users.get(id);
    const lang = await app.users.languageOf(u);
    try {
      await app.tg.send(id, await newTrackView(app, u || { telegram_id: id, role: 'user' }, tr, lang), 'new_track');
      sent += 1;
    } catch (e) {
      app.log.warn('new_track_notice_failed', { user_id: id, error: String(e && (e.description || e.message)).slice(0, 120) });
    }
  }
  return sent;
}

/** Re-renders the new-song message in place after a button. */
async function refreshNew(app, user, cq, trackId, toast) {
  const tr = await app.catalog.get(trackId);
  if (!tr) return { toast: tp(app.lang, 'trk.err.gone'), alert: true };
  await screen(app, user, cq, await newTrackView(app, user, tr, app.lang), 'new_track');
  return toast ? { toast, alert: false } : {};
}

/** One press of «📤 ارسال صف»: a batch now; the result screen offers the next batch. */
export async function sendQueueView(app, channelId = null) {
  const lang = app.lang;
  const r = await app.worker.sendQueue({ channelId, max: 8, deadlineMs: app.clock.ms() + 20000 });
  const left = channelId ? (await app.publisher.queueOf(await app.destinations.get(channelId))).queued : (await app.publisher.counts()).queued;
  const lines = [t(lang, 'pub.sendq_title'), t(lang, 'pub.sendq_sent', { n: r.sent })];
  if (r.failed) lines.push(t(lang, 'pub.sendq_failed', { n: r.failed }));
  if (r.retry) lines.push(t(lang, 'pub.sendq_retry', { n: r.retry }));
  if (r.stopped) lines.push(t(lang, `pub.sendq_stopped.${r.stopped}`));
  if (r.limited) lines.push(t(lang, 'pub.sendq_limited', { n: r.limited }));
  lines.push(left ? t(lang, 'pub.sendq_left', { n: left }) : t(lang, 'pub.sendq_empty'));
  const again = channelId ? btn(tp(lang, 'pub.btn_sendq_more', { n: left }), 'dst', 'sendq', channelId) : btn(tp(lang, 'pub.btn_sendq_more', { n: left }), 'pub', 'sendq');
  return { text: lines.join('\n'), keyboard: markup([left && !r.stopped ? [again] : [], [homeButton(lang)]]) };
}

/**
 * Tick processor (manual mode): when posts wait in the queue, the owner gets one message with the
 * send button — at most every digest interval.
 */
export async function notifyQueue(app) {
  if (await app.settings.get('publishing.auto_send')) return 'auto';
  const queued = (await app.publisher.counts()).queued;
  if (!queued) return 'empty';
  if (!(await app.alerts.claim('queue_notice', Number(await app.settings.get('digest.interval_seconds'))))) return 'throttled';
  const owner = await app.users.get(OWNER_ID);
  const lang = await app.users.languageOf(owner);
  await app.tg.send(OWNER_ID, { text: t(lang, 'pub.queue_notice', { n: queued }), keyboard: markup([[btn(tp(lang, 'pub.btn_sendq', { n: queued }), 'pub', 'sendq')]]) }, 'queue_notice');
  return { queued };
}

async function homeView(app, user) {
  const lang = app.lang;
  const c = await app.publisher.counts();
  const rows = [[btn(tp(lang, 'apr.btn_review_n', { n: c.pending }), 'apr', 'next', 0)]];
  if (c.queued && can(user, 'destinations.manage')) rows.unshift([btn(tp(lang, 'pub.btn_sendq', { n: c.queued }), 'pub', 'sendq')]);
  if (can(user, OWNER)) rows.push([btn(tp(lang, 'apr.btn_uncertain', { n: c.uncertain }), 'pub', 'ls', 'uncertain'), btn(tp(lang, 'apr.btn_failed', { n: c.failed }), 'pub', 'ls', 'failed')], [btn(tp(lang, 'apr.btn_queued', { n: c.queued }), 'pub', 'ls', 'queued')]);
  rows.push([homeButton(lang)]);
  const paused = await app.settings.get('publishing.paused');
  return { text: t(lang, 'apr.title', c) + (paused ? '\n\n' + t(lang, 'apr.paused') : ''), keyboard: markup(rows) };
}

/** Sends the next pending item after `afterId`: the audio with its channel caption, then the decision card. */
async function showNext(app, user, afterId) {
  const lang = app.lang;
  const p = await app.publisher.nextPending(afterId);
  if (!p) {
    await app.tg.send(user.telegram_id, { text: t(lang, 'apr.empty'), keyboard: markup([[btn(tp(lang, 'common.back'), 'apr', 'home')]]) }, 'review_empty');
    return;
  }
  const [track, ch] = await Promise.all([app.catalog.get(p.track_id), app.destinations.get(p.channel_id)]);
  if (!track || !ch) {
    await showNext(app, user, p.id);
    return;
  }
  const caption = await captionFor(track, ch, { get: (id) => app.sources.get(id) });
  try {
    await app.tg.call('sendAudio', { chat_id: user.telegram_id, audio: track.audio_file_id, caption, parse_mode: 'HTML' }, 'review_audio');
  } catch (e) {
    if (classify(e).kind !== 'bad_caption') throw e;
    await app.tg.call('sendAudio', { chat_id: user.telegram_id, audio: track.audio_file_id }, 'review_audio');
  }
  const m = matches(track, ch);
  const left = await app.publisher.countPending();
  await app.tg.send(user.telegram_id, {
    text: t(lang, 'apr.card', {
      channel: channelLabel(p), track: trackLabel(lang, p), left,
      reason: tp(lang, m.reason === 'low_confidence' ? 'apr.reason.low_confidence' : 'apr.reason.required'),
      language: tp(lang, `tlang.${track.language}`), confidence: tp(lang, `conf.${track.language_confidence}`),
    }),
    keyboard: markup([[btn(tp(lang, 'apr.btn_ok'), 'apr', 'ok', p.id), btn(tp(lang, 'apr.btn_no'), 'apr', 'no', p.id), btn(tp(lang, 'apr.btn_skip'), 'apr', 'next', p.id)]]),
  }, 'review_card');
}

async function decide(app, user, id, approve, cq) {
  const lang = app.lang;
  const r = await app.publisher.decide(user, id, approve);
  if (!r.ok) {
    const row = r.row;
    const who = row && row.decided_by ? displayName((await app.users.get(row.decided_by)) || { telegram_id: row.decided_by }) : '—';
    const text = row ? t(lang, 'apr.already', { status: tp(lang, `pub.status.${row.status}`), who }) : t(lang, 'pub.err.state');
    await screen(app, user, cq, { text }, 'review_done');
    return { toast: tp(lang, 'apr.already_toast'), alert: true };
  }
  await screen(app, user, cq, { text: t(lang, approve ? 'apr.approved' : 'apr.rejected', { channel: channelLabel(await app.publisher.get(id)) }) }, 'review_done');
  await showNext(app, user, id);
  return { toast: tp(lang, approve ? 'apr.approved_toast' : 'apr.rejected_toast') };
}

async function pubCard(app, user, p) {
  const lang = app.lang;
  const tz = await app.settings.get('time_zone');
  const rows = [];
  if (can(user, OWNER)) {
    if (p.status === 'uncertain') rows.push([btn(tp(lang, 'pub.btn_mark'), 'pub', 'mark', p.id), btn(tp(lang, 'pub.btn_resend'), 'pub', 'resend', p.id)]);
    if (p.status === 'failed') rows.push([btn(tp(lang, 'pub.btn_retry'), 'pub', 'resend', p.id)]);
    if (['uncertain', 'failed', 'queued', 'pending_approval'].includes(p.status)) rows.push([btn(tp(lang, 'pub.btn_cancel'), 'pub', 'cancel', p.id)]);
  }
  rows.push([btn(tp(lang, 'common.back'), 'apr', 'home')]);
  return {
    text: t(lang, 'pub.card', {
      icon: ICON[p.status] || '•', status: tp(lang, `pub.status.${p.status}`), channel: channelLabel(p), track: trackLabel(lang, p),
      attempts: p.attempt_count, error: p.last_error || '—', created: dateTime(p.created_at, tz, lang), published: dateTime(p.published_at || 0, tz, lang),
    }) + (p.status === 'uncertain' ? '\n\n' + t(lang, 'pub.uncertain_help') : ''),
    keyboard: markup(rows),
  };
}

const listLine = (lang, p, tz, withChannel = true) => `${ICON[p.status] || '•'} ${esc(trackLabel(lang, p))}${withChannel ? ` → ${esc(channelLabel(p))}` : ''} · ${esc(dateTime(p.published_at || p.updated_at || p.created_at, tz, lang))}${p.deleted_at ? ' 🧹' : ''}`;

/** Lines for the track card (music_ui). */
export async function trackPublicationLines(app, track) {
  const lang = app.lang;
  const list = await app.publisher.forTrack(track.id);
  if (!list.length) return [t(lang, 'pub.track_none')];
  return [t(lang, 'pub.track_head'), ...list.map((p) => `${ICON[p.status] || '•'} ${esc(channelLabel(p))}: ${esc(tp(lang, `pub.status.${p.status}`))}${p.deleted_at ? ' 🧹' : ''}`)];
}

export const routes = [
  { ns: 'apr', action: 'home', args: [], perm: REVIEW, run: async (app, user, _a, cq) => { await screen(app, user, cq, await homeView(app, user), 'approvals'); return {}; } },
  { ns: 'apr', action: 'next', args: ['uint'], perm: REVIEW, run: async (app, user, [after]) => { await showNext(app, user, Number(after)); return {}; } },
  { ns: 'apr', action: 'ok', args: ['uint'], perm: REVIEW, run: (app, user, [id], cq) => decide(app, user, id, true, cq) },
  { ns: 'apr', action: 'no', args: ['uint'], perm: REVIEW, run: (app, user, [id], cq) => decide(app, user, id, false, cq) },

  // ---- the new-song message's buttons
  { ns: 'nt', action: 'v', args: ['uint'], perm: 'catalog.manage', run: (app, user, [id], cq) => refreshNew(app, user, cq, id, null) },
  {
    ns: 'nt', action: 'lang', args: ['uint', 'tlang'], perm: 'catalog.manage',
    async run(app, user, [id, l], cq) {
      const row = await app.catalog.setLanguage(user, id, l);
      return refreshNew(app, user, cq, id, row && row.alsoSet ? tp(app.lang, 'trk.saved_artist', { n: row.alsoSet }) : tp(app.lang, 'trk.saved'));
    },
  },
  {
    ns: 'nt', action: 'act', args: ['uint'], perm: 'catalog.manage',
    async run(app, user, [id], cq) {
      await app.catalog.activate(user, id); // UserError (no title…) → a toast from the router
      return refreshNew(app, user, cq, id, tp(app.lang, 'trk.activated'));
    },
  },
  ...[['ok', true], ['no', false]].map(([action, approve]) => ({
    ns: 'nt', action: String(action), args: ['uint'], perm: REVIEW,
    async run(app, user, [id], cq) {
      const r = await app.publisher.decide(user, id, Boolean(approve));
      const p = r.row || (await app.publisher.get(id));
      if (!p) return { toast: tp(app.lang, 'common.expired'), alert: true };
      return refreshNew(app, user, cq, p.track_id, r.ok ? tp(app.lang, approve ? 'nt.approved' : 'nt.rejected') : tp(app.lang, 'nt.decided_already'));
    },
  })),
  {
    ns: 'nt', action: 'send', args: ['uint'], perm: 'destinations.manage',
    async run(app, user, [id], cq) {
      const p = await app.publisher.get(id);
      if (!p) return { toast: tp(app.lang, 'common.expired'), alert: true };
      const outcome = await app.worker.sendPublicationNow(id);
      const res = await refreshNew(app, user, cq, p.track_id, null);
      return { ...res, toast: tp(app.lang, `dst.now.${outcome}`), alert: outcome !== 'sent' };
    },
  },
  {
    // «📤 ارسال صف انتشار»: the owner sends the queue by hand
    ns: 'pub', action: 'sendq', args: [], perm: 'destinations.manage',
    async run(app, user, _a, cq) {
      await screen(app, user, cq, await sendQueueView(app), 'send_queue');
      return {};
    },
  },
  {
    ns: 'pub', action: 'ls', args: ['word'], perm: OWNER,
    async run(app, user, [status], cq) {
      if (!['uncertain', 'failed', 'queued'].includes(String(status))) return { toast: tp(app.lang, 'common.expired'), alert: true };
      const lang = app.lang;
      const list = await app.publisher.byStatus(String(status));
      const rows = list.slice(0, 10).map((p) => [btn(`${ICON[p.status]} ${trackLabel(lang, p)} → ${channelLabel(p)}`.slice(0, 60), 'pub', 'v', p.id)]);
      rows.push([btn(tp(lang, 'common.back'), 'apr', 'home')]);
      await screen(app, user, cq, { text: t(lang, 'pub.list', { status: tp(lang, `pub.status.${status}`), n: list.length }) + (list.length ? '' : '\n' + t(lang, 'mus.list_empty')), keyboard: markup(rows) }, 'publications');
      return {};
    },
  },
  {
    ns: 'pub', action: 'v', args: ['uint'], perm: OWNER,
    async run(app, user, [id], cq) {
      const p = await app.publisher.get(id);
      if (!p) return { toast: tp(app.lang, 'pub.err.state'), alert: true };
      await screen(app, user, cq, await pubCard(app, user, p), 'publication_card');
      return {};
    },
  },
  ...[['mark', 'markPublished', 'pub.marked'], ['resend', 'resend', 'pub.requeued'], ['cancel', 'cancel', 'pub.cancelled']].map(([action, fn, toast]) => ({
    ns: 'pub', action, args: ['uint'], perm: OWNER,
    async run(app, user, [id], cq) {
      await app.publisher[fn](user, id);
      await screen(app, user, cq, await pubCard(app, user, await app.publisher.get(id)), 'publication_card');
      return { toast: tp(app.lang, toast) };
    },
  })),
  {
    ns: 'pub', action: 'trk', args: ['uint'], perm: 'catalog.manage',
    async run(app, user, [trackId], cq) {
      const lang = app.lang;
      const tz = await app.settings.get('time_zone');
      const list = await app.publisher.forTrack(trackId);
      const rows = can(user, OWNER) ? list.map((p) => [btn(`${ICON[p.status]} ${channelLabel(p)}`.slice(0, 60), 'pub', 'v', p.id)]) : [];
      rows.push([btn(tp(lang, 'common.back'), 'trk', 'v', trackId)]);
      await screen(app, user, cq, { text: t(lang, 'pub.track_title', { n: list.length }) + '\n\n' + (list.length ? list.map((p) => listLine(lang, p, tz)).join('\n') : t(lang, 'pub.track_none')), keyboard: markup(rows) }, 'track_publications');
      return {};
    },
  },
  {
    ns: 'pub', action: 'ch', args: ['uint', 'uint'], perm: OWNER,
    async run(app, user, [channelId, page], cq) {
      const lang = app.lang;
      const tz = await app.settings.get('time_zone');
      const size = 10;
      const list = await app.publisher.forChannel(channelId, Number(page), size + 1);
      const rows = list.slice(0, size).map((p) => [btn(`${ICON[p.status]} ${trackLabel(lang, p)}`.slice(0, 60), 'pub', 'v', p.id)]);
      rows.push([Number(page) > 0 ? btn(tp(lang, 'common.prev'), 'pub', 'ch', channelId, Number(page) - 1) : null, list.length > size ? btn(tp(lang, 'common.next'), 'pub', 'ch', channelId, Number(page) + 1) : null]);
      rows.push([btn(tp(lang, 'common.back'), 'dst', 'v', channelId)]);
      await screen(app, user, cq, { text: t(lang, 'pub.channel_title', { page: Number(page) + 1 }) + '\n\n' + (list.length ? list.slice(0, size).map((p) => listLine(lang, p, tz, false)).join('\n') : t(lang, 'mus.list_empty')), keyboard: markup(rows) }, 'channel_history');
      return {};
    },
  },
  {
    ns: 'pub', action: 'bf', args: ['uint'], perm: OWNER,
    async run(app, user, [channelId], cq) {
      const lang = app.lang;
      const { channel, rows, sample } = await app.publisher.backfillPreview(user, channelId);
      const lines = sample.map((tr) => `• ${esc(truncate(`${tr.title} — ${tr.artist}`, 60))}`).join('\n');
      await screen(app, user, cq, {
        text: t(lang, 'pub.bf_preview', { channel: channel.title || String(channel.chat_id), n: rows.length, sample: raw(lines || '—'), approval: tp(lang, channel.approval_required ? 'pub.bf_approval_on' : 'pub.bf_approval_off') }),
        keyboard: markup([rows.length ? [btn(tp(lang, 'pub.btn_bf_ok', { n: rows.length }), 'pub', 'bfok', channelId)] : [], [btn(tp(lang, 'common.back'), 'dst', 'v', channelId)]]),
      }, 'backfill_preview');
      return {};
    },
  },
  {
    ns: 'pub', action: 'bfok', args: ['uint'], perm: OWNER,
    async run(app, user, [channelId], cq) {
      const n = await app.publisher.backfill(user, channelId);
      await screen(app, user, cq, { text: t(app.lang, 'pub.bf_done', { n }), keyboard: markup([[btn(tp(app.lang, 'common.back'), 'dst', 'v', channelId)]]) }, 'backfill_done');
      return {};
    },
  },
  {
    ns: 'pub', action: 'del', args: ['uint'], perm: OWNER,
    async run(app, user, [trackId], cq) {
      await screen(app, user, cq, { text: t(app.lang, 'pub.del_confirm'), keyboard: markup([[btn(tp(app.lang, 'common.yes_delete'), 'pub', 'delok', trackId), btn(tp(app.lang, 'common.no'), 'trk', 'v', trackId)]]) }, 'delete_posts_confirm');
      return {};
    },
  },
  {
    ns: 'pub', action: 'delok', args: ['uint'], perm: OWNER,
    async run(app, user, [trackId], cq) {
      const r = await app.publisher.deletePosts(user, trackId);
      await screen(app, user, cq, { text: t(app.lang, 'pub.del_done', { ok: r.ok, failed: r.failed }), keyboard: markup([[btn(tp(app.lang, 'common.back'), 'trk', 'v', trackId)]]) }, 'delete_posts_done');
      return {};
    },
  },
];

