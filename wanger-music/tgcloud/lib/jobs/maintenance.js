// Maintenance processor: prune processed_updates (48 h), expired flows, old error rows, stale leases.
import { LIMITS } from '../config/static.js';

/** @param {any} app */
export async function runMaintenance(app) {
  const now = app.clock.now();
  const cap = LIMITS.maintenanceDeleteCap;
  return {
    updates: await app.repos.system.pruneUpdates(now - LIMITS.processedUpdatesKeepSeconds, cap),
    flows: await app.flows.deleteExpired(cap),
    errors: await app.repos.system.pruneErrors(LIMITS.errorLogKeep),
    leases: await app.repos.broadcasts.releaseExpired(now),
    orphans: await app.publisher.sweepOrphans(),
  };
}
