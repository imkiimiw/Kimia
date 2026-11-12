// Telegram pack management by file_id (brief §9). The sticker set on Telegram is the truth;
// pack_items mirrors it and is refreshed from getStickerSet after every change. Every operation
// checks ownership (the pack row's tg_id) — ids from callback_data are never trusted.
import { packs as pdb, posts as postDb } from '../db/packs.js';
import { users } from '../db/users.js';
import { makePackName, stickerFormat, isRegularSticker } from '../core/packs.js';
import { classify, friendlyKey } from '../core/errors.js';
import { UserError, dayKey, parseJson } from '../core/util.js';
import { utf8 } from '../core/bytes.js';
import { TELEGRAM } from '../core/limits.js';
import { BOT_USERNAME } from '../config.js';

const SET = TELEGRAM.set;
const DEFAULT_EMOJI = '⭐';

/** A Sticker (from a message or a set) → what we store and pass as InputSticker. */
export function stickerInput(s, emojis) {
  return {
    file_id: s.file_id,
    file_unique_id: s.file_unique_id,
    format: stickerFormat(s),
    emojis: emojis && emojis.length ? emojis : [s.emoji || DEFAULT_EMOJI],
  };
}
const inputSticker = (si) => ({ sticker: si.file_id, format: si.format, emoji_list: si.emojis.slice(0, SET.emojiPerStickerMax) });

