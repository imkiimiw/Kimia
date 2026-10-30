/* { room, action: leave | seat | opts | bots | rematch, … }: lobby and end-of-game actions. See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { roomAction } from '../lib/play.js';

export default endpoint(roomAction);
