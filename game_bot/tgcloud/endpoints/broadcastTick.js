/*
 * Owner only. The Mini App's broadcast page calls this about once a second while it is open:
 * { action: tick } sends one batch of the running broadcast, { action: status } only reports,
 * { action: cancel } stops it. See lib/broadcast.js.
 */
import { reportIfFinished } from '../lib/admin.js';
import { cancelBroadcast, currentBroadcast, getBroadcast, progress, sendBatch } from '../lib/broadcast.js';
import { endpoint } from '../lib/endpoint.js';

export default endpoint(async (input, env) => {
  const cur = await currentBroadcast();
  if (!cur) return { broadcast: null };
  if (input.action === 'cancel' && cur.status === 'running') {
    await cancelBroadcast(Number(cur.id));
    return { broadcast: progress(await getBroadcast(Number(cur.id))) };
  }
  if (input.action === 'tick' && cur.status === 'running') {
    const r = await sendBatch(env.tg, Number(cur.id));
    await reportIfFinished(env.tg, env.user.lang, r);
    return { broadcast: progress(r.row), sent: r.sent };
  }
  return { broadcast: progress(cur) };
}, { owner: true, join: false });
