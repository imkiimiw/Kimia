/*
 * The owner's broadcast screens. Flow: audience (bot users / all groups / all channels) → mode
 * (copy / forward) → the owner sends the message → preview (an exact copy) and a confirm card with
 * optional URL buttons (copy mode only: forwardMessage can't carry new buttons) → send.
 * Sending: the first batch goes out at once; then the "next batch" button, the Mini App's live page
 * and the bot's other traffic move it forward (engines/broadcast.js). The progress card is edited
 * as it goes; the final report (sent / failed / blocked) arrives as a new message.
 *
 * callback_data: ob (home) · ob:n (new: audience) · ob:a:<u|g|c> (mode) · ob:m:<u|g|c>:<c|f>
 * (ask for the message) · bc:pv:<id> (preview again) · bc:bt:<id> (set buttons) · bc:rb:<id>
 * (remove buttons) · bc:no:<id> (discard draft) · bc:go:<id> (send) · bc:v:<id> / bc:rf:<id>
 * (progress) · bc:nx:<id> (next batch) · bc:ps:<id> / bc:rs:<id> (pause / resume) · bc:x:<id>
 * (cancel?) · bc:xy:<id> (cancel!).
 * Pending inputs (aegis_states): bc_content { audience, mode }, bc_buttons { id }.
 */
import { BC_BATCH, BC_BUDGET_MS, BC_PROGRESS_EVERY_SEC, OWNER_ID } from '../config.js';
import { appUrl } from '../core/bot.js';
import * as state from '../core/state.js';
import { answer, appBtn, btn, edit, screen, send, tryCall } from '../core/tg.js';
import { toInt } from '../core/util.js';
import * as bc from '../engines/broadcast.js';
import { countButtons, parseButtons } from '../engines/buttons.js';
import * as users from '../engines/users.js';
import { dur, t } from '../i18n/index.js';

const AUD = { u: 'users', g: 'groups', c: 'channels' };
const MODE = { c: 'copy', f: 'forward' };
const back = (lang, data) => [btn(t(lang, 'common.back'), data)];

export const ownerLang = async () => {
  const o = await users.get(OWNER_ID);
  return (o && o.lang) || 'en';
};

/* What kind of message the owner sent (for labels); null when it can't be broadcast. */
export function contentType(m) {
  for (const k of ['photo', 'video', 'animation', 'document', 'audio', 'voice', 'video_note', 'sticker', 'poll', 'location', 'venue', 'contact', 'dice', 'text']) {
    if (m[k] !== undefined) return k === 'venue' ? 'location' : k;
  }
  return null;
}

/* ---------- home and new-broadcast steps ---------- */

export async function home(ctx, lang, place = null) {
  await state.clear(OWNER_ID);
  const cur = await bc.active();
  const q = await bc.queued();
  const last = await bc.latestFinished();
  const lines = [t(lang, 'bc.home_title'), ''];
  if (cur) {
    const p = bc.progress(cur);
    lines.push(t(lang, 'bc.home_active', { id: p.id, status: t(lang, `bc.st_${p.status}`), pct: p.pct }));
  } else lines.push(t(lang, 'bc.home_idle'));
  if (q.length) lines.push(t(lang, 'bc.home_queued', { n: q.length }));
  if (last) {
    const p = bc.progress(last);
    lines.push(t(lang, 'bc.home_last', { id: p.id, status: t(lang, `bc.st_${p.status}`), sent: p.sent, failed: p.failed, blocked: p.blocked }));
  }
  const rows = [[btn(t(lang, 'bc.btn_new'), 'ob:n')]];
  if (cur) rows.push([btn(t(lang, 'bc.btn_progress', { id: Number(cur.id) }), `bc:v:${cur.id}`)]);
  for (const b of q.slice(0, 5)) rows.push([btn(t(lang, 'bc.btn_queued', { id: Number(b.id) }), `bc:v:${b.id}`)]);
  rows.push(back(lang, 'op'));
  return screen(ctx, OWNER_ID, place, lines.join('\n'), rows, 'bc-home');
}

