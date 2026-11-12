// WhatsApp packs (brief §10, Phase 3). The Studio makes every sticker on the device; the server
// re-validates it, stores the FILE in the storage channel (documents; only file_ids are kept in
// SQLite, brief §4) and keeps the pack in `packs` with platform = 'whatsapp'. Export downloads the
// files again, writes a stored-only ZIP (stickers + tray + README) and sends it to the user's chat;
// a .wastickers package is added only while flags.wastickers is on (brief: verify the importers'
// format first).
//
// Storage: settings `storage.chat_id` (a private channel where the bot is admin). Until the owner
// sets one, files are kept as silent documents in the user's own chat with the bot — the pack still
// works, and the owner is told once a day to set the channel.
import { wa as wdb, packs as pdb } from '../db/packs.js';
import { users } from '../db/users.js';
import { UserError } from '../core/util.js';
import { classify } from '../core/errors.js';
import { makeZip } from '../core/zip.js';
import { validateWhatsAppPack } from '../core/validate.js';
import { makeWaIdentifier, waFileName, waZipName, parseWaEmojis } from '../core/packs.js';
import { WHATSAPP } from '../core/limits.js';
import { t, tp } from '../i18n/index.js';

const P = WHATSAPP.pack;
const KIND_FORMAT = { static: 'wa_static', animated: 'wa_animated' };
const DOWNLOAD_PARALLEL = 6;

