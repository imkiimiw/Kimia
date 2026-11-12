// POST /api/upload_chunk { uploadId, idx, b64 } — one raw chunk (≤ 256 KB) as base64.
import { runEndpoint } from '../lib/endpoint.js';

export default function (input, ctx) {
  return runEndpoint('upload_chunk', input, ctx, { uploadId: 'string', idx: 'int', b64: 'string' }, (app, i) => app.transfer.chunk(app.user, i), { gate: false });
}