async function audienceScreen(ctx, lang, place) {
  const n = { users: await bc.countAudience('users'), groups: await bc.countAudience('groups'), channels: await bc.countAudience('channels') };
  const rows = [
    [btn(t(lang, 'bc.aud_btn_users', { n: n.users }), 'ob:a:u')],
    [btn(t(lang, 'bc.aud_btn_groups', { n: n.groups }), 'ob:a:g')],
    [btn(t(lang, 'bc.aud_btn_channels', { n: n.channels }), 'ob:a:c')],
    back(lang, 'ob'),
  ];
  return screen(ctx, OWNER_ID, place, t(lang, 'bc.pick_audience'), rows, 'bc-audience');
}

async function modeScreen(ctx, lang, place, a) {
  const audience = AUD[a];
  if (await bc.countAudience(audience) === 0) {
    await answer(ctx, t(lang, 'bc.no_recipients'), true);
    return null;
  }
  const rows = [[btn(t(lang, 'bc.mode_btn_copy'), `ob:m:${a}:c`)], [btn(t(lang, 'bc.mode_btn_forward'), `ob:m:${a}:f`)], back(lang, 'ob:n')];
  return screen(ctx, OWNER_ID, place, t(lang, 'bc.pick_mode', { audience: t(lang, `bc.aud_${audience}`) }), rows, 'bc-mode');
}

async function askContent(ctx, lang, place, a, m) {
  const audience = AUD[a];
  const mode = MODE[m];
  await state.set(OWNER_ID, 'bc_content', { audience, mode });
  const text = t(lang, 'bc.send_prompt', { audience: t(lang, `bc.aud_${audience}`), mode: t(lang, `bc.mode_${mode}`) });
  return screen(ctx, OWNER_ID, place, text, [[btn(t(lang, 'common.cancel'), 'ox')]], 'bc-prompt');
}

/* ---------- inputs ---------- */

/* The owner sent the message to broadcast. */
export async function contentInput(ctx, lang, message, data) {
  if (message.media_group_id) return send(ctx, OWNER_ID, t(lang, 'bc.album_unsupported'), [[btn(t(lang, 'common.cancel'), 'ox')]], 'bc-album');
  const type = contentType(message);
  if (!type) return send(ctx, OWNER_ID, t(lang, 'bc.unsupported'), [[btn(t(lang, 'common.cancel'), 'ox')]], 'bc-unsupported');
  const id = await bc.createDraft({ audience: data.audience, mode: data.mode, fromChat: OWNER_ID, messageId: message.message_id, contentType: type, createdBy: OWNER_ID });
  const kb = message.reply_markup && message.reply_markup.inline_keyboard;
  if (data.mode === 'copy' && Array.isArray(kb)) {
    const rows = kb.map((r) => r.filter((b) => b.url).map((b) => ({ text: b.text, url: b.url }))).filter((r) => r.length);
    if (rows.length) await bc.setButtons(id, rows);
  }
  await state.clear(OWNER_ID);
  return preview(ctx, lang, id);
}

/* The owner sent button lines for draft `data.id`. */
export async function buttonsInput(ctx, lang, message, data) {
  const id = Number(data.id);
  const row = await bc.get(id);
  if (!row || row.status !== 'draft') {
    await state.clear(OWNER_ID);
    return send(ctx, OWNER_ID, t(lang, 'bc.not_draft'), [back(lang, 'ob')], 'bc-not-draft');
  }
  const parsed = parseButtons(message.text);
  if (parsed.error) {
    const text = t(lang, `bc.buttons_err_${parsed.error}`, { line: parsed.line });
    return send(ctx, OWNER_ID, `${text}\n\n${t(lang, 'bc.buttons_help')}`, [[btn(t(lang, 'common.cancel'), `bc:pv:${id}`)]], 'bc-buttons-bad');
  }
  await bc.setButtons(id, parsed.rows);
  await state.clear(OWNER_ID);
  return preview(ctx, lang, id);
}

/* ---------- preview and confirm ---------- */

