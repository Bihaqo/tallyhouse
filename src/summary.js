'use strict';

const { buildSummary, listTransactions, windowMonths, previewMatches, similarMatches } = require('./analytics');
const overrides = require('./overrides');
const { applyExchangeRates } = require('./fx');
const rules = require('./rules');
const users = require('./users');
const demo = require('./demo');
const db = require('./db');

const mock = require('./mock');
const lunchflow = require('./lunchflow');

const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 15) * 60 * 1000;
// How far past the TTL a cached pull may still be handed straight back while it
// refreshes behind the request. Within this, serving instantly is worth a few
// minutes of drift. Beyond it — coming back after a long gap, or a restart that
// left an old snapshot in Postgres — stale data stops being a fair picture and
// the request waits for a real pull rather than quietly showing last week's
// numbers. 0 disables serve-while-refreshing entirely.
// Unset means the default; an explicit 0 means off, so a deployment can insist
// on fresh data without editing code.
function staleServeMinutes() {
  const configured = process.env.STALE_SERVE_MINUTES;
  if (configured === undefined || configured === '') return 60;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}
const STALE_SERVE_MS = staleServeMinutes() * 60 * 1000;
// MOCK_DATA=1 puts the whole instance on generated data; a demo account is on
// it individually, on an instance whose other accounts are reading real banks
// (see src/demo.js). Both answer the same question — "is there a bank behind
// this account?" — so they are the same switch.
const useMock = (userId) => process.env.MOCK_DATA === '1' || demo.isDemo(userId);

// Per-user in-memory cache of the raw Lunchflow pull. Summaries and per-month
// lists are derived from it on each request, so manual overrides take effect
// immediately without re-hitting the API. Backed by transactions_cache so it
// survives restarts. Shape: userId -> { cached: {accounts,txs}|null, cachedAt, inflight }.
const perUser = new Map();

