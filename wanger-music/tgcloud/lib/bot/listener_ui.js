// Listener screens (owner's ideas, 2026-11-23): the buttons under every song sent in the bot
// (❤️, 🔔 follow the artist, 👤 more from the artist, 💿 album, 📤 send to a friend), the listener
// menu (🎲 random, 🎭 genres and moods, ❤️ favourites, 🔔 my artists, 📝 requests), the owner's
// request and missed-search lists, and the tick processor that sends queued notices.
import { LIMITS, GENRES, MOODS } from '../config/static.js';
import { t, tp, digits } from '../i18n/index.js';
import { btn, markup, grid } from './keyboards.js';
import { truncate, UserError } from '../core/util.js';
import { classify } from '../telegram/errors.js';
import { cooldownAfter429, cooldownActive } from '../telegram/limiter.js';

const PAGE = LIMITS.listenerPage;
const label = (lang, tr) => truncate(`${tr.title || tp(lang, 'trk.untitled')} — ${tr.artist || '?'}`, 56);
const menuButton = (lang) => btn(tp(lang, 'l.btn_menu'), 'l', 'menu');

// ---------------------------------------------------------------- the song's buttons

/** The keyboard under a song in the bot chat. @param {string} lang @param {any} tr @param {boolean} fav @param {boolean} following */
export function trackKeyboard(lang, tr, fav, following) {
  const artist = Boolean(tr.artist && tr.normalized_artist);
  const share = [tr.title, tr.artist].filter(Boolean).join(' ').slice(0, 60);
  return markup([
    [btn(tp(lang, fav ? 'l.btn_unfav' : 'l.btn_fav'), 'l', 'fav', tr.public_id), artist ? btn(tp(lang, following ? 'l.btn_unfollow' : 'l.btn_follow'), 'l', 'fol', tr.public_id) : null],
    [artist ? btn(tp(lang, 'l.btn_more', { artist: truncate(tr.artist, 20) }), 'l', 'art', tr.public_id, 0) : null, tr.album ? btn(tp(lang, 'l.btn_album'), 'l', 'alb', tr.public_id) : null],
    [{ text: tp(lang, 'l.btn_share'), switch_inline_query: share }],
  ]);
}

const keyboardFor = async (app, userId, tr, lang) => trackKeyboard(lang, tr,
  await app.listeners.isFavorite(userId, tr.id), await app.listeners.isFollowing(userId, tr.normalized_artist));

/**
 * Sends a song to a listener with its buttons; `count` adds a play (a song they asked for).
 * @param {any} app @param {any} user @param {any} tr
 * @param {{caption?: string, view?: string, count?: boolean, lang?: string}} [opts]
 */
export async function sendTrackTo(app, user, tr, { caption = '', view = 'track', count = true, lang = app.lang } = {}) {
  const m = await app.tg.call('sendAudio', {
    chat_id: user.telegram_id, audio: tr.audio_file_id, reply_markup: await keyboardFor(app, user.telegram_id, tr, lang),
    ...(caption ? { caption, parse_mode: 'HTML' } : {}),
  }, view);
  if (count) {
    const id = await app.search.addPlay(tr.public_id);
    if (id) {
      app.stats.count('play.private');
      app.stats.count('track.play', id);
    }
  }
  return m;
}

/** Re-draws the buttons under the pressed song. */
async function refreshKeyboard(app, user, cq, tr) {
  if (!cq.message) return;
  await app.tg.call('editMessageReplyMarkup', { chat_id: user.telegram_id, message_id: cq.message.message_id, reply_markup: await keyboardFor(app, user.telegram_id, tr, app.lang) }, 'track_buttons');
}

// ---------------------------------------------------------------- menus and lists

/** The listener menu rows (also on the welcome message). @param {string} lang */
export const menuRows = (lang) => [
  [btn(tp(lang, 'l.btn_random'), 'l', 'rnd'), btn(tp(lang, 'l.btn_browse'), 'l', 'br')],
  [btn(tp(lang, 'l.btn_favs'), 'l', 'favs', 0), btn(tp(lang, 'l.btn_follows'), 'l', 'fols', 0)],
  [btn(tp(lang, 'l.btn_request'), 'l', 'req'), btn(tp(lang, 'l.btn_my_requests'), 'l', 'reqs')],
];

