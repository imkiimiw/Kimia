// "My packs" in the private chat: pack list, pack screen, sticker browsing (one sticker message
// with buttons, replaced as the user moves), and the conversation steps (user_state) for titles,
// emojis, keywords, replacing, thumbnails, importing, copying, duplicating and merging.
// Every pack id from callback_data is re-checked against the user (packs.mustOwn).
import { btn, urlBtn, markup } from '../core/codec.js';
import { UserError, parseJson } from '../core/util.js';
import { cleanTitle, parseEmojiList, parseKeywords, parseSetRef, parseNumberList, isRegularSticker, addStickersUrl } from '../core/packs.js';
import { inspectWebP, inspectPng } from '../core/inspect.js';
import { classify } from '../core/errors.js';
import { stickerInput } from '../packs/service.js';
import { posts as postDb, ops as opsTable } from '../db/packs.js';
import { TELEGRAM } from '../core/limits.js';
import { T, BOT_USERNAME } from '../config.js';

const MAX = TELEGRAM.set.maxStickersRegular;
const u = (app) => app.user;
const own = (app, id) => app.packs.mustOwn(app.user.tg_id, id);

/* ------------------------------------------------------------------ views */

export async function listView(app, page = 0) {
  const total = await app.packs.count(u(app).tg_id);
  const per = T.pageSize;
  const p = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / per) - 1)));
  const rows = (await app.packs.list(u(app).tg_id, p * per, per)).map((pk) => [btn(app.tp('pk.list_item', { title: pk.title, n: pk.sticker_count }), 'pk', 'open', pk.id)]);
  const nav = [];
  if (p > 0) nav.push(btn(app.tp('common.prev'), 'm', 'packs', p - 1));
  if ((p + 1) * per < total) nav.push(btn(app.tp('common.next'), 'm', 'packs', p + 1));
  rows.push(nav);
  rows.push([btn(app.tp('pk.btn_new'), 'pk', 'new')]);
  if (app.flag('pack_import')) rows.push([btn(app.tp('pk.btn_import'), 'pk', 'imp')]);
  rows.push([btn(app.tp('common.menu'), 'm', 'home')]);
  return { text: total ? app.t('pk.list', { n: total }) : app.t('pk.list_empty'), keyboard: markup(rows) };
}

export async function packView(app, pack) {
  const live = await postDb.liveOf(pack.id);
  const ch = app.publish.channel();
  const rows = [
    [urlBtn(app.tp('pk.btn_open_tg'), addStickersUrl(pack.tg_name)), urlBtn(app.tp('pk.btn_share'), `https://t.me/share/url?url=${encodeURIComponent(addStickersUrl(pack.tg_name))}`)],
    [btn(app.tp('pk.btn_browse'), 'pk', 'it', pack.id, 0)],
    [btn(app.tp('pk.btn_rename'), 'pk', 'ren', pack.id), btn(app.tp('pk.btn_thumb'), 'pk', 'thumb', pack.id)],
    [btn(app.tp('pk.btn_copy'), 'pk', 'copy', pack.id), btn(app.tp('pk.btn_dup'), 'pk', 'dup', pack.id), btn(app.tp('pk.btn_merge'), 'pk', 'merge', pack.id)],
    [btn(app.tp('pk.btn_export'), 'pk', 'exp', pack.id)],
  ];
  let pubLine = '';
  if (live) {
    pubLine = app.t('pk.pub_line', { status: app.tp(`pub.status.${live.status}`) });
    rows.push([btn(app.tp('pub.btn_withdraw'), 'pb', 'back', live.id)]);
  } else if (app.flag('pack_publish') && ch) {
    rows.push([btn(app.tp('pub.btn_publish'), 'pb', 'ask', pack.id)]);
  }
  rows.push([btn(app.tp('pk.btn_delete'), 'pk', 'drop', pack.id)]);
  rows.push([btn(app.tp('pk.btn_back_list'), 'm', 'packs', 0)]);
  return {
    text: app.t('pk.view', { title: pack.title, n: pack.sticker_count, max: MAX, link: addStickersUrl(pack.tg_name), pub: { __html: pubLine } }),
    keyboard: markup(rows),
  };
}

