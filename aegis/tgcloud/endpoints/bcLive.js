/*
 * Owner only. The Mini App's live broadcast page (webapp/) calls this about once a second while it
 * is open: { action: 'tick' } sends one batch of the running broadcast (the platform has no
 * scheduler, so an open page is what keeps a big broadcast moving), 'status' only reports,
 * 'pause' / 'resume' / 'cancel' control it. Every label the page shows comes back in the owner's
 * language. See lib/engines/broadcast.js.
 */
import { EndpointError } from 'sdk';
import { OWNER_ID } from '../lib/config.js';
import * as errors from '../lib/core/errors.js';
import { createCtx } from '../lib/core/tg.js';
import * as bc from '../lib/engines/broadcast.js';
import { dur, isRtl, num, t } from '../lib/i18n/index.js';
import { liveTick, ownerLang, refreshPanel, report } from '../lib/ui/owner_bc.js';

const LABELS = ['title', 'idle', 'sent', 'failed', 'blocked', 'left', 'audience', 'mode', 'status', 'wait', 'hint', 'pause', 'resume',
  'cancel', 'cancel_q', 'close', 'paused_source_gone', 'error'];

function view(lang, row, sent) {
  const plain = (s) => s.replace(/\u200F/g, '');
  const labels = {};
  for (const k of LABELS) labels[k] = plain(t(lang, `app.${k}`));
  let out = null;
  if (row) {
    const p = bc.progress(row);
    out = {
      ...p,
      statusLabel: plain(t(lang, `bc.st_${p.status}`)),
      audienceLabel: plain(t(lang, `bc.aud_${p.audience}`)),
      modeLabel: plain(t(lang, `bc.mode_${p.mode}`)),
      waitLabel: p.waitMs > 1500 ? dur(lang, Math.ceil(p.waitMs / 1000)) : '',
      tookLabel: p.took ? dur(lang, p.took) : '',
      f: { id: num(lang, p.id), pct: num(lang, p.pct), sent: num(lang, p.sent), failed: num(lang, p.failed), blocked: num(lang, p.blocked), left: num(lang, p.left), total: num(lang, p.total) },
    };
  }
  return { lang, rtl: isRtl(lang), labels, bc: out, sent };
}

export default async function (input, pctx) {
  const u = pctx && pctx.initData && pctx.initData.user;
  if (!u || u.id !== OWNER_ID) throw new EndpointError('Owner only', { code: 'OWNER_ONLY' });
  const ctx = createCtx({ kind: 'endpoint' });
  const action = String((input && input.action) || 'status');
  try {
    const lang = await ownerLang();
    let row = await bc.active();
    let sent = 0;
    if (row) {
      const id = Number(row.id);
      if (action === 'tick') {
        const r = await liveTick(ctx, lang);
        row = r.row;
        sent = r.sent;
      } else if (action === 'pause' || action === 'resume') {
        if (action === 'pause') await bc.pause(id, OWNER_ID);
        else await bc.resume(id, OWNER_ID);
        row = await bc.get(id);
        await refreshPanel(ctx, row, lang);
      } else if (action === 'cancel') {
        if (await bc.cancel(id, OWNER_ID)) {
          row = await bc.get(id);
          await report(ctx, row, lang);
          await refreshPanel(ctx, row, lang);
        }
      }
    }
    if (!row) row = await bc.latestFinished();
    return view(lang, row, sent);
  } catch (err) {
    await errors.record(ctx, err, { source: 'endpoint.bcLive', userId: u.id });
    throw err;
  }
}
