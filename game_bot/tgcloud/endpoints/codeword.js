/* { action: state | new | guess, mode: daily | free, lang, word }: Codeword, scored on the server. See lib/solo.js. */
import { endpoint } from '../lib/endpoint.js';
import { codeword } from '../lib/solo.js';

export default endpoint(codeword);