function itemKeyboard(app, pack, it, total) {
  const id = pack.id;
  const f = it.file_unique_id;
  return markup([
    [btn('⬆\ufe0f', 'pk', 'up', id, f), btn(app.tp('pk.pos', { i: it.position + 1, n: total }), 'pk', 'it', id, it.position), btn('⬇\ufe0f', 'pk', 'dn', id, f)],
    [btn(app.tp('pk.btn_emoji'), 'pk', 'emo', id, f), btn(app.tp('pk.btn_keywords'), 'pk', 'kw', id, f)],
    [btn(app.tp('pk.btn_replace'), 'pk', 'rep', id, f), btn(app.tp('pk.btn_del_sticker'), 'pk', 'del', id, f)],
    [btn('◀\ufe0f', 'pk', 'it', id, Math.max(0, it.position - 1)), btn(app.tp('pk.btn_back_pack'), 'pk', 'open', id), btn('▶\ufe0f', 'pk', 'it', id, Math.min(total - 1, it.position + 1))],
  ]);
}

/** Shows sticker #pos of a pack as a sticker message with buttons (the old one is deleted). */
async function showItem(app, pack, pos, cq) {
  const items = await app.packs.items(pack.id);
  if (!items.length) return { toast: app.tp('pk.err.empty') };
  const it = items[Math.max(0, Math.min(pos, items.length - 1))];
  if (cq && cq.message && cq.message.sticker) await app.tg.remove(u(app).tg_id, cq.message.message_id);
  await app.tg.sticker(u(app).tg_id, it.file_id, itemKeyboard(app, pack, it, items.length), 'pack_item');
  const emojis = parseJson(it.emojis, []).join('');
  const kws = parseJson(it.keywords, []).join('، ');
  return { toast: app.tp('pk.item_toast', { i: it.position + 1, n: items.length, emojis, kws: kws || '—' }) };
}

const show = (app, cq, view, name) => app.tg.show(u(app).tg_id, cq && cq.message && !cq.message.sticker ? cq.message.message_id : null, view, name);

/** Destination picker for "add this sticker" / import / copy. */
async function packPicker(app, ns, action, extraArgs = [], exceptId = null, room = 1) {
  const list = (await app.packs.list(u(app).tg_id, 0, 30)).filter((p) => p.id !== exceptId && p.sticker_count + room <= MAX).slice(0, T.pageSize);
  return list.map((p) => [btn(app.tp('pk.list_item', { title: p.title, n: p.sticker_count }), ns, action, ...extraArgs, p.id)]);
}

/* ------------------------------------------------------------------ incoming media */

/** A sticker in the private chat (not inside a conversation step). */
export async function onSticker(app, message) {
  const s = message.sticker;
  const chat = u(app).tg_id;
  if (!isRegularSticker(s)) {
    await app.tg.send(chat, { text: app.t('st.not_regular') }, 'sticker_refused');
    return 'sticker_refused';
  }
  if (!app.flag('packs')) {
    await app.tg.send(chat, { text: app.t('common.feature_off') }, 'feature_off');
    return 'feature_off';
  }
  const si = stickerInput(s);
  await app.state.set(chat, 'st_pick', { si, set: s.set_name || null });
  const rows = await packPicker(app, 'st', 'add');
  rows.push([btn(app.tp('st.btn_new'), 'st', 'new')]);
  const foreign = s.set_name && !String(s.set_name).toLowerCase().endsWith(`_by_${BOT_USERNAME.toLowerCase()}`);
  if (foreign && app.flag('pack_import')) rows.push([btn(app.tp('st.btn_import_set'), 'st', 'imp')]);
  rows.push([btn(app.tp('common.cancel'), 'm', 'home')]);
  await app.tg.send(chat, { text: app.t(foreign ? 'st.pick_foreign' : 'st.pick'), keyboard: markup(rows) }, 'sticker_pick');
  return 'sticker_pick';
}