async function loadCache(userId) {
  const { rows } = await db.query(
    'SELECT cached_at, accounts, txs FROM transactions_cache WHERE user_id = $1',
    [userId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return { cachedAt: Number(row.cached_at), raw: { accounts: row.accounts, txs: row.txs } };
}

async function persistCache(userId, raw, timestamp) {
  try {
    await db.query(
      `INSERT INTO transactions_cache (user_id, cached_at, accounts, txs) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET cached_at = EXCLUDED.cached_at,
         accounts = EXCLUDED.accounts, txs = EXCLUDED.txs`,
      [userId, timestamp, JSON.stringify(raw.accounts), JSON.stringify(raw.txs)]
    );
  } catch (err) {
    // A DB hiccup must not stop fresh data being served from memory.
    console.error(`Could not persist transaction cache for user ${userId}:`, err.message);
  }
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchRaw(userId) {
  const api = useMock(userId) ? mock : lunchflow;
  let apiKey = null;
  if (!useMock(userId)) {
    apiKey = (await users.getKeys(userId)).lunchflow;
    if (!apiKey) {
      const err = new Error('No Lunchflow API key on file');
      err.publicMessage = 'Add your Lunchflow API key in Settings';
      throw err;
    }
  }

  const to = new Date();
  const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);

  const accounts = await api.getAccounts(apiKey);
  const active = accounts.filter((a) => !a.status || String(a.status).toLowerCase() !== 'disconnected');

  const perAccount = await Promise.all(
    active.map((a) => api.getTransactions(apiKey, a.id, iso(from), iso(to)))
  );
  return { accounts: active, txs: perAccount.flat() };
}

// preferCached serves whatever is already loaded even past its TTL — right for
// derived lookups (rule previews, AI review context) that must answer fast and
// don't care about the last few minutes; only an empty cache still fetches.
async function getRaw(userId, { force = false, preferCached = false } = {}) {
  let state = perUser.get(userId);
  if (!state) {
    const disk = await loadCache(userId);
    state = { cached: disk ? disk.raw : null, cachedAt: disk ? disk.cachedAt : 0, inflight: null };
    perUser.set(userId, state);
  }

  const age = state.cached ? Date.now() - state.cachedAt : Infinity;
  const fresh = age < CACHE_TTL_MS;
  if (state.cached && (fresh || preferCached) && !force) return state.cached;

  // Expired, but we still have a recent enough pull: hand that back and refresh
  // behind the request. Re-fetching every account from Lunchflow takes seconds,
  // and making whoever happens to arrive first after the TTL lapses sit through
  // it is what made the dashboard feel slow at random. An explicit refresh
  // (force) still waits, so does a cold cache with nothing to show, and so does
  // anything older than STALE_SERVE_MS.
  if (state.cached && !force && age < STALE_SERVE_MS) {
    startRefresh(userId, state).catch((err) =>
      console.error(`background refresh failed for user ${userId}:`, err.message));
    return state.cached;
  }

  // If a refresh fails but we have stale data, serve it rather than erroring.
  try {
    return await startRefresh(userId, state);
  } catch (err) {
    if (state.cached) {
      console.error(`refresh failed for user ${userId}, serving stale data:`, err.message);
      return state.cached;
    }
    throw err;
  }
}

// The single in-flight Lunchflow pull for a user; concurrent callers share it.
function startRefresh(userId, state) {
  if (!state.inflight) {
    state.inflight = fetchRaw(userId)
      .then(async (raw) => {
        state.cached = raw;
        state.cachedAt = Date.now();
        await persistCache(userId, raw, state.cachedAt);
        return raw;
      })
      .finally(() => {
        state.inflight = null;
      });
  }
  return state.inflight;
}

// Cached raw data with exchange rates applied — the shape every derived view
// (summary, transaction lists, rule previews, AI reviews) starts from.
// The converted array is held against the raw one it came from: rebuilding it
// per request threw away thousands of objects each time, and handing every
// derived view the *same* array is what lets analytics.classify() reuse one
// classification pass across the several endpoints a page load hits.
const convertedCache = new WeakMap();

async function getConverted(userId, { force = false, preferCached = false } = {}) {
  const raw = await getRaw(userId, { force, preferCached });
  // Amounts are converted into the account's own currency, so the setting is
  // read here rather than passed in: every caller would otherwise have to
  // remember to, and one that forgot would quietly serve another currency's
  // numbers labelled as this one.
  const base = (await rules.get(userId)).currency;
  const hit = convertedCache.get(raw.txs);
  if (hit && hit.base === base) return { accounts: raw.accounts, txs: hit.txs };
  const txs = await applyExchangeRates(raw.txs, base);
  // Only keep it if every transaction actually converted. A missing rate means
  // the FX lookup came up short, and the next request should retry rather than
  // serve the gap until the raw cache next refreshes.
  if (txs.every((tx) => tx.exchange_rate !== null)) convertedCache.set(raw.txs, { base, txs });
  return { accounts: raw.accounts, txs };
}

// When this user's transactions were last pulled from Lunchflow, and whether a
// refresh is running right now. Read after the data, so a refresh this request
// kicked off is reflected.
function cacheStatus(userId) {
  const state = perUser.get(userId);
  return {
    fetchedAt: state && state.cachedAt ? new Date(state.cachedAt).toISOString() : null,
    refreshing: Boolean(state && state.inflight),
  };
}

async function getSummary(userId, { force = false } = {}) {
  const { accounts, txs } = await getConverted(userId, { force });
  const [ovr, rulesDoc] = await Promise.all([overrides.getAll(userId), rules.get(userId)]);
  // fetchedAt is when the data is really from; buildSummary's generatedAt is
  // only when these totals were added up, which is always "just now".
  return { ...buildSummary(accounts, txs, ovr, rulesDoc), ...cacheStatus(userId) };
}

async function getMonthTransactions(userId, month) {
  const { accounts, txs } = await getConverted(userId);
  const [ovr, rulesDoc] = await Promise.all([overrides.getAll(userId), rules.get(userId)]);
  return {
    scope: 'month',
    month,
    currency: rulesDoc.currency,
    baseCurrency: rulesDoc.currency,
    transactions: listTransactions(accounts, txs, new Set([month]), ovr, rulesDoc),
  };
}

async function getYearTransactions(userId) {
  const { accounts, txs } = await getConverted(userId);
  const [ovr, rulesDoc] = await Promise.all([overrides.getAll(userId), rules.get(userId)]);
  return {
    scope: 'year',
    currency: rulesDoc.currency,
    baseCurrency: rulesDoc.currency,
    transactions: listTransactions(accounts, txs, new Set(windowMonths()), ovr, rulesDoc),
  };
}

// Which transactions would this pattern list match right now? Answers from the
// existing cache — a preview keystroke must never block on a Lunchflow refetch.
async function previewRule(userId, patterns, limit) {
  const { accounts, txs } = await getConverted(userId, { preferCached: true });
  const [ovr, rulesDoc] = await Promise.all([overrides.getAll(userId), rules.get(userId)]);
  return previewMatches(accounts, txs, patterns, ovr, limit, rulesDoc);
}

// What else looks like this transaction? Answers from the cache for the same
// reason the rule preview does — opening a row must not trigger a refetch.
async function similarTransactions(userId, txId, limit) {
  const { accounts, txs } = await getConverted(userId, { preferCached: true });
  const [ovr, rulesDoc] = await Promise.all([overrides.getAll(userId), rules.get(userId)]);
  return similarMatches(accounts, txs, txId, ovr, limit, rulesDoc);
}

// Record a manual override. Returns true if it changed anything.
function setOverride(userId, txId, state) {
  return overrides.set(userId, txId, state);
}

// Pin a spending category for one transaction (null clears it).
function setCategoryOverride(userId, txId, category) {
  return overrides.setCategory(userId, txId, category);
}

// The cached raw transactions with their fetch timestamp, for a data export.
// Null when nothing has been cached yet.
async function exportTransactions(userId) {
  const disk = await loadCache(userId);
  return disk ? { cachedAt: disk.cachedAt, accounts: disk.raw.accounts, txs: disk.raw.txs } : null;
}

// Seed a user's transaction cache from an imported export.
async function importTransactions(userId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.txs)) return;
  const cachedAt = Number.isFinite(snapshot.cachedAt) ? snapshot.cachedAt : Date.now();
  await persistCache(userId, { accounts: snapshot.accounts, txs: snapshot.txs }, cachedAt);
  perUser.delete(userId); // force a reload from disk on next access
}

// Drop a user's cached Lunchflow pull from memory, for account deletion — the
// transactions_cache row goes with the cascade, this is its in-process copy.
function forgetUser(userId) {
  perUser.delete(userId);
}

module.exports = {
  forgetUser,
  getSummary,
  getMonthTransactions,
  getYearTransactions,
  getConverted,
  previewRule,
  similarTransactions,
  exportTransactions,
  importTransactions,
  setOverride,
  setCategoryOverride,
};
