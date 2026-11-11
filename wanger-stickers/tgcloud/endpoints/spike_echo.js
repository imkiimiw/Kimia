/**
 * PHASE 0 SPIKE ONLY — removed in Phase 1. Measures the endpoint HTTP limits from the Mini App:
 * the largest request body (input.b64) and response (input.want bytes) that get through, and the
 * server-side cost of decoding + hashing a chunk. Owner and listed spike testers only. No database,
 * no messages.
 *
 * input: { b64?: string, want?: number }
 */
import { EndpointError } from 'sdk';
import { isOwner, SPIKE_TESTER_IDS } from '../lib/config.js';
import { utf8, hex } from '../lib/core/bytes.js';

const MAX_WANT = 64 * 1024 * 1024;

export default async function (input, ctx) {
  const uid = ctx && ctx.initData && ctx.initData.user && ctx.initData.user.id;
  if (!isOwner(uid) && !SPIKE_TESTER_IDS.includes(uid)) throw new EndpointError('Not allowed', { code: 'FORBIDDEN' });

  const b64 = typeof input.b64 === 'string' ? input.b64 : '';
  const want = Number.isInteger(input.want) && input.want >= 0 && input.want <= MAX_WANT ? input.want : 0;

  let sha256 = null;
  if (b64 && globalThis.crypto && crypto.subtle) {
    sha256 = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(b64))));
  }
  return { received: b64.length, sha256, pad: want ? 'z'.repeat(want) : '' };
}
