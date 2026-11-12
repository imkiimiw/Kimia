// WhatsApp packs in the private chat (Phase 3): list, pack screen with its rule check, the ZIP
// export, a preview (the stored files as document albums, by file_id — nothing is uploaded again),
// removing stickers by number, emojis by number, rename, delete. Stickers are made and added in the
// Studio (?mode=wa&wpack=<id>). Every pack id from callback_data is re-checked (whatsapp.own).
import { btn, markup } from '../core/codec.js';
import { UserError, parseJson } from '../core/util.js';
import { parseNumberList, cleanWaText, parseWaEmojis } from '../core/packs.js';
import { WHATSAPP } from '../core/limits.js';
import { T, APP_URL } from '../config.js';

const P = WHATSAPP.pack;
const u = (app) => app.user;
const own = (app, id) => app.whatsapp.own(u(app).tg_id, id);
const show = (app, cq, view, name) => app.tg.show(u(app).tg_id, cq && cq.message ? cq.message.message_id : null, view, name);
const studio = (app, key, pack) => [{ text: app.tp(key), web_app: { url: `${APP_URL}?mode=wa${pack ? `&wpack=${pack.id}` : ''}` } }];
const ALBUM = 10; // sendMediaGroup takes 2–10 items

export async function waListView(app, page = 0) {
  const total = await app.whatsapp.count(u(app).tg_id);
  const per = T.pageSize;
  const p = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / per) - 1)));
  const rows = (await app.whatsapp.list(u(app).tg_id, p * per, per)).map((pk) => [btn(app.tp('wa.list_item', { title: pk.title, n: pk.sticker_count, kind: app.tp(`wa.kind_icon.${pk.kind}`) }), 'w', 'open', pk.id)]);
  const nav = [];
  if (p > 0) nav.push(btn(app.tp('common.prev'), 'w', 'list', p - 1));
  if ((p + 1) * per < total) nav.push(btn(app.tp('common.next'), 'w', 'list', p + 1));
  rows.push(nav);
  rows.push(studio(app, 'wa.btn_new', null));
  rows.push([btn(app.tp('pk.btn_back_list'), 'm', 'packs', 0)]);
  return { text: total ? app.t('wa.list', { n: total }) : app.t('wa.list_empty'), keyboard: markup(rows) };
}

export async function waPackView(app, pack) {
  const v = await app.whatsapp.check(pack);
  const status = v.length
    ? app.t('wa.status_missing', { why: v.map((x) => app.tp(`wa.rule.${x}`, { min: P.minStickers, max: P.maxStickers })).join('، ') })
    : app.t('wa.status_ready');
  const rows = [];
  if (!v.length) rows.push([btn(app.tp('wa.btn_zip'), 'w', 'zip', pack.id)]);
  if (pack.sticker_count < P.maxStickers) rows.push(studio(app, 'wa.btn_add', pack));
  if (pack.sticker_count) rows.push([btn(app.tp('wa.btn_preview'), 'w', 'prev', pack.id)]);
  if (pack.sticker_count) rows.push([btn(app.tp('wa.btn_emoji'), 'w', 'emo', pack.id), btn(app.tp('wa.btn_remove'), 'w', 'rm', pack.id)]);
  rows.push([btn(app.tp('wa.btn_rename'), 'w', 'ren', pack.id), btn(app.tp('pk.btn_delete'), 'w', 'drop', pack.id)]);
  rows.push([btn(app.tp('wa.btn_back_list'), 'w', 'list', 0)]);
  return {
    text: app.t('wa.view', { title: pack.title, publisher: pack.publisher || '—', kind: app.tp(`wa.kind.${pack.kind}`), n: pack.sticker_count, max: P.maxStickers, status: { __html: status } }),
    keyboard: markup(rows),
  };
}

/** Numbered lines "1. 😀😃" for the steps that ask for sticker numbers. */
async function numberedList(app, pack) {
  const items = await app.whatsapp.items(pack.id);
  return { items, text: items.map((it, i) => `${i + 1}. ${parseJson(it.emojis, []).join('')}`).join('\n') };
}

