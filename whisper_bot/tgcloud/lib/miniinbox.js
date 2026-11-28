// The inbox inside the Mini App (webapp/inbox.html, endpoint `inbox`): the same folders, categories,
// search, reading, reactions, replies, archive, category, block, report and delete as the bot's inbox
// buttons, on one scrolling page. The caller is always the platform-verified initData user, and every
// message must be theirs. A reply goes through the same relay as one typed in the chat
// (lib/anon.js relayAnon: blocks, anti-spam, the recipient's filters, anonymity both ways); media
// can't be shown in the page, so "💬 open in the chat" has the bot send it there.
import {
  ANON_MAX_LEN, CATEGORIES, PICKABLE_CATEGORIES, REACTIONS,
} from './config.js';
import {
  catLabel, displayNameOf, fileReport, react, relayAnon,
} from './anon.js';
import {
  FOLDER, addAnonBlock, addStrike, deleteMsg, getAnonMsg, isAnonBlocked, listFolder, markRead, removeAnonBlock, searchFolder,
  setCat, setFolder,
} from './astore.js';
import { normalize } from './filter.js';
import {
  ago, langOf, num, t,
} from './i18n.js';
import { showMessage } from './inbox.js';
import { checkJoin } from './join.js';
import { getUser, loadKv, usersByIds } from './store.js';
import { createCtx } from './tg.js';
import { truncate } from './util.js';

const PAGE = 20;
const isRef = (s) => /^[0-9A-Za-z]{10}$/.test(String(s));
const LABEL_KEYS = ['title', 'inbox', 'archive', 'filtered', 'all', 'search', 'more', 'empty', 'reply_ph', 'send', 'sent', 'to_archive',
  'to_inbox', 'delete', 'delete_confirm', 'block', 'unblock', 'report', 'report_confirm', 'reported', 'open_chat', 'opened_chat', 'cat',
  'back', 'failed', 'filtered_note', 'media_note', 'question', 'unread', 'deleted', 'blocked', 'unblocked', 'no_reply'];

function labels(lang) {
  const out = {};
  for (const k of LABEL_KEYS) out[k] = t(lang, `ia.${k}`);
  return out;
}

/** Who a message is from, as the inbox shows it: anonymous (its category), or a named reply. */
function fromLabel(lang, m, senders) {
  if (m.anon) return catLabel(lang, m.cat);
  if (m.cf) return t(lang, 'ia.from_cf', { id: num(lang, m.cf) }); // a confession's author: never a name
  const u = senders.get(m.fromId);
  return t(lang, 'ia.from_reply', { name: u ? displayNameOf(u, lang) : '?' });
}

function itemOf(lang, m, senders) {
  const media = m.kind !== 'text';
  return {
    id: m.id,
    cat: m.cat,
    kind: m.kind,
    media,
    unread: m.unread,
    folder: m.folder,
    ago: ago(lang, m.createdAt),
    from: fromLabel(lang, m, senders),
    preview: media ? `${t(lang, `kind.${m.kind}`)}${m.body ? ` · ${truncate(m.body, 100)}` : ''}` : truncate(m.body, 140),
    q: m.q ? truncate(m.q, 80) : '',
    reaction: m.reaction || '',
  };
}

async function sendersOf(items) {
  return usersByIds([...new Set(items.filter((m) => !m.anon && !m.cf).map((m) => m.fromId))]);
}

async function own(user, id) {
  const m = isRef(id) ? await getAnonMsg(String(id)) : null;
  return m && m.toId === user.id ? m : null;
}

/** A folder page (or search results) with the page's labels and the categories. */
async function list(user, lang, input) {
  const folder = [0, 1, 2].includes(Number(input.folder)) ? Number(input.folder) : 0;
  const cat = CATEGORIES[input.cat] ? input.cat : null;
  const page = Math.max(0, Math.min(50, Number(input.page) || 0));
  const q = normalize(String(input.q || '')).trim().slice(0, 50);
  let items;
  let more = false;
  if (q.length >= 2) items = await searchFolder(user.id, folder, q, PAGE);
  else ({ items, more } = await listFolder(user.id, folder, cat, page, PAGE));
  const senders = await sendersOf(items);
  return {
    lang,
    labels: labels(lang),
    folder,
    cat: cat || '-',
    page,
    more,
    unread: user.anonUnread,
    cats: Object.keys(CATEGORIES).map((k) => ({ key: k, label: catLabel(lang, k) })),
    pickable: PICKABLE_CATEGORIES.map((k) => ({ key: k, label: catLabel(lang, k) })),
    reactions: REACTIONS,
    items: items.map((m) => itemOf(lang, m, senders)),
  };
}

