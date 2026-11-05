/*
 * Data migrations. The tables themselves are created/extended by `tgcloud migrate` from schema.js;
 * these are the data steps that go with them (seeding, backfills), applied in order, once each,
 * on the first update after a deploy. aegis_kv.data_version records the last applied step. Every
 * step must be idempotent (a concurrent first update may run it twice).
 */
import * as join from '../engines/join.js';
import { seals } from '../engines/system.js';
import * as audit from './audit.js';
import * as kv from './kv.js';

export const MIGRATIONS = [
  {
    v: 1,
    name: 'default forced-join channels; forced join on',
    async run(ctx) {
      await join.seedDefaults();
      const s = await kv.all(ctx);
      if (s.join_enabled === undefined) await kv.set(ctx, 'join_enabled', '1');
    },
  },
  {
    v: 2,
    name: 'phase 2: global switch on; chats tracked before phase 2 are registered on their next update',
    async run(ctx) {
      const s = await kv.all(ctx);
      if (s.shutdown === undefined) await kv.set(ctx, 'shutdown', '0');
    },
  },
  {
    v: 3,
    name: 'phase 10: the audit log and its seals become append-only (database triggers refuse UPDATE and DELETE)',
    async run() {
      await seals.installGuard();
    },
  },
];

export const LATEST = MIGRATIONS[MIGRATIONS.length - 1].v;

export async function ensure(ctx) {
  const s = await kv.all(ctx);
  let current = Number(s.data_version || 0);
  if (current >= LATEST) return;
  for (const m of MIGRATIONS) {
    if (m.v <= current) continue;
    await m.run(ctx);
    await kv.set(ctx, 'data_version', m.v);
    await audit.log(0, 'system.migrate', { target: m.v, details: { name: m.name } });
    current = m.v;
  }
}
