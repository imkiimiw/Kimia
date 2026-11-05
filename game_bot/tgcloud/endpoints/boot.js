/*
 * The Mini App's first call: who the user is (language, owner?) and whether they have joined the
 * forced-join channels (if not: which ones are missing). Also records the visit.
 */
import { OWNER_ID } from '../lib/config.js';
import { endpoint } from '../lib/endpoint.js';
import { joinStatus } from '../lib/join.js';

export default endpoint(async (input, env) => {
  const join = await joinStatus(env.tg, env.user.user_id);
  return {
    me: { id: env.user.user_id, name: env.user.first_name || '', lang: env.user.lang, owner: env.user.user_id === OWNER_ID },
    join,
  };
}, { join: false });
