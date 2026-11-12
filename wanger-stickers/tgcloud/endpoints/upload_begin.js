// POST /api/upload_begin { kind, format, size, sha256 } → { uploadId, chunkBytes, chunks }
import { runEndpoint } from '../lib/endpoint.js';

export default function (input, ctx) {
  return runEndpoint('upload_begin', input, ctx, { kind: 'string', format: 'string', size: 'int', sha256: 'string' }, (app, i) => app.transfer.begin(app.user, i));
}
