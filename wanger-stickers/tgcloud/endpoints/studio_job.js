// POST /api/studio_job { job } — what the user sent in chat (kind, size), refused if not theirs.
import { runEndpoint } from '../lib/endpoint.js';

export default function (input, ctx) {
  return runEndpoint('studio_job', input, ctx, { job: 'string' }, async (app, { job }) => {
    const j = await app.transfer.job(app.user, job);
    return { job: j.id, kind: j.source_kind, mime: j.mime, size: j.size };
  });
}
