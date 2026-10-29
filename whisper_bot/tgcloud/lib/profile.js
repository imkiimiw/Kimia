// "👤 پروفایل": the limited public profile visitors of the link see — a display name, a short bio,
// a photo (sent with "you're sending a message to <name>" whenever someone opens the link), and
// whether the average star rating is shown. Nothing else about the user is ever shown.
// Names and bios go through the same offensive-word and link filters as anonymous messages.
import { BIO_MAX, NAME_MAX } from './config.js';
import { profileCaption, ratingLine } from './anon.js';
import { hasLink, isOffensive, normalize } from './filter.js';
import { t } from './i18n.js';
import { questionOf } from './qotd.js';
import { clearState, setState, setUserField } from './store.js';
import {
  answer, btn, send, sendMedia, show,
} from './tg.js';
import { esc } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);

export async function showProfile(ctx, user, note = '') {
  const kb = [
    [btn(T(ctx, 'pf.btn_name'), 'pf:n'), btn(T(ctx, 'pf.btn_bio'), 'pf:b')],
    [btn(T(ctx, 'pf.btn_photo'), 'pf:p'), ...(user.pPhoto ? [btn(T(ctx, 'pf.btn_photo_rm'), 'pf:px')] : [])],
    [btn(T(ctx, user.showRating ? 'pf.btn_rating_on' : 'pf.btn_rating_off'), 'pf:r'), btn(T(ctx, 'pf.btn_preview'), 'pf:v')],
    [btn(T(ctx, 'btn.back'), 'an')],
  ];
  return show(ctx, 'profile', `${note ? `${note}\n\n` : ''}${T(ctx, 'pf.text', {
    name: esc(user.pName || user.firstName || '—'),
    bio: user.pBio ? esc(user.pBio) : T(ctx, 'pf.empty'),
    photo: T(ctx, user.pPhoto ? 'pf.photo_yes' : 'pf.photo_no'),
    rating: ratingLine(ctx.lang, user),
    visible: T(ctx, user.showRating ? 'common.on' : 'common.off'),
  })}`, kb);
}

/** Exactly what a visitor sees when opening the link. */
export async function preview(ctx, user) {
  await answer(ctx);
  ctx.messageId = null;
  const caption = `${T(ctx, 'pf.preview_head')}\n\n${profileCaption(ctx.lang, user, questionOf(user))}`;
  const kb = [[btn(T(ctx, 'btn.back'), 'pf')]];
  if (user.pPhoto && (await sendMedia(ctx, 'profile_preview', 'photo', user.pPhoto, caption, kb))) return null;
  return send(ctx, 'profile_preview', caption, kb);
}

const ASK = { n: ['profile_name', 'pf.ask_name', NAME_MAX], b: ['profile_bio', 'pf.ask_bio', BIO_MAX], p: ['profile_photo', 'pf.ask_photo', 0] };

export async function ask(ctx, user, what) {
  const [state, key, max] = ASK[what];
  await setState(user.id, state);
  await answer(ctx);
  return show(ctx, state, T(ctx, key, { max }), [[btn(T(ctx, 'btn.cancel'), 'pf')]]);
}

export async function setRatingVisible(ctx, user, visible) {
  user.showRating = visible;
  await setUserField(user.id, 'show_rating', visible ? 1 : 0);
  await answer(ctx, T(ctx, visible ? 'pf.rating_shown' : 'pf.rating_hidden'));
}

export async function toggleRating(ctx, user) {
  await setRatingVisible(ctx, user, !user.showRating);
  return showProfile(ctx, user);
}

export async function removePhoto(ctx, user) {
  user.pPhoto = null;
  await setUserField(user.id, 'p_photo', null);
  await answer(ctx, T(ctx, 'pf.photo_removed'));
  return showProfile(ctx, user);
}

function badText(s) {
  return hasLink(s) || isOffensive(normalize(s));
}

/** The answer to "✏️ نام" / "📝 بیو" / "🖼 عکس". */
export async function onProfileInput(ctx, user, message, state) {
  if (state === 'profile_photo') {
    const photo = Array.isArray(message.photo) && message.photo.length ? message.photo[message.photo.length - 1] : null;
    if (!photo) return send(ctx, 'profile_invalid', T(ctx, 'pf.need_photo'));
    await clearState(user.id);
    user.pPhoto = photo.file_id;
    await setUserField(user.id, 'p_photo', user.pPhoto);
    ctx.messageId = null;
    return showProfile(ctx, user, T(ctx, 'pf.photo_saved'));
  }
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  const [, , max] = state === 'profile_name' ? ASK.n : ASK.b;
  if (!text) return send(ctx, 'profile_invalid', T(ctx, 'pf.need_text'));
  if (text.length > max) return send(ctx, 'profile_invalid', T(ctx, 'pf.too_long', { max }));
  if (badText(text)) return send(ctx, 'profile_invalid', T(ctx, 'pf.not_allowed'));
  await clearState(user.id);
  if (state === 'profile_name') {
    user.pName = text;
    await setUserField(user.id, 'p_name', text);
  } else {
    user.pBio = text;
    await setUserField(user.id, 'p_bio', text);
  }
  ctx.messageId = null;
  return showProfile(ctx, user, T(ctx, 'pf.saved'));
}
