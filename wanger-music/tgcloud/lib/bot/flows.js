// Persisted multi-step input (user_flows): one pending flow per user, expiring after 15 minutes.
import { LIMITS } from '../config/static.js';

/** @param {{repo: any, clock: any}} deps */
export function createFlowsService({ repo, clock }) {
  return {
    /** @returns {Promise<{flow: string, step: string, data: any} | null>} */
    async get(userId) {
      const row = await repo.get(userId, clock.now());
      if (!row) return null;
      let data = {};
      try {
        data = row.data ? JSON.parse(row.data) : {};
      } catch {
        data = {};
      }
      return { flow: row.flow, step: row.step, data };
    },
    start: (userId, flow, data = {}, step = 'input') => repo.set(userId, flow, step, JSON.stringify(data), clock.now() + LIMITS.flowTtlSeconds),
    clear: (userId) => repo.clear(userId),
    deleteExpired: (cap) => repo.deleteExpired(clock.now(), cap),
  };
}
