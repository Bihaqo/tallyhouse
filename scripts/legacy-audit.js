#!/usr/bin/env node
'use strict';

// Counts the old data shapes the code still carries read-time support for, so
// that support can be deleted on evidence rather than on the assumption that
// everything was migrated.
//
// Run:  DATABASE_URL=postgres://... node scripts/legacy-audit.js
//
// Read-only — it runs SELECTs and nothing else. Point it at production; that is
// the database whose answer decides what is safe to remove.
//
// Each shape below is read but never written back, which is why it can persist
// indefinitely: the app understands it on the way out and leaves the stored row
// alone. So "I migrated" is not the same as "the old shape is gone", and for
// the override kinds in particular a wrong guess silently reclassifies real
// transactions rather than failing loudly.

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL first (the production one, if that is what you mean to check).');
  process.exit(1);
}

const db = require('../src/db');

// Each check names the code that exists only to read the old shape, so a zero
// count points straight at what can go.
const CHECKS = [
  {
    what: 'Rules documents from before categories were unified',
    supports: 'rules.migrate() / rules.isLegacy() / rules.LEGACY_KIND_IDS',
    sql: `SELECT count(*)::int AS n FROM rules
          WHERE jsonb_typeof(doc->'transferPatterns') = 'array'
             OR jsonb_typeof(doc->'investments') = 'array'`,
  },
  {
    what: 'Rules documents still holding the old currencySymbol field',
    supports: 'rules.normalize() and currencies.fromSymbol()',
    sql: `SELECT count(*)::int AS n FROM rules WHERE doc ? 'currencySymbol'`,
  },
  {
    what: 'Overrides stored as a bare legacy kind ("internal", "invest", …)',
    supports: "analytics.overrideFor()'s string branch and its LEGACY_KIND_IDS",
    sql: `SELECT count(*)::int AS n FROM overrides
          WHERE jsonb_typeof(entry) = 'string'
            AND entry #>> '{}' IN ('internal', 'invest', 'renovation', 'tax')`,
  },
  {
    what: 'Overrides carrying a legacy kind inside an object',
    supports: 'the same LEGACY_KIND_IDS translation',
    sql: `SELECT count(*)::int AS n FROM overrides
          WHERE jsonb_typeof(entry) = 'object'
            AND entry->>'kind' IN ('internal', 'invest', 'renovation', 'tax')`,
  },
  {
    what: 'Category pins stored by display name, with no id',
    supports: "analytics.resolveCategory()'s name fallback",
    sql: `SELECT count(*)::int AS n FROM overrides
          WHERE jsonb_typeof(entry) = 'object'
            AND entry ? 'category' AND NOT (entry ? 'categoryId')`,
  },
  {
    what: 'FX rates keyed without a target currency ("USD|2026-06-14")',
    supports: 'the pair rewrite in fx.init()',
    sql: `SELECT count(*)::int AS n FROM fx_rates WHERE pair NOT LIKE '%>%'`,
    // Rates are objective and re-fetchable, so this one is only about not
    // throwing away a cache — nothing breaks if it is dropped.
    harmless: true,
  },
];

async function main() {
  const { rows: [{ n: users }] } = await db.query('SELECT count(*)::int AS n FROM users');
  console.log(`\n${users} account${users === 1 ? '' : 's'} in this database.\n`);

  let live = 0;
  for (const check of CHECKS) {
    const { rows: [{ n }] } = await db.query(check.sql);
    if (n) live += check.harmless ? 0 : 1;
    const mark = n === 0 ? '  clear' : check.harmless ? '  cache' : ' IN USE';
    console.log(`[${mark}] ${check.what}`);
    console.log(`          ${n} row${n === 1 ? '' : 's'} — ${check.supports}`);
    console.log('');
  }

  console.log(live === 0
    ? 'Nothing is relying on the old shapes: the support code above can be deleted.'
    : `${live} shape${live === 1 ? ' is' : 's are'} still stored. Deleting the code that reads`
      + ' them would change how those rows are interpreted, silently.');
  console.log('');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
