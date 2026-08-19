'use strict';

// A complete, self-contained snapshot of everything one user owns: their
// classification rules, manual overrides, AI reviews and running spend, the
// cached transactions, and the FX rates those transactions need. Sessions and
// API keys are deliberately excluded. buildExport produces it; applyImport
// loads one back into a user's account (used by onboarding and settings).

const rules = require('./rules');
const overrides = require('./overrides');
const gpt = require('./gpt');
const fx = require('./fx');
const summary = require('./summary');

// Bump when the export shape changes so an importer can branch on it.
const SCHEMA_VERSION = 1;

async function buildExport(userId, { user = null } = {}) {
  const ai = await gpt.exportData(userId);
  return {
    app: 'tallyhouse',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: user,
    data: {
      rules: await rules.get(userId),
      overrides: await overrides.getAll(userId),
      reviews: ai.reviews,
      aiUsage: ai.usage,
      fxRates: fx.exportRates(),
      transactions: await summary.exportTransactions(userId),
    },
  };
}

// Load an export (as produced by buildExport) into a user's account, replacing
// their rules/overrides/reviews/transactions. Returns { imported: [...] } or
// throws with a clear message on a malformed document.
async function applyImport(userId, doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Import file is not a JSON object');
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported export schemaVersion ${doc.schemaVersion} (expected ${SCHEMA_VERSION})`);
  }
  const data = doc.data;
  if (!data || typeof data !== 'object') throw new Error('Import file has no data section');

  const imported = [];
  const skipped = [];

  if (data.rules !== undefined) {
    const result = await rules.replace(userId, data.rules);
    if (result.error) throw new Error(`Invalid rules in import: ${result.error}`);
    imported.push('rules');
  }
  if (data.overrides && typeof data.overrides === 'object') {
    await overrides.replaceAll(userId, data.overrides);
    imported.push('overrides');
  }
  if (data.reviews || data.aiUsage) {
    await gpt.importData(userId, { reviews: data.reviews, usage: data.aiUsage });
    imported.push('reviews');
  }
  // Exchange rates are deliberately NOT imported. fx_rates is one table shared
  // by every account, so honouring rates from an uploaded file let any user
  // rewrite the numbers everyone else's foreign transactions are converted at —
  // verified by importing "USD|2026-06-14": 999.5 and watching it land globally.
  // Neither bounds-checking nor filling only the gaps closes that: a plausible
  // wrong rate passes both, and seeding a pair nobody has fetched yet still
  // decides what the next account sees. Rates are objective and free to fetch,
  // so the safe move is to let applyExchangeRates() get them from the source.
  // They stay in the export, which is useful for reading offline and harmless.
  if (data.fxRates) skipped.push('fxRates (re-fetched from the rate source instead)');
  if (data.transactions) {
    await summary.importTransactions(userId, data.transactions);
    imported.push('transactions');
  }

  return { imported, skipped };
}

module.exports = { buildExport, applyImport, SCHEMA_VERSION };
