// Owner panel → forced-join channels (brief §6): list with health, add (@username, id, link or a
// forwarded post), remove (confirm), up/down, enable/disable one, the whole gate on/off, invite
// link, health re-check, and a preview of the gate exactly as users see it.
import { btn, markup } from '../core/codec.js';
import { esc, code } from '../core/html.js';
import { UserError } from '../core/util.js';
import { joinUrl } from '../core/gate.js';
import { assertOwner } from './panel.js';
import { MAX_GATE_CHANNELS } from '../config.js';

const show = (app, cq, view, name) => app.tg.show(app.user.tg_id, cq && cq.message ? cq.message.message_id : null, view, name);
const HEALTH = { ok: '✅', bot_not_admin: '⚠\ufe0f', not_found: '❌', error: '❔' };

async function listView(app) {
  const rows = await app.gate.list();
  const on = app.settings.get('gate.enabled');
  const lines = rows.map((ch, i) => `${i + 1}. ${HEALTH[ch.health] || '❔'} ${ch.enabled ? '' : '⏸ '}<b>${esc(ch.title || ch.username || ch.chat_id)}</b> ${ch.username ? '@' + esc(ch.username) : code(ch.chat_id)}`).join('\n') || app.t('gm.empty');
  const kb = rows.map((ch) => [btn(`${HEALTH[ch.health] || ''} ${ch.title || ch.username || ch.chat_id}`.trim(), 'a', 'chv', ch.id)]);
  if (rows.length < MAX_GATE_CHANNELS) kb.push([btn(app.tp('gm.btn_add'), 'a', 'chadd')]);
  kb.push([btn(app.tp(on ? 'gm.btn_gate_off' : 'gm.btn_gate_on'), 'a', 'gtog'), btn(app.tp('gm.btn_preview'), 'a', 'gprev')]);
  kb.push([btn(app.tp('gm.btn_health'), 'a', 'chhl'), btn(app.tp('common.back'), 'a', 'home')]);
  return { text: app.t('gm.list', { state: app.tp(on ? 'common.on' : 'common.off'), n: rows.length, max: MAX_GATE_CHANNELS, lines: { __html: lines } }), keyboard: markup(kb) };
}

async function channelView(app, id) {
  const ch = (await app.gate.list()).find((r) => r.id === id);
  if (!ch) throw new UserError('gm.err.gone');
  return {
    text: app.t('gm.channel', {
      title: ch.title || '—', username: ch.username ? '@' + ch.username : '—', id: { __html: code(ch.chat_id) },
      health: app.tp(`gm.health.${ch.health}`), enabled: app.tp(ch.enabled ? 'common.on' : 'common.off'), link: ch.invite_link || joinUrl(ch) || '—',
    }),
    keyboard: markup([
      [btn('⬆\ufe0f', 'a', 'chup', id), btn('⬇\ufe0f', 'a', 'chdn', id), btn(app.tp(ch.enabled ? 'gm.btn_disable' : 'gm.btn_enable'), 'a', 'chtog', id)],
      [btn(app.tp('gm.btn_link'), 'a', 'chlnk', id), ch.invite_link ? btn(app.tp('gm.btn_unlink'), 'a', 'chnol', id) : null],
      [btn(app.tp('gm.btn_remove'), 'a', 'chdel', id)],
      [btn(app.tp('common.back'), 'a', 'ch')],
    ]),
  };
}

const owner = (fn) => async (app, args, cq) => {
  assertOwner(app);
  return fn(app, args, cq);
};

export const routes = {
  'a:ch': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => show(app, cq, await listView(app), 'admin_channels')) },
  'a:chv': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => show(app, cq, await channelView(app, id), 'admin_channel')) },
  'a:chadd': { args: [], perm: 'admin', run: owner(async (app) => { await app.state.set(app.user.tg_id, 'a_chadd', {}); await app.tg.send(app.user.tg_id, { text: app.t('gm.ask_add') }, 'ask_channel'); }) },
  'a:chdel': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [id], cq) => {
      const ch = (await app.gate.list()).find((r) => r.id === id);
      if (!ch) throw new UserError('gm.err.gone');
      await show(app, cq, { text: app.t('gm.ask_remove', { title: ch.title || ch.username || '' }), keyboard: markup([[btn(app.tp('common.yes_delete'), 'a', 'chdok', id), btn(app.tp('common.cancel'), 'a', 'chv', id)]]) }, 'admin_channel_remove');
    }),
  },
  'a:chdok': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.gate.remove(app.user.tg_id, id); await show(app, cq, await listView(app), 'admin_channels'); return { toast: app.tp('gm.removed') }; }) },
  'a:chup': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.gate.move(app.user.tg_id, id, -1); await show(app, cq, await channelView(app, id), 'admin_channel'); }) },
  'a:chdn': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.gate.move(app.user.tg_id, id, +1); await show(app, cq, await channelView(app, id), 'admin_channel'); }) },
  'a:chtog': {
    args: ['uint'], perm: 'admin',
    run: owner(async (app, [id], cq) => {
      const ch = (await app.gate.list()).find((r) => r.id === id);
      if (!ch) throw new UserError('gm.err.gone');
      await app.gate.setEnabled(app.user.tg_id, id, !ch.enabled);
      await show(app, cq, await channelView(app, id), 'admin_channel');
    }),
  },
  'a:chlnk': { args: ['uint'], perm: 'admin', run: owner(async (app, [id]) => { await app.state.set(app.user.tg_id, 'a_chlink', { id }); await app.tg.send(app.user.tg_id, { text: app.t('gm.ask_link') }, 'ask_link'); }) },
  'a:chnol': { args: ['uint'], perm: 'admin', run: owner(async (app, [id], cq) => { await app.gate.setInviteLink(app.user.tg_id, id, null); await show(app, cq, await channelView(app, id), 'admin_channel'); }) },
  'a:gtog': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => { await app.gate.setGateEnabled(app.user.tg_id, !app.settings.get('gate.enabled')); await show(app, cq, await listView(app), 'admin_channels'); }) },
  'a:gprev': {
    args: [], perm: 'admin',
    run: owner(async (app) => {
      const enabled = (await app.gate.list()).filter((c) => c.enabled);
      await app.tg.send(app.user.tg_id, app.gate.view(app.lang, enabled), 'gate_preview');
      return { toast: app.tp('gm.preview_sent') };
    }),
  },
  'a:chhl': { args: [], perm: 'admin', run: owner(async (app, _a, cq) => { await app.gate.checkHealth(app.user.tg_id); await show(app, cq, await listView(app), 'admin_channels'); return { toast: app.tp('gm.health_done') }; }) },
};

/** @returns {Promise<string|null>} */
export async function onChannelStep(app, step, payload, message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (step === 'a_chadd') {
    assertOwner(app);
    const row = await app.gate.add(app.user.tg_id, text, message);
    await app.state.clear(app.user.tg_id);
    await app.tg.send(app.user.tg_id, { text: app.t('gm.added', { title: row.title || row.username || '' }), keyboard: markup([[btn(app.tp('adm.channels'), 'a', 'ch')]]) }, 'channel_added');
    return step;
  }
  if (step === 'a_chlink') {
    assertOwner(app);
    await app.gate.setInviteLink(app.user.tg_id, payload.id, text);
    await app.state.clear(app.user.tg_id);
    await app.tg.send(app.user.tg_id, await channelView(app, payload.id), 'admin_channel');
    return step;
  }
  return null;
}
