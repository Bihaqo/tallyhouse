'use strict';

// Classification rules as editable data, one document per user in Postgres.
// config/settings.json ships the defaults a brand-new account starts from; the
// first edit writes the user's own row and that wins from then on.
//
// One flat, ordered list of categories. Each carries its own patterns and two
// flags, which is all the old hard-coded transferPatterns/investments/
// renovations/taxes/categories split ever expressed:
//
//   excludeFromSpending  kept out of spending totals and the category donuts
//   tracker              gets its own tiles, chart and table on the dashboard
//
// Precedence is list order, first match wins. `id` is stable across renames —
// overrides and legacy kinds resolve against it, never the display name.

const db = require('./db');
const currencies = require('./currencies');

/**
 * What a brand-new account starts from.
 *
 * Deliberately ships no keyword patterns. Patterns are personal data — they
 * name the individuals and small businesses a household pays, so a real set
 * committed here would publish one family's cleaner, contractors and relatives
 * to everyone who installs this, and hand them to every new user as defaults.
 *
 * The one category that remains carries no patterns and exists because the
 * transfer detector needs somewhere to put the pairs it finds; without an
 * autoTransfers category they land in an unnamed bucket. Spending categories are
 * suggested during onboarding from the user's own transactions, and patterns are
 * added one at a time from the AI review on a row, where the preview shows
 * exactly which transactions each one would catch before it is applied.
 */
const DEFAULTS = require('../config/settings.json');

// Ids the legacy per-transaction override kinds map onto. Kept in the shipped
// defaults so a migrated document lands on the same ids every time.
const LEGACY_KIND_IDS = {
  internal: 'internal-transfers',
  invest: 'investments',
  renovation: 'renovation',
  tax: 'taxes',
};

// Concurrent OpenAI review calls for this account's key. Per-user because the
// limit is per key; the env var is only the default for accounts that have not
// set their own. Capped because reviews are token-bound — past a handful the
// extra parallelism just buys 429s.
const CONCURRENCY_DEFAULT = Math.min(10, Math.max(1, Number(process.env.OPENAI_CONCURRENCY) || 2));
const CONCURRENCY_MAX = 10;

const concurrencyOf = (doc) =>
  (doc && Number.isInteger(doc.openaiConcurrency) && doc.openaiConcurrency >= 1
    ? Math.min(CONCURRENCY_MAX, doc.openaiConcurrency)
    : CONCURRENCY_DEFAULT);

/**
 * The two settings that decide what the AI review costs an account: how far
 * back it looks, and whether it may search the web for merchants it does not
 * recognise. Both are chosen during setup and editable in Settings → AI review.
 *
 * The search is the expensive half — roughly three quarters of the ~1¢ a review
 * costs — and it is also what sends a merchant name to a search engine, so it is
 * a switch rather than something baked into the prompt.
 *
 * Defaults are read per call, not at load time, so a deployment (and the tests)
 * can change the env without reloading the module. They only apply to documents
 * that say nothing: an account that has chosen keeps its choice.
 */
const MONTHS_MAX = 24;
const monthsDefault = () =>
  Math.min(MONTHS_MAX, Math.max(1, Number(process.env.OPENAI_SWEEP_MONTHS) || 12));
const webSearchDefault = () => process.env.OPENAI_WEB_SEARCH !== '0';

const monthsOf = (doc) =>
  (doc && Number.isInteger(doc.aiMonths) && doc.aiMonths >= 1
    ? Math.min(MONTHS_MAX, doc.aiMonths)
    : monthsDefault());

const webSearchOf = (doc) =>
  (doc && typeof doc.aiWebSearch === 'boolean' ? doc.aiWebSearch : webSearchDefault());

/**
 * A copy of `doc` carrying the AI settings chosen during setup. Fields that are
 * not being set are left alone rather than written as defaults, so a document
 * keeps following the deployment default until someone actually chooses.
 */
function withAiSettings(doc, { months, webSearch } = {}) {
  const next = clone(doc);
  if (months !== undefined) next.aiMonths = months;
  if (webSearch !== undefined) next.aiWebSearch = webSearch;
  return next;
}

const clone = (doc) => JSON.parse(JSON.stringify(doc));

function slugify(name, taken = new Set()) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function isPatternList(list) {
  return Array.isArray(list) && list.every((p) => typeof p === 'string' && p.trim());
}

const isLegacy = (doc) => Boolean(doc) && (Array.isArray(doc.transferPatterns) || Array.isArray(doc.investments));

/**
 * Fold a pre-unification document into the flat category list. The four
 * hard-coded groups become four categories; each group's entries collapse into
 * one pattern list, because the per-payee names only ever fed a breakdown table
 * that now groups by merchant. Nothing is written back — this runs on read, so
 * a rollback leaves stored documents untouched.
 */
