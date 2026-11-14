// POST /api/upload_commit — reassemble (or `inline` for one-chunk files), verify size + SHA-256,
// validate against the target's rules again, then act (lib/studio/transfer.js ACTIONS per kind):
// Telegram pack add / new / send, animation or file to the chat, WhatsApp pack add / new / tray.
// The gate is re-checked without the cache before creating packs and exports (brief §6).
import { EndpointError } from 'sdk';
import { runEndpoint } from '../lib/endpoint.js';
import { joinUrl } from '../lib/core/gate.js';

const SHAPE = { uploadId: 'string?', inline: 'string?', kind: 'string?', format: 'string?', size: 'int?', sha256: 'string?', action: 'string', packId: 'int?', title: 'string?', publisher: 'string?', emojis: 'string?', quiet: 'bool?', repaint: 'bool?' };
const ACTIONS = ['add', 'new', 'send', 'file', 'wa_add', 'wa_new', 'wa_tray'];

export default function (input, ctx) {
  return runEndpoint('upload_commit', input, ctx, SHAPE, async (app, i) => {
    if (app.role !== 'owner') {
      const v = await app.gate.check(app.user, { useCache: false });
      if (!v.passed) throw new EndpointError(app.tp('gate.still_missing'), { code: 'JOIN_REQUIRED', channels: v.missing.map((c) => ({ title: c.title || c.username || '', url: joinUrl(c) })).filter((c) => c.url) });
    }
    if (!ACTIONS.includes(i.action)) throw new EndpointError('Bad action', { code: 'BAD_INPUT', field: 'action' });
    if (i.inline === undefined && i.uploadId === undefined) throw new EndpointError('Nothing to commit', { code: 'BAD_INPUT' });
    return app.transfer.commit(app.user, i);
  });
}