/** @param {any} app @param {any} account */
export function createPacks(app, account) {
  const { clock, tg } = app;

  /** Bot API call; expected sticker errors become friendly UserErrors. */
  async function bot(method, params, view) {
    try {
      return await tg.call(method, params, view || method);
    } catch (e) {
      const key = friendlyKey(e);
      if (key !== 'err.generic') throw new UserError(key, { s: classify(e).retryAfter || 1 });
      throw e;
    }
  }

  async function checkQuota(userId, feature, n = 1) {
    const { quotas } = await account.getEntitlements(userId);
    const used = await users.usage(userId, dayKey(clock.now()), feature);
    if (used + n > quotas[feature]) throw new UserError('err.quota', { limit: quotas[feature] });
  }
  const countUsage = (userId, feature, n = 1) => users.addUsage(userId, dayKey(clock.now()), feature, n);

  /** Re-reads the set from Telegram and rewrites the mirror. Returns the items, or null if the set is gone. */
  async function sync(pack) {
    let set;
    try {
      set = await tg.call('getStickerSet', { name: pack.tg_name }, 'sync');
    } catch (e) {
      if (classify(e).kind === 'set_invalid') {
        await forget(pack);
        return null;
      }
      throw e;
    }
    const old = await pdb.items(pack.id);
    const byFuid = new Map(old.map((r) => [r.file_unique_id, r]));
    const origins = Object.fromEntries(old.map((r) => [r.file_unique_id, r.origin]));
    const list = (set.stickers || []).map((s) => {
      const prev = byFuid.get(s.file_unique_id);
      const prevEmojis = prev ? parseJson(prev.emojis, []) : [];
      return {
        file_id: s.file_id,
        file_unique_id: s.file_unique_id,
        format: stickerFormat(s),
        emojis: prevEmojis.length && (!s.emoji || prevEmojis.includes(s.emoji)) ? prevEmojis : [s.emoji || DEFAULT_EMOJI],
        keywords: prev ? parseJson(prev.keywords, []) : [],
      };
    });
    await pdb.replaceItems(pack.id, list, origins);
    if (set.title && set.title !== pack.title) await pdb.setTitle(pack.id, set.title, clock.now());
    await pdb.setCount(pack.id, list.length, clock.now());
    pack.sticker_count = list.length;
    return pdb.items(pack.id);
  }

  /** The pack was deleted on Telegram's side: drop our rows and withdraw its post. */
  async function forget(pack) {
    const live = await postDb.liveOf(pack.id);
    if (live) await postDb.transition(live.id, ['pending', 'approved', 'posting', 'published'], 'removed', { reason: 'pack_deleted' }, clock.now());
    await pdb.remove(pack.id);
  }

  async function mustOwn(userId, packId) {
    const pack = await pdb.getOwned(packId, userId);
    if (!pack) throw new UserError('pk.err.gone');
    return pack;
  }

  async function itemOf(pack, fuid) {
    const it = await pdb.item(pack.id, fuid);
    if (!it) throw new UserError('pk.err.item_gone');
    return it;
  }

  return {
    sync,
    mustOwn,
    itemOf,
    checkQuota,
    countUsage,
    list: (userId, offset, n) => pdb.listByUser(userId, offset, n),
    count: (userId) => pdb.countByUser(userId),
    items: (packId) => pdb.items(packId),

    /**
     * Creates a set with one first sticker. The name is ws_<id>_<n>_by_<bot>; on "name occupied"
     * the next n is tried (n is never reused).
     * @param {any} user @param {string} title @param {ReturnType<typeof stickerInput>} first @param {string} origin
     */
    async create(user, title, first, origin = 'made') {
      await checkQuota(user.tg_id, 'pack_create');
      if ((await pdb.countByUser(user.tg_id)) >= Number(app.settings.get('limits.packs_per_user'))) {
        throw new UserError('pk.err.too_many', { max: Number(app.settings.get('limits.packs_per_user')) });
      }
      let name = null;
      for (let attempt = 0; attempt < 3 && !name; attempt++) {
        const n = await users.nextPackNumber(user.tg_id);
        const candidate = makePackName(user.tg_id, n, BOT_USERNAME);
        try {
          await tg.call('createNewStickerSet', { user_id: user.tg_id, name: candidate, title, stickers: [inputSticker(first)] }, 'pack_create');
          name = candidate;
        } catch (e) {
          if (classify(e).kind === 'set_name_taken') continue;
          const key = friendlyKey(e);
          if (key !== 'err.generic') throw new UserError(key, { s: classify(e).retryAfter || 1 });
          throw e;
        }
      }
      if (!name) throw new UserError('err.set_name_taken');
      const pack = await pdb.create({ tg_id: user.tg_id, tg_name: name, title, sticker_count: 1 }, clock.now());
      await pdb.noteOrigin(pack.id, first.file_unique_id, first.file_id, first.format, origin);
      await sync(pack);
      await countUsage(user.tg_id, 'pack_create');
      app.stats.count('pack.created');
      account.recordEvent(user.tg_id, 'pack_created');
      return pack;
    },

    /** Adds one sticker (by file_id). Telegram ignores an exact duplicate. */
    async add(user, pack, si, origin = 'made') {
      if (pack.sticker_count >= SET.maxStickersRegular) throw new UserError('err.set_full');
      await checkQuota(user.tg_id, 'sticker_add');
      await pdb.noteOrigin(pack.id, si.file_unique_id, si.file_id, si.format, origin);
      try {
        await bot('addStickerToSet', { user_id: user.tg_id, name: pack.tg_name, sticker: inputSticker(si) }, 'sticker_add');
      } catch (e) {
        await pdb.dropPlaceholder(pack.id, si.file_unique_id);
        throw e;
      }
      await sync(pack);
      await countUsage(user.tg_id, 'sticker_add');
      app.stats.count(`sticker.added.${si.format}`);
      return pack;
    },

    async remove(user, pack, fuid) {
      const it = await itemOf(pack, fuid);
      if (pack.sticker_count <= 1) throw new UserError('pk.err.last_sticker');
      await bot('deleteStickerFromSet', { sticker: it.file_id });
      await sync(pack);
      app.stats.count('sticker.deleted');
    },

    /** dir −1 = earlier, +1 = later. */
    async move(user, pack, fuid, dir) {
      const it = await itemOf(pack, fuid);
      const to = it.position + dir;
      if (to < 0 || to >= pack.sticker_count) return false;
      await bot('setStickerPositionInSet', { sticker: it.file_id, position: to });
      await sync(pack);
      return true;
    },

    async replace(user, pack, fuid, si) {
      const it = await itemOf(pack, fuid);
      await pdb.noteOrigin(pack.id, si.file_unique_id, si.file_id, si.format, 'made');
      await bot('replaceStickerInSet', { user_id: user.tg_id, name: pack.tg_name, old_sticker: it.file_id, sticker: inputSticker({ ...si, emojis: parseJson(it.emojis, []).length ? parseJson(it.emojis, []) : si.emojis }) });
      await sync(pack);
    },

    async setEmojis(user, pack, fuid, list) {
      const it = await itemOf(pack, fuid);
      await bot('setStickerEmojiList', { sticker: it.file_id, emoji_list: list });
      await pdb.setItemEmojis(pack.id, fuid, list);
    },

    async setKeywords(user, pack, fuid, list) {
      const it = await itemOf(pack, fuid);
      await bot('setStickerKeywords', { sticker: it.file_id, keywords: list });
      await pdb.setItemKeywords(pack.id, fuid, list);
    },

    async rename(user, pack, title) {
      await bot('setStickerSetTitle', { name: pack.tg_name, title });
      await pdb.setTitle(pack.id, title, clock.now());
    },

    /** Drops the custom thumbnail (Telegram then uses the first sticker). */
    async resetThumbnail(user, pack) {
      await bot('setStickerSetThumbnail', { name: pack.tg_name, user_id: user.tg_id, format: 'static' });
    },
    /** A 100×100 WEBP/PNG (≤ 128 KB) the user sent as a file, or a 100×100 sticker. */
    async setThumbnail(user, pack, fileId, format) {
      await bot('setStickerSetThumbnail', { name: pack.tg_name, user_id: user.tg_id, thumbnail: fileId, format });
    },

    async deletePack(user, pack) {
      try {
        await tg.call('deleteStickerSet', { name: pack.tg_name }, 'pack_delete');
      } catch (e) {
        if (classify(e).kind !== 'set_invalid') {
          const key = friendlyKey(e);
          if (key !== 'err.generic') throw new UserError(key);
          throw e;
        }
      }
      await forget(pack);
      app.stats.count('pack.deleted');
    },

    /** A JSON backup of the pack (file_ids, emojis, keywords) as a document to the user. */
    async exportPack(user, pack) {
      const items = await pdb.items(pack.id);
      const data = {
        format: 'wanger-stickers/pack@1',
        exported_at: clock.now(),
        name: pack.tg_name,
        title: pack.title,
        link: `https://t.me/addstickers/${pack.tg_name}`,
        stickers: items.map((i) => ({ file_id: i.file_id, file_unique_id: i.file_unique_id, format: i.format, emojis: parseJson(i.emojis, []), keywords: parseJson(i.keywords, []) })),
      };
      await tg.sendDocument(user.tg_id, utf8(JSON.stringify(data, null, 2)), `${pack.tg_name}.json`, { type: 'application/json' }, 'pack_export');
    },
  };
}

export { isRegularSticker };
