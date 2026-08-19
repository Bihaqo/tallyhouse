'use strict';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

test('foreign transactions use the preceding ECB business-day rate, persisted to Postgres', { skip }, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [
      { date: '2026-06-12', base: 'EUR', quote: 'GBP', rate: 0.86305 },
      { date: '2026-06-12', base: 'EUR', quote: 'USD', rate: 1.1567 },
    ],
  });

  try {
    const fx = require('../src/fx');
    await fx.init();
    const [converted] = await fx.applyExchangeRates([{
      id: 'usd', date: '2026-06-14', amount: -6.99, currency: 'USD',
    }]);
    const expectedRate = 0.86305 / 1.1567;
    assert.equal(converted.exchange_rate_date, '2026-06-12');
    assert.ok(Math.abs(converted.exchange_rate - expectedRate) < 1e-12);
    assert.ok(Math.abs(converted.base_amount - (-6.99 * expectedRate)) < 1e-12);

    // The rate was written to the shared fx_rates table, keyed by both
    // currencies — the same source converts into whatever an account is kept in.
    const { rows } = await h.query("SELECT rate_date FROM fx_rates WHERE pair = 'USD>GBP|2026-06-14'");
    assert.equal(rows[0].rate_date, '2026-06-12');
  } finally {
    global.fetch = originalFetch;
  }
});

// An account kept in euros wants its dollars in euros, not converted to sterling
// and labelled with a € — which is what a single hard-coded base would do.
test('transactions convert into the account currency, not a fixed one', { skip }, async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => [
      { date: '2026-06-12', base: 'EUR', quote: 'GBP', rate: 0.86305 },
      { date: '2026-06-12', base: 'EUR', quote: 'USD', rate: 1.1567 },
    ],
  });

  try {
    const fx = require('../src/fx');
    await fx.init();
    const txs = [{ id: 'usd', date: '2026-06-14', amount: -6.99, currency: 'USD' }];

    const [inEuros] = await fx.applyExchangeRates(txs, 'EUR');
    assert.equal(inEuros.base_currency, 'EUR');
    assert.ok(Math.abs(inEuros.exchange_rate - 1 / 1.1567) < 1e-12);

    // The account's own currency needs no conversion at all.
    const [euroTx] = await fx.applyExchangeRates(
      [{ id: 'eur', date: '2026-06-14', amount: -10, currency: 'EUR' }], 'EUR');
    assert.equal(euroTx.exchange_rate, 1);
    assert.equal(euroTx.base_amount, -10);

    // Unsupported targets fall back rather than producing nulls for everything.
    const [fallback] = await fx.applyExchangeRates(txs, 'XYZ');
    assert.equal(fallback.base_currency, 'GBP');
  } finally {
    global.fetch = originalFetch;
  }
});

// Rates cached before the target was part of the key were all GBP rates.
test('rates stored without a target are read as the rates they were', { skip }, async () => {
  const fx = require('../src/fx');
  await h.query(
    `INSERT INTO fx_rates (pair, rate, rate_date) VALUES ('SEK|2026-05-04', 0.0771, '2026-05-02')
     ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate`
  );
  await fx.init();

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('should not refetch a rate already cached'); };
  try {
    const [converted] = await fx.applyExchangeRates(
      [{ id: 'sek', date: '2026-05-04', amount: -100, currency: 'SEK' }], 'GBP');
    assert.equal(converted.exchange_rate, 0.0771);
  } finally {
    global.fetch = originalFetch;
  }
});
