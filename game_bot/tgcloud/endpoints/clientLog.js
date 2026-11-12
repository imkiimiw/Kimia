/*
 * { kind, data }: the Mini App reporting a launch or a client-side failure (see schema: client_log).
 * Nothing here is trusted or acted on; it is only kept for the owner to read.
 */
import { endpoint } from '../lib/endpoint.js';
import { addClientLog } from '../lib/store.js';

export default endpoint(async (input, env) => {
  const kind = String(input.kind || '').slice(0, 40);
  if (!/^[a-z0-9-]{1,40}$/.test(kind)) return { ok: false };
  let data = '';
  try {
    data = JSON.stringify(input.data === undefined ? null : input.data).slice(0, 600);
  } catch (err) {
    data = '';
  }
  await addClientLog(env.user.user_id, kind, data);
  return { ok: true };
}, { join: false });