/** Photos, videos, GIFs, round videos, files: the Studio comes in Phase 2. */
export async function onOtherMedia(app, message) {
  const chat = u(app).tg_id;
  const doc = message.document;
  if (doc && /^image\/(png|webp)$/.test(doc.mime_type || '') && (doc.file_size || 0) <= TELEGRAM.static.maxBytes) {
    await app.tg.send(chat, { text: app.t('media.ready_file_hint') }, 'media_hint');
    return 'media_hint';
  }
  await app.tg.send(chat, { text: app.t(app.flag('studio') ? 'media.open_studio' : 'media.studio_soon') }, 'media_soon');
  return 'media_soon';
}

/* ------------------------------------------------------------------ callbacks */

async function stickerFromState(app) {
  const st = await app.state.get(u(app).tg_id);
  if (!st || st.step !== 'st_pick' || !st.payload.si) throw new UserError('common.expired_step');
  return st.payload;
}

export const routes = {
  'm:packs': { args: ['uint'], run: async (app, [page], cq) => { await show(app, cq, await listView(app, page), 'packs'); } },

  'st:add': {
    args: ['uint'],
    run: async (app, [packId], cq) => {
      const { si } = await stickerFromState(app);
      const pack = await own(app, packId);
      await app.packs.add(u(app), pack, si, 'made');
      await app.state.clear(u(app).tg_id);
      await show(app, cq, { text: app.t('st.added', { title: pack.title, n: pack.sticker_count, link: addStickersUrl(pack.tg_name) }), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)], [btn(app.tp('common.menu'), 'm', 'home')]]) }, 'sticker_added');
      return { toast: app.tp('st.added_toast') };
    },
  },
  'st:new': {
    args: [],
    run: async (app, _a, cq) => {
      const { si } = await stickerFromState(app);
      await app.state.set(u(app).tg_id, 'pk_title', { si });
      await show(app, cq, { text: app.t('pk.ask_title') }, 'ask_title');
    },
  },
  'st:imp': {
    args: [],
    run: async (app, _a, cq) => {
      const { set } = await stickerFromState(app);
      if (!set) throw new UserError('imp.err.no_set');
      await loadImportSource(app, set, cq);
    },
  },

  'pk:new': { args: [], run: async (app, _a, cq) => { await app.state.set(u(app).tg_id, 'pk_first', {}); await show(app, cq, { text: app.t('pk.ask_first') }, 'ask_first'); } },
  'pk:open': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      if (!(await app.packs.sync(pack))) throw new UserError('pk.err.gone_tg');
      if (cq && cq.message && cq.message.sticker) {
        await app.tg.remove(u(app).tg_id, cq.message.message_id);
        await app.tg.send(u(app).tg_id, await packView(app, pack), 'pack');
      } else await show(app, cq, await packView(app, pack), 'pack');
    },
  },
  'pk:it': { args: ['uint', 'uint'], run: async (app, [id, pos], cq) => showItem(app, await own(app, id), pos, cq) },
  'pk:up': { args: ['uint', 'fuid'], run: async (app, [id, f], cq) => moveItem(app, id, f, -1, cq) },
  'pk:dn': { args: ['uint', 'fuid'], run: async (app, [id, f], cq) => moveItem(app, id, f, +1, cq) },
  'pk:emo': { args: ['uint', 'fuid'], run: async (app, [id, f]) => askStep(app, id, f, 'pk_emo', 'pk.ask_emoji') },
  'pk:kw': { args: ['uint', 'fuid'], run: async (app, [id, f]) => askStep(app, id, f, 'pk_kw', 'pk.ask_keywords') },
  'pk:rep': { args: ['uint', 'fuid'], run: async (app, [id, f]) => askStep(app, id, f, 'pk_rep', 'pk.ask_replace') },
  'pk:del': {
    args: ['uint', 'fuid'],
    run: async (app, [id, f]) => {
      const pack = await own(app, id);
      await app.packs.itemOf(pack, f);
      await app.tg.send(u(app).tg_id, { text: app.t('pk.ask_del_sticker'), keyboard: markup([[btn(app.tp('common.yes_delete'), 'pk', 'delok', id, f), btn(app.tp('common.cancel'), 'pk', 'open', id)]]) }, 'ask_delete_sticker');
    },
  },
  'pk:delok': {
    args: ['uint', 'fuid'],
    run: async (app, [id, f], cq) => {
      const pack = await own(app, id);
      await app.packs.remove(u(app), pack, f);
      await show(app, cq, await packView(app, pack), 'pack');
      return { toast: app.tp('pk.deleted_sticker') };
    },
  },
  'pk:ren': { args: ['uint'], run: async (app, [id]) => { await own(app, id); await app.state.set(u(app).tg_id, 'pk_ren', { id }); await app.tg.send(u(app).tg_id, { text: app.t('pk.ask_rename') }, 'ask_rename'); } },
  'pk:thumb': {
    args: ['uint'],
    run: async (app, [id]) => {
      await own(app, id);
      await app.state.set(u(app).tg_id, 'pk_thumb', { id });
      await app.tg.send(u(app).tg_id, { text: app.t('pk.ask_thumb'), keyboard: markup([[btn(app.tp('pk.btn_thumb_reset'), 'pk', 'thrst', id)], [btn(app.tp('common.cancel'), 'pk', 'open', id)]]) }, 'ask_thumb');
    },
  },
  'pk:thrst': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      await app.packs.resetThumbnail(u(app), pack);
      await app.state.clear(u(app).tg_id);
      await show(app, cq, await packView(app, pack), 'pack');
      return { toast: app.tp('pk.thumb_reset') };
    },
  },
  'pk:exp': { args: ['uint'], run: async (app, [id]) => { await app.packs.exportPack(u(app), await own(app, id)); return { toast: app.tp('pk.exported') }; } },
  'pk:drop': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      await show(app, cq, { text: app.t('pk.ask_delete', { title: pack.title }), keyboard: markup([[btn(app.tp('common.yes_delete'), 'pk', 'dropok', id), btn(app.tp('common.cancel'), 'pk', 'open', id)]]) }, 'ask_delete_pack');
    },
  },
  'pk:dropok': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      const live = await postDb.liveOf(pack.id);
      if (live) await app.publish.takeBack(u(app).tg_id, app.role === 'user' ? 'user' : app.role, live.id).catch(() => null);
      await app.packs.deletePack(u(app), pack);
      await show(app, cq, await listView(app, 0), 'packs');
      return { toast: app.tp('pk.deleted_pack') };
    },
  },

  /* ---- import ---- */
  'pk:imp': { args: [], run: async (app, _a, cq) => { await app.state.set(u(app).tg_id, 'imp_link', {}); await show(app, cq, { text: app.t('imp.ask_link') }, 'ask_import'); } },
  'imp:to': {
    args: ['uint'],
    run: async (app, [dst], cq) => {
      const st = await app.state.get(u(app).tg_id);
      if (!st || st.step !== 'imp_src') throw new UserError('common.expired_step');
      if (dst) await own(app, dst);
      await app.state.set(u(app).tg_id, 'imp_src', { ...st.payload, dst });
      await show(app, cq, { text: app.t('imp.ask_which', { n: st.payload.n }), keyboard: markup([[btn(app.tp('imp.btn_all'), 'imp', 'all'), btn(app.tp('imp.btn_pick'), 'imp', 'pick')], [btn(app.tp('common.cancel'), 'm', 'home')]]) }, 'import_which');
    },
  },
  'imp:all': { args: [], run: async (app, _a, cq) => startImport(app, null, cq) },
  'imp:pick': {
    args: [],
    run: async (app, _a, cq) => {
      const st = await app.state.get(u(app).tg_id);
      if (!st || st.step !== 'imp_src') throw new UserError('common.expired_step');
      await app.state.set(u(app).tg_id, 'imp_pick', st.payload);
      await show(app, cq, { text: app.t('imp.ask_numbers', { n: st.payload.n, link: addStickersUrl(st.payload.src) }) }, 'ask_numbers');
    },
  },

  /* ---- copy / duplicate / merge ---- */
  'pk:copy': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      const rows = await packPicker(app, 'cp', 'to', [id], id);
      if (!rows.length) throw new UserError('cp.err.no_target');
      rows.push([btn(app.tp('common.cancel'), 'pk', 'open', id)]);
      await show(app, cq, { text: app.t('cp.ask_target', { title: pack.title }), keyboard: markup(rows) }, 'copy_target');
    },
  },
  'cp:to': {
    args: ['uint', 'uint'],
    run: async (app, [src, dst], cq) => {
      await own(app, src);
      await own(app, dst);
      await app.state.set(u(app).tg_id, 'cp_sel', { src, dst });
      await show(app, cq, { text: app.t('cp.ask_which'), keyboard: markup([[btn(app.tp('imp.btn_all'), 'cp', 'all'), btn(app.tp('imp.btn_pick'), 'cp', 'pick')], [btn(app.tp('common.cancel'), 'pk', 'open', src)]]) }, 'copy_which');
    },
  },
  'cp:all': { args: [], run: async (app, _a, cq) => startCopy(app, null, cq) },
  'cp:pick': {
    args: [],
    run: async (app, _a, cq) => {
      const st = await app.state.get(u(app).tg_id);
      if (!st || st.step !== 'cp_sel') throw new UserError('common.expired_step');
      const src = await own(app, st.payload.src);
      await app.state.set(u(app).tg_id, 'cp_pick', st.payload);
      await show(app, cq, { text: app.t('imp.ask_numbers', { n: src.sticker_count, link: addStickersUrl(src.tg_name) }) }, 'ask_numbers');
    },
  },
  'pk:dup': { args: ['uint'], run: async (app, [id]) => { await own(app, id); await app.state.set(u(app).tg_id, 'dup_title', { id }); await app.tg.send(u(app).tg_id, { text: app.t('dup.ask_title') }, 'ask_dup'); } },
  'pk:merge': {
    args: ['uint'],
    run: async (app, [dst], cq) => {
      const pack = await own(app, dst);
      const rows = (await app.packs.list(u(app).tg_id, 0, 30)).filter((p) => p.id !== dst).slice(0, T.pageSize).map((p) => [btn(app.tp('pk.list_item', { title: p.title, n: p.sticker_count }), 'mg', 'from', dst, p.id)]);
      if (!rows.length) throw new UserError('cp.err.no_target');
      rows.push([btn(app.tp('common.cancel'), 'pk', 'open', dst)]);
      await show(app, cq, { text: app.t('mg.ask_source', { title: pack.title }), keyboard: markup(rows) }, 'merge_source');
    },
  },
  'mg:from': {
    args: ['uint', 'uint'],
    run: async (app, [dst, src], cq) => {
      const a = await own(app, dst);
      const b = await own(app, src);
      await show(app, cq, { text: app.t('mg.ask_confirm', { into: a.title, from: b.title, n: b.sticker_count }), keyboard: markup([[btn(app.tp('mg.btn_delete_src'), 'mg', 'go', dst, src, 1)], [btn(app.tp('mg.btn_keep_src'), 'mg', 'go', dst, src, 0)], [btn(app.tp('common.cancel'), 'pk', 'open', dst)]]) }, 'merge_confirm');
    },
  },
  'mg:go': {
    args: ['uint', 'uint', 'uint'],
    run: async (app, [dst, src, del], cq) => {
      await own(app, dst);
      const b = await own(app, src);
      await app.packs.sync(b);
      const items = (await app.packs.items(b.id)).map(itemToInput);
      await runOp(app, cq, { kind: 'merge', src: b.tg_name, dstPackId: dst, items, deleteSrc: del === 1 });
    },
  },

  /* ---- bulk op progress ---- */
  'op:go': {
    args: ['uint'],
    run: async (app, [opId], cq) => {
      const op = await app.ops.get(opId);
      if (!op || op.tg_id !== u(app).tg_id) throw new UserError('op.err.gone');
      const r = await app.ops.step({ deadlineMs: app.clock.ms() + T.buttonBudgetMs, id: opId, user: u(app) });
      await notifyOp(app, r ? r.op : op, r ? r.stopped : 'locked', cq);
    },
  },
  'op:stop': {
    args: ['uint'],
    run: async (app, [opId], cq) => {
      const op = await app.ops.get(opId);
      if (!op || op.tg_id !== u(app).tg_id) throw new UserError('op.err.gone');
      await app.ops.cancel(u(app).tg_id);
      await show(app, cq, { text: app.t('op.cancelled', { done: op.done, total: op.total }), keyboard: markup([[btn(app.tp('menu.packs'), 'm', 'packs', 0)]]) }, 'op_cancelled');
    },
  },
};

