'use strict';

// Keeps the AI review backlog draining with nobody on the site.
//
// gpt.sweep() already detaches from the request that starts it, so a sweep
// survives closing the tab — what was missing was a trigger other than a page
// load. This walks every onboarded account on a timer and sweeps each one.
//
// In-process rather than a separate cron service: sweep progress lives in a Map
// in this process (src/gpt.js), so a second process could not report on or
// deduplicate against a sweep this one is running. That is also why the service
// must stay at one replica — two would review the same transactions twice and
// bill OpenAI twice.
//
// On by default, hourly. Set SWEEP_INTERVAL_MINUTES=0 to turn it off.

const users = require('./users');
const gpt = require('./gpt');
// Called through the module object rather than destructured, so the tests can
// stand in for a Lunchflow refresh.
const summary = require('./summary');

const MINUTE_MS = 60 * 1000;
// Long enough after boot that a deploy's first requests aren't competing with a
// sweep for the event loop, short enough to still catch up promptly.
const FIRST_RUN_DELAY_MS = 2 * MINUTE_MS;

const DEFAULT_INTERVAL_MINUTES = 60;

// Unset means the default; an explicit 0 (or anything unparseable) means off,
// so a deployment can opt out without editing code.
function intervalMinutes() {
  const configured = process.env.SWEEP_INTERVAL_MINUTES;
  if (configured === undefined || configured === '') return DEFAULT_INTERVAL_MINUTES;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * One pass over every account. gpt.sweep() starts its workers and returns
 * without waiting for them, so the reviews themselves end up running
 * concurrently across accounts, each inside its own per-key concurrency limit.
 * What this loop serializes is only the Lunchflow refresh before each sweep,
 * which is a few seconds and better not fired at every account at once.
 *
 * `queued` is therefore the size of the backlog at kick-off, not work finished
 * by the time this resolves. Returns a per-user summary for the log; never
 * throws.
 */
async function runOnce({ log = console } = {}) {
  const ids = await users.onboardedWithOpenAiKey();
  const results = [];
  for (const userId of ids) {
    try {
      // sweep() reads the cache with preferCached, so without this it would
      // keep re-examining the same stale window and never see new spending.
      await summary.getConverted(userId, { force: true });
      // Returns as soon as the workers are running, not when they finish.
      const status = await gpt.sweep(userId);
      results.push({ userId, queued: status.total || 0 });
    } catch (err) {
      // One account's expired Lunchflow key or exhausted OpenAI quota must not
      // stop the others, or block the next pass.
      log.error(`Background sweep failed for user ${userId}:`, err.message);
      results.push({ userId, error: err.message });
    }
  }
  return results;
}

/**
 * Start the timer. Returns a stop() to clear it (used by the tests and the
 * shutdown path), or null when the scheduler is disabled.
 */
function start({ log = console, delayMs = FIRST_RUN_DELAY_MS } = {}) {
  const minutes = intervalMinutes();
  if (!minutes) {
    log.log('Background AI sweep disabled (SWEEP_INTERVAL_MINUTES=0)');
    return null;
  }

  let running = false; // a slow pass must not overlap the next tick
  const pass = async () => {
    if (running) {
      log.warn('Background sweep still running, skipping this tick');
      return;
    }
    running = true;
    try {
      const results = await runOnce({ log });
      const queued = results.reduce((n, r) => n + (r.queued || 0), 0);
      const failed = results.filter((r) => r.error).length;
      if (queued || failed) {
        log.log(`Background sweep: ${results.length} account(s), ${queued} queued, ${failed} failed to start`);
      }
    } finally {
      running = false;
    }
  };

  const first = setTimeout(pass, delayMs);
  const timer = setInterval(pass, minutes * MINUTE_MS);
  // Neither timer should hold the process open on shutdown.
  first.unref();
  timer.unref();
  log.log(`Background AI sweep every ${minutes} minute(s)`);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { start, runOnce, intervalMinutes };
