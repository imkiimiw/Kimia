// The tick (spec 10.7): background work without cron. runTick runs the processors in order, each
// within the time budget. Triggers: piggyback after updates (never inline), the owner's buttons,
// and endpoints/opsTick (GitHub Actions schedule). Timing depends on traffic and the schedule.
import { runMaintenance } from './maintenance.js';
import { runMonitor } from '../core/health.js';
import { askMissingLanguages } from '../admin/sources_ui.js';

/** Processors in order (spec 10.7): maintenance → broadcast → publications → digests → archive → search index → stats (Phase 7: aggregation every 15 min, retention daily) → backup (Phase 8: weekly, when on) → monitor (Phase 8: warnings → throttled owner alerts). */
const PROCESSORS = [
  { name: 'maintenance', run: (app) => runMaintenance(app) },
  { name: 'broadcast', run: (app, deadlineMs) => app.broadcasts.runBatch({ deadlineMs }) },
  { name: 'publications', run: (app, deadlineMs) => app.worker.run({ deadlineMs }) },
  { name: 'digests', run: (app) => app.publisher.runDigest() },
  { name: 'archive', run: (app, deadlineMs) => app.catalog.runArchiveBacklog({ deadlineMs }) },
  { name: 'search_index', run: (app, deadlineMs) => app.search.runReindex({ deadlineMs }) },
  { name: 'stats', run: (app) => app.stats.runTick() },
  { name: 'backup', run: (app, _deadlineMs, trigger) => app.backup.runWeekly(trigger) },
  { name: 'languages', run: (app) => askMissingLanguages(app) },
  { name: 'monitor', run: (app) => runMonitor(app) },
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
      results[p.name] = await p.run(app, deadlineMs, trigger);
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