const itemToInput = (i) => ({ file_id: i.file_id, file_unique_id: i.file_unique_id, format: i.format, emojis: parseJson(i.emojis, []) });

async function moveItem(app, id, fuid, dir, cq) {
  const pack = await own(app, id);
  await app.packs.move(u(app), pack, fuid, dir);
  const it = await app.packs.itemOf(pack, fuid);
  return showItem(app, pack, it.position, cq);
}

async function askStep(app, id, fuid, step, key) {
  const pack = await own(app, id);
  await app.packs.itemOf(pack, fuid);
  await app.state.set(u(app).tg_id, step, { id, fuid });
  await app.tg.send(u(app).tg_id, { text: app.t(key) }, step);
}

async function loadImportSource(app, name, cq) {
  let set;
  try {
    set = await app.tg.call('getStickerSet', { name }, 'import_source');
  } catch (e) {
    if (['set_invalid', 'bad_request'].includes(classify(e).kind)) throw new UserError('imp.err.not_found');
    throw e;
  }
  if (set.sticker_type && set.sticker_type !== 'regular') throw new UserError('imp.err.type');
  const n = (set.stickers || []).filter(isRegularSticker).length;
  if (!n) throw new UserError('imp.err.not_found');
  await app.state.set(u(app).tg_id, 'imp_src', { src: set.name, n, title: set.title, dst: 0 });
  const rows = [[btn(app.tp('imp.btn_new_pack'), 'imp', 'to', 0)], ...(await packPicker(app, 'imp', 'to'))];
  rows.push([btn(app.tp('common.cancel'), 'm', 'home')]);
  await show(app, cq, { text: app.t('imp.found', { title: set.title, n }), keyboard: markup(rows) }, 'import_found');
}

