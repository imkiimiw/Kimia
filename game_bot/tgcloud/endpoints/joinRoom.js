/* { room, game }: opens a room from a startapp payload, creating it if new; takes a free seat. See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { joinRoom } from '../lib/play.js';

export default endpoint(joinRoom);
