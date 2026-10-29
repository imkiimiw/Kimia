// The whisper part of the private chat: history (last 20 sent and received), one whisper's details,
// its "curious" list (people who pressed the button but weren't recipients — visible only to the
// sender and the recipients), whisper settings, and the block list (which also lists anonymous
// senders, by number only).
import { DEFAULT_EXPIRY_CHOICES, HISTORY_LIMIT, HISTORY_PAGE, MAX_BLOCKS } from './config.js';
import { listAnonBlocks } from './astore.js';
import { ago, dur, num, t } from './i18n.js';
import { backBtn } from './menu.js';
import {
  addBlock, clearState, getRcpts, getUser, getUserByUsername, getWhisper, listBlocks, listSnoops, rcptsFor,
  receivedHistory, removeBlock, sentHistory, setDefExpiry, setReceipts, setState,
} from './store.js';
import { answer, btn, send, show } from './tg.js';
import {
  joinNames, personHtml, rcptHtml, roleOf,
} from './whisper.js';
import {
  esc, isId, nowSec, toAsciiDigits,
} from './util.js';

const T = (ctx, k, v) => t(ctx.lang, k, v);
const N = (ctx, n) => num(ctx.lang, n);

// ---------- history ----------

function statusKey(w, now) {
  if (w.state === 1) return 'wh.burned';
  if (w.state === 2 || (w.expiresAt && now >= w.expiresAt)) return 'wh.expired';
  return null;
}

function flagsOf(w) {
  return `${w.once ? '🔥' : ''}${w.expiresAt ? '⏳' : ''}`;
}

/** Sent (kind 's') or received ('r') whispers, newest first, 10 per page, at most the last 20. */
export async function showHistory(ctx, user, kind, page) {
  const now = nowSec();
  const p = Math.max(0, Math.min(Number(page) || 0, Math.ceil(HISTORY_LIMIT / HISTORY_PAGE) - 1));
  const lines = [];
  const pick = [];
  let total = 0;
  if (kind === 's') {
    const all = await sentHistory(user.id, HISTORY_LIMIT);
    total = all.length;
    const items = all.slice(p * HISTORY_PAGE, (p + 1) * HISTORY_PAGE);
    const rc = await rcptsFor(items.map((w) => w.id));
    items.forEach((w, i) => {
      const n = p * HISTORY_PAGE + i + 1;
      const rcpts = rc.get(w.id) || [];
      const seen = rcpts.filter((r) => r.seenAt).length;
      const opens = rcpts.reduce((a, r) => a + r.opens, 0);
      const status = statusKey(w, now);
      const body = w.body != null && w.state === 0 ? esc(w.body) : `<i>${T(ctx, status || 'wh.removed')}</i>`;
      const meta = [`👁 ${N(ctx, seen)}/${N(ctx, rcpts.length)}`, T(ctx, 'wh.opens', { n: N(ctx, opens) })];
      if (w.snoops) meta.push(`👀 ${N(ctx, w.snoops)}`);
      if (status && w.body != null) meta.push(T(ctx, status));
      lines.push(`<b>${N(ctx, n)}.</b> ${flagsOf(w)} ${T(ctx, 'wh.to', { who: joinNames(ctx.lang, rcpts.map(rcptHtml)) })} — ${ago(ctx.lang, w.createdAt, now)}\n${body}\n<i>${meta.join(' • ')}</i>`);
      pick.push(btn(N(ctx, n), `d:${w.id}`));
    });
  } else {
    const all = await receivedHistory(user, HISTORY_LIMIT);
    total = all.length;
    all.slice(p * HISTORY_PAGE, (p + 1) * HISTORY_PAGE).forEach(({ whisper: w, sender }, i) => {
      const n = p * HISTORY_PAGE + i + 1;
      const status = statusKey(w, now);
      let body;
      if (status) body = `<i>${T(ctx, status)}</i>`;
      else if (w.once) body = `<i>${T(ctx, 'wh.once_hidden')}</i>`;
      else body = esc(w.body || '');
      const from = sender ? personHtml(sender) : esc(w.senderId);
      lines.push(`<b>${N(ctx, n)}.</b> ${flagsOf(w)} ${T(ctx, 'wh.from', { who: from })} — ${ago(ctx.lang, w.createdAt, now)}\n${body}`);
      pick.push(btn(N(ctx, n), `d:${w.id}`));
    });
  }
  const title = T(ctx, kind === 's' ? 'wh.title_sent' : 'wh.title_received');
  const view = kind === 's' ? 'history_sent' : 'history_received';
  if (!lines.length) {
    return show(ctx, view, `${title}\n\n${T(ctx, kind === 's' ? 'wh.empty_sent' : 'wh.empty_received')}`, [[backBtn(ctx, 'ws')]], { meta: { total: 0 } });
  }
  const kb = [];
  for (let i = 0; i < pick.length; i += 5) kb.push(pick.slice(i, i + 5));
  const nav = [];
  if (p > 0) nav.push(btn(T(ctx, 'btn.prev'), `h:${kind}:${p - 1}`));
  if ((p + 1) * HISTORY_PAGE < total) nav.push(btn(T(ctx, 'btn.next'), `h:${kind}:${p + 1}`));
  if (nav.length) kb.push(nav);
  kb.push([btn(T(ctx, kind === 's' ? 'ws.btn_received' : 'ws.btn_sent'), `h:${kind === 's' ? 'r' : 's'}:0`), backBtn(ctx, 'ws')]);
  // At most 10 items of ≤256 characters: well under Telegram's 4096 visible characters. Never cut
  // HTML here — a cut tag or &amp; would make Telegram reject the whole message.
  const text = `${title} ${T(ctx, 'wh.count', { n: N(ctx, total) })}\n${T(ctx, 'wh.pick')}\n\n${lines.join('\n\n')}`;
  const meta = { total, page: p, shown: pick.length, ids: pick.map((b) => b.callback_data.slice(2)) };
  return show(ctx, view, text, kb, { secret: true, meta });
}

