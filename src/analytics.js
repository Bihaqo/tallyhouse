'use strict';

const currencies = require('./currencies');

// The active rules document for the current (synchronous) classify/summary call.
// Rules live per-user in the database now, so the caller passes the doc into the
// public entry points (classify, buildSummary, listTransactions, previewMatches)
// and it's stashed here for the helper functions. This is safe because none of
// these functions await — a single classify pass never interleaves with another.
let activeRules = null;

// The currency this account's totals are in — what fx.js converted every
// transaction into, and so the one an unconverted transaction is already in.
const baseOf = (doc) => currencies.normalize(doc && doc.currency) || currencies.DEFAULT;

// Manual override states a transaction can carry (see src/overrides.js).
// 'excluded' drops the transaction from every chart and total — a separate axis
// from the category list, which is why it survived unification. 'spend' forces
// a transaction back to ordinary spending with no category pinned.
const OVERRIDE_STATES = ['spend', 'excluded'];

// Pre-unification kinds, still present in stored overrides. They map onto the
// categories they became; ids are stable across renames, names are not.
const LEGACY_KIND_IDS = {
  internal: 'internal-transfers',
  invest: 'investments',
  renovation: 'renovation',
  tax: 'taxes',
};

/**
 * An overrides entry is one of:
 *   "spend" | "excluded"                       (current, compact)
 *   "internal" | "invest" | "renovation" | "tax"   (legacy kinds)
 *   { kind?, category?, categoryId? }
 * Normalizes to { kind, categoryId, category }. Legacy kinds are translated
 * here on read and never written back, so a rollback needs no migration.
 */
function overrideFor(overrides, id) {
  const entry = overrides[id];
  const fromKind = (kind) => (LEGACY_KIND_IDS[kind] ? { kind: null, categoryId: LEGACY_KIND_IDS[kind] } : null);

  if (typeof entry === 'string') {
    const legacy = fromKind(entry);
    if (legacy) return { ...legacy, category: null };
    return { kind: OVERRIDE_STATES.includes(entry) ? entry : null, categoryId: null, category: null };
  }
  if (entry && typeof entry === 'object') {
    const legacy = fromKind(entry.kind);
    return {
      kind: legacy ? null : OVERRIDE_STATES.includes(entry.kind) ? entry.kind : null,
      categoryId: typeof entry.categoryId === 'string' && entry.categoryId.trim()
        ? entry.categoryId
        : legacy ? legacy.categoryId : null,
      // Legacy pins stored the display name; resolved against the list below.
      category: typeof entry.category === 'string' && entry.category.trim() ? entry.category : null,
    };
  }
  return { kind: null, categoryId: null, category: null };
}

// The lowercased merchant+description a pattern is matched against. Every
// transaction is tested against every category's patterns (and, during refund
// matching, once per candidate pair), so the string is built once per
// transaction and remembered for as long as the object lives.
const haystackCache = new WeakMap();

function haystack(tx) {
  let text = haystackCache.get(tx);
  if (text === undefined) {
    text = `${tx.merchant || ''} ${tx.description || ''}`.toLowerCase();
    haystackCache.set(tx, text);
  }
  return text;
}

// True when `needle` appears in `text` at the start of a word — the character
// before it is absent or not alphanumeric.
function includesAtWordStart(text, needle) {
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1])) return true;
    from = at;
  }
}

// Supports plain substrings, an exact merchant/description prefix ("=railway"),
// and a trailing "*" wildcard ("top-up by *").
function matchesPattern(text, pattern, tx) {
  const p = pattern.toLowerCase();
  if (p.startsWith('=')) {
    const exact = p.slice(1).trim();
    return String(tx.merchant || '').trim().toLowerCase() === exact ||
      String(tx.description || '').trim().toLowerCase() === exact;
  }
  if (p.endsWith('*')) return text.includes(p.slice(0, -1).trimEnd());
  // A trailing space asks for a whole word ("pub " must not match "public").
  // Guard the front of the match too: haystack() joins merchant and description
  // with a space, so without this "bp " matches "Exchanged to GBP" through the
  // join, and the BP petrol rule silently swallows currency exchanges.
  if (p.endsWith(' ')) return includesAtWordStart(text, p);
  return text.includes(p);
}

function matchesAny(tx, patterns) {
  const text = haystack(tx);
  return patterns.some((p) => matchesPattern(text, p, tx));
}