function confirmCard(lang, row, n) {
  const rows = bc.buttonsOf(row);
  const lines = [
    t(lang, 'bc.confirm_title', { id: Number(row.id) }),
    '',
    t(lang, 'bc.confirm_audience', { audience: t(lang, `bc.aud_${row.audience}`), n }),
    t(lang, 'bc.confirm_mode', { mode: t(lang, `bc.mode_${row.mode}`) }),
    t(lang, 'bc.confirm_type', { type: t(lang, `bc.ct_${row.content_type}`) }),
  ];
  if (row.mode === 'copy') lines.push(t(lang, 'bc.confirm_buttons', { n: countButtons(rows) }));
  else lines.push(t(lang, 'bc.confirm_forward_note'));
  lines.push('', t(lang, 'bc.confirm_question'));
  const kb = [[btn(t(lang, 'bc.btn_send'), `bc:go:${row.id}`)]];
  if (row.mode === 'copy') {
    const edits = [btn(t(lang, rows ? 'bc.btn_edit_buttons' : 'bc.btn_add_buttons'), `bc:bt:${row.id}`)];
    if (rows) edits.push(btn(t(lang, 'bc.btn_remove_buttons'), `bc:rb:${row.id}`));
    kb.push(edits);
  }
  kb.push([btn(t(lang, 'bc.btn_discard'), `bc:no:${row.id}`)]);
  return { text: lines.join('\n'), kb };
}

/* Sends the exact message (copy with its buttons, or a forward) and the confirm card under it. */
export async function preview(ctx, lang, id) {
  const row = await bc.get(id);
  if (!row || row.status !== 'draft') return send(ctx, OWNER_ID, t(lang, 'bc.not_draft'), [back(lang, 'ob')], 'bc-not-draft');
  const base = { chat_id: OWNER_ID, from_chat_id: Number(row.from_chat), message_id: Number(row.message_id) };
  const rows = bc.buttonsOf(row);
  if (row.mode === 'copy' && rows) base.reply_markup = { inline_keyboard: rows };
  const copy = await tryCall(ctx, row.mode === 'forward' ? 'forwardMessage' : 'copyMessage', base, 'bc-preview');
  if (!copy) {
    await bc.cancel(id, OWNER_ID);
    return send(ctx, OWNER_ID, t(lang, 'bc.cant_copy'), [back(lang, 'ob')], 'bc-cant-copy');
  }
  const card = confirmCard(lang, row, await bc.countAudience(row.audience));
  return send(ctx, OWNER_ID, card.text, card.kb, 'bc-confirm');
}

/* ---------- progress ---------- */

function bar(pct) {
  const full = Math.round(pct / 10);
  return `${'▓'.repeat(full)}${'░'.repeat(10 - full)}`;
}

export async function progressView(ctx, lang, row) {
  const p = bc.progress(row);
  const lines = [
    t(lang, 'bc.progress_title', { id: p.id, status: t(lang, `bc.st_${p.status}`) }),
    t(lang, 'bc.progress_meta', { audience: t(lang, `bc.aud_${p.audience}`), mode: t(lang, `bc.mode_${p.mode}`) }),
    '',
    t(lang, 'bc.progress_bar', { bar: bar(p.pct), pct: p.pct }),
    t(lang, 'bc.progress_counts', { sent: p.sent, failed: p.failed, blocked: p.blocked }),
    t(lang, 'bc.progress_left', { left: p.left, total: p.total }),
  ];
  if (p.status === 'running' && p.waitMs > 1500) lines.push(t(lang, 'bc.progress_wait', { time: dur(lang, Math.ceil(p.waitMs / 1000)) }));
  if (p.status === 'paused' && p.lastError === 'source_gone') lines.push('', t(lang, 'bc.paused_source_gone'));
  if (p.status === 'done' || p.status === 'cancelled') lines.push(t(lang, 'bc.progress_took', { time: dur(lang, p.took) }));
  if (p.status === 'running') lines.push('', t(lang, 'bc.progress_hint'));
  if (p.status === 'queued') lines.push('', t(lang, 'bc.progress_queued_hint'));
  const kb = [];
  if (p.status === 'running') {
    kb.push([btn(t(lang, 'bc.btn_next'), `bc:nx:${p.id}`)]);
    kb.push([appBtn(t(lang, 'bc.btn_live'), `${await appUrl(ctx)}#bc`)]);
    kb.push([btn(t(lang, 'bc.btn_pause'), `bc:ps:${p.id}`), btn(t(lang, 'common.refresh'), `bc:rf:${p.id}`)]);
    kb.push([btn(t(lang, 'bc.btn_cancel'), `bc:x:${p.id}`)]);
  } else if (p.status === 'paused') {
    kb.push([btn(t(lang, 'bc.btn_resume'), `bc:rs:${p.id}`), btn(t(lang, 'common.refresh'), `bc:rf:${p.id}`)]);
    kb.push([btn(t(lang, 'bc.btn_cancel'), `bc:x:${p.id}`)]);
  } else if (p.status === 'queued') {
    kb.push([btn(t(lang, 'common.refresh'), `bc:rf:${p.id}`), btn(t(lang, 'bc.btn_cancel'), `bc:x:${p.id}`)]);
  }
  kb.push(back(lang, 'ob'));
  return { text: lines.join('\n'), kb };
}

