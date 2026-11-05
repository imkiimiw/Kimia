// Dependency injection: builds repositories and services once per invocation and wires them.
// Services receive their dependencies as arguments, so unit tests can pass fakes.
import { createLogger } from './logger.js';
import { OWNER_ID } from '../config/static.js';
import { createUsersRepo } from '../repositories/users.js';
import { createForceJoinRepo } from '../repositories/forcejoin.js';
import { createSettingsRepo } from '../repositories/settings.js';
import { createFlowsRepo } from '../repositories/flows.js';
import { createBroadcastsRepo } from '../repositories/broadcasts.js';
import { createSystemRepo } from '../repositories/system.js';
import { createTelegramClient } from '../telegram/client.js';
import { createSettingsService } from '../settings/service.js';
import { createAuditService } from '../audit/service.js';
import { createAlertsService } from '../alerts/service.js';
import { createUsersService } from '../users/service.js';
import { createFlowsService } from '../bot/flows.js';
import { createForceJoinService } from '../forcejoin/service.js';
import { createBroadcastService } from '../broadcast/service.js';
import { notifyProgress } from '../admin/broadcast_ui.js';

/** Bumped when bootstrap() learns something new to set up. */
const BOOTSTRAP_VERSION = 1;

/** Wall clock. Date.now() advances across awaits on this platform (not during pure CPU work). */
export const systemClock = Object.freeze({ now: () => Math.floor(Date.now() / 1000), ms: () => Date.now() });

/**
 * @param {{kind: string, updateId?: number|null, clock?: {now: () => number, ms: () => number}}} opts
 */
export async function createApp({ kind, updateId = null, clock = systemClock }) {
  const log = createLogger({ update_id: updateId, handler: kind });
  const repos = {
    users: createUsersRepo(),
    forcejoin: createForceJoinRepo(),
    settings: createSettingsRepo(),
    flows: createFlowsRepo(),
    broadcasts: createBroadcastsRepo(),
    system: createSystemRepo(),
  };
  /** @type {any} */
  const app = { kind, updateId, clock, log, repos, lang: 'fa', user: null };
  app.audit = createAuditService({ repo: repos.system, clock });
  app.settings = createSettingsService({ repo: repos.settings, clock, audit: app.audit });
  app.users = createUsersService({ repo: repos.users, clock, audit: app.audit, settings: app.settings });
  app.tg = createTelegramClient({ log, onBlocked: (chatId) => app.users.markBlocked(chatId, true) });
  app.alerts = createAlertsService({
    repo: repos.system, tg: app.tg, clock, log,
    ownerLang: async () => app.users.languageOf(await app.users.get(OWNER_ID)),
  });
  app.flows = createFlowsService({ repo: repos.flows, clock });
  app.forcejoin = createForceJoinService({ repo: repos.forcejoin, users: app.users, tg: app.tg, settings: app.settings, alerts: app.alerts, audit: app.audit, clock, log });
  app.broadcasts = createBroadcastService({
    repo: repos.broadcasts, users: app.users, tg: app.tg, settings: app.settings, audit: app.audit, clock, log,
    notify: (b, info) => notifyProgress(app, b, info),
  });
  await app.settings.load();
  await bootstrap(app);
  return app;
}

/** One-time setup (idempotent): internal rows and the force-join seed. */
async function bootstrap(app) {
  if (Number(await app.settings.get('system.bootstrapped')) >= BOOTSTRAP_VERSION) return;
  await app.settings.ensure('tick.last_at', 0);
  await app.forcejoin.seedIfNeeded();
  await app.settings.setInternal('system.bootstrapped', BOOTSTRAP_VERSION);
  app.log.info('bootstrapped');
}
