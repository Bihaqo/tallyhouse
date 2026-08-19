'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// The scheduler pulls users, refreshes the cache and calls gpt.sweep. Stub all
// three through the module cache so this stays a pure-logic test with no DB.
const users = require('../src/users');
const gpt = require('../src/gpt');
const summary = require('../src/summary');
const scheduler = require('../src/sweep-scheduler');

const quietLog = { log() {}, warn() {}, error() {} };

function withStubs({ ids, sweep, refresh }, run) {
  const original = {
    onboarded: users.onboardedWithOpenAiKey,
    sweep: gpt.sweep,
    getConverted: summary.getConverted,
  };
  users.onboardedWithOpenAiKey = async () => ids;
  gpt.sweep = sweep;
  summary.getConverted = refresh || (async () => ({ accounts: [], txs: [] }));
  return run().finally(() => {
    users.onboardedWithOpenAiKey = original.onboarded;
    gpt.sweep = original.sweep;
    summary.getConverted = original.getConverted;
  });
}

test('runOnce sweeps every onboarded account in turn', async () => {
  const swept = [];
  await withStubs({
    ids: [1, 2, 3],
    sweep: async (id) => {
      swept.push(id);
      return { total: id * 10 };
    },
  }, async () => {
    const results = await scheduler.runOnce({ log: quietLog });
    // Kicked off in id order; the reviews themselves then run concurrently.
    assert.deepEqual(swept, [1, 2, 3]);
    assert.deepEqual(results.map((r) => r.queued), [10, 20, 30]);
  });
});

test('one account failing does not stop the others', async () => {
  const swept = [];
  await withStubs({
    ids: [1, 2, 3],
    sweep: async (id) => {
      if (id === 2) throw new Error('OpenAI key is not set');
      swept.push(id);
      return { total: 1 };
    },
  }, async () => {
    const results = await scheduler.runOnce({ log: quietLog });
    assert.deepEqual(swept, [1, 3]);
    assert.equal(results[1].error, 'OpenAI key is not set');
    assert.equal(results[2].queued, 1); // the pass continued past the failure
  });
});

test('a failing cache refresh is caught before the sweep runs', async () => {
  let sweptAnyway = false;
  await withStubs({
    ids: [1],
    sweep: async () => {
      sweptAnyway = true;
      return { total: 0 };
    },
    refresh: async () => {
      throw new Error('Lunchflow key was rejected');
    },
  }, async () => {
    const results = await scheduler.runOnce({ log: quietLog });
    assert.equal(sweptAnyway, false);
    assert.match(results[0].error, /Lunchflow/);
  });
});

test('the scheduler runs hourly by default and can be switched off', async () => {
  const original = process.env.SWEEP_INTERVAL_MINUTES;
  try {
    delete process.env.SWEEP_INTERVAL_MINUTES;
    assert.equal(scheduler.intervalMinutes(), 60); // on by default

    // An explicit 0 opts out; so does anything that isn't a positive number,
    // rather than silently falling back to the default.
    for (const off of ['0', '-5', 'soon']) {
      process.env.SWEEP_INTERVAL_MINUTES = off;
      assert.equal(scheduler.intervalMinutes(), 0, off);
    }
    process.env.SWEEP_INTERVAL_MINUTES = '0';
    assert.equal(scheduler.start({ log: quietLog }), null);

    // An empty value is the same as not setting it at all.
    process.env.SWEEP_INTERVAL_MINUTES = '';
    assert.equal(scheduler.intervalMinutes(), 60);

    process.env.SWEEP_INTERVAL_MINUTES = '15';
    assert.equal(scheduler.intervalMinutes(), 15);
    const stop = await withStubs({ ids: [], sweep: async () => ({}) },
      async () => scheduler.start({ log: quietLog }));
    assert.equal(typeof stop, 'function');
    stop();
  } finally {
    if (original === undefined) delete process.env.SWEEP_INTERVAL_MINUTES;
    else process.env.SWEEP_INTERVAL_MINUTES = original;
  }
});

test('a slow pass does not overlap the next tick', async () => {
  process.env.SWEEP_INTERVAL_MINUTES = '15';
  let started = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  try {
    await withStubs({
      ids: [1],
      sweep: async () => {
        started++;
        await blocked;
        return { total: 0 };
      },
    }, async () => {
      // Fire the first pass immediately, then a second while it is still going.
      const stop = scheduler.start({ log: quietLog, delayMs: 0 });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(started, 1);
      release();
      stop();
    });
  } finally {
    delete process.env.SWEEP_INTERVAL_MINUTES;
  }
});