function migrate(doc) {
  const categories = [];
  const taken = new Set();
  const push = (id, name, patterns, extra) => {
    taken.add(id);
    categories.push({ id, name, patterns, excludeFromSpending: false, tracker: false, ...extra });
  };
  const flatten = (entries) => {
    const patterns = [];
    for (const entry of entries || []) {
      for (const p of entry.patterns || []) if (!patterns.includes(p)) patterns.push(p);
    }
    return patterns;
  };

  push(LEGACY_KIND_IDS.internal, 'Internal transfers', [...(doc.transferPatterns || [])],
    { excludeFromSpending: true, autoTransfers: true });
  push(LEGACY_KIND_IDS.invest, 'Investments', flatten(doc.investments),
    { excludeFromSpending: true, tracker: true });
  push(LEGACY_KIND_IDS.renovation, 'Renovation', flatten(doc.renovations),
    { excludeFromSpending: true, tracker: true });
  push(LEGACY_KIND_IDS.tax, 'Taxes', flatten(doc.taxes),
    { excludeFromSpending: true, tracker: true });

  for (const cat of doc.categories || []) {
    const id = slugify(cat.name, taken);
    // excludeFromChart is carried through when a document already has it, but
    // nothing here sets it: it used to be switched on for a category literally
    // named "Car", which was one household's preference applied to everybody.
    push(id, cat.name, [...(cat.patterns || [])],
      cat.excludeFromChart ? { excludeFromChart: true } : {});
  }
  return { currency: currencies.fromSymbol(doc.currencySymbol) || currencies.DEFAULT, categories };
}

/**
 * Bring a document written before the currency setting existed up to the
 * current shape.
 *
 * Those documents hold `currencySymbol`, a free-text display string ("£") that
 * was printed in front of totals which were converted to GBP whatever it said.
 * currencies.fromSymbol() reads what it can out of that; see the note there on
 * why an unreadable one falls back rather than failing.
 *
 * Only documents carrying that old field are touched. A current one is handed
 * back untouched even when its currency is wrong, so a bad value from a client
 * is rejected by validate() instead of being quietly redenominated to the
 * default — which would change every total on the dashboard without saying so.
 *
 * Applied on read, like migrate(), so nothing is rewritten until the user next
 * saves and a rollback finds its documents exactly as it left them.
 */
function normalize(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  if (!('currencySymbol' in doc)) return doc;
  const { currencySymbol, ...rest } = doc;
  return {
    ...rest,
    currency: currencies.normalize(doc.currency)
      || currencies.fromSymbol(currencySymbol)
      || currencies.DEFAULT,
  };
}

// Returns an error message, or null when the document is a valid rules doc.
function validate(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'rules must be an object';
  if (!currencies.isSupported(doc.currency)) {
    return 'currency must be one of the supported currency codes';
  }
  if (!Array.isArray(doc.categories)) return 'categories must be an array';
  if (doc.openaiConcurrency !== undefined) {
    const n = doc.openaiConcurrency;
    if (!Number.isInteger(n) || n < 1 || n > CONCURRENCY_MAX) {
      return `openaiConcurrency must be a whole number between 1 and ${CONCURRENCY_MAX}`;
    }
  }
  if (doc.aiMonths !== undefined) {
    const n = doc.aiMonths;
    if (!Number.isInteger(n) || n < 1 || n > MONTHS_MAX) {
      return `aiMonths must be a whole number between 1 and ${MONTHS_MAX}`;
    }
  }
  if (doc.aiWebSearch !== undefined && typeof doc.aiWebSearch !== 'boolean') {
    return 'aiWebSearch must be true or false';
  }

  const ids = new Set();
  const names = new Set();
  const allowed = new Set(['id', 'name', 'patterns', 'excludeFromSpending', 'tracker',
    'excludeFromChart', 'autoTransfers']);
  for (const cat of doc.categories) {
    if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return 'every category must be an object';
    if (typeof cat.id !== 'string' || !cat.id.trim()) return 'every category needs a non-empty id';
    if (typeof cat.name !== 'string' || !cat.name.trim()) return `category "${cat.id}" needs a non-empty name`;
    if (ids.has(cat.id)) return `duplicate category id "${cat.id}"`;
    ids.add(cat.id);
    const nameKey = cat.name.trim().toLowerCase();
    if (names.has(nameKey)) return `duplicate category name "${cat.name}"`;
    names.add(nameKey);
    if (!isPatternList(cat.patterns)) {
      return `patterns for "${cat.name}" must be an array of non-empty strings`;
    }
    for (const flag of ['excludeFromSpending', 'tracker', 'excludeFromChart', 'autoTransfers']) {
      if (cat[flag] !== undefined && typeof cat[flag] !== 'boolean') {
        return `${flag} on "${cat.name}" must be true or false`;
      }
    }
    const extra = Object.keys(cat).find((k) => !allowed.has(k));
    if (extra) return `unknown field "${extra}" on "${cat.name}"`;
  }
  if (doc.categories.filter((c) => c.autoTransfers).length > 1) {
    return 'only one category can absorb auto-detected transfers';
  }
  return null;
}

