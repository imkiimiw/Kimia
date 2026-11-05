// "🛡 فیلتر و ضداسپم" and "⚙️ تنظیمات" of the anonymous section, and "🗑 حذف داده‌های من".
// The filters decide what reaches the user; what they stop waits in the "filtered" folder.
// The automatic protections (rate limits, duplicates, restricting reported senders) are always on.
import { MAX_WORDS } from './config.js';
import {
  addWord, deleteRatingsOf, deleteSomeMessages, deleteWords, listWords, removeWord,
} from './astore.js';
import { ensureAnonCode } from './anon.js';
import { normalize } from './filter.js';
import { num, t } from './i18n.js';
import { clearState, setState, setUserField } from './store.js';
import { answer, btn, send, show } from './tg.js';
import { esc } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const onOff = (ctx, v) => T(ctx, v ? 'common.on' : 'common.off');

const TOGGLES = { o: ['a_filter', 'aFilter'], l: ['a_links', 'aLinks'], t: ['a_text', 'aText'], s: ['a_silent', 'aSilent'] };

export async function showFilters(ctx, user, note = '') {
  const words = await listWords(user.id);
  const kb = [
    [btn(`${T(ctx, 'fs.btn_offensive')}: ${onOff(ctx, user.aFilter)}`, 'fs:o')],
    [btn(`${T(ctx, 'fs.btn_links')}: ${onOff(ctx, user.aLinks)}`, 'fs:l')],
    [btn(`${T(ctx, 'fs.btn_text')}: ${onOff(ctx, user.aText)}`, 'fs:t')],
    [btn(`${T(ctx, 'fs.btn_silent')}: ${onOff(ctx, user.aSilent)}`, 'fs:s')],
    [btn(T(ctx, 'fs.btn_words', { n: N(ctx, words.length) }), 'fw'), btn(T(ctx, 'fs.btn_blocks'), 'bl:a')],
    [btn(T(ctx, 'fs.btn_filtered'), 'ib:2:-:0'), btn(T(ctx, 'btn.back'), 'an')],
  ];
  return show(ctx, 'filters', `${note ? `${note}\n\n` : ''}${T(ctx, 'fs.text')}`, kb);
}

export async function toggle(ctx, user, which) {
  const spec = TOGGLES[which];
  if (!spec) return answer(ctx, T(ctx, 'common.invalid'));
  user[spec[1]] = !user[spec[1]];
  await setUserField(user.id, spec[0], user[spec[1]] ? 1 : 0);
  await answer(ctx, T(ctx, user[spec[1]] ? 'common.turned_on' : 'common.turned_off'));
  return showFilters(ctx, user);
}

// ---------- the user's own blocked words ----------

export async function showWords(ctx, user, note = '') {
  const words = await listWords(user.id);
  const kb = words.map((w, i) => [btn(`❌ ${w}`.slice(0, 60), `fw:rm:${i}`)]);
  kb.push([btn(T(ctx, 'fw.btn_add'), 'fw:add'), btn(T(ctx, 'btn.back'), 'fs')]);
  const body = words.length ? words.map((w) => `• ${esc(w)}`).join('\n') : T(ctx, 'fw.empty');
  return show(ctx, 'words', `${note ? `${note}\n\n` : ''}${T(ctx, 'fw.text', { n: N(ctx, words.length), max: N(ctx, MAX_WORDS) })}\n\n${body}`, kb);
}

export async function askWord(ctx, user) {
  await setState(user.id, 'word_add');
  await answer(ctx);
  return show(ctx, 'word_ask', T(ctx, 'fw.ask'), [[btn(T(ctx, 'btn.cancel'), 'fw')]]);
}

/** One word or a few, separated by commas or new lines. */
export async function onWordInput(ctx, user, text) {
  const parts = String(text || '').split(/[,،\n]+/).map(normalize).filter((w) => w.length >= 2 && w.length <= 30);
  if (!parts.length) return send(ctx, 'word_invalid', T(ctx, 'fw.invalid'));
  await clearState(user.id);
  let added = 0;
  let full = false;
  for (const w of parts.slice(0, MAX_WORDS)) {
    const r = await addWord(user.id, w);
    if (r === 'ok') added += 1;
    if (r === 'full') full = true;
  }
  ctx.messageId = null;
  return showWords(ctx, user, full ? T(ctx, 'fw.full', { max: N(ctx, MAX_WORDS) }) : T(ctx, 'fw.added', { n: N(ctx, added) }));
}

export async function removeWordAt(ctx, user, index) {
  const words = await listWords(user.id);
  const w = words[Number(index)];
  if (w !== undefined) await removeWord(user.id, w);
  await answer(ctx, w !== undefined ? T(ctx, 'fw.removed') : '');
  return showWords(ctx, user);
}

// ---------- settings ----------

export async function showSettings(ctx, user) {
  const kb = [
    [btn(T(ctx, user.anonOn ? 'a.btn_pause' : 'a.btn_resume'), 'as:t'), btn(T(ctx, 'a.btn_new_link'), 'as:new')],
    [btn(`${T(ctx, 'pf.rating_visible')}: ${onOff(ctx, user.showRating)}`, 'as:r')],
    [btn(T(ctx, 'as.btn_privacy'), 'pv'), btn(T(ctx, 'privacy.btn_delete'), 'dd')],
    [btn(T(ctx, 'btn.back'), 'an')],
  ];
  return show(ctx, 'anon_settings', T(ctx, 'as.text', {
    state: T(ctx, user.anonOn ? 'a.state_on' : 'a.state_off'),
    rating: onOff(ctx, user.showRating),
  }), kb);
}

// ---------- delete my data ----------

export async function askDeleteData(ctx) {
  await answer(ctx);
  return show(ctx, 'delete_ask', T(ctx, 'dd.ask'), [[btn(T(ctx, 'dd.btn_yes'), 'ddy'), btn(T(ctx, 'btn.cancel'), 'an')]]);
}

/** Inbox, profile, photo, question, words, ratings — and a new link, so the old one stops working. */
export async function deleteData(ctx, user) {
  let removed = 0;
  for (let i = 0; i < 6; i += 1) {
    const n = await deleteSomeMessages(user.id, 200);
    removed += n;
    if (n < 200) break;
  }
  await deleteWords(user.id);
  await deleteRatingsOf(user.id);
  for (const col of ['p_name', 'p_bio', 'p_photo', 'q_text']) await setUserField(user.id, col, null);
  await setUserField(user.id, 'q_mode', 0);
  Object.assign(user, {
    pName: null, pBio: null, pPhoto: null, qText: null, qMode: 0, anonCode: null, ratingSum: 0, ratingCount: 0, inboxSize: 0, anonUnread: 0,
  });
  await ensureAnonCode(user);
  await answer(ctx, T(ctx, 'dd.done_short'), { alert: true });
  return show(ctx, 'delete_done', T(ctx, 'dd.done', { n: N(ctx, removed) }), [[btn(T(ctx, 'btn.home'), 'm')]]);
}
