// "📥 صندوق پیام": the anonymous messages a user received. Three folders — inbox, archive, and
// "filtered" (what a filter kept from being delivered; it empties itself after 30 days) — a category
// filter, search, and per message: reply, block, archive, re-categorize, image card, report, delete.
// callback_data: ib:<folder>:<cat|->:<page>  iv:<id>  ia:<id>  ic:<id>[:<cat>]  ix:<id>  ixy:<id>
//                ibb:<id>  is:<folder>
import { CATEGORIES, INBOX_PAGE } from './config.js';
import {
  deleteMsg, FOLDER, getAnonMsg, isAnonBlocked, listFolder, markRead, searchFolder, setCat, setFolder,
} from './astore.js';
import { catLabel, displayNameOf } from './anon.js';
import { botInfo } from './bot.js';
import { cardUrl } from './card.js';
import { normalize } from './filter.js';
import { ago, num, t } from './i18n.js';
import { clearState, getUser, setState } from './store.js';
import {
  answer, btn, send, sendMedia, show, webAppBtn,
} from './tg.js';
import { esc, truncate } from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);
const isRef = (s) => /^[0-9A-Za-z]{10}$/.test(String(s));
const FOLDER_KEYS = ['in.folder_inbox', 'in.folder_archive', 'in.folder_filtered'];

function snippet(ctx, m) {
  const media = m.kind !== 'text' ? `${T(ctx, `kind.${m.kind}`)} ` : '';
  const text = m.body ? esc(truncate(m.body.replace(/\s+/g, ' '), 60)) : '';
  return `${media}${text}` || T(ctx, `kind.${m.kind}`);
}

function itemLine(ctx, m, n) {
  return `<b>${N(ctx, n)}.</b> ${m.unread ? '🔵 ' : ''}${CATEGORIES[m.cat] || ''} ${snippet(ctx, m)} — <i>${ago(ctx.lang, m.createdAt)}</i>`;
}

/** A folder page: tabs, category filter, numbered items, navigation, search. */
export async function showInbox(ctx, user, folderArg, catArg, pageArg) {
  const folder = [0, 1, 2].includes(Number(folderArg)) ? Number(folderArg) : 0;
  const cat = CATEGORIES[catArg] ? catArg : null;
  const page = Math.max(0, Number(pageArg) || 0);
  const { items, more } = await listFolder(user.id, folder, cat, page, INBOX_PAGE);
  const c = cat || '-';
  const tabs = [0, 1, 2].map((f) => btn(`${f === folder ? '• ' : ''}${T(ctx, FOLDER_KEYS[f])}`, `ib:${f}:-:0`));
  const cats = [btn(`${cat ? '' : '• '}${T(ctx, 'in.all')}`, `ib:${folder}:-:0`), ...Object.keys(CATEGORIES).map((k) => btn(`${k === cat ? '•' : ''}${CATEGORIES[k]}`, `ib:${folder}:${k}:0`))];
  const kb = [tabs, cats.slice(0, 4), cats.slice(4)];
  const pick = items.map((m, i) => btn(N(ctx, page * INBOX_PAGE + i + 1), `iv:${m.id}`));
  for (let i = 0; i < pick.length; i += 4) kb.push(pick.slice(i, i + 4));
  const nav = [];
  if (page > 0) nav.push(btn(T(ctx, 'btn.prev'), `ib:${folder}:${c}:${page - 1}`));
  if (more) nav.push(btn(T(ctx, 'btn.next'), `ib:${folder}:${c}:${page + 1}`));
  if (nav.length) kb.push(nav);
  kb.push([btn(T(ctx, 'in.btn_search'), `is:${folder}`), btn(T(ctx, 'btn.back'), 'an')]);
  const head = T(ctx, 'in.title', { folder: T(ctx, FOLDER_KEYS[folder]), cat: cat ? ` · ${catLabel(ctx.lang, cat)}` : '' });
  const note = folder === FOLDER.filtered ? `\n${T(ctx, 'in.filtered_note')}` : '';
  const body = items.length ? items.map((m, i) => itemLine(ctx, m, page * INBOX_PAGE + i + 1)).join('\n') : T(ctx, 'in.empty');
  const meta = { folder, cat, page, ids: items.map((m) => m.id), unread: user.anonUnread };
  return show(ctx, 'inbox', `${head}${note}\n\n${body}`, kb, { secret: true, meta });
}

