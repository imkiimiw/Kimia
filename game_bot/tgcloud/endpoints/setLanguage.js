/* { lang }: the user's language, used everywhere (bot, inline results, Mini App). */
import { endpoint, fail } from '../lib/endpoint.js';
import { LANGS } from '../lib/i18n/index.js';
import { setLang } from '../lib/store.js';

export default endpoint(async (input, env) => {
  if (!LANGS.includes(input.lang)) throw fail('BAD_LANG');
  await setLang(env.user.user_id, input.lang);
  return { lang: input.lang };
}, { join: false });