export const routes = {
  'w:list': { args: ['uint'], run: async (app, [page], cq) => { await show(app, cq, await waListView(app, page), 'wa_list'); } },
  'w:open': { args: ['uint'], run: async (app, [id], cq) => { await show(app, cq, await waPackView(app, await own(app, id)), 'wa_pack'); } },
  'w:zip': {
    args: ['uint'],
    run: async (app, [id]) => {
      const pack = await own(app, id);
      const r = await app.whatsapp.exportZip(u(app), pack);
      await app.tg.send(u(app).tg_id, { text: app.t('wa.zip_help') }, 'wa_zip_help');
      return { toast: app.tp('wa.zip_sent', { n: r.count }) };
    },
  },
  'w:prev': {
    args: ['uint'],
    run: async (app, [id]) => {
      const pack = await own(app, id);
      const items = await app.whatsapp.items(pack.id);
      for (let i = 0; i < items.length; i += ALBUM) {
        const part = items.slice(i, i + ALBUM);
        const media = part.map((it, j) => ({ type: 'document', media: it.file_id, caption: `${i + j + 1}. ${parseJson(it.emojis, []).join('')}` }));
        if (media.length === 1) await app.tg.call('sendDocument', { chat_id: u(app).tg_id, document: media[0].media, caption: media[0].caption }, 'wa_preview');
        else await app.tg.call('sendMediaGroup', { chat_id: u(app).tg_id, media }, 'wa_preview');
      }
      return { toast: app.tp('wa.preview_sent') };
    },
  },
  'w:rm': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      const { text } = await numberedList(app, pack);
      await app.state.set(u(app).tg_id, 'w_rm', { id: pack.id });
      await show(app, cq, { text: app.t('wa.ask_remove', { list: text }) }, 'wa_ask_remove');
    },
  },
  'w:emo': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      const { text } = await numberedList(app, pack);
      await app.state.set(u(app).tg_id, 'w_emo', { id: pack.id });
      await show(app, cq, { text: app.t('wa.ask_emoji', { list: text, max: P.emojiPerStickerMax }) }, 'wa_ask_emoji');
    },
  },
  'w:ren': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      await app.state.set(u(app).tg_id, 'w_ren', { id: pack.id });
      await show(app, cq, { text: app.t('wa.ask_rename', { title: pack.title, publisher: pack.publisher || '' }) }, 'wa_ask_rename');
    },
  },
  'w:drop': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      await show(app, cq, { text: app.t('wa.ask_delete', { title: pack.title }), keyboard: markup([[btn(app.tp('wa.btn_delete_yes'), 'w', 'dropok', pack.id), btn(app.tp('common.cancel'), 'w', 'open', pack.id)]]) }, 'wa_ask_delete');
    },
  },
  'w:dropok': {
    args: ['uint'],
    run: async (app, [id], cq) => {
      const pack = await own(app, id);
      await app.whatsapp.deletePack(u(app), pack);
      await show(app, cq, await waListView(app, 0), 'wa_list');
      return { toast: app.tp('wa.deleted') };
    },
  },
};

/** Conversation steps of this module. */
export async function onWaStep(app, step, payload, message) {
  if (!WA_STEPS.includes(step)) return null;
  const chat = u(app).tg_id;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const pack = await own(app, payload.id);
  if (step === 'w_rm') {
    const { items } = await numberedList(app, pack);
    const picks = parseNumberList(text, items.length);
    if (!picks || !picks.length) throw new UserError('wa.err.numbers', { n: items.length });
    for (const i of picks) await app.whatsapp.remove(u(app), pack, items[i].id);
  } else if (step === 'w_emo') {
    const m = /^\s*([0-9۰-۹]{1,2})\s+(.+)$/s.exec(text);
    const { items } = await numberedList(app, pack);
    const n = m ? Number(m[1].replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))) : 0;
    if (!m || n < 1 || n > items.length) throw new UserError('wa.err.emoji_format', { n: items.length, max: P.emojiPerStickerMax });
    if (!parseWaEmojis(m[2])) throw new UserError('wa.err.emojis', { max: P.emojiPerStickerMax });
    await app.whatsapp.setEmojis(u(app), pack, items[n - 1].id, m[2]);
  } else if (step === 'w_ren') {
    const [a, ...rest] = text.split('\n');
    const title = cleanWaText(a);
    const publisher = cleanWaText(rest.join(' ') || pack.publisher, P.publisherMaxChars);
    if (!title || !publisher) throw new UserError('wa.err.meta', { max: P.nameMaxChars });
    await app.whatsapp.rename(u(app), pack, title, publisher);
  }
  await app.state.clear(chat);
  await app.tg.send(chat, await waPackView(app, await own(app, pack.id)), 'wa_pack');
  return step;
}

export const WA_STEPS = Object.freeze(['w_rm', 'w_emo', 'w_ren']);
