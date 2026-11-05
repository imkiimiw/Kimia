// The route registry: every callback route and every flow, in one table. The router validates
// callback_data against it, checks the route's permission on the server, then runs it.
import * as user from './user.js';
import * as panel from '../admin/panel.js';
import * as forcejoinUi from '../admin/forcejoin_ui.js';
import * as usersUi from '../admin/users_ui.js';
import * as settingsUi from '../admin/settings_ui.js';
import * as statusUi from '../admin/status_ui.js';
import * as broadcastUi from '../admin/broadcast_ui.js';
import * as musicUi from '../admin/music_ui.js';
import * as importUi from '../admin/import_ui.js';
import * as searchUi from './search_ui.js';
import * as artistsUi from '../admin/artists_ui.js';
import * as sourcesUi from '../admin/sources_ui.js';
import * as destinationsUi from '../admin/destinations_ui.js';

/**
 * @typedef {{ns: string, action: string, args: string[], perm: string|null, gate?: boolean,
 *   run: (app: any, user: any, args: any[], cq: any) => Promise<{toast?: string, alert?: boolean}|void>}} CallbackRoute
 * @typedef {{perm: string|null, maxInput?: number, run: (app: any, user: any, message: any, flow: any) => Promise<any>}} FlowDef
 */

/** @type {CallbackRoute[]} */
export const CALLBACK_ROUTES = [
  ...user.routes,
  ...panel.routes,
  ...forcejoinUi.routes,
  ...usersUi.routes,
  ...settingsUi.routes,
  ...statusUi.routes,
  ...broadcastUi.routes,
  ...musicUi.routes,
  ...importUi.routes,
  ...searchUi.routes,
  ...artistsUi.routes,
  ...sourcesUi.routes,
  ...destinationsUi.routes,
];

/** @type {Map<string, CallbackRoute>} */
const BY_KEY = new Map();
for (const r of CALLBACK_ROUTES) {
  const key = `${r.ns}:${r.action}`;
  if (BY_KEY.has(key)) throw new Error(`duplicate callback route ${key}`);
  BY_KEY.set(key, r);
}

/** @param {string} ns @param {string} action */
export const findRoute = (ns, action) => BY_KEY.get(`${ns}:${action}`) || null;

/**
 * Flows that take the next message as input. 'fj_pending' only remembers a /start payload
 * while the user joins the channels, so it takes no input.
 * @type {Record<string, FlowDef>}
 */
export const FLOWS = {
  ...forcejoinUi.flows,
  ...usersUi.flows,
  ...settingsUi.flows,
  ...broadcastUi.flows,
  ...musicUi.flows,
  ...artistsUi.flows,
  ...sourcesUi.flows,
  ...destinationsUi.flows,
};