async function startImport(app, picks, cq) {
  const st = await app.state.get(u(app).tg_id);
  if (!st || !['imp_src', 'imp_pick'].includes(st.step)) throw new UserError('common.expired_step');
  const { src, title, dst } = st.payload;
  const set = await app.tg.call('getStickerSet', { name: src }, 'import_source');
  let list = (set.stickers || []).filter(isRegularSticker).map((s) => stickerInput(s));
  if (picks) list = picks.map((i) => list[i]).filter(Boolean);
  await app.state.clear(u(app).tg_id);
  await runOp(app, cq, { kind: 'import', src, dstPackId: dst || null, title: cleanTitle(title) || 'Wanger', items: list });
}

async function startCopy(app, picks, cq) {
  const st = await app.state.get(u(app).tg_id);
  if (!st || !['cp_sel', 'cp_pick'].includes(st.step)) throw new UserError('common.expired_step');
  const src = await own(app, st.payload.src);
  await own(app, st.payload.dst);
  await app.packs.sync(src);
  let list = (await app.packs.items(src.id)).map(itemToInput);
  if (picks) list = picks.map((i) => list[i]).filter(Boolean);
  await app.state.clear(u(app).tg_id);
  await runOp(app, cq, { kind: 'copy', src: src.tg_name, dstPackId: st.payload.dst, items: list });
}

