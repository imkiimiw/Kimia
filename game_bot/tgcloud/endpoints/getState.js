/* { room, since }: the polling call. { same: true } if nothing changed since version `since`. See lib/play.js. */
import { endpoint } from '../lib/endpoint.js';
import { getState } from '../lib/play.js';

export default endpoint(getState);
