// POST /api/studio_boot — the Studio's first call: who the caller is, their language, Telegram and
// WhatsApp packs with free space, today's quota left, which Phase 3 features are on, and the
// numbers the editor needs (one limits object shared with the server). Runs the forced-join gate.
import { runEndpoint } from '../lib/endpoint.js';
import { users } from '../lib/db/users.js';
import { dayKey } from '../lib/core/util.js';
import { TELEGRAM, WHATSAPP, OUTPUT, SIZE_TARGETING } from '../lib/core/limits.js';
import { TRANSFER } from '../lib/studio/transfer.js';
import { BOT_USERNAME } from '../lib/config.js';

const FLAGS = ['studio', 'video', 'gif_studio', 'convert', 'whatsapp', 'emoji', 'anim_bg'];

export default function (input, ctx) {
  return runEndpoint('studio_boot', input, ctx, {}, async (app) => {
    const u = app.user;
    const packs = (await app.packs.list(u.tg_id, 0, 50)).map((p) => ({ id: p.id, title: p.title, count: p.sticker_count, name: p.tg_name, kind: p.kind === 'emoji' ? 'emoji' : 'sticker' }));
    const wa = app.flag('whatsapp') || app.role === 'owner'
      ? (await app.whatsapp.list(u.tg_id, 0, 50)).map((p) => ({ id: p.id, title: p.title, publisher: p.publisher || '', kind: p.kind, count: p.sticker_count, tray: !!p.tray_file_id }))
      : [];
    const { quotas } = await app.account.getEntitlements(u.tg_id);
    const day = dayKey(app.clock.now());
    const left = async (f) => (quotas[f] === Infinity ? -1 : Math.max(0, quotas[f] - (await users.usage(u.tg_id, day, f))));
    const flags = Object.fromEntries(FLAGS.map((f) => [f, app.flag(f) || app.role === 'owner']));
    return {
      user: { id: u.tg_id, first_name: u.first_name || '', username: u.username || '', lang: app.lang },
      role: app.role,
      packs,
      wa,
      flags,
      quota: { pack_create: await left('pack_create'), sticker_add: await left('sticker_add'), media_send: await left('media_send'), wa_export: await left('wa_export') },
      limits: { static: TELEGRAM.static, video: TELEGRAM.video, set: TELEGRAM.set, customEmoji: TELEGRAM.customEmoji, whatsapp: WHATSAPP, output: OUTPUT, sizeTargeting: SIZE_TARGETING, chunkBytes: TRANSFER.chunkBytes },
      bot: BOT_USERNAME,
    };
  });
}
