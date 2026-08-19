'use strict';

// Historical FX rates, shared across all users and stored in the fx_rates table.
// The whole set is small, so it's loaded into an in-memory map at boot (init)
// and kept in sync as new rates are fetched — applyExchangeRates() stays fast.
//
// A rate is stored per source *and* target currency, because the target is the
// account's own currency and accounts differ. Sharing the table across users
// stays safe: "USD>EUR on 2026-06-14" is one objective number, so two accounts
// asking for it want the same answer, and an account on a currency nobody else
// uses simply fetches its own column.

const db = require('./db');
const currencies = require('./currencies');

// The target currency for anything that has not said which it wants — and the
// one every rate was implicitly quoted against before targets were stored.
const BASE_CURRENCY = currencies.DEFAULT;
const API_URL = process.env.FX_API_URL || 'https://api.frankfurter.dev/v2/rates';
const DAY_MS = 24 * 60 * 60 * 1000;

let cache = {}; // { "USD>GBP|2026-06-14": { rate, rateDate } }

// Load the shared rate table into memory. Called once at startup.
async function init() {
  const { rows } = await db.query('SELECT pair, rate, rate_date FROM fx_rates');
  cache = {};
  // Rows written before rates carried a target are GBP rates, which is what the
  // single hard-coded base was. Renamed on the way in rather than in a
  // migration, so the stored rows are still readable by the previous version.
  for (const row of rows) {
    const pair = row.pair.includes('>')
      ? row.pair
      : row.pair.replace('|', `>${BASE_CURRENCY}|`);
    cache[pair] = { rate: row.rate, rateDate: row.rate_date };
  }
}

// Upsert one rate into Postgres and the in-memory map.
async function upsertRate(pair, rate, rateDate) {
  cache[pair] = { rate, rateDate };
  await db.query(
    `INSERT INTO fx_rates (pair, rate, rate_date) VALUES ($1, $2, $3)
     ON CONFLICT (pair) DO UPDATE SET rate = EXCLUDED.rate, rate_date = EXCLUDED.rate_date`,
    [pair, rate, rateDate]
  );
}

const rateKey = (currency, target, date) => `${currency}>${target}|${date}`;

function addDays(date, days) {
  return new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function fetchMissingRates(requests, target) {
  const sources = [...new Set(requests.map((item) => item.currency))];
  const dates = requests.map((item) => item.date).sort();
  const quotes = [...new Set([target, ...sources].filter((code) => code !== 'EUR'))];
  const url = new URL(API_URL);
  url.searchParams.set('from', iso(addDays(dates[0], -7)));
  url.searchParams.set('to', dates[dates.length - 1]);
  if (quotes.length) url.searchParams.set('quotes', quotes.join(','));
  url.searchParams.set('providers', 'ECB');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Frankfurter returned ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Frankfurter returned an invalid response');

  const byDate = new Map();
  for (const row of rows) {
    if (!row || !row.date || !row.quote || !Number.isFinite(row.rate)) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, { EUR: 1 });
    byDate.get(row.date)[String(row.quote).toUpperCase()] = row.rate;
  }
  const availableDates = [...byDate.keys()].sort();

  for (const request of requests) {
    const rateDate = availableDates.filter((date) => date <= request.date).at(-1);
    const rates = rateDate ? byDate.get(rateDate) : null;
    const sourceRate = request.currency === 'EUR' ? 1 : rates?.[request.currency];
    const targetRate = target === 'EUR' ? 1 : rates?.[target];
    if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate)) continue;
    await upsertRate(rateKey(request.currency, target, request.date), targetRate / sourceRate, rateDate);
  }
}

// Convert every transaction into `base` — the account's own currency — adding
// the rate used and the converted amount alongside the original.
async function applyExchangeRates(txs, base = BASE_CURRENCY) {
  const target = currencies.normalize(base) || BASE_CURRENCY;
  const requests = [...new Map(
    txs
      .map((tx) => ({ currency: String(tx.currency || target).toUpperCase(), date: tx.date }))
      .filter((item) => item.currency !== target && item.date)
      .map((item) => [rateKey(item.currency, target, item.date), item])
  ).values()].filter((item) => !cache[rateKey(item.currency, target, item.date)]);

  if (requests.length) {
    try {
      await fetchMissingRates(requests, target);
    } catch (err) {
      console.error('Could not refresh historical FX rates:', err.message);
    }
  }

  return txs.map((tx) => {
    const currency = String(tx.currency || target).toUpperCase();
    const saved = currency === target
      ? { rate: 1, rateDate: tx.date }
      : cache[rateKey(currency, target, tx.date)];
    return {
      ...tx,
      base_currency: target,
      exchange_rate: saved?.rate ?? null,
      exchange_rate_date: saved?.rateDate ?? null,
      base_amount: saved ? tx.amount * saved.rate : null,
    };
  });
}

// The cached historical rates, in the same shape they're persisted, for a full
// data export. Each key names both currencies ("USD>GBP|2026-06-14"), so the
// export says what everything was converted into without a separate field.
function exportRates() {
  return { rates: cache };
}

// There is deliberately no importRates(). fx_rates is one table shared by every
// account, so writing rates from an uploaded file let any user change what
// everyone else's foreign transactions convert at. Rates are objective and
// applyExchangeRates() fetches whatever is missing, so nothing is lost by
// refusing them. If a future version wants imports back, the rates have to be
// per-user first.

module.exports = { init, applyExchangeRates, BASE_CURRENCY, exportRates };