async function messageKeyboard(ctx, user, m, kv) {
  const bot = await botInfo(ctx, kv);
  const blocked = await isAnonBlocked(user.id, m.fromId);
  const back = `ib:${m.folder}:-:0`;
  const rows = [
    [btn(T(ctx, 'a.btn_reply'), `ar:${m.id}`), btn(T(ctx, blocked ? 'a.btn_unblock' : 'a.btn_block'), `ibb:${m.id}`)],
    [btn(T(ctx, m.folder === FOLDER.inbox ? 'in.btn_archive' : 'in.btn_to_inbox'), `ia:${m.id}`), btn(T(ctx, 'in.btn_cat'), `ic:${m.id}`)],
  ];
  const third = [];
  if (bot.id && (m.body || m.q)) third.push(webAppBtn(T(ctx, 'in.btn_card'), cardUrl(bot.id, { k: 'msg', id: m.id, l: ctx.lang })));
  third.push(btn(T(ctx, 'a.btn_report'), `ap:${m.id}`));
  rows.push(third);
  rows.push([btn(T(ctx, 'in.btn_delete'), `ix:${m.id}`), btn(T(ctx, 'btn.back'), back)]);
  return rows;
}

async function loadOwn(ctx, user, id) {
  const m = isRef(id) ? await getAnonMsg(id) : null;
  if (!m || m.toId !== user.id) {
    await answer(ctx, T(ctx, 'a.gone'), { alert: true });
    return null;
  }
  return m;
}

/** One message: header (category, time, the question it answers, who for a known sender), content, actions. */
export async function showMessage(ctx, user, kv, id) {
  const m = await loadOwn(ctx, user, id);
  if (!m) return null;
  if (await markRead(m.id, user.id)) user.anonUnread = Math.max(0, user.anonUnread - 1);
  const lines = [];
  if (m.anon) lines.push(T(ctx, 'in.msg_anon', { cat: catLabel(ctx.lang, m.cat), t: ago(ctx.lang, m.createdAt) }));
  else {
    const from = await getUser(m.fromId);
    lines.push(T(ctx, 'in.msg_reply', { name: esc(from ? displayNameOf(from, ctx.lang) : '?'), t: ago(ctx.lang, m.createdAt) }));
  }
  if (m.q) lines.push(T(ctx, 'a.answering', { q: esc(m.q) }));
  if (m.folder === FOLDER.filtered) lines.push(T(ctx, 'in.msg_filtered'));
  const head = lines.join('\n');
  const kb = await messageKeyboard(ctx, user, m, kv);
  const meta = { id: m.id, folder: m.folder, cat: m.cat, kind: m.kind };
  if (m.kind === 'text') return show(ctx, 'inbox_message', `${head}\n\n${esc(m.body)}`, kb, { secret: true, meta });
  await answer(ctx);
  ctx.messageId = null;
  const caption = m.body ? `${head}\n\n${esc(m.body)}` : head;
  return sendMedia(ctx, 'inbox_message', m.kind, m.fileId, truncate(caption, 1000), kb, ctx.chatId, { secret: true, meta });
}

export async function toggleArchive(ctx, user, kv, id) {
  const m = await loadOwn(ctx, user, id);
  if (!m) return null;
  const to = m.folder === FOLDER.inbox ? FOLDER.archive : FOLDER.inbox;
  await setFolder(m.id, user.id, to);
  await answer(ctx, T(ctx, to === FOLDER.archive ? 'in.archived' : 'in.unarchived'));
  return showInbox(ctx, user, m.folder, '-', 0);
}