/** Starts a bulk op and runs its first slice right away (button budget). */
async function runOp(app, cq, o) {
  const op = await app.ops.start(u(app), o);
  const m = await app.tg.send(u(app).tg_id, { text: app.t('op.started', { total: op.total }) }, 'op_progress');
  if (m && m.message_id) await opsTable.setProgress(op.id, u(app).tg_id, m.message_id);
  const r = await app.ops.step({ deadlineMs: app.clock.ms() + T.buttonBudgetMs, id: op.id, user: u(app) });
  await notifyOp(app, r ? r.op : await app.ops.get(op.id), r ? r.stopped : 'locked');
  return { toast: app.tp('op.started_toast') };
}

/** Edits the op's progress message (also called from the piggyback tick). */
export async function notifyOp(app, op, stopped, cq) {
  if (!op) return;
  const chat = op.progress_chat_id || op.tg_id;
  const msg = op.progress_message_id || (cq && cq.message && cq.message.message_id) || null;
  let view;
  if (op.status === 'done') {
    const pack = op.dst_pack_id ? await app.packs.mustOwn(op.tg_id, op.dst_pack_id).catch(() => null) : null;
    view = { text: app.t('op.done', { done: op.done, failed: op.failed, title: pack ? pack.title : '', link: pack ? addStickersUrl(pack.tg_name) : '' }), keyboard: pack ? markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) : undefined };
  } else if (op.status === 'failed' || stopped === 'err.set_full') {
    view = { text: app.t('op.failed', { done: op.done, total: op.total, reason: app.tp(stopped === 'err.set_full' ? 'err.set_full' : 'op.reason_gone') }) };
  } else if (op.status === 'cancelled') {
    view = { text: app.t('op.cancelled', { done: op.done, total: op.total }) };
  } else {
    const why = stopped === 'err.quota' ? app.tp('err.quota_short') : stopped === 'err.flood' ? app.tp('err.flood_short') : '';
    view = {
      text: app.t('op.progress', { done: op.cursor, total: op.total, why }),
      keyboard: markup([[btn(app.tp('op.btn_continue'), 'op', 'go', op.id), btn(app.tp('op.btn_stop'), 'op', 'stop', op.id)]]),
    };
  }
  try {
    await app.tg.show(chat, msg, view, 'op_progress');
  } catch (e) {
    app.log.warn('op_notify_failed', { user_id: op.tg_id, error: String(e && e.description).slice(0, 120) });
  }
}

