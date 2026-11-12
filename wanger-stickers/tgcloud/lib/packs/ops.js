// Bulk pack operations that may take several invocations (≈ 30 s wall, 3 s CPU each): import from
// a public pack, copy between own packs, duplicate, merge. The item list is snapshotted in the
// pack_ops row; a lease stops two invocations from running the same op; the cursor only moves
// forward after each sticker, so a retry never adds a sticker twice (and Telegram ignores an exact
// duplicate anyway). The op moves on when the user taps «ادامه», and piggybacked on any update.
import { ops as opsDb, packs as pdb } from '../db/packs.js';
import { UserError, parseJson } from '../core/util.js';
import { classify } from '../core/errors.js';
import { TELEGRAM } from '../core/limits.js';
import { T } from '../config.js';

export const OP_KINDS = Object.freeze(['import', 'copy', 'duplicate', 'merge']);

/** @param {any} app @param {ReturnType<import('./service.js').createPacks>} packs */
export function createOps(app, packs) {
  const { clock } = app;

  return {
    get: (id) => opsDb.get(id),
    activeOf: (userId) => opsDb.activeOf(userId),

    /**
     * @param {any} user
     * @param {{kind: string, src?: string, dstPackId?: number|null, title?: string, items: any[], deleteSrc?: boolean}} o
     */
    async start(user, o) {
      if (!OP_KINDS.includes(o.kind) || !o.items.length) throw new UserError('pk.err.nothing');
      if (await opsDb.activeOf(user.tg_id)) throw new UserError('op.err.busy');
      if (o.dstPackId) {
        const dst = await packs.mustOwn(user.tg_id, o.dstPackId);
        if (dst.sticker_count + o.items.length > TELEGRAM.set.maxStickersRegular) throw new UserError('op.err.too_many', { free: TELEGRAM.set.maxStickersRegular - dst.sticker_count });
      } else if (o.items.length > TELEGRAM.set.maxStickersRegular) throw new UserError('op.err.too_many', { free: TELEGRAM.set.maxStickersRegular });
      await packs.checkQuota(user.tg_id, 'sticker_add', o.items.length - (o.dstPackId ? 0 : 1));
      if (o.kind === 'import') await packs.checkQuota(user.tg_id, 'pack_import');
      const op = await opsDb.create({ tg_id: user.tg_id, kind: o.kind, src: o.src, dst_pack_id: o.dstPackId || null, items: o.items, title: o.title, delete_src: o.deleteSrc }, clock.now());
      if (o.kind === 'import') await packs.countUsage(user.tg_id, 'pack_import');
      app.stats.count(`op.${o.kind}`);
      return op;
    },

    async cancel(userId) {
      return opsDb.cancelOfUser(userId, clock.now());
    },

    /**
     * Runs one slice of an op (given, or the oldest runnable one). Returns the op row afterwards
     * and what stopped it, or null when nothing could run.
     * @param {{deadlineMs: number, id?: number, user?: any}} opts
     */
    async step({ deadlineMs, id, user }) {
      const now = clock.now();
      const candidate = id ? await opsDb.get(id) : await opsDb.nextRunnable(now);
      if (!candidate || candidate.status !== 'running') return null;
      const op = await opsDb.claim(candidate.id, now, now + T.packOpLeaseSec);
      if (!op) return null;
      const owner = user && user.tg_id === op.tg_id ? user : { tg_id: op.tg_id };
      const items = parseJson(op.items, []);
      const origin = op.kind === 'import' ? 'import' : 'copy';
      let cursor = op.cursor;
      let stopped = null;
      let n = 0;
      try {
        let dst = op.dst_pack_id ? await pdb.getOwned(op.dst_pack_id, op.tg_id) : null;
        if (op.dst_pack_id && !dst) {
          stopped = 'dst_gone';
        } else if (!dst && cursor < items.length) {
          // first sticker creates the pack (duplicate / import into a new pack)
          dst = await packs.create(owner, op.title || 'Wanger', items[cursor], origin);
          await opsDb.setDst(op.id, dst.id);
          await opsDb.advance(op.id, cursor, true, clock.now());
          cursor += 1;
          n += 1;
        }
        while (!stopped && dst && cursor < items.length && n < T.packOpSlice) {
          if (clock.ms() >= deadlineMs) { stopped = 'budget'; break; }
          let ok = true;
          try {
            await packs.add(owner, dst, items[cursor], origin);
          } catch (e) {
            if (e instanceof UserError && (e.key === 'err.set_full' || e.key === 'err.quota' || e.key === 'err.flood')) { stopped = e.key; break; }
            if (!(e instanceof UserError) && classify(e).kind !== 'bad_request') throw e;
            ok = false; // this one sticker can't be added (e.g. invalid file) — skip it
          }
          if (!(await opsDb.advance(op.id, cursor, ok, clock.now()))) { stopped = 'cursor'; break; }
          cursor += 1;
          n += 1;
        }
        if (!stopped && cursor >= items.length) {
          const fin = await opsDb.finish(op.id, 'done', clock.now());
          if (fin && fin.delete_src && fin.kind === 'merge' && fin.src) {
            const src = await pdb.getByName(fin.src);
            if (src && src.tg_id === op.tg_id && src.id !== fin.dst_pack_id) await packs.deletePack(owner, src);
          }
          return { op: await opsDb.get(op.id), stopped: 'done' };
        }
        if (stopped === 'dst_gone' || stopped === 'err.set_full') await opsDb.finish(op.id, 'failed', clock.now());
        else await opsDb.release(op.id);
        return { op: await opsDb.get(op.id), stopped };
      } catch (e) {
        await opsDb.release(op.id);
        throw e;
      }
    },
  };
}
