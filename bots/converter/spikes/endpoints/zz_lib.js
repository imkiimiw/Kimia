// C0 probe for the vendored libraries (fflate, @cantoo/pdf-lib). TEMPORARY: scripts/spike.mjs copies
// it to tgcloud/endpoints/zz_lib.js (and bench.js + vendor/ to tgcloud/lib/zz_spike/) for one
// `tgcloud run`, then deletes them. Never pushed. Database: only `SELECT 1` (clock reads).
import { db, fetch } from 'sdk';
import { sql } from 'sdk/db';
import { runCase } from '../lib/zz_spike/bench.js';

async function now() { await db.get(sql`SELECT 1 AS x`); return Date.now(); }

export default async function (input) {
  let bytes;
  let fetch_ms;
  if (input.url) {
    const t = await now();
    const r = await fetch(input.url);
    const chunks = []; let n = 0;
    for await (const c of r.body) { chunks.push(c); n += c.length; }
    bytes = new Uint8Array(n); let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    fetch_ms = (await now()) - t;
  }
  const steps = await runCase(input, { now, bytes });
  return { fetch_ms, steps };
}