/* ------------------------------------------------------------------ conversation steps */

/** @returns {Promise<string|null>} handled step name, or null if this step is not ours */
export async function onStep(app, step, payload, message) {
  const chat = u(app).tg_id;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const sticker = message.sticker;
  switch (step) {
    case 'pk_first': {
      if (!sticker) throw new UserError('pk.err.need_sticker');
      if (!isRegularSticker(sticker)) throw new UserError('st.not_regular');
      await app.state.set(chat, 'pk_title', { si: stickerInput(sticker) });
      await app.tg.send(chat, { text: app.t('pk.ask_title') }, 'ask_title');
      return step;
    }
    case 'pk_title': {
      const title = cleanTitle(text);
      if (!title) throw new UserError('pk.err.title', { max: TELEGRAM.set.titleMaxChars });
      const pack = await app.packs.create(u(app), title, payload.si, 'made');
      await app.state.clear(chat);
      await app.tg.send(chat, { text: app.t('pk.created', { title: pack.title, link: addStickersUrl(pack.tg_name) }), keyboard: markup([[urlBtn(app.tp('pk.btn_open_tg'), addStickersUrl(pack.tg_name))], [btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'pack_created');
      return step;
    }
    case 'pk_ren': {
      const title = cleanTitle(text);
      if (!title) throw new UserError('pk.err.title', { max: TELEGRAM.set.titleMaxChars });
      const pack = await own(app, payload.id);
      await app.packs.rename(u(app), pack, title);
      await app.state.clear(chat);
      pack.title = title;
      await app.tg.send(chat, await packView(app, pack), 'pack');
      return step;
    }
    case 'pk_emo': {
      const list = parseEmojiList(text);
      if (!list) throw new UserError('pk.err.emoji', { max: TELEGRAM.set.emojiPerStickerMax });
      const pack = await own(app, payload.id);
      await app.packs.setEmojis(u(app), pack, payload.fuid, list);
      await app.state.clear(chat);
      await app.tg.send(chat, { text: app.t('pk.emoji_set', { emojis: list.join('') }), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'emoji_set');
      return step;
    }
    case 'pk_kw': {
      const list = parseKeywords(text);
      if (!list) throw new UserError('pk.err.keywords', { max: TELEGRAM.set.keywordsMax, chars: TELEGRAM.set.keywordsTotalChars });
      const pack = await own(app, payload.id);
      await app.packs.setKeywords(u(app), pack, payload.fuid, list);
      await app.state.clear(chat);
      await app.tg.send(chat, { text: app.t(list.length ? 'pk.keywords_set' : 'pk.keywords_cleared', { kws: list.join('، ') }), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'keywords_set');
      return step;
    }
    case 'pk_rep': {
      if (!sticker) throw new UserError('pk.err.need_sticker');
      if (!isRegularSticker(sticker)) throw new UserError('st.not_regular');
      const pack = await own(app, payload.id);
      await app.packs.replace(u(app), pack, payload.fuid, stickerInput(sticker));
      await app.state.clear(chat);
      await app.tg.send(chat, { text: app.t('pk.replaced'), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'replaced');
      return step;
    }
    case 'pk_thumb': {
      const pack = await own(app, payload.id);
      const fileId = await thumbFile(app, message);
      await app.packs.setThumbnail(u(app), pack, fileId, 'static');
      await app.state.clear(chat);
      await app.tg.send(chat, { text: app.t('pk.thumb_set'), keyboard: markup([[btn(app.tp('pk.btn_back_pack'), 'pk', 'open', pack.id)]]) }, 'thumb_set');
      return step;
    }
    case 'imp_link': {
      const name = sticker && sticker.set_name ? sticker.set_name : parseSetRef(text);
      if (!name) throw new UserError('imp.err.link');
      await loadImportSource(app, name, null);
      return step;
    }
    case 'imp_pick': {
      const picks = parseNumberList(text, payload.n);
      if (!picks || !picks.length) throw new UserError('imp.err.numbers', { n: payload.n });
      await app.state.set(chat, 'imp_pick', payload);
      await startImport(app, picks, null);
      return step;
    }
    case 'cp_pick': {
      const src = await own(app, payload.src);
      const picks = parseNumberList(text, src.sticker_count);
      if (!picks || !picks.length) throw new UserError('imp.err.numbers', { n: src.sticker_count });
      await startCopy(app, picks, null);
      return step;
    }
    case 'dup_title': {
      const title = cleanTitle(text);
      if (!title) throw new UserError('pk.err.title', { max: TELEGRAM.set.titleMaxChars });
      const src = await own(app, payload.id);
      await app.packs.sync(src);
      const items = (await app.packs.items(src.id)).map(itemToInput);
      await app.state.clear(chat);
      await runOp(app, null, { kind: 'duplicate', src: src.tg_name, dstPackId: null, title, items });
      return step;
    }
    default:
      return null;
  }
}

/** A 100×100 static thumbnail: a PNG/WEBP file ≤ 128 KB (checked by reading it) or a 100×100 static sticker. */
async function thumbFile(app, message) {
  const th = TELEGRAM.thumbnail;
  const s = message.sticker;
  if (s) {
    if (s.is_animated || s.is_video || s.width !== th.width || s.height !== th.height) throw new UserError('pk.err.thumb_size', { w: th.width, h: th.height });
    return s.file_id;
  }
  const d = message.document;
  if (!d || !/^image\/(png|webp)$/.test(d.mime_type || '')) throw new UserError('pk.err.thumb_type');
  if ((d.file_size || 0) > th.staticMaxBytes) throw new UserError('pk.err.thumb_big', { kb: th.staticMaxBytes / 1024 });
  const bytes = await app.tg.fileContent(d.file_id);
  const info = d.mime_type === 'image/png' ? inspectPng(bytes) : inspectWebP(bytes);
  if (info.error || info.width !== th.width || info.height !== th.height) throw new UserError('pk.err.thumb_size', { w: th.width, h: th.height });
  return d.file_id;
}

export const PACK_STEPS = Object.freeze(['pk_first', 'pk_title', 'pk_ren', 'pk_emo', 'pk_kw', 'pk_rep', 'pk_thumb', 'imp_link', 'imp_pick', 'cp_pick', 'dup_title']);
