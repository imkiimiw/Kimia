/* "I've joined": checks the forced-join channels again, without the cache. */
import { endpoint } from '../lib/endpoint.js';
import { joinStatus } from '../lib/join.js';

export default endpoint(async (input, env) => joinStatus(env.tg, env.user.user_id, { force: true }), { join: false });
