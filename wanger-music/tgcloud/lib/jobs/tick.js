// The tick (spec 10.7): background work without cron. runTick runs the processors in order, each
// within the time budget. Triggers: piggyback after updates (never inline), the owner's buttons,
// and endpoints/opsTick (GitHub Actions schedule). Timing depends on traffic and the schedule.
import { runMaintenance } from './maintenance.js';

/** Processors in order; Phase 6 adds publications and approval digests here. */
const PROCESSORS = [
  { name: 'maintenance', run: (app) => runMaintenance(app) },
  { name: 'broadcast', run: (app, deadlineMs) => app.broadcasts.runBatch({ deadlineMs }) },
  { name: 'archive', run: (app, deadlineMs) => app.catalog.runArchiveBacklog({ deadlineMs }) },
];

/**
 * @param {any} app @param {'piggyback'|'manual'|'scheduled'} trigger @param {number} budgetMs
 * @returns {Promise<{at: number, trigger: string, ms: number, results: Record<string, any>}>}
 */
export async function runTick(app, trigger, budgetMs) {
  const startMs = app.clock.ms();
  const deadlineMs = startMs + budgetMs;
  /** @type {Record<string, any>} */
  const results = {};
  for (const p of PROCESSORS) {
    if (app.clock.ms() >= deadlineMs) {
      results[p.name] = 'skipped:budget';
      continue;
    }
    try {
      results[p.name] = await p.run(app, deadlineMs);
    } catch (e) {
      results[p.name] = 'error';
      await app.alerts.recordError({ handler: `tick:${p.name}`, err: e, context: { trigger } });
    }
  }
  const summary = { at: app.clock.now(), trigger, ms: app.clock.ms() - startMs, results };
  await app.settings.setInternal('tick.last', summary);
  if (trigger !== 'piggyback') await app.settings.setInternal('tick.last_at', summary.at);
  app.log.info('tick', { trigger, duration_ms: summary.ms });
  return summary;
}

/** Runs a small tick if the last one is older than the interval; one conditional UPDATE elects the winner. */
export async function maybePiggyback(app) {
  const interval = Number(await app.settings.get('tick.interval_seconds'));
  if (!(await app.settings.claimTick(app.clock.now(), interval))) return null;
  return runTick(app, 'piggyback', Number(await app.settings.get('tick.piggyback_budget_ms')));
}
