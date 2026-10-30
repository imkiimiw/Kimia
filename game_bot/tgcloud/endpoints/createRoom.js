/* { game }: a new room with the caller in the first seat (then shared with the invite button). See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { createRoom } from '../lib/play.js';

export default endpoint(createRoom);
