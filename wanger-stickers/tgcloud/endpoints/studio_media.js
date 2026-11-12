// POST /api/studio_media { job, idx } — one chunk (base64) of the job's file; the first call
// downloads it from Telegram (≤ 20 MB) into raw chunks. Refused if the job isn't the caller's.
import { runEndpoint } from '../lib/endpoint.js';

export default function (input, ctx) {
  return runEndpoint('studio_media', input, ctx, { job: 'string', idx: 'int' }, (app, { job, idx }) => app.transfer.media(app.user, job, idx));
}
