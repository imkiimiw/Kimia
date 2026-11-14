// POST /api/wa_export { packId } — sends the WhatsApp pack's ZIP to the user's chat (the pack must
// pass every WhatsApp rule; see lib/packs/whatsapp.js). The gate is re-checked without the cache.
import { EndpointError } from 'sdk';
import { runEndpoint } from '../lib/endpoint.js';
import { joinUrl } from '../lib/core/gate.js';
import { UserError } from '../lib/core/util.js';
import { zipHelpView } from '../lib/bot/wa_ui.js';

export default function (input, ctx) {
  return runEndpoint('wa_export', input, ctx, { packId: 'int' }, async (app, { packId }) => {
    if (!app.flag('whatsapp') && app.role !== 'owner') throw new UserError('common.feature_off');
    if (app.role !== 'owner') {
      const v = await app.gate.check(app.user, { useCache: false });
      if (!v.passed) throw new EndpointError(app.tp('gate.still_missing'), { code: 'JOIN_REQUIRED', channels: v.missing.map((c) => ({ title: c.title || c.username || '', url: joinUrl(c) })).filter((c) => c.url) });
    }
    const pack = await app.whatsapp.own(app.user.tg_id, packId);
    const r = await app.whatsapp.exportZip(app.user, pack);
    await app.tg.send(app.user.tg_id, zipHelpView(app), 'wa_zip_help');
    return { sent: true, count: r.count, bytes: r.bytes };
  });
}
