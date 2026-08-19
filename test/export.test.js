'use strict';

process.env.MOCK_DATA = '1';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const { buildExport, applyImport, SCHEMA_VERSION } = require('../src/export');
const summary = require('../src/summary');
const overrides = require('../src/overrides');
const rules = require('../src/rules');

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

test('buildExport assembles a versioned snapshot of a user, minus sessions/keys', { skip }, async () => {
  const userId = await h.freshUser();
  await overrides.setCategory(userId, 'tx-123', 'travel');
  await summary.getSummary(userId); // warms the transaction cache from mock data

  const doc = await buildExport(userId, { user: 'someone@example.com' });

  assert.equal(doc.app, 'tallyhouse');
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.exportedBy, 'someone@example.com');
  assert.ok(!Number.isNaN(Date.parse(doc.exportedAt)));
  assert.deepEqual(
    Object.keys(doc.data).sort(),
    ['aiUsage', 'fxRates', 'overrides', 'reviews', 'rules', 'transactions']
  );
  assert.ok(!('sessions' in doc.data) && !('keys' in doc.data));
  assert.deepEqual(doc.data.overrides['tx-123'], { categoryId: 'travel' });
  assert.ok(Number.isFinite(doc.data.transactions.cachedAt));
  assert.ok(Array.isArray(doc.data.transactions.txs) && doc.data.transactions.txs.length);
  // Each key names both currencies ("USD>GBP|2026-06-14"), so the export says
  // what was converted into what without a field of its own.
  assert.ok(doc.data.fxRates.rates && typeof doc.data.fxRates.rates === 'object');
  for (const pair of Object.keys(doc.data.fxRates.rates)) {
    assert.match(pair, /^[A-Z]{3}>[A-Z]{3}\|\d{4}-\d{2}-\d{2}$/);
  }
});

test('export → applyImport round-trips into another user, isolated from the source', { skip }, async () => {
  const source = await h.freshUser();
  await rules.addPattern(source, { name: 'Coffee', pattern: 'pret' });
  await overrides.set(source, 'tx-999', 'excluded');
  await summary.getSummary(source);
  const doc = await buildExport(source, { user: 'source@example.com' });

  const target = await h.freshUser();
  // Fresh target has none of the source's data.
  assert.ok(!(await rules.get(target)).categories.some((c) => c.name === 'Coffee'));
  assert.deepEqual(await overrides.getAll(target), {});

  const { imported } = await applyImport(target, doc);
  assert.ok(imported.includes('rules') && imported.includes('overrides') && imported.includes('transactions'));

  // Target now mirrors the source.
  assert.ok((await rules.get(target)).categories.some((c) => c.name === 'Coffee'));
  assert.equal((await overrides.getAll(target))['tx-999'], 'excluded');
  assert.ok((await summary.exportTransactions(target)).txs.length);

  // Editing the target does not affect the source (independent rows).
  await rules.addPattern(target, { name: 'OnlyTarget', pattern: 'zzz' });
  assert.ok(!(await rules.get(source)).categories.some((c) => c.name === 'OnlyTarget'));
});

test('applyImport rejects an unsupported schema version', { skip }, async () => {
  const userId = await h.freshUser();
  await assert.rejects(applyImport(userId, { schemaVersion: 999, data: {} }), /schemaVersion/);
  await assert.rejects(applyImport(userId, null), /JSON object/);
});

test('an import cannot rewrite the exchange rates every account shares', { skip }, async () => {
  const fx = require('../src/fx');
  const db = require('../src/db');
  await fx.init();

  const pair = 'USD>GBP|2026-06-14';
  const before = await db.query('SELECT rate FROM fx_rates WHERE pair = $1', [pair]);
  const userId = await h.freshUser();

  const { imported, skipped } = await applyImport(userId, {
    schemaVersion: SCHEMA_VERSION,
    data: { fxRates: { baseCurrency: 'GBP', rates: { [pair]: { rate: 999.5, rateDate: '2026-06-14' } } } },
  });

  // fx_rates is one table for the whole deployment, so honouring an uploaded
  // rate would change what everyone else's foreign transactions convert at.
  const after = await db.query('SELECT rate FROM fx_rates WHERE pair = $1', [pair]);
  assert.deepEqual(before.rows, after.rows, 'the shared rate table is untouched');
  assert.ok(!imported.includes('fxRates'));
  assert.ok(skipped.some((s) => s.startsWith('fxRates')), 'and the caller is told it was skipped');
});

test('there is no way to write rates into the shared table from user input', () => {
  // Nothing should re-introduce this: the export still carries rates (useful to
  // read offline), but no import path may apply them.
  assert.equal(typeof require('../src/fx').importRates, 'undefined');
});