/** "ic:<id>" shows the categories, "ic:<id>:<cat>" files the message under one. */
export async function recategorize(ctx, user, kv, id, cat) {
  const m = await loadOwn(ctx, user, id);
  if (!m) return null;
  if (!cat) {
    await answer(ctx);
    const keys = Object.keys(CATEGORIES);
    const rows = [];
    for (let i = 0; i < keys.length; i += 3) rows.push(keys.slice(i, i + 3).map((k) => btn(`${k === m.cat ? '✅ ' : ''}${catLabel(ctx.lang, k)}`, `ic:${m.id}:${k}`)));
    rows.push([btn(T(ctx, 'btn.back'), `iv:${m.id}`)]);
    ctx.messageId = m.kind === 'text' ? ctx.messageId : null;
    return show(ctx, 'inbox_categories', T(ctx, 'in.pick_cat'), rows);
  }
  if (!CATEGORIES[cat]) return answer(ctx, T(ctx, 'common.invalid'));
  await setCat(m.id, user.id, cat);
  await answer(ctx, T(ctx, 'a.cat_set', { cat: catLabel(ctx.lang, cat) }));
  return showMessage(ctx, user, kv, m.id);
}

export async function askDelete(ctx, user, id) {
  const m = await loadOwn(ctx, user, id);
  if (!m) return null;
  await answer(ctx);
  ctx.messageId = m.kind === 'text' ? ctx.messageId : null;
  return show(ctx, 'inbox_delete_ask', T(ctx, 'in.delete_ask'), [[btn(T(ctx, 'in.btn_delete_yes'), `ixy:${m.id}`), btn(T(ctx, 'btn.cancel'), `iv:${m.id}`)]]);
}

export async function doDelete(ctx, user, id) {
  const m = await loadOwn(ctx, user, id);
  if (!m) return null;
  await deleteMsg(m.id, user.id);
  user.inboxSize = Math.max(0, user.inboxSize - 1);
  await answer(ctx, T(ctx, 'in.deleted'));
  return showInbox(ctx, user, m.folder, '-', 0);
}

// ---------- search ----------

export async function askSearch(ctx, user, folder) {
  const f = [0, 1, 2].includes(Number(folder)) ? Number(folder) : 0;
  await setState(user.id, 'inbox_search', { folder: f });
  await answer(ctx);
  return show(ctx, 'inbox_search_ask', T(ctx, 'in.search_ask', { folder: T(ctx, FOLDER_KEYS[f]) }), [[btn(T(ctx, 'btn.cancel'), `ib:${f}:-:0`)]]);
}

export async function onSearch(ctx, user, text, data) {
  const term = normalize(text);
  if (term.length < 2) return send(ctx, 'inbox_search_short', T(ctx, 'in.search_short'));
  await clearState(user.id);
  const folder = Number(data.folder) || 0;
  const found = await searchFolder(user.id, folder, term, 20);
  const kb = [];
  const pick = found.map((m, i) => btn(N(ctx, i + 1), `iv:${m.id}`));
  for (let i = 0; i < pick.length; i += 5) kb.push(pick.slice(i, i + 5));
  kb.push([btn(T(ctx, 'in.btn_search_again'), `is:${folder}`), btn(T(ctx, 'btn.back'), `ib:${folder}:-:0`)]);
  const body = found.length ? found.map((m, i) => itemLine(ctx, m, i + 1)).join('\n') : T(ctx, 'in.search_none');
  return send(ctx, 'inbox_search', `${T(ctx, 'in.search_title', { q: esc(truncate(String(text).trim(), 40)), n: N(ctx, found.length) })}\n\n${body}`, kb, ctx.chatId, { secret: true, meta: { found: found.length, ids: found.map((m) => m.id) } });
}
