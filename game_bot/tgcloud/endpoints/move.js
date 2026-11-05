/* { room, ver, action }: a move in the game; checked by the rules in lib/games/*. See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { move } from '../lib/play.js';

export default endpoint(move);
