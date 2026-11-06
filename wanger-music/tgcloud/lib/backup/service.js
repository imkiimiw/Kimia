// Backups (spec §11, Phase 8). Export: the core tables as one JSON document sent to the owner
// (owner action, or weekly from the tick when the setting is on). Restore: scripts/restore.mjs sends
// the rows back in chunks through `tgcloud run` (a temporary owner-only endpoint), upserting by
// primary key. Audio files are not in the JSON (file_ids work for this bot only; the optional
// archive channel holds the audio).
import { OWNER_ID, BOT_ID } from '../config/static.js';
import { assertCan } from '../permissions/policy.js';
import { UserError, localDate } from '../core/util.js';
import { VERSION } from '../core/version.js';

export const BACKUP_FORMAT = 'wanger-music-backup';
export const BACKUP_VERSION = 1;
const PAGE = 1000;
const MAX_BYTES = 49 * 1024 * 1024; // Bot API upload limit is 50 MB
const WEEK = 7 * 86400;
const CHUNK_ROWS_MAX = 2000;

/** A cell a backup may hold (what SQLite stores here: integers, text, NULL). */
const okValue = (v) => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/**
 * @param {{repo: any, tables: Record<string, {key: string[], columns: string[]}>, settings: any, tg: any, audit: any, search: any, clock: any, log: any}} deps
 */
export function createBackupService({ repo, tables, settings, tg, audit, search, clock, log }) {
  /** Reads every backup table, page by page. */
  async function collect() {
    /** @type {Record<string, {columns: string[], rows: any[][]}>} */
    const out = {};
    /** @type {Record<string, number>} */
    const counts = {};
    for (const [name, spec] of Object.entries(tables)) {
      const rows = [];
      let last = null;
      for (;;) {
        const page = await repo.page(name, last, PAGE);
        rows.push(...page);
        if (page.length < PAGE) break;
        const lastRow = page[page.length - 1];
        last = spec.key.map((k) => lastRow[spec.columns.indexOf(k)]);
      }
      out[name] = { columns: spec.columns, rows };
      counts[name] = rows.length;
    }
    return { tables: out, counts };
  }

  const svc = {
    /** The backup document (pure data; also used by tests). */
    async build() {
      const t0 = clock.ms();
      const { tables: data, counts } = await collect();
      const doc = { format: BACKUP_FORMAT, version: BACKUP_VERSION, created_at: clock.now(), bot_id: BOT_ID, app: VERSION, counts, tables: data };
      const json = JSON.stringify(doc);
      const bytes = new TextEncoder().encode(json);
      return { bytes, counts, ms: clock.ms() - t0 };
    },

    /** Exports and sends the document to the owner. @param {any} actor owner, or null for the weekly tick */
    async exportToOwner(actor) {
      if (actor) assertCan(actor, 'backup.manage');
      const { bytes, counts, ms } = await svc.build();
      if (bytes.length > MAX_BYTES) throw new UserError('bak.err.too_big', { mb: Math.ceil(bytes.length / 1048576) });
      const now = clock.now();
      const day = localDate(now, String(await settings.get('time_zone')));
      const name = `wanger-music-backup-${day}-${now}.json`;
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const msg = await tg.sendDocument(OWNER_ID, bytes, name, { type: 'application/json', caption: `💾 ${name}\n${total} rows · ${Math.ceil(bytes.length / 1024)} KB` }, 'backup');
      const last = { at: now, ms, bytes: bytes.length, rows: total, file_id: msg && msg.document ? msg.document.file_id : null, by: actor ? actor.telegram_id : 0 };
      await settings.setInternal('backup.last', last);
      await audit.record(actor, 'backup.export', 'backup', name, { rows: total, bytes: bytes.length });
      log.info('backup_exported', { count: total, duration_ms: ms });
      return { ...last, name, counts };
    },

    /** Tick processor: a weekly backup when the setting is on (skipped on small piggyback ticks once exports get slow). */
    async runWeekly(trigger) {
      if (!(await settings.get('backup.weekly'))) return 'off';
      const last = /** @type {any} */ (await settings.get('backup.last')) || {};
      if (clock.now() - (Number(last.at) || 0) < WEEK) return 'not_due';
      if (trigger === 'piggyback' && Number(last.ms) > 1000) return 'skipped:piggyback';
      const r = await svc.exportToOwner(null);
      return { rows: r.rows, bytes: r.bytes };
    },

    /**
     * Restore, one chunk (scripts/restore.mjs). Validates everything; writes one statement.
     * @param {any} actor the owner
     * @param {{table: string, columns: string[], rows: any[][], replace?: boolean}} input
     */
    async restoreChunk(actor, input) {
      assertCan(actor, 'backup.manage');
      const spec = tables[input && input.table];
      if (!spec) throw new UserError('bak.err.table');
      const cols = Array.isArray(input.columns) ? input.columns : [];
      if (!cols.length || new Set(cols).size !== cols.length || !cols.every((c) => spec.columns.includes(c)) || !spec.key.every((k) => cols.includes(k))) throw new UserError('bak.err.columns');
      const rows = Array.isArray(input.rows) ? input.rows : [];
      if (rows.length > CHUNK_ROWS_MAX) throw new UserError('bak.err.chunk');
      for (const r of rows) if (!Array.isArray(r) || r.length !== cols.length || !r.every(okValue)) throw new UserError('bak.err.row');
      const cleared = input.replace ? await repo.clear(input.table) : 0;
      const written = await repo.upsert(input.table, cols, rows);
      return { table: input.table, given: rows.length, written, cleared };
    },

    /** After the last chunk: rebuild derived state, report row counts to compare with the backup. */
    async finishRestore(actor, { replace = false } = {}) {
      assertCan(actor, 'backup.manage');
      if (replace) await repo.clearSearchIndex();
      await search.requestRebuild();
      await settings.setInternal('stats.aggregated_at', 0);
      await settings.setInternal('catalog.version', Number(await settings.get('catalog.version')) + 1);
      await audit.record(actor, 'backup.restore', 'backup', null, { replace });
      /** @type {Record<string, number>} */
      const counts = {};
      for (const name of Object.keys(tables)) counts[name] = await repo.count(name);
      return { counts };
    },

    /** A slice of the last exported document, base64 (scripts/backup.mjs fetch; ≤ 20 MB files). */
    async lastFileSlice(actor, offset, length) {
      assertCan(actor, 'backup.manage');
      const last = /** @type {any} */ (await settings.get('backup.last')) || {};
      if (!last.file_id) throw new UserError('bak.err.none');
      const bytes = await tg.fileContent(last.file_id);
      const from = Math.max(0, Number(offset) || 0);
      const part = bytes.subarray(from, from + Math.min(Math.max(1, Number(length) || 0), 1 << 20));
      return { size: bytes.length, offset: from, b64: base64(part), at: last.at };
    },

    /** Bounds the restore script uses. */
    limits: () => ({ chunkRowsMax: CHUNK_ROWS_MAX, maxBytes: MAX_BYTES }),
  };
  return svc;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 without Buffer/btoa (neither is guaranteed in the isolate). @param {Uint8Array} b */
export function base64(b) {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