/**
 * A page of songs as buttons (each sends the song). `rows` has one extra item when there is a next page.
 * @param {string} lang @param {string} head @param {any[]} rows @param {number} page
 * @param {(p: number) => any} navButton @param {any[][]} [extra]
 */
function songsView(lang, head, rows, page, navButton, extra = []) {
  const items = rows.slice(0, PAGE);
  if (!items.length) return { text: `${head}\n\n${t(lang, page ? 'l.no_more' : 'l.empty')}`, keyboard: markup([...extra, [menuButton(lang)]]) };
  return {
    text: `${head}\n${t(lang, 'l.tap_to_get')}`,
    keyboard: markup([
      ...items.map((tr) => [btn(`🎵 ${label(lang, tr)}`, 's', 'get', tr.public_id)]),
      [page > 0 ? navButton(page - 1) : null, rows.length > PAGE ? navButton(page + 1) : null],
      ...extra,
      [menuButton(lang)],
    ]),
  };
}
const prevNext = (lang, current, ns, action, ...args) => (p) => btn(tp(lang, p < current ? 'common.prev' : 'common.next'), ns, action, ...args, p);

function browseView(lang) {
  return {
    text: t(lang, 'l.browse_title'),
    keyboard: markup([
      ...grid(MOODS.map((m) => btn(tp(lang, `mood.${m}`), 'l', 'm', m, 0)), 3),
      ...grid(GENRES.filter((g) => g !== 'other').map((g) => btn(tp(lang, `genre.${g}`), 'l', 'g', g, 0)), 3),
      [menuButton(lang)],
    ]),
  };
}

async function followsView(app, user, page) {
  const lang = app.lang;
  const rows = await app.listeners.follows(user.telegram_id, page);
  const items = rows.slice(0, PAGE);
  if (!items.length) return { text: t(lang, page ? 'l.no_more' : 'l.follows_empty'), keyboard: markup([[menuButton(lang)]]) };
  return {
    text: t(lang, 'l.follows_title'),
    keyboard: markup([
      ...items.map((r, i) => [btn(`👤 ${truncate(r.artist_name, 40)}`, 'l', 'fa', page, i), btn(tp(lang, 'l.btn_unfollow_short'), 'l', 'unf', page, i)]),
      [page > 0 ? btn(tp(lang, 'common.prev'), 'l', 'fols', page - 1) : null, rows.length > PAGE ? btn(tp(lang, 'common.next'), 'l', 'fols', page + 1) : null],
      [menuButton(lang)],
    ]),
  };
}

async function requestsView(app, user) {
  const lang = app.lang;
  const rows = await app.listeners.requestsOf(user.telegram_id);
  if (!rows.length) return { text: t(lang, 'l.requests_empty'), keyboard: markup([[btn(tp(lang, 'l.btn_request'), 'l', 'req')], [menuButton(lang)]]) };
  return {
    text: [t(lang, 'l.requests_title'), ...rows.map((r, i) => t(lang, 'l.request_line', { i: digits(i + 1, lang), q: r.text }))].join('\n'),
    keyboard: markup([...rows.map((r, i) => [btn(tp(lang, 'l.btn_cancel_request', { i: digits(i + 1, lang) }), 'l', 'rqx', r.id)]), [menuButton(lang)]]),
  };
}

/** The artist's songs, from one of their songs. */
async function artistView(app, tr, page) {
  const lang = app.lang;
  const rows = await app.listeners.byArtist(tr.normalized_artist, page);
  return songsView(lang, t(lang, 'l.artist_title', { artist: tr.artist || '?' }), rows, page, prevNext(lang, page, 'l', 'art', tr.public_id));
}

/** The query of a "nothing found" message, read back from its «…» (stateless). */
const queryOfMessage = (message) => {
  const m = /«([^»]{1,64})»/.exec(String((message && message.text) || ''));
  return m ? m[1] : '';
};