/**
 * Transfers between our own accounts, detected automatically. Returns a Set of
 * transaction ids (pure — does not mutate the transactions). Two mechanisms:
 *  1. Pair matching: an outflow in one account and an inflow of the same
 *     amount/currency in another account within `windowDays` of each other.
 *  2. Explicit description patterns from config/settings.json.
 *
 * Pair matching only fires when *neither* side is already explained by a
 * category rule. Equal round amounts collide constantly across several
 * accounts — a £50 massage and a £50 payment from yourself three days apart are
 * not the same money — and without this guard the pairing consumes a real
 * payment to explain a transfer that its own pattern already covered, erasing
 * both from every total. If a rule already names a transaction, believe it.
 */
function autoInternalIds(txs, windowDays = 4) {
  const inflows = new Map(); // "currency|abs-amount" -> inflow txs
  for (const tx of txs) {
    if (tx.amount > 0) {
      const key = `${tx.currency}|${Math.abs(tx.amount).toFixed(2)}`;
      if (!inflows.has(key)) inflows.set(key, []);
      inflows.get(key).push(tx);
    }
  }
  const explained = new Set();
  for (const tx of txs) {
    if (activeRules.categories.some((cat) => matchesAny(tx, cat.patterns))) explained.add(tx.id);
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const internal = new Set();
  const usedInflow = new Set(); // an inflow can only pair with one outflow
  for (const tx of txs) {
    if (tx.amount >= 0 || explained.has(tx.id)) continue;
    const key = `${tx.currency}|${Math.abs(tx.amount).toFixed(2)}`;
    const candidates = inflows.get(key) || [];
    const match = candidates.find(
      (c) =>
        !usedInflow.has(c.id) &&
        !explained.has(c.id) &&
        c.account_id !== tx.account_id &&
        Math.abs(new Date(c.date) - new Date(tx.date)) <= windowDays * dayMs
    );
    if (match) {
      internal.add(tx.id);
      internal.add(match.id);
      usedInflow.add(match.id);
    }
  }
  const absorbs = activeRules.categories.find((c) => c.autoTransfers);
  if (absorbs) {
    for (const tx of txs) {
      if (!internal.has(tx.id) && matchesAny(tx, absorbs.patterns)) internal.add(tx.id);
    }
  }
  return internal;
}

/* ---------- the unified category list ---------- */

const categoryById = (id) => activeRules.categories.find((c) => c.id === id) || null;

// Resolve a stored category reference: id first, display name as the fallback
// for pins written before categories had ids.
function resolveCategory({ categoryId, category }) {
  return (categoryId && categoryById(categoryId))
    || (category && activeRules.categories.find((c) => c.name.toLowerCase() === category.toLowerCase()))
    || null;
}

// First category whose patterns match, in list order.
function categorize(tx) {
  return activeRules.categories.find((cat) => matchesAny(tx, cat.patterns)) || null;
}

// The category auto-detected transfers land in.
function autoTransferCategory() {
  return activeRules.categories.find((c) => c.autoTransfers) || null;
}

const transferPatterns = () => (autoTransferCategory() || { patterns: [] }).patterns;

const categoryNameOf = (id) => (categoryById(id) || {}).name || null;

// Refund matching skips transfers and explicit exclusions: neither is a real
// purchase a refund could belong to. Covers the legacy 'internal' kind too,
// which overrideFor() has already resolved to the transfer category.
function isExcludedFromReturns(manual) {
  if (manual.kind === 'excluded') return true;
  const cat = resolveCategory(manual);
  return Boolean(cat && cat.autoTransfers);
}

function compactMerchant(value) {
  return value.replace(/[^a-z0-9]/g, '');
}

/**
 * The derived merchant forms every similarity check needs, memoized on the raw
 * merchant string. Unicode normalization is expensive and a few thousand
 * transactions share a few hundred distinct merchants, so deriving these once
 * per name rather than once per comparison is most of the win.
 */
const merchantForms = new Map();
const MERCHANT_FORMS_MAX = 50000;

function merchantInfo(tx) {
  const raw = String(tx.merchant || '');
  let info = merchantForms.get(raw);
  if (!info) {
    const normalized = raw
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
    info = {
      normalized,
      compact: compactMerchant(normalized),
      // Card statements commonly append a per-order reference after an
      // asterisk; this is the stable portion before it.
      starred: compactMerchant(normalized.split('*')[0]),
    };
    // Unbounded only in theory, but don't let a pathological feed grow it forever.
    if (merchantForms.size >= MERCHANT_FORMS_MAX) merchantForms.clear();
    merchantForms.set(raw, info);
  }
  return info;
}

function normalizedMerchant(tx) {
  return merchantInfo(tx).normalized;
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/**
 * Similarity between two merchants' derived forms, 0..1. `floor` is the score
 * the caller cares about: the edit distance can never beat 1 - lengthGap/longest,
 * so a candidate that cannot reach the floor is rejected without running the
 * O(n*m) matrix. Passing 0 (the default) always computes the exact score.
 */
function similarityOf(left, right, floor = 0) {
  if (!left.compact || !right.compact) return 0;
  if (left.compact === right.compact) return 1;
  if (left.starred.length >= 4 && left.starred === right.starred) return 0.99;

  const longest = Math.max(left.compact.length, right.compact.length);
  const gap = Math.abs(left.compact.length - right.compact.length);
  if (floor > 0 && 1 - gap / longest < floor) return 0;
  return 1 - editDistance(left.compact, right.compact) / longest;
}

function merchantSimilarity(a, b) {
  return similarityOf(merchantInfo(a), merchantInfo(b));
}

const MERCHANT_MATCH_THRESHOLD = 0.82;

function merchantsMatch(a, b) {
  return merchantSimilarity(a, b) >= MERCHANT_MATCH_THRESHOLD;
}

/**
 * Move merchant refunds back to the purchase they relate to. A positive
 * transaction is matched to the most recent earlier debit from the same
 * merchant and currency whose remaining value can cover the refund.
 */
function returnAdjustments(txs, overrides = {}) {
  const remaining = new Map(
    txs.filter((tx) => tx.amount < 0).map((tx) => [tx.id, -tx.amount])
  );
  const purchaseRefunds = new Map();
  const purchaseReturns = new Map();
  const returnedBy = new Map();
  const patterns = transferPatterns();
  const refunds = txs
    .filter((tx) =>
      tx.amount > 0 &&
      !tx.is_pending &&
      normalizedMerchant(tx) &&
      !matchesAny(tx, patterns)
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  // Candidate purchases, grouped by currency and then by merchant. Everything
  // here used to be re-tested for every (refund, purchase) pair — with a few
  // thousand transactions that is millions of edit-distance computations over
  // the same handful of merchant names. The conditions that don't depend on the
  // refund are applied once, and the merchant grouping means a refund only ever
  // looks at purchases from merchants that actually match it.
  const byCurrency = new Map();
  txs.forEach((tx, index) => {
    if (tx.amount >= 0 || tx.is_pending) return;
    if (matchesAny(tx, patterns)) return;
    if (isExcludedFromReturns(overrideFor(overrides, tx.id))) return;
    const info = merchantInfo(tx);
    if (!info.compact) return; // can never reach the similarity threshold
    let bucket = byCurrency.get(tx.currency);
    if (!bucket) byCurrency.set(tx.currency, (bucket = { groups: new Map(), byStarred: new Map() }));
    // Keyed on both forms, so every purchase in a group scores identically
    // against any given refund and the group can be accepted as a whole.
    const key = `${info.compact}|${info.starred}`;
    let group = bucket.groups.get(key);
    if (!group) {
      bucket.groups.set(key, (group = { info, entries: [], stamp: 0 }));
      // An asterisk-prefix hit clears the threshold whatever the lengths, so it
      // needs its own index alongside the length-ordered one built below.
      if (info.starred.length >= 4) {
        const list = bucket.byStarred.get(info.starred);
        if (list) list.push(group);
        else bucket.byStarred.set(info.starred, [group]);
      }
    }
    group.entries.push({ tx, index });
  });

  // Length-ordered, so the only groups an edit distance could ever accept sit in
  // one contiguous slice (see matchingGroups) and can be walked with a plain
  // indexed loop — no per-length arrays or iterators in the hot path.
  for (const bucket of byCurrency.values()) {
    bucket.sorted = [...bucket.groups.values()]
      .sort((a, b) => a.info.compact.length - b.info.compact.length);
  }

  // First index in `sorted` whose merchant is at least `length` characters.
  function lowerBound(sorted, length) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].info.compact.length < length) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Which merchant groups match a given refund merchant. Memoized because
  // distinct merchants are far fewer than transactions.
  const groupCache = new Map();
  let visit = 0; // stamps groups already considered, cheaper than a per-call Set
  function matchingGroups(bucket, currency, info) {
    const cacheKey = `${currency}|${info.compact}|${info.starred}`;
    const hit = groupCache.get(cacheKey);
    if (hit) return hit;

    const groups = [];
    const stamp = ++visit;
    const consider = (group) => {
      if (group.stamp === stamp) return;
      group.stamp = stamp;
      const similarity = similarityOf(group.info, info, MERCHANT_MATCH_THRESHOLD);
      if (similarity >= MERCHANT_MATCH_THRESHOLD) groups.push({ group, similarity });
    };

    const starredGroups = info.starred.length >= 4 ? bucket.byStarred.get(info.starred) : null;
    if (starredGroups) for (const group of starredGroups) consider(group);

    // An edit distance is never smaller than the length gap, so only merchants
    // whose compact length is within a factor of the threshold can match.
    const length = info.compact.length;
    const longest = Math.floor(length / MERCHANT_MATCH_THRESHOLD);
    const sorted = bucket.sorted;
    for (let i = lowerBound(sorted, Math.ceil(length * MERCHANT_MATCH_THRESHOLD)); i < sorted.length; i++) {
      const group = sorted[i];
      if (group.info.compact.length > longest) break;
      consider(group);
    }

    groupCache.set(cacheKey, groups);
    return groups;
  }

  for (const refund of refunds) {
    if (isExcludedFromReturns(overrideFor(overrides, refund.id))) continue;
    const info = merchantInfo(refund);
    if (!info.compact) continue;
    const bucket = byCurrency.get(refund.currency);
    if (!bucket) continue;

    const candidates = [];
    for (const { group, similarity } of matchingGroups(bucket, refund.currency, info)) {
      for (const entry of group.entries) {
        if (entry.tx.date >= refund.date) continue;
        if (!(remaining.get(entry.tx.id) >= refund.amount)) continue;
        candidates.push({ tx: entry.tx, index: entry.index, similarity });
      }
    }
    if (!candidates.length) continue;
    // Most recent purchase first, then the closest merchant match; the trailing
    // index comparison reproduces the stable sort over transaction order.
    candidates.sort((a, b) =>
      b.tx.date.localeCompare(a.tx.date) || b.similarity - a.similarity || a.index - b.index
    );
    const match = candidates[0].tx;

    remaining.set(match.id, remaining.get(match.id) - refund.amount);
    purchaseRefunds.set(match.id, (purchaseRefunds.get(match.id) || 0) + refund.amount);
    if (!purchaseReturns.has(match.id)) purchaseReturns.set(match.id, []);
    purchaseReturns.get(match.id).push(refund);
    returnedBy.set(refund.id, match);
  }
  return { purchaseRefunds, purchaseReturns, returnedBy };
}

/**
 * The last classification computed for a given transaction array, so the
 * several endpoints one page load hits — the summary, the outlier inbox, the
 * AI sweep, a month's list — share one pass instead of repeating it. Keyed on
 * the array itself, and re-checked against the overrides and rules that went
 * into it, so any change to the inputs recomputes rather than serving stale
 * numbers. Callers treat the result as read-only (they filter/map before
 * sorting), which is what makes sharing it safe.
 */
const classifyMemo = new WeakMap();

// Order-independent digest of the inputs classify() depends on besides `txs`.
function inputsKey(overrides, rulesDoc) {
  let key = JSON.stringify(rulesDoc);
  for (const id of Object.keys(overrides).sort()) key += `${id}=${JSON.stringify(overrides[id])}`;
  return key;
}

/**
 * Resolve every transaction to an effective classification, folding in manual
 * overrides. Returns an array of { tx, kind, ... } in the input order. `kind` is
 * one of 'excluded' | 'tracked' | 'spend'. A manual override
 * always wins; without one, automatic special-payment detection applies.
 */
function classify(txs, overrides = {}, rulesDoc = activeRules) {
  activeRules = rulesDoc;
  const key = inputsKey(overrides, rulesDoc);
  const memo = classifyMemo.get(txs);
  if (memo && memo.key === key) return memo.result;
  const result = classifyUncached(txs, overrides, rulesDoc);
  classifyMemo.set(txs, { key, result });
  return result;
}

function classifyUncached(txs, overrides, rulesDoc) {
  activeRules = rulesDoc;
  const base = baseOf(rulesDoc);
  const returns = returnAdjustments(txs, overrides);
  const auto = autoInternalIds(txs);
  // A same-merchant purchase/return pair is stronger evidence than the generic
  // equal-amount cross-account transfer rule.
  for (const [refundId, purchase] of returns.returnedBy) {
    auto.delete(refundId);
    auto.delete(purchase.id);
  }
  return txs.map((tx) => {
    const manual = overrideFor(overrides, tx.id);
    const pinned = resolveCategory(manual); // manual category, or null

    // Precedence: an explicit exclusion, then a pinned category, then the
    // auto-transfer detector, then the rules in list order.
    let category = null;
    let kind;
    if (manual.kind === 'excluded') {
      kind = 'excluded';
    } else if (pinned) {
      category = pinned;
      kind = pinned.excludeFromSpending ? 'tracked' : 'spend';
    } else if (manual.kind === 'spend') {
      kind = 'spend'; // forced back to ordinary spending, no category pinned
    } else if (auto.has(tx.id)) {
      category = autoTransferCategory();
      kind = 'tracked';
    } else {
      category = categorize(tx);
      kind = category && category.excludeFromSpending ? 'tracked' : 'spend';
    }
    // The two flags are independent: a category can get its own dashboard
    // section while still counting as ordinary spending (a spotlight on
    // Groceries), and one excluded from spending can have no section at all
    // (internal transfers, which drop out of every total).
    const tracker = category && category.tracker ? category : null;
    const refundAmount = returns.purchaseRefunds.get(tx.id) || 0;
    const returnTransactions = returns.purchaseReturns.get(tx.id) || [];
    const returnOf = returns.returnedBy.get(tx.id) || null;
    const exchangeRate = Number.isFinite(tx.exchange_rate)
      ? tx.exchange_rate
      : String(tx.currency || base).toUpperCase() === base ? 1 : null;
    const effectiveAmount = returnOf ? 0 : round2(tx.amount + refundAmount);

    return {
      tx,
      kind,
      override: manual.kind,
      // The category this landed in, whatever its flags — trackers included.
      categoryId: category ? category.id : null,
      // Any manual pin, tracker categories included — the row dropdown needs it
      // to preselect, which categoryOverride (spend-only) cannot express.
      pinnedCategoryId: pinned ? pinned.id : null,
      trackerId: tracker ? tracker.id : null,
      trackerName: tracker ? tracker.name : null,
      // Spending category name, or 'Other' for unmatched outflows. Kept as a
      // name because the donut charts and the AI prompt speak in names.
      category: kind === 'spend' && tx.amount < 0 ? (category ? category.name : 'Other') : null,
      categoryOverride: kind === 'spend' && tx.amount < 0 && pinned ? pinned.name : null,
      effectiveAmount,
      effectiveBaseAmount: exchangeRate === null ? null : round2(effectiveAmount * exchangeRate),
      refundAmount: round2(refundAmount),
      returnTransactions,
      returnOf,
    };
  });
}

/**
 * Readable names for accounts, as a Map of id -> label.
 *
 * Banks hand back whatever they like: Revolut names every sub-account after the
 * same IBAN, Barclays calls them "Account 1" and "Account 2". Three rows
 * labelled GB00BANK00000000000000 are useless in a transaction list, so fold in
 * the institution, shorten a raw account number to its last four digits, and
 * where that still collides, separate them by the currency they actually hold.
 */
function accountLabels(accounts, txs = []) {
  const currencies = new Map(); // account id -> { CUR: count }
  for (const tx of txs) {
    if (!currencies.has(tx.account_id)) currencies.set(tx.account_id, {});
    const seen = currencies.get(tx.account_id);
    seen[tx.currency] = (seen[tx.currency] || 0) + 1;
  }
  const dominantCurrency = (id) => {
    const seen = currencies.get(id);
    if (!seen) return null;
    return Object.entries(seen).sort((a, b) => b[1] - a[1])[0][0];
  };

  const base = new Map();
  for (const account of accounts) {
    const name = String(account.name || '').trim();
    const institution = String(account.institution_name || '').trim();
    // An IBAN or long account number carries no meaning past its last digits.
    const isIdentifier = name.length >= 10 && !/\s/.test(name) && /\d{4}/.test(name);
    let label;
    if (institution && isIdentifier) label = `${institution} ···${name.slice(-4)}`;
    else if (institution && name) label = `${institution} ${name}`;
    else label = name || institution || `Account ${account.id}`;
    base.set(account.id, label);
  }

  const counts = {};
  for (const label of base.values()) counts[label] = (counts[label] || 0) + 1;
  const labels = new Map();
  for (const [id, label] of base) {
    const currency = counts[label] > 1 ? dominantCurrency(id) : null;
    labels.set(id, currency ? `${label} ${currency}` : label);
  }
  return labels;
}

function monthKey(date) {
  return date.slice(0, 7); // YYYY-MM
}

function lastMonths(n) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Turn raw transactions into everything the dashboard needs.
 * Spending = outflows, excluding internal transfers, investments, renovations and taxes.
 */
function buildSummary(accounts, txs, overrides = {}, rulesDoc = activeRules) {
  activeRules = rulesDoc;
  const classified = classify(txs, overrides, rulesDoc);

  const months = lastMonths(12);
  const currentMonth = months[months.length - 1];
  const fullMonths = months.slice(0, -1); // exclude the partial current month from averages
  const inWindow = new Set(months);

  const monthlySpend = Object.fromEntries(months.map((m) => [m, 0]));
  const monthlyChartSpend = Object.fromEntries(months.map((m) => [m, 0]));
  const monthlyIncome = Object.fromEntries(months.map((m) => [m, 0]));
  const incomeByPayer = {};
  const catThisMonth = {};
  const catFullMonths = {};
  const noChart = new Set(activeRules.categories.filter((c) => c.excludeFromChart).map((c) => c.name));

  // One accumulator per tracker category, in the order they appear in settings.
  const trackers = new Map();
  for (const cat of activeRules.categories.filter((c) => c.tracker)) {
    trackers.set(cat.id, {
      id: cat.id,
      name: cat.name,
      excludeFromSpending: Boolean(cat.excludeFromSpending),
      months: Object.fromEntries(months.map((m) => [m, 0])),
      byMerchant: {},
    });
  }
  let internalCount = 0;
  let excludedCount = 0;
  let unconvertedCount = 0;
  // Category id -> how much was kept out of every total because it is excluded
  // from spending and has no tracker section to surface it.
  const hiddenByCategory = new Map();

  for (const { tx, kind, trackerId, categoryId, category, effectiveBaseAmount } of classified) {
    if (tx.is_pending) continue;
    const m = monthKey(tx.date);
    if (!inWindow.has(m)) continue;
    if (kind === 'excluded') {
      excludedCount++;
      continue;
    }
    if (kind === 'tracked' && !trackerId) {
      // Excluded from spending with nowhere to show: internal transfers, but
      // also any category the user excluded without ticking "tracker". That
      // money used to vanish into a count labelled "internal transfers", so
      // record which category actually absorbed it.
      internalCount++;
      const cat = categoryById(categoryId);
      const key = cat ? cat.id : 'unmatched';
      if (!hiddenByCategory.has(key)) {
        hiddenByCategory.set(key, { id: key, name: cat ? cat.name : 'Unmatched transfers', count: 0, total: 0 });
      }
      const entry = hiddenByCategory.get(key);
      entry.count++;
      if (effectiveBaseAmount !== null && effectiveBaseAmount < 0) entry.total += -effectiveBaseAmount;
      continue;
    }
    if (effectiveBaseAmount === null) {
      unconvertedCount++;
      continue;
    }
    if (effectiveBaseAmount >= 0) {
      // Money coming in, once transfers between our own accounts and anything
      // excluded are out of the way. It is not spending, but it was previously
      // dropped on the floor, which left no way to see earnings or what was
      // actually kept.
      if (kind === 'spend' && effectiveBaseAmount > 0) {
        monthlyIncome[m] += effectiveBaseAmount;
        const who = tx.merchant || tx.description || 'Unknown';
        incomeByPayer[who] = (incomeByPayer[who] || 0) + effectiveBaseAmount;
      }
      continue;
    }
    const spend = -effectiveBaseAmount;

    // A tracker section is additive: a category that still counts as spending
    // gets both its own section and its place in the totals below.
    const t = trackerId ? trackers.get(trackerId) : null;
    if (t) {
      t.months[m] += spend;
      // Curated per-payee names are gone; a tracker breaks down by merchant.
      const who = tx.merchant || 'Unknown';
      if (!t.byMerchant[who]) t.byMerchant[who] = { total: 0, thisMonth: 0 };
      t.byMerchant[who].total += spend;
      if (m === currentMonth) t.byMerchant[who].thisMonth += spend;
    }
    if (kind !== 'spend') continue; // excluded from spending: no totals, no donuts

    monthlySpend[m] += spend;
    if (!noChart.has(category)) monthlyChartSpend[m] += spend;
    if (m === currentMonth) catThisMonth[category] = (catThisMonth[category] || 0) + spend;
    else catFullMonths[category] = (catFullMonths[category] || 0) + spend;
  }

  const catAvg = Object.fromEntries(
    Object.entries(catFullMonths).map(([c, total]) => [c, total / fullMonths.length])
  );
  const fullMonthTotal = fullMonths.reduce((s, m) => s + monthlySpend[m], 0);

  const toSorted = (obj) =>
    Object.entries(obj)
      .map(([category, amount]) => ({ category, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount);

  const trackerList = [...trackers.values()].map((t) => ({
    id: t.id,
    name: t.name,
    excludeFromSpending: t.excludeFromSpending,
    thisMonth: round2(t.months[currentMonth]),
    total12m: round2(Object.values(t.months).reduce((a, b) => a + b, 0)),
    months: months.map((m) => round2(t.months[m])),
    breakdown: Object.entries(t.byMerchant)
      .map(([name, v]) => ({ name, total12m: round2(v.total), thisMonth: round2(v.thisMonth) }))
      .sort((a, b) => b.total12m - a.total12m),
  }));

  const fullMonthIncome = fullMonths.reduce((s, m) => s + monthlyIncome[m], 0);
  const now = new Date();
  // How far into the current month we are, so the partial bar and the tile can
  // say so instead of being read as a finished month.
  const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const daysElapsed = nowMonth === currentMonth ? now.getDate() : null;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const labels = accountLabels(accounts, txs);

  return {
    currency: activeRules.currency,
    months: months.map((m) => ({
      month: m,
      spend: round2(monthlySpend[m]),
      chartSpend: round2(monthlyChartSpend[m]),
      income: round2(monthlyIncome[m]),
      net: round2(monthlyIncome[m] - monthlySpend[m]),
      partial: m === currentMonth,
    })),
    categoriesThisMonth: toSorted(catThisMonth),
    categoriesYearAvg: toSorted(catAvg),
    // Categories ticked "exclude from chart", by name, so the donuts leave out
    // the same ones the spending line already does. Sent rather than inferred
    // because the client only ever sees category names and totals.
    chartExcluded: [...noChart],
    trackers: trackerList,
    totals: {
      spendThisMonth: round2(monthlySpend[currentMonth]),
      avgMonthlySpend: round2(fullMonthTotal / fullMonths.length),
      incomeThisMonth: round2(monthlyIncome[currentMonth]),
      avgMonthlyIncome: round2(fullMonthIncome / fullMonths.length),
      avgMonthlyNet: round2((fullMonthIncome - fullMonthTotal) / fullMonths.length),
    },
    // Where the money came in from, largest first — the counterpart to the
    // category donuts, which only ever showed money going out.
    incomeByPayer: Object.entries(incomeByPayer)
      .map(([name, amount]) => ({ name, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
    partialMonth: { month: currentMonth, daysElapsed, daysInMonth },
    // Categories held out of the bar chart but still inside every total, so the
    // chart can admit the gap rather than quietly understating a month.
    categoriesOffChart: [...noChart],
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      label: labels.get(a.id) || a.name,
      institution: a.institution_name,
    })),
    internalTransfersIgnored: internalCount,
    // What the count above is actually made of, largest first. A category that
    // is excluded from spending without being a tracker has no section of its
    // own, so this is the only place its money is visible at all.
    hiddenFromSpending: [...hiddenByCategory.values()]
      .map((e) => ({ ...e, total: round2(e.total) }))
      .sort((a, b) => b.total - a.total),
    manuallyExcluded: excludedCount,
    unconvertedCurrencyTransactions: unconvertedCount,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Transactions falling within `months` (a Set of 'YYYY-MM', or a single string),
 * newest first, each tagged with its effective classification so they can be
 * listed, filtered and re-tagged in the UI.
 */
function listTransactions(accounts, txs, months, overrides = {}, rulesDoc = activeRules) {
  activeRules = rulesDoc;
  const base = baseOf(rulesDoc);
  const monthSet = months instanceof Set ? months : new Set([months]);
  const accountName = accountLabels(accounts, txs);
  return classify(txs, overrides)
    .filter(({ tx }) => !tx.is_pending && monthSet.has(monthKey(tx.date)))
    .map(({ tx, kind, override, trackerName, categoryId, pinnedCategoryId, category, categoryOverride, effectiveAmount, effectiveBaseAmount, refundAmount, returnTransactions, returnOf }) => ({
      id: tx.id,
      categoryId, // the category this landed in, tracker and transfer ones included
      categoryOverride, // manual category name, or null when the keyword rules decided
      // The pinned id, so the row dropdown can preselect the right option.
      categoryIdOverride: pinnedCategoryId,
      date: tx.date,
      merchant: tx.merchant || tx.description || '—',
      amount: effectiveAmount,
      baseAmount: effectiveBaseAmount,
      baseCurrency: tx.base_currency || base,
      exchangeRate: tx.exchange_rate ?? (tx.currency === base ? 1 : null),
      exchangeRateDate: tx.exchange_rate_date || null,
      originalAmount: round2(tx.amount),
      refundAmount,
      returnTransactions: returnTransactions.map((refund) => ({
        id: refund.id,
        date: refund.date,
        amount: round2(refund.amount),
      })),
      returnOf: returnOf ? { id: returnOf.id, date: returnOf.date } : null,
      currency: tx.currency,
      account: accountName.get(tx.account_id) || '—',
      kind, // 'excluded' | 'tracked' | 'spend'
      override, // the manual state, or null if automatic
      // For spend rows this is the category; the UI groups the detail pie by it.
      label: trackerName || (kind === 'spend' && tx.amount < 0 ? category : null),
      raw: tx.raw || tx, // full original transaction, shown in the expandable detail view
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// The trailing 12-month window the dashboard covers (oldest first).
function windowMonths() {
  return lastMonths(12);
}

// Human label for a classified item's current bucket, used by rule previews
// and the AI reviewer.
function currentLabel(item) {
  if (item.kind === 'excluded') return 'Excluded from analytics';
  if (item.kind === 'tracked') {
    return item.trackerName || categoryNameOf(item.categoryId) || 'Internal transfer';
  }
  // A refund already netted against its purchase is not income, and calling it
  // that misled both the reader and the AI reviewer, which duly reported the
  // "wrong category" for a matched Amazon Prime refund.
  if (item.returnOf) return 'Refund';
  if (item.tx.amount >= 0) return 'Income';
  return item.category || 'Other';
}

/**
 * Which transactions would a pattern list match? Powers the rule preview in
 * the settings UI, the add-rule modal, and the AI reviewer's preview_rule
 * tool, so a proposed rule can be sanity-checked before it's applied.
 */
function previewMatches(accounts, txs, patterns, overrides = {}, limit = 50, rulesDoc = activeRules) {
  activeRules = rulesDoc;
  const clean = patterns.filter((p) => typeof p === 'string' && p.trim());
  const accountName = accountLabels(accounts, txs);
  const matched = classify(txs, overrides, rulesDoc)
    .filter(({ tx }) => !tx.is_pending && clean.length && matchesAny(tx, clean))
    .sort((a, b) => (a.tx.date < b.tx.date ? 1 : a.tx.date > b.tx.date ? -1 : 0));

  const byLabel = {};
  for (const item of matched) {
    const label = currentLabel(item);
    byLabel[label] = (byLabel[label] || 0) + 1;
  }
  return {
    count: matched.length,
    byLabel,
    matches: matched.slice(0, limit).map((item) => ({
      id: item.tx.id,
      date: item.tx.date,
      merchant: item.tx.merchant || '—',
      description: item.tx.description || '',
      amount: round2(item.tx.amount),
      currency: item.tx.currency,
      account: accountName.get(item.tx.account_id) || '—',
      label: currentLabel(item),
    })),
  };
}

// Below merchantsMatch's 0.82: this answers "what else looks like this?" for a
// human, so it errs towards showing a near miss rather than hiding it.
const SIMILAR_THRESHOLD = 0.7;

/**
 * Transactions whose merchant fuzzily resembles the given one — the same
 * normalized edit-distance used for refund matching, so "AIRCONCO (UK) LTD"
 * finds "Airconco Ltd". Returns previewMatches' shape (so the same renderer
 * handles both) plus each match's similarity and the converted total.
 */
function similarMatches(accounts, txs, txId, overrides = {}, limit = 50, rulesDoc = activeRules,
  threshold = SIMILAR_THRESHOLD) {
  activeRules = rulesDoc;
  const accountName = accountLabels(accounts, txs);
  const classified = classify(txs, overrides, rulesDoc);
  const target = classified.find((item) => String(item.tx.id) === String(txId));
  if (!target) return { count: 0, byLabel: {}, matches: [], totalBase: 0, target: null };

  const scored = [];
  const targetInfo = merchantInfo(target.tx);
  for (const item of classified) {
    if (item.tx.id === target.tx.id || item.tx.is_pending) continue;
    // The floor lets an obvious mismatch be rejected on length alone.
    const similarity = similarityOf(merchantInfo(item.tx), targetInfo, threshold);
    if (similarity >= threshold) scored.push({ item, similarity });
  }
  scored.sort((a, b) => b.similarity - a.similarity
    || (a.item.tx.date < b.item.tx.date ? 1 : a.item.tx.date > b.item.tx.date ? -1 : 0));

  const byLabel = {};
  let totalBase = 0;
  for (const { item } of scored) {
    const label = currentLabel(item);
    byLabel[label] = (byLabel[label] || 0) + 1;
    totalBase += item.effectiveBaseAmount || 0;
  }
  return {
    count: scored.length,
    byLabel,
    totalBase: round2(totalBase),
    target: { id: target.tx.id, merchant: target.tx.merchant || '—', label: currentLabel(target) },
    matches: scored.slice(0, limit).map(({ item, similarity }) => ({
      id: item.tx.id,
      date: item.tx.date,
      merchant: item.tx.merchant || '—',
      description: item.tx.description || '',
      amount: round2(item.tx.amount),
      currency: item.tx.currency,
      account: accountName.get(item.tx.account_id) || '—',
      label: currentLabel(item),
      similarity: Math.round(similarity * 100) / 100,
    })),
  };
}

module.exports = {
  buildSummary,
  listTransactions,
  windowMonths,
  classify,
  returnAdjustments,
  previewMatches,
  similarMatches,
  currentLabel,
  matchesAny,
  merchantSimilarity,
  accountLabels,
  SIMILAR_THRESHOLD,
  OVERRIDE_STATES,
};