/** @param {any} app @param {any} packs the Telegram pack service (quotas) */
export function createWhatsApp(app, packs) {
  const { clock, tg } = app;

  /** Stores one file; returns its document's file_id/file_unique_id. */
  async function store(user, bytes, name, type) {
    const chat = Number(app.settings.get('storage.chat_id')) || 0;
    const extra = { disable_content_type_detection: true, disable_notification: true };
    if (chat) {
      try {
        const m = await tg.sendDocument(chat, bytes, name, { type, caption: `#u${user.tg_id}`, extra }, 'wa_store');
        return { file_id: m.document.file_id, file_unique_id: m.document.file_unique_id };
      } catch (e) {
        const k = classify(e).kind;
        if (k === 'transient' || k === 'rate_limit') throw e;
        await app.alerts.owner('storage:broken', (lang) => t(lang, 'alert.storage_broken', { reason: String(e.description || e.message || k).slice(0, 120) }), 3600);
      }
    } else {
      await app.alerts.owner('storage:unset', (lang) => t(lang, 'alert.storage_unset'), 86400);
    }
    const m = await tg.sendDocument(user.tg_id, bytes, name, { type, caption: app.tp('wa.stored_here'), extra }, 'wa_store_user');
    return { file_id: m.document.file_id, file_unique_id: m.document.file_unique_id };
  }

  async function own(userId, packId) {
    const p = await wdb.getOwned(Number(packId), userId);
    if (!p) throw new UserError('wa.err.gone');
    return p;
  }

  const items = (packId) => pdb.items(packId);

  return {
    own,
    items,
    list: (userId, offset, n) => wdb.list(userId, offset, n),
    count: (userId) => wdb.count(userId),

    /** @param {any} user @param {{title: string, publisher: string, kind: 'static'|'animated'}} o */
    async create(user, o) {
      if (o.kind !== 'static' && o.kind !== 'animated') throw new UserError('studio.err.bad_input');
      await packs.checkQuota(user.tg_id, 'pack_create');
      const max = Number(app.settings.get('limits.packs_per_user'));
      if ((await wdb.count(user.tg_id)) >= max) throw new UserError('pk.err.too_many', { max });
      const n = await users.nextPackNumber(user.tg_id);
      const pack = await wdb.create({ tg_id: user.tg_id, title: o.title, publisher: o.publisher, kind: o.kind, wa_identifier: makeWaIdentifier(user.tg_id, n) }, clock.now());
      await packs.countUsage(user.tg_id, 'pack_create');
      app.stats.count('pack.wa_created');
      return pack;
    },

    /**
     * Adds one validated sticker (the caller ran the WhatsApp validator). The pack's kind decides
     * which files fit: static and animated never mix (WhatsApp rule).
     */
    async add(user, pack, bytes, kind, emojis) {
      if (pack.kind !== kind) throw new UserError('wa.err.mixed', { kind: app.tp(`wa.kind.${pack.kind}`) });
      if (pack.sticker_count >= P.maxStickers) throw new UserError('wa.err.full', { max: P.maxStickers });
      const list = emojis && emojis.length >= P.emojiPerStickerMin && emojis.length <= P.emojiPerStickerMax ? emojis : null;
      if (!list) throw new UserError('wa.err.emojis', { max: P.emojiPerStickerMax });
      await packs.checkQuota(user.tg_id, 'sticker_add');
      const f = await store(user, bytes, `${pack.wa_identifier}_${Date.now() % 1e9}.webp`, 'image/webp');
      const row = await wdb.addItem(pack.id, P.maxStickers, { ...f, format: KIND_FORMAT[kind], emojis: list });
      if (!row) {
        const fresh = await wdb.recount(pack.id, clock.now());
        throw new UserError(fresh >= P.maxStickers ? 'wa.err.full' : 'wa.err.duplicate', { max: P.maxStickers });
      }
      const count = await wdb.recount(pack.id, clock.now());
      await packs.countUsage(user.tg_id, 'sticker_add');
      app.stats.count(`sticker.wa_added.${kind}`);
      return { ...pack, sticker_count: count };
    },

    async setTray(user, pack, bytes) {
      const f = await store(user, bytes, `${pack.wa_identifier}_tray.png`, 'image/png');
      await wdb.setTray(pack.id, f.file_id, clock.now());
      return { ...pack, tray_file_id: f.file_id };
    },

    async remove(user, pack, itemId) {
      if (!(await wdb.removeItem(pack.id, Number(itemId)))) throw new UserError('wa.err.item_gone');
      return wdb.recount(pack.id, clock.now());
    },

    async move(user, pack, itemId, dir) {
      return wdb.move(pack.id, Number(itemId), dir < 0 ? -1 : 1);
    },

    async setEmojis(user, pack, itemId, text) {
      const list = parseWaEmojis(text);
      if (!list) throw new UserError('wa.err.emojis', { max: P.emojiPerStickerMax });
      if (!(await wdb.setItemEmojis(pack.id, Number(itemId), list))) throw new UserError('wa.err.item_gone');
      return list;
    },

    async rename(user, pack, title, publisher) {
      await wdb.setMeta(pack.id, title, publisher, clock.now());
    },

    /** Deletes the pack's rows (stored files stay in the channel; nothing refers to them). */
    async deletePack(user, pack) {
      await pdb.remove(pack.id);
      app.stats.count('pack.wa_deleted');
    },

    /** Checks the pack against every WhatsApp rule; returns the violations (empty = ready). */
    async check(pack) {
      const list = await items(pack.id);
      const kindOf = (f) => (f === 'wa_animated' ? 'animated' : 'static');
      return validateWhatsAppPack({
        title: pack.title,
        publisher: pack.publisher || '',
        identifier: pack.wa_identifier || '',
        kind: pack.kind,
        tray: !!pack.tray_file_id,
        items: list.map((i) => ({ kind: kindOf(i.format), emojis: parseJsonList(i.emojis) })),
      }).violations;
    },

    /**
     * Builds the ZIP from the stored files and sends it to the user (plus .wastickers when the flag
     * is on). Quota 'wa_export' is counted only after the send succeeded.
     */
    async exportZip(user, pack) {
      const v = await this.check(pack);
      if (v.length) throw new UserError('wa.err.not_ready', { why: v.map((x) => app.tp(`wa.rule.${x}`, { min: P.minStickers, max: P.maxStickers })).join('، ') });
      await packs.checkQuota(user.tg_id, 'wa_export');
      const list = await items(pack.id);
      const files = new Array(list.length);
      for (let i = 0; i < list.length; i += DOWNLOAD_PARALLEL) {
        const part = list.slice(i, i + DOWNLOAD_PARALLEL);
        const got = await Promise.all(part.map((it) => tg.fileContent(it.file_id)));
        got.forEach((b, j) => (files[i + j] = b));
      }
      const tray = await tg.fileContent(pack.tray_file_id);
      const readme = `${tp('fa', 'wa.readme', { title: pack.title })}\n\n----\n\n${tp('en', 'wa.readme', { title: pack.title })}\n`;
      const enc = new TextEncoder();
      const now = clock.now();
      const zip = makeZip([
        ...files.map((b, i) => ({ name: waFileName(i), data: b })),
        { name: 'tray.png', data: tray },
        { name: 'README.txt', data: enc.encode(readme) },
        { name: 'pack.json', data: enc.encode(JSON.stringify(packJson(pack, list), null, 2)) },
      ], now);
      await tg.sendDocument(user.tg_id, zip, waZipName(pack.wa_identifier), {
        type: 'application/zip',
        caption: app.t('wa.zip_caption', { title: pack.title, n: list.length }),
        extra: { disable_content_type_detection: true },
      }, 'wa_zip');
      if (app.flag('wastickers')) {
        const pkg = makeZip([
          { name: 'title.txt', data: enc.encode(pack.title) },
          { name: 'author.txt', data: enc.encode(pack.publisher || '') },
          { name: 'tray.png', data: tray },
          ...files.map((b, i) => ({ name: waFileName(i), data: b })),
        ], now);
        await tg.sendDocument(user.tg_id, pkg, waZipName(pack.wa_identifier, 'wastickers'), { type: 'application/octet-stream', extra: { disable_content_type_detection: true } }, 'wa_wastickers');
      }
      await packs.countUsage(user.tg_id, 'wa_export');
      app.stats.count('pack.wa_exported');
      return { bytes: zip.length, count: list.length };
    },
  };
}

function parseJsonList(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** The pack's metadata in WhatsApp's contents.json shape (identifier, name, publisher, emojis). */
function packJson(pack, list) {
  return {
    identifier: pack.wa_identifier,
    name: pack.title,
    publisher: pack.publisher || '',
    tray_image_file: 'tray.png',
    animated_sticker_pack: pack.kind === 'animated',
    stickers: list.map((it, i) => ({ image_file: waFileName(i), emojis: parseJsonList(it.emojis) })),
  };
}