/** A listener's request, from the menu flow or the «📝 request this song» button. */
async function addRequest(app, user, text) {
  const r = await app.listeners.request(user.telegram_id, text);
  return t(app.lang, r.status === 'added' ? 'l.request_added' : 'l.request_duplicate', { q: r.text });
}

/** The track a callback names (active only), or a toast. */
async function trackOf(app, pid) {
  const tr = await app.provider.getTrack(String(pid));
  return tr || null;
}
const gone = (app) => ({ toast: tp(app.lang, 'start.track_gone_short'), alert: true });

// ---------------------------------------------------------------- the owner's lists

async function adminRequestsView(app) {
  const lang = app.lang;
  const rows = await app.listeners.requestSummary();
  const lines = rows.map((r, i) => t(lang, 'lr.line', { i: digits(i + 1, lang), q: r.text, n: digits(r.n, lang) }));
  return {
    text: [t(lang, 'lr.title', { n: digits(await app.listeners.countOpenRequests(), lang) }), '', ...(lines.length ? lines : [t(lang, 'lr.empty')]), '', t(lang, 'lr.hint')].join('\n'),
    keyboard: markup([
      ...grid(rows.map((_r, i) => btn(tp(lang, 'lr.btn_drop', { i: digits(i + 1, lang) }), 'lr', 'drop', i)), 4),
      [btn(tp(lang, 'lr.btn_missed'), 'lr', 'miss'), btn(tp(lang, 'common.back'), 'mus', 'home')],
    ]),
  };
}

async function missedView(app) {
  const lang = app.lang;
  const rows = await app.listeners.topMissed();
  const lines = rows.map((r, i) => t(lang, 'lr.missed_line', { i: digits(i + 1, lang), q: r.text, n: digits(r.n, lang) }));
  return {
    text: [t(lang, 'lr.missed_title'), '', ...(lines.length ? lines : [t(lang, 'lr.missed_empty')])].join('\n'),
    keyboard: markup([
      ...grid(rows.map((_r, i) => btn(tp(lang, 'lr.btn_drop', { i: digits(i + 1, lang) }), 'lr', 'mdel', i)), 4),
      [btn(tp(lang, 'lr.btn_requests'), 'lr', 'home'), btn(tp(lang, 'common.back'), 'mus', 'home')],
    ]),
  };
}

// ---------------------------------------------------------------- the tick: queued notices

/**
 * Tick processor `notices`: arrived requests, then one batch of a followed artist's new song.
 * Each message is claimed before it goes out (at most once); a 429 stops the batch and sets the
 * global cooldown. @returns {Promise<any>}
 */
export async function runNotices(app, { deadlineMs }) {
  if (!(await app.settings.get('listeners.notices'))) return 'off';
  const now = app.clock.now();
  if (cooldownActive(now, Number(await app.settings.get('telegram.cooldown_until')))) return 'cooldown';
  await app.listeners.pruneMissed();
  const out = { requests: 0, followers: 0, failed: 0 };
  let budget = LIMITS.noticeBatch;
  /** @returns {Promise<'sent'|'failed'|'stop'>} */
  const deliver = async (userId, tr, captionKey, vars) => {
    const user = await app.users.get(userId);
    if (!user || user.is_blocked || user.is_banned) return 'failed';
    const lang = await app.users.languageOf(user);
    try {
      await sendTrackTo(app, user, tr, { caption: t(lang, captionKey, vars), view: 'listener_notice', count: false, lang });
      return 'sent';
    } catch (e) {
      const c = classify(e);
      if (c.kind === 'rate_limit') {
        await app.settings.setInternal('telegram.cooldown_until', cooldownAfter429(app.clock.now(), c.retryAfter));
        return 'stop';
      }
      app.log.warn('listener_notice_failed', { user_id: userId, error: c.kind });
      return 'failed';
    }
  };

  for (const r of await app.listeners.matchedRequests(budget)) {
    if (app.clock.ms() >= deadlineMs) return out;
    if (!(await app.listeners.claimMatched(r.id))) continue;
    budget -= 1;
    const tr = await app.listeners.activeById(r.track_id);
    if (!tr) continue;
    const res = await deliver(r.user_id, tr, 'l.notice_request', { q: r.text });
    if (res === 'stop') return { ...out, stopped: 'rate_limit' };
    out[res === 'sent' ? 'requests' : 'failed'] += 1;
  }

  const job = budget > 0 ? await app.listeners.openNoticeJob() : null;
  if (job && app.clock.ms() < deadlineMs) {
    const ids = await app.listeners.followersAfter(job.artist_key, job.cursor_user_id, budget);
    if (!ids.length) {
      await app.listeners.finishNoticeBatch(job.id, 0, true);
      return out;
    }
    if (!(await app.listeners.claimNoticeBatch(job.id, job.cursor_user_id, ids[ids.length - 1]))) return out;
    const tr = await app.listeners.activeById(job.track_id);
    let sent = 0;
    for (const id of ids) {
      if (!tr) break;
      const res = await deliver(id, tr, 'l.notice_follow', { artist: tr.artist || '' });
      if (res === 'stop') break;
      if (res === 'sent') sent += 1;
      else out.failed += 1;
    }
    out.followers = sent;
    await app.listeners.finishNoticeBatch(job.id, sent, !tr || ids.length < budget);
  }
  return out;
}