// ---------- details & the curious list ----------

/** One whisper, for its sender (full details) or a recipient (what they may see). */
export async function showDetails(ctx, user, wid) {
  const w = isId(wid, 8, 9) ? await getWhisper(wid) : null;
  const rcpts = w ? await getRcpts(w.id) : [];
  const role = w ? roleOf(w, rcpts, { id: user.id, username: user.username }) : { kind: 'curious' };
  if (!w || role.kind === 'curious') {
    await answer(ctx, T(ctx, 'w.not_yours'), { alert: true });
    return null;
  }
  const now = nowSec();
  const status = statusKey(w, now);
  const lines = [];
  const kb = [];
  if (role.kind === 'sender') {
    lines.push(`${T(ctx, 'wd.own')} — ${ago(ctx.lang, w.createdAt, now)}`);
    lines.push(w.body != null && w.state === 0 ? `\n${esc(w.body)}\n` : `\n<i>${T(ctx, status || 'wh.removed')}</i>\n`);
    lines.push(T(ctx, 'wd.recipients'));
    for (const r of rcpts) {
      const state = r.seenAt ? T(ctx, 'wd.seen', { t: ago(ctx.lang, r.seenAt, now), n: N(ctx, r.opens) }) : T(ctx, 'wd.not_seen');
      lines.push(`• ${rcptHtml(r)} — ${state}`);
    }
    if (w.once) lines.push(T(ctx, 'w.once_line'));
    if (w.expiresAt) lines.push(w.state === 0 && now < w.expiresAt ? T(ctx, 'wd.expires_in', { d: dur(ctx.lang, w.expiresAt - now) }) : T(ctx, 'wh.expired'));
  } else {
    const sender = await getUser(w.senderId);
    lines.push(`${T(ctx, 'wd.from', { who: sender ? personHtml(sender) : esc(w.senderId) })} — ${ago(ctx.lang, w.createdAt, now)}`);
    if (status) lines.push(`\n<i>${T(ctx, status)}</i>`);
    else if (w.once) lines.push(`\n<i>${T(ctx, 'wh.once_hidden')}</i>`);
    else lines.push(`\n${esc(w.body || '')}`);
    kb.push([btn(T(ctx, 'w.btn_block_sender'), `bk:${w.senderId}`)]);
  }
  lines.push(T(ctx, 'wd.curious', { n: N(ctx, w.snoops) }));
  if (w.snoops) kb.unshift([btn(T(ctx, 'wd.btn_curious', { n: N(ctx, w.snoops) }), `n:${w.id}`)]);
  kb.push([btn(T(ctx, 'wd.btn_history'), role.kind === 'sender' ? 'h:s:0' : 'h:r:0')]);
  const meta = { id: w.id, role: role.kind, state: w.state, seen: rcpts.filter((r) => r.seenAt).length, rcpts: rcpts.length, snoops: w.snoops, opens: rcpts.map((r) => r.opens) };
  return show(ctx, 'whisper_details', lines.join('\n'), kb, { secret: true, meta });
}