// The user's rules document, or a fresh copy of the defaults if they've never
// edited theirs. Legacy documents are migrated on the way out.
async function get(userId) {
  const { rows } = await db.query('SELECT doc FROM rules WHERE user_id = $1', [userId]);
  if (!rows.length) return clone(DEFAULTS);
  return isLegacy(rows[0].doc) ? migrate(rows[0].doc) : normalize(rows[0].doc);
}

// Every category id, for validating a pinned override.
async function categoryIds(userId) {
  return (await get(userId)).categories.map((c) => c.id);
}

// Categories a transaction can actually be spending in — what the AI reviewer
// is allowed to suggest and what the donut charts show.
async function categoryNames(userId) {
  const doc = await get(userId);
  return doc.categories.filter((c) => !c.excludeFromSpending).map((c) => c.name);
}

// Replace the whole document. Returns { rules } or { error }.
async function replace(userId, next) {
  // Normalized before it is checked, so a data export taken before the currency
  // setting changed shape still imports instead of failing validation on a
  // field that no longer exists.
  const normalized = normalize(next);
  const error = validate(normalized);
  if (error) return { error };
  const doc = clone(normalized);
  // Stored in one canonical form, so "eur" from a client and "EUR" from the
  // dropdown are the same setting to everything downstream.
  doc.currency = currencies.normalize(doc.currency);
  await db.query(
    `INSERT INTO rules (user_id, doc) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET doc = EXCLUDED.doc`,
    [userId, JSON.stringify(doc)]
  );
  return { rules: doc };
}

/**
 * Add a single pattern to a category, creating a plain spending category when
 * the name is new (that's how the add-rule modal handles an unseen payee).
 * Returns { rules } or { error }. Adding a duplicate pattern is a no-op.
 */
async function addPattern(userId, { categoryId, name, pattern }) {
  if (typeof pattern !== 'string' || !pattern.trim()) return { error: 'pattern must be a non-empty string' };
  // Leading/trailing spaces are meaningful in patterns ("pub " avoids
  // "public"), so the pattern is stored exactly as given.
  const next = clone(await get(userId));

  let cat = categoryId ? next.categories.find((c) => c.id === categoryId) : null;
  if (!cat && typeof name === 'string' && name.trim()) {
    const key = name.trim().toLowerCase();
    cat = next.categories.find((c) => c.name.toLowerCase() === key);
    if (!cat) {
      cat = {
        id: slugify(name, new Set(next.categories.map((c) => c.id))),
        name: name.trim(),
        patterns: [],
        excludeFromSpending: false,
        tracker: false,
      };
      next.categories.push(cat);
    }
  }
  if (!cat) return { error: 'categoryId or name is required' };
  if (!cat.patterns.includes(pattern)) cat.patterns.push(pattern);
  return replace(userId, next);
}

/**
 * Turn accepted onboarding suggestions into a valid rules document.
 *
 * Patterns start empty on purpose — the suggestion step proposes what the
 * buckets are, and the per-row AI review fills them in one at a time where the
 * preview shows exactly what each would catch. Ids are slugged from the names so
 * later renames don't orphan the overrides pinned to them.
 *
 * Two things are enforced rather than trusted: at most one category may absorb
 * auto-detected transfers, and there must be one, or the pairs the detector
 * finds end up in an unnamed bucket.
 */
function documentFromSuggestions(suggestions, { currency } = {}) {
  const taken = new Set();
  const categories = [];
  for (const entry of Array.isArray(suggestions) ? suggestions : []) {
    const name = String((entry && entry.name) || '').trim();
    if (!name) continue;
    if (categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
    const id = slugify(name, taken);
    taken.add(id);
    const cat = {
      id,
      name,
      patterns: [],
      excludeFromSpending: Boolean(entry.excludeFromSpending),
      tracker: Boolean(entry.tracker),
    };
    // First one wins; a second is dropped rather than failing validation.
    if (entry.autoTransfers && !categories.some((c) => c.autoTransfers)) {
      cat.autoTransfers = true;
      cat.excludeFromSpending = true; // a transfer is never spending
    }
    categories.push(cat);
  }

  if (!categories.some((c) => c.autoTransfers)) {
    const shipped = clone(DEFAULTS.categories.find((c) => c.autoTransfers));
    if (shipped && !taken.has(shipped.id)) categories.unshift(shipped);
  }
  return {
    currency: currencies.normalize(currency) || DEFAULTS.currency,
    categories,
  };
}

module.exports = {
  get, replace, addPattern, validate, migrate, normalize, categoryNames, categoryIds,
  documentFromSuggestions, withAiSettings,
  concurrencyOf, LEGACY_KIND_IDS, CONCURRENCY_DEFAULT, CONCURRENCY_MAX,
  monthsOf, monthsDefault, webSearchOf, webSearchDefault, MONTHS_MAX,
};