/* Edits the broadcast's progress card (if it has one). */
export async function refreshPanel(ctx, row, lang = null) {
  if (!row || !Number(row.panel_msg)) return;
  const l = lang || (await ownerLang());
  const v = await progressView(ctx, l, row);
  await edit(ctx, { chat_id: Number(row.panel_chat), message_id: Number(row.panel_msg) }, v.text, v.kb, 'bc-progress');
  await bc.touchProgress(Number(row.id));
}

/* The final report, as a new message so the owner is notified. */
export async function report(ctx, row, lang = null) {
  const l = lang || (await ownerLang());
  const p = bc.progress(row);
  const key = p.status === 'cancelled' ? 'bc.report_cancelled' : 'bc.report_done';
  await send(ctx, OWNER_ID, t(l, key, { id: p.id, sent: p.sent, failed: p.failed, blocked: p.blocked, total: p.total, time: dur(l, p.took) }),
    [back(l, 'ob')], 'bc-report');
}

/* After a batch: the progress card, and the report when it finished; a newly started queued one too. */
export async function afterBatch(ctx, result, lang = null) {
  await refreshPanel(ctx, result.row, lang);
  if (result.finished) {
    await report(ctx, result.row, lang);
    const next = await bc.active();
    if (next) await refreshPanel(ctx, next, lang);
  } else if (result.sourceGone) {
    const l = lang || (await ownerLang());
    await send(ctx, OWNER_ID, t(l, 'bc.paused_source_gone'), [[btn(t(l, 'bc.btn_progress', { id: Number(result.row.id) }), `bc:v:${result.row.id}`)]], 'bc-source-gone');
  }
}

async function showProgress(ctx, lang, place, id) {
  const row = await bc.get(id);
  if (!row) return home(ctx, lang, place);
  const v = await progressView(ctx, lang, row);
  const shown = await screen(ctx, OWNER_ID, place, v.text, v.kb, 'bc-progress');
  if (shown && row.status !== 'done' && row.status !== 'cancelled') await bc.setPanel(id, shown.chat_id, shown.message_id);
  return shown;
}

/* ---------- buttons ---------- */

