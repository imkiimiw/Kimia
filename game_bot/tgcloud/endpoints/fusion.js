/* { action: start } → a seed; { action: submit, run, moves } → the replayed score. See lib/solo.js. */
import { endpoint } from '../lib/endpoint.js';
import { fusionGame } from '../lib/solo.js';

export default endpoint(fusionGame);