// ---------------------------------------------------------------- routes

/** @type {any[]} */
export const routes = [
  { ns: 'l', action: 'menu', args: [], perm: null, run: async (app, user, _a, cq) => { await app.tg.show(user.telegram_id, cq.message ? cq.message.message_id : null, { text: t(app.lang, 'l.menu_title'), keyboard: markup([...menuRows(app.lang)]) }, 'listener_menu'); return {}; } },
  {
    ns: 'l', action: 'fav', args: ['pid'], perm: null,
    async run(app, user, [pid], cq) {
      const tr = await trackOf(app, pid);
      if (!tr) return gone(app);
      const r = await app.listeners.toggleFavorite(user.telegram_id, tr);
      await refreshKeyboard(app, user, cq, tr);
      return { toast: tp(app.lang, r.on ? 'l.fav_added' : 'l.fav_removed') };
    },
  },
  {
    ns: 'l', action: 'fol', args: ['pid'], perm: null,
    async run(app, user, [pid], cq) {
      const tr = await trackOf(app, pid);
      if (!tr) return gone(app);
      const r = await app.listeners.toggleFollow(user.telegram_id, tr);
      await refreshKeyboard(app, user, cq, tr);
      return { toast: tp(app.lang, r.on ? 'l.followed' : 'l.unfollowed', { artist: truncate(tr.artist || '', 40) }), alert: r.on };
    },
  },
  {
    ns: 'l', action: 'art', args: ['pid', 'uint'], perm: null,
    async run(app, user, [pid, page], cq) {
      const tr = await trackOf(app, pid);
      if (!tr || !tr.normalized_artist) return gone(app);
      const fromSong = cq.message && cq.message.audio; // pressed under a song: a new message; on a list: in place
      await app.tg.show(user.telegram_id, fromSong ? null : cq.message && cq.message.message_id, await artistView(app, tr, Number(page)), 'listener_artist');
      return {};
    },
  },
  {
    ns: 'l', action: 'alb', args: ['pid'], perm: null,
    async run(app, user, [pid]) {
      const tr = await trackOf(app, pid);
      if (!tr) return gone(app);
      const songs = await app.listeners.album(tr);
      const lang = app.lang;
      const view = songsView(lang, t(lang, 'l.album_title', { album: tr.album || '?', artist: tr.artist || '?', n: digits(songs.length, lang) }), songs.slice(0, PAGE), 0, () => null,
        songs.length > 1 ? [[btn(tp(lang, 'l.btn_album_all', { n: digits(Math.min(songs.length, LIMITS.albumSendMax), lang) }), 'l', 'albs', tr.public_id, 0)]] : []);
      await app.tg.send(user.telegram_id, view, 'listener_album');
      return {};
    },
  },
  {
    // «📥 send the album»: LIMITS.albumSendMax songs per press (a chat takes about one message a second)
    ns: 'l', action: 'albs', args: ['pid', 'uint'], perm: null,
    async run(app, user, [pid, from]) {
      const tr = await trackOf(app, pid);
      if (!tr) return gone(app);
      const songs = await app.listeners.album(tr);
      const start = Number(from);
      const part = songs.slice(start, start + LIMITS.albumSendMax);
      for (const s of part) await sendTrackTo(app, user, s, { view: 'listener_album_song' });
      const next = start + part.length;
      if (next < songs.length) {
        await app.tg.send(user.telegram_id, { text: t(app.lang, 'l.album_more', { n: digits(songs.length - next, app.lang) }), keyboard: markup([[btn(tp(app.lang, 'l.btn_album_next'), 'l', 'albs', tr.public_id, next)]]) }, 'listener_album_more');
      }
      return {};
    },
  },
  {
    ns: 'l', action: 'rnd', args: [], perm: null,
    async run(app, user) {
      const tr = await app.listeners.random();
      if (!tr) return { toast: tp(app.lang, 'l.empty_catalog'), alert: true };
      await sendTrackTo(app, user, tr, { caption: t(app.lang, 'l.random_caption'), view: 'listener_random' });
      return {};
    },
  },
  { ns: 'l', action: 'br', args: [], perm: null, run: async (app, user, _a, cq) => { await app.tg.show(user.telegram_id, cq.message && !cq.message.audio ? cq.message.message_id : null, browseView(app.lang), 'listener_browse'); return {}; } },
  {
    ns: 'l', action: 'g', args: ['word', 'uint'], perm: null,
    async run(app, user, [genre, page], cq) {
      if (!GENRES.includes(String(genre))) return { toast: tp(app.lang, 'common.expired_user'), alert: true };
      const rows = await app.listeners.byGenre(String(genre), Number(page));
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, songsView(app.lang, t(app.lang, 'l.genre_title', { genre: tp(app.lang, `genre.${genre}`) }), rows, Number(page), prevNext(app.lang, Number(page), 'l', 'g', String(genre)), [[btn(tp(app.lang, 'common.back'), 'l', 'br')]]), 'listener_genre');
      return {};
    },
  },
  {
    ns: 'l', action: 'm', args: ['word', 'uint'], perm: null,
    async run(app, user, [mood, page], cq) {
      if (!MOODS.includes(String(mood))) return { toast: tp(app.lang, 'common.expired_user'), alert: true };
      const rows = await app.listeners.byMood(String(mood), Number(page));
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, songsView(app.lang, t(app.lang, 'l.mood_title', { mood: tp(app.lang, `mood.${mood}`) }), rows, Number(page), prevNext(app.lang, Number(page), 'l', 'm', String(mood)), [[btn(tp(app.lang, 'common.back'), 'l', 'br')]]), 'listener_mood');
      return {};
    },
  },
  {
    ns: 'l', action: 'favs', args: ['uint'], perm: null,
    async run(app, user, [page], cq) {
      const rows = await app.listeners.favorites(user.telegram_id, Number(page));
      await app.tg.show(user.telegram_id, cq.message && !cq.message.audio ? cq.message.message_id : null, songsView(app.lang, t(app.lang, 'l.favs_title'), rows, Number(page), prevNext(app.lang, Number(page), 'l', 'favs')), 'listener_favorites');
      return {};
    },
  },
  { ns: 'l', action: 'fols', args: ['uint'], perm: null, run: async (app, user, [page], cq) => { await app.tg.show(user.telegram_id, cq.message && !cq.message.audio ? cq.message.message_id : null, await followsView(app, user, Number(page)), 'listener_follows'); return {}; } },
  {
    ns: 'l', action: 'fa', args: ['uint', 'uint'], perm: null,
    async run(app, user, [page, i], cq) {
      const f = (await app.listeners.follows(user.telegram_id, Number(page)))[Number(i)];
      if (!f) return { toast: tp(app.lang, 'common.expired_user'), alert: true };
      const [tr] = await app.listeners.byArtist(f.artist_key, 0);
      if (!tr) return { toast: tp(app.lang, 'l.artist_no_songs'), alert: true };
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await artistView(app, tr, 0), 'listener_artist');
      return {};
    },
  },
  {
    ns: 'l', action: 'unf', args: ['uint', 'uint'], perm: null,
    async run(app, user, [page, i], cq) {
      const f = (await app.listeners.follows(user.telegram_id, Number(page)))[Number(i)];
      if (f) await app.listeners.unfollow(user.telegram_id, f.artist_key);
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await followsView(app, user, Number(page)), 'listener_follows');
      return f ? { toast: tp(app.lang, 'l.unfollowed', { artist: truncate(f.artist_name, 40) }) } : {};
    },
  },
  {
    ns: 'l', action: 'req', args: [], perm: null,
    async run(app, user) {
      await app.flows.start(user.telegram_id, 'l_req', {});
      await app.tg.send(user.telegram_id, { text: t(app.lang, 'l.request_prompt'), keyboard: markup([[btn(tp(app.lang, 'common.no'), 'u', 'cancel')]]) }, 'listener_request_prompt');
      return {};
    },
  },
  {
    // «📝 request this song» under "nothing found": the query is read back from that message
    ns: 'l', action: 'rq', args: [], perm: null,
    async run(app, user, _a, cq) {
      const q = queryOfMessage(cq.message);
      if (!q) return { toast: tp(app.lang, 'common.expired_user'), alert: true };
      await app.tg.show(user.telegram_id, cq.message.message_id, { text: await addRequest(app, user, q), keyboard: markup([[btn(tp(app.lang, 'l.btn_my_requests'), 'l', 'reqs')]]) }, 'listener_request_added');
      return {};
    },
  },
  { ns: 'l', action: 'reqs', args: [], perm: null, run: async (app, user, _a, cq) => { await app.tg.show(user.telegram_id, cq.message && !cq.message.audio ? cq.message.message_id : null, await requestsView(app, user), 'listener_requests'); return {}; } },
  {
    ns: 'l', action: 'rqx', args: ['uint'], perm: null,
    async run(app, user, [id], cq) {
      const ok = await app.listeners.cancelRequest(user.telegram_id, Number(id));
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await requestsView(app, user), 'listener_requests');
      return { toast: tp(app.lang, ok ? 'l.request_cancelled' : 'common.expired_user') };
    },
  },
  // the owner and admins (catalog.manage)
  { ns: 'lr', action: 'home', args: [], perm: 'catalog.manage', run: async (app, user, _a, cq) => { await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await adminRequestsView(app), 'listener_admin_requests'); return {}; } },
  {
    ns: 'lr', action: 'drop', args: ['uint'], perm: 'catalog.manage',
    async run(app, user, [i], cq) {
      const r = (await app.listeners.requestSummary())[Number(i)];
      if (r) await app.listeners.dropRequests(r.key);
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await adminRequestsView(app), 'listener_admin_requests');
      return r ? { toast: tp(app.lang, 'lr.dropped') } : {};
    },
  },
  { ns: 'lr', action: 'miss', args: [], perm: 'catalog.manage', run: async (app, user, _a, cq) => { await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await missedView(app), 'listener_admin_missed'); return {}; } },
  {
    ns: 'lr', action: 'mdel', args: ['uint'], perm: 'catalog.manage',
    async run(app, user, [i], cq) {
      const r = (await app.listeners.topMissed())[Number(i)];
      if (r) await app.listeners.deleteMissed(r.key);
      await app.tg.show(user.telegram_id, cq.message && cq.message.message_id, await missedView(app), 'listener_admin_missed');
      return r ? { toast: tp(app.lang, 'lr.dropped') } : {};
    },
  },
];

export const flows = {
  l_req: {
    perm: null,
    maxInput: 64,
    async run(app, user, message) {
      const text = String(message.text || '').trim();
      if (!text) throw new UserError('l.err.req_empty');
      await app.flows.clear(user.telegram_id);
      await app.tg.send(user.telegram_id, { text: await addRequest(app, user, text), keyboard: markup([[btn(tp(app.lang, 'l.btn_my_requests'), 'l', 'reqs'), menuButton(app.lang)]]) }, 'listener_request_added');
    },
  },
};