/** Who pressed the button although it wasn't for them — only the sender and the recipients see it. */
export async function showCurious(ctx, user, wid) {
  const w = isId(wid, 8, 9) ? await getWhisper(wid) : null;
  const rcpts = w ? await getRcpts(w.id) : [];
  const role = w ? roleOf(w, rcpts, { id: user.id, username: user.username }) : { kind: 'curious' };
  if (!w || role.kind === 'curious') {
    await answer(ctx, T(ctx, 'w.not_yours'), { alert: true });
    return null;
  }
  const list = await listSnoops(w.id, 30);
  const now = nowSec();
  const lines = list.map((s, i) => `${N(ctx, i + 1)}. ${personHtml({ id: s.id, username: s.username, firstName: s.firstName })} — ${ago(ctx.lang, s.at, now)}`);
  const more = w.snoops > list.length ? `\n${T(ctx, 'wc.more', { n: N(ctx, w.snoops - list.length) })}` : '';
  const text = list.length ? `${T(ctx, 'wc.title', { n: N(ctx, w.snoops) })}\n\n${lines.join('\n')}${more}` : T(ctx, 'wc.none');
  return show(ctx, 'curious', text, [[btn(T(ctx, 'wc.btn_back'), `d:${w.id}`)]]);
}

// ---------- settings ----------

const expiryLabel = (ctx, sec) => (sec ? dur(ctx.lang, sec) : T(ctx, 'wst.no_expiry'));

export async function showSettings(ctx, user) {
  const choice = (s) => btn(`${s === user.defExpiry ? '✅ ' : ''}${expiryLabel(ctx, s)}`, `st:e:${s}`);
  const kb = [
    [btn(T(ctx, user.receipts ? 'wst.btn_receipts_on' : 'wst.btn_receipts_off'), 'st:r')],
    DEFAULT_EXPIRY_CHOICES.slice(0, 3).map(choice),
    DEFAULT_EXPIRY_CHOICES.slice(3).map(choice),
    [backBtn(ctx, 'ws')],
  ];
  return show(ctx, 'settings', T(ctx, 'wst.text', {
    receipts: T(ctx, user.receipts ? 'common.on' : 'common.off'),
    expiry: expiryLabel(ctx, user.defExpiry),
  }), kb);
}

export async function toggleReceipts(ctx, user) {
  user.receipts = !user.receipts;
  await setReceipts(user.id, user.receipts);
  await answer(ctx, T(ctx, user.receipts ? 'wst.receipts_on' : 'wst.receipts_off'));
  return showSettings(ctx, user);
}

export async function setExpiry(ctx, user, sec) {
  const s = Number(sec);
  if (!DEFAULT_EXPIRY_CHOICES.includes(s)) return answer(ctx, T(ctx, 'common.invalid'));
  user.defExpiry = s;
  await setDefExpiry(user.id, s);
  await answer(ctx, T(ctx, 'wst.expiry_set', { d: expiryLabel(ctx, s) }));
  return showSettings(ctx, user);
}