export async function callback(ctx, lang, parts, place) {
  const [kind, action, a, b] = parts;
  if (kind === 'ob') {
    if (!action) return home(ctx, lang, place);
    if (action === 'n') return audienceScreen(ctx, lang, place);
    if (action === 'a' && AUD[a]) return modeScreen(ctx, lang, place, a);
    if (action === 'm' && AUD[a] && MODE[b]) return askContent(ctx, lang, place, a, b);
    return home(ctx, lang, place);
  }
  const id = toInt(a);
  if (id === null) return home(ctx, lang, place);
  const row = await bc.get(id);
  if (!row) return home(ctx, lang, place);
  switch (action) {
    case 'pv':
      await state.clear(OWNER_ID);
      return preview(ctx, lang, id);
    case 'bt':
      if (row.status !== 'draft' || row.mode !== 'copy') return showProgress(ctx, lang, place, id);
      await state.set(OWNER_ID, 'bc_buttons', { id });
      return screen(ctx, OWNER_ID, place, t(lang, 'bc.buttons_help'), [[btn(t(lang, 'common.cancel'), `bc:pv:${id}`)]], 'bc-buttons');
    case 'rb':
      await bc.setButtons(id, null);
      return preview(ctx, lang, id);
    case 'no':
      await bc.cancel(id, OWNER_ID);
      return screen(ctx, OWNER_ID, place, t(lang, 'bc.discarded'), [back(lang, 'ob')], 'bc-discarded');
    case 'go': {
      const started = await bc.start(id, OWNER_ID);
      if (!started) {
        await answer(ctx, t(lang, 'bc.not_draft'), true);
        return showProgress(ctx, lang, place, id);
      }
      await answer(ctx, t(lang, started === 'queued' ? 'bc.queued_toast' : 'bc.started_toast'));
      const shown = await showProgress(ctx, lang, place, id);
      if (started === 'running' && shown) {
        const r = await bc.runBatch(ctx, id, { limit: BC_BATCH, budgetMs: BC_BUDGET_MS });
        if (r.ran) await afterBatch(ctx, r, lang);
      }
      return shown;
    }
    case 'nx': {
      const r = await bc.runBatch(ctx, id, { limit: BC_BATCH, budgetMs: BC_BUDGET_MS });
      if (!r.ran) {
        const why = r.reason === 'wait' ? t(lang, 'bc.toast_wait', { time: dur(lang, Math.ceil(bc.progress(r.row).waitMs / 1000)) }) : t(lang, `bc.toast_${r.reason}`);
        await answer(ctx, why);
        return showProgress(ctx, lang, place, id);
      }
      await answer(ctx, t(lang, 'bc.toast_batch', { n: r.attempted }));
      await bc.setPanel(id, place.chat_id, place.message_id);
      await afterBatch(ctx, { ...r, row: await bc.get(id) }, lang);
      return place;
    }
    case 'ps':
      await bc.pause(id, OWNER_ID);
      return showProgress(ctx, lang, place, id);
    case 'rs':
      await bc.resume(id, OWNER_ID);
      return showProgress(ctx, lang, place, id);
    case 'x': {
      if (row.status === 'done' || row.status === 'cancelled') return showProgress(ctx, lang, place, id);
      const kb = [[btn(t(lang, 'bc.btn_yes_cancel'), `bc:xy:${id}`), btn(t(lang, 'common.no'), `bc:v:${id}`)]];
      return screen(ctx, OWNER_ID, place, t(lang, 'bc.cancel_q', { id }), kb, 'bc-cancel?');
    }
    case 'xy': {
      if (await bc.cancel(id, OWNER_ID)) {
        const done = await bc.get(id);
        await report(ctx, done, lang);
        const next = await bc.active();
        if (next) await refreshPanel(ctx, next, lang);
      }
      return showProgress(ctx, lang, place, id);
    }
    default:
      return showProgress(ctx, lang, place, id);
  }
}

/* Used by the Mini App endpoint: one batch of the active broadcast. */
export async function liveTick(ctx, lang) {
  const cur = await bc.active();
  if (!cur || cur.status !== 'running') return { row: cur, sent: 0 };
  const r = await bc.runBatch(ctx, Number(cur.id), { limit: BC_BATCH, budgetMs: BC_BUDGET_MS });
  if (r.ran) {
    if (r.finished || r.sourceGone) await afterBatch(ctx, r, lang);
    else if (Date.now() / 1000 - Number(r.row.progress_at) >= BC_PROGRESS_EVERY_SEC) await refreshPanel(ctx, r.row, lang);
    return { row: r.row, sent: r.attempted };
  }
  return { row: r.row || cur, sent: 0 };
}
