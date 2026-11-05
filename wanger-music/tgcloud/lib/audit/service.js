// Audit log: every admin change writes one row (who, what, target, details).
/** @param {{repo: any, clock: any}} deps */
export function createAuditService({ repo, clock }) {
  return {
    /**
     * @param {{telegram_id: number}|null} actor
     * @param {string} action e.g. 'forcejoin.add'
     * @param {string|null} targetType @param {string|number|null} targetId
     * @param {Record<string, any>} [details]
     */
    record: (actor, action, targetType, targetId, details = {}) => repo.insertAudit({
      actor_id: actor ? actor.telegram_id : 0,
      action,
      target_type: targetType,
      target_id: targetId === null || targetId === undefined ? null : String(targetId),
      details: JSON.stringify(details).slice(0, 2000),
      created_at: clock.now(),
    }),
    recent: (n = 10) => repo.recentAudit(n),
  };
}
