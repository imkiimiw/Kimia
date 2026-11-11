/**
 * PHASE 0 SPIKE ONLY — removed in Phase 1. The device spike page sends its measurements here; the
 * bot posts them as a JSON document into the CALLER's own private chat (so the owner collects the
 * results of every device she tests on). Owner and listed spike testers only. No database.
 *
 * input: { report: object }
 */
import { api, InputFile, EndpointError } from 'sdk';
import { isOwner, SPIKE_TESTER_IDS } from '../lib/config.js';
import { utf8 } from '../lib/core/bytes.js';

const MAX_REPORT_CHARS = 512 * 1024;

export default async function (input, ctx) {
  const uid = ctx && ctx.initData && ctx.initData.user && ctx.initData.user.id;
  if (!isOwner(uid) && !SPIKE_TESTER_IDS.includes(uid)) throw new EndpointError('Not allowed', { code: 'FORBIDDEN' });
  if (!input.report || typeof input.report !== 'object' || Array.isArray(input.report)) {
    throw new EndpointError('report must be an object', { code: 'BAD_INPUT' });
  }
  const json = JSON.stringify(input.report, null, 2);
  if (json.length > MAX_REPORT_CHARS) throw new EndpointError('report too large', { code: 'TOO_LARGE' });

  const platform = String((input.report.device && input.report.device.platform) || 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
  const bytes = utf8(json);
  await api.sendDocument({
    chat_id: uid,
    document: new InputFile(bytes, `spike-${platform}.json`, { type: 'application/json' }),
    caption: `Wanger Stickers · Phase 0 spike · ${platform}`,
  });
  return { sent: true, bytes: bytes.length };
}