/** One message in full; reading it marks it read. */
async function get(user, lang, input) {
  const m = await own(user, input.id);
  if (!m) return { error: 'NOT_YOURS', message: t(lang, 'a.gone') };
  await markRead(m.id, user.id);
  const senders = await sendersOf([m]);
  return {
    ...itemOf(lang, m, senders),
    unread: false,
    body: m.body,
    q: m.q || '',
    blocked: await isAnonBlocked(user.id, m.fromId),
  };
}

/** archive | delete | cat | block | react | report | open (in the chat). */
async function act(user, lang, input) {
  const m = await own(user, input.id);
  if (!m) return { error: 'NOT_YOURS', message: t(lang, 'a.gone') };
  const ctx = createCtx({ userId: user.id, chatId: user.id, lang });
  switch (input.act) {
    case 'archive':
      await setFolder(m.id, user.id, m.folder === FOLDER.inbox ? FOLDER.archive : FOLDER.inbox);
      break;
    case 'delete':
      await deleteMsg(m.id, user.id);
      return { ok: true, deleted: true };
    case 'cat':
      if (!PICKABLE_CATEGORIES.includes(input.arg)) return { error: 'BAD_CAT', message: t(lang, 'ia.failed') };
      await setCat(m.id, user.id, input.arg);
      break;
    case 'block':
      if (await isAnonBlocked(user.id, m.fromId)) await removeAnonBlock(user.id, m.fromId);
      else if ((await addAnonBlock(user.id, m.fromId)) === 'ok' && m.anon) await addStrike(m.fromId, user.id);
      break;
    case 'react':
      if (!(await react(ctx, user, m.id, Number(input.arg), { inbox: true }))) return { error: 'BAD_REACTION', message: t(lang, 'ia.failed') };
      break;
    case 'report':
      return { ok: true, reported: (await fileReport(ctx, user, m)) === 'ok' };
    case 'open': // the bot sends it into the chat (media can't be shown in the page)
      await showMessage(ctx, user, await loadKv(), m.id);
      return { ok: true, opened: true };
    default:
      return { error: 'BAD_ACT', message: t(lang, 'ia.failed') };
  }
  return get(user, lang, { id: m.id });
}

/** A text reply, through the same relay as one typed in the chat. A held reply looks sent, as there. */
async function reply(user, lang, input) {
  const m = await own(user, input.id);
  if (!m) return { error: 'NOT_YOURS', message: t(lang, 'a.gone') };
  if (user.banned) return { error: 'BANNED', message: t(lang, 'e.banned') };
  const text = String(input.text || '').trim();
  if (!text) return { error: 'EMPTY', message: t(lang, 'ia.reply_ph') };
  if (text.length > ANON_MAX_LEN) return { error: 'TOO_LONG', message: t(lang, 'a.too_long', { max: num(lang, ANON_MAX_LEN) }) };
  const ctx = createCtx({ userId: user.id, chatId: user.id, lang });
  const kv = await loadKv();
  if (!(await checkJoin(ctx, user, kv)).ok) return { error: 'JOIN', message: t(lang, 'join.first') };
  const r = await relayAnon(ctx, user, { message_id: null, chat: { id: user.id }, text }, { state: 'anon_reply', data: { ref: m.id } });
  if (r.error) return { error: r.error.view.toUpperCase(), message: t(lang, r.error.key, r.error.vars) };
  return { ok: true };
}

const OPS = { list, get, act, reply };

/** The `inbox` endpoint: { op: list | get | act | reply, … } from the platform-verified user. */
export async function inboxCall(userId, input) {
  const user = await getUser(userId);
  if (!user || !user.started) return { error: 'NO_USER', message: 'Open the bot first' };
  const op = OPS[input.op];
  if (!op) return { error: 'BAD_OP', message: 'Unknown operation' };
  return op(user, langOf(user), input);
}
