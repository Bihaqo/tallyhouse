'use strict';

// The currency an account keeps its books in — the one every total on the
// dashboard is expressed in, and the one foreign transactions are converted
// into at the historical rate.
//
// config/currencies.json is deliberately not "every currency there is". A
// currency belongs on that list only if the rate source in fx.js can quote it,
// because an account denominated in something it cannot quote would show a
// blank for every foreign transaction it holds. That list is the ECB reference
// set Frankfurter serves; adding a code without adding rate coverage first is
// what would break.

const LIST = require('../config/currencies.json');

// What a brand-new account starts from before its data has been looked at, and
// where anything unrecognised lands.
const DEFAULT = 'GBP';

const byCode = new Map(LIST.map((entry) => [entry.code, entry]));

const isSupported = (code) =>
  typeof code === 'string' && byCode.has(code.trim().toUpperCase());

// The code as we store it, or null when it isn't one we support.
const normalize = (code) => (isSupported(code) ? code.trim().toUpperCase() : null);

/**
 * Read the old free-text `currencySymbol` setting as a currency code.
 *
 * That field was display-only: it was pasted in front of totals that were
 * always converted to GBP regardless of what it said. So this is a best reading
 * of an intent that was never fully expressed, not a lossless conversion.
 *
 * Symbols shared by several currencies resolve to the most widely used one —
 * "$" to USD rather than any of the eight other dollars — because that is the
 * likeliest reading and the cost of being wrong is one dropdown. Anything
 * genuinely unreadable ("kr" is four currencies, and the field accepted any
 * three characters at all) comes back null for the caller to default, which
 * leaves those accounts converting exactly as they do today.
 */
const SYMBOL_CODES = {
  '£': 'GBP',
  '€': 'EUR',
  '$': 'USD',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₪': 'ILS',
  '₺': 'TRY',
  '₱': 'PHP',
  'zł': 'PLN',
  'Kč': 'CZK',
  'R$': 'BRL',
};

function fromSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const trimmed = symbol.trim();
  // The old field was three characters wide, so plenty of people will have
  // typed the code itself rather than a symbol.
  return normalize(trimmed) || SYMBOL_CODES[trimmed] || null;
}

/**
 * The currency an account is most likely kept in, from its own data.
 *
 * Transactions decide it, by count: an account list can carry a currency for a
 * card that is barely used, while the transactions say where the money actually
 * moves. Account currencies are only consulted when there are no transactions
 * to count — a freshly connected bank, or a first sweep that came back empty.
 *
 * Returns null when nothing recognisable turned up, so the caller can fall back
 * rather than being handed a guess dressed up as a detection.
 */
function detect({ txs = [], accounts = [] } = {}) {
  const tally = (items) => {
    const counts = new Map();
    for (const item of items) {
      const code = normalize(item && item.currency);
      if (code) counts.set(code, (counts.get(code) || 0) + 1);
    }
    return counts;
  };

  const fromTxs = tally(txs);
  const counts = fromTxs.size ? fromTxs : tally(accounts);
  if (!counts.size) return null;
  // Sorted by code on a tie so the same data always suggests the same currency.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

module.exports = { LIST, DEFAULT, isSupported, normalize, fromSymbol, detect };
