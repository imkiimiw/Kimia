// POST /api/studio_boot — the Studio's first call: who the caller is, their language, packs with
// free space, today's quota left, and the numbers the editor needs. Runs the forced-join gate.
import { runEndpoint } from '../lib/endpoint.js';
import { users } from '../lib/db/users.js';
import { dayKey } from '../lib/core/util.js';
import { TELEGRAM } from '../lib/core/limits.js';
import { TRANSFER } from '../lib/studio/transfer.js';
import { BOT_USERNAME } from '../lib/config.js';

export default function (input, ctx) {
  return runEndpoint('studio_boot', input, ctx, {}, async (app) => {
    const u = app.user;
    const packs = (await app.packs.list(u.tg_id, 0, 50)).map((p) => ({ id: p.id, title: p.title, count: p.sticker_count, name: p.tg_name }));
    const { quotas } = await app.account.getEntitlements(u.tg_id);
    const day = dayKey(app.clock.now());
    const left = async (f) => (quotas[f] === Infinity ? -1 : Math.max(0, quotas[f] - (await users.usage(u.tg_id, day, f))));
    return {
      user: { id: u.tg_id, first_name: u.first_name || '', lang: app.lang },
      role: app.role,
      packs,
      quota: { pack_create: await left('pack_create'), sticker_add: await left('sticker_add') },
      limits: { static: TELEGRAM.static, set: TELEGRAM.set, chunkBytes: TRANSFER.chunkBytes },
      bot: BOT_USERNAME,
    };
  });
}