// ---------- block list ----------

export async function showBlocks(ctx, user, note = '', back = 'ws') {
  const list = await listBlocks(user.id);
  const anon = await listAnonBlocks(user.id);
  const kb = list.map((b) => [btn(`${T(ctx, 'bl.btn_unblock')} ${b.username ? `@${b.username}` : b.firstName || b.id}`.slice(0, 60), `ub:${b.id}`)]);
  anon.forEach((b, i) => kb.push([btn(T(ctx, 'bl.btn_unblock_anon', { n: N(ctx, i + 1) }), `uba:${b.ref}`)]));
  kb.push([btn(T(ctx, 'bl.btn_add'), 'bl:add')]);
  kb.push([backBtn(ctx, back)]);
  const lines = list.map((b, i) => `${N(ctx, i + 1)}. ${b.username ? `@${esc(b.username)}` : esc(b.firstName || '—')} — <code>${b.id}</code>`);
  const body = list.length ? lines.join('\n') : T(ctx, 'bl.empty');
  // Anonymous senders are listed by number and date only: blocking must not reveal who they were.
  const anonPart = anon.length
    ? `\n\n${T(ctx, 'bl.anon_title', { n: N(ctx, anon.length) })}\n${anon.map((b, i) => `${N(ctx, i + 1)}. ${T(ctx, 'bl.anon_item')} — ${ago(ctx.lang, b.createdAt)}`).join('\n')}`
    : '';
  return show(ctx, 'blocks', `${note ? `${note}\n\n` : ''}${T(ctx, 'bl.title', { n: N(ctx, list.length), max: N(ctx, MAX_BLOCKS) })}\n\n${body}${anonPart}`, kb);
}

export async function blockUser(ctx, user, targetId) {
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id <= 0 || id === user.id) return answer(ctx, T(ctx, 'common.invalid'));
  const r = await addBlock(user.id, id);
  if (r === 'full') return answer(ctx, T(ctx, 'bl.full', { max: N(ctx, MAX_BLOCKS) }), { alert: true });
  await answer(ctx, T(ctx, r === 'dup' ? 'bl.already' : 'bl.done'), { alert: r !== 'dup' });
  return showBlocks(ctx, user);
}

export async function unblockUser(ctx, user, targetId) {
  await removeBlock(user.id, Number(targetId));
  await answer(ctx, T(ctx, 'bl.unblocked'));
  return showBlocks(ctx, user);
}

export async function askBlock(ctx, user) {
  await setState(user.id, 'block_add');
  await answer(ctx);
  return show(ctx, 'block_ask', T(ctx, 'bl.ask'), [[btn(T(ctx, 'btn.cancel'), 'bl')]]);
}

/** The reply to "➕ بلاک با آیدی یا یوزرنیم". */
export async function onBlockInput(ctx, user, text) {
  const s = toAsciiDigits(String(text || '').trim());
  let target = null;
  if (/^[1-9][0-9]{4,15}$/.test(s)) target = Number(s);
  else {
    const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s);
    if (m) {
      const u = await getUserByUsername(m[1].toLowerCase());
      if (!u) return send(ctx, 'block_unknown', T(ctx, 'bl.unknown'));
      target = u.id;
    }
  }
  if (!target) return send(ctx, 'block_invalid', T(ctx, 'bl.invalid'));
  await clearState(user.id);
  if (target === user.id) return send(ctx, 'block_invalid', T(ctx, 'bl.self'), [[backBtn(ctx, 'bl')]]);
  const r = await addBlock(user.id, target);
  const note = r === 'ok' ? T(ctx, 'bl.done_id', { id: target }) : T(ctx, r === 'dup' ? 'bl.already' : 'bl.full', { max: N(ctx, MAX_BLOCKS) });
  ctx.messageId = null;
  return showBlocks(ctx, user, note);
}
